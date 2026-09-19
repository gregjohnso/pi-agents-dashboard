/**
 * Where one demo owner keeps its socket, its token and its disposable state.
 *
 * Everything is under one short directory, because a unix socket path is bounded by the kernel and a long
 * temporary path fails to bind rather than truncating. The directory is `0700` and the token and the owner
 * record are `0600`: the socket is the only way in, and the token is read from a file rather than passed on
 * a command line where `ps` would publish it.
 *
 * The state under `home/`, `agent/`, `sessions/` and `project/` is disposable by construction, and nothing here
 * reads the operator's real `~/.pi`. The root is created exclusively: an existing path of any kind, directory or
 * symlink, is refused before anything is chmodded, written or deleted.
 *
 * **This demo removes no root, and no tree, ever.** `stop` reaps the owner and keeps the directory for
 * inspection. That is a deliberate narrowing: a recursive delete keyed on an operator-supplied path is only as
 * safe as that path still naming the directory this process created, and a marker file inside a directory is
 * evidence, not identity — anyone can copy one. What the demo does instead is bind every write and every unlink
 * it makes to the directory it opened at creation, through `openRootAnchor`, so a renamed or replaced path is
 * never the thing it touches. Remove a retained root yourself when you have read it.
 */

import { chmod, lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
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
    /**
     * The owner management bridge: the in-Pi extension connects out to this one.
     *
     * One character for the same reason the two above are: an `AF_UNIX` path is capped at 108 bytes and the
     * operator chooses the root. It is a sibling of the control socket inside the same `0700` directory, so
     * the bridge is reachable by this user and nobody else.
     */
    sidebandSocket: path.join(root, "g"),
    token: path.join(root, "token"),
    /** Written once, at creation, as provenance for whoever reads a retained root. It authorises nothing. */
    ownership: path.join(root, "ownership.json"),
    ownerRecord: path.join(root, "owner.json"),
    log: path.join(root, "manager.log"),
    /** What the in-Pi pre-TUI caller appends its own observations to. */
    ingressLog: path.join(root, "owner-preload.jsonl"),
    home: path.join(root, "home"),
    agent: path.join(root, "agent"),
    sessions: path.join(root, "sessions"),
    project: path.join(root, "project"),
  };
}

/**
 * Hold the created directory open, and hand back paths that resolve through that descriptor.
 *
 * `anchoredRoot` is `/proc/<this pid>/fd/<fd>`, so `path.join(anchoredRoot, "s")` names the `s` inside the
 * directory this process opened — the same inode after a rename, and never a directory that later took that
 * path's place. It is a literal pid on purpose: the Pi child is handed some of these paths, and `/proc/self`
 * inside that child would name the child's own descriptors instead.
 *
 * `dev`/`ino` are captured for reporting only. The descriptor is what binds the writes; comparing a path's
 * `lstat` to those numbers says what was true when it was read, which is why `namesCreatedDirectory` is an
 * observation for a log line and never a permission to mutate a path.
 *
 * @param {string} root
 */
export async function openRootAnchor(root) {
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  const created = await handle.stat();
  const anchoredRoot = `/proc/${process.pid}/fd/${handle.fd}`;
  return {
    fd: handle.fd,
    dev: created.dev,
    ino: created.ino,
    anchoredRoot,
    /** Does `root` still name the directory this anchor holds? Reported, never relied on to authorise a write. */
    async namesCreatedDirectory() {
      const seen = await lstat(root).catch(() => null);
      return seen !== null && seen.isDirectory() && seen.dev === created.dev && seen.ino === created.ino;
    },
    /** Released only after the last anchored path has been used: an unlink through a closed fd resolves nowhere. */
    close: () => handle.close(),
  };
}

/**
 * Create and own a fresh root, and hold it open. It refuses every path that already exists rather than adopting it.
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
  const anchor = await openRootAnchor(root);
  const anchored = demoPaths(anchor.anchoredRoot);
  // From here nothing addresses the root by the caller's path: the mode, the state directories, the token and
  // the provenance marker are all set through the descriptor this process just opened. A umask that stripped
  // owner bits from `mkdir` is corrected here, where the correction cannot land on another directory.
  await chmod(anchor.anchoredRoot, 0o700);
  for (const directory of [anchored.home, anchored.agent, anchored.sessions, anchored.project]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(anchored.token, `${token}\n`, { mode: 0o600 });
  await chmod(anchored.token, 0o600);
  const ownership = { ownerId: randomUUID(), createdByPid: process.pid, createdAtMs: Date.now() };
  await writeFile(anchored.ownership, `${JSON.stringify(ownership, null, 2)}\n`, { mode: 0o600 });
  await chmod(anchored.ownership, 0o600);
  return { paths, token, ownership, anchor };
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

/** @param {string} root the operator-facing root for a read, or an anchored root for this owner's own write */
export async function writeOwnerRecord(root, record) {
  const file = demoPaths(root).ownerRecord;
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}
