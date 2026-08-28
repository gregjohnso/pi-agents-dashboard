import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { TranscriptModel, applyViewerEvent, createTranscriptState } from "./transcript.mjs";

const activity = { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "snapshot", startedAt: "2026-08-25T00:00:00Z" };
const snapshot = { items: [{ kind: "user_message", itemId: "u", content: [{ type: "text", text: "hello" }] }], tools: [], activity, pendingUi: [], errors: [], role: "composer", taskState: "READY", processState: "LIVE", outcome: "NONE", model: null, thinkingLevel: null };
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

describe("virtual transcript", () => {
  it("renders only visible blocks, pauses follow mode, and marks new activity", () => {
    const adapters = { component: vi.fn((item) => ({ render: vi.fn(() => [item.itemId ?? item.kind]) })) };
    const state = createTranscriptState({ ...snapshot, items: Array.from({ length: 100 }, (_, index) => ({ kind: "system_message", itemId: `i-${index}`, text: `line ${index}`, level: "info" })) });
    const transcript = new TranscriptModel({ state, adapters });
    transcript.setViewport(80, 5);
    transcript.scrollBy(-2);
    transcript.update(applyViewerEvent(state, event({ kind: "system_message", itemId: "new", text: "new", level: "info" })));
    const lines = transcript.render(80, 5);
    expect(lines).toHaveLength(5);
    expect(lines.map(stripVTControlCharacters).join("\n")).toContain("new activity");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(adapters.component).toHaveBeenCalledTimes(4);
  });
});
