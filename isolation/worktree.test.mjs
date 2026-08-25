import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { launchPreflight } from "./launch-preflight.mjs";
import { createWorktree } from "./worktree.mjs";

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

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-worktree-"));
  temporaryPaths.push(parent);
  const root = join(parent, "repo");
  const piConfigRoot = join(parent, "pi-config");
  await Promise.all([mkdir(root), mkdir(piConfigRoot)]);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Dashboard Tests");
  await git(root, "config", "user.email", "dashboard@example.test");
  await mkdir(join(root, "packages", "app"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "tracked.txt"), "base\n"),
    writeFile(join(root, "packages", "app", "package.txt"), "app\n"),
  ]);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  return { parent, root: await realpath(root), piConfigRoot: await realpath(piConfigRoot) };
}

/** @param {{ root: string, piConfigRoot: string }} paths @param {string} [cwd] */
async function preflight(paths, cwd = paths.root) {
  return launchPreflight(
    {
      prompt: "Implement the task",
      cwd,
      sourceSessionId: "source-session",
      isolation: { mode: "worktree" },
    },
    { piConfigRoot: paths.piConfigRoot },
  );
}

it("creates an owned branch worktree and preserves the source subdirectory", async () => {
  const paths = await fixture();
  const result = await createWorktree(
    await preflight(paths, join(paths.root, "packages", "app")),
    { worktreeId: "run-123" },
  );

  expect(result).toMatchObject({
    mode: "worktree",
    worktreePath: join(paths.piConfigRoot, "agents-dashboard", "worktrees", "run-123"),
    branch: "pi-agents/run-123",
    workerCwd: join(
      paths.piConfigRoot,
      "agents-dashboard",
      "worktrees",
      "run-123",
      "packages",
      "app",
    ),
    repositoryRoot: paths.root,
    baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/u),
    ownershipId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
  });
  await expect(access(result.workerCwd)).resolves.toBeUndefined();
  const { stdout: branch } = await git(result.worktreePath, "branch", "--show-current");
  expect(branch.trim()).toBe("pi-agents/run-123");
});

it("creates from a canonicalized source-repository alias", async () => {
  const paths = await fixture();
  const repositoryAlias = join(paths.parent, "repo-alias");
  await symlink(paths.root, repositoryAlias);

  const result = await createWorktree(await preflight(paths, repositoryAlias), {
    worktreeId: "canonical",
  });

  expect(result.repositoryRoot).toBe(paths.root);
  expect(result.worktreePath).toBe(
    join(paths.piConfigRoot, "agents-dashboard", "worktrees", "canonical"),
  );
});

it("reports branch collision and never falls back to shared directory", async () => {
  const paths = await fixture();
  await git(paths.root, "branch", "pi-agents/collision");

  await expect(
    createWorktree(await preflight(paths), { worktreeId: "collision" }),
  ).rejects.toMatchObject({ code: "WORKTREE_CREATE_FAILED" });
});

it("reports path collision and leaves the existing path intact", async () => {
  const paths = await fixture();
  const collisionPath = join(paths.piConfigRoot, "agents-dashboard", "worktrees", "collision");
  await mkdir(collisionPath, { recursive: true });
  await writeFile(join(collisionPath, "sentinel"), "keep\n");

  await expect(
    createWorktree(await preflight(paths), { worktreeId: "collision" }),
  ).rejects.toMatchObject({ code: "WORKTREE_CREATE_FAILED" });
  await expect(access(join(collisionPath, "sentinel"))).resolves.toBeUndefined();
});

it("rejects worktree IDs that could become argv or path injection", async () => {
  const paths = await fixture();

  await expect(
    createWorktree(await preflight(paths), { worktreeId: "--force; touch pwned" }),
  ).rejects.toMatchObject({ code: "INVALID_WORKTREE_ID" });
  await expect(access(join(paths.parent, "pwned"))).rejects.toMatchObject({ code: "ENOENT" });
});
