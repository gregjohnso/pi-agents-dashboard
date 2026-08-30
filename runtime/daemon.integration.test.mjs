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
function connect({ socketPath, token, maxBytes = 1024 }) {
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
      socket.write(encoder.encode({ version: 1, token }));
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
  const menu = { commands: [], models: [{ provider: "anthropic", id: "claude" }], model: null };
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
  client.send({ version: 1, clientId: "viewer", requestId: "attach-query", op: "attach", payload: { sessionId: "query", role: "composer" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { role: "composer" } });

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
  client.send({ version: 1, clientId: "viewer", requestId: "attach-silent", op: "attach", payload: { sessionId: "silent", role: "composer" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { role: "composer" } });

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
  client.send({ version: 1, clientId: "viewer", requestId: "attach-menu", op: "attach", payload: { sessionId: "menu", role: "composer" } });
  expect(await client.next()).toMatchObject({ ok: true, result: { role: "composer" } });
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

it.each([
  ["after_prepared", "abandon"],
  ["after_event_append", "retry_at_risk"],
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

  client.send({ version: 1, clientId: "client", requestId: "reopen", op: "attach", payload: { sessionId: "stopped", role: "composer", activate: true } });
  expect(await client.next()).toMatchObject({ ok: true, result: { kind: "attached", sessionId: "stopped", role: "composer" } });
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

  client.send({ version: 1, clientId: "client", requestId: "reopen-orphan", op: "attach", payload: { sessionId: "orphan-writer", role: "composer", activate: true } });
  expect(await client.next()).toMatchObject({ ok: false, error: { code: "WORKER_STILL_LIVE", retryable: false } });
  expect(launch).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(stateRoot, "daemon", "workers.json"), "utf8")).workers).toHaveLength(1);
  client.close();
});
