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
 */

import net from "node:net";

import { demoPaths, readToken } from "./demo-root.mjs";
import { createFrameReader, encodeFrame, MAX_BODY_BYTES } from "./protocol.mjs";

/**
 * Undo what a cold presentation left on *this* terminal.
 *
 * The Kitty keyboard flags are reset with the set-flags form rather than popped. Pi pushes its flags once, on
 * the owner's terminal, and pops them once at shutdown; a client that received only the reassertion
 * (`CSI = flags ; 1 u`) never received a push, so popping here would unbalance a stack this terminal never
 * grew.
 */
const FRONTEND_MODE_RESTORE = [
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
 * @param {{ root: string, attachmentId?: string }} options
 */
export async function attach({ root, attachmentId }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("attach needs a real terminal on stdin and stdout; run it from a terminal, not a pipe");
  }
  const paths = demoPaths(root);
  const token = await readToken(root);
  const notices = [];
  let restored = false;
  let welcome;

  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(FRONTEND_MODE_RESTORE);
    } catch {
      // A terminal that has already gone away needs no restoration.
    }
    // A resumed raw stdin holds the event loop open, so detaching would never end this process.
    process.stdin.pause();
    process.stdin.unref();
  };

  const socket = net.connect(paths.controlSocket);
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      restore();
      resolve(outcome);
    };

    const reader = createFrameReader(
      ({ header, body }) => {
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
            for (let offset = 0; offset < chunk.byteLength; offset += MAX_BODY_BYTES) {
              socket.write(encodeFrame({ type: "input" }, chunk.subarray(offset, Math.min(offset + MAX_BODY_BYTES, chunk.byteLength))));
            }
          });
          return;
        }
        if (header.type === "output") {
          process.stdout.write(body);
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
    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("error", (error) => finish({ reason: `transport: ${error.message}`, notices, welcome }));
    socket.on("close", () => finish({ reason: "the manager closed this attachment", notices, welcome }));

    // Detach without a key parser: an operator detaches with `demo.mjs detach`, or by signalling this client.
    for (const signal of /** @type {NodeJS.Signals[]} */ (["SIGTERM", "SIGHUP", "SIGINT"])) {
      process.on(signal, () => {
        socket.write(encodeFrame({ type: "detach" }));
        finish({ reason: `this client received ${signal}`, notices, welcome });
        socket.end();
      });
    }
    process.on("exit", restore);
  });

  const outcome = await done;
  process.stderr.write(`detached: ${outcome.reason}\r\n`);
  for (const notice of outcome.notices) process.stderr.write(`notice: ${notice}\r\n`);
  return outcome;
}
