/**
 * The host side of seam E's core bootstrap sideband.
 *
 * Pi connects out to this listener from `main()`, before any extension module is loaded, and writes its hello
 * first. That is the only launch-time route to readiness and cold presentation: an extension's
 * `session_start` runs later and behind every other extension's handler, so a host that waited for one could
 * be held up by code it does not own.
 *
 * Reads are bounded the same way Pi bounds its own inbound side: one newline-terminated JSON object of at
 * most `MAX_LINE_BYTES`. A peer that crosses the bound ends the channel instead of being buffered. There is
 * no reconnect logic, because Pi connects once per launch.
 *
 * **This channel is not authenticated, and it must not be described as if it were.** Protocol 1 is Pi's own,
 * unchanged, and it carries no credential field; this demo adds none and invents no core protocol field. The
 * only thing standing between this listener and another process is filesystem permission: the socket is
 * unix-domain, `0600`, inside the owner's `0700` root. The demo's *own* control socket in `manager.mjs` is the
 * one that requires a token. Keep the two straight when reasoning about who can reach what.
 */

import { chmod, rm } from "node:fs/promises";
import net from "node:net";

const MAX_LINE_BYTES = 8 * 1024;
const PRESENT_TIMEOUT_MS = 10_000;

/**
 * @param {string} socketPath
 * @param {{ onFrame: (frame: any) => void, onError: (error: Error) => void }} handlers
 */
export async function startBootstrapSideband(socketPath, { onFrame, onError }) {
  /** @type {net.Socket | undefined} */
  let peer;
  let buffered = "";
  let requestCounter = 0;
  /** @type {Map<string, { resolve: (result: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();

  const settle = (requestId, outcome) => {
    const waiter = pending.get(requestId);
    if (!waiter) return;
    pending.delete(requestId);
    clearTimeout(waiter.timer);
    if (outcome instanceof Error) waiter.reject(outcome);
    else waiter.resolve(outcome);
  };

  const server = net.createServer((connection) => {
    peer = connection;
    connection.setEncoding("utf8");
    connection.on("error", (error) => onError(error));
    connection.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE_BYTES) {
        onError(new Error(`The bootstrap sideband peer buffered ${buffered.length} bytes without a newline, above ${MAX_LINE_BYTES}`));
        buffered = "";
        connection.destroy();
        return;
      }
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (line.trim() === "") continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch (cause) {
          onError(new Error(`The bootstrap sideband sent a line that is not JSON: ${/** @type {Error} */ (cause).message}`));
          continue;
        }
        if (frame?.type === "presentation-result") settle(frame.requestId, frame.result);
        else if (frame?.type === "error") settle(frame.requestId, new Error(`Pi refused a sideband frame: ${JSON.stringify(frame.error)}`));
        onFrame(frame);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  await chmod(socketPath, 0o600);

  return {
    connected() {
      return peer !== undefined && !peer.destroyed;
    },
    /**
     * Ask Pi for one cold presentation and resolve with its own `PresentTerminalResult`.
     *
     * @param {{ attachmentId: string, epoch: number, geometryRevision: number }} request
     */
    present({ attachmentId, epoch, geometryRevision }) {
      if (!peer || peer.destroyed) return Promise.reject(new Error("Pi has not connected to the bootstrap sideband"));
      requestCounter += 1;
      const requestId = `present-${requestCounter}`;
      const command = {
        type: "present",
        protocol: 1,
        requestId,
        attachmentEpoch: { attachmentId, epoch },
        geometryRevision,
        coldTerminal: true,
      };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(requestId, new Error(`Pi did not answer ${requestId} within ${PRESENT_TIMEOUT_MS}ms`)), PRESENT_TIMEOUT_MS);
        pending.set(requestId, { resolve, reject, timer });
        peer.write(`${JSON.stringify(command)}\n`);
      });
    },
    async close() {
      for (const requestId of [...pending.keys()]) settle(requestId, new Error("The bootstrap sideband closed"));
      peer?.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await rm(socketPath, { force: true });
    },
  };
}
