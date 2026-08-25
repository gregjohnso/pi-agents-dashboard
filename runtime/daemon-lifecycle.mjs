import * as fs from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-file.mjs";
import { acquireLifecycleLock, LifecycleLockError } from "./lifecycle-lock.mjs";

const PUBLICATION_KEYS = ["schemaVersion", "pid", "startIdentity", "processGroupId", "daemonEpoch", "tokenPath", "startedAt"];

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
  if (value.schemaVersion !== 1 || typeof value.daemonEpoch !== "string" || value.daemonEpoch.length === 0 || typeof value.tokenPath !== "string" || value.tokenPath.length === 0 || typeof value.startedAt !== "string") throw new TypeError("Daemon publication is invalid");
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

/** @param {{ root: string, inspect(pid: number): Promise<any>, probe?(publication: any): Promise<boolean>, fsOps?: any }} options */
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
  let reachable = false;
  try {
    reachable = await probe?.(publication) ?? false;
  } catch {
  }
  return { status: reachable ? "HEALTHY" : "UNHEALTHY", canCleanup: false, publication };
}

/** @param {{ root: string, inspect(pid: number): Promise<any>, probe?: (publication: any) => Promise<boolean>, fsOps?: any }} options */
export async function cleanupStaleDaemon({ root, inspect, probe, fsOps = fs }) {
  const endpoint = await inspectDaemonEndpoint({ root, inspect, probe, fsOps });
  if (endpoint.status !== "STALE" || endpoint.canCleanup !== true) throw new DaemonLifecycleError("UNSAFE_STALE_CLEANUP", "Exact daemon identity does not authorize endpoint cleanup");
  const daemon = join(root, "daemon");
  await fsOps.rm(join(daemon, "control.sock"), { force: true });
  await fsOps.rm(join(daemon, "pid.json"), { force: true });
  await fsOps.rm(join(daemon, "lifecycle.lock"), { recursive: true, force: true });
  return endpoint;
}

/** @param {{ root: string, identity: any, daemonEpoch: string, tokenPath: string, inspect(pid: number): Promise<any>, probe?: (publication: any) => Promise<boolean>, now?: () => string, fsOps?: any }} options */
export async function claimDaemonLifecycle({ root, identity, daemonEpoch, tokenPath, inspect, probe = async () => false, now = () => new Date().toISOString(), fsOps = fs }) {
  validateIdentity(identity);
  const daemon = join(root, "daemon");
  const lockPath = join(daemon, "lifecycle.lock");
  let lock;
  try {
    lock = await acquireLifecycleLock(lockPath, { pid: identity.pid, startIdentity: identity.startIdentity }, fsOps);
  } catch (error) {
    if (!(error instanceof LifecycleLockError)) throw error;
    const endpoint = await inspectDaemonEndpoint({ root, inspect, probe, fsOps });
    if (endpoint.status === "STALE") {
      await cleanupStaleDaemon({ root, inspect, probe, fsOps });
      lock = await acquireLifecycleLock(lockPath, { pid: identity.pid, startIdentity: identity.startIdentity }, fsOps);
    } else if (endpoint.status === "HEALTHY" || endpoint.status === "UNHEALTHY") {
      throw new DaemonLifecycleError("DAEMON_ALREADY_RUNNING", "A verified daemon already owns the per-user endpoint");
    } else {
      throw new DaemonLifecycleError("DAEMON_IDENTITY_CONFLICT", "Lifecycle lock ownership cannot be verified", { cause: error });
    }
  }
  const publication = { schemaVersion: 1, ...identity, daemonEpoch, tokenPath, startedAt: now() };
  try {
    await atomicWriteJson(join(daemon, "pid.json"), publication, fsOps);
  } catch (error) {
    await lock.release().catch(() => {});
    throw error;
  }
  return { root, lock, publication };
}

/** @param {any} claim @param {{ preservePublication?: boolean, fsOps?: any }} [options] */
export async function releaseDaemonLifecycle(claim, { preservePublication = false, fsOps = fs } = {}) {
  if (!preservePublication) {
    await fsOps.rm(join(claim.root, "daemon", "control.sock"), { force: true });
    await fsOps.rm(join(claim.root, "daemon", "pid.json"), { force: true });
  }
  await claim.lock.release();
}
