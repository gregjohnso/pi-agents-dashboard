import net from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { CLIENT_PROTOCOL } from "../shared/contracts.mjs";
import { connectDaemon } from "./daemon-connector.mjs";
import { createDaemonRuntime } from "./daemon.mjs";
import { createIdleExit } from "./idle-exit.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";
import { RegistryStore } from "./registry-store.mjs";

/**
 * What holds the daemon open, decided against a real daemon over its real socket.
 *
 * Idle is not "no connected clients": a worker holds a connection too, and a command, a launch or a
 * replacement can outlive the dashboard that started it. Each case here drives the daemon into one
 * state and asks its own idle decision, because an unwired hold is invisible in a reason string.
 */

/** @type {any[]} */
const runtimes = [];
/** @type {any[]} */
const workers = [];
/** @type {any[]} */
const sockets = [];
/** @type {string[]} */
const roots = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const IDENTITY = { pid: 401, startIdentity: "40100", processGroupId: 401 };
const PI_CHILD = { pid: 402, startIdentity: "40200", processGroupId: 401 };
const AT = "2026-08-25T12:00:00.000Z";

/** One live worker on the daemon's own socket. A silent one never answers a command, which is what leaves it in flight. @param {any} config @param {any} worker */
function startFakeWorker(config, worker) {
  const controller = new AbortController();
  let commandCount = 0;
  /** @type {any} */
  let live;
  const run = (async () => {
    while (!controller.signal.aborted) {
      /** @type {any} */
      let connection;
      try {
        connection = await connectDaemon({ config: { ...config, maxBytes: 4 * 1024 }, signal: controller.signal });
        live = connection;
        connection.onMessage((/** @type {any} */ frame) => {
          if (frame?.type !== "command") return;
          commandCount += 1;
          if (worker.silent === true) return;
          void connection.send({ version: 1, type: "command_result", token: worker.token, id: frame.id, ok: true, record: { clientId: frame.command.clientId, requestId: frame.command.requestId, op: frame.command.op, stage: "RPC_ACKNOWLEDGED", at: AT, result: null } });
        });
        await connection.send({ version: 1, type: "worker_ready", token: worker.token, sessionId: worker.sessionId, runId: worker.runId, leaseId: worker.leaseId, generation: worker.generation, worker: IDENTITY, piChild: PI_CHILD });
        await connection.closed;
      } catch {
      } finally {
        connection?.close();
      }
      if (!controller.signal.aborted) await new Promise((wait) => setTimeout(wait, 10));
    }
  })();
  const loop = {
    get commandCount() { return commandCount; },
    async sendEvent(/** @type {any} */ event) { await live.send({ version: 1, type: "worker_event", token: worker.token, sessionId: worker.sessionId, event }); },
    async stop() { controller.abort(); await run; },
  };
  workers.push(loop);
  return loop;
}

/** One dashboard connection, as a raw socket, so closing it is what closing a dashboard does. @param {any} runtime */
async function openDashboard(runtime) {
  const encoder = createJsonlEncoder({ maxBytes: 64 * 1024 });
  const decoder = createJsonlDecoder({ maxBytes: 64 * 1024 });
  const socket = net.createConnection(runtime.socketPath);
  sockets.push(socket);
  /** @type {any[]} */
  const received = [];
  /** @type {Array<(value: any) => void>} */
  const waiters = [];
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    for (const frame of decoder.push(chunk)) {
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else received.push(frame);
    }
  });
  const next = () => received.length > 0 ? Promise.resolve(received.shift()) : new Promise((resolve) => waiters.push(resolve));
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(encoder.encode({ version: 1, token: runtime.token, clientProtocol: CLIENT_PROTOCOL, attachId: "attach-idle" }));
  await next();
  return {
    next,
    /** @param {string} requestId @param {string} op @param {any} payload */
    send(requestId, op, payload) { socket.write(encoder.encode({ version: 1, clientId: "idle-exit", requestId, op, payload })); },
    async close() { socket.destroy(); await new Promise((resolve) => socket.once("close", resolve)); },
  };
}

/**
 * A daemon with one adopted live worker, whose replacement launches wait for the test to release
 * them. Holding a launch is what keeps a known number of them in flight.
 * @param {{ sessionId?: string, cliVersion?: string, silent?: boolean, taskState?: import("../shared/contracts.mjs").TaskState, activityKind?: string }} [options]
 */
async function daemonWithWorker({ sessionId = "held", cliVersion, silent = false, taskState = "READY", activityKind = "assistant_final" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "daemon-idle-exit-"));
  roots.push(root);
  for (const name of ["canonical", "daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(root, name), { mode: 0o700 });
  const sessionFile = join(root, "canonical", `${sessionId}.jsonl`);
  const registry = new RegistryStore(join(root, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId, sessionFile, canonicalSessionFile: sessionFile, cwd: root, taskState, processState: "LIVE", outcome: "NONE", activity: { kind: activityKind, summary: "running", updatedAt: AT }, ownership: { kind: "managed", runId: `run-${sessionId}`, process: IDENTITY, acquiredAt: AT, heartbeatAt: AT }, latestRunId: `run-${sessionId}`, createdAt: AT, updatedAt: AT });
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, identity: IDENTITY, piChildIdentity: PI_CHILD, ...(cliVersion === undefined ? {} : { cliVersion }) }] })}\n`, { mode: 0o600 });

  /** @type {string[]} */
  const launches = [];
  /** @type {() => void} */
  let releaseLaunch = () => {};
  const launchGate = new Promise((resolve) => { releaseLaunch = () => resolve(undefined); });
  let alive = true;
  const runtime = await createDaemonRuntime({
    root,
    cliVersion: "2.0.0",
    reconnectTimeoutMs: 2_000,
    stopPolicy: { gracefulMs: 20, terminateMs: 20 },
    sleepImpl: async () => {},
    inspect: async (/** @type {number} */ pid) => {
      if (pid === process.pid) return { pid, startIdentity: "1", processGroupId: process.pid };
      if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return pid === IDENTITY.pid ? IDENTITY : PI_CHILD;
    },
    signalProcessGroupImpl: (/** @type {number} */ _pgid, /** @type {string} */ signal) => { if (signal === "SIGTERM") alive = false; },
    recordDiagnostic: () => {},
    resolveLaunchRequest: async (/** @type {any} */ requested) => ({ sessionId: `new-${requested.requestId}`, runId: `run-new-${requested.requestId}`, canonicalSessionFile: join(root, "canonical", `new-${requested.requestId}.jsonl`), cwd: root }),
    workerSupervisor: {
      useRouter() {},
      async launch(/** @type {any} */ requested) { launches.push(requested.sessionId); await launchGate; return { sessionId: requested.sessionId }; },
      async close() {},
    },
  });
  runtimes.push(runtime);
  const worker = startFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, token: `${sessionId}-token`, silent });
  await runtime.ready;
  await vi.waitFor(() => expect(runtime.status().connectedWorkers).toContain(sessionId), { timeout: 5_000, interval: 25 });
  return { root, sessionId, registry, runtime, worker, launches, releaseLaunch };
}

/** Run the daemon's own idle decision at a clock this test moves, and report whether it exited. @param {any} runtime */
function idleDecision(runtime) {
  const idleMs = 1_000;
  let clock = 0;
  const exit = vi.fn();
  const idle = createIdleExit({ idleMs, now: () => clock, onIdle: exit, hold: () => runtime.idleHold() });
  return {
    exit,
    /** Let the whole idle window pass with no other activity. */
    passWindow() {
      idle.check();
      clock += idleMs;
      idle.check();
    },
  };
}

// Operator-visible failure: every dashboard was closed and the daemon stayed resident forever,
// serving whatever build it started with, because its own workers' connections looked like clients.
it("does not treat a live worker's connection as a client, so a session alone never holds it open", async () => {
  const live = await daemonWithWorker();

  expect(live.runtime.idleHold()).toBeUndefined();
  const decision = idleDecision(live.runtime);
  decision.passWindow();
  expect(decision.exit).toHaveBeenCalledTimes(1);
});

// Operator-visible failure: the daemon exits under the dashboard the operator is looking at.
it("does not exit while a dashboard is connected", async () => {
  const live = await daemonWithWorker();
  await openDashboard(live.runtime);

  expect(live.runtime.idleHold()).toBe("clients");
  const decision = idleDecision(live.runtime);
  decision.passWindow();
  expect(decision.exit).not.toHaveBeenCalled();
});

// Operator-visible failure: the operator submits a prompt and closes the dashboard. The daemon exits
// before the worker answers, so the reply is lost and the command's delivery is recorded as unknown
// when it was about to be known.
it("does not exit while a command is in flight with a worker", async () => {
  const live = await daemonWithWorker({ silent: true });
  const dashboard = await openDashboard(live.runtime);
  dashboard.send("prompt", "prompt", { sessionId: live.sessionId, text: "still going" });
  await vi.waitFor(() => expect(live.worker.commandCount).toBe(1), { timeout: 5_000, interval: 25 });

  // The command outranks the dashboard that sent it: its bytes are with a worker that still owes a
  // reply, and that is true whether or not anyone is still watching.
  expect(live.runtime.idleHold()).toBe("commands");
  const decision = idleDecision(live.runtime);
  decision.passWindow();
  expect(decision.exit).not.toHaveBeenCalled();
});

// Operator-visible failure: a launch abandoned halfway leaves a prepared record, a Pi session file and
// possibly a worktree with no worker and nothing that says why.
it("does not exit while a launch is in progress", async () => {
  const live = await daemonWithWorker();
  // A held launch outlives a failed assertion, and the daemon cannot close until it is released.
  try {
    const dashboard = await openDashboard(live.runtime);
    dashboard.send("launch", "launch", { prompt: "starting", cwd: live.root, sourceSessionId: "source", isolation: { mode: "shared_directory", confirmedCwd: live.root, ownerSessionIds: [live.sessionId] } });
    await vi.waitFor(() => expect(live.launches).toHaveLength(1), { timeout: 5_000, interval: 25 });

    // A launch is its own hold rather than resting on the connection that asked for it: half a
    // launch is a prepared record, a Pi session file and possibly a worktree with no worker.
    expect(live.runtime.idleHold()).toBe("launches");
    const decision = idleDecision(live.runtime);
    decision.passWindow();
    expect(decision.exit).not.toHaveBeenCalled();
  } finally {
    live.releaseLaunch();
  }
});

// Operator-visible failure: the daemon signalled a stale worker, then exited before starting its
// replacement, leaving a session the operator was using with no worker and no Pi child at all.
it("does not exit while a worker replacement it scheduled is still running", async () => {
  // Only Pi settling a running turn opens the automatic replacement boundary, so the session has to
  // be working before the event that settles it.
  const live = await daemonWithWorker({ cliVersion: "1.9.0", taskState: "WORKING", activityKind: "tool" });
  try {
    await live.worker.sendEvent({ type: "TURN_COMPLETED", at: AT });
    await vi.waitFor(() => expect(live.launches).toEqual([live.sessionId]), { timeout: 8_000, interval: 25 });

    expect(live.runtime.idleHold()).toBe("replacements");
    const decision = idleDecision(live.runtime);
    decision.passWindow();
    expect(decision.exit).not.toHaveBeenCalled();
  } finally {
    live.releaseLaunch();
  }
});
