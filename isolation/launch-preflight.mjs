import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** An explicit launch-isolation refusal. */
export class IsolationError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "IsolationError";
    this.code = code;
  }
}

/** @param {string} cwd @param {string[]} args */
async function git(cwd, args) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    shell: false,
  });
}

/** @param {unknown} values */
export function normalizeOwnerSessionIds(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value === "")) {
    throw new TypeError("Current owner session IDs must be non-empty strings");
  }
  return [...new Set(values)].sort();
}

/** @param {unknown} value @param {string} name */
async function canonicalDirectory(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new IsolationError("INVALID_DIRECTORY", `${name} must be an absolute directory path`);
  }
  let canonical;
  try {
    canonical = await realpath(value);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (cause) {
    throw new IsolationError("INVALID_DIRECTORY", `${name} must identify an existing directory`, {
      cause,
    });
  }
  return canonical;
}

/**
 * Report whether a directory can host a managed worktree and what commit one would branch from.
 * @param {string} cwd
 * @returns {Promise<{available:true,repositoryRoot:string,baseCommit:string}|{available:false,code:string,error:IsolationError}>}
 */
export async function probeWorktreeCapability(cwd) {
  let repositoryRoot;
  try {
    const { stdout } = await git(cwd, ["rev-parse", "--show-toplevel"]);
    repositoryRoot = await canonicalDirectory(stdout.trim(), "Git repository root");
  } catch (cause) {
    if (cause instanceof IsolationError && cause.code === "INVALID_DIRECTORY") {
      throw cause;
    }
    return {
      available: false,
      code: "NOT_GIT_REPOSITORY",
      error: new IsolationError(
        "NOT_GIT_REPOSITORY",
        "Worktree isolation requires a Git repository",
        { cause },
      ),
    };
  }

  try {
    const { stdout } = await git(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
    return { available: true, repositoryRoot, baseCommit: stdout.trim() };
  } catch (cause) {
    return {
      available: false,
      code: "UNBORN_HEAD",
      error: new IsolationError("UNBORN_HEAD", "Worktree isolation requires an existing commit", {
        cause,
      }),
    };
  }
}

/**
 * Canonicalize an approved launch request and derive trusted isolation metadata.
 *
 * @param {import("../shared/contracts.mjs").LaunchRequest & { piConfigRoot?: unknown }} request
 * @param {{ piConfigRoot?: string, currentOwnerSessionIds?: string[] }} options
 */
export async function launchPreflight(request, options = {}) {
  if (request === null || typeof request !== "object") {
    throw new TypeError("Launch request must be an object");
  }
  if (Object.hasOwn(request, "piConfigRoot")) {
    throw new IsolationError(
      "UNTRUSTED_PI_CONFIG_ROOT",
      "Pi configuration root must be derived by the server",
    );
  }
  if (typeof request.sourceSessionId !== "string" || request.sourceSessionId === "") {
    throw new TypeError("Launch request sourceSessionId is required");
  }
  if (options.piConfigRoot === undefined) {
    throw new IsolationError(
      "PI_CONFIG_ROOT_REQUIRED",
      "A server-derived Pi configuration root is required",
    );
  }

  const [canonicalCwd, piConfigRoot] = await Promise.all([
    canonicalDirectory(request.cwd, "Launch cwd"),
    canonicalDirectory(options.piConfigRoot, "Pi configuration root"),
  ]);

  if (request.isolation?.mode === "shared_directory") {
    return {
      mode: "shared_directory_confirmation",
      canonicalCwd,
      confirmedCanonicalCwd: request.isolation.confirmedCwd,
      ownerSessionIds: normalizeOwnerSessionIds(request.isolation.ownerSessionIds),
      sourceSessionId: request.sourceSessionId,
      piConfigRoot,
    };
  }
  if (request.isolation?.mode !== "worktree") {
    throw new IsolationError("INVALID_ISOLATION_MODE", "Launch isolation mode is invalid");
  }

  const capability = await probeWorktreeCapability(canonicalCwd);
  // TypeScript 5.9 narrows this union through `in`, but not through `!capability.available`.
  if ("error" in capability) {
    throw capability.error;
  }
  const { repositoryRoot, baseCommit } = capability;

  let sourceBranch = null;
  try {
    const { stdout } = await git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    sourceBranch = stdout.trim();
  } catch {
    sourceBranch = null;
  }
  const { stdout: statusOutput } = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const sourceSubdirectory = relative(repositoryRoot, canonicalCwd);
  if (sourceSubdirectory.startsWith("..") || isAbsolute(sourceSubdirectory)) {
    throw new IsolationError("CWD_OUTSIDE_REPOSITORY", "Launch cwd is outside its Git root");
  }

  return {
    mode: "worktree",
    canonicalCwd,
    repositoryRoot,
    sourceSubdirectory,
    baseCommit,
    sourceBranch,
    sourceDirty: statusOutput.length > 0,
    sourceSessionId: request.sourceSessionId,
    piConfigRoot,
    worktreesRoot: join(piConfigRoot, "pi-agents", "worktrees"),
  };
}
