import { expect, it } from "vitest";

import { displaySessionState } from "./session-state.mjs";

const at = "2026-08-25T12:00:00.000Z";

/** @param {string} taskState @param {string} processState */
function session(taskState, processState) {
  return { taskState, processState, activity: { kind: "assistant_final", summary: "done", updatedAt: at } };
}

it.each([
  ["a working agent", "WORKING", "LIVE", "WORKING"],
  ["an agent awaiting input", "WAITING", "LIVE", "WAITING"],
  ["a live idle agent", "READY", "LIVE", "READY"],
  ["a sleeping agent", "READY", "SLEEPING", "SLEEPING"],
  ["a finished session", "READY", "EXITED", "EXITED"],
  ["a stopped session", "STOPPED", "EXITED", "STOPPED"],
  ["a failed session", "FAILED", "EXITED", "FAILED"],
  ["a session whose process vanished mid-turn", "WORKING", "EXITED", "EXITED"],
  ["an unverifiable process", "READY", "STALE", "STALE"],
])("reports %s as %s", (_label, taskState, processState, expected) => {
  expect(displaySessionState(/** @type {any} */ (session(taskState, processState)))).toBe(expected);
});

it("keeps a launching session distinct from a finished one", () => {
  const launching = { taskState: "READY", processState: "EXITED", activity: { kind: "launching", summary: "start", updatedAt: at } };
  expect(displaySessionState(/** @type {any} */ (launching))).toBe("STARTING");
});
