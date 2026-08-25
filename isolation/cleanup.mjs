import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { IsolationError } from "./launch-preflight.mjs";
import {
  acquireWorktreeOwnershipLock,
  WORKTREE_OWNERSHIP_FILE,
} from "./worktree.mjs";

const execFileAsync = promisify(execFile);

/** @param {string} cwd @param {string[]} args */
async function git(cwd, args) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    shell: false,
  });
}

/** @param {any} record */
function validateRecord(record) {
  if (
    record === null ||
    typeof record !== "object" ||
    record.mode !== "worktree" ||
    typeof record.worktreePath !== "string" ||
    !isAbsolute(record.worktreePath) ||
    resolve(record.worktreePath) !== record.worktreePath ||
    typeof record.branch !== "string"
  ) {
    throw new IsolationError("INVALID_WORKTREE_RECORD", "A worktree isolation record is required");
  }
}

/** @param {any} marker @param {{ worktreePath: string, branch: string }} record */
function markerMatches(marker, record) {
  return (
    marker !== null &&
    typeof marker === "object" &&
    marker.schemaVersion === 1 &&
    typeof marker.ownershipId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      marker.ownershipId,
    ) &&
    typeof marker.repositoryRoot === "string" &&
    marker.worktreePath === record.worktreePath &&
    marker.branch === record.branch &&
    typeof marker.baseCommit === "string" &&
    /^[0-9a-f]{40,64}$/u.test(marker.baseCommit) &&
    typeof marker.sourceSessionId === "string" &&
    marker.sourceSessionId !== ""
  );
}

/** @param {any} marker */
function markerIdentity(marker) {
  return JSON.stringify({
    schemaVersion: marker.schemaVersion,
    ownershipId: marker.ownershipId,
    repositoryRoot: marker.repositoryRoot,
    worktreePath: marker.worktreePath,
    branch: marker.branch,
    baseCommit: marker.baseCommit,
    sourceSessionId: marker.sourceSessionId,
  });
}

/**
 * @param {{ worktreePath: string, branch: string }} record
 * @param {boolean} destructiveBoundary
 */
async function inspectIdentity(record, destructiveBoundary = false) {
  let worktreePath;
  try {
    worktreePath = await realpath(record.worktreePath);
  } catch (cause) {
    if (destructiveBoundary) {
      throw new IsolationError(
        "IDENTITY_MISMATCH",
        "Worktree identity changed before removal",
        { cause },
      );
    }
    throw new IsolationError("WORKTREE_MISSING", "The recorded worktree is missing", { cause });
  }
  if (worktreePath !== record.worktreePath) {
    throw new IsolationError("IDENTITY_MISMATCH", "Canonical worktree identity does not match");
  }

  let gitDirectory;
  let marker;
  try {
    const { stdout } = await git(worktreePath, ["rev-parse", "--git-dir"]);
    const gitDirectoryText = stdout.trim();
    gitDirectory = await realpath(
      isAbsolute(gitDirectoryText) ? gitDirectoryText : join(worktreePath, gitDirectoryText),
    );
    marker = JSON.parse(await readFile(join(gitDirectory, WORKTREE_OWNERSHIP_FILE), "utf8"));
  } catch (cause) {
    if (destructiveBoundary) {
      throw new IsolationError(
        "IDENTITY_MISMATCH",
        "Dashboard ownership marker changed before removal",
        { cause },
      );
    }
    const code = /** @type {NodeJS.ErrnoException} */ (cause).code;
    if (code === "ENOENT") {
      throw new IsolationError(
        "NOT_DASHBOARD_OWNED",
        "The linked worktree has no dashboard ownership marker",
        { cause },
      );
    }
    throw new IsolationError(
      "NOT_DASHBOARD_OWNED",
      "The linked worktree ownership marker cannot be verified",
      { cause },
    );
  }
  if (!markerMatches(marker, { worktreePath, branch: record.branch })) {
    throw new IsolationError("IDENTITY_MISMATCH", "Dashboard worktree ownership does not match");
  }

  let repositoryRoot;
  let worktreeCommon;
  try {
    repositoryRoot = await realpath(marker.repositoryRoot);
    const [{ stdout: worktreeCommonOutput }, { stdout: repositoryCommonOutput }] =
      await Promise.all([
        git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        git(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      ]);
    const repositoryCommon = await realpath(repositoryCommonOutput.trim());
    worktreeCommon = await realpath(worktreeCommonOutput.trim());
    if (repositoryRoot !== marker.repositoryRoot || worktreeCommon !== repositoryCommon) {
      throw new Error("Git common directories differ");
    }
  } catch (cause) {
    throw new IsolationError("IDENTITY_MISMATCH", "Dashboard repository identity does not match", {
      cause,
    });
  }

  let branch;
  let head;
  try {
    const [{ stdout: branchOutput }, { stdout: headOutput }] = await Promise.all([
      git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      git(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
    ]);
    branch = branchOutput.trim();
    head = headOutput.trim();
  } catch (cause) {
    throw new IsolationError("IDENTITY_MISMATCH", "Worktree branch identity cannot be verified", {
      cause,
    });
  }
  if (branch !== record.branch) {
    throw new IsolationError("IDENTITY_MISMATCH", "Worktree branch identity does not match");
  }

  return {
    worktreePath,
    gitDirectory,
    marker,
    repositoryRoot,
    worktreeCommon,
    branch,
    head,
  };
}

/** @param {Awaited<ReturnType<typeof inspectIdentity>>} expected @param {Awaited<ReturnType<typeof inspectIdentity>>} current */
function sameIdentity(expected, current) {
  return (
    expected.worktreePath === current.worktreePath &&
    expected.gitDirectory === current.gitDirectory &&
    expected.repositoryRoot === current.repositoryRoot &&
    expected.worktreeCommon === current.worktreeCommon &&
    expected.branch === current.branch &&
    expected.head === current.head &&
    markerIdentity(expected.marker) === markerIdentity(current.marker)
  );
}

/** @param {string} worktreePath */
async function assertClean(worktreePath) {
  const { stdout: statusOutput } = await git(worktreePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  const statusLines = statusOutput.split("\n").filter(Boolean);
  if (statusLines.some((line) => line.startsWith("??") || line.startsWith("!!"))) {
    throw new IsolationError("UNTRACKED_FILES", "Worktree contains untracked files");
  }
  if (statusLines.length > 0) {
    throw new IsolationError("DIRTY_WORKTREE", "Worktree contains uncommitted changes");
  }
}

/**
 * Remove only an inactive, clean, pushed worktree with exact dashboard ownership.
 *
 * The reader must query the authoritative current ownership source. Cleanup invokes it only
 * while holding the worktree ownership lock, including immediately before removal.
 *
 * @param {any} record
 * @param {{ readLiveOwnership: () => unknown | Promise<unknown> }} options
 */
export async function cleanupManagedWorktree(record, options) {
  validateRecord(record);
  if (typeof options?.readLiveOwnership !== "function") {
    throw new TypeError("readLiveOwnership must be a function");
  }
  const { readLiveOwnership } = options;
  const assertNoLiveOwnership = async () => {
    const liveOwnership = await readLiveOwnership();
    if (liveOwnership !== undefined && liveOwnership !== null) {
      throw new IsolationError("LIVE_OWNERSHIP", "A live session still owns this worktree");
    }
  };

  const lock = await acquireWorktreeOwnershipLock(record.worktreePath);
  try {
    await assertNoLiveOwnership();
    const identity = await inspectIdentity(record);
    await assertClean(identity.worktreePath);

    if (identity.head !== identity.marker.baseCommit) {
      let upstream;
      try {
        const { stdout } = await git(identity.worktreePath, [
          "rev-parse",
          "--verify",
          "@{upstream}^{commit}",
        ]);
        upstream = stdout.trim();
      } catch (cause) {
        throw new IsolationError(
          "MISSING_UPSTREAM",
          "Changed worktree HEAD has no configured upstream",
          { cause },
        );
      }

      const { stdout: countsOutput } = await git(identity.worktreePath, [
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...${upstream}`,
      ]);
      const [aheadText, behindText] = countsOutput.trim().split(/\s+/u);
      const ahead = Number(aheadText);
      const behind = Number(behindText);
      if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
        throw new IsolationError("GIT_HISTORY_AMBIGUOUS", "Git history comparison was ambiguous");
      }
      if (ahead > 0 && behind > 0) {
        throw new IsolationError("DIVERGENT_HISTORY", "Local and upstream histories have diverged");
      }
      if (ahead > 0) {
        throw new IsolationError("UNPUSHED_COMMITS", "Worktree contains unpushed commits");
      }
      if (behind > 0) {
        throw new IsolationError("DIVERGENT_HISTORY", "Worktree HEAD is behind its upstream");
      }
    }

    await assertClean(identity.worktreePath);
    await assertNoLiveOwnership();
    const currentIdentity = await inspectIdentity(record, true);
    if (!sameIdentity(identity, currentIdentity)) {
      throw new IsolationError(
        "IDENTITY_MISMATCH",
        "Worktree identity changed before removal",
      );
    }

    try {
      await git(identity.repositoryRoot, ["worktree", "remove", identity.worktreePath]);
    } catch (cause) {
      throw new IsolationError("WORKTREE_REMOVE_FAILED", "Git refused to remove the worktree", {
        cause,
      });
    }
    return { disposition: "REMOVED" };
  } finally {
    await lock.release();
  }
}

export const cleanupOwnedWorktree = cleanupManagedWorktree;
