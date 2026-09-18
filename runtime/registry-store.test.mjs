import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, it } from "vitest";

import { atomicWriteJson } from "./atomic-file.mjs";
import { RegistryStore, applySessionColor, registryCoordinationScope, runSessionLifecycle } from "./registry-store.mjs";

/** Replace one store's update with a version that lets background churn win the race first. @param {RegistryStore} store @param {string} sessionId @param {number} losses */
function loseColorRaces(store, sessionId, losses) {
  const real = store.update.bind(store);
  const attempts = { count: 0 };
  store.update = async (/** @type {string} */ id, /** @type {number} */ revision, /** @type {any} */ update) => {
    attempts.count += 1;
    if (attempts.count <= losses) {
      const current = await store.get(sessionId);
      await real(sessionId, /** @type {number} */ (current?.revision), { activity: { kind: "assistant_stream", summary: `churn ${attempts.count}`, updatedAt: "2026-08-25T12:00:02.000Z" } });
    }
    return real(id, revision, update);
  };
  return attempts;
}

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

/** @param {string} sessionId @param {Partial<import("../shared/contracts.mjs").SessionRecord>} [overrides] */
function record(sessionId, overrides = {}) {
  const now = "2026-08-25T12:00:00.000Z";
  return /** @type {import("../shared/contracts.mjs").SessionRecord} */ ({
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

it("shares one reentrant lifecycle serializer across registry instances", async () => {
  const { sessions, store } = await makeRegistry();
  const other = new RegistryStore(`${sessions}/.`);
  /** @type {string[]} */
  const order = [];
  /** @type {((value?: unknown) => void) | undefined} */
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  /** @type {((value?: unknown) => void) | undefined} */
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const first = runSessionLifecycle(store, "exact", async () => {
    order.push("delete:checks");
    await registryCoordinationScope(other).lifecycle.runNested("exact", async () => { order.push("delete:nested-result"); });
    started?.();
    await gate;
    order.push("delete:done");
  });
  await firstStarted;
  const launch = runSessionLifecycle(other, "exact", async () => { order.push("launch"); });
  await Promise.resolve();
  expect(order).toEqual(["delete:checks", "delete:nested-result"]);
  release?.();
  await Promise.all([first, launch]);
  expect(order).toEqual(["delete:checks", "delete:nested-result", "delete:done", "launch"]);
});

it("removes only the exact compare-and-swap revision", async () => {
  const { sessions, store } = await makeRegistry();
  await store.create(record("remove-me"));
  await expect(store.remove("remove-me", 1)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(store.get("remove-me")).resolves.toBeDefined();
  await expect(store.remove("remove-me", 0)).resolves.toMatchObject({ sessionId: "remove-me" });
  await expect(store.get("remove-me")).resolves.toBeUndefined();
  await expect(fs.access(join(sessions, "remove-me.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("coordinates compare-and-swap updates across stores for one canonical directory", async () => {
  const { sessions, store } = await makeRegistry();
  await store.create(record("one"));
  const delayedWrite = async (/** @type {string} */ path, /** @type {unknown} */ value) => {
    await delay(10);
    await atomicWriteJson(path, value);
  };
  const a = new RegistryStore(sessions, { atomicWrite: delayedWrite });
  const b = new RegistryStore(`${sessions}/.`, { atomicWrite: delayedWrite });

  const results = await Promise.allSettled([
    a.update("one", 0, { taskState: "WORKING" }),
    b.update("one", 0, { taskState: "FAILED" }),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const conflict = results.find((result) => result.status === "rejected");
  if (conflict?.status !== "rejected") throw new Error("Expected one revision conflict");
  expect(conflict.reason).toMatchObject({ code: "REVISION_CONFLICT", actualRevision: 1 });
});

it("coordinates canonical-file uniqueness across stores for one directory", async () => {
  const { sessions } = await makeRegistry();
  const delayedWrite = async (/** @type {string} */ path, /** @type {unknown} */ value) => {
    await delay(10);
    await atomicWriteJson(path, value);
  };
  const a = new RegistryStore(sessions, { atomicWrite: delayedWrite });
  const b = new RegistryStore(sessions, { atomicWrite: delayedWrite });
  const canonicalSessionFile = "/pi/sessions/shared.jsonl";

  const results = await Promise.allSettled([
    a.create(record("one", { canonicalSessionFile })),
    b.create(record("two", { canonicalSessionFile })),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const conflict = results.find((result) => result.status === "rejected");
  if (conflict?.status !== "rejected") throw new Error("Expected one canonical conflict");
  expect(conflict.reason).toMatchObject({ code: "CANONICAL_SESSION_CONFLICT" });
});

it("refuses corrupted registry JSON without rewriting it", async () => {
  const { sessions, store } = await makeRegistry();
  const path = join(sessions, "broken.json");
  await writeFile(path, '{"sessionId":', { mode: 0o600 });

  await expect(store.get("broken")).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  await expect(store.list()).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  expect(await readFile(path, "utf8")).toBe('{"sessionId":');
});

it.each([
  ["worktree isolation", { isolation: { mode: "worktree", worktreePath: "/repo" } }],
  ["unknown field", { unexpected: true }],
])("refuses valid JSON with invalid %s", async (_label, overrides) => {
  const { sessions, store } = await makeRegistry();
  const path = join(sessions, "invalid.json");
  await writeFile(
    path,
    `${JSON.stringify(record("invalid", /** @type {any} */ (overrides)))}\n`,
    { mode: 0o600 },
  );

  await expect(store.get("invalid")).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
});

it("refuses a record whose session ID differs from its registry filename", async () => {
  const { sessions, store } = await makeRegistry();
  await writeFile(join(sessions, "filename.json"), `${JSON.stringify(record("payload"))}\n`, {
    mode: 0o600,
  });

  await expect(store.get("filename")).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  await expect(store.list()).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
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

it("persists a session color and refuses one outside the palette", async () => {
  const { store } = await makeRegistry();
  const created = await store.create(record("colored"));
  const updated = await store.update("colored", created.revision, { color: "amber" });
  expect(updated.color).toBe("amber");
  expect((await store.get("colored"))?.color).toBe("amber");

  await expect(store.update("colored", updated.revision, { color: /** @type {any} */ ("chartreuse") })).rejects.toThrow(/color/i);
  const cleared = await store.update("colored", updated.revision, { color: undefined });
  expect(cleared.color).toBeUndefined();
});

it("applies a color write that loses a compare-and-swap race to background churn", async () => {
  const { store } = await makeRegistry();
  await store.create(record("colored"));
  const attempts = loseColorRaces(store, "colored", 1);

  await expect(applySessionColor(store, "colored", "amber")).resolves.toMatchObject({ color: "amber" });
  expect(attempts.count).toBe(2);
  expect(await store.get("colored")).toMatchObject({ color: "amber", activity: { summary: "churn 1" } });
});
