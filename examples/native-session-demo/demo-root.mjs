/**
 * Where one demo owner keeps its socket, its token and its disposable state.
 *
 * Everything is under one short directory, because a unix socket path is bounded by the kernel and a long
 * temporary path fails to bind rather than truncating. The directory is `0700` and the token and the owner
 * record are `0600`: the socket is the only way in, and the token is read from a file rather than passed on
 * a command line where `ps` would publish it.
 *
 * The state under `home/`, `agent/`, `sessions/` and `project/` is disposable by construction. Nothing here
 * reads the operator's real `~/.pi`, and `stop` removes the whole root.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

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
    ownerRecord: path.join(root, "owner.json"),
    log: path.join(root, "manager.log"),
    home: path.join(root, "home"),
    agent: path.join(root, "agent"),
    sessions: path.join(root, "sessions"),
    project: path.join(root, "project"),
  };
}

/** @param {string} root */
export async function createRoot(root) {
  const paths = demoPaths(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  for (const directory of [paths.home, paths.agent, paths.sessions, paths.project]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(paths.token, `${token}\n`, { mode: 0o600 });
  await chmod(paths.token, 0o600);
  return { paths, token };
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
