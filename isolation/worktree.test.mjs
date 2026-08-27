import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vitest";

import { launchPreflight } from "./launch-preflight.mjs";
import { acquireWorktreeOwnershipLock, createWorktree } from "./worktree.mjs";

const execFileAsync = promisify(execFile);

/** @param {string} cwd @param {string[]} args */
async function git(cwd, ...args) {
  return execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false });
}

/**
 * One repository shared by every case in this file.
 *
 * No case changes `main`; each takes its own worktree ID, branch, and Pi configuration root, so
 * repository initialization stays out of the per-case cost.
 */
async function sharedRepository() {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-worktree-"));
  const root = join(parent, "repo");
  await mkdir(join(root, "packages", "app"), { recursive: true });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Dashboard Tests");
  await git(root, "config", "user.email", "dashboard@example.test");
  await Promise.all([
    writeFile(join(root, "tracked.txt"), "base\n"),
    writeFile(join(root, "packages", "app", "package.txt"), "app\n"),
  ]);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  return { parent, root: await realpath(root) };
}

/** @type {Awaited<ReturnType<typeof sharedRepository>>} */
let shared;
let configSequence = 0;

beforeAll(async () => {
  shared = await sharedRepository();
});
afterAll(async () => {
  await rm(shared.parent, { recursive: true, force: true });
});

/** A private Pi configuration root of this case alone, so directory-mode changes never leak. */
async function piConfigRoot() {
  configSequence += 1;
  const path = join(shared.parent, `pi-config-${configSequence}`);
  await mkdir(path, { mode: 0o700 });
  return realpath(path);
}

/** @param {string} piConfigRoot @param {string} [cwd] */
async function preflight(piConfigRoot, cwd = shared.root) {
  return launchPreflight(
    {
      prompt: "Implement the task",
      cwd,
      sourceSessionId: "source-session",
      isolation: { mode: "worktree" },
    },
    { piConfigRoot },
  );
}

it("reclaims an ownership lock abandoned by a dead dashboard process", async () => {
  const worktreePath = join(await piConfigRoot(), "pi-dashboard", "worktrees", "run-stale");
  const lockPath = `${worktreePath}.pi-dashboard-ownership.lock`;
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(
    join(lockPath, "dead-token"),
    `${JSON.stringify({ token: "dead-token", owner: { operation: "worktree_ownership", worktreePath }, holder: { pid: 4242, processGroupId: 4242, startIdentity: "9001" } })}\n`,
    { mode: 0o600 },
  );

  const lock = await acquireWorktreeOwnershipLock(worktreePath);

  expect(await stat(join(lockPath, "dead-token")).catch((error) => error.code)).toBe("ENOENT");
  await expect(lock.release()).resolves.toBeUndefined();
});

it("reclaims an identity-free legacy lock only when its worktree is gone", async () => {
  const worktreePath = join(await piConfigRoot(), "pi-dashboard", "worktrees", "run-legacy");
  const lockPath = `${worktreePath}.pi-dashboard-ownership.lock`;
  const writeLegacyLock = async () => {
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockPath, "legacy-token"),
      `${JSON.stringify({ token: "legacy-token", owner: { operation: "worktree_ownership", worktreePath } })}\n`,
      { mode: 0o600 },
    );
  };

  await mkdir(worktreePath, { recursive: true, mode: 0o700 });
  await writeLegacyLock();
  await expect(acquireWorktreeOwnershipLock(worktreePath)).rejects.toMatchObject({
    code: "WORKTREE_OWNERSHIP_LOCKED",
  });

  await rm(worktreePath, { recursive: true, force: true });
  await writeLegacyLock();
  const lock = await acquireWorktreeOwnershipLock(worktreePath);
  await expect(lock.release()).resolves.toBeUndefined();
});

it("refuses an ownership lock held by a live dashboard process", async () => {
  const worktreesRoot = join(await piConfigRoot(), "pi-dashboard", "worktrees");
  const worktreePath = join(worktreesRoot, "run-live");
  await mkdir(worktreesRoot, { recursive: true, mode: 0o700 });
  const held = await acquireWorktreeOwnershipLock(worktreePath);

  await expect(acquireWorktreeOwnershipLock(worktreePath)).rejects.toMatchObject({
    code: "WORKTREE_OWNERSHIP_LOCKED",
  });

  await held.release();
});

it("creates an owned branch worktree with private roots, its ownership marker, and the source subdirectory", async () => {
  const configRoot = await piConfigRoot();
  const result = await createWorktree(
    await preflight(configRoot, join(shared.root, "packages", "app")),
    { worktreeId: "run-123" },
  );

  expect(result).toMatchObject({
    mode: "worktree",
    worktreePath: join(configRoot, "pi-dashboard", "worktrees", "run-123"),
    branch: "pi-dashboard/run-123",
    workerCwd: join(configRoot, "pi-dashboard", "worktrees", "run-123", "packages", "app"),
    repositoryRoot: shared.root,
    baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/u),
    ownershipId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
  });
  await expect(access(result.workerCwd)).resolves.toBeUndefined();
  const { stdout: branch } = await git(result.worktreePath, "branch", "--show-current");
  expect(branch.trim()).toBe("pi-dashboard/run-123");
  const { stdout: gitDirectory } = await git(result.worktreePath, "rev-parse", "--git-dir");
  await expect(access(join(gitDirectory.trim(), "pi-dashboard-owner.json"))).resolves.toBeUndefined();
  expect((await stat(join(configRoot, "pi-dashboard"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(configRoot, "pi-dashboard", "worktrees"))).mode & 0o777).toBe(0o700);
});

it("rejects a pre-existing non-private dashboard worktree root", async () => {
  const configRoot = await piConfigRoot();
  const worktreesRoot = join(configRoot, "pi-dashboard", "worktrees");
  await mkdir(worktreesRoot, { recursive: true, mode: 0o700 });
  await chmod(worktreesRoot, 0o755);

  await expect(
    createWorktree(await preflight(configRoot), { worktreeId: "public-root" }),
  ).rejects.toMatchObject({ code: "INVALID_WORKTREES_ROOT" });
});

it("fails closed when an untracked source subdirectory is absent after checkout", async () => {
  const configRoot = await piConfigRoot();
  const untrackedSource = join(shared.root, "untracked-source");
  await mkdir(untrackedSource);
  try {
    await expect(
      createWorktree(await preflight(configRoot, untrackedSource), { worktreeId: "missing-source" }),
    ).rejects.toMatchObject({ code: "SOURCE_SUBDIRECTORY_MISSING" });
  } finally {
    await rm(untrackedSource, { recursive: true, force: true });
  }
  await expect(
    access(join(configRoot, "pi-dashboard", "worktrees", "missing-source")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    git(shared.root, "rev-parse", "--verify", "refs/heads/pi-dashboard/missing-source"),
  ).rejects.toBeDefined();
});

it("keeps the rollback branch when HEAD changes during ownership publication", async () => {
  const configRoot = await piConfigRoot();
  const preflightResult = await preflight(configRoot);

  await expect(
    createWorktree(preflightResult, {
      worktreeId: "rollback-race",
      writeOwnership: async (_path, _ownership, worktreePath) => {
        await writeFile(join(worktreePath, "late.txt"), "late\n");
        await git(worktreePath, "add", "late.txt");
        await git(worktreePath, "commit", "-m", "late identity change");
        throw new Error("ownership publication failed");
      },
    }),
  ).rejects.toMatchObject({ code: "WORKTREE_OWNERSHIP_FAILED" });

  const { stdout: branchHead } = await git(
    shared.root,
    "rev-parse",
    "--verify",
    "refs/heads/pi-dashboard/rollback-race^{commit}",
  );
  expect(branchHead.trim()).not.toBe(preflightResult.baseCommit);
  await expect(
    access(join(configRoot, "pi-dashboard", "worktrees", "rollback-race")),
  ).resolves.toBeUndefined();
});

it("creates from a canonicalized source-repository alias", async () => {
  const configRoot = await piConfigRoot();
  const repositoryAlias = join(shared.parent, "repo-alias");
  await symlink(shared.root, repositoryAlias);

  const result = await createWorktree(await preflight(configRoot, repositoryAlias), {
    worktreeId: "canonical",
  });

  expect(result.repositoryRoot).toBe(shared.root);
  expect(result.worktreePath).toBe(join(configRoot, "pi-dashboard", "worktrees", "canonical"));
});

it("reports branch collision and never falls back to shared directory", async () => {
  const configRoot = await piConfigRoot();
  await git(shared.root, "branch", "pi-dashboard/branch-collision");

  await expect(
    createWorktree(await preflight(configRoot), { worktreeId: "branch-collision" }),
  ).rejects.toMatchObject({ code: "WORKTREE_CREATE_FAILED" });
});

it("reports path collision and leaves the existing path intact", async () => {
  const configRoot = await piConfigRoot();
  const collisionPath = join(configRoot, "pi-dashboard", "worktrees", "path-collision");
  await mkdir(collisionPath, { recursive: true, mode: 0o700 });
  await writeFile(join(collisionPath, "sentinel"), "keep\n");

  await expect(
    createWorktree(await preflight(configRoot), { worktreeId: "path-collision" }),
  ).rejects.toMatchObject({ code: "WORKTREE_CREATE_FAILED" });
  await expect(access(join(collisionPath, "sentinel"))).resolves.toBeUndefined();
});

it("rejects worktree IDs that could become argv or path injection", async () => {
  const configRoot = await piConfigRoot();

  await expect(
    createWorktree(await preflight(configRoot), { worktreeId: "--force; touch pwned" }),
  ).rejects.toMatchObject({ code: "INVALID_WORKTREE_ID" });
  await expect(access(join(shared.parent, "pwned"))).rejects.toMatchObject({ code: "ENOENT" });
});
