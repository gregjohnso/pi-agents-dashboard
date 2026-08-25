import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { canonicalRuntimePaths, resolveDashboardRoots } from "./paths.mjs";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("uses the actual state root for daemon endpoints and ignores unsupported runtime overrides", () => {
  expect(resolveDashboardRoots({ HOME: "/home/user", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run/user/1", PI_DASHBOARD_RUNTIME_DIR: "/unsupported" })).toEqual({
    legacyStateRoot: "/state/pi-agents-dashboard",
    destinationStateRoot: "/state/pi-dashboard",
    legacyRuntimeRoot: "/state/pi-agents-dashboard",
    destinationRuntimeRoot: "/state/pi-dashboard",
  });
});

it("keeps explicit destination state overrides separate from the legacy root", () => {
  expect(resolveDashboardRoots({ HOME: "/home/user", PI_DASHBOARD_STATE_DIR: "/custom/new" })).toMatchObject({
    legacyStateRoot: "/home/user/.local/state/pi-agents-dashboard",
    destinationStateRoot: "/custom/new",
  });
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
