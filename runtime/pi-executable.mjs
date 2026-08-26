import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** A stable executable discovery or identity failure. */
export class PiExecutableError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "PiExecutableError";
    this.code = code;
  }
}

/** @param {any} metadata @param {string} realpath @returns {import("../shared/contracts.mjs").ExecutableIdentity} */
function identityFromStat(metadata, realpath) {
  const modifiedTimeNs = metadata.mtimeNs === undefined
    ? BigInt(Math.trunc(Number(metadata.mtimeMs) * 1_000_000)).toString()
    : metadata.mtimeNs.toString();
  return {
    realpath,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size: Number(metadata.size),
    modifiedTimeNs,
  };
}

/** @param {string} candidate @param {any} fsOps */
async function inspectCandidate(candidate, fsOps) {
  try {
    const canonical = await fsOps.realpath(candidate);
    const metadata = await fsOps.stat(canonical, { bigint: true });
    if (!metadata.isFile()) throw new TypeError("path is not a regular file");
    await fsOps.access(canonical, fsConstants.X_OK);
    const identity = identityFromStat(metadata, canonical);
    if (!Number.isSafeInteger(identity.size) || identity.size < 0) throw new TypeError("file size is not representable");
    return identity;
  } catch (cause) {
    throw new PiExecutableError("INVALID_PI_EXECUTABLE", `Pi executable is not a canonical executable file: ${candidate}`, { cause });
  }
}

/**
 * Resolve the installed Pi executable with CLI, configuration, then PATH precedence.
 * @param {{ cliPath?: string | null, configuredPath?: string | null, pathEnv?: string, fsOps?: any }} options
 */
export async function resolvePiExecutable({ cliPath, configuredPath, pathEnv = process.env.PATH ?? "", fsOps = fs }) {
  const explicit = cliPath ?? configuredPath;
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== "string" || explicit.length === 0) throw new PiExecutableError("INVALID_PI_EXECUTABLE", "Pi executable path must be non-empty");
    return inspectCandidate(isAbsolute(explicit) ? resolve(explicit) : resolve(explicit), fsOps);
  }
  for (const directory of pathEnv.split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, "pi");
    try {
      return await inspectCandidate(candidate, fsOps);
    } catch (error) {
      const cause = /** @type {{ cause?: NodeJS.ErrnoException }} */ (error).cause;
      if (!["ENOENT", "ENOTDIR"].includes(cause?.code ?? "")) throw error;
    }
  }
  throw new PiExecutableError("PI_EXECUTABLE_NOT_FOUND", "Could not find an executable Pi binary on PATH");
}

/** Open an inode-bound executable handle for `/proc/self/fd` execution.
 * @param {import("../shared/contracts.mjs").ExecutableIdentity} expected
 * @param {{ fsOps?: any }} [options]
 */
export async function openPiExecutableBinding(expected, { fsOps = fs } = {}) {
  let handle;
  try {
    handle = await fsOps.open(expected.realpath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat({ bigint: true });
    const current = identityFromStat(metadata, expected.realpath);
    if (!metadata.isFile() || current.device !== expected.device || current.inode !== expected.inode || current.size !== expected.size || current.modifiedTimeNs !== expected.modifiedTimeNs) {
      throw new PiExecutableError("PI_EXECUTABLE_REPLACED", "Pi executable changed before execution binding");
    }
    return { handle, childFd: 3, executionPath: "/proc/self/fd/3" };
  } catch (cause) {
    await handle?.close().catch(() => {});
    if (cause instanceof PiExecutableError) throw cause;
    throw new PiExecutableError("PI_EXECUTABLE_REPLACED", "Pi executable could not be bound to its validated identity", { cause });
  }
}

/** Revalidate the exact file identity immediately before spawn. @param {import("../shared/contracts.mjs").ExecutableIdentity} expected @param {{ fsOps?: any }} [options] */
export async function assertPiExecutableIdentity(expected, { fsOps = fs } = {}) {
  let current;
  try {
    current = await inspectCandidate(expected.realpath, fsOps);
  } catch (cause) {
    throw new PiExecutableError("PI_EXECUTABLE_REPLACED", "Pi executable is no longer the validated file", { cause });
  }
  if (current.realpath !== expected.realpath || current.device !== expected.device || current.inode !== expected.inode || current.size !== expected.size || current.modifiedTimeNs !== expected.modifiedTimeNs) {
    throw new PiExecutableError("PI_EXECUTABLE_REPLACED", "Pi executable changed after capability validation");
  }
  return current;
}

/** @param {import("../shared/contracts.mjs").ExecutableIdentity} identity */
export function piExecutableCacheKey(identity) {
  return [identity.realpath, identity.device, identity.inode, String(identity.size), identity.modifiedTimeNs].join("\0");
}
