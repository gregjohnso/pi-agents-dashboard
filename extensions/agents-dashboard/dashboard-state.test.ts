import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../../shared/contracts.js";
import {
  countDashboardSessions,
  selectDashboardSessions,
  type DashboardQuery,
} from "./dashboard-state.js";

const timestamp = "2026-08-25T12:00:00.000Z";

function session(
  sessionId: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    schemaVersion: 1,
    revision: 1,
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    canonicalSessionFile: `/sessions/${sessionId}.jsonl`,
    cwd: `/projects/${sessionId}`,
    name: `Name ${sessionId}`,
    model: { provider: "provider", id: `model-${sessionId}` },
    taskState: "READY",
    processState: "EXITED",
    outcome: "COMPLETED",
    activity: { kind: "assistant_final", summary: `Activity ${sessionId}`, updatedAt: timestamp },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

const allQuery: DashboardQuery = { view: "all" };

describe("selectDashboardSessions", () => {
  it("defines Live, Done, and All membership from independent dimensions", () => {
    const sessions = [
      session("live", { processState: "LIVE", outcome: "NONE" }),
      session("sleeping-done", { processState: "SLEEPING", outcome: "READY_FOR_REVIEW" }),
      session("exited-done"),
      session("failed", { taskState: "FAILED", processState: "EXITED", outcome: "NONE" }),
      session("stale", { processState: "STALE", outcome: "COMPLETED" }),
    ];

    expect(selectDashboardSessions(sessions, { view: "live" }).map(({ sessionId }) => sessionId)).toEqual(["live"]);
    expect(selectDashboardSessions(sessions, { view: "done" }).map(({ sessionId }) => sessionId)).toEqual([
      "sleeping-done",
      "exited-done",
    ]);
    expect(selectDashboardSessions(sessions, allQuery).map(({ sessionId }) => sessionId)).toEqual([
      "live",
      "sleeping-done",
      "exited-done",
      "failed",
      "stale",
    ]);
  });

  it.each([
    ["display name", { name: "Release Sentinel" }, "release sentinel"],
    ["session path", { sessionFile: "/archive/needle/transcript.jsonl" }, "archive/needle"],
    ["canonical path", { canonicalSessionFile: "/canonical/needle.jsonl" }, "canonical/needle"],
    ["project path", { cwd: "/projects/NeedleProject" }, "needleproject"],
    ["model provider", { model: { provider: "NeedleProvider", id: "model" } }, "needleprovider"],
    ["model ID", { model: { provider: "provider", id: "NeedleModel" } }, "needlemodel"],
    ["task state", { taskState: "WAITING" }, "waiting"],
    ["process state", { processState: "STALE" }, "stale"],
    ["outcome", { outcome: "READY_FOR_REVIEW" }, "ready_for_review"],
    ["activity kind", { activity: { kind: "NeedleTool", summary: "summary", updatedAt: timestamp } }, "needletool"],
    ["activity summary", { activity: { kind: "tool", summary: "Needle Summary", updatedAt: timestamp } }, "needle summary"],
  ] as const)("searches %s case-insensitively", (_field, overrides, search) => {
    const target = session("target", overrides as Partial<SessionRecord>);
    const other = session("other");

    expect(selectDashboardSessions([other, target], { view: "all", search })).toEqual([target]);
  });

  it("combines task-state and exact project-path filters", () => {
    const target = session("target", { taskState: "WAITING", cwd: "/repo/a" });
    const wrongState = session("wrong-state", { taskState: "READY", cwd: "/repo/a" });
    const childPath = session("child", { taskState: "WAITING", cwd: "/repo/a/child" });

    expect(selectDashboardSessions([wrongState, childPath, target], {
      view: "all",
      taskStates: ["WAITING"],
      projectPaths: ["/repo/a/../a"],
    })).toEqual([target]);
  });

  it("sorts by a requested key and preserves input order for ties", () => {
    const older = session("older", { updatedAt: "2026-08-25T10:00:00.000Z", name: "same" });
    const newerFirst = session("newer-first", { updatedAt: "2026-08-25T11:00:00.000Z", name: "same" });
    const newerSecond = session("newer-second", { updatedAt: "2026-08-25T11:00:00.000Z", name: "same" });

    expect(selectDashboardSessions([newerFirst, older, newerSecond], {
      view: "all",
      sort: { key: "age", direction: "desc" },
    }).map(({ sessionId }) => sessionId)).toEqual(["newer-first", "newer-second", "older"]);
  });

  it("groups deterministically before applying stable row sorting", () => {
    const readyB = session("ready-b", { taskState: "READY", cwd: "/repo/b" });
    const failed = session("failed", { taskState: "FAILED", cwd: "/repo/a" });
    const working = session("working", { taskState: "WORKING", cwd: "/repo/c" });
    const readyA = session("ready-a", { taskState: "READY", cwd: "/repo/a" });

    expect(selectDashboardSessions([readyB, failed, working, readyA], {
      view: "all",
      groupBy: "taskState",
      sort: { key: "id", direction: "asc" },
    }).map(({ sessionId }) => sessionId)).toEqual(["working", "ready-a", "ready-b", "failed"]);
    expect(selectDashboardSessions([working, readyB, failed, readyA], {
      view: "all",
      groupBy: "cwd",
      sort: { key: "id", direction: "asc" },
    }).map(({ sessionId }) => sessionId)).toEqual(["failed", "ready-a", "ready-b", "working"]);
  });

  it("injects history policy without reading clocks or configuration", () => {
    const recent = session("recent");
    const old = session("old");
    const considered: string[] = [];

    expect(selectDashboardSessions([old, recent], {
      view: "all",
      historyPolicy(candidate) {
        considered.push(candidate.sessionId);
        return candidate.sessionId !== "old";
      },
    })).toEqual([recent]);
    expect(considered).toEqual(["old", "recent"]);
  });
});

describe("countDashboardSessions", () => {
  it("returns deterministic task and process counts", () => {
    expect(countDashboardSessions([
      session("working", { taskState: "WORKING", processState: "LIVE" }),
      session("waiting", { taskState: "WAITING", processState: "LIVE" }),
      session("ready", { taskState: "READY", processState: "SLEEPING" }),
      session("failed", { taskState: "FAILED", processState: "EXITED" }),
      session("stopped", { taskState: "STOPPED", processState: "EXITED" }),
    ])).toEqual({
      working: 1,
      waiting: 1,
      ready: 1,
      failed: 1,
      stopped: 1,
      sessions: 5,
      processes: 2,
    });
  });
});
