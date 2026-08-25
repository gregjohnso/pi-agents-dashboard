/** @typedef {"idle"|"thinking"|"assistant_streaming"|"tool_pending"|"tool_running"|"tool_streaming"|"compacting"|"retrying"|"waiting"|"interrupting"|"stopping"|"error"} ViewerActivityPhase */
/** @typedef {{daemonEpoch:string,sessionId:string,sequence:string}} ViewerCursor */
/** @typedef {{version:1,sessionId:string,eventId:string,cursor:ViewerCursor,timestamp:string,payload:Record<string, unknown>}} ViewerEvent */
/** @typedef {Record<string, any>} ViewerSnapshot */

const PHASES = ["idle", "thinking", "assistant_streaming", "tool_pending", "tool_running", "tool_streaming", "compacting", "retrying", "waiting", "interrupting", "stopping", "error"];
const ITEM_KINDS = ["user_message", "assistant_message", "system_message", "image_placeholder", "file_placeholder", "unknown_pi_event"];

/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function record(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${path} must be a plain object`);
  return value;
}
/** @param {Record<string, any>} value @param {readonly string[]} required @param {readonly string[]} optional @param {string} path */
function exact(value, required, optional, path) {
  const allowed = [...required, ...optional];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`Unknown ${path} field: ${unknown}`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new TypeError(`${path}.${missing} is required`);
}
/** @param {unknown} value @param {string} path @param {boolean} [nullable] */
function string(value, path, nullable = false, maxLength = 4096) { if (nullable && value === null) return; if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > maxLength) throw new TypeError(`${path} must be a bounded non-empty string`); }
/** @param {unknown} value @param {string} path */
function canonicalSequence(value, path) { string(value, path); if (!/^(0|[1-9]\d*)$/u.test(/** @type {string} */ (value))) throw new TypeError(`${path} must be a canonical unsigned integer string`); }
/** @param {unknown} value @param {readonly string[]} values @param {string} path */
function enumeration(value, values, path) { if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${path} is invalid`); }
/** @param {unknown} value @param {string} path @returns {ViewerCursor} */
function cursor(value, path) {
  const parsed = record(value, path); exact(parsed, ["daemonEpoch", "sessionId", "sequence"], [], path);
  string(parsed.daemonEpoch, `${path}.daemonEpoch`); string(parsed.sessionId, `${path}.sessionId`); canonicalSequence(parsed.sequence, `${path}.sequence`);
  return /** @type {ViewerCursor} */ (parsed);
}
/** @param {unknown} value @param {string} path */
function content(value, path) {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  value.forEach((entry, index) => {
    const item = record(entry, `${path}[${index}]`); enumeration(item.type, ["text", "thinking", "image", "file"], `${path}[${index}].type`);
    if (item.type === "text" || item.type === "thinking") { exact(item, ["type", "text"], [], `${path}[${index}]`); if (typeof item.text !== "string" || item.text.length > 65536) throw new TypeError(`${path}[${index}].text must be a bounded string`); }
    else { exact(item, ["type", "attachmentId"], [], `${path}[${index}]`); string(item.attachmentId, `${path}[${index}].attachmentId`); }
  });
}
/** @param {unknown} value @param {string} path */
function attachment(value, path) {
  const item = record(value, path); exact(item, ["id"], ["path", "mediaType", "size", "width", "height"], path); string(item.id, `${path}.id`);
  for (const key of ["path", "mediaType"]) if (Object.hasOwn(item, key)) string(item[key], `${path}.${key}`);
  for (const key of ["size", "width", "height"]) if (Object.hasOwn(item, key) && (!Number.isSafeInteger(item[key]) || item[key] < 0)) throw new TypeError(`${path}.${key} must be a non-negative integer`);
}
/** @param {unknown} value @param {string} path */
function tool(value, path) {
  const item = record(value, path); exact(item, ["id", "name", "state", "arguments", "startedAt"], ["result", "error", "finishedAt"], path);
  string(item.id, `${path}.id`, false, 256); string(item.name, `${path}.name`, false, 256); enumeration(item.state, ["pending", "running", "streaming", "completed", "failed"], `${path}.state`); string(item.startedAt, `${path}.startedAt`, false, 64); if (typeof item.arguments !== "object" || item.arguments === null || Array.isArray(item.arguments) || JSON.stringify(item.arguments).length > 65536) throw new TypeError(`${path}.arguments must be bounded`);
  if (Object.hasOwn(item, "result")) content(item.result, `${path}.result`); if (Object.hasOwn(item, "error")) string(item.error, `${path}.error`); if (Object.hasOwn(item, "finishedAt")) string(item.finishedAt, `${path}.finishedAt`);
}
/** @param {unknown} value @param {string} path */
function uiRequest(value, path) {
  const item = record(value, path); exact(item, ["id", "method", "title"], ["options", "initialValue"], path); string(item.id, `${path}.id`); enumeration(item.method, ["confirm", "select", "input", "editor"], `${path}.method`); string(item.title, `${path}.title`);
  if (Object.hasOwn(item, "options")) { if (!Array.isArray(item.options)) throw new TypeError(`${path}.options must be an array`); item.options.forEach((option, index) => string(option, `${path}.options[${index}]`)); }
  if (Object.hasOwn(item, "initialValue") && (typeof item.initialValue !== "string" || item.initialValue.length > 16384)) throw new TypeError(`${path}.initialValue must be a bounded string`);
}
/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function payload(value, path) {
  const item = record(value, path); string(item.kind, `${path}.kind`);
  switch (item.kind) {
    case "user_message": case "assistant_message": exact(item, ["kind", "itemId", "content"], [], path); string(item.itemId, `${path}.itemId`); content(item.content, `${path}.content`); break;
    case "assistant_delta": exact(item, ["kind", "itemId", "delta"], [], path); string(item.itemId, `${path}.itemId`); if (typeof item.delta !== "string" || item.delta.length > 65536) throw new TypeError(`${path}.delta must be a bounded string`); break;
    case "system_message": exact(item, ["kind", "itemId", "text", "level"], [], path); string(item.itemId, `${path}.itemId`); if (typeof item.text !== "string" || item.text.length > 16384) throw new TypeError(`${path}.text must be a bounded string`); enumeration(item.level, ["info", "warning", "error"], `${path}.level`); break;
    case "tool_started": case "tool_updated": case "tool_finished": exact(item, ["kind", "tool"], [], path); tool(item.tool, `${path}.tool`); break;
    case "turn_state": exact(item, ["kind", "working"], [], path); if (typeof item.working !== "boolean") throw new TypeError(`${path}.working must be boolean`); break;
    case "pending_ui_request": exact(item, ["kind", "request"], [], path); uiRequest(item.request, `${path}.request`); break;
    case "ui_resolved": exact(item, ["kind", "requestId"], [], path); string(item.requestId, `${path}.requestId`); break;
    case "model_state": exact(item, ["kind", "provider", "model"], [], path); string(item.provider, `${path}.provider`, true); string(item.model, `${path}.model`, true); break;
    case "thinking_state": exact(item, ["kind", "level"], [], path); string(item.level, `${path}.level`, true); break;
    case "activity": exact(item, ["kind", "phase", "label", "sourceEventId", "startedAt"], ["detail", "toolCallId", "retryAt"], path); enumeration(item.phase, PHASES, `${path}.phase`); string(item.label, `${path}.label`, false, 256); string(item.sourceEventId, `${path}.sourceEventId`, false, 256); string(item.startedAt, `${path}.startedAt`, false, 64); if (Object.hasOwn(item, "detail")) string(item.detail, `${path}.detail`, false, 4096); for (const key of ["toolCallId", "retryAt"]) if (Object.hasOwn(item, key)) string(item[key], `${path}.${key}`, false, key === "toolCallId" ? 256 : 64); break;
    case "image_placeholder": case "file_placeholder": exact(item, ["kind", "attachment"], [], path); attachment(item.attachment, `${path}.attachment`); break;
    case "unknown_pi_event": exact(item, ["kind", "piType", "summary"], [], path); string(item.piType, `${path}.piType`); string(item.summary, `${path}.summary`); break;
    default: throw new TypeError(`${path}.kind is invalid`);
  }
  return item;
}
/** @param {unknown} value @param {string} path */
function processIdentity(value, path) { const item = record(value, path); exact(item, ["pid", "startIdentity", "processGroupId"], [], path); if (!Number.isSafeInteger(item.pid) || !Number.isSafeInteger(item.processGroupId)) throw new TypeError(`${path} process IDs are invalid`); string(item.startIdentity, `${path}.startIdentity`); }
/** @param {unknown} value @param {string} path */
function executable(value, path) { const item = record(value, path); exact(item, ["realpath", "device", "inode", "size", "modifiedTimeNs"], [], path); string(item.realpath, `${path}.realpath`); string(item.device, `${path}.device`); string(item.inode, `${path}.inode`); string(item.modifiedTimeNs, `${path}.modifiedTimeNs`); if (!Number.isSafeInteger(item.size) || item.size < 0) throw new TypeError(`${path}.size is invalid`); }
/** @param {unknown} value @param {string} path */
function runtime(value, path) {
  const item = record(value, path); exact(item, ["executable", "piVersion", "capabilities", "rpcAdapterVersion", "viewerProtocolVersion", "supervisor", "piChild"], [], path); executable(item.executable, `${path}.executable`); string(item.piVersion, `${path}.piVersion`, true);
  const capabilities = record(item.capabilities, `${path}.capabilities`); exact(capabilities, ["executable", "reportedVersion", "rpcMode", "jsonl", "commands", "events", "missingRequired"], [], `${path}.capabilities`); executable(capabilities.executable, `${path}.capabilities.executable`); string(capabilities.reportedVersion, `${path}.capabilities.reportedVersion`, true);
  if (typeof capabilities.rpcMode !== "boolean" || typeof capabilities.jsonl !== "boolean") throw new TypeError(`${path}.capabilities flags are invalid`);
  for (const key of ["commands", "events", "missingRequired"]) { if (!Array.isArray(capabilities[key])) throw new TypeError(`${path}.capabilities.${key} must be an array`); capabilities[key].forEach((entry, index) => string(entry, `${path}.capabilities.${key}[${index}]`)); }
  if (capabilities.commands.some((/** @type {string} */ command) => !["get_state", "prompt", "follow_up", "steer", "abort", "extension_ui_response"].includes(command))) throw new TypeError(`${path}.capabilities.commands is invalid`);
  if (item.rpcAdapterVersion !== 1 || item.viewerProtocolVersion !== 1) throw new TypeError(`${path} protocol versions must be 1`); processIdentity(item.supervisor, `${path}.supervisor`); processIdentity(item.piChild, `${path}.piChild`);
}

/** Parse one strict normalized viewer event. @param {unknown} value @returns {ViewerEvent} */
export function parseViewerEvent(value) {
  const event = record(value, "viewer event"); exact(event, ["version", "sessionId", "eventId", "cursor", "timestamp", "payload"], [], "viewer event"); if (event.version !== 1) throw new TypeError("viewer event.version must be 1");
  string(event.sessionId, "viewer event.sessionId"); string(event.eventId, "viewer event.eventId"); string(event.timestamp, "viewer event.timestamp"); const parsedCursor = cursor(event.cursor, "viewer event.cursor"); if (parsedCursor.sessionId !== event.sessionId) throw new TypeError("viewer cursor session does not match event session"); payload(event.payload, "viewer event.payload"); return /** @type {ViewerEvent} */ (event);
}

/** Parse one strict normalized viewer snapshot. @param {unknown} value @returns {ViewerSnapshot} */
export function parseViewerSnapshot(value) {
  const snapshot = record(value, "viewer snapshot"); exact(snapshot, ["version", "sessionId", "registryRevision", "cursor", "runtime", "role", "taskState", "processState", "outcome", "activity", "model", "thinkingLevel", "items", "tools", "pendingUi", "errors"], [], "viewer snapshot"); if (snapshot.version !== 1) throw new TypeError("viewer snapshot.version must be 1");
  string(snapshot.sessionId, "viewer snapshot.sessionId"); if (!Number.isSafeInteger(snapshot.registryRevision) || snapshot.registryRevision < 0) throw new TypeError("viewer snapshot.registryRevision is invalid"); const parsedCursor = cursor(snapshot.cursor, "viewer snapshot.cursor"); if (parsedCursor.sessionId !== snapshot.sessionId) throw new TypeError("viewer cursor session does not match snapshot session");
  if (snapshot.runtime !== null) runtime(snapshot.runtime, "viewer snapshot.runtime"); enumeration(snapshot.role, ["composer", "observer"], "viewer snapshot.role"); enumeration(snapshot.taskState, ["WORKING", "WAITING", "READY", "FAILED", "STOPPED"], "viewer snapshot.taskState"); enumeration(snapshot.processState, ["LIVE", "SLEEPING", "EXITED", "STALE"], "viewer snapshot.processState"); enumeration(snapshot.outcome, ["NONE", "COMPLETED", "READY_FOR_REVIEW"], "viewer snapshot.outcome");
  const activity = payload(snapshot.activity, "viewer snapshot.activity"); if (activity.kind !== "activity") throw new TypeError("viewer snapshot.activity must be activity");
  if (snapshot.model !== null) { const model = record(snapshot.model, "viewer snapshot.model"); exact(model, ["provider", "id"], [], "viewer snapshot.model"); string(model.provider, "viewer snapshot.model.provider"); string(model.id, "viewer snapshot.model.id"); } string(snapshot.thinkingLevel, "viewer snapshot.thinkingLevel", true);
  if (!Array.isArray(snapshot.items) || !Array.isArray(snapshot.tools) || !Array.isArray(snapshot.pendingUi) || !Array.isArray(snapshot.errors)) throw new TypeError("viewer snapshot collections must be arrays"); snapshot.items.forEach((item, index) => { const parsed = payload(item, `viewer snapshot.items[${index}]`); if (!ITEM_KINDS.includes(parsed.kind)) throw new TypeError(`viewer snapshot.items[${index}] is not a viewer item`); }); snapshot.tools.forEach((item, index) => tool(item, `viewer snapshot.tools[${index}]`)); snapshot.pendingUi.forEach((item, index) => uiRequest(item, `viewer snapshot.pendingUi[${index}]`)); snapshot.errors.forEach((entry, index) => { const error = record(entry, `viewer snapshot.errors[${index}]`); exact(error, ["code", "message", "retryable"], [], `viewer snapshot.errors[${index}]`); string(error.code, `viewer snapshot.errors[${index}].code`); if (typeof error.message !== "string" || typeof error.retryable !== "boolean") throw new TypeError(`viewer snapshot.errors[${index}] is invalid`); }); return snapshot;
}
