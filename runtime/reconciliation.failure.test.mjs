import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

/** @param {string} root */
function launchRouter(root, inspect = async (/** @type {number} */ pid) => ({ pid, startIdentity: String(pid), processGroupId: pid })) {
  const registry = new RegistryStore(join(root, "sessions"));
  return { registry, router: new RecoveredWorkerRouter({ registry, inspect, metadataPath: join(root, "daemon", "workers.json"), bindTimeoutMs: 200 }) };
}

function fakeConnection() {
  /** @type {(value?: unknown) => void} */
  let resolveClosed = () => {};
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  return { closed, close: () => resolveClosed(undefined), async send() {}, async request() { return undefined; } };
}

it.each([
  ["run", { runId: "other-run" }, "WORKER_HELLO_MISMATCH"],
  ["lease", { leaseId: "other-lease" }, "WORKER_HELLO_MISMATCH"],
  ["generation", { generation: 9 }, "WORKER_HELLO_MISMATCH"],
  ["session", { sessionId: "other-session" }, "WORKER_HELLO_MISMATCH"],
  ["worker PID", { worker: { pid: 9, startIdentity: "9", processGroupId: 9 } }, "WORKER_IDENTITY_MISMATCH"],
  ["process-start identity", { worker: { pid: 401, startIdentity: "recycled", processGroupId: 401 } }, "WORKER_IDENTITY_MISMATCH"],
  ["process group", { worker: { pid: 401, startIdentity: "401", processGroupId: 77 } }, "WORKER_IDENTITY_MISMATCH"],
])("refuses a startup socket whose %s does not match the reserved launch", async (_name, overrides, code) => {
  const root = await fixture();
  const { router } = launchRouter(root);
  await router.load();
  const reservation = await router.reserve({ sessionId: "reserved", runId: "run-reserved", leaseId: "lease-reserved", generation: 1, token: "reserved-token" });
  reservation.spawned(401);
  const hello = { version: 1, type: "hello", token: "reserved-token", sessionId: "reserved", runId: "run-reserved", leaseId: "lease-reserved", generation: 1, worker: { pid: 401, startIdentity: "401", processGroupId: 401 }, ...overrides };

  await expect(router.beginLaunchConnection(hello, fakeConnection(), () => {})).rejects.toMatchObject({ code });
  await expect(reservation.connected(50)).rejects.toMatchObject({ code });
  await router.close();
});

it("refuses a startup socket carrying a token no launch reserved", async () => {
  const root = await fixture();
  const { router } = launchRouter(root);
  await router.load();
  const reservation = await router.reserve({ sessionId: "reserved", runId: "run-reserved", leaseId: "lease-reserved", generation: 1, token: "reserved-token" });
  reservation.spawned(401);

  await expect(router.beginLaunchConnection({ version: 1, type: "hello", token: "forged-token", sessionId: "reserved", runId: "run-reserved", leaseId: "lease-reserved", generation: 1, worker: { pid: 401, startIdentity: "401", processGroupId: 401 } }, fakeConnection(), () => {}))
    .rejects.toMatchObject({ code: "WORKER_AUTHENTICATION_FAILED" });
  await router.close();
});

it("keeps a live worker's token in mode-0600 worker metadata across reconciliation and drops the whole entry when it is proven terminal", async () => {
  const root = await fixture();
  const worker = { pid: 501, startIdentity: "live-worker", processGroupId: 501 };
  const piChild = { pid: 502, startIdentity: "live-pi", processGroupId: 501 };
  const metadataPath = join(root, "daemon", "workers.json");
  const registry = new RegistryStore(join(root, "sessions"));
  await registry.create(record("live", worker));
  await writeFile(metadataPath, `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "live", runId: "run-live", leaseId: "lease-live", generation: 1, identity: worker, piChildIdentity: piChild, token: "live-run-token" }] })}\n`, { mode: 0o600 });

  const recovered = await reconcileRuntime({
    root,
    daemonEpoch: "epoch",
    inspect: async (/** @type {number} */ pid) => pid === 501 ? worker : pid === 502 ? piChild : (() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); })(),
    waitForReconnect: async (/** @type {any[]} */ workers) => workers.map((entry) => entry.sessionId),
  });
  expect(recovered.conflicts).toEqual([]);
  // A replacement daemon authenticates the surviving run with the same secret it never rotated.
  expect(recovered.router.metadata("live")).toMatchObject({ token: "live-run-token" });
  expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);

  await recovered.router.forgetRun("live", "live-run-token");
  expect(recovered.router.metadata("live")).toBeUndefined();
  expect(JSON.parse(await readFile(metadataPath, "utf8")).workers).toEqual([]);
  await recovered.close();
});

/** Build one adoptable live worker whose recorded metadata carries the supplied release fields. @param {string} root @param {string} sessionId @param {Record<string, any>} fields */
async function liveWorker(root, sessionId, fields) {
  const pid = 700 + [...sessionId].reduce((total, character) => total + character.charCodeAt(0), 0) % 90;
  const worker = { pid, startIdentity: `${sessionId}-worker`, processGroupId: pid };
  const piChild = { pid: pid + 100, startIdentity: `${sessionId}-pi`, processGroupId: pid };
  const registry = new RegistryStore(join(root, "sessions"));
  await registry.create(record(sessionId, worker));
  return {
    worker, piChild,
    metadata: { sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, identity: worker, piChildIdentity: piChild, token: `${sessionId}-token`, ...fields },
    ready: { version: 1, type: "worker_ready", token: `${sessionId}-token`, sessionId, runId: `run-${sessionId}`, leaseId: `lease-${sessionId}`, generation: 1, worker, piChild },
  };
}

/** @param {string} root @param {any[]} workers @param {string} cliVersion */
async function releaseRouter(root, workers, cliVersion) {
  const identities = new Map(workers.flatMap(({ worker, piChild }) => [[worker.pid, worker], [piChild.pid, piChild]]));
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: workers.map((entry) => entry.metadata) })}\n`, { mode: 0o600 });
  const registry = new RegistryStore(join(root, "sessions"));
  const router = new RecoveredWorkerRouter({ registry, cliVersion, metadataPath: join(root, "daemon", "workers.json"), inspect: async (/** @type {number} */ pid) => identities.get(pid) ?? Promise.reject(Object.assign(new Error("gone"), { code: "ESRCH" })) });
  await router.load();
  return router;
}

/** @param {string} root */
async function persistedWorkers(root) {
  return JSON.parse(await readFile(join(root, "daemon", "workers.json"), "utf8")).workers;
}

// Operator-visible failure: a replacement daemon that compared releases before adopting would refuse
// a live worker for being out of date, and the operator would lose an unsaved session to an upgrade.
it("adopts every protocol-compatible route before comparing releases and persists the generation it adopted", async () => {
  const root = await fixture();
  const older = await liveWorker(root, "older", { cliVersion: "1.9.0" });
  const equal = await liveWorker(root, "equal", { cliVersion: "2.0.0" });
  const newer = await liveWorker(root, "newer", { cliVersion: "2.1.0" });
  const unknown = await liveWorker(root, "unknown", {});
  // A release this daemon cannot compare is unknown, never a downgrade.
  const unparseable = await liveWorker(root, "unparseable", { cliVersion: "nightly-2026-08-30" });
  const router = await releaseRouter(root, [older, equal, newer, unknown, unparseable], "2.0.0");

  for (const live of [older, equal, newer, unknown, unparseable]) {
    await expect(router.adopt(live.ready, fakeConnection())).resolves.toMatchObject({ routeGeneration: 1 });
  }

  // A live authenticated version-1 route is what supplies the protocol a baseline record never wrote.
  expect(await persistedWorkers(root)).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "unknown", proto: 1, routeGeneration: 1 })]));
  expect((await persistedWorkers(root)).every((/** @type {any} */ entry) => entry.proto === 1 && entry.routeGeneration === 1)).toBe(true);
  expect(["older", "equal", "newer", "unknown", "unparseable"].map((sessionId) => router.releaseStatus(sessionId))).toEqual(["STALE", "CURRENT", "NEWER", "UNKNOWN", "UNKNOWN"]);
  await router.close();
});

it("leaves a worker whose recorded protocol this daemon does not speak unavailable and untouched", async () => {
  const root = await fixture();
  const future = await liveWorker(root, "future", { proto: 2, cliVersion: "9.0.0" });
  const router = await releaseRouter(root, [future], "2.0.0");

  await expect(router.adopt(future.ready, fakeConnection())).rejects.toMatchObject({ code: "WORKER_PROTOCOL_INCOMPATIBLE" });

  expect(router.route("future")).toBeUndefined();
  expect(await persistedWorkers(root)).toEqual([future.metadata]);
  await router.close();
});

// Gate 1 records the first public route-generation baseline and later gates compare against it, so a
// generation that restarts at one on every daemon start reports a reconnect that never happened.
it("continues route generations across a replacement daemon", async () => {
  const root = await fixture();
  const live = await liveWorker(root, "resumed", { cliVersion: "2.0.0", proto: 1, routeGeneration: 3 });
  const router = await releaseRouter(root, [live], "2.0.0");

  await expect(router.adopt(live.ready, fakeConnection())).resolves.toMatchObject({ routeGeneration: 4 });
  expect(await persistedWorkers(root)).toEqual([{ ...live.metadata, routeGeneration: 4 }]);
  await router.close();
});

it("inherits nothing from a run that was reserved but never spawned its worker", async () => {
  const root = await fixture();
  const metadataPath = join(root, "daemon", "workers.json");
  await writeFile(metadataPath, `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "reserved", runId: "run-reserved", leaseId: "lease-reserved", generation: 1, token: "orphan-token" }] })}\n`, { mode: 0o600 });
  const { router } = launchRouter(root);

  await router.load();
  expect(router.metadata("reserved")).toBeUndefined();
  await router.close();
});

// A graceful Stop kills the worker, which closes the route the action captured. Refusing that as a
// replacement reported STALE_WORKER_CONNECTION for a Stop that had already succeeded.
it("lets a lifecycle action forget a worker whose own graceful exit cleared its route, and still refuses a replaced one", async () => {
  const root = await fixture();
  const worker = { pid: 601, startIdentity: "stopping-worker", processGroupId: 601 };
  const piChild = { pid: 602, startIdentity: "stopping-pi", processGroupId: 601 };
  const registry = new RegistryStore(join(root, "sessions"));
  await registry.create(record("stopping", worker));
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "stopping", runId: "run-stopping", leaseId: "lease-stopping", generation: 1, identity: worker, piChildIdentity: piChild, token: "stopping-token" }] })}\n`, { mode: 0o600 });
  const router = new RecoveredWorkerRouter({ registry, metadataPath: join(root, "daemon", "workers.json"), inspect: async (/** @type {number} */ pid) => pid === 601 ? worker : piChild });
  await router.load();
  const ready = { version: 1, type: "worker_ready", token: "stopping-token", sessionId: "stopping", runId: "run-stopping", leaseId: "lease-stopping", generation: 1, worker, piChild };
  const first = fakeConnection();
  await router.adopt(ready, first);

  await router.runSession("stopping", async (/** @type {any} */ { forget }) => {
    // The worker exits and its socket closes while the Stop is still inside this action.
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await forget();
  });
  expect(router.metadata("stopping")).toBeUndefined();

  await registry.create(record("replaced", worker));
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "replaced", runId: "run-replaced", leaseId: "lease-replaced", generation: 1, identity: worker, piChildIdentity: piChild, token: "replaced-token" }] })}\n`, { mode: 0o600 });
  const replacedRouter = new RecoveredWorkerRouter({ registry, metadataPath: join(root, "daemon", "workers.json"), inspect: async (/** @type {number} */ pid) => pid === 601 ? worker : piChild });
  await replacedRouter.load();
  const replacedReady = { ...ready, token: "replaced-token", sessionId: "replaced", runId: "run-replaced", leaseId: "lease-replaced" };
  await replacedRouter.adopt(replacedReady, fakeConnection());
  await expect(replacedRouter.runSession("replaced", async (/** @type {any} */ { forget }) => {
    await replacedRouter.adopt(replacedReady, fakeConnection());
    await forget();
  })).rejects.toMatchObject({ code: "STALE_WORKER_CONNECTION" });
  expect(replacedRouter.metadata("replaced")).toMatchObject({ sessionId: "replaced" });
  await router.close();
  await replacedRouter.close();
});
