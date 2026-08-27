import { createWheelInputTap } from "../mouse-input.mjs";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";

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
