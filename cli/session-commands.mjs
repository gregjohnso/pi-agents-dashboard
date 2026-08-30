import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { cleanupManagedWorktree as defaultCleanupManagedWorktree } from "../isolation/cleanup.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { acquireLifecycleLock } from "../runtime/lifecycle-lock.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { loadDashboardConfig } from "../shared/config.mjs";
import { parseDaemonResponse } from "../shared/contracts.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const IDENTITY_LOCK_TIMEOUT_MS = 5_000;
const IDENTITY_WINNER_READ_ATTEMPTS = 100;
const IDENTITY_WINNER_READ_DELAY_MS = 5;
const PENDING_LOCK_TIMEOUT_MS = 5_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const ATOMIC_PUBLICATION_UNSUPPORTED_CODES = new Set(["EPERM", "EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EXDEV"]);
const PRIVATE_FILE_MODE = 0o600;
const AUTHENTICATION_STATES = new Set(["STARTING", "RECONCILING", "READY", "FAILED"]);
/**
 * Operator verbs mapped to the daemon operation and durable pending action each keeps.
 * `rm` is Claude Code's verb for the operator; the wire operation and the pending record stay
 * `delete` because a running daemon and an earlier release already wrote that spelling.
 */
const SESSION_OPERATIONS = new Map([["stop", "stop"], ["rm", "delete"], ["respawn", "respawn"], ["cleanup", "cleanup"]]);
/** Operations that end a worker's process group, so a lost answer leaves a delivery to resolve. */
const DESTRUCTIVE_OPERATIONS = new Set(["stop", "delete", "respawn"]);
/** Daemon operations the CLI sends that mutate nothing, so a lost answer leaves no delivery to resolve. */
const READ_ONLY_OPERATIONS = new Set(["get_state"]);
const DESTRUCTIVE_TIMEOUT_MARGIN_MS = 1_000;
const DEFAULT_STOP_POLICY = Object.freeze({ gracefulMs: 5_000, terminateMs: 5_000 });
/** Worst-case wait for the daemon's SIGTERM-then-SIGKILL escalation under the default policy. */
export const DEFAULT_STOP_ESCALATION_MS = DEFAULT_STOP_POLICY.gracefulMs + DEFAULT_STOP_POLICY.terminateMs + DESTRUCTIVE_TIMEOUT_MARGIN_MS;
const RESOLUTIONS = new Set(["retry_at_risk", "abandon"]);
/** Combined ceiling for one `logs` answer, matching the raw-output tail Claude Code keeps for its own. */
const LOG_TAIL_MAX_BYTES = 262_144;
const STDERR_SEGMENT_NAME = /^stderr\.(\d+)\.jsonl$/u;
const UNSAFE_LOG_OPEN_CODES = new Set(["ELOOP", "ENOTDIR", "EISDIR"]);

/**
 * Resolve how long a destructive request may wait, from the stop policy the daemon actually escalates on.
 * SIGTERM then SIGKILL spans gracefulMs + terminateMs, so a shorter CLI deadline reports a false timeout.
 * @param {string} root @param {{gracefulMs:number,terminateMs:number}} [override] @param {number} [requested]
 */
export async function destructiveRequestTimeoutMs(root, override, requested) {
  let policy = override;
  if (policy === undefined) {
    try {
      const config = loadDashboardConfig(JSON.parse(await fs.readFile(join(root, "dashboard.json"), "utf8")));
      policy = config.stop;
    } catch {
      policy = DEFAULT_STOP_POLICY;
    }
  }
  const escalation = policy.gracefulMs + policy.terminateMs + DESTRUCTIVE_TIMEOUT_MARGIN_MS;
  return Math.max(escalation, requested ?? 0);
}

/** Accept only a full identifier the caller typed exactly, never a prefix or a path. @param {unknown} value */
export function exactId(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !value.includes("/") && !value.includes("\0") && value !== "." && value !== "..";
}

/** Resolve the machine-local dashboard state root. @param {NodeJS.ProcessEnv} [env] */
export function resolveRuntimeRoot(env = process.env) {
  const home = env.HOME ?? homedir();
  return resolve(env.PI_AGENTS_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-agents"));
}

/** @param {string} directory @param {any} [fsOps] */
async function ensurePrivateDirectory(directory, fsOps = fs) {
  await fsOps.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await fsOps.chmod(directory, PRIVATE_DIRECTORY_MODE);
  const metadata = await fsOps.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw Object.assign(new Error("CLI state directory is unsafe"), { code: "CLI_STATE_UNSAFE" });
  }
}

/** @param {string} directory @param {any} [fsOps] */
async function syncDirectory(directory, fsOps = fs) {
  const handle = await fsOps.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** @param {string} path @param {string} unsafeMessage @param {any} [fsOps] */
async function readPrivateFile(path, unsafeMessage, fsOps = fs) {
  const handle = await fsOps.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== PRIVATE_FILE_MODE) throw Object.assign(new Error(unsafeMessage), { code: "CLI_STATE_UNSAFE" });
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Object.assign(new Error(unsafeMessage), { code: "CLI_STATE_UNSAFE" });
    return { text, identity: { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs } };
  } finally {
    await handle.close();
  }
}

/** Publish a fully durable private file without replacing an existing winner. @param {string} directory @param {string} path @param {string} text @param {() => unknown | Promise<unknown>} [beforePublish] @param {any} [fsOps] */
async function publishPrivateFile(directory, path, text, beforePublish = () => {}, fsOps = fs) {
  const temporary = join(directory, `.publish-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsOps.open(temporary, "wx", PRIVATE_FILE_MODE);
    await handle.chmod(PRIVATE_FILE_MODE);
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE) throw Object.assign(new Error("CLI temporary state is unsafe"), { code: "CLI_STATE_UNSAFE" });
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforePublish();
    try {
      await fsOps.link(temporary, path);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code ?? "";
      if (code === "EEXIST") return false;
      if (ATOMIC_PUBLICATION_UNSUPPORTED_CODES.has(code)) throw Object.assign(new Error("State filesystem does not support atomic no-replace publication", { cause: error }), { code: "ATOMIC_PUBLICATION_UNSUPPORTED" });
      throw error;
    }
    await syncDirectory(directory, fsOps);
    return true;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {});
    await fsOps.unlink(temporary).catch((error) => { if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") throw error; });
  }
}

/** Load or create the private stable identity shared by CLI invocations. */
export async function loadCliClientIdentity({
  root = resolveRuntimeRoot(),
  randomId = randomUUID,
  identityFailpoint = () => {},
  fsOps = fs,
  inspect = inspectProcessIdentity,
  lockTimeoutMs = IDENTITY_LOCK_TIMEOUT_MS,
  winnerReadAttempts = IDENTITY_WINNER_READ_ATTEMPTS,
  winnerReadTimeoutMs = lockTimeoutMs,
  winnerReadDelayMs = IDENTITY_WINNER_READ_DELAY_MS,
} = {}) {
  if (![lockTimeoutMs, winnerReadAttempts, winnerReadTimeoutMs].every((value) => Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(winnerReadDelayMs) || winnerReadDelayMs < 0) throw new TypeError("CLI identity wait bounds are invalid");
  const directory = join(root, "cli");
  const path = join(directory, "client-id");
  await ensurePrivateDirectory(directory, fsOps);
  const readIdentity = async () => {
    let persisted;
    try { persisted = await readPrivateFile(path, "CLI client identity is unsafe", fsOps); } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return undefined;
      throw error;
    }
    const clientId = persisted.text.trim();
    if (!exactId(clientId)) throw Object.assign(new Error("CLI client identity is invalid"), { code: "CLI_STATE_CORRUPT" });
    return clientId;
  };
  return withCliStateLock(directory, "client-id", async () => {
    const lockedExisting = await readIdentity();
    if (lockedExisting !== undefined) return lockedExisting;
    const generated = `cli-${randomId()}`;
    if (!exactId(generated)) throw new TypeError("CLI client ID generator returned an invalid identity");
    const published = await publishPrivateFile(directory, path, `${generated}\n`, async () => /** @type {any} */ (identityFailpoint)("identity_before_publish", { path, clientId: generated }), fsOps);
    if (published) return generated;
    const deadline = Date.now() + winnerReadTimeoutMs;
    for (let attempt = 0; attempt < winnerReadAttempts && Date.now() <= deadline; attempt += 1) {
      const winner = await readIdentity();
      if (winner !== undefined) return winner;
      if (attempt + 1 < winnerReadAttempts && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, winnerReadDelayMs));
    }
    throw Object.assign(new Error("CLI identity winner did not become readable"), { code: "CLI_STATE_BUSY" });
  }, { timeoutMs: lockTimeoutMs, operation: "client_identity", busyMessage: "CLI client identity lock remained held", fsOps, inspect });
}

/** @param {unknown} value */
function validateAuthentication(value) {
  const invalid = () => Object.assign(new Error("Daemon authentication frame is invalid"), { code: "INVALID_DAEMON_AUTHENTICATION" });
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const frame = /** @type {Record<string, any>} */ (value);
  const baseKeys = ["version", "kind", "state", "recovering", "daemonEpoch", "pid"];
  const failed = frame.state === "FAILED";
  const allowed = new Set(failed ? [...baseKeys, "error"] : baseKeys);
  const error = frame.error;
  const validError = typeof error === "object" && error !== null && !Array.isArray(error) &&
    Object.keys(error).length === 3 && Object.keys(error).every((key) => ["code", "message", "retryable"].includes(key)) &&
    exactId(error.code) && typeof error.message === "string" && typeof error.retryable === "boolean";
  const recovering = frame.state === "STARTING" || frame.state === "RECONCILING";
  if (frame.version !== 1 || frame.kind !== "authenticated" || !AUTHENTICATION_STATES.has(frame.state) || frame.recovering !== recovering || !exactId(frame.daemonEpoch) || !Number.isSafeInteger(frame.pid) || frame.pid <= 0 || Object.keys(frame).length !== allowed.size || Object.keys(frame).some((key) => !allowed.has(key)) || (failed && !validError)) throw invalid();
}

/** @param {string} op @param {any} payload @param {string} clientId @param {string} requestId @param {any} result */
function validateExpectedResult(op, payload, clientId, requestId, result) {
  const unexpected = (message) => Object.assign(new Error(message), { code: "UNEXPECTED_DAEMON_RESPONSE" });
  if (op === "get_state") {
    if (result.kind !== "state") throw unexpected("Daemon returned the wrong result kind for get_state");
    return;
  }
  if (DESTRUCTIVE_OPERATIONS.has(op)) {
    const status = result.kind === "command" ? result.status : undefined;
    if (status?.clientId !== clientId || status.requestId !== requestId || status.operation !== op || !["COMPLETED", "DELIVERY_UNKNOWN", "FAILED"].includes(status.stage)) {
      throw unexpected(`Daemon returned an unexpected ${op} command status`);
    }
    return;
  }
  if (op === "resolve_delivery") {
    const status = result.kind === "command" ? result.status : undefined;
    const expectedStage = payload.resolution === "retry_at_risk" ? "ACCEPTED" : "FAILED";
    if (status?.clientId !== payload.targetClientId || status.requestId !== payload.targetRequestId || status.stage !== expectedStage) {
      throw unexpected("Daemon returned an unexpected delivery-resolution status");
    }
  }
}

/** Create one persistent authenticated request session for composer-scoped operations.
 * @param {{ root?: string, clientId?: string, maxBytes?: number, timeoutMs?: number }} [options]
 */
export async function createPersistentDaemonRequester({ root = resolveRuntimeRoot(), clientId, maxBytes = 1024 * 1024, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  if (!exactId(clientId)) throw new TypeError("A stable CLI clientId is required");
  const token = (await fs.readFile(join(root, "daemon", "control.token"), "utf8")).trim();
  const client = createDaemonClient({ socketPath: join(root, "daemon", "control.sock"), token, maxBytes, clientId, reconnect: false });
  await client.connect();
  return {
    async request(op, payload, requestId = randomUUID()) {
      let timer;
      let rejectFatal;
      const fatal = new Promise((_, reject) => { rejectFatal = reject; });
      const removeFatal = client.onFatalError((error) => rejectFatal(Object.assign(new Error(error.message), { code: "INVALID_DAEMON_RESPONSE" })));
      try {
        const response = await Promise.race([
          client.request({ version: 1, clientId, requestId, op, payload }),
          fatal,
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Daemon request timed out"), DESTRUCTIVE_OPERATIONS.has(op) ? { code: "DELIVERY_UNKNOWN", clientId, requestId } : { code: "DAEMON_REQUEST_TIMEOUT" })), timeoutMs); }),
        ]);
        if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
        validateExpectedResult(op, payload, clientId, requestId, response.result);
        return response.result;
      } catch (error) {
        const destructive = DESTRUCTIVE_OPERATIONS.has(op);
        const responseUnvalidated = ["INVALID_DAEMON_RESPONSE", "UNEXPECTED_DAEMON_RESPONSE", "MALFORMED_RESPONSE"].includes(error?.code);
        if (destructive && (responseUnvalidated || (error?.code === "CONNECTION_CLOSED" && error?.submitted === true))) throw Object.assign(new Error("Destructive command delivery is ambiguous"), { code: "DELIVERY_UNKNOWN", clientId, requestId, submitted: true });
        throw error;
      } finally { clearTimeout(timer); removeFatal(); }
    },
    close: () => client.close(),
  };
}

/** Create one bounded authenticated requester; transport closure never signals workers.
 * @param {{ root?: string, clientId?: string, maxBytes?: number, timeoutMs?: number, createConnection?: typeof net.createConnection }} [options]
 */
export function createDaemonRequester({ root = resolveRuntimeRoot(), clientId, maxBytes = 1024 * 1024, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, createConnection = net.createConnection } = {}) {
  if (!exactId(clientId)) throw new TypeError("A stable CLI clientId is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive safe integer");
  return async (op, payload, requestId = randomUUID()) => {
    const token = (await fs.readFile(join(root, "daemon", "control.token"), "utf8")).trim();
    const encoder = createJsonlEncoder({ maxBytes });
    const decoder = createJsonlDecoder({ maxBytes });
    return new Promise((resolveRequest, rejectRequest) => {
      const socket = createConnection(join(root, "daemon", "control.sock"));
      let settled = false;
      let submitted = false;
      /** @type {any} */
      let validatedResponse;
      const deliveryUnknown = () => Object.assign(new Error("Daemon response was lost after submission"), { code: "DELIVERY_UNKNOWN", clientId, requestId });
      const protocolError = (code, message, cause) => Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
      /** @type {NodeJS.Timeout} */
      let timer;
      /** @param {unknown} error @param {unknown} [value] */
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error !== undefined) rejectRequest(error);
        else resolveRequest(value);
      };
      const settleValidated = () => {
        if (validatedResponse === undefined) return false;
        if (!validatedResponse.ok) finish(Object.assign(new Error(validatedResponse.error.message || "Daemon request failed"), validatedResponse.error));
        else finish(undefined, validatedResponse.result);
        return true;
      };
      /** Finalize buffered UTF-8/JSONL before classifying a transport boundary. @param {unknown} fallback */
      const finalizeTransport = (fallback) => {
        if (settled) return;
        try { decoder.end(); } catch (error) { finish(error); return; }
        if (!settleValidated()) finish(fallback);
      };
      const transportClosed = (error) => finalizeTransport(submitted ? deliveryUnknown() : error ?? Object.assign(new Error("Daemon connection closed"), { code: "CONNECTION_CLOSED" }));
      timer = setTimeout(() => finalizeTransport(submitted && !READ_ONLY_OPERATIONS.has(op) ? deliveryUnknown() : Object.assign(new Error("Daemon request timed out"), { code: "DAEMON_REQUEST_TIMEOUT" })), timeoutMs);
      socket.once("connect", () => socket.write(encoder.encode({ version: 1, token })));
      socket.on("error", transportClosed);
      socket.on("data", (chunk) => {
        try {
          const frames = decoder.push(chunk);
          if (!submitted) {
            if (frames.length === 0) return;
            validateAuthentication(frames[0]);
            if (frames.length !== 1) throw protocolError("UNEXPECTED_DAEMON_FRAME", "Daemon sent trailing data with authentication");
            submitted = true;
            socket.end(encoder.encode({ version: 1, clientId, requestId, op, payload }));
            return;
          }
          if (validatedResponse !== undefined) {
            if (frames.length === 0) throw protocolError("TRAILING_DAEMON_DATA", "Daemon sent partial data after its validated response");
            if (frames.every((frame) => typeof frame === "object" && frame !== null && Object.hasOwn(frame, "requestId"))) throw protocolError("DUPLICATE_DAEMON_RESPONSE", "Daemon sent data after its validated response");
            throw protocolError("UNEXPECTED_DAEMON_FRAME", "Daemon sent trailing data after its validated response");
          }
          if (frames.length === 0) return;
          if (frames.some((frame) => typeof frame !== "object" || frame === null || !Object.hasOwn(frame, "requestId"))) throw protocolError("UNEXPECTED_DAEMON_FRAME", "Daemon sent an event or trailing frame where a response was required");
          /** @type {any[]} */
          const responses = [];
          for (const frame of frames) {
            let parsed;
            try { parsed = parseDaemonResponse(frame); } catch (error) { throw protocolError("INVALID_DAEMON_RESPONSE", "Daemon response failed strict validation", error); }
            if (parsed.requestId !== requestId) throw protocolError("UNEXPECTED_DAEMON_RESPONSE", "Daemon response requestId does not match the submitted request");
            responses.push(parsed);
          }
          if (responses.length !== 1) throw protocolError("DUPLICATE_DAEMON_RESPONSE", "Daemon sent more than one response for one request");
          const parsed = responses[0];
          if (parsed.ok) validateExpectedResult(op, payload, clientId, requestId, parsed.result);
          validatedResponse = parsed;
        } catch (error) {
          finish(error);
        }
      });
      socket.once("end", () => transportClosed());
      socket.once("close", () => transportClosed());
    });
  };
}

/** @param {string[]} argv */
function parse(argv) {
  const [command, ...args] = argv;
  if (command === "resolve-delivery") {
    const [targetClientId, targetRequestId, resolution, confirmation, ...extra] = args;
    if (!exactId(targetClientId) || !exactId(targetRequestId) || !RESOLUTIONS.has(resolution) || confirmation !== "--yes" || extra.length > 0) {
      return { error: "Usage: session resolve-delivery <full-client-id> <full-request-id> retry_at_risk|abandon --yes" };
    }
    return { command, targetClientId, targetRequestId, resolution };
  }

  const [sessionId, ...flags] = args;
  const operation = SESSION_OPERATIONS.get(command);
  if (operation === undefined || !exactId(sessionId)) {
    return { error: "Usage: pi-agents stop|rm|respawn <full-id> --revision <n> --yes | pi-agents session cleanup <full-id> --revision <n> --yes | pi-agents session resolve-delivery <full-client-id> <full-request-id> retry_at_risk|abandon --yes" };
  }

  let revision;
  let confirmed = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--yes" && !confirmed) {
      confirmed = true;
      continue;
    }
    if (flag === "--revision" && revision === undefined && index + 1 < flags.length) {
      const value = flags[index + 1];
      if (!/^(0|[1-9]\d*)$/u.test(value)) return { error: "Destructive session commands require --revision <non-negative integer> --yes" };
      revision = Number(value);
      index += 1;
      continue;
    }
    return { error: "Destructive session commands require --revision <non-negative integer> --yes" };
  }
  if (!confirmed || !Number.isSafeInteger(revision)) return { error: "Destructive session commands require --revision <non-negative integer> --yes" };
  return { command, operation, sessionId, revision };
}

/** @param {string} action @param {string} sessionId @param {number} revision */
function pendingKey(action, sessionId, revision) {
  return createHash("sha256").update(JSON.stringify([action, sessionId, revision])).digest("hex");
}

/** @param {string} root */
async function pendingDirectory(root) {
  const directory = join(root, "cli", "pending");
  await ensurePrivateDirectory(directory);
  return directory;
}

/** @param {any} entry @param {string} action @param {string} sessionId @param {number} revision */
function validatePendingEntry(entry, action, sessionId, revision) {
  const keys = ["schemaVersion", "action", "sessionId", "revision", "clientId", "requestId"];
  if (entry?.schemaVersion !== 1 || entry.action !== action || entry.sessionId !== sessionId || entry.revision !== revision || !exactId(entry.clientId) || !exactId(entry.requestId) || Object.keys(entry).length !== keys.length || Object.keys(entry).some((key) => !keys.includes(key))) throw Object.assign(new Error("Pending CLI request is corrupt"), { code: "CLI_STATE_CORRUPT" });
}

/** @param {string} path @param {string} action @param {string} sessionId @param {number} revision */
async function readPendingPath(path, action, sessionId, revision) {
  let persisted;
  try {
    persisted = await readPrivateFile(path, "Pending CLI request is unsafe");
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? "")) throw Object.assign(new Error("Pending CLI request is unsafe", { cause: error }), { code: "CLI_STATE_UNSAFE" });
    throw error;
  }
  let entry;
  try { entry = JSON.parse(persisted.text); } catch (error) { throw Object.assign(new Error("Pending CLI request is corrupt", { cause: error }), { code: "CLI_STATE_CORRUPT" }); }
  validatePendingEntry(entry, action, sessionId, revision);
  return { path, entry, identity: persisted.identity };
}

/** Remove only a dead holder's exact token entry. @param {string} lockPath @param {{ fsOps?: any, inspect?: typeof inspectProcessIdentity, unsafeMessage?: string }} [options] */
async function recoverStaleCliLock(lockPath, { fsOps = fs, inspect = inspectProcessIdentity, unsafeMessage = "CLI state lock is unsafe" } = {}) {
  let metadata;
  try { metadata = await fsOps.lstat(lockPath); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return true;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) return false;
  let entries;
  try { entries = await fsOps.readdir(lockPath); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return true; throw error; }
  if (entries.length !== 1 || !exactId(entries[0])) return false;
  const entryPath = join(lockPath, entries[0]);
  let first;
  try { first = await readPrivateFile(entryPath, unsafeMessage, fsOps); } catch { return false; }
  let record;
  try { record = JSON.parse(first.text); } catch { return false; }
  if (record?.token !== entries[0] || !Number.isSafeInteger(record.owner?.pid) || record.owner.pid <= 0 || !exactId(record.owner?.startIdentity)) return false;
  try {
    const live = await inspect(record.owner.pid);
    if (live.startIdentity === record.owner.startIdentity) return false;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") return false;
  }
  let current;
  try { current = await readPrivateFile(entryPath, unsafeMessage, fsOps); } catch { return false; }
  if (current.text !== first.text || !sameFileIdentity(current.identity, first.identity)) return false;
  try { await fsOps.unlink(entryPath); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") throw error;
  }
  await fsOps.rmdir(lockPath).catch((error) => { if (!["ENOENT", "ENOTEMPTY"].includes(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? "")) throw error; });
  return true;
}

/** @param {string} directory @param {string} key @param {() => Promise<any>} action @param {{ timeoutMs?: number, operation?: string, busyMessage?: string, unsafeMessage?: string, fsOps?: any, inspect?: typeof inspectProcessIdentity }} [options] */
async function withCliStateLock(directory, key, action, { timeoutMs = PENDING_LOCK_TIMEOUT_MS, operation = "pending_request", busyMessage = "Pending CLI request lock remained held", unsafeMessage = "Pending CLI request lock is unsafe", fsOps = fs, inspect = inspectProcessIdentity } = {}) {
  const lockPath = join(directory, `.${key}.lock`);
  const deadline = Date.now() + timeoutMs;
  const processIdentity = await inspect(process.pid);
  let lock;
  for (;;) {
    try {
      lock = await acquireLifecycleLock(lockPath, { pid: processIdentity.pid, startIdentity: processIdentity.startIdentity, processGroupId: processIdentity.processGroupId, key, operation }, fsOps);
      break;
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "LOCK_HELD") throw error;
      if (await recoverStaleCliLock(lockPath, { fsOps, inspect, unsafeMessage })) continue;
      if (Date.now() >= deadline) throw Object.assign(new Error(busyMessage), { code: "CLI_STATE_BUSY" });
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
  }
  try { return await action(); } finally { await lock.release(); }
}

/** @param {string} root @param {string} action @param {string} sessionId @param {number} revision */
async function readPending(root, action, sessionId, revision) {
  const directory = await pendingDirectory(root);
  const path = join(directory, `${pendingKey(action, sessionId, revision)}.json`);
  try {
    return await readPendingPath(path, action, sessionId, revision);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return { path };
    throw error;
  }
}

/** @param {string} root @param {any} entry @param {(stage: string, context: any) => unknown | Promise<unknown>} [failpoint] */
async function putPending(root, entry, failpoint = () => {}) {
  const directory = await pendingDirectory(root);
  const key = pendingKey(entry.action, entry.sessionId, entry.revision);
  const path = join(directory, `${key}.json`);
  const candidate = { schemaVersion: 1, ...entry };
  return withCliStateLock(directory, key, async () => {
    await recoverPendingClear(directory, key, path, entry.action, entry.sessionId, entry.revision);
    const winner = await readPending(root, entry.action, entry.sessionId, entry.revision);
    if (winner.entry !== undefined) return winner;
    const published = await publishPrivateFile(directory, path, `${JSON.stringify(candidate)}\n`, async () => failpoint("pending_before_publish", { path, entry: candidate }));
    if (!published) {
      const existing = await readPending(root, entry.action, entry.sessionId, entry.revision);
      if (existing.entry === undefined) throw Object.assign(new Error("Pending CLI request winner disappeared"), { code: "CLI_STATE_UNSAFE" });
      return existing;
    }
    await failpoint("pending_after_publish", { path, entry: candidate });
    return readPendingPath(path, entry.action, entry.sessionId, entry.revision);
  });
}

/** @param {any} left @param {any} right */
function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino && left?.size === right?.size && left?.mtimeMs === right?.mtimeMs;
}

/** Restore the single exact pending tombstone left by a crashed clearer. @param {string} directory @param {string} key @param {string} path @param {string} action @param {string} sessionId @param {number} revision */
async function recoverPendingClear(directory, key, path, action, sessionId, revision) {
  const prefix = `.${key}.clear.`;
  const tombstones = (await fs.readdir(directory)).filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"));
  if (tombstones.length === 0) return;
  if (tombstones.length !== 1) throw Object.assign(new Error("Pending CLI clear recovery is ambiguous"), { code: "CLI_STATE_UNSAFE" });
  const tombstone = join(directory, tombstones[0]);
  const moved = await readPendingPath(tombstone, action, sessionId, revision);
  let current;
  try { current = await readPendingPath(path, action, sessionId, revision); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") throw error;
  }
  if (current === undefined) {
    await fs.rename(tombstone, path);
    await syncDirectory(directory);
    return;
  }
  if (JSON.stringify(current.entry) !== JSON.stringify(moved.entry) || !sameFileIdentity(current.identity, moved.identity)) throw Object.assign(new Error("Pending CLI clear recovery conflicts with a replacement"), { code: "CLI_STATE_UNSAFE" });
  await fs.unlink(tombstone);
  await syncDirectory(directory);
}

/** @param {string} root @param {string | undefined} path @param {any} expected @param {(stage: string, context: any) => unknown | Promise<unknown>} [failpoint] */
async function clearPending(root, path, expected, failpoint = () => {}) {
  if (path === undefined || expected?.entry === undefined) return;
  const directory = await pendingDirectory(root);
  const key = pendingKey(expected.entry.action, expected.entry.sessionId, expected.entry.revision);
  await withCliStateLock(directory, key, async () => {
    await recoverPendingClear(directory, key, path, expected.entry.action, expected.entry.sessionId, expected.entry.revision);
    const current = await readPending(root, expected.entry.action, expected.entry.sessionId, expected.entry.revision);
    if (current.path !== path || current.entry === undefined || JSON.stringify(current.entry) !== JSON.stringify(expected.entry) || !sameFileIdentity(current.identity, expected.identity)) return;
    const tombstone = join(directory, `.${key}.clear.${randomUUID()}.tmp`);
    await failpoint("pending_before_clear", { path, tombstone, entry: current.entry });
    await fs.rename(path, tombstone);
    let restore = true;
    try {
      await failpoint("pending_after_tombstone", { path, tombstone, entry: current.entry });
      const moved = await readPendingPath(tombstone, current.entry.action, current.entry.sessionId, current.entry.revision);
      if (JSON.stringify(moved.entry) !== JSON.stringify(current.entry) || !sameFileIdentity(moved.identity, current.identity)) throw Object.assign(new Error("Pending CLI request changed during clear"), { code: "CLI_STATE_UNSAFE" });
      await fs.unlink(tombstone);
      restore = false;
      await syncDirectory(directory);
    } finally {
      if (restore) {
        try {
          await fs.link(tombstone, path);
          await syncDirectory(directory);
          await fs.unlink(tombstone);
          await syncDirectory(directory);
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "EEXIST") throw error;
        }
      }
    }
  });
}

/** @param {string} root @param {string} clientId @param {string} requestId @param {(stage: string, context: any) => unknown | Promise<unknown>} [failpoint] */
async function clearPendingIdentity(root, clientId, requestId, failpoint = () => {}) {
  const directory = await pendingDirectory(root);
  for (const name of await fs.readdir(directory)) {
    const isPending = name.endsWith(".json");
    const isTombstone = /^\.[a-f0-9]{64}\.clear\..+\.tmp$/u.test(name);
    if (!isPending && !isTombstone) continue;
    const discoveredPath = join(directory, name);
    let raw;
    try { raw = await readPrivateFile(discoveredPath, "Pending CLI request is unsafe"); } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") continue;
      if (["ELOOP", "ENOTDIR"].includes(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? "")) throw Object.assign(new Error("Pending CLI request is unsafe", { cause: error }), { code: "CLI_STATE_UNSAFE" });
      throw error;
    }
    let entry;
    try { entry = JSON.parse(raw.text); } catch (error) { throw Object.assign(new Error("Pending CLI request is corrupt", { cause: error }), { code: "CLI_STATE_CORRUPT" }); }
    if (entry?.clientId !== clientId || entry?.requestId !== requestId) continue;
    validatePendingEntry(entry, entry.action, entry.sessionId, entry.revision);
    const key = pendingKey(entry.action, entry.sessionId, entry.revision);
    const path = join(directory, `${key}.json`);
    if ((isPending && name !== `${key}.json`) || (isTombstone && !name.startsWith(`.${key}.clear.`))) throw Object.assign(new Error("Pending CLI request filename conflicts with its content"), { code: "CLI_STATE_UNSAFE" });
    const expected = isPending ? await readPending(root, entry.action, entry.sessionId, entry.revision) : { path, entry, identity: raw.identity };
    if (expected.entry !== undefined) await clearPending(root, path, expected, failpoint);
  }
}

/** @param {any} result */
function classifyCommandResult(result) {
  if (result?.kind !== "command" || !["COMPLETED", "DELIVERY_UNKNOWN", "FAILED"].includes(result.status?.stage)) {
    return { code: 1, error: { code: "INVALID_RESPONSE", message: "Daemon returned an unexpected command result" } };
  }
  if (result.status.stage === "DELIVERY_UNKNOWN") {
    return { code: 1, error: { code: "DELIVERY_UNKNOWN", message: "Delivery is ambiguous; use session resolve-delivery with the exact clientId/requestId", clientId: result.status.clientId, requestId: result.status.requestId }, result };
  }
  if (result.status.stage === "FAILED") {
    return { code: 1, error: result.status.error ?? { code: "COMMAND_FAILED", message: "Command failed" }, result };
  }
  return { code: 0, result };
}

/** Read every machine-local session row without opening the list. */
export async function runAgentsCommand(options = {}) {
  const root = options.root ?? resolveRuntimeRoot(options.env);
  const request = options.request ?? createDaemonRequester({ root, clientId: await loadCliClientIdentity({ root, randomId: options.randomId }), timeoutMs: options.timeoutMs });
  const state = await request("get_state", {});
  return { code: 0, result: { kind: "agents", sessions: state.sessions } };
}

/** @param {string} message @param {unknown} [cause] */
function unsafeLogSource(message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code: "LOG_SOURCE_UNSAFE" });
}

/**
 * Decode only whole characters, dropping a sequence the tail offset or a killed writer cut in half.
 * @param {Buffer} bytes
 */
function completeUtf8(bytes) {
  let start = 0;
  while (start < bytes.length && (bytes[start] & 0b1100_0000) === 0b1000_0000) start += 1;
  let end = bytes.length;
  for (let back = 1; back <= 3 && end - back >= start; back += 1) {
    const byte = bytes[end - back];
    if ((byte & 0b1100_0000) === 0b1000_0000) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (width > back) end -= back;
    break;
  }
  return bytes.subarray(start, end).toString("utf8");
}

/**
 * Read at most `maxTailBytes` from the end of one owned regular file, following no symbolic link.
 * @param {string} path @param {number} maxTailBytes @param {(stage: string, context: any) => unknown | Promise<unknown>} [failpoint]
 * @returns {Promise<{ path: string, text: string, bytes: number, truncated: boolean } | undefined>} absent when no such log exists
 */
async function readLogTail(path, maxTailBytes, failpoint = () => {}) {
  let handle;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code ?? "";
    if (code === "ENOENT") return undefined;
    if (UNSAFE_LOG_OPEN_CODES.has(code)) throw unsafeLogSource(`Log source is not an owned regular file: ${path}`, error);
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid?.()) throw unsafeLogSource(`Log source is not an owned regular file: ${path}`);
    const start = Math.max(0, before.size - maxTailBytes);
    const length = before.size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, length, start);
    await failpoint("after_read", { path });
    // An open descriptor's device and inode cannot change, so the replacement check has to look the
    // name up again: a rotated or swapped log leaves this descriptor readable but no longer that path.
    const after = await fs.lstat(path).catch(() => undefined);
    if (after?.dev !== before.dev || after.ino !== before.ino) throw unsafeLogSource(`Log source was replaced while it was read: ${path}`);
    return { path, text: completeUtf8(buffer.subarray(0, bytesRead)), bytes: bytesRead, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

/** Newest rotating Pi stderr segment of one run, by the index its writer pads into the name. @param {string} directory */
async function newestStderrSegment(directory) {
  let names;
  try { names = await fs.readdir(directory); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return undefined;
    throw error;
  }
  /** @type {{ index: number, name: string } | undefined} */
  let newest;
  for (const name of names) {
    const match = STDERR_SEGMENT_NAME.exec(name);
    if (match === null) continue;
    const index = Number(match[1]);
    if (newest === undefined || index > newest.index) newest = { index, name };
  }
  return newest === undefined ? undefined : join(directory, newest.name);
}

/** Resolve one run's directory from the record's root-relative hash, never from a stored path. @param {string} root @param {unknown} runHash */
function resolveRunDirectory(root, runHash) {
  if (runHash === undefined) return undefined;
  if (typeof runHash !== "string" || runHash.length === 0 || runHash.includes("/") || runHash.startsWith(".")) throw unsafeLogSource(`Run directory is not a root-relative name: ${String(runHash)}`);
  const runs = join(root, "runs");
  const directory = join(runs, runHash);
  if (!directory.startsWith(`${runs}/`)) throw unsafeLogSource(`Run directory escapes the state root: ${runHash}`);
  return directory;
}

/** @param {{ path: string, text: string, truncated: boolean }} source */
function renderLogSource(source) {
  const header = `==> ${source.path}${source.truncated ? " (tail)" : ""} <==\n`;
  return source.text.length === 0 || source.text.endsWith("\n") ? `${header}${source.text}` : `${header}${source.text}\n`;
}

/**
 * Read the bounded log tail the operator needs after a startup failure: the daemon's startup log,
 * or one session's newest Pi stderr segment followed by its worker stderr.
 * @param {string} [sessionId] @param {any} [options]
 */
export async function runLogsCommand(sessionId, options = {}) {
  const root = options.root ?? resolveRuntimeRoot(options.env);
  /** @type {string[]} */
  let candidates;
  try {
    if (sessionId === undefined) candidates = [join(root, "daemon", "startup.log")];
    else {
      if (!exactId(sessionId)) return { code: 2, error: { code: "INVALID_SYNTAX", message: "Usage: pi-agents logs [<full-session-id>]" } };
      const request = options.request ?? createDaemonRequester({ root, clientId: await loadCliClientIdentity({ root, randomId: options.randomId }), timeoutMs: options.timeoutMs });
      const state = await request("get_state", {});
      const session = state?.sessions?.find((/** @type {any} */ candidate) => candidate.sessionId === sessionId);
      if (session === undefined) return { code: 1, error: { code: "SESSION_NOT_FOUND", message: `Unknown exact session ID: ${sessionId}` } };
      const directory = resolveRunDirectory(root, session.runHash);
      if (directory === undefined) return { code: 1, error: { code: "LOGS_NOT_FOUND", message: `Session ${sessionId} has no run directory yet` } };
      // Pi's own complaint takes the budget first: the worker stderr line that reports the exit
      // rarely says why Pi refused, and that is the failure this command exists for.
      const segment = await newestStderrSegment(join(directory, "diagnostics"));
      candidates = [...(segment === undefined ? [] : [segment]), join(directory, "worker.stderr.log")];
    }
    /** @type {{ path: string, text: string, bytes: number, truncated: boolean }[]} */
    const sources = [];
    let remaining = options.maxTailBytes ?? LOG_TAIL_MAX_BYTES;
    for (const path of candidates) {
      const source = await readLogTail(path, Math.max(0, remaining), options.logFailpoint);
      if (source === undefined) continue;
      remaining -= source.bytes;
      sources.push(source);
    }
    if (sources.length === 0) return { code: 1, error: { code: "LOGS_NOT_FOUND", message: `No readable log at: ${candidates.join(", ")}` } };
    return { code: 0, result: { kind: "logs", sources: sources.map(({ path, bytes, truncated }) => ({ path, bytes, truncated })), text: sources.map(renderLogSource).join("") } };
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== "LOG_SOURCE_UNSAFE") throw error;
    return { code: 1, error: { code: "LOG_SOURCE_UNSAFE", message: /** @type {Error} */ (error).message } };
  }
}

/** Run an exact-ID session command. */
export async function runSessionCommand(argv, options = {}) {
  const parsed = parse(argv);
  if ("error" in parsed) return { code: 2, error: { code: "INVALID_SYNTAX", message: parsed.error } };
  const root = options.root ?? resolveRuntimeRoot(options.env);

  if (parsed.command === "resolve-delivery") {
    const clientId = await loadCliClientIdentity({ root, randomId: options.randomId });
    const request = options.request ?? createDaemonRequester({ root, clientId, timeoutMs: options.timeoutMs });
    const result = await request("resolve_delivery", { targetClientId: parsed.targetClientId, targetRequestId: parsed.targetRequestId, resolution: parsed.resolution });
    if (result?.kind !== "command") return { code: 1, error: { code: "INVALID_RESPONSE", message: "Daemon returned the wrong resolution result" } };
    if (parsed.resolution === "abandon" || result.status?.stage === "COMPLETED" || result.status?.stage === "FAILED") await clearPendingIdentity(root, parsed.targetClientId, parsed.targetRequestId, options.pendingFailpoint);
    return { code: 0, result };
  }

  if (DESTRUCTIVE_OPERATIONS.has(parsed.operation)) {
    const clientId = await loadCliClientIdentity({ root, randomId: options.randomId });
    const existing = await readPending(root, parsed.operation, parsed.sessionId, parsed.revision);
    const pending = existing.entry === undefined
      ? await putPending(root, { action: parsed.operation, sessionId: parsed.sessionId, revision: parsed.revision, clientId, requestId: randomUUID() }, options.pendingFailpoint)
      : existing;
    if (pending.entry.clientId !== clientId) throw Object.assign(new Error("Persistent CLI identity changed while a destructive request remains pending"), { code: "CLI_CLIENT_IDENTITY_CHANGED", pendingClientId: pending.entry.clientId, currentClientId: clientId, requestId: pending.entry.requestId });
    const destructiveTimeoutMs = await destructiveRequestTimeoutMs(root, options.stopPolicy, options.timeoutMs);
    const persistent = options.request === undefined && options.composerRequest === undefined
      ? await createPersistentDaemonRequester({ root, clientId: pending.entry.clientId, timeoutMs: destructiveTimeoutMs })
      : undefined;
    const request = options.composerRequest ?? persistent?.request ?? options.request;
    const claimsComposer = options.composerRequest !== undefined || persistent !== undefined;
    let attached = false;
    let canDetach = false;
    try {
      if (claimsComposer) {
        const attachment = await request("attach", { sessionId: parsed.sessionId, role: "composer" });
        if (attachment?.kind !== "attached" || attachment.role !== "composer") throw Object.assign(new Error("Daemon refused the composer role"), { code: "ATTACHMENT_REQUIRED" });
        attached = true;
      }
      const result = await request(parsed.operation, { sessionId: parsed.sessionId, revision: parsed.revision }, pending.entry.requestId);
      canDetach = true;
      if (result?.kind === "command" && ["COMPLETED", "FAILED"].includes(result.status?.stage)) await clearPending(root, pending.path, pending, options.pendingFailpoint);
      return classifyCommandResult(result);
    } catch (error) {
      if (error?.code === "DELIVERY_UNKNOWN") return { code: 1, error: { code: "DELIVERY_UNKNOWN", message: error.message, clientId: pending.entry.clientId, requestId: pending.entry.requestId } };
      if (attached && error?.code === "CONNECTION_CLOSED") return { code: 1, error: { code: "DELIVERY_UNKNOWN", message: "Composer connection was lost before delivery could be confirmed", clientId: pending.entry.clientId, requestId: pending.entry.requestId } };
      throw error;
    } finally {
      if (attached && canDetach) await request("detach", { sessionId: parsed.sessionId }).catch(() => {});
      await persistent?.close();
    }
  }

  const request = options.request ?? createDaemonRequester({ root, clientId: await loadCliClientIdentity({ root, randomId: options.randomId }), timeoutMs: options.timeoutMs });
  const readSession = async () => {
    const state = await request("get_state", {});
    return state?.sessions?.find((candidate) => candidate.sessionId === parsed.sessionId);
  };
  const session = await readSession();
  if (session === undefined) return { code: 1, error: { code: "SESSION_NOT_FOUND", message: `Unknown exact session ID: ${parsed.sessionId}` } };
  if (session.revision !== parsed.revision) return { code: 1, error: { code: "REVISION_CONFLICT", message: "Session revision changed before cleanup" } };
  if (session.isolation?.mode !== "worktree") return { code: 1, error: { code: "NOT_MANAGED_WORKTREE", message: "Shared-directory sessions have no managed worktree to remove" } };

  try {
    const cleanupManagedWorktree = options.cleanupManagedWorktree ?? defaultCleanupManagedWorktree;
    const result = await cleanupManagedWorktree(session.isolation, {
      readLiveOwnership: async () => {
        const current = await readSession();
        if (current === undefined || current.revision !== parsed.revision || current.ownership !== undefined || ["LIVE", "SLEEPING"].includes(current.processState)) return { conflict: true };
        return null;
      },
    });
    return { code: 0, result };
  } catch (error) {
    return { code: ["OWNERSHIP_CONFLICT", "IDENTITY_MISMATCH"].includes(error?.code) ? 5 : 1, error: { code: error?.code ?? "CLEANUP_FAILED", message: error instanceof Error ? error.message : "Cleanup failed" } };
  }
}
