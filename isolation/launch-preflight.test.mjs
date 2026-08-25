import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { launchPreflight } from "./launch-preflight.mjs";

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

/** @param {{ commit?: boolean }} [options] */
async function repository({ commit = true } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-preflight-"));
  temporaryPaths.push(parent);
  const root = join(parent, "repo");
  const piConfigRoot = join(parent, "pi-config");
  await Promise.all([mkdir(root), mkdir(piConfigRoot)]);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Dashboard Tests");
  await git(root, "config", "user.email", "dashboard@example.test");
  if (commit) {
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "-m", "base");
  }
  return { parent, root: await realpath(root), piConfigRoot: await realpath(piConfigRoot) };
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

it("preflights an attached branch and preserves a subdirectory cwd", async () => {
  const fixture = await repository();
  const subdirectory = join(fixture.root, "src", "nested");
  await mkdir(subdirectory, { recursive: true });

  const result = await launchPreflight(request(subdirectory), {
    piConfigRoot: fixture.piConfigRoot,
  });

  const { stdout: head } = await git(fixture.root, "rev-parse", "HEAD");
  expect(result).toMatchObject({
    mode: "worktree",
    sourceSessionId: "source-session",
    canonicalCwd: subdirectory,
    repositoryRoot: fixture.root,
    sourceSubdirectory: join("src", "nested"),
    baseCommit: head.trim(),
    sourceBranch: "main",
    sourceDirty: false,
    piConfigRoot: fixture.piConfigRoot,
    worktreesRoot: join(fixture.piConfigRoot, "agents-dashboard", "worktrees"),
  });
});

it("uses the exact detached HEAD commit without inventing a branch", async () => {
  const fixture = await repository();
  const { stdout } = await git(fixture.root, "rev-parse", "HEAD");
  await git(fixture.root, "checkout", "--detach", stdout.trim());

  const result = await launchPreflight(request(fixture.root), {
    piConfigRoot: fixture.piConfigRoot,
  });

  expect(result.baseCommit).toBe(stdout.trim());
  expect(result.sourceBranch).toBeNull();
});

it("refuses worktree launch from an unborn HEAD", async () => {
  const fixture = await repository({ commit: false });

  await expect(
    launchPreflight(request(fixture.root), { piConfigRoot: fixture.piConfigRoot }),
  ).rejects.toMatchObject({ code: "UNBORN_HEAD" });
});

it("records a dirty source without copying its uncommitted state", async () => {
  const fixture = await repository();
  await writeFile(join(fixture.root, "tracked.txt"), "dirty\n");

  const result = await launchPreflight(request(fixture.root), {
    piConfigRoot: fixture.piConfigRoot,
  });

  expect(result.sourceDirty).toBe(true);
});

it("canonicalizes cwd aliases before deriving repository metadata", async () => {
  const fixture = await repository();
  const alias = join(fixture.parent, "repo-alias");
  await symlink(fixture.root, alias);

  const result = await launchPreflight(request(alias), {
    piConfigRoot: fixture.piConfigRoot,
  });

  expect(result.canonicalCwd).toBe(fixture.root);
  expect(result.repositoryRoot).toBe(fixture.root);
});

it("requires a server-derived Pi config root and rejects a client override", async () => {
  const fixture = await repository();

  await expect(launchPreflight(request(fixture.root), {})).rejects.toMatchObject({
    code: "PI_CONFIG_ROOT_REQUIRED",
  });
  await expect(
    launchPreflight(
      { ...request(fixture.root), piConfigRoot: join(fixture.parent, "untrusted") },
      { piConfigRoot: fixture.piConfigRoot },
    ),
  ).rejects.toMatchObject({ code: "UNTRUSTED_PI_CONFIG_ROOT" });
});

it("supports explicit shared-directory preflight outside Git", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-shared-preflight-"));
  temporaryPaths.push(parent);
  const cwd = join(parent, "cwd");
  const piConfigRoot = join(parent, "pi-config");
  await Promise.all([mkdir(cwd), mkdir(piConfigRoot)]);

  const result = await launchPreflight(
    request(cwd, { mode: "shared_directory", confirmedCwd: cwd }),
    { piConfigRoot, currentOwnerSessionIds: ["session-b", "session-a", "session-a"] },
  );

  expect(result).toMatchObject({
    mode: "shared_directory_confirmation",
    canonicalCwd: cwd,
    confirmedCanonicalCwd: cwd,
    ownerSessionIds: ["session-a", "session-b"],
    piConfigRoot,
  });
});

it("does not infer shared mode when worktree preflight is outside Git", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-non-repo-"));
  temporaryPaths.push(parent);
  const cwd = join(parent, "cwd");
  const piConfigRoot = join(parent, "pi-config");
  await Promise.all([mkdir(cwd), mkdir(piConfigRoot)]);

  await expect(
    launchPreflight(request(cwd), { piConfigRoot }),
  ).rejects.toMatchObject({ code: "NOT_GIT_REPOSITORY" });
});
