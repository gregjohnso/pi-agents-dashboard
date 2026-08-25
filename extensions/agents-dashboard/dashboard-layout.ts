import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { SessionRecord } from "../../shared/contracts.js";
import type {
  DashboardColumn,
  DashboardDensity,
  DashboardLayout,
  SortKey,
} from "./dashboard-types.js";
import { jobwatchTheme, type DashboardTheme } from "./dashboard-theme.js";

const COLUMN_LABELS: Record<SortKey, string> = {
  id: "ID",
  state: "STATE",
  age: "AGE",
  model: "MODEL",
  project: "PROJECT",
  activity: "ACTIVITY",
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

function plainText(value: string): string {
  return stripVTControlCharacters(value).replace(CONTROL_CHARACTERS, " ");
}

function fit(value: string, width: number): string {
  const safe = plainText(value);
  const clipped = truncateToWidth(safe, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function normalizedDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function densityForWidth(width: number): DashboardDensity {
  if (width >= 100) return "full";
  if (width >= 52) return "compact";
  return "minimal";
}

function columnsForWidth(width: number): readonly DashboardColumn[] {
  if (width <= 0) return [];
  if (width >= 100) {
    return [
      { key: "id", width: 10 },
      { key: "state", width: 9 },
      { key: "age", width: 7 },
      { key: "model", width: 20 },
      { key: "project", width: 24 },
      { key: "activity", width: width - 75 },
    ];
  }
  if (width >= 72) {
    return [
      { key: "id", width: 10 },
      { key: "state", width: 9 },
      { key: "age", width: 7 },
      { key: "project", width: 20 },
      { key: "activity", width: width - 50 },
    ];
  }
  if (width >= 52) {
    return [
      { key: "id", width: 9 },
      { key: "state", width: 8 },
      { key: "age", width: 6 },
      { key: "activity", width: width - 26 },
    ];
  }
  if (width >= 28) {
    return [
      { key: "id", width: 9 },
      { key: "state", width: 8 },
      { key: "activity", width: width - 19 },
    ];
  }
  if (width >= 12) {
    return [
      { key: "id", width: 8 },
      { key: "activity", width: width - 9 },
    ];
  }
  return [{ key: "activity", width }];
}

/** Compute responsive dashboard columns and the bounded list viewport. */
export function createDashboardLayout(width: number, height: number): DashboardLayout {
  const normalizedWidth = normalizedDimension(width);
  const normalizedHeight = normalizedDimension(height);
  const listTop = Math.min(6, normalizedHeight);
  return {
    width: normalizedWidth,
    height: normalizedHeight,
    density: densityForWidth(normalizedWidth),
    listTop,
    listHeight: Math.max(0, normalizedHeight - listTop - 4),
    columns: columnsForWidth(normalizedWidth),
  };
}

function joinCells(
  layout: DashboardLayout,
  values: Readonly<Record<SortKey, string>>,
  paintCell: (key: SortKey, text: string) => string,
  paintSeparator: (text: string) => string,
): string {
  const cells = layout.columns.map((column) => paintCell(column.key, fit(values[column.key], column.width)));
  return truncateToWidth(cells.join(paintSeparator(" ")), layout.width, "");
}

/** Render one responsive, width-safe table header. */
export function renderColumnHeader(
  layout: DashboardLayout,
  theme: DashboardTheme = jobwatchTheme,
): string {
  const values = COLUMN_LABELS;
  return joinCells(layout, values, (_key, text) => theme.header(text), (text) => theme.header(text));
}

function age(updatedAt: string, now: number): string {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return "—";
  const seconds = Math.max(0, Math.floor((now - updated) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function liveness(session: SessionRecord): string {
  switch (session.processState) {
    case "LIVE":
      return "▶";
    case "SLEEPING":
      return "◌";
    case "STALE":
      return "×";
    case "EXITED":
      return " ";
  }
}

function sessionValues(session: SessionRecord, now: number): Record<SortKey, string> {
  const project = basename(session.cwd) || session.cwd || "—";
  return {
    id: `${liveness(session)} ${truncateToWidth(plainText(session.sessionId), 8, "")}`,
    state: session.taskState,
    age: age(session.updatedAt, now),
    model: session.model?.id ?? "—",
    project,
    activity: session.activity.summary.trim() || "—",
  };
}

export interface SessionRowRenderOptions {
  now: number;
  selected?: boolean;
  theme?: DashboardTheme;
}

/** Render one dense session row without allocating a component per session. */
export function renderSessionRow(
  session: SessionRecord,
  layout: DashboardLayout,
  options: SessionRowRenderOptions,
): string {
  const selected = options.selected ?? false;
  const theme = options.theme ?? jobwatchTheme;
  const values = sessionValues(session, options.now);
  return joinCells(
    layout,
    values,
    (key, text) => {
      if (key === "id") return theme.id(text, selected);
      if (key === "state") return theme.state(session, text, selected);
      if (key === "age") return theme.muted(text, selected);
      return theme.text(text, selected);
    },
    (text) => theme.separator(text, selected),
  );
}

/** Render an unselectable group row that occupies one virtual list position. */
export function renderGroupHeader(
  label: string,
  count: number,
  layout: DashboardLayout,
  theme: DashboardTheme = jobwatchTheme,
): string {
  return theme.group(fit(`── ${plainText(label)} (${count}) `, layout.width));
}
