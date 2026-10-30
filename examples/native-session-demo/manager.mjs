/**
 * One persistent native Pi owner, and the manager that holds it.
 *
 * The shape is deliberately thin. Pi is the whole product: it owns the editor, the draft, the transcript, the
 * key classification and every byte on the screen. This process owns three things Pi cannot own for itself —
 * the pseudo-terminal Pi runs on, which client a byte span came from, and when a cold client should be
 * repainted — and nothing else. There is no second viewer, no second editor, no replayed byte tail and no
 * reconstruction of Pi's state from what it drew.
 *
 * What happens, in order:
 *
 * 1. A control socket and seam E's bootstrap sideband are created in a `0700` directory. That directory is held
 *    open from the moment it is created, and every path this process or its child writes to, binds or unlinks
 *    inside it resolves through that descriptor: a root that is renamed or replaced under a running owner is
 *    never the thing this process touches. `stop` removes no tree at all and keeps the directory for inspection.
 * 2. One owner pseudo-terminal is opened and the real bundled CLI is launched on it, once, with a replaced
 *    environment: a disposable HOME, a disposable agent and session directory, no discovered extensions and
 *    no credential. The native spawn replaces the inherited environment rather than adding to it, so nothing
 *    of the operator's own configuration reaches the owner.
 * 3. Pi connects out to the sideband and reports `native-mounted` before extensions load. From that moment
 *    clients may attach and see output; nothing here waits for first paint or initialization.
 * 4. A client's bytes are forwarded to the in-process pre-TUI caller, which dispatches them as labelled
 *    native input under that client's attachment epoch. Pi frames and classifies them.
 * 5. An attach — first or later — asks Pi for one cold presentation, which renders a complete frame from the
 *    live component tree. The draft on that screen is Pi's own, not a copy of it.
 * 6. Detach closes client connections only. The owner keeps the same PID and start identity with zero
 *    clients attached, because this process still holds the terminal.
 */

import { chmod } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { ReadStream } from "node:tty";
import { fileURLToPath } from "node:url";

import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";
import {
  OWNER_SIDEBAND_SOCKET_ENV,
  OWNER_SIDEBAND_TOKEN_ENV,
  listenForOwnerSideband,
} from "../../runtime/native-sideband.mjs";
import { openOwnerPty } from "../../runtime/pty-mechanism.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "../../runtime/process-signaler.mjs";
import { ATTACH_PROTOCOL } from "./client.mjs";
import { startBootstrapSideband } from "./bootstrap-sideband.mjs";
import { resolveCohort } from "./cohort.mjs";
import { createRoot, demoPaths, tokenMatches, writeOwnerRecord } from "./demo-root.mjs";
import { createSavedOwnerRecord, writeSavedOwnerSnapshot } from "./saved-owner-record.mjs";
import { FAKE_MODEL_ID, FAKE_PROVIDER_ID } from "./fake-provider.mjs";
import { createPendingInputQueue } from "./pending-input.mjs";
import { ownerLaunchPlan } from "./owner-launch.mjs";
import { createFrameReader, encodeFrame, MAX_BODY_BYTES } from "./protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, "owner-preload.mjs");
const EXTENSION = path.join(HERE, "owner-extension.ts");

/** One shared geometry for every attachment. There is no per-client viewport and no controller role. */
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
/** A client this far behind is disconnected by name rather than being allowed to stall the owner. */
const CLIENT_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
/** Bytes a client may send before the in-Pi caller is ready. Admitted bytes are delivered in order, once. */
const PENDING_INPUT_LIMIT_BYTES = 64 * 1024;
const GRACEFUL_EXIT_WAIT_MS = 5_000;
/** How long `start` waits for Pi's own `native-mounted` before it reports a failure instead of a ready owner. */
const MOUNT_WAIT_MS = 60_000;
const STOP_POLICY = { gracefulMs: 3_000, terminateMs: 3_000 };

/**
 * What one owner generation may legitimately send, taken from the producer rather than chosen.
 *
 * `extension/pi-agents-owner.mjs` opens a bridge per `session_start` and, on that connection, calls
 * `announceBridgeReady()` once, `reportSeams()` at most once (only when it has a record to forward) and
 * `publishFacts()` once. A receipt is sent from `answerRequest`, once per host request that reached it. So
 * three of the four frame kinds are bounded at one per generation, and receipts are bounded by the requests
 * this manager actually sent on that generation — which is why continuing owner work is never capped: a new
 * request authorises exactly one more receipt.
 */
/**
 * How many of each announcement one owner generation may send.
 *
 * `owner-ready` and `owner-seams` are announced once by construction. `owner-facts` is a REPLACED SNAPSHOT -
 * the consumer keeps only the latest - so a generation may publish it repeatedly as the run progresses without
 * accumulating anything, which is what lets a row follow a session instead of freezing at startup.
 *
 * It therefore carries NO lifetime quota. `admit` counts every frame a generation has ever sent and refuses past
 * the budget, so any number here is a lifetime cut-off, not a rate limit: a budget of one refused the whole
 * generation the moment a second fact arrived, and a budget of 512 refused the long-running session it was meant
 * to protect at report 513. What bounds a flood of snapshots is what bounds the payload and what is retained -
 * the link's per-frame byte and queued-frame limits, `factsRecord`'s entry and text caps, and keeping only the
 * latest - none of which cares how many times the producer speaks. Readiness and the seam table keep their
 * budget of one, because a second of either is outside the contract rather than an update.
 */
const BRIDGE_FRAME_BUDGET = { "owner-ready": 1, "owner-seams": 1 };
/** How long a rename waits for the owner's own answer before reporting that it has no confirmation yet. */
const RENAME_CONFIRM_WAIT_MS = 5_000;
const RENAME_CONFIRM_POLL_MS = 25;
/**
 * How many generation events this manager keeps for inspection.
 *
 * Diagnostics are bounded and the current aggregates are not a history: an owner that reconnects in a loop
 * costs a bounded ring and a counter, not a growing array, a growing status response and a growing final
 * record. The oldest entries are dropped, and `droppedEvents` says how many.
 */
const BRIDGE_DIAGNOSTIC_EVENTS = 64;
/**
 * How many requests one generation may have unanswered at once.
 *
 * This is in-flight capacity, not a cap on how much work an owner may be asked to do over its lifetime. A peer
 * that never answers cannot make this manager hold unbounded `awaiting` records, and a peer that does answer
 * frees a slot immediately, so sequential requests continue indefinitely. When the window is full, admission
 * returns a named capacity result rather than silently evicting a still-authorized request, fabricating a
 * receipt, or refusing the owner's connection: Pi and every attachment are untouched by a full window.
 */
const BRIDGE_IN_FLIGHT_REQUESTS = 8;
/**
 * How much recent request and receipt detail is kept, by entry count and by serialized bytes.
 *
 * An entry count alone is not a bound: a request id or an error string may be near the wire's own 64 KiB frame
 * limit, so sixteen of them would still be a megabyte in every status response and in the final owner record.
 * Both limits apply, oldest first, and what was dropped is counted rather than hidden.
 */
const BRIDGE_RECENT_ENTRIES = 16;
const BRIDGE_RECENT_BYTES = 8_192;
/** How much of one stored string is kept. Long enough to identify, short enough that a ring cannot blow up. */
const BRIDGE_TEXT_LIMIT = 256;
/**
 * How much this consumer may ever write to the manager's log, by entries and by UTF-8 bytes.
 *
 * These diagnostics are not Pi's transcript and not an audit ledger: they are a non-authoritative account of what
 * the bridge did, and the manager appends them to a file that nothing rotates. Every legitimate request an owner
 * answers used to produce a line, so a healthy peer doing nothing wrong grew that file without bound - and so did
 * repeated reconnects, capacity refusals and generation refusals, which is why the budget belongs to the
 * consumer's whole lifetime and is not reset when a generation is superseded.
 *
 * What is bounded is only what gets written. Admission, authorization, in-flight accounting and the lifetime
 * totals are untouched: an owner may still be asked to do unlimited sequential work, and `logDropped` says
 * exactly how much of the account of it was not written down.
 */
const BRIDGE_LOG_ENTRIES = 64;
const BRIDGE_LOG_BYTES = 16_384;
/** One emitted line, clamped so a single line cannot consume the whole byte budget. */
const BRIDGE_LOG_LINE = 240;
/** The one notice written when the budget runs out. Its cost is reserved, so saying so cannot overrun. */
const BRIDGE_LOG_NOTICE = `owner bridge reached its lifetime log budget of ${BRIDGE_LOG_ENTRIES} entries and ${BRIDGE_LOG_BYTES} bytes; further bridge lines are counted in counts.logDropped and not written`;
const BRIDGE_LOG_NOTICE_BYTES = Buffer.byteLength(BRIDGE_LOG_NOTICE, "utf8") + 1;
const LIST_STATUS_FIELDS = [
  "root", "owner", "geometry", "geometryRevision", "attach", "provider", "providerIsFake", "ownerMode", "projectCwd",
  "ingressReady", "attachments", "reaped", "exit", "ownerAliveWithZeroClients", "atMs",
];

/** Protocol 1 addition: old callers retain full detail when it fits; list callers omit diagnostic history.
 * @param {any} status @param {unknown} detail
 */
function encodeStatusResponse(status, detail) {
  if (detail !== "list") {
    try { return encodeFrame({ type: "status", status }); }
    catch (error) { if (error.code !== "DEMO_HEADER_TOO_LARGE") throw error; }
  }
  const summary = {
    ...Object.fromEntries(LIST_STATUS_FIELDS.map((key) => [key, status[key]])),
    bridge: { facts: status.bridge?.facts },
    durable: status.durable == null ? null : { ownerId: status.durable.ownerId },
  };
  try { return encodeFrame({ type: "status", status: summary, detailsOmitted: true }); }
  catch (error) {
    if (error.code !== "DEMO_HEADER_TOO_LARGE") throw error;
    return encodeFrame({ type: "refused", text: "Essential status exceeds the protocol header limit; full diagnostics remain in the owner record" });
  }
}

/**
 * The consumer side of the owner management bridge: one active generation, bounded retention.
 *
 * Two properties this owes its caller, both of which the previous shape got wrong.
 *
 * **One active generation.** A second connection supersedes the first, and the first is closed rather than
 * left running. Every frame, close callback and request completion is scoped to the generation it belongs
 * to, so a late event from a superseded owner cannot alter the current one. Current facts are the active
 * generation's own latest snapshot, replaced wholesale: a fact that generation omits because it could not
 * read it is absent, and does not survive from an older generation's snapshot.
 *
 * **Bounded retention.** Current owner facts are not a lifetime event log. The aggregates below are the
 * active generation's current state plus counters and a bounded diagnostic ring, so an authenticated peer
 * cannot grow this process's memory, its log, a status response or the final owner record by sending valid
 * frames forever. A generation that exceeds its budget, or answers a request nobody made, has *its*
 * connection closed and the reason recorded — Pi is not stopped and no attachment is touched.
 *
 * @param {{ log: (line: string) => void, maxDiagnosticEvents?: number, now?: () => number }} options
 */
/** One stored string, clamped so a value near the wire limit cannot become a megabyte of status. @param {unknown} value */
function boundedText(value) {
  return typeof value === "string" ? value.slice(0, BRIDGE_TEXT_LIMIT) : value;
}

/**
 * A ring bounded by both entry count and serialized bytes, which reports what it dropped.
 *
 * Retention is diagnostics, never authorization: dropping the oldest entry does not cancel work and does not
 * remove an in-flight request from `awaiting`. `dropped` is what makes the difference visible instead of a
 * status response that silently shortens.
 */
function boundedRing(entries = BRIDGE_RECENT_ENTRIES, bytes = BRIDGE_RECENT_BYTES) {
  /** @type {{ value: any, size: number }[]} */
  const held = [];
  let size = 0;
  let dropped = 0;
  return {
    /** @param {any} value */
    add(value) {
      const measured = JSON.stringify(value)?.length ?? 0;
      held.push({ value, size: measured });
      size += measured;
      while (held.length > entries || (size > bytes && held.length > 1)) {
        const oldest = held.shift();
        size -= oldest?.size ?? 0;
        dropped += 1;
      }
    },
    values: () => held.map((entry) => entry.value),
    dropped: () => dropped,
  };
}

export function createBridgeConsumer({ log, maxDiagnosticEvents = BRIDGE_DIAGNOSTIC_EVENTS, now = Date.now, onFacts }) {
  let generations = 0;
  /** @type {any} */
  let active;
  /** @type {any[]} */
  const events = [];
  let droppedEvents = 0;
  const counts = { frames: 0, refusedGenerations: 0, supersededGenerations: 0 };

  let logEmitted = 0;
  let logBytes = 0;
  let logDropped = 0;
  let logNoticed = false;

  /**
   * Write one bridge diagnostic line, or count it as dropped.
   *
   * Every log path in this consumer goes through here, so the budget covers request lines, capacity refusals,
   * generation refusals, close failures, connects and supersessions alike - bounding only the request line would
   * leave reconnect churn unbounded. The budget is this consumer's, not a generation's, so it is not refilled by
   * a peer that reconnects. When it runs out, exactly one notice is written saying so and naming the counter that
   * carries the rest; after that the lines are counted and discarded.
   * @param {string} line
   */
  const emit = (line) => {
    const text = line.length > BRIDGE_LOG_LINE ? `${line.slice(0, BRIDGE_LOG_LINE)}…` : line;
    const size = Buffer.byteLength(text, "utf8") + 1;
    // One entry and its bytes are held back for the notice, so the line that says the budget ran out is not
    // itself what overruns it.
    const fits = logEmitted + 1 < BRIDGE_LOG_ENTRIES && logBytes + size + BRIDGE_LOG_NOTICE_BYTES <= BRIDGE_LOG_BYTES;
    if (!fits) {
      logDropped += 1;
      if (logNoticed) return;
      logNoticed = true;
      logEmitted += 1;
      logBytes += BRIDGE_LOG_NOTICE_BYTES;
      log(BRIDGE_LOG_NOTICE);
      return;
    }
    logEmitted += 1;
    logBytes += size;
    log(text);
  };

  /** @param {Record<string, unknown>} event */
  const note = (event) => {
    events.push({ ...event, atHostMs: now() });
    while (events.length > maxDiagnosticEvents) {
      events.shift();
      droppedEvents += 1;
    }
  };

  /** Close one generation's connection and record why. The connection is asked once, and never awaited. @param {any} owner @param {string} reason */
  const refuse = (owner, reason) => {
    if (owner.refusal !== null) return;
    owner.refusal = reason;
    counts.refusedGenerations += 1;
    note({ type: "bridge-refused", generation: owner.generation, reason });
    emit(`owner bridge generation ${owner.generation} refused: ${reason}`);
    try {
      owner.connection.close();
    } catch (error) {
      emit(`owner bridge generation ${owner.generation} close failed: ${/** @type {Error} */ (error).message}`);
    }
  };

  /** @param {any} owner @param {any} frame */
  const admit = (owner, frame) => {
    // A frame from a generation that is no longer this manager's owner changes nothing at all.
    if (owner !== active) {
      note({ type: "bridge-late-frame", generation: owner.generation, frameType: frame.type });
      return;
    }
    if (owner.refusal !== null) return;
    counts.frames += 1;
    owner.seen[frame.type] = (owner.seen[frame.type] ?? 0) + 1;
    const budget = BRIDGE_FRAME_BUDGET[/** @type {keyof typeof BRIDGE_FRAME_BUDGET} */ (frame.type)];
    if (budget !== undefined && owner.seen[frame.type] > budget) {
      refuse(owner, `sent ${owner.seen[frame.type]} ${frame.type} frames and this owner generation may send ${budget}`);
      return;
    }
    if (frame.type === "owner-ready") {
      owner.readyPhases.push(frame.phase);
      return;
    }
    if (frame.type === "owner-seams") {
      owner.reportedSeams = frame.reported;
      return;
    }
    if (frame.type === "owner-facts") {
      // A full snapshot replaces the previous one. Merging would keep a value this snapshot omitted.
      owner.facts = frame.facts;
      // The manager's own cue to persist. Facts arrive here whether or not any frontend is attached, which is what
      // keeps durable state advancing while every dashboard is closed.
      try {
        onFacts?.(owner.facts);
      } catch {
        // A persistence hook that throws must not refuse the generation that published the facts.
      }
      return;
    }
    if (frame.type === "owner-receipt") {
      const pending = owner.awaiting.get(frame.requestId);
      if (pending === undefined) {
        refuse(owner, `answered request ${frame.requestId}, which this manager did not send on generation ${owner.generation}`);
        return;
      }
      owner.awaiting.delete(frame.requestId);
      owner.totals.receipted += 1;
      // A projection of the receipt contract's own fields. Keeping the frame verbatim would let whatever a
      // peer attached to it size every status response and the final owner record.
      owner.receipts.add({
        type: frame.type,
        requestId: boundedText(frame.requestId),
        request: frame.request,
        outcome: frame.outcome,
        idle: frame.idle,
        pendingMessages: frame.pendingMessages,
      });
      return;
    }
    // `validateOwnerFrame` admits no other kind, so reaching here means the two ends disagree about the wire.
    refuse(owner, `sent an unsolicited ${String(frame.type)} frame`);
  };

  return {
    /** @param {any} connection */
    adopt(connection) {
      const previous = active;
      generations += 1;
      const owner = {
        generation: generations,
        connection,
        readyPhases: /** @type {string[]} */ ([]),
        /** @type {Record<string, unknown>|undefined} */
        facts: undefined,
        /** @type {unknown} */
        reportedSeams: undefined,
        // In-flight only: an entry lives here until its receipt arrives or its write fails. It is the one
        // structure a silent peer could grow, which is why admission is windowed rather than unlimited.
        awaiting: new Map(),
        requests: boundedRing(),
        receipts: boundedRing(),
        // Lifetime counters. These are what stay truthful about how much legitimate work happened.
        totals: { requested: 0, sent: 0, refused: 0, receipted: 0, capacityRefusals: 0 },
        seen: /** @type {Record<string, number>} */ ({}),
        /** @type {string|null} */
        refusal: null,
        connectedAtMs: now(),
        closed: false,
      };
      active = owner;
      note({ type: "bridge-connected", generation: owner.generation });
      emit(`owner bridge generation ${owner.generation} connected`);
      if (previous !== undefined && !previous.closed) {
        counts.supersededGenerations += 1;
        note({ type: "bridge-superseded", generation: previous.generation, by: owner.generation });
        emit(`owner bridge generation ${previous.generation} superseded by ${owner.generation}`);
        try {
          previous.connection.close();
        } catch (error) {
          emit(`owner bridge generation ${previous.generation} close failed: ${/** @type {Error} */ (error).message}`);
        }
      }
      connection.onFrame((/** @type {any} */ frame) => admit(owner, frame));
      void connection.closed.then((/** @type {any} */ outcome) => {
        owner.closed = true;
        note({ type: "bridge-closed", generation: owner.generation, refusal: outcome?.refusal ?? null });
        emit(`owner bridge generation ${owner.generation} closed: ${JSON.stringify(outcome)}`);
      });
      return owner.generation;
    },

    /**
     * Ask the current owner to end or abort its own session, and record what it answered.
     *
     * The receipt says what was asked and what the session looked like when it was asked. It is **not** a
     * stop: `ctx.shutdown()` is request-only and idle-deferred, so only this manager observing a reaped exit
     * and an absent owner ends anything. The request is recorded against the generation it was sent on, which
     * is what makes a receipt from any other generation unsolicited.
     * rename: the one request carrying an argument, and the one that is capability-gated. An owner built
     * before rename existed validates the frame as `malformed-frame`, and a refusal DESTROYS the link - so a
     * speculative send would take down the bridge of exactly the session it was trying to rename. The gate is
     * therefore local and belongs to the generation being written to: the capability must be advertised by the
     * facts of the CURRENT owner generation, re-read at this boundary rather than cached from a previous owner.
     *
     * @param {"stop"|"abort"|"rename"|"color"} request @param {string} requestId @param {string} [name]
     */
    async request(request, requestId, name) {
      const owner = active;
      if (owner === undefined || owner.closed || owner.refusal !== null) {
        const absent = { request, requestId: null, generation: owner?.generation ?? null, admitted: false, sent: false, reason: "no owner generation is currently connected to the bridge", atHostMs: now() };
        note({ type: "bridge-request", request, sent: false, generation: absent.generation });
        return absent;
      }
      owner.totals.requested += 1;
      const capability = request === "rename" ? "renameSupported" : request === "color" ? "colorSupported" : undefined;
      if (capability !== undefined && owner.facts?.[capability] !== true) {
        // Named locally, nothing sent, nothing torn down. Read from this generation's own latest snapshot, so a
        // capability a previous owner advertised - or one this owner has since withdrawn - never authorizes it.
        const unsupported = {
          request,
          requestId: null,
          generation: owner.generation,
          admitted: false,
          sent: false,
          reason: `this owner generation does not advertise ${request} support, so no ${request} was sent to it`,
          atHostMs: now(),
        };
        note({ type: "bridge-request-unsupported", request, generation: owner.generation });
        emit(`owner bridge ${request} request refused on generation ${owner.generation}: ${request} support is not advertised`);
        return unsupported;
      }
      if (owner.awaiting.size >= BRIDGE_IN_FLIGHT_REQUESTS) {
        // A named capacity result, not an eviction and not a fabricated receipt. The requests already in flight
        // stay authorized and stay answerable; this one was never sent, so nothing is owed for it. Pi and every
        // attachment are untouched, and the next call succeeds as soon as one answer arrives.
        owner.totals.capacityRefusals += 1;
        const full = {
          request,
          requestId: null,
          generation: owner.generation,
          admitted: false,
          sent: false,
          reason: `this owner generation already has ${owner.awaiting.size} unanswered requests, which is its in-flight capacity`,
          inFlight: owner.awaiting.size,
          atHostMs: now(),
        };
        note({ type: "bridge-request-capacity", request, generation: owner.generation, inFlight: owner.awaiting.size });
        emit(`owner bridge ${request} request refused on generation ${owner.generation}: in-flight capacity ${owner.awaiting.size} reached`);
        return full;
      }
      const record = { request, requestId, generation: owner.generation, admitted: true, sent: false, reason: /** @type {string|null} */ (null), atHostMs: now() };
      // Recorded before the write, so a receipt that arrives while the write is still settling is expected.
      owner.awaiting.set(requestId, record);
      try {
        if (request === "rename") await owner.connection.requestRename(requestId, name);
        else if (request === "color") await owner.connection.requestColor(requestId, name);
        else if (request === "stop") await owner.connection.requestStop(requestId);
        else await owner.connection.requestAbort(requestId);
        record.sent = true;
        owner.totals.sent += 1;
      } catch (error) {
        // A write that failed is not in flight, so its slot is returned rather than held against the peer.
        owner.awaiting.delete(requestId);
        record.reason = boundedText(/** @type {Error} */ (error).message);
        owner.totals.refused += 1;
      }
      owner.requests.add({
        request: record.request,
        requestId: boundedText(record.requestId),
        generation: record.generation,
        admitted: record.admitted,
        sent: record.sent,
        reason: record.reason,
        atHostMs: record.atHostMs,
      });
      note({ type: "bridge-request", request, sent: record.sent, generation: owner.generation });
      emit(`owner bridge ${request} request ${String(requestId).slice(0, 64)} on generation ${owner.generation}: ${record.sent ? "sent" : `refused (${record.reason})`}`);
      return record;
    },

    /**
     * The current owner's state, and bounded diagnostics. Never a frame history.
     *
     * Everything above `diagnostics` belongs to the one active generation. `readyPhases` therefore holds at
     * most the single `bridge` phase that generation announced, and a reload does not accumulate a second.
     */
    status() {
      const owner = active;
      return {
        connected: owner !== undefined && !owner.closed && owner.refusal === null,
        generation: owner?.generation ?? 0,
        generations,
        readyPhases: [...(owner?.readyPhases ?? [])],
        facts: owner?.facts === undefined ? {} : { ...owner.facts },
        reportedSeams: owner?.reportedSeams === undefined ? [] : [owner.reportedSeams],
        // Bounded recent detail plus lifetime totals. Neither grows with how much legitimate work an owner did.
        receipts: owner?.receipts.values() ?? [],
        requests: owner?.requests.values() ?? [],
        inFlightRequests: owner?.awaiting.size ?? 0,
        inFlightCapacity: BRIDGE_IN_FLIGHT_REQUESTS,
        totals: owner === undefined
          ? { requested: 0, sent: 0, refused: 0, receipted: 0, capacityRefusals: 0, droppedRequests: 0, droppedReceipts: 0 }
          : { ...owner.totals, droppedRequests: owner.requests.dropped(), droppedReceipts: owner.receipts.dropped() },
        refusal: owner?.refusal ?? null,
        // Additive: the existing count names are unchanged, and these say how much of this consumer's own
        // account of its work was written and how much was only counted.
        counts: {
          ...counts,
          droppedEvents,
          logEmitted,
          logDropped,
          logBudgetEntries: BRIDGE_LOG_ENTRIES,
          logBudgetBytes: BRIDGE_LOG_BYTES,
        },
        diagnostics: [...events],
      };
    },

    /** The active generation's connection, or `undefined`. Exposed for the stop path's own bookkeeping. */
    activeGeneration() {
      return active === undefined || active.closed || active.refusal !== null ? undefined : active.generation;
    },
  };
}

/** The launch-fixed profile. The owner decides it before Pi negotiates; no client can change it. */
function launchProfile(cols, rows) {
  return {
    profileId: "native-session-demo-owner",
    term: "xterm-256color",
    capabilities: {
      kittyKeyboard: true,
      kittyGraphics: false,
      mouse: true,
      bracketedPaste: true,
      synchronizedOutput: true,
      trueColor: true,
    },
    cellSize: null,
    geometry: { cols, rows },
  };
}

/**
 * @param {{ root: string, cols?: number, rows?: number, manifestPath?: string, cohortRoot?: string, log: (line: string) => void, onReady: (record: any) => void }} options
 */
export async function runManager({ root, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, manifestPath, cohortRoot, mode = "fake", projectCwd, initialPromptFile, requestedProvider, requestedModel, requestedName, stateHome, piConfigHome, log: echo, onReady }) {
  const startedAtMs = Date.now();
  const ownerMode = mode;
  const cohort = resolveCohort({ manifestPath, cohortRoot });
  const { paths, token, anchor } = await createRoot(root);
  // Every path this owner writes to, binds or unlinks. `paths` is the operator's spelling, for reporting only.
  const owned = demoPaths(anchor.anchoredRoot);
  const profile = launchProfile(cols, rows);

  /**
   * This owner's saved record, when the operator asked for a records home.
   *
   * Metadata only. Pi owns storage: it selects its own session directory from its own configuration, and this
   * record simply remembers what Pi reported so a later dashboard can find the session again. Allocated before the
   * owner is spawned so a dashboard opening immediately cannot see a live owner with no record at all. Absent
   * `stateHome` nothing here runs and the legacy behaviour is unchanged.
   */
  let saved;
  if (typeof stateHome === "string" && stateHome.trim() !== "") {
    saved = await createSavedOwnerRecord({ recordsHome: stateHome, sessionId: path.basename(root), runtimeRoot: root });
  }
  /** Monotonic, so a late or duplicated snapshot can never replace a newer session or exit snapshot. */
  let durableSequence = 0;
  /** Serialized: snapshots are committed in causal order, one at a time. */
  let durableChain = Promise.resolve();
  /** @type {string|null} */
  let durableFailure = null;

  /**
   * Commit one saved-record snapshot, manager-side.
   *
   * Deliberately not driven by any frontend read: the facts arrive on this manager's own bridge and the exit comes
   * from its own wait, so the record keeps advancing while every dashboard is closed. A failure is recorded and
   * reported as a named storage failure rather than becoming an empty success or a silent fallback.
   *
   * @param {{ exit?: any, stopped?: boolean }} [options]
   */
  const commitDurable = (options = {}) => {
    if (saved === undefined) return durableChain;
    const sequence = ++durableSequence;
    const facts = Object.freeze({ ...bridgeConsumer.status().facts });
    durableChain = durableChain.then(async () => {
      try {
        await writeSavedOwnerSnapshot(saved, {
          sequence,
          owner: ownerIdentity,
          cwd: projectCwd,
          facts,
          exit: options.exit ?? exitRecord ?? null,
          stopped: options.stopped === true,
        });
      } catch (error) {
        durableFailure = `${/** @type {any} */ (error).code ?? "OWNER_RECORD_WRITE_FAILED"}: ${/** @type {Error} */ (error).message}`;
        log(`saved owner record failure: ${durableFailure}`);
      }
    });
    return durableChain;
  };

  /**
   * One line, in this owner's own log file and on the caller's stream.
   *
   * The file is appended through the held descriptor, so a replaced root never receives this owner's log. Once
   * `stop` has released that descriptor the line is still echoed but no longer appended: this owner has let go
   * of the directory it was writing to, and re-resolving the path to keep logging is the mistake this avoids.
   */
  const log = (line) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    try {
      appendFileSync(owned.log, entry);
    } catch {
      // A log that cannot be written must not stop the owner.
    }
    echo(line);
  };

  /** Every attachment the manager has ever issued, so an epoch is never reused for an attachment id. */
  const epochs = new Map();
  /** @type {Map<string, { id: string, epoch: number, socket: net.Socket, notices: string[] }>} */
  const clients = new Map();
  /** @type {net.Socket | undefined} */
  let ingress;
  /** Ingress callers that have connected but not yet announced readiness. They are never the input path. */
  const ingressCandidates = new Set();
  let ingressReady = false;
  /**
   * The one geometry this session's single Pi terminal is at.
   *
   * There is ONE shared Pi terminal, not a layout per client, so this is a single mutable value rather than
   * anything per attachment. The policy, stated plainly: **the most recent attaching or resizing client sets
   * the shared size, and every attachment then sees that size.** A second terminal of a different size joining,
   * or being dragged, moves the shared terminal - the honest consequence of one Pi rendering once.
   *
   * The launch-fixed `profile` is deliberately NOT updated: it carries negotiated capabilities, which do not
   * change, and Pi refuses a differing profile after negotiation. Rows and columns are mutable and live here.
   */
  let geometry = { cols, rows };
  let geometryRevision = 1;
  /** Refused resize attempts, bounded, so a rejection is visible rather than silent. */
  const geometryRefusals = [];
  /** Bytes a client sent before the in-Pi caller was ready: bounded before admission, drained in order. */
  const pendingInput = createPendingInputQueue(PENDING_INPUT_LIMIT_BYTES);
  let inputSequence = 0;
  /** @type {any[]} */
  const readiness = [];
  /** @type {any[]} */
  const presentations = [];
  /** @type {any[]} */
  const childPhases = [];
  /** Every in-Pi return gesture the manager acted on: which terminal asked, and when. Owner untouched. */
  const returns = [];
  let bootstrapHello;
  /**
   * The owner's identity, promised to the bootstrap sideband before Pi exists.
   *
   * This listener has to be up before Pi is spawned, and `openOwnerPty` only names the owner after it has
   * spawned it and read its birth proc snapshot - so a hello can arrive while this is still unresolved. The
   * sideband holds such a claim rather than granting or discarding it, which is why a promise is handed over
   * instead of a getter that would read `undefined` and have to guess.
   */
  let identifyOwnerForSideband;
  /** @type {Promise<number>} */
  const ownerIdentifiedForSideband = new Promise((resolve) => {
    identifyOwnerForSideband = resolve;
  });
  let stopping = false;
  /** @type {any} */
  let exitRecord = null;
  /** Resolved when Pi records `native-mounted`: the phase at which a client can attach and see output. */
  let resolveMounted;
  const mounted = new Promise((resolve) => {
    resolveMounted = resolve;
  });

  const noteReadiness = (entry) => {
    readiness.push(entry);
    if (entry.phase === "native-mounted") resolveMounted(entry);
  };

  const sideband = await startBootstrapSideband(owned.bootstrapSocket, {
    onFrame: (frame) => {
      if (frame.type === "native-bootstrap") {
        bootstrapHello = frame;
        for (const entry of frame.reached ?? []) noteReadiness({ ...entry, viaHello: true, atHostMs: Date.now() });
        log(`sideband hello: pid ${frame.pid}, seam ${frame.capability?.seam}, reached ${(frame.reached ?? []).map((e) => e.phase).join(",") || "none"}`);
      } else if (frame.type === "native-readiness") {
        noteReadiness({ ...frame.readiness, atHostMs: Date.now() });
        log(`readiness ${frame.readiness.phase} at ${Date.now() - startedAtMs}ms`);
      } else if (frame.type === "error") {
        log(`sideband error: ${JSON.stringify(frame.error)}`);
      }
    },
    onError: (error) => log(`sideband transport: ${error.message}`),
    // Only the owner's own hello may take the channel, which is what stops a spawned tool that inherited this
    // socket's path from displacing it and leaving a running session unable to repaint. The trust boundary is
    // still filesystem permission - a 0600 socket inside a 0700 root - and a claimed pid is not a credential;
    // it is what separates the owner from its own descendants on the far side of that boundary.
    whenOwnerPid: ownerIdentifiedForSideband,
  });

  /**
   * The owner management bridge: the reviewed sideband, listening before Pi is spawned.
   *
   * It is bound first so the endpoint already exists when the in-Pi extension connects out; the extension
   * opens it beside startup and never in front of it, so a bridge that never connects leaves the demo's own
   * path untouched. Nothing here is a readiness source for the demo: the mounted, ready and painted receipts
   * come from seam E's core bootstrap above, and the only phase this channel reports is `bridge`.
   */
  const bridgeToken = randomBytes(32).toString("hex");
  const bridgeConsumer = createBridgeConsumer({ log, onFacts: () => commitDurable() });
  const bridge = await listenForOwnerSideband({ socketPath: owned.sidebandSocket, token: bridgeToken });
  log(`owner bridge listening at ${owned.sidebandSocket}`);

  /** Accept bridge generations for as long as this listener is open. A closed listener rejects, and ends this. */
  const acceptBridgeOwners = async () => {
    for (;;) {
      let connection;
      try {
        connection = await bridge.nextOwner();
      } catch {
        return;
      }
      bridgeConsumer.adopt(connection);
    }
  };
  void acceptBridgeOwners();

  /** @param {"stop"|"abort"|"rename"|"color"} request @param {string} [name] */
  const requestThroughBridge = (request, name) => bridgeConsumer.request(request, randomUUID(), name);

  /**
   * Ask the owner to rename itself, then report the name the owner CONFIRMED.
   *
   * The send resolving only means the frame was written. The owner republishes its facts from Pi's own
   * `getSessionName` before it answers, so this waits for that generation's receipt and then reads the facts.
   * A wait that times out reports no confirmed name rather than echoing the requested one back as if it landed.
   * @param {unknown} name
   */
  const renameThroughBridge = async (name) => {
    const requested = typeof name === "string" ? name : null;
    const record = await requestThroughBridge("rename", typeof name === "string" ? name : undefined);
    const answered = () => bridgeConsumer.status().receipts.some((receipt) => receipt.requestId === record.requestId);
    if (record.sent === true) {
      for (let waited = 0; waited < RENAME_CONFIRM_WAIT_MS && !answered(); waited += RENAME_CONFIRM_POLL_MS) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_CONFIRM_POLL_MS));
      }
    }
    const facts = bridgeConsumer.status().facts ?? {};
    return {
      sent: record.sent === true,
      answered: answered(),
      reason: record.reason ?? null,
      requestedName: requested,
      confirmedName: typeof facts.sessionName === "string" ? facts.sessionName : null,
      renameError: typeof facts.renameError === "string" ? facts.renameError : null,
    };
  };

  /**
   * Ask the owner to change its colour through session-color, then report the colour the owner CONFIRMED in its
   * republished facts, exactly as `renameThroughBridge` does for a name. @param {unknown} color
   */
  const colorThroughBridge = async (color) => {
    const record = await requestThroughBridge("color", typeof color === "string" ? color : undefined);
    const answered = () => bridgeConsumer.status().receipts.some((receipt) => receipt.requestId === record.requestId);
    if (record.sent === true) {
      for (let waited = 0; waited < RENAME_CONFIRM_WAIT_MS && !answered(); waited += RENAME_CONFIRM_POLL_MS) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_CONFIRM_POLL_MS));
      }
    }
    const facts = bridgeConsumer.status().facts ?? {};
    return { sent: record.sent === true, answered: answered(), reason: record.reason ?? null,
      confirmedColor: typeof facts.sessionColor === "string" ? facts.sessionColor : null };
  };

  const launch = ownerLaunchPlan({
    mode: ownerMode,
    preload: PRELOAD,
    extension: EXTENSION,
    bundledCli: cohort.bundledCli,
    tuiPackageRoot: cohort.tuiPackageRoot,
    profile,
    cols,
    rows,
    owned,
    token,
    bridgeToken,
    // Pi owns storage and selects its own session directory. The demo supplies only a private Pi CONFIGURATION
    // home for fake automation, which is test configuration of Pi rather than a transcript-store convention.
    piConfigHome,
    sidebandSocketEnv: OWNER_SIDEBAND_SOCKET_ENV,
    sidebandTokenEnv: OWNER_SIDEBAND_TOKEN_ENV,
    fakeProviderId: FAKE_PROVIDER_ID,
    fakeModelId: FAKE_MODEL_ID,
    cwd: projectCwd,
    initialPromptFile,
    requestedProvider,
    requestedModel,
    requestedName,
  });
  const ownerEnv = launch.env;
  const ownerArgs = launch.args;

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // Bound through the held descriptor, not through `root`: closing this listener unlinks the pathname it bound,
    // so binding the operator's spelling would hand that unlink to whatever holds the path at teardown.
    server.listen(owned.controlSocket, () => resolve(undefined));
  });
  await chmod(owned.controlSocket, 0o600);

  // `launch.cwd` and not `owned.project`: the isolation mode decided where this session's agent runs, and
  // hardcoding the sealed project directory here silently discarded that decision.
  const handle = await openOwnerPty({ command: process.execPath, args: ownerArgs, env: ownerEnv, cwd: launch.cwd, cols, rows });
  // The one place this process takes the master descriptor into a stream. The stream owns its lifetime from
  // here on, so nothing else closes that fd: a second close could land on a descriptor the runtime recycled.
  const ownerOutput = new ReadStream(handle.masterFd);
  ownerOutput.on("error", (error) => log(`owner terminal read: ${error.message}`));

  const ownerIdentity = { ...handle.owner, launchedAtMs: startedAtMs };
  identifyOwnerForSideband(handle.owner.pid);
  log(`owner pid ${ownerIdentity.pid}, startIdentity ${ownerIdentity.startIdentity}, session ${ownerIdentity.sessionId}, geometry ${cols}x${rows}`);

  const send = (socket, header, body) => {
    if (socket.destroyed) return;
    try {
      socket.write(encodeFrame(header, body));
    } catch (error) {
      log(`frame write failed: ${/** @type {Error} */ (error).message}`);
    }
  };

  const resumeOwnerOutputIfDrained = () => {
    if (stopping) return;
    for (const client of clients.values()) {
      if (client.socket.writableLength > CLIENT_BUFFER_LIMIT_BYTES / 4) return;
    }
    ownerOutput.resume();
  };

  // One ordered fan-out of the owner's own bytes. Nothing is retained for a later client: a reattachment is
  // repainted by Pi, not replayed from here.
  ownerOutput.on("data", (chunk) => {
    for (let offset = 0; offset < chunk.byteLength; offset += MAX_BODY_BYTES) {
      const slice = chunk.subarray(offset, Math.min(offset + MAX_BODY_BYTES, chunk.byteLength));
      for (const client of clients.values()) send(client.socket, { type: "output" }, slice);
    }
    for (const client of clients.values()) {
      if (client.socket.writableLength > CLIENT_BUFFER_LIMIT_BYTES) {
        log(`client ${client.id} epoch ${client.epoch} is ${client.socket.writableLength} bytes behind; disconnecting it rather than stalling the owner`);
        detachClient(client, "backpressure: this client fell too far behind the owner's output");
      } else if (client.socket.writableLength > CLIENT_BUFFER_LIMIT_BYTES / 4) {
        ownerOutput.pause();
      }
    }
  });

  /** @param {{ id: string, epoch: number, socket: net.Socket }} client @param {string} reason */
  function detachClient(client, reason) {
    if (!clients.has(client.id)) return;
    clients.delete(client.id);
    send(client.socket, { type: "bye", reason });
    client.socket.end();
    log(`detached ${client.id} epoch ${client.epoch}: ${reason}`);
    resumeOwnerOutputIfDrained();
  }

  /** @param {unknown} value */
  const usableDimension = (value) => Number.isInteger(value) && value >= 2 && value <= 1000;

  /**
   * Apply one client's requested size to the shared terminal.
   *
   * The resize reaches the owner through the PTY master (`TIOCSWINSZ` in `openOwnerPty.resize`), which is what
   * makes Pi redraw: the owner and every child share that one size and Pi reacts to `SIGWINCH` as it would in
   * any terminal. This is not a banner and not a spawn-time environment value.
   *
   * @param {{ id: string, epoch: number, socket: net.Socket }} client @param {any} header
   */
  function applyResize(client, header) {
    const refuseResize = (reason) => {
      geometryRefusals.push({ attachmentId: client.id, epoch: header.epoch ?? null, cols: header.cols ?? null, rows: header.rows ?? null, reason, atMs: Date.now() });
      if (geometryRefusals.length > 32) geometryRefusals.splice(0, geometryRefusals.length - 32);
      log(`refused a resize from ${client.id}: ${reason}`);
      send(client.socket, { type: "notice", text: `resize refused: ${reason}` });
    };
    // The epoch the attachment actually holds, so a stale or invented one cannot move the shared terminal.
    if (header.epoch !== undefined && header.epoch !== client.epoch) {
      refuseResize(`epoch ${JSON.stringify(header.epoch)} is not this attachment's epoch ${client.epoch}`);
      return;
    }
    if (!usableDimension(header.cols) || !usableDimension(header.rows)) {
      refuseResize(`${JSON.stringify(header.cols)}x${JSON.stringify(header.rows)} is not a usable terminal size`);
      return;
    }
    if (header.cols === geometry.cols && header.rows === geometry.rows) return;
    try {
      handle.resize(header.cols, header.rows);
    } catch (error) {
      refuseResize(`the owner's terminal refused the resize: ${/** @type {Error} */ (error).message}`);
      return;
    }
    geometry = { cols: header.cols, rows: header.rows };
    geometryRevision += 1;
    log(`shared terminal resized to ${geometry.cols}x${geometry.rows} by ${client.id} epoch ${client.epoch} (revision ${geometryRevision})`);
    for (const attached of clients.values()) {
      send(attached.socket, { type: "geometry", cols: geometry.cols, rows: geometry.rows, geometryRevision, setBy: client.id });
    }
  }

  function forwardInput(entry) {
    inputSequence += 1;
    send(ingress, { type: "input", sequence: inputSequence, attachmentId: entry.attachmentId, epoch: entry.epoch, generation: entry.generation }, entry.bytes);
  }

  function flushPendingInput() {
    for (const entry of pendingInput.drain()) forwardInput(entry);
  }

  /**
   * Ask Pi to repaint the whole screen for one attachment, and say plainly whether it did.
   *
   * This is the ONLY thing that makes a reattachment's screen correct. Pi renders incrementally, so an
   * attachment that opens without a cold presentation inherits whatever was on the terminal and an editor whose
   * believed cursor is not the real one. Attaching anyway is what produced "my text ends up in the wrong place",
   * so the answer here decides whether the attachment is allowed to proceed at all.
   *
   * @returns {Promise<{ presented: true }|{ presented: false, reason: string }>}
   */
  async function presentTo(client) {
    // Pi connects this socket from `main()` while it is still loading, before its renderer exists. A present
    // request then waits behind that loading and is refused, so an early attachment waits for `native-mounted`.
    await Promise.race([mounted, sleep(MOUNT_WAIT_MS)]);
    if (!sideband.connected()) {
      const reason = "Pi is not connected to the bootstrap sideband, so no cold presentation could be requested";
      presentations.push({ attachmentId: client.id, epoch: client.epoch, requestedAtMs: Date.now(), error: reason });
      log(`cold presentation for ${client.id} refused: ${reason}`);
      return { presented: false, reason };
    }
    const requestedAtMs = Date.now();
    try {
      const result = await sideband.present({ attachmentId: client.id, epoch: client.epoch, geometryRevision });
      const record = { attachmentId: client.id, epoch: client.epoch, requestedAtMs, elapsedMs: Date.now() - requestedAtMs, result };
      presentations.push(record);
      log(`cold presentation for ${client.id} epoch ${client.epoch}: ${JSON.stringify(result)} in ${record.elapsedMs}ms`);
      // Pi answering is not Pi presenting. Its own result says which, and only `presented` is a usable screen.
      if (result?.presented !== true) {
        return { presented: false, reason: `Pi answered the presentation request without presenting: ${JSON.stringify(result)}` };
      }
      // The confirmation the frontend requires before it accepts the welcome. Additive, and scoped to THIS
      // attachment and THIS epoch so a stale one cannot be reused by a later attachment.
      return {
        presented: true,
        confirmation: {
          attachProtocol: ATTACH_PROTOCOL,
          presented: true,
          attachmentId: client.id,
          epoch: client.epoch,
          geometryRevision,
          presentationNonce: typeof result.presentationNonce === "string" ? result.presentationNonce : null,
        },
      };
    } catch (error) {
      presentations.push({ attachmentId: client.id, epoch: client.epoch, requestedAtMs, error: /** @type {Error} */ (error).message });
      log(`cold presentation for ${client.id} failed: ${/** @type {Error} */ (error).message}`);
      return { presented: false, reason: `cold presentation failed: ${/** @type {Error} */ (error).message}` };
    }
  }

  /**
   * Welcome one client whose cold presentation already succeeded.
   *
   * Separated from the handshake so the ordering is visible: the presentation is awaited first, and only a
   * presented screen is ever welcomed.
   * @param {any} client @param {any} header @param {any} coldPresentation
   */
  function welcomeClient(client, header, coldPresentation) {
    log(`attached ${client.id} epoch ${client.epoch}, ${clients.size} client(s) now attached`);
    send(client.socket, {
      type: "welcome",
      attachmentId: client.id,
      epoch: client.epoch,
      geometry: { ...geometry },
      geometryRevision,
      owner: ownerIdentity,
      // The provider this owner was ACTUALLY launched with. Hardcoding the fake label here told every `--real`
      // attachment it was talking to a fake model while Pi's own footer said otherwise.
      provider: launch.describesProvider.label,
      providerIsFake: launch.describesProvider.isFake,
      ingressReady,
      // Additive: older frontends ignore it, current ones require it. No existing field is renamed or dropped.
      coldPresentation,
    });
    void header;
  }

  function statusRecord() {
    return {
      root,
      owner: ownerIdentity,
      geometry: { ...geometry },
      geometryRevision,
      geometryRefusals: [...geometryRefusals],
      profileId: profile.profileId,
      // What this manager can do for an attaching frontend. Advertised positively so a list can tell a manager it
      // can open from one it cannot, WITHOUT guessing: a manager that predates this field is simply unreported,
      // which is not the same as incompatible.
      attach: { protocol: ATTACH_PROTOCOL },
      provider: launch.describesProvider.label,
      providerIsFake: launch.describesProvider.isFake,
      ownerMode,
      cohort: { consumerRoot: cohort.consumerRoot, bundledCli: cohort.bundledCli, manifest: cohort.manifestPath, buildSlurmJobId: cohort.buildSlurmJobId, patchedTreeHash: cohort.patchedTreeHash },
      bootstrapPid: bootstrapHello?.pid ?? null,
      /**
       * The saved owner record, when the operator configured a records home. `null` everywhere when they did not,
       * which keeps the legacy record shape and every legacy reader unchanged. Note what is absent: no transcript
       * directory, because Pi owns that and reports it in its own facts.
       */
      durable: saved === undefined
        ? null
        : {
          recordsHome: saved.paths.recordsHome,
          ownerId: saved.ownerId,
          ownerRoot: saved.paths.ownerRoot,
          record: saved.paths.record,
          committedSequence: saved.committedSequence(),
          failure: durableFailure,
        },
      readiness,
      presentations,
      childPhases,
      returns,
      /**
       * What the owner management bridge reported, for the **current** owner generation only.
       *
       * `readyPhases` can only ever contain the single `bridge` phase that generation announced: the extension
       * emits that one phase and no other, and a reload starts a new generation rather than appending to this
       * one. So this is not a substitute for the seam E receipts in `readiness` above. `facts` is that
       * generation's own latest snapshot, so a value it omits because it could not read it is absent here.
       * `requests` are stop/abort receipts, which record what was asked, never that anything ended. There is
       * no frame history: `counts` and `diagnostics` are bounded, and an owner that reconnects or floods
       * cannot grow this record.
       */
      bridge: { socketPath: owned.sidebandSocket, ...bridgeConsumer.status() },
      ingressReady,
      attachments: [...clients.values()].map((client) => ({ attachmentId: client.id, epoch: client.epoch })),
      issuedEpochs: [...epochs.entries()].map(([id, epoch]) => ({ attachmentId: id, epoch })),
      reaped: handle.reapIfExited(),
      exit: exitRecord,
      ownerAliveWithZeroClients: clients.size === 0 && handle.reapIfExited() === null,
      atMs: Date.now(),
    };
  }

  server.on("connection", (socket) => {
    let role = null;
    /** @type {{ id: string, epoch: number, socket: net.Socket, notices: string[] } | undefined} */
    let client;
    socket.on("error", () => {});

    const refuse = (text) => {
      send(socket, { type: "refused", text });
      socket.end();
    };

    const reader = createFrameReader(
      ({ header, body }) => {
        // Nothing is forwarded before the token is accepted.
        if (role === null) {
          if (header.type !== "hello" || !tokenMatches(header.token, token)) {
            log(`refused a connection: ${header.type === "hello" ? "bad token" : `first frame was ${header.type}`}`);
            refuse("authentication failed");
            return;
          }
          role = header.role;
          if (role === "ingress") {
            // A newly connected ingress caller is a CANDIDATE, not a replacement. It becomes the input path
            // only when it reports `ingress-ready` for itself.
            //
            // This is the operator-visible defect it fixes. A second in-process registration connected and
            // immediately went away; because arrival alone used to install it as `ingress`, its departure
            // cleared `ingressReady` and every later keystroke was held forever while output kept flowing -
            // "I can get in, but I can't type". A caller that never announced itself can no longer take the
            // working one down with it.
            ingressCandidates.add(socket);
            log(`in-Pi ingress caller connected from pid ${header.pid} (${ingressReady ? "a ready caller is already serving input" : "no ready caller yet"})`);
            return;
          }
          if (role === "control") {
            return;
          }
          if (role !== "client") {
            refuse(`unknown role ${JSON.stringify(role)}`);
            return;
          }
          const id = typeof header.attachmentId === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(header.attachmentId) ? header.attachmentId : `a${epochs.size + 1}`;
          const superseded = clients.get(id);
          const epoch = (epochs.get(id) ?? 0) + 1;
          epochs.set(id, epoch);
          if (superseded) detachClient(superseded, "superseded by a newer epoch of the same attachment id");
          client = { id, epoch, socket, notices: [] };
          clients.set(id, client);
          // The joining terminal's own size becomes the shared size, so the operator's window is what Pi
          // renders at instead of whatever the owner happened to be launched with. Refused sizes are recorded
          // and the previous geometry stands.
          if (header.cols !== undefined || header.rows !== undefined) applyResize(client, { cols: header.cols, rows: header.rows, epoch });
          // A fresh native presentation is a PRECONDITION of this attachment, not a courtesy after it. Pi renders
          // incrementally, so a client welcomed without one inherits a stale screen and an editor whose believed
          // cursor is not the real one - which is exactly the state an operator reported typing into. Asking
          // first means a session that cannot repaint is refused with its reason instead of opening a broken
          // view. Nothing is signalled to the owner on this path: it keeps running, and the frontend goes back
          // to the list, so a refusal costs the operator a message rather than a session.
          void (async () => {
            const presentation = await presentTo(client);
            if (presentation.presented !== true) {
              log(`refusing ${id} epoch ${epoch}: ${presentation.reason}`);
              clients.delete(id);
              send(socket, { type: "refused", text: `${presentation.reason}. The session is still running and was not touched; nothing was changed.` });
              socket.end();
              return;
            }
            welcomeClient(client, header, presentation.confirmation);
          })();
          return;
        }


        if (role === "ingress") {
          if (header.type === "ingress-ready") {
            // Adopt the caller that announced itself, whichever connection it arrived on. A reconnecting
            // caller therefore restores input rather than leaving the session permanently mute.
            ingress = socket;
            ingressCandidates.delete(socket);
            ingressReady = true;
            log(`labelled ingress ready in Pi pid ${header.pid}, tui mode ${header.tuiMode}; flushing ${pendingInput.length()} held frame(s)`);
            flushPendingInput();
          } else if (header.type === "ingress-unavailable") {
            log(`labelled ingress unavailable: ${header.reason}`);
          } else if (header.type === "input-result") {
            if (header.admitted === false) {
              log(`Pi refused input sequence ${header.sequence}: ${header.reason}`);
              for (const attached of clients.values()) send(attached.socket, { type: "notice", text: `Pi refused a labelled input span: ${header.reason}` });
            }
          } else if (header.type === "return-request") {
            // One terminal, named by the attachment id AND the epoch the gesture was dispatched under. A stale
            // epoch is refused rather than resolved to whatever now holds that id, and the owner is untouched:
            // returning to the list is a detachment, never a shutdown.
            const target = clients.get(header.attachmentId);
            if (target === undefined) {
              log(`return requested for ${header.attachmentId}, which is not attached; nothing detached`);
            } else if (target.epoch !== header.epoch) {
              log(`return requested for ${header.attachmentId} epoch ${header.epoch}, but epoch ${target.epoch} is attached; nothing detached`);
            } else {
              returns.push({ attachmentId: target.id, epoch: target.epoch, atMs: Date.now() });
              detachClient(target, "returned to the session list from inside Pi");
            }
          } else if (header.type === "child-terminal-phase") {
            childPhases.push({ ...header.phase, atHostMs: Date.now() });
            log(`child terminal ${header.phase.phase} ${header.phase.childPhaseId} ${header.phase.reason}`);
          }
          return;
        }

        if (role === "control") {
          if (header.type === "status") {
            if (!socket.destroyed) socket.write(encodeStatusResponse(statusRecord(), header.detail));
          } else if (header.type === "detach") {
            const targets = header.attachmentId ? [clients.get(header.attachmentId)].filter(Boolean) : [...clients.values()];
            for (const target of targets) detachClient(target, "operator detach");
            send(socket, { type: "detached", attachments: targets.map((target) => ({ attachmentId: target.id, epoch: target.epoch })), remaining: clients.size, owner: ownerIdentity, ownerReaped: handle.reapIfExited() });
          } else if (header.type === "rename") {
            // Renaming asks the owner and then reports what the owner CONFIRMED. The request record says only
            // whether the ask was sent; the confirmed name comes from the facts the owner republished, so a
            // request that was accepted but did not apply is never reported as a rename.
            void renameThroughBridge(header.name).then(
              (answer) => send(socket, { type: "renamed", ...answer }),
              (error) => send(socket, { type: "renamed", sent: false, reason: String(error?.message ?? error), requestedName: null, confirmedName: null, renameError: null }),
            );
          } else if (header.type === "color") {
            void colorThroughBridge(header.color).then(
              (answer) => send(socket, { type: "colored", ...answer }),
              (error) => send(socket, { type: "colored", sent: false, reason: String(error?.message ?? error), confirmedColor: null }),
            );
          } else if (header.type === "stop") {
            send(socket, { type: "stopping" });
            void stop(header.keepRoot === true).then((record) => {
              // The answer goes out before this process exits: a control connection that was torn down first
              // would leave the operator without the owner's real exit status. `stop` has already closed the
              // listener and released the directory descriptor it wrote through.
              send(socket, { type: "stopped", ...record });
              socket.end(() => process.exit(0));
              setTimeout(() => process.exit(0), 1_000).unref();
            });
          } else {
            refuse(`unknown control frame ${JSON.stringify(header.type)}`);
          }
          return;
        }

        if (role === "client") {
          if (header.type === "input") {
            const entry = { attachmentId: client.id, epoch: client.epoch, generation: 1, bytes: Buffer.from(body) };
            if (ingressReady && ingress && !ingress.destroyed) {
              forwardInput(entry);
              return;
            }
            // The bound is decided before the bytes are held, so a refused span is never delivered later.
            const admission = pendingInput.admit(entry);
            if (admission.outcome === "refused") {
              // Refusing the attachment is honest; silently discarding an operator's keystrokes is not.
              detachClient(client, `the in-Pi labelled ingress was not ready and ${admission.reason}`);
            }
          } else if (header.type === "resize") {
            applyResize(client, header);
          } else if (header.type === "detach") {
            detachClient(client, "client requested detach");
          }
        }
      },
      (error) => {
        log(`refused a peer frame: ${error.code} ${error.message}`);
        socket.destroy();
      },
    );

    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("drain", resumeOwnerOutputIfDrained);
    socket.on("close", () => {
      if (client && clients.get(client.id) === client) {
        clients.delete(client.id);
        log(`attachment ${client.id} epoch ${client.epoch} closed its connection, ${clients.size} client(s) remain`);
        resumeOwnerOutputIfDrained();
      }
      if (role === "ingress") {
        ingressCandidates.delete(socket);
        if (ingress === socket) {
          ingress = undefined;
          ingressReady = false;
          log("the ready in-Pi ingress caller disconnected; input is held until one announces itself again");
        } else {
          // A caller that never became ready takes nothing with it.
          log(`an in-Pi ingress caller that never announced readiness disconnected; input is unaffected (ingressReady ${ingressReady})`);
        }
      }
    });
  });

  /**
   * Explicit stop: this owner, and nothing else.
   *
   * The graceful gesture is Pi's own end-of-input, dispatched through the same labelled path a client's keys
   * take, so Pi decides what it means. Escalation past that is the repository's verified group stop, which
   * re-reads PID, start identity and process group immediately before every signal, so a recycled PID cannot
   * be signalled. The reaped status is read before any signal, because after one it can no longer be told
   * apart from the exit it caused.
   *
   * **No tree is removed.** The root is retained for inspection, whatever `keepRoot` says: this demo deletes
   * nothing recursively, and the two sockets it created are unlinked by closing the listeners that bound them
   * through the held descriptor. The descriptor is released last, after that unlink has happened.
   *
   * @param {boolean} keepRoot accepted for compatibility; the root is kept either way
   */
  async function stop(keepRoot) {
    if (stopping) return { alreadyStopping: true };
    stopping = true;
    const stopStartedMs = Date.now();
    for (const client of [...clients.values()]) detachClient(client, "the owner is stopping");

    const alreadyReaped = handle.reapIfExited();
    // The bridge is asked first, and what comes back is a receipt rather than an outcome: every verification
    // below runs exactly as it did before this channel existed.
    if (alreadyReaped === null) await requestThroughBridge("stop");
    if (alreadyReaped === null && ingressReady && ingress && !ingress.destroyed) {
      log("dispatching Pi's own end-of-input as the graceful stop gesture");
      forwardInput({ attachmentId: "manager-stop", epoch: 1, generation: 1, bytes: Buffer.from([0x04]) });
    }
    let exit = await Promise.race([handle.wait(), sleep(GRACEFUL_EXIT_WAIT_MS).then(() => null)]);
    let disposition = exit ? "graceful" : null;
    if (!exit) {
      log("the owner did not exit on its own; escalating through the verified group stop");
      const outcome = await stopVerifiedProcessGroup(
        { pid: ownerIdentity.pid, processGroupId: ownerIdentity.processGroupId, startIdentity: ownerIdentity.startIdentity },
        {
          inspect: (pid) => inspectProcessIdentity(pid),
          requestGraceful: async () => {},
          signalProcessGroup,
          sleep,
        },
        STOP_POLICY,
      );
      disposition = outcome.disposition;
      log(`verified group stop: ${JSON.stringify(outcome)}`);
      exit = await Promise.race([handle.wait(), sleep(GRACEFUL_EXIT_WAIT_MS).then(() => null)]);
    }
    exitRecord = { ...(exit ?? {}), waitObserved: exit !== null, disposition, elapsedMs: Date.now() - stopStartedMs };
    if (exit === null) {
      log(`no raw wait status was observed for owner ${ownerIdentity.pid} within ${GRACEFUL_EXIT_WAIT_MS}ms of ${disposition ?? "the graceful gesture"}; this teardown is unverified, not graceful`);
    }
    log(`owner ${ownerIdentity.pid} exit: ${JSON.stringify(exitRecord)}`);

    const finalStatus = statusRecord();
    await writeOwnerRecord(anchor.anchoredRoot, { ...finalStatus, stopped: true });
    // The last durable snapshot, committed and awaited BEFORE the descriptors go: it carries this stop's own
    // observed wait status, so a frontend restarted afterwards reads the real exit instead of guessing one.
    await commitDurable({ exit: exitRecord, stopped: true });
    saved?.close().catch(() => {});
    // Destroying the read stream closes the master descriptor, which is this process's only claim on the
    // terminal. It happens once, after the owner is gone, and nothing closes that fd again.
    ownerOutput.destroy();
    await sideband.close();
    // The management bridge ends with its owner. Closing it rejects the accept loop and unlinks its endpoint.
    await bridge.close();
    if (keepRoot) log("--keep-root was asked for; this demo removes no root at all, so the flag changes nothing");
    const pathStillNamesCreatedDirectory = await anchor.namesCreatedDirectory();
    const retention = {
      root,
      retained: true,
      pathStillNamesCreatedDirectory,
      reason: pathStillNamesCreatedDirectory
        ? `${root} is this owner's own root and is kept for inspection; remove it yourself when you have read it`
        : `${root} no longer names the directory this owner created; that directory was written through the descriptor this owner held, and nothing at ${root} was touched`,
    };
    log(`stopped; root is retained: ${retention.reason}`);
    // Closing the listener unlinks the pathname it bound — the anchored one — and it does that as the handle
    // closes, not when the last connection ends: measured, because the answer above still has to go out on a
    // live control connection, so its completion callback cannot be awaited here. The descriptor is released
    // only after that unlink, because an unlink through a closed fd resolves nowhere.
    server.close();
    await anchor.close();
    return { owner: ownerIdentity, exit: exitRecord, rootKept: true, rootRetention: retention };
  }

  // `start` returns at `native-mounted`, not at first paint and not at initialization. That is the phase at
  // which a key reaches the editor and a frame reaches the terminal, so it is the phase at which attaching is
  // meaningful — and a blocking startup dialog must not hold an operator's attach command.
  const mountedRecord = await Promise.race([
    mounted,
    sleep(MOUNT_WAIT_MS).then(() => {
      throw new Error(`Pi did not record native-mounted within ${MOUNT_WAIT_MS}ms; see ${paths.log}`);
    }),
  ]);
  log(`native-mounted after ${mountedRecord.atHostMs - startedAtMs}ms; attaching is now meaningful`);

  const record = {
    ...statusRecord(),
    controlSocket: paths.controlSocket,
    bootstrapSocket: paths.bootstrapSocket,
    ingressLog: paths.ingressLog,
    managerPid: process.pid,
    managerLog: paths.log,
  };
  await writeOwnerRecord(anchor.anchoredRoot, record);
  // The first durable snapshot is committed before readiness is announced, so a dashboard that opens immediately
  // cannot see a live owner with no saved record at all.
  await commitDurable();
  onReady(record);

  // A silent exit of the owner is reported, not hidden: the record keeps the real wait status.
  void handle.wait().then(
    async (exit) => {
      if (stopping) return;
      exitRecord = { ...exit, disposition: "exited-on-its-own" };
      log(`the owner exited on its own: ${JSON.stringify(exit)}`);
      for (const client of [...clients.values()]) detachClient(client, `the owner exited: ${JSON.stringify(exit)}`);
      await writeOwnerRecord(anchor.anchoredRoot, { ...statusRecord(), stopped: false });
      // A real observed wait status, so this is the one thing that may record an exit durably.
      await commitDurable({ exit: exitRecord, stopped: false });
    },
    (error) => log(`waiting for the owner failed: ${error.message}`),
  );

  return { stop, statusRecord };
}
