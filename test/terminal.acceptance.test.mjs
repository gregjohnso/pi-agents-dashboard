import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";

import { DashboardController } from "../app/list/dashboard.mjs";
import { ViewerController } from "../app/viewer/viewer-controller.mjs";

const timestamp = "2026-08-25T12:00:00.000Z";
const dimensions = [[160, 40], [120, 32], [80, 24], [55, 16], [40, 10]];

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

class DashboardBackend {
  constructor(sessions) { this.snapshot = { sessions }; }
  stop = vi.fn(async () => {});
  delete = vi.fn(async () => {});
  resolveDelivery = vi.fn(async () => {});
  async getSnapshot() { return this.snapshot; }
  subscribe(_cursor, listener, onError) { this.listener = listener; this.onError = onError; return () => { this.unsubscribed = true; }; }
  async preflightLaunch(draft) { return { canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }; }
  async launch() { return { kind: "launched", sessionId: "new" }; }
}

function dashboardFixture(sessions, overrides = {}) {
  const backend = new DashboardBackend(sessions);
  const persistence = { async load() {}, async save() {} };
  const openViewer = overrides.openViewer ?? vi.fn(async () => {});
  const onClose = overrides.onClose ?? vi.fn();
  const dashboard = new DashboardController({
    backend, persistence, openViewer, onClose,
    clientId: "terminal-client",
    requestId: () => "terminal-request",
    launchDefaults: { cwd: "/repo", model: { provider: "", id: "" }, name: "" },
    requestRender: () => {},
    now: () => Date.parse(timestamp) + 12 * 60 * 60 * 1_000,
  });
  return { backend, dashboard, onClose, openViewer };
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
    role: "composer",
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

function editor() {
  let text = "";
  return {
    focused: false,
    disableSubmit: false,
    setText(value) { text = value; this.onChange?.(value); },
    getText() { return text; },
    addToHistory() {},
    handleInput(data) {
      if (data === "\r") this.onSubmit?.(text);
      else if (data.length === 1 && data >= " ") { text += data; this.onChange?.(text); }
    },
    render: () => [`> ${text}`],
  };
}

function viewerFixture(snapshotOverrides = {}, options = {}) {
  let listener;
  const commands = [];
  const client = {
    async getSnapshot() { return viewerSnapshot(snapshotOverrides); },
    subscribe(_sessionId, _cursor, next) { listener = next; return () => {}; },
    async command(operation, payload) { commands.push({ operation, payload }); },
    async ack() {},
  };
  const persistence = { async load() {}, async save() {} };
  const onReturn = options.onReturn ?? vi.fn();
  const controller = new ViewerController({ sessionId: "viewer-session", client, editor: editor(), persistence, onReturn, requestRender: () => {}, now: options.now ?? (() => Date.parse(timestamp)) });
  return { commands, controller, emit: (event) => listener(event), onReturn };
}

function event(sequence, payload) {
  return { version: 1, sessionId: "viewer-session", eventId: `event-${sequence}`, cursor: { daemonEpoch: "epoch", sessionId: "viewer-session", sequence: String(sequence) }, timestamp, payload };
}

// The five-width matrix lives here for both surfaces; component tests assert semantics, not widths.
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
  const viewerLines = viewer.controller.render(width, height);
  expect(listLines).toHaveLength(height);
  expect(viewerLines).toHaveLength(height);
  expect([...listLines, ...viewerLines].every((line) => visibleWidth(line) <= width)).toBe(true);
  expect({ list: listLines.map(stripVTControlCharacters), viewer: viewerLines.map(stripVTControlCharacters) }).toMatchSnapshot();
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
  // full chord-to-query table for every filter, sort and group facet.
  for (const input of ["\x06", "l", "i", "v", "e", "\r"]) f.dashboard.handleInput(input);
  expect(f.dashboard.query).toMatchObject({ search: "live" });
  f.dashboard.clearFilters();
  f.dashboard.handleInput("\x05");
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

  // Ctrl+X stops on the first press; a second press soon after clears the stopped session.
  f.dashboard.selectSession("live");
  f.dashboard.handleInput("\x18");
  await vi.waitFor(() => expect(f.backend.stop).toHaveBeenCalledWith("live", 4, "terminal-request"));
  await vi.waitFor(() => expect(f.dashboard.stopClearArmed).toBe(true));
  const processing = Promise.resolve(f.backend.listener({ snapshot: { sessions: [session("live", { revision: 5, processState: "EXITED" }), session("saved", { revision: 7, processState: "EXITED" })] }, cursor: { daemonEpoch: "epoch", sequence: "1" } }));
  f.dashboard.render(80, 24);
  await processing;
  f.dashboard.handleInput("\x18");
  await vi.waitFor(() => expect(f.backend.delete).toHaveBeenCalledWith("live", 5, "terminal-request"));

  // Tab reaches no launch field any more, so it cannot move a cursor away from the prompt.
  f.dashboard.handleInput("\t");
  expect(f.dashboard.composerDraft.prompt).toBe("draft");
  f.dashboard.handleInput("\x03");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith({ kind: "closed" }));
  expect(f.dashboard.composerDraft.prompt).toBe("draft");
  expect(f.backend.stop).toHaveBeenCalledTimes(1);
  expect(f.backend.delete).toHaveBeenCalledTimes(1);
});

it("drives viewer prompt/follow-up/steer/interrupt, tools, pending UI, and read-only restrictions", async () => {
  const f = viewerFixture({ pendingUi: [], errors: [], tools: [{ id: "tool", name: "bash", state: "completed", arguments: {}, result: [{ type: "text", text: "needle result" }], startedAt: timestamp, finishedAt: timestamp }] });
  await f.controller.open();
  f.controller.editor.setText("first");
  f.controller.handleInput("\r");
  await vi.waitFor(() => expect(f.commands.at(-1)?.operation).toBe("prompt"));
  await f.emit(event(1, { kind: "turn_state", working: true }));
  f.controller.editor.setText("next");
  f.controller.handleInput("\r");
  f.controller.editor.setText("draft");
  f.controller.handleInput("\x13");
  for (const input of "urgent") f.controller.handleInput(input);
  f.controller.handleInput("\r");
  await vi.waitFor(() => {
    expect(f.commands.map(({ operation }) => operation)).toEqual(["prompt", "follow_up", "steer"]);
    expect(f.controller.inputMode).toBe("prompt");
  });
  f.controller.handleInput("\x03");
  await vi.waitFor(() => expect(f.commands.map(({ operation }) => operation)).toEqual(["prompt", "follow_up", "steer", "interrupt"]));

  await f.emit(event(2, { kind: "pending_ui_request", request: { id: "confirm", method: "confirm", title: "Continue?" } }));
  f.controller.handleInput("y");
  await vi.waitFor(() => expect(f.commands.at(-1)?.operation).toBe("ui_response"));
  f.controller.handleInput("\x0f");
  expect(f.controller.transcript.selectedToolId).toBe("tool");
  f.controller.handleInput("\x0f");
  expect(f.controller.transcript.expandedTools.has("tool")).toBe(true);
  await f.controller.close();

  const observer = viewerFixture({ role: "observer", pendingUi: [{ id: "blocked", method: "confirm", title: "Blocked" }] });
  await observer.controller.open();
  for (const input of ["x", "\r", "\x03", "\x13", "y", "\x1b[5~", "/", "x"]) observer.controller.handleInput(input);
  expect(observer.commands).toEqual([]);
  expect(observer.controller.render(55, 16).join("\n")).toContain("OBSERVER");
  await observer.controller.close();
});

it("uses context-sensitive Ctrl+C, immediate Escape, and the exact clean and 500 ms dirty/history Left table", async () => {
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
  dirty.controller.handleInput("x");
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
