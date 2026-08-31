import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseViewerEvent, parseViewerSnapshot } from "../shared/viewer-contracts.mjs";
import { openDurableAppendStore, AppendStoreError } from "./append-store.mjs";
import { atomicWriteJson } from "./atomic-file.mjs";
import { ensurePrivateDirectory } from "./permissions.mjs";

const MAX_RECORD_BYTES = 1024 * 1024;

/** A durable normalized viewer stream failure with a stable code. */
export class ViewerStoreError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "ViewerStoreError";
    this.code = code;
  }
}

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const item = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Parse the canonical unsigned sequence representation a durable viewer cursor uses. @param {unknown} value */
function sequence(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value)) throw new ViewerStoreError("INVALID_VIEWER_CURSOR", "Viewer cursor sequence must be a canonical unsigned integer string");
  return BigInt(value);
}

/** @param {string} directory @param {string} sessionId */
function paths(directory, sessionId) {
  const stem = createHash("sha256").update(sessionId).digest("hex");
  return { events: join(directory, `${stem}.events.jsonl`), checkpoints: join(directory, `${stem}.checkpoints.jsonl`), snapshot: join(directory, `${stem}.snapshot.json`), acks: join(directory, `${stem}.acks.json`) };
}

/** @param {unknown} value */
function internalCheckpoint(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => key !== "activeAssistant") || !Object.hasOwn(value, "activeAssistant")) throw new TypeError("invalid viewer recovery checkpoint");
  const active = /** @type {any} */ (value).activeAssistant;
  if (active !== null) {
    if (typeof active !== "object" || active === null || Array.isArray(active) || Object.keys(active).some((key) => !["itemId", "blocks"].includes(key)) || typeof active.itemId !== "string" || active.itemId.length === 0 || active.itemId.length > 256 || !Array.isArray(active.blocks)) throw new TypeError("invalid active assistant checkpoint");
    const indexes = new Set();
    for (const block of active.blocks) {
      if (typeof block !== "object" || block === null || Array.isArray(block) || Object.keys(block).some((key) => !["contentIndex", "type", "text"].includes(key)) || !Number.isSafeInteger(block.contentIndex) || block.contentIndex < 0 || indexes.has(block.contentIndex) || !["text", "thinking"].includes(block.type) || typeof block.text !== "string" || Buffer.byteLength(block.text) > 65_536) throw new TypeError("invalid active assistant block checkpoint");
      indexes.add(block.contentIndex);
    }
  }
  return structuredClone(value);
}

/** @param {any} checkpoint @param {any} payload */
function applyLegacyCheckpoint(checkpoint, payload) {
  let active = structuredClone(checkpoint?.activeAssistant ?? null);
  if (payload?.kind === "assistant_delta") {
    if (active?.itemId !== payload.itemId) active = { itemId: payload.itemId, blocks: [] };
    const contentIndex = Number.isSafeInteger(payload.contentIndex) && payload.contentIndex >= 0 ? payload.contentIndex : 0;
    const type = ["text", "thinking"].includes(payload.contentType) ? payload.contentType : "text";
    const prior = active.blocks.find((/** @type {any} */ block) => block.contentIndex === contentIndex);
    if (prior === undefined) active.blocks.push({ contentIndex, type, text: payload.delta });
    else { prior.type = type; prior.text += payload.delta; }
    active.blocks.sort((/** @type {any} */ left, /** @type {any} */ right) => left.contentIndex - right.contentIndex);
  } else if (payload?.kind === "assistant_message" && active?.itemId === payload.itemId) active = null;
  return { activeAssistant: active };
}

/**
 * Open one append-only normalized viewer stream and its crash-safe snapshot/ACK state.
 *
 * @param {{ directory: string, sessionId: string, daemonEpoch: string, protocolVersion?: number, subscriberLimit?: number, failpoint?: (phase: string, value?: unknown) => void | Promise<void> }} options
 */
export async function createViewerStore({ directory, sessionId, daemonEpoch, protocolVersion = 1, subscriberLimit = 100, failpoint = () => {} }) {
  if (typeof directory !== "string" || directory.length === 0) throw new TypeError("directory is required");
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId is required");
  if (typeof daemonEpoch !== "string" || daemonEpoch.length === 0) throw new TypeError("daemonEpoch is required");
  if (protocolVersion !== 1) throw new TypeError("Viewer protocol version must be 1");
  if (!Number.isSafeInteger(subscriberLimit) || subscriberLimit < 1) throw new TypeError("subscriberLimit must be a positive safe integer");
  await ensurePrivateDirectory(directory);
  const location = paths(directory, sessionId);
  const durable = await openDurableAppendStore({ path: location.events, maxRecordBytes: MAX_RECORD_BYTES });
  /** @type {Awaited<ReturnType<typeof openDurableAppendStore>>} */
  let checkpointDurable;
  try { checkpointDurable = await openDurableAppendStore({ path: location.checkpoints, maxRecordBytes: MAX_RECORD_BYTES }); }
  catch (error) { await durable.close(); throw error; }
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const recoveryPayloads = [];
  /** @type {Map<string, string>} */
  const byId = new Map();
  try {
    await durable.recoverRecords((value) => {
      const raw = /** @type {any} */ (value);
      const payload = raw?.payload;
      const publicValue = payload?.kind === "assistant_delta" && (Object.hasOwn(payload, "contentIndex") || Object.hasOwn(payload, "contentType"))
        ? { ...raw, payload: Object.fromEntries(Object.entries(payload).filter(([key]) => !["contentIndex", "contentType"].includes(key))) }
        : raw;
      let event;
      try { event = parseViewerEvent(publicValue); } catch (cause) { throw new ViewerStoreError("VIEWER_STORE_CORRUPT", "Persisted viewer event shape is invalid", { cause }); }
      if (event.sessionId !== sessionId || event.cursor.sessionId !== sessionId || event.cursor.daemonEpoch !== daemonEpoch || event.cursor.sequence !== String(events.length + 1)) throw new ViewerStoreError("VIEWER_STORE_CORRUPT", "Persisted viewer cursor identity or sequence is invalid");
      const serialized = canonical(event);
      if (byId.has(event.eventId)) throw new ViewerStoreError("VIEWER_STORE_CORRUPT", "Persisted viewer event IDs are not unique");
      events.push(event);
      recoveryPayloads.push(payload);
      byId.set(event.eventId, serialized);
    });
  } catch (cause) {
    await Promise.allSettled([durable.close(), checkpointDurable.close()]);
    if (cause instanceof ViewerStoreError) throw cause;
    throw new ViewerStoreError("VIEWER_STORE_CORRUPT", "Viewer event store recovery failed", { cause });
  }

  /** @type {Map<string, any>} */
  const checkpoints = new Map();
  try {
    await checkpointDurable.recoverRecords((value) => {
      const record = /** @type {any} */ (value);
      if (typeof record !== "object" || record === null || Array.isArray(record) || Object.keys(record).some((key) => !["version", "sessionId", "sequence", "checkpoint"].includes(key)) || record.version !== 1 || record.sessionId !== sessionId || !/^(0|[1-9]\d*)$/u.test(record.sequence)) throw new TypeError("invalid viewer recovery checkpoint record");
      checkpoints.set(record.sequence, internalCheckpoint(record.checkpoint));
    });
  } catch (cause) {
    await Promise.allSettled([durable.close(), checkpointDurable.close()]);
    throw new ViewerStoreError("VIEWER_STORE_CORRUPT", "Viewer recovery checkpoint store is invalid", { cause });
  }

  /** @type {any} */
  let publishedSnapshot;
  /** @type {any} */
  let legacySnapshotCheckpoint;
  try {
    const storedSnapshot = JSON.parse(await readFile(location.snapshot, "utf8"));
    if (Object.hasOwn(storedSnapshot, "activeAssistant")) {
      legacySnapshotCheckpoint = internalCheckpoint({ activeAssistant: storedSnapshot.activeAssistant });
      delete storedSnapshot.activeAssistant;
    }
    publishedSnapshot = parseViewerSnapshot(storedSnapshot);
    if (publishedSnapshot.sessionId !== sessionId || publishedSnapshot.cursor.daemonEpoch !== daemonEpoch || publishedSnapshot.cursor.sessionId !== sessionId || sequence(publishedSnapshot.cursor.sequence) > BigInt(events.length)) throw new ViewerStoreError("VIEWER_STORE_CORRUPT", "Persisted viewer snapshot cursor is invalid");
  } catch (error) {
    if (error instanceof ViewerStoreError) { await Promise.allSettled([durable.close(), checkpointDurable.close()]); throw error; }
    if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") { await Promise.allSettled([durable.close(), checkpointDurable.close()]); throw new ViewerStoreError("VIEWER_STORE_CORRUPT", "Persisted viewer snapshot is invalid", { cause: error }); }
  }

  const snapshotSequence = publishedSnapshot === undefined ? 0 : Number(sequence(publishedSnapshot.cursor.sequence));
  let checkpointSequence = legacySnapshotCheckpoint === undefined ? 0 : snapshotSequence;
  let recoveredCheckpoint = legacySnapshotCheckpoint;
  for (const [storedSequence, storedCheckpoint] of checkpoints) {
    const candidateSequence = Number(sequence(storedSequence));
    if (candidateSequence <= events.length && candidateSequence >= checkpointSequence) { checkpointSequence = candidateSequence; recoveredCheckpoint = storedCheckpoint; }
  }
  for (let index = checkpointSequence; index < recoveryPayloads.length; index += 1) recoveredCheckpoint = applyLegacyCheckpoint(recoveredCheckpoint, recoveryPayloads[index]);

  /** @type {Record<string, { daemonEpoch: string, sessionId: string, sequence: string }>} */
  let acknowledgements = {};
  try {
    const parsed = JSON.parse(await readFile(location.acks, "utf8"));
    if (parsed?.version !== 1 || parsed.sessionId !== sessionId || parsed.daemonEpoch !== daemonEpoch || typeof parsed.clients !== "object" || parsed.clients === null || Array.isArray(parsed.clients) || Object.keys(parsed).some((key) => !["version", "sessionId", "daemonEpoch", "clients"].includes(key))) throw new TypeError("invalid ACK store");
    for (const [clientId, cursor] of Object.entries(parsed.clients)) {
      if (clientId.length === 0) throw new TypeError("invalid ACK client");
      validateCursor(cursor);
    }
    acknowledgements = parsed.clients;
  } catch (error) {
    if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") { await Promise.allSettled([durable.close(), checkpointDurable.close()]); throw new ViewerStoreError("VIEWER_STORE_CORRUPT", "Persisted viewer acknowledgements are invalid", { cause: error }); }
  }

  /** @type {Set<any>} */
  const subscribers = new Set();
  let tail = Promise.resolve();
  let closed = false;

  /** @param {any} cursor */
  function validateCursor(cursor) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) throw new ViewerStoreError("INVALID_VIEWER_CURSOR", "Viewer cursor must be an object");
    if (cursor.daemonEpoch !== daemonEpoch) throw new ViewerStoreError("DAEMON_EPOCH_MISMATCH", "Viewer cursor belongs to a different daemon epoch");
    if (cursor.sessionId !== sessionId) throw new ViewerStoreError("VIEWER_SESSION_MISMATCH", "Viewer cursor belongs to a different session");
    const value = sequence(cursor.sequence);
    if (value > BigInt(events.length)) throw new ViewerStoreError("INVALID_VIEWER_CURSOR", "Viewer cursor is ahead of the durable stream");
    return value;
  }

  /** @template T @param {() => Promise<T>} action */
  function serialize(action) {
    const result = tail.then(action);
    tail = result.then(() => {}, () => {});
    return result;
  }

  /** @param {string} checkpointSequence @param {any} checkpoint */
  async function persistCheckpoint(checkpointSequence, checkpoint) {
    const parsed = internalCheckpoint(checkpoint);
    if (canonical(checkpoints.get(checkpointSequence)) === canonical(parsed)) return parsed;
    try {
      await checkpointDurable.write({ version: 1, sessionId, sequence: checkpointSequence, checkpoint: parsed });
      await checkpointDurable.sync();
    } catch (cause) {
      if (cause instanceof AppendStoreError && cause.code === "RECORD_TOO_LARGE") throw new ViewerStoreError("RECORD_TOO_LARGE", "Viewer recovery checkpoint exceeds the durable record limit", { cause });
      throw cause;
    }
    checkpoints.set(checkpointSequence, parsed);
    return parsed;
  }

  const api = {
    /** @param {{ eventId: string, timestamp: string, payload: Record<string, unknown>, internalCheckpoint?: any }} draft */
    append(draft) {
      return serialize(async () => {
        if (closed) throw new ViewerStoreError("VIEWER_STORE_CLOSED", "Viewer store is closed");
        const prior = byId.get(draft?.eventId);
        if (prior !== undefined) {
          const existing = events.find((event) => event.eventId === draft.eventId);
          if (existing === undefined) throw new ViewerStoreError("VIEWER_STORE_CORRUPT", "Viewer event ID index is inconsistent");
          const candidate = { version: 1, sessionId, eventId: draft.eventId, cursor: existing.cursor, timestamp: draft.timestamp, payload: draft.payload };
          if (canonical(candidate) !== prior) throw new ViewerStoreError("VIEWER_EVENT_ID_CONFLICT", "Stable viewer event ID was reused with changed content");
          return existing;
        }
        const event = { version: 1, sessionId, eventId: draft.eventId, cursor: { daemonEpoch, sessionId, sequence: String(events.length + 1) }, timestamp: draft.timestamp, payload: draft.payload };
        try { parseViewerEvent(event); } catch (cause) { throw new ViewerStoreError("INVALID_VIEWER_EVENT", "Normalized viewer event is invalid", { cause }); }
        const parsedCheckpoint = draft.internalCheckpoint === undefined ? undefined : await persistCheckpoint(event.cursor.sequence, draft.internalCheckpoint);
        try {
          await durable.write(event);
          await durable.sync();
        } catch (cause) {
          if (cause instanceof AppendStoreError && cause.code === "RECORD_TOO_LARGE") throw new ViewerStoreError("RECORD_TOO_LARGE", "Viewer event exceeds the durable record limit", { cause });
          throw cause;
        }
        events.push(event);
        recoveryPayloads.push(event.payload);
        byId.set(event.eventId, canonical(event));
        if (parsedCheckpoint !== undefined) recoveredCheckpoint = parsedCheckpoint;
        await failpoint("after_persist_before_broadcast", event);
        for (const subscriber of subscribers) subscriber.push(event);
        return event;
      });
    },
    async replay(/** @type {any} */ after = undefined) {
      await tail;
      const offset = after === undefined ? 0n : validateCursor(after);
      return events.slice(Number(offset));
    },
    subscribe(/** @type {any} */ after = undefined) {
      const offset = after === undefined ? 0n : validateCursor(after);
      const initial = events.slice(Number(offset));
      if (initial.length > subscriberLimit) throw new ViewerStoreError("SUBSCRIBER_OVERFLOW", "Initial viewer replay exceeds the subscriber bound");
      /** @type {any} */
      const subscriber = {
        queue: closed ? [] : initial,
        ended: closed,
        waiter: undefined,
        error: undefined,
        push(/** @type {any} */ event) {
          if (subscriber.ended) return;
          if (subscriber.waiter !== undefined) { const waiter = subscriber.waiter; subscriber.waiter = undefined; waiter({ value: event, done: false }); }
          else if (subscriber.queue.length >= subscriberLimit) { subscriber.error = new ViewerStoreError("SUBSCRIBER_OVERFLOW", "Viewer subscriber exceeded its bounded queue"); subscriber.ended = true; subscribers.delete(subscriber); }
          else subscriber.queue.push(event);
        },
      };
      if (!closed) subscribers.add(subscriber);
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (subscriber.error !== undefined) throw subscriber.error;
          const event = subscriber.queue.shift();
          if (event !== undefined) return { value: event, done: false };
          if (subscriber.ended) return { value: undefined, done: true };
          return new Promise((resolve) => { subscriber.waiter = resolve; });
        },
        async return() { subscriber.ended = true; subscribers.delete(subscriber); subscriber.waiter?.({ value: undefined, done: true }); subscriber.waiter = undefined; return { value: undefined, done: true }; },
      };
    },
    currentCursor() { return { daemonEpoch, sessionId, sequence: String(events.length) }; },
    publishSnapshot(/** @type {any} */ snapshot, /** @type {any} */ checkpoint = undefined) {
      return serialize(async () => {
        const parsed = parseViewerSnapshot(snapshot);
        if (parsed.sessionId !== sessionId) throw new ViewerStoreError("VIEWER_SESSION_MISMATCH", "Viewer snapshot belongs to another session");
        validateCursor(parsed.cursor);
        if (checkpoint !== undefined) recoveredCheckpoint = await persistCheckpoint(parsed.cursor.sequence, checkpoint);
        await failpoint("before_snapshot_publish", parsed);
        await atomicWriteJson(location.snapshot, parsed);
        publishedSnapshot = parsed;
        return parsed;
      });
    },
    async getSnapshot() { await tail; return publishedSnapshot; },
    async getCheckpoint() { await tail; return structuredClone(recoveredCheckpoint); },
    acknowledge(/** @type {string} */ clientId, /** @type {any} */ cursor) {
      return serialize(async () => {
        if (typeof clientId !== "string" || clientId.length === 0) throw new TypeError("clientId is required");
        const next = validateCursor(cursor);
        const prior = acknowledgements[clientId];
        if (prior !== undefined && sequence(prior.sequence) >= next) return prior;
        const accepted = { daemonEpoch, sessionId, sequence: String(next) };
        acknowledgements = { ...acknowledgements, [clientId]: accepted };
        await atomicWriteJson(location.acks, { version: 1, sessionId, daemonEpoch, clients: acknowledgements });
        return accepted;
      });
    },
    acknowledged(/** @type {string} */ clientId) { return acknowledgements[clientId]; },
    async close() {
      await tail;
      if (closed) return;
      closed = true;
      for (const subscriber of subscribers) { subscriber.ended = true; subscriber.waiter?.({ value: undefined, done: true }); subscriber.waiter = undefined; }
      subscribers.clear();
      await Promise.all([durable.close(), checkpointDurable.close()]);
    },
  };
  return api;
}
