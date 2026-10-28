/**
 * The dashboard's saved owner record: the minimum needed to find a session again, and nothing more.
 *
 * **Pi owns storage.** Session files, their format, their naming and the directory they live in are Pi's, chosen by
 * Pi's own configuration. This module does not allocate a transcript namespace, does not copy or sync transcripts,
 * does not mirror Pi's history model and does not decide where a transcript goes. It records what Pi *reports* —
 * principally the `sessionFile` and `sessionId` the owner extension already publishes — so a dashboard that starts
 * later can find a session whose transient socket root is gone.
 *
 * That is the whole job. A record here is discovery metadata, not a store.
 *
 * Three boundaries, each the answer to a way this could be wrong:
 *
 * - **Exclusive allocation, never adoption.** A record directory is created with `mkdir` and no `recursive`, so an
 *   existing one belongs to another manager and is refused. There is no writer takeover in this increment, and a
 *   saved record is never evidence that its writer is dead.
 * - **Descriptor-bound writes.** The record directory is held open and written through `/proc/self/fd/<n>`, the
 *   same protection `openRootAnchor` gives the runtime root, so a renamed or replaced path never receives this
 *   manager's record. The path is reported; the descriptor is what is written through.
 * - **Causal ordering.** Snapshots carry a sequence and an older one can never replace a newer, so a slow or
 *   duplicated write cannot push a saved identity backwards.
 *
 * What this does NOT promise: no power-loss or last-token guarantee. `atomicWriteJson` gives an exclusive mode-0600
 * temp file, an `fsync`, a rename and a directory sync, so a record this module acknowledged is committed and
 * readable. Whether Pi had finished writing a transcript byte is Pi's business, not something acknowledged here.
 */

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { atomicWriteJson } from "../../runtime/atomic-file.mjs";
import { nativeLabelsFromFacts, readNativeLabels } from "../../runtime/native-labels.mjs";

/** The record schema this module writes and reads. A reader that sees another version says so. */
export const OWNER_RECORD_VERSION = 2;
const MAX_TEXT = 4096;

/** A named saved-record failure. Never an empty success and never a silent fallback. */
export class SavedOwnerRecordError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "SavedOwnerRecordError";
    this.code = code;
  }
}

/** @param {unknown} value */
function boundedText(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_TEXT) : undefined;
}

/**
 * Where one owner's record lives under a records home.
 *
 * Note what is absent: no `sessions` directory. Pi decides where transcripts go, so this layout holds metadata
 * only.
 *
 * @param {string} recordsHome @param {string} ownerId
 */
export function savedOwnerLayout(recordsHome, ownerId) {
  const ownerRoot = path.join(recordsHome, "owners", ownerId);
  return { recordsHome, ownerId, ownerRoot, record: path.join(ownerRoot, "owner.json") };
}

/**
 * Create and hold one owner's record directory.
 *
 * @param {{ recordsHome: string, sessionId: string, ownerId?: string, runtimeRoot?: string }} options
 */
export async function createSavedOwnerRecord({ recordsHome, sessionId, ownerId = randomUUID(), runtimeRoot }) {
  if (typeof recordsHome !== "string" || recordsHome.trim() === "") {
    throw new SavedOwnerRecordError("RECORDS_HOME_REQUIRED", "A records home must be a non-empty path");
  }
  if (!path.isAbsolute(recordsHome)) {
    throw new SavedOwnerRecordError("RECORDS_HOME_NOT_ABSOLUTE", `A records home must be absolute, not ${JSON.stringify(recordsHome)}`);
  }
  const seen = await lstat(recordsHome).catch(() => null);
  if (seen !== null && !seen.isDirectory()) {
    throw new SavedOwnerRecordError(
      "RECORDS_HOME_NOT_A_DIRECTORY",
      `${recordsHome} is not a directory, and this refuses to follow or replace it`,
    );
  }
  const layout = savedOwnerLayout(recordsHome, ownerId);
  try {
    await mkdir(path.dirname(layout.ownerRoot), { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new SavedOwnerRecordError("RECORDS_HOME_UNWRITABLE", `Could not prepare ${path.dirname(layout.ownerRoot)}: ${/** @type {Error} */ (cause).message}`, { cause });
  }
  try {
    // No `recursive`: an existing directory is another manager's, and EEXIST is a refusal rather than adoption.
    await mkdir(layout.ownerRoot, { mode: 0o700 });
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code === "EEXIST") {
      throw new SavedOwnerRecordError(
        "OWNER_RECORD_EXISTS",
        `${layout.ownerRoot} already exists. A new owner allocates its own record and never adopts one that may still have a writer.`,
        { cause },
      );
    }
    throw new SavedOwnerRecordError("OWNER_RECORD_UNWRITABLE", `Could not create ${layout.ownerRoot}: ${/** @type {Error} */ (cause).message}`, { cause });
  }
  const handle = await open(layout.ownerRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  const anchoredRecord = `/proc/self/fd/${handle.fd}/owner.json`;
  let committedSequence = 0;
  return {
    ownerId,
    sessionId,
    runtimeRoot,
    paths: { ownerRoot: layout.ownerRoot, record: layout.record, recordsHome },
    anchoredRecord,
    labels: undefined,
    committedSequence: () => committedSequence,
    noteCommitted: (sequence) => {
      committedSequence = sequence;
    },
    close: () => handle.close(),
  };
}

/**
 * Commit one snapshot of an owner's discovery metadata, acknowledging only once it is on disk.
 *
 * `facts` are the owner extension's own published facts. `sessionFile` and `sessionId` are recorded exactly as Pi
 * reported them: this module does not rewrite, relocate or validate a layout it does not own. A descriptor alias is
 * the one thing refused, because such a path stops resolving when its process exits and recording it would be the
 * fake durability this replaces.
 *
 * @param {any} record @param {{ sequence: number, owner: any, cwd?: string, facts?: any, exit?: any, stopped?: boolean }} snapshot
 */
export async function writeSavedOwnerSnapshot(record, { sequence, owner, cwd, facts = {}, exit = null, stopped = false }) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new SavedOwnerRecordError("OWNER_RECORD_SEQUENCE_INVALID", `A snapshot sequence must be a positive integer, not ${JSON.stringify(sequence)}`);
  }
  if (sequence <= record.committedSequence()) {
    return { written: false, sequence, reason: `sequence ${sequence} is not newer than the committed ${record.committedSequence()}, so this older snapshot was refused` };
  }
  const identityConfirmed = boundedText(facts.sessionId) !== undefined;
  const session = identityConfirmed ? facts : record.sessionAssociation ?? {};
  const sessionFile = boundedText(session.sessionFile);
  if (sessionFile !== undefined && /\/proc\/(?:\d+|self)\/fd\//u.test(sessionFile)) {
    throw new SavedOwnerRecordError(
      "OWNER_RECORD_SESSION_FILE_IS_FD_ALIAS",
      `Pi reported its session file as ${sessionFile}, a descriptor alias that stops resolving when its process exits, so it was not recorded as a discoverable reference`,
    );
  }
  let labels = nativeLabelsFromFacts(facts, record.labels);
  // A replacement bridge with no identity cannot supply new labels or erase the last confirmed association.
  if (!identityConfirmed && (facts.labelVersion === undefined || facts.labelVersion === 1)) {
    labels = readNativeLabels(record.labels, session.sessionId);
  }
  const snapshot = {
    recordVersion: OWNER_RECORD_VERSION,
    ...(labels === undefined ? {} : { labels }),
    sequence,
    ownerId: record.ownerId,
    /** The dashboard's own session id. Deliberately NOT Pi's session id: one owner spans several of those. */
    dashboardSessionId: record.sessionId,
    runtimeRoot: record.runtimeRoot ?? null,
    recordsHome: record.paths.recordsHome,
    owner: owner === undefined || owner === null
      ? null
      : { pid: owner.pid ?? null, startIdentity: boundedText(owner.startIdentity) ?? null, processGroupId: owner.processGroupId ?? null },
    cwd: boundedText(cwd) ?? null,
    /** Exactly what Pi reports. Pi chose this path; nothing here did. */
    sessionFile: sessionFile ?? null,
    sessionId: boundedText(session.sessionId) ?? null,
    sessionName: boundedText(session.sessionName) ?? null,
    /** Present only with a real observed wait status. Absence of contact never lands here. */
    exit: exit !== null && exit !== undefined && (typeof exit.code === "number" || typeof exit.signal === "string") ? exit : null,
    stopped: stopped === true,
    updatedAtMs: Date.now(),
  };
  try {
    // Through the held descriptor, so a replaced or renamed path never receives this write.
    await atomicWriteJson(record.anchoredRecord, snapshot);
  } catch (cause) {
    throw new SavedOwnerRecordError("OWNER_RECORD_WRITE_FAILED", `Could not commit the owner record for ${record.ownerId}: ${/** @type {Error} */ (cause).message}`, { cause });
  }
  record.labels = labels;
  if (identityConfirmed) {
    record.sessionAssociation = { sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile, sessionName: snapshot.sessionName };
  }
  record.noteCommitted(sequence);
  return { written: true, sequence, record: record.paths.record };
}

/**
 * Read every saved owner record under a records home.
 *
 * Needs no runtime root and no live socket: it lists the records directory only. A record that cannot be parsed is
 * returned marked `corrupt` with its failure named, because dropping it would present a damaged session as absent.
 *
 * @param {string} recordsHome
 */
export async function readSavedOwnerRecords(recordsHome) {
  if (typeof recordsHome !== "string" || recordsHome.trim() === "" || !path.isAbsolute(recordsHome)) return [];
  const ownersRoot = path.join(recordsHome, "owners");
  const entries = await readdir(ownersRoot, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const recordPath = path.join(ownersRoot, entry.name, "owner.json");
    let text;
    try {
      text = await readFile(recordPath, "utf8");
    } catch (cause) {
      // A directory with no record yet is not a failure: its manager had not committed one.
      if (/** @type {NodeJS.ErrnoException} */ (cause).code === "ENOENT") continue;
      records.push({ ownerId: entry.name, record: recordPath, corrupt: true, failure: `${recordPath} could not be read: ${/** @type {Error} */ (cause).message}` });
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed?.recordVersion !== OWNER_RECORD_VERSION) {
        records.push({ ownerId: entry.name, record: recordPath, corrupt: true, failure: `${recordPath} reports record version ${JSON.stringify(parsed?.recordVersion)} and this reader speaks ${OWNER_RECORD_VERSION}` });
        continue;
      }
      records.push({ ...parsed, labels: readNativeLabels(parsed.labels, parsed.sessionId), record: recordPath, corrupt: false, failure: null });
    } catch (cause) {
      records.push({ ownerId: entry.name, record: recordPath, corrupt: true, failure: `${recordPath} is corrupt and could not be parsed: ${/** @type {Error} */ (cause).message}` });
    }
  }
  return records;
}
