import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { createDashboardLayout, renderColumnHeader, renderGroupHeader, renderSessionRow, wrapPromptDraft, } from "./dashboard-layout.mjs";
import { JOBWATCH_ANSI } from "./dashboard-theme.mjs";
const now = Date.parse("2026-08-25T12:00:00.000Z");

it("keeps a cursor-space visible without shifting the next wrapped word", () => {
    const rows = wrapPromptDraft("1234 abc", 8, 4);

    expect(rows[0]).toContain("\x1b[7m \x1b[27m");
    expect(stripVTControlCharacters(rows[0])).toBe(" ❯ 1234 ");
    expect(stripVTControlCharacters(rows[1])).toBe("   abc");
});

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

    it("renders the session name and falls back when a session has none", () => {
        const layout = createDashboardLayout(160, 40);
        const named = stripVTControlCharacters(renderSessionRow(session("named", { name: "Coverage loader", processState: "LIVE" }), layout, { now }));
        expect(named).toContain("Coverage loader");
        // STATE reports liveness, so the row carries no separate marker.
        expect(named).not.toContain("▶");
        const unnamed = stripVTControlCharacters(renderSessionRow(session("unnamed-session-id"), layout, { now }));
        expect(unnamed).toContain("unnamed-");
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
    it("highlights the name cell of a colored session behind black text", () => {
        const layout = createDashboardLayout(120, 20);
        const plain = renderSessionRow(fixtures[0], layout, { now });
        expect(renderSessionRow({ ...fixtures[0], color: undefined }, layout, { now })).toBe(plain);
        const colored = renderSessionRow({ ...fixtures[0], color: "amber" }, layout, { now });
        expect(colored).not.toBe(plain);
        // The colour fills the cell and the name inverts to black, so it reads as a label.
        expect(colored).toContain("\x1b[48;2;252;211;77m");
        expect(colored).toContain("\x1b[38;2;0;0;0m");
        // The state cell keeps its derived color; only the name cell carries the operator's choice.
        expect(colored).toContain(JOBWATCH_ANSI.green);
        expect(stripVTControlCharacters(colored)).toBe(stripVTControlCharacters(plain));
    });
});

it("draws session rows on the terminal background without removing meaningful highlights", () => {
    const layout = createDashboardLayout(120, 20);
    const plain = renderSessionRow(fixtures[0], layout, { now });
    expect(plain).toContain("\x1b[49m");
    expect(plain).not.toContain(JOBWATCH_ANSI.blackBackground);

    const selected = renderSessionRow(fixtures[0], layout, { now, selected: true });
    expect(selected).toContain(JOBWATCH_ANSI.selectionBackground);
    const colored = renderSessionRow({ ...fixtures[0], color: "amber" }, layout, { now });
    expect(colored).toContain("\x1b[48;2;252;211;77m");
    expect(colored).not.toContain(JOBWATCH_ANSI.blackBackground);
});

it("bolds the selected row without altering its colors", () => {
    const layout = createDashboardLayout(120, 20);
    const plain = renderSessionRow(fixtures[0], layout, { now });
    const selected = renderSessionRow(fixtures[0], layout, { now, selected: true });
    expect(selected).toContain(JOBWATCH_ANSI.bold);
    expect(plain).not.toContain(JOBWATCH_ANSI.bold);
    // Selection changes weight only: the same foregrounds and the same selection background as before.
    expect(selected).toContain(JOBWATCH_ANSI.selectionBackground);
    const codes = (line) => line.match(/\u001b\[38;2;[0-9;]+m/gu) ?? [];
    expect(codes(selected)).toEqual(codes(plain));
    expect(stripVTControlCharacters(selected)).toBe(stripVTControlCharacters(plain));
});

it("ages a session from when it started, not from its last activity", () => {
    const layout = createDashboardLayout(120, 20);
    const started = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    const justSpoke = new Date(now - 30 * 1000).toISOString();
    const row = stripVTControlCharacters(renderSessionRow(session("old", { createdAt: started, updatedAt: justSpoke }), layout, { now }));
    // A session running since this morning must not read as one minute old because it just replied.
    expect(row).toContain("3h");
    expect(row).not.toContain("30s");
});

it("spins an unlabelled column left of STATE so the state text never shifts", () => {
    const layout = createDashboardLayout(100, 24);
    const spinner = /[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f]/u;
    const rowAt = (now, overrides) => stripVTControlCharacters(renderSessionRow(session("spinning", overrides), layout, { now }));

    const working = rowAt(0, { taskState: "WORKING", processState: "LIVE" });
    expect(working).toMatch(spinner);
    expect(working.indexOf(working.match(spinner)[0])).toBeLessThan(working.indexOf("WORKING"));
    expect(rowAt(80, { taskState: "WORKING", processState: "LIVE" }).match(spinner)[0]).not.toBe(working.match(spinner)[0]);

    // A still session leaves the column blank, and STATE keeps its position either way.
    const ready = rowAt(0, { taskState: "READY", processState: "LIVE" });
    expect(ready).not.toMatch(spinner);
    expect(ready.indexOf("READY")).toBe(working.indexOf("WORKING"));
    // The header labels nothing above the spinner.
    expect(stripVTControlCharacters(renderColumnHeader(layout))).toMatch(/NAME\s+STATE\s+ACTIVITY/u);
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
