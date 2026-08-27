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

it.each([
  [
    "XDG_STATE_HOME for daemon endpoints, ignoring unsupported runtime overrides",
    { HOME: "/home/user", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run/user/1", PI_DASHBOARD_RUNTIME_DIR: "/unsupported" },
    { legacyStateRoot: "/state/pi-agents-dashboard", destinationStateRoot: "/state/pi-dashboard", legacyRuntimeRoot: "/state/pi-agents-dashboard", destinationRuntimeRoot: "/state/pi-dashboard" },
  ],
  [
    "an explicit destination override kept separate from the legacy root",
    { HOME: "/home/user", PI_DASHBOARD_STATE_DIR: "/custom/new" },
    { legacyStateRoot: "/home/user/.local/state/pi-agents-dashboard", destinationStateRoot: "/custom/new", legacyRuntimeRoot: "/home/user/.local/state/pi-agents-dashboard", destinationRuntimeRoot: "/custom/new" },
  ],
])("uses %s", (_label, env, expected) => {
  expect(resolveDashboardRoots(env)).toEqual(expected);
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

it.each([
  ["a symlinked runtime root", async (/** @type {string} */ parent) => {
    const target = join(parent, "target");
    const root = join(parent, "runtime");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, root);
    return root;
  }, /symbolic link/i],
  ["a non-canonical root path", async (/** @type {string} */ parent) => {
    await mkdir(join(parent, "runtime"), { mode: 0o700 });
    return `${parent}/./runtime/../runtime`;
  }, /canonical/i],
  ["a Unix-socket path that cannot fit sockaddr_un", async (/** @type {string} */ parent) => {
    const root = join(parent, "x".repeat(100));
    await mkdir(root, { mode: 0o700 });
    return root;
  }, /socket path.*107 bytes/i],
])("refuses %s", async (_label, build, message) => {
  const parent = await mkdtemp(join(tmpdir(), "dashboard-paths-"));
  cleanup.push(parent);

  await expect(canonicalRuntimePaths(await build(parent))).rejects.toThrow(message);
});
