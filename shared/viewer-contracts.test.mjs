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

it("accepts every frozen viewer payload and rejects unknown fields in each", () => {
  for (const payload of payloads) {
    expect(parseViewerEvent({ ...base, payload })).toEqual({ ...base, payload });
    expect(() => parseViewerEvent({ ...base, payload: { ...payload, unknown: true } })).toThrow(/unknown/i);
  }
});

it("rejects internal assistant checkpoint metadata on frozen v1 wire shapes", () => {
  expect(() => parseViewerEvent({ ...base, payload: { kind: "assistant_delta", itemId: "a1", delta: "hel", contentIndex: 0, contentType: "text" } })).toThrow(/unknown/i);
  const snapshot = {
    version: 1, sessionId: "session-1", registryRevision: 1, cursor: base.cursor, runtime: null, role: "observer", taskState: "READY", processState: "SLEEPING", outcome: "NONE",
    activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "source", startedAt: base.timestamp }, model: null, thinkingLevel: null, items: [], tools: [], pendingUi: [], errors: [],
    activeAssistant: { itemId: "a1", blocks: [{ contentIndex: 0, type: "text", text: "hel" }] },
  };
  expect(() => parseViewerSnapshot(snapshot)).toThrow(/unknown/i);
});

it("strictly validates nested content, tools, attachments, and UI requests", () => {
  expect(() => parseViewerEvent({ ...base, payload: { kind: "user_message", itemId: "u", content: [{ type: "text", text: "x", unknown: true }] } })).toThrow(/unknown/i);
  expect(() => parseViewerEvent({ ...base, payload: { kind: "tool_started", tool: { ...tool, state: "invalid" } } })).toThrow(/state/i);
  expect(() => parseViewerEvent({ ...base, payload: { kind: "pending_ui_request", request: { ...request, method: "unknown" } } })).toThrow(/method/i);
});

it("requires source identity and bounds viewer activity text", () => {
  expect(() => parseViewerEvent({ ...base, payload: { kind: "activity", phase: "thinking", label: "Thinking", startedAt: base.timestamp } })).toThrow(/sourceEventId/i);
  expect(() => parseViewerEvent({ ...base, payload: { kind: "activity", phase: "thinking", label: "x".repeat(257), sourceEventId: "source", startedAt: base.timestamp } })).toThrow(/label/i);
  expect(() => parseViewerEvent({ ...base, payload: { kind: "activity", phase: "thinking", label: "Thinking", detail: "x".repeat(4097), sourceEventId: "source", startedAt: base.timestamp } })).toThrow(/detail/i);
});

it("binds every cursor to the exact viewer session", () => {
  expect(() => parseViewerEvent({ ...base, cursor: { ...base.cursor, sessionId: "other" }, payload: payloads[0] })).toThrow(/session/i);
  expect(() => parseViewerEvent({ ...base, cursor: { ...base.cursor, sequence: "03" }, payload: payloads[0] })).toThrow(/sequence/i);
});

it("strictly parses the frozen version-1 viewer snapshot", () => {
  const snapshot = {
    version: 1, sessionId: "session-1", registryRevision: 4, cursor: base.cursor, runtime: null, role: "observer",
    taskState: "READY", processState: "SLEEPING", outcome: "COMPLETED",
    activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "snapshot-source", startedAt: "2026-08-25T00:00:00Z" },
    model: null, thinkingLevel: null, items: [payloads[0]], tools: [tool], pendingUi: [request], errors: [{ code: "WARN", message: "bounded", retryable: false }],
  };
  expect(parseViewerSnapshot(snapshot)).toEqual(snapshot);
  expect(() => parseViewerSnapshot({ ...snapshot, unknown: true })).toThrow(/unknown/i);
});
