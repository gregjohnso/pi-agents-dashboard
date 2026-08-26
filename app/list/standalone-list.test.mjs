import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

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
  expect(viewer.replayFromOrigin).toBe(true);
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

it("keeps the list open and does not signal when viewer attach fails", async () => {
  const attachError = new Error("attach failed");
  const viewerClient = { attach: vi.fn(async () => { throw attachError; }), detach: vi.fn(), command: vi.fn() };
  const controller = { close: vi.fn(), open: vi.fn() };
  const createViewer = vi.fn();
  const activateList = vi.fn();
  const result = await runViewerTransition({
    sessionId: "session", viewerClient, controller, createViewer,
    activateViewer: vi.fn(), activateList, restoreListFocus: vi.fn(), shouldRestore: () => true,
  });
  expect(result).toEqual({ kind: "failed", error: attachError });
  expect(controller.close).not.toHaveBeenCalled();
  expect(controller.open).not.toHaveBeenCalled();
  expect(createViewer).not.toHaveBeenCalled();
  expect(viewerClient.detach).not.toHaveBeenCalled();
  expect(viewerClient.command).not.toHaveBeenCalled();
  expect(activateList).toHaveBeenCalledOnce();
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

it("reports a close during delayed list reopen instead of focusing a closed controller", async () => {
  let resolveViewer;
  let resolveOpen;
  const viewerClient = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}) };
  const controller = {
    closed: false,
    close: vi.fn(async () => { controller.closed = true; }),
    open: vi.fn(() => new Promise((resolve) => { resolveOpen = resolve; })),
  };
  const viewer = { open: vi.fn(async () => {}), closed: new Promise((resolve) => { resolveViewer = resolve; }), close: vi.fn(async () => {}) };
  const activateList = vi.fn();
  const restoreListFocus = vi.fn();
  const onRestoreClosed = vi.fn();
  const transition = runViewerTransition({
    sessionId: "session", viewerClient, controller, createViewer: () => viewer,
    activateViewer: vi.fn(), activateList, restoreListFocus, onRestoreClosed, shouldRestore: () => true,
  });
  await vi.waitFor(() => expect(viewer.open).toHaveBeenCalledOnce());
  resolveViewer();
  await vi.waitFor(() => expect(controller.open).toHaveBeenCalledOnce());
  controller.closed = true;
  resolveOpen();
  await expect(transition).resolves.toEqual({ kind: "returned" });
  expect(onRestoreClosed).toHaveBeenCalledOnce();
  expect(activateList).not.toHaveBeenCalled();
  expect(restoreListFocus).not.toHaveBeenCalled();
});

it("disposes a failed viewer and restores the list without signaling", async () => {
  const runError = new Error("viewer open failed");
  const viewerClient = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), command: vi.fn() };
  const controller = { close: vi.fn(async () => {}), open: vi.fn(async () => {}) };
  const viewer = { open: vi.fn(async () => { throw runError; }), closed: Promise.resolve(), close: vi.fn(async () => {}) };
  let active = "list";
  const result = await runViewerTransition({
    sessionId: "session", viewerClient, controller, createViewer: () => viewer,
    activateViewer() { active = "viewer"; }, activateList() { active = "list"; }, restoreListFocus: vi.fn(), shouldRestore: () => true,
  });
  expect(result).toEqual({ kind: "failed", error: runError });
  expect(viewer.close).toHaveBeenCalledOnce();
  expect(viewerClient.detach).toHaveBeenCalledWith("session");
  expect(controller.open).toHaveBeenCalledOnce();
  expect(viewerClient.command).not.toHaveBeenCalled();
  expect(active).toBe("list");
});

it("fsyncs the private cursor file and parent directory around atomic publication", async () => {
  const path = await fixture();
  const stages = [];
  const persistence = createFrontendPersistence(path, "client", { failpoint: async (stage) => stages.push(stage) });
  await persistence.save({ schemaVersion: 1, clientId: "client", cursor: { daemonEpoch: "epoch", sequence: "1" }, viewState: { query: { view: "live" } }, launchDraft: {} });
  expect(stages).toEqual(["after_file_sync", "after_rename", "after_directory_sync"]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
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
