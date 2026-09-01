import { isAbsolute } from "node:path";

/** @typedef {{schemaVersion:1,migrationId:string,sourceIdentity:string,destinationIdentity:string,state:"PREPARED"|"PUBLISHED"|"RECONCILED",configFrom:1,configTo:2,createdAt:string,updatedAt:string}} MigrationManifest */
/** @typedef {{schemaVersion:2,pi:{executable:string|null},workers:{maxLive:number|null,idleRetentionMs:number},history:{completedWindowHours:number|null,indexRefreshMs:number},daemon:{heartbeatMs:number,staleAfterMs:number,startTimeoutMs:number},stop:{gracefulMs:number,terminateMs:number},diagnostics:{rpcSegmentBytes:number,rpcSegments:number,stderrBytes:number}}} DashboardConfig */

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 2,
  pi: { executable: null },
  workers: { maxLive: null, idleRetentionMs: 900_000 },
  history: { completedWindowHours: null, indexRefreshMs: 5_000 },
  daemon: { heartbeatMs: 2_000, staleAfterMs: 10_000, startTimeoutMs: 15_000 },
  stop: { gracefulMs: 5_000, terminateMs: 5_000 },
  diagnostics: { rpcSegmentBytes: 8_388_608, rpcSegments: 4, stderrBytes: 8_388_608 },
});

/** @param {unknown} value @param {string} path @returns {Record<string, unknown>} */
function record(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${path} must be a plain object`);
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {Record<string, unknown>} value @param {readonly string[]} keys @param {string} path */
function exact(value, keys, path) {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new TypeError(`Unknown ${path} key: ${unknown}`);
}
/** Read one optional section and refuse any key the defaults do not define. @param {Record<string, unknown>} root @param {keyof typeof DEFAULT_CONFIG} key */
function section(root, key) {
  const value = Object.hasOwn(root, key) ? record(root[key], key) : {};
  exact(value, Object.keys(DEFAULT_CONFIG[key]), key);
  return value;
}
/** @param {Record<string, unknown>} source @param {string} key @param {number} fallback */
function positiveInteger(source, key, fallback) {
  const value = Object.hasOwn(source, key) ? source[key] : fallback;
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) throw new TypeError(`${key} must be a positive integer`);
  return /** @type {number} */ (value);
}
/** @param {Record<string, unknown>} source @param {string} key @param {number|null} fallback @param {boolean} [integer] */
function nullablePositive(source, key, fallback, integer = true) {
  const value = Object.hasOwn(source, key) ? source[key] : fallback;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) throw new TypeError(`${key} must be null or a positive ${integer ? "integer" : "number"}`);
  return value;
}

/** Validate a partial schema-2 configuration and apply exact defaults. @param {unknown} input @returns {DashboardConfig} */
export function loadDashboardConfig(input) {
  const root = record(input, "Dashboard configuration");
  exact(root, Object.keys(DEFAULT_CONFIG), "dashboard configuration");
  if (Object.hasOwn(root, "schemaVersion") && root.schemaVersion !== 2) throw new TypeError("schemaVersion must be 2");
  const pi = section(root, "pi"); const workers = section(root, "workers"); const history = section(root, "history");
  const daemon = section(root, "daemon"); const stop = section(root, "stop"); const diagnostics = section(root, "diagnostics");
  const executable = Object.hasOwn(pi, "executable") ? pi.executable : DEFAULT_CONFIG.pi.executable;
  if (executable !== null && (typeof executable !== "string" || !isAbsolute(executable))) throw new TypeError("pi.executable must be null or an absolute path");
  return {
    schemaVersion: 2, pi: { executable },
    workers: { maxLive: nullablePositive(workers, "maxLive", null), idleRetentionMs: positiveInteger(workers, "idleRetentionMs", DEFAULT_CONFIG.workers.idleRetentionMs) },
    history: { completedWindowHours: nullablePositive(history, "completedWindowHours", null, false), indexRefreshMs: positiveInteger(history, "indexRefreshMs", DEFAULT_CONFIG.history.indexRefreshMs) },
    daemon: { heartbeatMs: positiveInteger(daemon, "heartbeatMs", DEFAULT_CONFIG.daemon.heartbeatMs), staleAfterMs: positiveInteger(daemon, "staleAfterMs", DEFAULT_CONFIG.daemon.staleAfterMs), startTimeoutMs: positiveInteger(daemon, "startTimeoutMs", DEFAULT_CONFIG.daemon.startTimeoutMs) },
    stop: { gracefulMs: positiveInteger(stop, "gracefulMs", DEFAULT_CONFIG.stop.gracefulMs), terminateMs: positiveInteger(stop, "terminateMs", DEFAULT_CONFIG.stop.terminateMs) },
    diagnostics: { rpcSegmentBytes: positiveInteger(diagnostics, "rpcSegmentBytes", DEFAULT_CONFIG.diagnostics.rpcSegmentBytes), rpcSegments: positiveInteger(diagnostics, "rpcSegments", DEFAULT_CONFIG.diagnostics.rpcSegments), stderrBytes: positiveInteger(diagnostics, "stderrBytes", DEFAULT_CONFIG.diagnostics.stderrBytes) },
  };
}

/** Convert one strict schema-1 configuration while retaining reviewed values. @param {unknown} input @returns {DashboardConfig} */
export function convertLegacyDashboardConfig(input) {
  const legacy = record(input, "Legacy dashboard configuration");
  exact(legacy, ["schemaVersion", "workers", "history", "daemon", "stop"], "legacy dashboard configuration");
  if (legacy.schemaVersion !== 1) throw new TypeError("Legacy schemaVersion must be 1");
  return loadDashboardConfig({
    ...(Object.hasOwn(legacy, "workers") ? { workers: legacy.workers } : {}),
    ...(Object.hasOwn(legacy, "history") ? { history: legacy.history } : {}),
    ...(Object.hasOwn(legacy, "daemon") ? { daemon: legacy.daemon } : {}),
    ...(Object.hasOwn(legacy, "stop") ? { stop: legacy.stop } : {}),
  });
}
