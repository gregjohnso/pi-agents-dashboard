import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  ["queue/commands.jsonl", "{\"command\":{}}\n"],
  ["daemon/launch-results.json", JSON.stringify({ schemaVersion: 1, results: { request: {} } })],
  ["runs/one/worker-replay.jsonl", `${JSON.stringify({ clientId: "client", requestId: "request", op: "stop", stage: "UNKNOWN", at: "now" })}\n`],
  ["runs/one/worker-replay.jsonl", `${JSON.stringify({ clientId: "", requestId: "request", op: "stop", stage: "RECEIVED", at: "now" })}\n`],
  ["daemon/workers.json", JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, proto: 0 }] })],
  ["daemon/workers.json", JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, routeGeneration: 0 }] })],
  ["daemon/workers.json", JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, pendingRespawn: "later" }] })],
  ["cli/pending/one.json", JSON.stringify({ schemaVersion: 1, action: "restart", sessionId: "one", revision: 3, clientId: "client", requestId: "request" })],
  ["unknown-state.json", JSON.stringify({ value: true })],
  // Retired artifacts. No production code names either one, so neither has a validator and both are
  // simply unknown to a migration: nothing parses, migrates, or deletes the copies already on disk.
  ["frontend-state.json", JSON.stringify({ schemaVersion: 1, clientId: "client", viewState: {}, launchDraft: {} })],
  ["daemon/attachment-results.jsonl", `${JSON.stringify({ schemaVersion: 1, phase: "COMPLETED" })}\n`],
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
it("migrates a worker awaiting replacement and a pending respawn request", async () => {
  const paths = await fixture();
  const identity = { pid: 42, startIdentity: "42", processGroupId: 42 };
  const metadata = { schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, identity, piChildIdentity: identity, token: "run-token", proto: 1, cliVersion: "1.4.2", routeGeneration: 3, pendingRespawn: "upgrade" }] };
  const pending = { schemaVersion: 1, action: "respawn", sessionId: "one", revision: 3, clientId: "client", requestId: "request" };
  await mkdir(join(paths.legacyRoot, "daemon"), { recursive: true, mode: 0o700 });
  await mkdir(join(paths.legacyRoot, "cli", "pending"), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, "daemon", "workers.json"), JSON.stringify(metadata), { mode: 0o600 });
  await writeFile(join(paths.legacyRoot, "cli", "pending", "one.json"), JSON.stringify(pending), { mode: 0o600 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} })).resolves.toMatchObject({ status: "MIGRATED" });
  expect(JSON.parse(await readFile(join(paths.destinationRoot, "daemon", "workers.json"), "utf8"))).toEqual(metadata);
  expect(JSON.parse(await readFile(join(paths.destinationRoot, "cli", "pending", "one.json"), "utf8"))).toEqual(pending);
});

/**
 * One durable journal record as a release that still had `session_query` wrote it. The fingerprint
 * is that release's canonical form of the command: sorted keys, no whitespace.
 */
function retiredOperationRecord() {
  return {
    commandCanonical: '{"clientId":"client","op":"session_query","payload":{"query":"stats","sessionId":"one"},"requestId":"request","version":1}',
    command: { version: 1, clientId: "client", requestId: "request", op: "session_query", payload: { sessionId: "one", query: "stats" } },
    status: { clientId: "client", requestId: "request", operation: "session_query", stage: "COMPLETED", acceptedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:01.000Z" },
  };
}

/** @param {{legacyRoot:string}} paths @param {unknown} record */
async function writeLegacyJournal(paths, record) {
  await mkdir(join(paths.legacyRoot, "queue"), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, "queue", "commands.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// Operator-visible failure: the journal records what a command was, not what the daemon can still
// run. Judging a historical record against the current operation allowlist refuses a whole root
// because it once used a feature this release deleted.
it("migrates a journal record for an operation this release removed", async () => {
  const paths = await fixture();
  const record = retiredOperationRecord();
  await writeLegacyJournal(paths, record);

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} })).resolves.toMatchObject({ status: "MIGRATED" });
  expect(JSON.parse(await readFile(join(paths.destinationRoot, "queue", "commands.jsonl"), "utf8"))).toEqual(record);
});

it.each([
  ["a client identity its command contradicts", (/** @type {any} */ record) => { record.status.clientId = "other"; }],
  ["a request identity its command contradicts", (/** @type {any} */ record) => { record.status.requestId = "other"; }],
  ["an operation its command contradicts", (/** @type {any} */ record) => { record.status.operation = "stop"; }],
  ["no canonical fingerprint", (/** @type {any} */ record) => { delete record.commandCanonical; }],
  ["a stage this release cannot recover", (/** @type {any} */ record) => { record.status.stage = "DISPATCHED"; }],
])("refuses a legacy journal record with %s", async (_label, corrupt) => {
  const paths = await fixture();
  const record = retiredOperationRecord();
  corrupt(record);
  await writeLegacyJournal(paths, record);

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: vi.fn() })).rejects.toMatchObject({ code: "MALFORMED_LEGACY_STATE" });
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
