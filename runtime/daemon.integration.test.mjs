import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

import { atomicWriteJson } from "./atomic-file.mjs";
import { connectDaemon } from "./daemon-connector.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";
import { createBoundedSocketWriter, createDaemonRuntime } from "./daemon.mjs";
import { RegistryStore, registryCoordinationScope, runSessionLifecycle } from "./registry-store.mjs";
import { CLIENT_PROTOCOL } from "../shared/contracts.mjs";

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
function connect({ socketPath, token, role, attachId, maxBytes = 1024, declaredClientProtocol = CLIENT_PROTOCOL }) {
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
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else received.push(frame);
    }
  });
  socket.on("error", () => {});
  const next = () => received.length > 0 ? Promise.resolve(received.shift()) : new Promise((resolve) => waiters.push(resolve));
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", () => {
      const authentication = { version: 1, token };
      if (role !== undefined) Object.assign(authentication, { role });
      else if (declaredClientProtocol !== null) Object.assign(authentication, { clientProtocol: declaredClientProtocol });
      if (attachId !== undefined) Object.assign(authentication, { attachId });
      socket.write(encoder.encode(authentication));
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
  /** @type {any} */
  let live;
  const run = (async () => {
    while (!controller.signal.aborted) {
      /** @type {any} */
      let connection;
      try {
        connection = await connectDaemon({ config: { ...config, maxBytes: 1024 }, signal: controller.signal });
        live = connection;
        connectionCount += 1;
        connection.onMessage((/** @type {any} */ frame) => {
          if (frame?.type !== "command") return;
          commandCount += 1;
          commandIds.push(frame.id);
          commands.push(frame.command);
          if (worker.silent === true) return;
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
  const loop = { pid: worker.identity.pid, get alive() { return alive; }, get connectionCount() { return connectionCount; }, get commandCount() { return commandCount; }, get commandIds() { return [...commandIds]; }, get commands() { return [...commands]; }, async sendFrame(/** @type {any} */ frame) { await live.send({ version: 1, type: "pi_frame", token: worker.token, sessionId: worker.sessionId, frame }); }, async sendEvent(/** @type {any} */ event) { await live.send({ version: 1, type: "worker_event", token: worker.token, sessionId: worker.sessionId, event }); }, async stop() { controller.abort(); await run; } };
  workerLoops.push(loop);
  return loop;
}

it("closes a subscriber whose output queue outgrows its bound", () => {
  const blocked = /** @type {any} */ (new EventEmitter());
  blocked.destroyed = false;
  blocked.write = () => false;
  blocked.destroy = vi.fn(() => { blocked.destroyed = true; });
  const bounded = createBoundedSocketWriter(blocked, { maxPendingBytes: 4, maxPendingRecords: 1 });
  expect(bounded.enqueue(Buffer.from("1234"))).toBe(true);
  expect(bounded.enqueue(Buffer.from("x"))).toBe(false);
  expect(blocked.destroy).toHaveBeenCalledWith(expect.objectContaining({ code: "SUBSCRIBER_BACKPRESSURE_LIMIT" }));
});

// Operator-visible failure: a second dashboard on a session could read it and not answer it, because
// the first one held the only writable attachment. Every authenticated client writes now, and the
// journal is where a command becomes durable, whether or not that client ever opened the session.
it("journals every mutation from an authenticated client that never attached", async () => {
  const runtime = await createDaemonRuntime({ root: await root() });
  runtimes.push(runtime);
  await runtime.ready;
  const attached = connect({ socketPath: runtime.socketPath, token: runtime.token, attachId: "attach-one" });
  const unattached = connect({ socketPath: runtime.socketPath, token: runtime.token, attachId: "attach-two" });
  await Promise.all([attached.ready, unattached.ready]);
  attached.send({ version: 1, clientId: "attached", requestId: "attach", op: "attach", payload: { sessionId: "session" } });
  expect(await attached.next()).toMatchObject({ ok: true, result: { kind: "attached" } });

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
    for (const [clientId, client] of /** @type {Array<[string, any]>} */ ([["attached", attached], ["unattached", unattached]])) {
      const request = { version: 1, clientId, requestId: `${clientId}-${op}`, op, payload };
      client.send(request);
      // This session does not exist, so each command fails on its own merits after acceptance.
      expect(await client.next(), `${clientId} ${op}`).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "FAILED" } } });
      expect(await runtime.commandStatus(request), `${clientId} ${op}`).toMatchObject({ clientId, requestId: request.requestId });
    }
  }
  attached.close();
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

  client.send({ version: 1, clientId: "viewer", requestId: "attach-leased", op: "attach", payload: { sessionId: "leased" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached" } });
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

  client.send({ version: 1, clientId: "viewer", requestId: "attach-forget", op: "attach", payload: { sessionId: "forgotten" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached" } });
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
  client.send({ version: 1, clientId: "viewer", requestId: "attach-stop", op: "attach", payload: { sessionId: "stopping" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached" } });
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

  // The repair is durable in the registry and nowhere else: a new root has no list event log.
  await expect(access(join(stateRoot, "index", "events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(join(stateRoot, "daemon", "event-acks.json"))).rejects.toMatchObject({ code: "ENOENT" });

  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 16384 });
  await client.ready;
  // Nothing is replayed: the subscription carries no position, and the repair is in current rows.
  client.send({ version: 1, clientId: "watcher", requestId: "subscribe", op: "subscribe_list_changes", payload: {} });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "list_subscribed" } });
  client.send({ version: 1, clientId: "watcher", requestId: "read", op: "get_state", payload: {} });
  const read = await client.next();
  expect(read.result.sessions.find((/** @type {any} */ session) => session.sessionId === "abandoned")).toMatchObject({ taskState: "FAILED" });
  expect(read.result.cursor).toMatchObject({ sequence: expect.stringMatching(/^(0|[1-9]\d*)$/u) });
  client.close();
});

// Operator-visible failure: replaying a persisted list history crashed the dashboard on every
// start, and 18 MB of it had accumulated on the operator's machine.
it("invalidates a list subscription after a durable change, carrying no payload and no position", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "tinted", sessionFile: "/sessions/tinted.jsonl", canonicalSessionFile: "/sessions/tinted.jsonl", cwd: "/repo", taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "saved_session", summary: "Saved", updatedAt: now }, createdAt: now, updatedAt: now });
  const runtime = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(runtime);
  await runtime.ready;

  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 16384 });
  await client.ready;
  client.send({ version: 1, clientId: "watcher", requestId: "read-before", op: "get_state", payload: {} });
  const before = (await client.next()).result.cursor;
  client.send({ version: 1, clientId: "watcher", requestId: "subscribe", op: "subscribe_list_changes", payload: {} });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "list_subscribed" } });

  client.send({ version: 1, clientId: "watcher", requestId: "tint", op: "set_session_color", payload: { sessionId: "tinted", color: "amber" } });
  // The durable write comes first, then the invalidation, then this request's own answer, so a
  // client that reads on the invalidation always sees the change it names.
  expect(await client.next()).toEqual({ version: 1, kind: "list_changed" });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "session_colored", color: "amber" } });

  client.send({ version: 1, clientId: "watcher", requestId: "read-after", op: "get_state", payload: {} });
  const after = await client.next();
  expect(after.result.sessions[0]).toMatchObject({ sessionId: "tinted", color: "amber" });
  // The coverage cursor advances with the change, so a snapshot states what it covers.
  expect(BigInt(after.result.cursor.sequence) > BigInt(before.sequence)).toBe(true);
  expect(after.result.cursor.daemonEpoch).toBe(before.daemonEpoch);
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

it("keeps the worker connection when a concurrent record write loses the worker event a compare-and-swap", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identity = { pid: 271, startIdentity: "worker-cas", processGroupId: 271 };
  const piChild = { pid: 272, startIdentity: "pi-cas", processGroupId: 271 };
  const inspect = async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : pid === 271 ? identity : piChild;
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "cas", sessionFile: "/sessions/cas.jsonl", canonicalSessionFile: "/sessions/cas.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "idle", summary: "Idle", updatedAt: now }, ownership: { kind: "managed", runId: "run-cas", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-cas", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "cas", runId: "run-cas", leaseId: "lease-cas", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({ root: stateRoot, inspect, reconnectTimeoutMs: 1_000 });
  runtimes.push(runtime);
  const worker = startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "cas", runId: "run-cas", leaseId: "lease-cas", generation: 1, identity, piChildIdentity: piChild, token: "cas-token" });
  await runtime.ready;
  await vi.waitFor(() => expect(worker.connectionCount).toBe(1));

  // Hold the coordination key RegistryStore.update takes, so the handler's own update queues behind a
  // record write it cannot see. RegistryStore.get is uncoordinated, so its read is already stale.
  const coordinated = registryCoordinationScope(registry).coordinator;
  /** @type {(value?: unknown) => void} */
  let releaseWrite = () => {};
  const blocked = new Promise((resolve) => { releaseWrite = resolve; });
  const holding = coordinated.run("cas", async () => {
    await worker.sendEvent({ type: "TURN_STARTED", at: "2026-08-25T12:00:01.000Z" });
    // Let the handler read the record before another writer bumps its revision.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await registry.get("cas");
    if (current === undefined) throw new Error("cas record missing");
    await atomicWriteJson(join(stateRoot, "sessions", "cas.json"), { ...current, revision: current.revision + 1, color: "amber" });
    await blocked;
  });
  releaseWrite();
  await holding;

  await vi.waitFor(async () => expect(await registry.get("cas")).toMatchObject({ taskState: "WORKING", color: "amber" }), { timeout: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(worker.connectionCount).toBe(1);
  expect(worker.alive).toBe(true);
});

it("selects sessions to summarize without republishing a durable viewer snapshot", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const sessionFile = join(stateRoot, "canonical.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "quiet", timestamp: now, cwd: stateRoot })}\n${JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: now, message: { role: "user", content: "fix the loader" } })}\n`, { mode: 0o600 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "quiet", sessionFile, canonicalSessionFile: sessionFile, cwd: stateRoot, taskState: "READY", processState: "SLEEPING", outcome: "NONE", activity: { kind: "idle", summary: "Idle", updatedAt: now }, createdAt: now, updatedAt: now });
  /** @type {(value?: unknown) => void} */
  let releaseSummary = () => {};
  const summaryGate = new Promise((resolve) => { releaseSummary = resolve; });
  const runtime = await createDaemonRuntime({ root: stateRoot, summarizeSession: async () => { await summaryGate; return { text: "Fixes the loader" }; } });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 16384 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "settings-quiet", op: "set_settings", payload: { summaryModel: { provider: "anthropic", id: "haiku" } } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "settings" } });

  // Selection must stay a memory read: republishing one snapshot per session put a durable write per
  // session on the request the frontend makes when it returns to the list.
  const snapshotPath = join(stateRoot, "index", "viewer", `${createHash("sha256").update("quiet").digest("hex")}.snapshot.json`);
  // atomicWriteJson renames a fresh temporary file into place, so a republish always changes the inode.
  const before = await stat(snapshotPath);
  client.send({ version: 1, clientId: "viewer", requestId: "refresh-quiet", op: "refresh_summaries", payload: {} });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "summaries_refreshing", sessionIds: ["quiet"] } });
  expect((await stat(snapshotPath)).ino).toBe(before.ino);

  releaseSummary();
  await vi.waitFor(async () => expect((await registry.get("quiet"))?.summary).toMatchObject({ text: "Fixes the loader" }));
  client.close();
});

it("reaches a freshly launched worker over its adopted startup route before any reconnect", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const createdAt = "2026-08-25T00:00:00.000Z";
  const identity = { pid: 501, startIdentity: "fresh-worker", processGroupId: 501 };
  const piChild = { pid: 502, startIdentity: "fresh-pi", processGroupId: 501 };
  const inspect = async (/** @type {number} */ pid) => pid === 501 ? identity : pid === 502 ? piChild : { pid, startIdentity: "daemon", processGroupId: pid };
  /** @type {any[]} */
  const delivered = [];
  const menu = { commands: [], models: [{ provider: "anthropic", id: "claude" }], model: null };
  /** @type {(value?: unknown) => void} */
  let closeRoute = () => {};
  const connection = {
    closed: new Promise((resolve) => { closeRoute = resolve; }),
    close: () => closeRoute(undefined),
    async send() {},
    /** @param {any} message @param {any} expected */
    async request(message, expected) {
      delivered.push({ op: expected.op, token: message.token, command: message.command });
      return { op: expected.op, stage: "RPC_ACKNOWLEDGED", result: menu };
    },
  };
  /** @type {any} */
  let router;
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    inspect,
    hostProbe: async () => ({ blockers: [] }),
    resolveLaunchRequest: async (/** @type {any} */ request) => ({
      sessionId: "fresh", canonicalSessionFile: "/sessions/fresh.jsonl", cwd: "/repo", runId: "run-fresh", initialPrompt: request.payload.prompt,
      sessionRecord: { schemaVersion: 1, revision: 0, sessionId: "fresh", sessionFile: "/sessions/fresh.jsonl", canonicalSessionFile: "/sessions/fresh.jsonl", cwd: "/repo", taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "launching", summary: "start", updatedAt: createdAt }, isolation: { mode: "shared_directory", canonicalCwd: "/repo" }, createdAt, updatedAt: createdAt },
    }),
    workerSupervisor: {
      /** @param {any} suppliedRouter */
      useRouter(suppliedRouter) { router = suppliedRouter; },
      // Stand in for the real launch: reserve the run, own the record, register both identities, and
      // adopt the startup connection before readiness, exactly as the supervisor does.
      async launch() {
        await router.reserve({ sessionId: "fresh", runId: "run-fresh", leaseId: "lease-fresh", generation: 1, token: "fresh-run-token" });
        const current = await registry.get("fresh");
        if (current === undefined) throw new Error("fresh record missing");
        await registry.update("fresh", current.revision, { ownership: { kind: "managed", runId: "run-fresh", process: identity, acquiredAt: createdAt, heartbeatAt: createdAt }, latestRunId: "run-fresh", processState: "LIVE", updatedAt: createdAt });
        await router.register({ sessionId: "fresh", runId: "run-fresh", leaseId: "lease-fresh", generation: 1, identity, piChildIdentity: piChild });
        await router.adopt({ version: 1, type: "worker_ready", token: "fresh-run-token", sessionId: "fresh", runId: "run-fresh", leaseId: "lease-fresh", generation: 1, worker: identity, piChild }, connection);
        return { sessionId: "fresh", runId: "run-fresh", leaseId: "lease-fresh", generation: 1, identity, piChildIdentity: piChild, ready: true, detach() { closeRoute(undefined); } };
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
  client.send({ version: 1, clientId: "viewer", requestId: "attach-fresh", op: "attach", payload: { sessionId: "fresh" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached" } });

  client.send({ version: 1, clientId: "viewer", requestId: "menu-fresh", op: "get_session_commands", payload: { sessionId: "fresh" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "session_commands", models: [{ provider: "anthropic", id: "claude" }] } });
  client.send({ version: 1, clientId: "viewer", requestId: "prompt-fresh", op: "prompt", payload: { sessionId: "fresh", text: "hello" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  // Every launch and steady-state message crossed one authenticated route, including the first prompt.
  expect(delivered.map((/** @type {any} */ entry) => entry.op)).toEqual(["prompt", "get_session_commands", "prompt"]);
  expect(new Set(delivered.map((/** @type {any} */ entry) => entry.token))).toEqual(new Set(["fresh-run-token"]));
  client.close();
});

it("refuses a session query and serves session toggles from the owning worker", async () => {
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
  const worker = startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "query", runId: "run-query", leaseId: "lease-query", generation: 1, identity, piChildIdentity: piChild, token: "query-token", results: {} });
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "attach-query", op: "attach", payload: { sessionId: "query" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached" } });

  client.send({ version: 1, clientId: "viewer", requestId: "stats-request", op: "session_query", payload: { sessionId: "query", query: "get_session_stats" } });
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });

  client.send({ version: 1, clientId: "viewer", requestId: "auto-compact", op: "session_command", payload: { sessionId: "query", command: "set_auto_compaction", enabled: false } });
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  client.send({ version: 1, clientId: "viewer", requestId: "steering", op: "session_command", payload: { sessionId: "query", command: "set_steering_mode", mode: "one-at-a-time" } });
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  client.send({ version: 1, clientId: "viewer", requestId: "thinking", op: "session_command", payload: { sessionId: "query", command: "set_thinking_level", level: "high" } });
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });

  // The retry brake outlives the settings passthrough, and it is the only zero-argument variant left.
  client.send({ version: 1, clientId: "viewer", requestId: "abort-retry", op: "session_command", payload: { sessionId: "query", command: "abort_retry" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });

  // get_state is the daemon's own reconnect probe, not a frontend request.
  const delivered = worker.commands.filter((/** @type {any} */ command) => !["get_session_commands", "get_state"].includes(command.op));
  expect(delivered.map((/** @type {any} */ command) => command.op)).toEqual(["session_command"]);
  expect(delivered[0].sessionCommand).toEqual({ command: "abort_retry" });
  client.close();
});

// Operator-visible failure: a Pi that answers nothing left the request pending in the daemon with
// no reply and no journal movement, so the dashboard showed a command that never finished.
it("bounds a worker request that is never answered and records it as ambiguous", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identity = { pid: 441, startIdentity: "silent-worker", processGroupId: 441 };
  const piChild = { pid: 442, startIdentity: "silent-pi", processGroupId: 441 };
  const inspect = async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : pid === 441 ? identity : piChild;
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "silent", sessionFile: "/sessions/silent.jsonl", canonicalSessionFile: "/sessions/silent.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: "run-silent", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-silent", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "silent", runId: "run-silent", leaseId: "lease-silent", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({ root: stateRoot, inspect, workerRequestTimeoutMs: 150 });
  runtimes.push(runtime);
  const worker = startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "silent", runId: "run-silent", leaseId: "lease-silent", generation: 1, identity, piChildIdentity: piChild, token: "silent-token", silent: true });
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "attach-silent", op: "attach", payload: { sessionId: "silent" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached" } });

  client.send({ version: 1, clientId: "viewer", requestId: "prompt-silent", op: "prompt", payload: { sessionId: "silent", text: "hello" } });
  const settled = await Promise.race([client.next(), new Promise((resolve) => setTimeout(() => resolve("stalled"), 3_000))]);
  // Ambiguous, never FAILED: the command's bytes may already have reached Pi.
  expect(settled).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "DELIVERY_UNKNOWN" } } });
  expect(worker.commands.filter((/** @type {any} */ command) => command.op === "prompt")).toHaveLength(1);
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
  const menu = { commands: [{ name: "/review", source: "extension", description: "Review" }], models: [{ provider: "anthropic", id: "claude" }], model: { provider: "anthropic", id: "claude" }, thinkingLevels: ["off", "high"], thinkingLevel: "high" };
  const worker = startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "menu", runId: "run-menu", leaseId: "lease-menu", generation: 1, identity, piChildIdentity: piChild, token: "menu-token", results: { get_session_commands: menu } });
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "attach-menu", op: "attach", payload: { sessionId: "menu" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached" } });
  client.send({ version: 1, clientId: "viewer", requestId: "menu-request", op: "get_session_commands", payload: { sessionId: "menu" } });
  const served = /** @type {any} */ (await client.next());
  // A worker may still report Pi's thinking values; the daemon serves the menu without them.
  expect(served).toMatchObject({ ok: true, result: { kind: "session_commands", sessionId: "menu", commands: menu.commands, models: menu.models, model: menu.model } });
  for (const key of ["thinkingLevels", "thinkingLevel"]) expect(Object.hasOwn(served.result, key), key).toBe(false);
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
// Operator-visible failure: an attachment used to be a durable claim, journaled and stored, so one
// dashboard opening a session both excluded the others and left 697 KB of attachment records behind.
// It is connection state now: no journal entry, no artifact, no list invalidation, and no exclusion.
it("opens one session on three connections at once, durably recording nothing", async () => {
  const stateRoot = await root();
  const runtime = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(runtime);
  await runtime.ready;
  const watcher = connect({ socketPath: runtime.socketPath, token: runtime.token, attachId: "attach-watcher" });
  const dashboards = ["attach-one", "attach-two", "attach-three"].map((attachId) => connect({ socketPath: runtime.socketPath, token: runtime.token, attachId }));
  await Promise.all([watcher.ready, ...dashboards.map((dashboard) => dashboard.ready)]);
  watcher.send({ version: 1, clientId: "watcher", requestId: "subscribe", op: "subscribe_list_changes", payload: {} });
  expect(await watcher.next()).toMatchObject({ ok: true, result: { kind: "list_subscribed" } });

  dashboards.forEach((dashboard, index) => dashboard.send({ version: 1, clientId: "installation-1", requestId: `attach-${index}`, op: "attach", payload: { sessionId: "session" } }));
  for (const dashboard of dashboards) expect(await dashboard.next()).toMatchObject({ ok: true, result: { kind: "attached", sessionId: "session" } });
  // A reopen on a connection that already has it open is the same attachment, not a conflict.
  dashboards[0].send({ version: 1, clientId: "installation-1", requestId: "attach-again", op: "attach", payload: { sessionId: "session" } });
  expect(await dashboards[0].next()).toMatchObject({ ok: true, result: { kind: "attached" } });
  dashboards[1].send({ version: 1, clientId: "installation-1", requestId: "detach-1", op: "detach", payload: { sessionId: "session" } });
  expect(await dashboards[1].next()).toMatchObject({ ok: true, result: { kind: "detached", sessionId: "session" } });
  dashboards[2].close();
  await dashboards[2].closed;

  // Nothing about opening or leaving a session changed the list, and nothing was written down.
  watcher.send({ version: 1, clientId: "watcher", requestId: "read", op: "get_state", payload: {} });
  expect(await watcher.next()).toMatchObject({ ok: true, requestId: "read", result: { kind: "state" } });
  await expect(access(join(stateRoot, "daemon", "attachment-results.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  const journal = await readFile(join(stateRoot, "queue", "commands.jsonl"), "utf8").catch(() => "");
  expect(journal).toBe("");
  watcher.close();
  for (const dashboard of dashboards) dashboard.close();
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

it("refuses a launch naming a model Pi does not offer, before anything is prepared", async () => {
  const stateRoot = await root();
  const resolveLaunchRequest = vi.fn(async () => ({ sessionId: "admitted" }));
  const launch = vi.fn(async () => { throw Object.assign(new Error("launch reached the supervisor"), { code: "LAUNCH_REACHED" }); });
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    hostProbe: async () => ({ blockers: [] }),
    modelCatalog: { models: async () => [{ provider: "openai-codex", id: "gpt-5.6-sol", thinking: true }] },
    resolveLaunchRequest,
    workerSupervisor: { launch, async close() {} },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 4096 });
  await client.ready;

  // The model of the operator's saved draft: a provider and an id Pi never offered.
  const refused = { version: 1, clientId: "launcher", requestId: "unknown-model", op: "launch", payload: { prompt: "go", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" }, model: { provider: "openai", id: "id" } } };
  client.send(refused);
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "FAILED", error: { code: "MODEL_UNKNOWN" } } } });
  // Nothing was prepared: the refusal precedes resolution, so there is no record, worktree, Pi file,
  // worker, list event, or row to clean up.
  expect(resolveLaunchRequest).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  expect(await new RegistryStore(join(stateRoot, "sessions")).list()).toEqual([]);
  await expect(access(join(stateRoot, "index", "events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readFile(join(stateRoot, "queue", "commands.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).status.stage)).toEqual(["ACCEPTED", "FAILED"]);
  expect(await runtime.commandStatus(refused)).toMatchObject({ stage: "FAILED", error: { code: "MODEL_UNKNOWN" } });

  // A model Pi does offer passes the same check and reaches launch resolution.
  client.send({ version: 1, clientId: "launcher", requestId: "known-model", op: "launch", payload: { prompt: "go", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" }, model: { provider: "openai-codex", id: "gpt-5.6-sol" } } });
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "LAUNCH_REACHED" } });
  expect(resolveLaunchRequest).toHaveBeenCalledTimes(1);
  client.close();
});

it("lets Pi decide when its model catalog is unavailable, and records that as a distinct diagnostic", async () => {
  const stateRoot = await root();
  /** @type {any[]} */
  const diagnostics = [];
  const resolveLaunchRequest = vi.fn(async () => ({ sessionId: "undecided" }));
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    hostProbe: async () => ({ blockers: [] }),
    modelCatalog: { models: async () => { throw Object.assign(new Error("Listing Pi models exited 1"), { code: "MODEL_CATALOG_FAILED" }); } },
    recordDiagnostic: (/** @type {any} */ entry) => { diagnostics.push(entry); },
    resolveLaunchRequest,
    workerSupervisor: { async launch() { throw Object.assign(new Error("launch reached the supervisor"), { code: "LAUNCH_REACHED" }); }, async close() {} },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 4096 });
  await client.ready;

  client.send({ version: 1, clientId: "launcher", requestId: "catalog-down", op: "launch", payload: { prompt: "go", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "worktree" }, model: { provider: "openai", id: "id" } } });
  // A catalog Pi could not list refuses nothing: Pi itself decides whether it accepts the model.
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "LAUNCH_REACHED" } });
  expect(resolveLaunchRequest).toHaveBeenCalledTimes(1);
  expect(diagnostics).toContainEqual(expect.objectContaining({ event: "model_catalog_unavailable", code: "MODEL_CATALOG_FAILED" }));
  expect(diagnostics.some((/** @type {any} */ entry) => entry.code === "MODEL_UNKNOWN")).toBe(false);
  client.close();
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

it("ingests Pi frames and keeps their order while a lifecycle operation holds the session lock", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identity = { pid: 261, startIdentity: "worker-stream", processGroupId: 261 };
  const piChild = { pid: 262, startIdentity: "pi-stream", processGroupId: 261 };
  const inspect = async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : pid === 261 ? identity : piChild;
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "stream", sessionFile: "/sessions/stream.jsonl", canonicalSessionFile: "/sessions/stream.jsonl", cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: "run-stream", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-stream", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "stream", runId: "run-stream", leaseId: "lease-stream", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({ root: stateRoot, inspect, reconnectTimeoutMs: 1_000 });
  runtimes.push(runtime);
  const worker = startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "stream", runId: "run-stream", leaseId: "lease-stream", generation: 1, identity, piChildIdentity: piChild, token: "stream-token" });
  await runtime.ready;
  const frontend = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 65536 });
  await frontend.ready;
  await vi.waitFor(() => expect(worker.connectionCount).toBeGreaterThan(0));

  /** @type {(value?: unknown) => void} */
  let releaseLock = () => {};
  const held = new Promise((resolve) => { releaseLock = resolve; });
  const lockHeld = runSessionLifecycle(registry, "stream", () => held);
  await Promise.resolve();

  try {
    for (let index = 0; index < 6; index += 1) {
      await worker.sendFrame({ type: "message_end", message: { role: "user", content: `frame ${index}`, timestamp: Date.parse(now) + index } });
    }
    // Ingest that still needed the lifecycle lock could not finish until releaseLock ran.
    await vi.waitFor(async () => {
      frontend.send({ version: 1, clientId: "viewer", requestId: `snapshot-${randomUUID()}`, op: "get_viewer_snapshot", payload: { sessionId: "stream" } });
      const response = await frontend.next();
      expect(response.result.snapshot.items).toHaveLength(6);
    }, { timeout: 5_000 });

    frontend.send({ version: 1, clientId: "viewer", requestId: "ordered", op: "get_viewer_snapshot", payload: { sessionId: "stream" } });
    const ordered = await frontend.next();
    expect(ordered.result.snapshot.items.map((/** @type {any} */ item) => item.content[0].text)).toEqual([0, 1, 2, 3, 4, 5].map((index) => `frame ${index}`));
  } finally {
    releaseLock();
    await lockHeld;
    frontend.close();
  }
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
  frontend.send({ version: 1, clientId: "client", requestId: "attach-before-restart", op: "attach", payload: { sessionId: "one" } });
  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "attached" } });
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
  malformed.send({ version: 1, clientId: "client", requestId: "attach-malformed", op: "attach", payload: { sessionId: "one" } });
  expect(await malformed.next()).toMatchObject({ ok: true, result: { kind: "attached" } });
  malformed.send({ version: 1, clientId: "client", requestId: "invalid-worker-result", op: "prompt", payload: { sessionId: "one", text: "invalid result" } });
  expect(await malformed.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "DELIVERY_UNKNOWN" } } });
  malformed.close();
  const resumed = connect({ socketPath: secondRuntime.socketPath, token: secondRuntime.token });
  await resumed.ready;
  resumed.send({ version: 1, clientId: "client", requestId: "attach-resumed", op: "attach", payload: { sessionId: "two" } });
  expect(await resumed.next()).toMatchObject({ ok: true, result: { kind: "attached" } });
  resumed.send({ version: 1, clientId: "client", requestId: "after-restart", op: "steer", payload: { sessionId: "two", text: "next" } });
  expect(await resumed.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  const beforeLostResponse = loops[1].commandCount;
  const lostResponse = { version: 1, clientId: "client", requestId: "lost-response", op: "prompt", payload: { sessionId: "two", text: "persist first" } };
  resumed.send(lostResponse);
  resumed.close();
  // The socket died before the response, not before the work. Wait for the command the daemon is
  // still finishing, so the retry below is a retry of a completed command rather than a race with it.
  await vi.waitFor(async () => expect(await secondRuntime.commandStatus(lostResponse)).toMatchObject({ stage: "COMPLETED" }));
  const retry = connect({ socketPath: secondRuntime.socketPath, token: secondRuntime.token });
  await retry.ready;
  retry.send({ version: 1, clientId: "client", requestId: "attach-retry", op: "attach", payload: { sessionId: "two" } });
  expect(await retry.next()).toMatchObject({ ok: true, result: { kind: "attached" } });
  retry.send(lostResponse);
  expect(await retry.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  expect(loops[1].commandCount).toBe(beforeLostResponse + 1);
  expect(new Set(loops.flatMap((loop) => loop.commandIds)).size).toBe(loops.reduce((total, loop) => total + loop.commandIds.length, 0));
  retry.close();
  await secondRuntime.close();
  runtimes.splice(runtimes.indexOf(secondRuntime), 1);
  expect(loops.map((loop) => [loop.pid, loop.alive])).toEqual([[201, true], [202, true]]);
});

// Operator-visible failure: a replacement daemon that compared releases before adopting refused its
// own live workers for holding older code, and the operator's only cure was a manual restart that
// ended the sessions. Adoption comes first, and the row says which worker is out of date.
it("adopts live workers of every release and reports each one's release and route generation in its row", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  /** @type {Array<[string, string | undefined]>} */
  const releases = [["older", "1.9.0"], ["equal", "2.0.0"], ["newer", "2.1.0"], ["unknown", undefined]];
  const workers = releases.map(([sessionId, cliVersion], index) => {
    const pid = 301 + index * 2;
    return {
      sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1,
      identity: { pid, startIdentity: `worker-${sessionId}`, processGroupId: pid },
      piChildIdentity: { pid: pid + 1, startIdentity: `pi-${sessionId}`, processGroupId: pid },
      token: `${sessionId}-token`,
      ...(cliVersion === undefined ? {} : { cliVersion }),
    };
  });
  const identities = new Map(workers.flatMap((worker) => [[worker.identity.pid, worker.identity], [worker.piChildIdentity.pid, worker.piChildIdentity]]));
  /** @param {number} pid */
  const inspect = async (pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : identities.get(pid) ?? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  for (const worker of workers) {
    await registry.create({ schemaVersion: 1, revision: 0, sessionId: worker.sessionId, sessionFile: `/sessions/${worker.sessionId}.jsonl`, canonicalSessionFile: `/sessions/${worker.sessionId}.jsonl`, cwd: "/repo", taskState: "WAITING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: worker.runId, process: worker.identity, acquiredAt: now, heartbeatAt: now }, latestRunId: worker.runId, createdAt: now, updatedAt: now });
  }
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: workers.map(({ token: _token, ...worker }) => worker) })}\n`, { mode: 0o600 });

  const runtime = await createDaemonRuntime({ root: stateRoot, inspect, hostProbe: async () => ({ blockers: [] }), reconnectTimeoutMs: 2_000, cliVersion: "2.0.0" });
  runtimes.push(runtime);
  const loops = workers.map((worker) => startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, worker));
  await runtime.ready;
  const frontend = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 64 * 1024 });
  // An older or unknown worker never refuses daemon startup.
  expect(await frontend.ready).toMatchObject({ kind: "authenticated", state: "READY" });
  let read = 0;
  const rows = async () => {
    read += 1;
    frontend.send({ version: 1, clientId: "client", requestId: `state-${read}`, op: "get_state", payload: {} });
    const response = await frontend.next();
    return Object.fromEntries(response.result.sessions.map((/** @type {any} */ session) => [session.sessionId, session]));
  };
  const adopted = await vi.waitFor(async () => {
    const current = await rows();
    expect(Object.values(current).map((/** @type {any} */ session) => session.routeGeneration)).toEqual([1, 1, 1, 1]);
    return current;
  }, { timeout: 4_000, interval: 50 });

  expect(adopted.older).toMatchObject({ workerCliVersion: "1.9.0", stale: true });
  expect(adopted.equal).toMatchObject({ workerCliVersion: "2.0.0", stale: false });
  // A newer worker is live, not stale, and this commit never replaces it.
  expect(adopted.newer).toMatchObject({ workerCliVersion: "2.1.0", stale: false });
  expect(adopted.unknown.workerCliVersion).toBeUndefined();
  expect(adopted.unknown).toMatchObject({ stale: true });
  expect(loops.map((loop) => loop.alive)).toEqual([true, true, true, true]);
  // Adoption colours the read; it writes no revision, so an exact-revision Stop survives a restart.
  expect(Object.values(adopted).map((/** @type {any} */ session) => session.revision)).toEqual([0, 0, 0, 0]);
  expect((await registry.get("older"))?.stale).toBeUndefined();
  frontend.close();
}, 20_000);

/**
 * Build one live adopted worker whose release is `cliVersion`, plus the daemon seams that observe a
 * replacement: the signals it sends, the launches it asks for, and the diagnostics it records.
 * @param {{ sessionId: string, cliVersion?: string, taskState: import("../shared/contracts.mjs").TaskState, activityKind?: string, pendingRespawn?: string }} options
 */
async function replaceableWorker({ sessionId, cliVersion, taskState, activityKind = "assistant_final", pendingRespawn }) {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const identity = { pid: 401, startIdentity: "40100", processGroupId: 401 };
  const piChildIdentity = { pid: 402, startIdentity: "40200", processGroupId: 401 };
  let alive = true;
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId, sessionFile: join(stateRoot, `${sessionId}.jsonl`), canonicalSessionFile: join(stateRoot, `${sessionId}.jsonl`), cwd: stateRoot, taskState, processState: "LIVE", outcome: "NONE", activity: { kind: activityKind, summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: `run-${sessionId}`, process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: `run-${sessionId}`, createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, identity, piChildIdentity, ...(cliVersion === undefined ? {} : { cliVersion }), ...(pendingRespawn === undefined ? {} : { pendingRespawn }) }] })}\n`, { mode: 0o600 });
  /** @type {Array<[number, string]>} */
  const signals = [];
  /** @type {string[]} */
  const launches = [];
  /** @type {any[]} */
  const diagnostics = [];
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    cliVersion: "2.0.0",
    reconnectTimeoutMs: 2_000,
    stopPolicy: { gracefulMs: 20, terminateMs: 20 },
    sleepImpl: async () => {},
    inspect: async (/** @type {number} */ pid) => {
      if (pid === process.pid) return { pid, startIdentity: "1", processGroupId: process.pid };
      if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return pid === identity.pid ? identity : piChildIdentity;
    },
    signalProcessGroupImpl: (/** @type {number} */ pgid, /** @type {string} */ signal) => {
      signals.push([pgid, signal]);
      if (signal === "SIGTERM") alive = false;
    },
    recordDiagnostic: (/** @type {any} */ entry) => { diagnostics.push(entry); },
    workerSupervisor: { useRouter() {}, async launch(/** @type {any} */ request) { launches.push(request.sessionId); return { sessionId: request.sessionId }; }, async close() {} },
  });
  runtimes.push(runtime);
  const loop = startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, identity, piChildIdentity, token: `${sessionId}-token` });
  await runtime.ready;
  await vi.waitFor(() => expect(runtime.status().connectedWorkers).toContain(sessionId), { timeout: 5_000, interval: 25 });
  return { stateRoot, registry, runtime, loop, identity, signals, launches, diagnostics, now };
}

/** Open one dashboard connection on a session, the way a viewer does. @param {any} runtime @param {string} sessionId */
async function openSession(runtime, sessionId) {
  const frontend = connect({ socketPath: runtime.socketPath, token: runtime.token, attachId: `attach-${sessionId}`, maxBytes: 64 * 1024 });
  await frontend.ready;
  frontend.send({ version: 1, clientId: "client", requestId: "attach", op: "attach", payload: { sessionId } });
  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "attached" } });
  return frontend;
}

// Operator-visible failure: replacing a worker mid-turn ends the run the operator is waiting on. The
// only fact that may open the boundary is Pi's own settled state reduced onto the row.
it("keeps a busy stale worker running and replaces it at the next structured idle boundary", async () => {
  const live = await replaceableWorker({ sessionId: "busy", cliVersion: "1.9.0", taskState: "WORKING", activityKind: "tool" });

  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  expect(live.signals).toEqual([]);
  expect(live.launches).toEqual([]);
  expect(await live.registry.get("busy")).toMatchObject({ taskState: "WORKING", ownership: { runId: "run-busy" } });

  await live.loop.sendEvent({ type: "TURN_COMPLETED", at: live.now });

  await vi.waitFor(() => expect(live.launches).toEqual(["busy"]), { timeout: 8_000, interval: 25 });
  await live.loop.stop();
  expect(live.signals).toEqual([[live.identity.processGroupId, "SIGTERM"]]);
  const replaced = await live.registry.get("busy");
  expect(replaced).toMatchObject({ taskState: "READY", processState: "EXITED" });
  expect(replaced?.ownership).toBeUndefined();
  // The replaced run's private metadata, including its pending replacement, goes with the run.
  expect(JSON.parse(await readFile(join(live.stateRoot, "daemon", "workers.json"), "utf8")).workers).toEqual([]);
}, 20_000);

// Operator-visible failure: a daemon that died between promising a replacement and completing it would
// leave the operator on the worker it had already decided to replace, with nothing on disk saying so.
it("resumes a replacement its predecessor promised, after it has adopted that worker again", async () => {
  const live = await replaceableWorker({ sessionId: "resumed", cliVersion: "1.9.0", taskState: "READY", pendingRespawn: "upgrade" });

  await vi.waitFor(() => expect(live.launches).toEqual(["resumed"]), { timeout: 8_000, interval: 25 });
  await live.loop.stop();
  expect(live.signals).toEqual([[live.identity.processGroupId, "SIGTERM"]]);
  expect(JSON.parse(await readFile(join(live.stateRoot, "daemon", "workers.json"), "utf8")).workers).toEqual([]);
}, 20_000);

/**
 * Build one live adopted worker per session, all of one stale release, whose replacement launches wait
 * for this test to release them. Holding the launches keeps a known number of replacements in flight,
 * so the burst bound is observed without depending on how fast a replacement runs.
 * @param {string[]} sessionIds
 */
async function burstReplaceableWorkers(sessionIds) {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const workers = sessionIds.map((sessionId, index) => {
    const pid = 4101 + index * 2;
    return {
      sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, cliVersion: "1.9.0",
      // stopVerifiedProcessGroup requires a positive integer start time, so these read like /proc.
      identity: { pid, startIdentity: `${pid}00`, processGroupId: pid },
      piChildIdentity: { pid: pid + 1, startIdentity: `${pid + 1}00`, processGroupId: pid },
      token: `${sessionId}-token`,
    };
  });
  for (const worker of workers) {
    await registry.create({ schemaVersion: 1, revision: 0, sessionId: worker.sessionId, sessionFile: join(stateRoot, `${worker.sessionId}.jsonl`), canonicalSessionFile: join(stateRoot, `${worker.sessionId}.jsonl`), cwd: stateRoot, taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "tool", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: worker.runId, process: worker.identity, acquiredAt: now, heartbeatAt: now }, latestRunId: worker.runId, createdAt: now, updatedAt: now });
  }
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: workers.map(({ token: _token, ...worker }) => worker) })}\n`, { mode: 0o600 });
  const identities = new Map(workers.flatMap((worker) => [[worker.identity.pid, worker.identity], [worker.piChildIdentity.pid, worker.piChildIdentity]]));
  const groups = new Map(workers.map((worker) => [worker.identity.processGroupId, [worker.identity.pid, worker.piChildIdentity.pid]]));
  const livePids = new Set(identities.keys());
  /** @type {string[]} */
  const launches = [];
  /** @type {any[]} */
  const diagnostics = [];
  /** @type {Record<string, () => void>} */
  const releases = {};
  /** @type {Record<string, Promise<unknown>>} */
  const launchGates = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, new Promise((resolveGate) => { releases[sessionId] = () => resolveGate(undefined); })]));
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    cliVersion: "2.0.0",
    reconnectTimeoutMs: 2_000,
    stopPolicy: { gracefulMs: 20, terminateMs: 20 },
    sleepImpl: async () => {},
    inspect: async (/** @type {number} */ pid) => {
      if (pid === process.pid) return { pid, startIdentity: "1", processGroupId: process.pid };
      if (!livePids.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return identities.get(pid);
    },
    signalProcessGroupImpl: (/** @type {number} */ pgid, /** @type {string} */ signal) => {
      if (signal !== "SIGTERM") return;
      for (const pid of groups.get(pgid) ?? []) livePids.delete(pid);
    },
    recordDiagnostic: (/** @type {any} */ entry) => { diagnostics.push(entry); },
    workerSupervisor: {
      useRouter() {},
      async launch(/** @type {any} */ request) {
        launches.push(request.sessionId);
        await launchGates[request.sessionId];
        return { sessionId: request.sessionId };
      },
      async close() {},
    },
  });
  runtimes.push(runtime);
  const loops = Object.fromEntries(workers.map((worker) => [worker.sessionId, startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, worker)]));
  await runtime.ready;
  await vi.waitFor(() => expect(runtime.status().connectedWorkers).toHaveLength(workers.length), { timeout: 5_000, interval: 25 });
  /** Let one held replacement launch finish. Releasing an already released launch does nothing. @param {string} sessionId */
  const release = (sessionId) => { releases[sessionId](); };
  return { stateRoot, registry, runtime, loops, launches, diagnostics, now, release };
}

// Operator-visible failure: four stale sessions settling close together replaced three and stranded the
// fourth on old code, with nothing said about it, until another turn settled, someone ran respawn by
// hand, or the daemon restarted.
it("replaces every settled stale session when more settle at once than the burst bound admits", async () => {
  const live = await burstReplaceableWorkers(["one", "two", "three", "four"]);

  // A held launch outlives a failed assertion, so every gate is released before this test returns.
  try {
    // Three replacements are held at their launch, which is what fills the bound.
    for (const sessionId of ["one", "two", "three"]) {
      await live.loops[sessionId].sendEvent({ type: "TURN_COMPLETED", at: live.now });
      await vi.waitFor(() => expect(live.launches).toContain(sessionId), { timeout: 8_000, interval: 25 });
    }
    await live.loops.four.sendEvent({ type: "TURN_COMPLETED", at: live.now });
    await vi.waitFor(async () => expect(await live.registry.get("four")).toMatchObject({ taskState: "READY" }), { timeout: 8_000, interval: 25 });
    expect(live.launches).toEqual(["one", "two", "three"]);

    live.release("one");

    await vi.waitFor(() => expect(live.launches).toEqual(["one", "two", "three", "four"]), { timeout: 8_000, interval: 25 });
    // The bound says what it does at the limit rather than dropping the work in silence.
    expect(live.diagnostics).toContainEqual(expect.objectContaining({ event: "respawn_deferred", sessionId: "four" }));
    for (const sessionId of ["two", "three", "four"]) live.release(sessionId);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(live.stateRoot, "daemon", "workers.json"), "utf8")).workers).toEqual([]), { timeout: 8_000, interval: 25 });
  } finally {
    for (const sessionId of Object.keys(live.loops)) live.release(sessionId);
    await Promise.all(Object.values(live.loops).map((loop) => loop.stop()));
  }
}, 30_000);

// Operator-visible failure: an explicit respawn that interrupted a running turn would destroy work the
// operator could not get back, and WAITING blocks on the operator rather than being idle.
it.each(/** @type {Array<[string, import("../shared/contracts.mjs").TaskState, string]>} */ ([
  ["working", "WORKING", "tool"],
  ["waiting on a person", "WAITING", "blocking_request"],
]))("refuses an explicit respawn while the session is %s and never signals it", async (_name, taskState, activityKind) => {
  const live = await replaceableWorker({ sessionId: "guarded", cliVersion: "1.9.0", taskState, activityKind });
  const frontend = await openSession(live.runtime, "guarded");

  frontend.send({ version: 1, clientId: "client", requestId: "respawn-busy", op: "respawn", payload: { sessionId: "guarded", revision: 0 } });

  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "command", status: { operation: "respawn", stage: "FAILED", error: { code: "SESSION_BUSY" } } } });
  expect(live.signals).toEqual([]);
  expect(live.launches).toEqual([]);
  expect(live.diagnostics).toEqual([expect.objectContaining({ event: "respawn_refused", sessionId: "guarded", code: "SESSION_BUSY" })]);
  expect(await live.registry.get("guarded")).toMatchObject({ revision: 0, taskState, ownership: { runId: "run-guarded" } });
  frontend.close();
}, 20_000);

// Operator-visible failure: an older daemon that replaced a newer worker would silently downgrade the
// operator's running session, and a worker with no recorded release is unknown rather than newer.
it("replaces an idle worker of unknown release on request and refuses to downgrade a newer one", async () => {
  const newer = await replaceableWorker({ sessionId: "guarded", cliVersion: "2.1.0", taskState: "READY" });
  const newerFrontend = await openSession(newer.runtime, "guarded");
  newerFrontend.send({ version: 1, clientId: "client", requestId: "respawn-newer", op: "respawn", payload: { sessionId: "guarded", revision: 0 } });
  expect(await newerFrontend.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "FAILED", error: { code: "WORKER_NEWER_THAN_DAEMON" } } } });
  expect(newer.signals).toEqual([]);
  expect(newer.launches).toEqual([]);
  // An idle newer worker is never replaced on its own either.
  await newer.loop.sendEvent({ type: "TURN_COMPLETED", at: newer.now });
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  expect(newer.launches).toEqual([]);
  newerFrontend.close();
  await newer.loop.stop();

  const unknown = await replaceableWorker({ sessionId: "nameless", taskState: "READY" });
  // Idle and replaceable, but with no promise on disk and no settled turn, nothing replaces it alone.
  expect(unknown.launches).toEqual([]);
  const frontend = await openSession(unknown.runtime, "nameless");
  frontend.send({ version: 1, clientId: "client", requestId: "respawn-unknown", op: "respawn", payload: { sessionId: "nameless", revision: 0 } });

  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "command", status: { operation: "respawn", stage: "COMPLETED" } } });
  expect(unknown.signals).toEqual([[unknown.identity.processGroupId, "SIGTERM"]]);
  expect(unknown.launches).toEqual(["nameless"]);
  frontend.close();
  await unknown.loop.stop();
}, 30_000);

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

  client.send({ version: 1, clientId: "client", requestId: "reopen", op: "attach", payload: { sessionId: "stopped", activate: true } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached", sessionId: "stopped" } });
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "stopped" }));
  client.close();
});

it("records the model Pi actually selected so the list can show it", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const identity = { pid: 621, startIdentity: "modelled-worker", processGroupId: 621 };
  const piChild = { pid: 622, startIdentity: "modelled-pi", processGroupId: 621 };
  const inspect = async (/** @type {number} */ pid) => pid === process.pid ? { pid, startIdentity: "daemon", processGroupId: process.pid } : pid === 621 ? identity : piChild;
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const now = "2026-08-25T12:00:00.000Z";
  // A launch that names no model still runs on Pi's default, and the row must say which.
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "modelled", sessionFile: "/sessions/modelled.jsonl", canonicalSessionFile: "/sessions/modelled.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "assistant_final", summary: "done", updatedAt: now }, ownership: { kind: "managed", runId: "run-modelled", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-modelled", createdAt: now, updatedAt: now });
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "modelled", runId: "run-modelled", leaseId: "lease-modelled", generation: 1, identity, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  const runtime = await createDaemonRuntime({ root: stateRoot, inspect });
  runtimes.push(runtime);
  startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, { sessionId: "modelled", runId: "run-modelled", leaseId: "lease-modelled", generation: 1, identity, piChildIdentity: piChild, token: "modelled-token", results: { get_state: { sessionId: "modelled", isStreaming: false, model: { provider: "openai-codex", id: "gpt-5.6-sol" }, thinkingLevel: "high" } } });
  await runtime.ready;

  await vi.waitFor(async () => expect(await registry.get("modelled")).toMatchObject({ model: { provider: "openai-codex", id: "gpt-5.6-sol" }, thinkingLevel: "high" }), { timeout: 5_000 });
});

it("marks a launch failed when the worker dies before it is ready", async () => {
  const stateRoot = await root();
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  // The supervisor spawned a worker, it died before worker_ready, and it released its lease on the way out.
  const launch = async () => { throw Object.assign(new Error("Worker exited before worker_ready (SIGTERM)"), { code: "WORKER_PROCESS_EXITED" }); };
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    hostProbe: async () => ({ blockers: [] }),
    workerSupervisor: { launch, async close() {} },
    resolveLaunchRequest: async () => ({
      sessionId: "doomed", canonicalSessionFile: "/sessions/doomed.jsonl", cwd: "/repo", runId: "run-doomed", initialPrompt: "hello",
      sessionRecord: { schemaVersion: 1, revision: 0, sessionId: "doomed", sessionFile: "/sessions/doomed.jsonl", canonicalSessionFile: "/sessions/doomed.jsonl", cwd: "/repo", name: "hello", taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "launching", summary: "hello", updatedAt: "2026-08-28T12:00:00.000Z" }, createdAt: "2026-08-28T12:00:00.000Z", updatedAt: "2026-08-28T12:00:00.000Z" },
    }),
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token });
  await client.ready;
  client.send({ version: 1, clientId: "launcher", requestId: "launch-doomed", op: "launch", payload: { prompt: "hello", cwd: "/repo", sourceSessionId: "dash", isolation: { mode: "worktree" } } });
  await client.next();

  // The row must say what happened rather than sitting at STARTING forever.
  await vi.waitFor(async () => expect(await registry.get("doomed")).toMatchObject({ taskState: "FAILED", processState: "EXITED", activity: { kind: "launch_failed" } }));
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

  client.send({ version: 1, clientId: "client", requestId: "reopen-orphan", op: "attach", payload: { sessionId: "orphan-writer", activate: true } });
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "WORKER_STILL_LIVE", retryable: false } });
  expect(launch).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(stateRoot, "daemon", "workers.json"), "utf8")).workers).toHaveLength(1);
  client.close();
});

// Operator-visible failure: after the worker of a session this daemon launched died, reopening that
// session did nothing at all, because the launch left a record of itself that claimed the session
// forever. The route is the only thing that may answer "is a worker already running here".
it("relaunches a session whose launched worker died during this daemon's lifetime", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const createdAt = "2026-08-25T00:00:00.000Z";
  const identity = { pid: 551, startIdentity: "relaunch-worker", processGroupId: 551 };
  const piChild = { pid: 552, startIdentity: "relaunch-pi", processGroupId: 551 };
  let workersLive = true;
  const inspect = async (/** @type {number} */ pid) => {
    if (pid === process.pid) return { pid, startIdentity: "daemon", processGroupId: process.pid };
    if (!workersLive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return pid === identity.pid ? identity : piChild;
  };
  /** @type {(value?: unknown) => void} */
  let closeRoute = () => {};
  const connection = {
    closed: new Promise((resolve) => { closeRoute = resolve; }),
    close: () => closeRoute(undefined),
    async send() {},
    async request() { return { stage: "RPC_ACKNOWLEDGED" }; },
  };
  /** @type {any} */
  let router;
  const launch = vi.fn(async (/** @type {any} */ request) => {
    if (launch.mock.calls.length > 1) return { sessionId: "relaunch", runId: request.runId, leaseId: "lease-relaunch-2", generation: 2, identity, piChildIdentity: piChild, ready: true };
    await router.reserve({ sessionId: "relaunch", runId: "run-relaunch", leaseId: "lease-relaunch", generation: 1, token: "relaunch-run-token" });
    const current = await registry.get("relaunch");
    if (current === undefined) throw new Error("relaunch record missing");
    await registry.update("relaunch", current.revision, { ownership: { kind: "managed", runId: "run-relaunch", process: identity, acquiredAt: createdAt, heartbeatAt: createdAt }, latestRunId: "run-relaunch", processState: "LIVE", updatedAt: createdAt });
    await router.register({ sessionId: "relaunch", runId: "run-relaunch", leaseId: "lease-relaunch", generation: 1, identity, piChildIdentity: piChild });
    await router.adopt({ version: 1, type: "worker_ready", token: "relaunch-run-token", sessionId: "relaunch", runId: "run-relaunch", leaseId: "lease-relaunch", generation: 1, worker: identity, piChild }, connection);
    return { sessionId: "relaunch", runId: "run-relaunch", leaseId: "lease-relaunch", generation: 1, identity, piChildIdentity: piChild, ready: true, detach() { closeRoute(undefined); } };
  });
  const runtime = await createDaemonRuntime({
    root: stateRoot,
    inspect,
    hostProbe: async () => ({ blockers: [] }),
    resolveLaunchRequest: async () => ({
      sessionId: "relaunch", canonicalSessionFile: "/sessions/relaunch.jsonl", cwd: "/repo", runId: "run-relaunch",
      sessionRecord: { schemaVersion: 1, revision: 0, sessionId: "relaunch", sessionFile: "/sessions/relaunch.jsonl", canonicalSessionFile: "/sessions/relaunch.jsonl", cwd: "/repo", taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "launching", summary: "start", updatedAt: createdAt }, isolation: { mode: "shared_directory", canonicalCwd: "/repo" }, createdAt, updatedAt: createdAt },
    }),
    workerSupervisor: {
      /** @param {any} suppliedRouter */
      useRouter(suppliedRouter) { router = suppliedRouter; },
      launch,
      async close() {},
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 8192 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "launch-relaunch", op: "launch", payload: { prompt: "start", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "shared_directory", confirmedCwd: "/repo", ownerSessionIds: [] } } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "launched", sessionId: "relaunch" } });
  expect(launch).toHaveBeenCalledTimes(1);

  // The worker and its Pi child die: the route closes and nothing owns the session any more.
  workersLive = false;
  closeRoute(undefined);
  const live = await registry.get("relaunch");
  if (live === undefined) throw new Error("relaunch record missing");
  await registry.update("relaunch", live.revision, { ownership: undefined, taskState: "STOPPED", processState: "EXITED", updatedAt: createdAt });
  await vi.waitFor(() => expect(router.route("relaunch")).toBeUndefined());

  client.send({ version: 1, clientId: "viewer", requestId: "reopen-relaunch", op: "attach", payload: { sessionId: "relaunch", activate: true } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached", sessionId: "relaunch" } });
  expect(launch).toHaveBeenCalledTimes(2);
  client.close();
});

// Operator-visible failure: a transcript that reorders or loses the frames a worker emitted between
// its startup connection and its adopted route. Those frames have nowhere to go until the route
// exists, so they are held and replayed, and the replay must not overtake later frames.
it("orders viewer frames across startup route adoption", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  const createdAt = "2026-08-25T00:00:00.000Z";
  const identity = { pid: 561, startIdentity: "ordered-worker", processGroupId: 561 };
  const piChild = { pid: 562, startIdentity: "ordered-pi", processGroupId: 561 };
  const inspect = async (/** @type {number} */ pid) => pid === identity.pid ? identity : pid === piChild.pid ? piChild : { pid, startIdentity: "daemon", processGroupId: pid };
  /** @param {any} frame */
  const piFrame = (frame) => ({ version: 1, type: "pi_frame", token: "ordered-run-token", sessionId: "ordered", frame });
  /** @param {number} index */
  const message = (index) => piFrame({ type: "message_end", message: { role: "user", content: `frame ${index}`, timestamp: Date.parse(createdAt) + index } });
  // A turn marker is not fingerprint-deduplicated the way a repeated message is, so a frame ingested
  // twice at the boundary shows up as an extra durable event rather than being silently absorbed.
  const turnStart = piFrame({ type: "agent_start" });
  /** @type {any} */
  let router;
  /** @type {any} */
  let runtime;
  /** @type {any} */
  let worker;
  runtime = await createDaemonRuntime({
    root: stateRoot,
    inspect,
    hostProbe: async () => ({ blockers: [] }),
    resolveLaunchRequest: async () => ({
      sessionId: "ordered", canonicalSessionFile: "/sessions/ordered.jsonl", cwd: "/repo", runId: "run-ordered",
      sessionRecord: { schemaVersion: 1, revision: 0, sessionId: "ordered", sessionFile: "/sessions/ordered.jsonl", canonicalSessionFile: "/sessions/ordered.jsonl", cwd: "/repo", taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "launching", summary: "start", updatedAt: createdAt }, isolation: { mode: "shared_directory", canonicalCwd: "/repo" }, createdAt, updatedAt: createdAt },
    }),
    workerSupervisor: {
      /** @param {any} suppliedRouter */
      useRouter(suppliedRouter) { router = suppliedRouter; },
      async launch() {
        const reservation = await router.reserve({ sessionId: "ordered", runId: "run-ordered", leaseId: "lease-ordered", generation: 1, token: "ordered-run-token" });
        worker = connect({ socketPath: runtime.socketPath, token: runtime.token, role: "worker", maxBytes: 8192 });
        await worker.ready;
        worker.send({ version: 1, type: "hello", token: "ordered-run-token", sessionId: "ordered", runId: "run-ordered", leaseId: "lease-ordered", generation: 1, worker: identity });
        // These three reach the daemon while the hello is still waiting for the spawned PID.
        worker.send(message(0));
        worker.send(message(1));
        worker.send(turnStart);
        reservation.spawned(identity.pid);
        await reservation.connected(4_000);
        const current = await registry.get("ordered");
        if (current === undefined) throw new Error("ordered record missing");
        await registry.update("ordered", current.revision, { ownership: { kind: "managed", runId: "run-ordered", process: identity, acquiredAt: createdAt, heartbeatAt: createdAt }, latestRunId: "run-ordered", processState: "LIVE", updatedAt: createdAt });
        worker.send({ version: 1, type: "worker_ready", token: "ordered-run-token", sessionId: "ordered", runId: "run-ordered", leaseId: "lease-ordered", generation: 1, worker: identity, piChild });
        const ready = await reservation.waitFor("worker_ready", 4_000);
        // This one arrives while the route is being adopted.
        worker.send(message(2));
        await router.register({ sessionId: "ordered", runId: "run-ordered", leaseId: "lease-ordered", generation: 1, identity, piChildIdentity: piChild });
        const route = await router.adopt(ready, reservation.connection);
        reservation.adopt(route);
        return { sessionId: "ordered", runId: "run-ordered", leaseId: "lease-ordered", generation: 1, identity, piChildIdentity: piChild, ready: true, detach() { route.connection.close?.(); } };
      },
      async close() {},
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 65536 });
  await client.ready;
  client.send({ version: 1, clientId: "viewer", requestId: "launch-ordered", op: "launch", payload: { prompt: "start", cwd: "/repo", sourceSessionId: "source", isolation: { mode: "shared_directory", confirmedCwd: "/repo", ownerSessionIds: [] } } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "launched", sessionId: "ordered" } });

  // And these two arrive over the adopted route.
  worker.send(message(3));
  worker.send(message(4));

  await vi.waitFor(async () => {
    client.send({ version: 1, clientId: "viewer", requestId: `ordered-${randomUUID()}`, op: "get_viewer_snapshot", payload: { sessionId: "ordered" } });
    const response = await client.next();
    expect(response.result.snapshot.items).toHaveLength(5);
  }, { timeout: 4_000 });
  client.send({ version: 1, clientId: "viewer", requestId: "ordered-final", op: "get_viewer_snapshot", payload: { sessionId: "ordered" } });
  const snapshot = /** @type {any} */ (await client.next());
  expect(snapshot.result.snapshot.items.map((/** @type {any} */ item) => item.content[0].text))
    .toEqual([0, 1, 2, 3, 4].map((index) => `frame ${index}`));

  // Each frame crossed the boundary exactly once, in source order, with a distinct stable ID.
  const durable = (await readFile(join(stateRoot, "index", "viewer", `${createHash("sha256").update("ordered").digest("hex")}.events.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(durable.map((/** @type {any} */ event) => event.payload.kind === "user_message" ? event.payload.content[0].text : event.payload.kind))
    .toEqual(["frame 0", "frame 1", "turn_state", "activity", "frame 2", "frame 3", "frame 4"]);
  expect(new Set(durable.map((/** @type {any} */ event) => event.eventId)).size).toBe(durable.length);
  worker.close();
  client.close();
});

// Operator-visible failure: this release replaced the replayed list-event stream with payload-free
// invalidations. A dashboard from the previous release read rows once and then sat on them forever,
// because its `subscribe` was a fire-and-forget frame whose refusal it dropped in silence.
it("refuses a frontend that did not declare this release's client protocol, once, without closing it", async () => {
  const runtime = await createDaemonRuntime({ root: await root() });
  runtimes.push(runtime);
  await runtime.ready;

  const old = connect({ socketPath: runtime.socketPath, token: runtime.token, declaredClientProtocol: null, maxBytes: 16384 });
  // Authentication still succeeds, so the daemon-liveness probe keeps working across releases.
  expect(await old.ready).toMatchObject({ version: 1, kind: "authenticated" });

  old.send({ version: 1, clientId: "old-dashboard", requestId: "read", op: "get_state", payload: {} });
  expect(await old.next()).toMatchObject({ ok: false, requestId: "read", error: { code: "UNSUPPORTED_CLIENT_PROTOCOL", message: expect.stringContaining("restart every dashboard") } });
  // The retired operation is refused the same way, and the connection stays open: closing it made
  // the old client reconnect and resubscribe, which is how one refusal became a reconnect storm.
  old.send({ version: 1, clientId: "old-dashboard", requestId: "subscribe", op: "subscribe", payload: {} });
  expect(await old.next()).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_CLIENT_PROTOCOL" } });
  expect(old.socket.destroyed).toBe(false);
  old.close();

  // A frontend from a later release is refused the same way, and named the protocol this one speaks.
  const newer = connect({ socketPath: runtime.socketPath, token: runtime.token, declaredClientProtocol: CLIENT_PROTOCOL + 1, maxBytes: 16384 });
  await newer.ready;
  newer.send({ version: 1, clientId: "newer-dashboard", requestId: "read", op: "get_state", payload: {} });
  expect(await newer.next()).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_CLIENT_PROTOCOL", message: expect.stringContaining(`protocol ${CLIENT_PROTOCOL}`) } });
  newer.close();

  const current = connect({ socketPath: runtime.socketPath, token: runtime.token, maxBytes: 16384 });
  await current.ready;
  current.send({ version: 1, clientId: "current-dashboard", requestId: "read", op: "get_state", payload: {} });
  expect(await current.next()).toMatchObject({ ok: true, result: { kind: "state" } });
  current.close();
});

/**
 * One live session owned by one connected fake worker, which is what a concurrent-writer test and a
 * restart test both need. Returns the fixture the caller starts its own daemon runtimes against.
 * @param {string} stateRoot @param {string} sessionId
 */
async function liveSessionRoot(stateRoot, sessionId) {
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const identity = { pid: 811, startIdentity: "worker-shared", processGroupId: 811 };
  const piChildIdentity = { pid: 812, startIdentity: "pi-shared", processGroupId: 811 };
  /** @param {number} pid */
  const inspect = async (pid) => {
    if (pid === process.pid) return { pid, startIdentity: "daemon", processGroupId: process.pid };
    if (pid === 811) return identity;
    if (pid === 812) return piChildIdentity;
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  };
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, canonicalSessionFile: `/sessions/${sessionId}.jsonl`, cwd: "/repo", taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: now }, ownership: { kind: "managed", runId: "run-shared", process: identity, acquiredAt: now, heartbeatAt: now }, latestRunId: "run-shared", createdAt: now, updatedAt: now });
  const worker = { sessionId, runId: "run-shared", leaseId: "lease-shared", generation: 1, identity, piChildIdentity, token: "shared-worker-token" };
  await writeFile(join(stateRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId, runId: worker.runId, leaseId: worker.leaseId, generation: 1, identity, piChildIdentity, token: worker.token }] })}\n`, { mode: 0o600 });
  return { inspect, registry, worker };
}

// Operator-visible failure: one dashboard held the session's composer claim and every other one was
// refused, so the second terminal could read the session and not answer it.
it("orders and journals concurrent commands from three dashboard processes on one session", async () => {
  const stateRoot = await root();
  const { inspect, worker } = await liveSessionRoot(stateRoot, "shared");
  const runtime = await createDaemonRuntime({ root: stateRoot, inspect, reconnectTimeoutMs: 1_000 });
  runtimes.push(runtime);
  const loop = startPersistentFakeWorker({ socketPath: runtime.socketPath, tokenPath: runtime.tokenPath }, worker);
  await runtime.ready;

  // Three dashboard processes of one installation: three process-scoped attachIds, one stable clientId.
  const attachIds = ["attach-one", "attach-two", "attach-three"];
  const dashboards = attachIds.map((attachId) => connect({ socketPath: runtime.socketPath, token: runtime.token, attachId, maxBytes: 8192 }));
  for (const dashboard of dashboards) expect(await dashboard.ready).toMatchObject({ version: 1, kind: "authenticated" });

  const requests = dashboards.map((_dashboard, index) => ({ version: 1, clientId: "installation-1", requestId: `prompt-${index}`, op: "prompt", payload: { sessionId: "shared", text: `from dashboard ${index}` } }));
  // No attachment, claim, or grant precedes a mutation: every authenticated client may write.
  requests.forEach((request, index) => dashboards[index].send(request));
  const responses = await Promise.all(dashboards.map((dashboard) => dashboard.next()));
  for (const response of responses) expect(response).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED", clientId: "installation-1" } } });

  const journal = (await readFile(join(stateRoot, "queue", "commands.jsonl"), "utf8")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
  expect(new Set(journal.map((record) => record.status.clientId))).toEqual(new Set(["installation-1"]));
  const journalOrder = [...new Set(journal.map((record) => record.status.requestId))];
  expect(journalOrder.sort()).toEqual(["prompt-0", "prompt-1", "prompt-2"]);
  // The per-session coordinator delivered them in exactly the order the journal accepted them. The
  // worker also answers this daemon's own adoption probe, which is not a journaled client command.
  const accepted = journal.filter((record) => record.status.stage === "ACCEPTED").map((record) => record.status.requestId);
  expect(loop.commands.map((command) => command.requestId).filter((requestId) => requestId.startsWith("prompt-"))).toEqual(accepted);
  for (const dashboard of dashboards) dashboard.close();
});

// Operator-visible failure: a restart that rewrote worker identity would orphan the operator's live
// Pi child, which is the one thing a dashboard change may never do.
it("leaves worker identity exactly as it was when the daemon restarts mid-session", async () => {
  const stateRoot = await root();
  const { inspect, registry, worker } = await liveSessionRoot(stateRoot, "resident");
  const firstRuntime = await createDaemonRuntime({ root: stateRoot, inspect, reconnectTimeoutMs: 1_000 });
  const loop = startPersistentFakeWorker({ socketPath: firstRuntime.socketPath, tokenPath: firstRuntime.tokenPath }, worker);
  await firstRuntime.ready;
  const before = connect({ socketPath: firstRuntime.socketPath, token: firstRuntime.token, attachId: "attach-before", maxBytes: 8192 });
  expect(await before.ready).toMatchObject({ version: 1, kind: "authenticated" });
  before.send({ version: 1, clientId: "installation-1", requestId: "before-restart", op: "prompt", payload: { sessionId: "resident", text: "before" } });
  expect(await before.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  before.close();

  // routeGeneration is the one field adoption is allowed to move; everything identifying the process is not.
  /** @param {string} text */
  const workerIdentity = (text) => JSON.parse(text).workers.map((/** @type {any} */ { routeGeneration: _routeGeneration, ...rest }) => rest);
  const identityBefore = workerIdentity(await readFile(join(stateRoot, "daemon", "workers.json"), "utf8"));
  const ownershipBefore = (await registry.get("resident"))?.ownership;
  await firstRuntime.close();
  expect(loop.alive).toBe(true);

  const secondRuntime = await createDaemonRuntime({ root: stateRoot, inspect, reconnectTimeoutMs: 1_000 });
  runtimes.push(secondRuntime);
  await secondRuntime.ready;
  await vi.waitFor(() => expect(secondRuntime.status().connectedWorkers).toEqual(["resident"]));
  expect(workerIdentity(await readFile(join(stateRoot, "daemon", "workers.json"), "utf8"))).toEqual(identityBefore);
  expect((await registry.get("resident"))?.ownership).toEqual(ownershipBefore);
  expect(loop.alive).toBe(true);

  const after = connect({ socketPath: secondRuntime.socketPath, token: secondRuntime.token, attachId: "attach-after", maxBytes: 8192 });
  await after.ready;
  after.send({ version: 1, clientId: "installation-1", requestId: "after-restart", op: "prompt", payload: { sessionId: "resident", text: "after" } });
  expect(await after.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  after.close();
  await secondRuntime.close();
  runtimes.splice(runtimes.indexOf(secondRuntime), 1);
  expect(loop.alive).toBe(true);
});

// The operator's index/viewer/*.snapshot.json files were written by the release that still had
// access roles. Recovery must read one and publish it forward without its retired `role`.
it("recovers a viewer snapshot written with a retired role and republishes it without one", async () => {
  const stateRoot = await root();
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(stateRoot, name), { mode: 0o700 });
  await mkdir(join(stateRoot, "index", "viewer"), { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const sessionFile = join(stateRoot, "legacy.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: now, cwd: stateRoot })}\n`, { mode: 0o600 });
  const registry = new RegistryStore(join(stateRoot, "sessions"));
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "legacy", sessionFile, canonicalSessionFile: sessionFile, cwd: stateRoot, taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "assistant_final", summary: "done", updatedAt: now }, createdAt: now, updatedAt: now });
  const daemonEpoch = randomUUID();
  await writeFile(join(stateRoot, "daemon", "epoch"), daemonEpoch, { mode: 0o600 });
  const stem = createHash("sha256").update("legacy").digest("hex");
  const snapshotPath = join(stateRoot, "index", "viewer", `${stem}.snapshot.json`);
  await writeFile(snapshotPath, `${JSON.stringify({
    version: 1, sessionId: "legacy", registryRevision: 0, cursor: { daemonEpoch, sessionId: "legacy", sequence: "0" }, runtime: null,
    role: "composer", taskState: "READY", processState: "EXITED", outcome: "NONE",
    activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "seed", startedAt: now },
    model: null, thinkingLevel: null, items: [], tools: [], pendingUi: [], errors: [],
  })}\n`, { mode: 0o600 });

  const runtime = await createDaemonRuntime({ root: stateRoot });
  runtimes.push(runtime);
  await runtime.ready;
  const client = connect({ socketPath: runtime.socketPath, token: runtime.token, attachId: "attach-legacy", maxBytes: 16384 });
  await client.ready;
  client.send({ version: 1, clientId: "installation-1", requestId: "snapshot", op: "get_viewer_snapshot", payload: { sessionId: "legacy" } });
  const response = await client.next();
  expect(response).toMatchObject({ ok: true, result: { kind: "viewer_snapshot" } });
  expect(response.result.snapshot).not.toHaveProperty("role");
  expect(JSON.parse(await readFile(snapshotPath, "utf8"))).not.toHaveProperty("role");
  client.close();
});

it("authenticates a control stop that carries no client protocol", async () => {
  const runtime = await createDaemonRuntime({ root: await root() });
  runtimes.push(runtime);
  await runtime.ready;
  // Control and worker frames deliberately carry no client protocol: a live worker must survive a
  // daemon replacement, and `daemon stop` must reach a daemon of either release.
  const control = connect({ socketPath: runtime.socketPath, token: runtime.token, role: "control", maxBytes: 4096 });
  expect(await control.ready).toMatchObject({ version: 1, kind: "authenticated" });
  await runtime.stopRequested;
  control.close();
});
