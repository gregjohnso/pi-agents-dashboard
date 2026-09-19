/**
 * Where one demo owner keeps its socket, its token and its disposable state.
 *
 * Everything is under one short directory, because a unix socket path is bounded by the kernel and a long
 * temporary path fails to bind rather than truncating. The directory is `0700` and the token and the owner
 * record are `0600`: the socket is the only way in, and the token is read from a file rather than passed on
 * a command line where `ps` would publish it.
 *
 * The state under `home/`, `agent/`, `sessions/` and `project/` is disposable by construction. Nothing here
 * reads the operator's real `~/.pi`, and `stop` removes the root this demo created — only that one. The root is
 * created exclusively: an existing path of any kind, directory or symlink, is refused before anything is
 * chmodded, written or deleted, and the ownership marker written at creation is what later authorises removal.
 */

import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";

/** A root this demo may not create, because something is already there. */
export class DemoRootExistsError extends Error {
  /** @param {string} root @param {{ cause?: unknown }} [options] */
  constructor(root, options) {
    super(
      `${root} already exists, and this demo neither adopts nor deletes a path it did not create. ` +
        "Stop the owner that owns it, or pass another --root.",
      options,
    );
    this.name = "DemoRootExistsError";
    this.code = "DEMO_ROOT_EXISTS";
  }
}

/** The default root. Short on purpose: `<root>/s` has to fit in a `sockaddr_un`. */
export function defaultRoot() {
  return `/tmp/pi-nsd-${process.getuid?.() ?? 0}`;
}

/** @param {string} root */
export function demoPaths(root) {
  return {
    root,
    /** The owner manager's control socket: clients, the in-Pi ingress caller and `detach`/`stop`/`status`. */
    controlSocket: path.join(root, "s"),
    /** Seam E's core bootstrap sideband, which Pi connects out to from `main()`. */
    bootstrapSocket: path.join(root, "b"),
    token: path.join(root, "token"),
    /** Written once, at creation: the one fact that says this demo created this exact root. */
    ownership: path.join(root, "ownership.json"),
    ownerRecord: path.join(root, "owner.json"),
    log: path.join(root, "manager.log"),
    home: path.join(root, "home"),
    agent: path.join(root, "agent"),
    sessions: path.join(root, "sessions"),
    project: path.join(root, "project"),
  };
}

/**
 * Create and own a fresh root. It refuses every path that already exists rather than adopting it.
 *
 * @param {string} root
 */
export async function createRoot(root) {
  const paths = demoPaths(root);
  // The parent may be shared (`/tmp`); the root itself must not exist, so it is created without `recursive`.
  await mkdir(path.dirname(root), { recursive: true });
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code === "EEXIST") throw new DemoRootExistsError(root, { cause });
    throw cause;
  }
  await chmod(root, 0o700);
  for (const directory of [paths.home, paths.agent, paths.sessions, paths.project]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(paths.token, `${token}\n`, { mode: 0o600 });
  await chmod(paths.token, 0o600);
  const ownership = { ownerId: randomUUID(), createdByPid: process.pid, createdAtMs: Date.now() };
  await writeFile(paths.ownership, `${JSON.stringify(ownership, null, 2)}\n`, { mode: 0o600 });
  await chmod(paths.ownership, 0o600);
  return { paths, token, ownership };
}

/**
 * Remove a root only while it is still the one this process created.
 *
 * A root that was replaced, or that is no longer a directory, is preserved and named instead of deleted: this
 * function is the only place the demo removes a tree recursively, and it never follows a symlink to do it.
 *
 * @param {string} root @param {{ ownerId: string }} ownership
 */
export async function removeOwnedRoot(root, ownership) {
  const entry = await lstat(root).catch(() => null);
  if (entry === null) return { removed: false, reason: `${root} no longer exists` };
  if (!entry.isDirectory()) return { removed: false, reason: `${root} is no longer a directory this demo created` };
  const recorded = await readFile(demoPaths(root).ownership, "utf8").then(
    (text) => /** @type {{ ownerId?: string }} */ (JSON.parse(text)),
    () => null,
  );
  if (recorded === null) return { removed: false, reason: `${root} carries no ownership record of this demo's making` };
  if (recorded.ownerId !== ownership.ownerId) {
    return { removed: false, reason: `${root} is owned by ${recorded.ownerId}, not by this owner` };
  }
  await rm(root, { recursive: true, force: true });
  return { removed: true, reason: `${root} was created by this owner and was removed with it` };
}

/** @param {string} root */
export async function readToken(root) {
  return (await readFile(demoPaths(root).token, "utf8")).trim();
}

/** Constant-time comparison, so a wrong token leaks no prefix length. @param {unknown} a @param {string} b */
export function tokenMatches(a, b) {
  if (typeof a !== "string") return false;
  const supplied = Buffer.from(a, "utf8");
  const expected = Buffer.from(b, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

/** @param {string} root */
export async function readOwnerRecord(root) {
  return JSON.parse(await readFile(demoPaths(root).ownerRecord, "utf8"));
}

/** @param {string} root @param {Record<string, unknown>} record */
export async function writeOwnerRecord(root, record) {
  const file = demoPaths(root).ownerRecord;
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}
