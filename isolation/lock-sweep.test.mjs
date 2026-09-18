import { lstat, mkdir, mkdtemp, readdir, readFile, rm, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
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

/** @param {string} root @param {string} name @param {any} holder @param {number} ageMs @param {string} [suffix] */
async function lock(root, name, holder, ageMs, suffix = ".pi-agents-ownership.lock") {
  const path = join(root, `${name}${suffix}`);
  await mkdir(path, { mode: 0o700 });
  const record = { token: name, owner: { operation: "worktree_ownership" }, ...(holder === undefined ? {} : { holder }) };
  await writeFile(join(path, name), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}

/** Delegating filesystem operations that record every mutating and reading call. */
function tracingFsOps() {
  /** @type {string[]} */
  const calls = [];
  /** @param {string} name @param {(...args: any[]) => Promise<any>} operation */
  const trace =
    (name, operation) =>
    /** @param {any[]} args */
    async (...args) => {
      calls.push(`${name} ${args[0]}`);
      return operation(...args);
    };
  return {
    calls,
    ops: {
      readdir: trace("readdir", readdir),
      lstat: trace("lstat", lstat),
      readFile: trace("readFile", readFile),
      unlink: trace("unlink", unlink),
      rmdir: trace("rmdir", rmdir),
      rm: trace("rm", rm),
    },
  };
}

const startedAt = () => new Date(Date.now() - 60_000).toISOString();
const absent = async () => {
  throw Object.assign(new Error("gone"), { code: "ESRCH" });
};

it("retains locks whose holder identity is incomplete", async () => {
  const root = await worktreesRoot();
  await lock(root, "legacy", undefined, 5 * 60_000);
  await lock(root, "null-holder", null, 5 * 60_000);
  await lock(root, "pid-only", { pid: 4242, processGroupId: 4242 }, 5 * 60_000);

  const removed = await sweepStaleWorktreeLocks({ worktreesRoot: root, startedAt: startedAt(), inspect: absent });

  expect(removed).toEqual([]);
  expect((await readdir(root)).sort()).toEqual([
    "legacy.pi-agents-ownership.lock",
    "null-holder.pi-agents-ownership.lock",
    "pid-only.pi-agents-ownership.lock",
  ]);
});

it("reclaims a dead holder and never a live one", async () => {
  const root = await worktreesRoot();
  await lock(root, "dead", { pid: 4242, processGroupId: 4242, startIdentity: "9" }, 5 * 60_000);
  await lock(root, "live", { pid: process.pid, processGroupId: process.pid, startIdentity: "7" }, 5 * 60_000);
  await lock(root, "fresh", { pid: 4242, processGroupId: 4242, startIdentity: "9" }, 0);
  const inspect = async (/** @type {number} */ pid) => {
    if (pid !== process.pid) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return { pid, processGroupId: pid, startIdentity: "7" };
  };

  const removed = await sweepStaleWorktreeLocks({ worktreesRoot: root, startedAt: startedAt(), inspect });

  expect(removed).toEqual([join(root, "dead.pi-agents-ownership.lock")]);
  expect((await readdir(root)).sort()).toEqual(["fresh.pi-agents-ownership.lock", "live.pi-agents-ownership.lock"]);
});

it.each([".pi-agents-dashboard-ownership.lock"])("reclaims a dead holder's %s lock written under a previous product name", async (suffix) => {
  const root = await worktreesRoot();
  await lock(root, "dead", { pid: 4242, processGroupId: 4242, startIdentity: "9" }, 5 * 60_000, suffix);

  const removed = await sweepStaleWorktreeLocks({ worktreesRoot: root, startedAt: startedAt(), inspect: absent });

  expect(removed).toEqual([join(root, `dead${suffix}`)]);
  expect(await readdir(root)).toEqual([]);
});

it("reclaims a holder whose PID was recycled by another process", async () => {
  const root = await worktreesRoot();
  const path = await lock(root, "recycled", { pid: 4242, processGroupId: 4242, startIdentity: "9" }, 5 * 60_000);
  const inspect = async (/** @type {number} */ pid) => ({ pid, processGroupId: pid, startIdentity: "51" });

  const removed = await sweepStaleWorktreeLocks({ worktreesRoot: root, startedAt: startedAt(), inspect });

  expect(removed).toEqual([path]);
  expect(await readdir(root)).toEqual([]);
});

it("retains a lock whose holder process state is unreadable", async () => {
  const root = await worktreesRoot();
  await lock(root, "ambiguous", { pid: 4242, processGroupId: 4242, startIdentity: "9" }, 5 * 60_000);
  const inspect = async () => {
    throw Object.assign(new Error("Linux proc stat is missing identity fields"), { code: "AMBIGUOUS_IDENTITY" });
  };

  const removed = await sweepStaleWorktreeLocks({ worktreesRoot: root, startedAt: startedAt(), inspect });

  expect(removed).toEqual([]);
  expect(await readdir(root)).toEqual(["ambiguous.pi-agents-ownership.lock"]);
});

it("retains a lock whose record changed between inspection and removal", async () => {
  const root = await worktreesRoot();
  const path = await lock(root, "rewritten", { pid: 4242, processGroupId: 4242, startIdentity: "9" }, 5 * 60_000);
  const successor = `${JSON.stringify({ token: "rewritten", owner: { operation: "worktree_ownership" }, holder: { pid: process.pid, processGroupId: process.pid, startIdentity: "7" } })}\n`;
  const inspect = async () => {
    await writeFile(join(path, "rewritten"), successor, { mode: 0o600 });
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  };

  const removed = await sweepStaleWorktreeLocks({ worktreesRoot: root, startedAt: startedAt(), inspect });

  expect(removed).toEqual([]);
  expect(await readFile(join(path, "rewritten"), "utf8")).toBe(successor);
});

it("unlinks exactly the verified token entry and never removes recursively", async () => {
  const root = await worktreesRoot();
  const path = await lock(root, "dead", { pid: 4242, processGroupId: 4242, startIdentity: "9" }, 5 * 60_000);
  const { calls, ops } = tracingFsOps();

  const removed = await sweepStaleWorktreeLocks({ worktreesRoot: root, startedAt: startedAt(), inspect: absent, fsOps: ops });

  expect(removed).toEqual([path]);
  expect(calls.filter((call) => call.startsWith("unlink "))).toEqual([`unlink ${join(path, "dead")}`]);
  expect(calls.filter((call) => call.startsWith("rmdir "))).toEqual([`rmdir ${path}`]);
  expect(calls.filter((call) => call.startsWith("rm "))).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});
