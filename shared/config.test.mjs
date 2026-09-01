import { expect, it } from "vitest";

import { convertLegacyDashboardConfig, loadDashboardConfig } from "./config.mjs";

const REVIEWED_DEFAULT_CONFIG = {
  schemaVersion: 2,
  pi: { executable: null },
  workers: { maxLive: null, idleRetentionMs: 900_000 },
  history: { completedWindowHours: null, indexRefreshMs: 5_000 },
  daemon: { heartbeatMs: 2_000, staleAfterMs: 10_000, startTimeoutMs: 15_000 },
  stop: { gracefulMs: 5_000, terminateMs: 5_000 },
  diagnostics: { rpcSegmentBytes: 8_388_608, rpcSegments: 4, stderrBytes: 8_388_608 },
};

// Nothing in this package writes dashboard.json; the operator does. Migration rewrites the legacy
// file through convertLegacyDashboardConfig and its own staged copy.
it("reads and converts configuration, and never writes it", async () => {
  expect(Object.keys(await import("./config.mjs")).sort()).toEqual(["convertLegacyDashboardConfig", "loadDashboardConfig"]);
});

it("rejects every unknown key and invalid schema 2 value", () => {
  expect(() => loadDashboardConfig({ unexpected: true })).toThrow(/unknown/i);
  expect(() => loadDashboardConfig({ diagnostics: { extra: 1 } })).toThrow(/unknown/i);
  expect(() => loadDashboardConfig({ schemaVersion: 1 })).toThrow(/schemaVersion/);
  expect(() => loadDashboardConfig({ pi: { executable: "relative" } })).toThrow(/absolute/i);
  expect(() => loadDashboardConfig({ daemon: { heartbeatMs: 0 } })).toThrow(/positive integer/i);
  expect(() => loadDashboardConfig({ diagnostics: { rpcSegments: 1.5 } })).toThrow(/positive integer/i);
});

it("preserves reviewed schema 1 limits, timings, history, and isolation-adjacent values", () => {
  expect(convertLegacyDashboardConfig({
    schemaVersion: 1,
    workers: { maxLive: 3, idleRetentionMs: 12_000 },
    history: { completedWindowHours: 48, indexRefreshMs: 7_000 },
    daemon: { heartbeatMs: 1_000, staleAfterMs: 4_000, startTimeoutMs: 20_000 },
    stop: { gracefulMs: 2_000, terminateMs: 3_000 },
  })).toEqual({
    ...REVIEWED_DEFAULT_CONFIG,
    workers: { maxLive: 3, idleRetentionMs: 12_000 },
    history: { completedWindowHours: 48, indexRefreshMs: 7_000 },
    daemon: { heartbeatMs: 1_000, staleAfterMs: 4_000, startTimeoutMs: 20_000 },
    stop: { gracefulMs: 2_000, terminateMs: 3_000 },
  });
});

it("applies the reviewed release defaults to an absent configuration", () => {
  expect(loadDashboardConfig({})).toEqual(REVIEWED_DEFAULT_CONFIG);
});
