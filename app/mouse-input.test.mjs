import { describe, expect, it, vi } from "vitest";

import { Component, TuiAltScreen } from "@earendil-works/pi-tui";
import { createWheelInputTap, parseWheelInput } from "./mouse-input.mjs";

describe("wheel input parsing", () => {
  it("reads SGR wheel-up and wheel-down with zero-based coordinates", () => {
    expect(parseWheelInput("\x1b[<64;13;5M")).toEqual({ events: [{ button: "wheel_up", column: 12, row: 4 }], passThrough: "", pending: "" });
    expect(parseWheelInput("\x1b[<65;1;1M")).toEqual({ events: [{ button: "wheel_down", column: 0, row: 0 }], passThrough: "", pending: "" });
  });

  it("reads X10 wheel encoding", () => {
    const x10 = (button, column, row) => `\x1b[M${String.fromCharCode(button + 32, column + 32, row + 32)}`;
    expect(parseWheelInput(x10(64, 4, 9)).events).toEqual([{ button: "wheel_up", column: 3, row: 8 }]);
    expect(parseWheelInput(x10(65, 4, 9)).events).toEqual([{ button: "wheel_down", column: 3, row: 8 }]);
  });

  it("passes through keystrokes untouched", () => {
    expect(parseWheelInput("q")).toEqual({ events: [], passThrough: "q", pending: "" });
    expect(parseWheelInput("\x1b[A")).toEqual({ events: [], passThrough: "\x1b[A", pending: "" });
    expect(parseWheelInput("\x03")).toEqual({ events: [], passThrough: "\x03", pending: "" });
  });

  it("passes through non-wheel mouse reports so pi-tui keeps selection and clicks", () => {
    expect(parseWheelInput("\x1b[<0;5;5M").passThrough).toBe("\x1b[<0;5;5M");
    expect(parseWheelInput("\x1b[<0;5;5M").events).toEqual([]);
  });

  it("separates wheel events from surrounding keystrokes without dropping bytes", () => {
    const result = parseWheelInput("ab\x1b[<65;2;3Mcd");
    expect(result.events).toEqual([{ button: "wheel_down", column: 1, row: 2 }]);
    expect(result.passThrough).toBe("abcd");
  });

  it("holds a split sequence as pending instead of dropping or corrupting it", () => {
    const first = parseWheelInput("\x1b[<65;2");
    expect(first).toEqual({ events: [], passThrough: "", pending: "\x1b[<65;2" });
    const second = parseWheelInput(`${first.pending};3M`);
    expect(second.events).toEqual([{ button: "wheel_down", column: 1, row: 2 }]);
    expect(second.passThrough).toBe("");
  });

  it("releases a pending prefix that turns out not to be a mouse report", () => {
    const first = parseWheelInput("\x1b[");
    expect(first.pending).toBe("\x1b[");
    const second = parseWheelInput(`${first.pending}A`);
    expect(second.passThrough).toBe("\x1b[A");
    expect(second.events).toEqual([]);
  });
});

describe("wheel input tap", () => {
  const fakeTerminal = () => {
    const terminal = {
      delivered: [],
      started: undefined,
      start(onInput, onResize) { this.started = { onInput, onResize }; },
      stop() { this.stopped = true; },
      write(data) { this.written = data; },
      get columns() { return 80; },
      get rows() { return 24; },
    };
    return terminal;
  };

  it("dispatches wheel events and withholds them from the wrapped terminal", () => {
    const terminal = fakeTerminal();
    const onWheel = vi.fn();
    const tapped = createWheelInputTap(terminal, onWheel);
    const forwarded = [];
    tapped.start((data) => forwarded.push(data), () => {});
    terminal.started.onInput("\x1b[<64;3;7M");
    expect(onWheel).toHaveBeenCalledWith({ button: "wheel_up", column: 2, row: 6 });
    expect(forwarded).toEqual([]);
  });

  it("forwards every non-wheel byte to the wrapped input handler", () => {
    const terminal = fakeTerminal();
    const tapped = createWheelInputTap(terminal, () => {});
    const forwarded = [];
    tapped.start((data) => forwarded.push(data), () => {});
    terminal.started.onInput("hello");
    terminal.started.onInput("\x1b[B");
    expect(forwarded).toEqual(["hello", "\x1b[B"]);
  });

  it("keeps delegating the rest of the terminal contract", () => {
    const terminal = fakeTerminal();
    const tapped = createWheelInputTap(terminal, () => {});
    expect(tapped.columns).toBe(80);
    expect(tapped.rows).toBe(24);
    tapped.write("x");
    expect(terminal.written).toBe("x");
    tapped.stop();
    expect(terminal.stopped).toBe(true);
  });
});

describe("installed pi-tui mouse assumptions", () => {
  const upgradeNotice = "pi-tui changed its mouse handling since the verified 0.84.3. Delete app/mouse-input.mjs and its terminal tap, and route wheel events through pi-tui's real seam instead.";

  it("still exposes no component mouse seam", () => {
    // The tap exists only because a component cannot receive mouse events.
    const componentKeys = Object.keys(Component ?? {});
    expect(componentKeys.some((key) => /mouse/i.test(key)), upgradeNotice).toBe(false);
    const altScreenMethods = Object.getOwnPropertyNames(TuiAltScreen.prototype);
    expect(altScreenMethods.includes("setMouseHandler") || altScreenMethods.includes("onMouse"), upgradeNotice).toBe(false);
  });

  it("still consumes wheel bytes instead of dispatching them to a focused component", () => {
    let deliver;
    const terminal = {
      start(onInput) { deliver = onInput; }, stop() {}, write() {},
      get columns() { return 80; }, get rows() { return 24; },
      get kittyProtocolActive() { return false; },
      moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
      clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
      async drainInput() {},
    };
    const tui = new TuiAltScreen(terminal);
    const received = [];
    const component = { render: () => ["x"], handleInput: (data) => received.push(data), invalidate() {} };
    tui.addChild(component);
    tui.setFocus(component);
    tui.start();
    try {
      deliver("\x1b[<64;3;7M");
      expect(received, upgradeNotice).toEqual([]);
      deliver("k");
      expect(received, "pi-tui stopped delivering ordinary keystrokes to a focused component").toEqual(["k"]);
    } finally {
      tui.stop({ preserveScreen: true });
    }
  });
});
