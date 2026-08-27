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

  it("opens Pi's selection list for a bare built-in command and applies the choice", async () => {
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

    f.instance.editor.setText("/thinking");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    f.instance.handleInput("\x1b");
    expect(f.instance.selection).toBeUndefined();
    expect(f.commands).toHaveLength(1);
  });

  it("offers mode and toggle pickers for bare queue and automation commands", async () => {
    const f = fixture();
    await f.instance.open();

    f.instance.editor.setText("/steering");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    expect(f.instance.render(80, 24).join("\n")).toContain("one-at-a-time");
    f.instance.handleInput("\x1b[B");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "session_command", payload: { sessionId: "s", command: "set_steering_mode", mode: "one-at-a-time" } }]));

    f.instance.editor.setText("/auto-compact");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(2));
    expect(f.commands.at(-1)).toEqual({ operation: "session_command", payload: { sessionId: "s", command: "set_auto_compaction", enabled: true } });

    f.instance.editor.setText("/follow-up");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    f.instance.handleInput("\x1b");
    expect(f.instance.selection).toBeUndefined();
    expect(f.commands).toHaveLength(2);
  });

  it.each([40, 55, 80, 120, 160])("fits the mode picker and help panel in %i columns", async (width) => {
    const f = fixture();
    await f.instance.open();

    f.instance.editor.setText("/steering");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    expect(f.instance.render(width, 24).every((line) => visibleWidth(line) <= width)).toBe(true);
    f.instance.handleInput("\x1b");

    f.instance.editor.setText("/help");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.render(width, 24).join("\n")).toContain("auto-compact"));
    expect(f.instance.render(width, 24).every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("corrects a mistyped mode instead of opening a picker", async () => {
    const f = fixture();
    await f.instance.open();

    f.instance.editor.setText("/auto-compact maybe");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.render(80, 24).join("\n")).toContain("TOGGLE_REQUIRED"));
    expect(f.instance.selection).toBeUndefined();
    expect(f.commands).toHaveLength(0);
  });

  it("renders a read-only query in an overlay without prompting the session", async () => {
    const f = fixture({ query: async (_sessionId, payload) => ({ rows: [`query:${payload.query}`, "messageCount: 12"] }) });
    await f.instance.open();
    f.instance.editor.setText("/stats");
    f.instance.handleInput("\r");

    await vi.waitFor(() => expect(f.instance.overlay?.title).toBe("Session stats"));
    const rendered = f.instance.render(80, 24).join("\n");
    expect(rendered).toContain("messageCount: 12");
    expect(f.commands).toEqual([]);

    f.instance.handleInput("\x1b");
    expect(f.instance.overlay).toBeUndefined();
  });

  it("routes /new and /resume to the dashboard instead of rebinding Pi", async () => {
    const f = fixture();
    await f.instance.open();
    f.instance.editor.setText("/new");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.dashboard).toEqual(["new_session"]));
    f.instance.editor.setText("/resume");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.dashboard).toEqual(["new_session", "session_list"]));
    expect(f.commands).toEqual([]);
  });

  it("shows viewer help listing its commands", async () => {
    const f = fixture();
    await f.instance.open();
    f.instance.editor.setText("/help");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.overlay?.title).toBe("Viewer help"));
    const rendered = f.instance.render(80, 24).join("\n");
    expect(rendered).toContain("/stats");
    expect(rendered).toContain("Esc");
  });

  it("forwards a session toggle and refreshes the menu", async () => {
    const f = fixture({ menu: async () => ({ commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null }) });
    await f.instance.open();
    f.instance.editor.setText("/auto-compact off");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "session_command", payload: { sessionId: "s", command: "set_auto_compaction", enabled: false } }]));
  });

  it("sets a session color through the daemon and tints the prompt bar", async () => {
    /** @type {any[]} */
    const colored = [];
    const f = fixture({ menu: async () => ({ commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null, color: null, registryRevision: 7 }) });
    f.client.setSessionColor = async (/** @type {string} */ sessionId, /** @type {string | null} */ color) => {
      colored.push({ sessionId, color });
      return { kind: "session_colored", sessionId, revision: 8, color };
    };
    await f.instance.open();
    const plain = f.instance.render(80, 20);

    f.instance.editor.setText("/color amber");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(colored).toEqual([{ sessionId: "s", color: "amber" }]));
    expect(f.commands).toEqual([]);

    const tinted = f.instance.render(80, 20);
    expect(tinted).not.toEqual(plain);
    expect(tinted.join("\n")).toContain("\x1b[38;2;252;211;77m");
    expect(tinted.map(stripVTControlCharacters)).toEqual(plain.map(stripVTControlCharacters));
    for (const width of [40, 55, 80, 120, 160]) {
      for (const line of f.instance.render(width, 20)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("offers a color picker when /color arrives without a color", async () => {
    const f = fixture({ menu: async () => ({ commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null, color: null, registryRevision: 2 }) });
    f.client.setSessionColor = async () => ({ kind: "session_colored", sessionId: "s", revision: 3, color: "rose" });
    await f.instance.open();
    f.instance.editor.setText("/color");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    const rendered = f.instance.render(80, 20).map(stripVTControlCharacters).join("\n");
    expect(rendered).toContain("amber");
    expect(rendered).toContain("default");
    expect(f.instance.state.errors).toEqual([]);
  });

  it("colors a session whose registry revision the viewer never learned", async () => {
    /** @type {any[]} */
    const colored = [];
    const f = fixture({ menu: async () => ({ commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null, color: null }) });
    f.client.setSessionColor = async (/** @type {string} */ sessionId, /** @type {string | null} */ color) => {
      colored.push({ sessionId, color });
      return { kind: "session_colored", sessionId, revision: 3, color };
    };
    await f.instance.open();
    f.instance.registryRevision = undefined;
    f.instance.state.registryRevision = undefined;

    f.instance.editor.setText("/color amber");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(colored).toEqual([{ sessionId: "s", color: "amber" }]));
    expect(f.instance.state.errors).toEqual([]);
  });

  it("reports a color failure as a viewer error without changing the prompt bar", async () => {
    const f = fixture({ menu: async () => ({ commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null, color: null, registryRevision: 4 }) });
    f.client.setSessionColor = async () => { throw Object.assign(new Error("The session no longer exists"), { code: "SESSION_NOT_FOUND" }); };
    await f.instance.open();
    const plain = f.instance.render(80, 20);
    f.instance.editor.setText("/color rose");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.state.errors).toContainEqual(expect.objectContaining({ code: "SESSION_NOT_FOUND" })));
    expect(f.instance.render(80, 20).at(-2)).toBe(plain.at(-2));
  });

  it("rejects an unknown model locally without contacting the session", async () => {
    const f = fixture({ menu: async () => ({ commands: [], models: [{ provider: "anthropic", id: "claude" }], thinkingLevels: [], model: null, thinkingLevel: null }) });
    await f.instance.open();
    f.instance.editor.setText("/model invented/model");
    f.instance.now = () => 0;
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

  it("stops a working agent with Escape and only leaves once the work is stopped", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING" } });
    await f.instance.open();

    f.instance.handleInput("\x1b");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "interrupt", payload: { sessionId: "s" } }]));
    expect(f.instance.onReturn).not.toHaveBeenCalled();

    await f.emit({ version: 1, sessionId: "s", eventId: "settled", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "turn_state", working: false } });
    f.instance.handleInput("\x1b");
    expect(f.instance.onReturn).toHaveBeenCalledOnce();
    expect(f.commands).toHaveLength(1);
  });

  it("leaves on the Escape after the interrupt even with an edited draft", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING" } });
    await f.instance.open();
    f.instance.editor.setText("half written");

    f.instance.handleInput("\x1b");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "interrupt", payload: { sessionId: "s" } }]));
    await f.emit({ version: 1, sessionId: "s", eventId: "settled", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "turn_state", working: false } });
    f.instance.handleInput("\x1b");
    expect(f.instance.onReturn).toHaveBeenCalledOnce();
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

  it("shows Pi's spinner, interrupt hint, model footer, and key hints while a turn works", async () => {
    const f = fixture(working);
    await f.instance.open();
    const lines = f.instance.render(80, 24).map(stripVTControlCharacters);
    expect(lines.some((line) => /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working\.\.\./u.test(line))).toBe(true);
    expect(lines.join("\n")).toContain("(Esc to interrupt)");
    expect(lines.at(-2)).toMatch(/\(anthropic\) opus • high$/u);
    expect(lines.at(-1)).toBe(" Esc interrupt · ← list · ↑↓ scroll · Ctrl+S steer · Ctrl+T thinking");
    expect(f.instance.render(120, 24).at(-1)).toBe(" Esc interrupt · ← list · ↑↓ scroll · Ctrl+S steer · Ctrl+T thinking · Ctrl+O tools · / commands");
  });

  it("drops the interrupt hint and offers the list keys once the turn settles", async () => {
    const f = fixture({ snapshot: { model: { provider: "anthropic", id: "opus" }, thinkingLevel: "off" } });
    await f.instance.open();
    const lines = f.instance.render(80, 24).map(stripVTControlCharacters);
    expect(lines.join("\n")).not.toContain("to interrupt");
    expect(lines.at(-2)).toMatch(/\(anthropic\) opus • thinking off$/u);
    expect(lines.at(-1)).toBe(" Esc/← list · ↑↓ scroll · Ctrl+S steer · Ctrl+T thinking · Ctrl+O tools");
  });

  it("keeps the hints and model footer inside every supported width", async () => {
    const f = fixture(working);
    await f.instance.open();
    for (const width of [40, 55, 80, 120, 160]) {
      const lines = f.instance.render(width, 24);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(visibleWidth(lines.at(-1))).toBeGreaterThan(0);
      expect(stripVTControlCharacters(lines.at(-2))).toContain("opus");
    }
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

  it("spaces user turns and words error cards the way Pi does", async () => {
    const f = fixture({ snapshot: {
      items: [
        { kind: "assistant_message", itemId: "a", content: [{ type: "text", text: "answer" }] },
        { kind: "user_message", itemId: "u", content: [{ type: "text", text: "follow up" }] },
        { kind: "system_message", itemId: "sys", text: "provider degraded", level: "warning" },
      ],
      errors: [{ code: "PROVIDER_ERROR", message: "provider error", retryable: true }],
    } });
    await f.instance.open();
    const lines = f.instance.render(80, 24).map(stripVTControlCharacters);
    const userIndex = lines.findIndex((line) => line.includes("follow up"));
    expect(userIndex).toBeGreaterThan(1);
    // Pi separates a user turn from the previous one with its own spacer above the message box padding.
    expect([lines[userIndex - 2].trim(), lines[userIndex - 1].trim()]).toEqual(["", ""]);
    expect(lines.join("\n")).toContain(" Warning: provider degraded");
    expect(lines.join("\n")).toContain(" Error: PROVIDER_ERROR: provider error");
  });
});

describe("transcript scrolling keys and wheel", () => {
  const longSnapshot = { items: Array.from({ length: 60 }, (_, index) => ({ kind: "system_message", itemId: `i-${index}`, text: `line ${index}`, level: "info" })) };

  it("scrolls with the arrows while the prompt is empty", async () => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    f.instance.render(80, 24);
    f.instance.handleInput("\x1b[A");
    expect(f.instance.transcript.following).toBe(false);
    f.instance.handleInput("\x1b[B");
    expect(f.instance.transcript.following).toBe(true);
  });

  it("hands the arrows to Pi's prompt history once a draft exists", async () => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    f.instance.render(80, 24);
    f.instance.editor.setText("draft");
    const before = f.instance.transcript.distanceFromEnd;
    f.instance.handleInput("\x1b[A");
    expect(f.instance.transcript.distanceFromEnd).toBe(before);
    expect(f.instance.transcript.following).toBe(true);
  });

  it("returns the arrows to scrolling when the prompt is cleared", async () => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    f.instance.render(80, 24);
    f.instance.editor.setText("draft");
    f.instance.handleInput("\x1b[A");
    expect(f.instance.transcript.following).toBe(true);
    f.instance.editor.setText("");
    f.instance.handleInput("\x1b[A");
    expect(f.instance.transcript.following).toBe(false);
  });

  it("leaves the arrows to Pi once prompt history exists, so recall keeps working", async () => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    f.instance.render(80, 24);
    f.instance.history.push("earlier prompt");
    f.instance.handleInput("\x1b[A");
    expect(f.instance.transcript.following).toBe(true);
    expect(f.instance.transcript.distanceFromEnd).toBe(0);
  });

  it("jumps to the transcript start and end with Home and End", async () => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    f.instance.render(80, 24);
    f.instance.handleInput("\x1b[H");
    expect(f.instance.transcript.following).toBe(false);
    expect(f.instance.transcript.distanceFromEnd).toBe(59);
    f.instance.handleInput("\x1b[F");
    expect(f.instance.transcript.following).toBe(true);
    expect(f.instance.transcript.distanceFromEnd).toBe(0);
  });

  it("scrolls the transcript from a wheel event and resumes follow at the end", async () => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    f.instance.render(80, 24);
    f.instance.handleMouse({ button: "wheel_up", column: 10, row: 5 });
    expect(f.instance.transcript.following).toBe(false);
    expect(f.instance.transcript.distanceFromEnd).toBeGreaterThan(0);
    f.instance.handleMouse({ button: "wheel_down", column: 10, row: 5 });
    f.instance.handleMouse({ button: "wheel_down", column: 10, row: 5 });
    expect(f.instance.transcript.following).toBe(true);
  });

  it("keeps the new-activity marker while detached and drops it on return to the end", async () => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    f.instance.render(80, 24);
    f.instance.handleMouse({ button: "wheel_up", column: 10, row: 5 });
    await f.emit({ version: 1, sessionId: "s", eventId: "e1", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "system_message", itemId: "fresh", text: "fresh", level: "info" } });
    expect(stripVTControlCharacters(f.instance.render(80, 24).join("\n"))).toContain("new activity");
    f.instance.handleInput("\x1b[F");
    expect(stripVTControlCharacters(f.instance.render(80, 24).join("\n"))).not.toContain("new activity");
  });

  it("restores a stored session color when the viewer reopens", async () => {
    // The colour lives on the session record, so reopening paints the prompt box with no fresh /color.
    const f = fixture({ menu: async () => ({ commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null, color: "amber", registryRevision: 3 }) });
    await f.instance.open();
    expect(f.instance.render(80, 20).join("\n")).toContain("\x1b[38;2;252;211;77m");
  });

  it("colors the prompt box and leaves the typed text white", async () => {
    const f = fixture({ menu: async () => ({ commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null, color: "amber" }) });
    await f.instance.open();
    f.instance.editor.setText("hello");
    const rendered = f.instance.render(80, 20);
    const plain = rendered.map(stripVTControlCharacters);
    const top = plain.findIndex((line) => /^\u256d\u2500+\u256e$/u.test(line.trim()));
    expect(top).toBeGreaterThan(0);
    expect(plain[top + 1]).toMatch(/^\u2502.*hello.*\u2502$/u);
    expect(plain.some((line) => /^\u2570\u2500+\u256f$/u.test(line.trim()))).toBe(true);
    // The frame carries the colour; the prompt text does not.
    expect(rendered[top]).toContain("\x1b[38;2;252;211;77m");
    const promptRow = rendered[top + 1];
    expect(promptRow).toContain("\x1b[38;2;252;211;77m");
    expect(promptRow.slice(promptRow.indexOf("hello") - 12, promptRow.indexOf("hello"))).not.toContain("\x1b[38;2;252;211;77m");
    for (const width of [40, 55, 80, 120, 160]) {
      for (const line of f.instance.render(width, 20)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
