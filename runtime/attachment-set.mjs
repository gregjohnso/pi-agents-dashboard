/**
 * The set of attachments one owner terminal is broadcast to, with epochs, backpressure and presentation
 * acknowledgements. This is the recorded **G-A6** policy, and nothing here evicts a client.
 *
 * Three facts decide its shape:
 *
 * **A `false` return from a sink's `write` is not a rejection.** Node has already accepted and buffered the
 * bytes; `false` only says the queue is past its high-water mark. So the cap is judged from the queue size
 * read **after** the write, and a `false` write whose queue is still within the cap stays `live`. Checking
 * only before the write would leave a sink that jumped from zero to over the cap marked `live`.
 *
 * **Nothing is retained.** No accepted byte is copied, queued or held anywhere in this module — the byte
 * array reaches every sink by reference and this set keeps no container for it. There is deliberately no
 * operation that could resend a byte: recovery from `resync-required` is a repaint by the host, not a replay.
 * A lost connection replays nothing, and a reconnect is a new epoch.
 *
 * **Only the client can prove its screen is current.** `resync-required` clears on one thing: the client
 * echoing the presentation nonce the host recorded for the repaint it sent *after* that attachment fell
 * behind. A nonce recorded before the resync, a nonce already consumed, a superseded nonce, a wrong nonce and
 * a stale epoch all fail to clear it, and there is no local "mark presented" that bypasses this. A drain is
 * not proof either: this set records that the drain arrived and changes no state from it.
 *
 * Membership and input eligibility are kept throughout. A slow or failing attachment stays a member and stays
 * able to send input; a sink failure is reported as a failure on the broadcast result and never authorizes
 * recovery or removes anybody.
 *
 * **Boundary.** This module records and matches the latest host-supplied presentation nonce per attachment.
 * It does not order Pi frame bytes against client acknowledgements on a real transport, parse terminal
 * responses, or know what a frame contains — that is the presentation/ingress work at seams B/C/E.
 *
 * The public surface a consumer binds to:
 *
 * - `createAttachmentSet({ queuedByteCap })` → the set below.
 * - `add(epoch, sink)` → the held `AttachmentEpoch` copy; throws unless the epoch strictly advances the
 *   highest ever admitted for that attachment id, including across removals.
 * - `broadcast(bytes)` → `{ delivered, skipped, markedResyncRequired, failures }`, each attachment named by
 *   its epoch record.
 * - `recordPresentationNonce(epoch, nonce)` → `true` when the nonce was recorded as that attachment's latest
 *   expected acknowledgement, `false` for a superseded or absent epoch.
 * - `acknowledgePresentation(epoch, nonce)` → `true` only when that acknowledgement cleared
 *   `resync-required`.
 * - `remove(epoch)` → `true` when that exact connection was a member; the highest epoch is kept.
 * - `attachments()` → one `AttachmentReport` per member, in admission order.
 * - `highestIssuedEpoch(attachmentId)` → the `AttachmentEpoch` to pass `nextAttachmentEpoch`, or `null`.
 * - `isInputEligible(epoch)` → membership, which under G-A6 is exactly input eligibility.
 */

import { parseAttachmentEpoch } from "../shared/native-contracts.mjs";

/** @typedef {import("../shared/native-contracts.mjs").AttachmentEpoch} AttachmentEpoch */
/** @typedef {{ write: (bytes: Uint8Array) => unknown, queuedBytes: () => number, onDrain: (listener: () => void) => void }} AttachmentSink */
/** @typedef {"live" | "resync-required"} AttachmentState */
/** @typedef {{ attachmentId: string, epoch: number, state: AttachmentState, inputEligible: boolean, drains: number, awaitingPresentationNonce: boolean }} AttachmentReport */
/** @typedef {{ attachment: AttachmentEpoch, reason: "write" | "queue", error: unknown }} BroadcastFailure */
/** @typedef {{ delivered: AttachmentEpoch[], skipped: AttachmentEpoch[], markedResyncRequired: AttachmentEpoch[], failures: BroadcastFailure[] }} BroadcastResult */
/** @typedef {{ epoch: AttachmentEpoch, sink: AttachmentSink, state: AttachmentState, drains: number, presentation: { nonce: string, order: number } | null, resyncOrder: number }} AttachmentEntry */

const MAX_NONCE_LENGTH = 256;

/** A refused input or an unusable sink. Never a warning, and never a way to drop bytes quietly. */
export class AttachmentSetError extends Error {
  /** @param {string} message @param {{ code?: string, cause?: unknown }} [options] */
  constructor(message, { code = "ATTACHMENT_SET", cause } = {}) {
    super(message, { cause });
    this.name = "AttachmentSetError";
    this.code = code;
  }
}

/** @param {unknown} sink @returns {AttachmentSink} */
function requireSink(sink) {
  const candidate = /** @type {Partial<AttachmentSink>} */ (sink);
  if (typeof sink !== "object" || sink === null || typeof candidate.write !== "function" || typeof candidate.queuedBytes !== "function" || typeof candidate.onDrain !== "function") {
    throw new AttachmentSetError("An attachment sink must provide write, queuedBytes and onDrain", { code: "ATTACHMENT_SINK_UNUSABLE" });
  }
  return /** @type {AttachmentSink} */ (sink);
}

/** The host records this nonce, so an unusable one is a host bug rather than an unproven acknowledgement.
 * @param {unknown} nonce @returns {string} */
function requireNonce(nonce) {
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.trim() !== nonce || nonce.length > MAX_NONCE_LENGTH) {
    throw new AttachmentSetError("A presentation nonce must be a bounded non-empty identifier", { code: "ATTACHMENT_NONCE_UNUSABLE" });
  }
  return nonce;
}

/**
 * One attachment set for one owner terminal.
 *
 * `queuedByteCap` is the sink queue size above which an attachment is behind. It is a host policy number, so
 * an unusable one is refused here rather than defaulted into something that silently never trips.
 *
 * @param {{ queuedByteCap: number }} options
 */
export function createAttachmentSet({ queuedByteCap }) {
  if (!Number.isSafeInteger(queuedByteCap) || queuedByteCap <= 0) {
    throw new AttachmentSetError(`A queued byte cap must be a positive safe integer, received ${String(queuedByteCap)}`, { code: "ATTACHMENT_CAP_UNUSABLE" });
  }

  /** Members by attachment id, in admission order. One live connection per id. @type {Map<string, AttachmentEntry>} */
  const members = new Map();
  /**
   * The highest epoch ever admitted per attachment id, kept after a removal.
   *
   * This is what stops a delayed reconnect from taking over the connection that replaced it: the number does
   * not go back down when a member leaves, so an epoch that was already used can never be admitted again.
   * @type {Map<string, number>}
   */
  const highestAdmitted = new Map();
  /**
   * One monotonic counter ordering resync marks against recorded presentations.
   *
   * Without it, a nonce recorded before an attachment fell behind would clear the resync that happened after
   * it — an acknowledgement of a frame that predates the loss is not proof of a current screen.
   */
  let order = 0;

  /** @param {AttachmentEntry} entry */
  function markResyncRequired(entry) {
    if (entry.state === "resync-required") return;
    entry.state = "resync-required";
    order += 1;
    entry.resyncOrder = order;
  }

  /** The member this exact connection is, or `null` when it was replaced, removed or never admitted.
   * @param {unknown} epoch @returns {AttachmentEntry | null} */
  function currentEntry(epoch) {
    const asked = parseAttachmentEpoch(epoch);
    const entry = members.get(asked.attachmentId);
    return entry === undefined || entry.epoch.epoch !== asked.epoch ? null : entry;
  }

  return Object.freeze({
    /**
     * Admit one connection for one attachment id, replacing an older connection for that id.
     *
     * The epoch record is parsed and copied: the caller's object is never the authority, so mutating it after
     * the fact moves nothing. Registering the drain listener before the member exists keeps a failing sink
     * from leaving a half-admitted attachment behind. The superseded connection's transport is the caller's to
     * close; this set only stops writing to it.
     *
     * @param {AttachmentEpoch} epoch @param {AttachmentSink} sink @returns {AttachmentEpoch}
     */
    add(epoch, sink) {
      const admitted = parseAttachmentEpoch(epoch);
      const highest = highestAdmitted.get(admitted.attachmentId);
      if (highest !== undefined && admitted.epoch <= highest) {
        throw new AttachmentSetError(
          `Attachment ${admitted.attachmentId} has already used epoch ${highest}, so epoch ${admitted.epoch} does not advance it`,
          { code: "ATTACHMENT_EPOCH_NOT_ADVANCING" },
        );
      }
      const accepted = requireSink(sink);
      /** @type {AttachmentEntry} */
      const entry = { epoch: Object.freeze({ attachmentId: admitted.attachmentId, epoch: admitted.epoch }), sink: accepted, state: "live", drains: 0, presentation: null, resyncOrder: 0 };
      try {
        // A drain from a connection that has since been replaced must not touch its replacement, and a drain
        // is recorded rather than acted on: it says the queue emptied, not that the client's screen is current.
        accepted.onDrain(() => {
          if (members.get(entry.epoch.attachmentId) !== entry) return;
          entry.drains += 1;
        });
      } catch (cause) {
        throw new AttachmentSetError(`Attachment ${admitted.attachmentId} epoch ${admitted.epoch} could not register a drain listener`, { code: "ATTACHMENT_SINK_UNUSABLE", cause });
      }
      members.set(admitted.attachmentId, entry);
      highestAdmitted.set(admitted.attachmentId, admitted.epoch);
      return entry.epoch;
    },

    /**
     * Hand these bytes to every attachment that is not already `resync-required`.
     *
     * The same array reaches every sink; nothing is copied and nothing is kept. The queue is read after the
     * write, so the first write that carries a sink from zero to over the cap marks it immediately, and there
     * is no retry: the bytes were accepted by the sink, and the repaint is what recovers the screen. A sink
     * that throws, or that cannot report a usable queue size, is marked and reported — an unreadable queue is
     * not evidence of a screen that is keeping up.
     *
     * @param {Uint8Array} bytes @returns {BroadcastResult}
     */
    broadcast(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new AttachmentSetError("A broadcast carries a Uint8Array", { code: "ATTACHMENT_BROADCAST_UNUSABLE" });
      /** @type {BroadcastResult} */
      const result = { delivered: [], skipped: [], markedResyncRequired: [], failures: [] };
      // A snapshot, because a sink may remove or replace attachments from inside its own write.
      for (const entry of [...members.values()]) {
        if (members.get(entry.epoch.attachmentId) !== entry) continue;
        if (entry.state === "resync-required") {
          result.skipped.push(entry.epoch);
          continue;
        }
        try {
          entry.sink.write(bytes);
        } catch (error) {
          markResyncRequired(entry);
          result.markedResyncRequired.push(entry.epoch);
          result.failures.push({ attachment: entry.epoch, reason: "write", error });
          continue;
        }
        let queued;
        try {
          queued = entry.sink.queuedBytes();
        } catch (error) {
          markResyncRequired(entry);
          result.markedResyncRequired.push(entry.epoch);
          result.failures.push({ attachment: entry.epoch, reason: "queue", error });
          continue;
        }
        if (!Number.isSafeInteger(queued) || queued < 0) {
          markResyncRequired(entry);
          result.markedResyncRequired.push(entry.epoch);
          result.failures.push({
            attachment: entry.epoch,
            reason: "queue",
            error: new AttachmentSetError(`Attachment ${entry.epoch.attachmentId} reported queue size ${String(queued)}, which is not a byte count`, { code: "ATTACHMENT_QUEUE_UNREADABLE" }),
          });
          continue;
        }
        result.delivered.push(entry.epoch);
        if (queued > queuedByteCap) {
          markResyncRequired(entry);
          result.markedResyncRequired.push(entry.epoch);
        }
      }
      return result;
    },

    /**
     * Record the nonce the host just sent this attachment in a `presentTerminal` frame.
     *
     * It replaces any earlier expected nonce, so only the latest presentation can be acknowledged. A
     * superseded or absent connection is a lost race rather than an error, and records nothing.
     *
     * @param {AttachmentEpoch} epoch @param {string} nonce @returns {boolean}
     */
    recordPresentationNonce(epoch, nonce) {
      const recorded = requireNonce(nonce);
      const entry = currentEntry(epoch);
      if (entry === null) return false;
      order += 1;
      entry.presentation = { nonce: recorded, order };
      return true;
    },

    /**
     * Take a client's echo of a presentation nonce, and clear `resync-required` only if it proves a repaint.
     *
     * A matching nonce is consumed either way, so it cannot clear a later resync. It clears this one only when
     * the presentation it names was recorded after the attachment fell behind. A wrong, absent or non-string
     * nonce comes from the client, so it is answered `false` rather than thrown.
     *
     * @param {AttachmentEpoch} epoch @param {unknown} nonce @returns {boolean}
     */
    acknowledgePresentation(epoch, nonce) {
      const entry = currentEntry(epoch);
      if (entry === null || entry.presentation === null) return false;
      if (typeof nonce !== "string" || nonce !== entry.presentation.nonce) return false;
      const presented = entry.presentation;
      entry.presentation = null;
      if (entry.state !== "resync-required" || presented.order < entry.resyncOrder) return false;
      entry.state = "live";
      entry.resyncOrder = 0;
      return true;
    },

    /**
     * Drop one exact connection. The attachment id keeps its highest epoch, so a reconnect gets a new one.
     *
     * An epoch that is not the current member's is a stale callback from a connection that was already
     * replaced, and removes nothing.
     *
     * @param {AttachmentEpoch} epoch @returns {boolean}
     */
    remove(epoch) {
      const entry = currentEntry(epoch);
      if (entry === null) return false;
      members.delete(entry.epoch.attachmentId);
      return true;
    },

    /** Every member in admission order. `inputEligible` is always true: nothing here revokes input. @returns {AttachmentReport[]} */
    attachments() {
      return [...members.values()].map((entry) => ({
        attachmentId: entry.epoch.attachmentId,
        epoch: entry.epoch.epoch,
        state: entry.state,
        inputEligible: true,
        drains: entry.drains,
        awaitingPresentationNonce: entry.presentation !== null,
      }));
    },

    /** The highest epoch ever admitted for this id, as the record `nextAttachmentEpoch` takes. @param {string} attachmentId @returns {AttachmentEpoch | null} */
    highestIssuedEpoch(attachmentId) {
      if (typeof attachmentId !== "string" || attachmentId.length === 0) throw new AttachmentSetError("An attachment id must be a non-empty string", { code: "ATTACHMENT_ID_UNUSABLE" });
      const highest = highestAdmitted.get(attachmentId);
      return highest === undefined ? null : Object.freeze({ attachmentId, epoch: highest });
    },

    /** Whether this exact connection may send input. Membership is eligibility; being behind never revokes it.
     * @param {AttachmentEpoch} epoch @returns {boolean} */
    isInputEligible(epoch) {
      return currentEntry(epoch) !== null;
    },
  });
}
