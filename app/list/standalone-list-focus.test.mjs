import { stripVTControlCharacters } from "node:util";

import { createWheelInputTap } from "../mouse-input.mjs";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";

import { SPINNER_INTERVAL_MS, spinnerFrame } from "../spinner.mjs";
import { DashboardController } from "./dashboard.mjs";
import * as standaloneList from "./standalone-list.mjs";

class FakeTerminal {
  columns = 80;
  rows = 37;
  input;
  writes = [];

  start(onInput) { this.input = onInput; }
  stop() { this.input = undefined; }
  write(data) { this.writes.push(data); }
  hideCursor() {}
  showCursor() {}
}

const FRAMES = new Set(Array.from({ length: 10 }, (_, index) => spinnerFrame(index * SPINNER_INTERVAL_MS)));
const at = "2026-08-25T12:00:00.000Z";

function workingSession() {
  return {
    schemaVersion: 1, revision: 1, sessionId: "busy", sessionFile: "/sessions/busy.jsonl", canonicalSessionFile: "/sessions/busy.jsonl",
    cwd: "/repo", name: "busy", taskState: "WORKING", processState: "LIVE", outcome: "NONE",
    activity: { kind: "tool", summary: "bash", updatedAt: at }, createdAt: at, updatedAt: at,
  };
}

/** Mount one real dashboard on a real alternate-screen TUI, wired exactly as createStandaloneList wires it. */
function mountedDashboard() {
  const terminal = new FakeTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const backend = {
    async getSnapshot() { return { sessions: [workingSession()], cursor: { daemonEpoch: "epoch", sequence: "1" } }; },
    async subscribeListChanges(onChanged, onError) { backend.notifyListChanged = onChanged; backend.onError = onError; return () => { backend.unsubscribed = true; }; },
    async preflightLaunch(draft) { return { canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }; },
    async launch() { return { kind: "launched", sessionId: "busy" }; },
  };
  const controller = new DashboardController({
    backend, openViewer: async () => {},
    clientId: "host-client", launchDefaults: { cwd: "/repo", model: { provider: "anthropic", id: "claude" }, name: "task" },
    requestRender: () => tui.requestRender(),
  });
  let depth = 0;
  const render = controller.render.bind(controller);
  controller.render = (width, height) => {
    if (depth > 0) throw new Error("Dashboard render re-entered itself");
    depth += 1;
    try { return render(width, height); } finally { depth -= 1; }
  };
  standaloneList.mountStandaloneHost({ tui, getActive: () => controller });
  return { backend, controller, terminal, tui };
}

function paintedGlyphs(terminal) {
  return [...stripVTControlCharacters(terminal.writes.join(""))].filter((character) => FRAMES.has(character));
}

it("restores the alternate screen when terminal startup fails", () => {
  expect(standaloneList.startStandaloneTui).toBeTypeOf("function");

  const terminal = new FakeTerminal();
  terminal.start = () => { throw new Error("raw mode failed"); };
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });

  expect(() => standaloneList.startStandaloneTui(tui)).toThrow("raw mode failed");
  expect(terminal.writes.join("")).toContain("\x1b[?1049h");
  expect(terminal.writes.join("")).toContain("\x1b[?1049l");
});

it("focuses the mounted list host so real TUI input reaches the active controller", () => {
  expect(standaloneList.mountStandaloneHost).toBeTypeOf("function");

  const terminal = new FakeTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const active = { render: vi.fn(() => ["dashboard"]), handleInput: vi.fn() };
  const host = standaloneList.mountStandaloneHost({
    tui,
    getActive: () => active,
  });

  host.component.render(80);
  expect(active.render).toHaveBeenCalledWith(80, 37);
  expect(tui.getFocusedComponent()).toBe(host.component);
  tui.start();
  terminal.input?.("\x1b[B");
  expect(active.handleInput).toHaveBeenCalledWith("\x1b[B");
  tui.stop({ preserveScreen: true });
});

it("repaints the mounted list with a moving throbber and stops the timer on close", async () => {
  const { controller, terminal, tui } = mountedDashboard();
  tui.start();
  await controller.open();

  await vi.waitFor(() => expect(new Set(paintedGlyphs(terminal)).size).toBeGreaterThan(1), { timeout: 2_000 });

  await controller.close();
  terminal.writes.length = 0;
  await new Promise((resolve) => setTimeout(resolve, SPINNER_INTERVAL_MS * 4));
  expect(terminal.writes).toEqual([]);
  tui.stop({ preserveScreen: true });
});

it("stops the spinner timer when the dashboard closes on a subscription failure", async () => {
  const { backend, controller, terminal, tui } = mountedDashboard();
  tui.start();
  await controller.open();
  await vi.waitFor(() => expect(paintedGlyphs(terminal).length).toBeGreaterThan(0), { timeout: 2_000 });

  backend.onError({ code: "MALFORMED_FRAME", message: "Daemon event stream failed" });
  await vi.waitFor(() => expect(controller.status).toMatchObject({ kind: "error" }));
  await new Promise((resolve) => setTimeout(resolve, SPINNER_INTERVAL_MS));
  terminal.writes.length = 0;
  await new Promise((resolve) => setTimeout(resolve, SPINNER_INTERVAL_MS * 4));
  expect(terminal.writes).toEqual([]);
  tui.stop({ preserveScreen: true });
});

it("routes wheel events past pi-tui to the active surface", () => {
  const terminal = createWheelInputTap(new FakeTerminal());
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const active = { render: vi.fn(() => ["dashboard"]), handleInput: vi.fn(), handleMouse: vi.fn() };
  const host = standaloneList.mountStandaloneHost({ tui, getActive: () => active, terminal });

  tui.start();
  terminal.input?.("\x1b[<64;4;9M");
  expect(active.handleMouse).toHaveBeenCalledWith({ button: "wheel_up", column: 3, row: 8 });
  expect(active.handleInput).not.toHaveBeenCalled();

  terminal.input?.("\x1b[B");
  expect(active.handleInput).toHaveBeenCalledWith("\x1b[B");
  tui.stop({ preserveScreen: true });
  expect(host.component).toBeDefined();
});
