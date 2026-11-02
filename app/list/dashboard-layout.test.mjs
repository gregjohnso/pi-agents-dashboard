import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { createDashboardLayout, renderColumnHeader, renderGroupHeader, renderSessionRow, wrapPromptDraft, } from "./dashboard-layout.mjs";
import { JOBWATCH_ANSI } from "./dashboard-theme.mjs";
const now = Date.parse("2026-08-25T12:00:00.000Z");

function session(sessionId, overrides = {}) {
    return {
        schemaVersion: 1,
        revision: 1,
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        canonicalSessionFile: `/sessions/${sessionId}.jsonl`,
        cwd: `/projects/${sessionId}`,
        model: { provider: "openai", id: "gpt-5.6" },
        taskState: "READY",
        processState: "LIVE",
        outcome: "NONE",
        activity: { kind: "assistant", summary: `Activity ${sessionId}`, updatedAt: "2026-08-25T11:50:00.000Z" },
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T11:50:00.000Z",
        ...overrides,
    };
}
const fixtures = [
    session("working-123456", {
        taskState: "WORKING",
        activity: { kind: "tool", summary: "bash: pytest extensions/agents-dashboard", updatedAt: "2026-08-25T11:59:01.000Z" },
    }),
    session("waiting-123456", {
        taskState: "WAITING",
        activity: { kind: "ui_request", summary: "Approve access to release credentials?", updatedAt: "2026-08-25T11:55:00.000Z" },
    }),
    session("ready-12345678", { taskState: "READY", processState: "SLEEPING" }),
    session("failed-1234567", {
        taskState: "FAILED",
        processState: "EXITED",
        activity: { kind: "terminal_error", summary: "provider 429: quota exhausted", updatedAt: "2026-08-25T10:00:00.000Z" },
    }),
    session("stopped-123456", { taskState: "STOPPED", processState: "EXITED" }),
    session("stale-12345678", { taskState: "READY", processState: "STALE" }),
    session("completed-1234", {
        taskState: "READY",
        processState: "EXITED",
        outcome: "COMPLETED",
        activity: { kind: "assistant_final", summary: "Release checks passed", updatedAt: "2026-08-24T12:00:00.000Z" },
    }),
    session("unicode-会話-1234", {
        cwd: "/worktrees/研究/非常に長いプロジェクト名/dashboard",
        model: { provider: "anthropic", id: "claude-opus-4-1-a-very-long-model-name" },
        activity: { kind: "assistant", summary: "検証中 🚀 résumé naïve café", updatedAt: "2026-08-25T11:58:00.000Z" },
    }),
    session("no-activity-123", {
        cwd: "/a/very/long/path/with/a/project-name-that-does-not-fit",
        activity: { kind: "none", summary: "", updatedAt: "2026-08-25T11:45:00.000Z" },
    }),
];
describe("responsive dashboard layout", () => {
    it("prefers a generated summary over raw activity in the Activity column", () => {
        const layout = createDashboardLayout(160, 40);
        const summarized = session("summarized", {
            activity: { kind: "assistant", summary: "Pi assistant streaming", updatedAt: "2026-08-25T11:59:00.000Z" },
            summary: { text: "Fixes the coverage loader and reruns tests", generatedAt: "2026-08-25T11:59:30.000Z", model: { provider: "anthropic", id: "haiku" }, sourceCursor: "42" },
        });
        const row = stripVTControlCharacters(renderSessionRow(summarized, layout, { now }));
        expect(row).toContain("Fixes the coverage loader and reruns tests");
        expect(row).not.toContain("Pi assistant streaming");
    });

    it("shows a short ID after the activity: the end of Pi's session id, else the dashboard's", () => {
        const layout = createDashboardLayout(149, 40);
        expect(stripVTControlCharacters(renderColumnHeader(layout))).toMatch(/ACTIVITY +ID +MODEL/u);
        const pi = stripVTControlCharacters(renderSessionRow(session("session-1793401671901", { durable: { piSessionId: "01a18f11-d577-7607-9611-6d83e02293b8" } }), layout, { now }));
        expect(pi).toContain(" 2293b8 ");
        const dashboardOnly = stripVTControlCharacters(renderSessionRow(session("session-1793401671901"), layout, { now }));
        expect(dashboardOnly).toContain("671901");
        expect(visibleWidth(pi)).toBeLessThanOrEqual(149);
    });

    it("sanitizes untrusted controls to one line before applying renderer-owned ANSI", () => {
        const layout = createDashboardLayout(160, 20);
        const hostile = session("id\twith\r\ncontrols\x07", {
            cwd: "/projects/project\tname\r\nnext",
            model: { provider: "provider", id: "model\tname\r\nnext\x1b[31mred" },
            activity: {
                kind: "tool",
                summary: "first\tcolumn\r\nsecond\x07\x1b]8;;https://example.test\x07link\x1b]8;;\x07",
                updatedAt: "2026-08-25T11:59:00.000Z",
            },
        });
        const lines = [
            renderSessionRow(hostile, layout, { now }),
            renderGroupHeader("group\ttitle\r\nnext\x07\x1b[31mred", 1, layout),
        ];
        for (const line of lines) {
            expect(stripVTControlCharacters(line)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
            expect(stripVTControlCharacters(line)).not.toContain("\n");
            expect(visibleWidth(line)).toBeLessThanOrEqual(layout.width);
        }
        expect(lines[0]).toContain(JOBWATCH_ANSI.cyan);
        expect(lines[1]).toContain(JOBWATCH_ANSI.sky);
    });
    it("draws a group header as a full-width divider naming the group and its size", () => {
        const layout = createDashboardLayout(60, 20);
        const line = stripVTControlCharacters(renderGroupHeader("WORKING", 2, layout));
        expect(line).toBe(`── WORKING (2) ${"─".repeat(60 - "── WORKING (2) ".length)}`);
        expect(visibleWidth(line)).toBe(60);
        const long = stripVTControlCharacters(renderGroupHeader("~/projects/a/very/deep/working/directory/that/cannot/fit/here", 7, layout));
        expect(visibleWidth(long)).toBe(60);
        // The end of a path is what tells two directories apart, so it is kept and the start is elided.
        expect(long).toMatch(/^── …[^ ]*\/cannot\/fit\/here \(7\) ─+$/u);
    });
});

it("reads a worker replacement as a start in progress, with the reason in the activity column", () => {
    // Operator-visible failure: a worker replaced at a release boundary left the row on its last
    // state for the two minutes the restart took, and the operator read his own prompt as hung.
    const layout = createDashboardLayout(160, 40);
    const replacing = session("replacing-1234", {
        processState: "EXITED",
        activity: { kind: "replacing", summary: "Replacing this session's worker for the current release", updatedAt: "2026-08-25T11:59:00.000Z" },
    });
    const row = stripVTControlCharacters(renderSessionRow(replacing, layout, { now }));
    expect(row).toContain("STARTING");
    expect(row).not.toContain("EXITED");
    expect(row).toContain("Replacing this session's worker");
    // A restarting session is live work, so the default view must not drop it.
    expect(renderSessionRow(replacing, layout, { now })).toContain(JOBWATCH_ANSI.cyan);
});
