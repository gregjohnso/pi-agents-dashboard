import { expect, it } from "vitest";

import { daemonEntryPoint, resolveRuntimeRoot, runDaemonCommand } from "./daemon-commands.mjs";

it("uses one per-user state root regardless of effective Pi config root", () => {
  const envA = { HOME: "/home/user", PI_CONFIG_DIR: "/pi/a" };
  const envB = { HOME: "/home/user", PI_CONFIG_DIR: "/pi/b" };
  expect(resolveRuntimeRoot(envA)).toBe("/home/user/.local/state/pi-agents-dashboard");
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
