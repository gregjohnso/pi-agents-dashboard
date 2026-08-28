import net from "node:net";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { createAttachmentResultStore } from "./attachment-result-store.mjs";
import { atomicWriteJson } from "./atomic-file.mjs";
import { claimDaemonLifecycle, releaseDaemonLifecycle, updateDaemonLifecycleState } from "./daemon-lifecycle.mjs";
import { createJsonlDecoder, createJsonlEncoder, JsonlFramingError } from "./jsonl.mjs";
import { createLaunchResolver } from "./launch-resolver.mjs";
import { sweepStaleWorktreeLocks } from "../isolation/lock-sweep.mjs";
import { ensurePrivateDirectory, initializeRuntimePermissions } from "./permissions.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "./process-signaler.mjs";
import { RecoveredWorkerRouter, reconcileRuntime } from "./reconciliation.mjs";
import { openSettingsStore, summarizePromptInput, summarizeWithPi } from "./summaries.mjs";
import { RegistryStore, applySessionColor, runSessionLifecycle } from "./registry-store.mjs";
import { reduceSessionState } from "./state-reducer.mjs";
import { createIdleExit } from "./idle-exit.mjs";
import { spawn as spawnProcess } from "node:child_process";
import { createModelCatalog } from "./pi-model-catalog.mjs";
import { WorkerSupervisor } from "./worker-supervisor.mjs";
import { loadDashboardConfig } from "../shared/config.mjs";
import { parseClientRequest } from "../shared/contracts.mjs";

initializeRuntimePermissions();

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_REQUESTS = 4096;
const WORKER_DELIVERED_COMMANDS = ["prompt", "steer", "follow_up", "interrupt", "ui_response", "session_command"];
const DURABLE_COMMANDS = new Set([...WORKER_DELIVERED_COMMANDS, "stop", "delete"]);
const CONNECTOR_PATH = fileURLToPath(new URL("./daemon-connector.mjs", import.meta.url));
const DEFAULT_STOP_POLICY = Object.freeze({ gracefulMs: 5_000, terminateMs: 5_000 });

/** @param {unknown} value */
function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : "", "utf8").digest();
}

/** @param {unknown} supplied @param {string} expected */
function sameToken(supplied, expected) {
  return typeof supplied === "string" && timingSafeEqual(digest(supplied), digest(expected));
}

/** @param {string} code @param {string} message @param {boolean} [retryable] */
function dashboardError(code, message, retryable = false) {
  return { code, message, retryable };
}

/** @param {string} requestId @param {any} result */
function response(requestId, result) {
  return { version: 1, requestId, ok: true, result };
}

/** @param {string} requestId @param {any} error */
function failure(requestId, error) {
  return { version: 1, requestId, ok: false, error: dashboardError(error?.code ?? "REQUEST_FAILED", error instanceof Error ? error.message : "Request failed", error?.retryable === true) };
}

/** @param {string} root */
async function ensureLayout(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await ensurePrivateDirectory(root);
  for (const directory of ["daemon", "sessions", "queue", "runs", "index"]) await ensurePrivateDirectory(join(root, directory));
}

/** @param {string} path */
async function readPrivateText(path) {
  try {
    const metadata = await fs.lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw new Error(`Private artifact is unsafe: ${path}`);
    const value = (await fs.readFile(path, "utf8")).trim();
    if (value.length === 0) throw new Error(`Private artifact is empty: ${path}`);
    return value;
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined;
    throw error;
  }
}

/** @param {string} path @param {() => string} create */
async function privateText(path, create) {
  const existing = await readPrivateText(path);
  if (existing !== undefined) return existing;
  const value = create();
  const handle = await fs.open(path, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${value}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return value;
}

async function checkDefaultHost() {
  return { blockers: [], daemonOwnedStartup: true };
}

/** @param {string} path @param {string} daemonEpoch */
async function createCursorStore(path, daemonEpoch) {
  /** @type {Record<string, { daemonEpoch: string, sequence: string }>} */
  let cursors = {};
  try {
    const value = JSON.parse(await fs.readFile(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Event cursor store is invalid");
    for (const [clientId, cursor] of Object.entries(value)) {
      if (clientId.length === 0 || typeof cursor !== "object" || cursor === null || /** @type {any} */ (cursor).daemonEpoch !== daemonEpoch || !/^(0|[1-9]\d*)$/u.test(/** @type {any} */ (cursor).sequence) || Object.keys(cursor).some((key) => !["daemonEpoch", "sequence"].includes(key))) throw new TypeError("Event cursor store is invalid");
    }
    cursors = /** @type {any} */ (value);
  } catch (error) {
    if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
  let tail = Promise.resolve();
  return {
    /** @param {string} clientId @param {{ daemonEpoch: string, sequence: string }} cursor @param {{ daemonEpoch: string, sequence: string }} maximum */
    acknowledge(clientId, cursor, maximum) {
      const result = tail.then(async () => {
        if (cursor.daemonEpoch !== daemonEpoch || maximum.daemonEpoch !== daemonEpoch || !/^(0|[1-9]\d*)$/u.test(cursor.sequence)) throw Object.assign(new Error("Cursor epoch or sequence is invalid"), { code: "INVALID_CURSOR" });
        const sequence = BigInt(cursor.sequence);
        if (sequence > BigInt(maximum.sequence)) throw Object.assign(new Error("Cursor is ahead of the event store"), { code: "INVALID_CURSOR" });
        const previous = cursors[clientId];
        if (previous !== undefined && BigInt(previous.sequence) >= sequence) return previous;
        const accepted = { daemonEpoch, sequence: String(sequence) };
        cursors = { ...cursors, [clientId]: accepted };
        await atomicWriteJson(path, cursors);
        return accepted;
      });
      tail = result.then(() => {}, () => {});
      return result;
    },
    async close() { await tail; },
  };
}

/** @param {string} path */
async function createLaunchResultStore(path) {
  /** @type {Record<string, { sessionId: string }>} */
  let results = {};
  try {
    const value = JSON.parse(await fs.readFile(path, "utf8"));
    if (value?.schemaVersion !== 1 || typeof value.results !== "object" || value.results === null || Array.isArray(value.results) || Object.keys(value).some((key) => !["schemaVersion", "results"].includes(key))) throw new TypeError("Launch result store is invalid");
    for (const result of Object.values(value.results)) if (typeof result?.sessionId !== "string" || result.sessionId.length === 0 || Object.keys(result).some((key) => key !== "sessionId")) throw new TypeError("Launch result store is invalid");
    results = value.results;
  } catch (error) {
    if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
  let tail = Promise.resolve();
  const key = (/** @type {any} */ request) => `${request.clientId}\0${request.requestId}`;
  return {
    /** @param {any} request */
    get(request) { return results[key(request)]; },
    /** @param {any} request @param {{ sessionId: string }} result */
    put(request, result) {
      const operation = tail.then(async () => {
        const existing = results[key(request)];
        if (existing !== undefined && existing.sessionId !== result.sessionId) throw Object.assign(new Error("Launch result conflicts with the durable request"), { code: "IDEMPOTENCY_CONFLICT" });
        if (existing !== undefined) return existing;
        results = { ...results, [key(request)]: result };
        await atomicWriteJson(path, { schemaVersion: 1, results });
        return result;
      });
      tail = operation.then(() => {}, () => {});
      return operation;
    },
    async close() { await tail; },
  };
}

/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** @param {string} path */
async function createDeleteResultStore(path) {
  /** @type {Record<string, any>} */
  let entries = {};
  try {
    const value = JSON.parse(await fs.readFile(path, "utf8"));
    if (value?.schemaVersion !== 1 || typeof value.entries !== "object" || value.entries === null || Array.isArray(value.entries) || Object.keys(value).some((key) => !["schemaVersion", "entries"].includes(key))) throw new TypeError("Delete recovery store is invalid");
    for (const entry of Object.values(value.entries)) {
      const allowed = ["request", "sessionId", "revision", "canonicalSessionFile", "recordCanonical", "identity", "phase"];
      const identity = /** @type {any} */ (entry)?.identity;
      const identityKeys = ["path", "realpath", "type", "dev", "ino", "size", "mtimeMs"];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry) || Object.keys(entry).length !== allowed.length || Object.keys(entry).some((key) => !allowed.includes(key)) || typeof entry.request !== "string" || (typeof entry.sessionId !== "string" || entry.sessionId.length === 0) || !Number.isSafeInteger(entry.revision) || entry.revision < 0 || typeof entry.canonicalSessionFile !== "string" || resolve(entry.canonicalSessionFile) !== entry.canonicalSessionFile || typeof entry.recordCanonical !== "string" || !["PREPARED", "TRASHED"].includes(entry.phase) || typeof identity !== "object" || identity === null || Array.isArray(identity) || Object.keys(identity).length !== identityKeys.length || Object.keys(identity).some((key) => !identityKeys.includes(key)) || identity.path !== entry.canonicalSessionFile || identity.realpath !== entry.canonicalSessionFile || identity.type !== "file" || !Number.isSafeInteger(identity.dev) || identity.dev < 0 || !Number.isSafeInteger(identity.ino) || identity.ino < 0 || !Number.isSafeInteger(identity.size) || identity.size < 0 || typeof identity.mtimeMs !== "number" || !Number.isFinite(identity.mtimeMs) || identity.mtimeMs < 0) throw new TypeError("Delete recovery store is invalid");
    }
    entries = value.entries;
  } catch (error) {
    if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
  let tail = Promise.resolve();
  const key = (/** @type {any} */ request) => `${request.clientId}\0${request.requestId}`;
  const serialized = (/** @type {any} */ request) => JSON.stringify({ op: request.op, payload: request.payload });
  const persist = (/** @type {() => any} */ mutate) => {
    const operation = tail.then(async () => {
      const result = mutate();
      await atomicWriteJson(path, { schemaVersion: 1, entries });
      return result;
    });
    tail = operation.then(() => {}, () => {});
    return operation;
  };
  return {
    /** @param {any} request */
    get(request) {
      const entry = entries[key(request)];
      if (entry !== undefined && entry.request !== serialized(request)) throw Object.assign(new Error("Delete request identity conflicts with recovery state"), { code: "IDEMPOTENCY_CONFLICT" });
      return entry;
    },
    /** @param {any} request @param {any} record @param {any} identity */
    prepare(request, record, identity) {
      return persist(() => {
        const existing = entries[key(request)];
        const candidate = { request: serialized(request), sessionId: record.sessionId, revision: record.revision, canonicalSessionFile: record.canonicalSessionFile, recordCanonical: canonicalJson(record), identity, phase: "PREPARED" };
        if (existing !== undefined) {
          if (JSON.stringify({ ...existing, phase: "PREPARED" }) !== JSON.stringify(candidate)) throw Object.assign(new Error("Delete recovery identity changed"), { code: "IDEMPOTENCY_CONFLICT" });
          return existing;
        }
        entries = { ...entries, [key(request)]: candidate };
        return candidate;
      });
    },
    /** @param {any} request */
    markTrashed(request) {
      return persist(() => {
        const existing = entries[key(request)];
        if (existing === undefined) throw Object.assign(new Error("Delete recovery preparation is missing"), { code: "DELETE_RECOVERY_MISSING" });
        const updated = { ...existing, phase: "TRASHED" };
        entries = { ...entries, [key(request)]: updated };
        return updated;
      });
    },
    async close() { await tail; },
  };
}

/** @param {any} record @param {any} pending */
function validateWorkerSuccess(record, pending) {
  const allowed = ["clientId", "requestId", "op", "stage", "at", "result", "stderr"];
  if (typeof record !== "object" || record === null || Array.isArray(record) || Object.keys(record).some((key) => !allowed.includes(key)) || record.clientId !== pending.clientId || record.requestId !== pending.requestId || record.op !== pending.op || record.stage !== "RPC_ACKNOWLEDGED" || typeof record.at !== "string") throw Object.assign(new Error("Worker result does not match the pending durable command"), { code: "INVALID_WORKER_RESULT" });
}

/** Project one validated session_command payload onto its exact worker request. @param {any} payload */
function sessionCommandPayload(payload) {
  if (payload.command === "set_model") return { command: "set_model", model: { ...payload.model } };
  if (payload.command === "set_thinking_level") return { command: "set_thinking_level", level: payload.level };
  if (payload.command === "set_session_name") return { command: "set_session_name", name: payload.name };
  if (payload.command === "set_auto_compaction" || payload.command === "set_auto_retry") return { command: payload.command, enabled: payload.enabled };
  if (payload.command === "set_steering_mode" || payload.command === "set_follow_up_mode") return { command: payload.command, mode: payload.mode };
  if (payload.command === "abort_retry") return { command: "abort_retry" };
  return payload.instructions === undefined ? { command: "compact" } : { command: "compact", instructions: payload.instructions };
}

/** Report whether an exact recorded process identity is provably gone. @param {any} identity @param {(pid: number) => Promise<any>} inspect */
async function processIsGone(identity, inspect) {
  if (identity?.pid === undefined) return false;
  try {
    return !sameProcessIdentity(await inspect(identity.pid), identity);
  } catch (error) {
    return ["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? "");
  }
}

/** @param {any} left @param {any} right */
function sameProcessIdentity(left, right) {
  return left?.pid === right?.pid && left?.startIdentity === right?.startIdentity && left?.processGroupId === right?.processGroupId;
}

/** Capture a regular, canonical session file identity without following a symlink replacement. @param {string} path */
async function inspectSessionFile(path) {
  if (typeof path !== "string" || resolve(path) !== path) throw Object.assign(new Error("Session file path is not canonical"), { code: "SESSION_PATH_UNSAFE" });
  const metadata = await fs.lstat(path);
  const realpath = await fs.realpath(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || realpath !== path) throw Object.assign(new Error("Session file identity is unsafe"), { code: "SESSION_PATH_UNSAFE" });
  return { path, realpath, type: "file", dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeMs: metadata.mtimeMs };
}

/** @param {any} error */
function validateWorkerFailure(error) {
  if (typeof error !== "object" || error === null || Array.isArray(error) || Object.keys(error).some((key) => !["code", "message", "deliveryUnknown"].includes(key)) || typeof error.code !== "string" || typeof error.message !== "string" || (error.deliveryUnknown !== undefined && typeof error.deliveryUnknown !== "boolean")) throw Object.assign(new Error("Worker failure result is invalid"), { code: "INVALID_WORKER_RESULT" });
}

/** Send one normalized subscription through a single ordered async path. @param {AsyncIterableIterator<any>} subscription @param {(event: any) => Promise<unknown>} write */
export async function pumpViewerSubscription(subscription, write) {
  try {
    for await (const event of subscription) await write(event);
  } finally {
    await subscription.return?.();
  }
}

/** Create one ordered bounded socket writer that waits for callback and drain.
 * @param {any} socket
 * @param {{ maxPendingBytes: number, maxPendingRecords: number }} options
 */
export function createBoundedSocketWriter(socket, { maxPendingBytes, maxPendingRecords }) {
  /** @type {Buffer[]} */
  const queue = [];
  let pendingBytes = 0;
  let writing = false;
  const pump = () => {
    if (writing || socket.destroyed) return;
    const next = queue[0];
    if (next === undefined) return;
    writing = true;
    let callbackDone = false;
    let drained = true;
    const finish = () => {
      if (!callbackDone || !drained || socket.destroyed) return;
      queue.shift();
      pendingBytes -= next.byteLength;
      writing = false;
      pump();
    };
    const accepted = socket.write(next, (/** @type {Error | null} */ error) => {
      if (error) { socket.destroy(); return; }
      callbackDone = true;
      finish();
    });
    if (!accepted) {
      drained = false;
      socket.once("drain", () => { drained = true; finish(); });
    }
  };
  return {
    /** @param {Buffer} encoded */
    enqueue(encoded) {
      if (socket.destroyed) return false;
      if (queue.length >= maxPendingRecords || pendingBytes + encoded.byteLength > maxPendingBytes) {
        socket.destroy(Object.assign(new Error("Subscriber output queue exceeded its bound"), { code: "SUBSCRIBER_BACKPRESSURE_LIMIT" }));
        return false;
      }
      queue.push(encoded);
      pendingBytes += encoded.byteLength;
      pump();
      return true;
    },
  };
}

/** @param {{ socketPath: string, token: string, maxBytes: number, context: any }} options */
function createSocketServer({ socketPath, token, maxBytes, context }) {
  const sockets = new Set();
  const subscribers = new Set();
  const viewerSubscriptions = new Map();
  const broadcastWriters = new Map();
  const chains = new Set();
  let accepting = true;
  /** @type {Promise<void> | undefined} */
  let serverClosed;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (!accepting) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    broadcastWriters.set(socket, createBoundedSocketWriter(socket, { maxPendingBytes: Math.min(4 * maxBytes, 4 * 1024 * 1024), maxPendingRecords: 256 }));
    let authenticated = false;
    let role = "frontend";
    /** @type {string | undefined} */
    let frontendClientId;
    /** @type {any} */
    let workerConnection;
    /** @type {any} */
    let workerMetadata;
    /** @type {number | undefined} */
    let workerRouteGeneration;
    /** @type {Promise<void>} */
    let chain = Promise.resolve();
    const decoder = createJsonlDecoder({ maxBytes });
    const encoder = createJsonlEncoder({ maxBytes });
    /** @type {(value: unknown) => void} */
    let resolveClosed = () => {};
    const closed = new Promise((resolveClosedPromise) => { resolveClosed = resolveClosedPromise; });
    /** @param {any} value */
    const send = (value) => new Promise((resolveWrite, rejectWrite) => {
      if (socket.destroyed) {
        rejectWrite(Object.assign(new Error("Socket is closed"), { code: "SOCKET_CLOSED" }));
        return;
      }
      let encoded;
      try { encoded = encoder.encode(value); } catch (error) { rejectWrite(error); return; }
      socket.write(encoded, (error) => error ? rejectWrite(error) : resolveWrite(undefined));
    });
    const close = () => socket.destroy();
    /** @param {any} message @param {any} expected */
    const requestWorker = (message, expected) => new Promise((resolveRequest, rejectRequest) => {
      const id = message.id;
      const pending = { ...expected, resolve: resolveRequest, reject: rejectRequest, connection: workerConnection };
      context.workerPending.set(id, pending);
      send(message).catch((error) => {
        if (context.workerPending.get(id) !== pending) return;
        context.workerPending.delete(id);
        rejectRequest(error);
      });
    });
    socket.on("close", () => {
      context.markAttachmentClosing(socket);
      sockets.delete(socket);
      subscribers.delete(socket);
      broadcastWriters.delete(socket);
      const activeViewerSubscriptions = viewerSubscriptions.get(socket) ?? [];
      viewerSubscriptions.delete(socket);
      for (const subscription of activeViewerSubscriptions) void subscription.return?.();
      const attachmentRelease = context.releaseAttachments(socket, frontendClientId);
      chains.add(attachmentRelease);
      void attachmentRelease.finally(() => chains.delete(attachmentRelease)).catch(() => {});
      resolveClosed(undefined);
      for (const [id, pending] of context.workerPending) {
        if (pending.connection === workerConnection && context.workerPending.get(id) === pending) {
          context.workerPending.delete(id);
          pending.reject(Object.assign(new Error("Worker delivery became ambiguous"), { code: "DELIVERY_UNKNOWN" }));
        }
      }
    });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (!accepting) return;
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        const code = error instanceof JsonlFramingError ? error.code : "INVALID_FRAME";
        void send({ version: 1, ok: false, error: dashboardError(code, error instanceof Error ? error.message : "Invalid frame") }).finally(() => socket.end());
        return;
      }
      for (const frameValue of frames) {
        const frame = /** @type {any} */ (frameValue);
        const operation = chain.then(async () => {
          if (!context.admissionOpen) throw Object.assign(new Error("Daemon is shutting down"), { code: "SHUTTING_DOWN", retryable: true });
          if (!authenticated) {
            const allowed = ["version", "token", "role", "action"];
            if (typeof frame !== "object" || frame === null || Array.isArray(frame) || Object.keys(frame).some((key) => !allowed.includes(key)) || frame.version !== 1 || !sameToken(frame.token, token) || (frame.role !== undefined && !["frontend", "worker", "control"].includes(frame.role)) || (frame.action !== undefined && (frame.role !== "control" || frame.action !== "stop"))) {
              await send({ version: 1, ok: false, error: dashboardError(frame?.version === 1 ? "AUTHENTICATION_FAILED" : "UNSUPPORTED_VERSION", "Invalid daemon authentication") });
              socket.end();
              return;
            }
            role = frame.role ?? "frontend";
            authenticated = true;
            await send({ version: 1, kind: "authenticated", ...context.publicStatus() });
            if (role === "control") {
              context.requestStop();
              socket.end();
            }
            return;
          }
          if (role === "worker") {
            if (workerConnection === undefined) {
              workerConnection = { closed, close, send, request: requestWorker };
              const route = await context.router.adopt(frame, workerConnection);
              workerMetadata = route.metadata;
              workerRouteGeneration = route.routeGeneration;
              void context.reconcileSessionActivity(route).catch(() => {});
              return;
            }
            await context.handleWorkerFrame(frame, workerConnection, workerMetadata, workerRouteGeneration);
            return;
          }
          let request;
          try {
            request = parseClientRequest(frame);
          } catch (error) {
            const requestError = /** @type {{ code?: string }} */ (error);
            const revisionRequired = requestError?.code === "REVISION_REQUIRED";
            await send({
              version: 1,
              requestId: typeof frame?.requestId === "string" ? frame.requestId : "invalid-request",
              ok: false,
              error: dashboardError(revisionRequired ? "REVISION_REQUIRED" : "INVALID_REQUEST", revisionRequired ? "Stop and Delete require an exact registry revision" : "Invalid client request"),
            });
            return;
          }
          if (frontendClientId === undefined) frontendClientId = request.clientId;
          if (frontendClientId !== request.clientId) {
            await send(failure(request.requestId, Object.assign(new Error("Client identity changed on an authenticated connection"), { code: "CLIENT_IDENTITY_CONFLICT" })));
            return;
          }
          /** @type {AsyncIterableIterator<any> | undefined} */
          let viewerSubscription;
          try {
            const result = await context.handleRequest(request, socket, subscribers, frontendClientId);
            viewerSubscription = result?._viewerSubscription;
            const publicResult = viewerSubscription === undefined ? result : { kind: result.kind, cursor: result.cursor };
            await context.writeResponse({ request, value: response(request.requestId, publicResult), write: send, close });
            if (request.op === "subscribe") {
              const replay = await context.recovery.events.replay(request.payload.after);
              for (const event of replay) await send(event);
            } else if (viewerSubscription !== undefined) {
              let active = viewerSubscriptions.get(socket);
              if (active === undefined) { active = new Set(); viewerSubscriptions.set(socket, active); }
              active.add(viewerSubscription);
              void pumpViewerSubscription(viewerSubscription, send).catch(() => socket.destroy()).finally(() => active.delete(viewerSubscription));
            }
          } catch (error) {
            await viewerSubscription?.return?.();
            await send(failure(request.requestId, error)).catch(() => {});
          }
        });
        chain = operation.catch(() => { socket.destroy(); });
        chains.add(operation);
        void operation.finally(() => chains.delete(operation)).catch(() => {});
      }
    });
    socket.on("end", () => {
      context.markAttachmentClosing(socket);
      /** @type {{ code?: string, message?: string } | undefined} */
      let framingError;
      try {
        decoder.end();
      } catch (error) {
        framingError = /** @type {{ code?: string, message?: string }} */ (error);
      }
      const finalizeInput = framingError === undefined
        ? chain
        : chain.then(() => send({ version: 1, ok: false, error: dashboardError(framingError.code ?? "INCOMPLETE_FRAME", framingError.message ?? "Incomplete frame") }));
      void finalizeInput.finally(() => { if (!socket.destroyed) socket.end(); }).catch(() => {});
    });
  });
  server.on("error", () => {});
  return {
    subscribers,
    sockets,
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, () => {
          server.off("error", rejectListen);
          resolveListen(undefined);
        });
      });
      await fs.chmod(socketPath, 0o600);
    },
    /** @param {any} event */
    broadcast(event) {
      const encoded = createJsonlEncoder({ maxBytes }).encode(event);
      for (const socket of subscribers) broadcastWriters.get(socket)?.enqueue(encoded);
    },

    beginShutdown() {
      if (!accepting) return;
      accepting = false;
      for (const [id, pending] of context.workerPending) {
        context.workerPending.delete(id);
        pending.reject(Object.assign(new Error("Daemon shutdown made worker delivery ambiguous"), { code: "DELIVERY_UNKNOWN" }));
      }
      for (const socket of sockets) socket.pause();
      if (server.listening) serverClosed = new Promise((resolveClose) => server.close(() => resolveClose(undefined)));
    },
    async drainAndClose() {
      await Promise.allSettled([...chains]);
      for (const socket of sockets) socket.destroy();
      while (chains.size > 0) await Promise.allSettled([...chains]);
      if (server.listening && serverClosed === undefined) serverClosed = new Promise((resolveClose) => server.close(() => resolveClose(undefined)));
      await serverClosed;
    },
  };
}

/** @param {any} [options] */
export async function createDaemonRuntime({
  root,
  maxBytes = DEFAULT_MAX_BYTES,
  inspect = inspectProcessIdentity,
  hostProbe = checkDefaultHost,
  reconcile,
  reconnectTimeoutMs = 15_000,
  workerSupervisor,
  resolveLaunchRequest,
  summarizeSession,
  summaryExecutable = "pi",
  summaryEnv = process.env,
  modelCatalog = createModelCatalog({ executable: summaryExecutable, spawn: spawnProcess, env: summaryEnv }),
  randomId = randomUUID,
  responseWriter = async (/** @type {any} */ { value, write }) => write(value),
  closeFailpoint = async () => {},
  attachmentFailpoint = () => {},
  destructiveFailpoint = async () => {},
  stopPolicy = DEFAULT_STOP_POLICY,
  signalProcessGroupImpl = signalProcessGroup,
  sleepImpl = sleep,
  trashSessionFile,
  broadcastEvent,
} = {}) {
  if (typeof root !== "string" || resolve(root) !== root) throw new TypeError("Daemon runtime root must be an absolute canonical path");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError("maxBytes must be at least 128");
  if (typeof randomId !== "function") throw new TypeError("randomId must be a function");
  if (typeof responseWriter !== "function" || typeof closeFailpoint !== "function" || typeof attachmentFailpoint !== "function" || typeof destructiveFailpoint !== "function" || typeof signalProcessGroupImpl !== "function" || typeof sleepImpl !== "function") throw new TypeError("Daemon runtime seams must be functions");
  if (!Number.isSafeInteger(stopPolicy?.gracefulMs) || stopPolicy.gracefulMs <= 0 || !Number.isSafeInteger(stopPolicy?.terminateMs) || stopPolicy.terminateMs <= 0) throw new TypeError("stopPolicy must contain approved positive integer waits");
  if (trashSessionFile !== undefined && typeof trashSessionFile !== "function") throw new TypeError("trashSessionFile must be a function when supplied");
  await ensureLayout(root);
  const daemonDirectory = join(root, "daemon");
  const tokenPath = join(daemonDirectory, "control.token");
  const tokenCandidate = await readPrivateText(tokenPath) ?? randomBytes(32).toString("base64url");
  const epochPath = join(daemonDirectory, "epoch");
  const epochCandidate = await readPrivateText(epochPath) ?? randomUUID();
  const identity = await inspect(process.pid);
  const claim = await claimDaemonLifecycle({ root, identity, daemonEpoch: epochCandidate, tokenPath, inspect, probe: async () => false });
  let socketOwned = false;
  /** @type {any} */
  let socketServer;
  try {
    const token = await privateText(tokenPath, () => tokenCandidate);
    const daemonEpoch = await privateText(epochPath, () => epochCandidate);
    if (daemonEpoch !== epochCandidate) throw Object.assign(new Error("Daemon epoch changed during lifecycle claim"), { code: "DAEMON_IDENTITY_CONFLICT" });
    const registry = new RegistryStore(join(root, "sessions"));
    const router = new RecoveredWorkerRouter({ registry, inspect, metadataPath: join(daemonDirectory, "workers.json") });
    await router.load();
    /** @type {(value?: unknown) => void} */
    let resolveStopRequested = () => {};
    const stopRequested = new Promise((resolveStop) => { resolveStopRequested = resolveStop; });
    const recoveryController = new AbortController();
    const usedCommandIds = new Set();
    const settingsStore = await openSettingsStore({ directory: daemonDirectory });
    /** @type {Set<string>} */
    const summarizing = new Set();
    const launchingSessions = new Set();
    const sessionStarts = new Map();
    /** Launch-channel handles for workers that have not yet reconnected over the control socket. @type {Map<string, any>} */
    const sessionHandles = new Map();
    /** @type {Map<string, Map<net.Socket, { clientId: string, role: "composer" | "observer" }>>} */
    const attachmentClaims = new Map();
    /** @type {Map<string, { serialized: string, promise: Promise<any> }>} */
    const attachmentRequests = new Map();
    /** @type {WeakMap<net.Socket, Set<string>>} */
    const attachmentSessions = new WeakMap();
    /** @type {WeakSet<net.Socket>} */
    const closingAttachmentSockets = new WeakSet();
    /** @type {any} */
    const context = {
      state: "STARTING",
      stateError: undefined,
      admissionOpen: true,
      recovery: undefined,
      viewerRecovery: undefined,
      cursorStore: undefined,
      launchResults: undefined,
      attachmentResults: undefined,
      deleteResults: undefined,
      router,
      workerPending: new Map(),
      hostReport: undefined,
      broadcast: () => {},
      writeResponse: responseWriter,
      requestStop: () => resolveStopRequested(undefined),
      publicStatus() { return { state: context.state, recovering: ["STARTING", "RECONCILING"].includes(context.state), error: context.stateError, daemonEpoch, pid: identity.pid }; },
      /** @param {net.Socket} socket */
      markAttachmentClosing(socket) { closingAttachmentSockets.add(socket); },
      /** Append and broadcast one session's new record. @param {any} session */
      async publishSession(session) {
        context.broadcast(await context.recovery.events.append({ kind: "session_changed", payload: { session } }));
      },
      /** Append and broadcast one durable command's new status. @param {any} status */
      async publishCommand(status) {
        context.broadcast(await context.recovery.events.append({ kind: "command_changed", payload: { status } }));
      },
      /** Mint one worker command ID that no earlier command in this daemon has used. */
      nextCommandId() {
        const id = randomId();
        if (typeof id !== "string" || id.length < 16 || usedCommandIds.has(id)) throw Object.assign(new Error("Command ID generator did not provide a unique restart-safe ID"), { code: "COMMAND_ID_COLLISION" });
        usedCommandIds.add(id);
        return id;
      },
      /** Send one command over an exact route, carrying the pending identity handleWorkerFrame checks the reply against. @param {any} route @param {string} id @param {any} durableRequest @param {Record<string, unknown>} [fields] */
      sendWorkerCommand(route, id, durableRequest, fields = {}) {
        const { metadata, connection, routeGeneration } = route;
        const { clientId, requestId, op } = durableRequest;
        return connection.request(
          { version: 1, type: "command", token: metadata.token, id, command: { clientId, requestId, op, ...fields } },
          { clientId, requestId, op, durableRequest, metadata, routeGeneration, sessionId: metadata.sessionId, runId: metadata.runId, leaseId: metadata.leaseId, generation: metadata.generation },
        );
      },
      /** Ask this session's worker one non-durable question over whichever channel owns it. @param {any} request @param {Record<string, unknown>} [fields] */
      async askWorker(request, fields = {}) {
        const sessionId = request.payload.sessionId;
        const route = router.route(sessionId);
        const handle = sessionHandles.get(sessionId);
        if (route?.connection !== undefined && route.metadata?.token !== undefined) return context.sendWorkerCommand(route, context.nextCommandId(), request, fields);
        // The launch channel carries no extra command fields yet, so a parameterised ask waits for the socket route.
        if (typeof handle?.request === "function" && Object.keys(fields).length === 0) return handle.request(request.op);
        if (typeof handle?.request === "function") throw Object.assign(new Error("This session is still starting; retry once it is connected"), { code: "WORKER_RECONNECTING", retryable: true });
        if (handle !== undefined) sessionHandles.delete(sessionId);
        throw Object.assign(new Error("No exact recovered worker owns this session"), { code: "WORKER_UNAVAILABLE" });
      },
      /** @param {any} handle */
      async activateWorker(handle) {
        sessionHandles.set(handle.sessionId, handle);
        await router.register(handle);
        await context.recovery.viewer.ensure(handle.sessionId);
        handle.onFrame?.((/** @type {Record<string, unknown>} */ frame) => {
          void router.runFrame(handle.sessionId, async () => {
            await context.recovery.viewer.ingest(handle.sessionId, frame);
          }).catch(() => {});
        });
      },
      /**
       * Re-derive task state from Pi after a reconnect: a turn can both finish and start while the
       * daemon is down, and the worker drops the state events it emits with no connection to send them
       * on. WAITING, STOPPED and FAILED mean something Pi does not report, so they are left alone.
       * @param {any} route
       */
      async reconcileSessionActivity(route) {
        const { metadata } = route;
        if (metadata?.token === undefined) return;
        const record = await registry.get(metadata.sessionId);
        if (record === undefined || (record.taskState !== "WORKING" && record.taskState !== "READY")) return;
        const id = context.nextCommandId();
        const clientId = `daemon-reconcile:${daemonEpoch}`;
        const durableRequest = { version: 1, clientId, requestId: id, op: "get_state", payload: { sessionId: metadata.sessionId } };
        const result = await context.sendWorkerCommand(route, id, durableRequest);
        const streaming = result?.result?.isStreaming;
        // Pi is the authority on which model a session runs: a launch that names none still gets one.
        await context.recordSessionModel(metadata, result?.result);
        if (typeof streaming !== "boolean") return;
        const derived = streaming ? "WORKING" : "READY";
        await runSessionLifecycle(registry, metadata.sessionId, async () => {
          const current = await registry.get(metadata.sessionId);
          if (current === undefined || current.ownership?.runId !== metadata.runId) return;
          if (current.taskState === derived || (current.taskState !== "WORKING" && current.taskState !== "READY")) return;
          const next = reduceSessionState(current, { type: streaming ? "TURN_STARTED" : "TURN_COMPLETED", at: new Date().toISOString() });
          const updated = await registry.update(current.sessionId, current.revision, { taskState: next.taskState, processState: next.processState, outcome: next.outcome, activity: next.activity, updatedAt: next.updatedAt });
          await context.publishSession(updated);
        }, "reconcile_activity");
      },
      /**
       * Store the model and thinking level Pi reported, so the list shows what a session actually runs
       * rather than only what the launch happened to ask for.
       * @param {any} metadata @param {any} state
       */
      async recordSessionModel(metadata, state) {
        const model = state?.model;
        const thinkingLevel = state?.thinkingLevel;
        const named = typeof model?.provider === "string" && typeof model?.id === "string";
        if (!named && typeof thinkingLevel !== "string") return;
        await runSessionLifecycle(registry, metadata.sessionId, async () => {
          const current = await registry.get(metadata.sessionId);
          if (current === undefined || current.ownership?.runId !== metadata.runId) return;
          const sameModel = !named || (current.model?.provider === model.provider && current.model?.id === model.id);
          const sameThinking = typeof thinkingLevel !== "string" || current.thinkingLevel === thinkingLevel;
          if (sameModel && sameThinking) return;
          const updated = await registry.update(current.sessionId, current.revision, {
            ...(named ? { model: { provider: model.provider, id: model.id } } : {}),
            ...(typeof thinkingLevel === "string" ? { thinkingLevel } : {}),
            updatedAt: new Date().toISOString(),
          });
          await context.publishSession(updated);
        }, "record_model");
      },
      /**
       * Refresh opt-in Activity summaries for every session whose transcript advanced. Selection reads
       * the normalized transcript from memory rather than republishing each session's snapshot, so a
       * frontend returning to the list does not wait behind one durable write per session.
       */
      async refreshSummaries() {
        const { summaryModel } = settingsStore.current();
        if (summaryModel === null || context.recovery?.viewer === undefined) return [];
        const summarize = summarizeSession ?? summarizeWithPi;
        /** @type {string[]} */
        const refreshed = [];
        for (const record of await registry.list()) {
          if (summarizing.has(record.sessionId)) continue;
          const normalized = context.recovery.viewer.transcript(record.sessionId);
          if (normalized === undefined) continue;
          const sourceCursor = normalized.sequence;
          const summary = record.summary;
          if (summary !== undefined && summary.sourceCursor === sourceCursor && summary.model.provider === summaryModel.provider && summary.model.id === summaryModel.id) continue;
          const transcript = summarizePromptInput(normalized.items);
          if (transcript.length === 0) continue;
          refreshed.push(record.sessionId);
          summarizing.add(record.sessionId);
          void (async () => {
            try {
              const written = await summarize({ model: summaryModel, transcript, executable: summaryExecutable, env: summaryEnv });
              const text = typeof written === "string" ? written : written?.text;
              const writtenName = typeof written === "string" ? undefined : written?.name;
              if (typeof text !== "string" || text.trim().length === 0) return;
              // The write stays under the lifecycle lock. It is the last writer that could race Stop's
              // signaling-boundary revision check or Delete's revision-guarded remove, and the lock is
              // what keeps every revision-guarded update from racing another writer. The hold is one
              // registry read plus one atomic write; the summarizer itself ran outside it.
              await runSessionLifecycle(registry, record.sessionId, async () => {
                const current = await registry.get(record.sessionId);
                if (current === undefined) return;
                // A name the operator chose outranks anything the summarizer writes.
                // Only a name the operator typed sets nameGenerated false; an absent flag is a legacy name of unknown provenance, which the agent may replace.
                const namesItself = typeof writtenName === "string" && writtenName.trim().length > 0 && current.nameGenerated !== false;
                const updated = await registry.update(current.sessionId, current.revision, { summary: { text: text.trim().slice(0, 512), generatedAt: new Date().toISOString(), model: { ...summaryModel }, sourceCursor }, ...(namesItself ? { name: writtenName.trim().slice(0, 128), nameGenerated: true } : {}), updatedAt: new Date().toISOString() });
                await context.publishSession(updated);
              }, "summary_write");
            } catch {
            } finally {
              summarizing.delete(record.sessionId);
            }
          })();
        }
        return refreshed;
      },
      /** @param {string} sessionId */
      async ensureSessionWorker(sessionId) {
        if (router.route(sessionId) !== undefined || sessionHandles.has(sessionId)) return;
        const pending = sessionStarts.get(sessionId);
        if (pending !== undefined) return pending;
        const start = (async () => {
          if (typeof workerSupervisor?.launch !== "function") return;
          const record = await registry.get(sessionId);
          if (record === undefined) throw Object.assign(new Error("Session does not exist"), { code: "SESSION_NOT_FOUND" });
          await router.runSession(sessionId, async (/** @type {any} */ { metadata, route, forget }) => {
            const current = await registry.get(sessionId);
            if (metadata !== undefined) {
              if (route !== undefined || !(await processIsGone(metadata.identity, inspect))) {
                throw Object.assign(new Error("Session worker is reconnecting"), { code: "WORKER_RECONNECTING", retryable: true });
              }
              // A Pi child outliving its supervisor is the second-writer case, and no retry clears it.
              if (!(await processIsGone(metadata.piChildIdentity, inspect))) {
                throw Object.assign(new Error("A worker is still running for this session"), { code: "WORKER_STILL_LIVE", retryable: false });
              }
              // Metadata whose supervisor and Pi child are both provably gone cannot be authoritative, and a
              // lease this daemon still holds keeps its metadata so recovery can find that worker again.
              if (current?.ownership === undefined) await forget();
            }
            if (current?.ownership !== undefined) throw Object.assign(new Error("Session worker is reconnecting"), { code: "WORKER_RECONNECTING", retryable: true });
          });
          launchingSessions.add(sessionId);
          try {
            const handle = await workerSupervisor.launch({
              sessionId,
              canonicalSessionFile: record.canonicalSessionFile,
              cwd: record.cwd,
              runId: randomUUID(),
              ...(record.model === undefined ? {} : { model: record.model }),
              ...(record.thinkingLevel === undefined ? {} : { thinkingLevel: record.thinkingLevel }),
              ...(record.name === undefined ? {} : { name: record.name }),
              daemonConnector: CONNECTOR_PATH,
              daemonConnectConfig: { socketPath: join(daemonDirectory, "control.sock"), tokenPath, maxBytes },
            });
            await context.activateWorker(handle);
          } finally {
            launchingSessions.delete(sessionId);
          }
        })();
        sessionStarts.set(sessionId, start);
        try { await start; } finally { if (sessionStarts.get(sessionId) === start) sessionStarts.delete(sessionId); }
      },
      /** @param {string} sessionId @param {string} clientId @param {"composer" | "observer"} role @param {boolean} attached */
      async appendAttachment(sessionId, clientId, role, attached) {
        if (context.recovery?.events === undefined) throw Object.assign(new Error("Attachment event store is unavailable"), { code: "RECOVERING" });
        return context.recovery.events.append({ kind: "attachment_changed", payload: { sessionId, clientId, role, attached } });
      },
      /** @param {any} request @param {net.Socket} socket @param {string} authenticatedClientId */
      async arbitrateAttachment(request, socket, authenticatedClientId) {
        if (request.clientId !== authenticatedClientId) throw Object.assign(new Error("Attachment client identity changed"), { code: "CLIENT_IDENTITY_CONFLICT" });
        const sessionId = request.payload.sessionId;
        if (request.op === "attach" && request.payload.role === "composer" && request.payload.activate === true) await context.ensureSessionWorker(sessionId);
        let touched = attachmentSessions.get(socket);
        if (touched === undefined) {
          touched = new Set();
          attachmentSessions.set(socket, touched);
        }
        touched.add(sessionId);
        attachmentFailpoint("registered", request);
        const cacheKey = JSON.stringify([authenticatedClientId, request.requestId]);
        const serialized = JSON.stringify({ op: request.op, payload: request.payload });
        const cached = attachmentRequests.get(cacheKey);
        if (cached !== undefined) {
          if (cached.serialized !== serialized) throw Object.assign(new Error("Attachment request ID was reused with changed content"), { code: "IDEMPOTENCY_CONFLICT" });
          return cached.promise;
        }
        if (attachmentRequests.size >= MAX_ATTACHMENT_REQUESTS) throw Object.assign(new Error("Too many attachment requests are in flight"), { code: "ATTACHMENT_REQUEST_LIMIT", retryable: true });
        const operation = runSessionLifecycle(registry, sessionId, async () => {
          let accepted = await context.recovery.journal.accept(request);
          const phase = context.attachmentResults.phase(request);
          const stored = context.attachmentResults.get(request);
          if (stored !== undefined) {
            if (stored.ok) return stored.result;
            throw Object.assign(new Error(stored.error.message), stored.error);
          }
          if (phase === "PREPARED" && accepted.stage !== "ACCEPTED") accepted = await context.recovery.journal.reconcileAttachment(request, phase);
          if (accepted.stage !== "ACCEPTED") return { kind: "command", status: accepted };
          await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
          /** @type {unknown} */
          let failpointFailure;
          /** @param {string} phase */
          const checkpoint = async (phase) => {
            try {
              await attachmentFailpoint(phase, request);
            } catch (error) {
              failpointFailure = error;
              throw error;
            }
          };
          /** @type {{ ok: true, result: any } | { ok: false, error: { code: string, message: string, retryable: boolean } }} */
          let outcome;
          try {
            if (closingAttachmentSockets.has(socket)) throw Object.assign(new Error("Attachment connection is closing"), { code: "SOCKET_CLOSING" });
            const existingClaims = attachmentClaims.get(sessionId);
            const claims = existingClaims ?? new Map();
            const prior = claims.get(socket);
            if (prior !== undefined && prior.clientId !== authenticatedClientId) throw Object.assign(new Error("Attachment claim identity changed"), { code: "CLIENT_IDENTITY_CONFLICT" });
            if (request.op === "detach") {
              outcome = { ok: true, result: { kind: "detached", sessionId } };
              await context.attachmentResults.prepare(request, outcome);
              await checkpoint("after_prepared");
              if (prior !== undefined && prior.clientId === authenticatedClientId) {
                const event = await context.appendAttachment(sessionId, authenticatedClientId, prior.role, false);
                await checkpoint("after_event_append");
                claims.delete(socket);
                if (claims.size === 0) attachmentClaims.delete(sessionId);
                await checkpoint("after_claim_mutation");
                context.broadcast(event);
                await checkpoint("after_broadcast");
              }
            } else {
              const composerClaim = [...claims.values()].find((claim) => claim.role === "composer");
              const grantedRole = request.payload.role === "composer" && (composerClaim === undefined || (prior?.clientId === authenticatedClientId && prior.role === "composer"))
                ? "composer"
                : "observer";
              outcome = { ok: true, result: { kind: "attached", sessionId, role: grantedRole } };
              await context.attachmentResults.prepare(request, outcome);
              await checkpoint("after_prepared");
              if (prior === undefined || prior.clientId !== authenticatedClientId || prior.role !== grantedRole) {
                const event = await context.appendAttachment(sessionId, authenticatedClientId, grantedRole, true);
                await checkpoint("after_event_append");
                if (existingClaims === undefined) attachmentClaims.set(sessionId, claims);
                claims.set(socket, { clientId: authenticatedClientId, role: grantedRole });
                await checkpoint("after_claim_mutation");
                context.broadcast(event);
                await checkpoint("after_broadcast");
              }
            }
          } catch (error) {
            if (error === failpointFailure) throw error;
            const attachmentError = /** @type {any} */ (error);
            outcome = { ok: false, error: dashboardError(attachmentError?.code ?? "REQUEST_FAILED", error instanceof Error ? error.message : "Request failed", attachmentError?.retryable === true) };
          }
          await checkpoint("before_result_completion");
          let durable;
          try {
            durable = await context.attachmentResults.put(request, outcome);
          } catch (error) {
            const current = await context.recovery.journal.get(request);
            if (current?.stage === "DELIVERY_ATTEMPTED") await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
            throw error;
          }
          await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
          await context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
          await checkpoint("after_result_completion");
          if (durable.ok) return durable.result;
          throw Object.assign(new Error(durable.error.message), durable.error);
        }, request.op);
        const reservation = { serialized, promise: operation };
        attachmentRequests.set(cacheKey, reservation);
        void operation.finally(() => {
          if (attachmentRequests.get(cacheKey) === reservation) attachmentRequests.delete(cacheKey);
        }).catch(() => {});
        return operation;
      },
      /** @param {net.Socket} socket @param {string | undefined} authenticatedClientId */
      async releaseAttachments(socket, authenticatedClientId) {
        if (authenticatedClientId === undefined) return;
        const sessionIds = attachmentSessions.get(socket);
        if (sessionIds === undefined) return;
        await Promise.all([...sessionIds].map((sessionId) => runSessionLifecycle(registry, sessionId, async () => {
          const claims = attachmentClaims.get(sessionId);
          if (claims === undefined) return;
          const prior = claims.get(socket);
          if (prior === undefined || prior.clientId !== authenticatedClientId) return;
          const event = await context.appendAttachment(sessionId, authenticatedClientId, prior.role, false);
          claims.delete(socket);
          if (claims.size === 0) attachmentClaims.delete(sessionId);
          context.broadcast(event);
        }, "release_attachments")));
        attachmentSessions.delete(socket);
      },
      /** @param {any} frame @param {any} connection @param {any} metadata @param {number} routeGeneration */
      async handleWorkerFrame(frame, connection, metadata, routeGeneration) {
        if (!context.admissionOpen) throw Object.assign(new Error("Daemon is shutting down"), { code: "SHUTTING_DOWN", retryable: true });
        if (metadata === undefined || frame?.token !== metadata.token) throw Object.assign(new Error("Unauthenticated worker frame"), { code: "WORKER_AUTHENTICATION_FAILED" });
        if (frame.type === "command_result") {
          const allowed = frame.ok === true ? ["version", "type", "token", "id", "ok", "record"] : ["version", "type", "token", "id", "ok", "error"];
          if (frame.version !== 1 || typeof frame.id !== "string" || typeof frame.ok !== "boolean" || Object.keys(frame).some((key) => !allowed.includes(key))) throw Object.assign(new Error("Invalid worker command-result frame"), { code: "INVALID_WORKER_FRAME" });
          await router.runCurrent(metadata, connection, routeGeneration, async () => {
            const pending = context.workerPending.get(frame.id);
            if (pending === undefined || pending.connection !== connection || pending.metadata !== metadata || pending.routeGeneration !== routeGeneration || pending.sessionId !== metadata.sessionId || pending.runId !== metadata.runId || pending.leaseId !== metadata.leaseId || pending.generation !== metadata.generation || pending.durableRequest?.clientId !== pending.clientId || pending.durableRequest?.requestId !== pending.requestId || pending.durableRequest?.op !== pending.op || pending.durableRequest?.payload?.sessionId !== pending.sessionId) return;
            if (frame.ok) validateWorkerSuccess(frame.record, pending);
            else validateWorkerFailure(frame.error);
            if (context.workerPending.get(frame.id) !== pending) return;
            context.workerPending.delete(frame.id);
            frame.ok ? pending.resolve(frame.record) : pending.reject(Object.assign(new Error(frame.error.message), { code: frame.error.deliveryUnknown ? "DELIVERY_UNKNOWN" : frame.error.code, delivered: frame.error.deliveryUnknown !== true }));
          });
          return;
        }
        if (frame.type === "pi_frame") {
          const allowed = ["version", "type", "token", "sessionId", "frame"];
          if (frame.version !== 1 || frame.sessionId !== metadata.sessionId || Object.keys(frame).some((key) => !allowed.includes(key)) || typeof frame.frame !== "object" || frame.frame === null || Array.isArray(frame.frame)) throw Object.assign(new Error("Invalid Pi viewer frame"), { code: "INVALID_WORKER_FRAME" });
          const viewer = context.recovery?.viewer ?? context.viewerRecovery;
          if (viewer === undefined) throw Object.assign(new Error("Viewer recovery is still initializing"), { code: "RECOVERING", retryable: true });
          await router.runCurrentFrame(metadata, connection, routeGeneration, async () => {
            await viewer.ingest(frame.sessionId, frame.frame);
          });
          return;
        }
        if (context.state !== "READY") throw Object.assign(new Error("Daemon recovery is still in progress"), { code: "RECOVERING", retryable: true });
        const eventKeys = ["version", "type", "token", "sessionId", "event"];
        if (frame.type !== "worker_event" || frame.version !== 1 || frame.sessionId !== metadata.sessionId || Object.keys(frame).some((key) => !eventKeys.includes(key)) || typeof frame.event !== "object" || frame.event === null || Array.isArray(frame.event)) throw Object.assign(new Error("Invalid worker frame"), { code: "INVALID_WORKER_FRAME" });
        await router.runCurrent(metadata, connection, routeGeneration, async () => {
          const record = await registry.get(frame.sessionId);
          if (record?.ownership === undefined || record.ownership.runId !== metadata.runId) throw Object.assign(new Error("Worker event ownership conflict"), { code: "OWNERSHIP_CONFLICT" });
          const next = reduceSessionState(record, frame.event);
          const updated = next === record ? record : await registry.update(record.sessionId, record.revision, { taskState: next.taskState, processState: next.processState, outcome: next.outcome, activity: next.activity, updatedAt: next.updatedAt });
          await context.publishSession(updated);
        });
      },
      /** @param {any} request @param {net.Socket | undefined} socket @param {Set<net.Socket>} subscribers @param {string} [authenticatedClientId] */
      async handleRequest(request, socket, subscribers, authenticatedClientId = request.clientId, duringRecovery = false) {
        if (!context.admissionOpen) throw Object.assign(new Error("Daemon is shutting down"), { code: "SHUTTING_DOWN", retryable: true });
        if (request.op === "get_state") return { kind: "state", sessions: await registry.list() };
        if (request.op === "get_settings") return { kind: "settings", ...settingsStore.current() };
        if (request.op === "get_models") {
          // Listing models runs no inference; it asks the installed Pi what it will accept.
          const models = await modelCatalog.models();
          return { kind: "models", models: models.map((/** @type {any} */ model) => ({ provider: model.provider, id: model.id, thinking: model.thinking })) };
        }
        if (request.op === "set_settings") return { kind: "settings", ...(await settingsStore.setSummaryModel(request.payload.summaryModel)) };
        if (request.op === "set_session_color") {
          return runSessionLifecycle(registry, request.payload.sessionId, async () => {
            const updated = await applySessionColor(registry, request.payload.sessionId, request.payload.color);
            await context.publishSession(updated);
            return { kind: "session_colored", sessionId: updated.sessionId, revision: updated.revision, color: updated.color ?? null };
          }, "set_session_color");
        }
        if (context.state !== "READY" && !duringRecovery) throw Object.assign(new Error(context.state === "FAILED" ? context.stateError?.message ?? "Daemon recovery failed" : "Daemon recovery is still in progress"), { code: context.state === "FAILED" ? context.stateError?.code ?? "RECOVERY_FAILED" : "RECOVERING", retryable: context.state !== "FAILED" });
        if (request.op === "get_viewer_snapshot") {
          const role = socket === undefined ? "observer" : attachmentClaims.get(request.payload.sessionId)?.get(socket)?.role ?? "observer";
          return { kind: "viewer_snapshot", snapshot: await context.recovery.viewer.snapshot(request.payload.sessionId, role) };
        }
        if (request.op === "subscribe_viewer") {
          if (socket === undefined) throw new TypeError("Viewer subscription requires a live socket");
          const store = context.recovery.viewer.store(request.payload.sessionId);
          if (store === undefined) throw Object.assign(new Error("Viewer session does not exist"), { code: "SESSION_NOT_FOUND" });
          const subscription = store.subscribe(request.payload.after);
          return { kind: "viewer_subscribed", cursor: store.currentCursor(), _viewerSubscription: subscription };
        }
        if (request.op === "ack_viewer") {
          if (request.clientId !== authenticatedClientId) throw Object.assign(new Error("Viewer cursor client identity changed"), { code: "CLIENT_IDENTITY_CONFLICT" });
          const store = context.recovery.viewer.store(request.payload.cursor.sessionId);
          if (store === undefined) throw Object.assign(new Error("Viewer session does not exist"), { code: "SESSION_NOT_FOUND" });
          return { kind: "viewer_acknowledged", cursor: await store.acknowledge(authenticatedClientId, request.payload.cursor) };
        }
        if (request.op === "subscribe") {
          if (socket === undefined) throw new TypeError("Subscription requires a live socket");
          subscribers.add(socket);
          return { kind: "subscribed", cursor: context.recovery.events.currentCursor() };
        }
        if (request.op === "ack") {
          if (request.clientId !== authenticatedClientId) throw Object.assign(new Error("Cursor client identity changed"), { code: "CLIENT_IDENTITY_CONFLICT" });
          const cursor = await context.cursorStore.acknowledge(authenticatedClientId, request.payload.cursor, context.recovery.events.currentCursor());
          return { kind: "acknowledged", cursor };
        }
        if (request.op === "resolve_delivery") {
          const status = await context.recovery.journal.resolveDelivery({ clientId: request.payload.targetClientId, requestId: request.payload.targetRequestId }, request.payload.resolution);
          await context.publishCommand(status);
          return { kind: "command", status };
        }
        if (request.op === "launch") {
          const accepted = await context.recovery.journal.accept(request);
          const priorResult = context.launchResults.get(request);
          if (accepted.stage === "COMPLETED" && priorResult !== undefined) return { kind: "launched", sessionId: priorResult.sessionId };
          if (accepted.stage !== "ACCEPTED") return { kind: "command", status: accepted };
          context.hostReport ??= await hostProbe();
          if (context.hostReport.blockers?.length > 0 || context.hostReport.daemonOwnedStartup === false) {
            const status = await context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("UNSUPPORTED_HOST", "Pi host does not support daemon-owned product launch"));
            return { kind: "command", status };
          }
          if (workerSupervisor === undefined || typeof resolveLaunchRequest !== "function") {
            const status = await context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("LAUNCH_UNAVAILABLE", "Daemon launch resolver is unavailable"));
            return { kind: "command", status };
          }
          await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
          /** @type {any} */
          let launch;
          try {
            launch = await resolveLaunchRequest(request);
            if (launch.sessionRecord !== undefined && await registry.get(launch.sessionId) === undefined) {
              const prepared = await registry.create(launch.sessionRecord);
              await context.publishSession(prepared);
            }
            return await runSessionLifecycle(registry, launch.sessionId, async () => {
              if (launchingSessions.has(launch.sessionId)) throw Object.assign(new Error("A launch is already in flight for this session"), { code: "LAUNCH_IN_FLIGHT" });
              launchingSessions.add(launch.sessionId);
              /** @type {any} */
              let handle;
              try {
                handle = await workerSupervisor.launch({ ...launch, daemonConnector: CONNECTOR_PATH, daemonConnectConfig: { socketPath: join(daemonDirectory, "control.sock"), tokenPath, maxBytes } });
                await context.activateWorker(handle);
                if (typeof launch.initialPrompt === "string") {
                  const promptRequest = {
                    version: 1,
                    clientId: `daemon-launch:${daemonEpoch}`,
                    requestId: createHash("sha256").update(canonicalJson([request.clientId, request.requestId, handle.sessionId])).digest("hex"),
                    op: "prompt",
                    payload: { sessionId: handle.sessionId, text: launch.initialPrompt },
                  };
                  const promptStatus = await handle.deliver(promptRequest, context.recovery.journal);
                  if (promptStatus?.stage !== "COMPLETED") throw Object.assign(new Error(promptStatus?.error?.message ?? `Initial prompt ended in ${promptStatus?.stage ?? "an unknown state"}`), { code: promptStatus?.error?.code ?? promptStatus?.stage ?? "INITIAL_PROMPT_FAILED" });
                }
              } finally {
                launchingSessions.delete(launch.sessionId);
              }
              const persisted = await context.launchResults.put(request, { sessionId: handle.sessionId });
              await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
              await context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
              return { kind: "launched", sessionId: persisted.sessionId };
            }, "launch");
          } catch (error) {
            const launchError = /** @type {any} */ (error);
            const current = await context.recovery.journal.get(request);
            // A worker that died before it was ready leaves no lease behind, so nothing owns this session
            // and the row must say the launch failed. Leaving it at STARTING makes the list lie for hours.
            const prepared = launch === undefined ? undefined : await registry.get(launch.sessionId);
            const unowned = prepared !== undefined && prepared.ownership === undefined;
            if (current?.stage === "DELIVERY_ATTEMPTED" && (launchError?.preChild === true || unowned) && launch !== undefined) {
              if (prepared !== undefined) {
                const updated = await registry.update(prepared.sessionId, prepared.revision, {
                  taskState: "FAILED",
                  processState: "EXITED",
                  activity: { kind: "launch_failed", summary: error instanceof Error ? error.message : "Launch failed", updatedAt: new Date().toISOString() },
                  updatedAt: new Date().toISOString(),
                });
                await context.publishSession(updated);
              }
              await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
              await context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "FAILED", dashboardError(launchError.code ?? "LAUNCH_FAILED", error instanceof Error ? error.message : "Launch failed"));
            } else if (current?.stage === "DELIVERY_ATTEMPTED") await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
            throw error;
          }
        }
        if (request.op === "refresh_summaries") return { kind: "summaries_refreshing", sessionIds: await context.refreshSummaries() };
        if (request.op === "attach" || request.op === "detach") {
          if (socket === undefined) throw new TypeError("Attachment requires a live socket");
          return context.arbitrateAttachment(request, socket, authenticatedClientId);
        }
        if (request.op === "get_session_commands") {
          const menu = (await context.askWorker(request))?.result ?? {};
          return {
            kind: "session_commands", sessionId: request.payload.sessionId,
            commands: menu.commands ?? [], models: menu.models ?? [], thinkingLevels: menu.thinkingLevels ?? [],
            model: menu.model ?? null, thinkingLevel: menu.thinkingLevel ?? null,
          };
        }
        if (request.op === "session_query") {
          const sessionQuery = { query: request.payload.query, ...(request.payload.outputPath === undefined ? {} : { outputPath: request.payload.outputPath }) };
          const rows = (await context.askWorker(request, { sessionQuery }))?.result ?? [];
          return { kind: "session_query", sessionId: request.payload.sessionId, query: request.payload.query, rows: Array.isArray(rows) ? rows : [] };
        }
        if (!DURABLE_COMMANDS.has(request.op)) throw Object.assign(new Error(`Unsupported daemon operation: ${request.op}`), { code: "UNSUPPORTED_OPERATION" });
        if (!duringRecovery) {
          const claim = socket === undefined ? undefined : attachmentClaims.get(request.payload.sessionId)?.get(socket);
          if (claim === undefined) throw Object.assign(new Error("A composer attachment is required"), { code: "ATTACHMENT_REQUIRED" });
          if (claim.role !== "composer") throw Object.assign(new Error("Observers cannot mutate sessions"), { code: "OBSERVER_READ_ONLY" });
        }
        const accepted = await context.recovery.journal.accept(request);
        let status = accepted;
        const changed = accepted.stage === "ACCEPTED";
        const unresolvedDeleteRecovery = request.op === "delete" && accepted.stage === "DELIVERY_UNKNOWN" && context.deleteResults.get(request)?.phase === "PREPARED";
        if (accepted.stage === "ACCEPTED" || unresolvedDeleteRecovery) {
          const route = router.route(request.payload.sessionId);
          const connection = route?.connection;
          const metadata = route?.metadata;
          if (connection !== undefined) sessionHandles.delete(request.payload.sessionId);
          const launchHandle = sessionHandles.get(request.payload.sessionId);
          if (WORKER_DELIVERED_COMMANDS.includes(request.op) && connection === undefined && typeof launchHandle?.deliver === "function") {
            status = await launchHandle.deliver(request, context.recovery.journal);
          } else if (WORKER_DELIVERED_COMMANDS.includes(request.op)) {
            if (connection === undefined || metadata?.token === undefined) {
              status = await context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("WORKER_UNAVAILABLE", "No exact recovered worker owns this session"));
            } else {
              const id = context.nextCommandId();
              await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
              const retryAtRisk = (await context.recovery.journal.history(request)).some((/** @type {any} */ prior) => prior.stage === "DELIVERY_UNKNOWN");
              try {
                await context.sendWorkerCommand(route, id, request, { text: request.payload.text, response: request.op === "ui_response" ? { requestId: request.payload.uiRequestId, response: request.payload.response } : undefined, sessionCommand: request.op === "session_command" ? sessionCommandPayload(request.payload) : undefined, retryAtRisk });
                await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
                status = await context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
              } catch (error) {
                const deliveryError = /** @type {any} */ (error);
                const current = await context.recovery.journal.get(request);
                if (current?.stage !== "DELIVERY_ATTEMPTED") status = current;
                else if (deliveryError?.delivered === true) {
                  await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
                  status = await context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "FAILED", dashboardError(deliveryError.code ?? "RPC_FAILED", deliveryError.message));
                } else status = await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
              }
            }
          } else if (request.op === "stop") {
            const retryAtRisk = (await context.recovery.journal.history(request)).some((/** @type {any} */ prior) => prior.stage === "DELIVERY_UNKNOWN");
            status = await router.runSession(request.payload.sessionId, async (/** @type {any} */ { metadata: lockedMetadata, route: lockedRoute, forget }) => {
              const record = await registry.get(request.payload.sessionId);
              if (record === undefined) return context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("SESSION_NOT_FOUND", "The exact session does not exist"));
              const retryObservedTerminal = retryAtRisk && record.revision === request.payload.revision + 1 && record.ownership === undefined && record.processState === "EXITED";
              if (record.revision !== request.payload.revision && !retryObservedTerminal) return context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("REVISION_CONFLICT", "Session revision changed before Stop"));
              if (record.ownership === undefined || !["LIVE", "SLEEPING", "STALE"].includes(record.processState)) {
                if (!retryAtRisk) return context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("SESSION_NOT_ACTIVE", "Stop requires current authoritative ownership"));
                await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
                await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
                return context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
              }
              if (lockedMetadata === undefined || lockedMetadata.runId !== record.ownership.runId || !sameProcessIdentity(lockedMetadata.identity, record.ownership.process)) {
                return context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("OWNERSHIP_CONFLICT", "Durable worker lease does not match the SessionRecord"));
              }
              await destructiveFailpoint("stop_before_delivery", request, record);
              await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
              const exactRecord = await registry.get(request.payload.sessionId);
              if (exactRecord?.revision !== record.revision || exactRecord.ownership === undefined || !sameProcessIdentity(exactRecord.ownership.process, record.ownership.process)) {
                await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
                return context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "FAILED", dashboardError("OWNERSHIP_CONFLICT", "Ownership changed at the signaling boundary"));
              }
              let disposition;
              try {
                disposition = await stopVerifiedProcessGroup(exactRecord.ownership.process, {
                  inspect,
                  requestGraceful: async () => { await lockedRoute?.connection.send({ version: 1, type: "shutdown", token: lockedMetadata.token }).catch(() => {}); },
                  signalProcessGroup: signalProcessGroupImpl,
                  sleep: sleepImpl,
                }, stopPolicy);
              } catch (error) {
                const current = await context.recovery.journal.get(request);
                if (current?.stage === "DELIVERY_ATTEMPTED") return context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
                throw error;
              }
              const observedTerminal = ["ALREADY_EXITED", "GRACEFUL", "TERMINATED", "KILLED"].includes(disposition.disposition);
              if (disposition.disposition === "KILL_REQUESTED" || disposition.signaled === true) {
                return context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
              }
              if (["STALE_IDENTITY", "AMBIGUOUS_IDENTITY", "CANCELLED"].includes(disposition.disposition)) {
                await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
                return context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "FAILED", dashboardError(disposition.disposition, `Stop refused at exact identity boundary: ${disposition.disposition}`));
              }
              if (observedTerminal) {
                const latest = await registry.get(request.payload.sessionId);
                if (latest?.revision === exactRecord.revision && latest.ownership?.runId === exactRecord.ownership.runId) {
                  // Stop is a task-state verdict; a reviewable outcome the session already earned stays intact.
                  const stopped = reduceSessionState(latest, { type: "USER_STOPPED", at: new Date().toISOString() });
                  const updated = await registry.update(latest.sessionId, latest.revision, { ownership: undefined, taskState: stopped.taskState, processState: stopped.processState, outcome: latest.outcome, activity: stopped.activity, updatedAt: stopped.updatedAt });
                  await context.publishSession(updated);
                }
                await forget();
              }
              await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
              return context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
            });
          } else if (request.op === "delete") {
            const history = await context.recovery.journal.history(request);
            const retryAtRisk = history.some((/** @type {any} */ prior, /** @type {number} */ index) => prior.stage === "DELIVERY_UNKNOWN" && history[index + 1]?.stage === "ACCEPTED");
            const reconciliationOnly = accepted.stage === "DELIVERY_UNKNOWN";
            status = await router.runSession(request.payload.sessionId, async (/** @type {any} */ { metadata: lockedMetadata, route: lockedRoute, forget }) => {
              const complete = async () => {
                await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
                await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
                return context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
              };
              /** @param {string} code @param {string} message */
              const refuse = (code, message) => reconciliationOnly ? accepted : context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError(code, message));
              const record = await registry.get(request.payload.sessionId);
              const recovery = context.deleteResults.get(request);
              const routeSafe = (/** @type {any} */ current) => current.ownership === undefined &&
                !["LIVE", "SLEEPING"].includes(current.processState) &&
                lockedMetadata === undefined && lockedRoute === undefined &&
                !launchingSessions.has(current.sessionId) &&
                [...(attachmentClaims.get(current.sessionId)?.keys() ?? [])].every((candidate) => candidate === socket);
              const exactRecoveryRecord = (/** @type {any} */ current) => recovery !== undefined &&
                recovery.sessionId === request.payload.sessionId &&
                recovery.revision === request.payload.revision &&
                current.revision === recovery.revision &&
                current.canonicalSessionFile === recovery.canonicalSessionFile &&
                canonicalJson(current) === recovery.recordCanonical;

              if (recovery !== undefined) {
                if (record === undefined) {
                  try {
                    await inspectSessionFile(recovery.canonicalSessionFile);
                    return refuse("DELETE_RECONCILIATION_REFUSED", recovery.phase === "TRASHED" ? "A trashed Delete path is present again" : "Prepared Delete registry state is missing while its file remains present");
                  } catch (error) {
                    if (/** @type {any} */ (error)?.code !== "ENOENT") return refuse("DELETE_RECONCILIATION_REFUSED", "Recovered Delete file identity is ambiguous");
                    return reconciliationOnly ? accepted : complete();
                  }
                }
                if (!exactRecoveryRecord(record) || !routeSafe(record)) return refuse("DELETE_RECONCILIATION_REFUSED", "Delete state no longer matches the complete prepared record fingerprint and inactive safety boundary");
                try {
                  const currentIdentity = await inspectSessionFile(recovery.canonicalSessionFile);
                  if (canonicalJson(currentIdentity) !== canonicalJson(recovery.identity) || recovery.phase !== "PREPARED") return refuse("DELETE_RECONCILIATION_REFUSED", "Prepared Delete file identity was replaced or restored");
                  if (reconciliationOnly) return accepted;
                  if (!retryAtRisk) {
                    await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
                    return context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
                  }
                } catch (error) {
                  if (/** @type {any} */ (error)?.code !== "ENOENT") return refuse("DELETE_RECONCILIATION_REFUSED", "Prepared Delete file identity is ambiguous");
                  await registry.remove(record.sessionId, recovery.revision);
                  return reconciliationOnly ? accepted : complete();
                }
              } else {
                if (record === undefined) return refuse("SESSION_NOT_FOUND", "The exact session does not exist");
                if (record.revision !== request.payload.revision) return refuse("REVISION_CONFLICT", "Session revision changed before Delete");
              }
              if (record.ownership !== undefined || ["LIVE", "SLEEPING"].includes(record.processState)) return refuse("SESSION_LIVE", "Delete refuses a live or owned session");
              // A lease whose worker process is provably gone cannot be authoritative; reclaim it instead of refusing forever.
              if (lockedMetadata !== undefined && lockedRoute === undefined && await processIsGone(lockedMetadata.identity, inspect)) {
                await forget();
                lockedMetadata = undefined;
              }
              if (lockedMetadata !== undefined || lockedRoute !== undefined || launchingSessions.has(record.sessionId)) return refuse("OWNERSHIP_CONFLICT", "A worker lease, route, or launch is still authoritative");
              const claims = attachmentClaims.get(record.sessionId);
              if (claims !== undefined && [...claims.keys()].some((candidate) => candidate !== socket)) return refuse("SESSION_ATTACHED", "Delete refuses another attached frontend");
              if (trashSessionFile === undefined) {
                // Without an approved trash seam, Delete forgets the dashboard record and leaves Pi's session file and worktree untouched.
                await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
                await registry.remove(record.sessionId, record.revision);
                await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
                return context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
              }
              let original;
              try {
                original = recovery?.identity ?? await inspectSessionFile(record.canonicalSessionFile);
              } catch (error) {
                return refuse(/** @type {any} */ (error)?.code ?? "SESSION_PATH_UNSAFE", error instanceof Error ? error.message : "Session file identity is unsafe");
              }
              await destructiveFailpoint("delete_before_identity_recheck", request, record);
              const currentIdentity = await inspectSessionFile(record.canonicalSessionFile);
              if (canonicalJson(currentIdentity) !== canonicalJson(original)) return refuse("SESSION_IDENTITY_MISMATCH", "Session file was replaced before trash");
              const prepared = recovery ?? await context.deleteResults.prepare(request, record, original);
              if (recovery === undefined) await destructiveFailpoint("delete_after_prepare", request, record);
              const exactRecord = await registry.get(record.sessionId);
              if (exactRecord === undefined || canonicalJson(exactRecord) !== prepared.recordCanonical || !routeSafe(exactRecord)) return refuse("DELETE_REVALIDATION_FAILED", "Session record fingerprint or safety state changed before trash");
              await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
              try {
                await trashSessionFile(prepared.canonicalSessionFile, prepared.identity);
                await fs.lstat(prepared.canonicalSessionFile).then(() => { throw Object.assign(new Error("Trash seam left the original session file in place"), { code: "TRASH_FAILED" }); }, (error) => { if (error?.code !== "ENOENT") throw error; });
                await context.deleteResults.markTrashed(request);
                await destructiveFailpoint("delete_after_trash", request, record);
                const postTrashRecord = await registry.get(prepared.sessionId);
                if (postTrashRecord !== undefined && (canonicalJson(postTrashRecord) !== prepared.recordCanonical || !routeSafe(postTrashRecord))) {
                  await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
                  return context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "FAILED", dashboardError("DELETE_RECONCILIATION_REFUSED", "Post-trash SessionRecord no longer matches the prepared safety fingerprint"));
                }
                if (postTrashRecord !== undefined) await registry.remove(prepared.sessionId, prepared.revision);
                await destructiveFailpoint("delete_after_registry", request, record);
              } catch (error) {
                await fs.lstat(prepared.canonicalSessionFile).then(() => {}, async (missing) => { if (missing?.code === "ENOENT") await context.deleteResults.markTrashed(request).catch(() => {}); });
                const current = await context.recovery.journal.get(request);
                if (current?.stage === "DELIVERY_ATTEMPTED") return context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
                throw error;
              }
              await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
              return context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
            });
          }
        }
        if (["stop", "delete"].includes(request.op) && status.stage === "COMPLETED") sessionHandles.delete(request.payload.sessionId);
        if (request.op === "session_command" && request.payload.command === "set_session_name" && status.stage === "COMPLETED") {
          await runSessionLifecycle(registry, request.payload.sessionId, async () => {
            const current = await registry.get(request.payload.sessionId);
            if (current === undefined || current.name === request.payload.name) return;
            const updated = await registry.update(current.sessionId, current.revision, { name: request.payload.name, nameGenerated: false, updatedAt: new Date().toISOString() });
            await context.publishSession(updated);
          }, "set_session_name");
        }
        if (changed) {
          const publish = () => context.publishCommand(status);
          if (typeof request.payload?.sessionId === "string") await runSessionLifecycle(registry, request.payload.sessionId, publish, "publish_command");
          else await publish();
        }
        return { kind: "command", status };
      },
    };
    const socketPath = join(daemonDirectory, "control.sock");
    socketServer = createSocketServer({ socketPath, token, maxBytes, context });
    await socketServer.listen();
    socketOwned = true;
    context.broadcast = (/** @type {any} */ event) => {
      if (broadcastEvent !== undefined) return broadcastEvent(event, () => socketServer.broadcast(event));
      return socketServer.broadcast(event);
    };

    context.state = "RECONCILING";
    await updateDaemonLifecycleState(claim, "RECONCILING");
    const defaultReconcile = () => reconcileRuntime({
      root,
      daemonEpoch,
      inspect,
      router,
      signal: recoveryController.signal,
      onViewerReady: (viewer) => { context.viewerRecovery = viewer; },
      waitForReconnect: async (workers) => {
        const expected = workers.filter((worker) => worker.metadata !== undefined).map((worker) => worker.sessionId);
        if (expected.length === 0) return [];
        const deadline = Date.now() + reconnectTimeoutMs;
        while (Date.now() < deadline && !recoveryController.signal.aborted) {
          const connected = router.connectedSessionIds();
          if (expected.every((sessionId) => connected.includes(sessionId))) return connected;
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        return router.connectedSessionIds();
      },
    });
    const ready = (async () => {
      try {
        context.recovery = reconcile === undefined ? await defaultReconcile() : await reconcile({ root, daemonEpoch, router, defaultReconcile, signal: recoveryController.signal });
        context.viewerRecovery = context.recovery.viewer;
        if (context.recovery.conflicts.length > 0) throw Object.assign(new Error("Worker ownership conflicts block daemon recovery"), { code: "OWNERSHIP_CONFLICT", conflicts: context.recovery.conflicts });
        context.cursorStore = await createCursorStore(join(daemonDirectory, "event-acks.json"), daemonEpoch);
        context.launchResults = await createLaunchResultStore(join(daemonDirectory, "launch-results.json"));
        context.attachmentResults = await createAttachmentResultStore({ path: join(daemonDirectory, "attachment-results.jsonl") });
        context.deleteResults = await createDeleteResultStore(join(daemonDirectory, "delete-results.json"));
        for (const event of context.recovery.repairedSessions ?? []) context.broadcast(event);
        for (const entry of context.attachmentResults.entries()) await context.recovery.journal.reconcileAttachment(entry.request, entry.phase);
        for (const action of context.recovery.recoveryActions) {
          if (action.action === "SAFE_REDELIVERY" && !["attach", "detach"].includes(action.command.op)) await context.handleRequest(action.command, undefined, new Set(), action.command.clientId, true);
        }
        context.state = "READY";
        await updateDaemonLifecycleState(claim, "READY");
        return context.recovery;
      } catch (error) {
        context.state = "FAILED";
        const recoveryError = /** @type {any} */ (error);
        context.stateError = dashboardError(recoveryError?.code ?? "RECOVERY_FAILED", error instanceof Error ? error.message : "Daemon recovery failed");
        await updateDaemonLifecycleState(claim, "FAILED", error).catch(() => {});
        throw error;
      }
    })();
    let closeState = "OPEN";
    /** @type {Promise<void> | undefined} */
    let closePromise;
    return {
      root,
      socketPath,
      tokenPath,
      token,
      daemonEpoch,
      ready,
      stopRequested,
      status() { return { ...context.publicStatus(), connectedWorkers: router.connectedSessionIds(), closeState }; },
      /** Frontend sockets currently attached, which is what idle exit must never interrupt. */
      attachedFrontends() { return socketServer.sockets.size; },
      /** Workers whose supervisor and Pi child are still recorded as live. */
      liveWorkers() { return router.connectedSessionIds().length; },
      /** @param {any} key */
      async commandStatus(key) { await ready; return context.recovery.journal.get(key); },
      close() {
        if (closePromise !== undefined) return closePromise;
        closeState = "CLOSING";
        closePromise = (async () => {
          /** @type {unknown[]} */
          const errors = [];
          /** @param {string} stage @param {() => unknown | Promise<unknown>} action */
          const cleanup = async (stage, action) => {
            try {
              await closeFailpoint(stage);
            } catch (error) {
              errors.push(error);
            }
            try {
              await action();
            } catch (error) {
              errors.push(error);
            }
          };
          context.admissionOpen = false;
          recoveryController.abort();
          await cleanup("request_admission", () => socketServer.beginShutdown());
          await cleanup("reconciliation", async () => { await Promise.allSettled([ready]); });
          await cleanup("request_chains", () => socketServer.drainAndClose());
          await cleanup("supervisor", async () => workerSupervisor?.close?.());
          await cleanup("cursor_store", async () => context.cursorStore?.close());
          await cleanup("launch_result_store", async () => context.launchResults?.close());
          await cleanup("attachment_result_store", async () => context.attachmentResults?.close());
          await cleanup("delete_result_store", async () => context.deleteResults?.close());
          await cleanup("recovery_stores", async () => context.recovery?.close());
          await cleanup("lifecycle", () => releaseDaemonLifecycle(claim));
          closeState = errors.length === 0 ? "CLOSED" : "FAILED_CLOSED";
          if (errors.length > 0) {
            const failure = new AggregateError(errors, "Daemon close completed with cleanup errors");
            Object.assign(failure, { code: "DAEMON_CLOSE_FAILED" });
            throw failure;
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    if (socketServer !== undefined) {
      socketServer.beginShutdown();
      await socketServer.drainAndClose().catch(() => {});
    }
    await releaseDaemonLifecycle(claim, { preservePublication: false, removeSocket: socketOwned }).catch(() => {});
    if (!socketOwned && error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "EADDRINUSE") throw Object.assign(new Error("Daemon endpoint is already bound"), { code: "DAEMON_IDENTITY_CONFLICT", cause: error });
    throw error;
  }
}

/** Build the production launch seams used by the detached daemon entry point. @param {{root:string,piBin?:string,env?:NodeJS.ProcessEnv}} options */
export async function createDefaultDaemonRuntime({ root, piBin, env = process.env }) {
  const configText = await readPrivateText(join(root, "dashboard.json"));
  const config = loadDashboardConfig(configText === undefined ? {} : JSON.parse(configText));
  const configuredPiPath = piBin ?? config.pi.executable;
  const registry = new RegistryStore(join(root, "sessions"));
  const piConfigPath = resolve(getAgentDir());
  await ensurePrivateDirectory(piConfigPath);
  const piConfigRoot = await fs.realpath(piConfigPath);
  await sweepStaleWorktreeLocks({ worktreesRoot: join(piConfigRoot, "pi-dashboard", "worktrees"), startedAt: new Date().toISOString() }).catch(() => []);
  const workerSupervisor = new WorkerSupervisor({
    registry,
    runsDirectory: join(root, "runs"),
    maxLive: config.workers.maxLive,
    configuredPiPath,
    env,
    startTimeoutMs: config.daemon.startTimeoutMs,
    launchStopPolicy: config.stop,
  });
  return createDaemonRuntime({
    root,
    workerSupervisor,
    resolveLaunchRequest: createLaunchResolver({ registry, piConfigRoot }),
    summaryExecutable: configuredPiPath ?? "pi",
    summaryEnv: env,
    stopPolicy: config.stop,
  });
}

/** @param {NodeJS.ProcessEnv} [env] */
export function defaultRuntimeRoot(env = process.env) {
  const home = env.HOME ?? homedir();
  return resolve(env.PI_DASHBOARD_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-dashboard"));
}

async function runMain() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const piBinFlag = argv.indexOf("--pi-bin");
  const root = rootFlag >= 0 ? argv[rootFlag + 1] : defaultRuntimeRoot();
  const piBin = piBinFlag >= 0 ? argv[piBinFlag + 1] : undefined;
  const idleFlag = argv.indexOf("--idle-exit-ms");
  const idleMs = idleFlag >= 0 ? Number(argv[idleFlag + 1]) : Number(process.env.PI_DASHBOARD_IDLE_EXIT_MS ?? 0);
  const runtime = await createDefaultDaemonRuntime({ root, piBin });
  try {
    await runtime.ready;
    await Promise.race([
      runtime.stopRequested,
      new Promise((resolveStop) => {
        process.once("SIGTERM", resolveStop);
        process.once("SIGINT", resolveStop);
        if (!Number.isFinite(idleMs) || idleMs <= 0) return;
        const idle = createIdleExit({ idleMs, now: () => Date.now(), onIdle: () => resolveStop(undefined), frontends: () => runtime.attachedFrontends(), workers: () => runtime.liveWorkers() });
        const timer = setInterval(() => idle.check(), Math.max(250, Math.min(idleMs, 5_000)));
        timer.unref?.();
      }),
    ]);
  } finally {
    await runtime.close();
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runMain().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = error?.code === "OWNERSHIP_CONFLICT" ? 5 : 1; });
