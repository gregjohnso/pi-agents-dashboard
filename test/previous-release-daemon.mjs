import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";

import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";

const MAX_FRAME_BYTES = 64 * 1024;
/**
 * The authentication frame keys the release before `clientProtocol` accepted, and nothing else.
 * A client that also sends `clientProtocol` or `attachId` sends an unknown key, which that daemon
 * refuses before it reads the token.
 */
const PREVIOUS_RELEASE_AUTHENTICATION_KEYS = ["version", "token", "role", "action"];

/**
 * Serve one control socket that authenticates exactly as the release before `clientProtocol` did.
 *
 * The behaviour is written out here rather than checked out, so this keeps its meaning after that
 * code is gone. Two facts define it: the authentication allowlist above, and a `get_state` result
 * that carries no coverage cursor, because that release published none.
 *
 * @param {string} root @param {{ token?: string, sessions?: any[], pid?: number }} [options]
 */
export async function startPreviousReleaseDaemon(root, { token = "previous-release-token", sessions = [], pid = 4242 } = {}) {
  const directory = join(root, "daemon");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tokenPath = join(directory, "control.token");
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  const socketPath = join(directory, "control.sock");
  /** Authentication frames this daemon refused, in arrival order. @type {any[]} */
  const refusals = [];
  /** Request frames it accepted on an authenticated connection. @type {any[]} */
  const requests = [];
  /** Control frames that asked it to stop. @type {any[]} */
  const stopRequests = [];
  /** @type {(frame: any) => void} */
  let recordStop = () => {};
  /** Settles when a control connection asks this daemon to stop, which arrives after the caller returns. */
  const stopped = new Promise((resolve) => { recordStop = resolve; });
  /** @type {Set<net.Socket>} */
  const sockets = new Set();

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    const decoder = createJsonlDecoder({ maxBytes: MAX_FRAME_BYTES });
    const encoder = createJsonlEncoder({ maxBytes: MAX_FRAME_BYTES });
    let authenticated = false;
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("end", () => socket.end());
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk)) {
        const frame = /** @type {any} */ (value);
        if (!authenticated) {
          const known = typeof frame === "object" && frame !== null && !Array.isArray(frame) &&
            Object.keys(frame).every((key) => PREVIOUS_RELEASE_AUTHENTICATION_KEYS.includes(key));
          if (!known || frame.version !== 1 || frame.token !== token ||
            (frame.role !== undefined && !["frontend", "worker", "control"].includes(frame.role)) ||
            (frame.action !== undefined && (frame.role !== "control" || frame.action !== "stop"))) {
            refusals.push(frame);
            socket.write(encoder.encode({ version: 1, ok: false, error: { code: "AUTHENTICATION_FAILED", message: "Invalid daemon authentication", retryable: false } }));
            socket.end();
            return;
          }
          authenticated = true;
          socket.write(encoder.encode({ version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "previous-release-epoch", pid }));
          if (frame.role === "control") {
            stopRequests.push(frame);
            recordStop(frame);
            socket.end();
          }
          continue;
        }
        requests.push(frame);
        socket.write(encoder.encode({ version: 1, requestId: frame?.requestId, ok: true, result: { kind: "state", sessions } }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.listen(socketPath, () => resolve(undefined)); server.once("error", reject); });

  return {
    socketPath,
    tokenPath,
    token,
    pid,
    refusals,
    requests,
    stopRequests,
    stopped,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
