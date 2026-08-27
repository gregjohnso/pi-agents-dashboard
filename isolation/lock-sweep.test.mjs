import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { sweepStaleWorktreeLocks } from "./lock-sweep.mjs";

/** @type {string[]} */
const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function worktreesRoot() {
  const root = await mkdtemp(join(tmpdir(), "dashboard-lock-sweep-"));
  roots.push(root);
  return root;
}

/** @param {string} root @param {string} name @param {any} holder @param {number} ageMs */
async function lock(root, name, holder, ageMs) {
  const path = join(root, `${name}.pi-dashboard-ownership.lock`);
  await mkdir(path, { mode: 0o700 });
  const record = { token: name, owner: { operation: "worktree_ownership" }, ...(holder === undefined ? {} : { holder }) };
  await writeFile(join(path, name), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}

const startedAt = () => new Date(Date.now() - 60_000).toISOString();

it("reclaims identity-free locks written before this daemon started", async () => {
  const root = await worktreesRoot();
  await lock(root, "old-legacy", undefined, 5 * 60_000);
  await lock(root, "new-legacy", undefined, 0);

  const removed = await sweepStaleWorktreeLocks({ worktreesRoot: root, startedAt: startedAt() });

  expect(removed).toEqual([join(root, "old-legacy.pi-dashboard-ownership.lock")]);
  expect(await readdir(root)).toEqual(["new-legacy.pi-dashboard-ownership.lock"]);
});

it("reclaims a dead holder and never a live one", async () => {
  const root = await worktreesRoot();
  await lock(root, "dead", { pid: 4242, processGroupId: 4242, startIdentity: "9" }, 5 * 60_000);
  await lock(root, "live", { pid: process.pid, processGroupId: process.pid, startIdentity: "7" }, 5 * 60_000);
  const inspect = async (/** @type {number} */ pid) => {
    if (pid !== process.pid) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return { pid, processGroupId: pid, startIdentity: "7" };
  };

  const removed = await sweepStaleWorktreeLocks({ worktreesRoot: root, startedAt: startedAt(), inspect });

  expect(removed).toEqual([join(root, "dead.pi-dashboard-ownership.lock")]);
  expect(await readdir(root)).toEqual(["live.pi-dashboard-ownership.lock"]);
});

it("keeps anything it cannot read as a lock and tolerates a missing root", async () => {
  const root = await worktreesRoot();
  await mkdir(join(root, "0fa4e7e1"), { mode: 0o700 });
  const unreadable = join(root, "corrupt.pi-dashboard-ownership.lock");
  await mkdir(unreadable, { mode: 0o700 });
  await writeFile(join(unreadable, "entry"), "{not json}\n", { mode: 0o600 });
  const when = new Date(Date.now() - 5 * 60_000);
  await utimes(unreadable, when, when);

  expect(await sweepStaleWorktreeLocks({ worktreesRoot: root, startedAt: startedAt() })).toEqual([]);
  expect((await readdir(root)).sort()).toEqual(["0fa4e7e1", "corrupt.pi-dashboard-ownership.lock"]);
  await expect(sweepStaleWorktreeLocks({ worktreesRoot: join(root, "missing"), startedAt: startedAt() })).resolves.toEqual([]);
});
