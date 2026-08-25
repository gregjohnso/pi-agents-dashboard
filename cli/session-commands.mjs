import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { cleanupManagedWorktree as defaultCleanupManagedWorktree } from "../isolation/cleanup.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { parseDaemonResponse } from "../shared/contracts.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DESTRUCTIVE_COMMANDS = new Set(["stop", "delete", "cleanup"]);
const RESOLUTIONS = new Set(["retry_at_risk", "abandon"]);

/** @param {unknown} value */
function exactId(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !value.includes("/") && !value.includes("\0") && value !== "." && value !== "..";
}

function runtimeRoot(env = process.env) {
  const home = env.HOME ?? homedir();
  return resolve(env.PI_AGENTS_DASHBOARD_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-agents-dashboard"));
}

/** @param {string} directory */
async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const metadata = await fs.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) {
    throw Object.assign(new Error("CLI state directory is unsafe"), { code: "CLI_STATE_UNSAFE" });
  }
}

/** Load or create the private stable identity shared by CLI invocations. */
export async function loadCliClientIdentity({ root = runtimeRoot(), randomId = randomUUID } = {}) {
  const directory = join(root, "cli");
  const path = join(directory, "client-id");
  await ensurePrivateDirectory(directory);
  try {
    const metadata = await fs.lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw Object.assign(new Error("CLI client identity is unsafe"), { code: "CLI_STATE_UNSAFE" });
    const clientId = (await fs.readFile(path, "utf8")).trim();
    if (!exactId(clientId)) throw Object.assign(new Error("CLI client identity is invalid"), { code: "CLI_STATE_CORRUPT" });
    return clientId;
  } catch (error) {
    if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
  const generated = `cli-${randomId()}`;
  if (!exactId(generated)) throw new TypeError("CLI client ID generator returned an invalid identity");
  try {
    const handle = await fs.open(path, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${generated}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directoryHandle = await fs.open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return generated;
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") return loadCliClientIdentity({ root, randomId });
    throw error;
  }
}

/** @param {unknown} value */
function validateAuthentication(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw Object.assign(new Error("Daemon authentication frame is invalid"), { code: "INVALID_DAEMON_AUTHENTICATION" });
  const frame = /** @type {Record<string, any>} */ (value);
  const allowed = new Set(["version", "kind", "state", "recovering", "error", "daemonEpoch", "pid"]);
  if (frame.version !== 1 || frame.kind !== "authenticated" || typeof frame.state !== "string" || typeof frame.recovering !== "boolean" || !exactId(frame.daemonEpoch) || !Number.isSafeInteger(frame.pid) || Object.keys(frame).some((key) => !allowed.has(key))) {
    throw Object.assign(new Error("Daemon authentication frame is invalid"), { code: "INVALID_DAEMON_AUTHENTICATION" });
  }
}

/** @param {string} op @param {any} payload @param {string} clientId @param {string} requestId @param {any} result */
function validateExpectedResult(op, payload, clientId, requestId, result) {
  const unexpected = (message) => Object.assign(new Error(message), { code: "UNEXPECTED_DAEMON_RESPONSE" });
  if (op === "get_state") {
    if (result.kind !== "state") throw unexpected("Daemon returned the wrong result kind for get_state");
    return;
  }
  if (op === "stop" || op === "delete") {
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

/** Create one bounded authenticated requester; transport closure never signals workers. */
export function createDaemonRequester({ root = runtimeRoot(), clientId, maxBytes = 1024 * 1024, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, createConnection = net.createConnection } = {}) {
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
      /** @type {NodeJS.Immediate | undefined} */
      let responseCheck;
      const deliveryUnknown = () => Object.assign(new Error("Daemon response was lost after submission"), { code: "DELIVERY_UNKNOWN", clientId, requestId });
      const protocolError = (code, message, cause) => Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
      const timer = setTimeout(() => finish(submitted ? deliveryUnknown() : Object.assign(new Error("Daemon request timed out"), { code: "DAEMON_REQUEST_TIMEOUT" })), timeoutMs);
      /** @param {unknown} error @param {unknown} [value] */
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (responseCheck !== undefined) clearImmediate(responseCheck);
        socket.destroy();
        if (error !== undefined) rejectRequest(error);
        else resolveRequest(value);
      };
      const transportClosed = (error) => finish(submitted ? deliveryUnknown() : error ?? Object.assign(new Error("Daemon connection closed"), { code: "CONNECTION_CLOSED" }));
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
            socket.write(encoder.encode({ version: 1, clientId, requestId, op, payload }), (error) => { if (error) transportClosed(error); });
            return;
          }
          if (frames.length === 0) return;
          if (validatedResponse !== undefined) throw protocolError("DUPLICATE_DAEMON_RESPONSE", "Daemon sent data after its validated response");
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
          responseCheck = setImmediate(() => {
            if (!parsed.ok) finish(Object.assign(new Error(parsed.error.message || "Daemon request failed"), parsed.error));
            else finish(undefined, parsed.result);
          });
        } catch (error) {
          finish(error);
        }
      });
      socket.once("end", () => {
        try { decoder.end(); } catch (error) { finish(error); return; }
        transportClosed();
      });
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
  if (!["status", ...DESTRUCTIVE_COMMANDS].includes(command) || !exactId(sessionId)) {
    return { error: "Usage: session status <full-id> | session stop|delete|cleanup <full-id> --revision <n> --yes | session resolve-delivery <full-client-id> <full-request-id> retry_at_risk|abandon --yes" };
  }
  if (command === "status") return flags.length === 0 ? { command, sessionId } : { error: "Status accepts no flags" };

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
  return { command, sessionId, revision };
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

/** @param {string} root @param {string} action @param {string} sessionId @param {number} revision */
async function readPending(root, action, sessionId, revision) {
  const directory = await pendingDirectory(root);
  const path = join(directory, `${pendingKey(action, sessionId, revision)}.json`);
  try {
    const metadata = await fs.lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw Object.assign(new Error("Pending CLI request is unsafe"), { code: "CLI_STATE_UNSAFE" });
    let entry;
    try { entry = JSON.parse(await fs.readFile(path, "utf8")); } catch (error) { throw Object.assign(new Error("Pending CLI request is corrupt", { cause: error }), { code: "CLI_STATE_CORRUPT" }); }
    if (entry?.schemaVersion !== 1 || entry.action !== action || entry.sessionId !== sessionId || entry.revision !== revision || !exactId(entry.clientId) || !exactId(entry.requestId) || Object.keys(entry).some((key) => !["schemaVersion", "action", "sessionId", "revision", "clientId", "requestId"].includes(key))) throw Object.assign(new Error("Pending CLI request is corrupt"), { code: "CLI_STATE_CORRUPT" });
    return { path, entry };
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return { path };
    throw error;
  }
}

/** @param {string} root @param {any} entry */
async function putPending(root, entry) {
  const directory = await pendingDirectory(root);
  const path = join(directory, `${pendingKey(entry.action, entry.sessionId, entry.revision)}.json`);
  const candidate = { schemaVersion: 1, ...entry };
  try {
    const handle = await fs.open(path, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(candidate)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directoryHandle = await fs.open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return { path, entry: candidate };
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") {
      const winner = await readPending(root, entry.action, entry.sessionId, entry.revision);
      if (winner.entry === undefined) throw Object.assign(new Error("Pending CLI request winner disappeared"), { code: "CLI_STATE_UNSAFE" });
      return winner;
    }
    throw error;
  }
}

/** @param {string} root @param {string | undefined} path @param {any} expected */
async function clearPending(root, path, expected) {
  if (path === undefined) return;
  const current = await readPending(root, expected.action, expected.sessionId, expected.revision);
  if (current.path !== path || current.entry === undefined || JSON.stringify(current.entry) !== JSON.stringify(expected)) return;
  await fs.unlink(path).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  const directory = await fs.open(resolve(path, ".."), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** @param {string} root @param {string} clientId @param {string} requestId */
async function clearPendingIdentity(root, clientId, requestId) {
  const directory = await pendingDirectory(root);
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const metadata = await fs.lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw Object.assign(new Error("Pending CLI request is unsafe"), { code: "CLI_STATE_UNSAFE" });
    let entry;
    try { entry = JSON.parse(await fs.readFile(path, "utf8")); } catch (error) { throw Object.assign(new Error("Pending CLI request is corrupt", { cause: error }), { code: "CLI_STATE_CORRUPT" }); }
    if (entry?.clientId !== clientId || entry?.requestId !== requestId) continue;
    const current = await readPending(root, entry.action, entry.sessionId, entry.revision);
    if (current.path === path && current.entry !== undefined) await clearPending(root, path, current.entry);
  }
}

/** @param {any} result */
function classifyCommandResult(result) {
  if (result?.kind !== "command" || !["COMPLETED", "DELIVERY_UNKNOWN", "FAILED"].includes(result.status?.stage)) {
    return { code: 1, error: { code: "INVALID_RESPONSE", message: "Daemon returned an unexpected command result" } };
  }
  if (result?.kind === "command" && result.status?.stage === "DELIVERY_UNKNOWN") {
    return { code: 1, error: { code: "DELIVERY_UNKNOWN", message: "Delivery is ambiguous; use session resolve-delivery with the exact clientId/requestId", clientId: result.status.clientId, requestId: result.status.requestId }, result };
  }
  if (result?.kind === "command" && result.status?.stage === "FAILED") {
    return { code: 1, error: result.status.error ?? { code: "COMMAND_FAILED", message: "Command failed" }, result };
  }
  return { code: 0, result };
}

/** Run an exact-ID session command. */
export async function runSessionCommand(argv, options = {}) {
  const parsed = parse(argv);
  if ("error" in parsed) return { code: 2, error: { code: "INVALID_SYNTAX", message: parsed.error } };
  const root = options.root ?? runtimeRoot(options.env);

  if (parsed.command === "resolve-delivery") {
    const clientId = await loadCliClientIdentity({ root, randomId: options.randomId });
    const request = options.request ?? createDaemonRequester({ root, clientId, timeoutMs: options.timeoutMs });
    const result = await request("resolve_delivery", { targetClientId: parsed.targetClientId, targetRequestId: parsed.targetRequestId, resolution: parsed.resolution });
    if (result?.kind !== "command") return { code: 1, error: { code: "INVALID_RESPONSE", message: "Daemon returned the wrong resolution result" } };
    if (parsed.resolution === "abandon" || result.status?.stage === "COMPLETED" || result.status?.stage === "FAILED") await clearPendingIdentity(root, parsed.targetClientId, parsed.targetRequestId);
    return { code: 0, result };
  }

  if (parsed.command === "status") {
    const clientId = options.request === undefined ? await loadCliClientIdentity({ root, randomId: options.randomId }) : undefined;
    const request = options.request ?? createDaemonRequester({ root, clientId, timeoutMs: options.timeoutMs });
    const state = await request("get_state", {});
    const session = state?.sessions?.find((candidate) => candidate.sessionId === parsed.sessionId);
    return session === undefined
      ? { code: 1, error: { code: "SESSION_NOT_FOUND", message: `Unknown exact session ID: ${parsed.sessionId}` } }
      : { code: 0, result: { kind: "session_status", session } };
  }

  if (parsed.command === "stop" || parsed.command === "delete") {
    const clientId = await loadCliClientIdentity({ root, randomId: options.randomId });
    const request = options.request ?? createDaemonRequester({ root, clientId, timeoutMs: options.timeoutMs });
    const existing = await readPending(root, parsed.command, parsed.sessionId, parsed.revision);
    const pending = existing.entry === undefined
      ? await putPending(root, { action: parsed.command, sessionId: parsed.sessionId, revision: parsed.revision, clientId, requestId: randomUUID() })
      : existing;
    try {
      const result = await request(parsed.command, { sessionId: parsed.sessionId, revision: parsed.revision }, pending.entry.requestId);
      if (result?.kind === "command" && ["COMPLETED", "FAILED"].includes(result.status?.stage)) await clearPending(root, pending.path, pending.entry);
      return classifyCommandResult(result);
    } catch (error) {
      if (error?.code === "DELIVERY_UNKNOWN") return { code: 1, error: { code: "DELIVERY_UNKNOWN", message: error.message, clientId: pending.entry.clientId, requestId: pending.entry.requestId } };
      throw error;
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
