import * as fs from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { adoptRenamedStateRoot } from "./state-root-adoption.mjs";

/** @type {string[]} */
const parents = [];
const quiet = async () => ({ activeDaemon: false, activeSupervisors: [], unverifiable: false });

afterEach(async () => Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true }))));

async function stateParent() {
  const parent = await mkdtemp(join(tmpdir(), "pi-agents-adoption-"));
  parents.push(parent);
  return { parent, env: { HOME: parent, XDG_STATE_HOME: parent }, previousRoot: join(parent, "pi-dashboard"), root: join(parent, "pi-agents") };
}

/** @param {string} root @param {string[]} sessionIds */
async function seedRoot(root, sessionIds) {
  await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "daemon"), { recursive: true, mode: 0o700 });
  for (const sessionId of sessionIds) await writeFile(join(root, "sessions", `${sessionId}.json`), JSON.stringify({ sessionId }), { mode: 0o600 });
  return root;
}

it("adopts the previous state root by renaming it in place", async () => {
  const { env, parent, previousRoot, root } = await stateParent();
  await seedRoot(previousRoot, ["alpha", "beta", "gamma", "delta"]);
  const before = await stat(previousRoot);

  const adoption = await adoptRenamedStateRoot({ env, inspectActivity: quiet });

  expect(adoption).toMatchObject({ status: "ADOPTED", root });
  expect(adoption.message).toContain(previousRoot);
  expect(adoption.message).toContain(root);
  expect((await stat(root)).ino).toBe(before.ino);
  expect((await readdir(join(root, "sessions"))).sort()).toEqual(["alpha.json", "beta.json", "delta.json", "gamma.json"]);
  await expect(lstat(previousRoot)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(parent)).toEqual(["pi-agents"]);
});

it("keeps an explicit state directory and adopts nothing", async () => {
  const { env, previousRoot } = await stateParent();
  await seedRoot(previousRoot, ["alpha"]);

  const adoption = await adoptRenamedStateRoot({ env: { ...env, PI_AGENTS_STATE_DIR: previousRoot }, inspectActivity: quiet });

  expect(adoption).toEqual({ status: "EXPLICIT_ROOT", root: previousRoot });
  await expect(lstat(previousRoot)).resolves.toMatchObject({});
});

it.each([
  ["daemon", { activeDaemon: { pid: 4242 }, activeSupervisors: [], unverifiable: false }],
])("defers the rename and keeps running against the previous root while it holds a live %s", async (_label, activity) => {
  const { env, previousRoot } = await stateParent();
  await seedRoot(previousRoot, ["alpha"]);

  const adoption = await adoptRenamedStateRoot({ env, inspectActivity: async () => activity });

  expect(adoption).toMatchObject({ status: "DEFERRED_RUNTIME_ACTIVE", root: previousRoot });
  expect(adoption.message).toContain(previousRoot);
  expect((await readdir(join(previousRoot, "sessions"))).sort()).toEqual(["alpha.json"]);
});

it("refuses to start when both roots hold sessions, naming both paths", async () => {
  const { env, previousRoot, root } = await stateParent();
  await seedRoot(previousRoot, ["alpha", "beta", "gamma", "delta"]);
  await seedRoot(root, ["epsilon"]);

  const refusal = await adoptRenamedStateRoot({ env, inspectActivity: quiet }).catch((error) => error);

  expect(refusal).toMatchObject({ code: "STATE_ROOTS_SPLIT" });
  expect(refusal.message).toContain(`${previousRoot} (4 sessions)`);
  expect(refusal.message).toContain(`${root} (1 session)`);
  expect((await readdir(join(previousRoot, "sessions"))).length).toBe(4);
  expect((await readdir(join(root, "sessions"))).length).toBe(1);
});

it("reports the previous root instead of adopting it when the new root already holds no sessions", async () => {
  const { env, previousRoot, root } = await stateParent();
  await seedRoot(previousRoot, []);
  await seedRoot(root, ["epsilon"]);

  const adoption = await adoptRenamedStateRoot({ env, inspectActivity: quiet });

  expect(adoption).toMatchObject({ status: "PREVIOUS_ROOT_EMPTY", root });
  expect(adoption.message).toContain(previousRoot);
  await expect(lstat(previousRoot)).resolves.toMatchObject({});
});

it.each([
  ["a symlinked previous root", async (/** @type {any} */ { parent, previousRoot }) => {
    await mkdir(join(parent, "elsewhere"), { mode: 0o700 });
    await symlink(join(parent, "elsewhere"), previousRoot);
  }],
])("refuses %s rather than adopting it", async (_label, mutate) => {
  const context = await stateParent();
  await mutate(context);

  await expect(adoptRenamedStateRoot({ env: context.env, inspectActivity: quiet })).rejects.toMatchObject({ code: "UNSAFE_STATE_ROOT" });
});

it("treats a rename lost to a concurrent start as nothing left to adopt", async () => {
  const { env, previousRoot, root } = await stateParent();
  await seedRoot(previousRoot, ["alpha"]);
  const fsOps = {
    ...fs,
    rename: async () => {
      await rm(previousRoot, { recursive: true, force: true });
      await seedRoot(root, ["alpha"]);
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
  };

  expect(await adoptRenamedStateRoot({ env, fsOps, inspectActivity: quiet })).toEqual({ status: "NOTHING_TO_ADOPT", root });
  expect(await readdir(join(root, "sessions"))).toEqual(["alpha.json"]);
});

it("keeps the previous root readable when a concurrent start published a competing new root", async () => {
  const { env, previousRoot, root } = await stateParent();
  await seedRoot(previousRoot, ["alpha"]);
  const fsOps = {
    ...fs,
    rename: async () => {
      await seedRoot(root, ["epsilon"]);
      throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" });
    },
  };

  await expect(adoptRenamedStateRoot({ env, fsOps, inspectActivity: quiet })).rejects.toMatchObject({ code: "STATE_ROOTS_SPLIT" });
  expect(JSON.parse(await readFile(join(previousRoot, "sessions", "alpha.json"), "utf8"))).toEqual({ sessionId: "alpha" });
});
