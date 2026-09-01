import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  chmodPrivateSocket,
  ensurePrivateDirectory,
  initializeRuntimePermissions,
  setPrivateUmask,
} from "./permissions.mjs";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Every private file this package creates is opened by the module that owns it, so the permissions
// module hands out the umask, the directory guarantee, and the socket guarantee only.
it("exposes the umask, directory, and socket guarantees and no file opener", async () => {
  expect(Object.keys(await import("./permissions.mjs")).sort()).toEqual([
    "chmodPrivateSocket", "ensurePrivateDirectory", "initializeRuntimePermissions", "setPrivateUmask",
  ]);
});

it("exposes startup initialization that sets the process file-creation mask to user-only", () => {
  const setUmask = vi.fn(() => 0o022);
  expect(initializeRuntimePermissions(setUmask)).toEqual({ previousUmask: 0o022 });
  expect(setUmask).toHaveBeenCalledWith(0o077);

  setUmask.mockClear();
  expect(setPrivateUmask(setUmask)).toBe(0o022);
  expect(setUmask).toHaveBeenCalledWith(0o077);
});

it("creates a private directory with an exact mode under a restrictive umask", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-permissions-"));
  cleanup.push(parent);
  const directory = join(parent, "private");
  const previousUmask = process.umask(0o777);

  try {
    await ensurePrivateDirectory(directory);
  } finally {
    process.umask(previousUmask);
  }

  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
});

it.each([
  ["a public mode", { isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o40755 }, /mode 0700/i],
  ["another user's ownership", { isDirectory: () => true, isSymbolicLink: () => false, uid: 2000, mode: 0o40700 }, /owner/i],
])("rejects an existing directory with %s", async (_label, stats, message) => {
  const fsOps = {
    async lstat() { return stats; },
    async mkdir() { throw new Error("must not create over an existing path"); },
  };

  await expect(ensurePrivateDirectory("/runtime", fsOps, 1000)).rejects.toThrow(message);
});

it("chmods only a verified user-owned socket and revalidates it", async () => {
  const stats = [
    { isSocket: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o140666 },
    { isSocket: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o140600 },
  ];
  const fsOps = { lstat: vi.fn(async () => stats.shift()), chmod: vi.fn(async () => {}) };

  await chmodPrivateSocket("/runtime/control.sock", fsOps, 1000);

  expect(fsOps.chmod).toHaveBeenCalledWith("/runtime/control.sock", 0o600);
  expect(fsOps.lstat).toHaveBeenCalledTimes(2);
});

it("refuses to chmod a symlink or wrong-owner socket", async () => {
  const symlinkOps = {
    lstat: vi.fn(async () => ({ isSocket: () => false, isSymbolicLink: () => true, uid: 1000 })),
    chmod: vi.fn(),
  };
  await expect(chmodPrivateSocket("/runtime/control.sock", symlinkOps, 1000)).rejects.toThrow(
    /symbolic link/i,
  );
  expect(symlinkOps.chmod).not.toHaveBeenCalled();

  const ownerOps = {
    lstat: vi.fn(async () => ({ isSocket: () => true, isSymbolicLink: () => false, uid: 2000 })),
    chmod: vi.fn(),
  };
  await expect(chmodPrivateSocket("/runtime/control.sock", ownerOps, 1000)).rejects.toThrow(/owner/i);
  expect(ownerOps.chmod).not.toHaveBeenCalled();
});
