import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../../shared/contracts.js";
import {
  createDashboardLayout,
  renderColumnHeader,
  renderSessionRow,
} from "./dashboard-layout.js";
import { JOBWATCH_ANSI } from "./dashboard-theme.js";

const now = Date.parse("2026-08-25T12:00:00.000Z");

function session(sessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
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
  it.each([160, 120, 80, 55, 40])("renders a width-safe %i-column snapshot", (width) => {
    const layout = createDashboardLayout(width, 20);
    const lines = [
      renderColumnHeader(layout),
      ...fixtures.map((record, index) => renderSessionRow(record, layout, { now, selected: index === 1 })),
    ];

    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect({
      width,
      density: layout.density,
      listTop: layout.listTop,
      listHeight: layout.listHeight,
      columns: layout.columns,
      lines: lines.map(stripVTControlCharacters),
    }).toMatchSnapshot();
  });

  it("uses the Jobwatch palette for information, state, selection, and black surfaces", () => {
    const layout = createDashboardLayout(120, 20);
    const working = renderSessionRow(fixtures[0], layout, { now });
    const waitingSelected = renderSessionRow(fixtures[1], layout, { now, selected: true });
    const failed = renderSessionRow(fixtures[3], layout, { now });
    const completed = renderSessionRow(fixtures[6], layout, { now });

    expect(renderColumnHeader(layout)).toContain(JOBWATCH_ANSI.sky);
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
