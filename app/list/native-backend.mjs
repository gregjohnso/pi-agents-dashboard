/**
 * The existing dashboard, backed by native Pi sessions instead of the daemon.
 *
 * This is a backend adapter and nothing else. It implements the small contract `DashboardController`
 * already asks of a client — `getState`, `subscribeListChanges`, `refreshSummaries`, `preflightLaunch`,
 * `launch`, `getModels`, plus `attach`/`detach` for `runViewerTransition` — over the reviewed native
 * owner/manager path. Rows use an owner's `status` answer, or exact procfs process identity corroborating its
 * saved creation metadata when status is unavailable. Agent state is never inferred from rendered output.
 *
 * What it deliberately does NOT do: it does not reimplement the list, the launch composer, the
 * navigation, the row renderer or the viewer transition. Those are the existing manager's, reused as
 * they are. It also does not touch the installed daemon: `createStandaloneList` still constructs its
 * daemon client by default and this adapter is only ever passed in explicitly.
 *
 * Sessions are directories under one sessions home. Each is a native demo root holding one persistent
 * Pi owner, so a session outlives this dashboard exactly as a daemon-backed session does.
 */

import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdir, readdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execFile } from "node:child_process";

import { parseModelCatalogue } from "./native-model-catalogue.mjs";
import { nativeLabelsFromFacts, readNativeLabels } from "../../runtime/native-labels.mjs";
import { sessionNameFromPrompt } from "../../runtime/session-name.mjs";
import { isNativeSessionName } from "../../runtime/native-sideband.mjs";
import { ATTACH_PROTOCOL } from "../../examples/native-session-demo/client.mjs";
import { resolveCohort } from "../../examples/native-session-demo/cohort.mjs";
import { readSavedOwnerRecords } from "../../examples/native-session-demo/saved-owner-record.mjs";
import { createWorktree } from "../../isolation/worktree.mjs";
import { launchPreflight } from "../../isolation/launch-preflight.mjs";
import { demoPaths, readOwnerRecord, readToken } from "../../examples/native-session-demo/demo-root.mjs";
import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";
import { atomicWriteJson } from "../../runtime/atomic-file.mjs";
import { createFrameReader, encodeFrame } from "../../examples/native-session-demo/protocol.mjs";

/**
 * The refusal codes that say something about attach COMPATIBILITY.
 *
 * Only these two mean "this list cannot open that manager". A generic failure or a crash says nothing about
 * protocol, so it must never label a row.
 */
const ATTACH_REFUSAL_CODES = ["ATTACH_PRESENTATION_UNSUPPORTED", "ATTACH_PRESENTATION_UNCONFIRMED"];
/**
 * How long a row's status probe waits before calling an owner unreachable.
 *
 * Short on purpose: the list reads every session directory, so this is what a blank first paint costs when one
 * owner is wedged. An owner that needs longer than this to say anything about itself is, for the purpose of
 * drawing a row, not answering.
 */
export const STATUS_PROBE_MS = 2_000;
/**
 * How long a MUTATION waits for the manager's own answer.
 *
 * Deliberately far larger than the status bound. A stop has needed about eight seconds to come back with the
 * owner's real wait status, and a rename waits on the owner's receipt for about five; cutting either short would
 * report a false failure for a command that actually worked.
 */
export const MUTATION_ANSWER_MS = 25_000;
const MAX_REFUSAL_REASON = 400;
const DEMO = fileURLToPath(new URL("../../examples/native-session-demo/demo.mjs", import.meta.url));
/** The demo's own owner extension, which registers its labelled fixture provider for fake mode. */
const FIXTURE_EXTENSION = fileURLToPath(new URL("../../examples/native-session-demo/owner-extension.ts", import.meta.url));

/**
 * One control request against one session root, bounded on every outcome.
 *
 * It used to settle only on an expected frame, a refusal, a parse error, a socket error or a close. A listening
 * socket whose process never replies and never closes satisfies none of those, so the request never settled - and
 * because `getState` awaits `Promise.all` over every session directory, one such peer held the entire list. A
 * wedged process is enough to cause it: the listen backlog is the kernel's, so `connect` succeeds and the writes
 * land in a buffer even when nothing ever calls `accept`.
 *
 * The deadline is the caller's, because the two kinds of request are not comparable. A status probe has to be
 * fast enough that first paint does not wait on a silent owner; a mutation has to be patient enough to hear a
 * real answer - a stop has needed about eight seconds and a rename receipt about five. A status bound applied to
 * those would turn a working command into a false failure.
 *
 * Timing out means UNREACHABLE and nothing more. It is not an exit: `rowStateFromStatus` renders an unreachable
 * owner as STALE, never EXITED or STOPPED, because nobody observed a death.
 *
 * Every outcome disposes the whole lifecycle - timer cleared, socket destroyed, one settle only - so a late
 * answer cannot resolve a second time and no timer outlives the request.
 *
 * @param {string} root @param {any} frame @param {string} expected
 * @param {{ timeoutMs?: number }} [options]
 */
export async function probeControl(root, frame, expected, { timeoutMs = STATUS_PROBE_MS } = {}) {
  const paths = demoPaths(root);
  if (!existsSync(paths.controlSocket)) return { reachable: false, reason: "no control socket" };
  let token;
  try {
    token = await readToken(root);
  } catch (error) {
    return { reachable: false, reason: /** @type {Error} */ (error).message };
  }
  const socket = net.connect(paths.controlSocket);
  return new Promise((resolve) => {
    let settled = false;
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // Removing the listeners before destroying keeps the close that destroy causes from re-entering here.
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    timer = setTimeout(
      () => settle({ reachable: false, reason: `did not answer ${JSON.stringify(expected)} within ${timeoutMs}ms` }),
      timeoutMs,
    );
    // The deadline must not itself hold a process open that is otherwise finished.
    timer.unref?.();
    const reader = createFrameReader(
      ({ header }) => {
        if (header.type === expected) settle({ reachable: true, answer: header });
        else if (header.type === "refused") settle({ reachable: false, reason: `refused: ${header.text}` });
      },
      (error) => settle({ reachable: false, reason: `protocol: ${error.message}` }),
    );
    socket.on("connect", () => {
      socket.write(encodeFrame({ type: "hello", role: "control", token }));
      socket.write(encodeFrame(frame));
    });
    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("error", (error) => settle({ reachable: false, reason: error.message }));
    socket.on("close", () => settle({ reachable: false, reason: "closed before answering" }));
  });
}

/** Kept as the internal name the rest of this module already uses. */
const ask = probeControl;

/**
 * What the owner has actually told us about itself, and nothing more.
 *
 * Every field here comes from a fact the producer published over the reviewed sideband, or from the manager's
 * own explicit exit record. Two rules hold throughout:
 *
 *   - **an unknown is an unknown.** Where no fact was published, `stateIsKnown` is false and the summary says
 *     so. Reporting a live owner as READY because nothing arrived would be inventing liveness.
 *   - **Pi's model loop is not the whole session.** `idle` is Pi's own agent-loop idleness. It says nothing
 *     about background work, so `backgroundWorkKnown` is false and no count is produced. Collapsing the two
 *     would claim an idle session that may still have work running.
 *
 * `FAILED` comes only from an explicit non-zero or signalled exit. Pi's `agent_end` carries no error, so a
 * failure is never inferred from the loop ending.
 *
 * @param {any} status the manager's own `status` answer, or `undefined` when the owner is unreachable
 * @param {{ requestedModel?: { provider: string, id: string } }} [context]
 */
function exitedState(exit, requestedModel) {
  const signalled = typeof exit.signal === "string" && exit.signal !== "";
  const code = typeof exit.code === "number" ? exit.code : null;
  // Only an explicit non-zero code or a signal is a failure. Pi's `agent_end` carries no error, so nothing
  // here reads a failure out of the agent loop merely ending.
  const failed = signalled || (code !== null && code !== 0);
  return {
    processState: "EXITED",
    taskState: failed ? "FAILED" : "STOPPED",
    stateIsKnown: true, backgroundWorkKnown: false,
    reason: signalled ? `signal ${exit.signal}` : `exited ${code === null ? "with no code" : code}`,
    requestedModel, modelIsObserved: false,
  };
}

export function rowStateFromStatus(status, context = {}) {
  const requestedModel = context.requestedModel;
  // Additive: an absent `attachment` means nothing is known, which is not the same as incompatible.
  const attachment = context.attachment;
  const withAttachment = (state) => (attachment === undefined ? state : { ...state, attachment });
  if (status === undefined) {
    // A wait status this backend observed when it stopped the session outlives the manager that reported it,
    // so a stopped row shows the real exit instead of falling back to "unreachable".
    const observed = context.observedExit;
    if (observed !== undefined && observed !== null) return exitedState(observed, requestedModel);
    // A failed connection is NOT evidence of exit. The owner may well still be running, so this uses the
    // repository's existing representation for a record whose worker cannot be confirmed - `STALE` - and leaves
    // `taskState` at the neutral contract value, which `displaySessionState` never reaches because STALE wins.
    // Reporting EXITED/STOPPED here claimed a death nobody observed.
    return withAttachment({
      processState: "STALE", taskState: "READY", stateIsKnown: false, backgroundWorkKnown: false,
      reason: "unreachable", requestedModel, modelIsObserved: false,
    });
  }
  const exit = status.exit ?? status.reaped ?? null;
  if (exit !== null) return exitedState(exit, requestedModel);
  // Only the named facts are read. An unexpected key is never rendered, so nothing private can arrive that way.
  const facts = (status.bridge !== undefined && status.bridge.facts !== undefined) ? status.bridge.facts : {};
  const agentPhase = typeof facts.agentPhase === "string" ? facts.agentPhase : undefined;
  const idle = typeof facts.idle === "boolean" ? facts.idle : undefined;
  const pendingMessages = typeof facts.pendingMessages === "boolean" ? facts.pendingMessages : undefined;
  const observedProvider = typeof facts.modelProvider === "string" ? facts.modelProvider : undefined;
  const observedId = typeof facts.modelId === "string" ? facts.modelId : undefined;
  const model = observedProvider !== undefined && observedId !== undefined
    ? { provider: observedProvider, id: observedId }
    : requestedModel;

  // Order matters, and this is the corrected order. A loop Pi reports as RUNNING is working, whether or not
  // more work is also queued behind it: queued work is reported separately in the summary instead of
  // overriding the state. WAITING is reserved for the condition actually observed - the loop is not running
  // and Pi says messages are pending. Nothing here infers background idleness or tool-approval state.
  const loopBusy = agentPhase === "start" || idle === false;
  let taskState;
  if (loopBusy) taskState = "WORKING";
  else if (pendingMessages === true) taskState = "WAITING";
  else if (agentPhase === "settled" || agentPhase === "end") taskState = "READY";
  else if (idle === true) taskState = "READY";

  return withAttachment({
    processState: "LIVE",
    // With no fact at all the row still has to carry a contract value; READY is the renderer's neutral one and
    // the summary says the state was not reported, so the claim is never made in words.
    taskState: taskState ?? "READY",
    stateIsKnown: taskState !== undefined,
    agentPhase,
    idle,
    pendingMessages,
    // Nothing published tells this backend about work outside Pi's loop, so it claims nothing and counts nothing.
    backgroundWorkKnown: false,
    model,
    requestedModel,
    modelIsObserved: observedProvider !== undefined && observedId !== undefined,
    ownerPid: status.owner?.pid,
    attachments: Array.isArray(status.attachments) ? status.attachments.length : 0,
  });
}

/**
 * Whether this list can open one session, from explicit capability data only.
 *
 * Three answers, and the middle one is the whole point of the parent's warning: a manager from the increment that
 * shipped `ATTACH_PROTOCOL` 2 supports it but publishes no advertisement yet, so **absence is `unreported`, never
 * `unavailable`**. Those sessions open fine today and must not be labelled.
 *
 * `supported` needs a positive advertisement. `unavailable` needs either an advertisement this list cannot speak
 * or a refusal this list actually received from the SAME owner. Nothing is inferred from liveness, fixture mode,
 * launch time or model id, and no terminal output is parsed.
 *
 * @param {any} status @param {{ code: string, reason: string, startIdentity?: string }|undefined} observed
 * @returns {{ availability: any, retire: boolean }}
 */
export function attachAvailability(status, observed) {
  const advertised = status?.attach?.protocol;
  if (typeof advertised === "number") {
    // Positive data wins, and it retires any earlier observation: compatibility was re-established.
    if (advertised === ATTACH_PROTOCOL) return { availability: { state: "supported", protocol: advertised }, retire: true };
    return {
      availability: {
        state: "unavailable",
        code: "ATTACH_PRESENTATION_UNSUPPORTED",
        reason: `this manager advertises attach protocol ${advertised} and this list speaks ${ATTACH_PROTOCOL}. The session is still running.`,
      },
      retire: true,
    };
  }
  if (observed === undefined) return { availability: { state: "unreported" }, retire: false };
  const identity = status?.owner?.startIdentity;
  // A refusal belongs to the owner that gave it. A different identity behind the same directory is a different
  // peer, so the observation is retired rather than inherited.
  if (identity !== undefined && observed.startIdentity !== undefined && observed.startIdentity !== identity) {
    return { availability: { state: "unreported" }, retire: true };
  }
  return { availability: { state: "unavailable", code: observed.code, reason: observed.reason }, retire: false };
}

/**
 * One line for the row's Activity column, saying only what is known.
 *
 * @param {ReturnType<typeof rowStateFromStatus>} row
 */
export function describeOwnerActivity(row) {
  // Attachment availability leads the summary when it is known to be bad. It is a separate question from task
  // state - the operator's session said READY, which was true, while opening it was refused - so it is said here
  // rather than by rewriting READY into something false. Nothing is added when availability is unknown, so a row
  // with no availability metadata, the daemon's included, reads exactly as it did before.
  const unavailable = row.attachment?.state === "unavailable" ? "attachment unavailable (older manager)" : undefined;
  const withLabel = (text) => (unavailable === undefined ? text : `${unavailable}; ${text}`);
  if (row.reason === "status-unavailable") {
    return withLabel("Pi process identity confirmed; manager status unavailable; agent and background work state unknown");
  }
  if (row.reason === "unreachable") {
    // Said as what it is: a failed connection, not a death.
    return withLabel("owner could not be reached; it may still be running, and its state is not reported");
  }
  // An exited owner cannot be attached to for a reason that has nothing to do with protocol, so no label there.
  if (row.processState === "EXITED") return `owner ${row.reason}`;
  const parts = [];
  if (row.agentPhase === "start") parts.push("agent loop running");
  else if (row.agentPhase === "end") parts.push("agent loop ended");
  else if (row.agentPhase === "settled") parts.push("run settled");
  if (row.pendingMessages === true) parts.push("work queued");
  if (row.idle === true) parts.push("model loop idle");
  else if (row.idle === false) parts.push("model loop busy");
  if (!row.stateIsKnown) parts.push("state not reported yet");
  // Said on every live row, because Pi reports its own loop and nothing about anything else.
  parts.push("background work not reported");
  return withLabel(parts.join("; "));
}

/**
 * Saved rows carry an OWNER-SCOPED id, never a runtime-root basename.
 *
 * That matters for safety, not tidiness: `rootFor` turns a row id into `<sessionsHome>/<id>`, so a saved row whose
 * id looked like a basename could resolve onto a DIFFERENT live owner's runtime root and route a stop or a rename
 * there. The prefix makes such a row unmistakable, and the guards below refuse it by name.
 */
const SAVED_ROW_PREFIX = "saved:";

/** The owner id behind a saved row id, or `undefined` for an ordinary live row. @param {unknown} sessionId */
function savedRowOwnerId(sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith(SAVED_ROW_PREFIX) ? sessionId.slice(SAVED_ROW_PREFIX.length) : undefined;
}

/** Refuse an action on a saved row by name, having contacted nothing. @param {string} sessionId @param {string} action */
function refuseSavedRowAction(sessionId, action) {
  throw Object.assign(
    new Error(
      `${sessionId} is a saved record rather than a running session, so ${action} was refused: it has no runtime root `
        + "and no live owner to ask, and nothing was contacted.",
    ),
    { code: "SAVED_ROW_NOT_ACTIONABLE" },
  );
}

/**
 * One row for a session this list knows only from its durable record.
 *
 * Honesty is the whole point. Metadata is not live authority: a saved record says what was true when its manager
 * last committed, so the row is `STALE` - the repository's existing representation for a worker that cannot be
 * confirmed - unless the record carries a REAL observed wait status, which is the only thing that makes it
 * `EXITED`. Nothing here ever reports `LIVE`, and no attach or recovery is attempted: a saved dead owner is a
 * readable record, not a session to resume.
 *
 * `STALE` sits outside the dashboard's default `live` view, so these rows are reached through the EXISTING view
 * filter (Ctrl+V, to `all`) rather than by inventing a surface or dressing a dead owner up as live.
 *
 * @param {any} saved
 */
function savedRecordFor(saved) {
  const exit = saved.exit ?? null;
  const observedExit = exit !== null && (typeof exit.code === "number" || typeof exit.signal === "string");
  const state = observedExit
    ? exitedState(exit, undefined)
    : { processState: "STALE", taskState: "READY", stateIsKnown: false, reason: "unreachable" };
  const transcriptKnown = typeof saved.sessionFile === "string" && saved.sessionFile !== "";
  // Report what was OBSERVED, and nothing beyond it. This row exists because no listed runtime root claimed the
  // record - which is not evidence that the manager or the owner has exited. The runtime directory may simply be
  // gone, or be under a different sessions home than the one this dashboard lists. An earlier wording asserted
  // "its manager is not running", which this list never checked.
  const summary = observedExit
    ? `saved session; owner exited ${exit.code ?? exit.signal}; ${transcriptKnown ? "Pi's session file recorded" : "no session file was reported"}`
    : `saved session; no running owner was found for it here and its state could not be confirmed; ${transcriptKnown ? "Pi's session file recorded" : "no session file was reported"}`;
  const at = new Date(saved.updatedAtMs ?? Date.now()).toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    // Owner-scoped and stable: two saved owners whose runtime roots shared a basename stay distinct rows, and no
    // action can mistake this id for a live runtime directory.
    sessionId: `${SAVED_ROW_PREFIX}${saved.ownerId}`,
    // Exactly the path Pi reported. Pi chose it from its own configuration; nothing here did.
    sessionFile: saved.sessionFile ?? null,
    canonicalSessionFile: saved.sessionFile ?? null,
    cwd: saved.cwd ?? null,
    name: saved.sessionName ?? saved.dashboardSessionId,
    summary: readNativeLabels(saved.labels, saved.sessionId)?.description === undefined ? undefined : { text: saved.labels.description },
    taskState: state.taskState,
    processState: state.processState,
    stateReported: state.stateIsKnown,
    outcome: "NONE",
    activity: { kind: observedExit ? "exited" : "unreported", summary, updatedAt: at },
    attachments: [],
    createdAt: at,
    updatedAt: at,
    /** Everything a reader needs to find Pi's own session file without this list's help. */
    durable: {
      ownerId: saved.ownerId,
      dashboardSessionId: saved.dashboardSessionId ?? null,
      record: saved.record,
      recordsHome: saved.recordsHome,
      runtimeRoot: saved.runtimeRoot ?? null,
      piSessionId: saved.sessionId ?? null,
      sessionFile: saved.sessionFile ?? null,
      sequence: saved.sequence ?? null,
      savedOnly: true,
    },
  };
}

/** A record that could not be read is reported as a named failure, never as an absent or healthy session. */
function corruptRecordFor(corrupt) {
  const at = new Date().toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    sessionId: `${SAVED_ROW_PREFIX}${corrupt.ownerId}`,
    sessionFile: null,
    canonicalSessionFile: null,
    cwd: null,
    name: `unreadable durable record ${corrupt.ownerId}`,
    taskState: "READY",
    processState: "STALE",
    stateReported: false,
    outcome: "NONE",
    activity: { kind: "unreported", summary: `durable record unreadable: ${corrupt.failure}`, updatedAt: at },
    attachments: [],
    createdAt: at,
    updatedAt: at,
    durable: { ownerId: corrupt.ownerId, record: corrupt.record, corrupt: true, failure: corrupt.failure, savedOnly: true },
  };
}

/**
 * Turn one owner's status into the `SessionRecord` the existing row renderer already reads.
 *
 * The state values are the contract's own, not near-misses: `ProcessState` is `LIVE | SLEEPING | EXITED |
 * STALE`, and the dashboard's default `live` view keeps a row only when `processState === "LIVE"`. A live
 * owner reported as anything else is filtered out of the list it belongs in, which is exactly the defect
 * the sibling test now pins.
 *
 * Nothing here reads the screen: alive means the owner has neither exited nor been reaped, which the
 * manager reports from its own wait status.
 *
 * @param {string} root @param {any} status
 */
function recordFor(root, status, launchedPrompt, requestedModel, observedExit, attachment, durableRecord, verifiedOwner) {
  const directoryName = path.basename(root);
  const reported = rowStateFromStatus(status, { requestedModel, observedExit, attachment });
  const state = verifiedOwner !== undefined && reported.processState === "STALE"
    ? { ...reported, processState: "LIVE", reason: "status-unavailable" }
    : reported;
  // What Pi says about itself RIGHT NOW. This is the authority for the row's session file, ahead of any record.
  const liveSessionFile = typeof status?.bridge?.facts?.sessionFile === "string" && status.bridge.facts.sessionFile !== ""
    ? status.bridge.facts.sessionFile
    : undefined;
  // The name Pi confirmed, when the owner published one. It comes from Pi's own `getSessionName`, so it is the
  // persisted session name rather than a display alias this process is keeping: a fresh backend reading the same
  // owner sees the same name. Falling back to the directory is what an owner that never published one gets.
  const confirmedName = typeof status?.bridge?.facts?.sessionName === "string" ? status.bridge.facts.sessionName : undefined;
  const name = confirmedName ?? (verifiedOwner === undefined ? undefined : durableRecord?.sessionName) ?? sessionNameFromPrompt(launchedPrompt ?? "") ?? directoryName;
  const labels = nativeLabelsFromFacts(status?.bridge?.facts, durableRecord?.labels);
  const labelStatusSuffix = labels?.status && !["ready", "pending"].includes(labels.status) ? `; labels ${labels.status}` : "";
  const alive = state.processState === "LIVE";
  return {
    schemaVersion: 1,
    revision: 1,
    sessionId: directoryName,
    // The session file Pi itself reported, when a saved record carries one. `<root>/session.jsonl` was a
    // placeholder no Pi ever wrote; it remains only as the legacy shape for a session with no saved record.
    // Pi's CURRENT session takes precedence over any saved pointer: one owner can switch Pi sessions, so a record
    // written before a `/new` must never be attached to the session Pi is on now. The saved value is a fallback for
    // an owner that has published nothing yet, and `<root>/session.jsonl` remains only the legacy no-record shape.
    sessionFile: liveSessionFile ?? durableRecord?.sessionFile ?? path.join(root, "session.jsonl"),
    canonicalSessionFile: liveSessionFile ?? durableRecord?.sessionFile ?? path.join(root, "session.jsonl"),
    cwd: status?.projectCwd ?? durableRecord?.cwd ?? root,
    name,
    // Agent state comes from published facts; process state may also use an exact procfs identity match.
    taskState: state.taskState,
    processState: state.processState,
    // Additive and optional: `false` means no state was reported, so the renderer shows UNKNOWN instead of
    // presenting the neutral contract value as a real state. Records that omit it are unaffected, which is how
    // the daemon's own rows keep their existing rendering exactly.
    stateReported: state.stateIsKnown,
    // Which saved record this LIVE row was joined to, when one was claimed by this owner's own durable id. Present
    // so a reader can see the association that was made rather than inferring it. `savedOnly: false` distinguishes
    // it from a row this list knows only from a record.
    ...(durableRecord === undefined ? {} : {
      durable: {
        ownerId: durableRecord.ownerId,
        dashboardSessionId: durableRecord.dashboardSessionId ?? null,
        record: durableRecord.record,
        recordsHome: durableRecord.recordsHome,
        runtimeRoot: durableRecord.runtimeRoot ?? null,
        piSessionId: durableRecord.sessionId ?? null,
        sessionFile: durableRecord.sessionFile ?? null,
        sequence: durableRecord.sequence ?? null,
        savedOnly: false,
      },
    }),
    // Additive and optional, and deliberately NOT a second process-state enum: it answers "can this list open
    // it", which is a different question from "what is the agent doing". Absent means unknown.
    ...(attachment === undefined ? {} : { attachment }),
    outcome: "NONE",
    activity: {
      // `kind` drives no decision here; the summary is where the operator reads what is actually known.
      kind: state.processState === "LIVE" ? (state.stateIsKnown ? "native" : "unreported") : "exited",
      summary: `${describeOwnerActivity(state)}${labelStatusSuffix}`,
      updatedAt: new Date().toISOString(),
    },
    // The model Pi CONFIRMED, falling back to the one the launch requested while Pi has not said. The two are
    // kept apart on `native` below so a row never presents a request as a confirmation.
    model: state.model,
    summary: labels?.description === undefined ? (launchedPrompt === undefined ? undefined : { headline: launchedPrompt.slice(0, 80) }) : { text: `${labels.description}${labelStatusSuffix}` },
    createdAt: new Date(status?.owner?.launchedAtMs ?? verifiedOwner?.launchedAtMs ?? Date.now()).toISOString(),
    updatedAt: new Date().toISOString(),
    // Native facts the opener needs, kept beside the record rather than re-derived.
    native: {
      root, ownerPid: status?.owner?.pid ?? verifiedOwner?.pid ?? null, startIdentity: status?.owner?.startIdentity ?? verifiedOwner?.startIdentity ?? null,
      labelStatus: labels?.status,
      attachments: status?.attachments ?? [],
      // Requested and observed stay distinct, and the row says which it is showing.
      requestedModel: state.requestedModel, modelIsObserved: state.modelIsObserved,
      stateIsKnown: state.stateIsKnown, backgroundWorkKnown: state.backgroundWorkKnown, agentPhase: state.agentPhase,
    },
  };
}

function sameOwnerIdentity(left, right) {
  return left?.pid === right?.pid && left?.startIdentity === right?.startIdentity && left?.processGroupId === right?.processGroupId;
}

async function ownerProcessState(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || !Number.isSafeInteger(owner?.processGroupId) || owner.processGroupId <= 0 || typeof owner?.startIdentity !== "string" || !/^[1-9]\d*$/u.test(owner.startIdentity)) return "unknown";
  try {
    const actual = await inspectProcessIdentity(owner?.pid);
    return sameOwnerIdentity(actual, owner) ? "live" : "gone";
  } catch (error) {
    return ["ENOENT", "ESRCH"].includes(error.code) ? "gone" : "unknown";
  }
}

/** Creation metadata must match the saved owner; an exit also needs proof that identity is gone. */
async function unreportedOwner(root, records) {
  const creation = await readOwnerRecord(root).catch(() => undefined);
  const record = records.get(creation?.durable?.ownerId);
  if (record === undefined || record.runtimeRoot !== root || creation?.root !== root) return undefined;
  if (!sameOwnerIdentity(creation.owner, record.owner)) return undefined;
  const state = await ownerProcessState(record.owner);
  if (state !== (record.exit == null ? "live" : "gone")) return undefined;
  return { record, owner: creation.owner };
}

function forgottenOwnerKey(root, owner, ownerId) {
  if (!Number.isSafeInteger(owner?.pid) || typeof owner?.startIdentity !== "string" || !Number.isSafeInteger(owner?.processGroupId)) return undefined;
  return createHash("sha256").update(JSON.stringify([root ?? null, ownerId ?? null, owner.pid, owner.startIdentity, owner.processGroupId])).digest("hex");
}

function recordWithExit(record, exit) {
  const state = exitedState(exit, record.model);
  const updatedAt = new Date().toISOString();
  return { ...record, processState: state.processState, taskState: state.taskState, stateReported: true, updatedAt,
    activity: { kind: "exited", summary: describeOwnerActivity(state), updatedAt },
    ...(record.native === undefined ? {} : { native: { ...record.native, stateIsKnown: true } }),
  };
}

/**
 * @param {{
 *   sessionsHome: string, node?: string, mode?: "fake" | "real",
 *   cols?: number, rows?: number, traceFile?: string,
 *   piConfigRoot?: string,
 *   statusTimeoutMs?: number,
 *   stateHome?: string,
 *   piConfigHome?: string,
 *   manifestPath?: string,
 *   cohortRoot?: string,
 *   runDemo?: (args: string[]) => Promise<{ code: number | null, output: string }>,
 *   listModels?: () => Promise<string>,
 *   askControl?: (root: string, frame: any, expected: string) => Promise<any>,
 * }} options
 */
export function createNativeBackend({ sessionsHome, node = process.execPath, mode = "fake", cols, rows, traceFile, piConfigRoot, runDemo: injectedRunDemo, listModels: injectedListModels, askControl: injectedAskControl, statusTimeoutMs = STATUS_PROBE_MS, stateHome, piConfigHome, manifestPath, cohortRoot }) {
  /**
   * Attach refusals this list has actually received, per session, stamped with the owner that refused.
   *
   * This is an observation, never an inference. Nothing here reads liveness, fixture mode, launch time or model
   * id to guess compatibility: a session is only called unavailable because this frontend tried and was told no
   * by name, or because the manager advertises a protocol this list cannot speak. The stamp is what makes the
   * observation expire: a different owner behind the same directory is a different peer.
   */
  const attachRefusals = new Map();
  /** Prompts this dashboard launched, so a row can show what it was started for. */
  const prompts = new Map();
  /** The model each launch ASKED for, kept apart from the one Pi later confirms. */
  const requestedModels = new Map();
  /** One catalogue read, reused: a picker keystroke must not start a Pi. */
  let catalogue;
  /** Wait statuses this backend actually observed when it stopped a session, so a row can show the real exit. */
  const observedExits = new Map();
  const exitOwnerIdentities = new Map();
  let lastRows = new Map();
  const forgottenKeys = new Set();
  const forgottenDirectory = stateHome === undefined ? undefined : path.join(stateHome, "forgotten");
  /** The owner identity each session last reported, so an attach refusal can be stamped with who refused it. */
  const lastOwnerIdentity = new Map();
  /** The control channel, injectable so a case can drive the answer shapes without an owner. */
  const control = injectedAskControl ?? ask;
  const listeners = new Set();
  /** @type {import("node:fs").FSWatcher | undefined} */
  let watcher;
  /** @type {import("node:fs").FSWatcher | undefined} */
  let forgottenWatcher;
  /** The session ids the last invalidation was decided against. */
  let knownIds;
  /** @type {NodeJS.Timeout | undefined} */
  let settle;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  /**
   * One line per backend event, for diagnosing a stalled list.
   *
   * Deliberately NOT inside the sessions home: a trace written there would be a change to the watched
   * directory, so tracing a read would invalidate the list and provoke the next read. That feedback loop
   * is exactly the defect this file had, and putting the log anywhere else is what keeps it fixed.
   */
  const trace = (line) => {
    if (traceFile === undefined) return;
    void appendFile(traceFile, `${new Date().toISOString()} ${line}\n`).catch(() => {});
  };

  const isForgotten = async (key) => {
    if (key === undefined) return false;
    if (forgottenKeys.has(key)) return true;
    if (forgottenDirectory === undefined) return false;
    let marker;
    try {
      marker = JSON.parse(await readFile(path.join(forgottenDirectory, `${key}.json`), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (marker.version !== 1 || marker.key !== key) throw Object.assign(new Error("A dashboard clear marker is invalid"), { code: "CLEAR_STATE_INVALID" });
    forgottenKeys.add(key);
    return true;
  };

  const savedRecords = async () => stateHome === undefined ? [] : readSavedOwnerRecords(stateHome);

  const noteExit = (sessionId, exit, saved) => {
    const root = path.join(sessionsHome, sessionId);
    const previous = lastRows.get(sessionId) ?? recordFor(root, undefined, prompts.get(sessionId), requestedModels.get(sessionId), exit, undefined, saved?.record, saved?.owner);
    observedExits.set(sessionId, exit);
    const identity = previous.native?.startIdentity ?? saved?.owner.startIdentity;
    if (identity !== undefined && identity !== null) exitOwnerIdentities.set(sessionId, identity);
    const session = recordWithExit(previous, exit);
    lastRows.set(sessionId, session);
    return session;
  };

  /** The set of session directories, which is the only runtime invalidation source. */
  const readSessionIds = async () => {
    const entries = await readdir(sessionsHome, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  };

  const runDemo = injectedRunDemo ?? ((args) =>
    new Promise((resolve) => {
      const child = spawn(node, [DEMO, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => (output += chunk));
      child.stderr?.on("data", (chunk) => (output += chunk));
      child.on("close", (code) => resolve({ code, output }));
      child.on("error", (error) => resolve({ code: null, output: error.message }));
    }));

  /**
   * Ask Pi for its own model catalogue.
   *
   * `pi --list-models` is Pi's documented listing, so PI resolves the operator's providers, credentials and
   * configuration. This backend reads none of that and contacts no provider. A failure is reported rather
   * than turned into an empty list, because "the catalogue could not be read" and "no models are configured"
   * are different facts and the operator needs the right one.
   */
  const listModels = injectedListModels ?? (async () => {
    const cohort = resolveCohort({ manifestPath, cohortRoot });
    // Real mode lets Pi resolve the operator's own providers and credentials, which is the whole point of
    // using Pi's listing. Fake mode lists the demo's own labelled fixture provider instead, under a disposable
    // configuration directory, so nothing here ever reads the operator's configuration or calls a provider.
    const args = mode === "real"
      ? [cohort.bundledCli, "--list-models"]
      : [cohort.bundledCli, "--list-models", "--no-extensions", "-e", FIXTURE_EXTENSION];
    const environment = mode === "real"
      ? process.env
      : {
        PATH: "/usr/bin:/bin", TERM: "dumb", LANG: "C.UTF-8",
        HOME: path.join(configRoot, "catalogue-home"),
        PI_CODING_AGENT_DIR: path.join(configRoot, "catalogue-home", ".pi"),
        PI_DEMO_FAKE_PROVIDER: "1",
      };
    if (mode !== "real") await mkdir(path.join(configRoot, "catalogue-home", ".pi"), { recursive: true });
    return new Promise((resolve, reject) => {
      execFile(node, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: environment }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(new Error(`pi --list-models failed: ${(stderr || error.message).trim().split("\n").pop()}`), { code: "MODEL_CATALOG_FAILED" }));
          return;
        }
        resolve(stdout);
      });
    });
  });

  /**
   * Where this backend's own worktrees live: its own config root, never the operator's.
   *
   * Deliberately a SIBLING of the sessions home rather than a directory inside it. Every directory inside the
   * sessions home is a session row, so a config root in there would appear in the operator's list as a
   * session that does not exist - which is exactly what the first run of these tests showed.
   */
  const configRoot = piConfigRoot ?? `${sessionsHome.replace(/\/+$/u, "")}-config`;

  /**
   * The repository's preflight canonicalises the config root and refuses one that does not exist, so it is
   * created before any call rather than only on the worktree path. Getting that wrong showed up as
   * `INVALID_DIRECTORY` on the composer's status line with nothing launched.
   */
  const ensureConfigRoot = async () => {
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    return configRoot;
  };

  /**
   * Resolve the requested isolation with the repository's own implementation, and refuse anything it does
   * not support BEFORE a Pi is started.
   *
   * The dashboard's composer defaults to worktree isolation. Acknowledging that and then launching in the
   * operator's own directory would be the worst outcome available, so the mode decides the owner's cwd here,
   * and a mode that cannot be prepared raises rather than falling back to the shared directory.
   *
   * @param {any} request
   */
  const resolveIsolation = async (request) => {
    const isolation = request?.isolation;
    const requested = isolation?.mode;
    if (requested === "shared_directory") {
      // Confirmed by the composer's own confirmation step, which is what names the canonical directory.
      return { mode: "shared_directory", ownerCwd: isolation.confirmedCwd ?? request.cwd };
    }
    if (requested !== "worktree") {
      throw Object.assign(
        new Error(`this native backend does not implement ${JSON.stringify(requested ?? "an unnamed")} isolation, so nothing was launched`),
        { code: "ISOLATION_MODE_UNSUPPORTED" },
      );
    }
    // The repository's own preflight and worktree creation, not a second implementation of either.
    const preflight = await launchPreflight(
      { cwd: request.cwd, sourceSessionId: request.sourceSessionId ?? "native-manager", isolation: { mode: "worktree" } },
      { piConfigRoot: await ensureConfigRoot(), currentOwnerSessionIds: [] },
    );
    const prepared = await createWorktree(preflight, { worktreeId: `native-${Date.now()}` });
    return { mode: "worktree", ownerCwd: prepared.workerCwd, worktreePath: prepared.worktreePath, branch: prepared.branch };
  };

  return {
    /** The paths a native opener needs, so the entry point does not re-derive them. */
    sessionsHome,
    /**
     * The runtime root behind a LIVE row id.
     *
     * A saved row has no runtime root, and resolving one would be worse than useless: `<sessionsHome>/<id>` could
     * name a different live owner's directory. It is refused by name instead.
     */
    rootFor: (sessionId) => {
      if (savedRowOwnerId(sessionId) !== undefined) {
        throw Object.assign(
          new Error(`${sessionId} is a saved record and has no runtime root, so nothing was resolved for it`),
          { code: "SAVED_ROW_HAS_NO_RUNTIME_ROOT" },
        );
      }
      return path.join(sessionsHome, sessionId);
    },

    /**
     * Record that opening one session was refused for an attach-compatibility reason.
     *
     * Called by the opener with the manager's OWN named refusal, so the row says what was actually answered
     * rather than a guess. Anything that is not an attach-compatibility code is ignored: a crash or a generic
     * non-zero exit says nothing about whether this list can speak to that manager.
     *
     * @param {string} sessionId @param {{ code?: string, reason?: string }} refusal
     */
    noteAttachRefusal(sessionId, refusal = {}) {
      if (!ATTACH_REFUSAL_CODES.includes(refusal.code)) return;
      attachRefusals.set(sessionId, {
        code: refusal.code,
        reason: typeof refusal.reason === "string" ? refusal.reason.slice(0, MAX_REFUSAL_REASON) : "",
        // Whatever owner this list last saw for the session. A later identity retires the observation.
        startIdentity: lastOwnerIdentity.get(sessionId),
      });
      trace(`attach refusal for ${sessionId}: ${refusal.code}`);
      notify();
    },

    async getState() {
      await mkdir(sessionsHome, { recursive: true });
      const entries = await readdir(sessionsHome, { withFileTypes: true }).catch(() => []);
      const roots = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(sessionsHome, entry.name));
      try {
        // Durable records are read from the state home ALONE - no runtime listing and no live socket - which is
        // what lets a saved session appear after its disposable runtime root is gone.
        const durableRecords = await savedRecords();
        const rowKeys = new Map();
        // Keyed by DURABLE OWNER IDENTITY, never by the runtime-root basename.
        //
        // Collapsing by basename was a real defect: two owners under different runtime homes, or a legitimately
        // recreated root, shared a key, and because the highest sequence won across them an older owner at
        // sequence 20 could attach its session file to a brand-new live owner at sequence 2. A sequence orders one
        // owner's own snapshots and means nothing between owners, so no sequence is compared across owners here.
        /** @type {Map<string, any>} */
        const durableByOwnerId = new Map();
        for (const candidate of durableRecords) {
          if (candidate.corrupt === true) continue;
          if (typeof candidate.ownerId !== "string") continue;
          durableByOwnerId.set(candidate.ownerId, candidate);
        }
        /** Owner ids a live row legitimately claimed, so the same record is not also listed as saved. */
        const joinedOwnerIds = new Set();
        /** @type {any[]} Live rows and saved rows are different shapes on purpose, so this list is not one record type. */
        const rows = await Promise.all(
          roots.map(async (root) => {
            const creation = await readOwnerRecord(root).catch(() => undefined);
            const key = creation?.root === root ? forgottenOwnerKey(root, creation.owner, creation.durable?.ownerId) : undefined;
            rowKeys.set(path.basename(root), key);
            if (await isForgotten(key)) return undefined;
            // Bounded, and bounded per row: a wedged owner costs this one row its detail, not the whole list.
            const probe = await control(root, { type: "status", detail: "list" }, "status", { timeoutMs: statusTimeoutMs });
            const sessionId = path.basename(root);
            const status = probe.reachable ? probe.answer.status : undefined;
            const verified = status === undefined ? await unreportedOwner(root, durableByOwnerId) : undefined;
            // Remember who this session's owner is, so a refusal recorded later can be stamped with it, and so a
            // replacement owner retires the previous owner's refusal instead of inheriting it.
            const identity = status?.owner?.startIdentity ?? verified?.owner.startIdentity;
            if (identity !== undefined) {
              lastOwnerIdentity.set(sessionId, identity);
              if (exitOwnerIdentities.has(sessionId) && exitOwnerIdentities.get(sessionId) !== identity) {
                observedExits.delete(sessionId);
                exitOwnerIdentities.delete(sessionId);
              }
            }
            // A refusal recorded before this list had ever seen the owner carries no stamp. Adopt the first
            // identity it is compared against, so it can expire on a later change instead of outliving the owner
            // that gave it.
            const pending = attachRefusals.get(sessionId);
            if (pending !== undefined && pending.startIdentity === undefined && identity !== undefined) {
              attachRefusals.set(sessionId, { ...pending, startIdentity: identity });
            }
            const { availability, retire } = attachAvailability(status ?? (verified === undefined ? undefined : { owner: verified.owner }), attachRefusals.get(sessionId));
            if (retire) attachRefusals.delete(sessionId);
            // Join the owner's durable id only when the runtime root agrees. If status is unavailable, the
            // creation identity must agree, with either a matching live process or a recorded exit and proof it is gone.
            const claimedOwnerId = status?.durable?.ownerId ?? verified?.record.ownerId;
            const joined = typeof claimedOwnerId === "string" ? durableByOwnerId.get(claimedOwnerId) : undefined;
            const belongsHere = joined !== undefined
              && (joined.runtimeRoot === undefined || joined.runtimeRoot === null || joined.runtimeRoot === root);
            if (belongsHere) joinedOwnerIds.add(claimedOwnerId);
            return recordFor(root, status, prompts.get(sessionId), requestedModels.get(sessionId), observedExits.get(sessionId) ?? verified?.record.exit ?? undefined, availability, belongsHere ? joined : undefined, verified?.owner);
          }),
        );
        const sessions = rows.filter((row) => row !== undefined);
        // Saved rows: every record no live owner claimed. Their ids are owner-scoped, never a runtime-root
        // basename, so a saved row can never be mistaken for a live session by an action that resolves a root.
        for (const [ownerId, saved] of durableByOwnerId) {
          if (joinedOwnerIds.has(ownerId)) continue;
          const key = forgottenOwnerKey(saved.runtimeRoot, saved.owner, ownerId);
          const row = savedRecordFor(saved);
          rowKeys.set(row.sessionId, key);
          if (!(await isForgotten(key))) sessions.push(row);
        }
        for (const corrupt of durableRecords.filter((candidate) => candidate.corrupt === true)) {
          sessions.push(corruptRecordFor(corrupt));
        }
        // A stop or clear may have completed while another owner's status probe was still in flight.
        const current = sessions.filter((row) => !forgottenKeys.has(rowKeys.get(row.sessionId))).map((row) => {
          const exit = observedExits.get(row.sessionId);
          return exit === undefined ? row : recordWithExit(row, exit);
        });
        current.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
        lastRows = new Map(current.map((row) => [row.sessionId, row]));
        trace(`getState -> ${current.length} row(s): ${current.map((row) => `${row.sessionId}:${row.processState}`).join(",")}`);
        return { sessions: current, cursor: { daemonEpoch: "native", sequence: String(current.length) } };
      } catch (error) {
        trace(`getState FAILED: ${/** @type {Error} */ (error).stack ?? error}`);
        throw error;
      }
    },

    /**
     * Payload-free invalidations, exactly as the dashboard expects: it re-reads `getState` itself.
     *
     * An invalidation is raised only when the SET of session directories changed. A running owner writes
     * to its own log and sockets constantly — including in answer to the status request each read makes —
     * and treating that churn as an invalidation made every read provoke the next one. The set is the
     * one fact that this backend's own reads cannot change, so deciding on it is what makes the signal
     * mean something. The cost is stated in the limitations: a state transition inside an existing
     * session appears on the next invalidation or operator action, not the instant it happens.
     */
    async subscribeListChanges(onChanged, onError) {
      await mkdir(sessionsHome, { recursive: true });
      listeners.add(onChanged);
      if (forgottenDirectory !== undefined && forgottenWatcher === undefined) {
        await mkdir(forgottenDirectory, { recursive: true, mode: 0o700 });
        forgottenWatcher = watch(forgottenDirectory, notify);
        forgottenWatcher.on("error", (error) => onError?.(error));
      }
      knownIds ??= (await readSessionIds()).join("\u0000");
      if (watcher === undefined) {
        try {
          watcher = watch(sessionsHome, () => {
            // One timer coalescing a burst, armed by events and never rearmed on its own: a create shows
            // up as several events, and the set is compared once after they settle.
            if (settle !== undefined) return;
            settle = setTimeout(() => {
              settle = undefined;
              void readSessionIds().then((ids) => {
                const next = ids.join("\u0000");
                if (next === knownIds) return;
                knownIds = next;
                trace(`session set changed -> ${ids.length} session(s)`);
                notify();
              }, () => {});
            }, 120);
            settle.unref?.();
          });
          watcher.on("error", (error) => onError?.(error));
        } catch (error) {
          onError?.(error);
        }
      }
      return () => {
        listeners.delete(onChanged);
        if (listeners.size === 0) {
          watcher?.close();
          watcher = undefined;
          forgottenWatcher?.close();
          forgottenWatcher = undefined;
          if (settle !== undefined) clearTimeout(settle);
          settle = undefined;
        }
      };
    },

    /** Owner-local label requests are event-driven; a render/poll never starts inference. */
    refreshSummaries() {},

    /** Refuse, before the terminal is handed over, to open a live session whose Pi has not mounted. */
    async assertOpenable(sessionId) {
      const probe = await control(path.join(sessionsHome, sessionId), { type: "status", detail: "list" }, "status", { timeoutMs: statusTimeoutMs });
      const status = probe.reachable ? probe.answer.status : undefined;
      if (status?.ingressReady !== false || (status.exit ?? status.reaped ?? null) !== null) return;
      notify();
      throw Object.assign(new Error("Still starting — try again in a moment"), { code: "SESSION_STARTING" });
    },

    /**
     * The existing picker's catalogue, from Pi's own listing, read once and reused.
     *
     * A failure propagates so the composer shows it, rather than becoming an empty catalogue that would read
     * as "no models configured".
     */
    async getModels() {
      catalogue ??= (async () => {
        try {
          return parseModelCatalogue(await listModels());
        } catch (error) {
          catalogue = undefined;
          throw error;
        }
      })();
      return catalogue;
    },

    /**
     * A native session's directory is its own, so there is no shared-directory question to confirm:
     * the canonical cwd is the requested one and no session owns it.
     */
    /**
     * The repository's own preflight, adapted to the shape the composer expects.
     *
     * It no longer echoes the draft's mode back. A cwd that cannot host the requested isolation is refused
     * here, which is where the composer can put the reason in front of the operator, rather than after a Pi
     * has already been started somewhere he did not ask for.
     */
    async preflightLaunch(draft) {
      if (draft.isolationMode === "shared_directory") {
        // The composer's confirmation step owns this mode: it needs the canonical path and the owners of it.
        const resolved = await launchPreflight(
          { cwd: draft.cwd, sourceSessionId: draft.sourceSessionId ?? "native-manager", isolation: { mode: "shared_directory", ownerSessionIds: [] } },
          { piConfigRoot: await ensureConfigRoot(), currentOwnerSessionIds: [] },
        );
        return { canonicalCwd: resolved.canonicalCwd, isolationMode: "shared_directory", ownerSessionIds: [] };
      }
      const resolved = await launchPreflight(
        { cwd: draft.cwd, sourceSessionId: draft.sourceSessionId ?? "native-manager", isolation: { mode: "worktree" } },
        { piConfigRoot: await ensureConfigRoot(), currentOwnerSessionIds: [] },
      );
      return { canonicalCwd: resolved.canonicalCwd, isolationMode: resolved.mode, ownerSessionIds: [] };
    },

    /**
     * Start one persistent native owner to run this task, in the directory the isolation mode decided.
     *
     * Two things this does that a row-only launch did not: the prompt is handed to the owner so the session
     * actually runs it, and the isolation mode is honoured rather than acknowledged. The prompt travels as a
     * file because its bytes must survive a leading dash, embedded newlines and trailing whitespace, none of
     * which argv preserves reliably.
     */
    async launch(request) {
      if (request.name !== undefined && request.name !== "" && !isNativeSessionName(request.name)) {
        throw Object.assign(new Error("Session name must be printable, nonempty and at most 128 characters"), { code: "NAME_INVALID" });
      }
      await mkdir(sessionsHome, { recursive: true });
      // Isolation first: a mode this backend cannot prepare must refuse before anything is started.
      const isolation = await resolveIsolation(request);
      const sessionId = `session-${Date.now()}`;
      const root = path.join(sessionsHome, sessionId);
      const promptFile = path.join(sessionsHome, `${sessionId}.prompt`);
      const prompt = typeof request.prompt === "string" ? request.prompt : "";
      // Written verbatim. Nothing is trimmed, quoted or escaped between the composer and Pi.
      await writeFile(promptFile, prompt, "utf8");
      const args = ["start", "--root", root, "--cwd", isolation.ownerCwd, "--initial-prompt-file", promptFile];
      if (typeof request.name === "string" && request.name !== "") {
        args.push("--name", request.name);
      }
      // The durable data home, when one is configured. The manager owns persistence from here on: it keeps
      // committing while this dashboard is closed.
      if (stateHome !== undefined) args.push("--state", stateHome);
      if (piConfigHome !== undefined) args.push("--pi-config", piConfigHome);
      if (manifestPath !== undefined) args.push("--manifest", manifestPath);
      if (cohortRoot !== undefined) args.push("--cohort", cohortRoot);
      if (cols !== undefined) args.push("--cols", String(cols));
      if (rows !== undefined) args.push("--rows", String(rows));
      if (mode === "real") args.push("--real");
      // The composer's selection, carried to the owner. Naming nothing leaves Pi its own selection, which is
      // what "no choice" means; it is never substituted with a guess.
      const model = request.model;
      const requestedModel = typeof model === "object" && model !== null
        && typeof model.provider === "string" && model.provider !== ""
        && typeof model.id === "string" && model.id !== ""
        ? { provider: model.provider, id: model.id }
        : undefined;
      if (requestedModel !== undefined) args.push("--provider", requestedModel.provider, "--model", requestedModel.id);
      trace(`launch start ${sessionId} isolation=${isolation.mode} cwd=${isolation.ownerCwd} promptBytes=${Buffer.byteLength(prompt)}`);
      const outcome = await runDemo(args);
      trace(`launch settled ${sessionId} exit=${outcome.code}`);
      if (outcome.code !== 0) {
        // A failed launch is the operator's answer to his Enter, so the whole of what the demo said is
        // kept beside the sessions home rather than reduced to one line on the status bar.
        await appendFile(
          path.join(sessionsHome, "launch-failures.log"),
          `${new Date().toISOString()} ${sessionId} exit=${outcome.code}\n${outcome.output}\n`,
        ).catch(() => {});
        throw Object.assign(new Error(`native launch failed: ${outcome.output.trim().split("\n").pop()}`), { code: "LAUNCH_FAILED" });
      }
      prompts.set(sessionId, prompt);
      if (requestedModel !== undefined) requestedModels.set(sessionId, requestedModel);
      // The set changed, and this backend knows it without waiting for the watcher to agree.
      knownIds = (await readSessionIds()).join("\u0000");
      notify();
      trace(`launch notified ${sessionId}, ${listeners.size} listener(s)`);
      return { sessionId, isolation };
    },

    /**
     * Stop one session, through the manager's own authenticated control channel.
     *
     * This is the method `DashboardController` dispatches as `this.client[action](sessionId, revision, requestId)`
     * for a live row. Its absence is what made the operator's Stop die as "this is not a function".
     *
     * Three honesty rules, because stopping is destructive:
     *
     *   - the controller's revision semantics are kept. A request naming a revision this backend did not issue
     *     raises `REVISION_CONFLICT` WITHOUT asking the owner anything, so the controller re-aims at the record
     *     it actually has rather than stopping something it was not looking at.
     *   - a receipt is not an exit. `observedExit` is true only when the manager answered with the owner's own
     *     wait status; an answer without one leaves it false and claims nothing.
     *   - a lost connection needs the same owner's saved exit and proof its process is gone before reporting an already-completed stop.
     *
     * @param {string} sessionId @param {number} revision @param {string} [requestId]
     */
    async stop(sessionId, revision, requestId) {
      if (savedRowOwnerId(sessionId) !== undefined) refuseSavedRowAction(sessionId, "stop");
      const root = path.join(sessionsHome, sessionId);
      // Every row this backend publishes carries revision 1; anything else is aimed at a record it never wrote.
      if (revision !== undefined && revision !== 1) {
        throw Object.assign(new Error(`revision ${revision} is not this session's revision 1`), { code: "REVISION_CONFLICT" });
      }
      // A stop gets the generous deadline: it has needed about eight seconds to return the owner's real wait
      // status, and a short bound would report a false failure for a stop that actually happened.
      const probe = await control(root, { type: "stop" }, "stopped", { timeoutMs: MUTATION_ANSWER_MS });
      if (!probe.reachable) {
        const records = new Map((await savedRecords()).filter((record) => !record.corrupt).map((record) => [record.ownerId, record]));
        const saved = await unreportedOwner(root, records);
        if (saved?.record.exit != null) {
          const session = noteExit(sessionId, saved.record.exit, saved);
          notify();
          return { sessionId, session, exit: saved.record.exit, observedExit: true, alreadyStopped: true };
        }
        throw Object.assign(new Error(`could not reach ${sessionId} to stop it: ${probe.reason}`), { code: "STOP_UNREACHABLE" });
      }
      const exit = probe.answer.exit;
      const observedExit = typeof exit === "object" && exit !== null
        && (typeof exit.code === "number" || typeof exit.signal === "string");
      const session = observedExit ? noteExit(sessionId, exit) : undefined;
      trace(`stop ${sessionId} requestId=${requestId ?? "none"} observedExit=${observedExit}`);
      knownIds = (await readSessionIds()).join("\u0000");
      notify();
      return { sessionId, session, exit: observedExit ? exit : undefined, observedExit };
    },

    /**
     * Rename one existing session through its owner, and report only the name the owner confirmed.
     *
     * The honesty rules here mirror `stop`:
     *   - the target is the session named by the caller, checked against the revision this backend publishes;
     *   - an unreachable owner raises rather than claiming a rename;
     *   - an owner that does not advertise the capability is refused BY NAME, and nothing was written to it,
     *     so its bridge is untouched;
     *   - a request the owner accepted but did not apply is not a rename: the answer must carry the confirmed
     *     name, and a confirmed name that is not the requested one raises with both names in the message.
     *
     * @param {string} sessionId @param {number} revision @param {string} [requestId] @param {string} [name]
     */
    async rename(sessionId, revision, requestId, name) {
      if (savedRowOwnerId(sessionId) !== undefined) refuseSavedRowAction(sessionId, "rename");
      const root = path.join(sessionsHome, sessionId);
      if (revision !== undefined && revision !== 1) {
        throw Object.assign(new Error(`revision ${revision} is not this session's revision 1`), { code: "REVISION_CONFLICT" });
      }
      if (typeof name !== "string" || name.trim() === "") {
        throw Object.assign(new Error(`no new name was given for ${sessionId}, so nothing was renamed`), { code: "RENAME_NAME_REQUIRED" });
      }
      // The manager itself waits about five seconds for the owner's receipt before answering, so this has to
      // outlast that rather than cut it off and call a working rename a failure.
      const probe = await control(root, { type: "rename", name }, "renamed", { timeoutMs: MUTATION_ANSWER_MS });
      if (!probe.reachable) {
        throw Object.assign(new Error(`could not reach ${sessionId} to rename it: ${probe.reason}`), { code: "RENAME_UNREACHABLE" });
      }
      const answer = probe.answer;
      if (answer.sent !== true) {
        // The owner never received a frame, which is how an older owner is refused without its bridge being
        // torn down by a request it would have called malformed.
        throw Object.assign(
          new Error(`${sessionId} was not renamed: ${answer.reason ?? "its owner did not accept a rename"}`),
          { code: "RENAME_UNSUPPORTED" },
        );
      }
      if (typeof answer.renameError === "string" && answer.renameError !== "") {
        throw Object.assign(new Error(`${sessionId} kept its name: ${answer.renameError}`), { code: "RENAME_FAILED" });
      }
      if (answer.confirmedName !== name) {
        throw Object.assign(
          new Error(`${sessionId} did not confirm the new name: asked for ${JSON.stringify(name)} and its owner reports ${JSON.stringify(answer.confirmedName)}`),
          { code: "RENAME_UNCONFIRMED" },
        );
      }
      trace(`rename ${sessionId} requestId=${requestId ?? "none"} confirmed=${JSON.stringify(answer.confirmedName)}`);
      notify();
      return { sessionId, name: answer.confirmedName, confirmed: true };
    },

    /** Forget only a confirmed inactive owner's dashboard entry, never its files or runtime root. */
    async delete(sessionId, revision) {
      const ownerId = savedRowOwnerId(sessionId);
      const records = (await savedRecords()).filter((record) => !record.corrupt);
      const root = ownerId === undefined ? path.join(sessionsHome, sessionId) : undefined;
      const creation = root === undefined ? undefined : await readOwnerRecord(root).catch(() => undefined);
      const saved = records.find((record) => ownerId === undefined
        ? record.runtimeRoot === root && creation?.root === root && record.ownerId === creation?.durable?.ownerId && sameOwnerIdentity(record.owner, creation.owner)
        : record.ownerId === ownerId);
      if (saved === undefined) throw Object.assign(new Error(`delete has no verified dashboard record for ${sessionId}; nothing was changed`), { code: "ACTION_UNSUPPORTED" });
      const expectedRevision = ownerId === undefined ? 1 : savedRecordFor(saved).revision;
      if (revision !== undefined && revision !== expectedRevision) throw Object.assign(new Error("The session record changed before clear"), { code: "REVISION_CONFLICT" });
      const state = await ownerProcessState(saved.owner);
      if (state !== "gone") throw Object.assign(new Error(state === "live" ? "This session is still running; stop it before clearing" : "Could not confirm this session has stopped; nothing was cleared"), { code: state === "live" ? "SESSION_LIVE" : "SESSION_STATE_UNKNOWN" });
      const key = forgottenOwnerKey(saved.runtimeRoot, saved.owner, saved.ownerId);
      if (key === undefined) throw Object.assign(new Error("This session's owner identity is incomplete; nothing was cleared"), { code: "SESSION_STATE_UNKNOWN" });
      if (forgottenDirectory !== undefined) {
        await mkdir(forgottenDirectory, { recursive: true, mode: 0o700 });
        await atomicWriteJson(path.join(forgottenDirectory, `${key}.json`), { version: 1, key });
      }
      forgottenKeys.add(key);
      notify();
      return { sessionId, deleted: true };
    },

    /**
     * Attach and detach are the transition's bookkeeping, not the terminal handoff: the opener owns
     * that, because it has the terminal. Nothing is signalled here, so a refused open leaves the
     * owner exactly as it was.
     */
    async attach() {},
    async detach() {},
    close() {
      watcher?.close();
      watcher = undefined;
      forgottenWatcher?.close();
      forgottenWatcher = undefined;
      if (settle !== undefined) clearTimeout(settle);
      settle = undefined;
      listeners.clear();
    },
  };
}
