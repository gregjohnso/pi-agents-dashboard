import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vitest";

import { launchPreflight, probeWorktreeCapability } from "./launch-preflight.mjs";

const execFileAsync = promisify(execFile);

/** @param {string} cwd @param {string[]} args */
async function git(cwd, ...args) {
  return execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false });
}

/**
 * One committed repository, one unborn repository, and one directory outside Git, shared by every
 * case in this file. Cases that need a different HEAD or a dirty tree take a linked worktree, so
 * the shared repository stays on a clean `main`.
 */
async function sharedFixtures() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "dashboard-preflight-")));
  const root = join(parent, "repo");
  const unborn = join(parent, "unborn");
  const outsideGit = join(parent, "outside-git");
  const piConfigRoot = join(parent, "pi-config");
  await Promise.all([
    mkdir(join(root, "src", "nested"), { recursive: true }),
    mkdir(unborn),
    mkdir(outsideGit),
    mkdir(piConfigRoot),
  ]);
  await Promise.all([git(root, "init", "-b", "main"), git(unborn, "init", "-b", "main")]);
  await git(root, "config", "user.name", "Dashboard Tests");
  await git(root, "config", "user.email", "dashboard@example.test");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "base");
  const alias = join(parent, "repo-alias");
  await symlink(root, alias);
  const { stdout: head } = await git(root, "rev-parse", "HEAD");
  return { parent, root, alias, unborn, outsideGit, piConfigRoot, head: head.trim() };
}

/** @type {Awaited<ReturnType<typeof sharedFixtures>>} */
let shared;
let worktreeSequence = 0;

beforeAll(async () => {
  shared = await sharedFixtures();
});
afterAll(async () => {
  await rm(shared.parent, { recursive: true, force: true });
});

/** A linked worktree of the shared repository, for cases that change HEAD or the working tree. */
async function linkedWorktree() {
  worktreeSequence += 1;
  const path = join(shared.parent, `linked-${worktreeSequence}`);
  await git(shared.root, "worktree", "add", "-b", `linked-${worktreeSequence}`, path);
  return path;
}

/**
 * @param {string} cwd
 * @param {import("../shared/contracts.mjs").LaunchIsolation} [isolation]
 * @returns {import("../shared/contracts.mjs").LaunchRequest}
 */
function request(cwd, isolation = { mode: "worktree" }) {
  return {
    prompt: "Implement the task",
    cwd,
    sourceSessionId: "source-session",
    isolation,
  };
}

it.each([
  ["a subdirectory cwd", () => join(shared.root, "src", "nested"), () => join(shared.root, "src", "nested"), join("src", "nested")],
])("preflights an attached branch from %s", async (_label, cwd, canonical, sourceSubdirectory) => {
  const result = await launchPreflight(request(cwd()), { piConfigRoot: shared.piConfigRoot });

  expect(result).toMatchObject({
    mode: "worktree",
    sourceSessionId: "source-session",
    canonicalCwd: canonical(),
    repositoryRoot: shared.root,
    sourceSubdirectory,
    baseCommit: shared.head,
    sourceBranch: "main",
    sourceDirty: false,
    piConfigRoot: shared.piConfigRoot,
    worktreesRoot: join(shared.piConfigRoot, "pi-agents", "worktrees"),
  });
});

it("uses the exact detached HEAD commit without inventing a branch", async () => {
  const detached = await linkedWorktree();
  await git(detached, "checkout", "--detach", shared.head);

  const result = await launchPreflight(request(detached), { piConfigRoot: shared.piConfigRoot });

  expect(result.baseCommit).toBe(shared.head);
  expect(result.sourceBranch).toBeNull();
});

it("refuses worktree launch from an unborn HEAD", async () => {
  await expect(
    launchPreflight(request(shared.unborn), { piConfigRoot: shared.piConfigRoot }),
  ).rejects.toMatchObject({ code: "UNBORN_HEAD" });
});

it("requires a server-derived Pi config root and rejects a client override", async () => {
  await expect(launchPreflight(request(shared.root), {})).rejects.toMatchObject({
    code: "PI_CONFIG_ROOT_REQUIRED",
  });
  await expect(
    launchPreflight(
      { ...request(shared.root), piConfigRoot: join(shared.parent, "untrusted") },
      { piConfigRoot: shared.piConfigRoot },
    ),
  ).rejects.toMatchObject({ code: "UNTRUSTED_PI_CONFIG_ROOT" });
});

it("supports explicit shared-directory preflight outside Git", async () => {
  const result = await launchPreflight(
    request(shared.outsideGit, {
      mode: "shared_directory",
      confirmedCwd: shared.outsideGit,
      ownerSessionIds: ["session-b", "session-a", "session-a"],
    }),
    { piConfigRoot: shared.piConfigRoot, currentOwnerSessionIds: ["session-b", "session-a", "session-a"] },
  );

  expect(result).toMatchObject({
    mode: "shared_directory_confirmation",
    canonicalCwd: shared.outsideGit,
    confirmedCanonicalCwd: shared.outsideGit,
    ownerSessionIds: ["session-a", "session-b"],
    piConfigRoot: shared.piConfigRoot,
  });
});

it.each([
  ["a directory outside Git", () => shared.outsideGit, "NOT_GIT_REPOSITORY"],
])("reports worktree isolation unavailable for %s", async (_label, cwd, code) => {
  expect(await probeWorktreeCapability(cwd())).toMatchObject({ available: false, code });
});
