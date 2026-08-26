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
  return { focused: false, disableSubmit: false, onSubmit: undefined, onChange: undefined, autocompleteProvider: undefined, setAutocompleteProvider(provider) { this.autocompleteProvider = provider; }, setText(value) { text = value; this.onChange?.(value); }, getText() { return text; }, addToHistory: vi.fn(), handleInput(data) { if (data === "\r") this.onSubmit?.(text); else if (data.length === 1 && data >= " ") { text += data; this.onChange?.(text); } }, render: () => [`> ${text}`] };
}
function fixture(overrides = {}) {
  let listener;
  const commands = [];
  const order = [];
  const saved = [];
  const client = {
    async getSnapshot() { return snapshot(overrides.snapshot); },
    subscribe(_sessionId, _cursor, next) { listener = next; return () => order.push("unsubscribe"); },
    async command(operation, payload) { commands.push({ operation, payload }); return overrides.command?.(operation, payload); },
    ...(overrides.menu === undefined ? {} : { menu: overrides.menu }),
    async ack(_sessionId, cursor) { order.push(`ack:${cursor.sequence}`); },
  };
  const persistence = { async load() { return overrides.persisted; }, async save(value) { await overrides.save?.(value); saved.push(structuredClone(value)); order.push(`persist:${value.cursor?.sequence ?? "draft"}`); } };
  const instance = new ViewerController({ sessionId: "s", client, editor: editor(), persistence, requestRender: async () => { order.push("render"); }, onReturn: vi.fn(), now: () => 0 });
  return { instance, client, commands, order, saved, emit: (event) => listener(event) };
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

  it("renders command failures without closing the viewer process", async () => {
    const failure = Object.assign(new Error("No exact recovered worker owns this session"), { code: "WORKER_UNAVAILABLE", retryable: false });
    const f = fixture({ command: async () => { throw failure; } });
    await f.instance.open();
    f.instance.editor.setText("retry");
    f.instance.handleInput("\r");

    await vi.waitFor(() => expect(f.instance.state.errors).toContainEqual({ code: "WORKER_UNAVAILABLE", message: failure.message, retryable: false }));
    expect(f.instance.closedState).toBe(false);
  });

  it("routes Ctrl+C to interrupt while a working pending overlay retains focus", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING", pendingUi: [{ id: "ui-working", method: "confirm", title: "Continue?" }] } });
    await f.instance.open();
    const overlay = f.instance.overlay;
    f.instance.handleInput("\x03");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "interrupt", payload: { sessionId: "s" } }]));
    expect(f.instance.overlay).toBe(overlay);
  });

  it("disposes a resolved overlay and restores focus before sending its response", async () => {
    const f = fixture({ snapshot: { pendingUi: [{ id: "ui-dispose", method: "confirm", title: "Continue?" }] } });
    await f.instance.open();
    const dispose = vi.spyOn(f.instance.overlay, "dispose");
    f.instance.handleInput("y");
    await vi.waitFor(() => expect(f.commands.at(-1)?.operation).toBe("ui_response"));
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.instance.overlay).toBeUndefined();
  });

  it.each([
    ["confirm", {}, "y", true],
    ["select", { options: ["one", "two"] }, "\r", "one"],
    ["input", { initialValue: "single" }, "\r", "single"],
    ["editor", { initialValue: "line one\nline two" }, "\r", "line one\nline two"],
  ])("sends one durable ui_response for a %s request", async (method, requestFields, input, expected) => {
    const f = fixture();
    await f.instance.open();
    await f.emit({ version: 1, sessionId: "s", eventId: `ui-${method}`, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "pending_ui_request", request: { id: `request-${method}`, method, title: `Request ${method}`, ...requestFields } } });
    f.instance.handleInput(input);
    f.instance.handleInput(input);
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "ui_response", payload: { sessionId: "s", uiRequestId: `request-${method}`, response: expected } }]));
  });

  it("discovers slash commands, applies model selection, and reloads the menu", async () => {
    const menu = { commands: [{ name: "/review", source: "extension" }], models: [{ provider: "anthropic", id: "claude" }], thinkingLevels: ["off", "high"], model: null, thinkingLevel: "off" };
    const loaded = [];
    const f = fixture({ menu: async () => { loaded.push("menu"); return menu; } });
    await f.instance.open();
    expect(loaded).toEqual(["menu"]);
    expect(f.instance.editor.autocompleteProvider).toBeDefined();

    f.instance.editor.setText("/model anthropic/claude");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "session_command", payload: { sessionId: "s", command: "set_model", model: { provider: "anthropic", id: "claude" } } }]));
    await vi.waitFor(() => expect(loaded).toEqual(["menu", "menu"]));

    f.instance.editor.setText("/review the diff");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands.at(-1)).toEqual({ operation: "prompt", payload: { sessionId: "s", text: "/review the diff" } }));
  });

  it("rejects an unknown model locally without contacting the session", async () => {
    const f = fixture({ menu: async () => ({ commands: [], models: [{ provider: "anthropic", id: "claude" }], thinkingLevels: [], model: null, thinkingLevel: null }) });
    await f.instance.open();
    f.instance.editor.setText("/model invented/model");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.state.errors).toContainEqual({ code: "UNKNOWN_MODEL", message: "Unknown model: invented/model", retryable: false }));
    expect(f.commands).toEqual([]);
  });

  it("observer mode disables every mutation but preserves scroll and tool inspection", async () => {
    const f = fixture({ snapshot: { role: "observer", tools: [{ id: "t", name: "bash", state: "completed", arguments: {}, result: [{ type: "text", text: "ok" }], startedAt: timestamp, finishedAt: timestamp }] } });
    await f.instance.open();
    f.instance.editor.setText("blocked");
    for (const input of ["\r", "\x03", "\x1b[5~", "\x0f", "\x1b[B", "\x0f", "\x1b", "\x14", "/", "x"]) f.instance.handleInput(input);
    f.instance.submitSteer("blocked");
    expect(f.commands).toEqual([]);
    expect(f.instance.render(55, 16).join("\n")).toContain("OBSERVER");
  });

  it("supports selected-tool inspection, explicit steer input, and thinking visibility", async () => {
    const tool = (id) => ({ id, name: "future_tool", state: "completed", arguments: { id }, result: [{ type: "text", text: `result ${id}` }], startedAt: timestamp, finishedAt: timestamp });
    const f = fixture({ snapshot: {
      items: [
        { kind: "system_message", itemId: "first", text: "needle first", level: "info" },
        { kind: "assistant_message", itemId: "middle", content: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: "middle" }] },
        { kind: "system_message", itemId: "second", text: "needle second", level: "info" },
      ],
      tools: [tool("tool-a"), tool("tool-b")], thinkingLevel: "high",
    } });
    await f.instance.open();

    f.instance.handleInput("\x0f");
    expect(f.instance.transcript.selectedToolId).toBe("tool-a");
    f.instance.handleInput("\x1b[B");
    expect(f.instance.transcript.selectedToolId).toBe("tool-b");
    expect(f.instance.transcript.expandedTools.has("tool-b")).toBe(false);
    f.instance.handleInput("\x0f");
    expect(f.instance.transcript.expandedTools.has("tool-b")).toBe(true);
    expect(f.instance.render(80, 24).join("\n")).toContain("tool:future_tool completed expanded");

    expect(f.instance.hideThinking).toBe(false);
    f.instance.handleInput("\x14");
    expect(f.instance.hideThinking).toBe(true);
    expect(f.instance.render(80, 24).join("\n")).toContain("thinking:high/hidden");

    f.instance.editor.setText("composer draft");
    f.instance.handleInput("\x13");
    expect(f.instance.inputMode).toBe("steer");
    expect(f.instance.editor.getText()).toBe("");
    for (const input of "urgent boundary") f.instance.handleInput(input);
    f.instance.handleInput("\r");
    await vi.waitFor(() => {
      expect(f.commands.at(-1)).toEqual({ operation: "steer", payload: { sessionId: "s", text: "urgent boundary" } });
      expect(f.instance.inputMode).toBe("prompt");
    });
    expect(f.instance.editor.getText()).toBe("composer draft");
    expect(f.instance.render(80, 24).join("\n")).toContain("Steer queued");
  });

  it("keeps drafts and history scoped to the exact session, including while steer input is open", async () => {
    const f = fixture({ persisted: { sessionId: "other", draft: "leak", history: ["leak"] } });
    await f.instance.open();
    expect(f.instance.editor.getText()).toBe("");
    f.instance.editor.setText("session draft");
    f.instance.handleInput("\x13");
    for (const input of "temporary steer") f.instance.handleInput(input);
    await f.instance.close();
    expect(f.order).toContain("persist:0");
    expect(f.saved.at(-1)).toMatchObject({ sessionId: "s", draft: "session draft", history: [] });
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

  it.each([[160, 40], [120, 32], [80, 24], [55, 16], [40, 10]])("snapshots the complete chat-state matrix at %ix%i", async (width, height) => {
    const message = (kind, text) => kind === "assistant_message"
      ? { kind, itemId: kind, content: [{ type: "text", text }] }
      : { kind, itemId: `${kind}-${text}`, text, level: text.includes("error") ? "error" : "info" };
    const tool = (state) => ({ id: `tool-${state}`, name: "future_tool", state, arguments: { state }, startedAt: timestamp, ...(state === "completed" ? { result: [{ type: "text", text: "completed output" }], finishedAt: timestamp } : {}), ...(state === "failed" ? { error: "tool failed", finishedAt: timestamp } : {}) });
    const cases = [
      ["user", { items: [{ kind: "user_message", itemId: "user", content: [{ type: "text", text: "User card" }] }] }],
      ["assistant", { items: [message("assistant_message", "## Assistant markdown\n- item")] }],
      ["thinking-visible", { items: [{ kind: "assistant_message", itemId: "thinking", content: [{ type: "thinking", text: "Visible reasoning" }, { type: "text", text: "Answer" }] }], thinkingLevel: "high" }],
      ...["pending", "running", "streaming", "completed", "failed"].map((state) => [`tool-${state}`, { items: [], tools: [tool(state)] }]),
      ["retry", { items: [message("system_message", "Retrying in 4s")] }],
      ["compaction", { items: [message("system_message", "Compacting context")] }],
      ["reconnect", { items: [message("system_message", "Connection lost; reconnecting")] }],
      ["error", { errors: [{ code: "PROVIDER_ERROR", message: "provider error", retryable: true }] }],
      ["unknown", { items: [{ kind: "unknown_pi_event", piType: "future", summary: "Future Pi event" }] }],
      ["placeholders", { items: [{ kind: "image_placeholder", attachment: { id: "image", path: "safe.png", mediaType: "image/png", width: 10, height: 5 } }, { kind: "file_placeholder", attachment: { id: "file", path: "safe.txt", size: 12 } }] }],
      ["active", { taskState: "WORKING", activity: { kind: "activity", phase: "tool_running", label: "Running bash", detail: "pytest", sourceEventId: "active", startedAt: timestamp } }],
      ["pending-ui", { taskState: "WAITING", pendingUi: [{ id: "ui-editor", method: "editor", title: "Edit response", initialValue: "line one\nline two" }] }],
      ["observer", { role: "observer" }],
      ["model-thinking", { model: { provider: "anthropic", id: "opus" }, thinkingLevel: "high" }],
    ];
    const matrix = {};
    for (const [name, overrides] of cases) {
      const f = fixture({ snapshot: overrides });
      await f.instance.open();
      if (name === "thinking-visible") {
        matrix["thinking-hidden"] = f.instance.handleInput("\x14") ?? f.instance.render(width, height).map(stripVTControlCharacters);
        f.instance.handleInput("\x14");
      }
      matrix[name] = f.instance.render(width, height).map(stripVTControlCharacters);
      await f.instance.close();
    }
    const streaming = fixture({ snapshot: { items: [] } });
    await streaming.instance.open();
    await streaming.emit({ version: 1, sessionId: "s", eventId: "stream", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "assistant_delta", itemId: "streaming", delta: "Streaming **markdown" } });
    matrix.streaming = streaming.instance.render(width, height).map(stripVTControlCharacters);
    await streaming.instance.close();
    const paused = fixture({ snapshot: { items: Array.from({ length: 12 }, (_, index) => message("system_message", `history ${index}`)) } });
    await paused.instance.open();
    paused.instance.transcript.scrollBy(-2);
    await paused.emit({ version: 1, sessionId: "s", eventId: "new", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "system_message", itemId: "new", text: "new output", level: "info" } });
    matrix["paused-follow"] = paused.instance.render(width, height).map(stripVTControlCharacters);
    await paused.instance.close();
    expect(matrix).toMatchSnapshot();
  });

  it("replays from origin into exact message/tool chronology before continuing live without a gap", async () => {
    const base = snapshot({
      items: [
        { kind: "user_message", itemId: "u1", content: [{ type: "text", text: "one" }] },
        { kind: "assistant_message", itemId: "a1", content: [{ type: "text", text: "calling" }] },
        { kind: "assistant_message", itemId: "a2", content: [{ type: "text", text: "done" }] },
      ],
      tools: [{ id: "tool", name: "bash", state: "completed", arguments: {}, result: [{ type: "text", text: "ok" }], startedAt: timestamp, finishedAt: timestamp }],
      cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "4" },
    });
    const payloads = [
      { kind: "user_message", itemId: "u1", content: [{ type: "text", text: "one" }] },
      { kind: "assistant_message", itemId: "a1", content: [{ type: "text", text: "calling" }] },
      { kind: "tool_finished", tool: base.tools[0] },
      { kind: "assistant_message", itemId: "a2", content: [{ type: "text", text: "done" }] },
      { kind: "system_message", itemId: "live", text: "live after snapshot", level: "info" },
    ];
    const client = {
      replayFromOrigin: true,
      async getSnapshot() { return base; },
      async subscribe(_sessionId, cursor, next) {
        expect(cursor.sequence).toBe("0");
        for (const [index, payload] of payloads.entries()) await next({ version: 1, sessionId: "s", eventId: `ordered-${index + 1}`, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: String(index + 1) }, timestamp, payload });
        return () => {};
      },
      async ack() {}, async command() {},
    };
    const instance = new ViewerController({ sessionId: "s", client, editor: editor(), persistence: { async load() {}, async save() {} }, requestRender: async () => {} });
    await instance.open();
    expect(instance.state.items.map((item) => item.itemId)).toEqual(["u1", "a1", "tool:tool", "a2", "live"]);
    expect(instance.state.cursor.sequence).toBe("5");
    await instance.close();
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
