import { stripVTControlCharacters } from "node:util";

/**
 * A pi-tui `Terminal` that keeps the alternate screen it was painted, so a test reads the rows the
 * operator sees rather than a component's own idea of them.
 *
 * `TuiAltScreen` paints differentially: a frame writes `ESC[<row>;1H ESC[2K <line>` for the rows
 * that changed and nothing at all for the rows that did not. Replaying those writes into a row
 * buffer is what makes an unchanged editor or footer row provable across a scroll.
 */
const ROW_WRITE = /\x1b\[(\d+);1H\x1b\[2K/gu;
const TRAILER = /\x1b\[\?(?:25[lh]|2026l)[\s\S]*$/u;

export class ScreenTerminal {
  /** @param {{ columns?: number, rows?: number }} [size] */
  constructor({ columns = 80, rows = 24 } = {}) {
    this.columns = columns;
    this.rows = rows;
    this.kittyProtocolActive = false;
    /** @type {string[]} */
    this.lines = Array.from({ length: rows }, () => "");
    /** @type {((data: string) => void) | undefined} */
    this.input = undefined;
    /** @type {(() => void) | undefined} */
    this.resized = undefined;
  }
  start(/** @type {(data: string) => void} */ onInput, /** @type {() => void} */ onResize) { this.input = onInput; this.resized = onResize; }
  stop() { this.input = undefined; }
  async drainInput() {}
  write(/** @type {string} */ data) { this.apply(data); }
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  moveBy() {}
  setTitle() {}
  setProgress() {}

  /** Replay one frame's writes into the row buffer. */
  apply(data) {
    const cleared = data.lastIndexOf("\x1b[2J");
    const frame = cleared < 0 ? data : data.slice(cleared);
    if (cleared >= 0) this.lines = Array.from({ length: this.rows }, () => "");
    const writes = [...frame.matchAll(ROW_WRITE)];
    for (const [index, match] of writes.entries()) {
      const start = (match.index ?? 0) + match[0].length;
      const end = index + 1 < writes.length ? writes[index + 1].index : frame.length;
      this.lines[Number.parseInt(match[1], 10) - 1] = frame.slice(start, end).replace(TRAILER, "");
    }
  }

  /** The painted screen with its colors removed, one string per terminal row. */
  screen() { return this.lines.map((line) => stripVTControlCharacters(line)); }

  /** The painted screen as one string, for `toContain` assertions. */
  text() { return this.screen().join("\n"); }

  /** Send bytes the way the operator's terminal does. */
  type(/** @type {string} */ data) { this.input?.(data); }

  /** Resize the way a real terminal does: new dimensions, then the resize callback. */
  resize(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.lines = Array.from({ length: rows }, () => "");
    this.resized?.();
  }
}

/** One SGR mouse report, the encoding pi-tui parses. */
export function mouseReport({ button, column, row, release = false }) {
  return `\x1b[<${button};${column + 1};${row + 1}${release ? "m" : "M"}`;
}
