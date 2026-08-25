import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { migrateLegacyState } from "./state-migration.mjs";

/** @type {string[]} */
const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-dashboard-migration-"));
  roots.push(parent);
  const legacyRoot = join(parent, "pi-agents-dashboard");
  const destinationRoot = join(parent, "pi-dashboard");
  await mkdir(join(legacyRoot, "sessions"), { recursive: true, mode: 0o700 });
  await writeFile(join(legacyRoot, "dashboard.json"), JSON.stringify({ schemaVersion: 1, workers: { maxLive: 2 } }), { mode: 0o600 });
  await writeFile(join(legacyRoot, "sessions", "one.json"), JSON.stringify({ schemaVersion: 1, revision: 0, sessionId: "one", sessionFile: "/canonical/sessions/one.jsonl", canonicalSessionFile: "/canonical/sessions/one.jsonl", cwd: "/repo", taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "none", summary: "idle", updatedAt: "2026-08-25T00:00:00.000Z" }, isolation: { mode: "worktree", worktreePath: "/worktrees/one", branch: "one" }, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" }), { mode: 0o600 });
  return { legacyRoot, destinationRoot };
}

it("publishes files, manifest, reconciliation, and canonical marker in durable order", async () => {
  const paths = await fixture();
  /** @type {string[]} */
  const order = [];
  const result = await migrateLegacyState({
    ...paths,
    expectedUserId: process.getuid?.() ?? 0,
    inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }),
    reconcileDestination: async () => { order.push("reconcile"); },
    failpoint: async (/** @type {string} */ stage) => { order.push(stage); },
  });
  expect(result.status).toBe("MIGRATED");
  expect(order).toEqual([
    "staging_start", "after_staged_file_fsync", "after_staged_file_fsync",
    "before_manifest_rename", "after_manifest_publication", "reconcile",
    "before_reconciliation_completion", "after_reconciliation",
  ]);
  expect(JSON.parse(await readFile(join(paths.destinationRoot, "dashboard.json"), "utf8"))).toMatchObject({ schemaVersion: 2, workers: { maxLive: 2 } });
  expect(JSON.parse(await readFile(join(paths.destinationRoot, "sessions", "one.json"), "utf8"))).toMatchObject({ canonicalSessionFile: "/canonical/sessions/one.jsonl", isolation: { worktreePath: "/worktrees/one" } });
  expect((await stat(join(paths.destinationRoot, "migration-manifest.json"))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(paths.destinationRoot, "migration-manifest.json"), "utf8"))).toEqual({
    schemaVersion: 1,
    migrationId: result.migrationId,
    sourceIdentity: expect.any(String),
    destinationIdentity: expect.any(String),
    state: "RECONCILED",
    configFrom: 1,
    configTo: 2,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  expect(await readFile(join(paths.destinationRoot, "CANONICAL"), "utf8")).toContain(result.migrationId);
  expect(await readFile(join(paths.legacyRoot, "dashboard.json"), "utf8")).toContain('"schemaVersion":1');
});

it.each(["staging_start", "after_staged_file_fsync", "before_manifest_rename", "after_manifest_publication", "before_reconciliation_completion", "after_reconciliation"])("preserves the source when %s fails", async (failedStage) => {
  const paths = await fixture();
  const before = await readFile(join(paths.legacyRoot, "dashboard.json"), "utf8");
  await expect(migrateLegacyState({
    ...paths,
    expectedUserId: process.getuid?.() ?? 0,
    inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }),
    reconcileDestination: async () => {},
    failpoint: async (/** @type {string} */ stage) => { if (stage === failedStage) throw new Error("injected"); },
  })).rejects.toThrow("injected");
  expect(await readFile(join(paths.legacyRoot, "dashboard.json"), "utf8")).toBe(before);
  await expect(migrateLegacyState({
    ...paths,
    expectedUserId: process.getuid?.() ?? 0,
    inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }),
    reconcileDestination: async () => {},
  })).resolves.toMatchObject({ status: "MIGRATED" });
});

it("refuses live legacy ownership before staging", async () => {
  const paths = await fixture();
  await expect(migrateLegacyState({
    ...paths,
    expectedUserId: process.getuid?.() ?? 0,
    inspectLegacyRuntime: async () => ({ activeDaemon: { pid: 12, startIdentity: "live" }, activeSupervisors: [] }),
    reconcileDestination: vi.fn(),
  })).rejects.toMatchObject({ code: "LEGACY_RUNTIME_ACTIVE" });
});

it("refuses a structurally invalid legacy registry record before staging", async () => {
  const paths = await fixture();
  await writeFile(join(paths.legacyRoot, "sessions", "one.json"), JSON.stringify({ schemaVersion: 1, sessionId: "one" }), { mode: 0o600 });
  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: vi.fn() })).rejects.toMatchObject({ code: "MALFORMED_LEGACY_STATE" });
});

it.each([
  ["daemon/control.token", ""],
  ["frontend-state.json", JSON.stringify({ schemaVersion: 1, clientId: "client", cursor: { daemonEpoch: "epoch", sequence: "01" } })],
  ["queue/commands.jsonl", "{\"command\":{}}\n"],
])("refuses malformed legacy artifact %s", async (relative, text) => {
  const paths = await fixture();
  const directory = join(paths.legacyRoot, relative.split("/").slice(0, -1).join("/"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, relative), text, { mode: 0o600 });
  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: vi.fn() })).rejects.toMatchObject({ code: "MALFORMED_LEGACY_STATE" });
});

it("treats a reconciled migration as idempotent after destination writers mutate copied records", async () => {
  const paths = await fixture();
  const options = { ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} };
  const first = await migrateLegacyState(options);
  const recordPath = join(paths.destinationRoot, "sessions", "one.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(recordPath, `${JSON.stringify({ ...record, revision: 1 })}\n`, { mode: 0o600 });
  await expect(migrateLegacyState(options)).resolves.toEqual({ ...first, status: "ALREADY_MIGRATED" });
});

it("recovers idempotently only for the same completed migration identity", async () => {
  const paths = await fixture();
  const options = { ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} };
  const first = await migrateLegacyState(options);
  const second = await migrateLegacyState(options);
  expect(second).toEqual({ ...first, status: "ALREADY_MIGRATED" });
  await writeFile(join(paths.destinationRoot, "collision"), "x", { mode: 0o600 });
  await expect(migrateLegacyState(options)).rejects.toMatchObject({ code: "DESTINATION_COLLISION" });
});
