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
    ...(overrides.query === undefined ? {} : { query: overrides.query }),
    ...(overrides.menu === undefined ? {} : { menu: overrides.menu }),
    async ack(_sessionId, cursor) { order.push(`ack:${cursor.sequence}`); },
  };
  const persistence = { async load() { return overrides.persisted; }, async save(value) { await overrides.save?.(value); saved.push(structuredClone(value)); order.push(`persist:${value.cursor?.sequence ?? "draft"}`); } };
  const dashboard = [];
  const instance = new ViewerController({ sessionId: "s", client, editor: editor(), persistence, requestRender: async () => { order.push("render"); }, onReturn: vi.fn(), now: () => 0, onDashboardAction: (action) => dashboard.push(action) });
  return { instance, client, commands, order, saved, dashboard, emit: (event) => listener(event) };
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

  it("keeps a working pending overlay through Ctrl+C and disposes it once it responds", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING", pendingUi: [{ id: "ui-working", method: "confirm", title: "Continue?" }] } });
    await f.instance.open();
    const overlay = f.instance.overlay;
    f.instance.handleInput("\x03");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "interrupt", payload: { sessionId: "s" } }]));
    expect(f.instance.overlay).toBe(overlay);

    const dispose = vi.spyOn(overlay, "dispose");
    f.instance.handleInput("y");
    await vi.waitFor(() => expect(f.commands.at(-1)).toEqual({ operation: "ui_response", payload: { sessionId: "s", uiRequestId: "ui-working", response: true } }));
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.instance.overlay).toBeUndefined();
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

  it("explains that an outdated session worker cannot report commands", async () => {
    const f = fixture({ menu: async () => { throw Object.assign(new Error("Unsupported worker operation: get_session_commands"), { code: "UNSUPPORTED_WORKER_OPERATION" }); } });
    await f.instance.open();
    expect(f.instance.state.errors).toContainEqual({ code: "SESSION_COMMANDS_UNAVAILABLE", message: "This session's worker predates slash commands. Stop and reopen the session to refresh them.", retryable: false });

    f.instance.editor.setText("/model");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.state.errors.at(-1)?.code).toBe("MODEL_REQUIRED"));
    expect(f.instance.selection).toBeUndefined();
    expect(f.commands).toEqual([]);
  });

  it("opens one picker per bare built-in, applies the choice, and refuses a mistyped argument", async () => {
    const f = fixture({ menu: async () => ({ commands: [], models: [{ provider: "anthropic", id: "claude" }, { provider: "openai", id: "gpt-5" }], thinkingLevels: ["off", "high"], model: null, thinkingLevel: null }) });
    await f.instance.open();

    f.instance.editor.setText("/model");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    expect(f.instance.render(80, 24).join("\n")).toContain("anthropic/claude");
    f.instance.handleInput("\x1b[B");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "session_command", payload: { sessionId: "s", command: "set_model", model: { provider: "openai", id: "gpt-5" } } }]));
    expect(f.instance.selection).toBeUndefined();

    f.instance.editor.setText("/steering");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    expect(f.instance.render(80, 24).join("\n")).toContain("one-at-a-time");
    f.instance.handleInput("\x1b[B");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands.at(-1)).toEqual({ operation: "session_command", payload: { sessionId: "s", command: "set_steering_mode", mode: "one-at-a-time" } }));

    f.instance.editor.setText("/auto-compact");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands.at(-1)).toEqual({ operation: "session_command", payload: { sessionId: "s", command: "set_auto_compaction", enabled: true } }));

    f.instance.editor.setText("/follow-up");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    f.instance.handleInput("\x1b");
    expect(f.instance.selection).toBeUndefined();
    expect(f.commands).toHaveLength(3);

    // Only a bare command opens a picker: a mistyped argument is a rejection the operator has to fix.
    f.instance.editor.setText("/auto-compact maybe");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.render(80, 24).join("\n")).toContain("TOGGLE_REQUIRED"));
    expect(f.instance.selection).toBeUndefined();
    expect(f.commands).toHaveLength(3);
  });

  it("answers /stats, /help, /new, and /resume in the viewer without prompting the session", async () => {
    const f = fixture({ query: async (_sessionId, payload) => ({ rows: [`query:${payload.query}`, "messageCount: 12"] }) });
    await f.instance.open();

    f.instance.editor.setText("/stats");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.overlay?.title).toBe("Session stats"));
    expect(f.instance.render(80, 24).join("\n")).toContain("messageCount: 12");
    f.instance.handleInput("\x1b");
    expect(f.instance.overlay).toBeUndefined();

    f.instance.editor.setText("/help");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.overlay?.title).toBe("Viewer help"));
    const help = f.instance.render(80, 24).join("\n");
    expect(help).toContain("/stats");
    expect(help).toContain("/auto-compact");
    expect(help).toContain("Esc");
    f.instance.handleInput("\x1b");

    f.instance.editor.setText("/new");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.dashboard).toEqual(["new_session"]));
    f.instance.editor.setText("/resume");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.dashboard).toEqual(["new_session", "session_list"]));
    expect(f.commands).toEqual([]);
  });

  it("picks, applies, keeps, and restores the session color, and reports a failed change", async () => {
    /** @type {any[]} */
    const colored = [];
    // The daemon owns the color: it comes back on the reloaded menu, not from viewer-local state.
    let stored = /** @type {string | null} */ (null);
    const f = fixture({ menu: async () => ({ commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null, color: stored }) });
    f.client.setSessionColor = async (/** @type {string} */ sessionId, /** @type {string | null} */ color) => {
      colored.push({ sessionId, color });
      stored = color;
      return { kind: "session_colored", sessionId, revision: 8, color };
    };
    await f.instance.open();

    f.instance.editor.setText("/color");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    const picker = f.instance.render(80, 20).map(stripVTControlCharacters).join("\n");
    expect(picker).toContain("amber");
    expect(picker).toContain("default");
    f.instance.handleInput("\x1b");
    const plain = f.instance.render(80, 20);

    f.instance.editor.setText("/color amber");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(colored).toEqual([{ sessionId: "s", color: "amber" }]));
    const tinted = f.instance.render(80, 20);
    expect(f.commands).toEqual([]);
    expect(f.instance.state.errors).toEqual([]);
    expect(tinted).not.toEqual(plain);
    expect(tinted.join("\n")).toContain("\x1b[38;2;252;211;77m");
    expect(tinted.map(stripVTControlCharacters)).toEqual(plain.map(stripVTControlCharacters));

    f.client.setSessionColor = async () => { throw Object.assign(new Error("The session no longer exists"), { code: "SESSION_NOT_FOUND" }); };
    f.instance.editor.setText("/color rose");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.state.errors).toContainEqual(expect.objectContaining({ code: "SESSION_NOT_FOUND" })));
    const afterFailure = f.instance.render(80, 20).join("\n");
    expect(afterFailure).toContain("\x1b[38;2;252;211;77m");
    expect(afterFailure).not.toContain("\x1b[38;2;253;164;175m");

    // The color lives on the session record, so reopening paints the prompt box with no fresh /color.
    const reopened = fixture({ menu: async () => ({ commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null, color: "amber" }) });
    await reopened.instance.open();
    expect(reopened.instance.render(80, 20).join("\n")).toContain("\x1b[38;2;252;211;77m");
  });

  it("observer mode disables every mutation but preserves scroll and tool inspection", async () => {
    const tool = (/** @type {string} */ id) => ({ id, name: "future_tool", state: "completed", arguments: { id }, result: [{ type: "text", text: `result ${id}` }], startedAt: timestamp, finishedAt: timestamp });
    const f = fixture({ snapshot: { role: "observer", tools: [tool("tool-a"), tool("tool-b")] } });
    await f.instance.open();
    f.instance.editor.setText("blocked");
    for (const input of ["\r", "\x03", "\x1b[5~", "\x1b", "\x14", "/", "x"]) f.instance.handleInput(input);
    f.instance.submitSteer("blocked");
    expect(f.commands).toEqual([]);
    expect(f.instance.render(55, 16).join("\n")).toContain("OBSERVER");

    f.instance.handleInput("\x0f");
    expect(f.instance.transcript.selectedToolId).toBe("tool-a");
    expect(f.instance.transcript.expandedTools.has("tool-a")).toBe(false);
    f.instance.handleInput("\x0f");
    expect(f.instance.transcript.expandedTools.has("tool-a")).toBe(true);
    f.instance.handleInput("\x1b[B");
    expect(f.instance.transcript.selectedToolId).toBe("tool-b");
    expect(f.instance.render(80, 24).join("\n")).toContain("tool:future_tool completed collapsed");
    f.instance.handleInput("\x0f");
    expect(f.instance.render(80, 24).join("\n")).toContain("tool:future_tool completed expanded");
    expect(f.commands).toEqual([]);
  });

  it("opens steer input over the draft and toggles thinking visibility", async () => {
    const f = fixture({ snapshot: {
      items: [{ kind: "assistant_message", itemId: "middle", content: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: "middle" }] }],
      thinkingLevel: "high",
    } });
    await f.instance.open();

    expect(f.instance.hideThinking).toBe(false);
    f.instance.handleInput("\x14");
    expect(f.instance.hideThinking).toBe(true);
    expect(f.instance.render(80, 24).join("\n")).toContain("Thinking blocks: hidden");

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
  // One visual pin for the whole dock and every chat state. Width behaviour belongs to the terminal
  // acceptance suite, which renders this same controller at 40, 55, 80, 120 and 160 columns.
  it("snapshots the complete chat-state matrix at 80x24", async () => {
    const [width, height] = [80, 24];
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
    expect(matrix.active).toHaveLength(height);
    expect(matrix.active.every((/** @type {string} */ line) => visibleWidth(line) <= width)).toBe(true);
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

  it("stops a working agent with Escape and leaves on the next one, draft and all", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING" } });
    await f.instance.open();
    f.instance.editor.setText("half written");

    f.instance.handleInput("\x1b");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "interrupt", payload: { sessionId: "s" } }]));
    expect(f.instance.onReturn).not.toHaveBeenCalled();

    await f.emit({ version: 1, sessionId: "s", eventId: "settled", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "turn_state", working: false } });
    f.instance.handleInput("\x1b");
    expect(f.instance.onReturn).toHaveBeenCalledOnce();
    expect(f.commands).toHaveLength(1);
    expect(f.saved.at(-1)).toMatchObject({ draft: "half written" });
  });

  it("leaves a working session with Left without stopping the agent", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING" } });
    await f.instance.open();
    f.instance.handleInput("\x1b[D");
    expect(f.instance.onReturn).toHaveBeenCalledOnce();
    expect(f.commands).toEqual([]);
  });

  it("uses the exact clean and dirty Left return gesture", async () => {
    let now = 0;
    const f = fixture();
    f.instance.now = () => now;
    await f.instance.open();
    f.instance.handleInput("x");
    f.instance.handleInput("\x1b[D");
    expect(f.instance.onReturn).not.toHaveBeenCalled();
    now = 500;
    f.instance.handleInput("\x1b[D");
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

describe("Pi interactive-mode parity", () => {
  const working = { snapshot: { taskState: "WORKING", model: { provider: "anthropic", id: "opus" }, thinkingLevel: "high", activity: { kind: "activity", phase: "assistant_streaming", label: "Working...", sourceEventId: "source", startedAt: timestamp } } };
  const settled = { snapshot: { model: { provider: "anthropic", id: "opus" }, thinkingLevel: "off" } };

  it.each([
    ["a working turn", working, /\(anthropic\) opus • high$/u, " Esc interrupt · ← list · ↑↓ scroll · Ctrl+S steer · Ctrl+T thinking", " Esc interrupt · ← list · ↑↓ scroll · Ctrl+S steer · Ctrl+T thinking · Ctrl+O tools · / commands"],
    ["a settled turn", settled, /\(anthropic\) opus • thinking off$/u, " Esc/← list · ↑↓ scroll · Ctrl+S steer · Ctrl+T thinking · Ctrl+O tools", " Esc/← list · ↑↓ scroll · Ctrl+S steer · Ctrl+T thinking · Ctrl+O tools · / commands"],
  ])("shows Pi's model footer and the key hints that fit for %s", async (_label, overrides, footer, hints80, hints120) => {
    const f = fixture(overrides);
    await f.instance.open();
    const lines = f.instance.render(80, 24).map(stripVTControlCharacters);
    const spinning = overrides === working;
    expect(lines.some((line) => /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working\.\.\./u.test(line))).toBe(spinning);
    expect(lines.join("\n").includes("(Esc to interrupt)")).toBe(spinning);
    expect(lines.at(-2)).toMatch(footer);
    expect(lines.at(-1)).toBe(hints80);
    expect(stripVTControlCharacters(f.instance.render(120, 24).at(-1))).toBe(hints120);
  });

  it("lists queued steer and follow-up messages under the editor until the session consumes them", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING" } });
    await f.instance.open();
    f.instance.editor.setText("next");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands.at(-1)?.operation).toBe("follow_up"));
    await f.instance.submitSteer("urgent");
    const queued = f.instance.render(80, 24).map(stripVTControlCharacters).join("\n");
    expect(queued).toContain(" Steering: urgent");
    expect(queued).toContain(" Follow-up: next");

    await f.emit({ version: 1, sessionId: "s", eventId: "consumed", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "user_message", itemId: "queued-next", content: [{ type: "text", text: "next" }] } });
    const consumed = f.instance.render(80, 24).map(stripVTControlCharacters).join("\n");
    expect(consumed).not.toContain("Follow-up: next");
    expect(consumed).toContain(" Steering: urgent");

    await f.emit({ version: 1, sessionId: "s", eventId: "settled", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "2" }, timestamp, payload: { kind: "turn_state", working: false } });
    expect(f.instance.render(80, 24).map(stripVTControlCharacters).join("\n")).not.toContain("Steering: urgent");
  });

  it("shrinks the dock spacers before the transcript at the smallest supported size", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING", errors: [{ code: "PROVIDER_ERROR", message: "boom", retryable: false }], pendingUi: [{ id: "ui", method: "confirm", title: "Continue?" }] } });
    await f.instance.open();
    const lines = f.instance.render(40, 10).map(stripVTControlCharacters);
    expect(lines).toHaveLength(10);
    expect(lines.join("\n")).toContain("y/Enter confirm");
    expect(lines.at(-1)).toContain("Esc interrupt");
  });

});

describe("transcript scrolling keys and wheel", () => {
  const longSnapshot = { items: Array.from({ length: 60 }, (_, index) => ({ kind: "system_message", itemId: `i-${index}`, text: `line ${index}`, level: "info" })) };

  // Arrows scroll only when Pi's editor has nothing to offer: no draft to move within and no history
  // to recall. Either one hands the arrows back, which keeps recall working and keeps the Left
  // double-press gesture honest about a dirty prompt.
  it.each([
    ["an empty prompt with no history", () => {}, false],
    ["a typed draft", (/** @type {any} */ f) => f.instance.editor.setText("draft"), true],
    ["a draft that was typed and then cleared", (/** @type {any} */ f) => { f.instance.editor.setText("draft"); f.instance.editor.setText(""); }, false],
    ["recallable prompt history", (/** @type {any} */ f) => f.instance.history.push("earlier prompt"), true],
  ])("routes the arrows to %s", async (_label, prepare, editorKeeps) => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    f.instance.render(80, 24);
    prepare(f);
    f.instance.handleInput("\x1b[A");
    expect(f.instance.transcript.following).toBe(editorKeeps);
    expect(f.instance.transcript.distanceFromEnd).toBe(editorKeeps ? 0 : 1);
    f.instance.handleInput("\x1b[B");
    expect(f.instance.transcript.following).toBe(true);
    expect(f.instance.transcript.distanceFromEnd).toBe(0);
  });

  it("jumps with Home and End, scrolls on the wheel, and clears the new-activity marker at the end", async () => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    f.instance.render(80, 24);

    f.instance.handleMouse({ button: "wheel_up", column: 10, row: 5 });
    expect(f.instance.transcript.following).toBe(false);
    expect(f.instance.transcript.distanceFromEnd).toBeGreaterThan(0);
    f.instance.handleMouse({ button: "wheel_down", column: 10, row: 5 });
    expect(f.instance.transcript.following).toBe(true);

    f.instance.handleInput("\x1b[H");
    expect(f.instance.transcript.following).toBe(false);
    expect(f.instance.transcript.distanceFromEnd).toBe(59);
    await f.emit({ version: 1, sessionId: "s", eventId: "e1", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "system_message", itemId: "fresh", text: "fresh", level: "info" } });
    expect(stripVTControlCharacters(f.instance.render(80, 24).join("\n"))).toContain("new activity");

    f.instance.handleInput("\x1b[F");
    expect(f.instance.transcript.following).toBe(true);
    expect(f.instance.transcript.distanceFromEnd).toBe(0);
    expect(stripVTControlCharacters(f.instance.render(80, 24).join("\n"))).not.toContain("new activity");
  });

  it("rules the prompt above and below in the session color and leaves the typed text white", async () => {
    const f = fixture({ menu: async () => ({ commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null, color: "amber" }) });
    await f.instance.open();
    f.instance.editor.setText("hello");
    const rendered = f.instance.render(80, 20);
    const plain = rendered.map(stripVTControlCharacters);
    const promptRow = plain.findLastIndex((line) => line.startsWith("> "));
    const rules = plain.map((line, index) => ({ line, index })).filter(({ line }) => /^\u2500+$/u.test(line.trim()) && line.trim() !== "");
    expect(promptRow).toBeGreaterThan(0);
    // One rule above the prompt, one below, and no side borders anywhere.
    expect(rules.filter(({ index }) => index < promptRow)).not.toHaveLength(0);
    expect(rules.filter(({ index }) => index > promptRow)).not.toHaveLength(0);
    expect(plain.every((line) => !line.includes("\u2502"))).toBe(true);
    expect(rendered[rules.find(({ index }) => index < promptRow).index]).toContain("\x1b[38;2;252;211;77m");
    expect(rendered[promptRow]).not.toContain("\x1b[38;2;252;211;77m");
  });
});
