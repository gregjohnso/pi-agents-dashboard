import { describe, expect, it } from "vitest";

import { reduceSessionState } from "./state-reducer.mjs";

/** @typedef {import("../shared/contracts.mjs").SessionRecord} SessionRecord */

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
  ["WORKER_EXITED", { taskState: "READY", processState: "EXITED", outcome: "COMPLETED" }],
  ["USER_STOPPED", { taskState: "STOPPED", processState: "EXITED", outcome: "NONE" }],
  ["PI_CHILD_CRASHED", { taskState: "FAILED", processState: "EXITED", outcome: "NONE" }],
]);

describe("reduceSessionState", () => {
  it.each(transitions)("maps %s without collapsing state dimensions", (type, expected) => {
    expect(reduceSessionState(baseRecord, { type, at: now, summary: type })).toMatchObject(expected);
  });

  it.each(outcomePreservingProcessEvents)(
    "preserves an absent outcome when %s has no explicit completion",
    (type) => {
      /** @type {SessionRecord} */
      const readyWithoutOutcome = { ...baseRecord, outcome: "NONE" };

      expect(reduceSessionState(readyWithoutOutcome, { type, at: now }).outcome).toBe("NONE");
    },
  );

  // Operator-visible failure: a later liveness sweep must not turn a specific Pi crash back into a
  // ready row after the process-error details were already persisted.
  it("keeps a Pi child crash terminal when WORKER_EXITED is observed later", () => {
    const crashed = reduceSessionState(baseRecord, { type: "PI_CHILD_CRASHED", at: now, summary: "Pi exited unexpectedly (SIGSEGV)" });

    expect(reduceSessionState(crashed, { type: "WORKER_EXITED", at: "2026-08-25T12:01:00.000Z" })).toEqual(crashed);
  });

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
});
