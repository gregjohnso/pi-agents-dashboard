import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createFrontendPersistence } from "./standalone-list.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-dashboard-frontend-state-"));
  roots.push(root);
  return join(root, "frontend-state.json");
}

it("fsyncs the private cursor file and parent directory around atomic publication", async () => {
  const path = await fixture();
  const stages = [];
  const persistence = createFrontendPersistence(path, "client", { failpoint: async (stage) => stages.push(stage) });
  await persistence.save({ schemaVersion: 1, clientId: "client", cursor: { daemonEpoch: "epoch", sequence: "1" }, viewState: { query: { view: "live" } }, launchDraft: {} });
  expect(stages).toEqual(["after_file_sync", "after_rename", "after_directory_sync"]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("does not replace the prior cursor when publication fails before rename", async () => {
  const path = await fixture();
  const original = { schemaVersion: 1, clientId: "client", cursor: { daemonEpoch: "epoch", sequence: "1" }, viewState: { query: { view: "live" } }, launchDraft: {} };
  await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const persistence = createFrontendPersistence(path, "client", { failpoint(stage) { if (stage === "after_file_sync") throw new Error("crash"); } });
  await expect(persistence.save({ ...original, cursor: { daemonEpoch: "epoch", sequence: "2" } })).rejects.toThrow("crash");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
});

it("refuses malformed or non-private cursor state", async () => {
  const path = await fixture();
  await writeFile(path, JSON.stringify({ schemaVersion: 1, clientId: "client", cursor: { daemonEpoch: "epoch", sequence: "01" } }), { mode: 0o644 });
  await expect(createFrontendPersistence(path, "client").load()).rejects.toMatchObject({ code: "FRONTEND_STATE_UNSAFE" });
});
