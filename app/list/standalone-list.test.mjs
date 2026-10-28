import { describe, expect, it, vi } from "vitest";

import { createPiEditorDouble } from "../../test/pi-editor-double.mjs";
import { ViewerController } from "../viewer/viewer-controller.mjs";
import { createHostShutdown, runViewerTransition } from "./standalone-list.mjs";

const at = "2026-08-25T00:00:00Z";

/** A daemon client that answers the viewer's subscription and never publishes an event. */
function hostClient() {
  return {
    commands: [],
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    async subscribeViewer() {
      return {
        snapshot: {
          version: 1, sessionId: "s", registryRevision: 1, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "0" }, runtime: null,
          taskState: "READY", processState: "LIVE", outcome: "NONE",
          activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "snapshot", startedAt: at },
          model: null, thinkingLevel: null, items: [], tools: [], pendingUi: [], errors: [],
        },
        events: { async next() { return new Promise(() => {}); }, async return() { return { value: undefined, done: true }; } },
        unsubscribe() {},
      };
    },
    onConnectionChange() { return () => {}; },
    async command(operation, payload) { this.commands.push({ operation, payload }); return { accepted: true }; },
    async sessionMenu() { return { commands: [], models: [], model: null, color: null }; },
  };
}

it("ends the whole frontend when the hosted viewer quits, instead of coming back to the list", async () => {
  const client = hostClient();
  const tui = { stop: vi.fn(), requestRender: vi.fn() };
  const controller = { closed: false, close: vi.fn(async () => { controller.closed = true; }), open: vi.fn(async () => { controller.closed = false; }) };
  const activateList = vi.fn();
  let activeViewer;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const shutdown = createHostShutdown({ currentViewer: () => activeViewer, controller, tui, client, resolveClosed: () => resolveClosed() });
  const transition = runViewerTransition({
    sessionId: "s", client, controller,
    createViewer() {
      /** @type {any} */
      let viewer;
      viewer = new ViewerController({
        sessionId: "s", client, editor: createPiEditorDouble(), now: () => 0,
        persistence: { async load() { return undefined; }, async save() {} },
        requestRender: () => tui.requestRender(),
        onReturn: () => { void viewer.close(); },
        onQuit: () => { void shutdown.run(); },
      });
      return viewer;
    },
    activateViewer(viewer) { activeViewer = viewer; },
    activateList, restoreListFocus: vi.fn(),
    shouldRestore: () => !shutdown.started,
  });
  await vi.waitFor(() => expect(activeViewer?.state).toBeDefined());

  activeViewer.handleInput("\x03");
  activeViewer.handleInput("\x03");

  await closed;
  await expect(transition).resolves.toEqual({ kind: "returned" });
  expect(controller.open).not.toHaveBeenCalled();
  expect(activateList).not.toHaveBeenCalled();
  expect(tui.stop).toHaveBeenCalledOnce();
  expect(client.close).toHaveBeenCalledOnce();
  // Quitting is the frontend leaving: the session itself is told nothing.
  expect(client.commands).toEqual([]);
});

it("detaches and reopens the same list when viewer construction fails", async () => {
  const constructionError = new Error("viewer construction failed");
  const client = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), command: vi.fn() };
  const controller = { close: vi.fn(async () => {}), open: vi.fn(async () => {}) };
  const activateViewer = vi.fn();
  const activateList = vi.fn();
  const restoreListFocus = vi.fn();
  const result = await runViewerTransition({
    sessionId: "session", client, controller,
    createViewer() { throw constructionError; },
    activateViewer, activateList, restoreListFocus, shouldRestore: () => true,
  });
  expect(result).toEqual({ kind: "failed", error: constructionError });
  expect(client.detach).toHaveBeenCalledWith("session");
  expect(controller.open).toHaveBeenCalledOnce();
  expect(activateViewer).not.toHaveBeenCalled();
  expect(activateList).toHaveBeenCalledOnce();
  expect(restoreListFocus).toHaveBeenCalledOnce();
  expect(client.command).not.toHaveBeenCalled();
});

it("restores cached rows and input without waiting for a slow owner refresh", async () => {
  let finishRefresh;
  const refresh = new Promise((resolve) => { finishRefresh = resolve; });
  const order = [];
  const controller = { closed: true, async close() {}, open() { this.closed = false; order.push("refresh"); return refresh; } };
  const transition = runViewerTransition({
    sessionId: "s", client: { async attach() {}, async detach() {} }, controller,
    createViewer: () => ({ async open() {}, closed: Promise.resolve(), async close() {} }),
    activateViewer() {}, activateList() { order.push("list"); }, restoreListFocus() { order.push("input"); }, shouldRestore: () => true,
  });
  try {
    await vi.waitFor(() => expect(order).toContain("input"));
    await expect(transition).resolves.toEqual({ kind: "returned" });
    expect(order).toEqual(["refresh", "list", "input"]);
  } finally { finishRefresh(); }
});

it("handles a background refresh rejection without losing the restored list", async () => {
  const error = new Error("owner refresh failed");
  const controller = { closed: false, async close() {}, async open() { throw error; }, setError: vi.fn(), requestRender: vi.fn() };
  const activateList = vi.fn();
  await expect(runViewerTransition({
    sessionId: "s", client: { async attach() {}, async detach() {} }, controller,
    createViewer: () => ({ async open() {}, closed: Promise.resolve(), async close() {} }),
    activateViewer() {}, activateList, restoreListFocus() {}, shouldRestore: () => true,
  })).resolves.toEqual({ kind: "returned" });
  await vi.waitFor(() => expect(controller.setError).toHaveBeenCalledWith(error, "DASHBOARD_OPEN_FAILED"));
  expect(activateList).toHaveBeenCalledOnce();
  expect(controller.requestRender).toHaveBeenCalled();
});

describe("viewer transition failures", () => {
  it("reports a refused viewer attach on the list instead of doing nothing", async () => {
      // A refused attach used to be dropped, so Enter and Right looked like dead keys.
      const failures = [];
      const controller = { closed: false, async close() {}, async open() {}, setError(error, fallback) { failures.push({ code: error?.code ?? fallback, message: error?.message }); } };
      const client = { async attach() { throw Object.assign(new Error("Session worker is reconnecting"), { code: "WORKER_RECONNECTING" }); }, async detach() {} };
      const outcome = await runViewerTransition({
          sessionId: "a", client, controller,
          createViewer: () => { throw new Error("viewer must not be created when attach fails"); },
          activateViewer() {}, activateList() {}, restoreListFocus() {},
          shouldRestore: () => true,
      });
      expect(outcome).toMatchObject({ kind: "failed" });
      expect(failures).toEqual([{ code: "WORKER_RECONNECTING", message: "Session worker is reconnecting" }]);
  });
});
