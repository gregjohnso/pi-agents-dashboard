import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { CLIENT_PROTOCOL } from "../shared/contracts.mjs";
import { startPreviousReleaseDaemon } from "../test/previous-release-daemon.mjs";
import { DAEMON_PROBE_TIMEOUT_MS, probeDaemon, resolveRuntimeRoot, runDaemonCommand } from "./daemon-commands.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function stateRoot() {
  const root = await mkdtemp(join(tmpdir(), "dashboard-daemon-cli-"));
  roots.push(root);
  return root;
}

const liveSession = { sessionId: "live-session", revision: 4, processState: "LIVE", ownership: { runId: "run" } };

/**
 * Run one daemon command against a real socket served by the previous release, with this file's
 * usual process-identity seams: only the protocol behaviour is real, as it is in every other case here.
 * @param {string} command @param {{ expectStop?: boolean } & Record<string, any>} [options]
 */
async function againstPreviousRelease(command, { expectStop = true, ...options } = {}) {
  const root = await stateRoot();
  const daemon = await startPreviousReleaseDaemon(root, { sessions: [liveSession] });
  const publication = { pid: daemon.pid, startIdentity: "111222333", processGroupId: daemon.pid, tokenPath: daemon.tokenPath };
  /** @type {any[]} */
  const signalled = [];
  /** @type {string[][]} */
  const spawned = [];
  let stopped = false;
  try {
    const result = await runDaemonCommand(command, {
      root,
      inspect: async () => {
        if (stopped) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        return publication;
      },
      inspectEndpoint: async () => stopped
        ? (spawned.length === 0 ? { status: "ABSENT" } : { status: "HEALTHY", daemonState: "READY", publication: { ...publication, pid: 5000 } })
        : { status: "HEALTHY", daemonState: "READY", publication },
      stopProcessGroup: async (/** @type {any} */ ownership, /** @type {any} */ deps) => {
        signalled.push(ownership);
        await deps.requestGraceful(ownership);
        stopped = true;
        return { disposition: "GRACEFUL" };
      },
      spawnDaemon: (/** @type {string} */ _file, /** @type {string[]} */ argv) => { spawned.push(argv); return { once() {} }; },
      ...options,
    });
    // The control stop frame is written and its socket destroyed before the command returns, so the
    // daemon side of it lands after that. Bounded so a lost frame fails as an assertion, not a hang.
    if (expectStop) await Promise.race([daemon.stopped, new Promise((settle) => setTimeout(settle, 10_000))]);
    return { result, daemon, signalled, spawned, publication };
  } finally {
    await daemon.close();
  }
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

/**
 * Run one daemon command against a clock only the test moves.
 *
 * Faking `Date` alone leaves `setTimeout` and the file system real, so the polling wait still runs
 * its own 25 ms steps while each poll costs the caller `stepMs` of apparent time. Faking the timers
 * too deadlocks: an `fs/promises` call never settles while `vi.advanceTimersByTimeAsync` is running.
 *
 * @param {string} command @param {any} options @param {number} stepMs
 * @returns {Promise<{ result: any, elapsedMs: number[] }>} the command's result and the apparent time of each poll
 */
async function underSlowClock(command, options, stepMs) {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const startedAt = Date.now();
    let apparentMs = 0;
    /** @type {number[]} */
    const elapsedMs = [];
    const inspectEndpoint = async (/** @type {any} */ request) => {
      elapsedMs.push(apparentMs);
      apparentMs += stepMs;
      vi.setSystemTime(startedAt + apparentMs);
      return options.inspectEndpoint(request);
    };
    return { result: await runDaemonCommand(command, { ...options, inspectEndpoint }), elapsedMs };
  } finally {
    vi.useRealTimers();
  }
}

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
    root: "/state", inspectEndpoint: async () => endpoints.shift() ?? { status: "ABSENT" }, request: request,
    stopWorkers: true, yes: true, stopProcessGroup: async () => ({ disposition: "GRACEFUL" }),
  })).resolves.toMatchObject({ code: 0, result: { kind: "daemon_stopped", stoppedSessionIds: ["live"] } });
  expect(operations).toEqual([["get_state", {}], ["stop", { sessionId: "live", revision: 4 }]]);
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
    request: async (op, ...rest) => { operations.push(op); return respond(op, ...rest); },
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

it("maps absent, unhealthy, and identity-conflict status to stable exit codes", async () => {
  for (const [status, code] of [["ABSENT", 3], ["UNHEALTHY", 1], ["CONFLICT", 5]]) {
    const result = await runDaemonCommand("status", { root: "/state", inspectEndpoint: async () => ({ status }) });
    expect(result.code).toBe(code);
  }
});

/**
 * Serve one control socket that answers the liveness probe only after `delayMs`.
 *
 * @param {string} directory @param {number} delayMs
 * @returns {Promise<{ tokenPath: string, close(): Promise<void> }>}
 */
async function slowControlSocket(directory, delayMs) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tokenPath = join(directory, "control.token");
  await writeFile(tokenPath, "probe-token\n", { mode: 0o600 });
  /** @type {NodeJS.Timeout[]} */
  const timers = [];
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      timers.push(setTimeout(() => socket.write(`${JSON.stringify({ version: 1, kind: "authenticated", state: "READY" })}\n`), delayMs));
    });
    socket.on("error", () => {});
  });
  await new Promise((ready) => server.listen(join(directory, "control.sock"), () => ready(undefined)));
  return {
    tokenPath,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      await new Promise((closed) => server.close(() => closed(undefined)));
    },
  };
}

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

// The refusal an operator meets on a current daemon, and the one an earlier release could not
// reach far enough to raise. It moved into stopLiveWorkers with this commit and was untested before.
it("still refuses a daemon stop while workers are live and --stop-workers is absent", async () => {
  const publication = { pid: 321, startIdentity: "987654321", processGroupId: 654, tokenPath: "/state/daemon/control.token" };
  const stopProcessGroup = vi.fn();
  const result = await runDaemonCommand("stop", {
    root: "/state",
    inspectEndpoint: async () => ({ status: "HEALTHY", daemonState: "READY", publication }),
    request: async () => ({ kind: "state", sessions: [liveSession] }),
    stopProcessGroup,
  });

  expect(result).toMatchObject({ code: 1, error: { code: "WORKERS_LIVE" }, result: { kind: "live_workers", sessionIds: ["live-session"] } });
  expect(stopProcessGroup).not.toHaveBeenCalled();
});

// Operator-visible failure, 2026-08-31: probing an older daemon is not restarting one. The stop the
// restart runs first opened a frontend connection only to read `get_state` for its live-worker
// check, and the previous release refused that connection's authentication frame, so
// `pi-agents daemon restart` failed with AUTHENTICATION_FAILED during the one release that
// requires a restart. The restart never needed those rows: it stops the daemon whatever they say.
it("restarts a daemon from the previous release without opening a frontend connection", async () => {
  const { result, daemon, signalled, spawned } = await againstPreviousRelease("restart");

  expect(result).toMatchObject({ code: 0, result: { kind: "daemon_started", alreadyRunning: false } });
  expect(daemon.refusals).toEqual([]);
  expect(daemon.requests).toEqual([]);
  expect(daemon.stopRequests).toHaveLength(1);
  expect(signalled).toEqual([{ pid: daemon.pid, startIdentity: "111222333", processGroupId: daemon.pid }]);
  expect(spawned).toHaveLength(1);
});

it("refuses --stop-workers against a daemon from the previous release, naming the release and the restart", async () => {
  const { result, daemon, signalled } = await againstPreviousRelease("stop", { stopWorkers: true, yes: true, expectStop: false });

  expect(result).toMatchObject({ code: 1, error: { code: "DAEMON_FROM_EARLIER_RELEASE", message: expect.stringContaining("pi-agents daemon restart") } });
  expect(daemon.requests).toEqual([]);
  expect(daemon.stopRequests).toEqual([]);
  expect(signalled).toEqual([]);
});

// The spike proved a forged or malformed frame is refused. Naming an older release must not become
// a way to read a refused token as a version problem.
it("keeps a refused token a refused token rather than an earlier release", async () => {
  const root = await stateRoot();
  const daemon = await startPreviousReleaseDaemon(root, { token: "server-token" });
  await writeFile(join(root, "daemon", "control.token"), "wrong-token\n", { mode: 0o600 });
  const publication = { pid: daemon.pid, startIdentity: "111222333", processGroupId: daemon.pid, tokenPath: daemon.tokenPath };
  const stopProcessGroup = vi.fn();
  try {
    await expect(runDaemonCommand("stop", {
      root,
      inspect: async () => publication,
      inspectEndpoint: async () => ({ status: "HEALTHY", daemonState: "READY", publication }),
      stopProcessGroup,
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(stopProcessGroup).not.toHaveBeenCalled();
  } finally {
    await daemon.close();
  }
});

// A restart that finds the endpoint absent, then loses the race to a daemon that publishes itself
// again, returned the start leg's `alreadyRunning` success. That is how a process from the previous
// day kept serving every launch while the operator read "daemon_started" and believed the deploy.
it("refuses when restart did not replace the running daemon", async () => {
  const root = await stateRoot();
  const old = { pid: 4242, startIdentity: "111222333", processGroupId: 4242, tokenPath: join(root, "daemon", "control.token") };
  let inspections = 0;
  const spawned = [];

  const result = await runDaemonCommand("restart", {
    root,
    timeoutMs: 200,
    stopPolicy: { gracefulMs: 1, terminateMs: 1 },
    inspect: async () => old,
    // Absent for restart's own look, healthy again by the time the start leg re-reads it.
    inspectEndpoint: async () => {
      inspections += 1;
      return inspections === 1
        ? { status: "ABSENT", canCleanup: false }
        : { status: "HEALTHY", daemonState: "READY", publication: old };
    },
    spawnDaemon: (/** @type {string} */ _file, /** @type {string[]} */ argv) => { spawned.push(argv); return { once() {} }; },
  });

  expect(result).toMatchObject({ code: 5, error: { code: "DAEMON_NOT_REPLACED" } });
  expect(result.error.message).toContain(String(old.pid));
  expect(spawned).toEqual([]);
});

it("reports the identity it replaced when restart starts a new daemon", async () => {
  const root = await stateRoot();
  const old = { pid: 4242, startIdentity: "111222333", processGroupId: 4242, tokenPath: join(root, "daemon", "control.token") };
  const live = new Map([[old.pid, old]]);
  let publication = old;

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
    requestGraceful: async () => { live.delete(old.pid); publication = undefined; },
    signalProcessGroup: () => {},
    spawnDaemon: () => {
      const pid = 5001;
      live.set(pid, { pid, startIdentity: "999888777", processGroupId: pid });
      publication = { pid, startIdentity: "999888777", processGroupId: pid, tokenPath: old.tokenPath };
      return { once() {} };
    },
  });

  expect(result).toMatchObject({
    code: 0,
    result: { kind: "daemon_started", alreadyRunning: false, publication: { pid: 5001 }, replacedPublication: { pid: 4242 } },
  });
});
