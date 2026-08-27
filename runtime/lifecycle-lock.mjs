import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { inspectProcessIdentity } from "./process-identity-linux.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ABSENT_PROCESS_CODES = ["ENOENT", "ESRCH"];

/** A typed lifecycle-lock acquisition conflict. */
export class LifecycleLockError extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = "LifecycleLockError";
    this.code = "LOCK_HELD";
  }
}

/** @param {unknown} error @param {string[]} codes */
function hasCode(error, codes) {
  return (
    error instanceof Error &&
    codes.includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")
  );
}

/** @param {unknown} value @returns {value is { pid: number, processGroupId: number, startIdentity: string }} */
function isHolderIdentity(value) {
  const holder = /** @type {any} */ (value);
  return (
    typeof holder === "object" &&
    holder !== null &&
    Number.isSafeInteger(holder.pid) &&
    holder.pid > 0 &&
    Number.isSafeInteger(holder.processGroupId) &&
    holder.processGroupId > 0 &&
    typeof holder.startIdentity === "string" &&
    holder.startIdentity.length > 0
  );
}

/**
 * Reclaim a published lock only when its recorded holder is provably gone.
 *
 * Every ambiguity keeps the lock: an unreadable or multi-entry directory, a record without
 * holder identity, an inspection that cannot answer, or a record that changed while we looked.
 *
 * @param {string} path
 * @param {any} fsOps
 * @param {{ inspect(pid: number): Promise<any>, reclaimIdentityFreeLock: boolean }} recovery
 */
async function reclaimDeadHolderLock(path, fsOps, recovery) {
  let entries;
  try {
    entries = await fsOps.readdir(path);
  } catch {
    return false;
  }
  if (entries.length !== 1) {
    return false;
  }

  const entryPath = join(path, entries[0]);
  let record;
  try {
    const metadata = await fsOps.lstat(entryPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return false;
    }
    record = JSON.parse(await fsOps.readFile(entryPath, "utf8"));
  } catch {
    return false;
  }
  if (record?.token !== entries[0]) {
    return false;
  }

  if (!isHolderIdentity(record.holder)) {
    // Legacy records predate holder identity, so liveness is unknowable from the record alone.
    // Only a caller that has already proven the resource is unowned may reclaim them.
    if (!recovery.reclaimIdentityFreeLock || record.holder !== undefined) {
      return false;
    }
  } else {
    let actual;
    try {
      actual = await recovery.inspect(record.holder.pid);
    } catch (error) {
      if (!hasCode(error, ABSENT_PROCESS_CODES)) {
        return false;
      }
    }
    const alive =
      actual?.pid === record.holder.pid &&
      actual?.startIdentity === record.holder.startIdentity &&
      actual?.processGroupId === record.holder.processGroupId;
    if (alive) {
      return false;
    }
  }

  let current;
  try {
    current = JSON.parse(await fsOps.readFile(entryPath, "utf8"));
  } catch {
    return false;
  }
  if (JSON.stringify(current) !== JSON.stringify(record)) {
    return false;
  }

  try {
    await fsOps.unlink(entryPath);
    await fsOps.rmdir(path);
  } catch {
    return false;
  }
  return true;
}

/**
 * Acquire an exclusive lifecycle lock as a complete token-entry directory.
 *
 * The directory and entry are prepared at a private staging path. Renaming that
 * non-empty directory publishes ownership in one operation. A stale holder can
 * address only its unguessable entry and cannot rename another holder's directory.
 *
 * @param {string} path
 * @param {unknown} owner
 * @param {any} [fsOps]
 * @param {{ inspect?: (pid: number) => Promise<any>, reclaimIdentityFreeLock?: boolean, holder?: unknown }} [recovery]
 */
export async function acquireLifecycleLock(path, owner, fsOps = fs, recovery = {}) {
  const token = randomUUID();
  if (owner === undefined) {
    throw new TypeError("Lifecycle lock owner must be JSON serializable");
  }
  const inspect = recovery.inspect ?? inspectProcessIdentity;
  const reclaimIdentityFreeLock = recovery.reclaimIdentityFreeLock === true;
  let holder = recovery.holder;
  if (holder === undefined) {
    try {
      holder = await inspectProcessIdentity(process.pid);
    } catch {
      holder = null;
    }
  }
  let serialized;
  try {
    serialized = `${JSON.stringify({ token, owner, holder })}\n`;
  } catch (cause) {
    throw new TypeError("Lifecycle lock owner must be JSON serializable", { cause });
  }

  const stagingPath = `${path}.${token}.tmp`;
  const stagingEntryPath = join(stagingPath, token);
  /** @type {any} */
  let handle;
  let published = false;
  let failed = false;
  try {
    await fsOps.mkdir(stagingPath, { mode: PRIVATE_DIRECTORY_MODE });
    await fsOps.chmod(stagingPath, PRIVATE_DIRECTORY_MODE);
    const directoryMetadata = await fsOps.lstat(stagingPath);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      (directoryMetadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new Error("Lifecycle lock staging directory must be a mode-0700 directory");
    }

    handle = await fsOps.open(stagingEntryPath, "wx", PRIVATE_FILE_MODE);
    await handle.chmod(PRIVATE_FILE_MODE);
    const entryMetadata = await handle.stat();
    if (!entryMetadata.isFile() || (entryMetadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error("Lifecycle lock token entry must be a regular mode-0600 file");
    }
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      const publicMetadata = await fsOps.lstat(path);
      if (!publicMetadata.isDirectory() || publicMetadata.isSymbolicLink()) {
        throw new LifecycleLockError("Lifecycle lock is already held");
      }
    } catch (error) {
      if (!hasCode(error, ["ENOENT"])) {
        throw error;
      }
    }

    try {
      await fsOps.rename(stagingPath, path);
      published = true;
    } catch (cause) {
      if (hasCode(cause, ["EEXIST", "ENOTEMPTY", "ELOOP", "ENOTDIR", "EISDIR"])) {
        if (await reclaimDeadHolderLock(path, fsOps, { inspect, reclaimIdentityFreeLock })) {
          try {
            await fsOps.rename(stagingPath, path);
            published = true;
          } catch (retryCause) {
            if (hasCode(retryCause, ["EEXIST", "ENOTEMPTY", "ELOOP", "ENOTDIR", "EISDIR"])) {
              throw new LifecycleLockError("Lifecycle lock is already held", { cause: retryCause });
            }
            throw retryCause;
          }
        } else {
          throw new LifecycleLockError("Lifecycle lock is already held", { cause });
        }
      } else {
        throw cause;
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    try {
      await fsOps.rm(stagingPath, { recursive: true, force: true });
    } catch (cleanupError) {
      if (!published && !failed) {
        throw cleanupError;
      }
    }
  }

  let released = false;
  const entryPath = join(path, token);
  return {
    token,
    owner,
    async release() {
      if (released) {
        return false;
      }

      try {
        await fsOps.unlink(entryPath);
      } catch (error) {
        if (hasCode(error, ["ENOENT", "ENOTDIR"])) {
          released = true;
          return false;
        }
        throw error;
      }

      released = true;
      await fsOps.rmdir(path).catch(() => {});
      return true;
    },
  };
}
