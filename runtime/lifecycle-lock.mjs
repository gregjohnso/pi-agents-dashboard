import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

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
 * Restore a claimed replacement without overwriting a newer lock at the public path.
 *
 * @param {string} claimedPath
 * @param {string} path
 * @param {any} fsOps
 */
async function restoreReplacement(claimedPath, path, fsOps) {
  try {
    await fsOps.link(claimedPath, path);
  } catch (error) {
    if (hasCode(error, ["EEXIST"])) {
      return;
    }
    throw error;
  }
  await fsOps.rm(claimedPath, { force: true });
}

/**
 * Acquire an exclusive, durable lifecycle lock containing an unguessable release token.
 *
 * The record is completed at a token-specific staging path before one hard-link operation
 * publishes it. Failed acquisition therefore cleans only the holder's staging name.
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
  /** @type {any} */
  let handle;
  let published = false;
  try {
    handle = await fsOps.open(stagingPath, "wx", PRIVATE_FILE_MODE);
    await handle.chmod(PRIVATE_FILE_MODE);
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error("Lifecycle lock staging file must be a regular mode-0600 file");
    }
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await fsOps.link(stagingPath, path);
      published = true;
    } catch (cause) {
      if (hasCode(cause, ["EEXIST", "ELOOP"])) {
        throw new LifecycleLockError("Lifecycle lock is already held", { cause });
      }
      throw cause;
    }
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await fsOps.rm(stagingPath, { force: true });
  }

  if (!published) {
    throw new Error("Lifecycle lock publication did not complete");
  }

  let released = false;
  return {
    token,
    owner,
    async release() {
      if (released) {
        return false;
      }

      const claimedPath = `${path}.${token}.${randomUUID()}.release`;
      try {
        await fsOps.rename(path, claimedPath);
      } catch (error) {
        if (hasCode(error, ["ENOENT"])) {
          released = true;
          return false;
        }
        throw error;
      }

      let record;
      try {
        record = JSON.parse(await fsOps.readFile(claimedPath, "utf8"));
      } catch (error) {
        await restoreReplacement(claimedPath, path, fsOps);
        return false;
      }
      if (record === null || typeof record !== "object" || record.token !== token) {
        await restoreReplacement(claimedPath, path, fsOps);
        return false;
      }

      await fsOps.rm(claimedPath, { force: true });
      released = true;
      return true;
    },
  };
}
