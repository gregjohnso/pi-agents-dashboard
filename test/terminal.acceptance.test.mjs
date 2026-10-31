import { stripVTControlCharacters } from "node:util";

import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";

import { DashboardController } from "../app/list/dashboard.mjs";
import { ViewerController } from "../app/viewer/viewer-controller.mjs";
import { ScreenTerminal } from "./alt-screen-harness.mjs";
import { createPiEditorDouble } from "./pi-editor-double.mjs";

// The viewer is one of Pi's own layouts, so its rows are read off a real alternate screen; the list
// still renders itself full-screen and is read directly.
/** @type {any[]} */
const screens = [];
afterEach(() => { for (const tui of screens.splice(0)) tui.stop({ preserveScreen: true }); });

function viewerScreen(/** @type {any} */ controller, /** @type {number} */ width, /** @type {number} */ height) {
  const tui = controller.tui;
  if (tui.terminal.columns !== width || tui.terminal.rows !== height) tui.terminal.resize(width, height);
  tui.setLayoutRoot(controller.layoutRoot);
  tui.renderNow();
  return [...tui.terminal.lines];
}

const timestamp = "2026-08-25T12:00:00.000Z";
const dimensions = [[80, 24], [40, 10]];

function session(sessionId, overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 1,
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    canonicalSessionFile: `/sessions/${sessionId}.jsonl`,
    cwd: `/projects/${sessionId}`,
    model: { provider: "anthropic", id: "opus" },
    thinkingLevel: "high",
    name: sessionId,
    taskState: "READY",
    processState: "LIVE",
    outcome: "NONE",
    activity: { kind: "assistant_final", summary: `Activity ${sessionId}`, updatedAt: timestamp },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

let coverageSequence = 0;
/** The daemon's in-memory snapshot coverage cursor, required in every successful get_state. */
function nextCoverage() {
  coverageSequence += 1;
  return { daemonEpoch: "epoch", sequence: String(coverageSequence) };
}

class FakeDaemonClient {
  constructor(sessions) { this.snapshot = { sessions, cursor: nextCoverage() }; }
  stop = vi.fn(async () => {});
  delete = vi.fn(async () => {});
  setSessions(sessions) { this.snapshot = { sessions, cursor: nextCoverage() }; }
  async getState() { return this.snapshot; }
  async subscribeListChanges(onChanged, onError) { this.notifyListChanged = onChanged; this.onError = onError; return () => { this.unsubscribed = true; }; }
  async preflightLaunch(draft) { return { canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }; }
  async launch() { return { kind: "launched", sessionId: "new" }; }
  async getModels() { return []; }
  async refreshSummaries() { return []; }
}

function dashboardFixture(sessions, overrides = {}) {
  const client = new FakeDaemonClient(sessions);
  const openViewer = overrides.openViewer ?? vi.fn(async () => {});
  const onClose = overrides.onClose ?? vi.fn();
  // The clock this fixture hands the controller is the test's, not the machine's: the stop/clear
  // window is 500 ms, and a loaded box can spend longer than that inside one `waitFor`.
  const clock = { at: Date.parse(timestamp) + 12 * 60 * 60 * 1_000 };
  const dashboard = new DashboardController({
    client, openViewer, onClose,
    clientId: "terminal-client",
    requestId: () => "terminal-request",
    launchDefaults: { cwd: "/repo", model: { provider: "", id: "" }, name: "" },
    requestRender: () => {},
    now: () => clock.at,
  });
  return { client, clock, dashboard, onClose, openViewer };
}

function viewerSnapshot(overrides = {}) {
  const tool = (state) => ({
    id: `tool-${state}`,
    name: "bash",
    state,
    arguments: { command: "pytest" },
    startedAt: timestamp,
    ...(state === "completed" ? { result: [{ type: "text", text: "passed" }], finishedAt: timestamp } : {}),
    ...(state === "failed" ? { error: "failed", finishedAt: timestamp } : {}),
  });
  return {
    version: 1,
    sessionId: "viewer-session",
    registryRevision: 3,
    cursor: { daemonEpoch: "epoch", sessionId: "viewer-session", sequence: "0" },
    runtime: null,
    taskState: "WAITING",
    processState: "LIVE",
    outcome: "NONE",
    activity: { kind: "activity", phase: "waiting", label: "Waiting for confirmation", sourceEventId: "active", startedAt: timestamp },
    model: { provider: "anthropic", id: "opus" },
    thinkingLevel: "high",
    items: [
      { kind: "user_message", itemId: "user", content: [{ type: "text", text: "Run acceptance" }, { type: "image", attachmentId: "image" }] },
      { kind: "assistant_message", itemId: "assistant", content: [{ type: "thinking", text: "Inspecting" }, { type: "text", text: "## Working\n- checking package" }] },
      { kind: "system_message", itemId: "retry", text: "Retrying in 4s", level: "warning" },
      { kind: "system_message", itemId: "compact", text: "Compacting context", level: "info" },
      { kind: "image_placeholder", attachment: { id: "image", path: "safe.png", mediaType: "image/png", width: 10, height: 5 } },
      { kind: "file_placeholder", attachment: { id: "file", path: "safe.txt", size: 12 } },
    ],
    tools: ["pending", "running", "streaming", "completed", "failed"].map(tool),
    pendingUi: [{ id: "confirm", method: "confirm", title: "Continue?" }],
    errors: [{ code: "RECOVERED_ERROR", message: "bounded terminal error", retryable: true }],
    ...overrides,
  };
}


function viewerFixture(snapshotOverrides = {}, options = {}) {
  /** @type {any} */
  let waiter;
  /** @type {any[]} */
  const queue = [];
  const commands = [];
  const events = {
    async next() {
      if (queue.length > 0) return { value: queue.shift(), done: false };
      return new Promise((resolve) => { waiter = resolve; });
    },
    async return() { return { value: undefined, done: true }; },
  };
  const client = {
    async subscribeViewer() { return { snapshot: viewerSnapshot(snapshotOverrides), events, unsubscribe() {} }; },
    async command(operation, payload) { commands.push({ operation, payload }); },
    async attach(sessionId) { return { kind: "attached", sessionId }; },
    async sessionMenu() { return { commands: [], models: [], model: null, color: null }; },
    onConnectionChange() { return () => {}; },
  };
  const persistence = { async load() {}, async save() {} };
  const onReturn = options.onReturn ?? vi.fn();
  const tui = new TuiAltScreen(new ScreenTerminal(), false, undefined, { mouse: false });
  tui.start();
  screens.push(tui);
  const controller = new ViewerController({ sessionId: "viewer-session", client, editor: createPiEditorDouble({ tui }), persistence, onReturn, requestRender: () => {}, now: options.now ?? (() => Date.parse(timestamp)) });
  // The controller's own pump reads these, so a test drives the same path the daemon client feeds.
  const emit = (value) => {
    const settled = new Promise((resolve, reject) => {
      const processEvent = controller.processEvent.bind(controller);
      controller.processEvent = async (incoming) => {
        controller.processEvent = processEvent;
        try { const result = await processEvent(incoming); resolve(result); return result; } catch (error) { reject(error); throw error; }
      };
    });
    if (waiter === undefined) queue.push(value);
    else { const resume = waiter; waiter = undefined; resume({ value, done: false }); }
    return settled;
  };
  return { commands, controller, emit, onReturn };
}

function event(sequence, payload) {
  return { version: 1, sessionId: "viewer-session", eventId: `event-${sequence}`, cursor: { daemonEpoch: "epoch", sessionId: "viewer-session", sequence: String(sequence) }, timestamp, payload };
}

// The width matrix lives here for both surfaces; component tests assert semantics, not widths.
// The first row carries wide characters and a deep path because it is the one row every height shows.
it.each(dimensions)("pins the complete list and viewer surfaces at %ix%i", async (width, height) => {
  const list = dashboardFixture([
    session("working", {
      name: "検証 🚀 résumé",
      cwd: "/worktrees/研究/非常に長いプロジェクト名/dashboard",
      taskState: "WORKING",
      activity: { kind: "tool", summary: "bash: pytest 検証中 🚀 naïve café", updatedAt: timestamp },
    }),
    session("waiting", { taskState: "WAITING", activity: { kind: "ui", summary: "Approval needed", updatedAt: timestamp } }),
    session("failed", { taskState: "FAILED", processState: "STALE", activity: { kind: "error", summary: "provider error", updatedAt: timestamp } }),
  ]);
  await list.dashboard.open();
  const viewer = viewerFixture();
  await viewer.controller.open();
  const listLines = list.dashboard.render(width, height);
  const viewerLines = viewerScreen(viewer.controller, width, height);
  expect(listLines).toHaveLength(height);
  expect(viewerLines).toHaveLength(height);
  expect([...listLines, ...viewerLines].every((line) => visibleWidth(line) <= width)).toBe(true);
  // The working indicator prints wall-clock elapsed time, so it differs run to run; pin the layout, not the clock.
  const steady = (line) => stripVTControlCharacters(line).replace(/Elapsed \d+\.\d+s/, "Elapsed 0.0s");
  expect({ list: listLines.map(steady), viewer: viewerLines.map(steady) }).toMatchSnapshot();
  await Promise.all([list.dashboard.close(), viewer.controller.close()]);
});

it("drives list navigation, search/filter/sort/group, metadata/help, composer, close, and Stop-then-Delete", async () => {
  const openViewer = vi.fn(async () => {});
  const onClose = vi.fn();
  const f = dashboardFixture([
    session("live", { revision: 4, taskState: "WORKING", ownership: { kind: "managed", runId: "run-live", process: { pid: 101, startIdentity: "101", processGroupId: 101 }, acquiredAt: timestamp, heartbeatAt: timestamp } }),
    session("saved", { revision: 7, processState: "EXITED" }),
  ], { openViewer, onClose });
  await f.dashboard.open();

  f.dashboard.handleInput("\r");
  f.dashboard.handleInput("\x1b[C");
  await vi.waitFor(() => expect(openViewer).toHaveBeenCalledTimes(2));
  // Ctrl+F opens search and the letters type into it; app/list/dashboard.test.mjs owns the
  // category/value controls for every filter, sort and group facet.
  for (const input of ["\x06", "l", "i", "v", "e", "\r"]) f.dashboard.handleInput(input);
  expect(f.dashboard.query).toMatchObject({ search: "live" });
  f.dashboard.clearFilters();
  while (f.dashboard.controlCategory !== "metadata") f.dashboard.handleInput("\x16");
  f.dashboard.handleInput("\x0e");
  expect(f.dashboard.overlay?.kind).toBe("metadata");
  f.dashboard.handleInput("\x07");
  expect(f.dashboard.overlay?.kind).toBe("help");
  f.dashboard.toggleHelp();
  // Typing anywhere in the list composes a prompt without moving focus off the list.
  for (const input of "draft") f.dashboard.handleInput(input);
  expect(f.dashboard.focus).toBe("list");
  expect(f.dashboard.composerDraft.prompt).toBe("draft");
  f.dashboard.handleInput("\x1b");
  expect(f.dashboard.focus).toBe("list");

  // Stopping and clearing each require a separate double-tap.
  f.dashboard.selectSession("live");
  f.dashboard.handleInput("\x18");
  expect(f.client.stop).not.toHaveBeenCalled();
  f.dashboard.handleInput("\x18");
  await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledWith("live", 4, "terminal-request"));
  await vi.waitFor(() => expect(f.dashboard.stopClearArmed).toBe(false));
  f.client.setSessions([session("live", { revision: 5, processState: "EXITED" }), session("saved", { revision: 7, processState: "EXITED" })]);
  await f.client.notifyListChanged();
  f.dashboard.setView("all");
  f.dashboard.selectSession("live");
  f.dashboard.render(80, 24);
  f.dashboard.handleInput("\x18");
  expect(f.client.delete).not.toHaveBeenCalled();
  f.dashboard.handleInput("\x18");
  await vi.waitFor(() => expect(f.client.delete).toHaveBeenCalledWith("live", 5, "terminal-request"));

  // Tab reaches no launch field any more, so it cannot move a cursor away from the prompt.
  f.dashboard.handleInput("\t");
  expect(f.dashboard.composerDraft.prompt).toBe("draft");
  // Ctrl+C clears the prompt and leaves the list standing; a second press inside the window quits.
  f.dashboard.handleInput("\x03");
  expect(f.dashboard.composerDraft.prompt).toBe("");
  expect(onClose).not.toHaveBeenCalled();
  f.dashboard.handleInput("\x03");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith({ kind: "closed" }));
  expect(f.dashboard.composerDraft.prompt).toBe("");
  expect(f.client.stop).toHaveBeenCalledTimes(1);
  expect(f.client.delete).toHaveBeenCalledTimes(1);
});

it("drives viewer prompt/follow-up/interrupt, tools, pending UI, and read-only restrictions", async () => {
  const f = viewerFixture({ pendingUi: [], errors: [], tools: [{ id: "tool", name: "bash", state: "completed", arguments: {}, result: [{ type: "text", text: "needle result" }], startedAt: timestamp, finishedAt: timestamp }] });
  await f.controller.open();
  f.controller.editor.setText("first");
  f.controller.handleInput("\r");
  await vi.waitFor(() => expect(f.commands.at(-1)?.operation).toBe("prompt"));
  await f.emit(event(1, { kind: "turn_state", working: true }));
  f.controller.editor.setText("next");
  f.controller.handleInput("\r");
  f.controller.editor.setText("urgent");
  f.controller.handleInput("\x1b\r");
  await vi.waitFor(() => {
    expect(f.commands.map(({ operation }) => operation)).toEqual(["prompt", "prompt", "follow_up"]);
    expect(f.controller.editor.getText()).toBe("");
  });
  // Escape is Pi's interrupt; Ctrl+C only clears what the operator is typing.
  f.controller.editor.setText("abandoned");
  f.controller.handleInput("\x03");
  expect(f.controller.editor.getText()).toBe("");
  f.controller.handleInput("\x1b");
  await vi.waitFor(() => expect(f.commands.map(({ operation }) => operation)).toEqual(["prompt", "prompt", "follow_up", "interrupt"]));

  await f.emit(event(2, { kind: "pending_ui_request", request: { id: "confirm", method: "confirm", title: "Continue?" } }));
  f.controller.handleInput("y");
  await vi.waitFor(() => expect(f.commands.at(-1)?.operation).toBe("ui_response"));
  f.controller.handleInput("\x0f");
  expect(f.controller.transcript.toolsExpanded).toBe(true);
  expect(stripVTControlCharacters(viewerScreen(f.controller, 80, 24).join("\n"))).toContain("needle result");
  f.controller.handleInput("\x0f");
  expect(f.controller.transcript.toolsExpanded).toBe(false);
  await f.controller.close();

  // A second viewer on the same session answers its pending request instead of watching it.
  const second = viewerFixture({ pendingUi: [{ id: "blocked", method: "confirm", title: "Blocked" }] });
  await second.controller.open();
  second.controller.handleInput("y");
  await vi.waitFor(() => expect(second.commands.at(-1)).toMatchObject({ operation: "ui_response", payload: { uiRequestId: "blocked", response: true } }));
  await second.controller.close();
});

it("leaves on an immediate Escape and on the exact clean and 500 ms empty-dirty/history Left table", async () => {
  const cleanLeft = viewerFixture({ pendingUi: [] }, { onReturn: vi.fn() });
  await cleanLeft.controller.open();
  cleanLeft.controller.handleInput("\x1b[D");
  expect(cleanLeft.onReturn).toHaveBeenCalledOnce();
  await cleanLeft.controller.close();

  const cleanEscape = viewerFixture({ pendingUi: [] }, { onReturn: vi.fn() });
  await cleanEscape.controller.open();
  cleanEscape.controller.handleInput("\x1b");
  expect(cleanEscape.onReturn).toHaveBeenCalledOnce();
  await cleanEscape.controller.close();

  let now = 0;
  const dirty = viewerFixture({ pendingUi: [] }, { onReturn: vi.fn(), now: () => now });
  await dirty.controller.open();
  dirty.controller.editor.setText("x");
  dirty.controller.editor.setText("");
  dirty.controller.handleInput("\x1b[D");
  expect(dirty.onReturn).not.toHaveBeenCalled();
  now = 500;
  dirty.controller.handleInput("\x1b[D");
  expect(dirty.onReturn).toHaveBeenCalledOnce();
  await dirty.controller.close();

  const history = viewerFixture({ pendingUi: [] }, { onReturn: vi.fn(), now: () => now });
  await history.controller.open();
  history.controller.history.push("prior");
  history.controller.handleInput("\x1b[A");
  history.controller.handleInput("\x1b[D");
  expect(history.onReturn).not.toHaveBeenCalled();
  now += 499;
  history.controller.handleInput("\x1b[D");
  expect(history.onReturn).toHaveBeenCalledOnce();
  await history.controller.close();
});
