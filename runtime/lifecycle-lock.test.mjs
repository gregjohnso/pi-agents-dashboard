import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { acquireLifecycleLock } from "./lifecycle-lock.mjs";

/** @param {string} path */
async function readSoleRecord(path) {
  const [entry] = await fs.readdir(path);
  return JSON.parse(await readFile(join(path, entry), "utf8"));
}

/** @param {string} path @param {unknown} record */
async function writeSoleRecord(path, record) {
  await fs.mkdir(path, { mode: 0o700 });
  const token = "stale-token";
  await writeFile(join(path, token), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

const deadHolder = { pid: 4242, processGroupId: 4242, startIdentity: "9001" };
const inspectDead = async () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeLockPath() {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-lock-"));
  cleanup.push(directory);
  return join(directory, "lifecycle.lock");
}

/** @param {string} path @param {string} token */
async function readTokenEntry(path, token) {
  return JSON.parse(await readFile(join(path, token), "utf8"));
}

it("records the holder process identity in its own lock entry", async () => {
  const path = await makeLockPath();

  const lock = await acquireLifecycleLock(path, { operation: "worktree_ownership" });

  expect(await readTokenEntry(path, lock.token)).toMatchObject({
    token: lock.token,
    owner: { operation: "worktree_ownership" },
    holder: { pid: process.pid, processGroupId: expect.any(Number), startIdentity: expect.any(String) },
  });
});

it("reclaims a lock whose holder process is gone", async () => {
  const path = await makeLockPath();
  await writeSoleRecord(path, { token: "stale-token", owner: { operation: "worktree_ownership" }, holder: deadHolder });

  const lock = await acquireLifecycleLock(path, { operation: "worktree_ownership" }, fs, { inspect: inspectDead });

  expect(await readSoleRecord(path)).toMatchObject({ token: lock.token, holder: { pid: process.pid } });
  expect((await stat(path)).mode & 0o777).toBe(0o700);
  expect((await stat(join(path, lock.token))).mode & 0o777).toBe(0o600);
});

it("reclaims a lock whose holder pid was reused by a different process", async () => {
  const path = await makeLockPath();
  await writeSoleRecord(path, { token: "stale-token", owner: { operation: "worktree_ownership" }, holder: deadHolder });
  const inspectReused = async (/** @type {number} */ pid) => ({ pid, processGroupId: 4242, startIdentity: "7777" });

  const lock = await acquireLifecycleLock(path, { operation: "worktree_ownership" }, fs, { inspect: inspectReused });

  expect(await readSoleRecord(path)).toMatchObject({ token: lock.token });
});

it("refuses a lock whose holder process is still alive", async () => {
  const path = await makeLockPath();
  await writeSoleRecord(path, { token: "stale-token", owner: { operation: "worktree_ownership" }, holder: deadHolder });
  const inspectAlive = async (/** @type {number} */ pid) => ({ pid, processGroupId: 4242, startIdentity: "9001" });

  await expect(acquireLifecycleLock(path, { operation: "x" }, fs, { inspect: inspectAlive })).rejects.toMatchObject({ code: "LOCK_HELD" });
  expect(await readSoleRecord(path)).toMatchObject({ token: "stale-token" });
});

it.each([
  ["an unreadable record", "{ not json"],
  ["a record without holder identity", JSON.stringify({ token: "stale-token", owner: { operation: "worktree_ownership" } })],
  ["a record with an incomplete holder", JSON.stringify({ token: "stale-token", owner: {}, holder: { pid: 4242 } })],
  ["a token mismatch", JSON.stringify({ token: "other-token", owner: {}, holder: deadHolder })],
])("fails closed for %s", async (_label, contents) => {
  const path = await makeLockPath();
  await fs.mkdir(path, { mode: 0o700 });
  await writeFile(join(path, "stale-token"), `${contents}\n`, { mode: 0o600 });

  await expect(acquireLifecycleLock(path, { operation: "x" }, fs, { inspect: inspectDead })).rejects.toMatchObject({ code: "LOCK_HELD" });
  expect(await fs.readdir(path)).toEqual(["stale-token"]);
});

it("fails closed when holder liveness cannot be determined", async () => {
  const path = await makeLockPath();
  await writeSoleRecord(path, { token: "stale-token", owner: {}, holder: deadHolder });
  const inspectUnknown = async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };

  await expect(acquireLifecycleLock(path, { operation: "x" }, fs, { inspect: inspectUnknown })).rejects.toMatchObject({ code: "LOCK_HELD" });
  expect(await fs.readdir(path)).toEqual(["stale-token"]);
});

it("fails closed when several holders share the lock directory", async () => {
  const path = await makeLockPath();
  await writeSoleRecord(path, { token: "stale-token", owner: {}, holder: deadHolder });
  await writeFile(join(path, "second-token"), `${JSON.stringify({ token: "second-token", owner: {}, holder: deadHolder })}\n`, { mode: 0o600 });

  await expect(acquireLifecycleLock(path, { operation: "x" }, fs, { inspect: inspectDead })).rejects.toMatchObject({ code: "LOCK_HELD" });
  expect((await fs.readdir(path)).sort()).toEqual(["second-token", "stale-token"]);
});

it("keeps a live holder's lock when the record changes during reclamation", async () => {
  const path = await makeLockPath();
  await writeSoleRecord(path, { token: "stale-token", owner: {}, holder: deadHolder });
  const fsOps = {
    ...fs,
    /** @param {string} entryPath @param {BufferEncoding} encoding */
    async readFile(entryPath, encoding) {
      const contents = await fs.readFile(entryPath, encoding);
      if (entryPath === join(path, "stale-token")) {
        await fs.writeFile(entryPath, `${JSON.stringify({ token: "stale-token", owner: {}, holder: { ...deadHolder, pid: 5150 } })}\n`, { mode: 0o600 });
      }
      return contents;
    },
  };

  await expect(acquireLifecycleLock(path, { operation: "x" }, fsOps, { inspect: inspectDead })).rejects.toMatchObject({ code: "LOCK_HELD" });
  expect(await readSoleRecord(path)).toMatchObject({ holder: { pid: 5150 } });
});

it("reclaims an identity-free legacy lock only when the caller proves it is unowned", async () => {
  const path = await makeLockPath();
  const legacy = { token: "stale-token", owner: { operation: "worktree_ownership", worktreePath: "/tmp/example" } };
  await writeSoleRecord(path, legacy);

  await expect(acquireLifecycleLock(path, { operation: "x" }, fs, { inspect: inspectDead })).rejects.toMatchObject({ code: "LOCK_HELD" });

  const lock = await acquireLifecycleLock(path, { operation: "x" }, fs, { inspect: inspectDead, reclaimIdentityFreeLock: true });
  expect(await readSoleRecord(path)).toMatchObject({ token: lock.token, holder: { pid: process.pid } });
});

it("acquires an exclusive token-entry lock directory and releases its own token", async () => {
  const path = await makeLockPath();
  const owner = { pid: 42, startTimeTicks: "9001", operation: "start" };

  const lock = await acquireLifecycleLock(path, owner);

  expect(await readTokenEntry(path, lock.token)).toMatchObject({ token: lock.token, owner });
  expect(lock.token).toMatch(/^[0-9a-f-]{36}$/);
  expect((await stat(path)).mode & 0o777).toBe(0o700);
  expect((await stat(join(path, lock.token))).mode & 0o777).toBe(0o600);
  await expect(acquireLifecycleLock(path, owner)).rejects.toMatchObject({ code: "LOCK_HELD" });

  await expect(lock.release()).resolves.toBe(true);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lock.release()).resolves.toBe(false);
});

it("creates exact lock-directory and token-entry modes under a restrictive inherited umask", async () => {
  const path = await makeLockPath();
  const previousUmask = process.umask(0o777);
  let lock;
  try {
    lock = await acquireLifecycleLock(path, { pid: 42 });
  } finally {
    process.umask(previousUmask);
  }

  expect((await stat(path)).mode & 0o777).toBe(0o700);
  expect((await stat(join(path, lock.token))).mode & 0o777).toBe(0o600);
});

it("keeps B public while stale A releases and C attempts acquisition", async () => {
  const path = await makeLockPath();
  /** @type {Awaited<ReturnType<typeof acquireLifecycleLock>> | undefined} */
  let cLock;
  /** @type {unknown} */
  let cError;
  async function attemptC() {
    if (cLock !== undefined || cError !== undefined) {
      return;
    }
    try {
      cLock = await acquireLifecycleLock(path, { pid: 100, holder: "C" });
    } catch (error) {
      cError = error;
    }
  }
  const aFsOps = {
    ...fs,
    /** @param {string} from @param {string} to */
    async rename(from, to) {
      await fs.rename(from, to);
      if (from === path) {
        await attemptC();
      }
    },
    /** @param {string} entryPath */
    async unlink(entryPath) {
      await attemptC();
      await fs.unlink(entryPath);
    },
  };
  const aLock = await acquireLifecycleLock(path, { pid: 42, holder: "A" }, aFsOps);
  await rm(path, { recursive: true });
  const bLock = await acquireLifecycleLock(path, { pid: 99, holder: "B" });

  await expect(aLock.release()).resolves.toBe(false);
  expect(cLock).toBeUndefined();
  expect(cError).toMatchObject({ code: "LOCK_HELD" });
  expect(await readTokenEntry(path, bLock.token)).toMatchObject({
    token: bLock.token,
    owner: { pid: 99, holder: "B" },
  });
});

it("release removes only its token entry and keeps a non-empty shared directory", async () => {
  const path = await makeLockPath();
  const lock = await acquireLifecycleLock(path, { pid: 42 });
  const foreignToken = "foreign-token";
  const foreignEntry = join(path, foreignToken);
  await writeFile(foreignEntry, '{"owner":"foreign"}\n', { mode: 0o600 });

  await expect(lock.release()).resolves.toBe(true);

  await expect(stat(join(path, lock.token))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(foreignEntry, "utf8")).toBe('{"owner":"foreign"}\n');
  expect((await stat(path)).isDirectory()).toBe(true);
});

it("returns the holder when staging cleanup fails after publication", async () => {
  const path = await makeLockPath();
  let published = false;
  const fsOps = {
    ...fs,
    /** @param {string} from @param {string} to */
    async rename(from, to) {
      await fs.rename(from, to);
      if (to === path) {
        published = true;
      }
    },
    /** @param {string} from @param {string} to */
    async link(from, to) {
      await fs.link(from, to);
      if (to === path) {
        published = true;
      }
    },
    /** @param {string} cleanupPath @param {{ force: boolean, recursive?: boolean }} options */
    async rm(cleanupPath, options) {
      if (published && cleanupPath !== path) {
        throw new Error("post-publication cleanup failed");
      }
      await fs.rm(cleanupPath, options);
    },
  };

  const lock = await acquireLifecycleLock(path, { pid: 42 }, fsOps);

  expect(await readTokenEntry(path, lock.token)).toMatchObject({ token: lock.token, owner: { pid: 42 } });
  await expect(lock.release()).resolves.toBe(true);
});

it("does not follow or replace a hostile symlink at the lock path", async () => {
  const path = await makeLockPath();
  const target = join(tmpdir(), `dashboard-lock-target-${process.pid}-${Date.now()}`);
  cleanup.push(target);
  await writeFile(target, "sentinel");
  await symlink(target, path);

  await expect(acquireLifecycleLock(path, { pid: 42 })).rejects.toMatchObject({
    code: "LOCK_HELD",
  });
  expect(await readFile(target, "utf8")).toBe("sentinel");
});

it("failed acquisition cleans only its staging directory", async () => {
  const path = await makeLockPath();
  const replacement = await acquireLifecycleLock(path, { pid: 99 });
  /** @type {string[]} */
  const removed = [];
  const fsOps = {
    ...fs,
    /** @param {string} cleanupPath @param {{ force: boolean, recursive?: boolean }} options */
    async rm(cleanupPath, options) {
      removed.push(cleanupPath);
      await fs.rm(cleanupPath, options);
    },
  };

  await expect(acquireLifecycleLock(path, { pid: 42 }, fsOps)).rejects.toMatchObject({
    code: "LOCK_HELD",
  });

  expect(removed).not.toContain(path);
  expect(await readTokenEntry(path, replacement.token)).toMatchObject({
    token: replacement.token,
    owner: { pid: 99 },
  });
});
