import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, it } from "vitest";

import { runDashboardApp } from "../app/standalone.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
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
