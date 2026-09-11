import { DynamicBorder, ExtensionEditorComponent, getMarkdownTheme, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { createPiKeybindings } from "./pi-component-adapters.mjs";
import { spinnerFrame } from "../spinner.mjs";

initTheme(undefined, false);

const PI_WORKING_MESSAGE = "Working...";

function fit(line, width) {
  const safe = line.replace(/[\r\n\u2028\u2029]/gu, " ");
  return visibleWidth(safe) <= width ? safe : truncateToWidth(safe, Math.max(0, width), "");
}

/** Focused confirm/select/input/editor request backed by public Pi TUI primitives. */
export class PendingUiOverlay {
  constructor({ request, tui, respond, returnFocus = undefined }) {
    this.request = request;
    tui.terminal ??= { rows: 24, columns: 80 };
    this.tui = tui;
    this.respond = respond;
    this.returnFocus = tui.getFocusedComponent?.() ?? returnFocus;
    this.resolved = false;
    this.border = new DynamicBorder((text) => text);
    if (request.method === "select") {
      this.control = new SelectList((request.options ?? []).map((option) => ({ value: option, label: option })), 8, getSelectListTheme());
      this.control.onSelect = (item) => this.resolve({ requestId: request.id, value: item.value });
    } else if (request.method === "editor") {
      this.control = new ExtensionEditorComponent(
        tui,
        /** @type {any} */ (createPiKeybindings()),
        request.title,
        request.initialValue,
        (value) => this.resolve({ requestId: request.id, value }),
        () => this.resolve({ requestId: request.id, cancelled: true }),
      );
      tui.setFocus(this.control);
    } else if (request.method === "input") {
      this.control = new Input();
      this.control.setValue(request.initialValue ?? "");
      this.control.onSubmit = (value) => this.resolve({ requestId: request.id, value });
      this.control.onEscape = () => this.resolve({ requestId: request.id, cancelled: true });
      tui.setFocus(this.control);
    } else {
      this.control = new Markdown("y/Enter confirm · n/Escape cancel", 1, 0, getMarkdownTheme());
    }
  }
  restoreFocus() {
    if (this.focusRestored) return;
    this.focusRestored = true;
    this.tui.setFocus(this.returnFocus ?? null);
  }
  resolve(response) {
    if (this.resolved) return;
    this.resolved = true;
    this.restoreFocus();
    this.respond(response);
  }
  dispose() { this.restoreFocus(); /** @type {any} */ (this.control).dispose?.(); }
  handleInput(data) {
    if (this.resolved) return true;
    if (data === "\x1b") { this.resolve({ requestId: this.request.id, cancelled: true }); return true; }
    if (this.request.method === "confirm") {
      if (data === "\r" || data.toLowerCase() === "y") this.resolve({ requestId: this.request.id, value: true });
      else if (data.toLowerCase() === "n") this.resolve({ requestId: this.request.id, value: false });
      return true;
    }
    /** @type {any} */ (this.control).handleInput?.(data);
    return true;
  }
  render(width) {
    const lines = this.request.method === "editor"
      ? this.control.render(width)
      : [...this.border.render(width), fit(` ${this.request.title}`, width), ...this.control.render(width), ...this.border.render(width)];
    return lines.map((line) => fit(line, width));
  }
}

/** Bounded Pi SelectList picker for built-in commands that take one exact argument. */
export class CommandSelectionOverlay {
  /** `selected` starts the list on the value already in force, so a picker opens on today's setting. */
  constructor({ title, items, tui, respond, returnFocus = undefined, maxVisible = 8, selected = undefined }) {
    tui.terminal ??= { rows: 24, columns: 80 };
    this.title = title;
    this.tui = tui;
    this.respond = respond;
    this.returnFocus = tui.getFocusedComponent?.() ?? returnFocus;
    this.resolved = false;
    this.border = new DynamicBorder((text) => text);
    this.control = new SelectList(items, maxVisible, getSelectListTheme());
    const index = items.findIndex((/** @type {{value:string}} */ item) => item.value === selected);
    if (index > 0) this.control.setSelectedIndex(index);
    this.control.onSelect = (/** @type {{value:string}} */ item) => this.resolve(item.value);
  }
  restoreFocus() {
    if (this.focusRestored) return;
    this.focusRestored = true;
    this.tui.setFocus(this.returnFocus ?? null);
  }
  /** @param {string | undefined} value */
  resolve(value) {
    if (this.resolved) return;
    this.resolved = true;
    this.restoreFocus();
    this.respond(value);
  }
  dispose() { this.restoreFocus(); /** @type {any} */ (this.control).dispose?.(); }
  /** @param {string} data */
  handleInput(data) {
    if (this.resolved) return true;
    if (data === "\x1b") { this.resolve(undefined); return true; }
    /** @type {any} */ (this.control).handleInput?.(data);
    return true;
  }
  /** @param {number} width */
  render(width) {
    return [...this.border.render(width), fit(` ${this.title}`, width), ...this.control.render(width), ...this.border.render(width)].map((line) => fit(line, width));
  }
}

/** Bounded scrollable text panel for read-only Pi results and viewer help. */
export class TextPanelOverlay {
  /** @param {{ title: string, rows: string[], tui: any, respond: () => void, returnFocus?: any, maxVisible?: number }} options */
  constructor({ title, rows, tui, respond, returnFocus = undefined, maxVisible = 12 }) {
    tui.terminal ??= { rows: 24, columns: 80 };
    this.title = title;
    this.rows = rows.length === 0 ? ["(nothing reported)"] : rows;
    this.tui = tui;
    this.respond = respond;
    this.returnFocus = tui.getFocusedComponent?.() ?? returnFocus;
    this.maxVisible = Math.max(1, maxVisible);
    this.offset = 0;
    this.resolved = false;
    this.border = new DynamicBorder((text) => text);
  }
  restoreFocus() {
    if (this.focusRestored) return;
    this.focusRestored = true;
    this.tui.setFocus(this.returnFocus ?? null);
  }
  resolve() {
    if (this.resolved) return;
    this.resolved = true;
    this.restoreFocus();
    this.respond();
  }
  dispose() { this.restoreFocus(); }
  /** @param {string} data */
  handleInput(data) {
    if (this.resolved) return true;
    if (data === "\x1b" || data === "\r" || data === "q") { this.resolve(); return true; }
    const maxOffset = Math.max(0, this.rows.length - this.maxVisible);
    if (data === "\x1b[A") this.offset = Math.max(0, this.offset - 1);
    else if (data === "\x1b[B") this.offset = Math.min(maxOffset, this.offset + 1);
    else if (data === "\x1b[5~") this.offset = Math.max(0, this.offset - this.maxVisible);
    else if (data === "\x1b[6~") this.offset = Math.min(maxOffset, this.offset + this.maxVisible);
    return true;
  }
  /** @param {number} width */
  render(width) {
    const visible = this.rows.slice(this.offset, this.offset + this.maxVisible);
    const more = this.rows.length > this.offset + visible.length ? [` … ${this.rows.length - this.offset - visible.length} more · ↑↓ scroll · Esc close`] : [" Esc close"];
    return [...this.border.render(width), fit(` ${this.title}`, width), ...visible.map((row) => fit(` ${row}`, width)), ...more.map((row) => fit(row, width)), ...this.border.render(width)]
      .map((line) => fit(line, width));
  }
}

/** Render Pi's status indicator: a blank separator, the spinner frame, the active phase, and the interrupt key. */
export function renderStatusIndicator(activity, width, now = Date.now(), { working = false } = {}) {
  const idle = activity === undefined || activity.phase === "idle";
  if (idle && !working) return [];
  const label = idle ? PI_WORKING_MESSAGE : activity.label;
  const started = idle ? Number.NaN : Date.parse(activity.startedAt);
  const elapsed = Number.isFinite(started) ? ` · ${Math.max(0, Math.floor((now - started) / 1_000))}s` : "";
  const detail = idle || activity.detail === undefined ? "" : ` · ${activity.detail}`;
  const frame = spinnerFrame(now);
  return ["", fit(` ${frame} ${label}${elapsed}${detail}${working ? " (Esc to interrupt)" : ""}`, width)];
}

/** Render one bounded lifecycle/system card with Pi's own error and warning wording. */
export function renderSystemCard(message, width) {
  const prefix = message.level === "error" ? "Error: " : message.level === "warning" ? "Warning: " : "";
  return ["", fit(` ${prefix}${message.text}`, width)];
}
