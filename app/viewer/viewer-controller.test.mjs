import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { TuiAltScreen, setKittyProtocolActive, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createViewerNormalizer } from "../../runtime/viewer-normalizer.mjs";
import { ScreenTerminal } from "../../test/alt-screen-harness.mjs";
import { createPiEditorDouble } from "../../test/pi-editor-double.mjs";
import { createPiEditor } from "./pi-component-adapters.mjs";
import { ViewerController } from "./viewer-controller.mjs";

/**
 * Every screen assertion below reads a real alternate screen.
 *
 * The viewer is one of Pi's layouts now: Pi clips it to the terminal, scrolls it, and composites its
 * dialogs over it. A test that called a viewport renderer of our own would be asserting against an
 * implementation this package no longer has.
 */
/** @type {any[]} */
const screens = [];
afterEach(() => { for (const tui of screens.splice(0)) tui.stop({ preserveScreen: true }); });

function altScreen() {
  const tui = new TuiAltScreen(new ScreenTerminal(), false, undefined, { mouse: false });
  tui.start();
  screens.push(tui);
  return tui;
}

/** Paint one viewer's layout at a terminal size and read the rows the operator would see. */
function paintedScreen(/** @type {any} */ instance, width = 80, height = 24) {
  const tui = instance.tui;
  const terminal = tui.terminal;
  if (terminal.columns !== width || terminal.rows !== height) terminal.resize(width, height);
  tui.setLayoutRoot(instance.layoutRoot);
  tui.renderNow();
  // A copy: the terminal keeps painting into its own rows, and a caller comparing two frames needs
  // the one it took to stay as it was.
  return [...terminal.lines];
}

// No test reads the operator's own ~/.pi/agent/keybindings.json; a remap test writes its own.
const NO_USER_BINDINGS = join(tmpdir(), "pi-agents-default-keybindings");
/** @type {string[]} */
const agentDirs = [];
afterEach(async () => { await Promise.all(agentDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function agentDir(bindings) {
  const dir = await mkdtemp(join(tmpdir(), "pi-agents-viewer-keys-"));
  agentDirs.push(dir);
  await writeFile(join(dir, "keybindings.json"), JSON.stringify(bindings));
  return dir;
}
function piEditorFor(agentDirPath = NO_USER_BINDINGS) {
  return createPiEditor({ tui: altScreen(), agentDir: agentDirPath });
}

const timestamp = "2026-08-25T00:00:00Z";
function snapshot(overrides = {}) {
  return {
    version: 1, sessionId: "s", registryRevision: 1, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "0" }, runtime: null,
    taskState: "READY", processState: "LIVE", outcome: "NONE",
    activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "snapshot", startedAt: timestamp }, model: null, thinkingLevel: null,
    items: [{ kind: "user_message", itemId: "u", content: [{ type: "text", text: "hello" }] }], tools: [], pendingUi: [], errors: [], ...overrides,
  };
}
/**
 * Pi's `CustomEditor` action layer, reduced to what this controller uses and dispatched in Pi's own
 * order through Pi's own keybindings. The tests at the end of this file drive the installed editor
 * itself, so a precedence this double got wrong still fails there.
 */
function editor() {
  return createPiEditorDouble({ addToHistory: vi.fn(), tui: altScreen() });
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
  it("sends prompt on Enter and follow_up on Alt+Enter whatever the cached turn state says, plus Escape's interrupt and one UI response", async () => {
    const f = fixture();
    await f.instance.open();
    f.instance.editor.setText("first"); f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(1));
    const eventStart = f.order.length;
    await f.emit({ version: 1, sessionId: "s", eventId: "e1", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "turn_state", working: true } });
    expect(f.order.slice(eventStart, eventStart + 2)).toEqual(["render", "persist:1"]);
    // The session is working now, and Enter still sends `prompt`: only Pi decides what to do with it.
    f.instance.editor.setText("next"); f.instance.handleInput("\r");
    f.instance.editor.setText("urgent"); f.instance.handleInput("\x1b\r");
    f.instance.handleInput("\x1b");
    await vi.waitFor(() => expect(f.commands.map(({ operation }) => operation)).toEqual(["prompt", "prompt", "follow_up", "interrupt"]));
    expect(f.commands.slice(0, 3).map(({ payload }) => payload.text)).toEqual(["first", "next", "urgent"]);
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

  it("clears a working session's prompt without interrupting it and sends nothing on the press that quits", async () => {
    const onQuit = vi.fn();
    const f = fixture({ snapshot: { taskState: "WORKING" }, onQuit });
    await f.instance.open();
    f.instance.editor.setText("draft");
    f.instance.handleInput("\x03");
    expect(f.instance.editor.getText()).toBe("");
    expect(f.commands).toEqual([]);
    expect(onQuit).not.toHaveBeenCalled();
    f.instance.handleInput("\x03");
    expect(onQuit).toHaveBeenCalledOnce();
    expect(f.commands).toEqual([]);
    await f.instance.close();
  });

  // Operator regression: the viewer's own clearQuitGesture.cancel() on close is the only thing that
  // stops the first Ctrl+C after a reopen from quitting; the gesture unit cannot see that call.
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
    expect(stripVTControlCharacters(paintedScreen(f.instance, 80, 12).join("\n"))).toContain("hello");
    f.instance.handleInput("\x1b");
    expect(f.instance.onReturn).toHaveBeenCalledOnce();

    releaseMenu();
    await f.instance.menuLoaded;
    expect(paintedScreen(f.instance, 80, 20).join("\n")).toContain("\x1b[38;2;252;211;77m");
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
    expect(paintedScreen(f.instance, 80, 24).join("\n")).toContain("anthropic/claude");
    f.instance.handleInput("\x1b[B");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "session_command", payload: { sessionId: "s", command: "set_model", model: { provider: "openai", id: "gpt-5" } } }]));
    expect(f.instance.selection).toBeUndefined();

    // Only a bare command opens a picker: a mistyped argument is a rejection the operator has to fix.
    f.instance.editor.setText("/model invented/model");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(paintedScreen(f.instance, 80, 24).join("\n")).toContain("UNKNOWN_MODEL"));
    expect(f.instance.selection).toBeUndefined();
    expect(f.commands).toHaveLength(1);
  });

  /**
   * The composer belongs to the operator, and Ctrl+L is a key rather than a submitted line.
   *
   * Operator-visible failure: pressing it in the middle of writing a prompt emptied the box. Every
   * assertion below reads Pi's own editor, cursor included, because a restored draft with the cursor
   * thrown to the end is the same lost place by a different route.
   */
  // app/viewer/slash-commands.test.mjs owns the per-name parse; this is the controller's one path.
  it("prompts the session with a Pi settings command instead of opening a settings picker", async () => {
    const text = "/thinking";
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
    const help = paintedScreen(f.instance, 80, 24).join("\n");
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

    const rendered = stripVTControlCharacters(paintedScreen(f.instance, 100, 24).join("\n"));
    expect(rendered).toContain("Restarting this session's worker");
    expect(rendered).not.toContain("Unsupported");
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
    expect(stripVTControlCharacters(paintedScreen(f.instance, 55, 16).join("\n"))).not.toMatch(/OBSERVER|COMPOSER|Read-only/u);

    f.instance.handleInput("\x0f");
    expect(f.instance.transcript.toolsExpanded).toBe(true);
    f.instance.handleInput("\x0f");
    expect(f.instance.transcript.toolsExpanded).toBe(false);
  });

  it("queues the composer as a follow-up on Alt+Enter and leaves it empty, recallable, and on one history", async () => {
    const f = fixture({ snapshot: {
      items: [{ kind: "assistant_message", itemId: "middle", content: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: "middle" }] }],
      thinkingLevel: "high",
    } });
    await f.instance.open();

    for (const input of "after you finish") f.instance.handleInput(input);
    f.instance.handleInput("\x1b\r");
    await vi.waitFor(() => {
      expect(f.commands.at(-1)).toEqual({ operation: "follow_up", payload: { sessionId: "s", text: "after you finish" } });
      expect(f.instance.editor.getText()).toBe("");
    });
    expect(f.instance.history).toEqual(["after you finish"]);
    expect(f.instance.editor.addToHistory).toHaveBeenCalledWith("after you finish");
  });

  it("keeps drafts and history scoped to the exact session", async () => {
    const f = fixture({ persisted: { sessionId: "other", draft: "leak", history: ["leak"] } });
    await f.instance.open();
    expect(f.instance.editor.getText()).toBe("");
    f.instance.editor.setText("session draft");
    await f.instance.close();
    expect(f.order).toContain("persist:0");
    expect(f.saved.at(-1)).toMatchObject({ sessionId: "s", draft: "session draft", history: [] });
  });
});

describe("viewer rendering and navigation", () => {
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

  it.each(["malformed event"])("closes only the viewer subscription after %s failure without advancing the resume cursor", async (failure) => {
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
  const view = (/** @type {any} */ f) => stripVTControlCharacters(paintedScreen(f.instance, 80, 24).join("\n"));
  const pendingRows = (/** @type {any} */ f) => view(f).split("\n").filter((line) => /Pending:/u.test(line)).map((line) => line.trim());
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

    f.instance.editor.setText("stop at the tests");
    f.instance.handleInput("\x1b\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(2));
    f.instance.editor.setText("then tag it");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(3));
    expect(pendingRows(f)).toEqual(["Pending: deploy it", "Pending: stop at the tests", "Pending: then tag it"]);

    // A settled turn is not proof about text Pi has not shown yet, so it drops nothing.
    await f.emit(event("1", { kind: "turn_state", working: false }));
    expect(pendingRows(f)).toEqual(["Pending: deploy it", "Pending: stop at the tests", "Pending: then tag it"]);

    await f.emit(event("2", { kind: "user_message", itemId: "landed", content: [{ type: "text", text: "deploy it" }] }));
    expect(pendingRows(f)).toEqual(["Pending: stop at the tests", "Pending: then tag it"]);
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
    const view = () => stripVTControlCharacters(paintedScreen(f.instance, 80, 24).join("\n"));
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
    expect(stripVTControlCharacters(paintedScreen(f.instance, 80, 24).join("\n"))).toContain("SESSION_NOT_FOUND");
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
    const view = () => stripVTControlCharacters(paintedScreen(f.instance, 80, 24).join("\n"));
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

    const view = stripVTControlCharacters(paintedScreen(f.instance, 80, 24).join("\n"));
    expect(view).toContain("SESSION_NOT_FOUND");
    expect(view).toContain("Transcript stopped");
    expect(f.instance.closedState).toBe(false);
  });
});

describe("transcript scrolling keys and wheel", () => {
  const longSnapshot = { items: Array.from({ length: 60 }, (_, index) => ({ kind: "system_message", itemId: `i-${index}`, text: `line ${index}`, level: "info" })) };

  // The arrows belong to Pi's editor. Nothing here scrolls on them: Pi's alternate screen binds no
  // arrow to its viewport, so a draft's cursor and prompt history keep every one of them.
  it.each([
    ["recallable prompt history", (/** @type {any} */ f) => f.instance.history.push("earlier prompt")],
  ])("hands the arrows to Pi's editor with %s", async (_label, prepare) => {
    const piEditor = piEditorFor();
    const f = fixture({ editor: piEditor, snapshot: longSnapshot });
    await f.instance.open();
    prepare(f);
    const before = f.instance.viewport.scrollTop;

    f.instance.handleInput("\x1b[A");
    f.instance.handleInput("\x1b[B");

    expect(f.instance.viewport.scrollTop).toBe(before);
    expect(f.instance.viewport.isFollowingEnd).toBe(true);
  });

  // Operator-visible failure this pins: a transcript that scrolled only as far as the viewer's own
  // clipping allowed, and search that could only find what was already on screen.
  it("gives Pi's own scroll view the whole transcript and every key that moves it", async () => {
    const f = fixture({ snapshot: longSnapshot });
    await f.instance.open();
    const body = () => stripVTControlCharacters(paintedScreen(f.instance, 80, 24).join("\n"));
    expect(body()).toContain("line 59");
    expect(body()).not.toContain("line 0\n");

    // Pi 1.4.0 binds tui.altScreen.top/bottom to Ctrl+Home and Ctrl+End; Home and End belong to the editor.
    f.instance.tui.terminal.type("\x1b[1;5H");
    const top = body();
    expect(top).toContain("line 0");
    expect(top).not.toContain("line 59");
    expect(f.instance.viewport.isFollowingEnd).toBe(false);

    // Output that arrives while the reader is up the page does not drag him back down.
    await f.emit({ version: 1, sessionId: "s", eventId: "e1", cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "1" }, timestamp, payload: { kind: "system_message", itemId: "fresh", text: "fresh", level: "info" } });
    expect(body()).toContain("line 0");
    expect(body()).not.toContain("fresh");

    f.instance.tui.terminal.type("\x1b[1;5F");
    expect(f.instance.viewport.isFollowingEnd).toBe(true);
    expect(body()).toContain("fresh");
  });

});

describe("installed Pi behavior the pending block depends on", () => {
  const piSource = (/** @type {string} */ path) => readFile(new URL(`../../node_modules/@earendil-works/pi-coding-agent/dist/${path}`, import.meta.url), "utf8");

  // Canary: Pi 1.4.0 expands a submitted slash before the text becomes a message. `session.prompt`
  // defaults `expandPromptTemplates` to true and RPC mode never overrides it, and `steer` and
  // `followUp` expand skills and prompt templates too, so text starting with "/" can reach the
  // transcript changed or, as an extension command, never reach it at all. That is why notePending
  // draws no row for it. When this fails, Pi changed how it treats a submitted slash: if it grew
  // verbatim delivery or a submission identity in its reply, delete that exception rather than
  // keeping it out of caution.
  it("still expands a submitted slash on every path a submission travels", async () => {
    const session = await piSource("core/agent-session.js");
    expect(session).toContain("options?.expandPromptTemplates ?? true");
    // steer and followUp both delegate to _queueUserInput, which expands before it queues.
    for (const operation of ["steer", "followUp"]) {
      const opens = `async ${operation}(text, images, options) {`;
      expect(session).toContain(opens);
      expect(session.slice(session.indexOf(opens), session.indexOf("}", session.indexOf(opens)))).toContain("this._queueUserInput(");
    }
    const queue = "async _queueUserInput(text, images, behavior, source) {";
    expect(session).toContain(queue);
    expect(session.slice(session.indexOf(queue), session.indexOf("await this._queue", session.indexOf(queue)))).toContain("expandPromptTemplate(expandedText");

    const rpc = await piSource("modes/rpc/rpc-mode.js");
    expect(rpc).toContain('case "prompt": {');
    expect(rpc.slice(rpc.indexOf('case "prompt": {'), rpc.indexOf('case "steer": {'))).not.toContain("expandPromptTemplates");
  });
});

/**
 * Pi's own keys for what a transcript shows and what Pi thinks with.
 *
 * Operator-visible failure each test names: Ctrl+T asking the session for something instead of
 * hiding thinking blocks, Shift+Tab sending a level the operator already left behind, a footer that
 * claims a level Pi never confirmed, a Ctrl+C that interrupts a turn the operator only wanted to
 * stop typing into, a Ctrl+D that does nothing, an Escape that leaves the session while a completion
 * popup is open, and a remapped key Pi honours and this viewer ignores.
 */
describe("Pi's own thinking, tools, clear, exit and escape keys", () => {
  const levelMenu = (overrides = {}) => async () => ({ commands: [], models: [], model: { provider: "anthropic", id: "opus" }, color: null, thinkingLevels: ["off", "low", "high"], thinkingLevel: "low", ...overrides });
  const screen = (/** @type {any} */ f) => stripVTControlCharacters(paintedScreen(f.instance, 80, 24).join("\n"));
  const reasoned = { kind: "assistant_message", itemId: "reasoned", content: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: "answer" }] };
  // A long result is the only way to read expansion off the screen: Pi's tool component shows the
  // first lines of a short one either way.
  const tool = (/** @type {string} */ id) => ({ id, name: "bash", state: "completed", arguments: { command: `run ${id}` }, result: [{ type: "text", text: Array.from({ length: 40 }, (_, line) => `${id} line ${line}`).join("\n") }], startedAt: timestamp, finishedAt: timestamp });
  const thinkingConfirmed = (/** @type {string} */ level, /** @type {string} */ sequence) => ({ version: 1, sessionId: "s", eventId: `thinking-${sequence}`, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence }, timestamp, payload: { kind: "thinking_state", level } });

  it("cycles to the next level Pi reported on Shift+Tab and moves the footer only on Pi's confirmation", async () => {
    const f = fixture({ menu: levelMenu(), snapshot: { thinkingLevel: "low", model: { provider: "anthropic", id: "opus" } } });
    await f.instance.open();
    await f.instance.menuLoaded;
    expect(screen(f)).toContain("opus • low");

    f.instance.handleInput("\x1b[Z");

    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "session_command", payload: { sessionId: "s", command: "set_thinking_level", level: "high" } }]));
    expect(screen(f)).toContain("opus • low");

    await f.emit(thinkingConfirmed("high", "1"));
    expect(screen(f)).toContain("opus • high");
    expect(f.commands).toHaveLength(1);
  });

  it.each([
    ["a worker from a release that never sent them", async () => ({ commands: [], models: [], model: null, color: null })],
  ])("sends nothing and says the levels are unavailable for %s", async (_name, menu) => {
    const f = fixture({ menu });
    await f.instance.open();
    await f.instance.menuLoaded;

    f.instance.handleInput("\x1b[Z");

    await vi.waitFor(() => expect(screen(f)).toContain("THINKING_LEVELS_UNAVAILABLE"));
    expect(f.commands).toEqual([]);
    expect(f.instance.selection).toBeUndefined();
  });

  it("keeps Escape as the only interrupt and leaves the session once the turn is settled", async () => {
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

  // Pi ships its own copy of pi-tui, so its editor reads a different global keybindings manager than
  // this package's own lists do. A remapped app action proves the editor's manager, and a remapped
  // editor action proves the one pi-tui itself resolves from.
  it("honours an app key and an editor key the operator remapped in Pi's own keybindings file", async () => {
    const piEditor = piEditorFor(await agentDir({ "app.tools.expand": "ctrl+e", "tui.input.submit": "ctrl+s" }));
    const f = fixture({ editor: piEditor, snapshot: { items: [], tools: [tool("first")] } });
    await f.instance.open();

    f.instance.handleInput("\x0f");
    expect(f.instance.transcript.toolsExpanded).toBe(false);

    f.instance.handleInput("\x05");
    expect(f.instance.transcript.toolsExpanded).toBe(true);

    for (const character of "ship it") f.instance.handleInput(character);
    f.instance.handleInput("\r");
    expect(f.commands).toEqual([]);
    f.instance.handleInput("\x13");

    await vi.waitFor(() => expect(f.commands).toEqual([{ operation: "prompt", payload: { sessionId: "s", text: "ship it" } }]));
    await f.instance.close();
  });
});

/**
 * Reading this session's menu is itself a Pi command, so what the viewer does with its answer decides
 * whether it ever stops asking.
 *
 * A menu read reaches Pi as `get_state`, and the viewer normalizer republishes every `get_state`
 * response as a `model_state` event carrying the model it just read. A viewer that reloads its menu
 * on each of those asks again, forever: one acceptance run logged 11,732 Pi commands for a single
 * idle session and never sent the key the operator had pressed.
 */
describe("session menu reads", () => {
  const modelMenu = (/** @type {any} */ model) => async () => ({ commands: [], models: [], model, color: null, thinkingLevels: ["off", "low", "high"], thinkingLevel: "low" });
  const modelState = (/** @type {any} */ model, /** @type {string} */ sequence) => ({
    version: 1, sessionId: "s", eventId: `model-${sequence}`, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence }, timestamp,
    payload: { kind: "model_state", provider: model?.provider ?? null, model: model?.id ?? null },
  });

  it.each([
    ["a model it already had", { provider: "anthropic", id: "opus" }, { provider: "anthropic", id: "opus" }],
  ])("reads the menu once when the read's own echo reports %s", async (_label, snapshotModel, echoed) => {
    let queries = 0;
    const f = fixture({
      snapshot: { model: snapshotModel },
      menu: async () => { queries += 1; return modelMenu(snapshotModel)(); },
    });
    await f.instance.open();
    await f.instance.menuLoaded;
    expect(queries).toBe(1);

    // Every one of these is the echo of a menu read. A viewer that answers them with another read
    // makes each echo produce the next one.
    await f.emit(modelState(echoed, "1"));
    await f.emit(modelState(echoed, "2"));
    await f.emit(modelState(echoed, "3"));

    expect(queries).toBe(1);
    expect(f.commands).toEqual([]);
  });

  it("reads the menu again when the model genuinely changed, and forgets the level it was waiting on", async () => {
    let queries = 0;
    const f = fixture({
      snapshot: { model: { provider: "anthropic", id: "opus" }, thinkingLevel: "low" },
      menu: async () => { queries += 1; return modelMenu({ provider: "anthropic", id: "opus" })(); },
    });
    await f.instance.open();
    await f.instance.menuLoaded;
    f.instance.handleInput("\x1b[Z");
    await vi.waitFor(() => expect(f.commands).toHaveLength(1));
    expect(f.instance.requestedThinkingLevel).toBe("high");

    await f.emit(modelState({ provider: "openai", id: "gpt-5" }, "1"));

    await vi.waitFor(() => expect(queries).toBe(2));
    // Pi reports levels per model, so the level asked for under the old one is no longer pending.
    expect(f.instance.requestedThinkingLevel).toBeUndefined();
  });

});

/**
 * The two submission keys, through the editor Pi ships rather than a stand-in.
 *
 * Nothing here parses an escape sequence: Enter is Pi's `tui.input.submit` and Alt+Enter is Pi's
 * `app.message.followUp`, so the terminal encodings both keys arrive in are Pi's problem and stay
 * correct when a terminal changes them. Operator-visible failure each test names: a key that sends
 * the wrong operation, or one that sends nothing at all.
 */
describe("submission keys through Pi's own editor", () => {
  afterEach(() => setKittyProtocolActive(false));

  const nativeFixture = (overrides = {}) => fixture({ ...overrides, editor: piEditorFor() });

  it.each([
    ["a Kitty-protocol terminal", true, "\x1b[13u", "\x1b[13;3u"],
  ])("sends prompt on Enter and follow_up on Alt+Enter from %s", async (_label, kitty, enter, altEnter) => {
    setKittyProtocolActive(kitty);
    const f = nativeFixture();
    await f.instance.open();

    for (const character of "ship it") f.instance.handleInput(character);
    f.instance.handleInput(enter);
    await vi.waitFor(() => expect(f.commands).toHaveLength(1));
    for (const character of "then deploy") f.instance.handleInput(character);
    f.instance.handleInput(altEnter);

    await vi.waitFor(() => expect(f.commands).toEqual([
      { operation: "prompt", payload: { sessionId: "s", text: "ship it" } },
      { operation: "follow_up", payload: { sessionId: "s", text: "then deploy" } },
    ]));
    expect(f.instance.editor.getText()).toBe("");
    await f.instance.close();
  });

  // The dashboard's own view of the turn is at least one event behind Pi, so neither key may read it.
  it.each([["a working", "WORKING"]])("sends the same two operations from %s session", async (_label, taskState) => {
    const f = nativeFixture({ snapshot: { taskState } });
    await f.instance.open();

    for (const character of "now") f.instance.handleInput(character);
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(1));
    for (const character of "later") f.instance.handleInput(character);
    f.instance.handleInput("\x1b\r");

    await vi.waitFor(() => expect(f.commands.map(({ operation }) => operation)).toEqual(["prompt", "follow_up"]));
    await f.instance.close();
  });

  // Pi expands skills and prompt templates on all three of its delivery paths, so a slash line is
  // the session's text on either key; a dashboard command is this frontend's and reaches no Pi queue.
  it("dispatches slash text as a session submission and a built-in command as a session command", async () => {
    const f = nativeFixture({ menu: async () => ({ commands: [{ name: "/review", source: "extension" }], models: [], model: null }) });
    await f.instance.open();
    await f.instance.menuLoaded;

    f.instance.editor.setText("/skill:lint everything");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(1));
    f.instance.editor.setText("/review the diff");
    f.instance.handleInput("\x1b\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(2));
    f.instance.editor.setText("/compact");
    f.instance.handleInput("\r");
    await vi.waitFor(() => expect(f.commands).toHaveLength(3));

    expect(f.commands.map(({ operation, payload }) => [operation, payload.text ?? payload.command])).toEqual([
      ["prompt", "/skill:lint everything"],
      ["follow_up", "/review the diff"],
      ["session_command", "compact"],
    ]);
    await f.instance.close();
  });

  // Pi's editor empties itself before it calls onSubmit, so a refusal arrives with the operator's
  // line already off the screen. A daemon that refuses Enter because this session's worker predates
  // native steering would otherwise have thrown his text away.
  it("puts a refused line back in the empty composer and sends it once", async () => {
    const refusal = Object.assign(new Error("This session's worker predates native steering."), { code: "WORKER_UPGRADE_REQUIRED", retryable: false });
    const f = nativeFixture({ command: async () => { throw refusal; } });
    await f.instance.open();

    for (const character of "check the lint first") f.instance.handleInput(character);
    f.instance.handleInput("\r");

    await vi.waitFor(() => expect(f.instance.editor.getText()).toBe("check the lint first"));
    expect(f.commands).toEqual([{ operation: "prompt", payload: { sessionId: "s", text: "check the lint first" } }]);
    expect(f.instance.state.errors.at(-1)).toMatchObject({ code: "WORKER_UPGRADE_REQUIRED" });
    expect(f.instance.history).toEqual([]);
    expect(stripVTControlCharacters(paintedScreen(f.instance, 80, 24).join("\n"))).not.toContain("Pending: check the lint first");
    await f.instance.close();
  });

});
