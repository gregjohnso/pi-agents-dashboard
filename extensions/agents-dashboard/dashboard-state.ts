import { resolve } from "node:path";

import type { Outcome, ProcessState, SessionRecord, TaskState } from "../../shared/contracts.js";

export type DashboardView = "live" | "done" | "all";
export type DashboardSortKey = "age" | "id" | "state" | "model" | "project" | "activity";
export type DashboardGroup = "taskState" | "cwd";
export type SortDirection = "asc" | "desc";
export type DashboardHistoryPolicy = (session: SessionRecord) => boolean;

export interface DashboardQuery {
  view: DashboardView;
  search?: string;
  taskStates?: readonly TaskState[];
  processStates?: readonly ProcessState[];
  outcomes?: readonly Outcome[];
  activityKinds?: readonly string[];
  projectPaths?: readonly string[];
  sort?: { key: DashboardSortKey; direction: SortDirection };
  groupBy?: DashboardGroup;
  historyPolicy?: DashboardHistoryPolicy;
}

export interface DashboardCounts {
  working: number;
  waiting: number;
  ready: number;
  failed: number;
  stopped: number;
  sessions: number;
  processes: number;
}

const TASK_STATE_ORDER: Record<TaskState, number> = {
  WORKING: 0,
  WAITING: 1,
  READY: 2,
  FAILED: 3,
  STOPPED: 4,
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalPath(path: string): string {
  return path === "" ? "" : resolve(path);
}

function isInView(session: SessionRecord, view: DashboardView): boolean {
  if (view === "all") return true;
  if (view === "live") return session.processState === "LIVE";
  return (
    (session.outcome === "COMPLETED" || session.outcome === "READY_FOR_REVIEW")
    && (session.processState === "SLEEPING" || session.processState === "EXITED")
  );
}

function searchText(session: SessionRecord): string {
  return [
    session.name,
    session.sessionFile,
    session.canonicalSessionFile,
    session.cwd,
    session.model?.provider,
    session.model?.id,
    session.taskState,
    session.processState,
    session.outcome,
    session.activity.kind,
    session.activity.summary,
  ].filter((value): value is string => value !== undefined).join("\n").toLowerCase();
}

function sortValue(session: SessionRecord, key: DashboardSortKey): string | number {
  switch (key) {
    case "age":
      return Date.parse(session.updatedAt);
    case "id":
      return session.sessionId.toLowerCase();
    case "state":
      return TASK_STATE_ORDER[session.taskState];
    case "model":
      return `${session.model?.provider ?? ""}/${session.model?.id ?? ""}`.toLowerCase();
    case "project":
      return canonicalPath(session.cwd).toLowerCase();
    case "activity":
      return `${session.activity.kind}\n${session.activity.summary}`.toLowerCase();
  }
}

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    const safeLeft = Number.isNaN(left) ? Number.NEGATIVE_INFINITY : left;
    const safeRight = Number.isNaN(right) ? Number.NEGATIVE_INFINITY : right;
    return safeLeft - safeRight;
  }
  return compareText(String(left), String(right));
}

/** Return the canonical identity used to coalesce dashboard group rows. */
export function dashboardGroupIdentity(
  session: SessionRecord,
  groupBy: DashboardGroup,
): string {
  return groupBy === "taskState"
    ? session.taskState
    : canonicalPath(session.cwd).toLowerCase();
}

function compareGroups(left: SessionRecord, right: SessionRecord, groupBy: DashboardGroup): number {
  if (groupBy === "taskState") {
    return TASK_STATE_ORDER[left.taskState] - TASK_STATE_ORDER[right.taskState];
  }
  return compareText(
    dashboardGroupIdentity(left, groupBy),
    dashboardGroupIdentity(right, groupBy),
  );
}

/** Filter, sort, and group a dashboard snapshot without reading external state. */
export function selectDashboardSessions(
  sessions: readonly SessionRecord[],
  query: DashboardQuery,
): readonly SessionRecord[] {
  const needle = query.search?.trim().toLowerCase() ?? "";
  const taskStates = query.taskStates === undefined ? undefined : new Set(query.taskStates);
  const processStates = query.processStates === undefined ? undefined : new Set(query.processStates);
  const outcomes = query.outcomes === undefined ? undefined : new Set(query.outcomes);
  const activityKinds = query.activityKinds === undefined ? undefined : new Set(query.activityKinds);
  const projectPaths = query.projectPaths === undefined
    ? undefined
    : new Set(query.projectPaths.map(canonicalPath));

  const selected = sessions.filter((session) => (
    (query.historyPolicy?.(session) ?? true)
    && isInView(session, query.view)
    && (taskStates?.has(session.taskState) ?? true)
    && (processStates?.has(session.processState) ?? true)
    && (outcomes?.has(session.outcome) ?? true)
    && (activityKinds?.has(session.activity.kind) ?? true)
    && (projectPaths?.has(canonicalPath(session.cwd)) ?? true)
    && (needle.length === 0 || searchText(session).includes(needle))
  ));

  if (query.sort === undefined && query.groupBy === undefined) {
    return selected;
  }

  return selected
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      if (query.groupBy !== undefined) {
        const grouped = compareGroups(left.session, right.session, query.groupBy);
        if (grouped !== 0) return grouped;
      }
      if (query.sort !== undefined) {
        const sorted = compareValues(
          sortValue(left.session, query.sort.key),
          sortValue(right.session, query.sort.key),
        );
        if (sorted !== 0) return query.sort.direction === "asc" ? sorted : -sorted;
      }
      return left.index - right.index;
    })
    .map(({ session }) => session);
}

/** Count dashboard task states and live processes from one snapshot. */
export function countDashboardSessions(sessions: readonly SessionRecord[]): DashboardCounts {
  const counts: DashboardCounts = {
    working: 0,
    waiting: 0,
    ready: 0,
    failed: 0,
    stopped: 0,
    sessions: sessions.length,
    processes: 0,
  };

  for (const session of sessions) {
    counts[session.taskState.toLowerCase() as Lowercase<TaskState>] += 1;
    if (session.processState === "LIVE") counts.processes += 1;
  }
  return counts;
}
