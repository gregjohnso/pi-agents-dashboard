import { expect, it } from "vitest";

import { parseViewerEvent, parseViewerSnapshot } from "./viewer-contracts.mjs";

const base = { version: 1, sessionId: "session-1", eventId: "event-1", cursor: { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: "3" }, timestamp: "2026-08-25T00:00:00Z" };
const content = [{ type: "text", text: "hello" }, { type: "thinking", text: "reasoning" }, { type: "file", attachmentId: "file-1" }];
const attachment = { id: "file-1", path: "safe.txt", mediaType: "text/plain", size: 10 };
const tool = { id: "tool-1", name: "bash", state: "running", arguments: { command: "pwd" }, startedAt: "2026-08-25T00:00:00Z" };
const request = { id: "ui-1", method: "select", title: "Choose", options: ["a", "b"] };
const payloads = [
  { kind: "user_message", itemId: "u1", content },
  { kind: "assistant_delta", itemId: "a1", delta: "hel" },
  { kind: "assistant_message", itemId: "a1", content },
  { kind: "system_message", itemId: "s1", text: "retrying", level: "warning" },
  { kind: "tool_started", tool }, { kind: "tool_updated", tool }, { kind: "tool_finished", tool: { ...tool, state: "completed", result: content, finishedAt: "2026-08-25T00:00:01Z" } },
  { kind: "turn_state", working: true }, { kind: "pending_ui_request", request }, { kind: "ui_resolved", requestId: "ui-1" },
  { kind: "model_state", provider: "provider", model: "model" }, { kind: "thinking_state", level: "high" },
  { kind: "activity", phase: "tool_running", label: "Running bash", sourceEventId: "pi-event-1", startedAt: "2026-08-25T00:00:00Z", toolCallId: "tool-1" },
  { kind: "image_placeholder", attachment }, { kind: "file_placeholder", attachment },
  { kind: "unknown_pi_event", piType: "future", summary: "Unsupported Pi event" },
];

/** Every event shape the frozen version-1 viewer wire must refuse. @type {Array<[string, Record<string, any>, RegExp]>} */
const rejectedEvents = [
  ["internal assistant checkpoint metadata", { ...base, payload: { kind: "assistant_delta", itemId: "a1", delta: "hel", contentIndex: 0, contentType: "text" } }, /unknown/iu],
  ["unknown field inside message content", { ...base, payload: { kind: "user_message", itemId: "u", content: [{ type: "text", text: "x", unknown: true }] } }, /unknown/iu],
  ["invalid tool state", { ...base, payload: { kind: "tool_started", tool: { ...tool, state: "invalid" } } }, /state/iu],
  ["unknown UI request method", { ...base, payload: { kind: "pending_ui_request", request: { ...request, method: "unknown" } } }, /method/iu],
  ["activity without source identity", { ...base, payload: { kind: "activity", phase: "thinking", label: "Thinking", startedAt: base.timestamp } }, /sourceEventId/iu],
  ["activity label over 256 characters", { ...base, payload: { kind: "activity", phase: "thinking", label: "x".repeat(257), sourceEventId: "source", startedAt: base.timestamp } }, /label/iu],
  ["activity detail over 4096 characters", { ...base, payload: { kind: "activity", phase: "thinking", label: "Thinking", detail: "x".repeat(4097), sourceEventId: "source", startedAt: base.timestamp } }, /detail/iu],
  ["cursor bound to another session", { ...base, cursor: { ...base.cursor, sessionId: "other" }, payload: payloads[0] }, /session/iu],
  ["non-canonical cursor sequence", { ...base, cursor: { ...base.cursor, sequence: "03" }, payload: payloads[0] }, /sequence/iu],
];

it("accepts every frozen viewer payload and rejects unknown fields in each", () => {
  for (const payload of payloads) {
    expect(parseViewerEvent({ ...base, payload })).toEqual({ ...base, payload });
    expect(() => parseViewerEvent({ ...base, payload: { ...payload, unknown: true } }), `${payload.kind} with an unknown field`).toThrow(/unknown/iu);
  }
});

it("rejects every invalid viewer event shape", () => {
  for (const [name, event, message] of rejectedEvents) {
    expect(() => parseViewerEvent(event), name).toThrow(message);
  }
});

const snapshot = {
  version: 1, sessionId: "session-1", registryRevision: 4, cursor: base.cursor, runtime: null,
  taskState: "READY", processState: "SLEEPING", outcome: "COMPLETED",
  activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "snapshot-source", startedAt: "2026-08-25T00:00:00Z" },
  model: null, thinkingLevel: null, items: [payloads[0]], tools: [tool], pendingUi: [request], errors: [{ code: "WARN", message: "bounded", retryable: false }],
};

it("strictly parses the frozen version-1 viewer snapshot", () => {
  expect(parseViewerSnapshot(snapshot)).toEqual(snapshot);
  expect(() => parseViewerSnapshot({ ...snapshot, unknown: true })).toThrow(/unknown/iu);
  expect(() => parseViewerSnapshot({ ...snapshot, activeAssistant: { itemId: "a1", blocks: [{ contentIndex: 0, type: "text", text: "hel" }] } }), "internal assistant checkpoint state").toThrow(/unknown/iu);
});

// A snapshot is built for one response and never stored, so a key only an earlier release wrote is
// refused rather than accepted and dropped.
it("refuses the retired access role", () => {
  expect(() => parseViewerSnapshot({ ...snapshot, role: "composer" })).toThrow(/unknown/iu);
});
