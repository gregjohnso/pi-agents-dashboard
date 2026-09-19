/**
 * The host that holds one owner pseudo-terminal, the attachments broadcast from it, and the phases around it.
 *
 * Pi is the whole product. This module owns the four things Pi cannot own for itself — which client a byte
 * span came from, one shared geometry, when a child has the terminal, and how the owner died — and nothing
 * else. There is no second editor, no second parser, no replayed byte tail and no reconstruction of Pi's
 * state from what it drew.
 *
 * Four facts decide its shape, and two of them are capabilities that do not exist yet.
 *
 * **Labelled ingress needs a supported dispatch target, and there is no launch-time route to one.**
 * `dispatchNativeInput` is a method on Pi's own started `ProcessTerminal`; the seam B/C/F registry publishes
 * no terminal, and seam E's core bootstrap sideband carries readiness and presentation only. The only working
 * route hands the public TUI out through an extension widget factory, which is behind every arbitrary
 * `session_start` handler. So `inputTarget` is injected, and while none is supplied `deliverInput` refuses by
 * name: `MISSING_HOST_CAPABILITIES.labelledIngress`. It is never answered by writing the client's bytes to
 * the master instead — unlabelled input would destroy the provenance seams B, C and G are built on.
 *
 * **A presentation receipt is not a delivery boundary.** Seam E's nonce names a frame handed to
 * `Terminal.write`, which is one `process.stdout.write` with no flush acknowledgement, and the receipt
 * arrives on the bootstrap socket rather than through the master this host reads. The receipt carries that
 * frame's own `byteLength` and no cumulative counter, so there is nothing to compare with this host's read
 * position. `presentTo` therefore reports `recoveryArmed: false` and names
 * `MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary`, the nonce is never recorded against an
 * attachment, and `acknowledgePresentation` clears nothing. A client's echo of a nonce whose frame may still
 * be in flight would mark a stale screen current, which is the one thing the attachment set's nonce rule
 * exists to prevent.
 *
 * **Seam G's `entering` is the authority on child ownership, and the foreground process group is not.** Pi's
 * own external editor is spawned with `stdio: "inherit"` and no `setpgid`, so it inherits Pi's group and
 * `tcgetpgrp` does not move. `corroborateForegroundProcessGroup` answers `proves: "nothing"` on purpose: it
 * notices a child that establishes its own group and it cannot notice the one child Pi already tells us
 * about.
 *
 * **A reaped status is read before any signal, and a null one is not life.** The artifact's waiting thread
 * publishes the raw status just after `wait(2)` returns, so `null` means "no status published yet". Every
 * stop reads it first, revalidates the recorded identity, and only then signals — after a signal, an exit
 * that had already happened for another reason can no longer be told apart from the one it caused.
 *
 * **Boundary.** This module keeps no copy of any byte it hands to a sink, never parses input or output, never
 * decodes a key, never judges paste completeness, and never stops the owner because the attachment set is
 * empty. Terminal-response decisions belong to the launch-fixed profile in
 * [terminal-profile.mjs](terminal-profile.mjs); epochs belong to
 * [shared/native-contracts.mjs](../shared/native-contracts.mjs); membership and backpressure belong to
 * [attachment-set.mjs](attachment-set.mjs).
 */

import { nextAttachmentEpoch, parseAttachmentEpoch } from "../shared/native-contracts.mjs";
import { createAttachmentSet } from "./attachment-set.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { signalProcessGroup } from "./process-signaler.mjs";
import { decodeWaitStatus } from "./pty-mechanism.mjs";
import { admitClient, PROFILE_COVERAGE_GAPS, profileModeInitialization, createResponseLedger } from "./terminal-profile.mjs";

/** @typedef {import("./terminal-profile.mjs").VirtualTerminalProfile} VirtualTerminalProfile */
/** @typedef {import("../shared/native-contracts.mjs").AttachmentEpoch} AttachmentEpoch */
/** @typedef {{ pid: number, startIdentity: string, processGroupId: number }} ProcessIdentity */
/** @typedef {{ signal: string, identity: any }} StopIntent */
/** @typedef {{ active: true, childPhaseId: string, reason: string, drainedThrough: number }} ChildPhase */

/**
 * The capabilities this host needs and does not have, by the name a refusal carries.
 *
 * They are named rather than described because a refusal reaches an operator: "attachment unavailable" says
 * nothing he can act on, and the named capability is what a follow-up seam correction has to supply.
 */
export const MISSING_HOST_CAPABILITIES = Object.freeze({
  /** No supported route publishes Pi's started terminal to a caller that runs before extensions load. */
  labelledIngress: "native-labelled-ingress-target",
  /** Nothing correlates a presentation receipt with the bytes this host has read off the master. */
  presentationDeliveryBoundary: "native-presentation-delivery-boundary",
});

/** The error codes a `write` failure carries the accepted prefix on, so only the suffix is ever queued. */
const PARTIAL_WRITE_CODES = Object.freeze(["PTY_INPUT_BACKPRESSURE", "PTY_WRITE_NO_PROGRESS"]);

/** A refused request, or a host that cannot be built as asked. Never a warning and never a default. */
export class PtyHostError extends Error {
  /** @param {string} message @param {{ code?: string, cause?: unknown }} [options] */
  constructor(message, { code = "PTY_HOST", cause } = {}) {
    super(message, { cause });
    this.name = "PtyHostError";
    this.code = code;
  }
}

/** @param {unknown} a @param {unknown} b */
function sameIdentity(a, b) {
  const left = /** @type {ProcessIdentity} */ (a);
  const right = /** @type {ProcessIdentity} */ (b);
  return (
    typeof left === "object" && left !== null && typeof right === "object" && right !== null &&
    left.pid === right.pid && left.startIdentity === right.startIdentity && left.processGroupId === right.processGroupId
  );
}

/**
 * The corrected exit-cause rule, in one place and with nothing inferred.
 *
 * 1. No published status is **not** an exit. It is also not evidence of life, which is why the answer names
 *    that rather than reporting a living owner.
 * 2. A normal wait status is a normal or native exit, even when a cleanup signal was sent afterwards. It does
 *    not prove the owner exited spontaneously, so the note says so and the stop intent is kept separate.
 * 3. A signal status matching a recorded intent **for that exact identity** is labelled attribution. Not
 *    proof: another cause could have produced the same signal at the same moment.
 * 4. Anything else — an unexplained signal, an intent for another identity, a different signal, a status this
 *    host cannot decode — is `unknown`.
 *
 * @param {{ reaped: { status: number } | null, stopIntent: StopIntent | null, owner: any }} observation
 */
export function classifyOwnerExit({ reaped, stopIntent, owner }) {
  if (reaped === null || reaped === undefined) {
    return { exited: false, cause: null, note: "a null cached wait status is not evidence of life" };
  }
  let decoded;
  try {
    decoded = decodeWaitStatus(reaped.status);
  } catch (cause) {
    return { exited: true, cause: "unknown", code: null, signal: null, attribution: null, note: `this owner's raw wait status ${String(reaped.status)} could not be decoded`, reason: /** @type {Error} */ (cause).message };
  }
  if (decoded.signal === null) {
    return {
      exited: true,
      cause: "native-exit",
      code: decoded.code,
      signal: null,
      attribution: null,
      note: "a normal wait status is a normal or native exit; it does not prove the owner exited spontaneously",
    };
  }
  if (stopIntent !== null && stopIntent !== undefined && stopIntent.signal === decoded.signal && sameIdentity(stopIntent.identity, owner)) {
    return {
      exited: true,
      cause: "attributed-stop",
      code: null,
      signal: decoded.signal,
      attribution: { signal: stopIntent.signal, identity: stopIntent.identity, basis: "attribution to a recorded stop intent, not causal proof" },
      note: "the signal matches this owner's recorded stop intent; nothing here proves the intent caused the exit",
    };
  }
  return {
    exited: true,
    cause: "unknown",
    code: null,
    signal: decoded.signal,
    attribution: null,
    note: "this owner died on a signal that matches no recorded stop intent for its exact identity",
  };
}

/** @param {string} name @param {unknown} value */
function requireDimension(name, value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0 || /** @type {number} */ (value) > 0xffff) {
    throw new PtyHostError(`${name} must be a positive 16-bit integer, received ${String(value)}`, { code: "PTY_HOST_INVALID_REQUEST" });
  }
  return /** @type {number} */ (value);
}

/**
 * One host for one owner.
 *
 * `owner` is the handle [pty-mechanism.mjs](pty-mechanism.mjs) returns. Its master descriptor's lifetime
 * belongs to whatever wrapped it in a stream, so nothing here ever closes it: an empty attachment set is not
 * an orphan, and the owner outlives every client.
 *
 * `inputTarget` and `presentation` are the two supported seams this host consumes when an owner really
 * supplies them — Pi's own `dispatchNativeInput` and seam E's `present`. Both are injected because both are
 * out-of-process facts about one launch, and both are absent for the whole of this release.
 *
 * @param {{ owner: any, profile: VirtualTerminalProfile, queuedByteCap: number, cols: number, rows: number, inputTarget?: any, presentation?: any, inspectIdentity?: (pid: number) => Promise<any>, signalProcessGroup?: (pgid: number, signal: any) => void }} options
 */
export function createPtyHost({
  owner,
  profile,
  queuedByteCap,
  cols,
  rows,
  inputTarget = null,
  presentation = null,
  inspectIdentity = inspectProcessIdentity,
  signalProcessGroup: signal = signalProcessGroup,
}) {
  for (const method of ["write", "resize", "reapIfExited", "foregroundProcessGroup"]) {
    if (typeof owner?.[method] !== "function") {
      throw new PtyHostError(`An owner handle must provide ${method}`, { code: "PTY_HOST_OWNER_UNUSABLE" });
    }
  }
  const identity = owner.owner;
  if (typeof identity !== "object" || identity === null || !Number.isSafeInteger(identity.pid) || typeof identity.startIdentity !== "string") {
    throw new PtyHostError("An owner handle must carry the identity it was born with", { code: "PTY_HOST_OWNER_UNUSABLE" });
  }
  let modeInitialization;
  try {
    modeInitialization = profileModeInitialization(profile);
  } catch (cause) {
    throw new PtyHostError("A launch-fixed terminal profile is required", { code: "PTY_HOST_PROFILE_UNUSABLE", cause });
  }
  if (!Number.isSafeInteger(queuedByteCap) || queuedByteCap <= 0) {
    throw new PtyHostError(`A queued byte cap must be a positive safe integer, received ${String(queuedByteCap)}`, { code: "PTY_HOST_INVALID_REQUEST" });
  }
  let geometryCols = requireDimension("cols", cols);
  let geometryRows = requireDimension("rows", rows);
  /** Revision 1 is the launch geometry: a client that never resized still has a revision to compare. */
  let geometryRevision = 1;

  const attachmentSet = createAttachmentSet({ queuedByteCap });
  const responses = createResponseLedger();
  /** Bytes this host has read off the master and handed to the attachment set. */
  let readBytes = 0;
  /** @type {ChildPhase | null} */
  let childPhaseRecord = null;
  /** @type {StopIntent | null} */
  let stopIntent = null;
  /** Spans the dispatch target refused. They stay the sender's, and they are handed out exactly once. */
  /** @type {{ epoch: AttachmentEpoch, bytes: Uint8Array, reason: string }[]} */
  const refusedInput = [];
  /** Unaccepted write suffixes, in arrival order. Never an accepted prefix, so nothing is ever rewritten. */
  /** @type {Uint8Array[]} */
  const ownerWriteQueue = [];
  /** One chain, so labelled spans are accounted for in the order they were admitted. */
  let dispatchAccounting = Promise.resolve();
  /** @type {Map<string, { epoch: AttachmentEpoch, token: object }>} */
  const outstandingPresentations = new Map();
  const presentationCounts = { requested: 0, presented: 0, refused: 0, retired: 0, staleReceipt: 0, acknowledgementsRefused: 0 };

  /** @param {AttachmentEpoch} epoch */
  const retirePresentation = (epoch) => {
    const outstanding = outstandingPresentations.get(epoch.attachmentId);
    if (outstanding !== undefined && outstanding.epoch.epoch === epoch.epoch) outstandingPresentations.delete(epoch.attachmentId);
  };

  /** @param {Uint8Array} span @returns {{ accepted: number, remainder: Uint8Array | null }} */
  const attemptOwnerWrite = (span) => {
    try {
      owner.write(span);
      return { accepted: span.byteLength, remainder: null };
    } catch (error) {
      const failure = /** @type {{ code?: string, bytesWritten?: number | null }} */ (error);
      if (PARTIAL_WRITE_CODES.includes(failure.code ?? "") && Number.isSafeInteger(failure.bytesWritten) && /** @type {number} */ (failure.bytesWritten) >= 0) {
        const accepted = /** @type {number} */ (failure.bytesWritten);
        return { accepted, remainder: accepted < span.byteLength ? span.subarray(accepted) : null };
      }
      throw new PtyHostError(`Writing ${span.byteLength} bytes to this owner's terminal failed`, { code: "PTY_HOST_WRITE_FAILED", cause: error });
    }
  };

  const pendingOwnerBytes = () => ownerWriteQueue.reduce((total, span) => total + span.byteLength, 0);

  const geometry = () => ({ cols: geometryCols, rows: geometryRows, revision: geometryRevision });

  const missingCapabilities = () => [
    ...(inputTarget === null ? [MISSING_HOST_CAPABILITIES.labelledIngress] : []),
    MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary,
  ];

  return Object.freeze({
    /** The launch-fixed profile, unchanged by every attach, refusal and reply. */
    profile() {
      return profile;
    },

    geometry,

    /** What this host cannot do, by name, plus the profile coverage it cannot enforce. */
    capabilityReport() {
      return { missing: missingCapabilities(), coverageGaps: PROFILE_COVERAGE_GAPS };
    },

    /**
     * Whether a conforming client can be given native attachment on this owner right now.
     *
     * Derived from the capability report, not from membership: the owner runs either way, and this is the
     * **G-A7** mark that says attachment is unavailable while naming what is missing.
     */
    ownerAttachmentUnavailable() {
      return missingCapabilities().length > 0;
    },

    /**
     * Admit one client, or refuse it by the name of the capability it is missing.
     *
     * The epoch comes from the adopted contract, so there is one epoch system: the next epoch for this id,
     * never reused, and strictly above the highest this owner ever admitted for it. The profile's client-owned
     * modes are written to the new sink immediately, before anything can broadcast to it.
     *
     * @param {{ attachmentId: string, sink: any, declared: any }} request
     */
    attach({ attachmentId, sink, declared }) {
      const admission = admitClient(profile, declared);
      if (!admission.admitted) {
        return { attached: false, code: admission.code, missingCapabilities: admission.missingCapabilities };
      }
      const superseded = attachmentSet.highestIssuedEpoch(attachmentId);
      const epoch = attachmentSet.add(nextAttachmentEpoch(attachmentId, superseded), sink);
      // A connection that is being replaced keeps nothing outstanding: its replacement must never be handed
      // the answer to a request the previous connection made.
      if (superseded !== null) retirePresentation(superseded);
      sink.write(modeInitialization);
      return { attached: true, epoch, geometry: geometry() };
    },

    /** Drop one exact connection and retire whatever it still had outstanding. @param {AttachmentEpoch} epoch @param {string} reason */
    detach(epoch, reason) {
      const asked = parseAttachmentEpoch(epoch);
      retirePresentation(asked);
      return attachmentSet.remove(asked);
    },

    attachments() {
      return attachmentSet.attachments();
    },

    /**
     * One shared geometry, changed by either attachment and retained after both leave.
     *
     * One `TIOCSWINSZ` on the master, so the owner and every child it spawned share one size. A resize to the
     * size already set changes nothing and advances no revision: a revision names a change clients must
     * re-render for.
     *
     * @param {{ cols: number, rows: number, from: AttachmentEpoch }} request
     */
    resize({ cols: nextCols, rows: nextRows, from }) {
      if (!attachmentSet.isInputEligible(from)) {
        throw new PtyHostError("A resize comes from a current attachment of this owner", { code: "PTY_HOST_NOT_ATTACHED" });
      }
      requireDimension("cols", nextCols);
      requireDimension("rows", nextRows);
      if (nextCols === geometryCols && nextRows === geometryRows) return { ...geometry(), changed: false };
      owner.resize(nextCols, nextRows);
      geometryCols = nextCols;
      geometryRows = nextRows;
      geometryRevision += 1;
      return { ...geometry(), changed: true };
    },

    /** Hand one read of the owner's terminal to every attachment. Nothing is copied and nothing is kept.
     * @param {Uint8Array} bytes */
    broadcastOwnerOutput(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new PtyHostError("Owner output is a Uint8Array", { code: "PTY_HOST_INVALID_REQUEST" });
      readBytes += bytes.byteLength;
      return attachmentSet.broadcast(bytes);
    },

    /** Bytes this host has read off the master. The only read position it has, and no frame names one. */
    readThrough() {
      return readBytes;
    },

    /**
     * Deliver one client's bytes as labelled native input, in arrival order.
     *
     * The dispatch is started in call order, because seam B's admission is synchronous and decides the order
     * the ordered native path sees. Only the accounting is chained.
     *
     * A refused span is neither retried nor written anywhere else: it stays the sender's, is reported, and is
     * handed out exactly once by `takeRefusedInput`. An answer this host cannot read is ambiguous, and
     * ambiguity is not permission to send the same bytes twice, so those bytes are reported and dropped from
     * every route.
     *
     * @param {{ epoch: AttachmentEpoch, bytes: Uint8Array, bindingGeneration?: number }} request
     */
    deliverInput({ epoch, bytes, bindingGeneration = 1 }) {
      if (!(bytes instanceof Uint8Array)) throw new PtyHostError("Labelled input is a Uint8Array", { code: "PTY_HOST_INVALID_REQUEST" });
      const asked = parseAttachmentEpoch(epoch);
      if (!attachmentSet.isInputEligible(asked)) {
        return Promise.resolve({ delivered: false, admitted: null, reason: "not-attached" });
      }
      if (childPhaseRecord !== null) {
        return Promise.resolve({ delivered: false, admitted: null, reason: "child-owns-terminal", childPhaseId: childPhaseRecord.childPhaseId });
      }
      if (inputTarget === null) {
        return Promise.resolve({ delivered: false, admitted: null, reason: "labelled-ingress-unavailable", missingCapability: MISSING_HOST_CAPABILITIES.labelledIngress });
      }
      /** @type {Promise<any>} */
      let dispatched;
      try {
        dispatched = Promise.resolve(inputTarget.dispatchNativeInput({ attachmentEpoch: asked, bytes, binding: { generation: bindingGeneration } }));
      } catch (error) {
        dispatched = Promise.reject(error);
      }
      const settled = dispatchAccounting.then(() => dispatched).then(
        (result) => {
          if (result?.admitted === true) return { delivered: true, admitted: true, consumedThrough: result.consumedThrough };
          if (result?.admitted === false) {
            refusedInput.push({ epoch: asked, bytes, reason: typeof result.reason === "string" ? result.reason : "refused" });
            return { delivered: false, admitted: false, reason: typeof result.reason === "string" ? result.reason : "refused", consumedThrough: result.consumedThrough };
          }
          return { delivered: false, admitted: null, reason: "dispatch-answer-unreadable" };
        },
        () => ({ delivered: false, admitted: null, reason: "dispatch-failed" }),
      );
      dispatchAccounting = settled.then(
        () => undefined,
        () => undefined,
      );
      return settled;
    },

    /** Take every refused span, once. A second call returns nothing, because first delivery happens once. */
    takeRefusedInput() {
      return refusedInput.splice(0);
    },

    /**
     * Write host-owned bytes to the owner's terminal, preserving the terminal's own partial-write progress.
     *
     * A full input buffer reports how much it took; only the suffix is queued, and a later flush continues
     * from there rather than rewriting an accepted prefix. A span that arrives while the queue is not empty
     * waits behind it, so the master never sees two host writes out of arrival order.
     *
     * @param {Uint8Array} bytes
     */
    writeToOwner(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new PtyHostError("Owner input is a Uint8Array", { code: "PTY_HOST_INVALID_REQUEST" });
      if (ownerWriteQueue.length > 0) {
        ownerWriteQueue.push(bytes);
        return { accepted: 0, pending: pendingOwnerBytes() };
      }
      const attempt = attemptOwnerWrite(bytes);
      if (attempt.remainder !== null) ownerWriteQueue.push(attempt.remainder);
      return { accepted: attempt.accepted, pending: pendingOwnerBytes() };
    },

    /** Continue the queued suffixes, in order, until the terminal stops taking bytes. */
    flushOwnerWrites() {
      let accepted = 0;
      while (ownerWriteQueue.length > 0) {
        const attempt = attemptOwnerWrite(/** @type {Uint8Array} */ (ownerWriteQueue.shift()));
        accepted += attempt.accepted;
        if (attempt.remainder !== null) {
          ownerWriteQueue.unshift(attempt.remainder);
          break;
        }
      }
      return { accepted, pending: pendingOwnerBytes() };
    },

    /**
     * Record one seam G phase. `entering` is authoritative and suspends both directions.
     *
     * Pi has already drained its in-flight input by the time `entering` arrives, and its own gate is closed,
     * so from here the host stops asking for presentation and stops delivering labelled ingress. `left` is
     * matched by `childPhaseId`: a phase this host never saw enter resumes nothing, because resuming on an
     * unmatched announcement would reopen ingress into a terminal a child still holds.
     *
     * @param {any} phase
     */
    childTerminalPhase(phase) {
      const record = typeof phase === "object" && phase !== null ? phase : {};
      if (typeof record.childPhaseId !== "string" || record.childPhaseId.length === 0 || typeof record.reason !== "string") {
        return { accepted: false, reason: "unreadable-child-phase" };
      }
      if (record.phase === "entering") {
        if (!Number.isSafeInteger(record.drainedThrough) || record.drainedThrough < 0) return { accepted: false, reason: "unreadable-child-phase" };
        if (childPhaseRecord !== null) return { accepted: false, reason: "child-phase-already-active" };
        childPhaseRecord = { active: true, childPhaseId: record.childPhaseId, reason: record.reason, drainedThrough: record.drainedThrough };
        return { accepted: true };
      }
      if (record.phase === "left") {
        if (childPhaseRecord === null || childPhaseRecord.childPhaseId !== record.childPhaseId) return { accepted: false, reason: "unmatched-child-phase" };
        childPhaseRecord = null;
        return { accepted: true };
      }
      return { accepted: false, reason: "unreadable-child-phase" };
    },

    /** The phase this host believes a child is in, or `null` while Pi holds the terminal. */
    childPhase() {
      return childPhaseRecord === null ? null : { ...childPhaseRecord };
    },

    presentationSuspended() {
      return childPhaseRecord !== null;
    },

    /**
     * The owner terminal's foreground process group. Corroboration, and it says so.
     *
     * It notices a child that establishes its own group and it cannot notice Pi's own external editor, whose
     * child inherits Pi's group. An unreadable answer is reported as unreadable rather than as no child.
     */
    corroborateForegroundProcessGroup() {
      try {
        const foregroundProcessGroup = owner.foregroundProcessGroup();
        return { foregroundProcessGroup, sameAsOwnerGroup: foregroundProcessGroup === identity.processGroupId, proves: "nothing" };
      } catch {
        return { foregroundProcessGroup: null, sameAsOwnerGroup: null, proves: "nothing" };
      }
    },

    /**
     * Ask Pi for one cold presentation for this attachment, and report what it cannot prove.
     *
     * The request is outstanding against one exact connection. A connection that leaves, or is replaced,
     * retires it: the answer is discarded rather than handed to whatever holds that attachment id now.
     *
     * A receipt is never turned into armed recovery. `recoveryArmed: false` with the delivery boundary named
     * is the whole answer, and a receipt built at another geometry is additionally reported as stale rather
     * than compared away.
     *
     * @param {AttachmentEpoch} epoch
     */
    async presentTo(epoch) {
      const asked = parseAttachmentEpoch(epoch);
      if (!attachmentSet.isInputEligible(asked)) return { presented: false, refusal: "not-attached", attachmentEpoch: asked };
      if (childPhaseRecord !== null) return { presented: false, refusal: "child-owns-terminal", attachmentEpoch: asked };
      if (presentation === null || typeof presentation.present !== "function") {
        return { presented: false, refusal: "presentation-channel-unavailable", attachmentEpoch: asked };
      }
      const token = {};
      const requestedRevision = geometryRevision;
      outstandingPresentations.set(asked.attachmentId, { epoch: asked, token });
      presentationCounts.requested += 1;
      /** @type {any} */
      let result;
      try {
        result = await presentation.present({ attachmentEpoch: asked, geometryRevision: requestedRevision, coldTerminal: true });
      } catch (error) {
        if (outstandingPresentations.get(asked.attachmentId)?.token !== token) {
          presentationCounts.retired += 1;
          return { presented: false, refusal: "attachment-retired", attachmentEpoch: asked };
        }
        outstandingPresentations.delete(asked.attachmentId);
        presentationCounts.refused += 1;
        return { presented: false, refusal: "presentation-failed", attachmentEpoch: asked, reason: /** @type {Error} */ (error).message };
      }
      if (outstandingPresentations.get(asked.attachmentId)?.token !== token) {
        presentationCounts.retired += 1;
        return { presented: false, refusal: "attachment-retired", attachmentEpoch: asked };
      }
      outstandingPresentations.delete(asked.attachmentId);
      if (result?.presented !== true) {
        presentationCounts.refused += 1;
        return { presented: false, refusal: typeof result?.refusal === "string" ? result.refusal : "refused", attachmentEpoch: asked };
      }
      presentationCounts.presented += 1;
      const frame = result.frame;
      const stale = result.geometryRevision !== geometryRevision || frame?.columns !== geometryCols || frame?.rows !== geometryRows;
      if (stale) presentationCounts.staleReceipt += 1;
      return {
        presented: true,
        presentationNonce: result.presentationNonce,
        geometryRevision: result.geometryRevision,
        frame,
        recoveryArmed: false,
        missingCapability: MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary,
        ...(stale ? { stale: true } : {}),
      };
    },

    /**
     * A client's echo of a presentation nonce. Counted, and it clears nothing.
     *
     * The echo would be proof of a current screen only if the frame it names had provably passed through this
     * host to that client. Nothing orders the receipt against this host's own reads, so accepting the echo
     * would mark a possibly stale screen current. Membership and input eligibility are untouched: a client
     * that stays `resync-required` keeps typing.
     *
     * @param {AttachmentEpoch} epoch @param {unknown} nonce
     */
    acknowledgePresentation(epoch, nonce) {
      presentationCounts.acknowledgementsRefused += 1;
      return {
        cleared: false,
        reason: "presentation-delivery-boundary-unavailable",
        missingCapability: MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary,
      };
    },

    presentationCounts() {
      return { ...presentationCounts };
    },

    /** Seam F's decision, delegated to the launch-fixed profile. Nothing here parses a byte. @param {unknown} response */
    authorizeTerminalResponse(response) {
      return responses.decide(response);
    },

    responseCounts() {
      return responses.counts();
    },

    /**
     * Stop this owner: reap first, revalidate the recorded identity, then signal — in that order.
     *
     * The published status is read before anything is sent, because after a signal an exit that had already
     * happened for another reason can no longer be told apart from the one it caused. The identity is
     * re-read immediately before the signal, because a PID the native thread has already reaped may belong
     * to any process by now.
     *
     * @param {{ signal: NodeJS.Signals }} request
     */
    async stopOwner({ signal: requested }) {
      const reaped = owner.reapIfExited();
      if (reaped !== null) {
        return { signalled: false, reason: "already-reaped", exit: classifyOwnerExit({ reaped, stopIntent, owner: identity }) };
      }
      if (typeof requested !== "string" || requested.length === 0) {
        throw new PtyHostError("A stop names the signal it sends", { code: "PTY_HOST_INVALID_REQUEST" });
      }
      let current;
      try {
        current = await inspectIdentity(identity.pid);
      } catch {
        return { signalled: false, reason: "identity-unreadable" };
      }
      if (!sameIdentity(current, identity)) return { signalled: false, reason: "identity-changed" };
      const intent = { signal: requested, identity };
      stopIntent = intent;
      signal(identity.processGroupId, requested);
      return { signalled: true, intent };
    },

    /** What this owner's exit can be said to be, from the published status and the recorded intent. */
    describeOwnerExit() {
      return classifyOwnerExit({ reaped: owner.reapIfExited(), stopIntent, owner: identity });
    },
  });
}
