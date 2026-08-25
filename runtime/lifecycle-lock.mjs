import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

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
 */
export async function acquireLifecycleLock(path, owner, fsOps = fs) {
  const token = randomUUID();
  if (owner === undefined) {
    throw new TypeError("Lifecycle lock owner must be JSON serializable");
  }
  let serialized;
  try {
    serialized = `${JSON.stringify({ token, owner })}\n`;
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
        throw new LifecycleLockError("Lifecycle lock is already held", { cause });
      }
      throw cause;
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
