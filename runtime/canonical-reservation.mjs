/**
 * Durable canonical reservations: the host backend behind Pi's seam D canonical trio.
 *
 * Pi's `vendor/pi/INTERFACE-seam-d-canonical.md` names three handlers a host registers —
 * `admitCanonicalOperation`, `commitBinding`, `abortReservation` — and says in as many words that the
 * journal, the session-directory lock, fsync, alias/inode collapse and reconciliation are the host's.
 * This module is that backend and nothing more. It never writes a session file: Pi owns every byte of a
 * canonical file, and this module owns only the record of who may write one.
 *
 * Four boundaries are deliberate, and each is the answer to a way this could be wrong:
 *
 * - **The domain is one Pi session directory, not a state root.** Two dashboard state roots can be
 *   configured against one Pi session directory, so a lock under a state root would exclude nothing.
 *   `canonicalReservationPaths` derives both paths from the session directory and `open` refuses a
 *   journal and a lock that do not share one directory.
 * - **Identity is the canonicalized path plus `{device, inode}`.** A symlink, a symlinked parent and a
 *   hard link are all one claim, so an alias cannot be admitted beside the file it names.
 * - **Absence is proven by a trusted verifier for the *recorded* host and boot.** `hostProof` is that
 *   adapter. This machine's process table says nothing about a claim recorded on another host, and a
 *   requester cannot assert absence: there is no parameter for it. An unreachable recorded host stays
 *   uncertain for as long as it stays unreachable — nothing here expires on elapsed time.
 * - **Proof of absence is not a release.** A crashed owner's claim becomes `uncertain`, which blocks a
 *   second writer until an explicit, journalled operator action clears it with that same host-scoped
 *   proof. Timeouts, disconnects and model idle release nothing.
 *
 * `runtime/lifecycle-lock.mjs` is used unchanged and its automatic stale reclaim is **not** inherited: it
 * inspects local PIDs, which is not evidence about a holder recorded on another host. Every acquisition
 * here passes an `inspect` that refuses to answer, so a contended lock stays held; recovery is attempted
 * only after this module's own `hostProof` proved the recorded holder absent, and only for the exact lock
 * record bytes that proof was computed from.
 *
 * `openDurableAppendStore` supplies the journal's owner-validated append and its fsync. Its
 * `recoverRecords` is deliberately not called: it truncates an incomplete final record, and a truncated
 * record here is an unknown claim. This module reads the journal itself and refuses to decide anything
 * from a torn tail rather than silently discarding it.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { hostname as localHostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { parseCanonicalOperation, parseOwnerRunIdentity } from "../shared/native-contracts.mjs";
import { openDurableAppendStore } from "./append-store.mjs";
import { acquireLifecycleLock, LifecycleLockError } from "./lifecycle-lock.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";

/**
 * The schema version of every record this module writes.
 *
 * Version 1 is the first version of these records; nothing else has ever written this journal. A record
 * at any other version is refused rather than interpreted, because a writer that shares this domain and
 * disagrees about what a record means is exactly the case a second writer must not be opened for. No old
 * log is rewritten and no legacy compatibility is claimed.
 */
export const CANONICAL_JOURNAL_VERSION = 1;

const DOMAIN_NAME = "canonical-reservations";
const JOURNAL_NAME = "journal.jsonl";
const LOCK_DIRECTORY_NAME = "locks";
const DOMAIN_MODE = 0o700;
// Two absolute paths, an owner identity and a reason, with room to spare for the longest of each.
const MAX_RECORD_BYTES = 16_384;
const RECORD_KINDS = ["prepared", "committed", "transferred", "released", "aborted", "cleared"];
const OWNER_FIELDS = ["initialRowId", "runId", "ownerPid", "ownerStartIdentity", "hostId", "bootId"];
const ABSENT_FILE_CODES = ["ENOENT", "ENOTDIR"];
// Read in this order, first non-empty wins. `/etc/machine-id` is the standard per-installation id and is
// empty on some container images; `/var/lib/dbus/machine-id` is the older spelling of the same value.
const MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
const RETRY_HINT = "retry the operation once that writer releases the file";

/** A refusal or failure of the canonical reservation backend. */
export class CanonicalReservationError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "CanonicalReservationError";
    this.code = code;
  }
}

/** @typedef {import("../shared/native-contracts.mjs").OwnerRunIdentity} OwnerRunIdentity */
/** @typedef {{canonicalFile:string,device:string|null,inode:string|null}} ClaimIdentity */
/** @typedef {{proof:"live"|"absent"|"unknown",evidence:string}} OwnerAbsenceVerdict */
/** @typedef {{key:string,owner:OwnerRunIdentity,reservationId:string,operation:string,generation:number,binds:boolean,state:"prepared"|"committed",target:ClaimIdentity}} Claim */

/**
 * The one lock-and-journal domain for a Pi session directory.
 *
 * Both paths are siblings inside a `canonical-reservations` subdirectory of that directory, for two
 * reasons. The pair is what `openCanonicalReservations` checks, so a caller cannot put the lock under one
 * state root and the journal under another. And nothing this module writes lands beside Pi's own session
 * files, where a journal named `*.jsonl` would be offered to an operator as a session to resume.
 * @param {string} sessionDirectory
 */
export function canonicalReservationPaths(sessionDirectory) {
  if (typeof sessionDirectory !== "string" || !isAbsolute(sessionDirectory)) throw new TypeError("The Pi session directory must be an absolute path");
  const domain = join(resolve(sessionDirectory), DOMAIN_NAME);
  return { journalPath: join(domain, JOURNAL_NAME), lockPath: join(domain, LOCK_DIRECTORY_NAME) };
}

/** @param {unknown} error @param {readonly string[]} codes */
function hasCode(error, codes) {
  return error instanceof Error && codes.includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "");
}

/**
 * Resolve one exact file to the identity a claim is keyed by.
 *
 * The path is canonicalized whether or not the file exists, so an admitted target that Pi has not created
 * yet is still one claim; `{device, inode}` is filled in as soon as the file exists, and that is what
 * collapses a hard link, which no amount of path canonicalization would.
 * @param {string} canonicalFile @returns {Promise<ClaimIdentity>}
 */
async function resolveClaimIdentity(canonicalFile) {
  const requested = resolve(canonicalFile);
  let directory = dirname(requested);
  try {
    directory = await fsPromises.realpath(directory);
  } catch (error) {
    if (!hasCode(error, ABSENT_FILE_CODES)) throw error;
  }
  const path = join(directory, basename(requested));
  try {
    const metadata = await fsPromises.stat(path, { bigint: true });
    if (!metadata.isFile()) throw new CanonicalReservationError("TARGET_NOT_A_FILE", `${canonicalFile} exists and is not a regular file`);
    return { canonicalFile: await fsPromises.realpath(path), device: String(metadata.dev), inode: String(metadata.ino) };
  } catch (error) {
    if (!hasCode(error, ABSENT_FILE_CODES)) throw error;
    return { canonicalFile: path, device: null, inode: null };
  }
}

/** Two identities are one claim when the canonicalized path matches, or when the device and inode do. @param {ClaimIdentity} left @param {ClaimIdentity} right */
function sameIdentity(left, right) {
  if (left.canonicalFile === right.canonicalFile) return true;
  return left.inode !== null && left.device === right.device && left.inode === right.inode;
}

/**
 * The globally defined lock order: lexicographic on the canonicalized path, with aliases collapsed.
 *
 * Two owners swapping two files take the same two locks in the same order, so neither can hold one and
 * wait for the other. Exported because it is the order, not an implementation detail: a caller that locks
 * a source and a target itself must use this one.
 * @param {string} lockDirectory @param {readonly string[]} canonicalFiles
 * @returns {Promise<{canonicalFile:string,identity:ClaimIdentity,path:string}[]>}
 */
export async function orderCanonicalLocks(lockDirectory, canonicalFiles) {
  if (typeof lockDirectory !== "string" || !isAbsolute(lockDirectory)) throw new TypeError("The canonical lock directory must be an absolute path");
  /** @type {{canonicalFile:string,identity:ClaimIdentity,path:string}[]} */
  const ordered = [];
  for (const file of canonicalFiles) {
    const identity = await resolveClaimIdentity(file);
    if (ordered.some((entry) => sameIdentity(entry.identity, identity))) continue;
    ordered.push({
      canonicalFile: identity.canonicalFile,
      identity,
      path: join(resolve(lockDirectory), `${createHash("sha256").update(identity.canonicalFile).digest("hex")}.lock`),
    });
  }
  return ordered.sort((left, right) => (left.canonicalFile < right.canonicalFile ? -1 : left.canonicalFile > right.canonicalFile ? 1 : 0));
}

/** @param {unknown} value @param {string} path */
function boundedString(value, path, maxLength = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new TypeError(`${path} must be a bounded non-empty string`);
  return value;
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {string} path */
function onlyFields(value, allowed, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be a plain object`);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`Unknown ${path} field: ${unknown}`);
}

/** @param {OwnerRunIdentity} left @param {OwnerRunIdentity} right */
function sameOwnerRun(left, right) {
  return OWNER_FIELDS.every((field) => /** @type {any} */ (left)[field] === /** @type {any} */ (right)[field]);
}

/**
 * The default trusted verifier: this machine, for claims recorded on this machine's host and boot.
 *
 * It answers `unknown` for every other recorded host, which is the whole point. A local `/proc` lookup for
 * a PID recorded on another machine would read whatever process happens to hold that number here, and a
 * changed boot id on *another* host is not evidence that *this* claim's owner is gone.
 *
 * `hostIdentity` is the pair `readLocalHostIdentity` reads, so an owner minted from the same source
 * compares equal. `inspect` is the same exact PID/start-identity/process-group probe the lifecycle lock
 * and the signaler use.
 *
 * @param {{ hostIdentity: {hostId:string,bootId:string}, inspect?: (pid:number) => Promise<{pid:number,processGroupId:number,startIdentity:string}> }} options
 */
export function createLocalHostProof({ hostIdentity, inspect = inspectProcessIdentity }) {
  const hostId = boundedString(hostIdentity?.hostId, "host identity.hostId", 256);
  const bootId = boundedString(hostIdentity?.bootId, "host identity.bootId", 256);
  if (typeof inspect !== "function") throw new TypeError("The host proof's process inspector must be a function");
  return {
    /** @param {OwnerRunIdentity} recorded @returns {Promise<OwnerAbsenceVerdict>} */
    async proveOwnerAbsence(recorded) {
      if (recorded.hostId !== hostId) {
        return { proof: "unknown", evidence: `recorded host ${recorded.hostId} is not this host, whose process table is no evidence about it` };
      }
      if (recorded.bootId !== bootId) {
        return { proof: "absent", evidence: `recorded boot ${recorded.bootId} on host ${recorded.hostId} was replaced by boot ${bootId}` };
      }
      let actual;
      try {
        actual = await inspect(recorded.ownerPid);
      } catch (error) {
        if (hasCode(error, ["ENOENT", "ESRCH"])) return { proof: "absent", evidence: `pid ${recorded.ownerPid} is absent on recorded boot ${bootId}` };
        return { proof: "unknown", evidence: `pid ${recorded.ownerPid} could not be inspected on recorded boot ${bootId}: ${String(error)}` };
      }
      if (actual.pid !== recorded.ownerPid || actual.startIdentity !== recorded.ownerStartIdentity) {
        return { proof: "absent", evidence: `pid ${recorded.ownerPid} on recorded boot ${bootId} now has start identity ${actual.startIdentity}, not ${recorded.ownerStartIdentity}` };
      }
      return { proof: "live", evidence: `pid ${recorded.ownerPid} is running on recorded boot ${bootId} with the recorded start identity` };
    },
  };
}

/**
 * This machine's host and boot identity, as the default verifier and an owner must both read it.
 *
 * `hostId` is a machine id and this host's name together, and both halves carry weight. A machine id
 * survives a reboot, which is what lets a changed `bootId` mean "that owner's boot is over" rather than
 * "some other machine rebooted". The hostname separates two nodes provisioned from one image: they share a
 * baked-in machine id, and without the name one node's process table would answer for a claim recorded on
 * the other. Two hosts compare equal only when both halves match.
 *
 * `bootId` is required. Without it there is no boot evidence, and an absence could never be proven.
 * @param {{ readFile?: typeof fsPromises.readFile, hostname?: () => string }} [options]
 */
export async function readLocalHostIdentity({ readFile = fsPromises.readFile, hostname = localHostname } = {}) {
  let bootId;
  try {
    bootId = boundedString(String(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), "boot id", 256);
  } catch (cause) {
    throw new CanonicalReservationError("HOST_IDENTITY_UNREADABLE", "/proc/sys/kernel/random/boot_id does not yield this boot's identity", { cause });
  }
  let machineId = "no-machine-id";
  let hostIdSource = "hostname";
  for (const path of MACHINE_ID_PATHS) {
    let value = "";
    try {
      value = String(await readFile(path, "utf8")).trim();
    } catch {
      continue;
    }
    if (value.length > 0 && value.length <= 128) {
      machineId = value;
      hostIdSource = path;
      break;
    }
  }
  return { hostId: `${machineId}:${boundedString(hostname(), "hostname", 256)}`, bootId, hostIdSource };
}

/** @param {unknown} value @param {number} index */
function parseJournalRecord(value, index) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CanonicalReservationError("JOURNAL_UNRECOGNIZED", `journal record ${index} is not an object`);
  const record = /** @type {any} */ (value);
  if (record.version !== CANONICAL_JOURNAL_VERSION) {
    throw new CanonicalReservationError("JOURNAL_VERSION_UNSUPPORTED", `journal record ${index} is at schema version ${String(record.version)}, not ${CANONICAL_JOURNAL_VERSION}`);
  }
  if (!RECORD_KINDS.includes(record.record)) throw new CanonicalReservationError("JOURNAL_UNRECOGNIZED", `journal record ${index} is a ${String(record.record)} record`);
  return record;
}

/**
 * Read every complete record, and refuse to decide anything from an incomplete one.
 *
 * A torn final line is a record whose claim is unknown: it could have reserved any path, or released one.
 * Discarding it could open a second writer and rewriting it would destroy the evidence, so it does
 * neither — the read fails and the caller fails closed.
 * @param {string} journalPath
 */
async function readJournal(journalPath) {
  const text = await fsPromises.readFile(journalPath, "utf8");
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) {
    throw new CanonicalReservationError("JOURNAL_TAIL_INCOMPLETE", `${journalPath} ends in an incomplete record, so what it claimed is unknown`);
  }
  return text.slice(0, -1).split("\n").map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw new CanonicalReservationError("JOURNAL_UNRECOGNIZED", `journal record ${index} is malformed JSON`, { cause });
    }
    return parseJournalRecord(parsed, index);
  });
}

/** @param {any} record */
function claimKeyOf(record) {
  return `${record.owner.runId}:${record.reservationId}`;
}

/**
 * Fold the journal into the claims that are still held.
 *
 * A record naming a reservation this fold has never seen means two writers disagree about the journal's
 * history, which is refused rather than skipped.
 * @param {any[]} records @returns {Claim[]}
 */
function foldClaims(records) {
  /** @type {Claim[]} */
  const claims = [];
  const indexOfKey = (/** @type {string} */ key) => claims.findIndex((claim) => claim.key === key);
  const drop = (/** @type {ClaimIdentity} */ identity) => {
    const index = claims.findIndex((claim) => sameIdentity(claim.target, identity));
    if (index >= 0) claims.splice(index, 1);
  };
  records.forEach((record, index) => {
    if (record.record === "cleared") {
      // An operator clears another owner run's claim, so this record is keyed by the claim it names.
      if (claims.findIndex((claim) => sameIdentity(claim.target, record.target)) < 0) {
        throw new CanonicalReservationError("JOURNAL_INCONSISTENT", `journal record ${index} clears a claim this journal does not hold`);
      }
      drop(record.target);
      return;
    }
    const key = claimKeyOf(record);
    if (record.record === "prepared") {
      // One identity carries one claim. Admission refuses another owner's, so the claim superseded here
      // is always this record's own owner, re-reserving the file it is already bound to.
      drop(record.target);
      claims.push({ key, owner: record.owner, reservationId: record.reservationId, operation: record.operation, generation: record.generation, binds: false, state: "prepared", target: record.target });
      return;
    }
    if (indexOfKey(key) < 0) {
      throw new CanonicalReservationError("JOURNAL_INCONSISTENT", `journal record ${index} is a ${record.record} for a reservation this journal never prepared`);
    }
    if (record.record === "committed" || record.record === "transferred") {
      if (record.record === "transferred") drop(record.released);
      claims[indexOfKey(key)] = { ...claims[indexOfKey(key)], state: "committed", generation: record.generation, binds: record.record === "transferred" ? true : record.binds === true, target: record.target };
      return;
    }
    claims.splice(indexOfKey(key), 1);
  });
  return claims;
}

/**
 * Open the canonical reservation backend for one owner run.
 *
 * @param {{
 *   journalPath: string,
 *   lockPath: string,
 *   owner: OwnerRunIdentity,
 *   currentGeneration: () => number,
 *   hostProof?: { proveOwnerAbsence(recorded: OwnerRunIdentity): Promise<OwnerAbsenceVerdict> },
 *   failpoint?: (stage: string) => Promise<void>,
 *   fsOps?: any,
 * }} options
 */
export async function openCanonicalReservations({ journalPath, lockPath, owner, currentGeneration, hostProof, failpoint = async () => {}, fsOps = fsPromises }) {
  if (typeof journalPath !== "string" || !isAbsolute(journalPath)) throw new TypeError("journalPath must be an absolute path");
  if (typeof lockPath !== "string" || !isAbsolute(lockPath)) throw new TypeError("lockPath must be an absolute path");
  if (dirname(resolve(journalPath)) !== dirname(resolve(lockPath))) {
    throw new CanonicalReservationError("DOMAIN_SPLIT", "The journal and the lock must share one Pi session directory; two state roots can share one session directory, so a per-root lock excludes nothing");
  }
  const ownerRun = parseOwnerRunIdentity(owner);
  if (typeof currentGeneration !== "function") throw new TypeError("currentGeneration must be a function returning the owner's authoritative generation");
  if (typeof failpoint !== "function") throw new TypeError("failpoint must be a function");
  const verifier = hostProof ?? createLocalHostProof({ hostIdentity: await readLocalHostIdentity() });
  if (typeof verifier.proveOwnerAbsence !== "function") throw new TypeError("hostProof must expose proveOwnerAbsence for the recorded host");

  const lockDirectory = resolve(lockPath);
  await fsPromises.mkdir(lockDirectory, { recursive: true, mode: DOMAIN_MODE });
  const store = await openDurableAppendStore({ path: resolve(journalPath), maxRecordBytes: MAX_RECORD_BYTES });
  /** The process holding a lock is this one; the host and boot are the owner run's, which runs here. */
  let holder = null;
  try {
    holder = { ...(await inspectProcessIdentity(process.pid)), hostId: ownerRun.hostId, bootId: ownerRun.bootId };
  } catch {
    holder = null;
  }

  /** @type {Set<string>} */
  const spentOperationIds = new Set();
  /** @type {Set<string>} */
  const spentReservationIds = new Set();
  /** @type {Map<string, {operationId:string,operation:string,identity:ClaimIdentity,source:ClaimIdentity|null}>} */
  const liveReservations = new Map();
  /** Set once a journal write's durability became unknown. Nothing is decided from the journal after it. */
  let unknownOutcome = /** @type {CanonicalReservationError|undefined} */ (undefined);
  let closed = false;

  const generation = () => {
    const value = currentGeneration();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("currentGeneration must return a non-negative safe integer");
    return value;
  };

  /**
   * Ids this same owner run already spent survive a re-registration; only a new run id clears them.
   *
   * A journal this read cannot make sense of is not a reason to open unmanaged: a host without the
   * canonical trio leaves Pi's stock overwrite behaviour in charge, which is the opposite of failing
   * closed. The backend opens with nothing seeded, and every decision below re-reads the journal and
   * refuses on the same failure.
   */
  try {
    for (const record of await readJournal(resolve(journalPath))) {
      if (record.record === "cleared" || !sameOwnerRun(record.owner, ownerRun)) continue;
      if (record.record === "prepared") {
        spentOperationIds.add(record.operationId);
        liveReservations.set(record.reservationId, { operationId: record.operationId, operation: record.operation, identity: record.target, source: record.source });
        continue;
      }
      liveReservations.delete(record.reservationId);
      spentReservationIds.add(record.reservationId);
    }
  } catch (unreadable) {
    if (!(unreadable instanceof CanonicalReservationError)) throw unreadable;
  }

  /** @param {string} stage */
  const reached = async (stage) => {
    await failpoint(stage);
  };

  /**
   * Append one record and make it durable, then hand the caller the fold it produced.
   *
   * Between the write and a successful sync the record's durability is unknown, so a failure at either
   * point blocks this backend permanently instead of guessing. Nothing is rolled back and nothing is
   * replayed: the claim stays exactly as durable as it turned out to be, which keeps it uncertain rather
   * than released.
   * @param {string} kind @param {Record<string, unknown>} fields
   */
  const append = async (kind, fields) => {
    const record = { version: CANONICAL_JOURNAL_VERSION, record: kind, at: new Date().toISOString(), owner: ownerRun, ...fields };
    await reached(`before_${kind}_append`);
    try {
      await store.write(record);
      await reached(`after_${kind}_append`);
      await store.sync();
      await reached(`after_${kind}_sync`);
    } catch (cause) {
      unknownOutcome = new CanonicalReservationError("JOURNAL_OUTCOME_UNKNOWN", `a ${kind} record's durability is unknown, so this journal decides nothing further`, { cause });
      throw cause;
    }
    return record;
  };

  /** @returns {Promise<Claim[]>} */
  const currentClaims = async () => {
    if (unknownOutcome !== undefined) throw unknownOutcome;
    if (closed) throw new CanonicalReservationError("CLOSED", "These canonical reservations are closed");
    return foldClaims(await readJournal(resolve(journalPath)));
  };

  /** @param {Claim[]} claims */
  const boundClaimIn = (claims) => claims.find((claim) => claim.state === "committed" && claim.binds && sameOwnerRun(claim.owner, ownerRun));

  /** @param {string} lockDirectoryPath */
  const readLockRecord = async (lockDirectoryPath) => {
    let entries;
    try {
      entries = await fsOps.readdir(lockDirectoryPath);
    } catch {
      return null;
    }
    if (entries.length !== 1) return null;
    try {
      const bytes = await fsOps.readFile(join(lockDirectoryPath, entries[0]), "utf8");
      const record = JSON.parse(bytes);
      return record?.token === entries[0] ? { bytes, holder: record.holder } : null;
    } catch {
      return null;
    }
  };

  /**
   * Acquire one canonical path lock, recovering a published lock only on host-scoped proof.
   *
   * The first attempt supplies an inspector that never answers, so `lifecycle-lock`'s own local-PID
   * reclaim cannot fire. Recovery is a second attempt, made only after `hostProof` proved the *recorded*
   * holder absent, and its inspector re-reads the lock record and refuses unless the bytes are still the
   * ones that proof was computed from. The unlink, the token check and the record re-read stay in
   * `lifecycle-lock`; only the proof is this module's.
   * @param {{canonicalFile:string,path:string}} entry
   */
  const acquireClaimLock = async (entry) => {
    const payload = { canonicalFile: entry.canonicalFile, ownerRunId: ownerRun.runId };
    const refuse = async () => {
      throw new CanonicalReservationError("HOST_PROOF_REQUIRED", `a canonical lock holder is only reclaimed on proof from its recorded host`);
    };
    try {
      return await acquireLifecycleLock(entry.path, payload, fsOps, { inspect: refuse, reclaimIdentityFreeLock: false, holder });
    } catch (held) {
      if (!(held instanceof LifecycleLockError)) throw held;
      const snapshot = await readLockRecord(entry.path);
      if (snapshot === null) throw held;
      const recorded = snapshot.holder;
      if (recorded?.hostId === undefined || recorded?.bootId === undefined || !Number.isSafeInteger(recorded?.pid)) throw held;
      const verdict = await verifier.proveOwnerAbsence({ ...ownerRun, hostId: recorded.hostId, bootId: recorded.bootId, ownerPid: recorded.pid, ownerStartIdentity: String(recorded.startIdentity) });
      if (verdict.proof !== "absent") throw held;
      const provenAbsent = async (/** @type {number} */ pid) => {
        const current = await readLockRecord(entry.path);
        if (pid !== recorded.pid || current === null || current.bytes !== snapshot.bytes) await refuse();
        const absent = new Error(`canonical lock holder pid ${pid} is absent on recorded host ${recorded.hostId}: ${verdict.evidence}`);
        /** @type {NodeJS.ErrnoException} */ (absent).code = "ESRCH";
        throw absent;
      };
      return await acquireLifecycleLock(entry.path, payload, fsOps, { inspect: provenAbsent, reclaimIdentityFreeLock: false, holder });
    }
  };

  /**
   * Hold the locks for every path an operation touches, in the globally defined order.
   * @template T @param {readonly string[]} canonicalFiles @param {(claims: Claim[]) => Promise<T>} body
   */
  const withClaimLocks = async (canonicalFiles, body) => {
    const ordered = await orderCanonicalLocks(lockDirectory, canonicalFiles);
    /** @type {{release(): Promise<boolean>}[]} */
    const held = [];
    try {
      for (const entry of ordered) held.push(await acquireClaimLock(entry));
      return await body(await currentClaims());
    } finally {
      for (const lock of held.reverse()) await lock.release().catch(() => {});
    }
  };

  /** @param {Claim} claim @returns {Promise<{state:"live"|"uncertain",absenceProven:boolean,reason:string,owner:OwnerRunIdentity}>} */
  const reconcileClaim = async (claim) => {
    if (sameOwnerRun(claim.owner, ownerRun)) {
      return { state: "live", absenceProven: false, reason: `this owner run holds ${claim.target.canonicalFile}`, owner: claim.owner };
    }
    const verdict = await verifier.proveOwnerAbsence(claim.owner);
    if (verdict.proof === "live") return { state: "live", absenceProven: false, reason: verdict.evidence, owner: claim.owner };
    // Absence is not a release: whether the mutation this claim covered happened is unknown, and only an
    // explicit operator action clears it.
    return { state: "uncertain", absenceProven: verdict.proof === "absent", reason: verdict.evidence, owner: claim.owner };
  };

  /** @param {Claim[]} claims @param {ClaimIdentity} identity */
  const claimOn = (claims, identity) => claims.find((claim) => sameIdentity(claim.target, identity));

  /** @param {string} code @param {string} message */
  const refusal = (code, message) => ({ refused: /** @type {true} */ (true), code, message });

  /** @param {string} reservationId */
  const liveReservation = (reservationId) => {
    const live = liveReservations.get(reservationId);
    if (live !== undefined) return live;
    if (spentReservationIds.has(reservationId)) {
      throw new CanonicalReservationError("SPENT_RESERVATION", `reservation ${reservationId} is spent; a reservation is one use for this owner run's lifetime`);
    }
    throw new CanonicalReservationError("NOT_RESERVED", `reservation ${reservationId} was not admitted to this owner run`);
  };

  /** @param {Claim[]} claims @param {string} reservationId */
  const reservedClaim = (claims, reservationId) => {
    const claim = claims.find((entry) => entry.reservationId === reservationId && sameOwnerRun(entry.owner, ownerRun));
    if (claim === undefined) throw new CanonicalReservationError("NOT_RESERVED", `reservation ${reservationId} holds no claim in this journal`);
    return claim;
  };

  /**
   * Seam D's `admitCanonicalOperation`: decide one canonical mutation before Pi's first side effect.
   *
   * A superseded generation and a replayed operation id are refused before anything is touched, so
   * neither leaves a journal entry. Everything else is decided while holding the target's lock — and the
   * source's, when this owner is bound to one — after re-reading the journal and re-reading the owner's
   * authoritative generation there, because the fold read before the lock may already be stale.
   *
   * Every failure is a refusal rather than a throw, so a host cannot turn a storage problem into an
   * unmanaged Pi. Only a contract violation — a target that is not one exact final filename — throws.
   * @param {unknown} operation
   */
  const admit = async (operation) => {
    const requested = parseCanonicalOperation(operation);
    try {
      if (unknownOutcome !== undefined) throw unknownOutcome;
      if (closed) throw new CanonicalReservationError("CLOSED", "These canonical reservations are closed");
      if (requested.currentBinding.generation !== generation()) {
        return refusal("STALE_BINDING", `this operation carries generation ${requested.currentBinding.generation} and the owner's binding is at ${generation()}`);
      }
      if (spentOperationIds.has(requested.operationId)) {
        return refusal("DUPLICATE_OPERATION", `operation ${requested.operationId} was already admitted for this owner run, and a reservation is one use for the owner's lifetime`);
      }
      const identity = await resolveClaimIdentity(requested.resolvedTarget.canonicalFile);
      const bound = boundClaimIn(await currentClaims());
      const files = bound === undefined ? [identity.canonicalFile] : [identity.canonicalFile, bound.target.canonicalFile];
      return await withClaimLocks(files, async (claims) => {
        if (requested.currentBinding.generation !== generation()) {
          return refusal("STALE_BINDING", `this operation's generation ${requested.currentBinding.generation} was superseded before it could be admitted`);
        }
        if (spentOperationIds.has(requested.operationId)) return refusal("DUPLICATE_OPERATION", `operation ${requested.operationId} was already admitted for this owner run`);
        const existing = claimOn(claims, identity);
        if (existing !== undefined && !sameOwnerRun(existing.owner, ownerRun)) {
          const state = await reconcileClaim(existing);
          if (state.state === "live") {
            return refusal("TARGET_HAS_LIVE_WRITER", `${identity.canonicalFile} is claimed by owner run ${existing.owner.runId}: ${state.reason}. ${RETRY_HINT}`);
          }
          return refusal("TARGET_UNCERTAIN", `${identity.canonicalFile} holds an unresolved claim from owner run ${existing.owner.runId}: ${state.reason}. An operator must clear it with proof from its recorded host`);
        }
        const reservationId = randomUUID();
        const source = bound === undefined || sameIdentity(bound.target, identity) ? null : bound.target;
        await append("prepared", {
          operationId: requested.operationId,
          reservationId,
          operation: requested.operation,
          generation: requested.currentBinding.generation,
          requestedTarget: requested.resolvedTarget.canonicalFile,
          target: identity,
          source,
        });
        spentOperationIds.add(requested.operationId);
        liveReservations.set(reservationId, { operationId: requested.operationId, operation: requested.operation, identity, source });
        return { reservationId };
      });
    } catch (error) {
      if (error instanceof TypeError) throw error;
      // A lock another owner holds right now lands here too. Nothing waits on a canonical lock: the
      // decision is refused with what happened, and nothing was reserved or written, so it can be retried.
      return refusal("ADMISSION_UNAVAILABLE", `this host could not decide the operation and reserved nothing: ${error instanceof Error ? error.message : String(error)}. Nothing was written, so ${RETRY_HINT}`);
    }
  };

  /**
   * Move this owner's claim, and its generation, from the file it was bound to onto the reserved target.
   *
   * One record does both, so there is no instant in which the journal shows two live claims for one owner,
   * or none. `commitBinding` calls this for every rebind; Pi itself only ever calls `commitBinding`.
   * @param {{reservationId:string, nextGeneration:number}} move
   */
  const transfer = async (move) => {
    onlyFields(move, ["reservationId", "nextGeneration"], "transfer");
    const reservationId = boundedString(move.reservationId, "transfer.reservationId");
    if (!Number.isSafeInteger(move.nextGeneration) || move.nextGeneration < 1) throw new TypeError("transfer.nextGeneration must be a safe integer of at least 1");
    const live = liveReservation(reservationId);
    const bound = boundClaimIn(await currentClaims());
    if (bound === undefined) throw new CanonicalReservationError("NOTHING_TO_TRANSFER", "This owner run holds no committed binding to transfer");
    if (sameIdentity(bound.target, live.identity)) throw new CanonicalReservationError("NOTHING_TO_TRANSFER", "A reservation for the file this owner is already bound to is not a transfer");
    await withClaimLocks([live.identity.canonicalFile, bound.target.canonicalFile], async (locked) => {
      const claim = reservedClaim(locked, reservationId);
      if (move.nextGeneration !== generation()) {
        throw new CanonicalReservationError("GENERATION_NOT_AUTHORITATIVE", `transfer.nextGeneration ${move.nextGeneration} is not the generation the owner's binding reports (${generation()})`);
      }
      if (move.nextGeneration <= bound.generation) {
        throw new CanonicalReservationError("GENERATION_NOT_AUTHORITATIVE", `a transfer advances the generation past ${bound.generation}, and ${move.nextGeneration} does not`);
      }
      const target = await resolveClaimIdentity(claim.target.canonicalFile);
      await append("transferred", { reservationId, generation: move.nextGeneration, target, released: bound.target });
      spentReservationIds.add(reservationId);
      liveReservations.delete(reservationId);
    });
  };

  /**
   * Seam D's `commitBinding`: persist the authoritative binding the owner's own supplier reports.
   *
   * `nextGeneration` must equal what `currentGeneration()` reports now. Pi sends the generation its binding
   * supplier reports after the replacement finished, so a value this host computed for itself — an
   * increment per operation, say — would be a guess about a rebind that may not have happened.
   *
   * An advanced generation onto another file is a rebind, and a rebind is a `transfer`. Anything else
   * commits the unchanged generation, which is what a selector rename, a selector delete and a reload onto
   * the same file all report. A selector operation's committed claim does not become this owner's binding.
   * @param {{reservationId:string, nextGeneration:number}} commit
   */
  const commitBinding = async (commit) => {
    onlyFields(commit, ["reservationId", "nextGeneration"], "commit");
    const reservationId = boundedString(commit.reservationId, "commit.reservationId");
    if (!Number.isSafeInteger(commit.nextGeneration) || commit.nextGeneration < 1) throw new TypeError("commit.nextGeneration must be a safe integer of at least 1");
    const live = liveReservation(reservationId);
    const bound = boundClaimIn(await currentClaims());
    if (bound !== undefined && commit.nextGeneration > bound.generation && !sameIdentity(bound.target, live.identity)) {
      return await transfer({ reservationId, nextGeneration: commit.nextGeneration });
    }
    const files = bound === undefined ? [live.identity.canonicalFile] : [live.identity.canonicalFile, bound.target.canonicalFile];
    await withClaimLocks(files, async (locked) => {
      const claim = reservedClaim(locked, reservationId);
      if (commit.nextGeneration !== generation()) {
        throw new CanonicalReservationError("GENERATION_NOT_AUTHORITATIVE", `commit.nextGeneration ${commit.nextGeneration} is not the generation the owner's binding reports (${generation()})`);
      }
      const target = await resolveClaimIdentity(claim.target.canonicalFile);
      const holdsBinding = bound === undefined || sameIdentity(bound.target, target);
      await append("committed", { reservationId, generation: commit.nextGeneration, binds: holdsBinding, target });
      spentReservationIds.add(reservationId);
      liveReservations.delete(reservationId);
    });
  };

  /**
   * Seam D's `abortReservation`: drop a reservation whose operation definitely mutated nothing.
   *
   * A committed reservation is refused: a committed claim leaves only through `releaseCommitted` or a
   * `transfer`, so an abort can never be the thing that frees a file Pi may still be writing.
   * @param {{reservationId:string, reason:string}} abort
   */
  const abortReservation = async (abort) => {
    onlyFields(abort, ["reservationId", "reason"], "abort");
    const reservationId = boundedString(abort.reservationId, "abort.reservationId");
    const reason = boundedString(abort.reason, "abort.reason", 1024);
    const live = liveReservation(reservationId);
    await withClaimLocks([live.identity.canonicalFile], async (locked) => {
      const claim = reservedClaim(locked, reservationId);
      if (claim.state !== "prepared") throw new CanonicalReservationError("SPENT_RESERVATION", `reservation ${reservationId} is committed and is released explicitly, never aborted`);
      await append("aborted", { reservationId, target: claim.target, reason });
      spentReservationIds.add(reservationId);
      liveReservations.delete(reservationId);
    });
  };

  /**
   * Release a committed claim, explicitly.
   *
   * This and a `transfer` are the only things that free a committed file. No timeout, no disconnect, no
   * idle model and no `close()` reaches it.
   * @param {{reservationId:string, reason:string}} release
   */
  const releaseCommitted = async (release) => {
    onlyFields(release, ["reservationId", "reason"], "release");
    const reservationId = boundedString(release.reservationId, "release.reservationId");
    const reason = boundedString(release.reason, "release.reason", 1024);
    const recorded = reservedClaim(await currentClaims(), reservationId);
    await withClaimLocks([recorded.target.canonicalFile], async (locked) => {
      const claim = reservedClaim(locked, reservationId);
      if (claim.state !== "committed") throw new CanonicalReservationError("NOT_COMMITTED", `reservation ${reservationId} has no committed claim to release`);
      await append("released", { reservationId, target: claim.target, reason });
      spentReservationIds.add(reservationId);
      liveReservations.delete(reservationId);
    });
  };

  /**
   * Report whether one exact file is claimed: `live`, `released` or `uncertain`.
   *
   * `released` covers a file no claim was ever recorded for, because in both cases the journal shows
   * nobody holding it. `uncertain` is everything that is neither, including a claim whose recorded host
   * cannot be reached — for as long as that stays true, with no expiry.
   * @param {{canonicalFile:string}} query
   */
  const reconcile = async (query) => {
    onlyFields(query, ["canonicalFile"], "reconcile");
    const identity = await resolveClaimIdentity(boundedString(query.canonicalFile, "reconcile.canonicalFile", 4096));
    const claim = claimOn(await currentClaims(), identity);
    if (claim === undefined) return { state: /** @type {const} */ ("released"), absenceProven: false, reason: `no claim is recorded for ${identity.canonicalFile}`, owner: null };
    return await reconcileClaim(claim);
  };

  /**
   * Clear one uncertain claim, on an explicit operator action, and journal that it happened.
   *
   * The proof is not the operator's to assert: there is no parameter for it. The verdict is taken from the
   * trusted verifier for the claim's *recorded* host and boot, under the claim's own lock, at the moment
   * of clearing — so a claim that became live again, or one whose host is merely unreachable, is refused.
   * This is the explicit recovery that no timeout and no connection cleanup can perform.
   * @param {{canonicalFile:string, operator:string, reason:string}} request
   */
  const clearUncertainClaim = async (request) => {
    onlyFields(request, ["canonicalFile", "operator", "reason"], "clear");
    const identity = await resolveClaimIdentity(boundedString(request.canonicalFile, "clear.canonicalFile", 4096));
    const operator = boundedString(request.operator, "clear.operator", 256);
    const reason = boundedString(request.reason, "clear.reason", 1024);
    return await withClaimLocks([identity.canonicalFile], async (claims) => {
      const claim = claimOn(claims, identity);
      if (claim === undefined) throw new CanonicalReservationError("NO_CLAIM", `no claim is recorded for ${identity.canonicalFile}`);
      const state = await reconcileClaim(claim);
      if (state.state !== "uncertain") throw new CanonicalReservationError("CLAIM_NOT_UNCERTAIN", `${identity.canonicalFile} is not uncertain: ${state.reason}`);
      if (!state.absenceProven) {
        throw new CanonicalReservationError("NO_ABSENCE_PROOF", `no proof from recorded host ${claim.owner.hostId} that owner run ${claim.owner.runId} is gone: ${state.reason}`);
      }
      await append("cleared", { clearedOwner: claim.owner, clearedReservationId: claim.reservationId, target: claim.target, operator, reason, evidence: state.reason });
      return { cleared: /** @type {const} */ (true), evidence: state.reason, clearedOwner: claim.owner };
    });
  };

  return {
    /** The journal, the lock directory and the owner run this backend actually opened. */
    domain: { journalPath: resolve(journalPath), lockPath: lockDirectory, owner: ownerRun },
    admit,
    commitBinding,
    transfer,
    abortReservation,
    releaseCommitted,
    reconcile,
    clearUncertainClaim,
    /** Close the journal. It releases nothing: a claim outlives the process that recorded it. */
    async close() {
      closed = true;
      await store.close();
    },
  };
}
