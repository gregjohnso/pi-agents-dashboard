// @ts-nocheck
import { open } from "node:fs/promises";

const MAX_RECORD_BYTES = 1024 * 1024;
export class EventStoreError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "EventStoreError"; this.code = code; }
}
function sequenceOf(cursor) {
  if (!cursor || typeof cursor.sequence !== "string" || !/^(0|[1-9]\d*)$/.test(cursor.sequence)) throw new EventStoreError("INVALID_CURSOR", "Cursor sequence must be a canonical unsigned integer string");
  return BigInt(cursor.sequence);
}

/** Create an append-only persisted event stream with bounded live subscribers. */
export async function createEventStore({ path, daemonEpoch, now = () => new Date().toISOString(), subscriberLimit = 100, failpoint = () => {} }) {
  if (typeof daemonEpoch !== "string" || !daemonEpoch) throw new TypeError("daemonEpoch is required");
  if (!Number.isSafeInteger(subscriberLimit) || subscriberLimit < 1) throw new TypeError("subscriberLimit must be a positive safe integer");
  const handle = await open(path, "a+", 0o600); await handle.chmod(0o600);
  const text = await handle.readFile("utf8"); const events = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new EventStoreError("EVENT_STORE_CORRUPT", "Event record exceeds limit");
    let event; try { event = JSON.parse(line); } catch { throw new EventStoreError("EVENT_STORE_CORRUPT", "Event store contains malformed JSON"); }
    if (event.cursor?.daemonEpoch !== daemonEpoch || event.cursor.sequence !== String(events.length + 1)) throw new EventStoreError("EVENT_STORE_CORRUPT", "Event cursor sequence or daemon epoch is invalid");
    events.push(event);
  }
  const subscribers = new Set(); let tail = Promise.resolve(); let closed = false;
  function validateCursor(cursor) {
    if (cursor === undefined) return 0n;
    if (cursor.daemonEpoch !== daemonEpoch) throw new EventStoreError("DAEMON_EPOCH_MISMATCH", "Cursor belongs to a different daemon epoch");
    const sequence = sequenceOf(cursor);
    if (sequence > BigInt(events.length)) throw new EventStoreError("INVALID_CURSOR", "Cursor is ahead of the event store");
    return sequence;
  }
  function serialize(action) { const result = tail.then(action); tail = result.catch(() => {}); return result; }
  return {
    append(input) { return serialize(async () => {
      if (closed) throw new EventStoreError("EVENT_STORE_CLOSED", "Event store is closed");
      if (!input || typeof input.kind !== "string" || typeof input.payload !== "object" || input.payload === null) throw new TypeError("Event requires kind and payload");
      const event = { version: 1, cursor: { daemonEpoch, sequence: String(events.length + 1) }, occurredAt: now(), kind: input.kind, payload: input.payload };
      const line = `${JSON.stringify(event)}\n`; if (Buffer.byteLength(line) - 1 > MAX_RECORD_BYTES) throw new EventStoreError("RECORD_TOO_LARGE", "Event record exceeds limit");
      await handle.write(line, null, "utf8"); await handle.sync(); events.push(event);
      await failpoint("after_persist_before_broadcast", event);
      for (const subscriber of subscribers) subscriber.push(event);
      return event;
    }); },
    async replay(after) { await tail; const sequence = validateCursor(after); return events.slice(Number(sequence)); },
    subscribe(after) {
      const initialSequence = validateCursor(after); const queue = events.slice(Number(initialSequence)); let waiter; let error; let ended = false;
      const subscriber = {
        push(event) {
          if (ended) return;
          if (waiter) { const resolve = waiter; waiter = undefined; resolve({ value: event, done: false }); return; }
          if (queue.length >= subscriberLimit) { error = new EventStoreError("SUBSCRIBER_OVERFLOW", "Subscriber exceeded its bounded event queue"); ended = true; subscribers.delete(subscriber); if (waiter) { const resolve = waiter; waiter = undefined; resolve(Promise.reject(error)); } return; }
          queue.push(event);
        },
      };
      subscribers.add(subscriber);
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (error) throw error;
          if (queue.length) return { value: queue.shift(), done: false };
          if (ended) return { value: undefined, done: true };
          return new Promise((resolve) => { waiter = resolve; });
        },
        async return() { ended = true; subscribers.delete(subscriber); if (waiter) { waiter({ value: undefined, done: true }); waiter = undefined; } return { value: undefined, done: true }; },
      };
    },
    currentCursor() { return { daemonEpoch, sequence: String(events.length) }; },
    async close() { await tail; closed = true; for (const subscriber of subscribers) { subscriber.push = () => {}; } subscribers.clear(); await handle.close(); },
  };
}
