import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { atomicWriteJson } from "./atomic-file.mjs";
import { RegistryStore } from "./registry-store.mjs";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** @param {{ atomicWrite?: (path: string, value: unknown) => Promise<void> }} [options] */
async function makeRegistry(options) {
  const root = await mkdtemp(join(tmpdir(), "dashboard-registry-"));
  cleanup.push(root);
  const sessions = join(root, "sessions");
  await mkdir(sessions, { mode: 0o700 });
  return { sessions, store: new RegistryStore(sessions, options) };
}

/** @param {string} sessionId @param {Partial<import("../shared/contracts.js").SessionRecord>} [overrides] */
function record(sessionId, overrides = {}) {
  const now = "2026-08-25T12:00:00.000Z";
  return /** @type {import("../shared/contracts.js").SessionRecord} */ ({
    schemaVersion: 1,
    revision: 0,
    sessionId,
    sessionFile: `/pi/sessions/${sessionId}.jsonl`,
    canonicalSessionFile: `/pi/sessions/${sessionId}.jsonl`,
    cwd: "/repo",
    taskState: "READY",
    processState: "EXITED",
    outcome: "NONE",
    activity: { kind: "saved_session", summary: "Imported session", updatedAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

it("creates and lists imported records with Task 5 canonical identity unchanged", async () => {
  const { sessions, store } = await makeRegistry();
  const imported = record("imported", {
    sessionFile: "/pi/sessions/aliases/../imported.jsonl",
    canonicalSessionFile: "/pi/sessions/imported.jsonl",
  });

  await expect(store.create(imported)).resolves.toEqual(imported);
  await expect(store.get("imported")).resolves.toEqual(imported);
  await expect(store.list()).resolves.toEqual([imported]);
  expect((await fs.stat(join(sessions, "imported.json"))).mode & 0o777).toBe(0o600);
});

it("uses compare-and-swap revisions and retains canonical session identity", async () => {
  const { store } = await makeRegistry();
  await store.create(record("one"));

  const updated = await store.update("one", 0, {
    taskState: "WORKING",
    processState: "LIVE",
    updatedAt: "2026-08-25T12:00:01.000Z",
  });

  expect(updated).toMatchObject({
    sessionId: "one",
    canonicalSessionFile: "/pi/sessions/one.jsonl",
    revision: 1,
    taskState: "WORKING",
  });
  await expect(store.update("one", 0, { taskState: "FAILED" })).rejects.toMatchObject({
    code: "REVISION_CONFLICT",
    expectedRevision: 0,
    actualRevision: 1,
  });
});

it("refuses duplicate canonical session files across session IDs", async () => {
  const { store } = await makeRegistry();
  await store.create(record("one"));

  await expect(
    store.create(record("two", { canonicalSessionFile: "/pi/sessions/one.jsonl" })),
  ).rejects.toMatchObject({
    code: "CANONICAL_SESSION_CONFLICT",
    canonicalSessionFile: "/pi/sessions/one.jsonl",
    existingSessionId: "one",
  });
  await expect(store.list()).resolves.toEqual([record("one")]);
});

it("refuses corrupted registry JSON without rewriting it", async () => {
  const { sessions, store } = await makeRegistry();
  const path = join(sessions, "broken.json");
  await writeFile(path, '{"sessionId":', { mode: 0o600 });

  await expect(store.get("broken")).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  await expect(store.list()).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  expect(await readFile(path, "utf8")).toBe('{"sessionId":');
});

it("keeps the last complete revision when an atomic update fails", async () => {
  let writes = 0;
  const atomicWrite = async (/** @type {string} */ path, /** @type {unknown} */ value) => {
    writes += 1;
    if (writes === 2) throw new Error("injected publication failure");
    await atomicWriteJson(path, value);
  };
  const { store } = await makeRegistry({ atomicWrite });
  const original = record("recoverable");
  await store.create(original);

  await expect(store.update("recoverable", 0, { taskState: "WORKING" })).rejects.toThrow(
    "injected publication failure",
  );
  await expect(store.get("recoverable")).resolves.toEqual(original);
  await expect(
    store.update("recoverable", 0, {
      taskState: "WORKING",
      updatedAt: "2026-08-25T12:00:01.000Z",
    }),
  ).resolves.toMatchObject({ revision: 1, taskState: "WORKING" });
});

it("refuses update attempts that replace the canonical identity", async () => {
  const { store } = await makeRegistry();
  await store.create(record("one"));

  await expect(
    store.update("one", 0, { canonicalSessionFile: "/pi/sessions/other.jsonl" }),
  ).rejects.toMatchObject({ code: "IMMUTABLE_SESSION_IDENTITY" });
  await expect(store.get("one")).resolves.toEqual(record("one"));
});
