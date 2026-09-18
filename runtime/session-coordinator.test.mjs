import { expect, it } from "vitest";

import { SessionCoordinator } from "./session-coordinator.mjs";

it("serializes operations for one session and removes its idle lock", async () => {
  const coordinator = new SessionCoordinator();
  /** @type {string[]} */
  const events = [];
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseFirst;
  /** @type {((value?: unknown) => void) | undefined} */
  let markFirstStarted;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });

  const first = coordinator.run("session-a", async () => {
    events.push("first:start");
    markFirstStarted?.();
    await firstBlocked;
    events.push("first:end");
  });
  const second = coordinator.run("session-a", async () => {
    events.push("second");
  });

  await firstStarted;
  expect(events).toEqual(["first:start"]);
  expect(coordinator.size).toBe(1);
  releaseFirst?.();
  await Promise.all([first, second]);
  expect(events).toEqual(["first:start", "first:end", "second"]);
  expect(coordinator.size).toBe(0);
});

it("continues the key queue after an operation rejects", async () => {
  const coordinator = new SessionCoordinator();

  const failed = coordinator.run("session-a", async () => {
    throw new Error("failed operation");
  });
  const recovered = coordinator.run("session-a", async () => "recovered");

  await expect(failed).rejects.toThrow("failed operation");
  await expect(recovered).resolves.toBe("recovered");
  expect(coordinator.size).toBe(0);
});
