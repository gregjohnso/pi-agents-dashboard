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

/** @param {string} sessionId @param {import("../shared/contracts.js").ProcessIdentity} identity @returns {import("../shared/contracts.js").SessionRecord} */
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

it("reopens truncated stores and converts unresolved delivery to DELIVERY_UNKNOWN", async () => {
  const root = await fixture();
  const journalPath = join(root, "queue", "commands.jsonl");
  const journal = await createCommandJournal({ path: journalPath });
  const command = /** @type {import("../shared/contracts.js").ClientRequest} */ ({ version: 1, clientId: "client", requestId: "request", op: "prompt", payload: { sessionId: "one", text: "hello" } });
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
  const accepted = /** @type {import("../shared/contracts.js").ClientRequest} */ ({ version: 1, clientId: "client", requestId: "accepted", op: "prompt", payload: { sessionId: "one", text: "safe" } });
  const acknowledged = /** @type {import("../shared/contracts.js").ClientRequest} */ ({ ...accepted, requestId: "acknowledged", payload: { ...accepted.payload, text: "done" } });
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

it("refuses an old command result during identity await without removing the replacement pending entry", async () => {
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
  let oldResultResolved = false;
  const oldResult = router.runCurrent(oldRoute.metadata, oldConnection, oldRoute.routeGeneration, async () => {
    pending.delete("shared-result-id");
    oldResultResolved = true;
  });
  await identityStartedPromise;
  const currentConnection = connection();
  const replacement = router.adopt(frame, currentConnection);
  const newPending = { ...oldPending, connection: currentConnection, routeGeneration: oldRoute.routeGeneration + 1, requestId: "current" };
  pending.set("shared-result-id", newPending);
  /** @type {(value?: unknown) => void} */ (releaseIdentity)();
  await expect(oldResult).rejects.toMatchObject({ code: "STALE_WORKER_CONNECTION" });
  const currentRoute = await replacement;
  expect(oldResultResolved).toBe(false);
  expect(pending.get("shared-result-id")).toBe(newPending);
  let currentResultResolved = false;
  await expect(router.runCurrent(currentRoute.metadata, currentConnection, currentRoute.routeGeneration, async () => {
    expect(pending.get("shared-result-id")).toBe(newPending);
    pending.delete("shared-result-id");
    currentResultResolved = true;
    return "accepted";
  })).resolves.toBe("accepted");
  expect(currentResultResolved).toBe(true);
  expect(pending.has("shared-result-id")).toBe(false);
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
