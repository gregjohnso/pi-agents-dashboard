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

  it("updates tools through pending, running, streaming, completed, failed, and expansion states", () => {
    let state = createTranscriptState(snapshot);
    const tool = { id: "t", name: "bash", state: "pending", arguments: { command: "pytest" }, startedAt: "2026-08-25T00:00:00Z" };
    for (const [index, toolState] of ["pending", "running", "streaming", "completed", "failed"].entries()) {
      const current = { ...tool, state: toolState, ...(toolState === "completed" ? { result: [{ type: "text", text: "passed" }], finishedAt: "2026-08-25T00:00:02Z" } : {}), ...(toolState === "failed" ? { error: "failed", finishedAt: "2026-08-25T00:00:03Z" } : {}) };
      state = applyViewerEvent(state, event({ kind: index === 0 ? "tool_started" : index === 4 ? "tool_finished" : "tool_updated", tool: current }, String(index + 1)));
      expect(state.tools.get("t")?.state).toBe(toolState);
    }
  });
});

describe("virtual transcript", () => {
  it("starts every tool card collapsed the way Pi does", () => {
    const adapters = { component: vi.fn((item) => ({ render: () => [item.itemId ?? item.kind], setExpanded() {} })) };
    const state = createTranscriptState({ ...snapshot, tools: [{ id: "t", name: "bash", state: "failed", arguments: {}, error: "boom", startedAt: "2026-08-25T00:00:00Z", finishedAt: "2026-08-25T00:00:01Z" }] });
    expect([...new TranscriptModel({ state, adapters }).expandedTools]).toEqual([]);
  });

  it("opens every user turn after the first with Pi's turn spacer", () => {
    const adapters = { component: vi.fn((item) => ({ render: () => [item.itemId ?? item.kind] })) };
    let state = createTranscriptState(snapshot);
    state = applyViewerEvent(state, event({ kind: "assistant_message", itemId: "a", content: [{ type: "text", text: "answer" }] }, "2"));
    state = applyViewerEvent(state, event({ kind: "user_message", itemId: "u2", content: [{ type: "text", text: "again" }] }, "3"));
    const transcript = new TranscriptModel({ state, adapters });
    expect(transcript.render(40, 5)).toEqual(["", "u", "a", "", "u2"]);
  });

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

describe("transcript scroll anchors", () => {
  const adapters = { component: vi.fn((item) => ({ render: () => [item.itemId ?? item.kind] })) };
  const longState = () => createTranscriptState({ ...snapshot, items: Array.from({ length: 50 }, (_, index) => ({ kind: "system_message", itemId: `i-${index}`, text: `line ${index}`, level: "info" })) });

  it("jumps to the start and detaches follow", () => {
    const transcript = new TranscriptModel({ state: longState(), adapters });
    transcript.setViewport(80, 5);
    transcript.scrollToStart();
    expect(transcript.following).toBe(false);
    expect(transcript.distanceFromEnd).toBe(49);
    const atStart = transcript.render(80, 5).map(stripVTControlCharacters);
    expect(atStart.join("\n")).toContain("i-0");
    expect(atStart.join("\n")).not.toContain("i-49");
  });

  it("jumps to the end, resumes follow, and clears the activity marker", () => {
    const transcript = new TranscriptModel({ state: longState(), adapters });
    transcript.setViewport(80, 5);
    transcript.scrollToStart();
    transcript.update(applyViewerEvent(transcript.state, event({ kind: "system_message", itemId: "fresh", text: "fresh", level: "info" })));
    expect(transcript.newActivity).toBe(true);
    transcript.scrollToEnd();
    expect(transcript.following).toBe(true);
    expect(transcript.newActivity).toBe(false);
    expect(stripVTControlCharacters(transcript.render(80, 5).join("\n"))).not.toContain("new activity");
  });

  it("resumes follow when scrolling back down to the end", () => {
    const transcript = new TranscriptModel({ state: longState(), adapters });
    transcript.setViewport(80, 5);
    transcript.scrollBy(-4);
    expect(transcript.following).toBe(false);
    transcript.scrollBy(4);
    expect(transcript.following).toBe(true);
    expect(transcript.distanceFromEnd).toBe(0);
  });
});
