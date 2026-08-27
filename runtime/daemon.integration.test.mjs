import net from "node:net";
import { EventEmitter } from "node:events";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

import { connectDaemon } from "./daemon-connector.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";
import { createBoundedSocketWriter, createDaemonRuntime } from "./daemon.mjs";
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

/** @param {string} text */
function attachmentEvents(text) {
  return text.trim().length === 0 ? [] : text.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.kind === "attachment_changed");
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
  /** @type {any[]} */
  const commands = [];
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
          commands.push(frame.command);
          if (worker.results !== undefined) {
            void connection.send({ version: 1, type: "command_result", token: worker.token, id: frame.id, ok: true, record: { clientId: frame.command.clientId, requestId: frame.command.requestId, op: frame.command.op, stage: "RPC_ACKNOWLEDGED", at: new Date().toISOString(), result: worker.results[frame.command.op] ?? null } });
            return;
          }
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
        for (const frame of worker.framesAfterReady ?? []) await connection.send({ version: 1, type: "pi_frame", token: worker.token, sessionId: worker.sessionId, frame });
        await connection.closed;
      } catch {
      } finally {
        connection?.close();
      }
      if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    alive = false;
  })();
  const loop = { pid: worker.identity.pid, get alive() { return alive; }, get connectionCount() { return connectionCount; }, get commandCount() { return commandCount; }, get commandIds() { return [...commandIds]; }, get commands() { return [...commands]; }, async stop() { controller.abort(); await run; } };
  workerLoops.push(loop);
  return loop;
}

it("orders bounded subscriber writes and waits for drain before advancing", () => {
  const socket = /** @type {any} */ (new EventEmitter());
  /** @type {{ value: string, callback: Function }[]} */
  const writes = [];
  socket.destroyed = false;
  socket.write = (/** @type {Buffer} */ value, /** @type {Function} */ callback) => { writes.push({ value: value.toString(), callback }); return writes.length !== 1; };
  socket.destroy = vi.fn(() => { socket.destroyed = true; });
  const writer = createBoundedSocketWriter(socket, { maxPendingBytes: 16, maxPendingRecords: 2 });
  expect(writer.enqueue(Buffer.from("one"))).toBe(true);
  expect(writer.enqueue(Buffer.from("two"))).toBe(true);
  expect(writes.map(({ value }) => value)).toEqual(["one"]);
  writes[0].callback();
  expect(writes).toHaveLength(1);
  socket.emit("drain");
  expect(writes.map(({ value }) => value)).toEqual(["one", "two"]);
  writes[1].callback();

  const blocked = /** @type {any} */ (new EventEmitter());
  blocked.destroyed = false;
  blocked.write = () => false;
  blocked.destroy = vi.fn(() => { blocked.destroyed = true; });
  const bounded = createBoundedSocketWriter(blocked, { maxPendingBytes: 4, maxPendingRecords: 1 });
  expect(bounded.enqueue(Buffer.from("1234"))).toBe(true);
  expect(bounded.enqueue(Buffer.from("x"))).toBe(false);
  expect(blocked.destroy).toHaveBeenCalledWith(expect.objectContaining({ code: "SUBSCRIBER_BACKPRESSURE_LIMIT" }));
});

it("rejects every composer-only command before journaling for observers and unattached sockets", async () => {
  const runtime = await createDaemonRuntime({ root: await root() });
  runtimes.push(runtime);
  await runtime.ready;
  const owner = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const observer = connect({ socketPath: runtime.socketPath, token: runtime.token });
  const unattached = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await Promise.all([owner.ready, observer.ready, unattached.ready]);
  owner.send({ version: 1, clientId: "owner", requestId: "attach-owner", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await owner.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  observer.send({ version: 1, clientId: "observer", requestId: "attach-observer", op: "attach", payload: { sessionId: "session", role: "composer" } });
  expect(await observer.next()).toMatchObject({ ok: true, result: { role: "observer" } });

  const variants = [
    ["prompt", { sessionId: "session", text: "next" }],
    ["follow_up", { sessionId: "session", text: "next" }],
    ["steer", { sessionId: "session", text: "next" }],
    ["interrupt", { sessionId: "session" }],
    ["ui_response", { sessionId: "session", uiRequestId: "ui", response: true }],
    ["stop", { sessionId: "session", revision: 1 }],
    ["delete", { sessionId: "session", revision: 1 }],
  ];
  for (const [op, payload] of variants) {
    const observerRequest = { version: 1, clientId: "observer", requestId: `observer-${op}`, op, payload };
    observer.send(observerRequest);
    expect(await observer.next()).toMatchObject({ ok: false, error: { code: "OBSERVER_READ_ONLY" } });
    expect(await runtime.commandStatus(observerRequest)).toBeUndefined();

    const unattachedRequest = { version: 1, clientId: "unattached", requestId: `unattached-${op}`, op, payload };
    unattached.send(unattachedRequest);
    expect(await unattached.next()).toMatchObject({ ok: false, error: { code: "ATTACHMENT_REQUIRED" } });
    expect(await runtime.commandStatus(unattachedRequest)).toBeUndefined();
  }
  owner.close();
  observer.close();
  unattached.close();
});

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

it("forgets a session whose worker lease points at a dead process", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const identity = { pid: 909, startIdentity: "90901", processGroupId: 909 };
  const sessionFile = join(stateRoot, "leased.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "leased", timestamp: now, cwd: stateRoot })}\n`, { mode: 0o600 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "leased", sessionFile, canonicalSessionFile: sessionFile, cwd: stateRoot, taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "assistant_final", summary: "done", updatedAt: now }, latestRunId: "run-leased", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "leased", runId: "run-leased", leaseId: "lease-leased", generation: 1, identity, piChildIdentity: identity }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    inspect: async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : Promise.reject(Object.assign(new Error("gone"), { code: "ESRCH" })),
    reconnectTimeoutMs: 200,
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;

  client.send({ version: 1, clientId: "viewer", requestId: "attach-leased", op: "attach", payload: { sessionId: "leased", role: "composer" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  client.send({ version: 1, clientId: "viewer", requestId: "forget-leased", op: "delete", payload: { sessionId: "leased", revision: 0 } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  expect(await registry.get("leased")).toBeUndefined();
  client.close();
});

it("forgets a dead session without touching its Pi session file, and never resurrects it on attach", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const sessionFile = join(stateRoot, "forgotten.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "forgotten", timestamp: now, cwd: stateRoot })}\n`, { mode: 0o600 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "forgotten", sessionFile, canonicalSessionFile: sessionFile, cwd: stateRoot, taskState: "STOPPED", processState: "EXITED", outcome: "NONE", activity: { kind: "assistant_final", summary: "done", updatedAt: now }, createdAt: now, updatedAt: now });
  const launch = vi.fn();
  const runtime = await createDaemonRuntime({ root: stateRoot, hostProbe: async () => ({ blockers: [] }), workerSupervisor: { launch, async close() {} } });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;

  client.send({ version: 1, clientId: "viewer", requestId: "attach-forget", op: "attach", payload: { sessionId: "forgotten", role: "composer" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  expect(launch).not.toHaveBeenCalled();

  client.send({ version: 1, clientId: "viewer", requestId: "forget", op: "delete", payload: { sessionId: "forgotten", revision: 0 } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  expect(await registry.get("forgotten")).toBeUndefined();
  expect(await readFile(sessionFile, "utf8")).toContain("\"type\":\"session\"");
  client.close();
});

it("marks a stopped session STOPPED rather than leaving it ready", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const identity = { pid: 701, startIdentity: "77001", processGroupId: 701 };
  const piChild = { pid: 702, startIdentity: "77002", processGroupId: 701 };
  let workerAlive = true;
  const inspect = async (/** @type {number} */ pid) => {
    if (pid === process.pid) return { pid, startIdentity: "daemon", processGroupId: process.pid };
    if (!workerAlive) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return pid === 701 ? identity : piChild;
  };
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "stopping", sessionFile: "/sessions/stopping.jsonl", canonicalSessionFile: "/sessions/stopping.jsonl", cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "assistant_stream", summary: "streaming", updatedAt: now }, ownership: { kind: "managed", runId: "run-stopping", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-stopping", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "stopping", runId: "run-stopping", leaseId: "lease-stopping", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({
    root: stateRoot, inspect,
    signalProcessGroupImpl: async () => {},
    stopPolicy: { gracefulMs: 200, terminateMs: 200 },
  });
  runtimes.push(runtime);
  startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "stopping", runId: "run-stopping", leaseId: "lease-stopping", generation: 1, identity, piChildIdentity: piChild, token: "stopping-token", results: { get_state: { sessionId: "stopping", isStreaming: true } } });
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "attach-stop", op: "attach", payload: { sessionId: "stopping", role: "composer" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  const current = await registry.get("stopping");
  if (current === undefined) throw new Error("stopping record missing");
  setTimeout(() => { workerAlive = false; }, 20);
  client.send({ version: 1, clientId: "viewer", requestId: "stop-request", op: "stop", payload: { sessionId: "stopping", revision: current.revision } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });

  expect(await registry.get("stopping")).toMatchObject({ taskState: "STOPPED", processState: "EXITED", outcome: "NONE" });
  client.close();
});

it("repairs an abandoned launch to FAILED and leaves finished sessions untouched", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "abandoned", sessionFile: "/sessions/abandoned.jsonl", canonicalSessionFile: "/sessions/abandoned.jsonl", cwd: "/repo", taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "launching", summary: "hello?", updatedAt: now }, createdAt: now, updatedAt: now });
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "finished", sessionFile: "/sessions/finished.jsonl", canonicalSessionFile: "/sessions/finished.jsonl", cwd: "/repo", taskState: "READY", processState: "EXITED", outcome: "COMPLETED", activity: { kind: "assistant_final", summary: "Pi assistant response received", updatedAt: now }, createdAt: now, updatedAt: now });

  const runtime = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(runtime);
  await runtime.ready;

  expect(await registry.get("abandoned")).toMatchObject({ taskState: "FAILED", processState: "EXITED", activity: { kind: "launch_failed" } });
  expect(await registry.get("finished")).toMatchObject({ taskState: "READY", outcome: "COMPLETED", activity: { kind: "assistant_final", summary: "Pi assistant response received" } });

  const published = (await readFile(join(stateRoot, "index", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(published.filter((event) => event.kind === "session_changed").map((event) => event.payload.session)).toEqual([
    expect.objectContaining({ sessionId: "abandoned", taskState: "FAILED", activity: expect.objectContaining({ kind: "launch_failed" }) }),
  ]);

  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 16384 });
  await client.ready;
  client.send({ version: 1, clientId: "watcher", requestId: "replay", op: "subscribe", payload: {} });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "subscribed" } });
  expect(await client.next()).toMatchObject({ kind: "session_changed", payload: { session: { sessionId: "abandoned", taskState: "FAILED" } } });
  client.close();
});

it("clears a stale WORKING session when the reconnected worker reports an idle Pi", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identity = { pid: 601, startIdentity: "stale-worker", processGroupId: 601 };
  const piChild = { pid: 602, startIdentity: "stale-pi", processGroupId: 601 };
  const inspect = async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : pid === 601 ? identity : piChild;
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "stale", sessionFile: "/sessions/stale.jsonl", canonicalSessionFile: "/sessions/stale.jsonl", cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "assistant_stream", summary: "Pi assistant streaming", updatedAt: now }, ownership: { kind: "managed", runId: "run-stale", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-stale", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "stale", runId: "run-stale", leaseId: "lease-stale", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({ root: stateRoot, inspect });
  runtimes.push(runtime);
  startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "stale", runId: "run-stale", leaseId: "lease-stale", generation: 1, identity, piChildIdentity: piChild, token: "stale-token", results: { get_state: { sessionId: "stale", isStreaming: false } } });
  await runtime.ready;

  await vi.waitFor(async () => expect(await registry.get("stale")).toMatchObject({ taskState: "READY", processState: "LIVE" }), { timeout: 5_000 });
});

it("marks a ready session working when the reconnected worker reports a streaming Pi", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identity = { pid: 611, startIdentity: "resumed-worker", processGroupId: 611 };
  const piChild = { pid: 612, startIdentity: "resumed-pi", processGroupId: 611 };
  const inspect = async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : pid === 611 ? identity : piChild;
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  // A turn that starts while the worker is disconnected drops its agent_start, so the row reads READY.
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "resumed", sessionFile: "/sessions/resumed.jsonl", canonicalSessionFile: "/sessions/resumed.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "assistant_final", summary: "done", updatedAt: now }, ownership: { kind: "managed", runId: "run-resumed", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-resumed", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "resumed", runId: "run-resumed", leaseId: "lease-resumed", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({ root: stateRoot, inspect });
  runtimes.push(runtime);
  startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "resumed", runId: "run-resumed", leaseId: "lease-resumed", generation: 1, identity, piChildIdentity: piChild, token: "resumed-token", results: { get_state: { sessionId: "resumed", isStreaming: true } } });
  await runtime.ready;

  await vi.waitFor(async () => expect(await registry.get("resumed")).toMatchObject({ taskState: "WORKING", processState: "LIVE" }), { timeout: 5_000 });
});

it("summarizes sessions only after the opt-in model is chosen and reuses cached summaries", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const sessionFile = join(stateRoot, "canonical.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "summary", timestamp: now, cwd: stateRoot })}\n${JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: now, message: { role: "user", content: "fix the loader" } })}\n`, { mode: 0o600 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "summary", sessionFile, canonicalSessionFile: sessionFile, cwd: stateRoot, taskState: "READY", processState: "SLEEPING", outcome: "NONE", activity: { kind: "idle", summary: "Idle", updatedAt: now }, createdAt: now, updatedAt: now });
  /** @type {any[]} */
  const summarized = [];
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    summarizeSession: async (/** @type {any} */ options) => { summarized.push(options); return { name: "Loader repair", text: "Fixes the loader" }; },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 16384 });
  await client.ready;

  client.send({ version: 1, clientId: "viewer", requestId: "settings-1", op: "get_settings", payload: {} });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "settings", summaryModel: null } });
  client.send({ version: 1, clientId: "viewer", requestId: "refresh-off", op: "refresh_summaries", payload: {} });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "summaries_refreshing", sessionIds: [] } });
  expect(summarized).toEqual([]);

  client.send({ version: 1, clientId: "viewer", requestId: "settings-2", op: "set_settings", payload: { summaryModel: { provider: "anthropic", id: "haiku" } } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "settings", summaryModel: { provider: "anthropic", id: "haiku" } } });
  client.send({ version: 1, clientId: "viewer", requestId: "refresh-on", op: "refresh_summaries", payload: {} });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "summaries_refreshing", sessionIds: ["summary"] } });
  await vi.waitFor(async () => expect((await registry.get("summary"))?.summary).toMatchObject({ text: "Fixes the loader", model: { provider: "anthropic", id: "haiku" } }));
  expect(summarized[0]).toMatchObject({ model: { provider: "anthropic", id: "haiku" }, transcript: "User: fix the loader" });

  expect(await registry.get("summary")).toMatchObject({ name: "Loader repair", nameGenerated: true });

  client.send({ version: 1, clientId: "viewer", requestId: "refresh-cached", op: "refresh_summaries", payload: {} });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "summaries_refreshing", sessionIds: [] } });
  expect(summarized).toHaveLength(1);
  client.close();
});

it("reaches a freshly launched worker over its launch channel before any socket reconnect", async () => {
  const stateRoot = await root();
  await mkdir(join(stateRoot, "sessions"), { mode: 0o700 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const createdAt = "2026-08-25T00:00:00.000Z";
  const identity = { pid: 501, startIdentity: "fresh-worker", processGroupId: 501 };
  /** @type {any[]} */
  const requested = [];
  /** @type {any[]} */
  const deliveries = [];
  const menu = { commands: [], models: [{ provider: "anthropic", id: "claude" }], thinkingLevels: ["off"], model: null, thinkingLevel: null };
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    hostProbe: async () => ({ blockers: [] }),
    resolveLaunchRequest: async (/** @type {any} */ request) => ({
      sessionId: "fresh", canonicalSessionFile: "/sessions/fresh.jsonl", cwd: "/repo", runId: "run-fresh", initialPrompt: request.payload.prompt,
      sessionRecord: { schemaVersion: 1, revision: 0, sessionId: "fresh", sessionFile: "/sessions/fresh.jsonl", canonicalSessionFile: "/sessions/fresh.jsonl", cwd: "/repo", taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "launching", summary: "start", updatedAt: createdAt }, isolation: { mode: "shared_directory", canonicalCwd: "/repo" }, createdAt, updatedAt: createdAt },
    }),
    workerSupervisor: {
      async launch() {
        const current = await registry.get("fresh");
        if (current === undefined) throw new Error("fresh record missing");
        await registry.update("fresh", current.revision, { ownership: { kind: "managed", runId: "run-fresh", process: identity, acquiredAt: createdAt, heartbeatAt: createdAt }, latestRunId: "run-fresh", processState: "LIVE", updatedAt: createdAt });
        return {
          sessionId: "fresh", runId: "run-fresh", leaseId: "lease-fresh", generation: 1, identity, piChildIdentity: identity,
          async request(/** @type {string} */ op) { requested.push(op); return { op, stage: "RPC_ACKNOWLEDGED", result: menu }; },
          async deliver(/** @type {any} */ command, /** @type {any} */ journal) {
            deliveries.push(command);
            const accepted = await journal.accept(command);
            if (accepted.stage !== "ACCEPTED") return accepted;
            await journal.transition(command, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
            await journal.transition(command, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
            return journal.transition(command, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
          },
          onFrame() {},
        };
      },
      async close() {},
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "launch-fresh", op: "launch", payload: { prompt: "start", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "shared_directory", confirmedCwd: "/repo", ownerSessionIds: [] } } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "launched", sessionId: "fresh" } });
  client.send({ version: 1, clientId: "viewer", requestId: "attach-fresh", op: "attach", payload: { sessionId: "fresh", role: "composer" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { role: "composer" } });

  client.send({ version: 1, clientId: "viewer", requestId: "menu-fresh", op: "get_session_commands", payload: { sessionId: "fresh" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "session_commands", models: [{ provider: "anthropic", id: "claude" }] } });
  client.send({ version: 1, clientId: "viewer", requestId: "prompt-fresh", op: "prompt", payload: { sessionId: "fresh", text: "hello" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  expect(requested).toEqual(["get_session_commands"]);
  expect(deliveries.map((/** @type {any} */ command) => command.op)).toEqual(["prompt", "prompt"]);
  client.close();
});

it("serves read-only session queries and session toggles from the owning worker", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identity = { pid: 431, startIdentity: "query-worker", processGroupId: 431 };
  const piChild = { pid: 432, startIdentity: "query-pi", processGroupId: 431 };
  const inspect = async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : pid === 431 ? identity : piChild;
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "query", sessionFile: "/sessions/query.jsonl", canonicalSessionFile: "/sessions/query.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: "run-query", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-query", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "query", runId: "run-query", leaseId: "lease-query", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({ root: stateRoot, inspect });
  runtimes.push(runtime);
  const worker = startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "query", runId: "run-query", leaseId: "lease-query", generation: 1, identity, piChildIdentity: piChild, token: "query-token", results: { session_query: ["messageCount: 12", "totalTokens: 3400"] } });
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "attach-query", op: "attach", payload: { sessionId: "query", role: "composer" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { role: "composer" } });

  client.send({ version: 1, clientId: "viewer", requestId: "stats-request", op: "session_query", payload: { sessionId: "query", query: "get_session_stats" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "session_query", sessionId: "query", query: "get_session_stats", rows: ["messageCount: 12", "totalTokens: 3400"] } });

  client.send({ version: 1, clientId: "viewer", requestId: "auto-compact", op: "session_command", payload: { sessionId: "query", command: "set_auto_compaction", enabled: false } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  client.send({ version: 1, clientId: "viewer", requestId: "steering", op: "session_command", payload: { sessionId: "query", command: "set_steering_mode", mode: "one-at-a-time" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });

  // get_state is the daemon's own reconnect probe, not a frontend request.
  const delivered = worker.commands.filter((/** @type {any} */ command) => !["get_session_commands", "get_state"].includes(command.op));
  expect(delivered[0]).toMatchObject({ op: "session_query", sessionQuery: { query: "get_session_stats" } });
  expect(delivered[1].sessionCommand).toEqual({ command: "set_auto_compaction", enabled: false });
  expect(delivered[2].sessionCommand).toEqual({ command: "set_steering_mode", mode: "one-at-a-time" });
  client.close();
});

it("discovers slash commands and delivers one session command to the owning worker", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identity = { pid: 401, startIdentity: "menu-worker", processGroupId: 401 };
  const piChild = { pid: 402, startIdentity: "menu-pi", processGroupId: 401 };
  const inspect = async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : pid === 401 ? identity : piChild;
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "menu", sessionFile: "/sessions/menu.jsonl", canonicalSessionFile: "/sessions/menu.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: "run-menu", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-menu", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "menu", runId: "run-menu", leaseId: "lease-menu", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({ root: stateRoot, inspect });
  runtimes.push(runtime);
  const menu = { commands: [{ name: "/review", source: "extension", description: "Review" }], models: [{ provider: "anthropic", id: "claude" }], thinkingLevels: ["off", "high"], model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high" };
  const worker = startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "menu", runId: "run-menu", leaseId: "lease-menu", generation: 1, identity, piChildIdentity: piChild, token: "menu-token", results: { get_session_commands: menu } });
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "attach-menu", op: "attach", payload: { sessionId: "menu", role: "composer" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  client.send({ version: 1, clientId: "viewer", requestId: "menu-request", op: "get_session_commands", payload: { sessionId: "menu" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "session_commands", sessionId: "menu", ...menu } });
  client.send({ version: 1, clientId: "viewer", requestId: "model-request", op: "session_command", payload: { sessionId: "menu", command: "set_model", model: { provider: "anthropic", id: "claude" } } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  client.send({ version: 1, clientId: "viewer", requestId: "rename-request", op: "session_command", payload: { sessionId: "menu", command: "set_session_name", name: "Coverage loader" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  await vi.waitFor(async () => expect(await new RegistryStore(join(stateRoot, "sessions")).get("menu")).toMatchObject({ name: "Coverage loader" }));
  const delivered = worker.commands.filter((/** @type {any} */ command) => command.op !== "get_state");
  expect(delivered.map((/** @type {any} */ command) => command.op)).toEqual(["get_session_commands", "session_command", "session_command"]);
  expect(delivered[1].sessionCommand).toEqual({ command: "set_model", model: { provider: "anthropic", id: "claude" } });
  expect(delivered[2].sessionCommand).toEqual({ command: "set_session_name", name: "Coverage loader" });
  client.close();
});

it("boots an exited session worker before granting its composer attachment", async () => {
  const stateRoot = await root();
  await mkdir(join(stateRoot, "sessions"), { mode: 0o700 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T00:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "resume", sessionFile: "/sessions/resume.jsonl", canonicalSessionFile: "/sessions/resume.jsonl", cwd: "/repo", taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "assistant_final", summary: "Saved", updatedAt: now }, createdAt: now, updatedAt: now });
  const identity = { pid: 321, startIdentity: "resumed-worker", processGroupId: 321 };
  const launch = vi.fn(async (request) => {
    const current = await registry.get("resume");
    if (current === undefined) throw new Error("resume record missing");
    await registry.update("resume", current.revision, { ownership: { kind: "managed", runId: request.runId, process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: request.runId, processState: "LIVE", updatedAt: now });
    return { sessionId: "resume", runId: request.runId, leaseId: "resume-lease", generation: 1, identity, piChildIdentity: identity };
  });
  const runtime = await createDaemonRuntime({ root: stateRoot, hostProbe: async () => ({ blockers: [] }), workerSupervisor: { launch, async close() {} } });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await client.ready;
  client.send({ version: 1, clientId: "client", requestId: "resume-attach", op: "attach", payload: { sessionId: "resume", role: "composer", activate: true } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached", sessionId: "resume", role: "composer" } });
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "resume", canonicalSessionFile: "/sessions/resume.jsonl", cwd: "/repo", runId: expect.any(String) }));
  client.close();
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

it.each([
  ["after_prepared", "abandon"],
  ["after_event_append", "retry_at_risk"],
  ["after_claim_mutation", "abandon"],
  ["after_broadcast", "retry_at_risk"],
  ["before_result_completion", "abandon"],
])("recovers attachment crash phase %s as durable ambiguity until %s", async (crashPhase, resolution) => {
  const stateRoot = await root();
  let crash = true;
  const original = { version: 1, clientId: "crash-client", requestId: `attach-${crashPhase}`, op: "attach", payload: { sessionId: `session-${crashPhase}`, role: "composer" } };
  const firstRuntime = await createDaemonRuntime({
    root: stateRoot,
    async attachmentFailpoint(/** @type {string} */ phase) {
      if (crash && phase === crashPhase) {
        crash = false;
        throw new Error(`crash at ${phase}`);
      }
    },
  });
  runtimes.push(firstRuntime);
  await firstRuntime.ready;
  const first = connect({ socketPath: firstRuntime.socketPath, token: firstRuntime.token });
  await first.ready;
  first.send(original);
  expect(await first.next()).toMatchObject({ ok: false });
  expect(await firstRuntime.commandStatus(original)).toMatchObject({ stage: "DELIVERY_ATTEMPTED" });
  first.close();
  await first.closed;
  await firstRuntime.close();
  runtimes.splice(runtimes.indexOf(firstRuntime), 1);

  const eventPath = join(stateRoot, "index", "events.jsonl");
  const beforeRecovery = await readFile(eventPath, "utf8");
  const secondRuntime = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(secondRuntime);
  await secondRuntime.ready;
  expect(await secondRuntime.commandStatus(original)).toMatchObject({ stage: "DELIVERY_UNKNOWN" });
  expect(await readFile(eventPath, "utf8")).toBe(beforeRecovery);

  const second = connect({ socketPath: secondRuntime.socketPath, token: secondRuntime.token });
  await second.ready;
  second.send(original);
  expect(await second.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "DELIVERY_UNKNOWN" } } });
  second.send({ ...original, payload: { ...original.payload, role: "observer" } });
  expect(await second.next()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
  expect(await readFile(eventPath, "utf8")).toBe(beforeRecovery);

  second.send({ version: 1, clientId: original.clientId, requestId: `resolve-${crashPhase}`, op: "resolve_delivery", payload: { targetClientId: original.clientId, targetRequestId: original.requestId, resolution } });
  expect(await second.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: resolution === "abandon" ? "FAILED" : "ACCEPTED" } } });
  second.send(original);
  if (resolution === "abandon") {
    expect(await second.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "FAILED", error: { code: "DELIVERY_ABANDONED" } } } });
    expect(attachmentEvents(await readFile(eventPath, "utf8"))).toEqual(attachmentEvents(beforeRecovery));
  } else {
    expect(await second.next()).toMatchObject({ ok: true, result: { kind: "attached", sessionId: original.payload.sessionId } });
    expect(await secondRuntime.commandStatus(original)).toMatchObject({ stage: "COMPLETED" });
    expect(attachmentEvents(await readFile(eventPath, "utf8"))).not.toEqual(attachmentEvents(beforeRecovery));
  }
  second.close();
});

it("replays strict completion after a post-completion crash without attachment side effects", async () => {
  const stateRoot = await root();
  const original = { version: 1, clientId: "completed-client", requestId: "completed-attach", op: "attach", payload: { sessionId: "completed-session", role: "composer" } };
  const firstRuntime = await createDaemonRuntime({
    root: stateRoot,
    attachmentFailpoint(/** @type {string} */ phase) {
      if (phase === "after_result_completion") throw new Error("post-completion crash");
    },
  });
  runtimes.push(firstRuntime);
  await firstRuntime.ready;
  const first = connect({ socketPath: firstRuntime.socketPath, token: firstRuntime.token });
  await first.ready;
  first.send(original);
  expect(await first.next()).toMatchObject({ ok: false });
  expect(await firstRuntime.commandStatus(original)).toMatchObject({ stage: "COMPLETED" });
  first.close();
  await first.closed;
  await firstRuntime.close();
  runtimes.splice(runtimes.indexOf(firstRuntime), 1);
  const eventPath = join(stateRoot, "index", "events.jsonl");
  const beforeReplay = await readFile(eventPath, "utf8");

  const restarted = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(restarted);
  await restarted.ready;
  const replay = connect({ socketPath: restarted.socketPath, token: restarted.token });
  await replay.ready;
  replay.send(original);
  expect(await replay.next()).toMatchObject({ ok: true, result: { kind: "attached", sessionId: original.payload.sessionId, role: "composer" } });
  expect(await restarted.commandStatus(original)).toMatchObject({ stage: "COMPLETED" });
  expect(await readFile(eventPath, "utf8")).toBe(beforeReplay);
  replay.close();
});

it("replays a completed broadcast failure after restart without attachment side effects", async () => {
  /** @type {string[]} */
  const order = [];
  let rejectBroadcast = true;
  const stateRoot = await root();
  const runtime = await createDaemonRuntime({
    root: stateRoot,
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
  const original = { version: 1, clientId: "first", requestId: "attach-first", op: "attach", payload: { sessionId: "session", role: "composer" } };
  first.send(original);
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
  await Promise.all([first.closed, second.closed]);
  await runtime.close();
  runtimes.splice(runtimes.indexOf(runtime), 1);
  const eventPath = join(stateRoot, "index", "events.jsonl");
  const beforeRestartReplay = await readFile(eventPath, "utf8");

  const restarted = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(restarted);
  await restarted.ready;
  const replay = connect({ socketPath: restarted.socketPath, token: restarted.token });
  await replay.ready;
  replay.send(original);
  expect(await replay.next()).toEqual(failed);
  expect(await readFile(eventPath, "utf8")).toBe(beforeRestartReplay);
  expect(await restarted.commandStatus(original)).toMatchObject({ stage: "COMPLETED" });
  replay.close();
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
  await expect(firstClose).rejects.toMatchObject({ code: "DAEMON_CLOSE_FAILED", errors: { length: 10 } });
  expect(runtime.status().closeState).toBe("FAILED_CLOSED");
  expect(failedStages).toEqual(["request_admission", "reconciliation", "request_chains", "supervisor", "cursor_store", "launch_result_store", "attachment_result_store", "delete_result_store", "recovery_stores", "lifecycle"]);
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
    client.send({ version: 1, clientId: "stable-client", requestId, op: "attach", payload: { sessionId: requestId, role: "composer" } });
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

it("retains a visible failed session when startup is refused before a child exists", async () => {
  const stateRoot = await root();
  const createdAt = "2026-08-25T00:00:00.000Z";
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    hostProbe: async () => ({ blockers: [] }),
    resolveLaunchRequest: async () => ({
      sessionId: "prepared",
      canonicalSessionFile: "/sessions/prepared.jsonl",
      sessionRecord: { schemaVersion: 1, revision: 0, sessionId: "prepared", sessionFile: "/sessions/prepared.jsonl", canonicalSessionFile: "/sessions/prepared.jsonl", cwd: "/repo", taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "launching", summary: "go", updatedAt: createdAt }, isolation: { mode: "shared_directory", canonicalCwd: "/repo" }, createdAt, updatedAt: createdAt },
    }),
    workerSupervisor: {
      async launch() { throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED_PI_CAPABILITY", preChild: true }); },
      async close() {},
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await client.ready;
  const launch = { version: 1, clientId: "launcher", requestId: "pre-child", op: "launch", payload: { prompt: "go", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" } } };
  client.send(launch);
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PI_CAPABILITY" } });
  expect(await new RegistryStore(join(stateRoot, "sessions")).get("prepared")).toMatchObject({ taskState: "FAILED", processState: "EXITED", activity: { kind: "launch_failed", summary: "unsupported" } });
  expect(await runtime.commandStatus(launch)).toMatchObject({ stage: "FAILED", error: { code: "UNSUPPORTED_PI_CAPABILITY" } });
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

it("durably admits authenticated Pi frames while worker reconnect reconciliation is still active", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identity = { pid: 251, startIdentity: "worker-early", processGroupId: 251 };
  const piChild = { pid: 252, startIdentity: "pi-early", processGroupId: 251 };
  const inspect = async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : pid === 251 ? identity : piChild;
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "early", sessionFile: "/sessions/early.jsonl", canonicalSessionFile: "/sessions/early.jsonl", cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: "run-early", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-early", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "early", runId: "run-early", leaseId: "lease-early", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({ root: stateRoot, inspect, reconnectTimeoutMs: 1_000 });
  runtimes.push(runtime);
  startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "early", runId: "run-early", leaseId: "lease-early", generation: 1, identity, piChildIdentity: piChild, token: "early-token", framesAfterReady: [{ type: "message_end", message: { role: "user", content: "during recovery", timestamp: Date.parse(now) } }] });
  await runtime.ready;
  const frontend = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 4096 });
  await frontend.ready;
  frontend.send({ version: 1, clientId: "viewer", requestId: "early-snapshot", op: "get_viewer_snapshot", payload: { sessionId: "early" } });
  expect(await frontend.next()).toMatchObject({ ok: true, result: { snapshot: { items: [expect.objectContaining({ kind: "user_message", content: [{ type: "text", text: "during recovery" }] })] } } });
  frontend.close();
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
  frontend.send({ version: 1, clientId: "client", requestId: "attach-before-restart", op: "attach", payload: { sessionId: "one", role: "composer" } });
  expect(await frontend.next()).toMatchObject({ ok: true, result: { role: "composer" } });
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
  malformed.send({ version: 1, clientId: "client", requestId: "attach-malformed", op: "attach", payload: { sessionId: "one", role: "composer" } });
  expect(await malformed.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  malformed.send({ version: 1, clientId: "client", requestId: "invalid-worker-result", op: "prompt", payload: { sessionId: "one", text: "invalid result" } });
  expect(await malformed.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "DELIVERY_UNKNOWN" } } });
  malformed.close();
  const resumed = connect({ socketPath: secondRuntime.socketPath, token: secondRuntime.token });
  await resumed.ready;
  resumed.send({ version: 1, clientId: "client", requestId: "attach-resumed", op: "attach", payload: { sessionId: "two", role: "composer" } });
  expect(await resumed.next()).toMatchObject({ ok: true, result: { role: "composer" } });
  resumed.send({ version: 1, clientId: "client", requestId: "after-restart", op: "steer", payload: { sessionId: "two", text: "next" } });
  expect(await resumed.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  const beforeLostResponse = loops[1].commandCount;
  const lostResponse = { version: 1, clientId: "client", requestId: "lost-response", op: "prompt", payload: { sessionId: "two", text: "persist first" } };
  resumed.send(lostResponse);
  resumed.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const retry = connect({ socketPath: secondRuntime.socketPath, token: secondRuntime.token });
  await retry.ready;
  retry.send({ version: 1, clientId: "client", requestId: "attach-retry", op: "attach", payload: { sessionId: "two", role: "composer" } });
  expect(await retry.next()).toMatchObject({ ok: true, result: { role: "composer" } });
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

it("colors a dead session without involving a Pi worker", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const sessionFile = join(stateRoot, "canonical.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "colored", timestamp: now, cwd: stateRoot })}\n`, { mode: 0o600 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const created = await registry.create({ schemaVersion: 1, revision: 0, sessionId: "colored", sessionFile, canonicalSessionFile: sessionFile, cwd: stateRoot, taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "idle", summary: "Idle", updatedAt: now }, createdAt: now, updatedAt: now });
  const runtime = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 16384 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "subscribe-1", op: "subscribe", payload: {} });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "subscribed" } });

  client.send({ version: 1, clientId: "viewer", requestId: "color-1", op: "set_session_color", payload: { sessionId: "colored", color: "amber" } });
  const responses = [await client.next(), await client.next()];
  expect(responses).toEqual(expect.arrayContaining([
    expect.objectContaining({ ok: true, result: expect.objectContaining({ kind: "session_colored" }) }),
    expect.objectContaining({ kind: "session_changed", payload: { session: expect.objectContaining({ color: "amber" }) } }),
  ]));
  const colored = await registry.get("colored");
  expect(colored).toMatchObject({ color: "amber", processState: "EXITED" });
  expect(colored?.revision).toBe(created.revision + 1);

  client.send({ version: 1, clientId: "viewer", requestId: "color-stale", op: "set_session_color", payload: { sessionId: "colored", revision: created.revision, color: "rose" } });
  await vi.waitFor(async () => expect(await registry.get("colored")).toMatchObject({ color: "rose" }));

  client.send({ version: 1, clientId: "viewer", requestId: "color-clear", op: "set_session_color", payload: { sessionId: "colored", color: null } });
  await vi.waitFor(async () => expect(await registry.get("colored")).not.toHaveProperty("color"));
});

it("colors a session across summary churn without a revision conflict", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const sessionFile = join(stateRoot, "canonical.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "summary", timestamp: now, cwd: stateRoot })}\n${JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: now, message: { role: "user", content: "fix the loader" } })}\n`, { mode: 0o600 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const created = await registry.create({ schemaVersion: 1, revision: 0, sessionId: "summary", sessionFile, canonicalSessionFile: sessionFile, cwd: stateRoot, taskState: "READY", processState: "SLEEPING", outcome: "NONE", activity: { kind: "idle", summary: "Idle", updatedAt: now }, createdAt: now, updatedAt: now });
  /** @type {(value?: unknown) => void} */
  let releaseSummary = () => {};
  const summaryGate = new Promise((resolve) => { releaseSummary = resolve; });
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    summarizeSession: async () => { await summaryGate; return { name: "Loader repair", text: "Fixes the loader" }; },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 16384 });
  await client.ready;

  client.send({ version: 1, clientId: "viewer", requestId: "settings-1", op: "set_settings", payload: { summaryModel: { provider: "anthropic", id: "haiku" } } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "settings" } });
  client.send({ version: 1, clientId: "viewer", requestId: "refresh-1", op: "refresh_summaries", payload: {} });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "summaries_refreshing", sessionIds: ["summary"] } });

  client.send({ version: 1, clientId: "viewer", requestId: "color-1", op: "set_session_color", payload: { sessionId: "summary", revision: created.revision, color: "amber" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "session_colored", color: "amber" } });

  releaseSummary();
  await vi.waitFor(async () => expect((await registry.get("summary"))?.summary).toMatchObject({ text: "Fixes the loader" }));
  expect(await registry.get("summary")).toMatchObject({ color: "amber", name: "Loader repair" });

  client.send({ version: 1, clientId: "viewer", requestId: "color-2", op: "set_session_color", payload: { sessionId: "summary", revision: created.revision, color: "rose" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "session_colored", color: "rose" } });
  expect(await registry.get("summary")).toMatchObject({ color: "rose", summary: { text: "Fixes the loader" } });
  client.close();
});

it("reports the counts idle exit depends on", async () => {
  const runtime = await createDaemonRuntime({ root: await root() });
  runtimes.push(runtime);
  await runtime.ready;
  // Idle exit may only end the process when both counts are zero.
  expect(runtime.attachedFrontends()).toBe(0);
  expect(runtime.liveWorkers()).toBe(0);
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await client.ready;
  expect(runtime.attachedFrontends()).toBeGreaterThan(0);
  client.socket.destroy();
  await vi.waitFor(() => expect(runtime.attachedFrontends()).toBe(0));
});

it("repairs a session whose supervisor and Pi child are both gone and reaches READY", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const identity = { pid: 701, startIdentity: "dead-supervisor", processGroupId: 701 };
  const piChild = { pid: 702, startIdentity: "dead-pi", processGroupId: 701 };
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "recovered", sessionFile: "/sessions/recovered.jsonl", canonicalSessionFile: "/sessions/recovered.jsonl", cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: "run-recovered", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-recovered", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "recovered", runId: "run-recovered", leaseId: "lease-recovered", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    inspect: async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : Promise.reject(Object.assign(new Error("gone"), { code: "ESRCH" })),
  });
  runtimes.push(runtime);

  await runtime.ready;
  expect(runtime.status()).toMatchObject({ state: "READY" });
  const repaired = await registry.get("recovered");
  expect(repaired).toMatchObject({ processState: "EXITED" });
  expect(repaired?.ownership).toBeUndefined();
  expect(JSON.parse(await readFile(join(stateRoot, "daemon", "workers.json"), "utf8")).workers).toEqual([]);
});

it("admits no second writer when a dead supervisor leaves a live Pi child", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const identity = { pid: 711, startIdentity: "gone-supervisor", processGroupId: 711 };
  const piChild = { pid: 712, startIdentity: "live-pi", processGroupId: 711 };
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "orphaned", sessionFile: "/sessions/orphaned.jsonl", canonicalSessionFile: "/sessions/orphaned.jsonl", cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: "run-orphaned", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-orphaned", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "orphaned", runId: "run-orphaned", leaseId: "lease-orphaned", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  let launches = 0;
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    inspect: async (/** @type {number} */ pid) => {
      if (pid === process.pid) return { pid, startIdentity: "daemon", processGroupId: process.pid };
      if (pid === piChild.pid) return piChild;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    hostProbe: async () => ({ blockers: [] }),
    resolveLaunchRequest: async () => ({ sessionId: "orphaned" }),
    workerSupervisor: { async launch() { launches += 1; return {}; }, async close() {} },
  });
  runtimes.push(runtime);

  await expect(runtime.ready).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT", conflicts: [expect.objectContaining({ sessionId: "orphaned", reason: "PI_CHILD_ORPHANED" })] });
  expect((await registry.get("orphaned"))?.ownership).toMatchObject({ runId: "run-orphaned" });
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;
  client.send({ version: 1, clientId: "launcher", requestId: "second-writer", op: "launch", payload: { prompt: "go", cwd: "/repo", sourceSessionId: "orphaned", isolation: { mode: "shared_directory", confirmedCwd: "/repo", ownerSessionIds: [] } } });
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "OWNERSHIP_CONFLICT" } });
  expect(launches).toBe(0);
  client.close();
});

it("relaunches a stopped session whose recorded worker processes are both gone", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T00:00:00.000Z";
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "stopped", sessionFile: "/sessions/stopped.jsonl", canonicalSessionFile: "/sessions/stopped.jsonl", cwd: "/repo", taskState: "STOPPED", processState: "EXITED", outcome: "NONE", activity: { kind: "assistant_final", summary: "Saved", updatedAt: now }, latestRunId: "run-stopped", createdAt: now, updatedAt: now });
  const stale = { pid: 811, startIdentity: "stopped-supervisor", processGroupId: 811 };
  const stalePiChild = { pid: 812, startIdentity: "stopped-pi", processGroupId: 811 };
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "stopped", runId: "run-stopped", leaseId: "lease-stopped", generation: 1, identity: stale, piChildIdentity: stalePiChild }] })}\n`, { mode: 0o600 });
  const identity = { pid: 821, startIdentity: "fresh-supervisor", processGroupId: 821 };
  const launch = vi.fn(async (/** @type {any} */ request) => {
    const current = await registry.get("stopped");
    if (current === undefined) throw new Error("stopped record missing");
    await registry.update("stopped", current.revision, { ownership: { kind: "managed", runId: request.runId, process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: request.runId, processState: "LIVE", updatedAt: now });
    return { sessionId: "stopped", runId: request.runId, leaseId: "fresh-lease", generation: 2, identity, piChildIdentity: { pid: 822, startIdentity: "fresh-pi", processGroupId: 821 } };
  });
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    hostProbe: async () => ({ blockers: [] }),
    inspect: async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : Promise.reject(Object.assign(new Error("gone"), { code: "ESRCH" })),
    workerSupervisor: { launch, async close() {} },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await client.ready;

  client.send({ version: 1, clientId: "client", requestId: "reopen", op: "attach", payload: { sessionId: "stopped", role: "composer", activate: true } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached", sessionId: "stopped", role: "composer" } });
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "stopped" }));
  client.close();
});

it("refuses an activating attach while the recorded Pi child of a gone supervisor is alive", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T00:00:00.000Z";
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "orphan-writer", sessionFile: "/sessions/orphan-writer.jsonl", canonicalSessionFile: "/sessions/orphan-writer.jsonl", cwd: "/repo", taskState: "STOPPED", processState: "EXITED", outcome: "NONE", activity: { kind: "assistant_final", summary: "Saved", updatedAt: now }, latestRunId: "run-orphan-writer", createdAt: now, updatedAt: now });
  const stale = { pid: 831, startIdentity: "orphan-supervisor", processGroupId: 831 };
  const livePiChild = { pid: 832, startIdentity: "orphan-pi", processGroupId: 831 };
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "orphan-writer", runId: "run-orphan-writer", leaseId: "lease-orphan-writer", generation: 1, identity: stale, piChildIdentity: livePiChild }] })}\n`, { mode: 0o600 });
  const launch = vi.fn();
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    hostProbe: async () => ({ blockers: [] }),
    inspect: async (/** @type {number} */ pid) => {
      if (pid === process.pid) return { pid, startIdentity: "daemon", processGroupId: process.pid };
      if (pid === livePiChild.pid) return livePiChild;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    workerSupervisor: { launch, async close() {} },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await client.ready;

  client.send({ version: 1, clientId: "client", requestId: "reopen-orphan", op: "attach", payload: { sessionId: "orphan-writer", role: "composer", activate: true } });
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "WORKER_STILL_LIVE", retryable: false } });
  expect(launch).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(stateRoot, "daemon", "workers.json"), "utf8")).workers).toHaveLength(1);
  client.close();
});
