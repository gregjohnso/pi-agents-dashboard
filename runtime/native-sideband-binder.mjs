/**
 * One short-lived process whose only job is to bind a private socket, prove what it bound, and hand it away.
 *
 * The reason this exists is narrow and mechanical. Closing a `net.Server` that bound a pathname unlinks that
 * pathname, and libuv does it before any userland code runs — so a listener that bound its own endpoint cannot
 * preserve a replacement another actor put there, no matter what it checks first. A handle that was *received*
 * over IPC carries no pathname, so closing it unlinks nothing. This file is the process that owns the bind,
 * and it is gone before the listener is usable.
 *
 * Two rules here are load-bearing and were both wrong in the first version of this file:
 *
 * **It proves which inode it bound, before the handle leaves.** The parent cannot establish that on its own:
 * by the time it looks, another process of the same user could have replaced the path with a different socket
 * that is also 0600 and also owned by this user, and every check the parent could make would pass. So the
 * identity is captured here, between `listen` and the send, and travels with the handle. The parent compares
 * the path against *this* proof rather than adopting whichever valid-looking socket it finds.
 *
 * **After a successful bind it never closes the server — not even when the handoff fails.** The earlier
 * version closed it on a send error, reasoning that a failed handoff meant the path was still its own. That
 * inference is false: a replacement can already be there, and the close would unlink it. A bind that
 * succeeded and a handoff that did not leaves the entry alone and lets the parent report the uncertainty.
 *
 * What it deliberately is not: a daemon, a supervisor, a second Pi owner, a canonical writer, or a general
 * process framework. It binds one path, sends one message, and exits.
 *
 * Its stdout is not a protocol. Everything the parent acts on arrives as one versioned IPC message; anything
 * written to a stream is diagnostics for a human reading a log.
 */

import { lstatSync } from "node:fs";
import net from "node:net";

/**
 * The parent/helper message version.
 *
 * Version 2 adds the ownership proof described above, which changes what a `sideband-bound` message must carry.
 * A v1 parent and a v2 helper cannot agree about that, so the version is also a *request* argument and a
 * mismatch is refused before anything is bound. The unpublished v1 shape is a historical candidate, not a
 * fallback: there is no code path that accepts it.
 */
export const SIDEBAND_BINDER_PROTOCOL = 2;

/** The three messages this helper can send, and nothing else. */
export const SIDEBAND_BINDER_MESSAGES = ["sideband-bound", "sideband-bind-failed", "sideband-binder-refused"];

/**
 * Only this process's umask changes, and only before the bind.
 *
 * The socket has to exist at 0600 from the moment it exists, because narrowing it afterwards means a `chmod`
 * on a pathname — and by then the entry at that pathname might be somebody else's. Creating it restrictively
 * here is the one way to avoid touching a foreign entry during permission work. The manager's own umask is
 * never involved: this is a separate process that exits immediately.
 *
 * The value is `0o177`, not `0o077`. A socket is created with `0o777 & ~umask`, so `0o077` leaves mode 0700 —
 * measured, and the parent's verification refused it. Masking the owner-execute bit as well is what produces
 * 0600, and the parent checks the result rather than trusting this arithmetic.
 */
const BINDER_UMASK = 0o177;

/** Exit codes, so a parent reading only the status knows which branch ran. */
export const BINDER_EXIT = { handedOver: 0, bindFailed: 1, refused: 2, handoffFailed: 3, parentGone: 4 };

/**
 * The identity of the entry this helper actually bound.
 *
 * Device and inode are read with `bigint: true` and carried as decimal strings, because a `Number` inode is
 * lossy above 2^53 and an ownership decision must not turn on a rounded value.
 * @param {string} socketPath
 */
export function readEndpointProof(socketPath) {
  const entry = lstatSync(socketPath, { bigint: true });
  return {
    device: String(entry.dev),
    inode: String(entry.ino),
    mode: Number(entry.mode & 0o777n),
    uid: Number(entry.uid),
  };
}

/** @param {unknown} value */
function isProof(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proof = /** @type {any} */ (value);
  return typeof proof.device === "string" && proof.device.length > 0
    && typeof proof.inode === "string" && proof.inode.length > 0
    && Number.isInteger(proof.mode) && Number.isInteger(proof.uid);
}

/**
 * One message this helper could have sent, or not.
 *
 * Exported so the parent validates with the same predicate the helper is written against: an unknown protocol
 * version, an unknown type, a non-object, or a `sideband-bound` without its ownership proof all fail here
 * rather than being pattern-matched twice.
 * @param {unknown} value
 */
export function isBinderMessage(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = /** @type {any} */ (value);
  if (message.protocol !== SIDEBAND_BINDER_PROTOCOL) return false;
  if (!SIDEBAND_BINDER_MESSAGES.includes(message.type)) return false;
  // A bound message without its proof is not a v2 bound message, whatever it claims its version is.
  if (message.type === "sideband-bound") return isProof(message.proof);
  return true;
}

/**
 * Read the two arguments this helper takes, refusing anything else before it touches the filesystem.
 *
 * The protocol version comes first precisely so a mismatched pair is refused *before* a bind: a v1 parent
 * spawning this file would otherwise get a socket it cannot verify and an entry nobody proved.
 * @param {string[]} argv
 */
export function readBinderRequest(argv) {
  if (argv.length !== 2) return { refusal: `a binder takes a protocol version and one absolute socket path, and was given ${argv.length} arguments` };
  const [version, socketPath] = argv;
  if (version !== String(SIDEBAND_BINDER_PROTOCOL)) {
    return { refusal: `this binder speaks protocol ${SIDEBAND_BINDER_PROTOCOL} and was asked for ${JSON.stringify(version)}` };
  }
  if (typeof socketPath !== "string" || socketPath.length === 0 || !socketPath.startsWith("/")) {
    return { refusal: "a binder needs one absolute socket path" };
  }
  return { socketPath };
}

/**
 * Bind, prove, hand the listener to the parent, and leave.
 *
 * The order matters in three specific ways. The ownership proof is read after `listen` and before the send, so
 * it describes the entry this process created rather than whatever is there later. The handle is sent while
 * this process still holds it. And after a successful bind this function never calls `server.close()` on any
 * path — success, send failure, or a parent that vanished — because that close would unlink a pathname this
 * process can no longer prove is its own. The exit releases the descriptor without touching the directory.
 *
 * @param {{ argv: string[], send: (message: unknown, handle: unknown, callback: (error?: Error|null) => void) => boolean,
 *   exit: (code: number) => void, diagnostic?: (line: string) => void, umask?: (mask: number) => void,
 *   onParentGone?: (handler: () => void) => void, proofOf?: (socketPath: string) => any }} host
 */
export function runBinder(host) {
  const diagnostic = host.diagnostic ?? (() => {});
  const setUmask = host.umask ?? ((mask) => process.umask(mask));
  const proofOf = host.proofOf ?? readEndpointProof;
  let bound = false;
  let finished = false;

  /** Leave exactly once, and never close a server this process bound. @param {number} code @param {string} why */
  const leave = (code, why) => {
    if (finished) return;
    finished = true;
    diagnostic(why);
    host.exit(code);
  };

  // A parent that disconnects or dies while this helper is working is handled here rather than left to a
  // timeout on the other side. After a successful bind this still does not close the server: the entry is no
  // longer provably this process's to remove, so it is left for the parent to report as uncertainty.
  host.onParentGone?.(() => leave(BINDER_EXIT.parentGone, bound
    ? "the parent went away after the bind; leaving the endpoint in place rather than unlinking a path this process can no longer prove"
    : "the parent went away before the bind"));

  const request = readBinderRequest(host.argv);
  if (request.socketPath === undefined) {
    // A refusal is a message, not an exit code alone: the parent must be able to say why it refused. Nothing
    // is bound yet, so there is nothing to leave behind.
    host.send({ protocol: SIDEBAND_BINDER_PROTOCOL, type: "sideband-binder-refused", reason: request.refusal }, undefined, () => leave(BINDER_EXIT.refused, `refused: ${request.refusal}`));
    return;
  }

  setUmask(BINDER_UMASK);
  const server = net.createServer();
  server.on("error", (error) => {
    const code = /** @type {any} */ (error).code ?? null;
    // A bind that never succeeded owns no entry, so this branch has nothing to preserve and nothing to remove.
    host.send({ protocol: SIDEBAND_BINDER_PROTOCOL, type: "sideband-bind-failed", code, message: error.message }, undefined, () => leave(BINDER_EXIT.bindFailed, `bind failed: ${error.message}`));
  });
  server.listen(request.socketPath, () => {
    bound = true;
    /** @type {any} */
    let proof;
    try {
      proof = proofOf(request.socketPath);
    } catch (error) {
      // The entry cannot be described, so it cannot be proved; it is left exactly where it is.
      host.send({
        protocol: SIDEBAND_BINDER_PROTOCOL,
        type: "sideband-bind-failed",
        code: /** @type {any} */ (error).code ?? null,
        message: `bound ${request.socketPath} but could not read its identity: ${/** @type {Error} */ (error).message}`,
      }, undefined, () => leave(BINDER_EXIT.bindFailed, "the bound endpoint's identity could not be read"));
      return;
    }
    diagnostic(`bound ${request.socketPath} as device ${proof.device} inode ${proof.inode} mode ${proof.mode.toString(8)}`);
    const delivered = host.send({ protocol: SIDEBAND_BINDER_PROTOCOL, type: "sideband-bound", socketPath: request.socketPath, proof }, server, (error) => {
      if (error) {
        // The handoff failed, so the parent has no proof and cannot clean up. This process still does not
        // unlink: a replacement may already be at that path, and closing the server would take it with it.
        leave(BINDER_EXIT.handoffFailed, `handoff failed after a successful bind: ${error.message}; the endpoint is left in place`);
        return;
      }
      leave(BINDER_EXIT.handedOver, "handed the listener over");
    });
    // `false` here is flow control, not a refusal. Whether the handle arrived is decided by the callback above.
    if (delivered === false) diagnostic("the parent channel applied backpressure to the handoff");
  });
}

// Run as a forked child. Guarded so importing this module in a test never binds anything.
if (process.send !== undefined && process.argv[1] !== undefined && process.argv[1].endsWith("native-sideband-binder.mjs")) {
  runBinder({
    argv: process.argv.slice(2),
    send: (message, handle, callback) => /** @type {any} */ (process.send)(message, handle, undefined, callback),
    exit: (code) => process.exit(code),
    onParentGone: (handler) => {
      process.once("disconnect", handler);
      process.once("SIGHUP", handler);
    },
    // Bounded, and never a protocol: one line per event, to stderr, for a human reading a log.
    diagnostic: (line) => process.stderr.write(`native-sideband-binder: ${line.slice(0, 512)}\n`),
  });
}
