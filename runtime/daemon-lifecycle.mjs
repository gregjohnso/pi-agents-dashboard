import * as fs from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-file.mjs";
import { acquireLifecycleLock, LifecycleLockError } from "./lifecycle-lock.mjs";

const DAEMON_STATES = new Set(["STARTING", "RECONCILING", "READY", "FAILED"]);
const PUBLICATION_KEYS = ["schemaVersion", "pid", "startIdentity", "processGroupId", "daemonEpoch", "tokenPath", "startedAt", "state", "error"];

export class DaemonLifecycleError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "DaemonLifecycleError";
    this.code = code;
  }
}

/** @param {any} left @param {any} right */
function sameIdentity(left, right) {
  return left?.pid === right?.pid && left?.startIdentity === right?.startIdentity && left?.processGroupId === right?.processGroupId;
}

/** @param {any} left @param {any} right */
function samePublication(left, right) {
  return sameIdentity(left, right) && left?.daemonEpoch === right?.daemonEpoch && left?.tokenPath === right?.tokenPath && left?.startedAt === right?.startedAt;
}

/** @param {any} identity */
function validateIdentity(identity) {
  if (!Number.isSafeInteger(identity?.pid) || identity.pid <= 0 || typeof identity.startIdentity !== "string" || identity.startIdentity.length === 0 || !Number.isSafeInteger(identity.processGroupId) || identity.processGroupId <= 0) {
    throw new TypeError("Daemon requires an exact process identity");
  }
}

/** @param {any} value */
function validatePublication(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Daemon publication must be an object");
  if (Object.keys(value).some((key) => !PUBLICATION_KEYS.includes(key))) throw new TypeError("Daemon publication contains unknown fields");
  if (value.schemaVersion !== 1 || typeof value.daemonEpoch !== "string" || value.daemonEpoch.length === 0 || typeof value.tokenPath !== "string" || value.tokenPath.length === 0 || typeof value.startedAt !== "string" || !DAEMON_STATES.has(value.state)) throw new TypeError("Daemon publication is invalid");
  if (value.error !== undefined && (typeof value.error !== "object" || value.error === null || typeof value.error.code !== "string" || typeof value.error.message !== "string")) throw new TypeError("Daemon publication error is invalid");
  validateIdentity(value);
  return value;
}

/** @param {string} root @param {any} [fsOps] */
async function readPublication(root, fsOps = fs) {
  const path = join(root, "daemon", "pid.json");
  try {
    const metadata = await fsOps.lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid?.()) throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Daemon publication is not a private owned file");
    return validatePublication(JSON.parse(await fsOps.readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined;
    if (error instanceof DaemonLifecycleError) throw error;
    throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Daemon publication is corrupt", { cause: error });
  }
}

/** @param {unknown} probeResult */
function probeState(probeResult) {
  if (probeResult === true) return { reachable: true };
  if (typeof probeResult === "object" && probeResult !== null && /** @type {any} */ (probeResult).reachable === true) return /** @type {any} */ (probeResult);
  return { reachable: false };
}

/** @param {{ root: string, inspect(pid: number): Promise<any>, probe?(publication: any): Promise<boolean | Record<string, unknown>>, fsOps?: any }} options */
export async function inspectDaemonEndpoint({ root, inspect, probe = async () => false, fsOps = fs }) {
  const publication = await readPublication(root, fsOps);
  if (publication === undefined) return { status: "ABSENT", canCleanup: false };
  let actual;
  try {
    actual = await inspect(publication.pid);
  } catch (error) {
    if (error instanceof Error && ["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) return { status: "STALE", canCleanup: true, publication };
    return { status: "CONFLICT", canCleanup: false, publication, error };
  }
  if (!sameIdentity(actual, publication)) return { status: "STALE", canCleanup: true, publication, actual };
  /** @type {any} */
  let reported = { reachable: false };
  try {
    reported = probeState(await probe?.(publication));
  } catch {
  }
  if (reported.reachable && (reported.state === "FAILED" || reported.state === "CONFLICT")) {
    return { status: "CONFLICT", canCleanup: false, publication, daemonState: reported.state, error: reported.error };
  }
  return {
    status: reported.reachable ? "HEALTHY" : "UNHEALTHY",
    canCleanup: false,
    publication,
    daemonState: reported.state ?? publication.state,
    error: reported.error ?? publication.error,
  };
}

/** @param {string} path @param {(pid: number) => Promise<any>} inspect @param {any} fsOps */
async function removeLegacyLockIfStale(path, inspect, fsOps) {
  let entries;
  try {
    entries = await fsOps.readdir(path);
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return false;
    throw error;
  }
  if (entries.length !== 1) throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Lifecycle lock record is ambiguous");
  const entryPath = join(path, entries[0]);
  let lockRecord;
  try {
    lockRecord = JSON.parse(await fsOps.readFile(entryPath, "utf8"));
    if (lockRecord?.token !== entries[0] || typeof lockRecord.owner?.pid !== "number" || typeof lockRecord.owner?.startIdentity !== "string" || (lockRecord.owner.processGroupId !== undefined && typeof lockRecord.owner.processGroupId !== "number")) throw new TypeError("invalid lock record");
  } catch (cause) {
    throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Lifecycle lock record is corrupt", { cause });
  }
  try {
    const actual = await inspect(lockRecord.owner.pid);
    if (actual?.pid === lockRecord.owner.pid && actual?.startIdentity === lockRecord.owner.startIdentity && (lockRecord.owner.processGroupId === undefined || actual?.processGroupId === lockRecord.owner.processGroupId)) throw new DaemonLifecycleError("DAEMON_ALREADY_RUNNING", "A live daemon lifecycle transaction is still active");
  } catch (error) {
    if (error instanceof DaemonLifecycleError) throw error;
    if (!(error instanceof Error) || !["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Lifecycle lock ownership cannot be verified", { cause: error });
  }
  let current;
  try {
    current = JSON.parse(await fsOps.readFile(entryPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return false;
    throw error;
  }
  if (current?.token !== lockRecord.token || current?.owner?.pid !== lockRecord.owner.pid || current?.owner?.startIdentity !== lockRecord.owner.startIdentity || current?.owner?.processGroupId !== lockRecord.owner.processGroupId) throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Lifecycle lock identity changed during stale recovery");
  try {
    await fsOps.unlink(entryPath);
  } catch (error) {
    if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
  await fsOps.rmdir(path).catch((/** @type {any} */ error) => {
    if (!(error instanceof Error) || !["ENOENT", "ENOTEMPTY"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) throw error;
  });
  return true;
}

/** @param {string} path @param {any} owner @param {(pid: number) => Promise<any>} inspect @param {any} fsOps */
async function acquireRecoverableLock(path, owner, inspect, fsOps) {
  try {
    return await acquireLifecycleLock(path, owner, fsOps);
  } catch (error) {
    if (!(error instanceof LifecycleLockError)) throw error;
  }
  await removeLegacyLockIfStale(path, inspect, fsOps);
  try {
    return await acquireLifecycleLock(path, owner, fsOps);
  } catch (error) {
    if (error instanceof LifecycleLockError) throw new DaemonLifecycleError("DAEMON_BUSY", "Another lifecycle transaction won stale recovery", { cause: error });
    throw error;
  }
}

/** @param {{ root: string, inspect(pid: number): Promise<any>, probe?: (publication: any) => Promise<boolean | Record<string, unknown>>, fsOps?: any }} options */
export async function cleanupStaleDaemon({ root, inspect, probe, fsOps = fs }) {
  const daemon = join(root, "daemon");
  let cleanupIdentity;
  try {
    cleanupIdentity = await inspect(process.pid);
  } catch (cause) {
    throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Cleanup process identity cannot be verified", { cause });
  }
  const transaction = await acquireRecoverableLock(join(daemon, "lifecycle.transaction.lock"), { pid: cleanupIdentity.pid, startIdentity: cleanupIdentity.startIdentity, processGroupId: cleanupIdentity.processGroupId }, inspect, fsOps);
  try {
    const endpoint = await inspectDaemonEndpoint({ root, inspect, probe, fsOps });
    if (endpoint.status !== "STALE" || endpoint.canCleanup !== true) throw new DaemonLifecycleError("UNSAFE_STALE_CLEANUP", "Exact daemon identity does not authorize endpoint cleanup");
    const revalidated = await inspectDaemonEndpoint({ root, inspect, probe, fsOps });
    if (revalidated.status !== "STALE" || !samePublication(revalidated.publication, endpoint.publication)) throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Daemon identity changed during stale cleanup");
    await removeLegacyLockIfStale(join(daemon, "lifecycle.lock"), inspect, fsOps);
    await fsOps.rm(join(daemon, "control.sock"), { force: true });
    await fsOps.rm(join(daemon, "pid.json"), { force: true });
    return endpoint;
  } finally {
    await transaction.release();
  }
}

/** @param {{ root: string, identity: any, daemonEpoch: string, tokenPath: string, inspect(pid: number): Promise<any>, probe?: (publication: any) => Promise<boolean | Record<string, unknown>>, now?: () => string, fsOps?: any }} options */
export async function claimDaemonLifecycle({ root, identity, daemonEpoch, tokenPath, inspect, probe = async () => false, now = () => new Date().toISOString(), fsOps = fs }) {
  validateIdentity(identity);
  const daemon = join(root, "daemon");
  let transaction;
  try {
    transaction = await acquireRecoverableLock(join(daemon, "lifecycle.transaction.lock"), identity, inspect, fsOps);
  } catch (error) {
    if (error instanceof DaemonLifecycleError && error.code === "DAEMON_ALREADY_RUNNING") {
      const endpoint = await inspectDaemonEndpoint({ root, inspect, probe, fsOps });
      if (endpoint.status === "HEALTHY" || endpoint.status === "UNHEALTHY") throw new DaemonLifecycleError("DAEMON_ALREADY_RUNNING", "A verified daemon already owns the per-user endpoint");
      throw new DaemonLifecycleError("DAEMON_BUSY", "A live daemon lifecycle transaction has not published a stable endpoint", { cause: error });
    }
    throw error;
  }

  let lock;
  try {
    const endpoint = await inspectDaemonEndpoint({ root, inspect, probe, fsOps });
    if (endpoint.status === "HEALTHY" || endpoint.status === "UNHEALTHY") throw new DaemonLifecycleError("DAEMON_ALREADY_RUNNING", "A verified daemon already owns the per-user endpoint");
    if (endpoint.status === "CONFLICT") throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Daemon publication ownership cannot be verified");
    if (endpoint.status === "STALE") {
      const revalidated = await inspectDaemonEndpoint({ root, inspect, probe, fsOps });
      if (revalidated.status !== "STALE" || !samePublication(revalidated.publication, endpoint.publication)) throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Daemon identity changed during stale recovery");
      await removeLegacyLockIfStale(join(daemon, "lifecycle.lock"), inspect, fsOps);
      await fsOps.rm(join(daemon, "control.sock"), { force: true });
      await fsOps.rm(join(daemon, "pid.json"), { force: true });
    } else {
      try {
        await fsOps.lstat(join(daemon, "control.sock"));
        throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "An unowned daemon socket cannot be removed safely");
      } catch (error) {
        if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
      }
    }
    await removeLegacyLockIfStale(join(daemon, "lifecycle.lock"), inspect, fsOps);
    lock = await acquireLifecycleLock(join(daemon, "lifecycle.lock"), identity, fsOps);
    const publication = { schemaVersion: 1, ...identity, daemonEpoch, tokenPath, startedAt: now(), state: "STARTING" };
    await atomicWriteJson(join(daemon, "pid.json"), publication, fsOps);
    return { root, lock, transaction, publication };
  } catch (error) {
    await lock?.release().catch(() => {});
    await transaction.release().catch(() => {});
    throw error;
  }
}

/** @param {any} claim @param {"STARTING" | "RECONCILING" | "READY" | "FAILED"} state @param {any} [error] @param {any} [fsOps] */
export async function updateDaemonLifecycleState(claim, state, error, fsOps = fs) {
  if (!DAEMON_STATES.has(state)) throw new TypeError("Invalid daemon lifecycle state");
  const current = await readPublication(claim.root, fsOps);
  if (!samePublication(current, claim.publication)) throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Daemon publication changed while lifecycle was held");
  const publication = { ...claim.publication, state };
  if (error !== undefined) publication.error = { code: typeof error?.code === "string" ? error.code : "RECOVERY_FAILED", message: error instanceof Error ? error.message : String(error) };
  else delete publication.error;
  await atomicWriteJson(join(claim.root, "daemon", "pid.json"), publication, fsOps);
  claim.publication = publication;
  return publication;
}

/** @param {any} claim @param {{ preservePublication?: boolean, removeSocket?: boolean, fsOps?: any }} [options] */
export async function releaseDaemonLifecycle(claim, { preservePublication = false, removeSocket = true, fsOps = fs } = {}) {
  /** @type {unknown[]} */
  const errors = [];
  try {
    if (!preservePublication) {
      const current = await readPublication(claim.root, fsOps).catch(() => undefined);
      if (samePublication(current, claim.publication)) {
        if (removeSocket) await fsOps.rm(join(claim.root, "daemon", "control.sock"), { force: true });
        await fsOps.rm(join(claim.root, "daemon", "pid.json"), { force: true });
      }
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await claim.lock.release();
  } catch (error) {
    errors.push(error);
  }
  try {
    await claim.transaction.release();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "Daemon lifecycle release completed with cleanup errors");
}
