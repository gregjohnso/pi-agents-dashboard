/**
 * The bytes a client sent before Pi's labelled ingress was ready to take them.
 *
 * This is the manager's only holding place for input, so its bound is the manager's protection: a client that
 * keeps typing — or a client that keeps reconnecting — must not be able to grow this queue. Held bytes are
 * delivered in order and exactly once, and a span that would cross the bound is refused rather than admitted.
 */

/** @typedef {{ attachmentId: string, epoch: number, generation: number, bytes: Buffer }} PendingEntry */

/** @param {number} limitBytes */
export function createPendingInputQueue(limitBytes) {
  /** @type {PendingEntry[]} */
  const entries = [];
  let heldBytes = 0;

  return {
    heldBytes: () => heldBytes,
    length: () => entries.length,

    /**
     * @param {PendingEntry} entry
     * @returns {{ outcome: "held" | "empty" | "refused", reason?: string }}
     */
    admit(entry) {
      // An empty span carries no keystroke, so holding one would only let a peer buy queue entries for free.
      if (entry.bytes.byteLength === 0) return { outcome: "empty" };
      const prospectiveBytes = heldBytes + entry.bytes.byteLength;
      if (prospectiveBytes > limitBytes) {
        // Refused before it is held: an admitted span is delivered, so the bound has to be decided first.
        return {
          outcome: "refused",
          reason: `${entry.bytes.byteLength} more held bytes would take the ${heldBytes} already held past the ${limitBytes} byte bound`,
        };
      }
      entries.push(entry);
      heldBytes = prospectiveBytes;
      return { outcome: "held" };
    },

    /** Every held entry, in arrival order, removed from the queue as it is handed over. */
    drain() {
      const taken = entries.splice(0);
      heldBytes = 0;
      return taken;
    },
  };
}
