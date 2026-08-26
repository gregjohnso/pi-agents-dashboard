import { createHash } from "node:crypto";
import { basename } from "node:path";

const MAX_CANONICAL_ID_BYTES = 65_536;
const MAX_SUMMARY_BYTES = 4_096;
const MAX_TEXT_BYTES = 65_536;
const DIALOG_METHODS = new Set(["confirm", "select", "input", "editor"]);

/** A typed, session-scoped Pi compatibility failure. */
export class ViewerNormalizerError extends Error {
  /** @param {string} code @param {string} message @param {string} sessionId @param {{ cause?: unknown }} [options] */
  constructor(code, message, sessionId, options) {
    super(message, options);
    this.name = "ViewerNormalizerError";
    this.code = code;
    this.sessionId = sessionId;
    this.retryable = false;
  }
}

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** @param {unknown} value @param {{ remaining: number }} budget @param {number} [depth] @returns {unknown} */
function boundedIdentity(value, budget, depth = 0) {
  if (budget.remaining <= 0 || depth > 8) return "[bounded]";
  if (typeof value === "string") {
    const text = bound(value, Math.max(4, Math.min(1_024, budget.remaining)));
    budget.remaining -= Buffer.byteLength(text);
    return text.length === value.length ? text : { prefix: text, bytes: Buffer.byteLength(value) };
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") { budget.remaining -= 16; return value; }
  if (Array.isArray(value)) return value.slice(0, 128).map((entry) => boundedIdentity(entry, budget, depth + 1));
  if (typeof value === "object") {
    const source = /** @type {Record<string, unknown>} */ (value);
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const key of Object.keys(source).sort().slice(0, 128)) {
      if (budget.remaining <= 0) break;
      result[key] = boundedIdentity(source[key], budget, depth + 1);
    }
    return result;
  }
  return String(value);
}

/** @param {string} value @param {number} maxBytes */
function bound(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes - 3).toString("utf8").replace(/\uFFFD$/u, "") + "...";
}

/** @param {unknown} value */
function timestamp(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
}

/** @param {unknown} value */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : undefined;
}

/** @param {unknown} value @returns {unknown} */
function sanitizeViewerValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeViewerValue);
  const parsed = record(value);
  if (parsed === undefined) return value;
  if (["image", "file"].includes(parsed.type)) {
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => !["data", "content", "extractedText", "preview"].includes(key)).map(([key, entry]) => [key, sanitizeViewerValue(entry)]));
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, sanitizeViewerValue(entry)]));
}

/** @param {unknown} value */
function safeArguments(value) {
  const parsed = record(sanitizeViewerValue(value));
  if (parsed === undefined) return {};
  const text = canonical(parsed);
  if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return parsed;
  return { summary: "Tool arguments exceeded the viewer limit", bytes: Buffer.byteLength(text) };
}

/** @param {unknown} value @param {string} fallback */
function requiredString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? bound(value, 256) : fallback;
}

/** Create the deterministic adapter shared by canonical history and live Pi RPC frames. */
/** @param {{ sessionId: string, protocolVersion: number, now: () => string }} options */
export function createViewerNormalizer({ sessionId, protocolVersion, now }) {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId is required");
  if (protocolVersion !== 1) throw new TypeError("Viewer protocol version must be 1");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const items = new Map();
  const tools = new Map();

  /** Record one tool and keep its first-seen position among the ordered items. @param {any} tool */
  function noteTool(tool) {
    tools.set(tool.id, tool);
    const itemId = `tool:${tool.id}`;
    if (!items.has(itemId)) items.set(itemId, { kind: "tool", itemId, toolId: tool.id });
  }
  const pendingUi = new Map();
  /** @type {any[]} */
  const errors = [];
  const emitted = new Map();
  /** @type {Map<string, { itemId: string, origin: "history" | "live" }[]>} */
  const messageFingerprints = new Map();
  /** @type {any} */
  let model = null;
  /** @type {any} */
  let thinkingLevel = null;
  /** @type {any} */
  let activity = { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "normalizer-initial", startedAt: now() };
  let liveIndex = 0;
  let attachmentIndex = 0;
  /** @type {any} */
  let currentAssistant;

  /** @param {string} kind @param {unknown} identity */
  function deterministicId(kind, identity) {
    const encoded = Buffer.from(canonical(boundedIdentity(identity, { remaining: MAX_CANONICAL_ID_BYTES })), "utf8");
    const hash = createHash("sha256").update(sessionId).update("\0").update(kind).update("\0").update(encoded.subarray(0, MAX_CANONICAL_ID_BYTES)).update(`\0${encoded.length}`).digest("hex");
    return `viewer-${hash.slice(0, 24)}`;
  }

  /** @param {string} code @param {string} message @returns {never} */
  function incompatible(code, message) {
    const error = { code, message: bound(message, MAX_SUMMARY_BYTES), retryable: false };
    if (!errors.some((candidate) => candidate.code === error.code && candidate.message === error.message)) errors.push(error);
    throw new ViewerNormalizerError(code, error.message, sessionId);
  }

  /** Return private restart state that is never part of the viewer v1 wire protocol. */
  function checkpoint() {
    return { activeAssistant: currentAssistant === undefined ? null : { itemId: currentAssistant.itemId, blocks: currentAssistant.blocks.flatMap((/** @type {any} */ block, /** @type {number} */ contentIndex) => block === undefined ? [] : [{ contentIndex, type: block.type, text: block.text }]) } };
  }

  /** @param {any} restored */
  function restoreCheckpoint(restored) {
    currentAssistant = undefined;
    if (restored?.activeAssistant === null || restored?.activeAssistant === undefined) return;
    const blocks = [];
    for (const block of restored.activeAssistant.blocks) blocks[block.contentIndex] = { type: block.type, text: block.text };
    const itemId = restored.activeAssistant.itemId;
    currentAssistant = { itemId, blocks, delta: 0 };
    const content = blocks.filter(Boolean).map((/** @type {any} */ block) => ({ ...block }));
    if (content.length > 0 || items.has(itemId)) items.set(itemId, { kind: "assistant_message", itemId, content });
  }

  /** @param {Record<string, unknown>} payload @param {string} [preferredId] @param {string} [at] */
  function publish(payload, preferredId, at = now()) {
    const eventId = preferredId ?? deterministicId(String(payload.kind), { index: ++liveIndex, payload });
    const serialized = canonical(payload);
    const prior = emitted.get(eventId);
    if (prior === serialized) return [];
    if (prior !== undefined) incompatible("VIEWER_EVENT_ID_CONFLICT", `Stable viewer event ID ${eventId} was reused with changed content`);
    emitted.set(eventId, serialized);
    return [{ eventId, timestamp: at, payload, internalCheckpoint: checkpoint() }];
  }

  /** @param {string} phase @param {string} label @param {string} sourceEventId @param {Record<string, unknown>} [optional] */
  function replaceActivity(phase, label, sourceEventId, optional = {}) {
    activity = { kind: "activity", phase, label: bound(label, 256), sourceEventId: bound(sourceEventId, 256), startedAt: now(), ...optional };
    return publish(activity, `${sourceEventId}:activity:${phase}`);
  }

  /** @param {any} candidate @param {string} attachmentKind @param {string} identity */
  function attachment(candidate, attachmentKind, identity) {
    const id = typeof candidate?.id === "string" && candidate.id.length > 0 ? candidate.id : deterministicId("attachment", { identity, index: ++attachmentIndex, type: attachmentKind });
    /** @type {any} */
    const result = { id };
    const suppliedPath = candidate?.fileName ?? candidate?.path;
    if (typeof suppliedPath === "string" && suppliedPath.length > 0) result.path = bound(basename(suppliedPath), 4_096);
    const mediaType = candidate?.mimeType ?? candidate?.mediaType;
    if (typeof mediaType === "string" && mediaType.length > 0) result.mediaType = bound(mediaType, 4_096);
    for (const key of ["size", "width", "height"]) if (Number.isSafeInteger(candidate?.[key]) && candidate[key] >= 0) result[key] = candidate[key];
    return result;
  }

  /** @param {unknown} source @param {string} identity @returns {{ content: any[], placeholders: any[] }} */
  function normalizeContent(source, identity) {
    const blocks = typeof source === "string" ? [{ type: "text", text: source }] : source;
    if (!Array.isArray(blocks)) incompatible("PI_REQUIRED_SHAPE", "Pi message content must be a string or array");
    /** @type {any[]} */
    const content = [];
    /** @type {any[]} */
    const placeholders = [];
    blocks.forEach((block, index) => {
      const item = record(block);
      if (item?.type === "text" && typeof item.text === "string") content.push({ type: "text", text: bound(item.text, MAX_TEXT_BYTES) });
      else if (item?.type === "thinking" && typeof item.thinking === "string") content.push({ type: "thinking", text: bound(item.thinking, MAX_TEXT_BYTES) });
      else if (item?.type === "image") {
        const metadata = attachment(item, "image", `${identity}:${index}`);
        content.push({ type: "image", attachmentId: metadata.id });
        placeholders.push({ kind: "image_placeholder", attachment: metadata });
      } else if (item?.type === "file") {
        const metadata = attachment(item, "file", `${identity}:${index}`);
        content.push({ type: "file", attachmentId: metadata.id });
        placeholders.push({ kind: "file_placeholder", attachment: metadata });
      } else if (item?.type !== "toolCall") {
        incompatible("PI_REQUIRED_SHAPE", `Unsupported required Pi content block at index ${index}`);
      }
    });
    return { content, placeholders };
  }

  /** @param {any} message @param {string} at */
  function fingerprint(message, at) {
    return deterministicId("message-overlap", { role: message.role, content: message.content, timestamp: timestamp(message.timestamp) ?? at });
  }

  /** @param {any} message @param {string} itemId @param {string} at @param {string} eventId @param {"history"|"live"} [origin] */
  function consumeMessage(message, itemId, at, eventId, origin = "live") {
    if (typeof message?.role !== "string" || !Object.hasOwn(message, "content")) incompatible("PI_REQUIRED_SHAPE", "Pi message requires role and content");
    const overlap = fingerprint(message, at);
    const prior = messageFingerprints.get(overlap) ?? [];
    if (prior.some((entry) => entry.itemId === itemId) || (prior.length > 0 && (origin === "live" || prior.some((entry) => entry.origin === "live")))) return [];
    prior.push({ itemId, origin });
    messageFingerprints.set(overlap, prior);
    const normalized = normalizeContent(message.content, itemId);
    const output = [];
    if (message.role === "user") {
      const payload = { kind: "user_message", itemId, content: normalized.content };
      items.set(itemId, payload);
      output.push(...publish(payload, eventId, at));
    } else if (message.role === "assistant") {
      const payload = { kind: "assistant_message", itemId, content: normalized.content };
      items.set(itemId, payload);
      output.push(...publish(payload, eventId, at));
      for (const [index, block] of message.content.entries()) {
        if (block?.type !== "toolCall") continue;
        if (typeof block.id !== "string" || typeof block.name !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi tool call requires id and name");
        /** @type {any} */
        const tool = { id: block.id, name: bound(block.name, 256), state: "pending", arguments: safeArguments(block.arguments), startedAt: at };
        noteTool(tool);
        output.push(...publish({ kind: "tool_started", tool }, `${eventId}:tool:${tool.id}`, at));
      }
    } else if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi tool result requires toolCallId and toolName");
      const prior = tools.get(message.toolCallId);
      /** @type {any} */
      const tool = { id: message.toolCallId, name: bound(message.toolName, 256), state: message.isError === true ? "failed" : "completed", arguments: prior?.arguments ?? {}, startedAt: prior?.startedAt ?? at, result: normalized.content, finishedAt: at };
      if (message.isError === true) tool.error = bound(normalized.content.filter((/** @type {any} */ block) => block.type === "text").map((/** @type {any} */ block) => block.text).join("\n") || "Tool failed", MAX_SUMMARY_BYTES);
      noteTool(tool);
      output.push(...publish({ kind: "tool_finished", tool }, eventId, at));
    } else {
      const text = normalized.content.filter((block) => ["text", "thinking"].includes(block.type)).map((block) => block.text).join("\n");
      const payload = { kind: "system_message", itemId, text: bound(text, 16_384), level: "info" };
      items.set(itemId, payload);
      output.push(...publish(payload, eventId, at));
    }
    for (const [index, placeholder] of normalized.placeholders.entries()) {
      items.set(placeholder.attachment.id, placeholder);
      output.push(...publish(placeholder, `${eventId}:attachment:${index}`, at));
    }
    if (Array.isArray(message.attachments)) {
      for (const [index, candidate] of message.attachments.entries()) {
        const kind = candidate?.type === "image" ? "image_placeholder" : "file_placeholder";
        const placeholder = { kind, attachment: attachment(candidate, candidate?.type ?? "file", `${itemId}:message-attachment:${index}`) };
        items.set(placeholder.attachment.id, placeholder);
        output.push(...publish(placeholder, `${eventId}:message-attachment:${index}`, at));
      }
    }
    return output;
  }

  /** @param {Record<string, any>} entry @param {{ line?: number, byteStart?: number, byteEnd?: number, sourceId?: string }} position */
  function consumeHistory(entry, position) {
    if (record(entry) === undefined || typeof entry.type !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi history entry requires a type");
    const at = timestamp(entry.timestamp) ?? now();
    const sourceId = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : deterministicId(entry.type, { position, entry });
    if (entry.type === "session" || entry.type === "custom" || entry.type === "label" || entry.type === "session_info") return [];
    if (entry.type === "message") return consumeMessage(entry.message, sourceId, at, sourceId, "history");
    if (entry.type === "model_change") {
      if (typeof entry.provider !== "string" || typeof entry.modelId !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi model change requires provider and modelId");
      model = { provider: entry.provider, id: entry.modelId };
      return publish({ kind: "model_state", provider: model.provider, model: model.id }, sourceId, at);
    }
    if (entry.type === "thinking_level_change") {
      if (typeof entry.thinkingLevel !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi thinking change requires thinkingLevel");
      thinkingLevel = entry.thinkingLevel;
      return publish({ kind: "thinking_state", level: thinkingLevel }, sourceId, at);
    }
    if (entry.type === "custom_message") {
      if (entry.display !== true) return [];
      const normalized = normalizeContent(entry.content, sourceId);
      const text = normalized.content.filter((block) => ["text", "thinking"].includes(block.type)).map((block) => block.text).join("\n");
      const payload = { kind: "system_message", itemId: sourceId, text: bound(text, 16_384), level: "info" };
      items.set(sourceId, payload);
      const output = [...publish(payload, sourceId, at)];
      for (const [index, placeholder] of normalized.placeholders.entries()) {
        items.set(placeholder.attachment.id, placeholder);
        output.push(...publish(placeholder, `${sourceId}:attachment:${index}`, at));
      }
      return output;
    }
    if (["compaction", "branch_summary"].includes(entry.type)) {
      const text = typeof entry.summary === "string" ? entry.summary : `${entry.type} completed`;
      const payload = { kind: "system_message", itemId: sourceId, text: bound(text, 16_384), level: "info" };
      items.set(sourceId, payload);
      return publish(payload, sourceId, at);
    }
    const payload = { kind: "unknown_pi_event", piType: bound(entry.type, 4_096), summary: `Unsupported canonical Pi entry (${entry.type})` };
    items.set(sourceId, payload);
    return publish(payload, sourceId, at);
  }

  /** @param {Record<string, any>} frame */
  function consumeFrame(frame) {
    if (record(frame) === undefined || typeof frame.type !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi frame requires a type");
    const frameIndex = ++liveIndex;
    const sourceId = typeof frame.id === "string" && frame.id.length > 0 ? frame.id : deterministicId("live-source", { index: frameIndex, type: frame.type });
    const at = timestamp(frame.timestamp) ?? timestamp(frame.message?.timestamp) ?? now();
    if (frame.type === "response") {
      if (frame.success !== true || !["get_state", "set_model", "cycle_model"].includes(frame.command)) return [];
      if (frame.command === "cycle_model" && frame.data === null) return [];
      const state = record(frame.data);
      if (state === undefined) incompatible("PI_REQUIRED_SHAPE", `Pi ${frame.command} response requires data`);
      const output = [];
      const nextModel = frame.command === "set_model" ? state : record(state.model);
      const provider = nextModel === undefined ? null : typeof nextModel.provider === "string" ? nextModel.provider : null;
      const id = nextModel === undefined ? null : typeof nextModel.id === "string" ? nextModel.id : null;
      model = provider === null || id === null ? null : { provider, id };
      output.push(...publish({ kind: "model_state", provider, model: id }, `${sourceId}:model`, at));
      if (frame.command === "get_state" || typeof state.thinkingLevel === "string") {
        thinkingLevel = typeof state.thinkingLevel === "string" ? state.thinkingLevel : null;
        output.push(...publish({ kind: "thinking_state", level: thinkingLevel }, `${sourceId}:thinking`, at));
      }
      if (state.isCompacting === true) output.push(...replaceActivity("compacting", "Compacting context", sourceId));
      else if (state.isStreaming === true) output.push(...replaceActivity("assistant_streaming", "Assistant streaming", sourceId));
      return output;
    }
    if (frame.type === "message_start") {
      if (frame.message?.role === "assistant") {
        const itemId = deterministicId("live-assistant", { timestamp: timestamp(frame.message.timestamp) ?? at, index: liveIndex + 1 });
        currentAssistant = { itemId, blocks: [], delta: 0 };
        return [];
      }
      if (frame.message?.role === "user") {
        const itemId = deterministicId("live-user", { timestamp: timestamp(frame.message.timestamp) ?? at, content: frame.message.content });
        return consumeMessage(frame.message, itemId, at, `${itemId}:final`);
      }
      return [];
    }
    if (frame.type === "message_update") {
      const update = record(frame.assistantMessageEvent);
      if (update === undefined || typeof update.type !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi message update requires assistantMessageEvent");
      currentAssistant ??= { itemId: deterministicId("live-assistant", { at, index: liveIndex + 1 }), blocks: [], delta: 0 };
      const output = [];
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        if (typeof update.delta !== "string" || !Number.isSafeInteger(update.contentIndex) || update.contentIndex < 0) incompatible("PI_REQUIRED_SHAPE", "Pi assistant delta requires text and a non-negative content index");
        currentAssistant.delta += 1;
        const blockType = update.type === "thinking_delta" ? "thinking" : "text";
        const block = currentAssistant.blocks[update.contentIndex] ?? { type: blockType, text: "" };
        block.type = blockType;
        block.text = bound(`${block.text}${update.delta}`, MAX_TEXT_BYTES);
        currentAssistant.blocks[update.contentIndex] = block;
        const partial = { kind: "assistant_message", itemId: currentAssistant.itemId, content: currentAssistant.blocks.filter(Boolean).map((/** @type {any} */ entry) => ({ ...entry })) };
        items.set(currentAssistant.itemId, partial);
        const deltaId = deterministicId("assistant-delta", { itemId: currentAssistant.itemId, contentIndex: update.contentIndex, type: update.type, cumulative: block.text });
        output.push(...publish({ kind: "assistant_delta", itemId: currentAssistant.itemId, delta: bound(update.delta, MAX_TEXT_BYTES) }, deltaId, at));
        output.push(...publish(partial, `${deltaId}:partial`, at));
        output.push(...replaceActivity(update.type === "thinking_delta" ? "thinking" : "assistant_streaming", update.type === "thinking_delta" ? "Thinking" : "Assistant streaming", deltaId));
      } else if (update.type === "toolcall_start") {
        if (typeof update.id !== "string" || typeof update.toolName !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi tool-call start requires id and toolName");
        const tool = { id: update.id, name: bound(update.toolName, 256), state: "pending", arguments: {}, startedAt: at };
        noteTool(tool);
        output.push(...publish({ kind: "tool_started", tool }, `${sourceId}:tool:${tool.id}`, at));
        output.push(...replaceActivity("tool_pending", `Preparing ${tool.name}`, sourceId, { toolCallId: tool.id }));
      }
      return output;
    }
    if (frame.type === "message_end") {
      if (frame.message?.role !== "assistant") return frame.message === undefined ? [] : consumeMessage(frame.message, deterministicId("live-message", frame.message), at, deterministicId("live-final", frame.message));
      const itemId = currentAssistant?.itemId ?? deterministicId("live-assistant", { timestamp: timestamp(frame.message.timestamp) ?? at, content: frame.message.content });
      currentAssistant = undefined;
      return consumeMessage(frame.message, itemId, at, `${itemId}:final`);
    }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(frame.type)) {
      if (typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") incompatible("PI_REQUIRED_SHAPE", `Pi ${frame.type} requires toolCallId and toolName`);
      const prior = tools.get(frame.toolCallId);
      if (frame.type === "tool_execution_start") {
        const tool = { id: frame.toolCallId, name: bound(frame.toolName, 256), state: "running", arguments: safeArguments(frame.args), startedAt: at };
        noteTool(tool);
        return [...publish({ kind: "tool_started", tool }, `${sourceId}:tool:${tool.id}:started`, at), ...replaceActivity("tool_running", `Running ${tool.name}`, sourceId, { toolCallId: tool.id })];
      }
      const source = frame.type === "tool_execution_update" ? frame.partialResult?.content : frame.result?.content;
      const normalized = normalizeContent(source ?? [], frame.toolCallId);
      /** @type {any} */
      const tool = { id: frame.toolCallId, name: bound(frame.toolName, 256), state: frame.type === "tool_execution_update" ? "streaming" : frame.isError === true ? "failed" : "completed", arguments: prior?.arguments ?? safeArguments(frame.args), startedAt: prior?.startedAt ?? at, result: normalized.content };
      if (frame.type === "tool_execution_end") tool.finishedAt = at;
      if (frame.isError === true) tool.error = bound(normalized.content.filter((/** @type {any} */ block) => block.type === "text").map((/** @type {any} */ block) => block.text).join("\n") || "Tool failed", MAX_SUMMARY_BYTES);
      noteTool(tool);
      const kind = frame.type === "tool_execution_update" ? "tool_updated" : "tool_finished";
      const phase = frame.type === "tool_execution_update" ? "tool_streaming" : frame.isError === true ? "error" : "thinking";
      return [...publish({ kind, tool }, `${sourceId}:tool:${tool.id}:${kind}`, at), ...replaceActivity(phase, frame.isError === true ? `${tool.name} failed` : frame.type === "tool_execution_update" ? `Streaming ${tool.name}` : `${tool.name} completed`, sourceId, { toolCallId: tool.id })];
    }
    if (frame.type === "extension_ui_request") {
      if (!DIALOG_METHODS.has(frame.method)) {
        return publish({ kind: "unknown_pi_event", piType: "extension_ui_request", summary: `Unsupported fire-and-forget Pi UI method (${requiredString(frame.method, "unknown")})` }, sourceId, at);
      }
      if (typeof frame.id !== "string" || typeof frame.title !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi UI request requires id and title");
      /** @type {any} */
      const request = { id: frame.id, method: frame.method, title: bound(frame.title, 4_096) };
      if (frame.method === "select") {
        if (!Array.isArray(frame.options) || frame.options.some((option) => typeof option !== "string")) incompatible("PI_REQUIRED_SHAPE", "Pi select UI request requires string options");
        request.options = frame.options.map((option) => bound(option, 4_096));
      }
      const initial = frame.prefill ?? frame.placeholder;
      if (typeof initial === "string") request.initialValue = bound(initial, 16_384);
      pendingUi.set(request.id, request);
      return [...publish({ kind: "pending_ui_request", request }, `${sourceId}:request`, at), ...replaceActivity("waiting", "Waiting for input", sourceId)];
    }
    if (frame.type === "extension_ui_resolved") {
      if (typeof frame.id !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi UI resolution requires id");
      if (!pendingUi.has(frame.id)) return [];
      pendingUi.delete(frame.id);
      return [...publish({ kind: "ui_resolved", requestId: frame.id }, `${sourceId}:resolved`, at), ...replaceActivity("thinking", "Continuing", sourceId)];
    }
    if (frame.type === "thinking_level_changed") {
      if (typeof frame.level !== "string") incompatible("PI_REQUIRED_SHAPE", "Pi thinking-level change requires level");
      thinkingLevel = frame.level;
      return publish({ kind: "thinking_state", level: thinkingLevel }, `${sourceId}:thinking`, at);
    }
    if (frame.type === "agent_start") return [...publish({ kind: "turn_state", working: true }, `${sourceId}:turn`, at), ...replaceActivity("thinking", "Thinking", sourceId)];
    if (frame.type === "agent_settled") return [...publish({ kind: "turn_state", working: false }, `${sourceId}:turn`, at), ...replaceActivity("idle", "Idle", sourceId)];
    if (frame.type === "compaction_start") return replaceActivity("compacting", "Compacting context", sourceId);
    if (frame.type === "compaction_end") return replaceActivity(frame.errorMessage ? "error" : "thinking", frame.errorMessage ? "Compaction failed" : "Compaction complete", sourceId, frame.errorMessage ? { detail: bound(frame.errorMessage, MAX_SUMMARY_BYTES) } : {});
    if (frame.type === "auto_retry_start" || frame.type === "summarization_retry_scheduled") return replaceActivity("retrying", `Retrying (attempt ${Number.isSafeInteger(frame.attempt) ? frame.attempt : "?"})`, sourceId, { ...(Number.isSafeInteger(frame.delayMs) ? { retryAt: new Date(Date.parse(at) + frame.delayMs).toISOString() } : {}), ...(typeof frame.errorMessage === "string" ? { detail: bound(frame.errorMessage, MAX_SUMMARY_BYTES) } : {}) });
    if (frame.type === "queue_update") return replaceActivity("waiting", "Queued work waiting", sourceId);
    if (frame.type === "interrupt_requested") return replaceActivity("interrupting", "Interrupting", sourceId);
    if (frame.type === "stop_requested") return replaceActivity("stopping", "Stopping", sourceId);
    if (frame.type === "extension_error") return replaceActivity("error", "Pi extension error", sourceId, typeof frame.error === "string" ? { detail: bound(frame.error, MAX_SUMMARY_BYTES) } : {});
    if (["agent_end", "turn_start", "turn_end", "text_start", "text_end", "thinking_start", "thinking_end", "toolcall_delta", "toolcall_end", "bash_execution_update", "auto_retry_end", "summarization_retry_attempt_start", "summarization_retry_finished"].includes(frame.type)) return [];
    const summary = frame.type === "pi_dashboard_frame_queue_overflow"
      ? `Pi frame queue overflow: ${Number.isSafeInteger(frame.droppedFrames) ? frame.droppedFrames : "unknown"} frames omitted`
      : `Unsupported optional Pi event (${frame.type})`;
    return publish({ kind: "unknown_pi_event", piType: bound(frame.type, 4_096), summary: bound(summary, MAX_SUMMARY_BYTES) }, sourceId, at);
  }

  /** Apply one already-durable event while reconstructing normalizer state. @param {any} event */
  function applyViewerEvent(event) {
    if (event?.sessionId !== sessionId || typeof event.eventId !== "string" || record(event.payload) === undefined) incompatible("INVALID_VIEWER_EVENT", "Durable viewer event does not match the normalizer session");
    const payload = event.payload;
    emitted.set(event.eventId, canonical(payload));
    if (["user_message", "assistant_message", "system_message"].includes(payload.kind)) {
      items.set(payload.itemId, payload);
      if (payload.kind === "assistant_message" && currentAssistant?.itemId === payload.itemId) currentAssistant = undefined;
    } else if (["image_placeholder", "file_placeholder"].includes(payload.kind)) items.set(payload.attachment.id, payload);
    else if (payload.kind === "unknown_pi_event") items.set(event.eventId, payload);
    else if (payload.kind === "assistant_delta") {
      if (currentAssistant?.itemId !== payload.itemId) currentAssistant = { itemId: payload.itemId, blocks: [], delta: 0 };
      const block = currentAssistant.blocks[0] ?? { type: "text", text: "" };
      block.text = bound(`${block.text}${payload.delta}`, MAX_TEXT_BYTES);
      currentAssistant.blocks[0] = block;
      currentAssistant.delta += 1;
      items.set(payload.itemId, { kind: "assistant_message", itemId: payload.itemId, content: currentAssistant.blocks.filter(Boolean).map((/** @type {any} */ entry) => ({ ...entry })) });
    } else if (["tool_started", "tool_updated", "tool_finished"].includes(payload.kind)) noteTool(payload.tool);
    else if (payload.kind === "pending_ui_request") pendingUi.set(payload.request.id, payload.request);
    else if (payload.kind === "ui_resolved") pendingUi.delete(payload.requestId);
    else if (payload.kind === "model_state") model = payload.provider === null || payload.model === null ? null : { provider: payload.provider, id: payload.model };
    else if (payload.kind === "thinking_state") thinkingLevel = payload.level;
    else if (payload.kind === "activity") activity = payload;
  }

  /** Restore one validated published snapshot before applying newer durable events. @param {any} restored */
  function restore(restored) {
    if (restored?.sessionId !== sessionId) incompatible("VIEWER_SESSION_MISMATCH", "Viewer snapshot does not match the normalizer session");
    items.clear(); tools.clear(); pendingUi.clear(); errors.splice(0);
    for (const item of restored.items) items.set(item.itemId ?? item.attachment?.id ?? deterministicId("restored-item", item), item);
    for (const tool of restored.tools) noteTool(tool);
    for (const request of restored.pendingUi) pendingUi.set(request.id, request);
    errors.push(...restored.errors);
    model = restored.model;
    thinkingLevel = restored.thinkingLevel;
    activity = restored.activity;
    currentAssistant = undefined;
    if (restored.activeAssistant !== undefined) restoreCheckpoint({ activeAssistant: restored.activeAssistant });
    else if (["assistant_streaming", "thinking"].includes(activity.phase)) {
      const assistants = restored.items.filter((/** @type {any} */ item) => item.kind === "assistant_message");
      const partial = assistants.at(-1);
      if (partial !== undefined) currentAssistant = { itemId: partial.itemId, blocks: partial.content.map((/** @type {any} */ block) => ({ ...block })), delta: 0 };
    }
  }

  /** Add one bounded canonical-history error to snapshot state. @param {any} error */
  function consumeError(error) {
    const candidate = { code: requiredString(error?.code, "SESSION_HISTORY_PARSE_ERROR"), message: bound(typeof error?.message === "string" ? error.message : "Canonical session history could not be parsed", MAX_SUMMARY_BYTES), retryable: error?.retryable === true };
    if (!errors.some((current) => canonical(current) === canonical(candidate))) errors.push(candidate);
  }

  /** @param {any} runtimeState */
  function snapshot(runtimeState) {
    const cursor = { daemonEpoch: runtimeState.daemonEpoch, sessionId, sequence: runtimeState.sequence };
    return {
      version: 1,
      sessionId,
      registryRevision: runtimeState.registryRevision,
      cursor,
      runtime: runtimeState.runtime ?? null,
      role: runtimeState.role ?? "observer",
      taskState: runtimeState.taskState,
      processState: runtimeState.processState,
      outcome: runtimeState.outcome,
      activity,
      model: model ?? runtimeState.model ?? null,
      thinkingLevel: thinkingLevel ?? runtimeState.thinkingLevel ?? null,
      items: [...items.values()],
      tools: [...tools.values()],
      pendingUi: [...pendingUi.values()],
      errors: [...errors],
    };
  }

  return { consumeHistory, consumeFrame, applyViewerEvent, restore, checkpoint, restoreCheckpoint, consumeError, snapshot };
}
