import net from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { CLIENT_PROTOCOL } from "../shared/contracts.mjs";
import { startListeningWorker } from "./test-fixtures.mjs";
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
  const socketPath = join(root, "daemon", "workers", `${sessionId}.sock`);
  await mkdir(join(root, "daemon", "workers"), { mode: 0o700 });
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, identity: IDENTITY, piChildIdentity: PI_CHILD, token: `${sessionId}-token`, socketPath, proto: 2, ...(cliVersion === undefined ? {} : { cliVersion }) }] })}\n`, { mode: 0o600 });
  // The worker listens before the daemon starts, which is the arrangement: the daemon connects to it.
  const worker = await startListeningWorker({ socketPath, token: `${sessionId}-token`, sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, worker: IDENTITY, piChild: PI_CHILD, silent });
  workers.push(worker);

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
