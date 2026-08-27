import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { createDashboardLayout, renderColumnHeader, renderGroupHeader, renderSessionRow, } from "./dashboard-layout.mjs";
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
    it.each([[160, 40], [120, 32], [80, 24], [55, 16], [40, 10]])("renders a width-safe %ix%i snapshot", (width, height) => {
        const layout = createDashboardLayout(width, height);
        const lines = [
            renderColumnHeader(layout),
            ...fixtures.map((record, index) => renderSessionRow(record, layout, { now, selected: index === 1 })),
        ];
        for (const line of lines)
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect({
            width,
            density: layout.density,
            listTop: layout.listTop,
            listHeight: layout.listHeight,
            columns: layout.columns,
            lines: lines.map(stripVTControlCharacters),
        }).toMatchSnapshot();
    });
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
    it("colors each displayed state with its Jobwatch semantic color", () => {
        const layout = createDashboardLayout(160, 40);
        const colorOf = (overrides) => renderSessionRow(session("colored", overrides), layout, { now });
        expect(colorOf({ taskState: "WORKING", processState: "LIVE" })).toContain(JOBWATCH_ANSI.green);
        expect(colorOf({ taskState: "WAITING", processState: "LIVE" })).toContain(JOBWATCH_ANSI.amber);
        expect(colorOf({ taskState: "READY", processState: "LIVE" })).toContain(JOBWATCH_ANSI.sky);
        expect(colorOf({ taskState: "FAILED", processState: "EXITED" })).toContain(JOBWATCH_ANSI.rose);
        expect(colorOf({ taskState: "READY", processState: "EXITED" })).toContain(JOBWATCH_ANSI.gray);
    });
    it("keeps the fixed list column order and never renders Model or Project", () => {
        expect(createDashboardLayout(160, 40).columns.map(({ key }) => key)).toEqual(["name", "state", "activity", "age"]);
        const header = stripVTControlCharacters(renderColumnHeader(createDashboardLayout(160, 40)));
        expect(header).not.toContain("MODEL");
        expect(header).not.toContain("PROJECT");
        expect(header).toContain("NAME");
        expect(createDashboardLayout(120, 32).columns.map(({ key }) => key)).toEqual(["name", "state", "activity", "age"]);
        expect(header).toContain("AGE");
        expect(header).not.toContain("ID");
    });
    it("renders the session name and falls back when a session has none", () => {
        const layout = createDashboardLayout(160, 40);
        const named = stripVTControlCharacters(renderSessionRow(session("named", { name: "Coverage loader", processState: "LIVE" }), layout, { now }));
        expect(named).toContain("Coverage loader");
        expect(named).toContain("▶");
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
    it("tints only the name cell for a colored session", () => {
        const layout = createDashboardLayout(120, 20);
        const plain = renderSessionRow(fixtures[0], layout, { now });
        const colored = renderSessionRow({ ...fixtures[0], color: "amber" }, layout, { now });
        expect(colored).not.toBe(plain);
        expect(colored).toContain(JOBWATCH_ANSI.amber);
        // The state cell keeps its derived color; only the name cell carries the operator's choice.
        expect(colored).toContain(JOBWATCH_ANSI.green);
        expect(stripVTControlCharacters(colored)).toBe(stripVTControlCharacters(plain));
    });

    it("renders an uncolored session byte-identically to today", () => {
        const layout = createDashboardLayout(120, 20);
        expect(renderSessionRow({ ...fixtures[0], color: undefined }, layout, { now })).toBe(renderSessionRow(fixtures[0], layout, { now }));
    });

    it("uses Jobwatch's exact surface, selection, accent, and semantic colors", () => {
        expect(JOBWATCH_ANSI).toMatchObject({
            blackBackground: "\x1b[48;2;0;0;0m",
            surfaceBackground: "\x1b[48;2;17;17;17m",
            headerBackground: "\x1b[48;2;2;132;199m",
            selectionBackground: "\x1b[48;2;54;54;54m",
            text: "\x1b[38;2;255;255;255m",
            sky: "\x1b[38;2;125;211;252m",
            cyan: "\x1b[38;2;125;211;252m",
            green: "\x1b[38;2;110;231;183m",
            amber: "\x1b[38;2;252;211;77m",
            rose: "\x1b[38;2;253;164;175m",
            gray: "\x1b[38;2;136;136;136m",
        });
        const layout = createDashboardLayout(120, 20);
        const working = renderSessionRow(fixtures[0], layout, { now });
        const waitingSelected = renderSessionRow(fixtures[1], layout, { now, selected: true });
        const failed = renderSessionRow(fixtures[3], layout, { now });
        const completed = renderSessionRow(fixtures[6], layout, { now });
        expect(renderColumnHeader(layout)).toContain(JOBWATCH_ANSI.gray);
        expect(working).toContain(JOBWATCH_ANSI.green);
        expect(waitingSelected).toContain(JOBWATCH_ANSI.amber);
        expect(waitingSelected).toContain(JOBWATCH_ANSI.selectionBackground);
        expect(failed).toContain(JOBWATCH_ANSI.rose);
        expect(completed).toContain(JOBWATCH_ANSI.gray);
        for (const line of [working, failed, completed]) {
            expect(line).toContain(JOBWATCH_ANSI.blackBackground);
        }
    });
});

it("spins the state cell while a session works, in step with the viewer's spinner", () => {
    const layout = createDashboardLayout(100, 24);
    const working = session("spinning", { taskState: "WORKING", processState: "LIVE" });
    const frameAt = (now) => stripVTControlCharacters(renderSessionRow(working, layout, { now })).match(/[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f]/u)?.[0];
    const first = frameAt(0);
    expect(first).toBeDefined();
    expect(frameAt(80)).not.toBe(first);
    expect(frameAt(800)).toBe(first);
    expect(stripVTControlCharacters(renderSessionRow(session("still", { taskState: "READY", processState: "LIVE" }), layout, { now: 0 }))).not.toMatch(/[\u280b\u2819]/u);
});
