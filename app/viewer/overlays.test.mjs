import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { PendingUiOverlay, renderActivityLine, renderSystemCard } from "./overlays.mjs";

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

  it("captures Escape as cancellation before viewer navigation", () => {
    const respond = vi.fn();
    const overlay = new PendingUiOverlay({ request: { id: "i", method: "input", title: "Name" }, tui, respond });
    expect(overlay.handleInput("\x1b")).toBe(true);
    expect(respond).toHaveBeenCalledWith({ requestId: "i", cancelled: true });
  });
});

it("renders bounded lifecycle, activity, reconnect, retry, and error cards", () => {
  for (const lines of [renderActivityLine({ phase: "retrying", label: "Retrying in 4s", detail: "provider busy", startedAt: "2026-08-25T00:00:00Z" }, 40, Date.parse("2026-08-25T00:00:04Z")), renderSystemCard({ text: "Connection lost; reconnecting", level: "error" }, 40)]) {
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  }
});
