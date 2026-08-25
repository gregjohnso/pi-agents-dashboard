import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { loadDashboardConfig, writeDashboardConfig } from "./config.js";

const REVIEWED_DEFAULT_CONFIG = {
  schemaVersion: 1,
  workers: { maxLive: null, idleRetentionMs: 900_000 },
  history: { completedWindowHours: null, indexRefreshMs: 5_000 },
  daemon: { heartbeatMs: 2_000, staleAfterMs: 10_000, startTimeoutMs: 15_000 },
  stop: { gracefulMs: 5_000, terminateMs: 5_000 },
};

it("loads the reviewed first-release defaults", () => {
  expect(loadDashboardConfig({})).toEqual(REVIEWED_DEFAULT_CONFIG);
});

it("rejects unknown keys and invalid limits", () => {
  expect(() => loadDashboardConfig({ workers: { maxLive: 0 } })).toThrow();
  expect(() => loadDashboardConfig({ unexpected: true })).toThrow();
});

it("merges valid reviewed configuration overrides", () => {
  expect(
    loadDashboardConfig({
      schemaVersion: 1,
      workers: { maxLive: 4, idleRetentionMs: 60_000 },
      history: { completedWindowHours: 48, indexRefreshMs: 10_000 },
      daemon: { heartbeatMs: 1_000, staleAfterMs: 4_000, startTimeoutMs: 20_000 },
      stop: { gracefulMs: 2_000, terminateMs: 3_000 },
    }),
  ).toEqual({
    schemaVersion: 1,
    workers: { maxLive: 4, idleRetentionMs: 60_000 },
    history: { completedWindowHours: 48, indexRefreshMs: 10_000 },
    daemon: { heartbeatMs: 1_000, staleAfterMs: 4_000, startTimeoutMs: 20_000 },
    stop: { gracefulMs: 2_000, terminateMs: 3_000 },
  });
});

it("rejects malformed sections, unsupported schemas, and invalid timing values", () => {
  expect(() => loadDashboardConfig(null)).toThrow();
  expect(() => loadDashboardConfig([])).toThrow();
  expect(() => loadDashboardConfig({ schemaVersion: 2 })).toThrow();
  expect(() => loadDashboardConfig({ workers: null })).toThrow();
  expect(() => loadDashboardConfig({ history: { unexpected: true } })).toThrow();
  expect(() => loadDashboardConfig({ daemon: { heartbeatMs: 0 } })).toThrow();
  expect(() => loadDashboardConfig({ stop: { terminateMs: 1.5 } })).toThrow();
  expect(() => loadDashboardConfig({ history: { completedWindowHours: 0 } })).toThrow();
  expect(() => loadDashboardConfig({ workers: { maxLive: -1 } })).toThrow();
  expect(() => loadDashboardConfig({ workers: { maxLive: 1.5 } })).toThrow();
});

it("validates and atomically serializes a complete configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agents-dashboard-config-"));
  const configPath = join(directory, "dashboard.json");

  try {
    await writeFile(configPath, '{"old":true}\n');
    await writeDashboardConfig(configPath, { workers: { maxLive: 3 } });

    const serialized = await readFile(configPath, "utf8");
    expect(JSON.parse(serialized)).toEqual({
      ...REVIEWED_DEFAULT_CONFIG,
      workers: { ...REVIEWED_DEFAULT_CONFIG.workers, maxLive: 3 },
    });
    expect(serialized.endsWith("\n")).toBe(true);
    expect(await readdir(directory)).toEqual(["dashboard.json"]);

    await expect(writeDashboardConfig(configPath, { workers: { maxLive: 0 } })).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(serialized);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
