import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { acquireLifecycleLock } from "./lifecycle-lock.mjs";

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

it("acquires an exclusive token-bearing mode-0600 lock and releases its own token", async () => {
  const path = await makeLockPath();
  const owner = { pid: 42, startTimeTicks: "9001", operation: "start" };

  const lock = await acquireLifecycleLock(path, owner);
  const record = JSON.parse(await readFile(path, "utf8"));

  expect(record).toEqual({ token: lock.token, owner });
  expect(lock.token).toMatch(/^[0-9a-f-]{36}$/);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await expect(acquireLifecycleLock(path, owner)).rejects.toMatchObject({ code: "LOCK_HELD" });

  await expect(lock.release()).resolves.toBe(true);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lock.release()).resolves.toBe(false);
});

it("creates an exact mode-0600 lock under a restrictive inherited umask", async () => {
  const path = await makeLockPath();
  const previousUmask = process.umask(0o777);
  try {
    await acquireLifecycleLock(path, { pid: 42 });
  } finally {
    process.umask(previousUmask);
  }

  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("does not remove a lock replaced by another token", async () => {
  const path = await makeLockPath();
  const lock = await acquireLifecycleLock(path, { pid: 42 });
  const replacement = { token: "replacement", owner: { pid: 99 } };
  await writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

  await expect(lock.release()).resolves.toBe(false);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
});

it("does not delete a replacement substituted at the release claim boundary", async () => {
  const path = await makeLockPath();
  const replacement = { token: "replacement-at-release", owner: { pid: 99 } };
  let substituted = false;
  const fsOps = {
    ...fs,
    /** @param {string} from @param {string} to */
    async rename(from, to) {
      if (from === path && !substituted) {
        substituted = true;
        await fs.rm(path, { force: true });
        await fs.writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      }
      await fs.rename(from, to);
    },
  };
  const lock = await acquireLifecycleLock(path, { pid: 42 }, fsOps);

  await expect(lock.release()).resolves.toBe(false);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
});

it("does not follow a hostile symlink at the lock path", async () => {
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

it("does not delete a replacement substituted during failed-acquisition cleanup", async () => {
  const path = await makeLockPath();
  const replacement = { token: "replacement-at-cleanup", owner: { pid: 99 } };
  const fsOps = {
    ...fs,
    /** @param {string} lockPath @param {any} flags @param {any} mode */
    async open(lockPath, flags, mode) {
      const handle = await fs.open(lockPath, flags, mode);
      return {
        writeFile: () => handle.writeFile('{"token":'),
        /** @param {number} newMode */
        chmod: (newMode) => handle.chmod(newMode),
        stat: () => handle.stat(),
        async sync() {
          throw new Error("sync failed");
        },
        close: () => handle.close(),
      };
    },
    /** @param {string} cleanupPath @param {{ force: boolean }} options */
    async rm(cleanupPath, options) {
      await fs.writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      await fs.rm(cleanupPath, options);
    },
  };

  await expect(acquireLifecycleLock(path, { pid: 42 }, fsOps)).rejects.toThrow("sync failed");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
});
