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
 * **Labelled ingress has a published target now, and it is process-local to Pi.**
 * `nativeInputTargetSnapshot`/`subscribeNativeInputTarget` read a container inside the Pi process: importing
 * them here, in the host process, would read this process's empty registry and answer `producer-absent`
 * forever. They are not an IPC bridge and this module does not pretend otherwise. `inputTargetRegistry` is
 * therefore injected with exactly the published snapshot/subscription shape, and whoever supplies it runs
 * where the registry lives — Pi-side. The host consumes publications, distinguishes API version from producer
 * version, follows replacement and synchronous revocation, and refuses by the registry's own reason. With no
 * route at all `deliverInput` still refuses by name: `MISSING_HOST_CAPABILITIES.labelledIngress`. It is never
 * answered by writing the client's bytes to the master unlabelled.
 *
 * **A presentation receipt still is not a delivery boundary; `dcs-pi-native-present-v1` is.** Four distinct
 * boundaries are kept apart on purpose: the bootstrap-2 request/result frames (a control channel), the marker
 * framing decoded out of the PTY master's bytes (a byte boundary), the fresh bytes handed to one client
 * transport, and that client's acknowledgement that its own local terminal-output `Writable` accepted them in
 * order. A usable ordered presentation needs **both** the matching successful control result and the matching
 * observed BEGIN/END; an END alone can be a fully admitted END followed by a throwing write, or a partial END
 * finished by the failed attempt's cleanup terminator. Nothing is live before the client's acknowledgement,
 * nothing is replayed, and no output tail is retained.
 *
 * **Boundary.** This module keeps no copy of any byte it hands to a sink, never parses input or output, never
 * decodes a key, never judges paste completeness, and never stops the owner because the attachment set is
 * empty. Terminal-response decisions belong to the launch-fixed profile in
 * [terminal-profile.mjs](terminal-profile.mjs); epochs belong to
 * [shared/native-contracts.mjs](../shared/native-contracts.mjs); membership and backpressure belong to
 * [attachment-set.mjs](attachment-set.mjs); the marker framing belongs to the accepted `pi-tui` build, whose
 * public API is injected rather than re-implemented.
 */

import { nextAttachmentEpoch, parseAttachmentEpoch } from "../shared/native-contracts.mjs";
import { createAttachmentSet } from "./attachment-set.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { signalProcessGroup } from "./process-signaler.mjs";
import { decodeWaitStatus } from "./pty-mechanism.mjs";
import { admitClient, createLaunchFixedProfile, PROFILE_COVERAGE_GAPS, profileModeInitialization, createResponseLedger } from "./terminal-profile.mjs";

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

/** The bootstrap protocol that carries `present-ordered`. Protocol 1 is not extended and stays compatible. */
export const ORDERED_BOOTSTRAP_PROTOCOL = 2;

/** The named marker API this host consumes from the build its owner runs. Absent names refuse activation. */
const REQUIRED_MARKER_API = Object.freeze([
  "NATIVE_PRESENT_MARKER_CODEC",
  "NATIVE_PRESENT_ORDERING_VERSION",
  "NATIVE_PRESENT_TOKEN_BYTES",
  "NATIVE_PRESENT_MARKER_MAX_BYTES",
  "NATIVE_PRESENT_FRESH_CHUNK_MAX",
  "NativePresentMarkerDecoder",
  "mintNativePresentToken",
  "isNativePresentToken",
  "isNativePresentFrameId",
]);

/**
 * Whether one protocol-2 hello really declares the framing the injected build speaks.
 *
 * Both halves are checked against each other rather than assumed: the hello is the launch Pi answered with,
 * and the marker API is the build this host was handed. A protocol-1 hello is a compatible old Pi, not a
 * failure, and either way not one ordered command is sent — an unsupported ordering is never downgraded to an
 * unordered presentation.
 *
 * @param {any} hello @param {any} markers
 * @returns {{ active: true, declared: { version: number, markerCodec: string, tokenBytes: number, maxMarkerBytes: number, freshChunkMax: number } } | { active: false, reason: string }}
 */
function readOrderedPresentationHello(hello, markers) {
  if (typeof markers !== "object" || markers === null) return { active: false, reason: "marker-api-absent" };
  const missing = REQUIRED_MARKER_API.find((name) => markers[name] === undefined);
  if (missing !== undefined) return { active: false, reason: `marker-api-incomplete:${missing}` };
  if (typeof hello !== "object" || hello === null || hello.type !== "native-bootstrap") return { active: false, reason: "bootstrap-hello-unreadable" };
  if (hello.protocol !== ORDERED_BOOTSTRAP_PROTOCOL) return { active: false, reason: "bootstrap-protocol-1" };
  const declared = hello.orderedPresentation;
  if (typeof declared !== "object" || declared === null) return { active: false, reason: "ordered-presentation-undeclared" };
  const expected = {
    version: markers.NATIVE_PRESENT_ORDERING_VERSION,
    markerCodec: markers.NATIVE_PRESENT_MARKER_CODEC,
    tokenBytes: markers.NATIVE_PRESENT_TOKEN_BYTES,
    maxMarkerBytes: markers.NATIVE_PRESENT_MARKER_MAX_BYTES,
    freshChunkMax: markers.NATIVE_PRESENT_FRESH_CHUNK_MAX,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (declared[field] !== value) return { active: false, reason: `ordered-presentation-mismatch:${field}` };
  }
  return { active: true, declared: Object.freeze({ ...expected }) };
}

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
 * The exact identity this owner was born with, copied out of the handle's own record and frozen.
 *
 * The mechanism returns a live mutable owner record, so retaining it by reference would let a later mutation
 * of that record move every signal this host sends and rewrite what an exit was attributed to. Only the three
 * fields an identity is are kept, and each is required: a zero or negative pid names no process, and a zero
 * or negative process group would send a signal to a group this host never launched.
 *
 * @param {unknown} record @returns {ProcessIdentity}
 */
function requireBirthIdentity(record) {
  if (typeof record !== "object" || record === null) {
    throw new PtyHostError("An owner handle must carry the identity it was born with", { code: "PTY_HOST_OWNER_UNUSABLE" });
  }
  const { pid, startIdentity, processGroupId } = /** @type {Record<string, unknown>} */ (record);
  if (
    !Number.isSafeInteger(pid) || Number(pid) <= 0 ||
    typeof startIdentity !== "string" || startIdentity.length === 0 ||
    !Number.isSafeInteger(processGroupId) || Number(processGroupId) <= 0
  ) {
    throw new PtyHostError(
      `An owner handle must carry an exact pid, start identity and process group, received ${String(pid)}/${String(startIdentity)}/${String(processGroupId)}`,
      { code: "PTY_HOST_OWNER_UNUSABLE" },
    );
  }
  return Object.freeze({ pid: /** @type {number} */ (pid), startIdentity, processGroupId: /** @type {number} */ (processGroupId) });
}

/**
 * The epoch number one attachment id has reached, with `0` for an id no connection has ever used.
 *
 * Only for comparing the set's own highest issued epoch against itself across one admission, which is how a
 * connection admitted from inside a sink callback is noticed. It mints nothing and is not a second epoch line.
 *
 * @param {AttachmentEpoch | null} issued
 */
function issuedEpoch(issued) {
  return issued === null ? 0 : issued.epoch;
}

/**
 * One admission's sink, with its drain registration already performed, ready to hand to the attachment set.
 *
 * Admission has one externally accepted effect — the initialization write — and it must be the last thing
 * that can fail. The set registers a drain listener as part of `add`, and that registration is a call into the
 * client's transport, so it can throw *after* those bytes were accepted. Preparing the sink moves that one
 * external call in front of the write: the listener is registered here, once, and the set is later handed a
 * registration that only records where to forward. So the set's `add` has nothing fallible left in it that
 * belongs to the transport.
 *
 * The forwarded listener stays inert until this admission actually commits, and a candidate that never becomes
 * a member forwards nothing for the rest of its life — a refused or superseded connection's drains cannot
 * touch the member that holds its id. Each method keeps the caller's sink as its receiver.
 *
 * Everything this function does touches the caller's object: reading the three methods can run a getter, and
 * the registration is a call into the transport. Either can synchronously admit another connection for the
 * same id, so `attach` re-reads that id's highest issued epoch as soon as this returns and before it writes.
 *
 * @param {any} sink
 */
function prepareAttachmentSink(sink) {
  for (const method of ["write", "queuedBytes", "onDrain"]) {
    if (typeof sink?.[method] !== "function") {
      throw new PtyHostError(`An attachment sink must provide ${method}`, { code: "PTY_HOST_SINK_UNUSABLE" });
    }
  }
  /** The set's own listener for this admission, or `null` while this candidate is not a member. */
  let member = /** @type {(() => void) | null} */ (null);
  try {
    sink.onDrain(() => {
      if (member !== null) member();
    });
  } catch (cause) {
    throw new PtyHostError("An attachment sink must be able to register a drain listener", { code: "PTY_HOST_SINK_UNUSABLE", cause });
  }
  return {
    /** @param {Uint8Array} bytes */
    write(bytes) {
      return sink.write(bytes);
    },
    queuedBytes() {
      return sink.queuedBytes();
    },
    /** @param {() => void} listener */
    onDrain(listener) {
      member = listener;
    },
  };
}

/**
 * One host for one owner.
 *
 * `owner` is the handle [pty-mechanism.mjs](pty-mechanism.mjs) returns. Its master descriptor's lifetime
 * belongs to whatever wrapped it in a stream, so nothing here ever closes it: an empty attachment set is not
 * an orphan, and the owner outlives every client.
 *
 * `inputTarget`, `inputTargetRegistry`, `presentation` and `presentMarkers` are the seams this host consumes
 * from the launch it belongs to. `inputTargetRegistry` is the published snapshot/subscription pair, supplied by
 * whoever runs inside Pi's process, because that registry is process-local; `inputTarget` is a single already
 * resolved dispatch handle for a caller that holds one. `presentation` is the bootstrap channel: `hello` is the
 * first frame Pi sent and `send` carries one command frame to its reply. `presentMarkers` is the accepted
 * `pi-tui` public marker API of the build this owner runs — injected, never re-implemented, and never resolved
 * from this package's own pinned dependency, because the framing must be the one the running Pi writes.
 *
 * `profile` is reconstructed rather than retained. A structurally profile-shaped object is not a launch-fixed
 * profile: only `createLaunchFixedProfile` refuses one that would buy a passing client by turning images,
 * configured keys or mouse reporting off, and only its frozen copy cannot drift apart from the mode bytes
 * derived here. So this host holds its own frozen profile, and a caller that mutates the record it passed in
 * moves neither admission nor initialization. A profile the factory already produced passes through unchanged.
 *
 * @param {{ owner: any, profile: VirtualTerminalProfile, queuedByteCap: number, cols: number, rows: number, inputTarget?: any, inputTargetRegistry?: any, presentation?: any, presentMarkers?: any, inspectIdentity?: (pid: number) => Promise<any>, signalProcessGroup?: (pgid: number, signal: any) => void }} options
 */
export function createPtyHost({
  owner,
  profile,
  queuedByteCap,
  cols,
  rows,
  inputTarget = null,
  inputTargetRegistry = null,
  presentation = null,
  presentMarkers = null,
  inspectIdentity = inspectProcessIdentity,
  signalProcessGroup: signal = signalProcessGroup,
}) {
  for (const method of ["write", "resize", "reapIfExited", "foregroundProcessGroup"]) {
    if (typeof owner?.[method] !== "function") {
      throw new PtyHostError(`An owner handle must provide ${method}`, { code: "PTY_HOST_OWNER_UNUSABLE" });
    }
  }
  const birthIdentity = requireBirthIdentity(owner.owner);
  let launchFixedProfile;
  let modeInitialization;
  try {
    const supplied = /** @type {Partial<VirtualTerminalProfile>} */ (typeof profile === "object" && profile !== null ? profile : {});
    launchFixedProfile = createLaunchFixedProfile({
      profileId: /** @type {string} */ (supplied.profileId),
      term: /** @type {string} */ (supplied.term),
      capabilities: /** @type {any} */ (supplied.capabilities),
      cellSize: supplied.cellSize ?? null,
    });
    modeInitialization = profileModeInitialization(launchFixedProfile);
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
  /**
   * The prepared handoff of each current member, so one armed recovery can be streamed to exactly one client.
   *
   * The attachment set broadcasts and deliberately skips a `resync-required` member, which is what keeps
   * ordinary output away from a client that fell behind (G-A6). A cold presentation has to reach that one
   * member and nobody else, so the host keeps the prepared sink it already owns rather than asking the set for
   * a per-member write it does not publish.
   * @type {Map<string, { epoch: AttachmentEpoch, prepared: { write: (bytes: Uint8Array) => unknown, queuedBytes: () => number } }>}
   */
  const admittedSinks = new Map();
  const orderedPresentation = /** @type {{ active: true, declared: { version: number, markerCodec: string, tokenBytes: number, maxMarkerBytes: number, freshChunkMax: number } } | { active: false, reason: string }} */ (
    presentation === null && presentMarkers === null
      ? { active: false, reason: "ordered-presentation-not-configured" }
      : readOrderedPresentationHello(presentation?.hello, presentMarkers)
  );
  /**
   * The one armed ordered attempt, or `null`.
   *
   * Two independent signals have to arrive before this attempt can be acknowledged, and they can arrive in
   * either order: the control result of the request that armed it, and the BEGIN/END observed on the byte
   * route. Neither alone is success. `freshBytes` counts what was handed to the client transport, and
   * `skippedOrdinaryAfterEnd` records ordinary output the member could not receive after the interval closed,
   * which invalidates the repaint even if the control result succeeds later.
   * @type {null | { epoch: AttachmentEpoch, token: string, requestId: string, geometryRevision: number, decoder: any, open: boolean, observedBegin: boolean, observedEnd: null | { frameId: string }, control: null | { presentationNonce: string, frameId: string }, freshBytes: number, freshChunks: number, skippedOrdinaryAfterEnd: boolean, failure: null | string, acknowledgeable: boolean }}
   */
  let armedRecovery = null;
  let requestSequence = 0;
  const recoveryCounts = { armed: 0, refusedAdmission: 0, freshChunks: 0, freshBytes: 0, failed: 0, acknowledgeable: 0, cleared: 0, retiredBackpressure: 0, retiredUncertain: 0, retiredGeometry: 0, lastRetirement: /** @type {string | null} */ (null) };

  /** Stop recognising this attempt's framing, whatever ended it. No tail is kept and nothing is replayed.
   * @param {string | null} failure */
  const retireRecovery = (failure) => {
    if (armedRecovery === null) return;
    if (failure !== null) {
      recoveryCounts.failed += 1;
      recoveryCounts.lastRetirement = failure;
      // Truthful reasons: a bounded route, an uncertain write and a moved geometry are not a detached client.
      if (failure === "fresh-route-backpressure" || failure === "fresh-route-queue-unreadable") recoveryCounts.retiredBackpressure += 1;
      else if (failure === "fresh-write-uncertain") recoveryCounts.retiredUncertain += 1;
      else if (failure === "geometry-moved") recoveryCounts.retiredGeometry += 1;
      armedRecovery.failure = failure;
    }
    try {
      armedRecovery.decoder.disarm();
    } catch {
      // A decoder that refuses to disarm is still dropped: this host keeps no framing state of its own.
    }
    armedRecovery = null;
  };

  /** The registry state this host can see right now, without inferring support from an exported version. */
  const inputTargetState = () => {
    if (inputTargetRegistry !== null) {
      let snapshot;
      try {
        snapshot = inputTargetRegistry.snapshot();
      } catch (error) {
        // A present-but-uninterpretable publication record, or a producer version this copy does not speak, is
        // refused by the registry with a throw. Fail closed and never reset it.
        return { route: "published-registry", apiVersion: null, producerVersion: null, publication: null, target: null, reason: "registry-unsupported", error: /** @type {Error} */ (error).message };
      }
      return {
        route: "published-registry",
        apiVersion: snapshot?.apiVersion ?? null,
        producerVersion: snapshot?.producerVersion ?? null,
        publication: snapshot?.publication ?? null,
        target: snapshot?.target ?? null,
        reason: snapshot?.target ? null : (snapshot?.reason ?? "producer-absent"),
      };
    }
    if (inputTarget !== null) {
      return { route: "resolved-handle", apiVersion: null, producerVersion: null, publication: inputTarget.publication ?? null, target: inputTarget, reason: null };
    }
    return { route: null, apiVersion: null, producerVersion: null, publication: null, target: null, reason: "no-input-route" };
  };

  /** @param {AttachmentEpoch} epoch */
  const retirePresentation = (epoch) => {
    const outstanding = outstandingPresentations.get(epoch.attachmentId);
    if (outstanding !== undefined && outstanding.epoch.epoch === epoch.epoch) outstandingPresentations.delete(epoch.attachmentId);
    if (armedRecovery !== null && armedRecovery.epoch.attachmentId === epoch.attachmentId && armedRecovery.epoch.epoch === epoch.epoch) {
      retireRecovery("attachment-retired");
    }
  };

  /**
   * Hand one fresh span to the one client this attempt is repainting, in bounded chunks.
   *
   * Three bounds apply, and the first two are the peer's and this host's own declared numbers rather than
   * advice. `freshChunkMax` sizes each chunk. `queuedByteCap` bounds what may be outstanding in that client's
   * transport, judged the way the attachment set judges it: the queue is read after a write, and a queue that is
   * past the cap stops the route. So at most the chunk already in flight can exceed the cap — a write's effect
   * cannot be known before it happens — and nothing further is written, buffered, queued or replayed. A `false`
   * return is Node's high-water mark: those bytes were admitted exactly once and are never rewritten, and it
   * ends the route for this attempt because the next chunk would only grow a queue that is already full.
   * A throw leaves what the transport accepted unknown, which can never authorize a retry.
   *
   * The client is neither evicted nor disabled by any of this, the owner's output is never stalled for it, and
   * nothing after the stop is written. The cost is recovery liveness: a client that cannot take a frame inside
   * the cap stays `resync-required` until a later attempt succeeds.
   *
   * Every write and every queue read is a call into the caller's own transport, so after each one this checks
   * that the same attempt and the same admitted connection are still current — the same rule admission follows.
   *
   * @param {Uint8Array} span
   */
  const streamFresh = (span) => {
    const attempt = armedRecovery;
    if (attempt === null) return;
    /** The exact connection and prepared handoff this attempt is repainting, or `null` if it moved. */
    const currentTarget = () => {
      if (armedRecovery !== attempt || attempt.failure !== null) return null;
      const held = admittedSinks.get(attempt.epoch.attachmentId);
      if (held === undefined || held.epoch.epoch !== attempt.epoch.epoch) return null;
      return held;
    };
    let held = currentTarget();
    if (held === null) {
      retireRecovery("attachment-retired");
      return;
    }
    const bound = orderedPresentation.active ? orderedPresentation.declared.freshChunkMax : span.byteLength;
    for (let offset = 0; offset < span.byteLength; offset += bound) {
      const chunk = span.subarray(offset, Math.min(offset + bound, span.byteLength));
      let queued;
      try {
        queued = held.prepared.queuedBytes();
      } catch {
        retireRecovery("fresh-route-queue-unreadable");
        return;
      }
      // Reading the queue is a call into the transport too, so the attempt may be gone by now.
      if (currentTarget() === null) {
        retireRecovery("attachment-retired");
        return;
      }
      if (!Number.isSafeInteger(queued) || /** @type {number} */ (queued) < 0) {
        retireRecovery("fresh-route-queue-unreadable");
        return;
      }
      if (/** @type {number} */ (queued) > queuedByteCap) {
        retireRecovery("fresh-route-backpressure");
        return;
      }
      let admitted;
      try {
        admitted = held.prepared.write(chunk);
      } catch {
        retireRecovery("fresh-write-uncertain");
        return;
      }
      // Accepted exactly once, counted exactly once, and never written again whatever the return said.
      attempt.freshBytes += chunk.byteLength;
      attempt.freshChunks += 1;
      recoveryCounts.freshBytes += chunk.byteLength;
      recoveryCounts.freshChunks += 1;
      const stillCurrent = currentTarget();
      if (stillCurrent === null) {
        retireRecovery("attachment-retired");
        return;
      }
      held = stillCurrent;
      let queuedAfter;
      try {
        queuedAfter = held.prepared.queuedBytes();
      } catch {
        retireRecovery("fresh-route-queue-unreadable");
        return;
      }
      if (currentTarget() === null) {
        retireRecovery("attachment-retired");
        return;
      }
      if (admitted === false || !Number.isSafeInteger(queuedAfter) || /** @type {number} */ (queuedAfter) > queuedByteCap) {
        retireRecovery("fresh-route-backpressure");
        return;
      }
    }
  };

  /**
   * Record the expected acknowledgement once **both** signals have arrived, and not one moment earlier.
   *
   * The control result with its matching receipt identity, and the matching BEGIN/END observed on the byte
   * route. Recording the nonce changes no member state: the attachment set still holds this member
   * `resync-required`, and only the client's own acknowledgement of this exact nonce clears it.
   */
  const completeRecoveryIfProved = () => {
    const attempt = armedRecovery;
    if (attempt === null || attempt.acknowledgeable || attempt.failure !== null) return;
    if (attempt.control === null || attempt.observedEnd === null) return;
    if (attempt.observedEnd.frameId !== attempt.control.frameId) {
      retireRecovery("frame-identity-mismatch");
      return;
    }
    if (attempt.skippedOrdinaryAfterEnd) {
      retireRecovery("ordinary-output-skipped-after-end");
      return;
    }
    if (attempt.geometryRevision !== geometryRevision) {
      retireRecovery("geometry-moved");
      return;
    }
    if (!attachmentSet.recordPresentationNonce(attempt.epoch, attempt.control.presentationNonce)) {
      retireRecovery("attachment-retired");
      return;
    }
    attempt.acknowledgeable = true;
    recoveryCounts.acknowledgeable += 1;
  };

  /**
   * One read of the master while an attempt is armed, split into this attempt's frame and everything else.
   *
   * The framing decoder is the accepted build's own: every byte that is not one of the armed token's markers is
   * reproduced verbatim, so ordinary output stays byte-identical and a refusal still carries its candidate's
   * bytes. Inside the interval the bytes are this attempt's fresh frame and go to the one member being
   * repainted. Outside it they are ordinary output and go to the live members exactly as before — which is also
   * why ordinary output arriving after END invalidates the repaint: the repainting member is still
   * `resync-required`, so the set skipped it and its screen is behind again.
   *
   * @param {Uint8Array} bytes
   */
  const decodeArmedRead = (bytes) => {
    const attempt = /** @type {NonNullable<typeof armedRecovery>} */ (armedRecovery);
    /** @type {any[]} */
    let events;
    try {
      events = attempt.decoder.decode(bytes);
    } catch (cause) {
      retireRecovery("decoder-refused-read");
      return attachmentSet.broadcast(bytes);
    }
    /** @type {import("./attachment-set.mjs").BroadcastResult} */
    const result = { delivered: [], skipped: [], markedResyncRequired: [], failures: [] };
    /** @param {Uint8Array} span @param {boolean} insideInterval */
    const ordinary = (span, insideInterval) => {
      if (span.byteLength === 0) return;
      if (!insideInterval && armedRecovery !== null && armedRecovery.observedEnd !== null) {
        // The repainting member is still `resync-required`, so the set skipped it: its screen is behind again
        // and this attempt can no longer be acknowledged, even when the control result succeeded already.
        armedRecovery.skippedOrdinaryAfterEnd = true;
        const alreadyProved = armedRecovery.acknowledgeable;
        if (alreadyProved) retireRecovery("ordinary-output-skipped-after-end");
      }
      const broadcast = attachmentSet.broadcast(span);
      result.delivered.push(...broadcast.delivered);
      result.skipped.push(...broadcast.skipped);
      result.markedResyncRequired.push(...broadcast.markedResyncRequired);
      result.failures.push(...broadcast.failures);
    };
    for (const event of events) {
      const open = armedRecovery !== null && armedRecovery.open;
      if (event.kind === "bytes" || event.kind === "refused") {
        // A refusal is not a loss: the candidate's bytes are reproduced, so they travel the route their phase
        // says. A refused candidate carrying this attempt's token still ends the attempt.
        //
        // Inside the interval those bytes are two things at once and both routes are taken: they are this
        // attempt's fresh frame for the one member being repainted, and they are still the owner's output for
        // every member that is keeping up. The attachment set skips a `resync-required` member, so the member
        // being repainted receives them once, through the authorized fresh route only — and the live members do
        // not lose the frame body or anything interleaved with it. The broadcast happens even when the fresh
        // route has just been retired: one client's transport is not the others' problem.
        if (open) {
          streamFresh(event.bytes);
          ordinary(event.bytes, true);
        } else {
          ordinary(event.bytes, false);
        }
        if (event.kind === "refused") retireRecovery(`framing-refused:${event.reason}`);
        continue;
      }
      if (armedRecovery === null || event.token !== armedRecovery.token) continue;
      if (event.kind === "begin") {
        armedRecovery.observedBegin = true;
        armedRecovery.open = true;
        continue;
      }
      if (event.kind === "end") {
        armedRecovery.open = false;
        armedRecovery.observedEnd = { frameId: event.frameId };
        completeRecoveryIfProved();
        continue;
      }
      // ABORT says the attempt failed. It undoes nothing, and a frame or even an END may already have gone out.
      retireRecovery("aborted");
    }
    return result;
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

  /**
   * What is still missing, by name — from the state this host is in right now.
   *
   * Labelled ingress is missing while there is no route at all **and** while the route there is publishes no
   * usable target: API availability, an injected adapter and a current publication are three different facts,
   * and only the third one is a dispatch target. One snapshot is passed in, so the two halves of one report
   * cannot disagree about it. The presentation delivery boundary is missing only while ordered framing is not
   * active: with it active the boundary exists, and what remains unproved is the client's own acknowledgement,
   * which this host requires rather than assumes.
   *
   * @param {{ target: any }} sampled
   */
  const missingCapabilities = (sampled) => [
    ...(sampled.target === null ? [MISSING_HOST_CAPABILITIES.labelledIngress] : []),
    ...(orderedPresentation.active ? [] : [MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary]),
  ];

  return Object.freeze({
    /** The launch-fixed profile this host owns, frozen at construction and unchanged by every attach, refusal and reply. */
    profile() {
      return launchFixedProfile;
    },

    geometry,

    /** What this host cannot do, by name, plus the profile coverage it cannot enforce and the seams it has. */
    capabilityReport() {
      // One sample of a mutable registry, read once and used for every field, so this report cannot contradict
      // itself about whether a target exists.
      const target = inputTargetState();
      return {
        missing: missingCapabilities(target),
        coverageGaps: PROFILE_COVERAGE_GAPS,
        // API availability is not producer availability, and a resolved handle is neither: all three are
        // reported separately so no caller infers support from an exported version.
        inputTarget: { route: target.route, apiVersion: target.apiVersion, producerVersion: target.producerVersion, publication: target.publication, available: target.target !== null, reason: target.reason },
        orderedPresentation: orderedPresentation.active
          ? { active: true, protocol: ORDERED_BOOTSTRAP_PROTOCOL, ...orderedPresentation.declared }
          : { active: false, reason: orderedPresentation.reason },
      };
    },

    /**
     * Whether a conforming client can be given native attachment on this owner right now.
     *
     * Derived from the same validated snapshot the report is derived from, not from membership and not from the
     * presence of an adapter: the owner runs either way, and this is the **G-A7** mark that says attachment is
     * unavailable while naming what is missing.
     */
    ownerAttachmentUnavailable() {
      return missingCapabilities(inputTargetState()).length > 0;
    },

    /**
     * Admit one client, or refuse it by the name of the capability it is missing.
     *
     * The epoch comes from the adopted contract, so there is one epoch system: the next epoch for this id,
     * never reused, and strictly above the highest this owner ever admitted for it.
     *
     * Admission is ordered so that the initialization write is the last thing that can fail, because those
     * bytes are accepted by the client's transport and can never be sent again. Everything fallible runs
     * first: the client's declaration, the id and the epoch it would take, the sink's surface, and the one
     * drain registration the set would otherwise perform after the write. Only then are the profile's
     * client-owned modes written, exactly once, and only then does the candidate become a member. A `false`
     * return from that write is Node's high-water mark, which means accepted: only a throw is a failure.
     *
     * So a refused id, an exhausted epoch space, an unusable sink and a transport that cannot take a drain
     * listener all leave the candidate unwritten, the membership untouched, a connection being replaced in
     * place with its own outstanding request, and the epoch this attempt would have used unspent.
     *
     * A sink callback can admit another connection for this id, and there are exactly two places in this
     * method that call out to the client and can do it: registering the drain listener, and the initialization
     * write. The id's highest issued epoch is therefore re-read after each of them, and a newer member keeps
     * the id: this attempt refuses rather than overwriting it, and its own prevalidated epoch is reused for
     * nobody. After the registration the refusal costs the candidate nothing, because it has not been written
     * to yet; after the write it keeps that one accepted initialization and no membership. Nothing else here
     * reaches the client — the set's `add` only touches the prepared handoff, so it cannot call back out.
     *
     * @param {{ attachmentId: string, sink: any, declared: any }} request
     */
    attach({ attachmentId, sink, declared }) {
      const admission = admitClient(launchFixedProfile, declared);
      if (!admission.admitted) {
        return { attached: false, code: admission.code, missingCapabilities: admission.missingCapabilities };
      }
      const superseded = attachmentSet.highestIssuedEpoch(attachmentId);
      const minted = nextAttachmentEpoch(attachmentId, superseded);
      /**
       * Refuse if this id has been admitted again since `superseded` was read.
       *
       * One comparison against the set's own highest issued epoch, run after each callback into the client.
       * The number never goes back down, so a connection admitted and removed inside a callback is still seen.
       *
       * @param {string} stage
       */
      const refuseIfSupersededSince = (stage) => {
        const admittedSince = attachmentSet.highestIssuedEpoch(attachmentId);
        if (issuedEpoch(admittedSince) === issuedEpoch(superseded)) return;
        throw new PtyHostError(
          `Attachment ${attachmentId} was admitted at epoch ${issuedEpoch(admittedSince)} while this connection was ${stage}, so this connection was not admitted`,
          { code: "PTY_HOST_ATTACHMENT_SUPERSEDED" },
        );
      };
      const prepared = prepareAttachmentSink(sink);
      refuseIfSupersededSince("registering its drain listener");
      try {
        prepared.write(modeInitialization);
      } catch (cause) {
        throw new PtyHostError(
          `Attachment ${attachmentId} could not be given the profile's mode initialization, so nothing was admitted`,
          { code: "PTY_HOST_ATTACHMENT_INITIALIZATION_FAILED", cause },
        );
      }
      refuseIfSupersededSince("being initialized");
      const epoch = attachmentSet.add(minted, prepared);
      // A connection that is being replaced keeps nothing outstanding: its replacement must never be handed
      // the answer to a request the previous connection made.
      if (superseded !== null) retirePresentation(superseded);
      admittedSinks.set(epoch.attachmentId, { epoch, prepared });
      return { attached: true, epoch, geometry: geometry() };
    },

    /** Drop one exact connection and retire whatever it still had outstanding. @param {AttachmentEpoch} epoch @param {string} reason */
    detach(epoch, reason) {
      const asked = parseAttachmentEpoch(epoch);
      retirePresentation(asked);
      const held = admittedSinks.get(asked.attachmentId);
      if (held !== undefined && held.epoch.epoch === asked.epoch) admittedSinks.delete(asked.attachmentId);
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
      // A frame painted at the previous size is not this size's screen, so an attempt armed or already proved
      // for it is retired here rather than left to be acknowledged later. A resize that changed nothing
      // advanced no revision and retires nothing.
      retireRecovery("geometry-moved");
      return { ...geometry(), changed: true };
    },

    /** Hand one read of the owner's terminal to every attachment. Nothing is copied and nothing is kept.
     * @param {Uint8Array} bytes */
    broadcastOwnerOutput(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new PtyHostError("Owner output is a Uint8Array", { code: "PTY_HOST_INVALID_REQUEST" });
      readBytes += bytes.byteLength;
      if (armedRecovery === null) return attachmentSet.broadcast(bytes);
      return decodeArmedRead(bytes);
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
      // The current publication is read per call, because the registry is the authority and a handle this host
      // cached could have been revoked or replaced since. Nothing here is inferred from an exported version.
      const route = inputTargetState();
      if (route.target === null) {
        if (route.route === null) {
          return Promise.resolve({ delivered: false, admitted: null, reason: "labelled-ingress-unavailable", missingCapability: MISSING_HOST_CAPABILITIES.labelledIngress });
        }
        return Promise.resolve({ delivered: false, admitted: null, reason: "input-target-unavailable", targetReason: route.reason, producerVersion: route.producerVersion });
      }
      const publication = route.publication;
      /** @type {Promise<any>} */
      let dispatched;
      try {
        dispatched = Promise.resolve(route.target.dispatchNativeInput({ attachmentEpoch: asked, bytes, binding: { generation: bindingGeneration } }));
      } catch (error) {
        dispatched = Promise.reject(error);
      }
      const settled = dispatchAccounting.then(() => dispatched).then(
        (result) => {
          if (result?.admitted === true) return { delivered: true, admitted: true, consumedThrough: result.consumedThrough, publication };
          if (result?.admitted === false) {
            // `target-revoked` is the handle's own synchronous refusal and carries no `consumedThrough`: nothing
            // was dispatched, so the span stays the sender's exactly like seam G's `handoff-closed`.
            const reason = typeof result.reason === "string" ? result.reason : "refused";
            refusedInput.push({ epoch: asked, bytes, reason });
            return { delivered: false, admitted: false, reason, consumedThrough: result.consumedThrough, publication };
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
        return { foregroundProcessGroup, sameAsOwnerGroup: foregroundProcessGroup === birthIdentity.processGroupId, proves: "nothing" };
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
     * Ask Pi for one **ordered** cold presentation and arm this attempt's framing, or refuse by name.
     *
     * This is the managed-recovery command, and it is the only one that writes markers. A fresh token is minted
     * per attempt by the accepted build's own minter, the decoder is armed with it before the command is sent —
     * so BEGIN cannot arrive unrecognised — and one command frame carries the exact published `present-ordered`
     * shape. The result is bound to this attempt by `requestId`, by the echoed `ordering.token` and by the
     * receipt's own frame identity; anything else retires the token.
     *
     * Nothing here acknowledges anything. Success means the control half arrived; the byte half arrives on the
     * read route, and only when both agree is an acknowledgement even possible.
     *
     * An attempt already armed is refused rather than silently replaced: replacing it would leave the first
     * attempt's markers armed to nobody while its client waited for a repaint that is no longer coming.
     *
     * @param {AttachmentEpoch} epoch
     */
    async presentOrderedTo(epoch) {
      const asked = parseAttachmentEpoch(epoch);
      if (!orderedPresentation.active) {
        return { presented: false, refusal: "ordered-presentation-unavailable", reason: orderedPresentation.reason, attachmentEpoch: asked };
      }
      if (!attachmentSet.isInputEligible(asked)) return { presented: false, refusal: "not-attached", attachmentEpoch: asked };
      if (childPhaseRecord !== null) return { presented: false, refusal: "child-owns-terminal", attachmentEpoch: asked };
      if (typeof presentation?.send !== "function") return { presented: false, refusal: "presentation-channel-unavailable", attachmentEpoch: asked };
      if (armedRecovery !== null) {
        recoveryCounts.refusedAdmission += 1;
        return { presented: false, refusal: "recovery-already-armed", armedFor: armedRecovery.epoch, attachmentEpoch: asked };
      }
      const token = presentMarkers.mintNativePresentToken();
      if (!presentMarkers.isNativePresentToken(token)) {
        return { presented: false, refusal: "token-unusable", attachmentEpoch: asked };
      }
      requestSequence += 1;
      const requestId = `${asked.attachmentId}:${asked.epoch}:${requestSequence}`;
      const decoder = new presentMarkers.NativePresentMarkerDecoder();
      decoder.arm(token);
      const requestedRevision = geometryRevision;
      armedRecovery = {
        epoch: asked,
        token,
        requestId,
        geometryRevision: requestedRevision,
        decoder,
        open: false,
        observedBegin: false,
        observedEnd: null,
        control: null,
        freshBytes: 0,
        freshChunks: 0,
        skippedOrdinaryAfterEnd: false,
        failure: null,
        acknowledgeable: false,
      };
      const attempt = armedRecovery;
      recoveryCounts.armed += 1;
      presentationCounts.requested += 1;
      /** @type {any} */
      let frame;
      try {
        frame = await presentation.send({
          type: "present-ordered",
          protocol: ORDERED_BOOTSTRAP_PROTOCOL,
          requestId,
          ordering: { version: orderedPresentation.declared.version, token },
          attachmentEpoch: asked,
          geometryRevision: requestedRevision,
          coldTerminal: true,
        });
      } catch (error) {
        if (armedRecovery === attempt) retireRecovery("control-transport-lost");
        presentationCounts.refused += 1;
        return { presented: false, refusal: "presentation-failed", reason: /** @type {Error} */ (error).message, attachmentEpoch: asked };
      }
      if (armedRecovery !== attempt) {
        presentationCounts.retired += 1;
        return { presented: false, refusal: "attachment-retired", attachmentEpoch: asked };
      }
      const result = frame?.result;
      const bound =
        frame?.type === "presentation-result" &&
        frame.protocol === ORDERED_BOOTSTRAP_PROTOCOL &&
        frame.requestId === requestId &&
        frame.ordering?.token === token &&
        frame.ordering?.version === orderedPresentation.declared.version;
      if (!bound) {
        retireRecovery("control-result-unbound");
        presentationCounts.refused += 1;
        return { presented: false, refusal: "control-result-unbound", attachmentEpoch: asked };
      }
      if (
        result?.presented !== true ||
        result.ordering?.token !== token ||
        result.ordering?.markerCodec !== orderedPresentation.declared.markerCodec ||
        result.ordering?.version !== orderedPresentation.declared.version
      ) {
        // The inner ordering carries the same version/token pair plus the codec. A missing or different inner
        // version is not the framing this host armed, so it is refused rather than read past.
        retireRecovery("control-result-negative");
        presentationCounts.refused += 1;
        return { presented: false, refusal: typeof result?.refusal === "string" ? result.refusal : "control-result-negative", attachmentEpoch: asked };
      }
      if (!presentMarkers.isNativePresentFrameId(result.frame?.frameId) || typeof result.presentationNonce !== "string") {
        retireRecovery("receipt-identity-unusable");
        presentationCounts.refused += 1;
        return { presented: false, refusal: "receipt-identity-unusable", attachmentEpoch: asked };
      }
      presentationCounts.presented += 1;
      const stale = result.geometryRevision !== geometryRevision || result.frame.columns !== geometryCols || result.frame.rows !== geometryRows;
      if (stale) {
        presentationCounts.staleReceipt += 1;
        retireRecovery("stale-receipt");
        return { presented: true, stale: true, recoveryArmed: false, attachmentEpoch: asked, presentationNonce: result.presentationNonce, frame: result.frame };
      }
      attempt.control = { presentationNonce: result.presentationNonce, frameId: result.frame.frameId };
      // The byte half may already be complete: a fast output route can deliver END before this reply lands.
      completeRecoveryIfProved();
      return {
        presented: true,
        recoveryArmed: armedRecovery === attempt,
        acknowledgeable: attempt.acknowledgeable,
        ordering: { version: orderedPresentation.declared.version, token },
        presentationNonce: result.presentationNonce,
        geometryRevision: result.geometryRevision,
        frame: result.frame,
        attachmentEpoch: asked,
      };
    },

    /** What this host can say about the one armed ordered attempt. Two independent signals, reported apart. */
    recoveryState() {
      if (armedRecovery === null) return null;
      return {
        epoch: armedRecovery.epoch,
        token: armedRecovery.token,
        observedBegin: armedRecovery.observedBegin,
        observedEnd: armedRecovery.observedEnd !== null,
        controlResult: armedRecovery.control !== null,
        freshBytes: armedRecovery.freshBytes,
        freshChunks: armedRecovery.freshChunks,
        skippedOrdinaryAfterEnd: armedRecovery.skippedOrdinaryAfterEnd,
        acknowledgeable: armedRecovery.acknowledgeable,
      };
    },

    recoveryCounts() {
      return { ...recoveryCounts };
    },

    /**
     * A client's echo of a presentation nonce.
     *
     * The echo is the client's statement that its own local terminal-output `Writable` accepted every fresh
     * byte of this frame, in order. It is not the host's socket admission, not an OS flush, not a parse and not
     * a pixel, and this host cannot and does not check those.
     *
     * It clears `resync-required` only for an attempt this host already proved twice over: the matching
     * successful control result with its receipt identity, and the matching BEGIN/END observed on the byte
     * route. Without ordered framing there is no boundary at all and the echo still clears nothing.
     *
     * @param {AttachmentEpoch} epoch @param {unknown} nonce
     */
    acknowledgePresentation(epoch, nonce) {
      if (!orderedPresentation.active) {
        presentationCounts.acknowledgementsRefused += 1;
        return {
          cleared: false,
          reason: "presentation-delivery-boundary-unavailable",
          missingCapability: MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary,
        };
      }
      const asked = parseAttachmentEpoch(epoch);
      const attempt = armedRecovery;
      if (attempt === null || attempt.epoch.attachmentId !== asked.attachmentId || attempt.epoch.epoch !== asked.epoch) {
        presentationCounts.acknowledgementsRefused += 1;
        return { cleared: false, reason: "no-armed-recovery" };
      }
      if (!attempt.acknowledgeable) {
        presentationCounts.acknowledgementsRefused += 1;
        return {
          cleared: false,
          reason: attempt.control === null ? "control-result-outstanding" : "frame-boundary-not-observed",
          observedEnd: attempt.observedEnd !== null,
          controlResult: attempt.control !== null,
        };
      }
      // Geometry is revalidated here as well as on resize: an acknowledgement is about the screen this frame was
      // painted for, and this is the last moment before `resync-required` is cleared.
      if (attempt.geometryRevision !== geometryRevision) {
        retireRecovery("geometry-moved");
        presentationCounts.acknowledgementsRefused += 1;
        return { cleared: false, reason: "geometry-moved" };
      }
      const cleared = attachmentSet.acknowledgePresentation(asked, nonce);
      if (!cleared) {
        presentationCounts.acknowledgementsRefused += 1;
        return { cleared: false, reason: "acknowledgement-not-current" };
      }
      recoveryCounts.cleared += 1;
      retireRecovery(null);
      return { cleared: true, reason: null };
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
     * to any process by now. Both the recorded intent and the copy handed back are frozen, so nothing a
     * caller does afterwards can move the signal target or rewrite what a later exit is attributed to.
     *
     * @param {{ signal: NodeJS.Signals }} request
     */
    async stopOwner({ signal: requested }) {
      const reaped = owner.reapIfExited();
      if (reaped !== null) {
        return { signalled: false, reason: "already-reaped", exit: classifyOwnerExit({ reaped, stopIntent, owner: birthIdentity }) };
      }
      if (typeof requested !== "string" || requested.length === 0) {
        throw new PtyHostError("A stop names the signal it sends", { code: "PTY_HOST_INVALID_REQUEST" });
      }
      let current;
      try {
        current = await inspectIdentity(birthIdentity.pid);
      } catch {
        return { signalled: false, reason: "identity-unreadable" };
      }
      if (!sameIdentity(current, birthIdentity)) return { signalled: false, reason: "identity-changed" };
      stopIntent = Object.freeze({ signal: requested, identity: birthIdentity });
      signal(birthIdentity.processGroupId, requested);
      return { signalled: true, intent: Object.freeze({ signal: requested, identity: birthIdentity }) };
    },

    /** What this owner's exit can be said to be, from the published status and the recorded intent. */
    describeOwnerExit() {
      return classifyOwnerExit({ reaped: owner.reapIfExited(), stopIntent, owner: birthIdentity });
    },
  });
}
