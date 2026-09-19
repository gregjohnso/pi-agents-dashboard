/**
 * One direction of the frontend's byte relay: terminal to socket, or socket to terminal.
 *
 * A `write()` that returns `false` has already accepted the chunk it was given; it is saying the destination's
 * queue is full, not that the bytes were lost. So this relay never re-sends an accepted chunk. It holds the
 * chunks it has not written yet, pauses the source once, and resumes it from one drain listener.
 */

/**
 * @param {{ source: { pause(): void, resume(): void }, destination: { write(chunk: Buffer): boolean, on(event: "drain", listener: () => void): unknown }, canResumeSource: () => boolean }} wiring
 */
export function createPausingRelay({ source, destination, canResumeSource }) {
  /** @type {Buffer[]} */
  const queued = [];
  let sourcePaused = false;

  // One chunk at a time, stopping at the first `false`: the chunks behind it stay queued in arrival order.
  const flush = () => {
    while (queued.length > 0) {
      if (!destination.write(/** @type {Buffer} */ (queued.shift()))) return false;
    }
    return true;
  };

  destination.on("drain", () => {
    if (!flush()) return;
    if (sourcePaused && canResumeSource()) {
      sourcePaused = false;
      source.resume();
    }
  });

  return {
    queuedCount: () => queued.length,
    sourcePaused: () => sourcePaused,

    /** @param {Buffer[]} chunks */
    send(...chunks) {
      queued.push(...chunks);
      if (!flush() && !sourcePaused) {
        sourcePaused = true;
        source.pause();
      }
    },
  };
}
