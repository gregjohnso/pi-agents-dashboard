import { createHash, timingSafeEqual } from "node:crypto";
import { PassThrough } from "node:stream";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { openDurableAppendStore } from "./append-store.mjs";
import { PiRpcAdapter } from "./pi-rpc-adapter.mjs";
import { initializeRuntimePermissions } from "./permissions.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";

initializeRuntimePermissions();

const MAX_REPLAY_RECORD_BYTES = 1024 * 1024;
const REPLAY_STAGES = new Set(["RECEIVED", "RPC_WRITE_STARTED", "RPC_ACKNOWLEDGED", "DELIVERY_UNKNOWN", "FAILED"]);
const WORKER_OPERATIONS = new Set(["prompt", "steer", "follow_up", "interrupt", "get_state"]);

/** @param {string} value */
function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

/** @param {unknown} supplied @param {string} expected */
function matchesToken(supplied, expected) {
  return timingSafeEqual(digest(typeof supplied === "string" ? supplied : ""), digest(expected)) && typeof supplied === "string";
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isReplayRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return typeof record.clientId === "string" && record.clientId.length > 0 &&
    typeof record.requestId === "string" && record.requestId.length > 0 &&
    typeof record.op === "string" && REPLAY_STAGES.has(/** @type {string} */ (record.stage)) &&
    typeof record.at === "string";
}

/**
 * Open the worker's durable replay boundary, or use an injected durable append seam.
 * @param {{ path?: string, append?: (record: any) => Promise<unknown>, now?: () => string }} options
 */
export async function createWorkerReplayStore({ path, append: injectedAppend, now = () => new Date().toISOString() }) {
  const records = new Map();
  /** @type {Awaited<ReturnType<typeof openDurableAppendStore>> | undefined} */
  let store;
  if (injectedAppend === undefined) {
    if (typeof path !== "string") throw new TypeError("Worker replay path is required");
    store = await openDurableAppendStore({ path, maxRecordBytes: MAX_REPLAY_RECORD_BYTES });
    await store.recoverRecords((value) => {
      if (!isReplayRecord(value)) throw new Error("Worker replay contains an invalid record");
      records.set(`${value.clientId}\0${value.requestId}`, value);
    });
  }

  /** @param {any} record */
  async function append(record) {
    const complete = { ...record, at: record.at ?? now() };
    if (!isReplayRecord(complete)) throw new TypeError("Invalid worker replay record");
    if (injectedAppend !== undefined) {
      await injectedAppend(complete);
    } else {
      await store?.write(complete);
      await store?.sync();
    }
    records.set(`${complete.clientId}\0${complete.requestId}`, complete);
    return complete;
  }

  for (const record of [...records.values()]) {
    if (record.stage === "RPC_WRITE_STARTED") {
      await append({ ...record, stage: "DELIVERY_UNKNOWN" });
    }
  }

  return {
    append,
    /** @param {{ clientId: string, requestId: string }} key */
    current(key) { return records.get(`${key.clientId}\0${key.requestId}`); },
    async close() { await store?.close(); },
  };
}

/** @param {any} replay @param {{ clientId: string, requestId: string }} command */
export function replayDeliveryIsAmbiguous(replay, command) {
  return ["RPC_WRITE_STARTED", "DELIVERY_UNKNOWN"].includes(replay.current(command)?.stage);
}

/**
 * Deliver same-session commands serially across the durable Pi write boundary.
 * @param {{ replay: any, adapter: any }} options
 */
export function createWorkerCommandDispatcher({ replay, adapter }) {
  let tail = Promise.resolve();

  /** @param {{ clientId: string, requestId: string, op: string, text?: string, retryAtRisk?: boolean }} command */
  function deliver(command) {
    const result = tail.then(async () => {
      if (typeof command?.clientId !== "string" || typeof command.requestId !== "string") {
        throw new TypeError("Worker command requires exact client and request IDs");
      }
      const existing = replay.current(command);
      if (existing?.stage === "RPC_ACKNOWLEDGED") return existing;
      if (existing?.stage === "DELIVERY_UNKNOWN" && command.retryAtRisk !== true) {
        throw Object.assign(new Error("Pi delivery is ambiguous"), { code: "DELIVERY_UNKNOWN" });
      }
      if (existing?.stage === "FAILED") {
        throw Object.assign(new Error(existing.error?.message ?? "Pi delivery failed"), { code: existing.error?.code ?? "RPC_FAILED" });
      }

      const base = { clientId: command.clientId, requestId: command.requestId, op: command.op };
      if (existing === undefined || existing.stage === "DELIVERY_UNKNOWN") await replay.append({ ...base, stage: "RECEIVED" });
      if (!WORKER_OPERATIONS.has(command.op)) {
        const cause = Object.assign(new Error(`Unsupported worker operation: ${command.op}`), { code: "UNSUPPORTED_WORKER_OPERATION" });
        await replay.append({ ...base, stage: "FAILED", error: { code: cause.code, message: cause.message, retryable: false } });
        throw cause;
      }

      await replay.append({ ...base, stage: "RPC_WRITE_STARTED" });
      let resultValue;
      try {
        switch (command.op) {
          case "prompt": resultValue = await adapter.prompt(command.text); break;
          case "steer": resultValue = await adapter.steer(command.text); break;
          case "follow_up": resultValue = await adapter.followUp(command.text); break;
          case "interrupt": resultValue = await adapter.abort(); break;
          case "get_state": resultValue = await adapter.getState(); break;
        }
      } catch (cause) {
        const failure = /** @type {{ code?: unknown, acknowledged?: unknown }} */ (cause);
        const error = {
          code: typeof failure?.code === "string" ? failure.code : "RPC_FAILED",
          message: cause instanceof Error ? cause.message : "Pi RPC failed",
          retryable: false,
        };
        const stderr = adapter.getStderr?.() ?? "";
        if (failure.acknowledged === true) {
          await replay.append({ ...base, stage: "RPC_ACKNOWLEDGED", error, stderr });
          await replay.append({ ...base, stage: "FAILED", error, stderr });
          throw cause;
        }
        let appendFailure;
        try {
          await replay.append({ ...base, stage: "DELIVERY_UNKNOWN", error, stderr });
        } catch (persistenceCause) {
          appendFailure = persistenceCause;
        }
        throw Object.assign(new Error("Pi delivery is ambiguous", { cause: appendFailure ?? cause }), {
          code: "DELIVERY_UNKNOWN",
          deliveryUnknown: true,
          rpcCause: cause,
          appendFailure,
        });
      }
      try {
        return await replay.append({ ...base, stage: "RPC_ACKNOWLEDGED", result: resultValue });
      } catch (cause) {
        let appendFailure;
        try {
          await replay.append({ ...base, stage: "DELIVERY_UNKNOWN", error: { code: "ACK_PERSISTENCE_FAILED", message: cause instanceof Error ? cause.message : "Pi acknowledgement persistence failed", retryable: false } });
        } catch (persistenceCause) {
          appendFailure = persistenceCause;
        }
        throw Object.assign(new Error("Pi delivery is ambiguous", { cause: appendFailure ?? cause }), {
          code: "DELIVERY_UNKNOWN",
          deliveryUnknown: true,
          rpcCause: cause,
          appendFailure,
        });
      }
    });
    tail = result.then(() => {}, () => {});
    return result;
  }

  return { deliver, async close() { await tail; await replay.close(); } };
}

/** @param {{ close?: () => unknown } | undefined} connection */
function closeConnectionBestEffort(connection) {
  try {
    void Promise.resolve(connection?.close?.()).catch(() => {});
  } catch {
  }
}

/**
 * A module named by `--daemon-connector` exports `connectDaemon({ config, signal })`.
 * Its connection exposes `closed`, `close`, `onMessage(listener)`, and `send(message)`.
 *
 * Maintain a daemon transport without coupling its lifetime to the Pi adapter.
 * @param {{ connect: () => Promise<{ closed: Promise<unknown>, close?: () => unknown }>, onConnection: (connection: unknown) => Promise<void> | void, delaysMs: readonly number[], sleep: (ms: number) => Promise<void>, signal?: AbortSignal }} options
 */
export async function maintainDaemonConnection({ connect, onConnection, delaysMs, sleep, signal }) {
  if (typeof connect !== "function" || typeof onConnection !== "function" || typeof sleep !== "function") {
    throw new TypeError("Reconnect dependencies must be functions");
  }
  if (!Array.isArray(delaysMs) || delaysMs.length === 0 || delaysMs.some((delay) => !Number.isSafeInteger(delay) || delay <= 0)) {
    throw new TypeError("Reconnect delays must contain positive integers");
  }
  let failureCount = 0;
  while (!signal?.aborted) {
    /** @type {{ closed: Promise<unknown>, close?: () => unknown } | undefined} */
    let connection;
    try {
      connection = await connect();
      await onConnection(connection);
      failureCount = 0;
      if (!signal?.aborted) {
        await new Promise((resolveClosed) => {
          const activeConnection = /** @type {{ closed: Promise<unknown>, close?: () => unknown }} */ (connection);
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolveClosed(undefined);
          };
          const onAbort = () => {
            closeConnectionBestEffort(activeConnection);
            finish();
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          Promise.resolve(activeConnection.closed).then(finish, finish);
          if (signal?.aborted) onAbort();
        });
      }
    } catch {
    } finally {
      closeConnectionBestEffort(connection);
    }
    if (signal?.aborted) return;
    const delay = delaysMs[Math.min(failureCount, delaysMs.length - 1)];
    failureCount += 1;
    try {
      await sleep(delay);
    } catch {
    }
  }
}

/** @param {Record<string, unknown>} event @returns {any | undefined} */
function sessionEventForRpc(event) {
  const at = new Date().toISOString();
  switch (event.type) {
    case "agent_start": return { type: "TURN_STARTED", at };
    case "agent_settled": return { type: "TURN_COMPLETED", at };
    case "extension_ui_request": return { type: "UI_REQUESTED", at, summary: "Waiting for Pi extension input" };
    case "tool_execution_start": return { type: "ACTIVITY_SNAPSHOT", at, tool: { summary: typeof event.toolName === "string" ? event.toolName : "Pi tool running" } };
    case "message_update": return { type: "ACTIVITY_SNAPSHOT", at, assistantStream: { summary: "Pi assistant streaming" } };
    case "message_end": return { type: "ACTIVITY_SNAPSHOT", at, finalAssistant: { summary: "Pi assistant response received" } };
    default: return undefined;
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new TypeError("Worker arguments must be flag/value pairs");
    values.set(key.slice(2), value);
  }
  for (const required of ["session-id", "canonical-session-file", "cwd", "run-id", "lease-id", "generation", "replay-path", "rpc-entry"]) {
    if (!values.has(required)) throw new TypeError(`Missing worker argument: --${required}`);
  }
  const generation = Number(values.get("generation"));
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new TypeError("Worker generation must be positive");
  let daemonConnectConfig;
  let reconnectDelaysMs;
  if (values.has("daemon-connector")) {
    try {
      daemonConnectConfig = JSON.parse(values.get("daemon-connect-config") ?? "{}");
      reconnectDelaysMs = JSON.parse(values.get("reconnect-delays-ms") ?? "[100,250,500,1000,2000]");
    } catch (cause) {
      throw new TypeError("Worker daemon connection configuration must be valid JSON", { cause });
    }
    if (typeof daemonConnectConfig !== "object" || daemonConnectConfig === null || Array.isArray(daemonConnectConfig)) {
      throw new TypeError("Worker daemon connection configuration must be an object");
    }
    if (!Array.isArray(reconnectDelaysMs) || reconnectDelaysMs.length === 0 || reconnectDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay <= 0)) {
      throw new TypeError("Worker reconnect delays must contain positive integers");
    }
  }
  return {
    sessionId: values.get("session-id"),
    canonicalSessionFile: values.get("canonical-session-file"),
    cwd: values.get("cwd"),
    runId: values.get("run-id"),
    leaseId: values.get("lease-id"),
    generation,
    replayPath: values.get("replay-path"),
    rpcEntry: values.get("rpc-entry"),
    model: values.has("model-provider") ? { provider: values.get("model-provider"), id: values.get("model-id") } : undefined,
    thinkingLevel: values.get("thinking-level"),
    name: values.get("name"),
    daemonConnector: values.get("daemon-connector"),
    daemonConnectConfig,
    reconnectDelaysMs,
  };
}

/** @param {NodeJS.Process} runtimeProcess */
export async function runWorker(runtimeProcess = process) {
  const options = parseArgs(runtimeProcess.argv.slice(2));
  const token = runtimeProcess.env.PI_DASHBOARD_WORKER_TOKEN;
  if (typeof token !== "string" || token.length === 0 || typeof runtimeProcess.send !== "function") {
    throw new Error("Worker requires an authenticated IPC launch channel");
  }
  const identity = await inspectProcessIdentity(runtimeProcess.pid);
  runtimeProcess.send({
    version: 1,
    type: "worker_hello",
    token,
    sessionId: options.sessionId,
    runId: options.runId,
    leaseId: options.leaseId,
    generation: options.generation,
    worker: identity,
    piChild: identity,
  });

  const activation = /** @type {any} */ (await new Promise((resolveActivation, rejectActivation) => {
    /** @param {any} message */
    const onMessage = (message) => {
      if (message?.type === "reject") {
        finish(Object.assign(new Error("Worker launch rejected"), { code: "WORKER_REJECTED" }));
      } else if (message?.type === "activate") {
        finish(undefined, message);
      }
    };
    const onDisconnect = () => finish(Object.assign(new Error("Worker launch channel closed before activation"), { code: "WORKER_DISCONNECTED" }));
    /** @param {unknown} [error] @param {any} [message] */
    const finish = (error, message) => {
      runtimeProcess.off("message", onMessage);
      runtimeProcess.off("disconnect", onDisconnect);
      if (error !== undefined) rejectActivation(error);
      else resolveActivation(message);
    };
    runtimeProcess.on("message", onMessage);
    runtimeProcess.once("disconnect", onDisconnect);
  }));
  if (!matchesToken(activation.token, token) || activation.leaseId !== options.leaseId || activation.generation !== options.generation) {
    throw Object.assign(new Error("Worker activation did not match the ownership lease"), { code: "WORKER_ACTIVATION_MISMATCH" });
  }

  let reconnectStarted = false;
  /** @type {(transport: any) => void} */
  let resolveTransportReady = () => {};
  const transportReady = new Promise((resolveReady) => { resolveTransportReady = resolveReady; });
  const reconnectController = new AbortController();
  const startReconnect = () => {
    if (reconnectStarted || options.daemonConnector === undefined) return;
    reconnectStarted = true;
    void transportReady.then((/** @type {any} */ transport) => maintainDaemonConnection({
      signal: reconnectController.signal,
      delaysMs: options.reconnectDelaysMs ?? [100, 250, 500, 1_000, 2_000],
      sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
      connect: async () => {
        const connectorTarget = options.daemonConnector.startsWith("file:") ? options.daemonConnector : pathToFileURL(options.daemonConnector).href;
        const connector = await import(connectorTarget);
        if (typeof connector.connectDaemon !== "function") throw new TypeError("Daemon connector must export connectDaemon");
        return connector.connectDaemon({ config: options.daemonConnectConfig, signal: reconnectController.signal });
      },
      onConnection: transport.onConnection,
    })).catch((error) => {
      if (!reconnectController.signal.aborted) runtimeProcess.stderr.write(`Daemon reconnect stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  runtimeProcess.once("disconnect", startReconnect);
  if (runtimeProcess.connected === false) startReconnect();

  /** @type {((message: any) => Promise<unknown>) | undefined} */
  let sendToDaemon;
  /** @param {any} message */
  const sendWorkerMessage = (message) => {
    if (runtimeProcess.connected) {
      runtimeProcess.send?.(message);
    } else {
      void sendToDaemon?.(message).catch(() => {});
    }
  };

  const rpcInput = new PassThrough();
  const rpcOutput = new PassThrough();
  Object.defineProperty(runtimeProcess, "stdin", { configurable: true, enumerable: true, value: rpcInput });
  Object.defineProperty(runtimeProcess, "stdout", { configurable: true, enumerable: true, value: rpcOutput });
  const adapter = PiRpcAdapter.connect({ input: rpcInput, output: rpcOutput });
  adapter.onEvent((event) => {
    const stateEvent = sessionEventForRpc(event);
    if (stateEvent !== undefined) {
      sendWorkerMessage({ version: 1, type: "worker_event", token, sessionId: options.sessionId, event: stateEvent });
    }
  });
  const rpcArgv = [options.rpcEntry, "--session", options.canonicalSessionFile];
  if (options.model !== undefined) rpcArgv.push("--provider", options.model.provider, "--model", options.model.id);
  if (options.thinkingLevel !== undefined) rpcArgv.push("--thinking", options.thinkingLevel);
  if (options.name !== undefined) rpcArgv.push("--name", options.name);
  runtimeProcess.argv = [runtimeProcess.execPath, ...rpcArgv];
  const importTarget = options.rpcEntry.startsWith("file:") ? options.rpcEntry : pathToFileURL(options.rpcEntry).href;
  await import(importTarget);
  await adapter.getState();

  const replay = await createWorkerReplayStore({ path: options.replayPath });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    reconnectController.abort();
    await dispatcher.close().catch(() => {});
    await adapter.close().catch(() => {});
    runtimeProcess.exit(0);
  };
  /** @param {any} message @param {(response: any) => Promise<unknown> | unknown} send */
  const onTransportMessage = (message, send) => {
    if (!matchesToken(message?.token, token)) return;
    if (message.type === "shutdown") {
      void shutdown();
      return;
    }
    if (message.type !== "command") return;
    dispatcher.deliver(message.command).then(
      (record) => send({ version: 1, type: "command_result", token, id: message.id, ok: true, record }),
      (error) => send({
        version: 1,
        type: "command_result",
        token,
        id: message.id,
        ok: false,
        error: {
          code: error?.code ?? "RPC_FAILED",
          message: error instanceof Error ? error.message : "RPC failed",
          deliveryUnknown: error?.deliveryUnknown === true || replayDeliveryIsAmbiguous(replay, message.command),
        },
      }),
    ).catch(() => {});
  };
  runtimeProcess.on("message", (message) => onTransportMessage(message, (response) => runtimeProcess.send?.(response)));
  resolveTransportReady({
    onConnection: async (/** @type {any} */ connection) => {
      if (typeof connection?.onMessage !== "function" || typeof connection?.send !== "function" || typeof connection?.closed?.then !== "function") {
        throw new TypeError("Daemon connector returned an invalid connection");
      }
      const connectionSend = (/** @type {any} */ message) => Promise.resolve(connection.send(message));
      sendToDaemon = connectionSend;
      /** @type {(() => unknown) | undefined} */
      let removeMessageListener;
      let disposed = false;
      const disposeConnection = () => {
        if (disposed) return;
        disposed = true;
        reconnectController.signal.removeEventListener("abort", disposeConnection);
        if (sendToDaemon === connectionSend) sendToDaemon = undefined;
        try {
          removeMessageListener?.();
        } catch {
        }
      };
      try {
        removeMessageListener = connection.onMessage((/** @type {any} */ message) => onTransportMessage(message, connectionSend));
        reconnectController.signal.addEventListener("abort", disposeConnection, { once: true });
        Promise.resolve(connection.closed).finally(disposeConnection).catch(() => {});
        if (reconnectController.signal.aborted) {
          disposeConnection();
          return;
        }
        await connectionSend({
          version: 1,
          type: "worker_ready",
          token,
          sessionId: options.sessionId,
          runId: options.runId,
          leaseId: options.leaseId,
          generation: options.generation,
          worker: identity,
          piChild: identity,
        });
      } catch (error) {
        disposeConnection();
        throw error;
      }
    },
  });
  runtimeProcess.send({ version: 1, type: "worker_ready", token, sessionId: options.sessionId, runId: options.runId });

  const testExitMs = Number(runtimeProcess.env.PI_DASHBOARD_TEST_EXIT_MS);
  if (Number.isSafeInteger(testExitMs) && testExitMs > 0) {
    setTimeout(() => runtimeProcess.exit(0), testExitMs);
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runWorker().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
    process.disconnect?.();
  });
}
