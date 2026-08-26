import { DynamicBorder, ExtensionEditorComponent, getMarkdownTheme, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { createPiKeybindings } from "./pi-component-adapters.mjs";

initTheme(undefined, false);

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
  constructor({ title, items, tui, respond, returnFocus = undefined, maxVisible = 8 }) {
    tui.terminal ??= { rows: 24, columns: 80 };
    this.title = title;
    this.tui = tui;
    this.respond = respond;
    this.returnFocus = tui.getFocusedComponent?.() ?? returnFocus;
    this.resolved = false;
    this.border = new DynamicBorder((text) => text);
    this.control = new SelectList(items, maxVisible, getSelectListTheme());
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

/** Render the currently active normalized phase with elapsed time. */
export function renderActivityLine(activity, width, now = Date.now()) {
  if (activity === undefined || activity.phase === "idle") return [];
  const started = Date.parse(activity.startedAt);
  const elapsed = Number.isFinite(started) ? ` · ${Math.max(0, Math.floor((now - started) / 1_000))}s` : "";
  return [fit(`● ${activity.label}${elapsed}${activity.detail ? ` · ${activity.detail}` : ""}`, width)];
}

/** Render one bounded lifecycle/system card without mixing it into assistant prose. */
export function renderSystemCard(message, width) {
  return [fit(`${message.level === "error" ? "ERROR" : message.level === "warning" ? "NOTICE" : "INFO"}: ${message.text}`, width)];
}
