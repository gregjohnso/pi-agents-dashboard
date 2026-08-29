import * as fs from "node:fs/promises";
import { join } from "node:path";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";

const LOCK_SUFFIXES = [".pi-agents-ownership.lock", ".pi-dashboard-ownership.lock", ".pi-agents-dashboard-ownership.lock"];
const ABSENT_PROCESS_CODES = ["ENOENT", "ESRCH"];

/** @param {any} holder */
function hasHolderIdentity(holder) {
  return typeof holder === "object" && holder !== null && Number.isSafeInteger(holder.pid) && holder.pid > 0 && typeof holder.startIdentity === "string" && holder.startIdentity.length > 0;
}

/**
 * Read a lock's single token entry together with the identity of the directory it came from.
 *
 * @param {string} path @param {any} fsOps
 * @returns {Promise<{ entryPath: string, serialized: string, record: any, dev: number, ino: number } | undefined>}
 */
async function inspectLock(path, fsOps) {
  try {
    const directory = await fsOps.lstat(path);
    const entries = await fsOps.readdir(path);
    if (entries.length !== 1) return undefined;
    const entryPath = join(path, entries[0]);
    const serialized = await fsOps.readFile(entryPath, "utf8");
    return { entryPath, serialized, record: JSON.parse(serialized), dev: directory.dev, ino: directory.ino };
  } catch {
    return undefined;
  }
}

/**
 * Confirm the lock directory and its token entry are byte-for-byte the ones that were inspected.
 *
 * @param {string} path @param {{ entryPath: string, serialized: string, dev: number, ino: number }} inspected @param {any} fsOps
 */
async function lockIsUnchanged(path, inspected, fsOps) {
  try {
    const directory = await fsOps.lstat(path);
    if (!directory.isDirectory() || directory.dev !== inspected.dev || directory.ino !== inspected.ino) return false;
    const entries = await fsOps.readdir(path);
    if (entries.length !== 1 || join(path, entries[0]) !== inspected.entryPath) return false;
    return (await fsOps.readFile(inspected.entryPath, "utf8")) === inspected.serialized;
  } catch {
    return false;
  }
}

/**
 * Reclaim worktree ownership locks that no live operation can still hold.
 *
 * Only daemon-side operations take these locks, so a lock older than this daemon's start
 * belonged to a daemon that is gone. A lock is reclaimed only when its record carries complete
 * holder identity, that holder is provably gone, and the directory and token entry are still
 * exactly the ones that were inspected. Every other case keeps the lock.
 *
 * @param {{ worktreesRoot: string, startedAt: string, inspect?: (pid: number) => Promise<any>, fsOps?: any }} options
 * @returns {Promise<string[]>} removed lock paths
 */
export async function sweepStaleWorktreeLocks({ worktreesRoot, startedAt, inspect = inspectProcessIdentity, fsOps = fs }) {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) throw new TypeError("Lock sweep requires the daemon start timestamp");
  /** @type {string[]} */
  let names;
  try {
    names = await fsOps.readdir(worktreesRoot);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return [];
    throw error;
  }

  /** @type {string[]} */
  const removed = [];
  for (const name of names.sort()) {
    if (!LOCK_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
    const path = join(worktreesRoot, name);
    let metadata;
    try {
      metadata = await fsOps.lstat(path);
    } catch {
      continue;
    }
    if (!metadata.isDirectory() || metadata.mtimeMs >= startedAtMs) continue;

    const inspected = await inspectLock(path, fsOps);
    if (inspected === undefined || !hasHolderIdentity(inspected.record.holder)) continue;
    const holder = inspected.record.holder;
    try {
      const actual = await inspect(holder.pid);
      if (actual?.pid === holder.pid && actual?.startIdentity === holder.startIdentity) continue;
    } catch (error) {
      if (!ABSENT_PROCESS_CODES.includes(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? "")) continue;
    }

    if (!(await lockIsUnchanged(path, inspected, fsOps))) continue;
    try {
      await fsOps.unlink(inspected.entryPath);
    } catch {
      continue;
    }
    await fsOps.rmdir(path).catch(() => {});
    removed.push(path);
  }
  return removed;
}
