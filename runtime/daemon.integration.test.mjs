import net from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

import { createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";
import { createDaemonRuntime } from "./daemon.mjs";
import { RegistryStore } from "./registry-store.mjs";

/** @type {any[]} */
const runtimes = [];
/** @type {string[]} */
const roots = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), "dashboard-daemon-"));
  roots.push(value);
  return value;
}

/** @param {any} options @returns {any} */
function connect({ socketPath, token, role, maxBytes = 1024, onFrame }) {
  const decoder = createJsonlDecoder({ maxBytes });
  const encoder = createJsonlEncoder({ maxBytes });
  /** @type {any[]} */
  const received = [];
  const socket = net.createConnection(socketPath);
  /** @type {Array<(value: any) => void>} */
  const waiters = [];
  socket.on("data", (chunk) => {
    for (const frameValue of decoder.push(chunk)) {
      const frame = /** @type {any} */ (frameValue);
      if (frame?.kind !== "authenticated" && onFrame?.(frame, socket, encoder) === true) continue;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else received.push(frame);
    }
  });
  const next = () => received.length > 0 ? Promise.resolve(received.shift()) : new Promise((resolve) => waiters.push(resolve));
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", () => {
      socket.write(encoder.encode(role === undefined ? { version: 1, token } : { version: 1, token, role }));
      resolve(undefined);
    });
    socket.once("error", reject);
  }).then(next);
  /** @param {any} value */
  const send = (value) => { socket.write(encoder.encode(value)); };
  return { socket, ready, next, send, close() { socket.destroy(); } };
}

it("shares one daemon across two effective Pi config roots and rejects mutations while recovering", async () => {
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const stateRoot = await root();
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    hostProbe: async () => ({ blockers: [] }),
    reconcile: async (/** @type {any} */ options) => {
      await recoveryGate;
      return options.defaultReconcile();
    },
  });
  runtimes.push(runtime);
  const first = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const second = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([first.ready, second.ready]);
  /** @param {string} clientId @param {string} requestId @param {string} op @param {any} payload */
  const request = (clientId, requestId, op, payload) => ({ version: 1, clientId, requestId, op, payload });
  first.send(request("root-a", "state-a", "get_state", {}));
  second.send(request("root-b", "state-b", "get_state", {}));
  expect(await first.next()).toMatchObject({ ok: true, result: { kind: "state" } });
  expect(await second.next()).toMatchObject({ ok: true, result: { kind: "state" } });
  first.send(request("root-a", "prompt-a", "prompt", { sessionId: "missing", text: "next" }));
  expect(await first.next()).toMatchObject({ ok: false, error: { code: "RECOVERING" } });
  /** @type {(value?: unknown) => void} */ (releaseRecovery)();
  await runtime.ready;
  expect(runtime.status()).toMatchObject({ recovering: false, state: "READY" });
  first.close();
  second.close();
});

it("authenticates every connection and applies strict framing limits", async () => {
  const runtime = await createDaemonRuntime({ root: await root(), hostProbe: async () => ({ blockers: [] }), maxBytes: 256 });
  runtimes.push(runtime);
  await runtime.ready;
  const wrong = connect({ socketPath: runtime.socketPath, token: "wrong", maxBytes: 1024 });
  expect(await wrong.ready).toMatchObject({ ok: false, error: { code: "AUTHENTICATION_FAILED" } });
  wrong.close();

  const oversized = await new Promise((resolve) => {
    const socket = net.createConnection(runtime.socketPath);
    let text = "";
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: 1, token: "x".repeat(400) })}\n`));
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("close", () => resolve(JSON.parse(text.trim())));
  });
  expect(oversized).toMatchObject({ error: { code: "FRAME_TOO_LARGE" } });
});

it("reconnects two exact workers and routes durable commands after daemon restart", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identities = new Map([
    [201, { pid: 201, startIdentity: "worker-one", processGroupId: 201 }],
    [202, { pid: 202, startIdentity: "worker-two", processGroupId: 202 }],
  ]);
  /** @param {number} pid */
  const inspect = async (pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : identities.get(pid) ?? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  for (const [sessionId, pid] of /** @type {Array<[string, number]>} */ ([["one", 201], ["two", 202]])) {
    const identity = /** @type {import("../shared/contracts.js").ProcessIdentity} */ (identities.get(pid));
    await registry.create({ schemaVersion: 1, revision: 0, sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, canonicalSessionFile: `/sessions/${sessionId}.jsonl`, cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: `run-${sessionId}`, process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: `run-${sessionId}`, createdAt: now, updatedAt: now });
  }
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [
    { sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, identity: identities.get(201), piChildIdentity: identities.get(201) },
    { sessionId: "two", runId: "run-two", leaseId: "lease-two", generation: 1, identity: identities.get(202), piChildIdentity: identities.get(202) },
  ] })}\n`, { mode: 0o600 });

  const startAndReconnect = async () => {
    const runtime = await createDaemonRuntime({ root: stateRoot, inspect, hostProbe: async () => ({ blockers: [] }), reconnectTimeoutMs: 500 });
    const workers = [
      { sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, identity: identities.get(201), token: "worker-token-one" },
      { sessionId: "two", runId: "run-two", leaseId: "lease-two", generation: 1, identity: identities.get(202), token: "worker-token-two" },
    ].map((worker) => {
      const connection = connect({
        socketPath: runtime.socketPath,
        token: runtime.token,
        role: "worker",
        onFrame(/** @type {any} */ frame, /** @type {any} */ socket, /** @type {any} */ encoder) {
          if (frame?.type !== "command") return false;
          socket.write(encoder.encode({ version: 1, type: "command_result", token: worker.token, id: frame.id, ok: true, record: { stage: "RPC_ACKNOWLEDGED" } }));
          return true;
        },
      });
      void connection.ready.then(() => connection.send({ version: 1, type: "worker_ready", token: worker.token, sessionId: worker.sessionId, runId: worker.runId, leaseId: worker.leaseId, generation: worker.generation, worker: worker.identity, piChild: worker.identity }));
      return connection;
    });
    await runtime.ready;
    return { runtime, workers };
  };

  const first = await startAndReconnect();
  const frontend = connect({ socketPath: first.runtime.socketPath, token: first.runtime.token });
  await frontend.ready;
  frontend.send({ version: 1, clientId: "client", requestId: "before-restart", op: "prompt", payload: { sessionId: "one", text: "hello" } });
  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  frontend.send({ version: 1, clientId: "client", requestId: "ack-before-restart", op: "ack", payload: { cursor: { daemonEpoch: first.runtime.daemonEpoch, sequence: "1" } } });
  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "acknowledged", cursor: { sequence: "1" } } });
  frontend.close();
  await first.runtime.close();
  first.workers.forEach((worker) => worker.close());

  const second = await startAndReconnect();
  runtimes.push(second.runtime);
  const resumed = connect({ socketPath: second.runtime.socketPath, token: second.runtime.token });
  await resumed.ready;
  expect(second.runtime.daemonEpoch).toBe(first.runtime.daemonEpoch);
  expect(second.runtime.token).toBe(first.runtime.token);
  resumed.send({ version: 1, clientId: "client", requestId: "resume-events", op: "subscribe", payload: { after: { daemonEpoch: second.runtime.daemonEpoch, sequence: "0" } } });
  expect(await resumed.next()).toMatchObject({ ok: true, result: { kind: "subscribed", cursor: { sequence: "1" } } });
  expect(await resumed.next()).toMatchObject({ kind: "command_changed", payload: { status: { requestId: "before-restart" } } });
  resumed.send({ version: 1, clientId: "client", requestId: "after-restart", op: "steer", payload: { sessionId: "two", text: "next" } });
  expect(await resumed.next()).toMatchObject({ kind: "command_changed", payload: { status: { requestId: "after-restart", stage: "COMPLETED" } } });
  expect(await resumed.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  resumed.close();
  second.workers.forEach((worker) => worker.close());
});

it("closes daemon and frontend sockets without signaling worker processes", async () => {
  /** @type {any[]} */
  const signals = [];
  /** @param {any[]} args */
  const signalWorker = (...args) => signals.push(args);
  const runtime = await createDaemonRuntime({ root: await root(), hostProbe: async () => ({ blockers: [] }), signalWorker });
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await client.ready;
  client.close();
  await runtime.close();
  expect(signals).toEqual([]);
});
