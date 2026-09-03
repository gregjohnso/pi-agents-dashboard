import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, it } from "vitest";

import { runDashboardApp } from "../app/standalone.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { reconcileRuntime } from "../runtime/reconciliation.mjs";
import { inspectRuntimeActivity } from "../runtime/runtime-activity.mjs";
import { migrateLegacyState } from "../runtime/state-migration.mjs";
import { expectDaemonCommand } from "./daemon-command-assertions.mjs";
import { readProcessLedger } from "./process-ledger.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const harness = createRealProcessHarness("migration");

afterEach(() => harness.cleanup());

/** @param {{ pid: number, startIdentity: string, processGroupId: number }} identity */
async function processMatches(identity) {
  try {
    const actual = await inspectProcessIdentity(identity.pid);
    return actual.pid === identity.pid && actual.startIdentity === identity.startIdentity && actual.processGroupId === identity.processGroupId;
  } catch {
    return false;
  }
}

async function attempt(mutator, expectedCode) {
  const parent = await mkdtemp(join(tmpdir(), "migration-unsafe-"));
  const legacyRoot = join(parent, "pi-agents-dashboard");
  const destinationRoot = join(parent, "pi-agents");
  await mkdir(legacyRoot, { mode: 0o700 });
  await writeFile(join(legacyRoot, "dashboard.json"), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  try {
    await mutator({ parent, legacyRoot, destinationRoot });
    await expect(migrateLegacyState({
      legacyRoot, destinationRoot, expectedUserId: process.getuid(),
      inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [] }),
      reconcileDestination: async () => {},
    })).rejects.toMatchObject({ code: expectedCode });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

// The real daemon start here is the one `migrateLegacyState` makes through `reconcileDestination`,
// so this test's own budget, not a `timeoutMs` argument, is the only thing that can cut it short. It
// has to exceed the command's 90 s startup deadline, or a hung daemon reads as a bare test timeout
// with no cause instead of DAEMON_START_FAILED and the daemon's own captured stderr.
it("publishes and reconciles exactly one real destination daemon", async () => {
  const parent = await harness.stateRoot("migration-real-daemon-");
  const legacyRoot = join(parent, "pi-agents-dashboard");
  const destinationRoot = harness.daemonRoot(join(parent, "pi-agents"));
  await mkdir(legacyRoot, { mode: 0o700 });
  await writeFile(join(legacyRoot, "dashboard.json"), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  await runDashboardApp({
    cwd: parent,
    env: { HOME: parent, XDG_STATE_HOME: parent, XDG_RUNTIME_DIR: join(parent, "runtime") },
    initialize: async () => {},
    startDaemon: (options) => harness.daemon("start", options),
    connectOrStart: async ({ root }) => ({ root, clientId: "migration-acceptance", async close() {} }),
    openList: async () => ({ closed: Promise.resolve(), async close() {} }),
  });
  const status = await harness.daemon("status", { root: destinationRoot });
  expectDaemonCommand("status", status, { code: 0, result: { publication: { pid: expect.any(Number) } } });
  expect((await readProcessLedger(harness.ledgerPath())).processes).toEqual([
    { label: expect.stringContaining("daemon child"), identity: expect.objectContaining({ pid: status.result.publication.pid, startIdentity: status.result.publication.startIdentity, processGroupId: status.result.publication.processGroupId }) },
  ]);
  const secondStart = await harness.daemon("start", { root: destinationRoot });
  expectDaemonCommand("start", secondStart, { code: 0, result: { alreadyRunning: true, publication: { pid: status.result.publication.pid } } });
}, 120_000);

it("records and reaps a destination daemon when the application times out before publication", async () => {
  const parent = await harness.stateRoot("migration-delayed-daemon-");
  const legacyRoot = join(parent, "pi-agents-dashboard");
  const destinationRoot = harness.daemonRoot(join(parent, "pi-agents"));
  const delayedImport = join(parent, "delay-daemon-start.mjs");
  await mkdir(legacyRoot, { mode: 0o700 });
  await writeFile(join(legacyRoot, "dashboard.json"), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  await writeFile(delayedImport, "await new Promise((resolve) => setTimeout(resolve, 60_000));\n", { mode: 0o600 });
  const env = { ...process.env, HOME: parent, XDG_STATE_HOME: parent, XDG_RUNTIME_DIR: join(parent, "runtime"), NODE_OPTIONS: `--import=${delayedImport}` };
  const application = runDashboardApp({
    cwd: parent,
    env,
    initialize: async () => {},
    startDaemon: (options) => harness.daemon("start", { ...options, env, timeoutMs: 60_000 }),
    connectOrStart: async ({ root }) => ({ root, clientId: "migration-timeout", async close() {} }),
    openList: async () => ({ closed: Promise.resolve(), async close() {} }),
  });
  const applicationOutcome = application.then(() => undefined, (error) => error);

  expect(await Promise.race([applicationOutcome.then(() => "settled"), delay(250, "publication timeout")])).toBe("publication timeout");
  await expect.poll(async () => {
    try { return (await readProcessLedger(harness.ledgerPath())).processes; } catch { return []; }
  }, { timeout: 5_000 }).toHaveLength(1);
  const [recorded] = (await readProcessLedger(harness.ledgerPath())).processes;
  expect(await processMatches(recorded.identity)).toBe(true);

  await harness.cleanup();

  expect(await processMatches(recorded.identity)).toBe(false);
  expect(await applicationOutcome).toMatchObject({ code: "DAEMON_START_FAILED" });
}, 120_000);

it.each([
  ["a group-readable legacy root", async ({ legacyRoot }) => chmod(legacyRoot, 0o755), "UNSAFE_LEGACY_STATE"],
  ["a group-readable destination root", async ({ destinationRoot }) => mkdir(destinationRoot, { mode: 0o755 }), "UNSAFE_DESTINATION_STATE"],
  ["a symlinked legacy artifact", async ({ parent, legacyRoot }) => {
    await writeFile(join(parent, "target"), "{}", { mode: 0o600 });
    await symlink(join(parent, "target"), join(legacyRoot, "linked.json"));
  }, "UNSAFE_LEGACY_STATE"],
  ["malformed legacy configuration", async ({ legacyRoot }) => writeFile(join(legacyRoot, "dashboard.json"), "not json", { mode: 0o600 }), "MALFORMED_LEGACY_STATE"],
  ["an interrupted manifest from another migration", async ({ destinationRoot }) => {
    await mkdir(destinationRoot, { mode: 0o700 });
    await writeFile(join(destinationRoot, "migration-manifest.json"), JSON.stringify({ schemaVersion: 1, migrationId: "other", sourceIdentity: "other", state: "COMPLETED" }), { mode: 0o600 });
  }, "MIGRATION_IDENTITY_MISMATCH"],
])("fails closed on %s", (_label, mutate, code) => attempt(mutate, code));

// Operator-visible failure: the crash that ended a run is bound to identities spread across the
// roster, the session record, and the run's own cause file. A partial carry fails silently — the
// destination daemon reads no cause, records a generic worker exit, and the operator never learns
// that Pi crashed. The socket path the roster carries has to land inside the destination too,
// because retiring a dead run unlinks it, and a legacy path would reach back into the source root
// this migration just declared preserved.
it("carries a dead run's crash cause and run socket into the destination daemon's reconciliation", async () => {
  const parent = await harness.stateRoot("migration-dead-run-");
  const legacyRoot = join(parent, "pi-agents-dashboard");
  const destinationRoot = join(parent, "pi-agents");
  const supervisor = { pid: 424_242, startIdentity: "dead-worker", processGroupId: 424_242 };
  const piChild = { pid: 424_243, startIdentity: "dead-child", processGroupId: 424_242 };
  const socketName = "0a1b2c3d4e5f6071.sock";
  const at = "2026-08-25T12:00:00.000Z";
  await mkdir(join(legacyRoot, "daemon", "workers"), { recursive: true, mode: 0o700 });
  await mkdir(join(legacyRoot, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(legacyRoot, "runs", "a2f9c1"), { recursive: true, mode: 0o700 });
  await writeFile(join(legacyRoot, "dashboard.json"), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  await writeFile(join(legacyRoot, "sessions", "one.json"), `${JSON.stringify({
    schemaVersion: 1, revision: 0, sessionId: "one", sessionFile: join(parent, "sessions", "one.jsonl"), canonicalSessionFile: join(parent, "sessions", "one.jsonl"),
    cwd: parent, taskState: "WORKING", processState: "LIVE", outcome: "NONE",
    activity: { kind: "worker", summary: "running", updatedAt: at },
    ownership: { kind: "managed", runId: "run-one", process: supervisor, acquiredAt: at, heartbeatAt: at },
    latestRunId: "run-one", runHash: "a2f9c1", createdAt: at, updatedAt: at,
  })}\n`, { mode: 0o600 });
  await writeFile(join(legacyRoot, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, identity: supervisor, piChildIdentity: piChild, token: "run-token", socketPath: join(legacyRoot, "daemon", "workers", socketName), proto: 2 }] })}\n`, { mode: 0o600 });
  const cause = `${JSON.stringify({ schemaVersion: 1, sessionId: "one", runId: "run-one", leaseId: "lease-one", generation: 1, worker: supervisor, piChild, event: { type: "PI_CHILD_CRASHED", at: "2026-08-25T12:01:00.000Z", summary: "Pi exited unexpectedly (SIGSEGV)" } })}\n`;
  await writeFile(join(legacyRoot, "runs", "a2f9c1", "terminal-cause.json"), cause, { mode: 0o600 });

  const gone = async () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
  /** @type {any} */
  let recovered;
  await expect(migrateLegacyState({
    legacyRoot, destinationRoot, expectedUserId: process.getuid(),
    inspectLegacyRuntime: () => inspectRuntimeActivity({ stateRoot: legacyRoot, exists: async () => true, inspectEndpoint: async () => ({ status: "ABSENT" }), inspect: gone }),
    reconcileDestination: async ({ root }) => {
      // Stand a file at both socket paths, after the source was read, so the unlink that retires this
      // dead run names one of them and the other proves which root it reached.
      for (const sockets of [legacyRoot, root]) await writeFile(join(sockets, "daemon", "workers", socketName), "", { mode: 0o600 });
      recovered = await reconcileRuntime({ root, daemonEpoch: "epoch", inspect: gone });
    },
  })).resolves.toMatchObject({ status: "MIGRATED" });

  expect(JSON.parse(await readFile(join(destinationRoot, "sessions", "one.json"), "utf8"))).toMatchObject({
    taskState: "FAILED", processState: "EXITED", activity: { kind: "process_error", summary: "Pi exited unexpectedly (SIGSEGV)" },
  });
  expect(JSON.parse(await readFile(join(destinationRoot, "sessions", "one.json"), "utf8")).ownership).toBeUndefined();
  await expect(stat(join(destinationRoot, "runs", "a2f9c1", "terminal-cause.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(destinationRoot, "daemon", "workers", socketName))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(legacyRoot, "runs", "a2f9c1", "terminal-cause.json"), "utf8")).toBe(cause);
  expect((await stat(join(legacyRoot, "daemon", "workers", socketName))).isFile()).toBe(true);
  await recovered.close();
}, 30_000);
