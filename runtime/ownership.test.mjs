import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { atomicWriteJson } from "./atomic-file.mjs";
import { OwnershipManager } from "./ownership.mjs";
import { RegistryStore } from "./registry-store.mjs";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function record(sessionId = "session-1") {
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
    activity: { kind: "saved_session", summary: "Saved session", updatedAt: now },
    createdAt: now,
    updatedAt: now,
  });
}

async function makeOwnership(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dashboard-ownership-"));
  cleanup.push(root);
  const sessions = join(root, "sessions");
  await mkdir(sessions, { mode: 0o700 });
  const registry = new RegistryStore(sessions);
  await registry.create(record());
  return { sessions, registry, ownership: new OwnershipManager(registry, options) };
}

const worker = { pid: 101, startIdentity: "worker-start", processGroupId: 101 };
const piChild = { pid: 102, startIdentity: "pi-start", processGroupId: 101 };

it("permits one writer under simultaneous resume", async () => {
  const { ownership } = await makeOwnership();
  const canonicalFile = "/pi/sessions/session-1.jsonl";

  const [a, b] = await Promise.allSettled([
    ownership.acquire("session-1", canonicalFile, "run-a"),
    ownership.acquire("session-1", canonicalFile, "run-b"),
  ]);

  expect([a, b].filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const conflict = [a, b].find((result) => result.status === "rejected");
  if (conflict?.status !== "rejected") throw new Error("Expected one ownership conflict");
  expect(conflict.reason).toMatchObject({ code: "OWNERSHIP_CONFLICT" });
});

it("permits one writer across managers backed by separate stores for one directory", async () => {
  const { sessions, ownership: a } = await makeOwnership();
  const b = new OwnershipManager(new RegistryStore(`${sessions}/.`));
  const canonicalFile = "/pi/sessions/session-1.jsonl";

  const results = await Promise.allSettled([
    a.acquire("session-1", canonicalFile, "run-a"),
    b.acquire("session-1", canonicalFile, "run-b"),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const conflict = results.find((result) => result.status === "rejected");
  if (conflict?.status !== "rejected") throw new Error("Expected one ownership conflict");
  expect(conflict.reason).toMatchObject({ code: "OWNERSHIP_CONFLICT" });
});

it("binds the lease to the frozen managed ownership contract and updates heartbeat", async () => {
  const times = [
    "2026-08-25T12:00:01.000Z",
    "2026-08-25T12:00:02.000Z",
  ];
  const { registry, ownership } = await makeOwnership({
    now: () => times.shift(),
    randomId: () => "lease-1",
  });
  const lease = await ownership.acquire(
    "session-1",
    "/pi/sessions/session-1.jsonl",
    "run-1",
  );

  await expect(
    ownership.bindProcesses("session-1", lease.leaseId, lease.generation, worker, piChild),
  ).resolves.toEqual({
    ...lease,
    worker,
    piChild,
  });
  expect(await registry.get("session-1")).toMatchObject({
    revision: 1,
    processState: "LIVE",
    latestRunId: "run-1",
    ownership: {
      kind: "managed",
      runId: "run-1",
      process: worker,
      acquiredAt: "2026-08-25T12:00:01.000Z",
      heartbeatAt: "2026-08-25T12:00:01.000Z",
    },
  });

  await expect(
    ownership.heartbeat("session-1", lease.leaseId, lease.generation),
  ).resolves.toMatchObject({
    revision: 2,
    ownership: { heartbeatAt: "2026-08-25T12:00:02.000Z" },
  });
});

it("rejects a stale worker hello and stale release after lease generation advances", async () => {
  const leaseIds = ["lease-old", "lease-current"];
  const { registry, ownership } = await makeOwnership({ randomId: () => leaseIds.shift() });
  const oldLease = await ownership.acquire(
    "session-1",
    "/pi/sessions/session-1.jsonl",
    "run-old",
  );
  await expect(
    ownership.release("session-1", oldLease.leaseId, oldLease.generation),
  ).resolves.toBe(true);
  const currentLease = await ownership.acquire(
    "session-1",
    "/pi/sessions/session-1.jsonl",
    "run-current",
  );

  await expect(
    ownership.bindProcesses(
      "session-1",
      oldLease.leaseId,
      oldLease.generation,
      worker,
      piChild,
    ),
  ).rejects.toMatchObject({ code: "STALE_LEASE" });
  await expect(
    ownership.release("session-1", oldLease.leaseId, oldLease.generation),
  ).resolves.toBe(false);
  await ownership.bindProcesses(
    "session-1",
    currentLease.leaseId,
    currentLease.generation,
    worker,
    piChild,
  );
  expect(await registry.get("session-1")).toMatchObject({
    ownership: { runId: "run-current" },
  });
});

it("uses generation with a repeated lease ID to reject stale bind, heartbeat, and release", async () => {
  const { registry, ownership } = await makeOwnership({ randomId: () => "repeated-lease" });
  const oldLease = await ownership.acquire(
    "session-1",
    "/pi/sessions/session-1.jsonl",
    "run-old",
  );
  await ownership.bindProcesses("session-1", oldLease.leaseId, oldLease.generation, worker, piChild);
  await ownership.release("session-1", oldLease.leaseId, oldLease.generation);
  const currentLease = await ownership.acquire(
    "session-1",
    "/pi/sessions/session-1.jsonl",
    "run-current",
  );
  await ownership.bindProcesses(
    "session-1",
    currentLease.leaseId,
    currentLease.generation,
    worker,
    piChild,
  );

  await expect(
    ownership.bindProcesses("session-1", oldLease.leaseId, oldLease.generation, worker, piChild),
  ).rejects.toMatchObject({ code: "STALE_LEASE" });
  await expect(
    ownership.heartbeat("session-1", oldLease.leaseId, oldLease.generation),
  ).rejects.toMatchObject({ code: "STALE_LEASE" });
  await expect(
    ownership.release("session-1", oldLease.leaseId, oldLease.generation),
  ).resolves.toBe(false);
  expect(await registry.get("session-1")).toMatchObject({
    ownership: { runId: "run-current" },
  });
});

it("reconciles ownership published before an atomic writer reports failure", async () => {
  let writes = 0;
  const atomicWrite = async (/** @type {string} */ path, /** @type {unknown} */ value) => {
    writes += 1;
    await atomicWriteJson(path, value);
    if (writes === 2 || writes === 3) throw new Error("injected directory sync failure");
  };
  const root = await mkdtemp(join(tmpdir(), "dashboard-ownership-ambiguous-"));
  cleanup.push(root);
  const sessions = join(root, "sessions");
  await mkdir(sessions, { mode: 0o700 });
  const registry = new RegistryStore(sessions, { atomicWrite });
  await registry.create(record());
  const ownership = new OwnershipManager(registry, {
    now: () => "2026-08-25T12:00:01.000Z",
    randomId: () => "lease-1",
  });
  const lease = await ownership.acquire(
    "session-1",
    "/pi/sessions/session-1.jsonl",
    "run-1",
  );

  await expect(
    ownership.bindProcesses("session-1", lease.leaseId, lease.generation, worker, piChild),
  ).resolves.toMatchObject({ worker, piChild });
  expect((await registry.get("session-1"))?.ownership).toMatchObject({ runId: "run-1" });
  await expect(
    ownership.release("session-1", lease.leaseId, lease.generation),
  ).resolves.toBe(true);
  expect((await registry.get("session-1"))?.ownership).toBeUndefined();
});

it("releases matching durable ownership while the local lease is still pending", async () => {
  const acquiredAt = "2026-08-25T12:00:01.000Z";
  const { registry, ownership } = await makeOwnership({
    now: () => acquiredAt,
    randomId: () => "lease-1",
  });
  const lease = await ownership.acquire(
    "session-1",
    "/pi/sessions/session-1.jsonl",
    "run-1",
  );
  await registry.update("session-1", 0, {
    processState: "LIVE",
    updatedAt: acquiredAt,
    ownership: {
      kind: "managed",
      runId: lease.runId,
      process: worker,
      acquiredAt: lease.acquiredAt,
      heartbeatAt: lease.acquiredAt,
    },
  });

  await expect(
    ownership.release("session-1", lease.leaseId, lease.generation),
  ).resolves.toBe(true);
  expect(await registry.get("session-1")).toMatchObject({ revision: 2, processState: "EXITED" });
  expect((await registry.get("session-1"))?.ownership).toBeUndefined();
});

it("releases only the current bound owner", async () => {
  const { registry, ownership } = await makeOwnership({ randomId: () => "lease-1" });
  const lease = await ownership.acquire(
    "session-1",
    "/pi/sessions/session-1.jsonl",
    "run-1",
  );
  await ownership.bindProcesses("session-1", lease.leaseId, lease.generation, worker, piChild);

  await expect(
    ownership.release("session-1", "foreign-lease", lease.generation),
  ).resolves.toBe(false);
  expect((await registry.get("session-1"))?.ownership).toBeDefined();
  await expect(
    ownership.release("session-1", lease.leaseId, lease.generation),
  ).resolves.toBe(true);
  expect(await registry.get("session-1")).toMatchObject({ processState: "EXITED", revision: 2 });
  expect((await registry.get("session-1"))?.ownership).toBeUndefined();
});

it("refuses an ownership claim that does not use the record's canonical session file", async () => {
  const { ownership } = await makeOwnership();

  await expect(
    ownership.acquire("session-1", "/pi/sessions/alias.jsonl", "run-1"),
  ).rejects.toMatchObject({
    code: "CANONICAL_SESSION_MISMATCH",
    canonicalSessionFile: "/pi/sessions/session-1.jsonl",
  });
});

it("conflicts with durable ownership recovered from the registry", async () => {
  const { registry } = await makeOwnership();
  await registry.update("session-1", 0, {
    processState: "LIVE",
    ownership: {
      kind: "managed",
      runId: "existing-run",
      process: worker,
      acquiredAt: "2026-08-25T12:00:01.000Z",
      heartbeatAt: "2026-08-25T12:00:02.000Z",
    },
  });
  const recovered = new OwnershipManager(registry);

  await expect(
    recovered.acquire("session-1", "/pi/sessions/session-1.jsonl", "new-run"),
  ).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT", ownerRunId: "existing-run" });
});
