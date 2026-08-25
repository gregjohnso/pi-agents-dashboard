import { basename } from "node:path";

import { truncateToWidth } from "@earendil-works/pi-tui";

import type { SessionRecord } from "../../shared/contracts.js";
import type { DashboardGroup } from "./dashboard-state.js";
import {
  createDashboardLayout,
  renderGroupHeader,
  renderSessionRow,
} from "./dashboard-layout.js";
import type {
  RenderedVirtualRow,
  VirtualRow,
  VirtualRowRenderer,
  VirtualSessionListOptions,
  VirtualViewport,
} from "./dashboard-types.js";

interface CachedSessionRow {
  signature: string;
  width: number;
  selected: boolean;
  line: string;
}

function sessionSignature(session: SessionRecord): string {
  return JSON.stringify(session);
}

function groupValue(session: SessionRecord, groupBy: DashboardGroup): string {
  return groupBy === "taskState" ? session.taskState : session.cwd;
}

function groupLabel(value: string, groupBy: DashboardGroup): string {
  if (groupBy === "taskState") return value;
  return basename(value) || value || "—";
}

function buildRows(
  sessions: readonly SessionRecord[],
  groupBy: DashboardGroup | undefined,
): readonly VirtualRow[] {
  if (groupBy === undefined) {
    return sessions.map((session) => ({
      kind: "session",
      key: `session:${session.sessionId}`,
      session,
      selectable: true,
    }));
  }

  const rows: VirtualRow[] = [];
  let index = 0;
  while (index < sessions.length) {
    const value = groupValue(sessions[index], groupBy);
    let end = index + 1;
    while (end < sessions.length && groupValue(sessions[end], groupBy) === value) end += 1;
    rows.push({
      kind: "group",
      key: `group:${groupBy}:${value}:${index}`,
      label: groupLabel(value, groupBy),
      count: end - index,
      selectable: false,
    });
    for (let sessionIndex = index; sessionIndex < end; sessionIndex += 1) {
      const session = sessions[sessionIndex];
      rows.push({
        kind: "session",
        key: `session:${session.sessionId}`,
        session,
        selectable: true,
      });
    }
    index = end;
  }
  return rows;
}

function firstSessionId(rows: readonly VirtualRow[]): string | undefined {
  return rows.find((row) => row.kind === "session")?.session.sessionId;
}

function normalizedInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Virtualized session rows with ID-stable selection and per-session render caching. */
export class VirtualSessionList {
  private sessions: readonly SessionRecord[];
  private groupBy: DashboardGroup | undefined;
  private virtualRows: readonly VirtualRow[];
  private selectedId: string | undefined;
  private now: number;
  private readonly renderRowOverride: VirtualRowRenderer | undefined;
  private readonly rowCache = new Map<string, CachedSessionRow>();

  constructor(
    sessions: readonly SessionRecord[],
    options: VirtualSessionListOptions = {},
  ) {
    this.sessions = sessions;
    this.groupBy = options.groupBy;
    this.virtualRows = buildRows(sessions, this.groupBy);
    this.selectedId = firstSessionId(this.virtualRows);
    this.now = options.now ?? Date.now();
    this.renderRowOverride = options.renderRow;
  }

  get rows(): readonly VirtualRow[] {
    return this.virtualRows;
  }

  get selectedSessionId(): string | undefined {
    return this.selectedId;
  }

  get selectedRowIndex(): number {
    if (this.selectedId === undefined) return -1;
    return this.virtualRows.findIndex((row) => (
      row.kind === "session" && row.session.sessionId === this.selectedId
    ));
  }

  get cacheSize(): number {
    return this.rowCache.size;
  }

  selectSession(sessionId: string): boolean {
    const exists = this.sessions.some((session) => session.sessionId === sessionId);
    if (!exists) return false;
    this.selectedId = sessionId;
    return true;
  }

  moveSelection(delta: number): void {
    if (this.virtualRows.length === 0 || delta === 0) return;
    const direction = delta > 0 ? 1 : -1;
    let remaining = Math.abs(Math.trunc(delta));
    let index = this.selectedRowIndex;
    if (index < 0) {
      this.selectedId = firstSessionId(this.virtualRows);
      index = this.selectedRowIndex;
      remaining -= 1;
    }

    while (remaining > 0) {
      let candidate = index + direction;
      while (candidate >= 0 && candidate < this.virtualRows.length) {
        const row = this.virtualRows[candidate];
        if (row.kind === "session") break;
        candidate += direction;
      }
      if (candidate < 0 || candidate >= this.virtualRows.length) break;
      index = candidate;
      remaining -= 1;
    }

    const row = this.virtualRows[index];
    if (row?.kind === "session") this.selectedId = row.session.sessionId;
  }

  setSessions(
    sessions: readonly SessionRecord[],
    options?: { groupBy?: DashboardGroup },
  ): { invalidated: number } {
    const previousById = new Map(this.sessions.map((session) => [session.sessionId, session]));
    const nextById = new Map(sessions.map((session) => [session.sessionId, session]));
    let invalidated = 0;

    for (const [sessionId, cached] of this.rowCache) {
      const previous = previousById.get(sessionId);
      const next = nextById.get(sessionId);
      if (
        previous === undefined
        || next === undefined
        || cached.signature !== sessionSignature(next)
      ) {
        this.rowCache.delete(sessionId);
        invalidated += 1;
      }
    }

    this.sessions = sessions;
    if (options !== undefined) this.groupBy = options.groupBy;
    this.virtualRows = buildRows(sessions, this.groupBy);
    if (this.selectedId === undefined || !nextById.has(this.selectedId)) {
      this.selectedId = firstSessionId(this.virtualRows);
    }
    return { invalidated };
  }

  setNow(now: number): number {
    if (this.now === now) return 0;
    this.now = now;
    return this.invalidate();
  }

  invalidate(sessionId?: string): number {
    if (sessionId !== undefined) return this.rowCache.delete(sessionId) ? 1 : 0;
    const invalidated = this.rowCache.size;
    this.rowCache.clear();
    return invalidated;
  }

  renderViewport(viewport: VirtualViewport): readonly RenderedVirtualRow[] {
    const offset = Math.min(normalizedInteger(viewport.offset), this.virtualRows.length);
    const height = normalizedInteger(viewport.height);
    const width = normalizedInteger(viewport.width);
    const end = Math.min(this.virtualRows.length, offset + height);
    const rendered: RenderedVirtualRow[] = [];

    for (let index = offset; index < end; index += 1) {
      const row = this.virtualRows[index];
      const selected = row.kind === "session" && row.session.sessionId === this.selectedId;
      const line = row.kind === "session"
        ? this.renderSession(row, width, selected)
        : this.renderUncached(row, width, false);
      rendered.push({ index, row, line });
    }
    return rendered;
  }

  private renderSession(row: Extract<VirtualRow, { kind: "session" }>, width: number, selected: boolean): string {
    const signature = sessionSignature(row.session);
    const cached = this.rowCache.get(row.session.sessionId);
    if (
      cached !== undefined
      && cached.signature === signature
      && cached.width === width
      && cached.selected === selected
    ) {
      return cached.line;
    }

    const line = this.renderUncached(row, width, selected);
    this.rowCache.set(row.session.sessionId, { signature, width, selected, line });
    return line;
  }

  private renderUncached(row: VirtualRow, width: number, selected: boolean): string {
    const line = this.renderRowOverride === undefined
      ? this.renderDefault(row, width, selected)
      : this.renderRowOverride(row, width, selected);
    return truncateToWidth(line, width, "");
  }

  private renderDefault(row: VirtualRow, width: number, selected: boolean): string {
    const layout = createDashboardLayout(width, 1);
    return row.kind === "group"
      ? renderGroupHeader(row.label, row.count, layout)
      : renderSessionRow(row.session, layout, { now: this.now, selected });
  }
}
