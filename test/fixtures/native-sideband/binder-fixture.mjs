/**
 * Deterministic stand-in helpers for the binder's failure matrix.
 *
 * Every lifecycle branch the decision requires is a *real* forked process over a *real* IPC channel: the
 * parent's observers, its handle disposal and its exit accounting are exactly what is under test, and a fake
 * child would test none of them. What these files replace is only the helper's *behaviour*, so a branch that a
 * correct helper never takes — a wrong protocol version, two handoffs, a handle that is not a server, a silent
 * process, an abrupt death — can be driven without a sleep and without patching production code.
 *
 * Each script is selected by its own name and takes the socket path from `SOCKET_PATH`.
 * `SIDEBAND_FIXTURE_MODE` is not used: the mode is the file, so a test names the branch it is exercising.
 */

import { lstatSync } from "node:fs";
import net from "node:net";

/** The protocol the real helper speaks. Kept here literally, so a bump has to be made deliberately in tests. */
export const FIXTURE_PROTOCOL = 2;

/**
 * The endpoint to bind, read exactly the way the real helper reads it.
 *
 * The request is a protocol version and then a path, so the path is the second argument, not the first. Read
 * once here rather than in thirteen scripts, and checked, because taking the version for the path binds a
 * relative name in whatever directory the test runner happens to be in and every case then fails as an
 * incomplete helper for a reason that has nothing to do with what it was testing.
 */
export const SOCKET_PATH = (() => {
  const [version, socketPath] = process.argv.slice(2);
  if (version !== String(FIXTURE_PROTOCOL)) throw new Error(`fixture expected protocol ${FIXTURE_PROTOCOL} as the first argument, got ${version}`);
  if (socketPath === undefined || !socketPath.startsWith("/")) throw new Error(`fixture expected an absolute socket path as the second argument, got ${socketPath}`);
  return socketPath;
})();

/** @param {string} socketPath */
export function proofFor(socketPath) {
  const entry = lstatSync(socketPath, { bigint: true });
  return { device: String(entry.dev), inode: String(entry.ino), mode: Number(entry.mode & 0o777n), uid: Number(entry.uid) };
}

/** Bind exactly as the real helper does, and hand the caller the server plus its proof. @param {string} socketPath */
export function bindPrivately(socketPath) {
  process.umask(0o177);
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve({ server, proof: proofFor(socketPath) }));
  });
}

/** @param {unknown} message @param {unknown} handle */
export function send(message, handle) {
  return new Promise((resolve) => {
    /** @type {any} */ (process.send)(message, handle, undefined, (/** @type {Error|null} */ error) => resolve(error ?? null));
  });
}
