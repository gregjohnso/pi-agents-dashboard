import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { launchPreflight } from "./launch-preflight.mjs";
import { confirmSharedDirectory } from "./shared-directory.mjs";

/** @type {string[]} */
const temporaryPaths = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-shared-"));
  temporaryPaths.push(parent);
  const cwd = join(parent, "cwd");
  const other = join(parent, "other");
  const piConfigRoot = join(parent, "pi-config");
  await Promise.all([mkdir(cwd), mkdir(other), mkdir(piConfigRoot)]);
  const alias = join(parent, "alias");
  await symlink(cwd, alias);
  return {
    cwd: await realpath(cwd),
    alias,
    other: await realpath(other),
    piConfigRoot: await realpath(piConfigRoot),
  };
}

/**
 * @param {string} cwd
 * @param {string} confirmedCwd
 * @returns {import("../shared/contracts.mjs").LaunchRequest}
 */
function sharedRequest(cwd, confirmedCwd) {
  return {
    prompt: "Use the shared directory",
    cwd,
    sourceSessionId: "source-session",
    isolation: { mode: "shared_directory", confirmedCwd },
  };
}

it("binds confirmation to the exact canonical cwd and current owners", async () => {
  const paths = await fixture();
  const warning = await launchPreflight(sharedRequest(paths.alias, paths.cwd), {
    piConfigRoot: paths.piConfigRoot,
    currentOwnerSessionIds: ["owner-a"],
  });

  await expect(
    confirmSharedDirectory(
      { ...warning, confirmedCanonicalCwd: paths.other },
      { currentOwnerSessionIds: ["owner-a"] },
    ),
  ).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
  await expect(
    confirmSharedDirectory(warning, { currentOwnerSessionIds: ["owner-b", "owner-a"] }),
  ).rejects.toMatchObject({ code: "OWNERS_CHANGED" });
});

it("accepts only the echoed canonical path and unchanged owner set", async () => {
  const paths = await fixture();
  const warning = await launchPreflight(sharedRequest(paths.alias, paths.cwd), {
    piConfigRoot: paths.piConfigRoot,
    currentOwnerSessionIds: ["owner-b", "owner-a"],
  });

  await expect(
    confirmSharedDirectory(warning, {
      currentOwnerSessionIds: ["owner-a", "owner-b", "owner-a"],
    }),
  ).resolves.toEqual({
    mode: "shared_directory",
    canonicalCwd: paths.cwd,
    workerCwd: paths.cwd,
    sourceSessionId: "source-session",
    piConfigRoot: paths.piConfigRoot,
  });
});

it("rejects an alias as confirmation even when it resolves to the same directory", async () => {
  const paths = await fixture();
  const warning = await launchPreflight(sharedRequest(paths.alias, paths.alias), {
    piConfigRoot: paths.piConfigRoot,
  });

  await expect(
    confirmSharedDirectory(warning, { currentOwnerSessionIds: [] }),
  ).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
});

it("refuses malformed or worktree preflight records", async () => {
  await expect(
    confirmSharedDirectory({ mode: "worktree" }, { currentOwnerSessionIds: [] }),
  ).rejects.toMatchObject({ code: "INVALID_SHARED_PREFLIGHT" });
});
