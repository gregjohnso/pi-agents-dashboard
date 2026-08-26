import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { migrateLegacyState } from "../runtime/state-migration.mjs";

async function attempt(mutator, expectedCode) {
  const parent = await mkdtemp(join(tmpdir(), "migration-invalid-"));
  const legacyRoot = join(parent, "pi-agents-dashboard");
  const destinationRoot = join(parent, "pi-dashboard");
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

it("fails closed on unsafe permissions", () => attempt(async ({ legacyRoot }) => {
  await (await import("node:fs/promises")).chmod(legacyRoot, 0o755);
}, "UNSAFE_LEGACY_STATE"));

it("fails closed on unsafe destination permissions", () => attempt(async ({ destinationRoot }) => {
  await mkdir(destinationRoot, { mode: 0o755 });
}, "UNSAFE_DESTINATION_STATE"));

it("fails closed on a symlinked legacy artifact", () => attempt(async ({ parent, legacyRoot }) => {
  await writeFile(join(parent, "target"), "{}", { mode: 0o600 });
  await symlink(join(parent, "target"), join(legacyRoot, "linked.json"));
}, "UNSAFE_LEGACY_STATE"));

it("fails closed on malformed legacy schema", () => attempt(async ({ legacyRoot }) => {
  await writeFile(join(legacyRoot, "dashboard.json"), "not json", { mode: 0o600 });
}, "MALFORMED_LEGACY_STATE"));

it("fails closed when an interrupted manifest identity changes", () => attempt(async ({ destinationRoot }) => {
  await mkdir(destinationRoot, { mode: 0o700 });
  await writeFile(join(destinationRoot, "migration-manifest.json"), JSON.stringify({ schemaVersion: 1, migrationId: "other", sourceIdentity: "other", state: "COMPLETED" }), { mode: 0o600 });
}, "MIGRATION_IDENTITY_MISMATCH"));

it("refuses an exact live legacy supervisor before staging and reports its identity", async () => {
  const parent = await mkdtemp(join(tmpdir(), "migration-live-supervisor-"));
  const legacyRoot = join(parent, "pi-agents-dashboard");
  const destinationRoot = join(parent, "pi-dashboard");
  const supervisor = { pid: 42, startIdentity: "legacy-42", processGroupId: 42 };
  await mkdir(legacyRoot, { mode: 0o700 });
  await writeFile(join(legacyRoot, "dashboard.json"), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  try {
    await expect(migrateLegacyState({
      legacyRoot,
      destinationRoot,
      expectedUserId: process.getuid(),
      inspectLegacyRuntime: async () => ({ activeDaemon: false, activeSupervisors: [supervisor] }),
      reconcileDestination: async () => { throw new Error("reconciliation must not start"); },
    })).rejects.toMatchObject({ code: "LEGACY_RUNTIME_ACTIVE", identities: { activeSupervisors: [supervisor] } });
    await expect(readFile(join(legacyRoot, "dashboard.json"), "utf8")).resolves.toContain('"schemaVersion":1');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
