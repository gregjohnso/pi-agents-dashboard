import net from "node:net";
import { randomUUID } from "node:crypto";
import { createJsonlDecoder, createJsonlEncoder } from "../../runtime/jsonl.mjs";
import type { ClientRequest, DaemonResponse, EventCursor, PersistedEvent } from "../../shared/contracts.js";

export class DaemonClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DaemonClientError";
    this.code = code;
  }
}

type Pending = {
  request: ClientRequest;
  resolve(value: DaemonResponse): void;
  reject(error: unknown): void;
  promise: Promise<DaemonResponse>;
};
type Subscriber = {
  acknowledgedAfter?: EventCursor;
  queue: PersistedEvent[];
  waiter?: (value: IteratorResult<PersistedEvent>) => void;
  error?: Error;
  ended: boolean;
};

type UnknownRecord = Record<string, unknown>;

const OPERATIONS = ["get_state", "launch", "attach", "detach", "prompt", "steer", "follow_up", "interrupt", "stop", "delete", "ui_response", "subscribe", "ack", "resolve_delivery"] as const;
const COMMAND_STAGES = ["ACCEPTED", "DELIVERY_ATTEMPTED", "WORKER_ACKNOWLEDGED", "COMPLETED", "DELIVERY_UNKNOWN", "FAILED"] as const;

function readRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
  return value as UnknownRecord;
}

function requireKeys(record: UnknownRecord, required: readonly string[], optional: readonly string[], path: string): void {
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${path}.${key} is required`);
  }
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new TypeError(`Unknown ${path} field: ${unknown}`);
}

function readString(record: UnknownRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path}.${key} must be a non-empty string`);
  return value;
}

function readEnum<const Values extends readonly string[]>(record: UnknownRecord, key: string, values: Values, path: string): Values[number] {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${path}.${key} is invalid`);
  return value as Values[number];
}

function validateCursor(value: unknown, path: string): void {
  const cursor = readRecord(value, path);
  requireKeys(cursor, ["daemonEpoch", "sequence"], [], path);
  readString(cursor, "daemonEpoch", path);
  const sequence = readString(cursor, "sequence", path);
  if (!/^(0|[1-9]\d*)$/.test(sequence)) throw new TypeError(`${path}.sequence must be a canonical unsigned integer string`);
}

function validateDashboardError(value: unknown, path: string): void {
  const error = readRecord(value, path);
  requireKeys(error, ["code", "message", "retryable"], [], path);
  readString(error, "code", path);
  if (typeof error.message !== "string") throw new TypeError(`${path}.message must be a string`);
  if (typeof error.retryable !== "boolean") throw new TypeError(`${path}.retryable must be a boolean`);
}

function validateProcessIdentity(value: unknown, path: string): void {
  const process = readRecord(value, path);
  requireKeys(process, ["pid", "startIdentity", "processGroupId"], [], path);
  if (!Number.isSafeInteger(process.pid) || !Number.isSafeInteger(process.processGroupId)) throw new TypeError(`${path} process IDs must be safe integers`);
  readString(process, "startIdentity", path);
}

function validateSession(value: unknown, path: string): void {
  const session = readRecord(value, path);
  requireKeys(session, ["schemaVersion", "revision", "sessionId", "sessionFile", "canonicalSessionFile", "cwd", "taskState", "processState", "outcome", "activity", "createdAt", "updatedAt"], ["name", "model", "thinkingLevel", "ownership", "isolation", "latestRunId"], path);
  if (session.schemaVersion !== 1 || !Number.isSafeInteger(session.revision)) throw new TypeError(`${path} schema version or revision is invalid`);
  for (const key of ["sessionId", "sessionFile", "canonicalSessionFile", "cwd", "createdAt", "updatedAt"] as const) readString(session, key, path);
  readEnum(session, "taskState", ["WORKING", "WAITING", "READY", "FAILED", "STOPPED"] as const, path);
  readEnum(session, "processState", ["LIVE", "SLEEPING", "EXITED", "STALE"] as const, path);
  readEnum(session, "outcome", ["NONE", "COMPLETED", "READY_FOR_REVIEW"] as const, path);
  const activity = readRecord(session.activity, `${path}.activity`);
  requireKeys(activity, ["kind", "summary", "updatedAt"], [], `${path}.activity`);
  readString(activity, "kind", `${path}.activity`);
  if (typeof activity.summary !== "string") throw new TypeError(`${path}.activity.summary must be a string`);
  readString(activity, "updatedAt", `${path}.activity`);
  for (const key of ["name", "thinkingLevel", "latestRunId"] as const) {
    if (Object.hasOwn(session, key)) readString(session, key, path);
  }
  if (Object.hasOwn(session, "model")) {
    const model = readRecord(session.model, `${path}.model`);
    requireKeys(model, ["provider", "id"], [], `${path}.model`);
    readString(model, "provider", `${path}.model`);
    readString(model, "id", `${path}.model`);
  }
  if (Object.hasOwn(session, "ownership")) {
    const ownership = readRecord(session.ownership, `${path}.ownership`);
    requireKeys(ownership, ["kind", "runId", "process", "acquiredAt", "heartbeatAt"], [], `${path}.ownership`);
    if (ownership.kind !== "managed") throw new TypeError(`${path}.ownership.kind is invalid`);
    readString(ownership, "runId", `${path}.ownership`);
    validateProcessIdentity(ownership.process, `${path}.ownership.process`);
    readString(ownership, "acquiredAt", `${path}.ownership`);
    readString(ownership, "heartbeatAt", `${path}.ownership`);
  }
  if (Object.hasOwn(session, "isolation")) {
    const isolation = readRecord(session.isolation, `${path}.isolation`);
    const mode = readEnum(isolation, "mode", ["worktree", "shared_directory"] as const, `${path}.isolation`);
    if (mode === "worktree") {
      requireKeys(isolation, ["mode", "worktreePath", "branch"], [], `${path}.isolation`);
      readString(isolation, "worktreePath", `${path}.isolation`);
      readString(isolation, "branch", `${path}.isolation`);
    } else {
      requireKeys(isolation, ["mode", "canonicalCwd"], [], `${path}.isolation`);
      readString(isolation, "canonicalCwd", `${path}.isolation`);
    }
  }
}

function validateCommandStatus(value: unknown, path: string): void {
  const status = readRecord(value, path);
  requireKeys(status, ["clientId", "requestId", "operation", "stage", "acceptedAt", "updatedAt"], ["error"], path);
  readString(status, "clientId", path);
  readString(status, "requestId", path);
  readEnum(status, "operation", OPERATIONS, path);
  readEnum(status, "stage", COMMAND_STAGES, path);
  readString(status, "acceptedAt", path);
  readString(status, "updatedAt", path);
  if (Object.hasOwn(status, "error")) validateDashboardError(status.error, `${path}.error`);
}

function parseDaemonResponse(value: unknown): DaemonResponse {
  const response = readRecord(value, "Daemon response");
  if (response.version !== 1 || typeof response.requestId !== "string" || response.requestId.length === 0 || typeof response.ok !== "boolean") throw new TypeError("Daemon response envelope is invalid");
  if (!response.ok) {
    requireKeys(response, ["version", "requestId", "ok", "error"], [], "daemon response");
    validateDashboardError(response.error, "daemon response.error");
    return value as DaemonResponse;
  }
  requireKeys(response, ["version", "requestId", "ok", "result"], [], "daemon response");
  const result = readRecord(response.result, "daemon response.result");
  const kind = readEnum(result, "kind", ["state", "launched", "attached", "detached", "command", "subscribed", "acknowledged"] as const, "daemon response.result");
  switch (kind) {
    case "state":
      requireKeys(result, ["kind", "sessions"], [], "daemon response.result");
      if (!Array.isArray(result.sessions)) throw new TypeError("daemon response.result.sessions must be an array");
      result.sessions.forEach((session, index) => validateSession(session, `daemon response.result.sessions[${index}]`));
      break;
    case "launched":
    case "detached":
      requireKeys(result, ["kind", "sessionId"], [], "daemon response.result");
      readString(result, "sessionId", "daemon response.result");
      break;
    case "attached":
      requireKeys(result, ["kind", "sessionId", "role"], [], "daemon response.result");
      readString(result, "sessionId", "daemon response.result");
      readEnum(result, "role", ["composer", "observer"] as const, "daemon response.result");
      break;
    case "command":
      requireKeys(result, ["kind", "status"], [], "daemon response.result");
      validateCommandStatus(result.status, "daemon response.result.status");
      break;
    case "subscribed":
    case "acknowledged":
      requireKeys(result, ["kind", "cursor"], [], "daemon response.result");
      validateCursor(result.cursor, "daemon response.result.cursor");
      break;
  }
  return value as DaemonResponse;
}

function parsePersistedEvent(value: unknown): PersistedEvent {
  const event = readRecord(value, "Persisted event");
  requireKeys(event, ["version", "cursor", "occurredAt", "kind", "payload"], [], "persisted event");
  if (event.version !== 1) throw new TypeError("Persisted event version must be 1");
  validateCursor(event.cursor, "persisted event.cursor");
  readString(event, "occurredAt", "persisted event");
  const kind = readEnum(event, "kind", ["session_changed", "session_deleted", "command_changed", "attachment_changed"] as const, "persisted event");
  const payload = readRecord(event.payload, "persisted event.payload");
  if (kind === "session_changed") {
    requireKeys(payload, ["session"], [], "persisted event.payload");
    validateSession(payload.session, "persisted event.payload.session");
  } else if (kind === "session_deleted") {
    requireKeys(payload, ["sessionId", "revision"], [], "persisted event.payload");
    readString(payload, "sessionId", "persisted event.payload");
    if (!Number.isSafeInteger(payload.revision) || (payload.revision as number) < 0) throw new TypeError("persisted event.payload.revision must be a non-negative integer");
  } else if (kind === "command_changed") {
    requireKeys(payload, ["status"], [], "persisted event.payload");
    validateCommandStatus(payload.status, "persisted event.payload.status");
  } else {
    requireKeys(payload, ["sessionId", "clientId", "role", "attached"], [], "persisted event.payload");
    readString(payload, "sessionId", "persisted event.payload");
    readString(payload, "clientId", "persisted event.payload");
    readEnum(payload, "role", ["composer", "observer"] as const, "persisted event.payload");
    if (typeof payload.attached !== "boolean") throw new TypeError("persisted event.payload.attached must be a boolean");
  }
  return value as PersistedEvent;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function laterCursor(current: EventCursor | undefined, candidate: EventCursor): EventCursor {
  if (current === undefined || current.daemonEpoch !== candidate.daemonEpoch) return candidate;
  if (!/^(0|[1-9]\d*)$/.test(current.sequence) || !/^(0|[1-9]\d*)$/.test(candidate.sequence)) return candidate;
  return BigInt(candidate.sequence) >= BigInt(current.sequence) ? candidate : current;
}

export interface DaemonClient {
  connect(): Promise<void>;
  request(request: ClientRequest): Promise<DaemonResponse>;
  subscribe(after?: EventCursor): AsyncIterable<PersistedEvent>;
  onFatalError?(listener: (error: DaemonClientError) => void): () => void;
  close(): Promise<void>;
}

export type DaemonClientOptions = {
  socketPath: string;
  token: string;
  maxBytes: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  clientId: string;
  subscriberLimit?: number;
};

/** Create a bounded JSONL daemon client that reconnects until explicitly closed. */
export function createDaemonClient({
  socketPath,
  token,
  maxBytes,
  reconnectDelayMs = 50,
  maxReconnectDelayMs = 1_000,
  clientId,
  subscriberLimit = 100,
}: DaemonClientOptions): DaemonClient {
  if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 0) throw new TypeError("reconnectDelayMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(maxReconnectDelayMs) || maxReconnectDelayMs < reconnectDelayMs) throw new TypeError("maxReconnectDelayMs must be at least reconnectDelayMs");
  if (!Number.isSafeInteger(subscriberLimit) || subscriberLimit < 1) throw new TypeError("subscriberLimit must be a positive safe integer");
  if (typeof clientId !== "string" || clientId.length === 0) throw new TypeError("clientId is required");

  const encoder = createJsonlEncoder({ maxBytes });
  const pending = new Map<string, Pending>();
  const seen = new Map<string, { canonical: string; response?: DaemonResponse }>();
  const subscribers = new Set<Subscriber>();
  const fatalErrorListeners = new Set<(error: DaemonClientError) => void>();
  const wakeDelays = new Set<() => void>();
  let socket: net.Socket | undefined;
  let reconnectLoop: Promise<void> | undefined;
  let closed = false;
  let authenticated = false;

  const hasWork = () => pending.size > 0 || subscribers.size > 0;
  const reportFatalFrame = (error: unknown, fallbackCode: string) => {
    const typed = error as { code?: string; message?: string };
    const reported = error instanceof DaemonClientError
      ? error
      : new DaemonClientError(typed.code ?? fallbackCode, typed.message ?? fallbackCode);
    for (const listener of fatalErrorListeners) listener(reported);
  };
  const send = (value: unknown) => {
    if (socket === undefined || !authenticated || socket.destroyed) throw new DaemonClientError("NOT_CONNECTED", "Daemon is not connected");
    socket.write(encoder.encode(value));
  };
  const sendSubscriptions = () => {
    for (const subscriber of subscribers) {
      send({ version: 1, clientId, requestId: randomUUID(), op: "subscribe", payload: subscriber.acknowledgedAfter === undefined ? {} : { after: subscriber.acknowledgedAfter } });
    }
  };
  const dispatchEvent = (event: PersistedEvent) => {
    for (const subscriber of subscribers) {
      if (subscriber.ended) continue;
      if (subscriber.waiter !== undefined) {
        const waiter = subscriber.waiter;
        subscriber.waiter = undefined;
        waiter({ value: event, done: false });
      } else if (subscriber.queue.length >= subscriberLimit) {
        subscriber.error = new DaemonClientError("SUBSCRIBER_OVERFLOW", "Client subscriber exceeded its bounded queue");
        subscriber.ended = true;
        subscribers.delete(subscriber);
      } else {
        subscriber.queue.push(event);
      }
    }
  };
  const applyAcknowledgement = (cursor: EventCursor) => {
    for (const subscriber of subscribers) subscriber.acknowledgedAfter = laterCursor(subscriber.acknowledgedAfter, cursor);
  };
  const waitForRetry = (milliseconds: number) => new Promise<void>((resolve) => {
    if (closed || milliseconds === 0) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      clearTimeout(timer);
      wakeDelays.delete(wake);
      resolve();
    };
    timer = setTimeout(wake, milliseconds);
    wakeDelays.add(wake);
  });

  const attemptConnection = () => new Promise<void>((resolve, reject) => {
    if (closed) {
      reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
      return;
    }
    const candidate = net.createConnection(socketPath);
    socket = candidate;
    authenticated = false;
    const decoder = createJsonlDecoder({ maxBytes });
    let settled = false;
    const failAttempt = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    candidate.on("connect", () => {
      try {
        candidate.write(encoder.encode({ version: 1, token }));
      } catch (error) {
        failAttempt(error);
        candidate.destroy();
      }
    });
    candidate.on("data", (chunk) => {
      try {
        const records = decoder.push(chunk);
        for (const record of records) {
          if (!authenticated) {
            if (typeof record === "object" && record !== null && (record as { kind?: unknown }).kind === "authenticated" && (record as { version?: unknown }).version === 1) {
              authenticated = true;
              for (const item of pending.values()) send(item.request);
              sendSubscriptions();
              if (!settled) {
                settled = true;
                resolve();
              }
            } else {
              const error = new DaemonClientError("AUTHENTICATION_FAILED", "Daemon rejected authentication");
              reportFatalFrame(error, "AUTHENTICATION_FAILED");
              failAttempt(error);
              candidate.destroy();
            }
            continue;
          }
          if (typeof record === "object" && record !== null && Object.hasOwn(record, "requestId")) {
            const response = parseDaemonResponse(record);
            const item = pending.get(response.requestId);
            if (item === undefined) continue;
            pending.delete(response.requestId);
            const entry = seen.get(response.requestId);
            if (entry !== undefined) entry.response = response;
            if (item.request.op === "ack" && response.ok && response.result.kind === "acknowledged") applyAcknowledgement(response.result.cursor);
            item.resolve(response);
          } else {
            dispatchEvent(parsePersistedEvent(record));
          }
        }
      } catch (error) {
        reportFatalFrame(error, "MALFORMED_FRAME");
        failAttempt(error);
        candidate.destroy();
      }
    });
    candidate.on("error", failAttempt);
    candidate.on("close", () => {
      if (socket === candidate) {
        socket = undefined;
        authenticated = false;
      }
      failAttempt(new DaemonClientError("CONNECTION_CLOSED", "Daemon connection closed"));
      if (!closed && hasWork()) void startReconnectLoop().catch(() => {});
    });
  });

  function startReconnectLoop(): Promise<void> {
    if (closed) return Promise.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
    if (socket !== undefined && authenticated && !socket.destroyed) return Promise.resolve();
    if (reconnectLoop !== undefined) return reconnectLoop;
    reconnectLoop = (async () => {
      let retryDelay = reconnectDelayMs;
      while (!closed) {
        try {
          await attemptConnection();
          return;
        } catch {
          if (closed) break;
          await waitForRetry(retryDelay);
          retryDelay = Math.min(maxReconnectDelayMs, Math.max(reconnectDelayMs, retryDelay === 0 ? 1 : retryDelay * 2));
        }
      }
      throw new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed");
    })().finally(() => {
      reconnectLoop = undefined;
    });
    return reconnectLoop;
  }

  return {
    connect: startReconnectLoop,
    request(request) {
      if (closed) return Promise.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
      if (request.clientId !== clientId) return Promise.reject(new DaemonClientError("CLIENT_ID_MISMATCH", "Request clientId does not match the configured daemon client identity"));
      const serialized = canonical(request);
      const previous = seen.get(request.requestId);
      if (previous !== undefined && previous.canonical !== serialized) return Promise.reject(new DaemonClientError("IDEMPOTENCY_CONFLICT", "Request IDs were reused with changed content"));
      if (previous?.response !== undefined) return Promise.resolve(previous.response);
      const existing = pending.get(request.requestId);
      if (existing !== undefined) return existing.promise;
      let resolve!: (value: DaemonResponse) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<DaemonResponse>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      pending.set(request.requestId, { request, resolve, reject, promise });
      seen.set(request.requestId, { canonical: serialized });
      if (socket !== undefined && authenticated && !socket.destroyed) send(request);
      else void startReconnectLoop().catch(() => {});
      return promise;
    },
    subscribe(after) {
      const subscriber: Subscriber = { acknowledgedAfter: after, queue: [], ended: closed };
      if (!closed) {
        subscribers.add(subscriber);
        if (socket !== undefined && authenticated && !socket.destroyed) {
          send({ version: 1, clientId, requestId: randomUUID(), op: "subscribe", payload: after === undefined ? {} : { after } });
        } else {
          void startReconnectLoop().catch(() => {});
        }
      }
      const iterable: AsyncIterableIterator<PersistedEvent> = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (subscriber.error !== undefined) throw subscriber.error;
          const event = subscriber.queue.shift();
          if (event !== undefined) return { value: event, done: false };
          if (subscriber.ended) return { value: undefined, done: true };
          return new Promise<IteratorResult<PersistedEvent>>((resolve) => { subscriber.waiter = resolve; });
        },
        async return() {
          subscriber.ended = true;
          subscribers.delete(subscriber);
          subscriber.waiter?.({ value: undefined, done: true });
          subscriber.waiter = undefined;
          return { value: undefined, done: true };
        },
      };
      return iterable;
    },
    onFatalError(listener) {
      fatalErrorListeners.add(listener);
      return () => fatalErrorListeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const wake of wakeDelays) wake();
      for (const item of pending.values()) item.reject(new DaemonClientError("CLIENT_CLOSED", "Daemon client is closed"));
      pending.clear();
      for (const subscriber of subscribers) {
        subscriber.ended = true;
        subscriber.waiter?.({ value: undefined, done: true });
        subscriber.waiter = undefined;
      }
      subscribers.clear();
      fatalErrorListeners.clear();
      if (socket !== undefined && !socket.destroyed) {
        await new Promise<void>((resolve) => {
          socket!.once("close", resolve);
          socket!.destroy();
        });
      }
    },
  };
}
