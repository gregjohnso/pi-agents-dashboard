import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { ViewerController } from "./viewer-controller.mjs";

const timestamp = "2026-08-25T00:00:00Z";
function snapshot(overrides = {}) {
  return {
    version: 1, sessionId: "s", registryRevision: 1, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "0" }, runtime: null,
    taskState: "READY", processState: "LIVE", outcome: "NONE",
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
  let connectionListener;
  const commands = [];
  const order = [];
  const saved = [];
  const attached = [];
  const subscribed = [];
  let snapshots = 0;
  const client = {
    async getSnapshot() { order.push("snapshot"); return snapshot(typeof overrides.snapshot === "function" ? overrides.snapshot(snapshots++) : overrides.snapshot); },
    subscribe(_sessionId, cursor, next) { subscribed.push(cursor); listener = next; return () => order.push("unsubscribe"); },
    onConnectionChange(next) { connectionListener = next; return () => { connectionListener = undefined; }; },
    ...(overrides.attach === undefined ? {} : { attach: async (sessionId) => { attached.push(sessionId); return overrides.attach(sessionId); } }),
    async command(operation, payload) { commands.push({ operation, payload }); return overrides.command?.(operation, payload); },
    ...(overrides.menu === undefined ? {} : { menu: overrides.menu }),
    // A trap, not a seam the viewer uses: the resume cursor is the frontend's own, and nothing here
    // may report it to the daemon.
    async ack(_sessionId, cursor) { order.push(`ack:${cursor.sequence}`); },
  };
  const persistence = { async load() { return overrides.persisted; }, async save(value) { await overrides.save?.(value); saved.push(structuredClone(value)); order.push(`persist:${value.cursor?.sequence ?? "draft"}`); } };
  const dashboard = [];
  const instance = new ViewerController({ sessionId: "s", client, editor: overrides.editor ?? editor(), persistence, requestRender: async () => { order.push("render"); }, onReturn: vi.fn(), now: () => 0, onDashboardAction: (action) => dashboard.push(action) });
  return { instance, client, commands, order, saved, dashboard, attached, subscribed, emit: (event) => listener(event), connection: (status) => connectionListener(status) };
}

describe("viewer commands", () => {
  it("sends prompt while idle, follow_up while working, explicit steer, interrupt, and one UI response", async () => {
    const f = fixture();
    await f.instance.open();
    f.instance.editor.setText("first"); f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(1));
    const eventStart = f.order.length;
    await f.emit({ version: 1, sessionId: "s", eventId: "e1", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "turn_state", working: true } });
    expect(f.order.slice(eventStart, eventStart + 2)).toEqual(["render", "persist:1"]);
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
    const menu = { commands: [{ name: "/review", source: "extension" }], models: [{ provider: "anthropic", id: "claude" }], model: null };
    const loaded = [];
    const f = fixture({ menu: async () => { loaded.push("menu"); return menu; } });
    await f.instance.open();
    await f.instance.menuLoaded;
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

  it("renders and leaves before the session menu answers", async () => {
    // The menu is a worker round trip. While open() awaited it, a daemon that never answered kept the
    // operator inside the transition: the viewer drew but Escape could not get back to the list.
    let releaseMenu;
    const f = fixture({ menu: () => new Promise((resolve) => { releaseMenu = () => resolve({ commands: [], models: [], model: null, color: "amber" }); }) });
    await f.instance.open();
    expect(stripVTControlCharacters(f.instance.render(80, 12).join("\n"))).toContain("hello");
    f.instance.handleInput("\x1b");
    expect(f.instance.onReturn).toHaveBeenCalledOnce();

    releaseMenu();
    await f.instance.menuLoaded;
    expect(f.instance.render(80, 20).join("\n")).toContain("\x1b[38;2;252;211;77m");
  });

  it("records why an open failed before it closes", async () => {
    const failure = Object.assign(new Error("Unknown viewer session"), { code: "SESSION_NOT_FOUND" });
    const f = fixture();
    f.client.getSnapshot = async () => { throw failure; };
    await expect(f.instance.open()).rejects.toThrow(failure);
    expect(f.instance.openError).toBe(failure);
  });

  it("opens one picker per bare built-in, applies the choice, and refuses a mistyped argument", async () => {
    const f = fixture({ menu: async () => ({ commands: [], models: [{ provider: "anthropic", id: "claude" }, { provider: "openai", id: "gpt-5" }], model: null }) });
    await f.instance.open();

    f.instance.editor.setText("/model");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    expect(f.instance.render(80, 24).join("\n")).toContain("anthropic/claude");
    f.instance.handleInput("\x1b[B");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "session_command", payload: { sessionId: "s", command: "set_model", model: { provider: "openai", id: "gpt-5" } } }]));
    expect(f.instance.selection).toBeUndefined();

    // Only a bare command opens a picker: a mistyped argument is a rejection the operator has to fix.
    f.instance.editor.setText("/model invented/model");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.render(80, 24).join("\n")).toContain("UNKNOWN_MODEL"));
    expect(f.instance.selection).toBeUndefined();
    expect(f.commands).toHaveLength(1);
  });

  it.each(["/thinking", "/auto-compact", "/steering", "/follow-up"])("prompts the session with %s instead of opening a settings picker", async (text) => {
    const f = fixture();
    await f.instance.open();

    f.instance.editor.setText(text);
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands.at(-1)).toEqual({ operation: "prompt", payload: { sessionId: "s", text } }));
    expect(f.instance.selection).toBeUndefined();
  });

  it("answers /help, /new, and /resume in the viewer without prompting the session", async () => {
    const f = fixture();
    await f.instance.open();

    f.instance.editor.setText("/help");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.instance.overlay?.title).toBe("Viewer help"));
    const help = f.instance.render(80, 24).join("\n");
    expect(help).not.toContain("/stats");
    expect(help).not.toContain("/auto-compact");
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
    const f = fixture({ menu: async () => ({ commands: [], models: [], model: null, color: stored }) });
    f.client.setSessionColor = async (/** @type {string} */ sessionId, /** @type {string | null} */ color) => {
      colored.push({ sessionId, color });
      stored = color;
      return { kind: "session_colored", sessionId, revision: 8, color };
    };
    await f.instance.open();
    await f.instance.menuLoaded;

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
    const reopened = fixture({ menu: async () => ({ commands: [], models: [], model: null, color: "amber" }) });
    await reopened.instance.open();
    await reopened.instance.menuLoaded;
    expect(reopened.instance.render(80, 20).join("\n")).toContain("\x1b[38;2;252;211;77m");
  });

  it("names the session on the prompt's top rule", async () => {
    const framed = { ...editor(), render: () => ["─".repeat(60), "> do 3", "─".repeat(60)] };
    const f = fixture({ editor: framed, menu: async () => ({ commands: [], models: [], model: null, color: null, name: "recurse agent investigation" }) });
    await f.instance.open();
    await f.instance.menuLoaded;
    const plain = f.instance.render(80, 20).map(stripVTControlCharacters);
    const promptRow = plain.findLastIndex((line) => line.startsWith("> "));
    // The name rides the rule above the prompt, right-aligned, so the operator sees which session they type into.
    expect(plain[promptRow - 1]).toMatch(/^─+ recurse agent investigation ─$/u);
    expect(plain[promptRow]).toBe("> do 3");
  });

  it("leaves the rule bare when the session has no name", async () => {
    const framed = { ...editor(), render: () => ["─".repeat(60), "> do 3", "─".repeat(60)] };
    const f = fixture({ editor: framed, menu: async () => ({ commands: [], models: [], model: null, color: null }) });
    await f.instance.open();
    await f.instance.menuLoaded;
    const plain = f.instance.render(80, 20).map(stripVTControlCharacters);
    const promptRow = plain.findLastIndex((line) => line.startsWith("> "));
    expect(plain[promptRow - 1]).toMatch(/^─+$/u);
  });

  it("colors the border Pi's editor already draws instead of adding rules", async () => {
    // Pi's editor renders its own frame; adding ours put four rules on screen instead of two.
    const framed = { ...editor(), render: () => ["─".repeat(20), "> hello", "─".repeat(20)] };
    const f = fixture({ editor: framed, menu: async () => ({ commands: [], models: [], model: null, color: "amber" }) });
    await f.instance.open();
    await f.instance.menuLoaded;
    const rendered = f.instance.render(80, 20);
    const plain = rendered.map(stripVTControlCharacters);
    expect(plain.filter((line) => /^─+$/u.test(line.trim()) && line.trim() !== "")).toHaveLength(2);
    const promptRow = plain.findLastIndex((line) => line.startsWith("> "));
    expect(rendered[promptRow - 1]).toContain("\x1b[38;2;252;211;77m");
    expect(rendered[promptRow]).not.toContain("\x1b[38;2;252;211;77m");
  });

  // Operator-visible failure: a second dashboard on a session was read-only, so the keys that answer
  // the agent did nothing. Every viewer writes now, and tool inspection still works alongside it.
  it("submits from a second viewer on the same session while tool inspection still works", async () => {
    const tool = (/** @type {string} */ id) => ({ id, name: "future_tool", state: "completed", arguments: { id }, result: [{ type: "text", text: `result ${id}` }], startedAt: timestamp, finishedAt: timestamp });
    const f = fixture({ snapshot: { tools: [tool("tool-a"), tool("tool-b")] } });
    await f.instance.open();
    f.instance.editor.setText("answer from the second viewer");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "prompt", payload: { sessionId: "s", text: "answer from the second viewer" } }]));
    expect(stripVTControlCharacters(f.instance.render(55, 16).join("\n"))).not.toMatch(/OBSERVER|COMPOSER|Read-only/u);

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
      async command() {},
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

  it.each(["render", "persistence", "malformed event"])("closes only the viewer subscription after %s failure without advancing the resume cursor", async (failure) => {
    const f = fixture({ save: failure === "persistence" ? async (value) => { if (value.cursor?.sequence === "1") throw new Error("persist failed"); } : undefined });
    await f.instance.open();
    if (failure === "render") f.instance.requestRender = async () => { throw new Error("render failed"); };
    const value = failure === "malformed event" ? { invalid: true } : { version: 1, sessionId: "s", eventId: "e1", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "turn_state", working: true } };
    await expect(f.emit(value)).rejects.toThrow();
    expect(f.order).toContain("unsubscribe");
    expect(f.order.some((entry) => entry.startsWith("ack:"))).toBe(false);
    expect(f.saved.some((state) => state.cursor?.sequence === "1")).toBe(false);
    expect(f.commands).toEqual([]);
  });
});

describe("frontend resume across a reconnect", () => {
  // Three windows where the socket can drop around one event. The frontend advances its resume
  // cursor only after the event is applied and drawn, so the resumed subscription can hand the
  // boundary event over a second time; its stable event ID has to absorb that. The daemon is never
  // told where this viewer stands.
  const at = { daemonEpoch: "epoch", sessionId: "s", sequence: "1" };
  const boundary = (payload) => ({ version: 1, sessionId: "s", eventId: "boundary", cursor: at, timestamp, payload });
  const identities = (instance) => instance.state.items.map((item) => item.itemId ?? item.attachment?.id ?? item.piType);
  const empty = { items: [], tools: [] };

  // Each case pairs one event payload with the snapshot a daemon that already published it returns,
  // and with the transcript identity that must appear exactly once.
  const kinds = [
    ["user_message", { kind: "user_message", itemId: "b", content: [{ type: "text", text: "boundary" }] }, (payload) => ({ items: [payload], tools: [] }), "b"],
    ["system_message", { kind: "system_message", itemId: "b", text: "boundary", level: "info" }, (payload) => ({ items: [payload], tools: [] }), "b"],
    ["image_placeholder", { kind: "image_placeholder", attachment: { id: "b", path: "b.png", mediaType: "image/png", width: 1, height: 1 } }, (payload) => ({ items: [payload], tools: [] }), "b"],
    ["unknown_pi_event", { kind: "unknown_pi_event", piType: "future", summary: "boundary" }, (payload) => ({ items: [payload], tools: [] }), "future"],
    ["tool_started", { kind: "tool_started", tool: { id: "b", name: "bash", state: "running", arguments: {}, startedAt: timestamp } }, (payload) => ({ items: [], tools: [payload.tool] }), "tool:b"],
  ];
  const republished = (asSnapshot, payload) => (call) => (call === 0 ? empty : { ...asSnapshot(payload), cursor: at });

  it.each(kinds)("keeps one %s item when the socket drops before the event is processed", async (_name, payload, asSnapshot, identity) => {
    const f = fixture({ snapshot: republished(asSnapshot, payload), attach: async () => ({ kind: "attached", sessionId: "s" }) });
    await f.instance.open();
    await f.connection({ connected: false });
    await f.connection({ connected: true });

    expect(identities(f.instance)).toEqual([identity]);
    expect(f.subscribed.at(-1)).toEqual(at);
    expect(f.order.filter((entry) => entry.startsWith("ack:"))).toEqual([]);
  });

  it.each(kinds)("keeps one %s item when the socket drops after the event is drawn but before the cursor advances", async (_name, payload, asSnapshot, identity) => {
    const f = fixture({ snapshot: republished(asSnapshot, payload), attach: async () => ({ kind: "attached", sessionId: "s" }) });
    await f.instance.open();
    await f.emit(boundary(payload));
    expect(identities(f.instance)).toEqual([identity]);

    await f.connection({ connected: false });
    await f.connection({ connected: true });
    await f.emit(boundary(payload));

    expect(identities(f.instance)).toEqual([identity]);
    expect(f.order.filter((entry) => entry.startsWith("ack:"))).toEqual([]);
  });

  it("continues without a gap when the socket drops after the resume cursor advanced", async () => {
    const [, payload, asSnapshot, identity] = kinds[0];
    const f = fixture({ snapshot: republished(asSnapshot, payload), attach: async () => ({ kind: "attached", sessionId: "s" }) });
    await f.instance.open();
    await f.emit(boundary(payload));
    await f.connection({ connected: false });
    await f.connection({ connected: true });

    expect(f.subscribed.at(-1)).toEqual(at);
    await f.emit({ version: 1, sessionId: "s", eventId: "next", cursor: { ...at, sequence: "2" }, timestamp, payload: { kind: "system_message", itemId: "n", text: "after the drop", level: "info" } });
    expect(identities(f.instance)).toEqual([identity, "n"]);
    expect(f.order.filter((entry) => entry.startsWith("ack:"))).toEqual([]);
  });
});

describe("Pi interactive-mode parity", () => {
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

});

describe("daemon outage", () => {
  it("says the daemon is unreachable and rebuilds the session when it comes back", async () => {
    const f = fixture({ attach: async () => ({ kind: "attached", sessionId: "s" }) });
    await f.instance.open();
    const view = () => stripVTControlCharacters(f.instance.render(80, 24).join("\n"));
    expect(view()).not.toContain("Daemon unreachable");

    await f.connection({ connected: false });
    expect(view()).toContain("Daemon unreachable");
    expect(f.instance.closedState).toBe(false);

    await f.connection({ connected: true });
    expect(view()).not.toContain("Daemon unreachable");
    expect(f.attached).toEqual(["s"]);
    expect(f.order.filter((entry) => entry === "snapshot")).toHaveLength(2);
    expect(f.order.filter((entry) => entry === "unsubscribe")).toHaveLength(1);

    // The rebuilt subscription feeds the same transcript, from the new daemon's cursor.
    await f.emit({ version: 1, sessionId: "s", eventId: "after", cursor: { daemonEpoch: "epoch-2", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "system_message", itemId: "back", text: "daemon is back", level: "info" } });
    expect(view()).toContain("daemon is back");
  });

  it("keeps the viewer open and says why when the returning daemon refuses to reopen the session", async () => {
    const f = fixture({ attach: async () => { throw Object.assign(new Error("Unknown viewer session"), { code: "SESSION_NOT_FOUND" }); } });
    await f.instance.open();
    await f.connection({ connected: false });
    await f.connection({ connected: true });

    expect(f.instance.closedState).toBe(false);
    expect(stripVTControlCharacters(f.instance.render(80, 24).join("\n"))).toContain("SESSION_NOT_FOUND");
  });
});

describe("transcript scrolling keys and wheel", () => {
  const longSnapshot = { items: Array.from({ length: 60 }, (_, index) => ({ kind: "system_message", itemId: `i-${index}`, text: `line ${index}`, level: "info" })) };

  // Arrows scroll only when Pi's editor has nothing to offer: no draft to move within and no history
  // to recall. Either one hands the arrows back, which keeps recall working and keeps the Left
  // double-press gesture honest about a dirty prompt.
  it.each([
    ["an empty prompt with no history", () => {}, false],
    ["recallable prompt history", (/** @type {any} */ f) => f.instance.history.push("earlier prompt"), true],
  ])("routes the arrows to %s", async (_label, prepare, editorKeeps) => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    f.instance.render(80, 24);
    prepare(f);
    f.instance.handleInput("\x1b[A");
    expect(f.instance.transcript.following).toBe(editorKeeps);
    expect(f.instance.transcript.linesFromEnd).toBe(editorKeeps ? 0 : 1);
    f.instance.handleInput("\x1b[B");
    expect(f.instance.transcript.following).toBe(true);
    expect(f.instance.transcript.linesFromEnd).toBe(0);
  });

  it("jumps with Home and End, scrolls on the wheel, and clears the new-activity marker at the end", async () => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    const body = () => stripVTControlCharacters(f.instance.render(80, 24).join("\n"));
    body();

    f.instance.handleMouse({ button: "wheel_up", column: 10, row: 5 });
    expect(f.instance.transcript.following).toBe(false);
    expect(f.instance.transcript.linesFromEnd).toBe(1);
    f.instance.handleMouse({ button: "wheel_down", column: 10, row: 5 });
    expect(f.instance.transcript.following).toBe(true);

    // Home shows the oldest lines filling the transcript, not one message stranded on a blank screen.
    f.instance.handleInput("\x1b[H");
    expect(f.instance.transcript.following).toBe(false);
    const top = body();
    expect(top).toContain("line 0");
    expect(top).toContain("line 8");
    expect(top).not.toContain("line 59");
    await f.emit({ version: 1, sessionId: "s", eventId: "e1", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "system_message", itemId: "fresh", text: "fresh", level: "info" } });
    expect(body()).toContain("new activity");
    expect(body()).toContain("line 0");

    f.instance.handleInput("\x1b[F");
    expect(f.instance.transcript.following).toBe(true);
    expect(f.instance.transcript.linesFromEnd).toBe(0);
    const tail = body();
    expect(tail).not.toContain("new activity");
    expect(tail).toContain("fresh");
  });

});
