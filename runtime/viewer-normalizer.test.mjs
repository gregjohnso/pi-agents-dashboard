import { describe, expect, it } from "vitest";

import { parseViewerEvent, parseViewerSnapshot } from "../shared/viewer-contracts.mjs";
import { ViewerNormalizerError, createViewerNormalizer } from "./viewer-normalizer.mjs";

const AT = "2026-08-25T00:00:00.000Z";
const position = (/** @type {number} */ line) => ({ line, byteStart: line * 100, byteEnd: line * 100 + 99, sourceId: `source-${line}` });
const normalizer = () => createViewerNormalizer({ sessionId: "session-1", protocolVersion: 1, now: () => AT });

/** @param {any[]} events */
function assertPayloads(events) {
  for (const [index, event] of events.entries()) {
    expect(() => parseViewerEvent({ version: 1, sessionId: "session-1", eventId: event.eventId, cursor: { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: String(index + 1) }, timestamp: event.timestamp, payload: event.payload })).not.toThrow();
  }
}

describe("viewer normalizer", () => {
  it("normalizes canonical public history, preserves Pi IDs, and replaces private attachment bytes with placeholders", () => {
    const subject = normalizer();
    const user = { type: "message", id: "pi-user", timestamp: AT, message: { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", data: "private-base64", mimeType: "image/png" }], attachments: [{ id: "file-1", type: "file", fileName: "notes.txt", mimeType: "text/plain", size: 12, content: "private-file" }] } };
    const assistant = { type: "message", id: "pi-assistant", timestamp: AT, message: { role: "assistant", content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: "answer" }, { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "notes.txt" } }] } };
    const result = { type: "message", id: "pi-result", timestamp: AT, message: { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false } };
    const events = [
      ...subject.consumeHistory(user, position(1)),
      ...subject.consumeHistory(assistant, position(2)),
      ...subject.consumeHistory(result, position(3)),
      ...subject.consumeHistory({ type: "custom_message", id: "custom-1", timestamp: AT, customType: "ext", content: "visible", display: true }, position(4)),
      ...subject.consumeHistory({ type: "compaction", id: "compact-1", timestamp: AT, summary: "summary", tokensBefore: 100 }, position(5)),
    ];

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: "pi-user", payload: expect.objectContaining({ kind: "user_message", itemId: "pi-user" }) }),
      expect.objectContaining({ eventId: "pi-assistant", payload: expect.objectContaining({ kind: "assistant_message", itemId: "pi-assistant", content: [{ type: "thinking", text: "reason" }, { type: "text", text: "answer" }] }) }),
      expect.objectContaining({ payload: expect.objectContaining({ kind: "tool_started", tool: expect.objectContaining({ id: "tool-1", name: "read" }) }) }),
      expect.objectContaining({ payload: expect.objectContaining({ kind: "tool_finished", tool: expect.objectContaining({ id: "tool-1", state: "completed" }) }) }),
      expect.objectContaining({ payload: expect.objectContaining({ kind: "image_placeholder", attachment: expect.objectContaining({ mediaType: "image/png" }) }) }),
      expect.objectContaining({ payload: { kind: "file_placeholder", attachment: { id: "file-1", path: "notes.txt", mediaType: "text/plain", size: 12 } } }),
      expect.objectContaining({ payload: expect.objectContaining({ kind: "system_message", level: "info" }) }),
    ]));
    expect(JSON.stringify(events)).not.toContain("private-base64");
    expect(JSON.stringify(events)).not.toContain("private-file");
    assertPayloads(events);
  });

  it("creates deterministic bounded fallback IDs and deduplicates history/live overlap", () => {
    const entry = { type: "message", timestamp: AT, message: { role: "user", content: "same" } };
    const first = normalizer();
    const second = normalizer();
    const history = first.consumeHistory(entry, position(8));
    expect(second.consumeHistory(entry, position(8))).toEqual(history);
    expect(history[0].eventId).toMatch(/^viewer-/u);
    expect(first.consumeFrame({ type: "message_end", message: entry.message })).toEqual([]);
  });

  it("keeps distinct stable canonical messages even when their content and timestamps match", () => {
    const subject = normalizer();
    const message = { role: "user", content: "same" };
    const first = subject.consumeHistory({ type: "message", id: "stable-one", timestamp: AT, message }, position(20));
    const second = subject.consumeHistory({ type: "message", id: "stable-two", timestamp: AT, message }, position(21));
    expect([...first, ...second].filter((event) => event.payload.kind === "user_message").map((event) => event.payload.itemId)).toEqual(["stable-one", "stable-two"]);
    expect(subject.consumeFrame({ type: "message_end", message })).toEqual([]);
  });

  it("assembles assistant deltas into one stable item and treats final content as authoritative and idempotent", () => {
    const subject = normalizer();
    expect(subject.consumeFrame({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.parse(AT) } })).toEqual([]);
    const first = subject.consumeFrame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" } });
    const second = subject.consumeFrame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } });
    const finalFrame = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: Date.parse(AT) } };
    const final = subject.consumeFrame(finalFrame);
    expect(first[0].payload).toMatchObject({ kind: "assistant_delta", delta: "hel" });
    expect(second[0].payload).toMatchObject({ kind: "assistant_delta", itemId: first[0].payload.itemId, delta: "lo" });
    expect(first[1].payload).toEqual({ kind: "assistant_message", itemId: first[0].payload.itemId, content: [{ type: "text", text: "hel" }] });
    expect(second[1].payload).toEqual({ kind: "assistant_message", itemId: first[0].payload.itemId, content: [{ type: "text", text: "hello" }] });
    expect(final[0].payload).toEqual({ kind: "assistant_message", itemId: first[0].payload.itemId, content: [{ type: "text", text: "hello" }] });
    expect(subject.consumeFrame(finalFrame)).toEqual([]);
    assertPayloads([...first, ...second, ...final]);
  });

  it("publishes authoritative partial messages that preserve thinking and text block identity in frozen v1", () => {
    const subject = normalizer();
    subject.consumeFrame({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.parse(AT) } });
    const thinking = subject.consumeFrame({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reason" } });
    const text = subject.consumeFrame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "answer" } });
    expect(thinking[1].payload).toEqual({ kind: "assistant_message", itemId: thinking[0].payload.itemId, content: [{ type: "thinking", text: "reason" }] });
    expect(text[1].payload).toEqual({ kind: "assistant_message", itemId: thinking[0].payload.itemId, content: [{ type: "thinking", text: "reason" }, { type: "text", text: "answer" }] });
    assertPayloads([...thinking, ...text]);
  });

  it("records each tool's chronological position between messages in the snapshot", () => {
    const subject = normalizer();
    subject.consumeFrame({ type: "message_end", message: { role: "user", content: "run it", timestamp: 1 } });
    subject.consumeFrame({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "pwd" } });
    subject.consumeFrame({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { content: [{ type: "text", text: "/repo" }] }, isError: false });
    subject.consumeFrame({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } });

    const snapshot = subject.snapshot({ daemonEpoch: "epoch-1", sequence: "4", registryRevision: 1, runtime: null, role: "composer", taskState: "READY", processState: "LIVE", outcome: "NONE" });
    expect(snapshot.items.map((/** @type {any} */ item) => item.kind)).toEqual(["user_message", "tool", "assistant_message"]);
    expect(snapshot.items[1]).toMatchObject({ kind: "tool", toolId: "tool-1" });
    expect(() => parseViewerSnapshot(snapshot)).not.toThrow();
  });

  it("keeps tool, pending UI, model, thinking, and replacement activity continuity", () => {
    const subject = normalizer();
    const events = /** @type {any[]} */ ([
      ...subject.consumeFrame({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "pwd" } }),
      ...subject.consumeFrame({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", args: { command: "pwd" }, partialResult: { content: [{ type: "text", text: "/repo" }] } }),
      ...subject.consumeFrame({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { content: [{ type: "text", text: "/repo" }] }, isError: false }),
      ...subject.consumeFrame({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Choose", options: ["a", "b"] }),
      ...subject.consumeFrame({ type: "extension_ui_resolved", id: "ui-1" }),
      ...subject.consumeFrame({ type: "response", command: "get_state", success: true, data: { model: { provider: "anthropic", id: "model-1" }, thinkingLevel: "high", isStreaming: false, isCompacting: false } }),
    ]);
    const tools = events.filter((event) => event.payload.kind.startsWith("tool_"));
    expect(tools.map((event) => event.payload.tool.id)).toEqual(["tool-1", "tool-1", "tool-1"]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ kind: "pending_ui_request", request: expect.objectContaining({ id: "ui-1" }) }) }),
      expect.objectContaining({ payload: { kind: "ui_resolved", requestId: "ui-1" } }),
      expect.objectContaining({ payload: { kind: "model_state", provider: "anthropic", model: "model-1" } }),
      expect.objectContaining({ payload: { kind: "thinking_state", level: "high" } }),
    ]));
    const snapshot = subject.snapshot({ daemonEpoch: "epoch-1", sequence: "99", registryRevision: 3, runtime: null, role: "composer", taskState: "READY", processState: "LIVE", outcome: "NONE" });
    expect(snapshot.tools).toEqual([expect.objectContaining({ id: "tool-1", state: "completed" })]);
    expect(snapshot.pendingUi).toEqual([]);
    expect(snapshot.model).toEqual({ provider: "anthropic", id: "model-1" });
    expect(snapshot.thinkingLevel).toBe("high");
    expect(() => parseViewerSnapshot(snapshot)).not.toThrow();
    assertPayloads(events);
  });

  it.each([
    ["agent_start", "thinking"], ["message_update", "assistant_streaming"], ["toolcall_start", "tool_pending"],
    ["tool_execution_start", "tool_running"], ["tool_execution_update", "tool_streaming"], ["compaction_start", "compacting"],
    ["auto_retry_start", "retrying"], ["extension_ui_request", "waiting"], ["interrupt_requested", "interrupting"],
    ["stop_requested", "stopping"], ["extension_error", "error"], ["agent_settled", "idle"],
  ])("maps %s to replacement activity %s", (type, phase) => {
    const subject = normalizer();
    const frame = type === "message_update" ? { type, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } }
      : type === "toolcall_start" ? { type: "message_update", assistantMessageEvent: { type, contentIndex: 0, id: "tool-1", toolName: "bash" } }
        : type.startsWith("tool_execution") ? { type, toolCallId: "tool-1", toolName: "bash", args: {}, partialResult: { content: [] } }
          : type === "extension_ui_request" ? { type, id: "ui-1", method: "confirm", title: "Confirm" }
            : type === "auto_retry_start" ? { type, attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "busy" }
              : type === "extension_error" ? { type, error: "failed", event: "turn" }
                : { type };
    const events = subject.consumeFrame(frame);
    expect(events.filter((event) => event.payload.kind === "activity").at(-1)?.payload.phase).toBe(phase);
  });

  it("never serializes image bytes from custom or fallback message roles", () => {
    const subject = normalizer();
    const content = [{ type: "text", text: "visible" }, { type: "image", data: "raw-base64-secret", mimeType: "image/png" }];
    const events = [
      ...subject.consumeHistory({ type: "custom_message", id: "custom-image", timestamp: AT, customType: "ext", content, display: true }, position(10)),
      ...subject.consumeHistory({ type: "message", id: "fallback-image", timestamp: AT, message: { role: "custom", content } }, position(11)),
    ];
    expect(JSON.stringify(events)).not.toContain("raw-base64-secret");
    expect(events.filter((event) => event.payload.kind === "image_placeholder")).toHaveLength(2);
    expect(events.filter((event) => event.payload.kind === "system_message").map((event) => event.payload.text)).toEqual(["visible", "visible"]);
    const toolEvents = subject.consumeFrame({ type: "tool_execution_start", toolCallId: "image-tool", toolName: "inspect", args: { image: { type: "image", data: "tool-base64-secret", mimeType: "image/png" } } });
    expect(JSON.stringify(toolEvents)).not.toContain("tool-base64-secret");
  });

  it("restores a partial streaming assistant with stable identity and distinct continuation events", () => {
    const first = normalizer();
    first.consumeFrame({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.parse(AT) } });
    const initial = first.consumeFrame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" } });
    const snapshot = first.snapshot({ daemonEpoch: "epoch-1", sequence: "2", registryRevision: 1, runtime: null, role: "observer", taskState: "WORKING", processState: "LIVE", outcome: "NONE" });
    const partial = snapshot.items.find((item) => item.kind === "assistant_message");
    expect(partial).toMatchObject({ content: [{ type: "text", text: "hel" }] });

    const restored = normalizer();
    restored.restore(snapshot);
    const continued = restored.consumeFrame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } });
    expect(continued[0].payload).toMatchObject({ kind: "assistant_delta", itemId: partial.itemId, delta: "lo" });
    expect(continued[0].eventId).not.toBe(initial[0].eventId);
    expect(restored.snapshot({ daemonEpoch: "epoch-1", sequence: "4", registryRevision: 1, runtime: null, role: "observer", taskState: "WORKING", processState: "LIVE", outcome: "NONE" }).items).toContainEqual({ kind: "assistant_message", itemId: partial.itemId, content: [{ type: "text", text: "hello" }] });
  });

  it("preserves exact active assistant blocks through non-streaming snapshots and durable replay", () => {
    const first = normalizer();
    first.consumeFrame({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.parse(AT) } });
    const drafts = [
      ...first.consumeFrame({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reason" } }),
      ...first.consumeFrame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "ans" } }),
      ...first.consumeFrame({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} }),
    ];
    const snapshot = first.snapshot({ daemonEpoch: "epoch-1", sequence: "5", registryRevision: 1, runtime: null, role: "observer", taskState: "WORKING", processState: "LIVE", outcome: "NONE" });
    expect(snapshot.activity.phase).toBe("tool_running");
    expect(snapshot).not.toHaveProperty("activeAssistant");
    expect(first.checkpoint()).toEqual({ activeAssistant: { itemId: drafts[0].payload.itemId, blocks: [{ contentIndex: 0, type: "thinking", text: "reason" }, { contentIndex: 2, type: "text", text: "ans" }] } });
    expect(() => parseViewerSnapshot(snapshot)).not.toThrow();
    for (const draft of drafts) expect(() => parseViewerEvent({ version: 1, sessionId: "session-1", eventId: draft.eventId, cursor: { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: "1" }, timestamp: draft.timestamp, payload: draft.payload })).not.toThrow();

    const fromSnapshot = normalizer();
    fromSnapshot.restore(snapshot);
    fromSnapshot.restoreCheckpoint(first.checkpoint());
    const replayed = normalizer();
    for (const [index, draft] of drafts.entries()) replayed.applyViewerEvent({ version: 1, sessionId: "session-1", eventId: draft.eventId, cursor: { daemonEpoch: "epoch-1", sessionId: "session-1", sequence: String(index + 1) }, timestamp: draft.timestamp, payload: draft.payload });
    replayed.restoreCheckpoint(drafts.at(-1)?.internalCheckpoint);
    expect(replayed.snapshot({ daemonEpoch: "epoch-1", sequence: "5", registryRevision: 1, runtime: null, role: "observer", taskState: "WORKING", processState: "LIVE", outcome: "NONE" }).items).toContainEqual({ kind: "assistant_message", itemId: drafts[0].payload.itemId, content: [{ type: "thinking", text: "reason" }, { type: "text", text: "ans" }] });
    for (const restored of [fromSnapshot, replayed]) {
      const continued = restored.consumeFrame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "wer" } });
      expect(continued[0].payload).toEqual({ kind: "assistant_delta", itemId: drafts[0].payload.itemId, delta: "wer" });
      expect(restored.checkpoint()).toEqual({ activeAssistant: { itemId: drafts[0].payload.itemId, blocks: [{ contentIndex: 0, type: "thinking", text: "reason" }, { contentIndex: 2, type: "text", text: "answer" }] } });
    }
  });

  it("maps documented model and thinking replacement frames", () => {
    const subject = normalizer();
    const events = [
      ...subject.consumeFrame({ type: "response", command: "set_model", success: true, data: { provider: "openai", id: "gpt-5" } }),
      ...subject.consumeFrame({ type: "response", command: "cycle_model", success: true, data: { model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high" } }),
      ...subject.consumeFrame({ type: "thinking_level_changed", level: "low" }),
    ];
    expect(events.filter((event) => event.payload.kind === "model_state").map((event) => event.payload)).toEqual([
      { kind: "model_state", provider: "openai", model: "gpt-5" },
      { kind: "model_state", provider: "anthropic", model: "claude" },
    ]);
    expect(events.filter((event) => event.payload.kind === "thinking_state").map((event) => event.payload.level)).toEqual(["high", "low"]);
    expect(subject.snapshot({ daemonEpoch: "epoch-1", sequence: "4", registryRevision: 1, runtime: null, role: "observer", taskState: "READY", processState: "LIVE", outcome: "NONE" })).toMatchObject({ model: { provider: "anthropic", id: "claude" }, thinkingLevel: "low" });
    expect(subject.consumeFrame({ type: "response", command: "cycle_model", success: true, data: null })).toEqual([]);
    expect(subject.snapshot({ daemonEpoch: "epoch-1", sequence: "4", registryRevision: 1, runtime: null, role: "observer", taskState: "READY", processState: "LIVE", outcome: "NONE" }).model).toEqual({ provider: "anthropic", id: "claude" });
    expect(() => normalizer().consumeFrame({ type: "response", command: "cycle_model", success: true, data: null })).not.toThrow();
  });

  it("bounds unknown optional events and reports malformed required shapes as typed session errors", () => {
    const subject = normalizer();
    const events = subject.consumeFrame({ type: "future_pi_event", secret: "x".repeat(100_000) });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual(expect.objectContaining({ kind: "unknown_pi_event", piType: "future_pi_event" }));
    expect(Buffer.byteLength(String(events[0].payload.summary))).toBeLessThanOrEqual(4096);
    expect(events[0].payload.summary).not.toContain("xxx");
    expect(() => subject.consumeFrame({ type: "tool_execution_start", toolName: "bash", args: {} })).toThrow(expect.objectContaining({ name: "ViewerNormalizerError", code: "PI_REQUIRED_SHAPE", sessionId: "session-1" }));
    expect(() => subject.consumeHistory({ type: "message", id: "bad", message: { role: "assistant" } }, position(9))).toThrow(ViewerNormalizerError);
  });
});
