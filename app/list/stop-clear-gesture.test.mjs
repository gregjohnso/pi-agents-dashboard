import { expect, it, vi } from "vitest";

import { StopClearGesture } from "./stop-clear-gesture.mjs";

it("arms only once a stop has landed for that session", () => {
    const gesture = new StopClearGesture({ now: () => 0 });
    expect(gesture.pressWouldClear("a")).toBe(false);
    gesture.armAfterStop("a");
    expect(gesture.pressWouldClear("a")).toBe(true);
});

it("clears on the second press at exactly the window edge and not after", () => {
    let now = 0;
    const gesture = new StopClearGesture({ now: () => now });
    gesture.armAfterStop("a");
    now = 500;
    expect(gesture.pressWouldClear("a")).toBe(true);

    gesture.armAfterStop("a");
    now = 1001;
    expect(gesture.pressWouldClear("a")).toBe(false);
});

it("disarms for a different session and on an explicit cancel", () => {
    const gesture = new StopClearGesture({ now: () => 0 });
    gesture.armAfterStop("a");
    expect(gesture.pressWouldClear("b")).toBe(false);
    gesture.armAfterStop("a");
    gesture.cancel();
    expect(gesture.pressWouldClear("a")).toBe(false);
});
