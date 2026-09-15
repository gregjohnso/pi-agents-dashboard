import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { CommandSelectionOverlay, PendingUiOverlay, TextPanelOverlay, renderStatusIndicator } from "./overlays.mjs";

const tui = { requestRender: vi.fn(), setFocus: vi.fn(), mode: "fullscreen" };

/** A tui that records every focus transfer, so an overlay's focus hand-off can be read back in order. */
function focusFixture() {
  /** @type {any[]} */
  const focused = [];
  const returnFocus = { focused: true };
  let currentFocus = returnFocus;
  return { focused, returnFocus, tui: { ...tui, setFocus(/** @type {any} */ component) { currentFocus.focused = false; focused.push(component); currentFocus = component; if (currentFocus !== null) currentFocus.focused = true; } } };
}

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

  it("uses a multiline public editor and restores the prior IME focus after submit and after Escape", () => {
    const submit = focusFixture();
    const respond = vi.fn();
    const overlay = new PendingUiOverlay({ request: { id: "e", method: "editor", title: "Edit", initialValue: "first\nsecond" }, tui: submit.tui, returnFocus: submit.returnFocus, respond });
    expect(overlay.control.constructor.name).toBe("ExtensionEditorComponent");
    expect(overlay.render(80).join("\n")).toContain("first");
    expect(overlay.render(80).join("\n")).toContain("second");
    expect(submit.focused[0]).toBe(overlay.control);
    expect(overlay.control.focused).toBe(true);
    expect(submit.returnFocus.focused).toBe(false);
    overlay.handleInput("\r");
    expect(respond).toHaveBeenCalledWith({ requestId: "e", value: "first\nsecond" });
    expect(submit.focused.at(-1)).toBe(submit.returnFocus);
    expect(submit.returnFocus.focused).toBe(true);
    expect(overlay.control.focused).toBe(false);

    const cancel = focusFixture();
    const cancelRespond = vi.fn();
    const prompt = new PendingUiOverlay({ request: { id: "i", method: "input", title: "Name" }, tui: cancel.tui, returnFocus: cancel.returnFocus, respond: cancelRespond });
    expect(cancel.focused[0]).toBe(prompt.control);
    expect(prompt.handleInput("\x1b")).toBe(true);
    expect(cancelRespond).toHaveBeenCalledWith({ requestId: "i", cancelled: true });
    expect(cancel.focused.at(-1)).toBe(cancel.returnFocus);
    expect(cancel.returnFocus.focused).toBe(true);
    expect(prompt.control.focused).toBe(false);
  });

  // Pi's own cancel keybinding is escape or ctrl+c, and an operator may rebind it. Hard-coding the
  // escape byte left ctrl+c to fall through to the viewer, which quit the frontend from a dialog.
  it.each([["Escape", "\x1b"], ["Ctrl+C", "\x03"]])("cancels every overlay on Pi's own %s", (_label, key) => {
    const dialog = vi.fn();
    const pending = new PendingUiOverlay({ request: { id: "s", method: "select", title: "Choose", options: ["one", "two"] }, tui, respond: dialog });
    expect(pending.handleInput(key)).toBe(true);
    expect(dialog).toHaveBeenCalledWith({ requestId: "s", cancelled: true });

    const chosen = vi.fn();
    const selection = new CommandSelectionOverlay({ title: "Select a model", items: [{ value: "a", label: "A" }], tui, respond: chosen });
    selection.handleInput(key);
    expect(chosen).toHaveBeenCalledWith(undefined);

    const closed = vi.fn();
    const panel = new TextPanelOverlay({ title: "Viewer help", rows: ["a row"], tui, respond: closed });
    panel.handleInput(key);
    expect(closed).toHaveBeenCalledOnce();
  });
});

describe("Pi status indicator and system cards", () => {
  const started = "2026-08-25T00:00:00Z";
  const now = Date.parse("2026-08-25T00:00:04Z");

  it("spins the working indicator with the interrupt key and falls back to Working once the turn settles", () => {
    const running = { phase: "tool_running", label: "Running bash", detail: "pytest", startedAt: started };
    const lines = renderStatusIndicator(running, 80, now, { working: true });
    expect(lines[0]).toBe("");
    expect(lines[1]).toMatch(/^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Running bash · 4s · pytest \(Esc to interrupt\)$/u);
    expect(renderStatusIndicator(running, 40, now, { working: true }).every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(renderStatusIndicator({ phase: "idle", label: "Idle", startedAt: started }, 40, now, { working: true })[1]).toContain("Working...");
    expect(renderStatusIndicator({ phase: "idle", label: "Idle", startedAt: started }, 40, now)).toEqual([]);
    expect(renderStatusIndicator({ phase: "waiting", label: "Waiting", startedAt: started }, 40, now)[1]).not.toContain("interrupt");
  });
});
