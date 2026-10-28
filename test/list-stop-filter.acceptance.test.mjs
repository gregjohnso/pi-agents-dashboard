import { stripVTControlCharacters } from "node:util";

import { TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";

import { DashboardController } from "../app/list/dashboard.mjs";
import { mountStandaloneHost } from "../app/list/standalone-list.mjs";
import { ScreenTerminal } from "./alt-screen-harness.mjs";

/**
 * What Ctrl+X does to the list the operator chose to look at.
 *
 * Operator-visible failure: stopping a session threw the list back to the unfiltered view, so every
 * killed and stopped session the operator had filtered away reappeared under his cursor. Removing
 * that switch exposes the second failure this file pins: under the live view the stopped row leaves
 * the list at once, the selection lands on a neighbour, and a quick second Ctrl+X aimed at clearing
 * the session just stopped would stop that neighbour instead.
 *
 * Every press here goes through the same input router the frontend mounts, onto a real alternate
 * screen, so a fix that only holds when a controller is driven directly does not pass.
 */

const at = "2026-08-25T12:00:00.000Z";
let coverage = 0;
function nextCoverage() { coverage += 1; return { daemonEpoch: "epoch", sequence: String(coverage) }; }

function session(sessionId, overrides = {}) {
  return {
    schemaVersion: 1, revision: 1, sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`, canonicalSessionFile: `/sessions/${sessionId}.jsonl`,
    cwd: "/repo", name: sessionId, taskState: "READY", processState: "LIVE", outcome: "NONE",
    activity: { kind: "assistant_final", summary: `activity ${sessionId}`, updatedAt: at },
    createdAt: at, updatedAt: at,
    ...overrides,
  };
}

const stopped = (sessionId, revision = 2) => session(sessionId, { taskState: "STOPPED", processState: "EXITED", revision });
const STOP_CLEAR_WINDOW_MS = 500;

class FakeDaemonClient {
  stop = vi.fn(async () => {});
  delete = vi.fn(async () => {});
  constructor(sessions) { this.snapshot = { sessions, cursor: nextCoverage() }; }
  setSessions(sessions) { this.snapshot = { sessions, cursor: nextCoverage() }; }
  async getState() { return this.snapshot; }
  async subscribeListChanges(onChanged) { this.notifyListChanged = onChanged; return () => {}; }
  async preflightLaunch(draft) { return { canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }; }
  async launch() { return { kind: "launched", sessionId: "new" }; }
  async getModels() { return []; }
  async refreshSummaries() { return []; }
}

/** @type {any[]} */
const screens = [];
afterEach(() => { for (const tui of screens.splice(0)) tui.stop({ preserveScreen: true }); });

/** One dashboard behind the frontend's own router and alternate screen. */
async function mountedList(sessions, { now = () => 0 } = {}) {
  const client = new FakeDaemonClient(sessions);
  const terminal = new ScreenTerminal({ columns: 100, rows: 28 });
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  screens.push(tui);
  /** @type {any} */
  let controller;
  controller = new DashboardController({
    client, openViewer: vi.fn(async () => {}),
    clientId: "stop-filter-client", sourceSessionId: "source", requestId: () => "stop-filter-request",
    launchDefaults: { cwd: "/repo", model: { provider: "anthropic", id: "claude" }, name: "task" },
    requestRender: () => tui.requestRender(), now,
  });
  mountStandaloneHost({ tui, getActive: () => controller });
  await controller.open();
  tui.start();
  tui.renderNow();
  const paint = () => { tui.renderNow(); return terminal.screen().map(stripVTControlCharacters).join("\n"); };
  // Only the session panel: the dock legitimately names the session a status line or an armed clear
  // is talking about, and that is not a row the operator can select.
  const rows = () => {
    const lines = terminal.screen().map(stripVTControlCharacters);
    const top = lines.findIndex((line) => line.includes("Sessions"));
    const bottom = lines.findIndex((line, index) => index > top && /^\s*[\u2500]+\s*$/u.test(line));
    return lines.slice(top + 1, bottom === -1 ? lines.length : bottom).join("\n");
  };
  return { client, controller, paint, rows, terminal, tui, type: (data) => { terminal.type(data); tui.renderNow(); } };
}

it("keeps the operator's chosen view when Ctrl+X stops a session", async () => {
  const f = await mountedList([session("alpha"), session("beta"), stopped("gone", 1)]);
  // The live view is the default, and it is what the operator is looking at.
  expect(f.controller.query).toMatchObject({ view: "live" });
  expect(f.rows()).not.toContain("gone");
  f.controller.selectSession("alpha");

  f.type("\x18");
  expect(f.client.stop).not.toHaveBeenCalled();
  f.type("\x18");

  await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledWith("alpha", 1, "stop-filter-request"));
  expect(f.controller.query).toMatchObject({ view: "live" });
  expect(f.rows()).not.toContain("gone");
});

it("abandons an armed stop when the operator changes selection, requiring two fresh taps", async () => {
  const f = await mountedList([session("alpha"), session("beta")]);
  f.controller.selectSession("alpha");
  f.type("\x18");
  expect(f.paint()).toContain("ctrl+x again to stop alpha");
  f.type("\x1b[B");
  f.type("\x18");
  expect(f.client.stop).not.toHaveBeenCalled();
  expect(f.client.delete).not.toHaveBeenCalled();
  f.type("\x18");
  await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledWith("beta", 1, "stop-filter-request"));
});

/**
 * A stop the daemon has not answered yet is still the operator's to abandon.
 *
 * Operator-visible failure: he pressed Ctrl+X, the daemon took its time, and he moved on. The ack
 * then armed the session he had left behind, the dock offered to clear it while his cursor sat
 * somewhere else, and his next Ctrl+X acted on that old row instead of the one he was looking at.
 */
it.each([
  ["moves the selection", (/** @type {any} */ f) => f.type("\x1b[B")],
])("abandons an unanswered stop once the operator %s", async (_label, abandon) => {
  /** @type {() => void} */
  let release;
  const f = await mountedList([session("alpha"), session("beta")]);
  f.client.stop = vi.fn(() => new Promise((resolve) => { release = () => resolve(undefined); }));
  f.controller.selectSession("alpha");
  f.type("\x18");
  expect(f.client.stop).not.toHaveBeenCalled();
  f.type("\x18");
  await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledTimes(1));

  abandon(f);
  release();
  await vi.waitFor(() => expect(f.controller.status).not.toMatchObject({ kind: "pending" }));

  // Nothing is armed, and nothing offers to clear a session the operator walked away from.
  expect(f.controller.stopClearArmed).toBe(false);
  expect(f.paint()).not.toContain("ctrl+x again");
});

it("leaves an unanswered stop behind when the frontend closes before the ack", async () => {
  /** @type {() => void} */
  let release;
  const f = await mountedList([session("alpha"), session("beta")]);
  f.client.stop = vi.fn(() => new Promise((resolve) => { release = () => resolve(undefined); }));
  f.controller.selectSession("alpha");
  f.type("\x18");
  expect(f.client.stop).not.toHaveBeenCalled();
  f.type("\x18");
  await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledTimes(1));

  await f.controller.close();
  release();
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  expect(f.controller.stopClearArmed).toBe(false);
});

/**
 * Operator-visible failure: another frontend cleared the session this one had just stopped, and the
 * second Ctrl+X fell through to the live row under the cursor and stopped it.
 */
/**
 * Operator-visible failure: a second Ctrl+X while the daemon was still answering the first sent a
 * second stop at a stale revision, and once the row had left a filtered view that second press
 * landed on the neighbour the selection had moved to.
 */
it("arms nothing while the stop is still in flight or after it failed", async () => {
  let release;
  const f = await mountedList([session("alpha"), session("beta")]);
  f.client.stop = vi.fn(() => new Promise((resolve) => { release = resolve; }));
  f.controller.selectSession("alpha");

  f.type("\x18");
  expect(f.client.stop).not.toHaveBeenCalled();
  f.type("\x18");
  await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledTimes(1));
  // In flight: a second press must not remove anything, because nothing has stopped yet.
  f.type("\x18");
  expect(f.client.delete).not.toHaveBeenCalled();
  release();

  const failing = await mountedList([session("gamma")]);
  failing.client.stop = vi.fn(async () => { throw Object.assign(new Error("worker refused"), { code: "STOP_FAILED" }); });
  failing.controller.selectSession("gamma");
  failing.type("\x18");
  expect(failing.client.stop).not.toHaveBeenCalled();
  failing.type("\x18");
  await vi.waitFor(() => expect(failing.controller.status).toMatchObject({ kind: "error", code: "STOP_FAILED" }));
  failing.type("\x18");
  expect(failing.client.stop).toHaveBeenCalledTimes(1);
  failing.type("\x18");
  expect(failing.client.delete).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(failing.client.stop).toHaveBeenCalledTimes(2));
});
