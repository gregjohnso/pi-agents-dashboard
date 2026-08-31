import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  expect(resolveRuntimeRoot(envA)).toBe("/home/user/.local/state/pi-agents");
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
  let exited = false;
  const result = await runDaemonCommand("stop", {
    root: "/state",
    inspect: async () => {
      if (exited) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      return publication;
    },
    inspectEndpoint: async () => endpoints.shift() ?? { status: "ABSENT" },
    request: async () => ({ kind: "state", sessions: [] }),
    stopProcessGroup: async (ownership, deps, policy) => {
      calls.push({ ownership, policy });
      await deps.requestGraceful(ownership);
      exited = true;
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

// Operator-visible failure: this claimed an access role per worker and read the reply to decide
// whether it might stop that worker. The daemon grants no roles, so the claim could only refuse.
it("stops each exact live worker on one held connection, claiming nothing", async () => {
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: "/state/daemon/control.token" };
  const operations = [];
  const request = async (/** @type {string} */ op, /** @type {any} */ payload) => {
    operations.push([op, payload]);
    if (op === "get_state") return { kind: "state", sessions: [{ sessionId: "live", revision: 4, processState: "LIVE", ownership: { runId: "run" } }] };
    return { kind: "command", status: { stage: "COMPLETED" } };
  };
  const endpoints = [{ status: "HEALTHY", daemonState: "READY", publication }, { status: "ABSENT" }];
  await expect(runDaemonCommand("stop", {
    root: "/state", inspectEndpoint: async () => endpoints.shift() ?? { status: "ABSENT" }, heldConnectionRequest: request,
    stopWorkers: true, yes: true, stopProcessGroup: async () => ({ disposition: "GRACEFUL" }),
  })).resolves.toMatchObject({ code: 0, result: { kind: "daemon_stopped", stoppedSessionIds: ["live"] } });
  expect(operations).toEqual([["get_state", {}], ["stop", { sessionId: "live", revision: 4 }]]);
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
    throw Object.assign(new Error("socket closed"), { code: "DELIVERY_UNKNOWN", submitted: true });
  };
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: "/state/daemon/control.token" };
  const operations = [];
  const stopProcessGroup = vi.fn();
  await expect(runDaemonCommand("stop", {
    root: "/state", inspectEndpoint: async () => ({ status: "HEALTHY", daemonState: "READY", publication }),
    heldConnectionRequest: async (op, ...rest) => { operations.push(op); return respond(op, ...rest); },
    stopWorkers: true, yes: true, stopProcessGroup,
  })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN" } });
  expect(operations.slice(0, 2)).toEqual(["get_state", "stop"]);
  expect(stopProcessGroup).not.toHaveBeenCalled();
});

it("leaves exactly one daemon when restart cannot prove the old one is gone", async () => {
  // The daemon removes pid.json as the last step of its own shutdown, so an absent publication
  // proves only that the endpoint was released. Tonight that read as success three times and left
  // three daemons live on one state root.
  const root = await stateRoot();
  const old = { pid: 4242, startIdentity: "111222333", processGroupId: 4242 };
  /** @type {Map<number, any>} */
  const live = new Map([[old.pid, old]]);
  /** @type {any} */
  let publication = { ...old, tokenPath: join(root, "daemon", "control.token") };
  /** @type {string[][]} */
  const spawned = [];

  const result = await runDaemonCommand("restart", {
    root,
    timeoutMs: 200,
    stopPolicy: { gracefulMs: 1, terminateMs: 1 },
    request: async () => ({ kind: "state", sessions: [] }),
    inspect: async (/** @type {number} */ pid) => {
      const identity = live.get(pid);
      if (identity === undefined) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      return identity;
    },
    inspectEndpoint: async () => publication === undefined ? { status: "ABSENT", canCleanup: false } : { status: "HEALTHY", daemonState: "READY", publication },
    requestGraceful: async () => { publication = undefined; },
    signalProcessGroup: () => {},
    spawnDaemon: (/** @type {string} */ _file, /** @type {string[]} */ argv) => {
      const pid = 5000 + spawned.length;
      spawned.push(argv);
      live.set(pid, { pid, startIdentity: "999888777", processGroupId: pid });
      publication = { pid, startIdentity: "999888777", processGroupId: pid, tokenPath: join(root, "daemon", "control.token") };
      return { once() {} };
    },
  });

  expect(spawned).toEqual([]);
  expect([...live.keys()]).toEqual([old.pid]);
  expect(result).toMatchObject({ code: 5, error: { code: "DAEMON_STILL_RUNNING" } });
}, 20_000);

it("starts where the operator's sessions already are when no root is given", async () => {
  // A start that resolves its own root opened an empty one beside six live sessions, and the list
  // came up blank.
  const parent = await stateRoot();
  const previousRoot = join(parent, "pi-dashboard");
  await mkdir(join(previousRoot, "sessions"), { recursive: true, mode: 0o700 });
  await writeFile(join(previousRoot, "sessions", "alpha.json"), "{}", { mode: 0o600 });
  /** @type {string[][]} */
  const spawned = [];
  const endpoints = [{ status: "ABSENT" }, { status: "HEALTHY", daemonState: "READY", publication: { pid: 321 } }];

  const result = await runDaemonCommand("start", {
    env: { HOME: parent, XDG_STATE_HOME: parent },
    inspectEndpoint: async () => endpoints.shift() ?? { status: "HEALTHY", daemonState: "READY", publication: { pid: 321 } },
    spawnDaemon: (/** @type {string} */ _file, /** @type {string[]} */ argv) => { spawned.push(argv); return { once() {} }; },
  });

  expect(result).toMatchObject({ code: 0, result: { kind: "daemon_started" } });
  expect(spawned).toEqual([["--root", result.result.root]]);
  expect(await readdir(join(result.result.root, "sessions"))).toEqual(["alpha.json"]);
});

it("maps absent, unhealthy, and identity-conflict status to stable exit codes", async () => {
  for (const [status, code] of [["ABSENT", 3], ["UNHEALTHY", 1], ["CONFLICT", 5]]) {
    const result = await runDaemonCommand("status", { root: "/state", inspectEndpoint: async () => ({ status }) });
    expect(result.code).toBe(code);
  }
});

// Operator-visible failure: this release changes the frontend protocol, so the daemon refuses a
// frontend that does not declare it. The liveness probe deliberately declares nothing, because a
// command-line client from this release must still find and stop a daemon from the previous one —
// otherwise `pi-agents daemon restart` breaks during the one release that requires a restart.
it("probes a daemon without declaring the client protocol", async () => {
  const { createDaemonRuntime } = await import("../runtime/daemon.mjs");
  const { probeDaemon } = await import("./daemon-commands.mjs");
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-agents-probe-protocol-"));
  const runtime = await createDaemonRuntime({ root: stateRoot });
  try {
    await runtime.ready;
    expect(await probeDaemon({ tokenPath: join(stateRoot, "daemon", "control.token") }, { timeoutMs: 5_000 }))
      .toMatchObject({ reachable: true, state: "READY" });
  } finally {
    await runtime.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
