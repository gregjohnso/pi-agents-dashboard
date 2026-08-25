import { openDurableAppendStore, AppendStoreError } from "./append-store.mjs";

const MAX_RECORD_BYTES = 1024 * 1024;

/** @typedef {import("../shared/contracts.js").EventCursor} EventCursor */
/** @typedef {import("../shared/contracts.js").PersistedEvent} PersistedEvent */
/** @typedef {(name: "after_persist_before_broadcast", event: PersistedEvent) => void | Promise<void>} EventFailpoint */
/** @typedef {(result: IteratorResult<PersistedEvent>) => void} EventWaiter */
/** @typedef {{ queue: PersistedEvent[], waiter?: EventWaiter, error?: Error, ended: boolean, push(event: PersistedEvent): void }} Subscriber */

/** A persisted event stream failure with a stable code. */
export class EventStoreError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "EventStoreError";
    this.code = code;
  }
}

/** @param {EventCursor} cursor @returns {bigint} */
function sequenceOf(cursor) {
  if (typeof cursor.sequence !== "string" || !/^(0|[1-9]\d*)$/.test(cursor.sequence)) throw new EventStoreError("INVALID_CURSOR", "Cursor sequence must be a canonical unsigned integer string");
  return BigInt(cursor.sequence);
}

/** @param {unknown} value @returns {value is PersistedEvent} */
function isPersistedEvent(value) {
  if (typeof value !== "object" || value === null) return false;
  const event = /** @type {Partial<PersistedEvent>} */ (value);
  return event.version === 1 && typeof event.cursor === "object" && event.cursor !== null
    && typeof event.cursor.daemonEpoch === "string" && typeof event.cursor.sequence === "string"
    && typeof event.occurredAt === "string" && typeof event.kind === "string"
    && typeof event.payload === "object" && event.payload !== null;
}

/**
 * Create an append-only persisted event stream with bounded replay and live subscribers.
 *
 * @param {{ path: string, daemonEpoch: string, now?: () => string, subscriberLimit?: number, failpoint?: EventFailpoint }} options
 */
export async function createEventStore({ path, daemonEpoch, now = () => new Date().toISOString(), subscriberLimit = 100, failpoint = () => {} }) {
  if (typeof daemonEpoch !== "string" || daemonEpoch.length === 0) throw new TypeError("daemonEpoch is required");
  if (!Number.isSafeInteger(subscriberLimit) || subscriberLimit < 1) throw new TypeError("subscriberLimit must be a positive safe integer");
  const store = await openDurableAppendStore({ path, maxRecordBytes: MAX_RECORD_BYTES });
  /** @type {PersistedEvent[]} */
  const events = [];
  try {
    await store.recoverRecords((value) => {
      if (!isPersistedEvent(value) || value.cursor.daemonEpoch !== daemonEpoch || value.cursor.sequence !== String(events.length + 1)) {
        throw new EventStoreError("EVENT_STORE_CORRUPT", "Event cursor sequence, daemon epoch, or record shape is invalid");
      }
      events.push(value);
    });
  } catch (cause) {
    await store.close();
    if (cause instanceof EventStoreError) throw cause;
    throw new EventStoreError("EVENT_STORE_CORRUPT", cause instanceof Error ? cause.message : "Event store is corrupt", { cause });
  }

  /** @type {Set<Subscriber>} */
  const subscribers = new Set();
  let tail = Promise.resolve();
  let closed = false;

  /** @param {EventCursor | undefined} cursor @returns {bigint} */
  function validateCursor(cursor) {
    if (cursor === undefined) return 0n;
    if (cursor.daemonEpoch !== daemonEpoch) throw new EventStoreError("DAEMON_EPOCH_MISMATCH", "Cursor belongs to a different daemon epoch");
    const sequence = sequenceOf(cursor);
    if (sequence > BigInt(events.length)) throw new EventStoreError("INVALID_CURSOR", "Cursor is ahead of the event store");
    return sequence;
  }

  /** @template T @param {() => Promise<T>} action @returns {Promise<T>} */
  function serialize(action) {
    const result = tail.then(action);
    tail = result.then(() => {}, () => {});
    return result;
  }

  return {
    /** @param {{ kind: string, payload: Record<string, unknown> }} input @returns {Promise<PersistedEvent>} */
    append(input) {
      return serialize(async () => {
        if (closed) throw new EventStoreError("EVENT_STORE_CLOSED", "Event store is closed");
        if (typeof input !== "object" || input === null || typeof input.kind !== "string" || typeof input.payload !== "object" || input.payload === null) throw new TypeError("Event requires kind and payload");
        const event = /** @type {PersistedEvent} */ ({ version: 1, cursor: { daemonEpoch, sequence: String(events.length + 1) }, occurredAt: now(), kind: input.kind, payload: input.payload });
        try {
          await store.write(event);
          await store.sync();
        } catch (cause) {
          if (cause instanceof AppendStoreError && cause.code === "RECORD_TOO_LARGE") throw new EventStoreError("RECORD_TOO_LARGE", "Event record exceeds limit", { cause });
          throw cause;
        }
        events.push(event);
        await failpoint("after_persist_before_broadcast", event);
        for (const subscriber of subscribers) subscriber.push(event);
        return event;
      });
    },
    /** @param {EventCursor} [after] @returns {Promise<PersistedEvent[]>} */
    async replay(after) {
      await tail;
      const sequence = validateCursor(after);
      return events.slice(Number(sequence));
    },
    /** @param {EventCursor} [after] @returns {AsyncIterableIterator<PersistedEvent>} */
    subscribe(after) {
      const initialSequence = validateCursor(after);
      const replayLength = events.length - Number(initialSequence);
      if (replayLength > subscriberLimit) throw new EventStoreError("SUBSCRIBER_OVERFLOW", "Initial event replay exceeds the bounded subscriber queue");
      /** @type {Subscriber} */
      const subscriber = {
        queue: events.slice(Number(initialSequence)),
        ended: false,
        push(event) {
          if (subscriber.ended) return;
          if (subscriber.waiter !== undefined) {
            const waiter = subscriber.waiter;
            subscriber.waiter = undefined;
            waiter({ value: event, done: false });
          } else if (subscriber.queue.length >= subscriberLimit) {
            subscriber.error = new EventStoreError("SUBSCRIBER_OVERFLOW", "Subscriber exceeded its bounded event queue");
            subscriber.ended = true;
            subscribers.delete(subscriber);
          } else {
            subscriber.queue.push(event);
          }
        },
      };
      subscribers.add(subscriber);
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (subscriber.error !== undefined) throw subscriber.error;
          const event = subscriber.queue.shift();
          if (event !== undefined) return { value: event, done: false };
          if (subscriber.ended) return { value: undefined, done: true };
          return new Promise((resolve) => { subscriber.waiter = resolve; });
        },
        async return() {
          subscriber.ended = true;
          subscribers.delete(subscriber);
          subscriber.waiter?.({ value: undefined, done: true });
          subscriber.waiter = undefined;
          return { value: undefined, done: true };
        },
      };
    },
    /** @returns {EventCursor} */
    currentCursor() {
      return { daemonEpoch, sequence: String(events.length) };
    },
    async close() {
      await tail;
      closed = true;
      for (const subscriber of subscribers) {
        subscriber.ended = true;
        subscriber.waiter?.({ value: undefined, done: true });
        subscriber.waiter = undefined;
      }
      subscribers.clear();
      await store.close();
    },
  };
}
