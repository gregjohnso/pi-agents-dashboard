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
    return row.kind === "group" ? `[${row.label}]` : row.session.sessionId;
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
            { kind: "group", selectable: false, label: "[READY]" },
            { kind: "session", selectable: true, label: "session-00001" },
        ]);
        expect(list.selectedSessionId).toBe("session-00000");
        list.moveSelection(1);
        expect(list.selectedSessionId).toBe("session-00002");
        list.moveSelection(1);
        expect(list.selectedSessionId).toBe("session-00001");
        expect(list.selectedRowIndex).toBe(4);
    });
});
