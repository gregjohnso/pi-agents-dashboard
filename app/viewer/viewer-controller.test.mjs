import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { createViewerNormalizer } from "../../runtime/viewer-normalizer.mjs";
import { createPiEditor } from "./pi-component-adapters.mjs";
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
/**
 * One subscription's event queue, read by the controller's own pump rather than by a listener this
 * fixture calls. A double that hands events straight to `processEvent` cannot fail the way the pump
 * fails, and the pump is what turns a stream failure into a rebuild.
 */
function createSubscription(order) {
  /** @type {any[]} */
  const queue = [];
  /** @type {any} */
  let waiter;
  /** @type {unknown} */
  let failure;
  let ended = false;
  const events = {
    async next() {
      if (queue.length > 0) return { value: queue.shift(), done: false };
      if (failure !== undefined) { const raised = failure; failure = undefined; throw raised; }
      if (ended) return { value: undefined, done: true };
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    async return() {
      if (!ended) order.push("unsubscribe");
      ended = true;
      waiter?.resolve({ value: undefined, done: true });
      waiter = undefined;
      return { value: undefined, done: true };
    },
  };
  return {
    events,
    unsubscribe() { void events.return(); },
    /** @param {any} event */
    push(event) {
      if (waiter === undefined) { queue.push(event); return; }
      const waiting = waiter;
      waiter = undefined;
      waiting.resolve({ value: event, done: false });
    },
    /** @param {unknown} raised */
    fail(raised) {
      if (waiter === undefined) { failure = raised; return; }
      const waiting = waiter;
      waiter = undefined;
      waiting.reject(raised);
    },
    get ended() { return ended; },
  };
}

function fixture(overrides = {}) {
  let connectionListener;
  const commands = [];
  const order = [];
  const saved = [];
  const attached = [];
  /** @type {any[]} */
  const subscriptions = [];
  let snapshots = 0;
  // One client, the shape the daemon client itself has: every method is present, so a viewer that
  // reached for one this fixture omitted would fail here the way it fails against the real daemon.
  const client = {
    async subscribeViewer() {
      order.push("snapshot");
      const subscription = createSubscription(order);
      subscriptions.push(subscription);
      return { snapshot: snapshot(typeof overrides.snapshot === "function" ? overrides.snapshot(snapshots++) : overrides.snapshot), events: subscription.events, unsubscribe: () => subscription.unsubscribe() };
    },
    onConnectionChange(next) { connectionListener = next; return () => { connectionListener = undefined; }; },
    async attach(sessionId) { attached.push(sessionId); return overrides.attach?.(sessionId) ?? { kind: "attached", sessionId }; },
    async detach(sessionId) { return { kind: "detached", sessionId }; },
    async command(operation, payload) { commands.push({ operation, payload }); return overrides.command?.(operation, payload); },
    sessionMenu: overrides.menu ?? (async () => ({ commands: [], models: [], model: null, color: null })),
    // A trap, not a seam the viewer uses: the resume cursor is the frontend's own, and nothing here
    // may report it to the daemon.
    async ack(_sessionId, cursor) { order.push(`ack:${cursor.sequence}`); },
  };
  const persistence = { async load() { return overrides.persisted; }, async save(value) { await overrides.save?.(value); saved.push(structuredClone(value)); order.push(`persist:${value.cursor?.sequence ?? "draft"}`); } };
  const dashboard = [];
  const instance = new ViewerController({ sessionId: "s", client, editor: overrides.editor ?? editor(), persistence, requestRender: async () => { order.push("render"); }, onReturn: vi.fn(), onQuit: overrides.onQuit, now: overrides.now ?? (() => 0), onDashboardAction: (action) => dashboard.push(action) });
  // Observe the pump: `emit` and `refuseStream` settle exactly as the controller's own handling of
  // that event or failure settled, so a test never polls for work the pump has already finished.
  /** @param {string} method @returns {() => any} */
  const observe = (method) => {
    const original = instance[method].bind(instance);
    /** @type {any} */
    let settled;
    instance[method] = async (/** @type {any} */ value) => {
      try {
        const result = await original(value);
        settled?.resolve(result);
        return result;
      } catch (error) {
        settled?.reject(error);
        throw error;
      }
    };
    return (/** @type {any} */ handler) => new Promise((resolve, reject) => { settled = { resolve, reject }; handler(); });
  };
  const onProcessed = observe("processEvent");
  const onStreamFailed = observe("streamFailed");
  const live = () => subscriptions.filter((subscription) => !subscription.ended).at(-1) ?? subscriptions.at(-1);
  return {
    instance, client, commands, order, saved, dashboard, attached, subscriptions,
    emit: (event) => onProcessed(() => live().push(event)),
    refuseStream: (error) => onStreamFailed(() => live().fail(error)),
    connection: (status) => connectionListener(status),
  };
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

  it("shows a Pi refusal as the sentence Pi wrote, with no transport code in front of it", async () => {
    const f = fixture({ snapshot: { errors: [{ code: "RPC_COMMAND_FAILED", message: "Cannot submit a prompt while compaction is in progress.", retryable: false }] } });
    await f.instance.open();

    const dock = f.instance.render(100, 24).map(stripVTControlCharacters).join(" ");
    expect(dock).not.toContain("RPC_COMMAND_FAILED");
    expect(dock).toContain("Pi refused this command: Cannot submit a prompt while compaction is in progress.");
    await f.instance.close();
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

  it("clears the prompt on Ctrl+C without interrupting an idle session, and quits on a second press inside 500 ms", async () => {
    let now = 1_000;
    const onQuit = vi.fn();
    const f = fixture({ now: () => now, onQuit });
    await f.instance.open();
    f.instance.editor.setText("draft");
    f.instance.handleInput("\x03");
    expect(f.instance.editor.getText()).toBe("");
    expect(f.commands).toEqual([]);
    expect(onQuit).not.toHaveBeenCalled();
    // The window has passed, so this press clears again rather than quitting.
    now += 500;
    f.instance.handleInput("\x03");
    expect(onQuit).not.toHaveBeenCalled();
    now += 499;
    f.instance.handleInput("\x03");
    expect(onQuit).toHaveBeenCalledOnce();
    // Quitting is the frontend leaving: it never returns to the list and sends the session nothing.
    expect(f.instance.onReturn).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
    await f.instance.close();
  });

  it("interrupts a working turn once and sends nothing on the press that quits", async () => {
    const onQuit = vi.fn();
    const f = fixture({ snapshot: { taskState: "WORKING" }, onQuit });
    await f.instance.open();
    f.instance.editor.setText("draft");
    f.instance.handleInput("\x03");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "interrupt", payload: { sessionId: "s" } }]));
    expect(f.instance.editor.getText()).toBe("");
    expect(onQuit).not.toHaveBeenCalled();
    f.instance.handleInput("\x03");
    expect(onQuit).toHaveBeenCalledOnce();
    expect(f.commands).toHaveLength(1);
    await f.instance.close();
  });

  it("clears a steer draft with Ctrl+C and stays in steer mode", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING" } });
    await f.instance.open();
    f.instance.handleInput("\x13");
    for (const character of "urgent") f.instance.handleInput(character);
    expect(f.instance.editor.getText()).toBe("urgent");
    f.instance.handleInput("\x03");
    expect(f.instance.editor.getText()).toBe("");
    expect(f.instance.inputMode).toBe("steer");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "interrupt", payload: { sessionId: "s" } }]));
    await f.instance.close();
  });

  it("forgets an armed quit when the same viewer is reopened", async () => {
    const onQuit = vi.fn();
    const f = fixture({ onQuit });
    await f.instance.open();
    f.instance.handleInput("\x03");
    await f.instance.close();
    await f.instance.open();
    f.instance.handleInput("\x03");
    expect(onQuit).not.toHaveBeenCalled();
    await f.instance.close();
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
    f.client.subscribeViewer = async () => { throw failure; };
    await expect(f.instance.open()).rejects.toThrow(failure);
    expect(f.instance.openError).toBe(failure);
  });

  it("opens one picker per bare built-in, applies the choice, and refuses a mistyped argument", async () => {
    const f = fixture({ menu: async () => ({ commands: [], models: [{ provider: "anthropic", id: "claude" }, { provider: "openai", id: "gpt-5" }], model: null }) });
    await f.instance.open();
    // The picker is built from the menu, which loads behind the open on purpose.
    await f.instance.menuLoaded;

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

  // Operator-visible failure: the supervisor replaced this session's worker at a release boundary and
  // the transcript said nothing for the two minutes Pi took to restart and resume, so the operator
  // read a live restart as a hung session. The notice is the normalizer's own, not a string this test
  // invents: it comes from the same frame the daemon ingests when it replaces a worker.
  it("shows the supervisor's worker replacement in the transcript it renders", async () => {
    const f = fixture();
    await f.instance.open();
    const [draft] = createViewerNormalizer({ sessionId: "s", protocolVersion: 1, now: () => timestamp })
      .consumeFrame({ type: "worker_replacing", id: "respawn:run-1" });

    await f.emit({ version: 1, sessionId: "s", eventId: draft.eventId, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: draft.payload });

    const rendered = stripVTControlCharacters(f.instance.render(100, 24).join("\n"));
    expect(rendered).toContain("Restarting this session's worker");
    expect(rendered).not.toContain("Unsupported");
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

  it("opens steer input over the draft", async () => {
    const f = fixture({ snapshot: {
      items: [{ kind: "assistant_message", itemId: "middle", content: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: "middle" }] }],
      thinkingLevel: "high",
    } });
    await f.instance.open();

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
        // Hidden thinking blocks are still a state this dock draws; no key reaches it, so set it here.
        f.instance.hideThinking = true;
        f.instance.transcript.setThinkingHidden(true);
        matrix["thinking-hidden"] = f.instance.render(width, height).map(stripVTControlCharacters);
        f.instance.hideThinking = false;
        f.instance.transcript.setThinkingHidden(false);
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

  // The snapshot a subscription carries is the transcript's start, and events continue it. Nothing
  // replays, so an event that arrives while this viewer is still building state waits in the
  // subscription's queue rather than being dropped or applied out of order.
  it("continues the subscription's own snapshot with events queued while it was building", async () => {
    const f = fixture({
      snapshot: {
        items: [{ kind: "user_message", itemId: "u1", content: [{ type: "text", text: "one" }] }],
        cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "4" },
      },
    });
    await f.instance.open();
    await f.emit({ version: 1, sessionId: "s", eventId: "ordered-5", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "5" }, timestamp, payload: { kind: "assistant_message", itemId: "a1", content: [{ type: "text", text: "live after snapshot" }] } });
    expect(f.instance.state.items.map((item) => item.itemId)).toEqual(["u1", "a1"]);
    expect(f.instance.state.cursor.sequence).toBe("5");
    await f.instance.close();
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

    await f.emit({ version: 1, sessionId: "s", eventId: "next", cursor: { ...at, sequence: "2" }, timestamp, payload: { kind: "system_message", itemId: "n", text: "after the drop", level: "info" } });
    expect(identities(f.instance)).toEqual([identity, "n"]);
    expect(f.order.filter((entry) => entry.startsWith("ack:"))).toEqual([]);
  });
});

describe("Pi interactive-mode parity", () => {
  const view = (/** @type {any} */ f) => stripVTControlCharacters(f.instance.render(80, 24).join("\n"));
  const pendingRows = (/** @type {any} */ f) => view(f).split("\n").filter((line) => /Pending:|Steering:/u.test(line)).map((line) => line.trim());
  const event = (/** @type {string} */ sequence, /** @type {any} */ payload) => ({ version: 1, sessionId: "s", eventId: `e${sequence}`, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence }, timestamp, payload });

  // The operator's own view of the lost-prompt fix: this frontend believes the session is idle while
  // Pi has already started a turn, so it cannot say whether Pi began this text or queued it. What it
  // can say is that the text was accepted and has not appeared yet, and it must keep saying it until
  // the transcript carries the text.
  it("shows every accepted submission as pending, in submission order, until the transcript carries it", async () => {
    const f = fixture();
    await f.instance.open();

    f.instance.editor.setText("deploy it");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands.at(-1)?.operation).toBe("prompt"));
    expect(view(f)).toContain(" Pending: deploy it");

    await f.instance.submitSteer("stop at the tests");
    f.instance.editor.setText("then tag it");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(3));
    expect(pendingRows(f)).toEqual(["Pending: deploy it", "Steering: stop at the tests", "Pending: then tag it"]);

    // A settled turn is not proof about text Pi has not shown yet, so it drops nothing.
    await f.emit(event("1", { kind: "turn_state", working: false }));
    expect(pendingRows(f)).toEqual(["Pending: deploy it", "Steering: stop at the tests", "Pending: then tag it"]);

    await f.emit(event("2", { kind: "user_message", itemId: "landed", content: [{ type: "text", text: "deploy it" }] }));
    expect(pendingRows(f)).toEqual(["Steering: stop at the tests", "Pending: then tag it"]);
  });

  it("keeps text the transcript already carried pending until this submission's own copy lands", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING" } });
    await f.instance.open();
    f.instance.editor.setText("hello");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(1));

    // The snapshot's own user message says "hello" too; it is not this submission.
    await f.emit(event("1", { kind: "system_message", itemId: "noise", text: "working", level: "info" }));
    expect(pendingRows(f)).toEqual(["Pending: hello"]);

    await f.emit(event("2", { kind: "user_message", itemId: "second-hello", content: [{ type: "text", text: "hello" }] }));
    expect(pendingRows(f)).toEqual([]);
  });

  it("takes a refused submission out of the pending block and leaves the text in the composer", async () => {
    /** @type {(error: Error) => void} */
    let refuse = () => {};
    const f = fixture({ command: async () => new Promise((_resolve, reject) => { refuse = reject; }) });
    await f.instance.open();
    f.instance.editor.setText("ship it");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(1));
    expect(pendingRows(f)).toEqual(["Pending: ship it"]);

    refuse(Object.assign(new Error("Cannot submit a prompt while compaction is in progress."), { code: "RPC_COMMAND_FAILED", retryable: false }));
    await vi.waitFor(() => expect(pendingRows(f)).toEqual([]));
    expect(view(f)).toContain("Pi refused this command: Cannot submit a prompt");
    expect(f.instance.editor.getText()).toBe("ship it");
  });

  // Pi expands a leading slash before the text becomes a message, so this submission may reach the
  // transcript changed or never reach it at all, and no event could ever clear its row.
  it("draws no pending row for slash text, on the prompt path and on the steer path", async () => {
    const f = fixture({ menu: async () => ({ commands: [{ name: "/review", source: "extension" }], models: [], model: null }) });
    await f.instance.open();
    await f.instance.menuLoaded;

    f.instance.editor.setText("/review the diff");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands.at(-1)).toEqual({ operation: "prompt", payload: { sessionId: "s", text: "/review the diff" } }));
    expect(pendingRows(f)).toEqual([]);

    await f.instance.submitSteer("/skill:lint everything");
    await f.instance.submitSteer("plain steering");
    expect(f.commands.map(({ operation }) => operation)).toEqual(["prompt", "steer", "steer"]);
    expect(pendingRows(f)).toEqual(["Steering: plain steering"]);
  });

  // A pending row is this frontend's own memory, and a rebuild replaces the transcript it is matched
  // against. The cursor advances only after an event is applied, so a message that landed while the
  // daemon was away arrives in the rebuild's snapshot rather than as an event: without a sync there,
  // the row it belongs to would sit on screen until some later event happened to arrive.
  it("clears a pending row the reconnect snapshot already carries and keeps one it does not", async () => {
    const landed = { kind: "user_message", itemId: "landed-while-away", content: [{ type: "text", text: "first" }] };
    const f = fixture({
      attach: async () => ({ kind: "attached", sessionId: "s" }),
      snapshot: (/** @type {number} */ call) => call === 0 ? { taskState: "WORKING" } : { taskState: "WORKING", items: [landed] },
    });
    await f.instance.open();
    for (const text of ["first", "second"]) {
      f.instance.editor.setText(text);
      f.instance.handleInput("\r");
    }
    await vi.waitFor(() => expect(f.commands).toHaveLength(2));
    expect(pendingRows(f)).toEqual(["Pending: first", "Pending: second"]);

    await f.connection({ connected: false });
    await f.connection({ connected: true });

    expect(pendingRows(f)).toEqual(["Pending: second"]);
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

describe("refused viewer subscription", () => {
  const overflow = () => Object.assign(new Error("Initial viewer replay exceeds the subscriber bound"), { code: "SUBSCRIBER_OVERFLOW" });

  // Operator-visible failure: the daemon refuses to resume a subscription whose cursor is further
  // behind than the subscriber bound, and the refusal used to reach nothing. The transcript stopped
  // updating while the dock still drew a running turn.
  it("reloads from a fresh snapshot once, then reports the refusal instead of freezing the transcript", async () => {
    const f = fixture({ snapshot: { taskState: "WORKING" } });
    await f.instance.open();
    const view = () => stripVTControlCharacters(f.instance.render(80, 24).join("\n"));
    expect(view()).toContain("Working");

    await f.refuseStream(overflow());
    expect(f.subscriptions).toHaveLength(2);
    expect(f.order.filter((entry) => entry === "snapshot")).toHaveLength(2);

    // A refusal answered by another reload is a request loop, so the second one is the operator's.
    await f.refuseStream(overflow());
    expect(f.subscriptions).toHaveLength(2);
    expect(view()).toContain("SUBSCRIBER_OVERFLOW");
    expect(view()).toContain("Transcript stopped");
    expect(view()).not.toContain("Working");
    expect(f.instance.closedState).toBe(false);
  });

  it("reports a session the daemon no longer holds, which no reload can recover", async () => {
    const f = fixture();
    await f.instance.open();
    const gone = Object.assign(new Error("Viewer session does not exist"), { code: "SESSION_NOT_FOUND" });
    f.client.subscribeViewer = async () => { throw gone; };

    await f.refuseStream(gone);

    const view = stripVTControlCharacters(f.instance.render(80, 24).join("\n"));
    expect(view).toContain("SESSION_NOT_FOUND");
    expect(view).toContain("Transcript stopped");
    expect(f.instance.closedState).toBe(false);
  });
});

describe("transcript scrolling keys and wheel", () => {
  const longSnapshot = { items: Array.from({ length: 60 }, (_, index) => ({ kind: "system_message", itemId: `i-${index}`, text: `line ${index}`, level: "info" })) };

  it("keeps repeated Left and Right presses in a non-empty Pi editor draft", async () => {
    const piEditor = createPiEditor({ tui: { requestRender() {} } });
    const f = fixture({ editor: piEditor });
    await f.instance.open();
    piEditor.setText("abcd");

    f.instance.handleInput("\x1b[D");
    f.instance.handleInput("\x1b[D");
    f.instance.handleInput("X");
    f.instance.handleInput("\x1b[C");
    f.instance.handleInput("Y");

    expect(piEditor.getText()).toBe("abXcYd");
    expect(f.instance.onReturn).not.toHaveBeenCalled();
  });

  // Up and Down scroll only when Pi's editor has nothing to offer: no draft to move within and no
  // history to recall. A draft or history hands them back to the editor instead.
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

describe("installed Pi behavior the pending block depends on", () => {
  const piSource = (/** @type {string} */ path) => readFile(new URL(`../../node_modules/@earendil-works/pi-coding-agent/dist/${path}`, import.meta.url), "utf8");

  // Canary: Pi 0.84.3 expands a submitted slash before the text becomes a message. `session.prompt`
  // defaults `expandPromptTemplates` to true and RPC mode never overrides it, and `steer` and
  // `followUp` expand skills and prompt templates too, so text starting with "/" can reach the
  // transcript changed or, as an extension command, never reach it at all. That is why notePending
  // draws no row for it. When this fails, Pi changed how it treats a submitted slash: if it grew
  // verbatim delivery or a submission identity in its reply, delete that exception rather than
  // keeping it out of caution.
  it("still expands a submitted slash on every path a submission travels", async () => {
    const session = await piSource("core/agent-session.js");
    expect(session).toContain("options?.expandPromptTemplates ?? true");
    for (const operation of ["steer", "followUp"]) {
      const opens = `async ${operation}(text, images) {`;
      expect(session).toContain(opens);
      expect(session.slice(session.indexOf(opens), session.indexOf("await this._queue", session.indexOf(opens)))).toContain("expandPromptTemplate(expandedText");
    }

    const rpc = await piSource("modes/rpc/rpc-mode.js");
    expect(rpc).toContain('case "prompt": {');
    expect(rpc.slice(rpc.indexOf('case "prompt": {'), rpc.indexOf('case "steer": {'))).not.toContain("expandPromptTemplates");
  });
});

/**
 * Ctrl+T opens Pi's own thinking levels for this session.
 *
 * Operator-visible failure each test names: a key that changes nothing Pi can see, a picker that
 * offers a level Pi does not support, a level the footer claims before Pi confirmed it, and a draft
 * the picker eats.
 */
describe("thinking level picker", () => {
  const levelMenu = (overrides = {}) => async () => ({ commands: [], models: [], model: { provider: "anthropic", id: "opus" }, color: null, thinkingLevels: ["off", "low", "high"], thinkingLevel: "low", ...overrides });
  const screen = (/** @type {any} */ f) => stripVTControlCharacters(f.instance.render(80, 24).join("\n"));

  it("lists the levels Pi reported with the current one selected, leaving thinking blocks and the draft alone", async () => {
    const f = fixture({
      menu: levelMenu(),
      snapshot: { thinkingLevel: "low", items: [{ kind: "assistant_message", itemId: "reasoned", content: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: "answer" }] }] },
    });
    await f.instance.open();
    await f.instance.menuLoaded;
    f.instance.editor.setText("half typed");
    expect(screen(f)).toContain("private reasoning");

    f.instance.handleInput("\x14");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());

    const view = screen(f);
    expect(view).toContain("Select a thinking level");
    for (const level of ["off", "low", "high"]) expect(view).toContain(level);
    expect(view).toContain("→ low");
    expect(f.instance.editor.getText()).toBe("half typed");

    f.instance.handleInput("\x1b");
    expect(f.instance.selection).toBeUndefined();
    expect(f.commands).toEqual([]);
    expect(f.instance.editor.getText()).toBe("half typed");
    expect(f.instance.onReturn).not.toHaveBeenCalled();
    // The picker chooses what Pi thinks with, never what this transcript shows.
    expect(f.instance.hideThinking).toBe(false);
    expect(screen(f)).not.toContain("Thinking blocks: hidden");
    expect(screen(f)).toContain("private reasoning");
  });

  it("keeps the draft and its cursor across an opened and cancelled picker", async () => {
    const piEditor = createPiEditor({ tui: { requestRender() {}, setFocus() {} } });
    const f = fixture({ editor: piEditor, menu: levelMenu() });
    await f.instance.open();
    await f.instance.menuLoaded;
    piEditor.setText("abcd");
    f.instance.handleInput("\x1b[D");

    f.instance.handleInput("\x14");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    f.instance.handleInput("\x1b");
    f.instance.handleInput("X");

    expect(piEditor.getText()).toBe("abcXd");
  });

  it("sends one set_thinking_level for the chosen level and follows Pi's confirmation in the footer", async () => {
    const f = fixture({ menu: levelMenu(), snapshot: { thinkingLevel: "low", model: { provider: "anthropic", id: "opus" } } });
    await f.instance.open();
    await f.instance.menuLoaded;
    expect(screen(f)).toContain("opus • low");

    f.instance.handleInput("\x14");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    f.instance.handleInput("\x1b[B");
    f.instance.handleInput("\r");

    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "session_command", payload: { sessionId: "s", command: "set_thinking_level", level: "high" } }]));
    expect(f.instance.selection).toBeUndefined();
    // Pi confirms the change on its own stream; nothing here claims it first.
    expect(screen(f)).toContain("opus • low");
    await f.emit({ version: 1, sessionId: "s", eventId: "confirmed", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "thinking_state", level: "high" } });
    expect(screen(f)).toContain("opus • high");
    expect(f.commands).toHaveLength(1);
  });

  it("leaves the level where it was and says why when the daemon refuses the change", async () => {
    const f = fixture({
      menu: levelMenu(),
      snapshot: { thinkingLevel: "low", model: { provider: "anthropic", id: "opus" } },
      command: async () => { throw Object.assign(new Error("No exact recovered worker owns this session"), { code: "WORKER_UNAVAILABLE", retryable: false }); },
    });
    await f.instance.open();
    await f.instance.menuLoaded;

    f.instance.handleInput("\x14");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());
    f.instance.handleInput("\x1b[B");
    f.instance.handleInput("\r");

    await vi.waitFor(() => expect(screen(f)).toContain("WORKER_UNAVAILABLE"));
    expect(screen(f)).toContain("opus • low");
    expect(f.instance.closedState).toBe(false);
  });

  it("offers the levels of the model this session is on now, not the ones the last menu carried", async () => {
    let levels = ["off", "low", "high"];
    const f = fixture({ menu: async () => ({ commands: [], models: [], model: null, color: null, thinkingLevels: levels, thinkingLevel: "off" }) });
    await f.instance.open();
    await f.instance.menuLoaded;

    levels = ["off", "max"];
    f.instance.handleInput("\x14");
    await vi.waitFor(() => expect(f.instance.selection).toBeDefined());

    expect(screen(f)).toContain("max");
    expect(screen(f)).not.toContain("low");
  });

  it.each([
    ["a worker that reports no levels", async () => ({ commands: [], models: [], model: null, color: null, thinkingLevels: [], thinkingLevel: null })],
    ["a worker from a release that never sent them", async () => ({ commands: [], models: [], model: null, color: null })],
  ])("opens no picker for %s and says the levels are unavailable", async (_name, menu) => {
    const f = fixture({ menu });
    await f.instance.open();
    await f.instance.menuLoaded;

    f.instance.handleInput("\x14");

    await vi.waitFor(() => expect(screen(f)).toContain("THINKING_LEVELS_UNAVAILABLE"));
    expect(f.instance.selection).toBeUndefined();
    expect(f.instance.thinkingLoading).toBe(false);
    expect(f.commands).toEqual([]);
  });

  it("reports the menu failure once and opens no picker when the worker refuses the read", async () => {
    const f = fixture({ menu: async () => { throw Object.assign(new Error("This session's worker predates slash commands"), { code: "UNSUPPORTED_WORKER_OPERATION" }); } });
    await f.instance.open();
    await f.instance.menuLoaded;

    f.instance.handleInput("\x14");

    await vi.waitFor(() => expect(f.instance.thinkingLoading).toBe(false));
    expect(f.instance.selection).toBeUndefined();
    expect(screen(f)).not.toContain("THINKING_LEVELS_UNAVAILABLE");
    expect(f.instance.state.errors.map((/** @type {any} */ error) => error.code)).toEqual(["SESSION_COMMANDS_UNAVAILABLE", "SESSION_COMMANDS_UNAVAILABLE"]);
  });

  it("says the levels are loading and opens nothing when the viewer leaves before they arrive", async () => {
    /** @type {() => void} */
    let releaseLevels = () => {};
    let menuCalls = 0;
    const f = fixture({
      menu: () => {
        menuCalls += 1;
        if (menuCalls === 1) return Promise.resolve({ commands: [], models: [], model: null, color: null, thinkingLevels: ["off", "high"], thinkingLevel: "off" });
        return new Promise((resolve) => { releaseLevels = () => resolve({ commands: [], models: [], model: null, color: null, thinkingLevels: ["off", "high"], thinkingLevel: "off" }); });
      },
    });
    await f.instance.open();
    await f.instance.menuLoaded;

    f.instance.handleInput("\x14");
    expect(f.instance.thinkingLoading).toBe(true);
    expect(screen(f)).toContain("Thinking levels…");

    // Escape while the read is in flight cancels it: no picker afterwards, and the list is not left.
    f.instance.handleInput("\x1b");
    expect(f.instance.thinkingLoading).toBe(false);
    expect(f.instance.onReturn).not.toHaveBeenCalled();
    releaseLevels();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.instance.selection).toBeUndefined();
    expect(screen(f)).not.toContain("Thinking levels…");
  });

  it("opens no picker after the viewer closed while the levels were still loading", async () => {
    /** @type {() => void} */
    let releaseLevels = () => {};
    let menuCalls = 0;
    const f = fixture({
      menu: () => {
        menuCalls += 1;
        if (menuCalls === 1) return Promise.resolve({ commands: [], models: [], model: null, color: null, thinkingLevels: ["off", "high"], thinkingLevel: "off" });
        return new Promise((resolve) => { releaseLevels = () => resolve({ commands: [], models: [], model: null, color: null, thinkingLevels: ["off", "high"], thinkingLevel: "off" }); });
      },
    });
    await f.instance.open();
    await f.instance.menuLoaded;
    f.instance.handleInput("\x14");
    expect(menuCalls).toBe(2);

    await f.instance.close();
    releaseLevels();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(f.instance.selection).toBeUndefined();
  });
});

describe("viewer prompt", () => {
  // The dashboard's prompt clipped an over-wide draft; this pins that the viewer's does not, because
  // it is Pi's own editor rather than a hand-painted line.
  it("wraps a draft wider than the terminal instead of clipping it", async () => {
    const draft = "Add the Notion and Slack MCP servers to this session so the agent can read the release checklist";
    const f = fixture({ editor: createPiEditor({ tui: { requestRender() {} } }) });
    await f.instance.open();
    f.instance.editor.setText(draft);

    const lines = f.instance.render(60, 24).map(stripTerminalSequences);
    const rules = lines.flatMap((line, index) => /^─+$/u.test(line.trim()) ? [index] : []);
    const promptRows = lines.slice(rules.at(-2) + 1, rules.at(-1));

    expect(promptRows.length).toBeGreaterThan(1);
    expect(promptRows.join("").replace(/\s+/gu, "")).toBe(draft.replace(/\s+/gu, ""));
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });
});
