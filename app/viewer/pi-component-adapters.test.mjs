import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { adaptAssistantMessage, createPiComponentAdapters, createPiEditor } from "./pi-component-adapters.mjs";

const tui = { requestRender: vi.fn(), setFocus: vi.fn(), mode: "fullscreen" };

describe("public Pi component adapters", () => {
  it("renders normalized user, assistant, thinking, and every tool state within width", () => {
    const adapters = createPiComponentAdapters({ tui, cwd: "/repo" });
    const fixtures = [
      adapters.user({ kind: "user_message", itemId: "u", content: [{ type: "text", text: "Please **check** this" }] }),
      adapters.assistant({ kind: "assistant_message", itemId: "a", content: [{ type: "thinking", text: "Inspecting" }, { type: "text", text: "## Result\nDone" }] }, { streaming: true }),
      ...["pending", "running", "streaming", "completed", "failed"].map((state) => adapters.tool({ id: `t-${state}`, name: "future_tool", state, arguments: { path: "/repo/very/long/path" }, startedAt: "2026-08-25T00:00:00Z", ...(state === "failed" ? { error: "boom", finishedAt: "2026-08-25T00:00:01Z" } : state === "completed" ? { result: [{ type: "text", text: "ok" }], finishedAt: "2026-08-25T00:00:01Z" } : {}) })),
    ];
    for (const component of fixtures) {
      expect(component.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
    }
  });

  it("adapts normalized assistant content to the complete public AssistantMessage shape", () => {
    expect(adaptAssistantMessage({ kind: "assistant_message", itemId: "a", content: [{ type: "thinking", text: "reason" }, { type: "text", text: "answer" }] })).toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: "answer" }],
      api: "pi-dashboard-normalized",
      provider: "pi-dashboard",
      model: "normalized-viewer",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
    });
    expect(adaptAssistantMessage({ kind: "assistant_message", itemId: "stream", content: [{ type: "text", text: "partial" }] }, { streaming: true }).stopReason).toBe("pending");
  });

  it("uses Pi's hidden thinking label and its collapsed tool cards", () => {
    const adapters = createPiComponentAdapters({ tui, cwd: "/repo" });
    const hidden = adapters.assistant({ kind: "assistant_message", itemId: "a", content: [{ type: "thinking", text: "Inspecting" }, { type: "text", text: "Done" }] }, { hideThinking: true, thinkingLevel: "high" });
    const text = hidden.render(40).map(stripVTControlCharacters).join("\n");
    expect(text).toContain("Thinking...");
    expect(text).not.toContain("Inspecting");
    for (const state of ["running", "streaming", "failed"]) {
      expect(adapters.tool({ id: state, name: "future_tool", state, arguments: {}, startedAt: "2026-08-25T00:00:00Z", ...(state === "failed" ? { error: "boom", finishedAt: "2026-08-25T00:00:01Z" } : {}) }).expanded).toBe(false);
    }
  });

  it("words normalized system and unknown-event cards the way Pi does", () => {
    const adapters = createPiComponentAdapters({ tui, cwd: "/repo" });
    expect(adapters.component({ kind: "system_message", itemId: "s", text: "boom", level: "error" }).render(40)).toEqual(["", " Error: boom"]);
    expect(adapters.component({ kind: "system_message", itemId: "s", text: "careful", level: "warning" }).render(40)).toEqual(["", " Warning: careful"]);
    expect(adapters.component({ kind: "system_message", itemId: "s", text: "note", level: "info" }).render(40)).toEqual(["", " note"]);
    expect(adapters.component({ kind: "unknown_pi_event", piType: "future", summary: "Future Pi event" }).render(40)).toEqual(["", " Activity (future): Future Pi event"]);
  });

  it("uses the public CustomEditor with Pi keybindings and IME focus", () => {
    const editor = createPiEditor({ tui });
    editor.focused = true;
    editor.setText("draft");
    expect(editor.getText()).toBe("draft");
    expect(editor.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(editor.constructor.name).toBe("CustomEditor");
  });
});
