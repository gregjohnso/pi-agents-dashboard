import { describe, expect, it, vi } from "vitest";

import { runViewerTransition } from "./standalone-list.mjs";

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

it("reopens the list before exposing and focusing it after the viewer returns", async () => {
  let resolveViewer;
  let resolveOpen;
  const client = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}) };
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
    sessionId: "session", client, controller, createViewer: () => viewer,
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
  const client = { attach: vi.fn(async () => {}), detach: vi.fn(() => new Promise((resolve) => { resolveDetach = resolve; })) };
  const controller = { closed: false, close: vi.fn(async () => { controller.closed = true; }), open: vi.fn(async () => { controller.closed = false; }) };
  const viewer = { open: vi.fn(async () => {}), closed: Promise.resolve(), close: vi.fn(async () => {}) };
  const activateList = vi.fn();
  const transition = await runViewerTransition({
    sessionId: "session", client, controller, createViewer: () => viewer,
    activateViewer() {}, activateList, restoreListFocus() {}, shouldRestore: () => true,
  });
  expect(transition).toEqual({ kind: "returned" });
  expect(client.detach).toHaveBeenCalledWith("session");
  expect(activateList).toHaveBeenCalledOnce();
  resolveDetach();
});

it("returns to the list while the viewer's open is still in flight", async () => {
  // Escape closes the viewer. A daemon request the open is still waiting on must not hold the list
  // back: that is what left the operator inside a session with no way out.
  let resolveClosed;
  const client = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}) };
  const controller = { closed: false, close: vi.fn(async () => { controller.closed = true; }), open: vi.fn(async () => { controller.closed = false; }) };
  const viewer = { open: vi.fn(() => new Promise(() => {})), closed: new Promise((resolve) => { resolveClosed = resolve; }), close: vi.fn(async () => {}) };
  const activateList = vi.fn();
  const restoreListFocus = vi.fn();
  const transition = runViewerTransition({
    sessionId: "session", client, controller, createViewer: () => viewer,
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
  const client = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}) };
  const controller = { closed: false, close: vi.fn(async () => { controller.closed = true; }), open: vi.fn(async () => { controller.closed = false; }), setError(error, fallback) { failures.push(error?.code ?? fallback); } };
  // ViewerController records openError before it closes itself, which is where the transition reads it.
  const viewer = { openError: failure, open: vi.fn(async () => { throw failure; }), closed: Promise.resolve(), close: vi.fn(async () => {}) };
  const transition = await runViewerTransition({
    sessionId: "session", client, controller, createViewer: () => viewer,
    activateViewer() {}, activateList() {}, restoreListFocus() {}, shouldRestore: () => true,
  });
  expect(transition).toEqual({ kind: "failed", error: failure });
  expect(failures).toEqual(["SESSION_NOT_FOUND"]);
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
