import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { migrateLegacyState } from "./state-migration.mjs";

/** @type {string[]} */
const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-agents-migration-"));
  roots.push(parent);
  const legacyRoot = join(parent, "pi-agents-dashboard");
  const destinationRoot = join(parent, "pi-agents");
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

it.each([
  ["an active daemon", { activeDaemon: { pid: 12, startIdentity: "live" }, activeSupervisors: [] }],
  ["a live supervisor", { activeDaemon: false, activeSupervisors: [{ pid: 42, startIdentity: "legacy-42", processGroupId: 42 }] }],
])("refuses %s before staging and reports its identity", async (_label, activity) => {
  const paths = await fixture();
  const reconcileDestination = vi.fn();

  await expect(migrateLegacyState({
    ...paths,
    expectedUserId: process.getuid?.() ?? 0,
    inspectLegacyRuntime: async () => activity,
    reconcileDestination,
  })).rejects.toMatchObject({ code: "LEGACY_RUNTIME_ACTIVE", identities: activity });
  expect(reconcileDestination).not.toHaveBeenCalled();
  await expect(readFile(join(paths.legacyRoot, "dashboard.json"), "utf8")).resolves.toContain('"schemaVersion":1');
});

it.each([
  ["sessions/one.json", JSON.stringify({ schemaVersion: 1, sessionId: "one" })],
  ["daemon/control.token", ""],
  ["runs/one/worker-replay.jsonl", `${JSON.stringify({ clientId: "client", requestId: "request", op: "stop", stage: "UNKNOWN", at: "now" })}\n`],
  ["runs/one/worker-replay.jsonl", `${JSON.stringify({ clientId: "", requestId: "request", op: "stop", stage: "RECEIVED", at: "now" })}\n`],
  ["daemon/workers.json", JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, proto: 0 }] })],
  ["daemon/workers.json", JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, routeGeneration: 0 }] })],
  ["daemon/workers.json", JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, pendingRespawn: "later" }] })],
  ["unknown-state.json", JSON.stringify({ value: true })],
])("refuses malformed legacy artifact %s", async (relative, text) => {
  const paths = await fixture();
  const directory = join(paths.legacyRoot, relative.split("/").slice(0, -1).join("/"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, relative), text, { mode: 0o600 });
  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: vi.fn() })).rejects.toMatchObject({ code: "MALFORMED_LEGACY_STATE" });
});

it.each([
  ["a changed record", async (/** @type {{destinationRoot:string}} */ paths) => { const recordPath = join(paths.destinationRoot, "sessions", "one.json"); const record = JSON.parse(await readFile(recordPath, "utf8")); await writeFile(recordPath, `${JSON.stringify({ ...record, revision: 1 })}\n`, { mode: 0o600 }); }, "MIGRATION_IDENTITY_MISMATCH"],
  ["a public expected file", async (/** @type {{destinationRoot:string}} */ paths) => chmod(join(paths.destinationRoot, "sessions", "one.json"), 0o644), "MIGRATION_IDENTITY_MISMATCH"],
  ["a same-content symlink", async (/** @type {{legacyRoot:string,destinationRoot:string}} */ paths) => { const target = join(paths.destinationRoot, "sessions", "one.json"); await rm(target); await symlink(join(paths.legacyRoot, "sessions", "one.json"), target); }, "DESTINATION_COLLISION"],
  ["an extra nested artifact", async (/** @type {{destinationRoot:string}} */ paths) => writeFile(join(paths.destinationRoot, "sessions", "extra.json"), "{}", { mode: 0o600 }), "DESTINATION_COLLISION"],
])("rejects PUBLISHED output containing %s before reconciliation starts", async (_name, mutate, code) => {
  const paths = await fixture();
  const options = { ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {}, async failpoint(/** @type {string} */ stage) { if (stage === "after_manifest_publication") throw new Error("crash"); } };
  await expect(migrateLegacyState(options)).rejects.toThrow("crash");
  await mutate(paths);
  await expect(migrateLegacyState({ ...options, failpoint: async () => {} })).rejects.toMatchObject({ code });
});

// Operator-visible failure: the fields a live daemon writes when it adopts a worker must survive a
// state-root migration. Refusing them strands every live session behind MALFORMED_LEGACY_STATE.
it("migrates worker metadata carrying the adopted protocol, release, and route generation", async () => {
  const paths = await fixture();
  const identity = { pid: 42, startIdentity: "42", processGroupId: 42 };
  const metadata = { schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, identity, piChildIdentity: identity, token: "run-token", proto: 1, cliVersion: "1.4.2", routeGeneration: 3 }] };
  await mkdir(join(paths.legacyRoot, "daemon"), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, "daemon", "workers.json"), JSON.stringify(metadata), { mode: 0o600 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} })).resolves.toMatchObject({ status: "MIGRATED" });
  expect(JSON.parse(await readFile(join(paths.destinationRoot, "daemon", "workers.json"), "utf8"))).toEqual(metadata);
});

// Operator-visible failure: a replacement the daemon promised before it signalled must survive a
// state-root migration, and so must the operator's own pending respawn. Refusing either strands the
// session behind MALFORMED_LEGACY_STATE.
it("migrates a worker awaiting replacement", async () => {
  const paths = await fixture();
  const identity = { pid: 42, startIdentity: "42", processGroupId: 42 };
  const metadata = { schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, identity, piChildIdentity: identity, token: "run-token", proto: 1, cliVersion: "1.4.2", routeGeneration: 3, pendingRespawn: "upgrade" }] };
  await mkdir(join(paths.legacyRoot, "daemon"), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, "daemon", "workers.json"), JSON.stringify(metadata), { mode: 0o600 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} })).resolves.toMatchObject({ status: "MIGRATED" });
  expect(JSON.parse(await readFile(join(paths.destinationRoot, "daemon", "workers.json"), "utf8"))).toEqual(metadata);
});

// Operator-visible failure: this release deleted the daemon command journal and the two client
// records that existed only to give it a stable retry identity. A legacy root still holds all three.
// Refusing the root over a format nobody reads would leave the operator unable to migrate at all,
// and copying it forward would leave durable state no code names.
it("drops the deleted command journal and its client-side retry records", async () => {
  const paths = await fixture();
  for (const directory of ["queue", "daemon", "cli/pending"]) await mkdir(join(paths.legacyRoot, directory), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, "queue", "commands.jsonl"), "this was never valid JSON\n", { mode: 0o600 });
  await writeFile(join(paths.legacyRoot, "daemon", "launch-results.json"), "{", { mode: 0o600 });
  await writeFile(join(paths.legacyRoot, "cli", "pending", "one.json"), "{", { mode: 0o600 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} })).resolves.toMatchObject({ status: "MIGRATED" });
  for (const relative of [["queue", "commands.jsonl"], ["daemon", "launch-results.json"], ["cli", "pending", "one.json"]]) {
    await expect(readFile(join(paths.destinationRoot, ...relative), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it.each([
  ["index/viewer/events.jsonl", "this retired index record is not JSON\n", "index"],
  ["frontend-state.json", "{", undefined],
  ["daemon/attachment-results.jsonl", "this retired attachment result is not JSON\n", "daemon"],
  ["daemon/event-acks.json", "{", "daemon"],
])("drops retired viewer artifact %s without recreating its empty directory", async (relative, text, emptyDirectory) => {
  const paths = await fixture();
  const directory = join(paths.legacyRoot, relative.split("/").slice(0, -1).join("/"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, relative), text, { mode: 0o600 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} })).resolves.toMatchObject({ status: "MIGRATED" });
  await expect(readFile(join(paths.destinationRoot, relative), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  if (emptyDirectory !== undefined) await expect(stat(join(paths.destinationRoot, emptyDirectory))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(paths.legacyRoot, relative), "utf8")).toBe(text);
});

// Operator-visible failure: a directory standing where a legacy file belongs is not a format this
// release reads. Copying it forward puts a directory where the daemon expects a private file, which
// fails every later launch inside reconciliation instead of during migration.
it.each(["frontend-state.json", "daemon/event-acks.json", "dashboard.json"])("refuses a legacy directory standing at the file path %s", async (relative) => {
  const paths = await fixture();
  await rm(join(paths.legacyRoot, relative), { force: true });
  await mkdir(join(paths.legacyRoot, relative), { recursive: true, mode: 0o700 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: vi.fn() })).rejects.toMatchObject({ code: "MALFORMED_LEGACY_STATE" });
  expect((await stat(join(paths.legacyRoot, relative))).isDirectory()).toBe(true);
  await expect(stat(join(paths.destinationRoot, relative))).rejects.toMatchObject({ code: "ENOENT" });
});

// Operator-visible failure: the release line's own daemon creates `daemon/workers` for its run
// sockets and every launch creates `runs/<run>/diagnostics`. Both stand empty in a stopped root, and
// refusing them leaves the operator unable to migrate a root this release wrote itself.
it.each(["daemon/workers", "runs/one-run/diagnostics"])("migrates a legacy root holding the empty %s directory the daemon creates", async (relative) => {
  const paths = await fixture();
  await mkdir(join(paths.legacyRoot, relative), { recursive: true, mode: 0o700 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} })).resolves.toMatchObject({ status: "MIGRATED" });
  expect((await stat(join(paths.destinationRoot, relative))).isDirectory()).toBe(true);
});

// Operator-visible failure: an empty socket or diagnostic directory is the only shape this release
// can carry forward. Contents it cannot read must still refuse the migration before anything is
// written to the destination, rather than arrive there as durable state no code names.
it.each(["daemon/workers/state.json", "runs/one-run/diagnostics/rpc.0.jsonl"])("refuses the unsupported legacy file %s", async (relative) => {
  const paths = await fixture();
  await mkdir(dirname(join(paths.legacyRoot, relative)), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, relative), "{}\n", { mode: 0o600 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: vi.fn() })).rejects.toMatchObject({ code: "MALFORMED_LEGACY_STATE", message: `Malformed legacy artifact: ${relative}` });
  await expect(stat(join(paths.destinationRoot, relative.split("/")[0]))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["daemon/workers/nested", "runs/one-run/diagnostics/nested"])("refuses the unknown legacy directory %s", async (relative) => {
  const paths = await fixture();
  await mkdir(join(paths.legacyRoot, relative), { recursive: true, mode: 0o700 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: vi.fn() })).rejects.toMatchObject({ code: "MALFORMED_LEGACY_STATE", relative });
  await expect(stat(join(paths.destinationRoot, relative.split("/")[0]))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses a worker socket left in the legacy daemon/workers directory", async () => {
  const paths = await fixture();
  const socketDirectory = join(paths.legacyRoot, "daemon", "workers");
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(join(socketDirectory, "run.sock"), () => resolve(undefined)); });

  try {
    await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: vi.fn() })).rejects.toMatchObject({ code: "UNSAFE_LEGACY_STATE" });
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
  await expect(stat(join(paths.destinationRoot, "daemon"))).rejects.toMatchObject({ code: "ENOENT" });
});

// Operator-visible failure: a destination an earlier release wrote still holds the retired viewer
// artifacts. Resuming an interrupted migration must read them as leftovers, not as a collision no
// retry can clear, or the dashboard never launches again without manual filesystem surgery.
it.each(["after_manifest_publication", "before_manifest_rename"])("resumes an interrupted migration whose destination holds retired artifacts after %s", async (failedStage) => {
  const paths = await fixture();
  const base = { ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} };
  await expect(migrateLegacyState({ ...base, failpoint: async (/** @type {string} */ stage) => { if (stage === failedStage) throw new Error("crash"); } })).rejects.toThrow("crash");

  await writeFile(join(paths.destinationRoot, "frontend-state.json"), "{}", { mode: 0o600 });
  await mkdir(join(paths.destinationRoot, "queue"), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.destinationRoot, "queue", "commands.jsonl"), "", { mode: 0o600 });

  await expect(migrateLegacyState(base)).resolves.toMatchObject({ status: "MIGRATED" });
});

it("recovers mutable PUBLISHED output only after the reconciliation marker is durable", async () => {
  const paths = await fixture();
  const recordPath = join(paths.destinationRoot, "sessions", "one.json");
  const base = { ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }) };
  await expect(migrateLegacyState({ ...base, reconcileDestination: async () => { const record = JSON.parse(await readFile(recordPath, "utf8")); await writeFile(recordPath, `${JSON.stringify({ ...record, revision: 1 })}\n`, { mode: 0o600 }); }, async failpoint(/** @type {string} */ stage) { if (stage === "before_reconciliation_completion") throw new Error("crash"); } })).rejects.toThrow("crash");
  await expect(migrateLegacyState({ ...base, reconcileDestination: async () => {} })).resolves.toMatchObject({ status: "MIGRATED" });
});

it("recovers idempotently only for the same completed migration identity", async () => {
  const paths = await fixture();
  const options = { ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} };
  const first = await migrateLegacyState(options);
  expect(await migrateLegacyState(options)).toEqual({ ...first, status: "ALREADY_MIGRATED" });

  // A reconciled destination is the daemon's to write; its own revisions must stay idempotent.
  const recordPath = join(paths.destinationRoot, "sessions", "one.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(recordPath, `${JSON.stringify({ ...record, revision: 1 })}\n`, { mode: 0o600 });
  await expect(migrateLegacyState(options)).resolves.toEqual({ ...first, status: "ALREADY_MIGRATED" });

  await writeFile(join(paths.destinationRoot, "collision"), "x", { mode: 0o600 });
  await expect(migrateLegacyState(options)).rejects.toMatchObject({ code: "DESTINATION_COLLISION" });
});
