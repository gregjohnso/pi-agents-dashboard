import { expect, it, vi } from "vitest";

import { ReturnGesture } from "./return-gesture.mjs";

it("requires the same dirty/history key twice within exactly 500 ms", () => {
  let now = 0;
  const onReturn = vi.fn();
  const gesture = new ReturnGesture({ now: () => now, onReturn });
  expect(gesture.handle("escape", { clean: false, overlayCaptured: false })).toBe("armed");
  now = 500;
  expect(gesture.handle("escape", { clean: false, overlayCaptured: false })).toBe("returned");
  expect(onReturn).toHaveBeenCalledOnce();
});

it("cancels on a different key, overlay capture, or timeout", () => {
  let now = 0;
  const onReturn = vi.fn();
  const gesture = new ReturnGesture({ now: () => now, onReturn });
  gesture.handle("left", { clean: false, overlayCaptured: false });
  gesture.cancelForInput("escape");
  expect(gesture.handle("left", { clean: false, overlayCaptured: false })).toBe("armed");
  expect(gesture.handle("left", { clean: false, overlayCaptured: true })).toBe("captured");
  gesture.handle("left", { clean: false, overlayCaptured: false });
  now = 501;
  expect(gesture.handle("left", { clean: false, overlayCaptured: false })).toBe("armed");
  expect(onReturn).not.toHaveBeenCalled();
});
