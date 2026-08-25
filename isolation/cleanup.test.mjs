import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it, vi } from "vitest";

import { cleanupOwnedWorktree } from "./cleanup.mjs";
import { launchPreflight } from "./launch-preflight.mjs";
import {
  acquireWorktreeOwnershipLock,
  createWorktree,
  LEGACY_WORKTREE_OWNERSHIP_FILE,
  WORKTREE_OWNERSHIP_FILE,
} from "./worktree.mjs";

const execFileAsync = promisify(execFile);
const noLiveOwnershipOptions = { readLiveOwnership: async () => null };
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

it("recognizes the legacy ownership marker during cleanup", async () => {
  const { isolation } = await fixture();
  const { stdout } = await git(isolation.worktreePath, "rev-parse", "--git-dir");
  const gitDirectory = stdout.trim();
  await rename(join(gitDirectory, WORKTREE_OWNERSHIP_FILE), join(gitDirectory, LEGACY_WORKTREE_OWNERSHIP_FILE));
  await expect(cleanupOwnedWorktree(isolation, noLiveOwnershipOptions)).resolves.toMatchObject({ disposition: "REMOVED" });
});

it("fails closed when the authoritative ownership reader is omitted", async () => {
  const { isolation } = await fixture();

  // @ts-expect-error Exercise runtime validation for omitted required options.
  await expect(cleanupOwnedWorktree(isolation)).rejects.toThrow(
    "readLiveOwnership must be a function",
  );
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it("does not accept a live ownership snapshot as an authoritative reader", async () => {
  const { isolation } = await fixture();

  await expect(
    // @ts-expect-error Exercise runtime rejection of the removed snapshot option.
    cleanupOwnedWorktree(isolation, { liveOwnership: null }),
  ).rejects.toThrow("readLiveOwnership must be a function");
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it("removes a clean dashboard-owned worktree still at its base without an upstream", async () => {
  const { isolation } = await fixture();

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
  const { isolation } = await fixture();

  await expect(
    cleanupOwnedWorktree(isolation, {
      readLiveOwnership: async () => ({ runId: "run-live" }),
    }),
  ).rejects.toMatchObject({ code: "LIVE_OWNERSHIP" });
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it("refuses modified tracked files", async () => {
  const { isolation } = await fixture();
  await writeFile(join(isolation.worktreePath, "tracked.txt"), "dirty\n");

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "DIRTY_WORKTREE",
  });
});

it("refuses untracked files", async () => {
  const { isolation } = await fixture();
  await writeFile(join(isolation.worktreePath, "untracked.txt"), "keep\n");

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "UNTRACKED_FILES",
  });
});

it("classifies ignored untracked files as UNTRACKED_FILES", async () => {
  const { isolation } = await fixture();
  await writeFile(join(isolation.worktreePath, ".gitignore"), "ignored.txt\n");
  await git(isolation.worktreePath, "add", ".gitignore");
  await git(isolation.worktreePath, "commit", "-m", "ignore test artifact");
  await writeFile(join(isolation.worktreePath, "ignored.txt"), "keep\n");

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "UNTRACKED_FILES",
  });
  await expect(access(join(isolation.worktreePath, "ignored.txt"))).resolves.toBeUndefined();
});

it("rechecks live ownership immediately before worktree removal", async () => {
  const { isolation } = await fixture();
  const readLiveOwnership = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ runId: "late-owner" });

  await expect(
    cleanupOwnedWorktree(isolation, { readLiveOwnership }),
  ).rejects.toMatchObject({ code: "LIVE_OWNERSHIP" });
  expect(readLiveOwnership).toHaveBeenCalledTimes(2);
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it("holds the authoritative ownership lock throughout cleanup", async () => {
  const { isolation } = await fixture();
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

it("rechecks the ownership marker and repository immediately before worktree removal", async () => {
  const { isolation } = await fixture();
  const { stdout } = await git(isolation.worktreePath, "rev-parse", "--git-dir");
  const markerPath = join(stdout.trim(), WORKTREE_OWNERSHIP_FILE);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  const readLiveOwnership = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(async () => {
      await writeFile(markerPath, `${JSON.stringify({ ...marker, repositoryRoot: isolation.worktreePath })}\n`);
      return null;
    });

  await expect(
    cleanupOwnedWorktree(isolation, { readLiveOwnership }),
  ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it("rechecks the branch immediately before worktree removal", async () => {
  const { isolation } = await fixture();
  const readLiveOwnership = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(async () => {
      await git(isolation.worktreePath, "switch", "-c", "late-branch");
      return null;
    });

  await expect(
    cleanupOwnedWorktree(isolation, { readLiveOwnership }),
  ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it("rechecks HEAD immediately before worktree removal", async () => {
  const { isolation } = await fixture();
  const readLiveOwnership = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(async () => {
      await commit(isolation, "late.txt", "late commit\n");
      return null;
    });

  await expect(
    cleanupOwnedWorktree(isolation, { readLiveOwnership }),
  ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  await expect(access(isolation.worktreePath)).resolves.toBeUndefined();
});

it("refuses unpushed commits against a local bare remote", async () => {
  const { isolation } = await fixture({ remote: true });
  await git(isolation.worktreePath, "push", "-u", "origin", isolation.branch);
  await commit(isolation, "local.txt", "unpushed\n");

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "UNPUSHED_COMMITS",
  });
});

it("refuses a changed HEAD with no upstream", async () => {
  const { isolation } = await fixture();
  await commit(isolation, "local.txt", "no upstream\n");

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
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

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "DIVERGENT_HISTORY",
  });
});

it("refuses cleanup when the dashboard ownership identity is malformed", async () => {
  const { isolation } = await fixture();
  const { stdout } = await git(isolation.worktreePath, "rev-parse", "--git-dir");
  const markerPath = join(stdout.trim(), WORKTREE_OWNERSHIP_FILE);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, `${JSON.stringify({ ...marker, ownershipId: "wrong" })}\n`);

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
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

  await expect(
    cleanupOwnedWorktree(unmanaged, noLiveOwnershipOptions),
  ).rejects.toMatchObject({
    code: "NOT_DASHBOARD_OWNED",
  });
});

it("refuses a record whose branch identity no longer matches", async () => {
  const { isolation } = await fixture();

  await expect(
    cleanupOwnedWorktree(
      { ...isolation, branch: `${basename(isolation.branch)}-other` },
      noLiveOwnershipOptions,
    ),
  ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
});

it("allows cleanup after changed commits are pushed to the configured upstream", async () => {
  const { isolation } = await fixture({ remote: true });
  await git(isolation.worktreePath, "push", "-u", "origin", isolation.branch);
  await commit(isolation, "pushed.txt", "pushed\n");
  await git(isolation.worktreePath, "push");

  await expect(
    cleanupOwnedWorktree(isolation, noLiveOwnershipOptions),
  ).resolves.toEqual({ disposition: "REMOVED" });
});
