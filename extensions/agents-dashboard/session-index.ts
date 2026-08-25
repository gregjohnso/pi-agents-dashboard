import { isAbsolute, resolve } from "node:path";

import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import type { SessionRecord } from "../../shared/contracts.js";

interface ValidSavedSession {
  info: SessionInfo;
  canonicalPath: string;
  createdAt: string;
  updatedAt: string;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalSessionPath(path: string): string {
  return resolve(path);
}

function readSavedSession(value: unknown): ValidSavedSession | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SessionInfo>;
  if (
    typeof candidate.id !== "string"
    || candidate.id.length === 0
    || candidate.id.trim() !== candidate.id
    || typeof candidate.path !== "string"
    || !isAbsolute(candidate.path)
    || typeof candidate.cwd !== "string"
    || !(candidate.created instanceof Date)
    || !Number.isFinite(candidate.created.getTime())
    || !(candidate.modified instanceof Date)
    || !Number.isFinite(candidate.modified.getTime())
    || typeof candidate.messageCount !== "number"
    || !Number.isInteger(candidate.messageCount)
    || candidate.messageCount < 0
    || typeof candidate.firstMessage !== "string"
    || typeof candidate.allMessagesText !== "string"
    || (candidate.name !== undefined && typeof candidate.name !== "string")
    || (candidate.parentSessionPath !== undefined && typeof candidate.parentSessionPath !== "string")
  ) {
    return undefined;
  }
  return {
    info: candidate as SessionInfo,
    canonicalPath: canonicalSessionPath(candidate.path),
    createdAt: candidate.created.toISOString(),
    updatedAt: candidate.modified.toISOString(),
  };
}

function savedSessionRecord(saved: ValidSavedSession): SessionRecord {
  const { info } = saved;
  const summary = info.firstMessage.trim() || info.name?.trim() || "Saved session";
  const record: SessionRecord = {
    schemaVersion: 1,
    revision: 0,
    sessionId: info.id,
    sessionFile: info.path,
    canonicalSessionFile: saved.canonicalPath,
    cwd: info.cwd,
    taskState: "READY",
    processState: "EXITED",
    outcome: info.messageCount > 0 ? "COMPLETED" : "NONE",
    activity: { kind: "saved_session", summary, updatedAt: saved.updatedAt },
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
  if (info.name !== undefined) record.name = info.name;
  return record;
}

function pathAliases(record: SessionRecord): readonly string[] {
  return [
    canonicalSessionPath(record.sessionFile),
    canonicalSessionPath(record.canonicalSessionFile),
  ];
}

function compareSnapshotRows(left: SessionRecord, right: SessionRecord): number {
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updated !== 0) return updated;
  const id = compareText(left.sessionId, right.sessionId);
  if (id !== 0) return id;
  return compareText(left.canonicalSessionFile, right.canonicalSessionFile);
}

/** Merge top-level saved Pi metadata with authoritative live registry records. */
export function mergeSessionIndex(
  saved: readonly SessionInfo[],
  live: readonly SessionRecord[],
): readonly SessionRecord[] {
  const rows: SessionRecord[] = [];
  const rowById = new Map<string, number>();
  const rowByPath = new Map<string, number>();

  const validSaved = saved
    .map(readSavedSession)
    .filter((entry): entry is ValidSavedSession => (
      entry !== undefined && !entry.info.parentSessionPath
    ))
    .sort((left, right) => {
      const modified = right.info.modified.getTime() - left.info.modified.getTime();
      if (modified !== 0) return modified;
      const id = compareText(left.info.id, right.info.id);
      return id !== 0 ? id : compareText(left.canonicalPath, right.canonicalPath);
    });

  for (const entry of validSaved) {
    if (rowById.has(entry.info.id) || rowByPath.has(entry.canonicalPath)) continue;
    const row = savedSessionRecord(entry);
    const index = rows.push(row) - 1;
    rowById.set(row.sessionId, index);
    rowByPath.set(row.canonicalSessionFile, index);
  }

  const orderedLive = live
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const revision = right.record.revision - left.record.revision;
      if (revision !== 0) return revision;
      const updated = Date.parse(right.record.updatedAt) - Date.parse(left.record.updatedAt);
      return updated !== 0 ? updated : left.index - right.index;
    });
  const liveIds = new Set<string>();
  const livePaths = new Set<string>();

  for (const { record } of orderedLive) {
    const aliases = pathAliases(record);
    if (liveIds.has(record.sessionId) || aliases.some((path) => livePaths.has(path))) continue;

    const matchingIndices = rows.flatMap((row, index) => (
      (
        row.sessionId === record.sessionId
        || pathAliases(row).some((path) => aliases.includes(path))
      ) ? [index] : []
    ));
    const savedName = matchingIndices
      .map((index) => rows[index].name)
      .find((name) => name !== undefined);
    const merged = matchingIndices.length === 0
      ? record
      : { ...rows[matchingIndices[0]], ...record };
    if (record.name === undefined && savedName !== undefined) merged.name = savedName;

    for (const index of matchingIndices.slice().reverse()) rows.splice(index, 1);
    rows.push(merged);
    liveIds.add(record.sessionId);
    for (const alias of aliases) livePaths.add(alias);
  }

  return rows.sort(compareSnapshotRows);
}
