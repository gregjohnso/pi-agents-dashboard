import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runDashboardApp } from "../app/standalone.mjs";
import { migrateLegacyState } from "../runtime/state-migration.mjs";
import { expectDaemonCommand } from "./daemon-command-assertions.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const harness = createRealProcessHarness("migration");

afterEach(() => harness.cleanup());

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
    connectOrStart: async ({ root }) => ({ root, clientId: "migration-acceptance", async close() {} }),
    openList: async () => ({ closed: Promise.resolve(), async close() {} }),
  });
  const status = await harness.daemon("status", { root: destinationRoot });
  expectDaemonCommand("status", status, { code: 0, result: { publication: { pid: expect.any(Number) } } });
  // `migrateLegacyState` starts this daemon through `reconcileDestination`, deep enough that the
  // harness never sees its spawn. Recording the published identity here is the earliest point a
  // later timeout can still be reaped from; a timeout inside `runDashboardApp` above still leaks.
  await harness.record("reconciled destination daemon", status.result.publication);
  const secondStart = await harness.daemon("start", { root: destinationRoot });
  expectDaemonCommand("start", secondStart, { code: 0, result: { alreadyRunning: true, publication: { pid: status.result.publication.pid } } });
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
