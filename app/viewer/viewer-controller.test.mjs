import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { ViewerController } from "./viewer-controller.mjs";

const timestamp = "2026-08-25T00:00:00Z";
function snapshot(overrides = {}) {
  return {
    version: 1, sessionId: "s", registryRevision: 1, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "0" }, runtime: null,
    role: "composer", taskState: "READY", processState: "LIVE", outcome: "NONE",
    activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "snapshot", startedAt: timestamp }, model: null, thinkingLevel: null,
    items: [{ kind: "user_message", itemId: "u", content: [{ type: "text", text: "hello" }] }], tools: [], pendingUi: [], errors: [], ...overrides,
  };
}
function editor() {
  let text = "";
  return { focused: false, disableSubmit: false, onSubmit: undefined, onChange: undefined, setText(value) { text = value; this.onChange?.(value); }, getText() { return text; }, addToHistory: vi.fn(), handleInput(data) { if (data === "\r") this.onSubmit?.(text); else if (data.length === 1 && data >= " ") { text += data; this.onChange?.(text); } }, render: () => [`> ${text}`] };
}
function fixture(overrides = {}) {
  let listener;
  const commands = [];
  const order = [];
  const client = {
    async getSnapshot() { return snapshot(overrides.snapshot); },
    subscribe(_sessionId, _cursor, next) { listener = next; return () => order.push("unsubscribe"); },
    async command(operation, payload) { commands.push({ operation, payload }); },
    async ack(_sessionId, cursor) { order.push(`ack:${cursor.sequence}`); },
  };
  const persistence = { async load() { return overrides.persisted; }, async save(value) { await overrides.save?.(value); order.push(`persist:${value.cursor?.sequence ?? "draft"}`); } };
  const instance = new ViewerController({ sessionId: "s", client, editor: editor(), persistence, requestRender: async () => { order.push("render"); }, onReturn: vi.fn(), now: () => 0 });
  return { instance, client, commands, order, emit: (event) => listener(event) };
}

describe("viewer commands and role restrictions", () => {
  it("sends prompt while idle, follow_up while working, explicit steer, interrupt, and one UI response", async () => {
    const f = fixture();
    await f.instance.open();
    f.instance.editor.setText("first"); f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(1));
    const eventStart = f.order.length;
    await f.emit({ version: 1, sessionId: "s", eventId: "e1", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "turn_state", working: true } });
    expect(f.order.slice(eventStart, eventStart + 3)).toEqual(["render", "persist:1", "ack:1"]);
    f.instance.editor.setText("next"); f.instance.handleInput("\r");
    f.instance.submitSteer("urgent"); f.instance.handleInput("\x03");
    await vi.waitFor(() => expect(f.commands.map(({ operation }) => operation)).toEqual(["prompt", "follow_up", "steer", "interrupt"]));
    await f.emit({ version: 1, sessionId: "s", eventId: "e2", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "2" }, timestamp, payload: { kind: "pending_ui_request", request: { id: "ui-1", method: "confirm", title: "Continue?" } } });
    f.instance.handleInput("y");
    await vi.waitFor(() => expect(f.commands.at(-1)).toEqual({ operation: "ui_response", payload: { sessionId: "s", uiRequestId: "ui-1", response: true } }));
    await f.emit({ version: 1, sessionId: "s", eventId: "e3", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "3" }, timestamp, payload: { kind: "turn_state", working: true } });
    f.instance.handleInput("y");
    expect(f.commands.filter(({ operation }) => operation === "ui_response")).toHaveLength(1);
  });

  it("observer mode disables every mutation but preserves scroll, search, and tool inspection", async () => {
    const f = fixture({ snapshot: { role: "observer", tools: [{ id: "t", name: "bash", state: "completed", arguments: {}, result: [{ type: "text", text: "ok" }], startedAt: timestamp, finishedAt: timestamp }] } });
    await f.instance.open();
    f.instance.editor.setText("blocked");
    for (const input of ["\r", "\x03", "\x1b[5~", "/", "e"]) f.instance.handleInput(input);
    f.instance.submitSteer("blocked");
    expect(f.commands).toEqual([]);
    expect(f.instance.render(55, 16).join("\n")).toContain("OBSERVER");
  });

  it("keeps drafts and history scoped to the exact session", async () => {
    const f = fixture({ persisted: { sessionId: "other", draft: "leak", history: ["leak"] } });
    await f.instance.open();
    expect(f.instance.editor.getText()).toBe("");
    await f.instance.close();
    expect(f.order).toContain("persist:0");
  });
});

describe("viewer rendering and navigation", () => {
  it.each([[160, 40], [120, 32], [80, 24], [55, 16], [40, 10]])("renders a bounded %ix%i Pi-style fixture", async (width, height) => {
    const f = fixture({ snapshot: { taskState: "WORKING", activity: { kind: "activity", phase: "thinking", label: "Thinking", sourceEventId: "source", startedAt: timestamp }, model: { provider: "anthropic", id: "opus" }, thinkingLevel: "high" } });
    await f.instance.open();
    const lines = f.instance.render(width, height);
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).toContain("Thinking");
    expect(lines.map(stripVTControlCharacters)).toMatchSnapshot();
  });

  it("uses the exact clean and dirty Left/Escape return gesture", async () => {
    let now = 0;
    const f = fixture();
    f.instance.now = () => now;
    await f.instance.open();
    f.instance.handleInput("x");
    f.instance.handleInput("\x1b");
    expect(f.instance.onReturn).not.toHaveBeenCalled();
    now = 500;
    f.instance.handleInput("\x1b");
    expect(f.instance.onReturn).toHaveBeenCalledOnce();
  });

  it.each(["render", "persistence", "malformed event"])("closes only the viewer subscription after %s failure and sends no ACK", async (failure) => {
    const f = fixture({ save: failure === "persistence" ? async (value) => { if (value.cursor?.sequence === "1") throw new Error("persist failed"); } : undefined });
    await f.instance.open();
    if (failure === "render") f.instance.requestRender = async () => { throw new Error("render failed"); };
    const value = failure === "malformed event" ? { invalid: true } : { version: 1, sessionId: "s", eventId: "e1", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "turn_state", working: true } };
    await expect(f.emit(value)).rejects.toThrow();
    expect(f.order).toContain("unsubscribe");
    expect(f.order.some((entry) => entry.startsWith("ack:"))).toBe(false);
    expect(f.commands).toEqual([]);
  });
});
