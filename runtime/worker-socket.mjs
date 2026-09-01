import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";

import { createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";

/**
 * The worker socket arrangement, recorded per run as `proto` in `daemon/workers.json`.
 *
 * Version 1 was the opposite arrangement: the daemon listened on `daemon/control.sock` and every
 * worker connected out to it. A worker from that release listens on nothing, so a daemon speaking
 * this version has no socket to connect to and reports the run unreachable rather than signalling it.
 */
export const WORKER_SOCKET_PROTOCOL = 2;
const DEFAULT_MAX_BYTES = 1024 * 1024;
/** How long a connect waits for a worker that has been spawned but has not called listen yet. */
const CONNECT_RETRY_MS = 10;

/** @param {unknown} supplied @param {string} expected */
function sameToken(supplied, expected) {
  const digest = (/** @type {string} */ value) => createHash("sha256").update(value, "utf8").digest();
  return typeof supplied === "string" && timingSafeEqual(digest(supplied), digest(expected));
}

/**
 * Wrap one connected socket in the message transport both sides of this boundary speak.
 * @param {net.Socket} socket @param {number} maxBytes
 */
function createFrameTransport(socket, maxBytes) {
  const encoder = createJsonlEncoder({ maxBytes });
  /** @type {Set<(message: any) => void>} */
  const listeners = new Set();
  /** @type {(value: unknown) => void} */
  let resolveClosed = () => {};
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  socket.once("close", () => resolveClosed(undefined));
  socket.on("error", () => {});
  return {
    closed,
    listeners,
    /** @param {any} message */
    send(message) {
      if (socket.destroyed) throw Object.assign(new Error("Worker connection is closed"), { code: "WORKER_CONNECTION_CLOSED" });
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

/**
 * Listen on the socket path the daemon named before this worker was spawned.
 *
 * The worker owns this socket: it creates the file, holds it for its whole life, and removes it when
 * it stops. A daemon that dies between naming the path and spawning therefore leaves no file behind,
 * because until this call nothing has created one.
 *
 * A connection that does not open with this run's token is destroyed without a reply. Only one
 * daemon connection is live at a time; a newly authenticated one replaces the connection before it,
 * which is what a daemon replaced mid-flight looks like from here.
 *
 * @param {{ socketPath: string, token: string, maxBytes?: number }} options
 */
export async function listenForDaemon({ socketPath, token, maxBytes = DEFAULT_MAX_BYTES }) {
  if (typeof socketPath !== "string" || socketPath.length === 0) throw new TypeError("Worker socket path is required");
  if (typeof token !== "string" || token.length === 0) throw new TypeError("Worker socket token is required");
  /** Authenticated connections nothing has taken yet. @type {any[]} */
  const waiting = [];
  /** @type {((connection: any) => void)[]} */
  const takers = [];
  /** @type {any} */
  let current;
  let closing = false;
  /** Every accepted socket, authenticated or not. `server.close` waits for all of them. @type {Set<net.Socket>} */
  const sockets = new Set();

  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const decoder = createJsonlDecoder({ maxBytes });
    /** @type {any} */
    let transport;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      /** @type {unknown[]} */
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const value of frames) {
        const frame = /** @type {any} */ (value);
        if (transport === undefined) {
          if (frame?.version !== 1 || frame.type !== "daemon_hello" || !sameToken(frame.token, token)) {
            socket.destroy();
            return;
          }
          transport = createFrameTransport(socket, maxBytes);
          const connection = { closed: transport.closed, send: transport.send, onMessage: transport.onMessage, close: transport.close };
          const previous = current;
          current = connection;
          previous?.close();
          const taker = takers.shift();
          if (taker === undefined) waiting.push(connection);
          else taker(connection);
          continue;
        }
        for (const listener of [...transport.listeners]) {
          try {
            listener(frame);
          } catch {
            socket.destroy();
            return;
          }
        }
      }
    });
  });
  server.on("error", () => {});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });
  // The socket lives under a private directory the daemon created, so this narrows an already
  // unreachable path rather than closing a window an unprivileged reader could use.
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    /** The next authenticated daemon connection. Rejects once this listener is closed. */
    next() {
      const queued = waiting.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closing) return Promise.reject(Object.assign(new Error("Worker socket is closed"), { code: "WORKER_SOCKET_CLOSED" }));
      return new Promise((resolve) => takers.push(resolve));
    },
    async close() {
      if (closing) return;
      closing = true;
      current?.close();
      for (const connection of waiting.splice(0)) connection.close();
      for (const taker of takers.splice(0)) taker(undefined);
      // Destroy every accepted socket first: `server.close` waits for all of them, so a daemon that
      // is still connected would otherwise hold this worker's own shutdown open indefinitely.
      for (const socket of [...sockets]) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await unlink(socketPath).catch(() => {});
    },
  };
}

/**
 * Connect to one worker's own socket and authenticate with that run's token.
 *
 * A worker that has been spawned but has not reached `listen` yet answers ENOENT or ECONNREFUSED,
 * so this retries until the deadline. Past it the run is unreachable, which is a report rather than
 * a signal: nothing here touches the process the socket belongs to.
 *
 * @param {{ socketPath: string, token: string, maxBytes?: number, timeoutMs?: number }} options
 */
export async function connectToWorker({ socketPath, token, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = 0 }) {
  if (typeof socketPath !== "string" || socketPath.length === 0) throw new TypeError("Worker socket path is required");
  if (typeof token !== "string" || token.length === 0) throw new TypeError("Worker socket token is required");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      return await openWorkerConnection(socketPath, token, maxBytes);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "";
      if (!["ENOENT", "ECONNREFUSED"].includes(code) || Date.now() >= deadline) {
        throw Object.assign(new Error(`Worker socket is unreachable: ${code || "connect failed"}`, { cause: error }), { code: "WORKER_SOCKET_UNREACHABLE" });
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }
}

/** @param {string} socketPath @param {string} token @param {number} maxBytes */
function openWorkerConnection(socketPath, token, maxBytes) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const decoder = createJsonlDecoder({ maxBytes });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      const transport = createFrameTransport(socket, maxBytes);
      socket.on("data", (chunk) => {
        /** @type {unknown[]} */
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const frame of frames) {
          for (const listener of [...transport.listeners]) {
            try {
              listener(frame);
            } catch {
              socket.destroy();
              return;
            }
          }
        }
      });
      transport.send({ version: 1, type: "daemon_hello", token }).then(
        () => resolve({ closed: transport.closed, send: transport.send, onMessage: transport.onMessage, close: transport.close }),
        (error) => { socket.destroy(); reject(error); },
      );
    });
  });
}
