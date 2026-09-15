import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { TranscriptModel, applyViewerEvent, createTranscriptState } from "./transcript.mjs";

const activity = { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "snapshot", startedAt: "2026-08-25T00:00:00Z" };
const snapshot = { items: [{ kind: "user_message", itemId: "u", content: [{ type: "text", text: "hello" }] }], tools: [], activity, pendingUi: [], errors: [], taskState: "READY", processState: "LIVE", outcome: "NONE", model: null, thinkingLevel: null };
const event = (payload, sequence = "1") => ({ eventId: `e-${sequence}`, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence }, timestamp: "2026-08-25T00:00:01Z", payload });

describe("normalized transcript state", () => {
  it("coalesces streaming assistant markdown and records lifecycle, placeholders, unknown events, and status changes", () => {
    let state = createTranscriptState(snapshot);
    const payloads = [
      { kind: "assistant_delta", itemId: "a", delta: "**hel" }, { kind: "assistant_delta", itemId: "a", delta: "lo**" },
      { kind: "thinking_state", level: "high" }, { kind: "model_state", provider: "anthropic", model: "opus" },
      { kind: "system_message", itemId: "retry", text: "Retrying in 4s", level: "warning" },
      { kind: "image_placeholder", attachment: { id: "image", path: "safe.png", mediaType: "image/png", width: 10, height: 5 } },
      { kind: "file_placeholder", attachment: { id: "file", path: "safe.txt", size: 12 } },
      { kind: "unknown_pi_event", piType: "future", summary: "Future activity" },
      { kind: "activity", phase: "compacting", label: "Compacting context", sourceEventId: "source", startedAt: "2026-08-25T00:00:01Z" },
    ];
    payloads.forEach((payload, index) => { state = applyViewerEvent(state, event(payload, String(index + 1))); });
    expect(state.items.find((item) => item.itemId === "a")?.content).toEqual([{ type: "text", text: "**hello**" }]);
    expect(state.items.map((item) => item.kind)).toEqual(expect.arrayContaining(["system_message", "image_placeholder", "file_placeholder", "unknown_pi_event"]));
    expect(state).toMatchObject({ model: { provider: "anthropic", id: "opus" }, thinkingLevel: "high", activity: { phase: "compacting" } });
  });

});

// The viewport itself belongs to Pi's ScrollView now; test/native-viewport.acceptance.test.mjs drives
// it through a real terminal. What is left here is the document that scroll view is given.
describe("transcript document", () => {
  const tallItems = (count, rows) => Array.from({ length: count }, (_, index) => ({ kind: "system_message", itemId: `i-${index}`, text: `item ${index}`, level: "info", rows }));
  const tallAdapters = () => ({ component: vi.fn((item) => ({ render: () => Array.from({ length: item.rows }, (_, row) => `${item.itemId}:${row}`) })) });

  it("renders every line of every block, oldest first", () => {
    const state = createTranscriptState({ ...snapshot, items: tallItems(3, 10) });
    const transcript = new TranscriptModel({ state, adapters: tallAdapters() });
    const lines = transcript.render(80);
    expect(lines).toHaveLength(30);
    expect(lines.at(0)).toBe("i-0:0");
    expect(lines.at(-1)).toBe("i-2:9");
  });

  it("grows by the new block when an event appends one", () => {
    let state = createTranscriptState({ ...snapshot, items: tallItems(3, 10) });
    const transcript = new TranscriptModel({ state, adapters: tallAdapters() });
    expect(transcript.render(80)).toHaveLength(30);
    state = applyViewerEvent(state, event({ kind: "system_message", itemId: "fresh", text: "fresh", level: "info" }));
    state.items.at(-1).rows = 4;
    transcript.update(state);
    const lines = transcript.render(80);
    expect(lines).toHaveLength(34);
    expect(lines.slice(-4)).toEqual(["fresh:0", "fresh:1", "fresh:2", "fresh:3"]);
  });

  it("renders each block once and reuses it until its item, width or options change", () => {
    const adapters = tallAdapters();
    const state = createTranscriptState({ ...snapshot, items: tallItems(40, 10) });
    const transcript = new TranscriptModel({ state, adapters });
    transcript.render(80);
    expect(adapters.component).toHaveBeenCalledTimes(40);
    transcript.render(80);
    expect(adapters.component).toHaveBeenCalledTimes(40);
    transcript.render(60);
    expect(adapters.component).toHaveBeenCalledTimes(80);
  });

  it("keeps every rendered line inside the width it was given", () => {
    const adapters = { component: vi.fn((item) => ({ render: vi.fn(() => [`${item.itemId} ${"wide ".repeat(40)}`]) })) };
    const state = createTranscriptState({ ...snapshot, items: Array.from({ length: 100 }, (_, index) => ({ kind: "system_message", itemId: `i-${index}`, text: `line ${index}`, level: "info" })) });
    const transcript = new TranscriptModel({ state, adapters });
    const lines = transcript.render(80);
    expect(lines).toHaveLength(100);
    expect(lines.every((line) => visibleWidth(stripVTControlCharacters(line)) <= 80)).toBe(true);
  });
});
