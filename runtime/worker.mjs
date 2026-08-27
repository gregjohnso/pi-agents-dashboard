import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { openDurableAppendStore } from "./append-store.mjs";
import { validateWorkerReplayRecord } from "./worker-replay-contract.mjs";
import { initializeRuntimePermissions } from "./permissions.mjs";
import { runInstalledPiWorker } from "./installed-pi-worker.mjs";

initializeRuntimePermissions();

const MAX_REPLAY_RECORD_BYTES = 1024 * 1024;
const WORKER_OPERATIONS = new Set(["prompt", "steer", "follow_up", "interrupt", "ui_response", "get_state", "get_session_commands", "session_command", "session_query"]);
const MAX_MENU_ENTRIES = 1_000;
const MAX_QUERY_ROWS = 500;
const QUEUE_MODES = ["all", "one-at-a-time"];

/** @param {any} value @param {string} fallbackSource */
function menuCommand(value, fallbackSource) {
  const name = typeof value?.name === "string" ? value.name.trim() : "";
  if (name.length === 0) return undefined;
  const source = ["extension", "prompt", "skill"].includes(value?.source) ? value.source : fallbackSource;
  /** @type {Record<string, string>} */
  const command = { name: name.startsWith("/") ? name : `/${name}`, source };
  if (typeof value?.description === "string" && value.description.length > 0) command.description = value.description;
  if (typeof value?.argumentHint === "string" && value.argumentHint.length > 0) command.argumentHint = value.argumentHint;
  return command;
}

/** Collect one bounded, normalized slash-command menu from public Pi RPC discovery. @param {any} adapter */
export async function collectSessionMenu(adapter) {
  const state = await adapter.getState();
  const discovered = typeof adapter.getCommands === "function" ? await adapter.getCommands().catch(() => undefined) : undefined;
  const available = typeof adapter.getAvailableModels === "function" ? await adapter.getAvailableModels().catch(() => undefined) : undefined;
  const levels = typeof adapter.getAvailableThinkingLevels === "function" ? await adapter.getAvailableThinkingLevels().catch(() => undefined) : undefined;
  const commands = (Array.isArray(discovered?.commands) ? discovered.commands : [])
    .map((/** @type {any} */ entry) => menuCommand(entry, "extension"))
    .filter((/** @type {any} */ entry) => entry !== undefined)
    .slice(0, MAX_MENU_ENTRIES);
  const models = (Array.isArray(available?.models) ? available.models : [])
    .filter((/** @type {any} */ model) => typeof model?.provider === "string" && model.provider.length > 0 && typeof model?.id === "string" && model.id.length > 0)
    .map((/** @type {any} */ model) => ({ provider: model.provider, id: model.id }))
    .slice(0, MAX_MENU_ENTRIES);
  const thinkingLevels = (Array.isArray(levels?.levels) ? levels.levels : [])
    .filter((/** @type {unknown} */ level) => typeof level === "string" && level.length > 0)
    .slice(0, MAX_MENU_ENTRIES);
  const model = typeof state?.model?.provider === "string" && typeof state?.model?.id === "string" ? { provider: state.model.provider, id: state.model.id } : null;
  return { commands, models, thinkingLevels, model, thinkingLevel: typeof state?.thinkingLevel === "string" && state.thinkingLevel.length > 0 ? state.thinkingLevel : null };
}

/** Reject an unusable session command before any Pi write, so failures are never ambiguous. @param {any} request */
function assertSessionCommand(request) {
  const invalid = (/** @type {string} */ message) => Object.assign(new TypeError(message), { code: "INVALID_SESSION_COMMAND" });
  if (request?.command === "set_model") {
    if (typeof request.model?.provider !== "string" || typeof request.model?.id !== "string") throw invalid("session_command model is invalid");
    return;
  }
  if (request?.command === "set_thinking_level") {
    if (typeof request.level !== "string" || request.level.length === 0) throw invalid("session_command level is invalid");
    return;
  }
  if (request?.command === "set_session_name") {
    if (typeof request.name !== "string" || request.name.trim().length === 0) throw invalid("session_command name is invalid");
    return;
  }
  if (request?.command === "set_auto_compaction" || request?.command === "set_auto_retry") {
    if (typeof request.enabled !== "boolean") throw invalid("session_command enabled is invalid");
    return;
  }
  if (request?.command === "set_steering_mode" || request?.command === "set_follow_up_mode") {
    if (!QUEUE_MODES.includes(request.mode)) throw invalid("session_command mode is invalid");
    return;
  }
  if (request?.command === "abort_retry") return;
  if (request?.command !== "compact") throw invalid(`session_command is unsupported: ${request?.command ?? "missing"}`);
}

/** @param {any} adapter @param {any} request */
function applySessionCommand(adapter, request) {
  if (request.command === "set_model") return adapter.setModel({ provider: request.model.provider, id: request.model.id });
  if (request.command === "set_thinking_level") return adapter.setThinkingLevel(request.level);
  if (request.command === "set_session_name") return adapter.setSessionName(request.name.trim());
  if (request.command === "set_auto_compaction") return adapter.setAutoCompaction(request.enabled);
  if (request.command === "set_auto_retry") return adapter.setAutoRetry(request.enabled);
  if (request.command === "abort_retry") return adapter.abortRetry();
  if (request.command === "set_steering_mode") return adapter.setSteeringMode(request.mode);
  if (request.command === "set_follow_up_mode") return adapter.setFollowUpMode(request.mode);
  return adapter.compact(typeof request.instructions === "string" && request.instructions.length > 0 ? request.instructions : undefined);
}

/** @param {unknown} value @param {string} label @param {string[]} rows @param {number} depth */
function flattenRows(value, label, rows, depth = 0) {
  if (rows.length >= MAX_QUERY_ROWS) return rows;
  if (value === null || typeof value !== "object") {
    rows.push(`${label}: ${String(value)}`.slice(0, 2_000));
    return rows;
  }
  if (depth >= 3) {
    rows.push(`${label}: ${Array.isArray(value) ? `${value.length} entries` : "…"}`.slice(0, 2_000));
    return rows;
  }
  const entries = Array.isArray(value)
    ? value.slice(0, MAX_QUERY_ROWS).map((/** @type {unknown} */ entry, /** @type {number} */ index) => [`${label}[${index}]`, entry])
    : Object.entries(value).map(([key, entry]) => [label === "" ? key : `${label}.${key}`, entry]);
  for (const [childLabel, entry] of entries) flattenRows(entry, /** @type {string} */ (childLabel), rows, depth + 1);
  return rows;
}

/** Render one read-only Pi query as bounded display rows. @param {any} adapter @param {any} request */
async function runSessionQuery(adapter, request) {
  if (request?.query === "get_session_stats") return flattenRows(await adapter.getSessionStats(), "", []);
  if (request?.query === "get_tree") {
    const tree = await adapter.getTree();
    return flattenRows({ leafId: tree?.leafId ?? null, tree: tree?.tree ?? null }, "", []);
  }
  if (request?.query === "export_html") {
    const exported = await adapter.exportHtml(typeof request.outputPath === "string" && request.outputPath.length > 0 ? request.outputPath : undefined);
    return [`Exported to ${exported?.path ?? "an unreported path"}`];
  }
  throw Object.assign(new TypeError(`session_query is unsupported: ${request?.query ?? "missing"}`), { code: "INVALID_SESSION_QUERY" });
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
      if (!validateWorkerReplayRecord(value)) throw new Error("Worker replay contains an invalid record");
      records.set(`${value.clientId}\0${value.requestId}`, value);
    });
  }

  /** @param {any} record */
  async function append(record) {
    const complete = { ...record, at: record.at ?? now() };
    if (!validateWorkerReplayRecord(complete)) throw new TypeError("Invalid worker replay record");
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

  /** @param {{ clientId: string, requestId: string, op: string, text?: string, response?: unknown, sessionCommand?: any, sessionQuery?: any, retryAtRisk?: boolean }} command */
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
      if (command.op === "session_command") {
        try {
          assertSessionCommand(command.sessionCommand);
        } catch (cause) {
          const failure = /** @type {any} */ (cause);
          await replay.append({ ...base, stage: "FAILED", error: { code: failure.code, message: failure.message, retryable: false } });
          throw cause;
        }
      }

      await replay.append({ ...base, stage: "RPC_WRITE_STARTED" });
      let resultValue;
      try {
        switch (command.op) {
          case "prompt": resultValue = await adapter.prompt(command.text); break;
          case "steer": resultValue = await adapter.steer(command.text); break;
          case "follow_up": resultValue = await adapter.followUp(command.text); break;
          case "interrupt": resultValue = await adapter.abort(); break;
          case "ui_response": resultValue = await adapter.uiResponse(command.response); break;
          case "get_state": resultValue = await adapter.getState(); break;
          case "get_session_commands": resultValue = await collectSessionMenu(adapter); break;
          case "session_command": resultValue = await applySessionCommand(adapter, command.sessionCommand); break;
          case "session_query": resultValue = await runSessionQuery(adapter, command.sessionQuery); break;
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

export async function runWorker(runtimeProcess = process) {
  return runInstalledPiWorker(runtimeProcess, { createWorkerReplayStore, createWorkerCommandDispatcher, replayDeliveryIsAmbiguous, maintainDaemonConnection });
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runWorker().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.disconnect?.();
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {
      process.exit(1);
    }
  });
}
