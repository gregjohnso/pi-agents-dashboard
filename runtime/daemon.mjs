import net from "node:net";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { claimDaemonLifecycle, releaseDaemonLifecycle, updateDaemonLifecycleState } from "./daemon-lifecycle.mjs";
import { createJsonlDecoder, createJsonlEncoder, JsonlFramingError } from "./jsonl.mjs";
import { createLaunchResolver } from "./launch-resolver.mjs";
import { sweepStaleWorktreeLocks } from "../isolation/lock-sweep.mjs";
import { ensurePrivateDirectory, initializeRuntimePermissions } from "./permissions.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "./process-signaler.mjs";
import { PI_CHILD_CRASH_REPORTED, RecoveredWorkerRouter, WORKER_UNREACHABLE, reconcileRuntime } from "./reconciliation.mjs";
import { connectToWorker } from "./worker-socket.mjs";
import { openSettingsStore, summarizePromptInput, summarizeWithPi } from "./summaries.mjs";
import { RegistryStore, applySessionColor, applySessionUpdate, runSessionLifecycle } from "./registry-store.mjs";
import { sessionCommandPayload } from "./session-command-projection.mjs";
import { reduceSessionState } from "./state-reducer.mjs";
import { createIdleExit, resolveIdleExitMs } from "./idle-exit.mjs";
import { spawn as spawnProcess } from "node:child_process";
import { createModelCatalog } from "./pi-model-catalog.mjs";
import { WorkerSupervisor } from "./worker-supervisor.mjs";
import { inspectWorkerTerminalCause, retireWorkerTerminalCause, workerTerminalCausePath } from "./worker-terminal-cause.mjs";
import { loadDashboardConfig } from "../shared/config.mjs";
import { CLIENT_PROTOCOL, parseClientRequest, piConfirmedModel } from "../shared/contracts.mjs";

initializeRuntimePermissions();

const DEFAULT_MAX_BYTES = 1024 * 1024;
const WORKER_DELIVERED_COMMANDS = ["prompt", "steer", "follow_up", "interrupt", "ui_response", "session_command"];
/** Operations that change a session: routed to its worker, or acting on its record and its process. */
const SESSION_MUTATIONS = new Set([...WORKER_DELIVERED_COMMANDS, "stop", "delete", "respawn"]);
/** Stop dispositions that prove the signalled process group is gone. */
const TERMINAL_STOP_DISPOSITIONS = ["ALREADY_EXITED", "GRACEFUL", "TERMINATED", "KILLED"];
/** Release statuses whose worker this daemon replaces. A newer worker is never downgraded. */
const REPLACEABLE_RELEASES = new Set(["STALE", "UNKNOWN"]);
/**
 * Automatic upgrade respawns in flight across sessions. An idle boundary is never urgent, and an
 * unbounded burst would restart every session at once the first time an upgraded daemon starts.
 * A session that settles while the bound is full is deferred, not dropped: the next replacement to
 * finish frees a slot and re-decides it.
 */
const MAX_UPGRADE_RESPAWNS = 3;
/**
 * What a live worker this daemon cannot reach costs, and the one way out of it.
 *
 * The commonest cause is an upgrade: a worker spawned by the previous release listens on nothing,
 * because that release had the daemon listen and the worker connect out. Stop is not blocked by it,
 * since Stop signals the process identity the record holds and never needs the route.
 */
const UNREACHABLE_WORKER_MESSAGE = "This session's worker is running but cannot be reached on its socket.";
const UNREACHABLE_WORKER_FIX = "Stop it with `pi-agents stop <full-session-id> --revision <n> --yes`, then reopen the session to start a worker this daemon can reach.";
/** This package's manifest. Its version is the release recorded for every worker this daemon spawns. */
const PACKAGE_MANIFEST_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const DEFAULT_STOP_POLICY = Object.freeze({ gracefulMs: 5_000, terminateMs: 5_000 });
/**
 * How long the daemon waits for one worker's reply before the command becomes ambiguous. A worker
 * bounds each Pi command at 120 s and delivers them serially, so this leaves room for one command
 * expiring behind another before the daemon stops waiting on a worker that answers nothing.
 */
const WORKER_REQUEST_TIMEOUT_MS = 300_000;
/**
 * Frames one worker may replay in its live tail. The worker bounds that tail by bytes
 * (`MAX_LIVE_TAIL_BYTES`), and this bounds the count a daemon will parse from a frame it did not
 * write, so a malformed tail is refused rather than walked.
 */
const MAX_LIVE_TAIL_FRAMES = 8_192;
const WORKTREE_ROOT_DIRECTORIES = ["pi-agents", "pi-dashboard", "pi-agents-dashboard"];

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

/** Refuse one operation with a code its caller can act on. @param {string} code @param {string} message @param {boolean} [retryable] */
function refusal(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
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
  for (const directory of ["daemon", "sessions", "runs", "index"]) await ensurePrivateDirectory(join(root, directory));
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

/** @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** @param {any} record @param {any} pending */
function validateWorkerSuccess(record, pending) {
  const allowed = ["clientId", "requestId", "op", "stage", "at", "result", "stderr", "text"];
  if (typeof record !== "object" || record === null || Array.isArray(record) || Object.keys(record).some((key) => !allowed.includes(key)) || record.clientId !== pending.clientId || record.requestId !== pending.requestId || record.op !== pending.op || record.stage !== "RPC_ACKNOWLEDGED" || typeof record.at !== "string") throw Object.assign(new Error("Worker result does not match the pending durable command"), { code: "INVALID_WORKER_RESULT" });
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

/**
 * Report whether one row sits at a safe worker-replacement boundary.
 *
 * Only the reduced record decides. Terminal bytes and the canonical Pi session file may never open
 * this boundary, and WAITING is Pi blocked on a person rather than an idle session, so a false idle
 * fact cannot cost the operator a running turn.
 * @param {any} record
 */
function idleForRespawn(record) {
  return record?.taskState === "READY" && record.processState === "LIVE" && record.activity?.kind !== "blocking_request";
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

/**
 * Open one authenticated connection to a worker's own socket, carrying the request correlation the
 * daemon's commands travel on.
 *
 * The worker listens and this connects, so a connection exists only because this daemon asked for
 * one. A connection that ends leaves every command it carried ambiguous rather than failed: the
 * bytes may already have reached Pi, and only the worker's replay log can say.
 * @param {{ workerPending: Map<string, any>, workerRequestTimeoutMs: number }} options
 */
function createWorkerConnector({ workerPending, workerRequestTimeoutMs }) {
  return async (/** @type {{ socketPath: string, token: string, maxBytes: number, timeoutMs: number }} */ options) => {
    const transport = await connectToWorker(options);
    /** @type {any} */
    const connection = {
      closed: transport.closed,
      close: transport.close,
      send: transport.send,
      onMessage: transport.onMessage,
      /** @param {any} message @param {any} expected */
      request(message, expected) {
        return new Promise((resolveRequest, rejectRequest) => {
          const id = message.id;
          /** @type {any} */
          const pending = { ...expected, resolve: resolveRequest, reject: rejectRequest, connection };
          // A worker that never answers leaves the command's delivery unknown, not failed.
          pending.timer = setTimeout(() => {
            if (workerPending.get(id) !== pending) return;
            workerPending.delete(id);
            rejectRequest(Object.assign(new Error("Worker did not answer within the delivery bound"), { code: "DELIVERY_UNKNOWN" }));
          }, workerRequestTimeoutMs);
          workerPending.set(id, pending);
          Promise.resolve(transport.send(message)).catch((error) => {
            if (workerPending.get(id) !== pending) return;
            workerPending.delete(id);
            clearTimeout(pending.timer);
            rejectRequest(error);
          });
        });
      },
    };
    transport.closed.then(() => {
      for (const [id, pending] of workerPending) {
        if (pending.connection !== connection || workerPending.get(id) !== pending) continue;
        workerPending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error("Worker delivery became ambiguous"), { code: "DELIVERY_UNKNOWN" }));
      }
    }, () => {});
    return connection;
  };
}

/** @param {{ socketPath: string, token: string, maxBytes: number, context: any }} options */
function createSocketServer({ socketPath, token, maxBytes, context }) {
  const sockets = new Set();
  /** Dashboard connections. A worker holds a connection too, and idle exit must not read it as a client. */
  const frontendSockets = new Set();
  /** Sockets watching the session list. They receive payload-free invalidations and nothing else. */
  const listSubscribers = new Set();
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
    // Every connection re-arms the idle window here, before it authenticates, so a liveness probe
    // keeps the daemon up for the client it precedes rather than racing that client's connect.
    context.touchIdle();
    broadcastWriters.set(socket, createBoundedSocketWriter(socket, { maxPendingBytes: Math.min(4 * maxBytes, 4 * 1024 * 1024), maxPendingRecords: 256 }));
    let authenticated = false;
    let role = "frontend";
    /** The client protocol a frontend connection declared, if it declared one. @type {number | undefined} */
    let clientProtocol;
    /** The dashboard process this connection belongs to, which lives and dies with that process. @type {string | undefined} */
    let attachId;
    /** @type {string | undefined} */
    let frontendClientId;
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
    socket.on("close", () => {
      sockets.delete(socket);
      frontendSockets.delete(socket);
      listSubscribers.delete(socket);
      broadcastWriters.delete(socket);
      const activeViewerSubscriptions = viewerSubscriptions.get(socket) ?? [];
      viewerSubscriptions.delete(socket);
      for (const subscription of activeViewerSubscriptions) void subscription.return?.();
      context.releaseAttachments(socket);
      resolveClosed(undefined);
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
            const allowed = ["version", "token", "role", "action", "clientProtocol", "attachId"];
            if (typeof frame !== "object" || frame === null || Array.isArray(frame) || Object.keys(frame).some((key) => !allowed.includes(key)) || frame.version !== 1 || !sameToken(frame.token, token) || (frame.role !== undefined && !["frontend", "control"].includes(frame.role)) || (frame.action !== undefined && (frame.role !== "control" || frame.action !== "stop")) || (frame.clientProtocol !== undefined && !Number.isSafeInteger(frame.clientProtocol)) || (frame.attachId !== undefined && (typeof frame.attachId !== "string" || frame.attachId.length === 0 || frame.attachId.trim() !== frame.attachId))) {
              await send({ version: 1, ok: false, error: dashboardError(frame?.version === 1 ? "AUTHENTICATION_FAILED" : "UNSUPPORTED_VERSION", "Invalid daemon authentication") });
              socket.end();
              return;
            }
            role = frame.role ?? "frontend";
            if (role === "frontend") frontendSockets.add(socket);
            clientProtocol = frame.clientProtocol;
            attachId = frame.attachId;
            authenticated = true;
            await send({ version: 1, kind: "authenticated", ...context.publicStatus() });
            if (role === "control") {
              context.requestStop();
              socket.end();
            }
            return;
          }
          // A frontend that did not declare this release's client protocol is refused at its first
          // request, not at authentication: the daemon-liveness probe sends no request, so a new
          // command-line client can still find and stop an older daemon during the upgrade.
          if (clientProtocol !== CLIENT_PROTOCOL) {
            await send({
              version: 1,
              requestId: typeof frame?.requestId === "string" ? frame.requestId : "invalid-request",
              ok: false,
              error: dashboardError("UNSUPPORTED_CLIENT_PROTOCOL", `This daemon speaks client protocol ${CLIENT_PROTOCOL}; restart every dashboard on the same release`),
            });
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
              error: dashboardError(revisionRequired ? "REVISION_REQUIRED" : "INVALID_REQUEST", revisionRequired ? "Stop, Delete, and Respawn require an exact registry revision" : "Invalid client request"),
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
            const result = await context.handleRequest(request, { socket, attachId }, frontendClientId);
            viewerSubscription = result?._viewerSubscription;
            const publicResult = viewerSubscription === undefined ? result : { kind: result.kind, cursor: result.cursor, snapshot: result.snapshot };
            await context.writeResponse({ request, value: response(request.requestId, publicResult), write: send, close });
            if (viewerSubscription !== undefined) {
              let active = viewerSubscriptions.get(socket);
              if (active === undefined) { active = new Set(); viewerSubscriptions.set(socket, active); }
              active.add(viewerSubscription);
              const sessionId = request.payload.sessionId;
              // A stream that stops mid-turn says so on its own frame rather than destroying this
              // socket. Destroying it took the session list down with one viewer's bound, and a
              // second response frame for an answered request reaches no pending request at all.
              void pumpViewerSubscription(viewerSubscription, send)
                .catch((error) => send({ version: 1, kind: "viewer_stream_failed", sessionId, error: dashboardError(/** @type {any} */ (error)?.code ?? "VIEWER_STREAM_FAILED", error instanceof Error ? error.message : "Viewer stream stopped") }))
                .catch(() => socket.destroy())
                .finally(() => active.delete(viewerSubscription));
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
    listSubscribers,
    sockets,
    frontendSockets,
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
    /** Tell every list subscriber the session list changed, without saying what changed. */
    broadcastListChanged() {
      const encoded = createJsonlEncoder({ maxBytes }).encode({ version: 1, kind: "list_changed" });
      for (const socket of listSubscribers) broadcastWriters.get(socket)?.enqueue(encoded);
    },

    beginShutdown() {
      if (!accepting) return;
      accepting = false;
      for (const [id, pending] of context.workerPending) {
        context.workerPending.delete(id);
        clearTimeout(pending.timer);
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
  workerRequestTimeoutMs = WORKER_REQUEST_TIMEOUT_MS,
  workerSupervisor,
  resolveLaunchRequest,
  summarizeSession,
  summaryExecutable = "pi",
  summaryEnv = process.env,
  modelCatalog = createModelCatalog({ executable: summaryExecutable, spawn: spawnProcess, env: summaryEnv }),
  randomId = randomUUID,
  responseWriter = async (/** @type {any} */ { value, write }) => write(value),
  recordDiagnostic = (/** @type {any} */ entry) => { process.stderr.write(`${JSON.stringify(entry)}\n`); },
  stopPolicy = DEFAULT_STOP_POLICY,
  signalProcessGroupImpl = signalProcessGroup,
  sleepImpl = sleep,
  cliVersion,
} = {}) {
  if (typeof root !== "string" || resolve(root) !== root) throw new TypeError("Daemon runtime root must be an absolute canonical path");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError("maxBytes must be at least 128");
  if (!Number.isSafeInteger(workerRequestTimeoutMs) || workerRequestTimeoutMs <= 0) throw new TypeError("workerRequestTimeoutMs must be a positive integer");
  if (typeof randomId !== "function") throw new TypeError("randomId must be a function");
  if (typeof responseWriter !== "function" || typeof recordDiagnostic !== "function" || typeof signalProcessGroupImpl !== "function" || typeof sleepImpl !== "function") throw new TypeError("Daemon runtime seams must be functions");
  if (!Number.isSafeInteger(stopPolicy?.gracefulMs) || stopPolicy.gracefulMs <= 0 || !Number.isSafeInteger(stopPolicy?.terminateMs) || stopPolicy.terminateMs <= 0) throw new TypeError("stopPolicy must contain approved positive integer waits");
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
    /** Commands whose bytes are with a worker that still owes a reply. @type {Map<string, any>} */
    const workerPending = new Map();
    const router = new RecoveredWorkerRouter({
      registry,
      inspect,
      metadataPath: join(daemonDirectory, "workers.json"),
      maxBytes,
      cliVersion,
      connect: createWorkerConnector({ workerPending, workerRequestTimeoutMs }),
      onWorkerFrame: (frame, connection, metadata, routeGeneration) => context.handleWorkerFrame(frame, connection, metadata, routeGeneration),
      onRouteAdopted: async (route, launched) => {
        unreachableWorkers.delete(route.metadata.sessionId);
        await context.recovery?.viewer?.ensure(route.metadata.sessionId).catch(() => {});
        // A launch already knows this session's state; a reconnect has to re-derive it from Pi,
        // because a turn can both finish and start while the daemon is absent.
        if (!launched) void context.reconcileSessionActivity(route).catch(() => {});
      },
      onWorkerUnreachable: (report) => context.reportUnreachableWorker(report),
      reconnectTimeoutMs,
    });
    workerSupervisor?.useRouter?.(router);
    await router.load();
    /** @type {(value?: unknown) => void} */
    let resolveStopRequested = () => {};
    const stopRequested = new Promise((resolveStop) => { resolveStopRequested = resolveStop; });
    const recoveryController = new AbortController();
    const usedCommandIds = new Set();
    /**
     * How far this daemon's session list has advanced, in memory only. It states what a `get_state`
     * snapshot covers; it is not a position anything replays from, and it does not survive a restart.
     */
    let listSequence = 0;
    const listCoverageCursor = () => ({ daemonEpoch, sequence: String(listSequence) });
    const settingsStore = await openSettingsStore({ directory: daemonDirectory });
    /** @type {Set<string>} */
    const summarizing = new Set();
    const launchingSessions = new Set();
    const sessionStarts = new Map();
    /** Sessions whose automatic upgrade respawn is in flight, which bounds the burst after an upgrade. @type {Set<string>} */
    const upgradeRespawns = new Set();
    /** Sessions the burst bound turned away, waiting for a slot. Insertion order is the order they settled. @type {Set<string>} */
    const deferredUpgradeRespawns = new Set();
    /** Live workers this daemon could not connect to, and why. @type {Map<string, string>} */
    const unreachableWorkers = new Map();
    /**
     * Which dashboard connections currently have each session open. An attachment grants nothing:
     * every authenticated client may write. It records that a session is on someone's screen, which
     * is what Delete refuses to remove out from under, and it dies with its connection.
     * @type {Map<string, Map<net.Socket, { attachId: string | undefined }>>}
     */
    const attachedConnections = new Map();
    /** @type {WeakMap<net.Socket, Set<string>>} */
    const attachedSessions = new WeakMap();
    /** @type {any} */
    const context = {
      state: "STARTING",
      stateError: undefined,
      admissionOpen: true,
      recovery: undefined,
      viewerRecovery: undefined,
      listSubscribers: new Set(),
      router,
      workerPending,
      hostReport: undefined,
      notifyListChanged: () => {},
      writeResponse: responseWriter,
      requestStop: () => resolveStopRequested(undefined),
      /** Re-armed by every accepted connection; replaced by the idle window this daemon runs on. */
      touchIdle: () => {},
      publicStatus() { return { state: context.state, recovering: ["STARTING", "RECONCILING"].includes(context.state), error: context.stateError, daemonEpoch, pid: identity.pid }; },
      /** Mint one worker command ID that no earlier command in this daemon has used. */
      nextCommandId() {
        const id = randomId();
        if (typeof id !== "string" || id.length < 16 || usedCommandIds.has(id)) throw Object.assign(new Error("Command ID generator did not provide a unique restart-safe ID"), { code: "COMMAND_ID_COLLISION" });
        usedCommandIds.add(id);
        return id;
      },
      /** Send one command over an exact route, carrying the pending identity handleWorkerFrame checks the reply against. @param {any} route @param {string} id @param {any} clientRequest @param {Record<string, unknown>} [fields] */
      sendWorkerCommand(route, id, clientRequest, fields = {}) {
        const { metadata, connection, routeGeneration } = route;
        const { clientId, requestId, op } = clientRequest;
        return connection.request(
          { version: 1, type: "command", token: metadata.token, id, command: { clientId, requestId, op, ...fields } },
          { clientId, requestId, op, clientRequest, metadata, routeGeneration, sessionId: metadata.sessionId, runId: metadata.runId, leaseId: metadata.leaseId, generation: metadata.generation },
        );
      },
      /**
       * Route one command to the worker that owns this session and answer with that worker's reply.
       *
       * The daemon writes nothing durable here. The owning worker's replay log is the acceptance
       * boundary: it records the operator's text before the Pi write, and it is the only thing that
       * can say afterwards whether that write happened. A reply that never arrives, or a worker that
       * cannot attribute one, reaches the caller as DELIVERY_UNKNOWN and never as a clean failure.
       * @param {any} request @param {Record<string, unknown>} [fields]
       */
      async routeCommand(request, fields = {}) {
        const route = router.route(request.payload.sessionId);
        const unreachable = unreachableWorkers.get(request.payload.sessionId);
        if (route === undefined && unreachable !== undefined) throw refusal(unreachable, `${UNREACHABLE_WORKER_MESSAGE} ${UNREACHABLE_WORKER_FIX}`);
        if (route?.connection === undefined || route.metadata?.token === undefined) throw refusal("WORKER_UNAVAILABLE", "No adopted worker route owns this session");
        return context.sendWorkerCommand(route, context.nextCommandId(), request, fields);
      },
      /**
       * Add this session's adopted worker to one public row, so a reader of `agents --json` can tell
       * an adopted worker from a stale one without inspecting daemon memory.
       *
       * Adoption is not a session change, so it colours a read instead of writing a revision: an
       * operator's exact revision has to survive a daemon restart, and a revision-guarded Stop that
       * failed after every restart would teach the operator to retry past the guard. The release
       * comparison happens here, after the route is already adopted; an absent release is unknown,
       * which the row reports as stale.
       * @param {any} session
       */
      withWorkerAdoption(session) {
        const route = router.route(session.sessionId);
        // A live worker this daemon cannot reach says so on its own row, so the operator reads why a
        // session he can see refuses his text, and reads it before he types.
        const unreachable = unreachableWorkers.get(session.sessionId);
        if (route === undefined) return unreachable === undefined ? session : { ...session, workerUnreachable: unreachable };
        if (route.metadata?.runId !== session.ownership?.runId) return session;
        return {
          ...session,
          ...(route.metadata.cliVersion === undefined ? {} : { workerCliVersion: route.metadata.cliVersion }),
          stale: ["STALE", "UNKNOWN"].includes(router.releaseStatus(session.sessionId)),
          routeGeneration: route.routeGeneration,
        };
      },
      /**
       * Say on the row and in the transcript that this session's worker is being replaced.
       *
       * The replacement takes as long as a cold start, and it is the supervisor's own decision: the
       * operator's session was READY and stays READY through it, so without this the wait reads as a
       * hung prompt. Both surfaces come from this one structured transition; neither infers it from
       * terminal bytes or from how long a reply is taking.
       * @param {any} record
       */
      async announceWorkerReplacement(record) {
        const replacing = reduceSessionState(record, { type: "WORKER_REPLACING", at: new Date().toISOString() });
        await registry.update(record.sessionId, record.revision, { activity: replacing.activity, updatedAt: replacing.updatedAt });
        context.notifyListChanged();
      },
      /**
       * Restore the activity a refused or failed replacement announced, so a row that is not being
       * replaced stops saying that it is. The compare is on the announcement itself: a worker that
       * went on to report something newer keeps what it reported.
       * @param {string} sessionId @param {any} activity
       */
      async withdrawWorkerReplacement(sessionId, activity) {
        await applySessionUpdate(registry, sessionId, (current) => current.activity.kind === "replacing"
          ? { activity, updatedAt: new Date().toISOString() }
          : undefined).catch(() => {});
        context.notifyListChanged();
      },
      /** Record one refusal or failure to replace a worker; the worker itself keeps running. @param {string} sessionId @param {unknown} error */
      recordRespawnRefusal(sessionId, error) {
        const refusal = /** @type {any} */ (error);
        recordDiagnostic({ event: "respawn_refused", sessionId, code: refusal?.code ?? "RESPAWN_FAILED", message: error instanceof Error ? error.message : "Respawn failed", at: new Date().toISOString() });
      },
      /**
       * Replace one out-of-date worker, serialized under this session's lifecycle lock.
       *
       * Every fact the decision rests on is re-read here rather than carried from whatever opened the
       * boundary: the revision, the adopted route, both recorded process identities, the release, and
       * the idle state. The replacement runs to the same exact-identity signalling boundary Stop uses,
       * so nothing is signalled that is not still the process this session recorded.
       * @param {string} sessionId @param {{ revision?: number }} [options]
       */
      async replaceStaleWorker(sessionId, { revision } = {}) {
        /** @param {string} code @param {string} message */
        const refusal = (code, message) => Object.assign(new Error(message), { code });
        return router.runSession(sessionId, async (/** @type {any} */ { metadata, route, forget }) => {
          const record = await registry.get(sessionId);
          if (record === undefined) throw refusal("SESSION_NOT_FOUND", "The exact session does not exist");
          if (revision !== undefined && record.revision !== revision) throw refusal("REVISION_CONFLICT", "Session revision changed before respawn");
          if (route === undefined || metadata?.token === undefined || record.ownership === undefined || metadata.runId !== record.ownership.runId || !sameProcessIdentity(metadata.identity, record.ownership.process)) {
            throw refusal("WORKER_UNAVAILABLE", "No adopted worker route owns this session");
          }
          const release = router.releaseStatus(sessionId);
          if (release === "NEWER") throw refusal("WORKER_NEWER_THAN_DAEMON", "Respawn refuses to downgrade a worker newer than this daemon");
          if (!REPLACEABLE_RELEASES.has(release)) throw refusal("WORKER_CURRENT", "This session's worker already runs this daemon's release");
          if (!idleForRespawn(record)) throw refusal("SESSION_BUSY", "Respawn refuses a session that is not idle");
          // The intent is durable before anything is signalled, so a daemon that dies mid-replacement
          // resumes the guarded operation after it has adopted the worker again.
          await router.markPendingRespawn(sessionId, metadata.runId);
          const announced = record.activity;
          await context.announceWorkerReplacement(record);
          const disposition = await stopVerifiedProcessGroup(record.ownership.process, {
            inspect,
            requestGraceful: async () => { await route.connection.send({ version: 1, type: "shutdown", token: metadata.token }).catch(() => {}); },
            signalProcessGroup: signalProcessGroupImpl,
            sleep: sleepImpl,
          }, stopPolicy);
          if (!TERMINAL_STOP_DISPOSITIONS.includes(disposition.disposition)) {
            await context.withdrawWorkerReplacement(sessionId, announced);
            throw refusal(disposition.disposition, `Respawn stopped short of proof at the exact identity boundary: ${disposition.disposition}`);
          }
          const latest = await registry.get(sessionId);
          if (latest?.ownership?.runId === record.ownership.runId) {
            const exited = reduceSessionState(latest, { type: "WORKER_EXITED", at: new Date().toISOString() });
            const updated = await registry.update(latest.sessionId, latest.revision, { ownership: undefined, taskState: exited.taskState, processState: exited.processState, outcome: latest.outcome, activity: exited.activity, updatedAt: exited.updatedAt });
            context.notifyListChanged();
          }
          // The replaced run's private metadata, including its pending replacement, goes with the run.
          await forget();
          // The transcript says it once the worker is provably gone, so an open viewer never reads a
          // restart notice for a worker that is still running. A notice that cannot be written must
          // not cost the operator the replacement itself.
          const viewer = context.recovery?.viewer ?? context.viewerRecovery;
          await viewer?.ingest(sessionId, { type: "worker_replacing", id: `respawn:${record.ownership.runId}` })
            .catch((/** @type {unknown} */ error) => { recordDiagnostic({ event: "respawn_notice_failed", sessionId, code: /** @type {any} */ (error)?.code ?? "VIEWER_NOTICE_FAILED", message: error instanceof Error ? error.message : "Replacement notice failed", at: new Date().toISOString() }); });
          await context.ensureSessionWorker(sessionId);
        });
      },
      /**
       * Open the automatic replacement boundary for one session whose structured state is idle. A
       * worker already on this release needs no replacement and a newer one is never downgraded, so
       * neither reaches the guarded operation from here.
       * @param {string} sessionId @param {any} record
       */
      scheduleUpgradeRespawn(sessionId, record) {
        // A daemon that does not know its own release cannot judge a worker's, and replaces nothing.
        if (cliVersion === undefined || !idleForRespawn(record)) return;
        if (upgradeRespawns.has(sessionId)) return;
        if (router.route(sessionId) === undefined || !REPLACEABLE_RELEASES.has(router.releaseStatus(sessionId))) return;
        if (upgradeRespawns.size >= MAX_UPGRADE_RESPAWNS) {
          // The bound delays this replacement; it never cancels it. Saying so is the difference between
          // a queued upgrade and a session stranded on old code with nothing recorded about it.
          if (!deferredUpgradeRespawns.has(sessionId)) {
            deferredUpgradeRespawns.add(sessionId);
            recordDiagnostic({ event: "respawn_deferred", sessionId, inFlight: upgradeRespawns.size, deferred: deferredUpgradeRespawns.size, at: new Date().toISOString() });
          }
          return;
        }
        deferredUpgradeRespawns.delete(sessionId);
        upgradeRespawns.add(sessionId);
        void context.replaceStaleWorker(sessionId)
          .catch((/** @type {unknown} */ error) => context.recordRespawnRefusal(sessionId, error))
          .finally(() => {
            upgradeRespawns.delete(sessionId);
            void context.resumeDeferredUpgradeRespawns();
          });
      },
      /**
       * Take up the replacements the burst bound turned away, now that a slot is free. Each one is
       * re-decided from a freshly read record rather than the one that settled: a session that went
       * busy again, or was already replaced, waits for its own next idle boundary instead.
       */
      async resumeDeferredUpgradeRespawns() {
        while (deferredUpgradeRespawns.size > 0 && upgradeRespawns.size < MAX_UPGRADE_RESPAWNS) {
          const [sessionId] = deferredUpgradeRespawns;
          // Removed before the read, so two replacements finishing together cannot both take this one.
          deferredUpgradeRespawns.delete(sessionId);
          const record = await registry.get(sessionId).catch(() => undefined);
          context.scheduleUpgradeRespawn(sessionId, record);
        }
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
          context.notifyListChanged();
        }, "reconcile_activity");
      },
      /**
       * Store the model and thinking level Pi reported on reconnect. A launch already records Pi's
       * model at readiness; this keeps a row current after a daemon restart, and it is the only writer
       * of the thinking level Pi restored for itself.
       * @param {any} metadata @param {any} state
       */
      async recordSessionModel(metadata, state) {
        const model = piConfirmedModel(state);
        const thinkingLevel = state?.thinkingLevel;
        if (model === undefined && typeof thinkingLevel !== "string") return;
        await runSessionLifecycle(registry, metadata.sessionId, async () => {
          const current = await registry.get(metadata.sessionId);
          if (current === undefined || current.ownership?.runId !== metadata.runId) return;
          const sameModel = model === undefined || (current.model?.provider === model.provider && current.model?.id === model.id);
          const sameThinking = typeof thinkingLevel !== "string" || current.thinkingLevel === thinkingLevel;
          if (sameModel && sameThinking) return;
          const updated = await registry.update(current.sessionId, current.revision, {
            ...(model === undefined ? {} : { model }),
            ...(typeof thinkingLevel === "string" ? { thinkingLevel } : {}),
            updatedAt: new Date().toISOString(),
          });
          context.notifyListChanged();
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
                context.notifyListChanged();
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
        if (router.route(sessionId) !== undefined) return;
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
              // Pi restores its own thinking level from the canonical session file, so a restart asks for none.
              ...(record.model === undefined ? {} : { model: record.model }),
              ...(record.name === undefined ? {} : { name: record.name }),
            });
            // The launch registered and adopted its own route; this only opens the viewer stream.
            await context.recovery.viewer.ensure(handle.sessionId);
          } finally {
            launchingSessions.delete(sessionId);
          }
        })();
        sessionStarts.set(sessionId, start);
        try { await start; } finally { if (sessionStarts.get(sessionId) === start) sessionStarts.delete(sessionId); }
      },
      /**
       * Record or forget one session on one dashboard connection. It authorizes nothing: the socket
       * token already authenticated this client, and every authenticated client may write.
       * @param {any} request @param {{ socket: net.Socket, attachId: string | undefined }} connection @param {string} authenticatedClientId
       */
      async attachConnection(request, connection, authenticatedClientId) {
        if (request.clientId !== authenticatedClientId) throw Object.assign(new Error("Attachment client identity changed"), { code: "CLIENT_IDENTITY_CONFLICT" });
        const sessionId = request.payload.sessionId;
        const { socket, attachId } = connection;
        if (request.op === "detach") {
          attachedSessions.get(socket)?.delete(sessionId);
          const attached = attachedConnections.get(sessionId);
          attached?.delete(socket);
          if (attached?.size === 0) attachedConnections.delete(sessionId);
          return { kind: "detached", sessionId };
        }
        // Opening a session whose worker has exited starts one, which is the only side effect an
        // attachment has. It runs before the connection is recorded so a refused start records nothing.
        if (request.payload.activate === true) await context.ensureSessionWorker(sessionId);
        let sessions = attachedSessions.get(socket);
        if (sessions === undefined) {
          sessions = new Set();
          attachedSessions.set(socket, sessions);
        }
        sessions.add(sessionId);
        let attached = attachedConnections.get(sessionId);
        if (attached === undefined) {
          attached = new Map();
          attachedConnections.set(sessionId, attached);
        }
        attached.set(socket, { attachId });
        return { kind: "attached", sessionId };
      },
      /** @param {net.Socket} socket */
      releaseAttachments(socket) {
        const sessions = attachedSessions.get(socket);
        if (sessions === undefined) return;
        for (const sessionId of sessions) {
          const attached = attachedConnections.get(sessionId);
          attached?.delete(socket);
          if (attached?.size === 0) attachedConnections.delete(sessionId);
        }
        attachedSessions.delete(socket);
      },
      /**
       * Say, once, that a live worker is out of reach and what ends it. The worker keeps running and
       * is never signalled here; the row carries the same answer until a route is adopted again.
       * @param {{ sessionId: string, cause?: string, message?: string }} report
       */
      reportUnreachableWorker({ sessionId, cause = WORKER_UNREACHABLE, message }) {
        if (unreachableWorkers.get(sessionId) === cause) return;
        unreachableWorkers.set(sessionId, cause);
        recordDiagnostic({ event: "worker_unreachable", sessionId, code: cause, message, fix: UNREACHABLE_WORKER_FIX, at: new Date().toISOString() });
        context.notifyListChanged();
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
            if (pending === undefined || pending.connection !== connection || pending.metadata !== metadata || pending.routeGeneration !== routeGeneration || pending.sessionId !== metadata.sessionId || pending.runId !== metadata.runId || pending.leaseId !== metadata.leaseId || pending.generation !== metadata.generation || pending.clientRequest?.clientId !== pending.clientId || pending.clientRequest?.requestId !== pending.requestId || pending.clientRequest?.op !== pending.op || pending.clientRequest?.payload?.sessionId !== pending.sessionId) return;
            if (frame.ok) validateWorkerSuccess(frame.record, pending);
            else validateWorkerFailure(frame.error);
            if (context.workerPending.get(frame.id) !== pending) return;
            context.workerPending.delete(frame.id);
            clearTimeout(pending.timer);
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
        // A reconnecting worker replays its bounded live tail before it forwards anything new on that
        // connection. It is the only source for frames Pi produced while this daemon was absent, and
        // for the newest frames Pi has not written to its own session file yet.
        if (frame.type === "pi_tail") {
          const allowed = ["version", "type", "token", "sessionId", "frames", "dropped"];
          if (frame.version !== 1 || frame.sessionId !== metadata.sessionId || Object.keys(frame).some((key) => !allowed.includes(key)) || !Array.isArray(frame.frames) || frame.frames.length > MAX_LIVE_TAIL_FRAMES || frame.frames.some((/** @type {any} */ value) => typeof value !== "object" || value === null || Array.isArray(value)) || !Number.isSafeInteger(frame.dropped) || frame.dropped < 0) throw Object.assign(new Error("Invalid Pi tail frame"), { code: "INVALID_WORKER_FRAME" });
          const viewer = context.recovery?.viewer ?? context.viewerRecovery;
          if (viewer === undefined) throw Object.assign(new Error("Viewer recovery is still initializing"), { code: "RECOVERING", retryable: true });
          await router.runCurrentFrame(metadata, connection, routeGeneration, async () => {
            await viewer.rebuild(frame.sessionId, frame.frames);
          });
          // The bound was reached, so the rebuilt transcript holds Pi's completed history and only the
          // newest live frames. Nothing freezes and nothing fails; the operator loses partial text
          // older than the tail, which is what this records.
          if (frame.dropped > 0) recordDiagnostic({ event: "viewer_tail_truncated", sessionId: frame.sessionId, droppedFrames: frame.dropped, retainedFrames: frame.frames.length, at: new Date().toISOString() });
          return;
        }
        if (context.state !== "READY") throw Object.assign(new Error("Daemon recovery is still in progress"), { code: "RECOVERING", retryable: true });
        const eventKeys = ["version", "type", "token", "sessionId", "event"];
        if (frame.type !== "worker_event" || frame.version !== 1 || frame.sessionId !== metadata.sessionId || Object.keys(frame).some((key) => !eventKeys.includes(key)) || typeof frame.event !== "object" || frame.event === null || Array.isArray(frame.event)) throw Object.assign(new Error("Invalid worker frame"), { code: "INVALID_WORKER_FRAME" });
        /**
         * How this frame's route is verified before it reaches the registry. Every frame but one is
         * verified against both live process identities.
         * @type {(action: () => Promise<any>) => Promise<any>}
         */
        let serializeFrame = (action) => router.runCurrent(metadata, connection, routeGeneration, action);
        if (frame.event.type === "PI_CHILD_CRASHED") {
          const runHash = (await registry.get(frame.sessionId))?.runHash;
          const causePath = typeof runHash === "string" ? workerTerminalCausePath(root, runHash) : undefined;
          // A worker from a build that predates the durable cause sends this same authenticated frame and
          // publishes no file. Refusing it would drop the route and leave the row reading LIVE with a dead
          // Pi, so an absent record degrades to the verified worker-event path below. A record that is
          // present and does not validate is a forged or stale run file, and stays refused.
          const { present, cause } = causePath === undefined ? { present: false, cause: undefined } : await inspectWorkerTerminalCause(causePath, {
            sessionId: metadata.sessionId,
            runId: metadata.runId,
            leaseId: metadata.leaseId,
            generation: metadata.generation,
            worker: metadata.identity,
            piChild: metadata.piChildIdentity,
          });
          if (present && (cause === undefined || cause.event.at !== frame.event.at || cause.event.summary !== frame.event.summary)) throw Object.assign(new Error("Pi child crash has no valid durable cause"), { code: "INVALID_WORKER_FRAME" });
          if (cause !== undefined) {
            await router.runCurrentTerminal(metadata, connection, routeGeneration, cause, async (owned) => {
              if (owned.runHash !== runHash) throw Object.assign(new Error("Terminal cause no longer matches the owning run"), { code: "OWNERSHIP_CONFLICT" });
              const next = reduceSessionState(owned, cause.event);
              await registry.update(owned.sessionId, owned.revision, {
                taskState: next.taskState,
                processState: next.processState,
                outcome: next.outcome,
                activity: next.activity,
                updatedAt: next.updatedAt,
              });
            });
            await retireWorkerTerminalCause(/** @type {string} */ (causePath));
            await connection.send({ version: 1, type: "terminal_cause_ack", token: metadata.token, sessionId: metadata.sessionId, runId: metadata.runId, leaseId: metadata.leaseId, generation: metadata.generation });
            context.notifyListChanged();
            return;
          }
          // This frame is the report that the Pi child exited, so the route is verified without it.
          serializeFrame = (action) => router.runCurrentTerminalEvent(metadata, connection, routeGeneration, action);
        }
        /** @type {string | undefined} */
        let previousTaskState;
        /** @type {any} */
        let settled;
        await serializeFrame(async () => {
          // Re-read and re-reduce when another writer wins the compare-and-swap. Throwing here reaches
          // the worker socket's error path, which destroys the connection: losing a race with a color,
          // rename or summary write must not cost the supervisor its route.
          const updated = await applySessionUpdate(registry, frame.sessionId, (current) => {
            if (current.ownership === undefined || current.ownership.runId !== metadata.runId) throw Object.assign(new Error("Worker event ownership conflict"), { code: "OWNERSHIP_CONFLICT" });
            previousTaskState = current.taskState;
            const next = reduceSessionState(current, frame.event);
            return next === current ? undefined : { taskState: next.taskState, processState: next.processState, outcome: next.outcome, activity: next.activity, updatedAt: next.updatedAt };
          });
          settled = updated;
          context.notifyListChanged();
        });
        // Pi settling this run is the one fact that opens an automatic replacement boundary, and it
        // opens it once per turn rather than on every event a settled session goes on to emit.
        if (previousTaskState !== "READY") context.scheduleUpgradeRespawn(metadata.sessionId, settled);
      },
      /** @param {any} request @param {{ socket: net.Socket, attachId: string | undefined } | undefined} connection @param {string} [authenticatedClientId] */
      async handleRequest(request, connection, authenticatedClientId = request.clientId) {
        const socket = connection?.socket;
        const attachId = connection?.attachId;
        if (!context.admissionOpen) throw Object.assign(new Error("Daemon is shutting down"), { code: "SHUTTING_DOWN", retryable: true });
        if (request.op === "get_state") {
          // Read the coverage cursor before the registry, never after. A snapshot newer than its own
          // cursor understates what it covers, which costs one extra read; a cursor newer than the
          // snapshot would let a client believe a change it never saw was already included.
          const cursor = listCoverageCursor();
          const sessions = (await registry.list()).map((session) => context.withWorkerAdoption(session));
          return { kind: "state", sessions, cursor };
        }
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
            context.notifyListChanged();
            return { kind: "session_colored", sessionId: updated.sessionId, revision: updated.revision, color: updated.color ?? null };
          }, "set_session_color");
        }
        if (context.state !== "READY") throw Object.assign(new Error(context.state === "FAILED" ? context.stateError?.message ?? "Daemon recovery failed" : "Daemon recovery is still in progress"), { code: context.state === "FAILED" ? context.stateError?.code ?? "RECOVERY_FAILED" : "RECOVERING", retryable: context.state !== "FAILED" });
        if (request.op === "subscribe_viewer") {
          if (socket === undefined) throw new TypeError("Viewer subscription requires a live socket");
          // The snapshot and the subscription are taken together, under this session's frame lock, so
          // no ingested frame falls between them. Nothing is retained that could replay one.
          const opened = await router.runFrame(request.payload.sessionId, () => context.recovery.viewer.subscribe(request.payload.sessionId));
          return { kind: "viewer_subscribed", cursor: opened.cursor, snapshot: opened.snapshot, _viewerSubscription: opened.subscription };
        }
        if (request.op === "subscribe_list_changes") {
          if (socket === undefined) throw new TypeError("List subscription requires a live socket");
          context.listSubscribers.add(socket);
          return { kind: "list_subscribed" };
        }
        if (request.op === "launch") {
          context.hostReport ??= await hostProbe();
          if (context.hostReport.blockers?.length > 0 || context.hostReport.daemonOwnedStartup === false) throw refusal("UNSUPPORTED_HOST", "Pi host does not support daemon-owned product launch");
          if (workerSupervisor === undefined || typeof resolveLaunchRequest !== "function") throw refusal("LAUNCH_UNAVAILABLE", "Daemon launch resolver is unavailable");
          const requestedModel = request.payload.model;
          if (requestedModel !== undefined) {
            /** @type {any[] | undefined} */
            let catalog;
            try {
              catalog = await modelCatalog.models();
            } catch (error) {
              // A catalog Pi could not list refuses nothing: Pi decides what it accepts. This stays a
              // diagnostic, and a distinct one from a model Pi listed and does not have.
              const failure = /** @type {any} */ (error);
              recordDiagnostic({ event: "model_catalog_unavailable", code: failure?.code ?? "MODEL_CATALOG_FAILED", message: error instanceof Error ? error.message : "Listing Pi models failed", at: new Date().toISOString() });
            }
            // Admission runs before resolution, so a refused model leaves no record, Pi file, worktree,
            // worker, or row to clean up. The frontend picker is an earlier check, not this one.
            if (catalog !== undefined && !catalog.some((/** @type {any} */ model) => model.provider === requestedModel.provider && model.id === requestedModel.id)) {
              throw refusal("MODEL_UNKNOWN", `Pi does not offer ${requestedModel.provider}/${requestedModel.id}`);
            }
          }
          /** @type {any} */
          let launch;
          try {
            launch = await resolveLaunchRequest(request);
            if (launch.sessionRecord !== undefined && await registry.get(launch.sessionId) === undefined) {
              const prepared = await registry.create(launch.sessionRecord);
              context.notifyListChanged();
            }
            const launched = await runSessionLifecycle(registry, launch.sessionId, async () => {
              if (launchingSessions.has(launch.sessionId)) throw Object.assign(new Error("A launch is already in flight for this session"), { code: "LAUNCH_IN_FLIGHT" });
              launchingSessions.add(launch.sessionId);
              /** @type {any} */
              let handle;
              try {
                handle = await workerSupervisor.launch(launch);
                // The launch registered and adopted its own route; this only opens the viewer stream.
                await context.recovery.viewer.ensure(handle.sessionId);
              } finally {
                launchingSessions.delete(launch.sessionId);
              }
              return { kind: "launched", sessionId: handle.sessionId };
            }, "launch");
            // The first prompt's reply arrives on the worker socket and is handled through the same
            // session lifecycle lock the launch holds, so it is delivered after that lock is released.
            if (typeof launch.initialPrompt === "string") {
              const promptRequest = {
                version: 1,
                clientId: `daemon-launch:${daemonEpoch}`,
                requestId: createHash("sha256").update(canonicalJson([request.clientId, request.requestId, launched.sessionId])).digest("hex"),
                op: "prompt",
                payload: { sessionId: launched.sessionId, text: launch.initialPrompt },
              };
              await context.routeCommand(promptRequest, { text: launch.initialPrompt });
            }
            return launched;
          } catch (error) {
            const launchError = /** @type {any} */ (error);
            // A worker that died before it was ready leaves no lease behind, so nothing owns this session
            // and the row must say the launch failed. Leaving it at STARTING makes the list lie for hours.
            const prepared = launch === undefined ? undefined : await registry.get(launch.sessionId);
            if ((launchError?.preChild === true || prepared?.ownership === undefined) && prepared !== undefined) {
              const updated = await registry.update(prepared.sessionId, prepared.revision, {
                taskState: "FAILED",
                processState: "EXITED",
                activity: { kind: "launch_failed", summary: error instanceof Error ? error.message : "Launch failed", updatedAt: new Date().toISOString() },
                updatedAt: new Date().toISOString(),
              });
              context.notifyListChanged();
            }
            throw error;
          }
        }
        if (request.op === "refresh_summaries") return { kind: "summaries_refreshing", sessionIds: await context.refreshSummaries() };
        if (request.op === "attach" || request.op === "detach") {
          if (connection === undefined) throw new TypeError("Attachment requires a live socket");
          return context.attachConnection(request, connection, authenticatedClientId);
        }
        if (request.op === "get_session_commands") {
          const menu = (await context.routeCommand(request))?.result ?? {};
          // A worker from the release that reported no thinking values leaves both empty, which the
          // viewer reads as a session whose levels cannot be picked rather than as a level of its own.
          return {
            kind: "session_commands", sessionId: request.payload.sessionId,
            commands: menu.commands ?? [], models: menu.models ?? [], model: menu.model ?? null,
            thinkingLevels: menu.thinkingLevels ?? [], thinkingLevel: menu.thinkingLevel ?? null,
          };
        }
        if (!SESSION_MUTATIONS.has(request.op)) throw refusal("UNSUPPORTED_OPERATION", `Unsupported daemon operation: ${request.op}`);
        try {
          if (WORKER_DELIVERED_COMMANDS.includes(request.op)) {
            await context.routeCommand(request, {
              text: request.payload.text,
              response: request.op === "ui_response" ? { requestId: request.payload.uiRequestId, response: request.payload.response } : undefined,
              sessionCommand: request.op === "session_command" ? sessionCommandPayload(request.payload) : undefined,
            });
            if (request.op === "session_command" && request.payload.command === "set_session_name") {
              await runSessionLifecycle(registry, request.payload.sessionId, async () => {
                const current = await registry.get(request.payload.sessionId);
                if (current === undefined || current.name === request.payload.name) return;
                const updated = await registry.update(current.sessionId, current.revision, { name: request.payload.name, nameGenerated: false, updatedAt: new Date().toISOString() });
                context.notifyListChanged();
              }, "set_session_name");
            }
          } else if (request.op === "stop") {
            await router.runSession(request.payload.sessionId, async (/** @type {any} */ { metadata: lockedMetadata, route: lockedRoute, forget }) => {
              const record = await registry.get(request.payload.sessionId);
              if (record === undefined) throw refusal("SESSION_NOT_FOUND", "The exact session does not exist");
              // The revision is the guard, and it is the whole guard: a Stop the operator reissues after
              // an ambiguous answer is refused here, and the row he refused against says whether the
              // first one landed.
              if (record.revision !== request.payload.revision) throw refusal("REVISION_CONFLICT", "Session revision changed before Stop");
              if (record.ownership === undefined || !["LIVE", "SLEEPING", "STALE"].includes(record.processState)) throw refusal("SESSION_NOT_ACTIVE", "Stop requires current authoritative ownership");
              if (lockedMetadata === undefined || lockedMetadata.runId !== record.ownership.runId || !sameProcessIdentity(lockedMetadata.identity, record.ownership.process)) {
                throw refusal("OWNERSHIP_CONFLICT", "Durable worker lease does not match the SessionRecord");
              }
              const exactRecord = await registry.get(request.payload.sessionId);
              if (exactRecord?.revision !== record.revision || exactRecord.ownership === undefined || !sameProcessIdentity(exactRecord.ownership.process, record.ownership.process)) {
                throw refusal("OWNERSHIP_CONFLICT", "Ownership changed at the signaling boundary");
              }
              let disposition;
              try {
                disposition = await stopVerifiedProcessGroup(exactRecord.ownership.process, {
                  inspect,
                  requestGraceful: async () => { await lockedRoute?.connection.send({ version: 1, type: "shutdown", token: lockedMetadata.token }).catch(() => {}); },
                  signalProcessGroup: signalProcessGroupImpl,
                  sleep: sleepImpl,
                }, stopPolicy);
              } catch (cause) {
                throw Object.assign(new Error("Stop failed where it may already have signalled", { cause }), { code: "DELIVERY_UNKNOWN", retryable: false });
              }
              // Signalled without proof of exit. The operator reads the row for the answer; nothing here
              // guesses that the process group is gone.
              if (disposition.disposition === "KILL_REQUESTED" || disposition.signaled === true) throw refusal("DELIVERY_UNKNOWN", `Stop signalled without proof of exit: ${disposition.disposition}`);
              if (["STALE_IDENTITY", "AMBIGUOUS_IDENTITY", "CANCELLED"].includes(disposition.disposition)) {
                throw refusal(disposition.disposition, `Stop refused at exact identity boundary: ${disposition.disposition}`);
              }
              if (TERMINAL_STOP_DISPOSITIONS.includes(disposition.disposition)) {
                const latest = await registry.get(request.payload.sessionId);
                if (latest?.revision === exactRecord.revision && latest.ownership?.runId === exactRecord.ownership.runId) {
                  // Stop is a task-state verdict; a reviewable outcome the session already earned stays intact.
                  const stopped = reduceSessionState(latest, { type: "USER_STOPPED", at: new Date().toISOString() });
                  const updated = await registry.update(latest.sessionId, latest.revision, { ownership: undefined, taskState: stopped.taskState, processState: stopped.processState, outcome: latest.outcome, activity: stopped.activity, updatedAt: stopped.updatedAt });
                  context.notifyListChanged();
                }
                await forget();
              }
            });
          } else if (request.op === "respawn") {
            try {
              await context.replaceStaleWorker(request.payload.sessionId, { revision: request.payload.revision });
            } catch (error) {
              context.recordRespawnRefusal(request.payload.sessionId, error);
              throw error;
            }
          } else {
            await router.runSession(request.payload.sessionId, async (/** @type {any} */ { metadata: lockedMetadata, route: lockedRoute, forget }) => {
              const record = await registry.get(request.payload.sessionId);
              if (record === undefined) throw refusal("SESSION_NOT_FOUND", "The exact session does not exist");
              if (record.revision !== request.payload.revision) throw refusal("REVISION_CONFLICT", "Session revision changed before Delete");
              if (record.ownership !== undefined || ["LIVE", "SLEEPING"].includes(record.processState)) throw refusal("SESSION_LIVE", "Delete refuses a live or owned session");
              // A lease whose worker process is provably gone cannot be authoritative; reclaim it instead of refusing forever.
              if (lockedMetadata !== undefined && lockedRoute === undefined && await processIsGone(lockedMetadata.identity, inspect)) {
                await forget();
                lockedMetadata = undefined;
              }
              if (lockedMetadata !== undefined || lockedRoute !== undefined || launchingSessions.has(record.sessionId)) throw refusal("OWNERSHIP_CONFLICT", "A worker lease, route, or launch is still authoritative");
              // Another dashboard has this row open, so removing it would empty a screen someone is
              // reading. One dashboard's own second connection is not another dashboard: a destructive
              // command travels on its own socket, and its list connection may still hold the session.
              const attached = attachedConnections.get(record.sessionId);
              const heldElsewhere = [...(attached ?? []).entries()].some(([candidate, held]) => candidate !== socket && (attachId === undefined || held.attachId !== attachId));
              if (heldElsewhere) throw refusal("SESSION_ATTACHED", "Delete refuses a session another dashboard has open");
              // Delete forgets the dashboard record and nothing else. Pi's canonical session file and any
              // managed worktree belong to the operator, so no path beneath either is ever mutated here.
              await registry.remove(record.sessionId, record.revision);
            });
          }
        } finally {
          // Invalidate whatever the outcome, under this session's lifecycle lock so the invalidation
          // cannot overtake a write the same lock is still making. A refused command may still have
          // reclaimed a dead lease or signalled a process on its way to refusing.
          await runSessionLifecycle(registry, request.payload.sessionId, async () => context.notifyListChanged(), "notify_list_changed");
        }
        return { kind: "command", sessionId: request.payload.sessionId };
      },
    };
    const socketPath = join(daemonDirectory, "control.sock");
    socketServer = createSocketServer({ socketPath, token, maxBytes, context });
    await socketServer.listen();
    socketOwned = true;
    context.listSubscribers = socketServer.listSubscribers;
    context.notifyListChanged = () => {
      // Advance the coverage cursor and then tell the list, in that order, so a read that starts
      // after the change reports a cursor that already includes it.
      listSequence += 1;
      socketServer.broadcastListChanged();
    };

    context.state = "RECONCILING";
    await updateDaemonLifecycleState(claim, "RECONCILING");
    const defaultReconcile = () => reconcileRuntime({
      root,
      daemonEpoch,
      inspect,
      router,
      signal: recoveryController.signal,
      adoptTimeoutMs: reconnectTimeoutMs,
      onViewerReady: (viewer) => { context.viewerRecovery = viewer; },
    });
    const ready = (async () => {
      try {
        context.recovery = reconcile === undefined ? await defaultReconcile() : await reconcile({ root, daemonEpoch, router, defaultReconcile, signal: recoveryController.signal });
        context.viewerRecovery = context.recovery.viewer;
        // A worker this daemon could not reach does not refuse the start. It is still running, it
        // still owns Pi, and refusing here would take every other session down with it; the row it
        // owns says why it is out of reach and what to do about it.
        for (const unreachable of context.recovery.unreachableWorkers ?? []) context.reportUnreachableWorker(unreachable);
        const blocking = context.recovery.conflicts.filter((/** @type {any} */ conflict) => ![WORKER_UNREACHABLE, PI_CHILD_CRASH_REPORTED].includes(conflict.reason));
        if (blocking.length > 0) throw Object.assign(new Error("Worker ownership conflicts block daemon recovery"), { code: "OWNERSHIP_CONFLICT", conflicts: blocking });
        if ((context.recovery.repairedSessions ?? []).length > 0) context.notifyListChanged();
        context.state = "READY";
        await updateDaemonLifecycleState(claim, "READY");
        // A replacement an earlier daemon promised resumes only now, after its worker was adopted. A
        // session that is busy again waits for its next idle boundary instead.
        for (const sessionId of router.connectedSessionIds()) {
          if (router.pendingRespawn(sessionId) !== undefined) context.scheduleUpgradeRespawn(sessionId, await registry.get(sessionId));
        }
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
      /**
       * Why this daemon must not exit now, or undefined when nothing holds it.
       *
       * Live workers are absent on purpose: a worker is Pi's parent, outlives the daemon, and keeps
       * recording, so a session with no dashboard open is not work this process has to stay up for.
       */
      idleHold() {
        // Work this daemon owes first, watchers last: when several stand at once the reason names
        // what has to finish rather than who happens to be looking.
        if (upgradeRespawns.size > 0 || deferredUpgradeRespawns.size > 0) return "replacements";
        if (launchingSessions.size > 0) return "launches";
        if (context.workerPending.size > 0) return "commands";
        if (socketServer.frontendSockets.size > 0) return "clients";
        return undefined;
      },
      /** Re-arm the idle window from every accepted connection. @param {() => void} touch */
      onClientActivity(touch) { context.touchIdle = touch; },
      close() {
        if (closePromise !== undefined) return closePromise;
        closeState = "CLOSING";
        closePromise = (async () => {
          /** @type {unknown[]} */
          const errors = [];
          // Every stage runs even after an earlier one failed, and each failure is reported together.
          /** @param {() => unknown | Promise<unknown>} action */
          const cleanup = async (action) => {
            try {
              await action();
            } catch (error) {
              errors.push(error);
            }
          };
          context.admissionOpen = false;
          recoveryController.abort();
          await cleanup(() => socketServer.beginShutdown());
          await cleanup(async () => { await Promise.allSettled([ready]); });
          await cleanup(() => socketServer.drainAndClose());
          await cleanup(async () => workerSupervisor?.close?.());
          await cleanup(async () => context.recovery?.close());
          await cleanup(() => releaseDaemonLifecycle(claim));
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
  const cliVersion = JSON.parse(await fs.readFile(PACKAGE_MANIFEST_PATH, "utf8")).version;
  const configText = await readPrivateText(join(root, "dashboard.json"));
  const config = loadDashboardConfig(configText === undefined ? {} : JSON.parse(configText));
  const configuredPiPath = piBin ?? config.pi.executable;
  const registry = new RegistryStore(join(root, "sessions"));
  const piConfigPath = resolve(getAgentDir());
  await ensurePrivateDirectory(piConfigPath);
  const piConfigRoot = await fs.realpath(piConfigPath);
  // Worktrees created before the pi-agents rename keep their recorded absolute paths, so their
  // ownership locks still live under the previous product directory and must still be swept.
  const sweepStartedAt = new Date().toISOString();
  for (const directory of WORKTREE_ROOT_DIRECTORIES) {
    await sweepStaleWorktreeLocks({ worktreesRoot: join(piConfigRoot, directory, "worktrees"), startedAt: sweepStartedAt }).catch(() => []);
  }
  const workerSupervisor = new WorkerSupervisor({
    registry,
    runsDirectory: join(root, "runs"),
    maxLive: config.workers.maxLive,
    configuredPiPath,
    env,
    startTimeoutMs: config.daemon.startTimeoutMs,
    launchStopPolicy: config.stop,
    cliVersion,
  });
  return createDaemonRuntime({
    root,
    workerSupervisor,
    resolveLaunchRequest: createLaunchResolver({ registry, piConfigRoot }),
    summaryExecutable: configuredPiPath ?? "pi",
    summaryEnv: env,
    stopPolicy: config.stop,
    cliVersion,
  });
}

/** @param {NodeJS.ProcessEnv} [env] */
export function defaultRuntimeRoot(env = process.env) {
  const home = env.HOME ?? homedir();
  return resolve(env.PI_AGENTS_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-agents"));
}

async function runMain() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const piBinFlag = argv.indexOf("--pi-bin");
  const root = rootFlag >= 0 ? argv[rootFlag + 1] : defaultRuntimeRoot();
  const piBin = piBinFlag >= 0 ? argv[piBinFlag + 1] : undefined;
  const idleMs = resolveIdleExitMs({ argv, env: process.env });
  const runtime = await createDefaultDaemonRuntime({ root, piBin });
  try {
    await runtime.ready;
    await Promise.race([
      runtime.stopRequested,
      new Promise((resolveStop) => {
        process.once("SIGTERM", resolveStop);
        process.once("SIGINT", resolveStop);
        if (idleMs <= 0) return;
        const idle = createIdleExit({ idleMs, now: () => Date.now(), onIdle: () => resolveStop(undefined), hold: () => runtime.idleHold() });
        runtime.onClientActivity(idle.touch);
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
