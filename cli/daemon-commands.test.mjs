import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { resolveRuntimeRoot, runDaemonCommand } from "./daemon-commands.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function stateRoot() {
  const root = await mkdtemp(join(tmpdir(), "dashboard-daemon-cli-"));
  roots.push(root);
  return root;
}

it("uses one per-user state root regardless of effective Pi config root", () => {
  const envA = { HOME: "/home/user", PI_CONFIG_DIR: "/pi/a" };
  const envB = { HOME: "/home/user", PI_CONFIG_DIR: "/pi/b" };
  expect(resolveRuntimeRoot(envA)).toBe("/home/user/.local/state/pi-dashboard");
  expect(resolveRuntimeRoot(envB)).toBe(resolveRuntimeRoot(envA));
});

it("waits through transient unhealthy startup until the daemon is ready", async () => {
  const endpoints = [
    { status: "ABSENT" },
    { status: "UNHEALTHY", daemonState: "STARTING" },
    { status: "HEALTHY", daemonState: "READY", publication: { pid: 321 } },
  ];
  const result = await runDaemonCommand("start", {
    root: "/state",
    inspectEndpoint: async () => endpoints.shift() ?? { status: "UNHEALTHY" },
    spawnDaemon: () => ({ once() {} }),
  });
  expect(result).toMatchObject({ code: 0, result: { kind: "daemon_started", alreadyRunning: false } });
});

it.each([
  ["exits", 1, /exited with code 1/u],
  ["never becomes healthy", undefined, /startup deadline/u],
])("reports the failing daemon child's own error output when it %s", async (_label, exitCode, summary) => {
  const root = await stateRoot();
  const result = await runDaemonCommand("start", {
    root,
    timeoutMs: 100,
    inspectEndpoint: async () => ({ status: "ABSENT" }),
    spawnDaemon: (_file, _argv, _env, stderr) => {
      writeSync(stderr, "DashboardConfigError: dashboard.json is invalid\n");
      const child = new EventEmitter();
      if (exitCode !== undefined) setTimeout(() => child.emit("exit", exitCode), 5);
      return child;
    },
  });
  expect(result.code).toBe(1);
  expect(result.error.code).toBe("DAEMON_START_FAILED");
  expect(result.error.message).toMatch(summary);
  expect(result.error.message).toContain("DashboardConfigError: dashboard.json is invalid");
  expect(await readFile(join(root, "daemon", "startup.log"), "utf8")).toContain("DashboardConfigError");
});

it("reports a daemon child that could not be spawned at all", async () => {
  const root = await stateRoot();
  const result = await runDaemonCommand("start", {
    root,
    timeoutMs: 5_000,
    inspectEndpoint: async () => ({ status: "ABSENT" }),
    spawnDaemon: () => {
      const child = new EventEmitter();
      setTimeout(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })), 5);
      return child;
    },
  });
  expect(result).toMatchObject({ code: 1, error: { code: "DAEMON_START_FAILED", message: expect.stringContaining("spawn ENOENT") } });
});

it("stops only through the verified daemon process-group boundary", async () => {
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: "/state/daemon/control.token" };
  const endpoints = [{ status: "HEALTHY", daemonState: "READY", publication }, { status: "ABSENT" }];
  /** @type {any[]} */
  const calls = [];
  const result = await runDaemonCommand("stop", {
    root: "/state",
    inspect: async () => publication,
    inspectEndpoint: async () => endpoints.shift() ?? { status: "ABSENT" },
    request: async () => ({ kind: "state", sessions: [] }),
    stopProcessGroup: async (ownership, deps, policy) => {
      calls.push({ ownership, policy });
      await deps.requestGraceful(ownership);
      return { disposition: "GRACEFUL" };
    },
    requestGraceful: async (ownership) => { calls.push({ graceful: ownership }); },
  });
  expect(result.code).toBe(0);
  expect(calls).toEqual([
    { ownership: { pid: 321, startIdentity: "987654321", processGroupId: 654 }, policy: { gracefulMs: 500, terminateMs: 500 } },
    { graceful: { pid: 321, startIdentity: "987654321", processGroupId: 654 } },
  ]);
});

it("claims composer on each exact worker before --stop-workers mutation", async () => {
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: "/state/daemon/control.token" };
  const operations = [];
  const request = async (op) => {
    operations.push(op);
    if (op === "get_state") return { kind: "state", sessions: [{ sessionId: "live", revision: 4, processState: "LIVE", ownership: { runId: "run" } }] };
    if (op === "attach") return { kind: "attached", sessionId: "live", role: "composer" };
    if (op === "detach") return { kind: "detached", sessionId: "live" };
    return { kind: "command", status: { stage: "COMPLETED" } };
  };
  const endpoints = [{ status: "HEALTHY", daemonState: "READY", publication }, { status: "ABSENT" }];
  await runDaemonCommand("stop", {
    root: "/state", inspectEndpoint: async () => endpoints.shift() ?? { status: "ABSENT" }, composerRequest: request,
    stopWorkers: true, yes: true, stopProcessGroup: async () => ({ disposition: "GRACEFUL" }),
  });
  expect(operations).toEqual(["get_state", "attach", "stop", "detach"]);
});

it("gives every worker stop the daemon's full escalation window and reports the sessions it stopped", async () => {
  const root = await stateRoot();
  await writeFile(join(root, "dashboard.json"), JSON.stringify({ stop: { gracefulMs: 7_000, terminateMs: 3_000 } }), { mode: 0o600 });
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: join(root, "daemon", "control.token") };
  const endpoints = [{ status: "HEALTHY", daemonState: "READY", publication }, { status: "ABSENT" }];
  const timeouts = [];
  const result = await runDaemonCommand("stop", {
    root,
    inspectEndpoint: async () => endpoints.shift() ?? { status: "ABSENT" },
    createPersistentRequester: async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      return {
        request: async (op) => {
          if (op === "get_state") return { kind: "state", sessions: [{ sessionId: "live", revision: 4, processState: "LIVE", ownership: { runId: "run" } }] };
          if (op === "attach") return { kind: "attached", sessionId: "live", role: "composer" };
          if (op === "detach") return { kind: "detached", sessionId: "live" };
          return { kind: "command", status: { stage: "COMPLETED" } };
        },
        close: async () => {},
      };
    },
    stopWorkers: true, yes: true, stopProcessGroup: async () => ({ disposition: "GRACEFUL" }),
  });
  expect(timeouts).toEqual([7_000 + 3_000 + 1_000]);
  expect(result).toMatchObject({ code: 0, result: { kind: "daemon_stopped", stoppedSessionIds: ["live"] } });
});

it("keeps the daemon running when the stop socket disconnects after submission", async () => {
  const respond = async (/** @type {string} */ op) => {
    if (op === "get_state") return { kind: "state", sessions: [{ sessionId: "live", revision: 4, processState: "LIVE", ownership: { runId: "run" } }] };
    if (op === "attach") return { kind: "attached", sessionId: "live", role: "composer" };
    throw Object.assign(new Error("socket closed"), { code: "DELIVERY_UNKNOWN", submitted: true });
  };
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: "/state/daemon/control.token" };
  const operations = [];
  const stopProcessGroup = vi.fn();
  await expect(runDaemonCommand("stop", {
    root: "/state", inspectEndpoint: async () => ({ status: "HEALTHY", daemonState: "READY", publication }),
    composerRequest: async (op, ...rest) => { operations.push(op); return respond(op, ...rest); },
    stopWorkers: true, yes: true, stopProcessGroup,
  })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN" } });
  expect(operations.slice(0, 3)).toEqual(["get_state", "attach", "stop"]);
  expect(stopProcessGroup).not.toHaveBeenCalled();
});

it("maps absent, unhealthy, and identity-conflict status to stable exit codes", async () => {
  for (const [status, code] of [["ABSENT", 3], ["UNHEALTHY", 1], ["CONFLICT", 5]]) {
    const result = await runDaemonCommand("status", { root: "/state", inspectEndpoint: async () => ({ status }) });
    expect(result.code).toBe(code);
  }
});
