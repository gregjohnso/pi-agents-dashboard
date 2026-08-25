export type TaskState = "WORKING" | "WAITING" | "READY" | "FAILED" | "STOPPED";
export type ProcessState = "LIVE" | "SLEEPING" | "EXITED" | "STALE";
export type Outcome = "NONE" | "COMPLETED" | "READY_FOR_REVIEW";
export type AttachmentRole = "composer" | "observer";
export type DeliveryResolution = "retry_at_risk" | "abandon";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ProcessIdentity {
  pid: number;
  startIdentity: string;
  processGroupId: number;
}

export interface WorkerOwnership {
  kind: "managed";
  runId: string;
  process: ProcessIdentity;
  acquiredAt: string;
  heartbeatAt: string;
}

export type IsolationRecord =
  | { mode: "worktree"; worktreePath: string; branch: string }
  | { mode: "shared_directory"; canonicalCwd: string };

export interface SessionRecord {
  schemaVersion: 1;
  revision: number;
  sessionId: string;
  sessionFile: string;
  canonicalSessionFile: string;
  cwd: string;
  name?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  taskState: TaskState;
  processState: ProcessState;
  outcome: Outcome;
  activity: { kind: string; summary: string; updatedAt: string };
  ownership?: WorkerOwnership;
  isolation?: IsolationRecord;
  latestRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export type LaunchIsolation =
  | { mode: "worktree" }
  | { mode: "shared_directory"; confirmedCwd: string };

export interface LaunchRequest {
  prompt: string;
  cwd: string;
  sourceSessionId: string;
  isolation: LaunchIsolation;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  name?: string;
}

export interface EventCursor {
  daemonEpoch: string;
  sequence: string;
}

export type CommandStage =
  | "ACCEPTED"
  | "DELIVERY_ATTEMPTED"
  | "WORKER_ACKNOWLEDGED"
  | "COMPLETED"
  | "DELIVERY_UNKNOWN"
  | "FAILED";

export interface DashboardError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CommandStatus {
  clientId: string;
  requestId: string;
  operation: ClientRequest["op"];
  stage: CommandStage;
  acceptedAt: string;
  updatedAt: string;
  error?: DashboardError;
}

type RequestEnvelope<Operation extends string, Payload> = {
  version: 1;
  clientId: string;
  requestId: string;
  op: Operation;
  payload: Payload;
};

type EmptyPayload = Record<string, never>;
type SessionPayload = { sessionId: string };
type DestructiveSessionPayload = { sessionId: string; revision: number };
type TextPayload = { sessionId: string; text: string };

export type ClientRequest =
  | RequestEnvelope<"get_state", EmptyPayload>
  | RequestEnvelope<"launch", LaunchRequest>
  | RequestEnvelope<"attach", { sessionId: string; role: AttachmentRole }>
  | RequestEnvelope<"detach", SessionPayload>
  | RequestEnvelope<"prompt", TextPayload>
  | RequestEnvelope<"steer", TextPayload>
  | RequestEnvelope<"follow_up", TextPayload>
  | RequestEnvelope<"interrupt", SessionPayload>
  | RequestEnvelope<"stop", DestructiveSessionPayload>
  | RequestEnvelope<"delete", DestructiveSessionPayload>
  | RequestEnvelope<
      "ui_response",
      { sessionId: string; uiRequestId: string; response: JsonValue }
    >
  | RequestEnvelope<"subscribe", { after?: EventCursor }>
  | RequestEnvelope<"ack", { cursor: EventCursor }>
  | RequestEnvelope<
      "resolve_delivery",
      {
        targetClientId: string;
        targetRequestId: string;
        resolution: DeliveryResolution;
      }
    >;

export type DaemonResponse =
  | {
      version: 1;
      requestId: string;
      ok: true;
      result:
        | { kind: "state"; sessions: readonly SessionRecord[] }
        | { kind: "launched"; sessionId: string }
        | { kind: "attached"; sessionId: string; role: AttachmentRole }
        | { kind: "detached"; sessionId: string }
        | { kind: "command"; status: CommandStatus }
        | { kind: "subscribed"; cursor: EventCursor }
        | { kind: "acknowledged"; cursor: EventCursor };
    }
  | { version: 1; requestId: string; ok: false; error: DashboardError };

interface PersistedEventEnvelope<Kind extends string, Payload> {
  version: 1;
  cursor: EventCursor;
  occurredAt: string;
  kind: Kind;
  payload: Payload;
}

export type PersistedEvent =
  | PersistedEventEnvelope<"session_changed", { session: SessionRecord }>
  | PersistedEventEnvelope<"command_changed", { status: CommandStatus }>
  | PersistedEventEnvelope<
      "attachment_changed",
      { sessionId: string; clientId: string; role: AttachmentRole; attached: boolean }
    >;

type UnknownRecord = Record<string, unknown>;

const ENVELOPE_KEYS = ["version", "clientId", "requestId", "op", "payload"];
const OPERATIONS = [
  "get_state",
  "launch",
  "attach",
  "detach",
  "prompt",
  "steer",
  "follow_up",
  "interrupt",
  "stop",
  "delete",
  "ui_response",
  "subscribe",
  "ack",
  "resolve_delivery",
] as const;

function readRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value as UnknownRecord;
}

function rejectUnknownKeys(record: UnknownRecord, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new TypeError(`Unknown ${path} field: ${unknown}`);
  }
}

function readIdentifier(record: UnknownRecord, key: string, path = key): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${path} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function readText(record: UnknownRecord, key: string, path = key): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function readEnum<const Values extends readonly string[]>(
  record: UnknownRecord,
  key: string,
  values: Values,
  path = key,
): Values[number] {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${path} must be one of: ${values.join(", ")}`);
  }
  return value as Values[number];
}

function readCursor(value: unknown, path: string): EventCursor {
  const cursor = readRecord(value, path);
  rejectUnknownKeys(cursor, ["daemonEpoch", "sequence"], path);
  return {
    daemonEpoch: readIdentifier(cursor, "daemonEpoch", `${path}.daemonEpoch`),
    sequence: readIdentifier(cursor, "sequence", `${path}.sequence`),
  };
}

function readJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => readJsonValue(entry, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const record = readRecord(value, path);
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, readJsonValue(entry, `${path}.${key}`)]),
    );
  }
  throw new TypeError(`${path} must be a JSON value`);
}

function readLaunchRequest(value: unknown): LaunchRequest {
  const launch = readRecord(value, "launch payload");
  rejectUnknownKeys(
    launch,
    ["prompt", "cwd", "sourceSessionId", "isolation", "model", "thinkingLevel", "name"],
    "launch payload",
  );

  const isolation = readRecord(launch.isolation, "launch payload.isolation");
  const mode = readEnum(
    isolation,
    "mode",
    ["worktree", "shared_directory"] as const,
    "launch payload.isolation.mode",
  );
  let parsedIsolation: LaunchIsolation;
  if (mode === "worktree") {
    rejectUnknownKeys(isolation, ["mode"], "launch payload.isolation");
    parsedIsolation = { mode };
  } else {
    rejectUnknownKeys(isolation, ["mode", "confirmedCwd"], "launch payload.isolation");
    parsedIsolation = {
      mode,
      confirmedCwd: readIdentifier(
        isolation,
        "confirmedCwd",
        "launch payload.isolation.confirmedCwd",
      ),
    };
  }

  const parsed: LaunchRequest = {
    prompt: readText(launch, "prompt", "launch payload.prompt"),
    cwd: readIdentifier(launch, "cwd", "launch payload.cwd"),
    sourceSessionId: readIdentifier(
      launch,
      "sourceSessionId",
      "launch payload.sourceSessionId",
    ),
    isolation: parsedIsolation,
  };

  if (Object.hasOwn(launch, "model")) {
    const model = readRecord(launch.model, "launch payload.model");
    rejectUnknownKeys(model, ["provider", "id"], "launch payload.model");
    parsed.model = {
      provider: readIdentifier(model, "provider", "launch payload.model.provider"),
      id: readIdentifier(model, "id", "launch payload.model.id"),
    };
  }
  if (Object.hasOwn(launch, "thinkingLevel")) {
    parsed.thinkingLevel = readIdentifier(
      launch,
      "thinkingLevel",
      "launch payload.thinkingLevel",
    );
  }
  if (Object.hasOwn(launch, "name")) {
    parsed.name = readText(launch, "name", "launch payload.name");
  }
  return parsed;
}

function readEmptyPayload(value: unknown, operation: string): EmptyPayload {
  const payload = readRecord(value, `${operation} payload`);
  rejectUnknownKeys(payload, [], `${operation} payload`);
  return {};
}

function readSessionPayload(value: unknown, operation: string): SessionPayload {
  const payload = readRecord(value, `${operation} payload`);
  rejectUnknownKeys(payload, ["sessionId"], `${operation} payload`);
  return { sessionId: readIdentifier(payload, "sessionId", `${operation} payload.sessionId`) };
}

function readDestructiveSessionPayload(value: unknown, operation: string): DestructiveSessionPayload {
  const payload = readRecord(value, `${operation} payload`);
  rejectUnknownKeys(payload, ["sessionId", "revision"], `${operation} payload`);
  if (!Object.hasOwn(payload, "revision")) {
    const error = new TypeError(`${operation} payload.revision is required`);
    Object.assign(error, { code: "REVISION_REQUIRED" });
    throw error;
  }
  if (!Number.isSafeInteger(payload.revision) || (payload.revision as number) < 0) {
    throw new TypeError(`${operation} payload.revision must be a non-negative safe integer`);
  }
  return {
    sessionId: readIdentifier(payload, "sessionId", `${operation} payload.sessionId`),
    revision: payload.revision as number,
  };
}

function readTextPayload(value: unknown, operation: string): TextPayload {
  const payload = readRecord(value, `${operation} payload`);
  rejectUnknownKeys(payload, ["sessionId", "text"], `${operation} payload`);
  return {
    sessionId: readIdentifier(payload, "sessionId", `${operation} payload.sessionId`),
    text: readText(payload, "text", `${operation} payload.text`),
  };
}

/** Parse one fail-closed client request from an untrusted JSON value. */
export function parseClientRequest(value: unknown): ClientRequest {
  const request = readRecord(value, "Client request");
  rejectUnknownKeys(request, ENVELOPE_KEYS, "client request");
  if (request.version !== 1) {
    throw new TypeError("version must be 1");
  }
  const clientId = readIdentifier(request, "clientId");
  const requestId = readIdentifier(request, "requestId");
  const op = readEnum(request, "op", OPERATIONS, "operation");
  const base = { version: 1 as const, clientId, requestId };

  switch (op) {
    case "get_state":
      return { ...base, op, payload: readEmptyPayload(request.payload, op) };
    case "launch":
      return { ...base, op, payload: readLaunchRequest(request.payload) };
    case "attach": {
      const payload = readRecord(request.payload, "attach payload");
      rejectUnknownKeys(payload, ["sessionId", "role"], "attach payload");
      return {
        ...base,
        op,
        payload: {
          sessionId: readIdentifier(payload, "sessionId", "attach payload.sessionId"),
          role: readEnum(payload, "role", ["composer", "observer"] as const, "attach payload.role"),
        },
      };
    }
    case "detach":
    case "interrupt":
      return { ...base, op, payload: readSessionPayload(request.payload, op) };
    case "stop":
    case "delete":
      return { ...base, op, payload: readDestructiveSessionPayload(request.payload, op) };
    case "prompt":
    case "steer":
    case "follow_up":
      return { ...base, op, payload: readTextPayload(request.payload, op) };
    case "ui_response": {
      const payload = readRecord(request.payload, "ui_response payload");
      rejectUnknownKeys(
        payload,
        ["sessionId", "uiRequestId", "response"],
        "ui_response payload",
      );
      if (!Object.hasOwn(payload, "response")) {
        throw new TypeError("ui_response payload.response is required");
      }
      return {
        ...base,
        op,
        payload: {
          sessionId: readIdentifier(payload, "sessionId", "ui_response payload.sessionId"),
          uiRequestId: readIdentifier(
            payload,
            "uiRequestId",
            "ui_response payload.uiRequestId",
          ),
          response: readJsonValue(payload.response, "ui_response payload.response"),
        },
      };
    }
    case "subscribe": {
      const payload = readRecord(request.payload, "subscribe payload");
      rejectUnknownKeys(payload, ["after"], "subscribe payload");
      return Object.hasOwn(payload, "after")
        ? { ...base, op, payload: { after: readCursor(payload.after, "subscribe payload.after") } }
        : { ...base, op, payload: {} };
    }
    case "ack": {
      const payload = readRecord(request.payload, "ack payload");
      rejectUnknownKeys(payload, ["cursor"], "ack payload");
      return { ...base, op, payload: { cursor: readCursor(payload.cursor, "ack payload.cursor") } };
    }
    case "resolve_delivery": {
      const payload = readRecord(request.payload, "resolve_delivery payload");
      rejectUnknownKeys(
        payload,
        ["targetClientId", "targetRequestId", "resolution"],
        "resolve_delivery payload",
      );
      return {
        ...base,
        op,
        payload: {
          targetClientId: readIdentifier(
            payload,
            "targetClientId",
            "resolve_delivery payload.targetClientId",
          ),
          targetRequestId: readIdentifier(
            payload,
            "targetRequestId",
            "resolve_delivery payload.targetRequestId",
          ),
          resolution: readEnum(
            payload,
            "resolution",
            ["retry_at_risk", "abandon"] as const,
            "resolve_delivery payload.resolution",
          ),
        },
      };
    }
  }
}
