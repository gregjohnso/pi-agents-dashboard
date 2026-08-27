import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

import { createCommandJournal } from "./command-journal.mjs";
import { createEventStore } from "./event-store.mjs";
import { RegistryStore } from "./registry-store.mjs";
import { RecoveredWorkerRouter, reconcileRuntime } from "./reconciliation.mjs";

/** @type {string[]} */
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** @param {string} sessionId @param {import("../shared/contracts.mjs").ProcessIdentity} identity @returns {import("../shared/contracts.mjs").SessionRecord} */
function record(sessionId, identity) {
  const now = "2026-08-25T12:00:00.000Z";
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    canonicalSessionFile: `/sessions/${sessionId}.jsonl`,
    cwd: "/repo",
    taskState: "WORKING",
    processState: "LIVE",
    outcome: "NONE",
    activity: { kind: "worker", summary: "running", updatedAt: now },
    ownership: { kind: "managed", runId: `run-${sessionId}`, process: identity, acquiredAt: now, heartbeatAt: now },
    latestRunId: `run-${sessionId}`,
    createdAt: now,
    updatedAt: now,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dashboard-recovery-"));
  roots.push(root);
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(root, name), { mode: 0o700 });
  return root;
}

it("initializes durable viewer recovery before admitting reconnect traffic", async () => {
  const root = await fixture();
  let viewerReady = false;
  const recovered = await reconcileRuntime({
    root,
    daemonEpoch: "epoch",
    inspect: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
    onViewerReady: async (viewer) => { viewerReady = viewer !== undefined; },
    waitForReconnect: async () => {
      expect(viewerReady).toBe(true);
      return [];
    },
  });
  expect(viewerReady).toBe(true);
  await recovered.close();
});

it("reopens truncated stores and converts unresolved delivery to DELIVERY_UNKNOWN", async () => {
  const root = await fixture();
  const journalPath = join(root, "queue", "commands.jsonl");
  const journal = await createCommandJournal({ path: journalPath });
  const command = /** @type {import("../shared/contracts.mjs").ClientRequest} */ ({ version: 1, clientId: "client", requestId: "request", op: "prompt", payload: { sessionId: "one", text: "hello" } });
  await journal.accept(command);
  await journal.transition(command, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
  await journal.close();
  await writeFile(join(root, "runs", "worker-replay.jsonl"), `${JSON.stringify({ clientId: "client", requestId: "request", op: "prompt", stage: "RECEIVED", at: "2026-08-25T12:00:00.000Z" })}\n`, { mode: 0o600 });
  await appendFile(journalPath, "{\"torn\":");

  const eventPath = join(root, "index", "events.jsonl");
  const events = await createEventStore({ path: eventPath, daemonEpoch: "epoch" });
  const persisted = await events.append({ kind: "attachment_changed", payload: { sessionId: "one", clientId: "client", role: "observer", attached: true } });
  await events.close();
  await appendFile(eventPath, "{\"torn\":");

  const recovered = await reconcileRuntime({ root, daemonEpoch: "epoch", inspect: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }, waitForReconnect: async () => [] });
  expect(await recovered.journal.get(command)).toMatchObject({ stage: "DELIVERY_UNKNOWN" });
  expect(recovered.recoveryActions).toContainEqual(expect.objectContaining({ clientId: "client", requestId: "request", sessionId: "one", action: "DELIVERY_AMBIGUOUS" }));
  expect(await recovered.events.replay()).toEqual([persisted]);
  await recovered.close();
  const secondRecovery = await reconcileRuntime({ root, daemonEpoch: "epoch", inspect: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } });
  expect(await secondRecovery.journal.get(command)).toMatchObject({ stage: "DELIVERY_UNKNOWN" });
  expect(await secondRecovery.events.replay()).toEqual([persisted]);
  await secondRecovery.close();
});

it("redelivers only ACCEPTED commands and never acknowledged or worker-local RECEIVED attempts", async () => {
  const root = await fixture();
  const journal = await createCommandJournal({ path: join(root, "queue", "commands.jsonl") });
  const accepted = /** @type {import("../shared/contracts.mjs").ClientRequest} */ ({ version: 1, clientId: "client", requestId: "accepted", op: "prompt", payload: { sessionId: "one", text: "safe" } });
  const acknowledged = /** @type {import("../shared/contracts.mjs").ClientRequest} */ ({ ...accepted, requestId: "acknowledged", payload: { ...accepted.payload, text: "done" } });
  await journal.accept(accepted);
  await journal.accept(acknowledged);
  await journal.transition(acknowledged, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
  await journal.transition(acknowledged, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
  await journal.close();
  const recovered = await reconcileRuntime({ root, daemonEpoch: "epoch", inspect: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } });
  expect(recovered.recoveryActions.map(({ clientId, requestId, sessionId, action }) => ({ clientId, requestId, sessionId, action }))).toEqual([
    { clientId: "client", requestId: "accepted", sessionId: "one", action: "SAFE_REDELIVERY" },
    { clientId: "client", requestId: "acknowledged", sessionId: "one", action: "NO_REDELIVERY" },
  ]);
  await recovered.close();
});

it("validates the authoritative Pi child and invalidates frames from replaced routes", async () => {
  const root = await fixture();
  const registry = new RegistryStore(join(root, "sessions"));
  const worker = { pid: 301, startIdentity: "worker", processGroupId: 301 };
  const piChild = { pid: 302, startIdentity: "pi-child", processGroupId: 301 };
  await registry.create(record("exact", worker));
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "exact", runId: "run-exact", leaseId: "lease-exact", generation: 4, identity: worker, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  let reusedPiChild = true;
  const router = new RecoveredWorkerRouter({
    registry,
    metadataPath: join(root, "daemon", "workers.json"),
    inspect: async (pid) => pid === worker.pid ? worker : reusedPiChild ? { ...piChild, startIdentity: "reused" } : piChild,
  });
  await router.load();
  const frame = { version: 1, type: "worker_ready", token: "worker-token", sessionId: "exact", runId: "run-exact", leaseId: "lease-exact", generation: 4, worker, piChild };
  const connection = () => {
    /** @type {(value?: unknown) => void} */
    let resolveClosed = () => {};
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    return { closed, close: () => resolveClosed(undefined) };
  };
  await expect(router.adopt(frame, connection())).rejects.toMatchObject({ code: "PROCESS_IDENTITY_CONFLICT" });
  reusedPiChild = false;
  const oldConnection = connection();
  const currentConnection = connection();
  const oldRoute = await router.adopt(frame, oldConnection);
  await router.adopt(frame, currentConnection);
  let mutated = false;
  await expect(router.runCurrent(oldRoute.metadata, oldConnection, oldRoute.routeGeneration, async () => { mutated = true; })).rejects.toMatchObject({ code: "STALE_WORKER_CONNECTION" });
  expect(mutated).toBe(false);
  await router.close();
});

it("finishes an accepted old command result before replacing its route", async () => {
  const root = await fixture();
  const registry = new RegistryStore(join(root, "sessions"));
  const worker = { pid: 401, startIdentity: "worker", processGroupId: 401 };
  const piChild = { pid: 402, startIdentity: "pi-child", processGroupId: 401 };
  await registry.create(record("barrier", worker));
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "barrier", runId: "run-barrier", leaseId: "lease-barrier", generation: 7, identity: worker, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseIdentity;
  /** @type {((value?: unknown) => void) | undefined} */
  let identityStarted;
  let blockIdentity = false;
  const identityStartedPromise = new Promise((resolve) => { identityStarted = resolve; });
  const identityGate = new Promise((resolve) => { releaseIdentity = resolve; });
  const router = new RecoveredWorkerRouter({
    registry,
    metadataPath: join(root, "daemon", "workers.json"),
    inspect: async (pid) => {
      if (blockIdentity) {
        identityStarted?.();
        await identityGate;
      }
      return pid === worker.pid ? worker : piChild;
    },
  });
  await router.load();
  const frame = { version: 1, type: "worker_ready", token: "worker-token", sessionId: "barrier", runId: "run-barrier", leaseId: "lease-barrier", generation: 7, worker, piChild };
  const connection = () => {
    /** @type {(value?: unknown) => void} */
    let resolveClosed = () => {};
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    return { closed, close: () => resolveClosed(undefined) };
  };
  const oldConnection = connection();
  const oldRoute = await router.adopt(frame, oldConnection);
  blockIdentity = true;
  const pending = new Map();
  const oldPending = { connection: oldConnection, routeGeneration: oldRoute.routeGeneration, sessionId: "barrier", runId: "run-barrier", leaseId: "lease-barrier", generation: 7, clientId: "client", requestId: "old", op: "prompt" };
  pending.set("shared-result-id", oldPending);
  const oldResult = router.runCurrent(oldRoute.metadata, oldConnection, oldRoute.routeGeneration, async () => {
    expect(pending.get("shared-result-id")).toBe(oldPending);
    pending.delete("shared-result-id");
    return "old-accepted";
  });
  await identityStartedPromise;
  const currentConnection = connection();
  let replacementSettled = false;
  const replacement = router.adopt(frame, currentConnection).finally(() => { replacementSettled = true; });
  await Promise.resolve();
  expect(replacementSettled).toBe(false);
  expect(router.route("barrier")?.connection).toBe(oldConnection);
  /** @type {(value?: unknown) => void} */ (releaseIdentity)();
  await expect(oldResult).resolves.toBe("old-accepted");
  const currentRoute = await replacement;
  expect(pending.has("shared-result-id")).toBe(false);

  const currentPending = { ...oldPending, connection: currentConnection, routeGeneration: currentRoute.routeGeneration, requestId: "current" };
  pending.set("shared-result-id", currentPending);
  await expect(router.runCurrent(currentRoute.metadata, currentConnection, currentRoute.routeGeneration, async () => {
    expect(pending.get("shared-result-id")).toBe(currentPending);
    pending.delete("shared-result-id");
    return "current-accepted";
  })).resolves.toBe("current-accepted");
  expect(pending.has("shared-result-id")).toBe(false);
  await router.close();
});

it("finishes every old worker-event side effect before route replacement advances", async () => {
  const root = await fixture();
  const registry = new RegistryStore(join(root, "sessions"));
  const worker = { pid: 501, startIdentity: "worker", processGroupId: 501 };
  await registry.create(record("event-old-first", worker));
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "event-old-first", runId: "run-event-old-first", leaseId: "lease-event", generation: 1, identity: worker, piChildIdentity: worker }] })}\n`, { mode: 0o600 });
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseIdentity;
  /** @type {((value?: unknown) => void) | undefined} */
  let identityStarted;
  let blockIdentity = false;
  const identityStartedPromise = new Promise((resolve) => { identityStarted = resolve; });
  const identityGate = new Promise((resolve) => { releaseIdentity = resolve; });
  const router = new RecoveredWorkerRouter({
    registry,
    metadataPath: join(root, "daemon", "workers.json"),
    inspect: async () => {
      if (blockIdentity) {
        identityStarted?.();
        await identityGate;
      }
      return worker;
    },
  });
  await router.load();
  const frame = { version: 1, type: "worker_ready", token: "worker-token", sessionId: "event-old-first", runId: "run-event-old-first", leaseId: "lease-event", generation: 1, worker, piChild: worker };
  const connection = () => {
    /** @type {(value?: unknown) => void} */
    let resolveClosed = () => {};
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    return { closed, close: () => resolveClosed(undefined) };
  };
  const oldConnection = connection();
  const oldRoute = await router.adopt(frame, oldConnection);
  blockIdentity = true;
  const sideEffects = { updates: 0, appends: 0, broadcasts: 0 };
  const oldEvent = router.runCurrent(oldRoute.metadata, oldConnection, oldRoute.routeGeneration, async () => {
    sideEffects.updates += 1;
    await Promise.resolve();
    sideEffects.appends += 1;
    await Promise.resolve();
    sideEffects.broadcasts += 1;
  });
  await identityStartedPromise;
  const currentConnection = connection();
  let replacementSettled = false;
  const replacement = router.adopt(frame, currentConnection).finally(() => { replacementSettled = true; });
  await Promise.resolve();
  expect(replacementSettled).toBe(false);
  expect(sideEffects).toEqual({ updates: 0, appends: 0, broadcasts: 0 });
  /** @type {(value?: unknown) => void} */ (releaseIdentity)();
  await oldEvent;
  expect(sideEffects).toEqual({ updates: 1, appends: 1, broadcasts: 1 });
  const currentRoute = await replacement;
  await router.runCurrent(currentRoute.metadata, currentConnection, currentRoute.routeGeneration, async () => {
    sideEffects.updates += 1;
    sideEffects.appends += 1;
    sideEffects.broadcasts += 1;
  });
  expect(sideEffects).toEqual({ updates: 2, appends: 2, broadcasts: 2 });
  await router.close();
});

it("invalidates queued old worker events when replacement wins first", async () => {
  const root = await fixture();
  const registry = new RegistryStore(join(root, "sessions"));
  const worker = { pid: 601, startIdentity: "worker", processGroupId: 601 };
  await registry.create(record("event-replacement-first", worker));
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "event-replacement-first", runId: "run-event-replacement-first", leaseId: "lease-event", generation: 1, identity: worker, piChildIdentity: worker }] })}\n`, { mode: 0o600 });
  /** @type {((value?: unknown) => void) | undefined} */
  let releaseIdentity;
  /** @type {((value?: unknown) => void) | undefined} */
  let identityStarted;
  let blockIdentity = false;
  const identityStartedPromise = new Promise((resolve) => { identityStarted = resolve; });
  const identityGate = new Promise((resolve) => { releaseIdentity = resolve; });
  const router = new RecoveredWorkerRouter({
    registry,
    metadataPath: join(root, "daemon", "workers.json"),
    inspect: async () => {
      if (blockIdentity) {
        identityStarted?.();
        await identityGate;
      }
      return worker;
    },
  });
  await router.load();
  const frame = { version: 1, type: "worker_ready", token: "worker-token", sessionId: "event-replacement-first", runId: "run-event-replacement-first", leaseId: "lease-event", generation: 1, worker, piChild: worker };
  const connection = () => {
    /** @type {(value?: unknown) => void} */
    let resolveClosed = () => {};
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    return { closed, close: () => resolveClosed(undefined) };
  };
  const oldConnection = connection();
  const oldRoute = await router.adopt(frame, oldConnection);
  blockIdentity = true;
  const currentConnection = connection();
  const replacement = router.adopt(frame, currentConnection);
  await identityStartedPromise;
  const sideEffects = { updates: 0, appends: 0, broadcasts: 0 };
  const oldActions = [1, 2].map(() => router.runCurrent(oldRoute.metadata, oldConnection, oldRoute.routeGeneration, async () => {
    sideEffects.updates += 1;
    sideEffects.appends += 1;
    sideEffects.broadcasts += 1;
  }));
  /** @type {(value?: unknown) => void} */ (releaseIdentity)();
  const currentRoute = await replacement;
  const outcomes = await Promise.allSettled(oldActions);
  expect(outcomes).toEqual([
    expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "STALE_WORKER_CONNECTION" }) }),
    expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "STALE_WORKER_CONNECTION" }) }),
  ]);
  expect(sideEffects).toEqual({ updates: 0, appends: 0, broadcasts: 0 });
  await router.runCurrent(currentRoute.metadata, currentConnection, currentRoute.routeGeneration, async () => {
    sideEffects.updates += 1;
    sideEffects.appends += 1;
    sideEffects.broadcasts += 1;
  });
  expect(sideEffects).toEqual({ updates: 1, appends: 1, broadcasts: 1 });
  await router.close();
});

it("retains exact ownership conflicts fail-closed for live matches, dead workers, and PID reuse", async () => {
  const root = await fixture();
  const registry = new RegistryStore(join(root, "sessions"));
  const alive = { pid: 101, startIdentity: "alive", processGroupId: 101 };
  const reused = { pid: 102, startIdentity: "old", processGroupId: 102 };
  const dead = { pid: 103, startIdentity: "dead", processGroupId: 103 };
  await registry.create(record("alive", alive));
  await registry.create(record("reused", reused));
  await registry.create(record("dead", dead));
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "alive", runId: "run-alive", leaseId: "lease-alive", generation: 1, identity: alive, piChildIdentity: alive }] })}\n`, { mode: 0o600 });

  const recovered = await reconcileRuntime({
    root,
    daemonEpoch: "epoch",
    inspect: async (pid) => {
      if (pid === 101) return alive;
      if (pid === 102) return { ...reused, startIdentity: "new" };
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
    waitForReconnect: async (workers) => workers.filter((worker) => worker.sessionId === "alive").map((worker) => worker.sessionId),
  });

  expect(recovered.liveWorkers.map(({ sessionId }) => sessionId)).toEqual(["alive"]);
  expect(recovered.conflicts.map(({ sessionId, reason }) => [sessionId, reason])).toEqual([
    ["dead", "WORKER_EXITED"],
    ["reused", "PROCESS_IDENTITY_MISMATCH"],
  ]);
  expect((await registry.get("dead"))?.ownership).toBeDefined();
  expect((await registry.get("reused"))?.ownership).toBeDefined();
  await recovered.close();
});

it("reclaims a session whose supervisor and recorded Pi child are both gone or replaced", async () => {
  const root = await fixture();
  const registry = new RegistryStore(join(root, "sessions"));
  const deadWorker = { pid: 201, startIdentity: "dead-worker", processGroupId: 201 };
  const deadChild = { pid: 202, startIdentity: "dead-child", processGroupId: 201 };
  const replacedWorker = { pid: 211, startIdentity: "old-worker", processGroupId: 211 };
  const replacedChild = { pid: 212, startIdentity: "old-child", processGroupId: 211 };
  await registry.create(record("dead-pair", deadWorker));
  await registry.create(record("replaced-pair", replacedWorker));
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [
    { sessionId: "dead-pair", runId: "run-dead-pair", leaseId: "lease-dead", generation: 1, identity: deadWorker, piChildIdentity: deadChild },
    { sessionId: "replaced-pair", runId: "run-replaced-pair", leaseId: "lease-replaced", generation: 1, identity: replacedWorker, piChildIdentity: replacedChild },
  ] })}\n`, { mode: 0o600 });

  const recovered = await reconcileRuntime({
    root,
    daemonEpoch: "epoch",
    inspect: async (pid) => {
      if (pid === 211) return { ...replacedWorker, startIdentity: "new-worker" };
      if (pid === 212) return { ...replacedChild, startIdentity: "new-child" };
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
  });

  expect(recovered.conflicts).toEqual([]);
  expect(recovered.router.metadata("dead-pair")).toBeUndefined();
  expect(recovered.router.metadata("replaced-pair")).toBeUndefined();
  for (const sessionId of ["dead-pair", "replaced-pair"]) {
    const repaired = await registry.get(sessionId);
    expect(repaired).toMatchObject({ processState: "EXITED", taskState: "READY" });
    expect(repaired?.ownership).toBeUndefined();
  }
  expect(recovered.repairedSessions.map((event) => event.payload.session.sessionId).sort()).toEqual(["dead-pair", "replaced-pair"]);
  await recovered.close();
});

it.each([
  ["live", async () => ({ pid: 302, startIdentity: "orphan-child", processGroupId: 301 }), "PI_CHILD_ORPHANED"],
  ["unreadable", async () => { throw Object.assign(new Error("unreadable"), { code: "AMBIGUOUS_IDENTITY" }); }, "PI_CHILD_IDENTITY_AMBIGUOUS"],
])("retains ownership when a dead supervisor leaves a %s Pi child", async (_name, inspectChild, reason) => {
  const root = await fixture();
  const registry = new RegistryStore(join(root, "sessions"));
  const worker = { pid: 301, startIdentity: "orphan-worker", processGroupId: 301 };
  const piChild = { pid: 302, startIdentity: "orphan-child", processGroupId: 301 };
  await registry.create(record("orphaned", worker));
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "orphaned", runId: "run-orphaned", leaseId: "lease-orphaned", generation: 1, identity: worker, piChildIdentity: piChild }] })}\n`, { mode: 0o600 });

  const recovered = await reconcileRuntime({
    root,
    daemonEpoch: "epoch",
    inspect: async (pid) => {
      if (pid === piChild.pid) return inspectChild();
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
  });

  expect(recovered.conflicts.map(({ sessionId, reason: conflictReason }) => [sessionId, conflictReason])).toEqual([["orphaned", reason]]);
  expect((await registry.get("orphaned"))?.ownership).toMatchObject({ runId: "run-orphaned" });
  expect(recovered.router.metadata("orphaned")).toMatchObject({ sessionId: "orphaned" });
  await recovered.close();
});
