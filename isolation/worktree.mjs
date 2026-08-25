import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson } from "../runtime/atomic-file.mjs";
import { acquireLifecycleLock } from "../runtime/lifecycle-lock.mjs";
import { ensurePrivateDirectory } from "../runtime/permissions.mjs";
import { IsolationError } from "./launch-preflight.mjs";

const execFileAsync = promisify(execFile);
export const WORKTREE_OWNERSHIP_FILE = "pi-agents-dashboard-owner.json";
const WORKTREE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WORKTREE_LOCK_SUFFIX = ".pi-agents-dashboard-ownership.lock";

/** @param {string} cwd @param {string[]} args */
async function git(cwd, args) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    shell: false,
  });
}

/** @param {any} preflight */
function validatePreflight(preflight) {
  if (
    preflight === null ||
    typeof preflight !== "object" ||
    preflight.mode !== "worktree" ||
    typeof preflight.repositoryRoot !== "string" ||
    typeof preflight.baseCommit !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(preflight.baseCommit) ||
    typeof preflight.sourceSubdirectory !== "string" ||
    typeof preflight.worktreesRoot !== "string" ||
    typeof preflight.sourceSessionId !== "string" ||
    typeof preflight.piConfigRoot !== "string"
  ) {
    throw new IsolationError("INVALID_WORKTREE_PREFLIGHT", "A worktree launch preflight is required");
  }
}

/**
 * Serialize dashboard ownership and cleanup operations for one worktree path.
 *
 * Every dashboard operation that changes live ownership must hold this lock.
 *
 * @param {string} worktreePath
 */
export async function acquireWorktreeOwnershipLock(worktreePath) {
  const lockPath = `${worktreePath}${WORKTREE_LOCK_SUFFIX}`;
  try {
    return await acquireLifecycleLock(lockPath, {
      operation: "worktree_ownership",
      worktreePath,
    });
  } catch (cause) {
    if (/** @type {{ code?: unknown }} */ (cause).code === "LOCK_HELD") {
      throw new IsolationError(
        "WORKTREE_OWNERSHIP_LOCKED",
        "Another dashboard operation holds the worktree ownership lock",
        { cause },
      );
    }
    throw new IsolationError(
      "WORKTREE_OWNERSHIP_LOCK_FAILED",
      "The worktree ownership lock could not be acquired",
      { cause },
    );
  }
}

/**
 * Remove a newly created worktree only while its repository, branch, and HEAD retain creation identity.
 *
 * @param {{ repositoryRoot: string, worktreePath: string, branch: string, baseCommit: string }} identity
 */
async function rollbackCreatedWorktree(identity) {
  try {
    const canonicalWorktree = await realpath(identity.worktreePath);
    if (canonicalWorktree !== identity.worktreePath) {
      return false;
    }
    const [branchResult, headResult, worktreeCommonResult, repositoryCommonResult] =
      await Promise.all([
        git(identity.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
        git(identity.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
        git(identity.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        git(identity.repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      ]);
    const [worktreeCommon, repositoryCommon] = await Promise.all([
      realpath(worktreeCommonResult.stdout.trim()),
      realpath(repositoryCommonResult.stdout.trim()),
    ]);
    if (
      branchResult.stdout.trim() !== identity.branch ||
      headResult.stdout.trim() !== identity.baseCommit ||
      worktreeCommon !== repositoryCommon
    ) {
      return false;
    }

    await git(identity.repositoryRoot, ["worktree", "remove", identity.worktreePath]);
    await git(identity.repositoryRoot, [
      "update-ref",
      "-d",
      `refs/heads/${identity.branch}`,
      identity.baseCommit,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create one dashboard-owned Git worktree using structured argv only.
 *
 * @param {any} preflight
 * @param {{ worktreeId: string, writeOwnership?: (path: string, ownership: unknown, worktreePath: string) => Promise<void> }} options
 */
export async function createWorktree(preflight, options) {
  validatePreflight(preflight);
  if (!WORKTREE_ID_PATTERN.test(options?.worktreeId ?? "")) {
    throw new IsolationError(
      "INVALID_WORKTREE_ID",
      "Worktree ID must use only letters, numbers, dot, underscore, and hyphen",
    );
  }

  const canonicalPiConfigRoot = await realpath(preflight.piConfigRoot);
  const dashboardRoot = join(canonicalPiConfigRoot, "agents-dashboard");
  const expectedWorktreesRoot = join(dashboardRoot, "worktrees");
  if (preflight.worktreesRoot !== expectedWorktreesRoot) {
    throw new IsolationError(
      "INVALID_WORKTREES_ROOT",
      "Worktrees root must be derived from the server Pi configuration root",
    );
  }
  try {
    await ensurePrivateDirectory(dashboardRoot);
    await ensurePrivateDirectory(expectedWorktreesRoot);
  } catch (cause) {
    throw new IsolationError(
      "INVALID_WORKTREES_ROOT",
      "Dashboard worktree roots must be private user-owned directories",
      { cause },
    );
  }

  const [repositoryRoot, worktreesRoot] = await Promise.all([
    realpath(preflight.repositoryRoot),
    realpath(expectedWorktreesRoot),
  ]);
  if (worktreesRoot !== expectedWorktreesRoot) {
    throw new IsolationError("INVALID_WORKTREES_ROOT", "Worktrees root must be a canonical directory");
  }

  const worktreePath = join(worktreesRoot, options.worktreeId);
  if (!isAbsolute(worktreePath) || resolve(worktreePath) !== worktreePath) {
    throw new IsolationError("INVALID_WORKTREE_PATH", "Derived worktree path is not canonical");
  }
  const branch = `pi-agents/${options.worktreeId}`;
  const lock = await acquireWorktreeOwnershipLock(worktreePath);
  try {
    try {
      await git(repositoryRoot, [
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
        preflight.baseCommit,
      ]);
    } catch (cause) {
      throw new IsolationError(
        "WORKTREE_CREATE_FAILED",
        "Git refused to create the isolated worktree",
        { cause },
      );
    }

    const creationIdentity = {
      repositoryRoot,
      worktreePath,
      branch,
      baseCommit: preflight.baseCommit,
    };
    const workerCwd = join(worktreePath, preflight.sourceSubdirectory);
    try {
      const canonicalWorkerCwd = await realpath(workerCwd);
      const workerCwdMetadata = await stat(canonicalWorkerCwd);
      if (canonicalWorkerCwd !== workerCwd || !workerCwdMetadata.isDirectory()) {
        throw new Error("Worker cwd is not a canonical directory");
      }
    } catch (cause) {
      await rollbackCreatedWorktree(creationIdentity);
      throw new IsolationError(
        "SOURCE_SUBDIRECTORY_MISSING",
        "The source subdirectory is absent from the checked-out base commit",
        { cause },
      );
    }

    const ownershipId = randomUUID();
    const ownership = {
      schemaVersion: 1,
      ownershipId,
      repositoryRoot,
      worktreePath,
      branch,
      baseCommit: preflight.baseCommit,
      sourceSessionId: preflight.sourceSessionId,
    };

    try {
      const { stdout: gitDirectoryOutput } = await git(worktreePath, ["rev-parse", "--git-dir"]);
      const gitDirectory = await realpath(
        isAbsolute(gitDirectoryOutput.trim())
          ? gitDirectoryOutput.trim()
          : join(worktreePath, gitDirectoryOutput.trim()),
      );
      const ownershipPath = join(gitDirectory, WORKTREE_OWNERSHIP_FILE);
      if (options.writeOwnership === undefined) {
        await atomicWriteJson(ownershipPath, ownership);
      } else {
        await options.writeOwnership(ownershipPath, ownership, worktreePath);
      }
    } catch (cause) {
      await rollbackCreatedWorktree(creationIdentity);
      throw new IsolationError(
        "WORKTREE_OWNERSHIP_FAILED",
        "Could not record dashboard ownership for the worktree",
        { cause },
      );
    }

    return {
      mode: "worktree",
      worktreePath,
      branch,
      workerCwd,
      repositoryRoot,
      baseCommit: preflight.baseCommit,
      ownershipId,
      sourceSessionId: preflight.sourceSessionId,
      piConfigRoot: preflight.piConfigRoot,
    };
  } finally {
    await lock.release();
  }
}
