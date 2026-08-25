import net from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { daemonEntryPoint, resolveRuntimeRoot, runDaemonCommand } from "./daemon-commands.mjs";

it("uses one per-user state root regardless of effective Pi config root", () => {
  const envA = { HOME: "/home/user", PI_CONFIG_DIR: "/pi/a" };
  const envB = { HOME: "/home/user", PI_CONFIG_DIR: "/pi/b" };
  expect(resolveRuntimeRoot(envA)).toBe("/home/user/.local/state/pi-dashboard");
  expect(resolveRuntimeRoot(envB)).toBe(resolveRuntimeRoot(envA));
});

it("discovers the daemon entry point relative to the package instead of PATH", async () => {
  expect(await daemonEntryPoint()).toMatch(/runtime\/daemon\.mjs$/);
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

it("wires daemon live-worker checks through the persistent private CLI identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-daemon-cli-"));
  const daemon = join(root, "daemon");
  await mkdir(daemon, { recursive: true, mode: 0o700 });
  await writeFile(join(daemon, "control.token"), "secret\n", { mode: 0o600 });
  const received = [];
  const server = net.createServer((socket) => {
    const decoder = createJsonlDecoder({ maxBytes: 4096 });
    const encoder = createJsonlEncoder({ maxBytes: 4096 });
    let authenticated = false;
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (!authenticated) {
          authenticated = true;
          socket.write(encoder.encode({ version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "epoch", pid: 321 }));
        } else {
          received.push(frame);
          socket.write(encoder.encode({ version: 1, requestId: frame.requestId, ok: true, result: { kind: "state", sessions: [] } }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(join(daemon, "control.sock"), resolve).once("error", reject));
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: join(daemon, "control.token") };
  const endpoints = [{ status: "HEALTHY", daemonState: "READY", publication }, { status: "ABSENT" }];
  const result = await runDaemonCommand("stop", {
    root,
    randomId: () => "persistent-daemon-cli",
    inspectEndpoint: async () => endpoints.shift() ?? { status: "ABSENT" },
    stopProcessGroup: async () => ({ disposition: "GRACEFUL" }),
  });
  expect(result.code).toBe(0);
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ clientId: "cli-persistent-daemon-cli", op: "get_state" });
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
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

it("keeps the daemon running when a worker Stop socket disconnects after submission", async () => {
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: "/state/daemon/control.token" };
  const operations = [];
  const request = async (op) => {
    operations.push(op);
    if (op === "get_state") return { kind: "state", sessions: [{ sessionId: "live", revision: 4, processState: "LIVE", ownership: { runId: "run" } }] };
    if (op === "attach") return { kind: "attached", sessionId: "live", role: "composer" };
    throw Object.assign(new Error("socket closed"), { code: "DELIVERY_UNKNOWN", submitted: true });
  };
  await expect(runDaemonCommand("stop", {
    root: "/state", inspectEndpoint: async () => ({ status: "HEALTHY", daemonState: "READY", publication }), composerRequest: request,
    stopWorkers: true, yes: true, stopProcessGroup: vi.fn(),
  })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN" } });
  expect(operations).toEqual(["get_state", "attach", "stop"]);
});

it("refuses daemon --stop-workers shutdown when any exact worker stop is not observed terminal", async () => {
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: "/state/daemon/control.token" };
  const request = async (op) => op === "get_state"
    ? { kind: "state", sessions: [{ sessionId: "still-live", revision: 4, processState: "LIVE", ownership: { runId: "run" } }] }
    : { kind: "command", status: { stage: "DELIVERY_UNKNOWN" } };
  const stopProcessGroup = async () => { throw new Error("daemon must remain running"); };
  await expect(runDaemonCommand("stop", {
    root: "/state",
    inspectEndpoint: async () => ({ status: "HEALTHY", daemonState: "READY", publication }),
    request,
    stopWorkers: true,
    yes: true,
    stopProcessGroup,
  })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN" } });
});

it("maps a daemon child recovery-conflict exit to CLI exit 5", async () => {
  const result = await runDaemonCommand("start", {
    root: "/state",
    inspectEndpoint: async () => ({ status: "ABSENT" }),
    spawnDaemon: () => ({ once(event, listener) { if (event === "exit") listener(5); } }),
  });
  expect(result).toMatchObject({ code: 5, error: { code: "DAEMON_RECOVERY_CONFLICT" } });
});

it("maps stop identity ambiguity and recovery conflict to exit 5 without signaling", async () => {
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: "/state/daemon/control.token" };
  const result = await runDaemonCommand("stop", {
    root: "/state",
    inspectEndpoint: async () => ({ status: "HEALTHY", daemonState: "READY", publication }),
    request: async () => ({ kind: "state", sessions: [] }),
    stopProcessGroup: async () => ({ disposition: "STALE_IDENTITY" }),
  });
  expect(result).toMatchObject({ code: 5, error: { code: "DAEMON_IDENTITY_CONFLICT" } });
  const recovering = await runDaemonCommand("recover", {
    root: "/state",
    inspectEndpoint: async () => ({ status: "STALE" }),
    cleanupStale: async () => { throw Object.assign(new Error("busy"), { code: "DAEMON_BUSY" }); },
  });
  expect(recovering.code).toBe(5);
});

it("maps absent, unhealthy, and identity-conflict status to stable exit codes", async () => {
  for (const [status, code] of [["ABSENT", 3], ["UNHEALTHY", 1], ["CONFLICT", 5]]) {
    const result = await runDaemonCommand("status", { root: "/state", inspectEndpoint: async () => ({ status }) });
    expect(result.code).toBe(code);
  }
});
