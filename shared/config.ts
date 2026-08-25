import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface DashboardConfig {
  schemaVersion: 1;
  workers: { maxLive: number | null; idleRetentionMs: number };
  history: { completedWindowHours: number | null; indexRefreshMs: number };
  daemon: { heartbeatMs: number; staleAfterMs: number; startTimeoutMs: number };
  stop: { gracefulMs: number; terminateMs: number };
}

type UnknownRecord = Record<string, unknown>;

const DEFAULT_CONFIG: DashboardConfig = {
  schemaVersion: 1,
  workers: { maxLive: null, idleRetentionMs: 900_000 },
  history: { completedWindowHours: null, indexRefreshMs: 5_000 },
  daemon: { heartbeatMs: 2_000, staleAfterMs: 10_000, startTimeoutMs: 15_000 },
  stop: { gracefulMs: 5_000, terminateMs: 5_000 },
};

const TOP_LEVEL_KEYS = ["schemaVersion", "workers", "history", "daemon", "stop"];
const WORKER_KEYS = ["maxLive", "idleRetentionMs"];
const HISTORY_KEYS = ["completedWindowHours", "indexRefreshMs"];
const DAEMON_KEYS = ["heartbeatMs", "staleAfterMs", "startTimeoutMs"];
const STOP_KEYS = ["gracefulMs", "terminateMs"];

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value as UnknownRecord;
}

function readSection(root: UnknownRecord, key: string): UnknownRecord {
  return hasOwn(root, key) ? readRecord(root[key], key) : {};
}

function rejectUnknownKeys(record: UnknownRecord, allowedKeys: string[], path: string): void {
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unknownKey !== undefined) {
    throw new TypeError(`Unknown ${path} key: ${unknownKey}`);
  }
}

function readPositiveInteger(record: UnknownRecord, key: string, fallback: number): number {
  if (!hasOwn(record, key)) {
    return fallback;
  }
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${key} must be a positive integer`);
  }
  return value as number;
}

function readNullablePositiveInteger(
  record: UnknownRecord,
  key: string,
  fallback: number | null,
): number | null {
  if (!hasOwn(record, key)) {
    return fallback;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${key} must be null or a positive integer`);
  }
  return value as number;
}

function readNullablePositiveNumber(
  record: UnknownRecord,
  key: string,
  fallback: number | null,
): number | null {
  if (!hasOwn(record, key)) {
    return fallback;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${key} must be null or a positive number`);
  }
  return value;
}

/** Validate a partial configuration and apply the reviewed defaults. */
export function loadDashboardConfig(input: unknown): DashboardConfig {
  const root = readRecord(input, "Dashboard configuration");
  rejectUnknownKeys(root, TOP_LEVEL_KEYS, "dashboard configuration");
  if (hasOwn(root, "schemaVersion") && root.schemaVersion !== 1) {
    throw new TypeError("schemaVersion must be 1");
  }

  const workers = readSection(root, "workers");
  const history = readSection(root, "history");
  const daemon = readSection(root, "daemon");
  const stop = readSection(root, "stop");
  rejectUnknownKeys(workers, WORKER_KEYS, "workers");
  rejectUnknownKeys(history, HISTORY_KEYS, "history");
  rejectUnknownKeys(daemon, DAEMON_KEYS, "daemon");
  rejectUnknownKeys(stop, STOP_KEYS, "stop");

  return {
    schemaVersion: 1,
    workers: {
      maxLive: readNullablePositiveInteger(workers, "maxLive", DEFAULT_CONFIG.workers.maxLive),
      idleRetentionMs: readPositiveInteger(
        workers,
        "idleRetentionMs",
        DEFAULT_CONFIG.workers.idleRetentionMs,
      ),
    },
    history: {
      completedWindowHours: readNullablePositiveNumber(
        history,
        "completedWindowHours",
        DEFAULT_CONFIG.history.completedWindowHours,
      ),
      indexRefreshMs: readPositiveInteger(
        history,
        "indexRefreshMs",
        DEFAULT_CONFIG.history.indexRefreshMs,
      ),
    },
    daemon: {
      heartbeatMs: readPositiveInteger(daemon, "heartbeatMs", DEFAULT_CONFIG.daemon.heartbeatMs),
      staleAfterMs: readPositiveInteger(
        daemon,
        "staleAfterMs",
        DEFAULT_CONFIG.daemon.staleAfterMs,
      ),
      startTimeoutMs: readPositiveInteger(
        daemon,
        "startTimeoutMs",
        DEFAULT_CONFIG.daemon.startTimeoutMs,
      ),
    },
    stop: {
      gracefulMs: readPositiveInteger(stop, "gracefulMs", DEFAULT_CONFIG.stop.gracefulMs),
      terminateMs: readPositiveInteger(stop, "terminateMs", DEFAULT_CONFIG.stop.terminateMs),
    },
  };
}

/** Validate and atomically replace a complete configuration file. */
export async function writeDashboardConfig(path: string, input: unknown): Promise<void> {
  const config = loadDashboardConfig(input);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
