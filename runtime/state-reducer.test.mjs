import { describe, expect, it } from "vitest";

import { reduceSessionState } from "./state-reducer.mjs";

/** @typedef {import("../shared/contracts.js").SessionRecord} SessionRecord */

const now = "2026-08-25T12:00:00.000Z";
/** @type {SessionRecord} */
const baseRecord = {
  schemaVersion: 1,
  revision: 4,
  sessionId: "session-1",
  sessionFile: "/sessions/session-1.jsonl",
  canonicalSessionFile: "/sessions/session-1.jsonl",
  cwd: "/repo",
  taskState: "READY",
  processState: "LIVE",
  outcome: "COMPLETED",
  activity: { kind: "assistant", summary: "Previous answer", updatedAt: "2026-08-25T11:00:00.000Z" },
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T11:00:00.000Z",
};

const outcomePreservingProcessEvents = /** @type {const} */ (["WORKER_SLEEPING", "WORKER_EXITED"]);
const transitions = /** @type {const} */ ([
  ["WORKER_READY", { taskState: "READY", processState: "LIVE", outcome: "NONE" }],
  ["TURN_STARTED", { taskState: "WORKING", processState: "LIVE", outcome: "NONE" }],
  ["TURN_COMPLETED", { taskState: "READY", processState: "LIVE", outcome: "COMPLETED" }],
  ["TURN_READY_FOR_REVIEW", { taskState: "READY", processState: "LIVE", outcome: "READY_FOR_REVIEW" }],
  ["WORKER_SLEEPING", { taskState: "READY", processState: "SLEEPING", outcome: "COMPLETED" }],
  ["WORKER_EXITED", { taskState: "READY", processState: "EXITED", outcome: "COMPLETED" }],
  ["USER_STOPPED", { taskState: "STOPPED", processState: "EXITED", outcome: "NONE" }],
  ["PI_CHILD_CRASHED", { taskState: "FAILED", processState: "EXITED", outcome: "NONE" }],
  ["WORKER_CRASHED", { taskState: "READY", processState: "STALE", outcome: "COMPLETED" }],
  ["IDENTITY_STALE", { taskState: "READY", processState: "STALE", outcome: "COMPLETED" }],
  ["UI_REQUESTED", { taskState: "WAITING", processState: "LIVE", outcome: "COMPLETED" }],
  ["UI_RESPONDED", { taskState: "WORKING", processState: "LIVE", outcome: "COMPLETED" }],
]);

describe("reduceSessionState", () => {
  it.each(transitions)("maps %s without collapsing state dimensions", (type, expected) => {
    expect(reduceSessionState(baseRecord, { type, at: now, summary: type })).toMatchObject(expected);
  });

  it("keeps READY independent from LIVE, SLEEPING, and EXITED process states", () => {
    const ready = reduceSessionState(baseRecord, { type: "TURN_COMPLETED", at: now });
    const sleeping = reduceSessionState(ready, { type: "WORKER_SLEEPING", at: now });
    const exited = reduceSessionState(sleeping, { type: "WORKER_EXITED", at: now });

    expect([ready, sleeping, exited].map(({ taskState, processState, outcome }) => ({
      taskState,
      processState,
      outcome,
    }))).toEqual([
      { taskState: "READY", processState: "LIVE", outcome: "COMPLETED" },
      { taskState: "READY", processState: "SLEEPING", outcome: "COMPLETED" },
      { taskState: "READY", processState: "EXITED", outcome: "COMPLETED" },
    ]);
  });

  it.each(outcomePreservingProcessEvents)(
    "preserves an absent outcome when %s has no explicit completion",
    (type) => {
      /** @type {SessionRecord} */
      const readyWithoutOutcome = { ...baseRecord, outcome: "NONE" };

      expect(reduceSessionState(readyWithoutOutcome, { type, at: now }).outcome).toBe("NONE");
    },
  );

  it("uses blocking, tool, stream, final, then process-error activity precedence", () => {
    const result = reduceSessionState(baseRecord, {
      type: "ACTIVITY_SNAPSHOT",
      at: now,
      blockingRequest: { summary: "Approve tool" },
      tool: { summary: "bash: pytest" },
      assistantStream: { summary: "Running tests" },
      finalAssistant: { summary: "Tests passed" },
      processError: { summary: "old stderr" },
    });

    expect(result.activity).toEqual({ kind: "blocking_request", summary: "Approve tool", updatedAt: now });
    expect(reduceSessionState(baseRecord, {
      type: "ACTIVITY_SNAPSHOT",
      at: now,
      tool: { summary: "bash: pytest" },
      assistantStream: { summary: "Running tests" },
      finalAssistant: { summary: "Tests passed" },
      processError: { summary: "old stderr" },
    }).activity.kind).toBe("tool");
    expect(reduceSessionState(baseRecord, {
      type: "ACTIVITY_SNAPSHOT",
      at: now,
      assistantStream: { summary: "Running tests" },
      finalAssistant: { summary: "Tests passed" },
      processError: { summary: "old stderr" },
    }).activity.kind).toBe("assistant_stream");
    expect(reduceSessionState(baseRecord, {
      type: "ACTIVITY_SNAPSHOT",
      at: now,
      finalAssistant: { summary: "Tests passed" },
      processError: { summary: "old stderr" },
    }).activity.kind).toBe("assistant_final");
    expect(reduceSessionState(baseRecord, {
      type: "ACTIVITY_SNAPSHOT",
      at: now,
      processError: { summary: "old stderr" },
    }).activity.kind).toBe("process_error");
  });

  it("treats frontend detachment as an exact no-op", () => {
    expect(reduceSessionState(baseRecord, { type: "FRONTEND_DETACHED", at: now })).toBe(baseRecord);
  });

  it("returns the original record when an activity snapshot has no signal", () => {
    expect(reduceSessionState(baseRecord, { type: "ACTIVITY_SNAPSHOT", at: now })).toBe(baseRecord);
  });

  it("advances revision and timestamps only for effective transitions", () => {
    const result = reduceSessionState(baseRecord, { type: "TURN_STARTED", at: now });

    expect(result).toMatchObject({ revision: 5, updatedAt: now });
    expect(baseRecord).toMatchObject({ revision: 4, updatedAt: "2026-08-25T11:00:00.000Z" });
  });
});
