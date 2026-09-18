import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { cleanupOwnedWorktree } from "./cleanup.mjs";
import { launchPreflight } from "./launch-preflight.mjs";
import {
  acquireWorktreeOwnershipLock,
  createWorktree,
  LEGACY_WORKTREE_OWNERSHIP_FILES,
  WORKTREE_OWNERSHIP_FILE,
} from "./worktree.mjs";

const execFileAsync = promisify(execFile);
const noLiveOwnershipOptions = { readLiveOwnership: async () => null };

/** @param {string} cwd @param {string[]} args */
async function git(cwd, ...args) {
  return execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false });
}

/** @param {string} cwd */
async function configure(cwd) {
  await git(cwd, "config", "user.name", "Dashboard Tests");
  await git(cwd, "config", "user.email", "dashboard@example.test");
}

/** @param {string} root @param {string} piConfigRoot */
async function worktreePreflight(root, piConfigRoot) {
  return launchPreflight(
    {
      prompt: "Implement the task",
      cwd: root,
      sourceSessionId: "source-session",
      isolation: { mode: "worktree" },
    },
    { piConfigRoot },
  );
}

/**
 * One local repository and one clone of a local bare remote, shared by every case in this file.
 *
 * Cases never change `main` in either repository; each takes its own dashboard-owned worktree and
 * branch, so Git initialization stays out of the per-case cost.
 */
async function sharedRepositories() {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-cleanup-"));
  const piConfigRoot = join(parent, "pi-config");
  await mkdir(piConfigRoot);

  const local = join(parent, "repo");
  await mkdir(local);
  await git(local, "init", "-b", "main");
  await configure(local);
  await writeFile(join(local, "tracked.txt"), "base\n");
  await git(local, "add", "tracked.txt");
  await git(local, "commit", "-m", "base");

  const bareRemote = join(parent, "remote.git");
  await git(parent, "init", "--bare", bareRemote);
  const cloned = join(parent, "clone");
  await git(parent, "clone", bareRemote, cloned);
  await configure(cloned);
  await git(cloned, "switch", "-c", "main");
  await writeFile(join(cloned, "tracked.txt"), "base\n");
  await git(cloned, "add", "tracked.txt");
  await git(cloned, "commit", "-m", "base");
  await git(cloned, "push", "-u", "origin", "main");

  const canonicalPiConfigRoot = await realpath(piConfigRoot);
  const [root, clone] = await Promise.all([realpath(local), realpath(cloned)]);
  const [preflight, clonePreflight] = await Promise.all([
    worktreePreflight(root, canonicalPiConfigRoot),
    worktreePreflight(clone, canonicalPiConfigRoot),
  ]);
  return { parent, root, bareRemote, preflight, clonePreflight };
}

/** @type {Awaited<ReturnType<typeof sharedRepositories>>} */
let shared;
let worktreeSequence = 0;

beforeAll(async () => {
  shared = await sharedRepositories();
});
afterAll(async () => {
  await rm(shared.parent, { recursive: true, force: true });
});

/** @param {{ remote?: boolean }} [options] */
async function ownedWorktree({ remote = false } = {}) {
  worktreeSequence += 1;
  return createWorktree(remote ? shared.clonePreflight : shared.preflight, {
    worktreeId: `cleanup-${worktreeSequence}`,
  });
}

/** @param {{ worktreePath: string }} isolation @param {string} [file] */
async function markerPath(isolation, file = WORKTREE_OWNERSHIP_FILE) {
  const { stdout } = await git(isolation.worktreePath, "rev-parse", "--git-dir");
  return join(stdout.trim(), file);
}

/** @param {{ worktreePath: string }} isolation @param {string} name @param {string} contents */
async function commit(isolation, name, contents) {
  await writeFile(join(isolation.worktreePath, name), contents);
  await git(isolation.worktreePath, "add", name);
  await git(isolation.worktreePath, "commit", "-m", name);
}

it.each(LEGACY_WORKTREE_OWNERSHIP_FILES.slice(-1))("recognizes the %s legacy ownership marker during cleanup", async (legacyFile) => {
  const isolation = await ownedWorktree();
  await rename(await markerPath(isolation), await markerPath(isolation, legacyFile));
  await expect(cleanupOwnedWorktree(isolation, noLiveOwnershipOptions)).resolves.toMatchObject({ disposition: "REMOVED" });
});

it.each([
  ["omitted", undefined],
])("fails closed when the authoritative ownership reader is %s", async (_label, options) => {
  const isolation = await ownedWorktree();

  await expect(
    cleanupOwnedWorktree(isolation, /** @type {any} */ (options)),
  ).rejects.toThrow("readLiveOwnership must be a function");
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it("removes a clean dashboard-owned worktree still at its base without an upstream", async () => {
  const isolation = await ownedWorktree();

  const frozenIsolationRecord = {
    mode: isolation.mode,
    worktreePath: isolation.worktreePath,
    branch: isolation.branch,
  };
  await expect(
    cleanupOwnedWorktree(frozenIsolationRecord, { readLiveOwnership: async () => null }),
  ).resolves.toEqual({ disposition: "REMOVED" });
  await expect(access(isolation.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses cleanup while the session has live ownership", async () => {
  const isolation = await ownedWorktree();

  await expect(
    cleanupOwnedWorktree(isolation, {
      readLiveOwnership: async () => ({ runId: "run-live" }),
    }),
  ).rejects.toMatchObject({ code: "LIVE_OWNERSHIP" });
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it.each([
  [
    "a modified tracked file",
    /** @param {string} worktreePath */ async (worktreePath) => {
      await writeFile(join(worktreePath, "tracked.txt"), "dirty\n");
    },
    "DIRTY_WORKTREE",
  ],
  [
    "an untracked file",
    /** @param {string} worktreePath */ async (worktreePath) => {
      await writeFile(join(worktreePath, "untracked.txt"), "keep\n");
    },
    "UNTRACKED_FILES",
  ],
])("refuses cleanup and keeps %s", async (_label, dirty, code) => {
  const isolation = await ownedWorktree();
  const preserved = await dirty(isolation.worktreePath);

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({ code });
  await expect(access(preserved ?? isolation.worktreePath)).resolves.toBeUndefined();
});

it.each([
  [
    "live ownership",
    /** @param {any} _isolation */ async (_isolation) => ({ runId: "late-owner" }),
    "LIVE_OWNERSHIP",
  ],
  [
    "the ownership marker repository",
    /** @param {any} isolation */ async (isolation) => {
      const path = await markerPath(isolation);
      const marker = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, `${JSON.stringify({ ...marker, repositoryRoot: isolation.worktreePath })}\n`);
      return null;
    },
    "IDENTITY_MISMATCH",
  ],
])("rechecks %s immediately before worktree removal", async (_label, change, code) => {
  const isolation = await ownedWorktree();
  const readLiveOwnership = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(() => change(isolation));

  await expect(
    cleanupOwnedWorktree(isolation, { readLiveOwnership }),
  ).rejects.toMatchObject({ code });
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it("cleans up after a dashboard that died holding the ownership lock", async () => {
  const isolation = await ownedWorktree();
  const lockPath = `${isolation.worktreePath}.pi-agents-ownership.lock`;
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(
    join(lockPath, "dead-token"),
    `${JSON.stringify({ token: "dead-token", owner: { operation: "worktree_ownership", worktreePath: isolation.worktreePath }, holder: { pid: 4242, processGroupId: 4242, startIdentity: "9001" } })}\n`,
    { mode: 0o600 },
  );

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).resolves.toEqual({ disposition: "REMOVED" });
});

it("holds the authoritative ownership lock throughout cleanup", async () => {
  const isolation = await ownedWorktree();
  const lock = await acquireWorktreeOwnershipLock(isolation.worktreePath);

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "WORKTREE_OWNERSHIP_LOCKED",
  });
  await lock.release();
  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).resolves.toEqual({ disposition: "REMOVED" });
});

it("refuses unpushed commits against a local bare remote", async () => {
  const isolation = await ownedWorktree({ remote: true });
  await git(isolation.worktreePath, "push", "-u", "origin", isolation.branch);
  await commit(isolation, "local.txt", "unpushed\n");

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "UNPUSHED_COMMITS",
  });
});

it("refuses a changed HEAD with no upstream", async () => {
  const isolation = await ownedWorktree();
  await commit(isolation, "local.txt", "no upstream\n");

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "MISSING_UPSTREAM",
  });
});

it("refuses cleanup when the dashboard ownership identity is malformed", async () => {
  const isolation = await ownedWorktree();
  const path = await markerPath(isolation);
  const marker = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify({ ...marker, ownershipId: "wrong" })}\n`);

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "IDENTITY_MISMATCH",
  });
});

it("refuses a non-dashboard-owned linked worktree", async () => {
  const isolation = await ownedWorktree();
  const unmanagedPath = join(shared.parent, "unmanaged");
  const unmanagedBranch = "manual-worktree";
  await git(shared.root, "worktree", "add", "-b", unmanagedBranch, unmanagedPath, isolation.baseCommit);
  const unmanaged = {
    ...isolation,
    worktreePath: await realpath(unmanagedPath),
    workerCwd: await realpath(unmanagedPath),
    branch: unmanagedBranch,
    ownershipId: isolation.ownershipId,
  };

  await expect(
    cleanupOwnedWorktree(unmanaged, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "NOT_DASHBOARD_OWNED",
  });
});

it("refuses a record whose branch identity no longer matches", async () => {
  const isolation = await ownedWorktree();

  await expect(
    cleanupOwnedWorktree(
      { ...isolation, branch: `${basename(isolation.branch)}-other` },
      noLiveOwnershipOptions,
    ),
  ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
});

it("allows cleanup after changed commits are pushed to the configured upstream", async () => {
  const isolation = await ownedWorktree({ remote: true });
  await git(isolation.worktreePath, "push", "-u", "origin", isolation.branch);
  await commit(isolation, "pushed.txt", "pushed\n");
  await git(isolation.worktreePath, "push");

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).resolves.toEqual({ disposition: "REMOVED" });
});
