import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { createNativeBackend } from "./native-backend.mjs";
import { createSavedOwnerRecord, writeSavedOwnerSnapshot } from "../../examples/native-session-demo/saved-owner-record.mjs";
import { writeOwnerRecord } from "../../examples/native-session-demo/demo-root.mjs";
import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(change = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "pia-unreported-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const sessionsHome = path.join(directory, "runtime");
  const stateHome = path.join(directory, "records");
  const root = path.join(sessionsHome, "session-1700000000001");
  await mkdir(root, { recursive: true });
  const owner = await inspectProcessIdentity(process.pid);
  const record = await createSavedOwnerRecord({ recordsHome: stateHome, sessionId: path.basename(root), runtimeRoot: root });
  const snapshot = { sequence: 1, owner: { ...owner }, facts: { sessionId: "pi-current", sessionFile: "/pi/current.jsonl", sessionName: "my running session" } };
  const creation = { root, owner: { ...owner }, durable: { ownerId: record.ownerId } };
  const settings = { record, snapshot, creation };
  change(settings);
  await writeSavedOwnerSnapshot(record, snapshot);
  await record.close();
  if (settings.creation !== undefined) await writeOwnerRecord(root, settings.creation);
  const client = createNativeBackend({ sessionsHome, stateHome, askControl: async () => ({ reachable: false, reason: "status reply timed out" }) });
  cleanup.push(() => client.close());
  return { client, root, owner, ownerId: record.ownerId };
}

it("shows one actionable live row with unknown agent state when the exact saved owner process still exists", async () => {
  const f = await fixture();
  const { sessions } = await f.client.getState();
  expect(sessions).toHaveLength(1);
  const row = sessions[0];
  expect(row.sessionId).toBe(path.basename(f.root));
  expect(row.processState).toBe("LIVE");
  expect(row.stateReported).toBe(false);
  expect(row.native.ownerPid).toBe(f.owner.pid);
  expect(row.native.startIdentity).toBe(f.owner.startIdentity);
  expect(row.native.modelIsObserved).toBe(false);
  expect(row.activity.summary).toContain("manager status unavailable");
  expect(row.durable.ownerId).toBe(f.ownerId);
  expect(row.durable.savedOnly).toBe(false);
  expect(f.client.rootFor(row.sessionId)).toBe(f.root);
});

it.each([
  ["reused PID", ({ snapshot, creation }) => { snapshot.owner.startIdentity = "1"; creation.owner.startIdentity = "1"; }],
  ["different process group", ({ snapshot, creation }) => { snapshot.owner.processGroupId += 1; creation.owner.processGroupId += 1; }],
  ["different runtime home", ({ record }) => { record.runtimeRoot = "/another-home/session-1700000000001"; }],
  ["different creation owner", ({ creation }) => { creation.owner.startIdentity = "1"; }],
  ["recorded exit", ({ snapshot }) => { snapshot.exit = { code: 0, signal: null }; }],
  ["missing runtime metadata", (settings) => { settings.creation = undefined; }],
])("does not join an unresponsive runtime with %s", async (_name, change) => {
  const f = await fixture(change);
  const { sessions } = await f.client.getState();
  expect(sessions).toHaveLength(2);
  expect(sessions.find((row) => row.sessionId === path.basename(f.root)).processState).toBe("STALE");
  expect(sessions.some((row) => row.durable?.ownerId === f.ownerId && row.durable?.savedOnly === true)).toBe(true);
});
