/**
 * One short-lived process whose only job is to bind a private socket and hand the listener away.
 *
 * The reason this exists is narrow and mechanical. Closing a `net.Server` that bound a pathname unlinks that
 * pathname, and libuv does it before any userland code runs — so a listener that bound its own endpoint cannot
 * preserve a replacement another actor put there, no matter what it checks first. Measured, not assumed:
 * `close-probe-v1-binder-closed.txt` beside this tree's evidence shows the guarded unlink changing nothing.
 *
 * A handle that was *received* over IPC carries no pathname, so closing it unlinks nothing. That is the whole
 * trick. This file is the process that owns the bind, and it is gone before the listener is usable.
 *
 * What it deliberately is not: a daemon, a supervisor, a second Pi owner, a canonical writer, or a general
 * process framework. It binds one path, sends one message, and exits. It never closes the server it bound,
 * because that close is exactly the unlink this design exists to avoid — its exit releases the descriptor
 * instead, leaving the entry for the process that now holds the handle.
 *
 * Its stdout is not a protocol. Everything the parent acts on arrives as one versioned IPC message; anything
 * written to a stream is diagnostics for a human reading a log.
 */

import net from "node:net";

/** The parent/helper message version. Bumped only for an incompatible message shape, never for the wire. */
export const SIDEBAND_BINDER_PROTOCOL = 1;

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

/**
 * One message this helper could have sent, or not.
 *
 * Exported so the parent validates with the same predicate the helper is written against: an unknown protocol
 * version, an unknown type or a non-object all fail here rather than being pattern-matched twice.
 * @param {unknown} value
 */
export function isBinderMessage(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = /** @type {any} */ (value);
  return message.protocol === SIDEBAND_BINDER_PROTOCOL && SIDEBAND_BINDER_MESSAGES.includes(message.type);
}

/**
 * Read the one argument this helper takes, refusing anything else before it touches the filesystem.
 * @param {string[]} argv
 */
export function readBinderRequest(argv) {
  const socketPath = argv[0];
  if (typeof socketPath !== "string" || socketPath.length === 0 || !socketPath.startsWith("/")) {
    return { refusal: "a binder needs one absolute socket path and nothing else" };
  }
  if (argv.length !== 1) return { refusal: `a binder takes one argument and was given ${argv.length}` };
  return { socketPath };
}

/**
 * Bind, hand the listener to the parent, and leave.
 *
 * The order matters in one specific way: the handle is sent while this process still holds it, and this
 * process exits only after the send has been acknowledged by the runtime. It never calls `server.close()` —
 * that would unlink the pathname it just bound, which is the failure this whole file exists to prevent. The
 * exit releases the descriptor without touching the directory entry.
 *
 * @param {{ argv: string[], send: (message: unknown, handle: unknown, callback: (error?: Error|null) => void) => boolean,
 *   exit: (code: number) => void, diagnostic?: (line: string) => void, umask?: (mask: number) => void }} host
 */
export function runBinder(host) {
  const diagnostic = host.diagnostic ?? (() => {});
  const setUmask = host.umask ?? ((mask) => process.umask(mask));
  const request = readBinderRequest(host.argv);
  if (request.socketPath === undefined) {
    // A refusal is a message, not an exit code alone: the parent must be able to say why it refused.
    host.send({ protocol: SIDEBAND_BINDER_PROTOCOL, type: "sideband-binder-refused", reason: request.refusal }, undefined, () => host.exit(2));
    return;
  }

  setUmask(BINDER_UMASK);
  const server = net.createServer();
  server.on("error", (error) => {
    const code = /** @type {any} */ (error).code ?? null;
    diagnostic(`bind failed: ${error.message}`);
    host.send({ protocol: SIDEBAND_BINDER_PROTOCOL, type: "sideband-bind-failed", code, message: error.message }, undefined, () => host.exit(1));
  });
  server.listen(request.socketPath, () => {
    diagnostic(`bound ${request.socketPath}`);
    const delivered = host.send({ protocol: SIDEBAND_BINDER_PROTOCOL, type: "sideband-bound", socketPath: request.socketPath }, server, (error) => {
      if (error) {
        // The parent will never see this handle, so nothing may be left listening on a path nobody owns. This
        // is the one place a close is correct: no handoff happened, so the entry is still only this call's.
        diagnostic(`handoff failed: ${error.message}`);
        server.close(() => host.exit(1));
        return;
      }
      // Handed over. Exit without closing: the parent's handle carries no pathname, and a close here would
      // take the entry with it.
      host.exit(0);
    });
    if (delivered === false) diagnostic("the parent channel refused the handle");
  });
}

// Run as a forked child. Guarded so importing this module in a test never binds anything.
if (process.send !== undefined && process.argv[1] !== undefined && process.argv[1].endsWith("native-sideband-binder.mjs")) {
  runBinder({
    argv: process.argv.slice(2),
    send: (message, handle, callback) => /** @type {any} */ (process.send)(message, handle, undefined, callback),
    exit: (code) => process.exit(code),
    // Bounded, and never a protocol: one line per event, to stderr, for a human reading a log.
    diagnostic: (line) => process.stderr.write(`native-sideband-binder: ${line.slice(0, 512)}\n`),
  });
}
