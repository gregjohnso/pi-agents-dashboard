import net from "node:net";
import { readFile, lstat } from "node:fs/promises";

import { createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";

/** @param {{ config: { socketPath: string, tokenPath: string, maxBytes?: number }, signal?: AbortSignal }} options */
export async function connectDaemon({ config, signal }) {
  const { socketPath, tokenPath, maxBytes = 1024 * 1024 } = config ?? {};
  if (typeof socketPath !== "string" || typeof tokenPath !== "string") throw new TypeError("Daemon connector requires socketPath and tokenPath");
  const metadata = await lstat(tokenPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw new Error("Daemon control token must be a private owned file");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (token.length === 0) throw new Error("Daemon control token is empty");
  const encoder = createJsonlEncoder({ maxBytes });
  const decoder = createJsonlDecoder({ maxBytes });
  const socket = net.createConnection(socketPath);
  socket.on("error", () => {});
  /** @type {Set<(message: any) => void>} */
  const listeners = new Set();
  let authenticated = false;
  /** @type {(value: unknown) => void} */
  let resolveClosed = () => {};
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    /** @param {unknown} error */
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const failClosed = () => {
      if (authenticated) return;
      fail(Object.assign(new Error("Daemon connection closed before worker authentication"), { code: "DAEMON_AUTHENTICATION_CLOSED" }));
      socket.destroy();
    };
    socket.once("error", fail);
    socket.once("end", failClosed);
    socket.once("close", failClosed);
    socket.once("connect", () => {
      try {
        socket.write(encoder.encode({ version: 1, token, role: "worker" }));
      } catch (error) {
        fail(error);
        socket.destroy();
      }
    });
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        fail(error);
        socket.destroy();
        return;
      }
      for (const frameValue of frames) {
        const frame = /** @type {any} */ (frameValue);
        if (!authenticated) {
          if (frame?.version === 1 && frame?.kind === "authenticated") {
            authenticated = true;
            if (!settled) {
              settled = true;
              resolve(undefined);
            }
          } else {
            fail(Object.assign(new Error("Daemon rejected worker authentication"), { code: frame?.error?.code ?? "AUTHENTICATION_FAILED" }));
            socket.destroy();
          }
        } else {
          for (const listener of listeners) {
            try {
              listener(frame);
            } catch {
              socket.destroy();
              break;
            }
          }
        }
      }
    });
  });
  socket.once("close", () => resolveClosed(undefined));
  const abort = () => socket.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  closed.finally(() => signal?.removeEventListener("abort", abort)).catch(() => {});
  await ready;
  return {
    closed,
    /** @param {any} message */
    send(message) {
      if (!authenticated || socket.destroyed) throw Object.assign(new Error("Daemon connection is closed"), { code: "DAEMON_CONNECTION_CLOSED" });
      return new Promise((resolve, reject) => socket.write(encoder.encode(message), (error) => error ? reject(error) : resolve(undefined)));
    },
    /** @param {(message: any) => void} listener */
    onMessage(listener) {
      if (typeof listener !== "function") throw new TypeError("Worker message listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      socket.destroy();
    },
  };
}
