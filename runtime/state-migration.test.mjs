import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { inspectRuntimeActivity } from "./runtime-activity.mjs";
import { migrateLegacyState } from "./state-migration.mjs";

// 0x80 is a bare continuation byte, 0xc3 0x28 is a truncated two-byte sequence, and 0xff never
// appears in UTF-8. A lossy decode turns these 9 bytes into 15.
const INVALID_UTF8 = Buffer.from([0x70, 0x69, 0x3a, 0x20, 0x80, 0xc3, 0x28, 0xff, 0x0a]);
const SUPERVISOR = { pid: 42, startIdentity: "42", processGroupId: 42 };
const PI_CHILD = { pid: 43, startIdentity: "43", processGroupId: 42 };
const GONE = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };

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
  ["daemon/workers.json", JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, socketPath: "" }] })],
  ["daemon/workers.json", JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, socketPath: 42 }] })],
  ["daemon/workers.json", JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, socketPath: "/tmp/pi-agents-elsewhere/run.sock" }] })],
  ["runs/one/terminal-cause.json", JSON.stringify({ schemaVersion: 1, sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, worker: SUPERVISOR, piChild: PI_CHILD, event: { type: "WORKER_EXITED", at: "2026-08-25T12:01:00.000Z", summary: "the worker exited" } })],
  ["runs/one/terminal-cause.json", JSON.stringify({ schemaVersion: 1, sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, worker: SUPERVISOR, piChild: PI_CHILD })],
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

// Operator-visible failure: a stopped run keeps the rotating RPC and stderr segments this release
// still writes. Refusing them leaves the operator unable to migrate a root that holds one crashed
// run's only diagnostics, and rewriting them would destroy the evidence they exist to carry.
it("migrates the rotating RPC and stderr segments a run leaves behind", async () => {
  const paths = await fixture();
  const segments = {
    "rpc.00000000.jsonl": `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } })}\n`,
    "rpc.00000001.jsonl": `${JSON.stringify({ type: "diagnostic_truncation", removedBytes: 8_388_608, removedRecords: 12 })}\n`,
    "stderr.00000000.jsonl": "pi: model provider returned 429\npi: retrying in 2s\n",
  };
  const directory = join(paths.legacyRoot, "runs", "a2f9c1", "diagnostics");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(segments)) await writeFile(join(directory, name), text, { mode: 0o600 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} })).resolves.toMatchObject({ status: "MIGRATED" });

  for (const [name, text] of Object.entries(segments)) {
    const migrated = join(paths.destinationRoot, "runs", "a2f9c1", "diagnostics", name);
    expect(await readFile(migrated)).toEqual(Buffer.from(text));
    expect((await stat(migrated)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, name))).toEqual(Buffer.from(text));
  }
  expect((await stat(join(paths.destinationRoot, "runs", "a2f9c1", "diagnostics"))).mode & 0o777).toBe(0o700);
});

// Operator-visible failure: only the segment names `openRotatingWriter` writes are carried forward.
// Any other content of a socket or diagnostic directory must refuse the migration before anything is
// written to the destination, rather than arrive there as durable state no code names.
it.each(["daemon/workers/state.json", "runs/one-run/diagnostics/rpc.0.jsonl", "runs/one-run/diagnostics/stdout.00000000.jsonl"])("refuses the unsupported legacy file %s", async (relative) => {
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

// Operator-visible failure: a crashed run's stdout, stderr, and rotating diagnostics are byte
// streams, not text. A stream chunk that splits a multi-byte character, or a subprocess that writes
// bytes UTF-8 never produces, decodes to U+FFFD, so the migrated copy is not what the run emitted
// and the evidence these files exist to carry is silently destroyed.
it("migrates opaque run bytes that are not valid UTF-8", async () => {
  const paths = await fixture();
  const runDirectory = join(paths.legacyRoot, "runs", "a2f9c1");
  await mkdir(join(runDirectory, "diagnostics"), { recursive: true, mode: 0o700 });
  const opaque = {
    "worker.stdout.log": INVALID_UTF8,
    "worker.stderr.log": INVALID_UTF8,
    "diagnostics/stderr.00000000.jsonl": INVALID_UTF8,
    "diagnostics/rpc.00000000.jsonl": Buffer.concat([Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt" })}\n`), INVALID_UTF8]),
  };
  for (const [relative, bytes] of Object.entries(opaque)) await writeFile(join(runDirectory, relative), bytes, { mode: 0o600 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} })).resolves.toMatchObject({ status: "MIGRATED" });

  for (const [relative, bytes] of Object.entries(opaque)) {
    const migrated = join(paths.destinationRoot, "runs", "a2f9c1", relative);
    expect(await readFile(migrated)).toEqual(bytes);
    expect((await stat(migrated)).size).toBe(bytes.length);
    expect((await stat(migrated)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(runDirectory, relative))).toEqual(bytes);
  }
});

// Operator-visible failure: resuming an interrupted migration revalidates what was already staged.
// Comparing decoded text on both sides makes a corrupted copy look identical to its source, so
// recovery adopts the corruption instead of detecting it.
it.each(["after_staged_file_fsync", "after_manifest_publication"])("revalidates opaque non-UTF-8 run bytes when resuming a migration interrupted at %s", async (failedStage) => {
  const paths = await fixture();
  const directory = join(paths.legacyRoot, "runs", "a2f9c1", "diagnostics");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "stderr.00000000.jsonl"), INVALID_UTF8, { mode: 0o600 });
  const base = { ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: async () => {} };

  await expect(migrateLegacyState({ ...base, failpoint: async (/** @type {string} */ stage) => { if (stage === failedStage) throw new Error("crash"); } })).rejects.toThrow("crash");
  await expect(migrateLegacyState(base)).resolves.toMatchObject({ status: "MIGRATED" });

  expect(await readFile(join(paths.destinationRoot, "runs", "a2f9c1", "diagnostics", "stderr.00000000.jsonl"))).toEqual(INVALID_UTF8);
});

// Operator-visible failure: a structured artifact that is not valid UTF-8 is not the text it claims
// to be. Decoding it lossily migrates a corrupted control token or session name that reads as valid,
// and the daemon then fails to authenticate far from the cause.
it.each(["daemon/control.token", "cli/client-id", "sessions/two.json"])("refuses the structured legacy artifact %s holding invalid UTF-8", async (relative) => {
  const paths = await fixture();
  await mkdir(join(paths.legacyRoot, dirname(relative)), { recursive: true, mode: 0o700 });
  const record = JSON.parse(await readFile(join(paths.legacyRoot, "sessions", "one.json"), "utf8"));
  // The byte sits inside a JSON string value, where a lossy decode yields the legal character U+FFFD
  // and every structural validator downstream still accepts the record.
  const [head, tail] = JSON.stringify({ ...record, sessionId: "two", name: "SESSION_NAME" }).split("SESSION_NAME");
  const bytes = relative === "sessions/two.json" ? Buffer.concat([Buffer.from(head, "utf8"), Buffer.from([0xff]), Buffer.from(tail, "utf8")]) : INVALID_UTF8;
  await writeFile(join(paths.legacyRoot, relative), bytes, { mode: 0o600 });

  await expect(migrateLegacyState({ ...paths, expectedUserId: process.getuid?.() ?? 0, inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }), reconcileDestination: vi.fn() })).rejects.toMatchObject({ code: "MALFORMED_LEGACY_STATE", message: `Malformed legacy artifact: ${relative}` });
  await expect(stat(join(paths.destinationRoot, "dashboard.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

// Operator-visible failure: a root whose workers are all dead is the root this migration exists to
// rescue. Its roster names every run's own socket and its crashed run holds the cause Pi died of, so
// refusing either field leaves the operator with no dashboard and no reason, and carrying the socket
// path verbatim points the destination daemon's cleanup back inside the legacy root.
it("migrates a dead root's current-format worker roster and the crash cause its run recorded", async () => {
  const paths = await fixture();
  const socketName = "0a1b2c3d4e5f6071.sock";
  const worker = { sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, identity: SUPERVISOR, piChildIdentity: PI_CHILD, token: "run-token", socketPath: join(paths.legacyRoot, "daemon", "workers", socketName), proto: 2, cliVersion: "1.4.2", routeGeneration: 3 };
  await mkdir(join(paths.legacyRoot, "daemon", "workers"), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [worker] })}\n`, { mode: 0o600 });
  const cause = Buffer.from(`${JSON.stringify({ schemaVersion: 1, sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, worker: SUPERVISOR, piChild: PI_CHILD, event: { type: "PI_CHILD_CRASHED", at: "2026-08-25T12:01:00.000Z", summary: "Pi exited unexpectedly (SIGSEGV)" } })}\n`, "utf8");
  await mkdir(join(paths.legacyRoot, "runs", "a2f9c1"), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, "runs", "a2f9c1", "terminal-cause.json"), cause, { mode: 0o600 });

  await expect(migrateLegacyState({
    ...paths,
    expectedUserId: process.getuid?.() ?? 0,
    inspectLegacyRuntime: () => inspectRuntimeActivity({ stateRoot: paths.legacyRoot, exists: async () => true, inspectEndpoint: async () => ({ status: "ABSENT" }), inspect: async () => GONE() }),
    reconcileDestination: async () => {},
  })).resolves.toMatchObject({ status: "MIGRATED" });

  expect(JSON.parse(await readFile(join(paths.destinationRoot, "daemon", "workers.json"), "utf8"))).toEqual({ schemaVersion: 1, workers: [{ ...worker, socketPath: join(paths.destinationRoot, "daemon", "workers", socketName) }] });
  const migratedCause = join(paths.destinationRoot, "runs", "a2f9c1", "terminal-cause.json");
  expect(await readFile(migratedCause)).toEqual(cause);
  expect((await stat(migratedCause)).mode & 0o777).toBe(0o600);
});

// Operator-visible failure: a live worker still owns its session's files, so migrating underneath it
// would split one session across two roots. The roster a live daemon writes names each run's socket,
// and a preflight that cannot read that field refuses the root for its shape instead of blocking on
// the process it found.
it("refuses a legacy root whose current-format worker roster names a live supervisor", async () => {
  const paths = await fixture();
  const worker = { sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, identity: SUPERVISOR, piChildIdentity: PI_CHILD, token: "run-token", socketPath: join(paths.legacyRoot, "daemon", "workers", "0a1b2c3d4e5f6071.sock"), proto: 2 };
  await mkdir(join(paths.legacyRoot, "daemon", "workers"), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.legacyRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [worker] })}\n`, { mode: 0o600 });
  const reconcileDestination = vi.fn();

  await expect(migrateLegacyState({
    ...paths,
    expectedUserId: process.getuid?.() ?? 0,
    inspectLegacyRuntime: () => inspectRuntimeActivity({ stateRoot: paths.legacyRoot, exists: async () => true, inspectEndpoint: async () => ({ status: "ABSENT" }), inspect: async (/** @type {number} */ pid) => pid === SUPERVISOR.pid ? SUPERVISOR : GONE() }),
    reconcileDestination,
  })).rejects.toMatchObject({ code: "LEGACY_RUNTIME_ACTIVE", identities: { activeDaemon: false, activeSupervisors: [SUPERVISOR] } });
  expect(reconcileDestination).not.toHaveBeenCalled();
  await expect(stat(join(paths.destinationRoot, "daemon"))).rejects.toMatchObject({ code: "ENOENT" });
});
