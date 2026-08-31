import { describe, expect, it, vi } from "vitest";

import { createDaemonViewerClient, runViewerTransition } from "./standalone-list.mjs";

it("adapts the installed daemon client to origin replay, mutation, applied cursors, and detach", async () => {
  const requests = [];
  const order = [];
  const events = {
    [Symbol.asyncIterator]() {
      const queue = [{ eventId: "one", cursor: { sequence: "1" } }];
      return {
        async next() { const value = queue.shift(); return value === undefined ? { value: undefined, done: true } : { value, done: false }; },
        applied(cursor) { order.push(`applied:${cursor.sequence}`); },
      };
    },
  };
  const watchers = [];
  const client = {
    async request(value) {
      requests.push(value);
      const result = value.op === "attach" ? { kind: "attached", sessionId: value.payload.sessionId }
        : value.op === "detach" ? { kind: "detached" }
          : { kind: "command", status: { stage: "COMPLETED" } };
      return { ok: true, result };
    },
    async getViewerSnapshot(sessionId) { return { sessionId }; },
    subscribeViewer(sessionId, cursor) { expect([sessionId, cursor.sequence]).toEqual(["session", "0"]); return events; },
    onConnectionChange(listener) { watchers.push(listener); return () => watchers.pop(); },
  };
  const viewer = createDaemonViewerClient({ client, clientId: "client" });
  expect(viewer.replayFromOrigin).toBe(false);
  // The viewer learns about a dead daemon through this seam; without it an outage is invisible.
  viewer.onConnectionChange(() => {});
  expect(watchers).toHaveLength(1);
  await viewer.attach("session");
  const received = [];
  const unsubscribe = viewer.subscribe("session", { sequence: "0" }, async (event) => { received.push(event); order.push(`process:${event.eventId}`); }, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  await viewer.command("interrupt", { sessionId: "session" });
  await viewer.detach("session");
  unsubscribe();
  expect(received).toEqual([{ eventId: "one", cursor: { sequence: "1" } }]);
  // The resume cursor moves only once the consumer has drawn the event: a drop before that replays
  // it, and a drop after it skips nothing.
  expect(order).toEqual(["process:one", "applied:1"]);
  // Nothing here reports a viewer cursor to the daemon.
  expect(viewer.ack).toBeUndefined();
  expect(requests.map(({ op }) => op)).toEqual(["attach", "interrupt", "detach"]);
});

// Operator-visible failure: a session already open elsewhere used to hand this viewer a read-only
// role. It opens for every dashboard now, and asks the daemon to start a worker that has exited.
it("opens a session another dashboard already has open, and asks for its worker", async () => {
  const requests = [];
  const client = {
    async request(value) { requests.push(value); return { ok: true, result: { kind: "attached", sessionId: "session" } }; },
  };
  const viewer = createDaemonViewerClient({ client, clientId: "client" });
  await expect(viewer.attach("session")).resolves.toEqual({ kind: "attached", sessionId: "session" });
  expect(requests).toEqual([expect.objectContaining({ op: "attach", payload: { sessionId: "session", activate: true } })]);
});

it("refuses an attachment result that is not one", async () => {
  const client = { async request() { return { ok: true, result: { kind: "detached", sessionId: "session" } }; } };
  const viewer = createDaemonViewerClient({ client, clientId: "client" });
  await expect(viewer.attach("session")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

it("detaches and reopens the same list when viewer construction fails", async () => {
  const constructionError = new Error("viewer construction failed");
  const viewerClient = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), command: vi.fn() };
  const controller = { close: vi.fn(async () => {}), open: vi.fn(async () => {}) };
  const activateViewer = vi.fn();
  const activateList = vi.fn();
  const restoreListFocus = vi.fn();
  const result = await runViewerTransition({
    sessionId: "session", viewerClient, controller,
    createViewer() { throw constructionError; },
    activateViewer, activateList, restoreListFocus, shouldRestore: () => true,
  });
  expect(result).toEqual({ kind: "failed", error: constructionError });
  expect(viewerClient.detach).toHaveBeenCalledWith("session");
  expect(controller.open).toHaveBeenCalledOnce();
  expect(activateViewer).not.toHaveBeenCalled();
  expect(activateList).toHaveBeenCalledOnce();
  expect(restoreListFocus).toHaveBeenCalledOnce();
  expect(viewerClient.command).not.toHaveBeenCalled();
});

it("reopens the list before exposing and focusing it after the viewer returns", async () => {
  let resolveViewer;
  let resolveOpen;
  const viewerClient = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}) };
  const controller = {
    closed: false,
    close: vi.fn(async () => { controller.closed = true; }),
    open: vi.fn(() => new Promise((resolve) => { resolveOpen = () => { controller.closed = false; resolve(); }; })),
  };
  const viewer = { open: vi.fn(async () => {}), closed: new Promise((resolve) => { resolveViewer = resolve; }), close: vi.fn(async () => {}) };
  const activateList = vi.fn();
  const restoreListFocus = vi.fn();
  let active = controller;
  const transition = runViewerTransition({
    sessionId: "session", viewerClient, controller, createViewer: () => viewer,
    activateViewer(value) { active = value; }, activateList, restoreListFocus,
    onRestoreClosed: vi.fn(), shouldRestore: () => true,
  });
  await vi.waitFor(() => expect(active).toBe(viewer));
  expect(controller.close).toHaveBeenCalledOnce();
  resolveViewer();
  await vi.waitFor(() => expect(controller.open).toHaveBeenCalledOnce());
  expect(activateList).not.toHaveBeenCalled();
  expect(restoreListFocus).not.toHaveBeenCalled();
  resolveOpen();
  await expect(transition).resolves.toEqual({ kind: "returned" });
  expect(activateList).toHaveBeenCalledOnce();
  expect(restoreListFocus).toHaveBeenCalledOnce();
});

it("restores the list without waiting for the detach round trip", async () => {
  let resolveDetach;
  const viewerClient = { attach: vi.fn(async () => {}), detach: vi.fn(() => new Promise((resolve) => { resolveDetach = resolve; })) };
  const controller = { closed: false, close: vi.fn(async () => { controller.closed = true; }), open: vi.fn(async () => { controller.closed = false; }) };
  const viewer = { open: vi.fn(async () => {}), closed: Promise.resolve(), close: vi.fn(async () => {}) };
  const activateList = vi.fn();
  const transition = await runViewerTransition({
    sessionId: "session", viewerClient, controller, createViewer: () => viewer,
    activateViewer() {}, activateList, restoreListFocus() {}, shouldRestore: () => true,
  });
  expect(transition).toEqual({ kind: "returned" });
  expect(viewerClient.detach).toHaveBeenCalledWith("session");
  expect(activateList).toHaveBeenCalledOnce();
  resolveDetach();
});

it("returns to the list while the viewer's open is still in flight", async () => {
  // Escape closes the viewer. A daemon request the open is still waiting on must not hold the list
  // back: that is what left the operator inside a session with no way out.
  let resolveClosed;
  const viewerClient = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}) };
  const controller = { closed: false, close: vi.fn(async () => { controller.closed = true; }), open: vi.fn(async () => { controller.closed = false; }) };
  const viewer = { open: vi.fn(() => new Promise(() => {})), closed: new Promise((resolve) => { resolveClosed = resolve; }), close: vi.fn(async () => {}) };
  const activateList = vi.fn();
  const restoreListFocus = vi.fn();
  const transition = runViewerTransition({
    sessionId: "session", viewerClient, controller, createViewer: () => viewer,
    activateViewer() {}, activateList, restoreListFocus, shouldRestore: () => true,
  });
  await vi.waitFor(() => expect(viewer.open).toHaveBeenCalledOnce());
  resolveClosed();
  await expect(transition).resolves.toEqual({ kind: "returned" });
  expect(controller.open).toHaveBeenCalledOnce();
  expect(activateList).toHaveBeenCalledOnce();
  expect(restoreListFocus).toHaveBeenCalledOnce();
});

it("reports a viewer that failed to open on the list", async () => {
  const failure = Object.assign(new Error("Unknown viewer session"), { code: "SESSION_NOT_FOUND" });
  const failures = [];
  const viewerClient = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}) };
  const controller = { closed: false, close: vi.fn(async () => { controller.closed = true; }), open: vi.fn(async () => { controller.closed = false; }), setError(error, fallback) { failures.push(error?.code ?? fallback); } };
  // ViewerController records openError before it closes itself, which is where the transition reads it.
  const viewer = { openError: failure, open: vi.fn(async () => { throw failure; }), closed: Promise.resolve(), close: vi.fn(async () => {}) };
  const transition = await runViewerTransition({
    sessionId: "session", viewerClient, controller, createViewer: () => viewer,
    activateViewer() {}, activateList() {}, restoreListFocus() {}, shouldRestore: () => true,
  });
  expect(transition).toEqual({ kind: "failed", error: failure });
  expect(failures).toEqual(["SESSION_NOT_FOUND"]);
});

it("holds a reattach behind the same session's in-flight detach", async () => {
  const order = [];
  let resolveDetach;
  const client = {
    async request(value) {
      if (value.op === "detach") {
        order.push("detach:start");
        await new Promise((resolve) => { resolveDetach = resolve; });
        order.push("detach:done");
        return { ok: true, result: { kind: "detached" } };
      }
      order.push(`${value.op}:run`);
      return { ok: true, result: { kind: "attached", sessionId: value.payload.sessionId } };
    },
  };
  const viewer = createDaemonViewerClient({ client, clientId: "client" });
  void viewer.detach("session").catch(() => {});
  await vi.waitFor(() => expect(order).toEqual(["detach:start"]));
  const reattach = viewer.attach("session");
  // A different session must not queue behind it.
  await viewer.attach("other");
  expect(order).toEqual(["detach:start", "attach:run"]);
  resolveDetach();
  await expect(reattach).resolves.toMatchObject({ kind: "attached", sessionId: "session" });
  expect(order).toEqual(["detach:start", "attach:run", "detach:done", "attach:run"]);
});

describe("viewer transition failures", () => {
  it("reports a refused viewer attach on the list instead of doing nothing", async () => {
      // A refused attach used to be dropped, so Enter and Right looked like dead keys.
      const failures = [];
      const controller = { closed: false, async close() {}, async open() {}, setError(error, fallback) { failures.push({ code: error?.code ?? fallback, message: error?.message }); } };
      const viewerClient = { async attach() { throw Object.assign(new Error("Session worker is reconnecting"), { code: "WORKER_RECONNECTING" }); }, async detach() {} };
      const outcome = await runViewerTransition({
          sessionId: "a", viewerClient, controller,
          createViewer: () => { throw new Error("viewer must not be created when attach fails"); },
          activateViewer() {}, activateList() {}, restoreListFocus() {},
          shouldRestore: () => true,
      });
      expect(outcome).toMatchObject({ kind: "failed" });
      expect(failures).toEqual([{ code: "WORKER_RECONNECTING", message: "Session worker is reconnecting" }]);
  });
});
