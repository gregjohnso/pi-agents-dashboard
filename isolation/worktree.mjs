import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { atomicWriteJson } from "../runtime/atomic-file.mjs";
import { IsolationError } from "./launch-preflight.mjs";

const execFileAsync = promisify(execFile);
export const WORKTREE_OWNERSHIP_FILE = "pi-agents-dashboard-owner.json";
const WORKTREE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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
 * Create one dashboard-owned Git worktree using structured argv only.
 *
 * @param {any} preflight
 * @param {{ worktreeId: string }} options
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
  const expectedWorktreesRoot = join(
    canonicalPiConfigRoot,
    "agents-dashboard",
    "worktrees",
  );
  if (preflight.worktreesRoot !== expectedWorktreesRoot) {
    throw new IsolationError(
      "INVALID_WORKTREES_ROOT",
      "Worktrees root must be derived from the server Pi configuration root",
    );
  }
  await mkdir(expectedWorktreesRoot, { recursive: true, mode: 0o700 });
  const [repositoryRoot, worktreesRoot] = await Promise.all([
    realpath(preflight.repositoryRoot),
    realpath(expectedWorktreesRoot),
  ]);
  const rootMetadata = await stat(worktreesRoot);
  if (!rootMetadata.isDirectory() || worktreesRoot !== expectedWorktreesRoot) {
    throw new IsolationError("INVALID_WORKTREES_ROOT", "Worktrees root must be a canonical directory");
  }

  const worktreePath = join(worktreesRoot, options.worktreeId);
  if (!isAbsolute(worktreePath) || resolve(worktreePath) !== worktreePath) {
    throw new IsolationError("INVALID_WORKTREE_PATH", "Derived worktree path is not canonical");
  }
  const branch = `pi-agents/${options.worktreeId}`;
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
    await atomicWriteJson(join(gitDirectory, WORKTREE_OWNERSHIP_FILE), ownership);
  } catch (cause) {
    try {
      await git(repositoryRoot, ["worktree", "remove", worktreePath]);
      await git(repositoryRoot, ["branch", "-D", branch]);
    } catch {
      // Git retains the worktree for manual inspection when rollback is unsafe or incomplete.
    }
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
    workerCwd: join(worktreePath, preflight.sourceSubdirectory),
    repositoryRoot,
    baseCommit: preflight.baseCommit,
    ownershipId,
    sourceSessionId: preflight.sourceSessionId,
    piConfigRoot: preflight.piConfigRoot,
  };
}
