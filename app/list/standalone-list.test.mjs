import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonViewerClient, createFrontendPersistence, runViewerTransition } from "./standalone-list.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-dashboard-frontend-state-"));
  roots.push(root);
  return join(root, "frontend-state.json");
}

it("adapts the installed daemon client to origin replay, mutation, ACK, and detach", async () => {
  const requests = [];
  const events = { async *[Symbol.asyncIterator]() { yield { eventId: "one" }; } };
  const client = {
    async request(value) {
      requests.push(value);
      const result = value.op === "attach" ? { kind: "attached", role: "composer" }
        : value.op === "detach" ? { kind: "detached" }
          : { kind: "command", status: { stage: "COMPLETED" } };
      return { ok: true, result };
    },
    async getViewerSnapshot(sessionId) { return { sessionId }; },
    subscribeViewer(sessionId, cursor) { expect([sessionId, cursor.sequence]).toEqual(["session", "0"]); return events; },
    async ackViewer(cursor) { return cursor; },
  };
  const viewer = createDaemonViewerClient({ client, clientId: "client" });
  expect(viewer.replayFromOrigin).toBe(false);
  await viewer.attach("session");
  const received = [];
  const unsubscribe = viewer.subscribe("session", { sequence: "0" }, async (event) => { received.push(event); }, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  await viewer.command("interrupt", { sessionId: "session" });
  await viewer.ack("session", { sequence: "1" });
  await viewer.detach("session");
  unsubscribe();
  expect(received).toEqual([{ eventId: "one" }]);
  expect(requests.map(({ op }) => op)).toEqual(["attach", "interrupt", "detach"]);
});

it("refuses observer fallback instead of opening a read-only viewer", async () => {
  const client = {
    async request() { return { ok: true, result: { kind: "attached", sessionId: "session", role: "observer" } }; },
  };
  const viewer = createDaemonViewerClient({ client, clientId: "client" });
  await expect(viewer.attach("session")).rejects.toMatchObject({ code: "SESSION_IN_USE" });
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
      return { ok: true, result: { kind: "attached", sessionId: value.payload.sessionId, role: "composer" } };
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
  await expect(reattach).resolves.toMatchObject({ role: "composer" });
  expect(order).toEqual(["detach:start", "attach:run", "detach:done", "attach:run"]);
});

it("does not replace the prior cursor when publication fails before rename", async () => {
  const path = await fixture();
  const original = { schemaVersion: 1, clientId: "client", cursor: { daemonEpoch: "epoch", sequence: "1" }, viewState: { query: { view: "live" } }, launchDraft: {} };
  await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const persistence = createFrontendPersistence(path, "client", { failpoint(stage) { if (stage === "after_file_sync") throw new Error("crash"); } });
  await expect(persistence.save({ ...original, cursor: { daemonEpoch: "epoch", sequence: "2" } })).rejects.toThrow("crash");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
});

it("refuses malformed or non-private cursor state", async () => {
  const path = await fixture();
  await writeFile(path, JSON.stringify({ schemaVersion: 1, clientId: "client", cursor: { daemonEpoch: "epoch", sequence: "01" } }), { mode: 0o644 });
  await expect(createFrontendPersistence(path, "client").load()).rejects.toMatchObject({ code: "FRONTEND_STATE_UNSAFE" });

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
