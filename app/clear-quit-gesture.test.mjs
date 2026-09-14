import { expect, it } from "vitest";

import { ClearQuitGesture } from "./clear-quit-gesture.mjs";

it("clears on the first press even when the clock reads zero", () => {
  expect(new ClearQuitGesture({ now: () => 0 }).press()).toBe("clear");
});

it("quits only on a second press strictly inside the window", () => {
  let now = 1_000;
  const gesture = new ClearQuitGesture({ now: () => now });
  expect(gesture.press()).toBe("clear");
  now += 499;
  expect(gesture.press()).toBe("quit");
  // The quit consumed the arm, so the press after it clears again.
  expect(gesture.press()).toBe("clear");
  now += 500;
  expect(gesture.press()).toBe("clear");
  now += 501;
  expect(gesture.press()).toBe("clear");
  now += 1;
  expect(gesture.press()).toBe("quit");
});

it("forgets an armed quit when the frontend it belongs to is reopened", () => {
  const gesture = new ClearQuitGesture({ now: () => 0 });
  expect(gesture.press()).toBe("clear");
  gesture.cancel();
  expect(gesture.press()).toBe("clear");
});
