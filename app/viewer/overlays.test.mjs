import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { CommandSelectionOverlay, PendingUiOverlay, renderStatusIndicator, renderSystemCard } from "./overlays.mjs";

const tui = { requestRender: vi.fn(), setFocus: vi.fn(), mode: "fullscreen" };

describe("pending Pi UI overlays", () => {
  it.each([
    [{ id: "c", method: "confirm", title: "Continue?" }, "y", true],
    [{ id: "s", method: "select", title: "Choose", options: ["one", "two"] }, "\r", "one"],
    [{ id: "i", method: "input", title: "Name", initialValue: "abc" }, "\r", "abc"],
    [{ id: "e", method: "editor", title: "Edit", initialValue: "body" }, "\r", "body"],
  ])("captures one %s response", (request, input, expected) => {
    const respond = vi.fn();
    const overlay = new PendingUiOverlay({ request, tui, respond });
    overlay.handleInput(input);
    overlay.handleInput(input);
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({ requestId: request.id, value: expected });
    expect(overlay.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("uses a multiline public editor and restores the prior IME focus after submit", () => {
    const focused = [];
    const returnFocus = { focused: true };
    let currentFocus = returnFocus;
    const focusedTui = { ...tui, setFocus(component) { currentFocus.focused = false; focused.push(component); currentFocus = component; if (currentFocus !== null) currentFocus.focused = true; } };
    const respond = vi.fn();
    const overlay = new PendingUiOverlay({ request: { id: "e", method: "editor", title: "Edit", initialValue: "first\nsecond" }, tui: focusedTui, returnFocus, respond });
    expect(overlay.control.constructor.name).toBe("ExtensionEditorComponent");
    expect(overlay.render(80).join("\n")).toContain("first");
    expect(overlay.render(80).join("\n")).toContain("second");
    expect(focused[0]).toBe(overlay.control);
    expect(overlay.control.focused).toBe(true);
    expect(returnFocus.focused).toBe(false);
    overlay.handleInput("\r");
    expect(respond).toHaveBeenCalledWith({ requestId: "e", value: "first\nsecond" });
    expect(focused.at(-1)).toBe(returnFocus);
    expect(returnFocus.focused).toBe(true);
    expect(overlay.control.focused).toBe(false);
  });

  it("returns focus to the component that owned it before the overlay opened", () => {
    const host = { focused: true };
    const editor = { focused: false };
    const focused = [];
    let currentFocus = host;
    const focusedTui = {
      ...tui,
      getFocusedComponent: () => currentFocus,
      setFocus(component) { if (currentFocus !== null) currentFocus.focused = false; focused.push(component); currentFocus = component; if (currentFocus !== null) currentFocus.focused = true; },
    };
    const overlay = new CommandSelectionOverlay({ title: "Select a model", items: [{ value: "a/one", label: "a/one" }], tui: focusedTui, returnFocus: editor, respond: vi.fn() });
    overlay.handleInput("\x1b");
    expect(focused.at(-1)).toBe(host);
    expect(host.focused).toBe(true);
    expect(editor.focused).toBe(false);
  });

  it("transfers and restores input focus when Escape cancels before viewer navigation", () => {
    const focused = [];
    const returnFocus = { focused: true };
    let currentFocus = returnFocus;
    const focusedTui = { ...tui, setFocus(component) { currentFocus.focused = false; focused.push(component); currentFocus = component; if (currentFocus !== null) currentFocus.focused = true; } };
    const respond = vi.fn();
    const overlay = new PendingUiOverlay({ request: { id: "i", method: "input", title: "Name" }, tui: focusedTui, returnFocus, respond });
    expect(focused[0]).toBe(overlay.control);
    expect(overlay.control.focused).toBe(true);
    expect(returnFocus.focused).toBe(false);
    expect(overlay.handleInput("\x1b")).toBe(true);
    expect(respond).toHaveBeenCalledWith({ requestId: "i", cancelled: true });
    expect(focused.at(-1)).toBe(returnFocus);
    expect(returnFocus.focused).toBe(true);
    expect(overlay.control.focused).toBe(false);
  });
});

it("renders bounded lifecycle, activity, reconnect, retry, and error cards", () => {
  for (const lines of [renderStatusIndicator({ phase: "retrying", label: "Retrying in 4s", detail: "provider busy", startedAt: "2026-08-25T00:00:00Z" }, 40, Date.parse("2026-08-25T00:00:04Z")), renderSystemCard({ text: "Connection lost; reconnecting", level: "error" }, 40)]) {
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  }
});

describe("Pi status indicator and system cards", () => {
  const started = "2026-08-25T00:00:00Z";
  const now = Date.parse("2026-08-25T00:00:04Z");

  it("spins Pi's working indicator above the dock and offers the interrupt key", () => {
    const lines = renderStatusIndicator({ phase: "tool_running", label: "Running bash", detail: "pytest", startedAt: started }, 80, now, { working: true });
    expect(lines[0]).toBe("");
    expect(lines[1]).toMatch(/^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Running bash · 4s · pytest \(Esc to interrupt\)$/u);
    expect(renderStatusIndicator({ phase: "tool_running", label: "Running bash", detail: "pytest", startedAt: started }, 40, now, { working: true }).every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("falls back to Pi's Working message and hides the interrupt key when the turn is settled", () => {
    expect(renderStatusIndicator({ phase: "idle", label: "Idle", startedAt: started }, 40, now, { working: true })[1]).toContain("Working...");
    expect(renderStatusIndicator({ phase: "idle", label: "Idle", startedAt: started }, 40, now)).toEqual([]);
    expect(renderStatusIndicator({ phase: "waiting", label: "Waiting", startedAt: started }, 40, now)[1]).not.toContain("interrupt");
  });

  it("words system cards the way Pi does", () => {
    expect(renderSystemCard({ text: "boom", level: "error" }, 40)).toEqual(["", " Error: boom"]);
    expect(renderSystemCard({ text: "careful", level: "warning" }, 40)).toEqual(["", " Warning: careful"]);
    expect(renderSystemCard({ text: "note", level: "info" }, 40)).toEqual(["", " note"]);
  });
});
