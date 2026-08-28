import { parseViewerSnapshot } from "./viewer-contracts.mjs";

/** @typedef {"WORKING" | "WAITING" | "READY" | "FAILED" | "STOPPED"} TaskState */
/** @typedef {"LIVE" | "SLEEPING" | "EXITED" | "STALE"} ProcessState */
/** @typedef {"NONE" | "COMPLETED" | "READY_FOR_REVIEW"} Outcome */
/** @typedef {"composer" | "observer"} AttachmentRole */
/** @typedef {"retry_at_risk" | "abandon"} DeliveryResolution */
/** @typedef {null | boolean | number | string | any[] | {[key: string]: any}} JsonValue */
/** @typedef {{pid:number,startIdentity:string,processGroupId:number}} ProcessIdentity */
/** @typedef {{realpath:string,device:string,inode:string,size:number,modifiedTimeNs:string}} ExecutableIdentity */
/** @typedef {{executable:ExecutableIdentity,reportedVersion:string|null,rpcMode:boolean,jsonl:boolean,commands:readonly ("get_state"|"prompt"|"follow_up"|"steer"|"abort"|"extension_ui_response")[],events:readonly string[],missingRequired:readonly string[]}} PiCapabilityReport */
/** @typedef {{executable:ExecutableIdentity,piVersion:string|null,capabilities:PiCapabilityReport,rpcAdapterVersion:1,viewerProtocolVersion:1,supervisor:ProcessIdentity,piChild:ProcessIdentity}} RunRuntimeIdentity */
/** @typedef {{kind:"managed",runId:string,process:ProcessIdentity,acquiredAt:string,heartbeatAt:string}} WorkerOwnership */
/** @typedef {{mode:"worktree",worktreePath:string,branch:string}|{mode:"shared_directory",canonicalCwd:string}} IsolationRecord */
/** @typedef {{text:string,generatedAt:string,model:{provider:string,id:string},sourceCursor:string}} SessionSummary */
/** @typedef {{schemaVersion:1,revision:number,sessionId:string,sessionFile:string,canonicalSessionFile:string,cwd:string,name?:string,nameGenerated?:boolean,color?:SessionColor,model?:{provider:string,id:string},thinkingLevel?:string,taskState:TaskState,processState:ProcessState,outcome:Outcome,activity:{kind:string,summary:string,updatedAt:string},ownership?:WorkerOwnership,isolation?:IsolationRecord,latestRunId?:string,runtime?:RunRuntimeIdentity,summary?:SessionSummary,createdAt:string,updatedAt:string}} SessionRecord */
/** @typedef {{mode:"worktree"}|{mode:"shared_directory",confirmedCwd:string,ownerSessionIds:string[]}} LaunchIsolation */
/** @typedef {{prompt:string,cwd:string,sourceSessionId:string,isolation:LaunchIsolation,model?:{provider:string,id:string},thinkingLevel?:string,name?:string}} LaunchRequest */
/** @typedef {{daemonEpoch:string,sequence:string}} EventCursor */
/** @typedef {{daemonEpoch:string,sessionId:string,sequence:string}} ViewerCursor */
/** @typedef {"ACCEPTED"|"DELIVERY_ATTEMPTED"|"WORKER_ACKNOWLEDGED"|"COMPLETED"|"DELIVERY_UNKNOWN"|"FAILED"} CommandStage */
/** @typedef {{code:string,message:string,retryable:boolean}} DashboardError */
/** @typedef {{clientId:string,requestId:string,operation:string,stage:CommandStage,acceptedAt:string,updatedAt:string,error?:DashboardError}} CommandStatus */
/** @typedef {{version:number,clientId:string,requestId:string,op:string,payload:any}} ClientRequest */
/** @typedef {any} DaemonResponse */
/** @typedef {{version:1,cursor:EventCursor,occurredAt:string,kind:"session_changed"|"command_changed"|"attachment_changed",payload:any}} PersistedEvent */

const ENVELOPE_KEYS = ["version", "clientId", "requestId", "op", "payload"];
/** Operator-chosen row tints, named for the Jobwatch palette. Dashboard metadata; Pi never sees them. */
export const SESSION_COLORS = ["sky", "green", "amber", "rose", "cyan", "gray"];
/** @typedef {"sky"|"green"|"amber"|"rose"|"cyan"|"gray"} SessionColor */

const OPERATIONS = ["get_state", "launch", "attach", "detach", "prompt", "steer", "follow_up", "interrupt", "stop", "delete", "ui_response", "subscribe", "ack", "get_viewer_snapshot", "subscribe_viewer", "ack_viewer", "resolve_delivery", "get_session_commands", "session_command", "session_query", "get_settings", "set_settings", "refresh_summaries", "set_session_color", "get_models"];
const COMMAND_STAGES = ["ACCEPTED", "DELIVERY_ATTEMPTED", "WORKER_ACKNOWLEDGED", "COMPLETED", "DELIVERY_UNKNOWN", "FAILED"];
const SESSION_COMMANDS = ["set_model", "set_thinking_level", "compact", "set_session_name", "set_auto_compaction", "set_auto_retry", "abort_retry", "set_steering_mode", "set_follow_up_mode"];
// Pi's own vocabulary for both queue modes; anything else is refused before it reaches a worker.
const QUEUE_MODES = ["all", "one-at-a-time"];
// Read-only Pi commands the dashboard may serve. Session-rebinding commands are deliberately absent.
const SESSION_QUERIES = ["get_session_stats", "get_tree", "export_html"];
const MAX_QUERY_ROWS = 500;
const MAX_MENU_ENTRIES = 1_000;

/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function readRecord(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
  return value;
}

/** @param {Record<string, any>} record @param {readonly string[]} allowed @param {string} path */
function rejectUnknownKeys(record, allowed, path) {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`Unknown ${path} field: ${unknown}`);
}

/** @param {Record<string, any>} record @param {readonly string[]} required @param {readonly string[]} optional @param {string} path */
function requireKeys(record, required, optional, path) {
  for (const key of required) if (!Object.hasOwn(record, key)) throw new TypeError(`${path}.${key} is required`);
  rejectUnknownKeys(record, [...required, ...optional], path);
}

/** @param {Record<string, any>} record @param {string} key @param {string} [path] */
function readIdentifier(record, key, path = key) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new TypeError(`${path} must be a non-empty string without surrounding whitespace`);
  return value;
}

/** @param {Record<string, any>} record @param {string} key @param {string} [path] */
function readText(record, key, path = key) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

/** @param {Record<string, any>} record @param {string} key @param {readonly string[]} values @param {string} [path] */
function readEnum(record, key, values, path = key) {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${path} must be one of: ${values.join(", ")}`);
  return value;
}

/** @param {unknown} value @param {string} path @returns {{provider:string,id:string}} */
function readModel(value, path) {
  const model = readRecord(value, path);
  requireKeys(model, ["provider", "id"], [], path);
  return { provider: readIdentifier(model, "provider", `${path}.provider`), id: readIdentifier(model, "id", `${path}.id`) };
}

/** @param {unknown} value @param {string} path */
function validateProcessIdentity(value, path) {
  const identity = readRecord(value, path);
  requireKeys(identity, ["pid", "startIdentity", "processGroupId"], [], path);
  if (!Number.isSafeInteger(identity.pid) || !Number.isSafeInteger(identity.processGroupId)) throw new TypeError(`${path} process IDs are invalid`);
  readIdentifier(identity, "startIdentity", `${path}.startIdentity`);
}

/** @param {unknown} value @param {string} path */
function validateExecutableIdentity(value, path) {
  const executable = readRecord(value, path);
  requireKeys(executable, ["realpath", "device", "inode", "size", "modifiedTimeNs"], [], path);
  for (const key of ["realpath", "device", "inode", "modifiedTimeNs"]) readIdentifier(executable, key, `${path}.${key}`);
  if (!Number.isSafeInteger(executable.size) || executable.size < 0) throw new TypeError(`${path}.size is invalid`);
}

/** @param {unknown} value @param {string} path @returns {EventCursor} */
function readCursor(value, path) {
  const cursor = readRecord(value, path);
  rejectUnknownKeys(cursor, ["daemonEpoch", "sequence"], path);
  const sequence = readIdentifier(cursor, "sequence", `${path}.sequence`);
  if (!/^(0|[1-9]\d*)$/u.test(sequence)) throw new TypeError(`${path}.sequence must be a canonical unsigned integer string`);
  return { daemonEpoch: readIdentifier(cursor, "daemonEpoch", `${path}.daemonEpoch`), sequence };
}

/** @param {unknown} value @param {string} path @returns {ViewerCursor} */
function readViewerCursor(value, path) {
  const cursor = readRecord(value, path);
  rejectUnknownKeys(cursor, ["daemonEpoch", "sessionId", "sequence"], path);
  const sequence = readIdentifier(cursor, "sequence", `${path}.sequence`);
  if (!/^(0|[1-9]\d*)$/u.test(sequence)) throw new TypeError(`${path}.sequence must be a canonical unsigned integer string`);
  return { daemonEpoch: readIdentifier(cursor, "daemonEpoch", `${path}.daemonEpoch`), sessionId: readIdentifier(cursor, "sessionId", `${path}.sessionId`), sequence };
}

/** @param {unknown} value @param {string} path @returns {JsonValue} */
function readJsonValue(value, path) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => readJsonValue(entry, `${path}[${index}]`));
  if (typeof value === "object") return Object.fromEntries(Object.entries(readRecord(value, path)).map(([key, entry]) => [key, readJsonValue(entry, `${path}.${key}`)]));
  throw new TypeError(`${path} must be a JSON value`);
}

/** @param {unknown} value @returns {LaunchRequest} */
function readLaunchRequest(value) {
  const launch = readRecord(value, "launch payload");
  rejectUnknownKeys(launch, ["prompt", "cwd", "sourceSessionId", "isolation", "model", "thinkingLevel", "name"], "launch payload");
  const isolation = readRecord(launch.isolation, "launch payload.isolation");
  const mode = readEnum(isolation, "mode", ["worktree", "shared_directory"], "launch payload.isolation.mode");
  /** @type {LaunchIsolation} */
  let parsedIsolation;
  if (mode === "worktree") {
    rejectUnknownKeys(isolation, ["mode"], "launch payload.isolation");
    parsedIsolation = { mode: "worktree" };
  } else {
    rejectUnknownKeys(isolation, ["mode", "confirmedCwd", "ownerSessionIds"], "launch payload.isolation");
    if (!Array.isArray(isolation.ownerSessionIds) || isolation.ownerSessionIds.some((/** @type {unknown} */ owner) => typeof owner !== "string" || owner.length === 0 || owner.trim() !== owner)) throw new TypeError("launch payload.isolation.ownerSessionIds must contain identifiers");
    parsedIsolation = { mode: "shared_directory", confirmedCwd: readIdentifier(isolation, "confirmedCwd", "launch payload.isolation.confirmedCwd"), ownerSessionIds: [...new Set(isolation.ownerSessionIds)].sort() };
  }
  const parsed = {
    prompt: readText(launch, "prompt", "launch payload.prompt"), cwd: readIdentifier(launch, "cwd", "launch payload.cwd"),
    sourceSessionId: readIdentifier(launch, "sourceSessionId", "launch payload.sourceSessionId"), isolation: parsedIsolation,
  };
  if (Object.hasOwn(launch, "model")) Object.assign(parsed, { model: readModel(launch.model, "launch payload.model") });
  if (Object.hasOwn(launch, "thinkingLevel")) Object.assign(parsed, { thinkingLevel: readIdentifier(launch, "thinkingLevel", "launch payload.thinkingLevel") });
  if (Object.hasOwn(launch, "name")) Object.assign(parsed, { name: readText(launch, "name", "launch payload.name") });
  return parsed;
}

/** @param {unknown} value @param {string} operation */
function readSessionPayload(value, operation) {
  const payload = readRecord(value, `${operation} payload`);
  rejectUnknownKeys(payload, ["sessionId"], `${operation} payload`);
  return { sessionId: readIdentifier(payload, "sessionId", `${operation} payload.sessionId`) };
}

/** @param {unknown} value @param {string} operation */
function readDestructivePayload(value, operation) {
  const payload = readRecord(value, `${operation} payload`);
  rejectUnknownKeys(payload, ["sessionId", "revision"], `${operation} payload`);
  if (!Object.hasOwn(payload, "revision")) throw Object.assign(new TypeError(`${operation} payload.revision is required`), { code: "REVISION_REQUIRED" });
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 0) throw new TypeError(`${operation} payload.revision must be a non-negative safe integer`);
  return { sessionId: readIdentifier(payload, "sessionId", `${operation} payload.sessionId`), revision: payload.revision };
}

/** Parse one fail-closed client request from an untrusted JSON value. @param {unknown} value @returns {ClientRequest} */
export function parseClientRequest(value) {
  const request = readRecord(value, "Client request");
  rejectUnknownKeys(request, ENVELOPE_KEYS, "client request");
  if (request.version !== 1) throw new TypeError("version must be 1");
  const clientId = readIdentifier(request, "clientId");
  const requestId = readIdentifier(request, "requestId");
  const op = readEnum(request, "op", OPERATIONS, "operation");
  const base = { version: 1, clientId, requestId, op };
  if (["get_state", "get_settings", "refresh_summaries", "get_models"].includes(op)) {
    const payload = readRecord(request.payload, `${op} payload`); rejectUnknownKeys(payload, [], `${op} payload`); return { ...base, payload: {} };
  }
  if (op === "set_settings") {
    const payload = readRecord(request.payload, "set_settings payload");
    rejectUnknownKeys(payload, ["summaryModel"], "set_settings payload");
    if (!Object.hasOwn(payload, "summaryModel")) throw new TypeError("set_settings payload.summaryModel is required");
    if (payload.summaryModel === null) return { ...base, payload: { summaryModel: null } };
    return { ...base, payload: { summaryModel: readModel(payload.summaryModel, "set_settings payload.summaryModel") } };
  }
  if (op === "set_session_color") {
    const payload = readRecord(request.payload, "set_session_color payload");
    // A color is dashboard metadata with no precondition on session state, so it carries no revision.
    // Clients built against the original version-1 shape still send one: accept it, check its shape, and drop it.
    rejectUnknownKeys(payload, ["sessionId", "revision", "color"], "set_session_color payload");
    if (Object.hasOwn(payload, "revision") && (!Number.isSafeInteger(payload.revision) || payload.revision < 0)) throw new TypeError("set_session_color payload.revision must be a non-negative safe integer");
    if (!Object.hasOwn(payload, "color")) throw new TypeError("set_session_color payload.color is required");
    if (payload.color !== null && !SESSION_COLORS.includes(payload.color)) throw new TypeError(`set_session_color payload.color must be null or one of: ${SESSION_COLORS.join(", ")}`);
    return { ...base, payload: { sessionId: readIdentifier(payload, "sessionId", "set_session_color payload.sessionId"), color: payload.color } };
  }
  if (op === "launch") return { ...base, payload: readLaunchRequest(request.payload) };
  if (op === "attach") {
    const payload = readRecord(request.payload, "attach payload"); rejectUnknownKeys(payload, ["sessionId", "role", "activate"], "attach payload");
    if (Object.hasOwn(payload, "activate") && typeof payload.activate !== "boolean") throw new TypeError("attach payload.activate must be a boolean");
    const parsed = { sessionId: readIdentifier(payload, "sessionId", "attach payload.sessionId"), role: readEnum(payload, "role", ["composer", "observer"], "attach payload.role") };
    return { ...base, payload: payload.activate === true ? { ...parsed, activate: true } : parsed };
  }
  if (["detach", "interrupt"].includes(op)) return { ...base, payload: readSessionPayload(request.payload, op) };
  if (["stop", "delete"].includes(op)) return { ...base, payload: readDestructivePayload(request.payload, op) };
  if (["prompt", "steer", "follow_up"].includes(op)) {
    const payload = readRecord(request.payload, `${op} payload`); rejectUnknownKeys(payload, ["sessionId", "text"], `${op} payload`);
    return { ...base, payload: { sessionId: readIdentifier(payload, "sessionId", `${op} payload.sessionId`), text: readText(payload, "text", `${op} payload.text`) } };
  }
  if (op === "ui_response") {
    const payload = readRecord(request.payload, "ui_response payload"); rejectUnknownKeys(payload, ["sessionId", "uiRequestId", "response"], "ui_response payload");
    if (!Object.hasOwn(payload, "response")) throw new TypeError("ui_response payload.response is required");
    return { ...base, payload: { sessionId: readIdentifier(payload, "sessionId", "ui_response payload.sessionId"), uiRequestId: readIdentifier(payload, "uiRequestId", "ui_response payload.uiRequestId"), response: readJsonValue(payload.response, "ui_response payload.response") } };
  }
  if (op === "subscribe") {
    const payload = readRecord(request.payload, "subscribe payload"); rejectUnknownKeys(payload, ["after"], "subscribe payload");
    return { ...base, payload: Object.hasOwn(payload, "after") ? { after: readCursor(payload.after, "subscribe payload.after") } : {} };
  }
  if (op === "ack") {
    const payload = readRecord(request.payload, "ack payload"); rejectUnknownKeys(payload, ["cursor"], "ack payload");
    return { ...base, payload: { cursor: readCursor(payload.cursor, "ack payload.cursor") } };
  }
  if (["get_viewer_snapshot", "get_session_commands"].includes(op)) return { ...base, payload: readSessionPayload(request.payload, op) };
  if (op === "session_query") {
    const payload = readRecord(request.payload, "session_query payload");
    const query = readEnum(payload, "query", SESSION_QUERIES, "session_query payload.query");
    const sessionId = readIdentifier(payload, "sessionId", "session_query payload.sessionId");
    rejectUnknownKeys(payload, query === "export_html" ? ["sessionId", "query", "outputPath"] : ["sessionId", "query"], "session_query payload");
    if (query === "export_html" && Object.hasOwn(payload, "outputPath")) {
      return { ...base, payload: { sessionId, query, outputPath: readIdentifier(payload, "outputPath", "session_query payload.outputPath") } };
    }
    return { ...base, payload: { sessionId, query } };
  }
  if (op === "session_command") {
    const payload = readRecord(request.payload, "session_command payload");
    const command = readEnum(payload, "command", SESSION_COMMANDS, "session_command payload.command");
    const sessionId = readIdentifier(payload, "sessionId", "session_command payload.sessionId");
    if (command === "set_model") {
      rejectUnknownKeys(payload, ["sessionId", "command", "model"], "session_command payload");
      return { ...base, payload: { sessionId, command, model: readModel(payload.model, "session_command payload.model") } };
    }
    if (command === "set_thinking_level") {
      rejectUnknownKeys(payload, ["sessionId", "command", "level"], "session_command payload");
      return { ...base, payload: { sessionId, command, level: readIdentifier(payload, "level", "session_command payload.level") } };
    }
    if (command === "set_session_name") {
      rejectUnknownKeys(payload, ["sessionId", "command", "name"], "session_command payload");
      const name = readText(payload, "name", "session_command payload.name");
      if (name.length > 128) throw new TypeError("session_command payload.name must be at most 128 characters");
      return { ...base, payload: { sessionId, command, name } };
    }
    if (command === "set_auto_compaction" || command === "set_auto_retry") {
      rejectUnknownKeys(payload, ["sessionId", "command", "enabled"], "session_command payload");
      if (typeof payload.enabled !== "boolean") throw new TypeError("session_command payload.enabled must be a boolean");
      return { ...base, payload: { sessionId, command, enabled: payload.enabled } };
    }
    if (command === "set_steering_mode" || command === "set_follow_up_mode") {
      rejectUnknownKeys(payload, ["sessionId", "command", "mode"], "session_command payload");
      return { ...base, payload: { sessionId, command, mode: readEnum(payload, "mode", QUEUE_MODES, "session_command payload.mode") } };
    }
    if (command === "abort_retry") {
      rejectUnknownKeys(payload, ["sessionId", "command"], "session_command payload");
      return { ...base, payload: { sessionId, command } };
    }
    rejectUnknownKeys(payload, ["sessionId", "command", "instructions"], "session_command payload");
    return { ...base, payload: Object.hasOwn(payload, "instructions") ? { sessionId, command, instructions: readText(payload, "instructions", "session_command payload.instructions") } : { sessionId, command } };
  }
  if (op === "subscribe_viewer") {
    const payload = readRecord(request.payload, "subscribe_viewer payload"); rejectUnknownKeys(payload, ["sessionId", "after"], "subscribe_viewer payload");
    const sessionId = readIdentifier(payload, "sessionId", "subscribe_viewer payload.sessionId");
    if (!Object.hasOwn(payload, "after")) return { ...base, payload: { sessionId } };
    const after = readViewerCursor(payload.after, "subscribe_viewer payload.after");
    if (after.sessionId !== sessionId) throw new TypeError("subscribe_viewer cursor session does not match payload session");
    return { ...base, payload: { sessionId, after } };
  }
  if (op === "ack_viewer") {
    const payload = readRecord(request.payload, "ack_viewer payload"); rejectUnknownKeys(payload, ["cursor"], "ack_viewer payload");
    return { ...base, payload: { cursor: readViewerCursor(payload.cursor, "ack_viewer payload.cursor") } };
  }
  const payload = readRecord(request.payload, "resolve_delivery payload"); rejectUnknownKeys(payload, ["targetClientId", "targetRequestId", "resolution"], "resolve_delivery payload");
  return { ...base, payload: { targetClientId: readIdentifier(payload, "targetClientId", "resolve_delivery payload.targetClientId"), targetRequestId: readIdentifier(payload, "targetRequestId", "resolve_delivery payload.targetRequestId"), resolution: readEnum(payload, "resolution", ["retry_at_risk", "abandon"], "resolve_delivery payload.resolution") } };
}

/** @param {unknown} value @param {string} path */
function validateCommandStatus(value, path) {
  const status = readRecord(value, path);
  requireKeys(status, ["clientId", "requestId", "operation", "stage", "acceptedAt", "updatedAt"], ["error"], path);
  for (const key of ["clientId", "requestId", "acceptedAt", "updatedAt"]) readIdentifier(status, key, `${path}.${key}`);
  readEnum(status, "operation", OPERATIONS, `${path}.operation`);
  readEnum(status, "stage", COMMAND_STAGES, `${path}.stage`);
  if (Object.hasOwn(status, "error")) validateError(status.error, `${path}.error`);
}

/** @param {unknown} value @param {string} path */
function validateError(value, path) {
  const error = readRecord(value, path); requireKeys(error, ["code", "message", "retryable"], [], path); readIdentifier(error, "code", `${path}.code`);
  if (typeof error.message !== "string" || typeof error.retryable !== "boolean") throw new TypeError(`${path} is invalid`);
}

/** @param {unknown} value @param {string} path */
function validateSession(value, path) {
  const session = readRecord(value, path);
  requireKeys(session, ["schemaVersion", "revision", "sessionId", "sessionFile", "canonicalSessionFile", "cwd", "taskState", "processState", "outcome", "activity", "createdAt", "updatedAt"], ["name", "nameGenerated", "color", "model", "thinkingLevel", "ownership", "isolation", "latestRunId", "runtime", "summary"], path);
  if (Object.hasOwn(session, "nameGenerated") && typeof session.nameGenerated !== "boolean") throw new TypeError(`${path}.nameGenerated must be a boolean`);
  if (Object.hasOwn(session, "color") && !SESSION_COLORS.includes(session.color)) throw new TypeError(`${path}.color must be one of: ${SESSION_COLORS.join(", ")}`);
  if (Object.hasOwn(session, "summary")) {
    const summary = readRecord(session.summary, `${path}.summary`);
    requireKeys(summary, ["text", "generatedAt", "model", "sourceCursor"], [], `${path}.summary`);
    if (typeof summary.text !== "string" || summary.text.length === 0 || summary.text.length > 512) throw new TypeError(`${path}.summary.text must be a bounded non-empty string`);
    readIdentifier(summary, "generatedAt", `${path}.summary.generatedAt`);
    readIdentifier(summary, "sourceCursor", `${path}.summary.sourceCursor`);
    readModel(summary.model, `${path}.summary.model`);
  }
  if (session.schemaVersion !== 1 || !Number.isSafeInteger(session.revision) || session.revision < 0) throw new TypeError(`${path} schema version or revision is invalid`);
  for (const key of ["sessionId", "sessionFile", "canonicalSessionFile", "cwd", "createdAt", "updatedAt"]) readIdentifier(session, key, `${path}.${key}`);
  readEnum(session, "taskState", ["WORKING", "WAITING", "READY", "FAILED", "STOPPED"], `${path}.taskState`);
  readEnum(session, "processState", ["LIVE", "SLEEPING", "EXITED", "STALE"], `${path}.processState`);
  readEnum(session, "outcome", ["NONE", "COMPLETED", "READY_FOR_REVIEW"], `${path}.outcome`);
  const activity = readRecord(session.activity, `${path}.activity`); requireKeys(activity, ["kind", "summary", "updatedAt"], [], `${path}.activity`); readIdentifier(activity, "kind", `${path}.activity.kind`); if (typeof activity.summary !== "string") throw new TypeError(`${path}.activity.summary must be a string`); readIdentifier(activity, "updatedAt", `${path}.activity.updatedAt`);
  for (const key of ["name", "thinkingLevel", "latestRunId"]) if (Object.hasOwn(session, key)) readIdentifier(session, key, `${path}.${key}`);
  if (Object.hasOwn(session, "model")) readModel(session.model, `${path}.model`);
  if (Object.hasOwn(session, "ownership")) { const ownership = readRecord(session.ownership, `${path}.ownership`); requireKeys(ownership, ["kind", "runId", "process", "acquiredAt", "heartbeatAt"], [], `${path}.ownership`); if (ownership.kind !== "managed") throw new TypeError(`${path}.ownership.kind is invalid`); for (const key of ["runId", "acquiredAt", "heartbeatAt"]) readIdentifier(ownership, key, `${path}.ownership.${key}`); validateProcessIdentity(ownership.process, `${path}.ownership.process`); }
  if (Object.hasOwn(session, "isolation")) { const isolation = readRecord(session.isolation, `${path}.isolation`); const mode = readEnum(isolation, "mode", ["worktree", "shared_directory"], `${path}.isolation.mode`); if (mode === "worktree") { requireKeys(isolation, ["mode", "worktreePath", "branch"], [], `${path}.isolation`); readIdentifier(isolation, "worktreePath", `${path}.isolation.worktreePath`); readIdentifier(isolation, "branch", `${path}.isolation.branch`); } else { requireKeys(isolation, ["mode", "canonicalCwd"], [], `${path}.isolation`); readIdentifier(isolation, "canonicalCwd", `${path}.isolation.canonicalCwd`); } }
  if (Object.hasOwn(session, "runtime")) validateRuntimeIdentity(session.runtime, `${path}.runtime`);
}

/** @param {unknown} value @param {string} path */
function validateRuntimeIdentity(value, path) {
  const runtime = readRecord(value, path); requireKeys(runtime, ["executable", "piVersion", "capabilities", "rpcAdapterVersion", "viewerProtocolVersion", "supervisor", "piChild"], [], path);
  validateExecutableIdentity(runtime.executable, `${path}.executable`); if (runtime.piVersion !== null) readIdentifier(runtime, "piVersion", `${path}.piVersion`); if (runtime.rpcAdapterVersion !== 1 || runtime.viewerProtocolVersion !== 1) throw new TypeError(`${path} protocol versions must be 1`);
  const capabilities = readRecord(runtime.capabilities, `${path}.capabilities`); requireKeys(capabilities, ["executable", "reportedVersion", "rpcMode", "jsonl", "commands", "events", "missingRequired"], [], `${path}.capabilities`); validateExecutableIdentity(capabilities.executable, `${path}.capabilities.executable`); if (capabilities.reportedVersion !== null) readIdentifier(capabilities, "reportedVersion", `${path}.capabilities.reportedVersion`); if (typeof capabilities.rpcMode !== "boolean" || typeof capabilities.jsonl !== "boolean" || !Array.isArray(capabilities.commands) || !Array.isArray(capabilities.events) || !Array.isArray(capabilities.missingRequired) || capabilities.commands.some((/** @type {unknown} */ command) => typeof command !== "string" || !["get_state", "prompt", "follow_up", "steer", "abort", "extension_ui_response"].includes(command)) || [...capabilities.events, ...capabilities.missingRequired].some((/** @type {unknown} */ entry) => typeof entry !== "string")) throw new TypeError(`${path}.capabilities is invalid`);
  validateProcessIdentity(runtime.supervisor, `${path}.supervisor`); validateProcessIdentity(runtime.piChild, `${path}.piChild`);
}

/** @param {Record<string, any>} result */
function validateSessionCommands(result) {
  const path = "daemon response.result";
  requireKeys(result, ["kind", "sessionId", "commands", "models", "thinkingLevels", "model", "thinkingLevel"], [], path);
  readIdentifier(result, "sessionId", `${path}.sessionId`);
  for (const key of ["commands", "models", "thinkingLevels"]) {
    if (!Array.isArray(result[key]) || result[key].length > MAX_MENU_ENTRIES) throw new TypeError(`${path}.${key} must be a bounded array`);
  }
  result.commands.forEach((/** @type {unknown} */ entry, /** @type {number} */ index) => {
    const command = readRecord(entry, `${path}.commands[${index}]`);
    requireKeys(command, ["name", "source"], ["description", "argumentHint"], `${path}.commands[${index}]`);
    readIdentifier(command, "name", `${path}.commands[${index}].name`);
    readEnum(command, "source", ["extension", "prompt", "skill", "builtin"], `${path}.commands[${index}].source`);
    for (const key of ["description", "argumentHint"]) if (Object.hasOwn(command, key) && typeof command[key] !== "string") throw new TypeError(`${path}.commands[${index}].${key} must be a string`);
  });
  result.models.forEach((/** @type {unknown} */ entry, /** @type {number} */ index) => readModel(entry, `${path}.models[${index}]`));
  result.thinkingLevels.forEach((/** @type {unknown} */ level, /** @type {number} */ index) => {
    if (typeof level !== "string" || level.length === 0) throw new TypeError(`${path}.thinkingLevels[${index}] must be a non-empty string`);
  });
  if (result.model !== null) readModel(result.model, `${path}.model`);
  if (result.thinkingLevel !== null && (typeof result.thinkingLevel !== "string" || result.thinkingLevel.length === 0)) throw new TypeError(`${path}.thinkingLevel must be a non-empty string or null`);
}

/** Parse one strict version-1 daemon response. @param {unknown} value @returns {DaemonResponse} */
export function parseDaemonResponse(value) {
  const response = readRecord(value, "daemon response");
  if (response.version !== 1 || typeof response.requestId !== "string" || response.requestId.length === 0 || typeof response.ok !== "boolean") throw new TypeError("Daemon response envelope is invalid");
  if (!response.ok) { requireKeys(response, ["version", "requestId", "ok", "error"], [], "daemon response"); validateError(response.error, "daemon response.error"); return response; }
  requireKeys(response, ["version", "requestId", "ok", "result"], [], "daemon response");
  const result = readRecord(response.result, "daemon response.result");
  const kind = readEnum(result, "kind", ["state", "launched", "attached", "detached", "command", "subscribed", "acknowledged", "viewer_snapshot", "viewer_subscribed", "viewer_acknowledged", "session_commands", "session_query", "settings", "summaries_refreshing", "session_colored"], "daemon response.result.kind");
  if (kind === "state") { requireKeys(result, ["kind", "sessions"], [], "daemon response.result"); if (!Array.isArray(result.sessions)) throw new TypeError("sessions must be an array"); result.sessions.forEach((session, index) => validateSession(session, `daemon response.result.sessions[${index}]`)); }
  else if (["launched", "detached"].includes(kind)) { requireKeys(result, ["kind", "sessionId"], [], "daemon response.result"); readIdentifier(result, "sessionId"); }
  else if (kind === "attached") { requireKeys(result, ["kind", "sessionId", "role"], [], "daemon response.result"); readIdentifier(result, "sessionId"); readEnum(result, "role", ["composer", "observer"]); }
  else if (kind === "command") { requireKeys(result, ["kind", "status"], [], "daemon response.result"); validateCommandStatus(result.status, "status"); }
  else if (kind === "session_commands") validateSessionCommands(result);
  else if (kind === "session_query") {
    requireKeys(result, ["kind", "sessionId", "query", "rows"], [], "daemon response.result");
    readIdentifier(result, "sessionId", "daemon response.result.sessionId");
    readEnum(result, "query", SESSION_QUERIES, "daemon response.result.query");
    if (!Array.isArray(result.rows) || result.rows.length > MAX_QUERY_ROWS) throw new TypeError("daemon response.result.rows must be a bounded array");
    result.rows.forEach((/** @type {unknown} */ row, /** @type {number} */ index) => {
      if (typeof row !== "string" || row.length > 2_000) throw new TypeError(`daemon response.result.rows[${index}] must be a bounded string`);
    });
  }
  else if (kind === "settings") {
    requireKeys(result, ["kind", "summaryModel"], [], "daemon response.result");
    if (result.summaryModel !== null) readModel(result.summaryModel, "daemon response.result.summaryModel");
  }
  else if (kind === "session_colored") {
    requireKeys(result, ["kind", "sessionId", "revision", "color"], [], "daemon response.result");
    readIdentifier(result, "sessionId", "daemon response.result.sessionId");
    if (!Number.isSafeInteger(result.revision) || result.revision < 0) throw new TypeError("daemon response.result.revision must be a non-negative safe integer");
    if (result.color !== null && !SESSION_COLORS.includes(result.color)) throw new TypeError(`daemon response.result.color must be null or one of: ${SESSION_COLORS.join(", ")}`);
  }
  else if (kind === "summaries_refreshing") { requireKeys(result, ["kind", "sessionIds"], [], "daemon response.result"); if (!Array.isArray(result.sessionIds)) throw new TypeError("daemon response.result.sessionIds must be an array"); result.sessionIds.forEach((/** @type {unknown} */ sessionId, /** @type {number} */ index) => { if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError(`daemon response.result.sessionIds[${index}] must be a non-empty string`); }); }
  else if (kind === "viewer_snapshot") { requireKeys(result, ["kind", "snapshot"], [], "daemon response.result"); parseViewerSnapshot(result.snapshot); }
  else if (["viewer_subscribed", "viewer_acknowledged"].includes(kind)) { requireKeys(result, ["kind", "cursor"], [], "daemon response.result"); readViewerCursor(result.cursor, "daemon response.result.cursor"); }
  else { requireKeys(result, ["kind", "cursor"], [], "daemon response.result"); readCursor(result.cursor, "daemon response.result.cursor"); }
  return response;
}

/** Parse one strict version-1 persisted event broadcast to subscribers. @param {unknown} value @returns {PersistedEvent} */
export function parsePersistedEvent(value) {
  const event = readRecord(value, "Persisted event");
  requireKeys(event, ["version", "cursor", "occurredAt", "kind", "payload"], [], "persisted event");
  if (event.version !== 1) throw new TypeError("Persisted event version must be 1");
  readCursor(event.cursor, "persisted event.cursor");
  readIdentifier(event, "occurredAt", "persisted event.occurredAt");
  const kind = readEnum(event, "kind", ["session_changed", "command_changed", "attachment_changed"], "persisted event.kind");
  const payload = readRecord(event.payload, "persisted event.payload");
  if (kind === "session_changed") { requireKeys(payload, ["session"], [], "persisted event.payload"); validateSession(payload.session, "persisted event.payload.session"); }
  else if (kind === "command_changed") { requireKeys(payload, ["status"], [], "persisted event.payload"); validateCommandStatus(payload.status, "persisted event.payload.status"); }
  else {
    requireKeys(payload, ["sessionId", "clientId", "role", "attached"], [], "persisted event.payload");
    readIdentifier(payload, "sessionId", "persisted event.payload.sessionId");
    readIdentifier(payload, "clientId", "persisted event.payload.clientId");
    readEnum(payload, "role", ["composer", "observer"], "persisted event.payload.role");
    if (typeof payload.attached !== "boolean") throw new TypeError("persisted event.payload.attached must be a boolean");
  }
  return /** @type {PersistedEvent} */ (value);
}
