import { chmod, lstat, mkdir, rmdir } from "node:fs/promises";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** @returns {number} */
function currentUid() {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Private runtime artifacts require a POSIX user ID");
  }
  return uid;
}

/** @param {{ uid: number, mode: number, isDirectory(): boolean, isSymbolicLink(): boolean }} metadata @param {number} uid */
function validateDirectory(metadata, uid) {
  if (metadata.isSymbolicLink()) {
    throw new Error("Private directory must not be a symbolic link");
  }
  if (!metadata.isDirectory()) {
    throw new Error("Private directory path is not a directory");
  }
  if (metadata.uid !== uid) {
    throw new Error("Private directory has the wrong owner");
  }
  if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error("Private directory must have mode 0700");
  }
}

/** Set the file-creation mask used by detached runtime entrypoints. */
export function setPrivateUmask(setUmask = process.umask) {
  return setUmask(0o077);
}

/** Initialize process-wide permissions before a runtime entrypoint creates artifacts. */
export function initializeRuntimePermissions(setUmask = process.umask) {
  return { previousUmask: setPrivateUmask(setUmask) };
}

/**
 * Create or validate an exact user-owned mode-0700 directory.
 *
 * @param {string} path
 * @param {{ lstat(path: string): Promise<any>, mkdir(path: string, options: { mode: number }): Promise<unknown>, chmod?(path: string, mode: number): Promise<void>, rmdir?(path: string): Promise<void> }} [fsOps]
 * @param {number} [uid]
 */
export async function ensurePrivateDirectory(
  path,
  fsOps = { lstat, mkdir, chmod, rmdir },
  uid = currentUid(),
) {
  try {
    validateDirectory(await fsOps.lstat(path), uid);
    return;
  } catch (error) {
    if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      throw error;
    }
  }

  let created = false;
  try {
    try {
      await fsOps.mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    } catch (error) {
      if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") {
        throw error;
      }
    }
    if (created) {
      if (typeof fsOps.chmod !== "function") {
        throw new TypeError("Private directory creation requires chmod support");
      }
      await fsOps.chmod(path, PRIVATE_DIRECTORY_MODE);
    }
    validateDirectory(await fsOps.lstat(path), uid);
  } catch (error) {
    if (created && typeof fsOps.rmdir === "function") {
      await fsOps.rmdir(path).catch(() => {});
    }
    throw error;
  }
}

/**
 * Restrict a newly bound, user-owned control socket and revalidate its identity.
 *
 * @param {string} path
 * @param {{ lstat(path: string): Promise<any>, chmod(path: string, mode: number): Promise<void> }} [fsOps]
 * @param {number} [uid]
 */
export async function chmodPrivateSocket(path, fsOps = { lstat, chmod }, uid = currentUid()) {
  const validateSocket = async () => {
    const metadata = await fsOps.lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error("Control socket must not be a symbolic link");
    }
    if (!metadata.isSocket()) {
      throw new Error("Control socket path is not a socket");
    }
    if (metadata.uid !== uid) {
      throw new Error("Control socket has the wrong owner");
    }
    return metadata;
  };

  await validateSocket();
  await fsOps.chmod(path, PRIVATE_FILE_MODE);
  const metadata = await validateSocket();
  if ((metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new Error("Control socket must have mode 0600");
  }
}
