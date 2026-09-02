import { connectToWorker, listenForDaemon } from "./worker-socket.mjs";
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
 * One live worker listening on its own socket, without a worker process.
 *
 * It answers every daemon that connects with its readiness frame, exactly as a real worker does, and
 * acknowledges commands unless it is `silent`, which is what leaves one in flight. It survives every
 * daemon that connects to it, because that is what a worker is for.
 *
 * @param {{ socketPath: string, token: string, sessionId: string, runId: string, leaseId: string, generation: number, worker: any, piChild: any, silent?: boolean, maxBytes?: number }} run
 */
export async function startListeningWorker({ socketPath, token, sessionId, runId, leaseId, generation, worker, piChild, silent = false, maxBytes = 64 * 1024 }) {
  const listener = await listenForDaemon({ socketPath, token, maxBytes });
  const ready = { version: 1, type: "worker_ready", token, sessionId, runId, leaseId, generation, worker, piChild };
  let commandCount = 0;
  let stopped = false;
  /** @type {any} */
  let live;
  const serving = (async () => {
    while (!stopped) {
      /** @type {any} */
      let connection;
      try {
        connection = await listener.next();
        if (connection === undefined) return;
        live = connection;
        connection.onMessage((/** @type {any} */ frame) => {
          if (frame?.type !== "command") return;
          commandCount += 1;
          if (silent) return;
          void connection.send({ version: 1, type: "command_result", token, id: frame.id, ok: true, record: { clientId: frame.command.clientId, requestId: frame.command.requestId, op: frame.command.op, stage: "RPC_ACKNOWLEDGED", at: "2026-08-25T12:00:00.000Z", result: null } });
        });
        await connection.send(ready);
        await connection.closed;
      } catch {
        return;
      }
    }
  })();
  return {
    socketPath,
    get commandCount() { return commandCount; },
    /** @param {any} event */
    async sendEvent(event) { await live.send({ version: 1, type: "worker_event", token, sessionId, event }); },
    /** @param {any} frame */
    async sendFrame(frame) { await live.send(frame); },
    async stop() {
      stopped = true;
      await listener.close();
      await serving;
    },
  };
}

/**
 * Worker sockets a router can connect to without a worker process.
 *
 * Each registered path answers one connect with the frames that worker would have written, in order,
 * so a test can drive adoption and its refusals. An unregistered path is unreachable, which is what
 * a worker from an earlier release, or a dead one, looks like to a daemon that connects.
 */
export function createFakeWorkerSockets() {
  /** @type {Map<string, any[]>} */
  const answers = new Map();
  /** @type {any[]} */
  const opened = [];
  return {
    opened,
    /** @param {string} socketPath @param {any[]} frames */
    answer(socketPath, frames) {
      answers.set(socketPath, frames);
    },
    /** @param {{ socketPath: string, token: string }} options */
    async connect({ socketPath, token }) {
      const frames = answers.get(socketPath);
      if (frames === undefined) throw Object.assign(new Error(`Worker socket is unreachable: ${socketPath}`), { code: "WORKER_SOCKET_UNREACHABLE" });
      /** @type {(value?: unknown) => void} */
      let resolveClosed = () => {};
      const closed = new Promise((resolve) => { resolveClosed = resolve; });
      /** @type {Set<(frame: any) => void>} */
      const listeners = new Set();
      /** @type {any} */
      const connection = {
        closed,
        token,
        sent: /** @type {any[]} */ ([]),
        close: () => resolveClosed(undefined),
        async send(/** @type {any} */ message) { connection.sent.push(message); },
        async request() { return undefined; },
        /** @param {(frame: any) => void} listener */
        onMessage(listener) {
          listeners.add(listener);
          queueMicrotask(() => { for (const frame of frames) { if (listeners.has(listener)) listener(frame); } });
          return () => listeners.delete(listener);
        },
      };
      opened.push(connection);
      return connection;
    },
  };
}

/**
 * A minimal stand-in for the daemon's end of a worker socket.
 *
 * The worker listens and the daemon connects, so this is a client: it opens each run's socket with
 * that run's token, correlates command replies, and applies worker events with the production
 * reducer. It exists so a supervisor test can drive real worker processes without a whole daemon
 * runtime, and it is passed to the router as the connect seam the daemon otherwise supplies.
 *
 * @param {{ registry: any }} options
 */
export function createWorkerControlClient({ registry }) {
  /** @type {any[]} */
  const frames = [];
  /** @type {Set<any>} */
  const connections = new Set();
  /** @type {Map<string, any>} */
  const pending = new Map();
  /** @type {any} */
  let routeMetadata;

  /** @param {{ socketPath: string, token: string, maxBytes: number, timeoutMs: number }} options */
  const connect = async (options) => {
    const transport = await connectToWorker(options);
    const connection = {
      closed: transport.closed,
      close: transport.close,
      send: transport.send,
      onMessage: transport.onMessage,
      /** @param {any} message */
      request: (message) => new Promise((resolve, reject) => {
        pending.set(message.id, { resolve, reject });
        Promise.resolve(transport.send(message)).catch(reject);
      }),
    };
    connections.add(connection);
    transport.closed.then(() => connections.delete(connection), () => {});
    return connection;
  };

  /** @param {any} frame @param {any} connection @param {any} metadata */
  const onWorkerFrame = async (frame, connection, metadata) => {
    frames.push(frame);
    if (frame.type === "command_result") {
      const request = pending.get(frame.id);
      pending.delete(frame.id);
      frame.ok ? request?.resolve(frame.record) : request?.reject(Object.assign(new Error(frame.error?.message ?? "failed"), frame.error));
      return;
    }
    if (frame.type !== "worker_event" || routeMetadata === undefined) return;
    const current = await registry.get(frame.sessionId);
    if (current?.ownership?.runId !== routeMetadata.runId) return;
    const next = reduceSessionState(current, frame.event);
    if (next !== current) await registry.update(frame.sessionId, current.revision, { taskState: next.taskState, processState: next.processState, outcome: next.outcome, activity: next.activity, updatedAt: next.updatedAt });
    if (frame.event?.type === "PI_CHILD_CRASHED" && metadata !== undefined) {
      await connection.send({ version: 1, type: "terminal_cause_ack", token: metadata.token, sessionId: metadata.sessionId, runId: metadata.runId, leaseId: metadata.leaseId, generation: metadata.generation });
    }
  };

  return {
    frames,
    routerSeams: { connect, onWorkerFrame, onRouteAdopted: async (/** @type {any} */ route) => { routeMetadata = route.metadata; } },
    async close() {
      for (const connection of [...connections]) connection.close();
      connections.clear();
    },
  };
}
