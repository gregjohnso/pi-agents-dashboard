import * as fs from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-file.mjs";
import { createCommandJournal } from "./command-journal.mjs";
import { createEventStore } from "./event-store.mjs";
import { RegistryStore, registryCoordinationScope } from "./registry-store.mjs";
import { createSessionHistoryReader, SessionHistoryError } from "./session-history.mjs";
import { createViewerNormalizer } from "./viewer-normalizer.mjs";
import { createViewerStore } from "./viewer-store.mjs";

/** @param {any} left @param {any} right */
function sameIdentity(left, right) {
  return left?.pid === right?.pid && left?.startIdentity === right?.startIdentity && left?.processGroupId === right?.processGroupId;
}

/** @param {any} value */
function validIdentity(value) {
  return Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value.startIdentity === "string" && value.startIdentity.length > 0 && Number.isSafeInteger(value.processGroupId) && value.processGroupId > 0;
}

/** @param {any} worker */
function validateWorkerMetadata(worker) {
  const allowed = ["sessionId", "runId", "leaseId", "generation", "identity", "piChildIdentity", "token"];
  if (typeof worker !== "object" || worker === null || Array.isArray(worker) || Object.keys(worker).some((key) => !allowed.includes(key)) || [worker.sessionId, worker.runId, worker.leaseId].some((value) => typeof value !== "string" || value.length === 0) || !Number.isSafeInteger(worker.generation) || worker.generation <= 0 || !validIdentity(worker.identity) || !validIdentity(worker.piChildIdentity) || (worker.token !== undefined && (typeof worker.token !== "string" || worker.token.length === 0))) throw new TypeError("Worker recovery metadata record is invalid");
  return worker;
}

/** @param {unknown} error */
function exited(error) {
  return error instanceof Error && ["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "");
}

/** @param {string} path @returns {Promise<any[]>} */
async function latestJournalRecords(path) {
  let text;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }
  const latest = new Map();
  for (const line of text.trimEnd().split("\n")) {
    if (line.length === 0) continue;
    const record = JSON.parse(line);
    if (record?.status?.clientId !== undefined && record?.status?.requestId !== undefined) latest.set(`${record.status.clientId}\0${record.status.requestId}`, record);
  }
  return [...latest.values()];
}

export class RecoveredWorkerRouter {
  #registry;
  #inspect;
  #metadataPath;
  #workers = new Map();
  #routes = new Map();
  #routeGenerations = new Map();
  #lifecycle;
  #loaded = false;

  /** @param {{ registry: RegistryStore, inspect(pid: number): Promise<any>, metadataPath: string }} options */
  constructor({ registry, inspect, metadataPath }) {
    this.#registry = registry;
    this.#inspect = inspect;
    this.#metadataPath = metadataPath;
    this.#lifecycle = registryCoordinationScope(registry).lifecycle;
  }

  async load() {
    if (this.#loaded) return;
    try {
      const metadata = await fs.lstat(this.#metadataPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw new TypeError("Worker recovery metadata must be a private owned file");
      const value = JSON.parse(await fs.readFile(this.#metadataPath, "utf8"));
      if (value?.schemaVersion !== 1 || !Array.isArray(value.workers) || Object.keys(value).some((key) => !["schemaVersion", "workers"].includes(key))) throw new TypeError("Worker recovery metadata is invalid");
      for (const candidate of value.workers) {
        const worker = validateWorkerMetadata(candidate);
        if (this.#workers.has(worker.sessionId)) throw new TypeError("Worker recovery metadata contains duplicate sessions");
        this.#workers.set(worker.sessionId, worker);
      }
    } catch (error) {
      if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    }
    this.#loaded = true;
  }

  async #persist() {
    await atomicWriteJson(this.#metadataPath, { schemaVersion: 1, workers: [...this.#workers.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)) });
  }

  /** @param {any} handle */
  async register(handle) {
    return this.#lifecycle.runNested(handle.sessionId, async () => {
      const routeGeneration = (this.#routeGenerations.get(handle.sessionId) ?? 0) + 1;
      this.#routeGenerations.set(handle.sessionId, routeGeneration);
      const record = await this.#registry.get(handle.sessionId);
      if (record?.ownership === undefined || record.ownership.runId !== handle.runId || !sameIdentity(record.ownership.process, handle.identity)) throw Object.assign(new Error("Launched worker does not own the durable registry record"), { code: "OWNERSHIP_CONFLICT" });
      this.#workers.set(handle.sessionId, {
        sessionId: handle.sessionId,
        runId: handle.runId,
        leaseId: handle.leaseId,
        generation: handle.generation,
        identity: handle.identity,
        piChildIdentity: handle.piChildIdentity,
      });
      await this.#persist();
      const previous = this.#routes.get(handle.sessionId);
      if (previous !== undefined && previous.routeGeneration < routeGeneration) {
        this.#routes.delete(handle.sessionId);
        previous.connection.close?.();
      }
    });
  }

  /** @param {string} sessionId */
  metadata(sessionId) {
    return this.#workers.get(sessionId);
  }

  connectedSessionIds() {
    return [...this.#routes.keys()];
  }

  /** @template T @param {string} sessionId @param {() => Promise<T>} action */
  #serializeRoute(sessionId, action) {
    return this.#lifecycle.run(sessionId, action);
  }

  /** @param {any} frame @param {any} connection */
  async adopt(frame, connection) {
    const allowed = ["version", "type", "token", "sessionId", "runId", "leaseId", "generation", "worker", "piChild"];
    if (typeof frame !== "object" || frame === null || Array.isArray(frame) || Object.keys(frame).some((key) => !allowed.includes(key)) || frame.version !== 1 || frame.type !== "worker_ready") throw Object.assign(new Error("Invalid worker ready frame"), { code: "INVALID_WORKER_FRAME" });
    return this.#serializeRoute(frame.sessionId, async () => {
      const expected = this.#workers.get(frame.sessionId);
      if (expected === undefined || expected.runId !== frame.runId || expected.leaseId !== frame.leaseId || expected.generation !== frame.generation || !sameIdentity(expected.identity, frame.worker) || !sameIdentity(expected.piChildIdentity, frame.piChild)) throw Object.assign(new Error("Worker ownership or generation conflicts with durable state"), { code: "OWNERSHIP_CONFLICT" });
      if (expected.token !== undefined && expected.token !== frame.token) throw Object.assign(new Error("Worker authentication failed"), { code: "WORKER_AUTHENTICATION_FAILED" });
      const routeGeneration = (this.#routeGenerations.get(frame.sessionId) ?? 0) + 1;
      this.#routeGenerations.set(frame.sessionId, routeGeneration);
      const record = await this.#registry.get(frame.sessionId);
      if (this.#routeGenerations.get(frame.sessionId) !== routeGeneration) throw Object.assign(new Error("Worker connection was superseded during registration"), { code: "STALE_WORKER_CONNECTION" });
      if (record?.ownership === undefined || record.ownership.runId !== frame.runId || !sameIdentity(record.ownership.process, frame.worker)) throw Object.assign(new Error("Worker ownership or generation conflicts with durable state"), { code: "OWNERSHIP_CONFLICT" });
      const [actualWorker, actualPiChild] = await Promise.all([
        this.#inspect(frame.worker.pid),
        frame.piChild.pid === frame.worker.pid ? Promise.resolve(undefined) : this.#inspect(frame.piChild.pid),
      ]);
      if (this.#routeGenerations.get(frame.sessionId) !== routeGeneration) throw Object.assign(new Error("Worker connection was superseded during identity validation"), { code: "STALE_WORKER_CONNECTION" });
      if (!sameIdentity(actualWorker, frame.worker) || (actualPiChild !== undefined && !sameIdentity(actualPiChild, frame.piChild))) throw Object.assign(new Error("Worker or Pi-child process identity changed"), { code: "PROCESS_IDENTITY_CONFLICT" });
      if (expected.token === undefined) {
        if (typeof frame.token !== "string" || frame.token.length === 0) throw Object.assign(new Error("Worker authentication token is missing"), { code: "WORKER_AUTHENTICATION_FAILED" });
        expected.token = frame.token;
        await this.#persist();
      }
      const previous = this.#routes.get(frame.sessionId);
      const route = { connection, metadata: expected, routeGeneration };
      this.#routes.set(frame.sessionId, route);
      previous?.connection.close?.();
      connection.closed.finally(() => {
        if (this.#routes.get(frame.sessionId) === route) this.#routes.delete(frame.sessionId);
      }).catch(() => {});
      return route;
    });
  }

  /** @param {string} sessionId */
  route(sessionId) {
    return this.#routes.get(sessionId);
  }

  /** Serialize a daemon lifecycle action with route adoption, replacement, and worker frames. @param {string} sessionId @param {(state: any) => Promise<any>} action */
  runSession(sessionId, action) {
    return this.#serializeRoute(sessionId, async () => {
      const metadata = this.#workers.get(sessionId);
      const route = this.#routes.get(sessionId);
      let forgotten = false;
      return action({
        metadata,
        route,
        forget: async () => {
          if (forgotten) return;
          if (this.#workers.get(sessionId) !== metadata || this.#routes.get(sessionId) !== route) {
            throw Object.assign(new Error("Worker route changed during lifecycle action"), { code: "STALE_WORKER_CONNECTION" });
          }
          forgotten = true;
          this.#workers.delete(sessionId);
          this.#routes.delete(sessionId);
          await this.#persist();
          route?.connection.close?.();
        },
      });
    });
  }

  /** @param {any} metadata @param {any} connection @param {number} routeGeneration */
  #assertRoute(metadata, connection, routeGeneration) {
    const route = this.#routes.get(metadata?.sessionId);
    if (this.#workers.get(metadata?.sessionId) !== metadata || this.#routeGenerations.get(metadata?.sessionId) !== routeGeneration || route?.metadata !== metadata || route?.connection !== connection || route?.routeGeneration !== routeGeneration) throw Object.assign(new Error("Worker connection was replaced"), { code: "STALE_WORKER_CONNECTION" });
  }

  /** Verify the current route and both live process identities before one frame boundary. @param {any} metadata @param {any} connection @param {number} routeGeneration */
  async #assertCurrent(metadata, connection, routeGeneration) {
    this.#assertRoute(metadata, connection, routeGeneration);
    const record = await this.#registry.get(metadata.sessionId);
    this.#assertRoute(metadata, connection, routeGeneration);
    if (record?.ownership === undefined || record.ownership.runId !== metadata.runId || !sameIdentity(record.ownership.process, metadata.identity)) throw Object.assign(new Error("Worker no longer owns the durable session"), { code: "OWNERSHIP_CONFLICT" });
    const [actualWorker, actualPiChild] = await Promise.all([
      this.#inspect(metadata.identity.pid),
      metadata.piChildIdentity.pid === metadata.identity.pid ? Promise.resolve(undefined) : this.#inspect(metadata.piChildIdentity.pid),
    ]);
    this.#assertRoute(metadata, connection, routeGeneration);
    if (!sameIdentity(actualWorker, metadata.identity) || (actualPiChild !== undefined && !sameIdentity(actualPiChild, metadata.piChildIdentity))) throw Object.assign(new Error("Worker or Pi-child process identity changed"), { code: "PROCESS_IDENTITY_CONFLICT" });
    if (this.#workers.get(metadata.sessionId)?.leaseId !== metadata.leaseId || this.#workers.get(metadata.sessionId)?.generation !== metadata.generation) throw Object.assign(new Error("Worker lease or generation changed"), { code: "OWNERSHIP_CONFLICT" });
  }

  /** Serialize one worker frame against connection replacement. @param {any} metadata @param {any} connection @param {number} routeGeneration @param {() => Promise<any>} action */
  runCurrent(metadata, connection, routeGeneration, action) {
    return this.#serializeRoute(metadata.sessionId, async () => {
      await this.#assertCurrent(metadata, connection, routeGeneration);
      return action();
    });
  }

  /** @param {string} sessionId */
  connection(sessionId) {
    return this.#routes.get(sessionId)?.connection;
  }

  async close() {
    const routes = [...this.#routes.values()];
    this.#routes.clear();
    for (const route of routes) route.connection.close?.();
    await this.#lifecycle.idle();
  }
}

/** Recover every per-session normalized stream before daemon mutation admission. @param {{ root: string, daemonEpoch: string, registry: RegistryStore }} options */
async function createViewerRecovery({ root, daemonEpoch, registry }) {
  const directory = join(root, "index", "viewer");
  /** @type {Map<string, any>} */
  const sessions = new Map();

  /** @param {any} state */
  async function publish(state) {
    const current = await registry.get(state.sessionId);
    if (current === undefined) throw Object.assign(new Error(`Unknown viewer session: ${state.sessionId}`), { code: "SESSION_NOT_FOUND" });
    const snapshot = state.normalizer.snapshot({
      daemonEpoch,
      sequence: state.store.currentCursor().sequence,
      registryRevision: current.revision,
      runtime: current.runtime ?? null,
      model: current.model ?? null,
      thinkingLevel: current.thinkingLevel ?? null,
      role: state.role ?? "observer",
      taskState: current.taskState,
      processState: current.processState,
      outcome: current.outcome,
    });
    return state.store.publishSnapshot(snapshot, state.normalizer.checkpoint());
  }

  /** @param {any} state */
  async function readHistory(state) {
    const history = await state.reader.read();
    for (const error of history.errors) state.normalizer.consumeError(error);
    for (const item of history.entries) {
      const drafts = state.normalizer.consumeHistory(item.entry, { ...item.position, sourceId: item.sourceId });
      for (const draft of drafts) {
        try {
          await state.store.append(draft);
        } catch (error) {
          // A published event is authoritative: frontends already consumed it at that cursor, so re-derived drift never rewrites history.
          if (/** @type {any} */ (error)?.code !== "VIEWER_EVENT_ID_CONFLICT") throw error;
        }
      }
    }
  }

  /** @param {any} record */
  async function openSession(record) {
    const existing = sessions.get(record.sessionId);
    if (existing !== undefined) return existing;
    const store = await createViewerStore({ directory, sessionId: record.sessionId, daemonEpoch });
    const normalizer = createViewerNormalizer({ sessionId: record.sessionId, protocolVersion: 1, now: () => new Date().toISOString() });
    let reader;
    try {
      reader = await createSessionHistoryReader({ path: record.canonicalSessionFile });
    } catch (error) {
      const missing = /** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT";
      if (!missing && !(error instanceof SessionHistoryError)) throw error;
      const historyError = /** @type {SessionHistoryError} */ (error);
      normalizer.consumeError({ code: missing ? "SESSION_HISTORY_MISSING" : historyError.code, message: missing ? "Canonical session history is unavailable" : historyError.message, retryable: missing });
      reader = { async read() { return { entries: [], errors: [], position: { byteOffset: 0, line: 0 } }; }, async close() {} };
    }
    const state = { sessionId: record.sessionId, store, normalizer, reader, role: "observer" };
    sessions.set(record.sessionId, state);
    const snapshot = await store.getSnapshot();
    if (snapshot !== undefined) normalizer.restore(snapshot);
    const replay = await store.replay(snapshot?.cursor);
    for (const event of replay) normalizer.applyViewerEvent(event);
    const checkpoint = await store.getCheckpoint();
    if (checkpoint !== undefined) normalizer.restoreCheckpoint(checkpoint);
    await readHistory(state);
    await publish(state);
    return state;
  }

  try {
    for (const record of await registry.list()) await openSession(record);
  } catch (error) {
    await Promise.allSettled([...sessions.values()].flatMap((state) => [state.reader.close(), state.store.close()]));
    throw error;
  }

  return {
    /** @param {string} sessionId */
    async ensure(sessionId) {
      const record = await registry.get(sessionId);
      if (record === undefined) throw Object.assign(new Error(`Unknown viewer session: ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      return openSession(record);
    },
    /** @param {string} sessionId @param {any} frame */
    async ingest(sessionId, frame) {
      const state = sessions.get(sessionId);
      if (state === undefined) throw Object.assign(new Error(`Unknown viewer session: ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      /** @type {any[]} */
      const persisted = [];
      for (const draft of state.normalizer.consumeFrame(frame)) persisted.push(await state.store.append(draft));
      await publish(state);
      return persisted;
    },
    /** @param {string} sessionId @param {"composer" | "observer"} [role] */
    async snapshot(sessionId, role = "observer") {
      const state = sessions.get(sessionId);
      if (state === undefined) throw Object.assign(new Error(`Unknown viewer session: ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      state.role = role;
      await readHistory(state);
      return publish(state);
    },
    /** @param {string} sessionId */
    store(sessionId) { return sessions.get(sessionId)?.store; },
    async close() {
      const results = await Promise.allSettled([...sessions.values()].flatMap((state) => [state.reader.close(), state.store.close()]));
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, "Viewer recovery stores closed with errors");
    },
  };
}

/** @param {{ root: string, daemonEpoch: string, inspect(pid: number): Promise<any>, waitForReconnect?: (workers: any[], router: RecoveredWorkerRouter) => Promise<string[]>, onViewerReady?: (viewer: any) => void | Promise<void>, router?: RecoveredWorkerRouter, signal?: AbortSignal }} options */
export async function reconcileRuntime({ root, daemonEpoch, inspect, waitForReconnect = async () => [], onViewerReady = () => {}, router: suppliedRouter, signal }) {
  const registry = new RegistryStore(join(root, "sessions"));
  const journalPath = join(root, "queue", "commands.jsonl");
  const eventPath = join(root, "index", "events.jsonl");
  /** @type {any} */
  let journal;
  /** @type {any} */
  let events;
  /** @type {any} */
  let viewer;
  const router = suppliedRouter ?? new RecoveredWorkerRouter({ registry, inspect, metadataPath: join(root, "daemon", "workers.json") });
  const cancelled = () => {
    if (signal?.aborted) throw Object.assign(new Error("Reconciliation was cancelled"), { code: "RECONCILIATION_CANCELLED" });
  };
  try {
    cancelled();
    journal = await createCommandJournal({ path: journalPath });
    cancelled();
    events = await createEventStore({ path: eventPath, daemonEpoch });
    await router.load();
    viewer = await createViewerRecovery({ root, daemonEpoch, registry });
    await onViewerReady(viewer);
    cancelled();
    /** @type {any[]} */
    const liveWorkers = [];
    /** @type {any[]} */
    const conflicts = [];
    for (const record of await registry.list()) {
      cancelled();
      if (record.ownership === undefined) continue;
      let actual;
      try {
        actual = await inspect(record.ownership.process.pid);
      } catch (error) {
        conflicts.push({ sessionId: record.sessionId, reason: exited(error) ? "WORKER_EXITED" : "PROCESS_IDENTITY_AMBIGUOUS", ownership: record.ownership });
        continue;
      }
      if (!sameIdentity(actual, record.ownership.process)) {
        conflicts.push({ sessionId: record.sessionId, reason: "PROCESS_IDENTITY_MISMATCH", ownership: record.ownership, actual });
        continue;
      }
      const metadata = router.metadata(record.sessionId);
      if (metadata === undefined) {
        conflicts.push({ sessionId: record.sessionId, reason: "OWNERSHIP_METADATA_MISSING", ownership: record.ownership });
        continue;
      }
      if (metadata.runId !== record.ownership.runId || !sameIdentity(metadata.identity, actual)) {
        conflicts.push({ sessionId: record.sessionId, reason: "OWNERSHIP_METADATA_CONFLICT", ownership: record.ownership, metadata });
        continue;
      }
      let piChild;
      try {
        piChild = metadata.piChildIdentity.pid === metadata.identity.pid ? actual : await inspect(metadata.piChildIdentity.pid);
      } catch (error) {
        conflicts.push({ sessionId: record.sessionId, reason: exited(error) ? "PI_CHILD_EXITED" : "PI_CHILD_IDENTITY_AMBIGUOUS", ownership: record.ownership, metadata });
        continue;
      }
      if (!sameIdentity(piChild, metadata.piChildIdentity)) {
        conflicts.push({ sessionId: record.sessionId, reason: "PI_CHILD_IDENTITY_MISMATCH", ownership: record.ownership, metadata, actual: piChild });
        continue;
      }
      liveWorkers.push({ sessionId: record.sessionId, runId: record.ownership.runId, identity: actual, piChildIdentity: piChild, metadata });
    }
    cancelled();
    const reconnected = new Set(await waitForReconnect(liveWorkers, router));
    cancelled();
    for (const worker of liveWorkers) {
      if (!reconnected.has(worker.sessionId) && !router.connectedSessionIds().includes(worker.sessionId)) conflicts.push({ sessionId: worker.sessionId, reason: "WORKER_RECONNECT_TIMEOUT", ownership: worker });
    }
    const commands = await latestJournalRecords(journalPath);
    const recoveryActions = commands.map((record) => ({
      clientId: record.status.clientId,
      requestId: record.status.requestId,
      sessionId: record.command?.payload?.sessionId,
      command: record.command,
      action: record.status.stage === "ACCEPTED" ? "SAFE_REDELIVERY" : record.status.stage === "DELIVERY_UNKNOWN" ? "DELIVERY_AMBIGUOUS" : "NO_REDELIVERY",
    }));
    await atomicWriteJson(join(root, "daemon", "reconciliation.json"), { schemaVersion: 1, daemonEpoch, completedAt: new Date().toISOString(), conflicts, recoveryActions });
    return {
      registry,
      journal,
      events,
      router,
      liveWorkers,
      conflicts,
      recoveryActions,
      viewer,
      async close() {
        const results = await Promise.allSettled([router.close(), journal.close(), events.close(), viewer.close()]);
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length > 0) throw new AggregateError(errors, "Reconciliation stores closed with errors");
      },
    };
  } catch (error) {
    await Promise.allSettled([journal?.close(), events?.close(), viewer?.close()]);
    if (suppliedRouter === undefined) await router.close().catch(() => {});
    throw error;
  }
}
