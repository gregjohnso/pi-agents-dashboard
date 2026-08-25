import net from "node:net";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJson } from "./atomic-file.mjs";
import { claimDaemonLifecycle, cleanupStaleDaemon, inspectDaemonEndpoint, releaseDaemonLifecycle } from "./daemon-lifecycle.mjs";
import { createJsonlDecoder, createJsonlEncoder, JsonlFramingError } from "./jsonl.mjs";
import { ensurePrivateDirectory, initializeRuntimePermissions } from "./permissions.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { RecoveredWorkerRouter, reconcileRuntime } from "./reconciliation.mjs";
import { RegistryStore } from "./registry-store.mjs";
import { reduceSessionState } from "./state-reducer.mjs";
import { parseClientRequest } from "../shared/contracts.js";

initializeRuntimePermissions();

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MUTATIONS = new Set(["launch", "attach", "detach", "prompt", "steer", "follow_up", "interrupt", "stop", "delete", "ui_response", "resolve_delivery"]);
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

/** @param {string} path @param {() => string} create */
async function privateText(path, create) {
  try {
    const metadata = await fs.lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw new Error(`Private artifact is unsafe: ${path}`);
    const value = (await fs.readFile(path, "utf8")).trim();
    if (value.length === 0) throw new Error(`Private artifact is empty: ${path}`);
    return value;
  } catch (error) {
    if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
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
}

async function checkDefaultHost() {
  const module = await import(new URL("../extensions/agents-dashboard/compatibility.ts", import.meta.url).href);
  return module.checkHostCapabilities();
}

/** @param {{ socketPath: string, token: string, maxBytes: number, context: any }} options */
function createSocketServer({ socketPath, token, maxBytes, context }) {
  const sockets = new Set();
  const subscribers = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    let authenticated = false;
    let role = "frontend";
    /** @type {any} */
    let workerConnection;
    /** @type {any} */
    let workerMetadata;
    /** @type {Promise<void>} */
    let chain = Promise.resolve();
    const decoder = createJsonlDecoder({ maxBytes });
    const encoder = createJsonlEncoder({ maxBytes });
    /** @type {(value: unknown) => void} */
    let resolveClosed = () => {};
    const closed = new Promise((resolveClosedPromise) => { resolveClosed = resolveClosedPromise; });
    /** @param {any} value */
    const send = (value) => {
      if (!socket.destroyed) socket.write(encoder.encode(value));
    };
    const close = () => socket.destroy();
    /** @param {any} message */
    const requestWorker = (message) => new Promise((resolveRequest, rejectRequest) => {
      const id = message.id;
      context.workerPending.set(id, { resolve: resolveRequest, reject: rejectRequest, socket });
      try {
        send(message);
      } catch (error) {
        context.workerPending.delete(id);
        rejectRequest(error);
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      subscribers.delete(socket);
      resolveClosed(undefined);
      for (const [id, pending] of context.workerPending) {
        if (pending.socket === socket) {
          context.workerPending.delete(id);
          pending.reject(Object.assign(new Error("Worker delivery became ambiguous"), { code: "DELIVERY_UNKNOWN" }));
        }
      }
    });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        const code = error instanceof JsonlFramingError ? error.code : "INVALID_FRAME";
        send({ version: 1, ok: false, error: dashboardError(code, error instanceof Error ? error.message : "Invalid frame") });
        socket.end();
        return;
      }
      for (const frameValue of frames) {
        const frame = /** @type {any} */ (frameValue);
        chain = chain.then(async () => {
          if (!authenticated) {
            const allowed = role === "frontend" ? ["version", "token", "role"] : [];
            if (typeof frame !== "object" || frame === null || Array.isArray(frame) || Object.keys(frame).some((key) => !allowed.includes(key)) || frame.version !== 1 || !sameToken(frame.token, token) || (frame.role !== undefined && !["frontend", "worker"].includes(frame.role))) {
              send({ version: 1, ok: false, error: dashboardError(frame?.version === 1 ? "AUTHENTICATION_FAILED" : "UNSUPPORTED_VERSION", "Invalid daemon authentication") });
              socket.end();
              return;
            }
            role = frame.role ?? "frontend";
            authenticated = true;
            send({ version: 1, kind: "authenticated" });
            return;
          }
          if (role === "worker") {
            if (workerConnection === undefined) {
              workerConnection = { closed, close, send: async (/** @type {any} */ message) => { send(message); }, request: requestWorker };
              workerMetadata = await context.router.adopt(frame, workerConnection);
              return;
            }
            await context.handleWorkerFrame(frame, socket, workerMetadata);
            return;
          }
          let request;
          try {
            request = parseClientRequest(frame);
          } catch {
            send({ version: 1, requestId: typeof frame?.requestId === "string" ? frame.requestId : "invalid-request", ok: false, error: dashboardError("INVALID_REQUEST", "Invalid client request") });
            return;
          }
          try {
            const result = await context.handleRequest(request, socket, subscribers);
            send(response(request.requestId, result));
            if (request.op === "subscribe") {
              const replay = await context.recovery.events.replay(request.payload.after);
              for (const event of replay) send(event);
            }
          } catch (error) {
            send(failure(request.requestId, error));
          }
        }).catch(() => { socket.destroy(); });
      }
    });
    socket.on("end", () => {
      try {
        decoder.end();
      } catch (error) {
        const framing = /** @type {{ code?: string, message?: string }} */ (error);
        send({ version: 1, ok: false, error: dashboardError(framing.code ?? "INCOMPLETE_FRAME", framing.message ?? "Incomplete frame") });
      }
      socket.end();
    });
  });
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
      for (const socket of subscribers) {
        if (!socket.destroyed) socket.write(encoded);
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolveClose) => server.close(() => resolveClose(undefined)));
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
} = {}) {
  if (typeof root !== "string" || resolve(root) !== root) throw new TypeError("Daemon runtime root must be an absolute canonical path");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError("maxBytes must be at least 128");
  await ensureLayout(root);
  const daemonDirectory = join(root, "daemon");
  const tokenPath = join(daemonDirectory, "control.token");
  const token = await privateText(tokenPath, () => randomBytes(32).toString("base64url"));
  const daemonEpoch = await privateText(join(daemonDirectory, "epoch"), randomUUID);
  const identity = await inspect(process.pid);
  const endpoint = await inspectDaemonEndpoint({ root, inspect, probe: async () => false });
  if (endpoint.status === "STALE") await cleanupStaleDaemon({ root, inspect, probe: async () => false });
  else if (endpoint.status !== "ABSENT") throw Object.assign(new Error("A live daemon already owns the per-user endpoint"), { code: endpoint.status === "CONFLICT" ? "DAEMON_IDENTITY_CONFLICT" : "DAEMON_ALREADY_RUNNING" });

  const registry = new RegistryStore(join(root, "sessions"));
  const router = new RecoveredWorkerRouter({ registry, inspect, metadataPath: join(daemonDirectory, "workers.json") });
  await router.load();
  /** @type {any} */
  const context = {
    state: "RECONCILING",
    recovery: undefined,
    router,
    workerPending: new Map(),
    commandSequence: 0,
    hostReport: undefined,
    broadcast: () => {},
    /** @param {any} frame @param {net.Socket} _socket @param {any} metadata */
    async handleWorkerFrame(frame, _socket, metadata) {
      if (metadata === undefined || frame?.token !== metadata.token) throw Object.assign(new Error("Unauthenticated worker frame"), { code: "WORKER_AUTHENTICATION_FAILED" });
      if (frame.type === "command_result") {
        const allowed = frame.ok === true ? ["version", "type", "token", "id", "ok", "record"] : ["version", "type", "token", "id", "ok", "error"];
        if (frame.version !== 1 || typeof frame.id !== "string" || typeof frame.ok !== "boolean" || Object.keys(frame).some((key) => !allowed.includes(key))) throw Object.assign(new Error("Invalid worker command-result frame"), { code: "INVALID_WORKER_FRAME" });
        const pending = context.workerPending.get(frame.id);
        if (pending === undefined) return;
        context.workerPending.delete(frame.id);
        frame.ok ? pending.resolve(frame) : pending.reject(Object.assign(new Error(frame.error?.message ?? "Worker command failed"), { code: frame.error?.deliveryUnknown ? "DELIVERY_UNKNOWN" : frame.error?.code ?? "RPC_FAILED", delivered: frame.error?.deliveryUnknown !== true }));
        return;
      }
      const eventKeys = ["version", "type", "token", "sessionId", "event"];
      if (frame.type !== "worker_event" || frame.version !== 1 || frame.sessionId !== metadata.sessionId || Object.keys(frame).some((key) => !eventKeys.includes(key)) || typeof frame.event !== "object" || frame.event === null) throw Object.assign(new Error("Invalid worker frame"), { code: "INVALID_WORKER_FRAME" });
      const record = await registry.get(frame.sessionId);
      if (record?.ownership === undefined || record.ownership.runId !== metadata.runId) throw Object.assign(new Error("Worker event ownership conflict"), { code: "OWNERSHIP_CONFLICT" });
      const next = reduceSessionState(record, frame.event);
      const updated = next === record ? record : await registry.update(record.sessionId, record.revision, { taskState: next.taskState, processState: next.processState, outcome: next.outcome, activity: next.activity, updatedAt: next.updatedAt });
      const event = await context.recovery.events.append({ kind: "session_changed", payload: { session: updated } });
      context.broadcast(event);
    },
    /** @param {any} request @param {net.Socket} socket @param {Set<net.Socket>} subscribers */
    async handleRequest(request, socket, subscribers) {
      if (request.op === "get_state") return { kind: "state", sessions: await registry.list() };
      if (context.state !== "READY" && MUTATIONS.has(request.op)) throw Object.assign(new Error("Daemon recovery is still in progress"), { code: "RECOVERING", retryable: true });
      if (request.op === "subscribe") {
        subscribers.add(socket);
        return { kind: "subscribed", cursor: context.recovery.events.currentCursor() };
      }
      if (request.op === "ack") {
        const acksPath = join(daemonDirectory, "event-acks.json");
        /** @type {Record<string, any>} */
        let acks = {};
        try { acks = JSON.parse(await fs.readFile(acksPath, "utf8")); } catch (error) { if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error; }
        acks[request.clientId] = request.payload.cursor;
        await atomicWriteJson(acksPath, acks);
        return { kind: "acknowledged", cursor: request.payload.cursor };
      }
      if (request.op === "resolve_delivery") {
        const status = await context.recovery.journal.resolveDelivery({ clientId: request.payload.targetClientId, requestId: request.payload.targetRequestId }, request.payload.resolution);
        const event = await context.recovery.events.append({ kind: "command_changed", payload: { status } });
        context.broadcast(event);
        return { kind: "command", status };
      }
      if (request.op === "launch") {
        context.hostReport ??= await hostProbe();
        if (context.hostReport.blockers?.length > 0 || context.hostReport.daemonOwnedStartup === false || context.hostReport.nativeAttach === false) throw Object.assign(new Error("Pi host does not support daemon-owned product launch"), { code: "UNSUPPORTED_HOST" });
        if (workerSupervisor === undefined || typeof resolveLaunchRequest !== "function") throw Object.assign(new Error("Daemon launch resolver is unavailable"), { code: "LAUNCH_UNAVAILABLE" });
        const launch = await resolveLaunchRequest(request);
        const handle = await workerSupervisor.launch({
          ...launch,
          daemonConnector: CONNECTOR_PATH,
          daemonConnectConfig: { socketPath: join(daemonDirectory, "control.sock"), tokenPath, maxBytes },
        });
        await router.register(handle);
        return { kind: "launched", sessionId: handle.sessionId };
      }
      if (request.op === "attach" || request.op === "detach") return { kind: request.op === "attach" ? "attached" : "detached", sessionId: request.payload.sessionId, ...(request.op === "attach" ? { role: request.payload.role } : {}) };
      if (!DURABLE_COMMANDS.has(request.op)) throw Object.assign(new Error(`Unsupported daemon operation: ${request.op}`), { code: "UNSUPPORTED_OPERATION" });
      const accepted = await context.recovery.journal.accept(request);
      let status = accepted;
      if (accepted.stage === "ACCEPTED") {
        const connection = router.connection(request.payload.sessionId);
        const metadata = router.metadata(request.payload.sessionId);
        if (connection === undefined || metadata?.token === undefined) {
          status = await context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("WORKER_UNAVAILABLE", "No exact recovered worker owns this session"));
        } else if (["prompt", "steer", "follow_up", "interrupt"].includes(request.op)) {
          await context.recovery.journal.transition(request, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
          const id = `${daemonEpoch}:${++context.commandSequence}`;
          const retryAtRisk = (await context.recovery.journal.history(request)).some((/** @type {any} */ prior) => prior.stage === "DELIVERY_UNKNOWN");
          try {
            await connection.request({ version: 1, type: "command", token: metadata.token, id, command: { clientId: request.clientId, requestId: request.requestId, op: request.op, text: request.payload.text, retryAtRisk } });
            await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
            status = await context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
          } catch (error) {
            const deliveryError = /** @type {any} */ (error);
            if (deliveryError?.delivered === true) {
              await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
              status = await context.recovery.journal.transition(request, ["WORKER_ACKNOWLEDGED"], "FAILED", dashboardError(deliveryError.code ?? "RPC_FAILED", deliveryError.message));
            } else status = await context.recovery.journal.transition(request, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
          }
        } else status = await context.recovery.journal.transition(request, ["ACCEPTED"], "FAILED", dashboardError("OPERATION_UNAVAILABLE", "Destructive worker workflow is not assembled in this task"));
      }
      const event = await context.recovery.events.append({ kind: "command_changed", payload: { status } });
      context.broadcast(event);
      return { kind: "command", status };
    },
  };
  const socketPath = join(daemonDirectory, "control.sock");
  const socketServer = createSocketServer({ socketPath, token, maxBytes, context });
  try {
    await socketServer.listen();
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "EADDRINUSE") throw Object.assign(new Error("Daemon endpoint is already bound"), { code: "DAEMON_ALREADY_RUNNING", cause: error });
    throw error;
  }
  context.broadcast = (/** @type {any} */ event) => socketServer.broadcast(event);
  let claim;
  try {
    claim = await claimDaemonLifecycle({ root, identity, daemonEpoch, tokenPath, inspect, probe: async () => true });
  } catch (error) {
    await socketServer.close();
    await fs.rm(socketPath, { force: true });
    throw error;
  }
  const defaultReconcile = () => reconcileRuntime({
    root,
    daemonEpoch,
    inspect,
    router,
    waitForReconnect: async (workers) => {
      const expected = workers.filter((worker) => worker.metadata !== undefined).map((worker) => worker.sessionId);
      if (expected.length === 0) return [];
      const deadline = Date.now() + reconnectTimeoutMs;
      while (Date.now() < deadline) {
        const connected = router.connectedSessionIds();
        if (expected.every((sessionId) => connected.includes(sessionId))) return connected;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      return router.connectedSessionIds();
    },
  });
  const ready = (async () => {
    try {
      context.recovery = reconcile === undefined ? await defaultReconcile() : await reconcile({ root, daemonEpoch, router, defaultReconcile });
      context.state = context.recovery.conflicts.length > 0 ? "CONFLICT" : "READY";
      if (context.state === "READY") {
        for (const action of context.recovery.recoveryActions) {
          if (action.action === "SAFE_REDELIVERY") await context.handleRequest(action.command, /** @type {any} */ (undefined), new Set());
        }
      }
      return context.recovery;
    } catch (error) {
      context.state = "FAILED";
      throw error;
    }
  })();
  let closed = false;
  return {
    root,
    socketPath,
    tokenPath,
    token,
    daemonEpoch,
    ready,
    status() { return { state: context.state, recovering: context.state === "RECONCILING", daemonEpoch, pid: identity.pid, connectedWorkers: router.connectedSessionIds() }; },
    /** @param {any} key */
    async commandStatus(key) { await ready; return context.recovery.journal.get(key); },
    async close() {
      if (closed) return;
      closed = true;
      await socketServer.close();
      await workerSupervisor?.close?.();
      if (context.recovery !== undefined) await context.recovery.close();
      await releaseDaemonLifecycle(claim);
    },
  };
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
  await runtime.ready;
  await new Promise((resolveStop) => {
    const stop = () => resolveStop(undefined);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  await runtime.close();
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runMain().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
