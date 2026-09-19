/**
 * One direction of the frontend's byte relay: terminal to socket, or socket to terminal.
 *
 * A `write()` that returns `false` has already accepted the chunk it was given; it is saying the destination's
 * queue is full, not that the bytes were lost. So this relay never re-sends an accepted chunk — and it writes
 * nothing more until the destination drains. A later `send()` only joins the queue: the next frame decoded from
 * the same socket read, and the next keystroke, are held rather than pushed into a queue the destination just
 * said was full. Order is arrival order, in both directions, and the source is paused once and resumed from one
 * drain listener.
 *
 * `dispose()` is the only end. It detaches that listener, names the bytes it is dropping so the caller can tell
 * the operator, and refuses every later `send()` — so nothing this relay was holding can reach a restored
 * terminal or a socket that is closing.
 */

/** A `send()` after the attachment ended. Loud on purpose: the alternative is bytes written after teardown. */
export class DemoRelayDisposedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "DemoRelayDisposedError";
    this.code = "DEMO_RELAY_DISPOSED";
  }
}

/**
 * @param {{ source: { pause(): void, resume(): void }, destination: { write(chunk: Buffer): boolean, on(event: "drain", listener: () => void): unknown, off(event: "drain", listener: () => void): unknown }, canResumeSource: () => boolean }} wiring
 */
export function createPausingRelay({ source, destination, canResumeSource }) {
  /** @type {Buffer[]} */
  const queued = [];
  let sourcePaused = false;
  /** The destination refused its last write. Nothing more may be written before `drain` says it has room. */
  let blocked = false;
  /** @type {null | { reason: string, discardedChunks: number, discardedBytes: number }} */
  let disposal = null;

  const bytesIn = (chunks) => chunks.reduce((total, chunk) => total + chunk.byteLength, 0);

  // One chunk at a time, stopping at the first `false`: the chunks behind it stay queued in arrival order.
  const flush = () => {
    while (queued.length > 0) {
      if (!destination.write(/** @type {Buffer} */ (queued.shift()))) {
        blocked = true;
        return false;
      }
    }
    return true;
  };

  const onDrain = () => {
    blocked = false;
    if (!flush()) return;
    if (sourcePaused && canResumeSource()) {
      sourcePaused = false;
      source.resume();
    }
  };
  destination.on("drain", onDrain);

  return {
    queuedCount: () => queued.length,
    queuedBytes: () => bytesIn(queued),
    sourcePaused: () => sourcePaused,
    blocked: () => blocked,
    disposal: () => disposal,

    /** @param {Buffer[]} chunks */
    send(...chunks) {
      if (disposal !== null) {
        throw new DemoRelayDisposedError(
          `this relay was disposed (${disposal.reason}), so ${chunks.length} chunk(s) of ${bytesIn(chunks)} bytes were refused rather than written`,
        );
      }
      queued.push(...chunks);
      if (blocked) return;
      if (!flush() && !sourcePaused) {
        sourcePaused = true;
        source.pause();
      }
    },

    /**
     * End this direction: no drain listener, no later write, and a count of what was dropped.
     *
     * The source is left paused. Neither end of the stream is closed here — the caller owns the socket, and the
     * terminal on the other end of the output direction is the operator's own.
     *
     * @param {string} reason
     */
    dispose(reason) {
      if (disposal !== null) return disposal;
      destination.off("drain", onDrain);
      const dropped = queued.splice(0);
      disposal = { reason, discardedChunks: dropped.length, discardedBytes: bytesIn(dropped) };
      return disposal;
    },
  };
}
