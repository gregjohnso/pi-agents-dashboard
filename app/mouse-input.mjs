/**
 * Wheel-event extraction for full-screen surfaces.
 *
 * pi-tui 0.84.3 offers no component mouse seam: `TuiAltScreen.handleViewportInput` parses wheel
 * bytes and returns `{ consume: true }` before any child dispatch, then scrolls its own ScrollViews,
 * which our full-screen renderers never use. So a wheel event cannot reach a component at all.
 * Reading wheel input ahead of the TUI is the only way to scroll our own surfaces. The canary tests
 * in mouse-input.test.mjs fail once pi-tui grows a real seam, so this module can be deleted then.
 */

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const X10_MOUSE_PREFIX = "\x1b[M";
const X10_MOUSE_LENGTH = 6;
const WHEEL_FLAG = 64;

/** Longest byte string that can still grow into a complete mouse report. */
const MAX_PENDING = 32;

/**
 * Longest a held partial sequence waits before it reaches the TUI unchanged. pi-tui's own
 * StdinBuffer splits the same way (10 ms for a lone Escape, 50 ms for a longer partial), so the tap
 * never holds a byte longer than the library behind it already would.
 */
const ESCAPE_FLUSH_MS = 10;
const SEQUENCE_FLUSH_MS = 50;

const DRAG_FLAG = 32;

/**
 * Name the event a mouse report carries, or undefined to leave the bytes to pi-tui.
 * Wheel notches scroll, and a plain left-button press selects; drags, other buttons and modified
 * clicks stay with pi-tui, which owns text selection.
 * @param {number} button @returns {"wheel_up" | "wheel_down" | "left" | undefined}
 */
function mouseButton(button) {
  if ((button & WHEEL_FLAG) !== 0) {
    const direction = button & 3;
    if (direction === 0) return "wheel_up";
    if (direction === 1) return "wheel_down";
    return undefined;
  }
  return button === 0 ? "left" : undefined;
}

/** True when `data` is a strict prefix of some complete mouse report. */
function couldCompleteMouseReport(data) {
  if (data.length >= MAX_PENDING) return false;
  if (data.startsWith(X10_MOUSE_PREFIX)) return data.length < X10_MOUSE_LENGTH;
  for (const prefix of ["\x1b", "\x1b[", "\x1b[<"]) {
    if (data === prefix) return true;
  }
  return /^\x1b\[<\d*(;\d*){0,2}$/.test(data);
}

/**
 * Split terminal input into wheel events and bytes the TUI should still see.
 *
 * Every byte is either reported as an event, returned in `passThrough`, or held in `pending` for the
 * next chunk. Nothing is dropped: a split escape sequence survives as `pending`, and anything that
 * turns out not to be a wheel report is passed through unchanged.
 *
 * @param {string} data
 * @returns {{ events: Array<{ button: "wheel_up" | "wheel_down" | "left", column: number, row: number }>, passThrough: string, pending: string }}
 */
export function parseWheelInput(data) {
  const events = [];
  let passThrough = "";
  let rest = data;
  while (rest !== "") {
    if (couldCompleteMouseReport(rest)) return { events, passThrough, pending: rest };
    const sgr = SGR_MOUSE.exec(rest);
    if (sgr !== null) {
      const raw = Number.parseInt(sgr[1], 10);
      const button = (raw & DRAG_FLAG) === 0 ? mouseButton(raw) : undefined;
      const release = sgr[4] === "m";
      // Swallow the release that matches a click we reported, so pi-tui never sees half a click.
      if (button === "left" && release) { rest = rest.slice(sgr[0].length); continue; }
      if (button === undefined || (release && button !== "left")) passThrough += sgr[0];
      else events.push({ button, column: Number.parseInt(sgr[2], 10) - 1, row: Number.parseInt(sgr[3], 10) - 1 });
      rest = rest.slice(sgr[0].length);
      continue;
    }
    if (rest.startsWith(X10_MOUSE_PREFIX) && rest.length >= X10_MOUSE_LENGTH) {
      const report = rest.slice(0, X10_MOUSE_LENGTH);
      const button = mouseButton(report.charCodeAt(3) - 32);
      if (button === undefined) passThrough += report;
      else events.push({ button, column: report.charCodeAt(4) - 32 - 1, row: report.charCodeAt(5) - 32 - 1 });
      rest = rest.slice(X10_MOUSE_LENGTH);
      continue;
    }
    passThrough += rest[0];
    rest = rest.slice(1);
  }
  return { events, passThrough, pending: "" };
}

/**
 * Wrap a pi-tui `Terminal` so wheel notches and plain left clicks reach `onWheel`, and every other
 * byte reaches the TUI unchanged.
 *
 * The returned terminal also exposes `onWheel(listener)` so a host mounted after construction can
 * subscribe; the constructor argument is optional for that reason.
 *
 * @param {any} terminal
 * @param {(event: { button: "wheel_up" | "wheel_down" | "left", column: number, row: number }) => void} [onWheel]
 */
export function createWheelInputTap(terminal, onWheel) {
  let pending = "";
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let flushTimer;
  const cancelFlush = () => { if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined; } };
  /** @type {Array<(event: any) => void>} */
  const listeners = onWheel === undefined ? [] : [onWheel];
  const emit = (/** @type {any} */ event) => { for (const listener of listeners) listener(event); };
  return new Proxy(terminal, {
    get(target, property, receiver) {
      if (property === "onWheel") {
        return (/** @type {(event: any) => void} */ listener) => {
          listeners.push(listener);
          return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
        };
      }
      if (property === "start") {
        return (onInput, onResize) => target.start((data) => {
          cancelFlush();
          const result = parseWheelInput(pending + data);
          pending = result.pending;
          for (const event of result.events) emit(event);
          if (result.passThrough !== "") onInput(result.passThrough);
          if (pending === "") return;
          // Without this the tap holds a lone Escape until the next keystroke, which then reaches
          // pi-tui glued to it and is read as a meta chord. Escape is the viewer's way back to the
          // list, so a held one costs the operator two keys and every millisecond in between.
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            const held = pending;
            pending = "";
            if (held !== "") onInput(held);
          }, pending === "\x1b" ? ESCAPE_FLUSH_MS : SEQUENCE_FLUSH_MS);
          flushTimer.unref?.();
        }, onResize);
      }
      if (property === "stop") {
        return (/** @type {unknown[]} */ ...args) => { cancelFlush(); pending = ""; return target.stop(...args); };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
