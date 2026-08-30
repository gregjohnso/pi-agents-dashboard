import net from "node:net";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";
import { reduceSessionState } from "./state-reducer.mjs";

/**
 * Create an inspector whose results can model exit and PID reuse deterministically.
 *
 * @param {unknown[]} sequence
 */
export function createSequenceInspector(sequence) {
  const remaining = [...sequence];
  /** @type {number[]} */
  const calls = [];
  return {
    calls,
    /** @param {number} pid */
    async inspect(pid) {
      calls.push(pid);
      if (remaining.length === 0) {
        throw new Error("Inspector sequence exhausted");
      }
      const next = remaining.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

/**
 * Record graceful requests and process-group signals without signaling real processes.
 *
 * @param {Set<number>} [aliveGroups]
 */
export function createFakeSignaler(aliveGroups = new Set()) {
  /** @type {Array<{ type: string, ownership?: unknown, pgid?: number, signal?: NodeJS.Signals }>} */
  const calls = [];
  return {
    calls,
    /** @param {unknown} ownership */
    async requestGraceful(ownership) {
      calls.push({ type: "graceful", ownership });
    },
    /** @param {number} pgid @param {NodeJS.Signals} signal */
    signalProcessGroup(pgid, signal) {
      calls.push({ type: "signal", pgid, signal });
      if (signal === "SIGKILL") {
        aliveGroups.delete(pgid);
      }
    },
  };
}

/**
 * Return a sleep seam that records configured delays and runs optional boundary hooks.
 *
 * @param {Array<(() => unknown | Promise<unknown>) | undefined>} [hooks]
 */
export function createFakeSleep(hooks = []) {
  /** @type {number[]} */
  const calls = [];
  return {
    calls,
    /** @param {number} ms */
    async sleep(ms) {
      calls.push(ms);
      const hook = hooks.shift();
      if (hook) {
        await hook();
      }
    },
  };
}

/**
 * A minimal stand-in for the daemon's worker control socket.
 *
 * It authenticates a worker connection, hands a startup hello to the router's launch reservation,
 * adopts a reconnecting worker's route, and applies worker events with the production reducer. It
 * exists so a supervisor test can drive real worker processes without a whole daemon runtime.
 *
 * @param {{ root: string, router: any, registry: any }} options
 */
export async function createWorkerControlSocket({ root, router, registry }) {
  const daemonDirectory = join(root, "daemon");
  await mkdir(daemonDirectory, { recursive: true, mode: 0o700 });
  const socketPath = join(daemonDirectory, "control.sock");
  const tokenPath = join(daemonDirectory, "control.token");
  const token = "worker-control-socket-token";
  await writeFile(tokenPath, token, { mode: 0o600 });
  /** @type {any[]} */
  const frames = [];
  /** @type {Set<any>} */
  const sockets = new Set();
  /** @type {Map<string, any>} */
  const pending = new Map();

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    const decoder = createJsonlDecoder({ maxBytes: 1024 * 1024 });
    const encoder = createJsonlEncoder({ maxBytes: 1024 * 1024 });
    /** @type {(value?: unknown) => void} */
    let resolveClosed = () => {};
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    /** @param {any} value */
    const send = (value) => new Promise((resolve, reject) => socket.write(encoder.encode(value), (error) => error ? reject(error) : resolve(undefined)));
    /** @type {any} */
    let connection;
    /** @type {any} */
    let reservation;
    /** @type {any} */
    let metadata;
    let authenticated = false;
    let chain = Promise.resolve();
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); resolveClosed(undefined); });
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk)) {
        const frame = /** @type {any} */ (value);
        chain = chain.then(async () => {
          if (!authenticated) {
            if (frame?.token !== token || frame.role !== "worker") { socket.destroy(); return; }
            authenticated = true;
            await send({ version: 1, kind: "authenticated" });
            return;
          }
          if (connection === undefined) {
            connection = {
              closed,
              close: () => socket.destroy(),
              send,
              /** @param {any} message */
              request: (message) => new Promise((resolve, reject) => {
                pending.set(message.id, { resolve, reject });
                send(message).catch(reject);
              }),
            };
            reservation = await router.beginLaunchConnection(frame, connection, (/** @type {any} */ entry) => {
              metadata = entry.route.metadata;
              for (const buffered of entry.drainBuffered()) frames.push(buffered);
            });
            if (reservation !== undefined) return;
            const route = await router.adopt(frame, connection);
            metadata = route.metadata;
            return;
          }
          if (reservation !== undefined && reservation.route === undefined) { reservation.deliver(frame); return; }
          frames.push(frame);
          if (frame.type === "command_result") {
            const request = pending.get(frame.id);
            pending.delete(frame.id);
            frame.ok ? request?.resolve(frame.record) : request?.reject(Object.assign(new Error(frame.error?.message ?? "failed"), frame.error));
            return;
          }
          if (frame.type !== "worker_event" || metadata === undefined) return;
          const current = await registry.get(frame.sessionId);
          if (current?.ownership?.runId !== metadata.runId) return;
          const next = reduceSessionState(current, frame.event);
          if (next === current) return;
          await registry.update(frame.sessionId, current.revision, { taskState: next.taskState, processState: next.processState, outcome: next.outcome, activity: next.activity, updatedAt: next.updatedAt });
        }).catch(() => { socket.destroy(); });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(undefined); });
  });
  await chmod(socketPath, 0o600);
  return {
    frames,
    connectConfig: { socketPath, tokenPath, maxBytes: 1024 * 1024 },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
