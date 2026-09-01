import { parseViewerEvent } from "../shared/viewer-contracts.mjs";

/** A normalized viewer stream failure with a stable code. */
export class ViewerStreamError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "ViewerStreamError";
    this.code = code;
  }
}

/**
 * One session's live normalized viewer stream, held in daemon memory only.
 *
 * There is no durable copy: Pi's canonical session file is the transcript, and the frames Pi has not
 * written there yet live in the worker's bounded tail. The sequence in a cursor therefore says how far
 * this daemon's stream has advanced, and nothing replays from it. It resets to zero with the daemon.
 *
 * @param {{ sessionId: string, daemonEpoch: string, subscriberLimit?: number }} options
 */
export function createViewerStream({ sessionId, daemonEpoch, subscriberLimit = 100 }) {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId is required");
  if (typeof daemonEpoch !== "string" || daemonEpoch.length === 0) throw new TypeError("daemonEpoch is required");
  if (!Number.isSafeInteger(subscriberLimit) || subscriberLimit < 1) throw new TypeError("subscriberLimit must be a positive safe integer");
  /** @type {Set<any>} */
  const subscribers = new Set();
  let sequence = 0n;
  let closed = false;

  /** @param {any} subscriber @param {ViewerStreamError} error */
  function endSubscriber(subscriber, error) {
    if (subscriber.ended) return;
    subscriber.ended = true;
    subscriber.error = error;
    subscribers.delete(subscriber);
    const waiter = subscriber.waiter;
    subscriber.waiter = undefined;
    // A reader waiting on `next` learns the code now. Resolving it as a clean end would report an
    // empty stream where this one stopped for a reason the frontend has to act on.
    waiter?.reject(error);
  }

  return {
    /**
     * Publish one normalized event to every live subscriber. The draft comes from the normalizer, so
     * an invalid one is a normalizer defect rather than untrusted input, and it is refused here
     * before any subscriber can be told a shape the viewer contract does not admit.
     * @param {{ eventId: string, timestamp: string, payload: Record<string, unknown> }} draft
     */
    append(draft) {
      if (closed) throw new ViewerStreamError("VIEWER_STREAM_CLOSED", "Viewer stream is closed");
      sequence += 1n;
      const event = { version: 1, sessionId, eventId: draft.eventId, cursor: { daemonEpoch, sessionId, sequence: String(sequence) }, timestamp: draft.timestamp, payload: draft.payload };
      try { parseViewerEvent(event); } catch (cause) { throw new ViewerStreamError("INVALID_VIEWER_EVENT", "Normalized viewer event is invalid", { cause }); }
      for (const subscriber of [...subscribers]) subscriber.push(event);
      return event;
    },
    /**
     * Read every event published after this call. A subscriber that stops reading is dropped once its
     * queue passes the bound, with a code its reader receives: the frontend answers that by rebuilding
     * from a fresh snapshot, which is the only recovery available now that nothing replays.
     */
    subscribe() {
      /** @type {any} */
      const subscriber = {
        queue: /** @type {any[]} */ ([]),
        ended: closed,
        /** @type {any} */
        waiter: undefined,
        /** @type {ViewerStreamError | undefined} */
        error: undefined,
        push(/** @type {any} */ event) {
          if (subscriber.ended) return;
          if (subscriber.waiter !== undefined) {
            const waiter = subscriber.waiter;
            subscriber.waiter = undefined;
            waiter.resolve({ value: event, done: false });
            return;
          }
          if (subscriber.queue.length >= subscriberLimit) {
            endSubscriber(subscriber, new ViewerStreamError("SUBSCRIBER_OVERFLOW", "Viewer subscriber exceeded its bounded queue"));
            return;
          }
          subscriber.queue.push(event);
        },
      };
      if (!closed) subscribers.add(subscriber);
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          const event = subscriber.queue.shift();
          if (event !== undefined) return { value: event, done: false };
          if (subscriber.error !== undefined) throw subscriber.error;
          if (subscriber.ended) return { value: undefined, done: true };
          return new Promise((resolve, reject) => { subscriber.waiter = { resolve, reject }; });
        },
        async return() {
          subscriber.ended = true;
          subscribers.delete(subscriber);
          subscriber.waiter?.resolve({ value: undefined, done: true });
          subscriber.waiter = undefined;
          return { value: undefined, done: true };
        },
      };
    },
    currentCursor() { return { daemonEpoch, sessionId, sequence: String(sequence) }; },
    /**
     * This session's normalized state was rebuilt, so every live subscriber is holding a transcript
     * this stream no longer describes. Each is ended with `code`, and the frontend answers with one
     * rebuild from a fresh snapshot rather than freezing on what it already had.
     * @param {string} code @param {string} message
     */
    resynchronize(code, message) {
      for (const subscriber of [...subscribers]) endSubscriber(subscriber, new ViewerStreamError(code, message));
    },
    close() {
      if (closed) return;
      closed = true;
      for (const subscriber of [...subscribers]) {
        subscriber.ended = true;
        const waiter = subscriber.waiter;
        subscriber.waiter = undefined;
        waiter?.resolve({ value: undefined, done: true });
      }
      subscribers.clear();
    },
  };
}
