import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { inspectRuntimeActivity } from "./runtime-activity.mjs";

/**
 * The state root directory name this build uses, and the one it shipped under before the
 * pi-agents rename. `pi-agents-dashboard`, the scaffold name older still, is not adopted here: it
 * carries schema-version-1 configuration and migrates by copy through state-migration.mjs.
 */
export const STATE_ROOT_DIRECTORY = "pi-agents";
export const PREVIOUS_STATE_ROOT_DIRECTORY = "pi-dashboard";

/** @param {string} code @param {string} message */
function adoptionError(code, message) { return Object.assign(new Error(message), { code }); }

/** @param {number} count */
function sessions(count) { return `${count} session${count === 1 ? "" : "s"}`; }

/** Resolve one state root's metadata, refusing anything the daemon would later refuse. @param {string} root @param {any} fsOps */
async function inspectRoot(root, fsOps) {
  let metadata;
  try { metadata = await fsOps.lstat(root); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined; throw error; }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw adoptionError("UNSAFE_STATE_ROOT", `State root is not a directory: ${root}`);
  if (metadata.uid !== process.getuid?.()) throw adoptionError("UNSAFE_STATE_ROOT", `State root belongs to another user: ${root}`);
  return metadata;
}

/** @param {string} root @param {any} fsOps */
async function countSessionRecords(root, fsOps) {
  try { return (await fsOps.readdir(join(root, "sessions"))).filter((/** @type {string} */ name) => name.endsWith(".json")).length; }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return 0; throw error; }
}

/** @param {string} directory @param {any} fsOps */
async function syncDirectory(directory, fsOps) {
  const handle = await fsOps.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** @param {string} root @param {string} previousRoot @param {any} fsOps */
async function splitRootsError(root, previousRoot, fsOps) {
  const [held, previouslyHeld] = await Promise.all([countSessionRecords(root, fsOps), countSessionRecords(previousRoot, fsOps)]);
  return adoptionError(
    "STATE_ROOTS_SPLIT",
    `State is split across two roots: ${previousRoot} (${sessions(previouslyHeld)}) and ${root} (${sessions(held)}). ` +
    `Stop the daemon in each root, move the sessions you keep into ${root}, and remove the other root. pi-agents will not merge them for you.`,
  );
}

/**
 * Adopt the state root this product shipped under before the pi-agents rename.
 *
 * The adoption is one `rename` of the directory itself, so the operator's sessions, command
 * journal, and worker leases move together or not at all; there is no half-migrated state to
 * recover. Every path a stopped worker recorded is either outside the state root (canonical
 * session files, managed worktrees) or recomputed from the root at start, so a lease written under
 * the previous root still validates afterwards. The single exception is `daemon/pid.json`, whose
 * `tokenPath` still names the previous root; a start reads the publication's PID first, finds the
 * dead daemon, and clears it.
 *
 * The rename is deferred while the previous root holds a live daemon or supervisor, because both
 * hold their root as a string in argv: renaming underneath them would break every later write and
 * orphan the Pi children. Until then this returns the previous root, so the run uses exactly one
 * root and the operator sees every session.
 *
 * @param {{ env?: NodeJS.ProcessEnv | Record<string, string | undefined>, fsOps?: any, inspectActivity?: (options: { stateRoot: string, runtimeRoot: string }) => Promise<{ activeDaemon: unknown, activeSupervisors: unknown[], unverifiable?: boolean }> }} [options]
 * @returns {Promise<{ status: string, root: string, message?: string }>}
 */
export async function adoptRenamedStateRoot({ env = process.env, fsOps = fs, inspectActivity = inspectRuntimeActivity } = {}) {
  if (env.PI_AGENTS_STATE_DIR !== undefined) return { status: "EXPLICIT_ROOT", root: resolve(env.PI_AGENTS_STATE_DIR) };
  const stateParent = env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state");
  const root = resolve(stateParent, STATE_ROOT_DIRECTORY);
  const previousRoot = resolve(stateParent, PREVIOUS_STATE_ROOT_DIRECTORY);

  if (await inspectRoot(previousRoot, fsOps) === undefined) return { status: "NOTHING_TO_ADOPT", root };
  if (await inspectRoot(root, fsOps) !== undefined) {
    if (await countSessionRecords(previousRoot, fsOps) > 0) throw await splitRootsError(root, previousRoot, fsOps);
    return { status: "PREVIOUS_ROOT_EMPTY", root, message: `Ignoring ${previousRoot}: it holds no sessions and ${root} is already in use.` };
  }

  const activity = await inspectActivity({ stateRoot: previousRoot, runtimeRoot: previousRoot });
  if (activity.activeDaemon !== false || activity.activeSupervisors.length > 0 || activity.unverifiable) {
    return {
      status: "DEFERRED_RUNTIME_ACTIVE",
      root: previousRoot,
      message: `Using ${previousRoot}: a live daemon or worker still holds it, so it cannot be renamed to ${root} yet. Restart pi-agents once they have stopped.`,
    };
  }

  try {
    await fsOps.rename(previousRoot, root);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) throw error;
    // Another pi-agents start raced this one. It either finished the same adoption or published a
    // competing root; only the second case can still lose sessions, and it must not be papered over.
    if (await inspectRoot(previousRoot, fsOps) !== undefined) throw await splitRootsError(root, previousRoot, fsOps);
    return { status: "NOTHING_TO_ADOPT", root };
  }
  await syncDirectory(stateParent, fsOps);
  return { status: "ADOPTED", root, message: `Adopted ${previousRoot} as ${root}: the directory was renamed in place, keeping every session.` };
}
