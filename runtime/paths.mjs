import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Buffer } from "node:buffer";

export const LINUX_SOCKET_PATH_MAX_BYTES = 107;

/** Derive legacy and standalone roots from the same per-user XDG parents. @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function resolveDashboardRoots(env = process.env) {
  const home = env.HOME ?? homedir();
  const stateParent = env.XDG_STATE_HOME ?? join(home, ".local", "state");
  const legacyStateRoot = resolve(stateParent, "pi-agents-dashboard");
  const destinationStateRoot = resolve(env.PI_DASHBOARD_STATE_DIR ?? join(stateParent, "pi-dashboard"));
  return {
    legacyStateRoot,
    destinationStateRoot,
    legacyRuntimeRoot: legacyStateRoot,
    destinationRuntimeRoot: destinationStateRoot,
  };
}

/**
 * Resolve the fixed artifact names beneath an existing, non-symlink runtime root.
 *
 * @param {string} root
 * @param {{ lstat: typeof lstat, realpath: typeof realpath }} [fsOps]
 */
export async function canonicalRuntimePaths(root, fsOps = { lstat, realpath }) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new TypeError("Runtime root must be an absolute path");
  }
  if (resolve(root) !== root) {
    throw new Error("Runtime root path must be canonical");
  }

  const metadata = await fsOps.lstat(root);
  if (metadata.isSymbolicLink()) {
    throw new Error("Runtime root must not be a symbolic link");
  }
  if (!metadata.isDirectory()) {
    throw new Error("Runtime root must be a directory");
  }
  if ((await fsOps.realpath(root)) !== root) {
    throw new Error("Runtime root path must be canonical and contain no symbolic-link aliases");
  }

  const daemon = join(root, "daemon");
  const paths = {
    root,
    daemon,
    daemonIdentity: join(daemon, "pid.json"),
    controlSocket: join(daemon, "control.sock"),
    lifecycleLock: join(daemon, "lifecycle.lock"),
    sessions: join(root, "sessions"),
    queue: join(root, "queue"),
    runs: join(root, "runs"),
    index: join(root, "index"),
  };
  if (Buffer.byteLength(paths.controlSocket) > LINUX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `Control socket path exceeds the Linux 107 bytes limit: ${paths.controlSocket}`,
    );
  }
  return paths;
}
