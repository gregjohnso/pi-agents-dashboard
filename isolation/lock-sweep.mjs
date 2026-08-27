import * as fs from "node:fs/promises";
import { join } from "node:path";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";

const LOCK_SUFFIXES = [".pi-dashboard-ownership.lock", ".pi-agents-dashboard-ownership.lock"];

/** @param {any} holder */
function hasHolderIdentity(holder) {
  return typeof holder === "object" && holder !== null && Number.isSafeInteger(holder.pid) && holder.pid > 0 && typeof holder.startIdentity === "string" && holder.startIdentity.length > 0;
}

/** @param {string} path @param {any} fsOps */
async function readLockRecord(path, fsOps) {
  const entries = await fsOps.readdir(path);
  if (entries.length !== 1) return undefined;
  try {
    return JSON.parse(await fsOps.readFile(join(path, entries[0]), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Reclaim worktree ownership locks that no live operation can still hold.
 *
 * Only daemon-side operations take these locks, so a lock older than this daemon's start
 * belonged to a daemon that is gone. Anything unreadable, newer, or held by a live process stays.
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

    const record = await readLockRecord(path, fsOps).catch(() => undefined);
    if (record === undefined) continue;
    if (hasHolderIdentity(record.holder)) {
      try {
        const actual = await inspect(record.holder.pid);
        if (actual?.pid === record.holder.pid && actual?.startIdentity === record.holder.startIdentity) continue;
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? "")) continue;
      }
    } else if (record.holder !== undefined) {
      continue;
    }

    await fsOps.rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}
