import net from "node:net";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJson } from "./atomic-file.mjs";
import { claimDaemonLifecycle, releaseDaemonLifecycle, updateDaemonLifecycleState } from "./daemon-lifecycle.mjs";
import { createJsonlDecoder, createJsonlEncoder, JsonlFramingError } from "./jsonl.mjs";
import { ensurePrivateDirectory, initializeRuntimePermissions } from "./permissions.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { RecoveredWorkerRouter, reconcileRuntime } from "./reconciliation.mjs";
import { RegistryStore } from "./registry-store.mjs";
import { reduceSessionState } from "./state-reducer.mjs";
import { parseClientRequest } from "../shared/contracts.js";

initializeRuntimePermissions();

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DURABLE_COMMANDS = new Set(["prompt", "steer", "follow_up", "interrupt", "stop", "delete", "ui_response"]);
const CONNECTOR_PATH = fileURLToPath(new URL("./daemon-connector.mjs", import.meta.url));

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
  const module = await import(new URL("../extensions/agents-dashboard/compatibility.ts", import.meta.url).href);
  return module.checkHostCapabilities();
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

/** @param {any} record @param {any} pending */
function validateWorkerSuccess(record, pending) {
  const allowed = ["clientId", "requestId", "op", "stage", "at", "result", "stderr"];
  if (typeof record !== "object" || record === null || Array.isArray(record) || Object.keys(record).some((key) => !allowed.includes(key)) || record.clientId !== pending.clientId || record.requestId !== pending.requestId || record.op !== pending.op || record.stage !== "RPC_ACKNOWLEDGED" || typeof record.at !== "string") throw Object.assign(new Error("Worker result does not match the pending durable command"), { code: "INVALID_WORKER_RESULT" });
}

/** @param {any} error */
function validateWorkerFailure(error) {
  if (typeof error !== "object" || error === null || Array.isArray(error) || Object.keys(error).some((key) => !["code", "message", "deliveryUnknown"].includes(key)) || typeof error.code !== "string" || typeof error.message !== "string" || (error.deliveryUnknown !== undefined && typeof error.deliveryUnknown !== "boolean")) throw Object.assign(new Error("Worker failure result is invalid"), { code: "INVALID_WORKER_RESULT" });
}

/** @param {{ socketPath: string, token: string, maxBytes: number, context: any }} options */
function createSocketServer({ socketPath, token, maxBytes, context }) {
  const sockets = new Set();
  const subscribers = new Set();
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
      sockets.delete(socket);
      subscribers.delete(socket);
      const attachmentRelease = context.releaseAttachments?.(socket);
      if (attachmentRelease !== undefined) {
        chains.add(attachmentRelease);
        void attachmentRelease.finally(() => chains.delete(attachmentRelease)).catch(() => {});
      }
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
              return;
            }
            await context.handleWorkerFrame(frame, workerConnection, workerMetadata, workerRouteGeneration);
            return;
          }
          let request;
          try {
            request = parseClientRequest(frame);
          } catch {
            await send({ version: 1, requestId: typeof frame?.requestId === "string" ? frame.requestId : "invalid-request", ok: false, error: dashboardError("INVALID_REQUEST", "Invalid client request") });
            return;
          }
          if (frontendClientId === undefined) frontendClientId = request.clientId;
          if (frontendClientId !== request.clientId) {
            await send(failure(request.requestId, Object.assign(new Error("Client identity changed on an authenticated connection"), { code: "CLIENT_IDENTITY_CONFLICT" })));
            return;
          }
          try {
            const result = await context.handleRequest(request, socket, subscribers, frontendClientId);
            await context.writeResponse({ request, value: response(request.requestId, result), write: send, close });
            if (request.op === "subscribe") {
              const replay = await context.recovery.events.replay(request.payload.after);
              for (const event of replay) await send(event);
            }
          } catch (error) {
            await send(failure(request.requestId, error)).catch(() => {});
          }
        });
        chain = operation.catch(() => { socket.destroy(); });
        chains.add(operation);
        void operation.finally(() => chains.delete(operation)).catch(() => {});
      }
    });
    socket.on("end", () => {
      try {
        decoder.end();
      } catch (error) {
        const framing = /** @type {{ code?: string, message?: string }} */ (error);
        void send({ version: 1, ok: false, error: dashboardError(framing.code ?? "INCOMPLETE_FRAME", framing.message ?? "Incomplete frame") }).catch(() => {});
      }
      socket.end();
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
      for (const socket of subscribers) if (!socket.destroyed) socket.write(encoded, () => {});
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
  randomId = randomUUID,
  responseWriter = async (/** @type {any} */ { value, write }) => write(value),
  closeFailpoint = async () => {},
} = {}) {
  if (typeof root !== "string" || resolve(root) !== root) throw new TypeError("Daemon runtime root must be an absolute canonical path");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError("maxBytes must be at least 128");
  if (typeof randomId !== "function") throw new TypeError("randomId must be a function");
  if (typeof responseWriter !== "function" || typeof closeFailpoint !== "function") throw new TypeError("Daemon runtime seams must be functions");
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
    /** @type {Map<string, Map<net.Socket, { clientId: string, role: "composer" | "observer" }>>} */
    const attachmentClaims = new Map();
    /** @type {WeakMap<net.Socket, Map<string, { serialized: string, result: any }>>} */
    const attachmentRequests = new WeakMap();
    /** @type {Map<string, Promise<unknown>>} */
    const attachmentTails = new Map();
    /** @type {any} */
    const context = {
      state: "STARTING",
      stateError: undefined,
      admissionOpen: true,
      recovery: undefined,
      cursorStore: undefined,
      launchResults: undefined,
      router,
      workerPending: new Map(),
      hostReport: undefined,
      broadcast: () => {},
      writeResponse: responseWriter,
      requestStop: () => resolveStopRequested(undefined),
      publicStatus() { return { state: context.state, recovering: ["STARTING", "RECONCILING"].includes(context.state), error: context.stateError, daemonEpoch, pid: identity.pid }; },
      /** @param {string} sessionId @param {() => Promise<any>} operation */
      serializeAttachment(sessionId, operation) {
        const previous = attachmentTails.get(sessionId) ?? Promise.resolve();
        const result = previous.catch(() => {}).then(operation);
        const tail = result.catch(() => {});
        attachmentTails.set(sessionId, tail);
        void tail.finally(() => {
          if (attachmentTails.get(sessionId) === tail) attachmentTails.delete(sessionId);
        });
        return result;
      },
      /** @param {string} sessionId @param {string} clientId @param {"composer" | "observer"} role @param {boolean} attached */
      async publishAttachment(sessionId, clientId, role, attached) {
        if (context.recovery?.events === undefined) return;
        const event = await context.recovery.events.append({ kind: "attachment_changed", payload: { sessionId, clientId, role, attached } });
        context.broadcast(event);
      },
      /** @param {any} request @param {net.Socket} socket */
      async arbitrateAttachment(request, socket) {
        let cache = attachmentRequests.get(socket);
        if (cache === undefined) {
          cache = new Map();
          attachmentRequests.set(socket, cache);
        }
        const cacheKey = `${request.clientId}\u0000${request.requestId}`;
        const serialized = JSON.stringify(request);
        const cached = cache.get(cacheKey);
        if (cached !== undefined) {
          if (cached.serialized !== serialized) throw Object.assign(new Error("Attachment request ID was reused with changed content"), { code: "IDEMPOTENCY_CONFLICT" });
          return cached.result;
        }
        const sessionId = request.payload.sessionId;
        const result = await context.serializeAttachment(sessionId, async () => {
          let claims = attachmentClaims.get(sessionId);
          if (claims === undefined) {
            claims = new Map();
            attachmentClaims.set(sessionId, claims);
          }
          const prior = claims.get(socket);
          if (request.op === "detach") {
            if (prior !== undefined) {
              claims.delete(socket);
              await context.publishAttachment(sessionId, prior.clientId, prior.role, false);
            }
            if (claims.size === 0) attachmentClaims.delete(sessionId);
            return { kind: "detached", sessionId };
          }
          const composer = [...claims.values()].find((claim) => claim.role === "composer");
          const grantedRole = request.payload.role === "composer" && (composer === undefined || composer.clientId === request.clientId)
            ? "composer"
            : "observer";
          if (prior !== undefined && prior.clientId === request.clientId && prior.role === grantedRole) return { kind: "attached", sessionId, role: grantedRole };
          if (prior !== undefined) await context.publishAttachment(sessionId, prior.clientId, prior.role, false);
          claims.set(socket, { clientId: request.clientId, role: grantedRole });
          await context.publishAttachment(sessionId, request.clientId, grantedRole, true);
          return { kind: "attached", sessionId, role: grantedRole };
        });
        cache.set(cacheKey, { serialized, result });
        return result;
      },
      /** @param {net.Socket} socket */
      async releaseAttachments(socket) {
        const sessionIds = [...attachmentClaims].filter(([, claims]) => claims.has(socket)).map(([sessionId]) => sessionId);
        await Promise.all(sessionIds.map((sessionId) => context.serializeAttachment(sessionId, async () => {
          const claims = attachmentClaims.get(sessionId);
          if (claims === undefined) return;
          const prior = claims.get(socket);
          if (prior === undefined) return;
          claims.delete(socket);
          await context.publishAttachment(sessionId, prior.clientId, prior.role, false);
          if (claims.size === 0) attachmentClaims.delete(sessionId);
        })));
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
        if (context.state !== "READY") throw Object.assign(new Error("Daemon recovery is still in progress"), { code: "RECOVERING", retryable: true });
        const eventKeys = ["version", "type", "token", "sessionId", "event"];
        if (frame.type !== "worker_event" || frame.version !== 1 || frame.sessionId !== metadata.sessionId || Object.keys(frame).some((key) => !eventKeys.includes(key)) || typeof frame.event !== "object" || frame.event === null || Array.isArray(frame.event)) throw Object.assign(new Error("Invalid worker frame"), { code: "INVALID_WORKER_FRAME" });
        await router.runCurrent(metadata, connection, routeGeneration, async () => {
          const record = await registry.get(frame.sessionId);
          if (record?.ownership === undefined || record.ownership.runId !== metadata.runId) throw Object.assign(new Error("Worker event ownership conflict"), { code: "OWNERSHIP_CONFLICT" });
          const next = reduceSessionState(record, frame.event);
          const updated = next === record ? record : await registry.update(record.sessionId, record.revision, { taskState: next.taskState, processState: next.processState, outcome: next.outcome, activity: next.activity, updatedAt: next.updatedAt });
          const event = await context.recovery.events.append({ kind: "session_changed", payload: { session: updated } });
          context.broadcast(event);
        });
      },
      /** @param {any} request @param {net.Socket | undefined} socket @param {Set<net.Socket>} subscribers @param {string} [authenticatedClientId] */
      async handleRequest(request, socket, subscribers, authenticatedClientId = request.clientId, duringRecovery = false) {
        if (!context.admissionOpen) throw Object.assign(new Error("Daemon is shutting down"), { code: "SHUTTING_DOWN", retryable: true });
        if (request.op === "get_state") return { kind: "state", sessions: await registry.list() };
        if (context.state !== "READY" && !duringRecovery) throw Object.assign(new Error(context.state === "FAILED" ? context.stateError?.message ?? "Daemon recovery failed" : "Daemon recovery is still in progress"), { code: context.state === "FAILED" ? context.stateError?.code ?? "RECOVERY_FAILED" : "RECOVERING", retryable: context.state !== "FAILED" });
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
          const event = await context.recovery.events.append({ kind: "command_changed", payload: { status } });
          context.broadcast(event);
          return { kind: "command", status };
        }
        if (request.op === "launch") {
          const accepted = await context.recovery.journal.accept(request);
          const priorResult = context.launchResults.get(request);
          if (accepted.stage === "COMPLETED" && priorResult !== undefined) return { kind: "launched", sessionId: priorResult.sessionId };
          if (accepted.stage !== "ACCEPTED") return { kind: "command", status: accepted };
          context.hostReport ??= await hostProbe();
          if (context.hostReport.blockers?.length > 0 || context.hostReport.daemonOwnedStartup === false || context.hostReport.nativeAttach === false) {
            const status = await context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("UNSUPPORTED_HOST", "Pi host does not support daemon-owned product launch"));
            return { kind: "command", status };
          }
          if (workerSupervisor === undefined || typeof resolveLaunchRequest !== "function") {
            const status = await context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("LAUNCH_UNAVAILABLE", "Daemon launch resolver is unavailable"));
            return { kind: "command", status };
          }
          await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
          try {
            const launch = await resolveLaunchRequest(request);
            const handle = await workerSupervisor.launch({ ...launch, daemonConnector: CONNECTOR_PATH, daemonConnectConfig: { socketPath: join(daemonDirectory, "control.sock"), tokenPath, maxBytes } });
            await router.register(handle);
            const persisted = await context.launchResults.put(request, { sessionId: handle.sessionId });
            await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
            await context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
            return { kind: "launched", sessionId: persisted.sessionId };
          } catch (error) {
            const current = await context.recovery.journal.get(request);
            if (current?.stage === "DELIVERY_ATTEMPTED") await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
            throw error;
          }
        }
        if (request.op === "attach" || request.op === "detach") {
          if (socket === undefined) throw new TypeError("Attachment requires a live socket");
          return context.arbitrateAttachment(request, socket);
        }
        if (!DURABLE_COMMANDS.has(request.op)) throw Object.assign(new Error(`Unsupported daemon operation: ${request.op}`), { code: "UNSUPPORTED_OPERATION" });
        const accepted = await context.recovery.journal.accept(request);
        let status = accepted;
        const changed = accepted.stage === "ACCEPTED";
        if (accepted.stage === "ACCEPTED") {
          const route = router.route(request.payload.sessionId);
          const connection = route?.connection;
          const metadata = route?.metadata;
          if (connection === undefined || metadata?.token === undefined) {
            status = await context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("WORKER_UNAVAILABLE", "No exact recovered worker owns this session"));
          } else if (["prompt", "steer", "follow_up", "interrupt"].includes(request.op)) {
            const id = randomId();
            if (typeof id !== "string" || id.length < 16 || usedCommandIds.has(id)) throw Object.assign(new Error("Command ID generator did not provide a unique restart-safe ID"), { code: "COMMAND_ID_COLLISION" });
            usedCommandIds.add(id);
            await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
            const retryAtRisk = (await context.recovery.journal.history(request)).some((/** @type {any} */ prior) => prior.stage === "DELIVERY_UNKNOWN");
            try {
              await connection.request({ version: 1, type: "command", token: metadata.token, id, command: { clientId: request.clientId, requestId: request.requestId, op: request.op, text: request.payload.text, retryAtRisk } }, { clientId: request.clientId, requestId: request.requestId, op: request.op, durableRequest: request, metadata, routeGeneration: route.routeGeneration, sessionId: metadata.sessionId, runId: metadata.runId, leaseId: metadata.leaseId, generation: metadata.generation });
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
          } else status = await context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("OPERATION_UNAVAILABLE", "Destructive worker workflow is not assembled in this task"));
        }
        if (changed) {
          const event = await context.recovery.events.append({ kind: "command_changed", payload: { status } });
          context.broadcast(event);
        }
        return { kind: "command", status };
      },
    };
    const socketPath = join(daemonDirectory, "control.sock");
    socketServer = createSocketServer({ socketPath, token, maxBytes, context });
    await socketServer.listen();
    socketOwned = true;
    context.broadcast = (/** @type {any} */ event) => socketServer.broadcast(event);
    context.state = "RECONCILING";
    await updateDaemonLifecycleState(claim, "RECONCILING");
    const defaultReconcile = () => reconcileRuntime({
      root,
      daemonEpoch,
      inspect,
      router,
      signal: recoveryController.signal,
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
        if (context.recovery.conflicts.length > 0) throw Object.assign(new Error("Worker ownership conflicts block daemon recovery"), { code: "OWNERSHIP_CONFLICT", conflicts: context.recovery.conflicts });
        context.cursorStore = await createCursorStore(join(daemonDirectory, "event-acks.json"), daemonEpoch);
        context.launchResults = await createLaunchResultStore(join(daemonDirectory, "launch-results.json"));
        for (const action of context.recovery.recoveryActions) if (action.action === "SAFE_REDELIVERY") await context.handleRequest(action.command, undefined, new Set(), action.command.clientId, true);
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

/** @param {NodeJS.ProcessEnv} [env] */
export function defaultRuntimeRoot(env = process.env) {
  const home = env.HOME ?? homedir();
  return resolve(env.PI_AGENTS_DASHBOARD_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-agents-dashboard"));
}

async function runMain() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag >= 0 ? argv[rootFlag + 1] : defaultRuntimeRoot();
  const runtime = await createDaemonRuntime({ root });
  try {
    await runtime.ready;
    await Promise.race([
      runtime.stopRequested,
      new Promise((resolveStop) => {
        process.once("SIGTERM", resolveStop);
        process.once("SIGINT", resolveStop);
      }),
    ]);
  } finally {
    await runtime.close();
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runMain().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = error?.code === "OWNERSHIP_CONFLICT" ? 5 : 1; });
