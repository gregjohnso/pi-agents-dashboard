import { describe, expect, it } from "vitest";
import { countDashboardSessions, selectDashboardSessions, } from "./dashboard-state.mjs";
const timestamp = "2026-08-25T12:00:00.000Z";
function session(sessionId, overrides = {}) {
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
const allQuery = { view: "all" };
describe("selectDashboardSessions", () => {
    it("defines Live, Done, and All membership from independent dimensions", () => {
        const sessions = [
            session("live", { processState: "LIVE", outcome: "NONE" }),
            session("launching", { processState: "EXITED", outcome: "NONE", activity: { kind: "launching", summary: "Starting", updatedAt: timestamp } }),
            session("sleeping-done", { processState: "SLEEPING", outcome: "READY_FOR_REVIEW" }),
            session("exited-done"),
            session("failed", { taskState: "FAILED", processState: "EXITED", outcome: "NONE" }),
            session("stale", { processState: "STALE", outcome: "COMPLETED" }),
        ];
        expect(selectDashboardSessions(sessions, { view: "live" }).map(({ sessionId }) => sessionId)).toEqual(["live", "launching"]);
        expect(selectDashboardSessions(sessions, { view: "done" }).map(({ sessionId }) => sessionId)).toEqual([
            "sleeping-done",
            "exited-done",
        ]);
        expect(selectDashboardSessions(sessions, allQuery).map(({ sessionId }) => sessionId)).toEqual([
            "live",
            "launching",
            "sleeping-done",
            "exited-done",
            "failed",
            "stale",
        ]);
    });
    it.each([
        ["display name", { name: "Release Sentinel" }, "release sentinel"],
    ])("searches %s case-insensitively", (_field, overrides, search) => {
        const target = session("target", overrides);
        const other = session("other");
        expect(selectDashboardSessions([other, target], { view: "all", search })).toEqual([target]);
    });
    it("combines task-state and exact project-path filters", () => {
        const target = session("target", { taskState: "WAITING", processState: "LIVE", cwd: "/repo/a" });
        const wrongState = session("wrong-state", { taskState: "READY", processState: "LIVE", cwd: "/repo/a" });
        const childPath = session("child", { taskState: "WAITING", processState: "LIVE", cwd: "/repo/a/child" });
        expect(selectDashboardSessions([wrongState, childPath, target], {
            view: "all",
            taskStates: ["WAITING"],
            projectPaths: ["/repo/a/../a"],
        })).toEqual([target]);
    });
});
