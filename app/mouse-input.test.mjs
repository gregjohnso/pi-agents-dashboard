import { describe, expect, it, vi } from "vitest";

import { Component, TuiAltScreen } from "@earendil-works/pi-tui";
import { createWheelInputTap, parseWheelInput } from "./mouse-input.mjs";

describe("wheel input parsing", () => {
  const x10 = (button, column, row) => `\x1b[M${String.fromCharCode(button + 32, column + 32, row + 32)}`;

  it.each([
    ["SGR wheel-up with zero-based coordinates", "\x1b[<64;13;5M", { events: [{ button: "wheel_up", column: 12, row: 4 }], passThrough: "", pending: "" }],
    ["SGR wheel-down with zero-based coordinates", "\x1b[<65;1;1M", { events: [{ button: "wheel_down", column: 0, row: 0 }], passThrough: "", pending: "" }],
    ["X10 wheel-up", x10(64, 4, 9), { events: [{ button: "wheel_up", column: 3, row: 8 }], passThrough: "", pending: "" }],
    // pi-tui keeps selection and clicks, so a non-wheel mouse report must reach it untouched.
    ["a non-wheel mouse report", "\x1b[<0;5;5M", { events: [], passThrough: "\x1b[<0;5;5M", pending: "" }],
    ["a wheel event surrounded by keystrokes", "ab\x1b[<65;2;3Mcd", { events: [{ button: "wheel_down", column: 1, row: 2 }], passThrough: "abcd", pending: "" }],
  ])("reads %s", (_label, input, expected) => {
    expect(parseWheelInput(input)).toEqual(expected);
  });

  it.each([
    ["a split wheel report", "\x1b[<65;2", ";3M", { events: [{ button: "wheel_down", column: 1, row: 2 }], passThrough: "", pending: "" }],
    ["a prefix that turns out not to be a mouse report", "\x1b[", "A", { events: [], passThrough: "\x1b[A", pending: "" }],
  ])("holds %s as pending instead of dropping or corrupting it", (_label, first, rest, expected) => {
    const held = parseWheelInput(first);
    expect(held).toEqual({ events: [], passThrough: "", pending: first });
    expect(parseWheelInput(`${held.pending}${rest}`)).toEqual(expected);
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

  it("dispatches wheel events, withholds them, and forwards every other byte", () => {
    const terminal = fakeTerminal();
    const onWheel = vi.fn();
    const tapped = createWheelInputTap(terminal, onWheel);
    const forwarded = [];
    tapped.start((data) => forwarded.push(data), () => {});
    terminal.started.onInput("\x1b[<64;3;7M");
    terminal.started.onInput("hello");
    terminal.started.onInput("\x1b[B");
    expect(onWheel).toHaveBeenCalledWith({ button: "wheel_up", column: 2, row: 6 });
    expect(forwarded).toEqual(["hello", "\x1b[B"]);
  });

});

describe("installed pi-tui mouse assumptions", () => {
  const upgradeNotice = "pi-tui changed its mouse handling since the verified 0.84.3. Delete app/mouse-input.mjs and its terminal tap, and route wheel events through pi-tui's real seam instead.";

  it("still exposes no component mouse seam and still consumes wheel bytes", () => {
    // The tap exists only because a component cannot receive mouse events.
    const componentKeys = Object.keys(Component ?? {});
    expect(componentKeys.some((key) => /mouse/i.test(key)), upgradeNotice).toBe(false);
    const altScreenMethods = Object.getOwnPropertyNames(TuiAltScreen.prototype);
    expect(altScreenMethods.includes("setMouseHandler") || altScreenMethods.includes("onMouse"), upgradeNotice).toBe(false);

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
