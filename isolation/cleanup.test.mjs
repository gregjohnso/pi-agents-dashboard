import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { cleanupOwnedWorktree } from "./cleanup.mjs";
import { launchPreflight } from "./launch-preflight.mjs";
import { createWorktree, WORKTREE_OWNERSHIP_FILE } from "./worktree.mjs";

const execFileAsync = promisify(execFile);
/** @type {string[]} */
const temporaryPaths = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** @param {string} cwd @param {string[]} args */
async function git(cwd, ...args) {
  return execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false });
}

/** @param {string} cwd */
async function configure(cwd) {
  await git(cwd, "config", "user.name", "Dashboard Tests");
  await git(cwd, "config", "user.email", "dashboard@example.test");
}

async function fixture({ remote = false } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-cleanup-"));
  temporaryPaths.push(parent);
  const piConfigRoot = join(parent, "pi-config");
  await mkdir(piConfigRoot);
  let root;
  let bareRemote;
  if (remote) {
    bareRemote = join(parent, "remote.git");
    await git(parent, "init", "--bare", bareRemote);
    root = join(parent, "repo");
    await git(parent, "clone", bareRemote, root);
    await configure(root);
    await git(root, "switch", "-c", "main");
  } else {
    root = join(parent, "repo");
    await mkdir(root);
    await git(root, "init", "-b", "main");
    await configure(root);
  }
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "base");
  if (remote) {
    await git(root, "push", "-u", "origin", "main");
  }
  root = await realpath(root);
  const preflight = await launchPreflight(
    {
      prompt: "Implement the task",
      cwd: root,
      sourceSessionId: "source-session",
      isolation: { mode: "worktree" },
    },
    { piConfigRoot: await realpath(piConfigRoot) },
  );
  const isolation = await createWorktree(preflight, { worktreeId: "cleanup-target" });
  return { parent, root, bareRemote, isolation };
}

/** @param {any} isolation @param {string} name @param {string} contents */
async function commit(isolation, name, contents) {
  await writeFile(join(isolation.worktreePath, name), contents);
  await git(isolation.worktreePath, "add", name);
  await git(isolation.worktreePath, "commit", "-m", name);
}

it("removes a clean dashboard-owned worktree still at its base without an upstream", async () => {
  const { isolation } = await fixture();

  const frozenIsolationRecord = {
    mode: isolation.mode,
    worktreePath: isolation.worktreePath,
    branch: isolation.branch,
  };
  await expect(cleanupOwnedWorktree(frozenIsolationRecord)).resolves.toEqual({
    disposition: "REMOVED",
  });
  await expect(access(isolation.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses cleanup while the session has live ownership", async () => {
  const { isolation } = await fixture();

  await expect(
    cleanupOwnedWorktree(isolation, { liveOwnership: { runId: "run-live" } }),
  ).rejects.toMatchObject({ code: "LIVE_OWNERSHIP" });
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it("refuses modified tracked files", async () => {
  const { isolation } = await fixture();
  await writeFile(join(isolation.worktreePath, "tracked.txt"), "dirty\n");

  await expect(cleanupOwnedWorktree(isolation)).rejects.toMatchObject({
    code: "DIRTY_WORKTREE",
  });
});

it("refuses untracked files", async () => {
  const { isolation } = await fixture();
  await writeFile(join(isolation.worktreePath, "untracked.txt"), "keep\n");

  await expect(cleanupOwnedWorktree(isolation)).rejects.toMatchObject({
    code: "UNTRACKED_FILES",
  });
});

it("refuses unpushed commits against a local bare remote", async () => {
  const { isolation } = await fixture({ remote: true });
  await git(isolation.worktreePath, "push", "-u", "origin", isolation.branch);
  await commit(isolation, "local.txt", "unpushed\n");

  await expect(cleanupOwnedWorktree(isolation)).rejects.toMatchObject({
    code: "UNPUSHED_COMMITS",
  });
});

it("refuses a changed HEAD with no upstream", async () => {
  const { isolation } = await fixture();
  await commit(isolation, "local.txt", "no upstream\n");

  await expect(cleanupOwnedWorktree(isolation)).rejects.toMatchObject({
    code: "MISSING_UPSTREAM",
  });
});

it("refuses divergent local and upstream history", async () => {
  const { parent, bareRemote, isolation } = await fixture({ remote: true });
  await git(isolation.worktreePath, "push", "-u", "origin", isolation.branch);
  await commit(isolation, "local.txt", "local\n");

  if (bareRemote === undefined) {
    throw new Error("remote fixture did not create a bare repository");
  }
  const other = join(parent, "other-clone");
  await git(parent, "clone", bareRemote, other);
  await configure(other);
  await git(other, "checkout", isolation.branch);
  await writeFile(join(other, "remote.txt"), "remote\n");
  await git(other, "add", "remote.txt");
  await git(other, "commit", "-m", "remote");
  await git(other, "push", "origin", isolation.branch);
  await git(isolation.worktreePath, "fetch", "origin");

  await expect(cleanupOwnedWorktree(isolation)).rejects.toMatchObject({
    code: "DIVERGENT_HISTORY",
  });
});

it("refuses cleanup when the dashboard ownership identity is malformed", async () => {
  const { isolation } = await fixture();
  const { stdout } = await git(isolation.worktreePath, "rev-parse", "--git-dir");
  const markerPath = join(stdout.trim(), WORKTREE_OWNERSHIP_FILE);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, `${JSON.stringify({ ...marker, ownershipId: "wrong" })}\n`);

  await expect(cleanupOwnedWorktree(isolation)).rejects.toMatchObject({
    code: "IDENTITY_MISMATCH",
  });
});

it("refuses a non-dashboard-owned linked worktree", async () => {
  const { parent, root, isolation } = await fixture();
  const unmanagedPath = join(parent, "unmanaged");
  const unmanagedBranch = "manual-worktree";
  await git(root, "worktree", "add", "-b", unmanagedBranch, unmanagedPath, isolation.baseCommit);
  const unmanaged = {
    ...isolation,
    worktreePath: await realpath(unmanagedPath),
    workerCwd: await realpath(unmanagedPath),
    branch: unmanagedBranch,
    ownershipId: isolation.ownershipId,
  };

  await expect(cleanupOwnedWorktree(unmanaged)).rejects.toMatchObject({
    code: "NOT_DASHBOARD_OWNED",
  });
});

it("refuses a record whose branch identity no longer matches", async () => {
  const { isolation } = await fixture();

  await expect(
    cleanupOwnedWorktree({ ...isolation, branch: `${basename(isolation.branch)}-other` }),
  ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
});

it("allows cleanup after changed commits are pushed to the configured upstream", async () => {
  const { isolation } = await fixture({ remote: true });
  await git(isolation.worktreePath, "push", "-u", "origin", isolation.branch);
  await commit(isolation, "pushed.txt", "pushed\n");
  await git(isolation.worktreePath, "push");

  await expect(cleanupOwnedWorktree(isolation)).resolves.toEqual({ disposition: "REMOVED" });
});
