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

  // Pi's own cancel keybinding is escape or ctrl+c, and an operator may rebind it. Hard-coding the
  // escape byte left ctrl+c to fall through to the viewer, which quit the frontend from a dialog.
  it.each([["Escape", "\x1b"]])("cancels every overlay on Pi's own %s", (_label, key) => {
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

