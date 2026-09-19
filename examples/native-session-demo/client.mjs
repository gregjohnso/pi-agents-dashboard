/**
 * One attachment: a frontend terminal, and nothing else.
 *
 * This process is deliberately incapable of interpreting the session. It reads raw bytes from its own
 * terminal and sends them, labelled with nothing but its attachment identity, to the manager; it writes the
 * bytes Pi produced to its own terminal unchanged. It decodes no key, recognises no escape sequence, holds no
 * draft, keeps no screen model and has no detach key of its own. Detach is either this process being asked to
 * stop, or the manager's explicit `detach` command.
 *
 * What it does own is its own terminal's modes. Pi negotiated and pushed modes on the *owner's* terminal, not
 * on this one, and Pi will never pop them here: the frontend that turned raw mode on is the frontend that has
 * to put its terminal back, on a clean exit, on an error and on a disconnect.
 *
 * It also owns backpressure in both directions. A `write()` that answers `false` has already taken the chunk it
 * was given, so nothing is re-sent; the source of that direction is paused instead, nothing more is written
 * until the destination drains, and one drain listener catches up the remainder.
 *
 * Teardown has one order, on every path that ends an attachment — a `bye`, a refusal, a transport error, a
 * closed socket or a signal: dispose both relays, then the detach frame if this path sends one, then restore
 * this terminal. Nothing is written to the terminal after the restoration sequence, and keystrokes that never
 * reached the manager are dropped with a count rather than delivered late to a session that has moved on.
 */

import net from "node:net";

import { demoPaths, readToken } from "./demo-root.mjs";
import { createPausingRelay } from "./pausing-relay.mjs";
import { createFrameReader, encodeFrame, MAX_BODY_BYTES } from "./protocol.mjs";

/**
 * Undo what a cold presentation left on *this* terminal.
 *
 * The Kitty keyboard flags are reset with the set-flags form rather than popped. Pi pushes its flags once, on
 * the owner's terminal, and pops them once at shutdown; a client that received only the reassertion
 * (`CSI = flags ; 1 u`) never received a push, so popping here would unbalance a stack this terminal never
 * grew.
 */
export const FRONTEND_MODE_RESTORE = [
  "\u001b[=0;1u", // kitty keyboard flags back to none, set-flags form
  "\u001b[>4;0m", // modifyOtherKeys off
  "\u001b[?2004l", // bracketed paste off
  "\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l", // mouse reporting off
  "\u001b[?25h", // cursor visible
  "\u001b[?7h", // autowrap on
  "\u001b[?1049l", // leave the alternate screen if a fullscreen owner put us there
  "\u001b[0m\r\n", // no lingering attributes, and start the operator's shell on a fresh line
].join("");

/**
 * One attachment's teardown, in one order, shared by every path that ends it.
 *
 * Both relays are disposed first, so nothing either of them still holds can be written afterwards; the caller
 * may then write its own last frame to the socket, behind the writes the socket has already accepted; and this
 * terminal is restored last. The operator is told how many of his own bytes were dropped: this attachment is
 * over, so unforwarded keystrokes are not delivered late, and output is not replayed — a reattachment is
 * repainted by Pi.
 *
 * @param {{ toManager: { dispose: (reason: string) => { discardedChunks: number, discardedBytes: number } }, toTerminal: { dispose: (reason: string) => { discardedChunks: number, discardedBytes: number } }, stdin: any, stdout: { write: (text: string) => unknown }, notice: (text: string) => void }} wiring
 */
export function createAttachmentTeardown({ toManager, toTerminal, stdin, stdout, notice }) {
  let disposed = false;
  let restored = false;

  /** @param {string} reason */
  const disposeRelays = (reason) => {
    if (disposed) return null;
    disposed = true;
    const input = toManager.dispose(reason);
    const output = toTerminal.dispose(reason);
    if (input.discardedBytes > 0) {
      notice(
        `${input.discardedBytes} typed byte(s) in ${input.discardedChunks} frame(s) had not reached the manager when this attachment ended (${reason}); ` +
          "they were dropped, not delivered late",
      );
    }
    if (output.discardedBytes > 0) {
      notice(
        `${output.discardedBytes} byte(s) of the owner's output were dropped at teardown (${reason}); ` +
          "a reattachment is repainted by Pi, not replayed from here",
      );
    }
    return { input, output };
  };

  return {
    disposeRelays,

    /** @param {string} reason */
    restore(reason) {
      disposeRelays(reason);
      if (restored) return;
      restored = true;
      try {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdout.write(FRONTEND_MODE_RESTORE);
      } catch {
        // A terminal that has already gone away needs no restoration.
      }
      // A resumed raw stdin holds the event loop open, so detaching would never end this process.
      stdin.pause();
      stdin.unref?.();
    },
  };
}

/**
 * @param {{ root: string, attachmentId?: string }} options
 */
export async function attach({ root, attachmentId }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("attach needs a real terminal on stdin and stdout; run it from a terminal, not a pipe");
  }
  const paths = demoPaths(root);
  const token = await readToken(root);
  const notices = [];
  let welcome;

  const socket = net.connect(paths.controlSocket);
  let finished = false;
  // Pi's bytes to this terminal: a slow terminal pauses the socket rather than growing stdout's queue, and
  // the frames already decoded from the current read stay queued here in order.
  const toTerminal = createPausingRelay({ source: socket, destination: process.stdout, canResumeSource: () => !finished });
  // This terminal's bytes to the manager: a full socket pauses stdin rather than growing the socket's queue.
  const toManager = createPausingRelay({ source: process.stdin, destination: socket, canResumeSource: () => !finished });
  const teardown = createAttachmentTeardown({
    toManager,
    toTerminal,
    stdin: process.stdin,
    stdout: process.stdout,
    notice: (text) => notices.push(text),
  });
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      finished = true;
      teardown.restore(outcome.reason);
      resolve(outcome);
    };

    const reader = createFrameReader(
      ({ header, body }) => {
        // Frames coalesced into one read are still decoded after a `bye` or a refusal ends this attachment.
        if (finished) return;
        if (header.type === "welcome") {
          welcome = header;
          process.stderr.write(
            `attached as ${header.attachmentId} epoch ${header.epoch} to owner pid ${header.owner.pid} ` +
              `(startIdentity ${header.owner.startIdentity}), geometry ${header.geometry.cols}x${header.geometry.rows}, ` +
              `provider ${header.provider}\r\n`,
          );
          if (process.stdout.columns !== header.geometry.cols || process.stdout.rows !== header.geometry.rows) {
            process.stderr.write(
              `note: this terminal is ${process.stdout.columns}x${process.stdout.rows} and the owner's one shared geometry is ` +
                `${header.geometry.cols}x${header.geometry.rows}; the session is not resized per client\r\n`,
            );
          }
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.on("data", (chunk) => {
            if (finished) return;
            const frames = [];
            for (let offset = 0; offset < chunk.byteLength; offset += MAX_BODY_BYTES) {
              frames.push(encodeFrame({ type: "input" }, chunk.subarray(offset, Math.min(offset + MAX_BODY_BYTES, chunk.byteLength))));
            }
            toManager.send(...frames);
          });
          return;
        }
        if (header.type === "output") {
          toTerminal.send(body);
          return;
        }
        if (header.type === "notice") {
          notices.push(header.text);
          return;
        }
        if (header.type === "bye") {
          finish({ reason: header.reason, notices, welcome });
          socket.destroy();
          return;
        }
        if (header.type === "refused") {
          finish({ reason: `refused: ${header.text}`, notices, welcome });
          socket.destroy();
        }
      },
      (error) => {
        finish({ reason: `protocol refusal: ${error.code} ${error.message}`, notices, welcome });
        socket.destroy();
      },
    );

    socket.on("connect", () => {
      socket.write(encodeFrame({ type: "hello", role: "client", token, attachmentId }));
    });
    socket.on("data", (chunk) => {
      if (!finished) reader.push(chunk);
    });
    socket.on("error", (error) => finish({ reason: `transport: ${error.message}`, notices, welcome }));
    socket.on("close", () => finish({ reason: "the manager closed this attachment", notices, welcome }));

    // Detach without a key parser: an operator detaches with `demo.mjs detach`, or by signalling this client.
    // The relays are disposed first, so the detach frame is the last thing this client writes and the keystrokes
    // the input relay was still holding are dropped with a count rather than delivered late. The writes the
    // socket already accepted stay ordered ahead of it.
    for (const signal of /** @type {NodeJS.Signals[]} */ (["SIGTERM", "SIGHUP", "SIGINT"])) {
      process.on(signal, () => {
        if (finished) return;
        teardown.disposeRelays(`this client received ${signal}`);
        socket.write(encodeFrame({ type: "detach" }));
        finish({ reason: `this client received ${signal}`, notices, welcome });
        socket.end();
      });
    }
    process.on("exit", () => teardown.restore("this client is exiting"));
  });

  const outcome = await done;
  process.stderr.write(`detached: ${outcome.reason}\r\n`);
  for (const notice of outcome.notices) process.stderr.write(`notice: ${notice}\r\n`);
  return outcome;
}
