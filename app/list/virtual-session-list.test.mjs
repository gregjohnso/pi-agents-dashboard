import { homedir } from "node:os";

import { describe, expect, it, vi } from "vitest";
import { VirtualSessionList } from "./virtual-session-list.mjs";
const timestamp = "2026-08-25T12:00:00.000Z";
function session(index, overrides = {}) {
    const sessionId = `session-${String(index).padStart(5, "0")}`;
    return {
        schemaVersion: 1,
        revision: 1,
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        canonicalSessionFile: `/sessions/${sessionId}.jsonl`,
        cwd: `/projects/${index % 2 === 0 ? "alpha" : "beta"}`,
        model: { provider: "provider", id: "model" },
        taskState: index % 2 === 0 ? "WORKING" : "READY",
        processState: "LIVE",
        outcome: "NONE",
        activity: { kind: "tool", summary: `Activity ${index}`, updatedAt: timestamp },
        createdAt: timestamp,
        updatedAt: timestamp,
        ...overrides,
    };
}
function label(row) {
    return row.kind === "gap" ? "" : row.kind === "group" ? `[${row.label}]` : row.session.sessionId;
}
describe("VirtualSessionList", () => {
    it("bounds ten thousand sessions to the requested viewport slice", () => {
        const sessions = Array.from({ length: 10_000 }, (_, index) => session(index));
        const renderRow = vi.fn((row) => label(row));
        const list = new VirtualSessionList(sessions, { renderRow });
        const rendered = list.renderViewport({ offset: 4_321, height: 11, width: 80 });
        expect(rendered).toHaveLength(11);
        expect(rendered.map(({ row }) => label(row))).toEqual(sessions.slice(4_321, 4_332).map(({ sessionId }) => sessionId));
        expect(renderRow).toHaveBeenCalledTimes(11);
    });
    it("counts group headers as virtual rows while keeping them unselectable", () => {
        const sessions = [
            session(0, { taskState: "WORKING" }),
            session(2, { taskState: "WORKING" }),
            session(1, { taskState: "READY" }),
        ];
        const list = new VirtualSessionList(sessions, {
            groupBy: "taskState",
            renderRow: (row) => label(row),
        });
        expect(list.rows.map((row) => ({ kind: row.kind, selectable: row.selectable, label: label(row) }))).toEqual([
            { kind: "group", selectable: false, label: "[WORKING]" },
            { kind: "session", selectable: true, label: "session-00000" },
            { kind: "session", selectable: true, label: "session-00002" },
            { kind: "gap", selectable: false, label: "" },
            { kind: "group", selectable: false, label: "[READY]" },
            { kind: "session", selectable: true, label: "session-00001" },
        ]);
        expect(list.selectedSessionId).toBe("session-00000");
        list.moveSelection(1);
        expect(list.selectedSessionId).toBe("session-00002");
        list.moveSelection(1);
        expect(list.selectedSessionId).toBe("session-00001");
        expect(list.selectedRowIndex).toBe(5);
    });
    it("labels a directory group with its whole path, home shortened to ~", () => {
        const home = homedir();
        const list = new VirtualSessionList([session(0, { cwd: `${home}/projects/a` }), session(1, { cwd: "/srv/b" })], { groupBy: "cwd", renderRow: (row) => label(row) });
        expect(list.rows.filter((row) => row.kind === "group").map((row) => row.label)).toEqual(["~/projects/a", "/srv/b"]);
    });
    it("groups by the state the STATE column shows", () => {
        const list = new VirtualSessionList([session(0, { taskState: "READY", stateReported: false })], { groupBy: "taskState", renderRow: (row) => label(row) });
        expect(list.rows[0]).toMatchObject({ kind: "group", label: "UNKNOWN" });
    });
    it("separates groups with one blank line, and never selects it", () => {
        const list = new VirtualSessionList([session(0), session(2), session(1)], { groupBy: "taskState" });
        expect(list.rows.map((row) => row.kind)).toEqual(["group", "session", "session", "gap", "group", "session"]);
        expect(list.rows[3].selectable).toBe(false);
        expect(list.renderViewport({ offset: 0, height: 6, width: 80 })[3].line.trim()).toBe("");
        list.selectSession("session-00002");
        list.moveSelection(1);
        expect(list.selectedSessionId).toBe("session-00001");
    });
    it("keeps the cursor in place when the selected session leaves the list", () => {
        const sessions = [session(0), session(1), session(2), session(3)];
        const list = new VirtualSessionList(sessions, { renderRow: (row) => label(row) });
        list.selectSession("session-00001");
        list.setSessions([session(0), session(2), session(3)]);
        expect(list.selectedSessionId).toBe("session-00002");
        list.selectSession("session-00003");
        list.setSessions([session(0), session(2)]);
        expect(list.selectedSessionId).toBe("session-00002");
    });
});
