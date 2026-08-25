import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { canonicalRuntimePaths } from "./paths.mjs";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("returns canonical paths beneath a real private runtime root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-paths-"));
  cleanup.push(parent);
  const root = join(parent, "runtime");
  await mkdir(root, { mode: 0o700 });

  await expect(canonicalRuntimePaths(root)).resolves.toEqual({
    root,
    daemon: join(root, "daemon"),
    daemonIdentity: join(root, "daemon", "pid.json"),
    controlSocket: join(root, "daemon", "control.sock"),
    lifecycleLock: join(root, "daemon", "lifecycle.lock"),
    sessions: join(root, "sessions"),
    queue: join(root, "queue"),
    runs: join(root, "runs"),
    index: join(root, "index"),
  });
});

it("rejects a symlinked runtime root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-paths-symlink-"));
  cleanup.push(parent);
  const target = join(parent, "target");
  const root = join(parent, "runtime");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, root);

  await expect(canonicalRuntimePaths(root)).rejects.toThrow(/symbolic link/i);
});

it("rejects a non-canonical root path", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-paths-alias-"));
  cleanup.push(parent);
  const root = join(parent, "runtime");
  await mkdir(root, { mode: 0o700 });

  await expect(canonicalRuntimePaths(`${parent}/./runtime/../runtime`)).rejects.toThrow(/canonical/i);
});

it("refuses a Linux Unix-socket path that cannot fit sockaddr_un", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-paths-long-"));
  cleanup.push(parent);
  const root = join(parent, "x".repeat(100));
  await mkdir(root, { mode: 0o700 });

  await expect(canonicalRuntimePaths(root)).rejects.toThrow(/socket path.*107 bytes/i);
});
