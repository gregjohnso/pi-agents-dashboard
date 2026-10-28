import { expect, it } from "vitest";

import { StopClearGesture } from "./stop-clear-gesture.mjs";

it.each(["stop", "delete"])("requires an armed first tap for %s and consumes the second tap", (action) => {
    const gesture = new StopClearGesture({ now: () => 0 });
    expect(gesture.pressWouldAct("a", action)).toBe(false);
    gesture.arm("a", action);
    expect(gesture.pressWouldAct("a", action)).toBe(true);
    expect(gesture.pressWouldAct("a", action)).toBe(false);
});

it("acts at exactly the window edge and rearms after it", () => {
    let now = 0;
    const gesture = new StopClearGesture({ now: () => now });
    gesture.arm("a", "stop");
    now = 500;
    expect(gesture.pressWouldAct("a", "stop")).toBe(true);
    gesture.arm("a", "stop");
    now = 1001;
    expect(gesture.pressWouldAct("a", "stop")).toBe(false);
});

it("requires the same action and session, and respects explicit cancellation", () => {
    const gesture = new StopClearGesture({ now: () => 0 });
    gesture.arm("a", "stop");
    expect(gesture.pressWouldAct("a", "delete")).toBe(false);
    gesture.arm("a", "stop");
    expect(gesture.pressWouldAct("b", "stop")).toBe(false);
    gesture.arm("a", "stop");
    gesture.cancel();
    expect(gesture.pressWouldAct("a", "stop")).toBe(false);
});

it("keeps a pending stop distinct from an armed first tap", () => {
    const gesture = new StopClearGesture({ now: () => 0 });
    gesture.arm("a", "stop");
    const intent = gesture.beginStop("a");
    expect(gesture.armedSessionId()).toBeUndefined();
    expect(gesture.pendingSessionId()).toBe("a");
    expect(gesture.holds(intent)).toBe(true);
    gesture.cancel();
    expect(gesture.holds(intent)).toBe(false);
});
