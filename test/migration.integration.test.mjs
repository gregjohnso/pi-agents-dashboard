import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { runDashboardApp } from "../app/standalone.mjs";
import { runDaemonCommand } from "../cli/daemon-commands.mjs";
import { migrateLegacyState } from "../runtime/state-migration.mjs";

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

it("publishes and reconciles exactly one real destination daemon", async () => {
  const parent = await mkdtemp(join(tmpdir(), "migration-real-daemon-"));
  const legacyRoot = join(parent, "pi-agents-dashboard");
  const destinationRoot = join(parent, "pi-agents");
  await mkdir(legacyRoot, { mode: 0o700 });
  await writeFile(join(legacyRoot, "dashboard.json"), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  try {
    await runDashboardApp({
      cwd: parent,
      env: { HOME: parent, XDG_STATE_HOME: parent, XDG_RUNTIME_DIR: join(parent, "runtime") },
      initialize: async () => {},
      connectOrStart: async ({ root }) => ({ root, clientId: "migration-acceptance", async close() {} }),
      openList: async () => ({ closed: Promise.resolve(), async close() {} }),
    });
    const status = await runDaemonCommand("status", { root: destinationRoot });
    expect(status).toMatchObject({ code: 0, result: { publication: { pid: expect.any(Number) } } });
    const secondStart = await runDaemonCommand("start", { root: destinationRoot });
    expect(secondStart).toMatchObject({ code: 0, result: { alreadyRunning: true, publication: { pid: status.result.publication.pid } } });
  } finally {
    await runDaemonCommand("stop", { root: destinationRoot }).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
}, 20_000);

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
