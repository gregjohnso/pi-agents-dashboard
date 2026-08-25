import net from "node:net";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

import { connectDaemon } from "./daemon-connector.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";
import { createDaemonRuntime } from "./daemon.mjs";
import { RegistryStore } from "./registry-store.mjs";

/** @type {any[]} */
const runtimes = [];
/** @type {any[]} */
const workerLoops = [];
/** @type {string[]} */
const roots = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(workerLoops.splice(0).map((worker) => worker.stop()));
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
  const closed = new Promise((resolve) => socket.once("close", resolve));
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
  socket.on("error", () => {});
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
  return { socket, ready, closed, next, send, close() { socket.destroy(); } };
}

/** @param {{ socketPath: string, tokenPath: string }} config @param {any} worker */
function startPersistentFakeWorker(config, worker) {
  const controller = new AbortController();
  let connectionCount = 0;
  let commandCount = 0;
  /** @type {string[]} */
  const commandIds = [];
  /** @type {any} */
  let previousCommand;
  let alive = true;
  const run = (async () => {
    while (!controller.signal.aborted) {
      /** @type {any} */
      let connection;
      try {
        connection = await connectDaemon({ config: { ...config, maxBytes: 1024 }, signal: controller.signal });
        connectionCount += 1;
        connection.onMessage((/** @type {any} */ frame) => {
          if (frame?.type !== "command") return;
          commandCount += 1;
          commandIds.push(frame.id);
          if (frame.command.requestId === worker.malformedRequestId) {
            void connection.send({ version: 1, type: "command_result", token: worker.token, id: frame.id, ok: true, record: { stage: "RPC_ACKNOWLEDGED" } });
            return;
          }
          if (previousCommand !== undefined) {
            void connection.send({
              version: 1,
              type: "command_result",
              token: worker.token,
              id: previousCommand.id,
              ok: true,
              record: { clientId: previousCommand.command.clientId, requestId: previousCommand.command.requestId, op: previousCommand.command.op, stage: "RPC_ACKNOWLEDGED", at: new Date().toISOString(), result: null },
            });
          }
          previousCommand = frame;
          void connection.send({
            version: 1,
            type: "command_result",
            token: worker.token,
            id: frame.id,
            ok: true,
            record: { clientId: frame.command.clientId, requestId: frame.command.requestId, op: frame.command.op, stage: "RPC_ACKNOWLEDGED", at: new Date().toISOString(), result: null },
          });
        });
        await connection.send({ version: 1, type: "worker_ready", token: worker.token, sessionId: worker.sessionId, runId: worker.runId, leaseId: worker.leaseId, generation: worker.generation, worker: worker.identity, piChild: worker.piChildIdentity });
        await connection.closed;
      } catch {
      } finally {
        connection?.close();
      }
      if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    alive = false;
  })();
  const loop = { pid: worker.identity.pid, get alive() { return alive; }, get connectionCount() { return connectionCount; }, get commandCount() { return commandCount; }, get commandIds() { return [...commandIds]; }, async stop() { controller.abort(); await run; } };
  workerLoops.push(loop);
  return loop;
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

it("rejects worker mutations during reconciliation without touching unopened stores", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const workerIdentity = { pid: 901, startIdentity: "worker-901", processGroupId: 901 };
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "recovering", sessionFile: "/sessions/recovering.jsonl", canonicalSessionFile: "/sessions/recovering.jsonl", cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: "run-recovering", process: workerIdentity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-recovering", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "recovering", runId: "run-recovering", leaseId: "lease-recovering", generation: 1, identity: workerIdentity, piChildIdentity: workerIdentity }] })}\n`, { mode: 0o600 });
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseRecovery;
  const gate = new Promise((resolve) => { releaseRecovery = resolve; });
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    inspect: async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : workerIdentity,
    reconnectTimeoutMs: 20,
    reconcile: async (/** @type {any} */ options) => { await gate; return options.defaultReconcile(); },
  });
  const worker = connect({ socketPath: runtime.socketPath, token: runtime.token, role: "worker" });
  await worker.ready;
  worker.send({ version: 1, type: "worker_ready", token: "private-worker", sessionId: "recovering", runId: "run-recovering", leaseId: "lease-recovering", generation: 1, worker: workerIdentity, piChild: workerIdentity });
  await new Promise((resolve) => setTimeout(resolve, 10));
  worker.send({ version: 1, type: "worker_event", token: "private-worker", sessionId: "recovering", event: { type: "TURN_STARTED", at: now } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(runtime.status()).toMatchObject({ state: "RECONCILING" });
  /** @type {(value?: unknown) => void} */ (releaseRecovery)();
  await expect(runtime.ready).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
  await runtime.close();
  worker.close();
});

it("arbitrates one composer per session and persists release before observer takeover", async () => {
  const workerSupervisor = { close: vi.fn(), stop: vi.fn(), delete: vi.fn() };
  const runtime = await createDaemonRuntime({ root: await root(), workerSupervisor });
  runtimes.push(runtime);
  await runtime.ready;
  const first = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const second = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const observer = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([first.ready, second.ready, observer.ready]);
  /** @param {string} clientId @param {string} requestId @param {string} op @param {any} payload */
  const request = (clientId, requestId, op, payload) => ({ version: 1, clientId, requestId, op, payload });

  observer.send(request("watcher", "subscribe", "subscribe", {}));
  expect(await observer.next()).toMatchObject({ ok: true, result: { kind: "subscribed" } });
  first.send(request("client-a", "attach-a", "attach", { sessionId: "session", role: "composer" }));
  second.send(request("client-b", "attach-b", "attach", { sessionId: "session", role: "composer" }));
  const [firstResponse, secondResponse] = await Promise.all([first.next(), second.next()]);
  expect([firstResponse.result.role, secondResponse.result.role].sort()).toEqual(["composer", "observer"]);
  await observer.next();
  await observer.next();

  const winner = firstResponse.result.role === "composer" ? first : second;
  const loser = winner === first ? second : first;
  const loserClient = winner === first ? "client-b" : "client-a";
  winner.close();
  const released = await observer.next();
  expect(released).toMatchObject({ kind: "attachment_changed", payload: { sessionId: "session", role: "composer", attached: false } });

  loser.send(request(loserClient, "attach-retry", "attach", { sessionId: "session", role: "composer" }));
  expect(await loser.next()).toMatchObject({ ok: true, result: { kind: "attached", role: "composer" } });
  expect(await observer.next()).toMatchObject({ kind: "attachment_changed", payload: { clientId: loserClient, role: "composer", attached: true } });
  expect(workerSupervisor.stop).not.toHaveBeenCalled();
  expect(workerSupervisor.delete).not.toHaveBeenCalled();
  loser.close();
  observer.close();
});

it("binds composer ownership to the exact authenticated connection even for the same stable client ID", async () => {
  /** @type {any[]} */
  const signals = [];
  /** @param {any[]} args */
  const signalWorker = (...args) => signals.push(args);
  const runtime = await createDaemonRuntime({ root: await root(), signalWorker });
  runtimes.push(runtime);
  await runtime.ready;
  const first = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const spoof = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([first.ready, spoof.ready]);
  /** @param {string} requestId */
  const attach = (requestId) => ({ version: 1, clientId: "same-client", requestId, op: "attach", payload: { sessionId: "session", role: "composer" } });
  first.send(attach("first"));
  expect(await first.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  spoof.send(attach("spoof"));
  expect(await spoof.next()).toMatchObject({ ok: true, result: { role: "observer" } });
  spoof.send({ version: 1, clientId: "same-client", requestId: "spoof-detach", op: "detach", payload: { sessionId: "session" } });
  expect(await spoof.next()).toMatchObject({ ok: true, result: { kind: "detached" } });
  const third = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await third.ready;
  third.send(attach("third"));
  expect(await third.next()).toMatchObject({ ok: true, result: { role: "observer" } });
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reconnect = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await reconnect.ready;
  reconnect.send(attach("reconnect"));
  expect(await reconnect.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  expect(signals).toEqual([]);
  spoof.close();
  third.close();
  reconnect.close();
});

it("rejects wrong-client detach on one connection and releases only the exact authenticated claim", async () => {
  const runtime = await createDaemonRuntime({ root: await root() });
  runtimes.push(runtime);
  await runtime.ready;
  const owner = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const contender = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([owner.ready, contender.ready]);
  owner.send({ version: 1, clientId: "owner", requestId: "attach", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await owner.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  owner.send({ version: 1, clientId: "wrong", requestId: "wrong-detach", op: "detach", payload: { sessionId: "session" } });
  expect(await owner.next()).toMatchObject({ ok: false, error: { code: "CLIENT_IDENTITY_CONFLICT" } });
  contender.send({ version: 1, clientId: "contender", requestId: "attach-before", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await contender.next()).toMatchObject({ ok: true, result: { role: "observer" } });
  owner.send({ version: 1, clientId: "owner", requestId: "exact-detach", op: "detach", payload: { sessionId: "session" } });
  expect(await owner.next()).toMatchObject({ ok: true, result: { kind: "detached" } });
  contender.send({ version: 1, clientId: "contender", requestId: "attach-after", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await contender.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  owner.close();
  contender.close();
});

it("installs an in-flight attachment reservation across sockets before arbitration", async () => {
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseAppend;
  /** @type {((value?: unknown) => void) | undefined} */
  let appendReached;
  const appendGate = new Promise((resolve) => { releaseAppend = resolve; });
  const reached = new Promise((resolve) => { appendReached = resolve; });
  let appendCount = 0;
  const runtime = await createDaemonRuntime({
    root: await root(),
    reconcile: async (/** @type {any} */ options) => {
      const recovery = await options.defaultReconcile();
      const append = recovery.events.append.bind(recovery.events);
      recovery.events.append = async (/** @type {any} */ event) => {
        if (event.kind === "attachment_changed" && event.payload.attached === true) {
          appendCount += 1;
          appendReached?.();
          await appendGate;
        }
        return append(event);
      };
      return recovery;
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const first = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const duplicate = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const conflict = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([first.ready, duplicate.ready, conflict.ready]);
  const attach = { version: 1, clientId: "stable", requestId: "same", op: "attach", payload: { sessionId: "session", role: "composer" } };
  first.send(attach);
  await reached;
  duplicate.send(attach);
  conflict.send({ ...attach, op: "detach", payload: { sessionId: "session" } });
  expect(await conflict.next()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
  releaseAppend?.();
  const [firstResult, duplicateResult] = await Promise.all([first.next(), duplicate.next()]);
  expect(firstResult).toMatchObject({ ok: true, result: { role: "composer" } });
  expect(duplicateResult).toEqual(firstResult);
  expect(appendCount).toBe(1);
  first.close();
  duplicate.close();
  conflict.close();
});

it("serializes disconnect behind an attach whose durable append is in flight", async () => {
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseAppend;
  /** @type {((value?: unknown) => void) | undefined} */
  let appendReached;
  const appendGate = new Promise((resolve) => { releaseAppend = resolve; });
  const reached = new Promise((resolve) => { appendReached = resolve; });
  const runtime = await createDaemonRuntime({
    root: await root(),
    reconcile: async (/** @type {any} */ options) => {
      const recovery = await options.defaultReconcile();
      const append = recovery.events.append.bind(recovery.events);
      recovery.events.append = async (/** @type {any} */ event) => {
        if (event.kind === "attachment_changed" && event.payload.clientId === "closing" && event.payload.attached) {
          appendReached?.();
          await appendGate;
        }
        return append(event);
      };
      return recovery;
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const observer = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([client.ready, observer.ready]);
  observer.send({ version: 1, clientId: "watcher", requestId: "subscribe", op: "subscribe", payload: {} });
  await observer.next();
  client.send({ version: 1, clientId: "closing", requestId: "attach", op: "attach", payload: { sessionId: "session", role: "composer" } });
  await reached;
  client.close();
  /** @type {(value?: unknown) => void} */ (releaseAppend)();
  expect(await observer.next()).toMatchObject({ payload: { clientId: "closing", attached: true } });
  expect(await observer.next()).toMatchObject({ payload: { clientId: "closing", attached: false } });

  const next = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await next.ready;
  next.send({ version: 1, clientId: "next", requestId: "attach", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await next.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  next.close();
  observer.close();
});

it("registers a pending session before its serializer lock and rejects it after close", async () => {
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseAppend;
  /** @type {((value?: unknown) => void) | undefined} */
  let appendReached;
  /** @type {((value?: unknown) => void) | undefined} */
  let pendingRegistered;
  const appendGate = new Promise((resolve) => { releaseAppend = resolve; });
  const reached = new Promise((resolve) => { appendReached = resolve; });
  const registered = new Promise((resolve) => { pendingRegistered = resolve; });
  const runtime = await createDaemonRuntime({
    root: await root(),
    attachmentFailpoint(/** @type {string} */ stage, /** @type {any} */ request) {
      if (stage === "registered" && request.clientId === "closing") pendingRegistered?.();
    },
    reconcile: async (/** @type {any} */ options) => {
      const recovery = await options.defaultReconcile();
      const append = recovery.events.append.bind(recovery.events);
      recovery.events.append = async (/** @type {any} */ event) => {
        if (event.kind === "attachment_changed" && event.payload.clientId === "blocker" && event.payload.attached) {
          appendReached?.();
          await appendGate;
        }
        return append(event);
      };
      return recovery;
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const blocker = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const closing = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const observer = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([blocker.ready, closing.ready, observer.ready]);
  observer.send({ version: 1, clientId: "watcher", requestId: "subscribe", op: "subscribe", payload: {} });
  await observer.next();
  blocker.send({ version: 1, clientId: "blocker", requestId: "attach", op: "attach", payload: { sessionId: "session", role: "composer" } });
  await reached;
  closing.send({ version: 1, clientId: "closing", requestId: "attach", op: "attach", payload: { sessionId: "session", role: "composer" } });
  await registered;
  closing.close();
  /** @type {(value?: unknown) => void} */ (releaseAppend)();
  await blocker.next();
  expect(await observer.next()).toMatchObject({ payload: { clientId: "blocker", attached: true } });
  blocker.close();
  expect(await observer.next()).toMatchObject({ payload: { clientId: "blocker", attached: false } });

  const next = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await next.ready;
  next.send({ version: 1, clientId: "next", requestId: "attach", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await next.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  next.close();
  observer.close();
});

it("replays durable attachment outcomes across request pressure and daemon restart", async () => {
  const stateRoot = await root();
  const firstRuntime = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(firstRuntime);
  await firstRuntime.ready;
  const first = connect({ socketPath: firstRuntime.socketPath, token: firstRuntime.token });
  await first.ready;
  const original = { version: 1, clientId: "stable", requestId: "original", op: "attach", payload: { sessionId: "session", role: "composer" } };
  first.send(original);
  const originalResponse = await first.next();
  expect(originalResponse).toMatchObject({ ok: true, result: { kind: "attached", role: "composer" } });
  first.close();
  await first.closed;

  const pressure = connect({ socketPath: firstRuntime.socketPath, token: firstRuntime.token });
  await pressure.ready;
  const pressureRequests = Array.from({ length: 20 }, (_, index) => ({ version: 1, clientId: "pressure", requestId: `detach-${index}`, op: "detach", payload: { sessionId: `other-${index}` } }));
  pressureRequests.forEach(pressure.send);
  const pressureResponses = await Promise.all(pressureRequests.map(() => pressure.next()));
  expect(pressureResponses.every((value) => value.ok === true && value.result?.kind === "detached")).toBe(true);
  pressure.close();
  await firstRuntime.close();

  const eventPath = join(stateRoot, "index", "events.jsonl");
  const beforeReplay = await readFile(eventPath, "utf8");
  const secondRuntime = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(secondRuntime);
  await secondRuntime.ready;
  const replay = connect({ socketPath: secondRuntime.socketPath, token: secondRuntime.token });
  await replay.ready;
  replay.send(original);
  expect(await replay.next()).toEqual(originalResponse);
  expect(await readFile(eventPath, "utf8")).toBe(beforeReplay);
  replay.send({ ...original, payload: { sessionId: "session", role: "observer" } });
  expect(await replay.next()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
  expect(await readFile(eventPath, "utf8")).toBe(beforeReplay);
  replay.close();
});

it("mutates a durable claim before broadcast and retains it when broadcast fails", async () => {
  /** @type {string[]} */
  const order = [];
  let rejectBroadcast = true;
  const runtime = await createDaemonRuntime({
    root: await root(),
    /** @param {any} event @param {() => void} broadcast */
    broadcastEvent(event, broadcast) {
      if (event.kind === "attachment_changed") order.push("broadcast");
      if (rejectBroadcast && event.kind === "attachment_changed") {
        rejectBroadcast = false;
        throw Object.assign(new Error("injected broadcast failure"), { code: "BROADCAST_FAILED" });
      }
      broadcast();
    },
    reconcile: async (/** @type {any} */ options) => {
      const recovery = await options.defaultReconcile();
      const append = recovery.events.append.bind(recovery.events);
      recovery.events.append = async (/** @type {any} */ event) => {
        if (event.kind === "attachment_changed") order.push("append");
        return append(event);
      };
      return recovery;
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const first = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const second = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([first.ready, second.ready]);
  first.send({ version: 1, clientId: "first", requestId: "attach-first", op: "attach", payload: { sessionId: "session", role: "composer" } });
  const failed = await first.next();
  expect(failed).toMatchObject({ ok: false, error: { code: "BROADCAST_FAILED" } });
  const orderAfterFailure = [...order];
  first.send({ version: 1, clientId: "first", requestId: "attach-first", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await first.next()).toEqual(failed);
  expect(order).toEqual(orderAfterFailure);
  second.send({ version: 1, clientId: "second", requestId: "attach-second", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await second.next()).toMatchObject({ ok: true, result: { role: "observer" } });
  expect(order.slice(0, 2)).toEqual(["append", "broadcast"]);
  first.close();
  second.close();
});

it("leaves an attachment claim unchanged when durable attachment event append fails", async () => {
  let rejectNextAttachment = false;
  const runtime = await createDaemonRuntime({
    root: await root(),
    reconcile: async (/** @type {any} */ options) => {
      const recovery = await options.defaultReconcile();
      const append = recovery.events.append.bind(recovery.events);
      recovery.events.append = async (/** @type {any} */ event) => {
        if (rejectNextAttachment && event.kind === "attachment_changed") {
          rejectNextAttachment = false;
          throw Object.assign(new Error("injected append failure"), { code: "PERSIST_FAILED" });
        }
        return append(event);
      };
      return recovery;
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const first = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const second = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([first.ready, second.ready]);
  first.send({ version: 1, clientId: "first", requestId: "attach-first", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await first.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  rejectNextAttachment = true;
  first.send({ version: 1, clientId: "first", requestId: "detach-fails", op: "detach", payload: { sessionId: "session" } });
  expect(await first.next()).toMatchObject({ ok: false, error: { code: "PERSIST_FAILED" } });
  second.send({ version: 1, clientId: "second", requestId: "attach-second", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await second.next()).toMatchObject({ ok: true, result: { role: "observer" } });
  first.close();
  second.close();
});

it("does not install a claim when the durable attach event fails", async () => {
  let rejectNextAttachment = true;
  const runtime = await createDaemonRuntime({
    root: await root(),
    reconcile: async (/** @type {any} */ options) => {
      const recovery = await options.defaultReconcile();
      const append = recovery.events.append.bind(recovery.events);
      recovery.events.append = async (/** @type {any} */ event) => {
        if (rejectNextAttachment && event.kind === "attachment_changed") {
          rejectNextAttachment = false;
          throw Object.assign(new Error("injected append failure"), { code: "PERSIST_FAILED" });
        }
        return append(event);
      };
      return recovery;
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const first = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const second = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([first.ready, second.ready]);
  first.send({ version: 1, clientId: "first", requestId: "attach-fails", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await first.next()).toMatchObject({ ok: false, error: { code: "PERSIST_FAILED" } });
  second.send({ version: 1, clientId: "second", requestId: "attach-succeeds", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await second.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  first.close();
  second.close();
});

it("keeps the exact connection claim when disconnect release persistence fails", async () => {
  let rejectRelease = false;
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseAttempted;
  const attempted = new Promise((resolve) => { releaseAttempted = resolve; });
  const runtime = await createDaemonRuntime({
    root: await root(),
    reconcile: async (/** @type {any} */ options) => {
      const recovery = await options.defaultReconcile();
      const append = recovery.events.append.bind(recovery.events);
      recovery.events.append = async (/** @type {any} */ event) => {
        if (rejectRelease && event.kind === "attachment_changed" && event.payload.attached === false) {
          rejectRelease = false;
          releaseAttempted?.();
          throw Object.assign(new Error("injected disconnect append failure"), { code: "PERSIST_FAILED" });
        }
        return append(event);
      };
      return recovery;
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const first = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await first.ready;
  first.send({ version: 1, clientId: "first", requestId: "attach", op: "attach", payload: { sessionId: "session", role: "composer" } });
  await first.next();
  rejectRelease = true;
  first.close();
  await attempted;
  const second = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await second.ready;
  second.send({ version: 1, clientId: "second", requestId: "attach", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await second.next()).toMatchObject({ ok: true, result: { role: "observer" } });
  second.close();
});

it("drains a durable disconnect release chain before daemon shutdown completes", async () => {
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseAppend;
  /** @type {((value?: unknown) => void) | undefined} */
  let appendReached;
  const appendGate = new Promise((resolve) => { releaseAppend = resolve; });
  const reached = new Promise((resolve) => { appendReached = resolve; });
  let gateRelease = false;
  const runtime = await createDaemonRuntime({
    root: await root(),
    reconcile: async (/** @type {any} */ options) => {
      const recovery = await options.defaultReconcile();
      const append = recovery.events.append.bind(recovery.events);
      recovery.events.append = async (/** @type {any} */ event) => {
        if (gateRelease && event.kind === "attachment_changed" && event.payload.attached === false) {
          appendReached?.();
          await appendGate;
        }
        return append(event);
      };
      return recovery;
    },
  });
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await client.ready;
  client.send({ version: 1, clientId: "client", requestId: "attach", op: "attach", payload: { sessionId: "session", role: "composer" } });
  await client.next();
  gateRelease = true;
  client.close();
  await reached;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(closed).toBe(false);
  releaseAppend?.();
  await closing;
  expect(closed).toBe(true);
});

it("serializes disconnect against attach and keeps duplicate attachment requests idempotent", async () => {
  const runtime = await createDaemonRuntime({ root: await root() });
  runtimes.push(runtime);
  await runtime.ready;
  const first = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const second = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const events = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([first.ready, second.ready, events.ready]);
  const attach = { version: 1, clientId: "stable-a", requestId: "same-attach", op: "attach", payload: { sessionId: "session", role: "composer" } };
  events.send({ version: 1, clientId: "watcher", requestId: "subscribe", op: "subscribe", payload: {} });
  await events.next();
  first.send(attach);
  expect(await first.next()).toMatchObject({ result: { role: "composer" } });
  await events.next();
  first.send(attach);
  expect(await first.next()).toMatchObject({ result: { role: "composer" } });
  first.close();
  expect(await events.next()).toMatchObject({ payload: { clientId: "stable-a", attached: false } });
  second.send({ ...attach, clientId: "stable-b", requestId: "attach-b" });
  expect(await second.next()).toMatchObject({ result: { role: "composer" } });
  const transitions = [
    { payload: { clientId: "stable-a", attached: false } },
    await events.next(),
  ];
  expect(transitions.map((event) => [event.payload.clientId, event.payload.attached])).toEqual([
    ["stable-a", false],
    ["stable-b", true],
  ]);
  second.close();
  events.close();
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

it("settles connector authentication on silent close, auth-close race, and normal post-auth close", async () => {
  const stateRoot = await root();
  const tokenPath = join(stateRoot, "connector-close.token");
  await writeFile(tokenPath, "private-token\n", { mode: 0o600 });

  const silentPath = join(stateRoot, "silent-close.sock");
  /** @type {net.Socket | undefined} */
  let silentSocket;
  const silentServer = net.createServer((socket) => {
    silentSocket = socket;
    socket.end();
  });
  await new Promise((resolve, reject) => {
    silentServer.once("error", reject);
    silentServer.listen(silentPath, () => resolve(undefined));
  });
  await expect(connectDaemon({ config: { socketPath: silentPath, tokenPath, maxBytes: 1024 } })).rejects.toMatchObject({ code: "DAEMON_AUTHENTICATION_CLOSED" });
  silentSocket?.destroy();
  await new Promise((resolve) => silentServer.close(() => resolve(undefined)));

  const racingPath = join(stateRoot, "racing-close.sock");
  const racingServer = net.createServer((socket) => {
    const decoder = createJsonlDecoder({ maxBytes: 1024 });
    const encoder = createJsonlEncoder({ maxBytes: 1024 });
    socket.on("data", (chunk) => {
      if (decoder.push(chunk).length > 0) socket.end(encoder.encode({ version: 1, kind: "authenticated" }));
    });
  });
  await new Promise((resolve, reject) => {
    racingServer.once("error", reject);
    racingServer.listen(racingPath, () => resolve(undefined));
  });
  const racingConnection = await connectDaemon({ config: { socketPath: racingPath, tokenPath, maxBytes: 1024 } });
  await racingConnection.closed;
  await new Promise((resolve) => racingServer.close(() => resolve(undefined)));

  const normalPath = join(stateRoot, "normal-close.sock");
  /** @type {net.Socket | undefined} */
  let serverSocket;
  const normalServer = net.createServer((socket) => {
    serverSocket = socket;
    const decoder = createJsonlDecoder({ maxBytes: 1024 });
    const encoder = createJsonlEncoder({ maxBytes: 1024 });
    socket.on("data", (chunk) => {
      if (decoder.push(chunk).length > 0) socket.write(encoder.encode({ version: 1, kind: "authenticated" }));
    });
  });
  await new Promise((resolve, reject) => {
    normalServer.once("error", reject);
    normalServer.listen(normalPath, () => resolve(undefined));
  });
  const normalConnection = await connectDaemon({ config: { socketPath: normalPath, tokenPath, maxBytes: 1024 } });
  serverSocket?.end();
  await normalConnection.closed;
  await new Promise((resolve) => normalServer.close(() => resolve(undefined)));
});

it("contains connector listener exceptions and keeps an error handler after authentication", async () => {
  const stateRoot = await root();
  const socketPath = join(stateRoot, "connector.sock");
  const tokenPath = join(stateRoot, "connector.token");
  await writeFile(tokenPath, "private-token\n", { mode: 0o600 });
  const server = net.createServer((socket) => {
    const decoder = createJsonlDecoder({ maxBytes: 1024 });
    const encoder = createJsonlEncoder({ maxBytes: 1024 });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (decoder.push(chunk).length === 0) return;
      socket.write(encoder.encode({ version: 1, kind: "authenticated" }), () => {
        setTimeout(() => socket.write(encoder.encode({ version: 1, type: "command", id: "late-frame" })), 10);
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  const connection = await connectDaemon({ config: { socketPath, tokenPath, maxBytes: 1024 } });
  connection.onMessage(() => { throw new Error("listener failure"); });
  await Promise.race([connection.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("connector did not close")), 500))]);
  await new Promise((resolve) => server.close(() => resolve(undefined)));
});

it("publishes failed recovery status and removes lifecycle artifacts on close", async () => {
  const stateRoot = await root();
  const runtime = await createDaemonRuntime({ root: stateRoot, reconcile: async () => { throw Object.assign(new Error("ownership conflict"), { code: "OWNERSHIP_CONFLICT" }); } });
  await expect(runtime.ready).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
  const status = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await expect(status.ready).resolves.toMatchObject({ state: "FAILED", error: { code: "OWNERSHIP_CONFLICT" } });
  status.close();
  await runtime.close();
  await expect(access(join(stateRoot, "daemon", "pid.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(runtime.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed and closes partial cursor stores", async () => {
  const stateRoot = await root();
  await mkdir(join(stateRoot, "daemon"), { mode: 0o700 });
  await writeFile(join(stateRoot, "daemon", "event-acks.json"), "{\"client\":", { mode: 0o600 });
  const runtime = await createDaemonRuntime({ root: stateRoot });
  await expect(runtime.ready).rejects.toThrow();
  expect(runtime.status()).toMatchObject({ state: "FAILED" });
  await runtime.close();
  await expect(access(join(stateRoot, "daemon", "pid.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("cancels and drains reconciliation before releasing lifecycle ownership", async () => {
  const stateRoot = await root();
  let sawAbort = false;
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    reconcile: async (/** @type {any} */ { signal }) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      sawAbort = true;
      throw Object.assign(new Error("cancelled"), { code: "RECONCILIATION_CANCELLED" });
    },
  });
  await runtime.close();
  expect(sawAbort).toBe(true);
  await expect(access(join(stateRoot, "daemon", "pid.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("shares close state, reports every staged failure after releasing lifecycle ownership", async () => {
  const stateRoot = await root();
  /** @type {string[]} */
  const failedStages = [];
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    closeFailpoint: async (/** @type {string} */ stage) => {
      failedStages.push(stage);
      throw new Error(`injected ${stage} close failure`);
    },
  });
  await runtime.ready;
  const firstClose = runtime.close();
  const secondClose = runtime.close();
  expect(secondClose).toBe(firstClose);
  await expect(firstClose).rejects.toMatchObject({ code: "DAEMON_CLOSE_FAILED", errors: { length: 9 } });
  expect(runtime.status().closeState).toBe("FAILED_CLOSED");
  expect(failedStages).toEqual(["request_admission", "reconciliation", "request_chains", "supervisor", "cursor_store", "launch_result_store", "attachment_result_store", "recovery_stores", "lifecycle"]);
  await expect(access(join(stateRoot, "daemon", "pid.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(runtime.socketPath)).rejects.toMatchObject({ code: "ENOENT" });

  const replacement = await createDaemonRuntime({ root: stateRoot });
  await replacement.ready;
  await replacement.close();
});

it("serializes monotonic event acknowledgements by stable socket client identity", async () => {
  const stateRoot = await root();
  const runtime = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(runtime);
  await runtime.ready;
  const first = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const second = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([first.ready, second.ready]);
  for (const [client, requestId] of [[first, "event-one"], [second, "event-two"]]) {
    client.send({ version: 1, clientId: "stable-client", requestId, op: "prompt", payload: { sessionId: "missing", text: "x" } });
    await client.next();
  }
  first.send({ version: 1, clientId: "stable-client", requestId: "ack-two", op: "ack", payload: { cursor: { daemonEpoch: runtime.daemonEpoch, sequence: "2" } } });
  second.send({ version: 1, clientId: "stable-client", requestId: "ack-one", op: "ack", payload: { cursor: { daemonEpoch: runtime.daemonEpoch, sequence: "1" } } });
  await Promise.all([first.next(), second.next()]);
  const cursors = JSON.parse(await readFile(join(stateRoot, "daemon", "event-acks.json"), "utf8"));
  expect(cursors["stable-client"]).toEqual({ daemonEpoch: runtime.daemonEpoch, sequence: "2" });
  first.send({ version: 1, clientId: "changed-client", requestId: "wrong-client", op: "ack", payload: { cursor: { daemonEpoch: runtime.daemonEpoch, sequence: "2" } } });
  expect(await first.next()).toMatchObject({ ok: false, error: { code: "CLIENT_IDENTITY_CONFLICT" } });
  first.close();
  second.close();
});

it("journals launch before the irreversible call and refuses ambiguous duplicate retry", async () => {
  const stateRoot = await root();
  let launches = 0;
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    hostProbe: async () => ({ blockers: [] }),
    resolveLaunchRequest: async () => ({ sessionId: "launch-session" }),
    workerSupervisor: {
      async launch() { launches += 1; throw Object.assign(new Error("crash after spawn"), { code: "LAUNCH_CRASH" }); },
      async close() {},
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await client.ready;
  const launch = { version: 1, clientId: "launcher", requestId: "exact-launch", op: "launch", payload: { prompt: "go", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" } } };
  client.send(launch);
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "LAUNCH_CRASH" } });
  expect(await runtime.commandStatus(launch)).toMatchObject({ stage: "DELIVERY_UNKNOWN" });
  client.send(launch);
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "DELIVERY_UNKNOWN" } } });
  expect(launches).toBe(1);
  client.close();
});

it("replays a durably terminal launch after deterministic response loss without relaunching", async () => {
  const stateRoot = await root();
  let launches = 0;
  let loseFirstResponse = true;
  /** @type {((value?: unknown) => void) | undefined} */
  let responseReached;
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseResponse;
  const responseReachedPromise = new Promise((resolve) => { responseReached = resolve; });
  const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
  const workerIdentity = { pid: 701, startIdentity: "worker-701", processGroupId: 701 };
  const now = "2026-08-25T12:00:00.000Z";
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    inspect: async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : workerIdentity,
    hostProbe: async () => ({ blockers: [] }),
    resolveLaunchRequest: async () => {
      const registry = new RegistryStore(join(stateRoot, "sessions"));
      if (await registry.get("launch-once") === undefined) {
        await registry.create({ schemaVersion: 1, revision: 0, sessionId: "launch-once", sessionFile: "/sessions/launch-once.jsonl", canonicalSessionFile: "/sessions/launch-once.jsonl", cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: "run-launch-once", process: workerIdentity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-launch-once", createdAt: now, updatedAt: now });
      }
      return { sessionId: "launch-once" };
    },
    workerSupervisor: {
      async launch() {
        launches += 1;
        return { sessionId: "launch-once", runId: "run-launch-once", leaseId: "lease-launch-once", generation: 1, identity: workerIdentity, piChildIdentity: workerIdentity };
      },
      async close() {},
    },
    responseWriter: async (/** @type {any} */ { request, value, write, close }) => {
      if (request.requestId !== "lost-launch-response" || !loseFirstResponse) return write(value);
      loseFirstResponse = false;
      responseReached?.();
      await responseGate;
      close();
      throw Object.assign(new Error("injected response loss"), { code: "SOCKET_CLOSED" });
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const launch = { version: 1, clientId: "launcher", requestId: "lost-launch-response", op: "launch", payload: { prompt: "go", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" } } };
  const firstClient = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await firstClient.ready;
  firstClient.send(launch);
  await responseReachedPromise;
  const journalStages = (await readFile(join(stateRoot, "queue", "commands.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).status.stage);
  expect(journalStages).toEqual(["ACCEPTED", "DELIVERY_ATTEMPTED", "WORKER_ACKNOWLEDGED", "COMPLETED"]);
  expect(await runtime.commandStatus(launch)).toMatchObject({ stage: "COMPLETED" });
  expect(JSON.parse(await readFile(join(stateRoot, "daemon", "launch-results.json"), "utf8"))).toMatchObject({ results: { "launcher\u0000lost-launch-response": { sessionId: "launch-once" } } });
  expect(launches).toBe(1);
  /** @type {(value?: unknown) => void} */ (releaseResponse)();
  await firstClient.closed;

  const retry = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await retry.ready;
  retry.send(launch);
  expect(await retry.next()).toMatchObject({ ok: true, result: { kind: "launched", sessionId: "launch-once" } });
  expect(launches).toBe(1);
  retry.close();
});

it("waits for an admitted launch chain before lifecycle release", async () => {
  const stateRoot = await root();
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseLaunch;
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    hostProbe: async () => ({ blockers: [] }),
    resolveLaunchRequest: async () => ({ sessionId: "launch-session" }),
    workerSupervisor: {
      async launch() { await launchGate; throw Object.assign(new Error("stopped launch"), { code: "LAUNCH_STOPPED" }); },
      async close() {},
    },
  });
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await client.ready;
  client.send({ version: 1, clientId: "launcher", requestId: "shutdown-launch", op: "launch", payload: { prompt: "go", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(closed).toBe(false);
  /** @type {(value?: unknown) => void} */ (releaseLaunch)();
  await closing;
  expect(closed).toBe(true);
  const journalAfterClose = await readFile(join(stateRoot, "queue", "commands.jsonl"), "utf8");
  const replacement = await createDaemonRuntime({ root: stateRoot });
  await replacement.ready;
  await replacement.close();
  expect(await readFile(join(stateRoot, "queue", "commands.jsonl"), "utf8")).toBe(journalAfterClose);
  client.close();
});

it("reconnects two surviving fake workers through the concrete connector after daemon restart", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identities = new Map([
    [201, { pid: 201, startIdentity: "worker-one", processGroupId: 201 }],
    [211, { pid: 211, startIdentity: "pi-one", processGroupId: 201 }],
    [202, { pid: 202, startIdentity: "worker-two", processGroupId: 202 }],
    [212, { pid: 212, startIdentity: "pi-two", processGroupId: 202 }],
  ]);
  /** @param {number} pid */
  const inspect = async (pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : identities.get(pid) ?? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  /** @type {any[]} */
  const workers = [
    { sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, identity: identities.get(201), piChildIdentity: identities.get(211), token: "worker-token-one", malformedRequestId: "invalid-worker-result" },
    { sessionId: "two", runId: "run-two", leaseId: "lease-two", generation: 1, identity: identities.get(202), piChildIdentity: identities.get(212), token: "worker-token-two" },
  ];
  for (const worker of workers) {
    await registry.create({ schemaVersion: 1, revision: 0, sessionId: worker.sessionId, sessionFile: `/sessions/${worker.sessionId}.jsonl`, canonicalSessionFile: `/sessions/${worker.sessionId}.jsonl`, cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: worker.runId, process: worker.identity, acquiredAt: now, heartbeatAt: now }, latestRunId: worker.runId, createdAt: now, updatedAt: now });
  }
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: workers.map(({ token: _token, malformedRequestId: _malformedRequestId, ...worker }) => worker) })}\n`, { mode: 0o600 });

  const firstRuntime = await createDaemonRuntime({ root: stateRoot, inspect, hostProbe: async () => ({ blockers: [] }), reconnectTimeoutMs: 1_000 });
  const loops = workers.map((worker) => startPersistentFakeWorker({ socketPath: firstRuntime.socketPath, tokenPath: firstRuntime.tokenPath }, worker));
  await firstRuntime.ready;
  const frontend = connect({ socketPath: firstRuntime.socketPath, token: firstRuntime.token });
  await frontend.ready;
  frontend.send({ version: 1, clientId: "client", requestId: "before-restart", op: "prompt", payload: { sessionId: "one", text: "hello" } });
  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  frontend.close();
  await firstRuntime.close();
  expect(loops.map((loop) => [loop.pid, loop.alive])).toEqual([[201, true], [202, true]]);

  const secondRuntime = await createDaemonRuntime({ root: stateRoot, inspect, hostProbe: async () => ({ blockers: [] }), reconnectTimeoutMs: 1_000 });
  runtimes.push(secondRuntime);
  await secondRuntime.ready;
  expect(secondRuntime.daemonEpoch).toBe(firstRuntime.daemonEpoch);
  expect(secondRuntime.token).toBe(firstRuntime.token);
  expect(loops.every((loop) => loop.connectionCount >= 2)).toBe(true);
  const malformed = connect({ socketPath: secondRuntime.socketPath, token: secondRuntime.token });
  await malformed.ready;
  malformed.send({ version: 1, clientId: "client", requestId: "invalid-worker-result", op: "prompt", payload: { sessionId: "one", text: "invalid result" } });
  expect(await malformed.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "DELIVERY_UNKNOWN" } } });
  malformed.close();
  const resumed = connect({ socketPath: secondRuntime.socketPath, token: secondRuntime.token });
  await resumed.ready;
  resumed.send({ version: 1, clientId: "client", requestId: "after-restart", op: "steer", payload: { sessionId: "two", text: "next" } });
  expect(await resumed.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  const beforeLostResponse = loops[1].commandCount;
  const lostResponse = { version: 1, clientId: "client", requestId: "lost-response", op: "prompt", payload: { sessionId: "two", text: "persist first" } };
  resumed.send(lostResponse);
  resumed.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const retry = connect({ socketPath: secondRuntime.socketPath, token: secondRuntime.token });
  await retry.ready;
  retry.send(lostResponse);
  expect(await retry.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  expect(loops[1].commandCount).toBe(beforeLostResponse + 1);
  expect(new Set(loops.flatMap((loop) => loop.commandIds)).size).toBe(loops.reduce((total, loop) => total + loop.commandIds.length, 0));
  retry.close();
  await secondRuntime.close();
  runtimes.splice(runtimes.indexOf(secondRuntime), 1);
  expect(loops.map((loop) => [loop.pid, loop.alive])).toEqual([[201, true], [202, true]]);
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
