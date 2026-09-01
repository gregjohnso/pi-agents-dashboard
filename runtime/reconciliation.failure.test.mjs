import { mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

import { RegistryStore } from "./registry-store.mjs";
import { RecoveredWorkerRouter, reconcileRuntime } from "./reconciliation.mjs";
import { createFakeWorkerSockets } from "./test-fixtures.mjs";

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
  for (const name of ["daemon", "sessions", "runs", "index"]) await mkdir(join(root, name), { mode: 0o700 });
  return root;
}

// Operator-visible failure: a crash tears whatever the daemon was appending. This release appends
// no command journal and no list history, so recovery must read neither and recreate neither, and a
// torn copy of either from an earlier release must not stop a daemon from starting.
it("starts over a torn command journal and list history without reading or rewriting either", async () => {
  const root = await fixture();
  await mkdir(join(root, "queue"), { mode: 0o700 });
  const journalPath = join(root, "queue", "commands.jsonl");
  const journal = `${JSON.stringify({ commandCanonical: "{}", command: { version: 1, clientId: "client", requestId: "request", op: "prompt", payload: { sessionId: "one", text: "hello" } }, status: { clientId: "client", requestId: "request", operation: "prompt", stage: "DELIVERY_ATTEMPTED", acceptedAt: "2026-08-25T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z" } })}\n{"torn":`;
  await writeFile(journalPath, journal, { mode: 0o600 });
  const eventPath = join(root, "index", "events.jsonl");
  const retired = `${JSON.stringify({ version: 1, cursor: { daemonEpoch: "epoch", sequence: "1" }, occurredAt: "2026-08-25T12:00:00.000Z", kind: "attachment_changed", payload: { sessionId: "one", clientId: "client", role: "observer", attached: true } })}\n{"torn":`;
  await writeFile(eventPath, retired, { mode: 0o600 });

  const gone = async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
  const recovered = await reconcileRuntime({ root, daemonEpoch: "epoch", inspect: gone });
  expect(/** @type {any} */ (recovered).journal).toBeUndefined();
  await recovered.close();
  const secondRecovery = await reconcileRuntime({ root, daemonEpoch: "epoch", inspect: gone });
  await secondRecovery.close();
  expect(await readFile(journalPath, "utf8")).toBe(journal);
  expect(await readFile(eventPath, "utf8")).toBe(retired);
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
  const aliveSocket = join(root, "daemon", "workers", "alive.sock");
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "alive", runId: "run-alive", leaseId: "lease-alive", generation: 1, identity: alive, piChildIdentity: alive, token: "alive-token", socketPath: aliveSocket, proto: 2 }] })}\n`, { mode: 0o600 });
  const inspect = async (/** @type {number} */ pid) => {
    if (pid === 101) return alive;
    if (pid === 102) return { ...reused, startIdentity: "new" };
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  };
  const sockets = createFakeWorkerSockets();
  sockets.answer(aliveSocket, [{ version: 1, type: "worker_ready", token: "alive-token", sessionId: "alive", runId: "run-alive", leaseId: "lease-alive", generation: 1, worker: alive, piChild: alive }]);
  const router = new RecoveredWorkerRouter({ registry, inspect, metadataPath: join(root, "daemon", "workers.json"), connect: sockets.connect });
  await router.load();

  const recovered = await reconcileRuntime({ root, daemonEpoch: "epoch", inspect, router });

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
  expect(recovered.repairedSessions.map((session) => session.sessionId).sort()).toEqual(["dead-pair", "replaced-pair"]);
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

/** @param {string} root @param {any} [sockets] */
function launchRouter(root, sockets, inspect = async (/** @type {number} */ pid) => ({ pid, startIdentity: String(pid), processGroupId: pid })) {
  const registry = new RegistryStore(join(root, "sessions"));
  return { registry, router: new RecoveredWorkerRouter({ registry, inspect, metadataPath: join(root, "daemon", "workers.json"), ...(sockets === undefined ? {} : { connect: sockets.connect }) }) };
}

function fakeConnection() {
  /** @type {(value?: unknown) => void} */
  let resolveClosed = () => {};
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  return { closed, close: () => resolveClosed(undefined), async send() {}, async request() { return undefined; }, onMessage() { return () => {}; } };
}

it.each([
  ["run", { runId: "other-run" }, "WORKER_HELLO_MISMATCH"],
  ["lease", { leaseId: "other-lease" }, "WORKER_HELLO_MISMATCH"],
  ["generation", { generation: 9 }, "WORKER_HELLO_MISMATCH"],
  ["session", { sessionId: "other-session" }, "WORKER_HELLO_MISMATCH"],
  ["token", { token: "forged-token" }, "WORKER_HELLO_MISMATCH"],
  ["worker PID", { worker: { pid: 9, startIdentity: "9", processGroupId: 9 } }, "WORKER_IDENTITY_MISMATCH"],
  ["process-start identity", { worker: { pid: 401, startIdentity: "recycled", processGroupId: 401 } }, "WORKER_IDENTITY_MISMATCH"],
  ["process group", { worker: { pid: 401, startIdentity: "401", processGroupId: 77 } }, "WORKER_IDENTITY_MISMATCH"],
])("refuses a worker socket whose %s does not match the reserved launch", async (_name, overrides, code) => {
  const root = await fixture();
  const sockets = createFakeWorkerSockets();
  const { router } = launchRouter(root, sockets);
  await router.load();
  const reservation = await router.reserve({ sessionId: "reserved", runId: "run-reserved", leaseId: "lease-reserved", generation: 1, token: "reserved-token" });
  sockets.answer(reservation.socketPath, [{ version: 1, type: "hello", token: "reserved-token", sessionId: "reserved", runId: "run-reserved", leaseId: "lease-reserved", generation: 1, worker: { pid: 401, startIdentity: "401", processGroupId: 401 }, ...overrides }]);

  await expect(reservation.connected(401, 200)).rejects.toMatchObject({ code });
  await router.close();
});

// The daemon connects, so a socket nothing is listening on is the whole refusal: there is no
// connection for a forged token to arrive on.
it("refuses a launch whose worker never listened on the socket the daemon named", async () => {
  const root = await fixture();
  const sockets = createFakeWorkerSockets();
  const { router } = launchRouter(root, sockets);
  await router.load();
  const reservation = await router.reserve({ sessionId: "reserved", runId: "run-reserved", leaseId: "lease-reserved", generation: 1, token: "reserved-token" });

  await expect(reservation.connected(401, 50)).rejects.toMatchObject({ code: "WORKER_SOCKET_UNREACHABLE" });
  await router.close();
});

it("keeps a live worker's token in mode-0600 worker metadata across reconciliation and drops the whole entry when it is proven terminal", async () => {
  const root = await fixture();
  const worker = { pid: 501, startIdentity: "live-worker", processGroupId: 501 };
  const piChild = { pid: 502, startIdentity: "live-pi", processGroupId: 501 };
  const metadataPath = join(root, "daemon", "workers.json");
  const registry = new RegistryStore(join(root, "sessions"));
  await registry.create(record("live", worker));
  const liveSocket = join(root, "daemon", "workers", "live.sock");
  await writeFile(metadataPath, `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "live", runId: "run-live", leaseId: "lease-live", generation: 1, identity: worker, piChildIdentity: piChild, token: "live-run-token", socketPath: liveSocket, proto: 2 }] })}\n`, { mode: 0o600 });
  const inspect = async (/** @type {number} */ pid) => pid === 501 ? worker : pid === 502 ? piChild : (() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); })();
  const sockets = createFakeWorkerSockets();
  sockets.answer(liveSocket, [{ version: 1, type: "worker_ready", token: "live-run-token", sessionId: "live", runId: "run-live", leaseId: "lease-live", generation: 1, worker, piChild }]);
  const router = new RecoveredWorkerRouter({ registry, inspect, metadataPath, connect: sockets.connect });
  await router.load();

  const recovered = await reconcileRuntime({ root, daemonEpoch: "epoch", inspect, router });
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
  expect(await persistedWorkers(root)).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "unknown", proto: 2, routeGeneration: 1 })]));
  expect((await persistedWorkers(root)).every((/** @type {any} */ entry) => entry.proto === 2 && entry.routeGeneration === 1)).toBe(true);
  expect(["older", "equal", "newer", "unknown", "unparseable"].map((sessionId) => router.releaseStatus(sessionId))).toEqual(["STALE", "CURRENT", "NEWER", "UNKNOWN", "UNKNOWN"]);
  await router.close();
});

it("leaves a worker whose recorded protocol this daemon does not speak unavailable and untouched", async () => {
  const root = await fixture();
  const future = await liveWorker(root, "future", { proto: 3, cliVersion: "9.0.0" });
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
  const live = await liveWorker(root, "resumed", { cliVersion: "2.0.0", proto: 2, routeGeneration: 3 });
  const router = await releaseRouter(root, [live], "2.0.0");

  await expect(router.adopt(live.ready, fakeConnection())).resolves.toMatchObject({ routeGeneration: 4 });
  expect(await persistedWorkers(root)).toEqual([{ ...live.metadata, routeGeneration: 4 }]);
  await router.close();
});

// Operator-visible failure: a daemon that recorded no replacement intent before it signalled would
// forget an interrupted upgrade on restart, leaving the operator's session on the worker the daemon
// had already decided to replace.
it("carries one run's persisted pending replacement across adoption by a replacement daemon", async () => {
  const root = await fixture();
  const live = await liveWorker(root, "marked", { cliVersion: "1.9.0", proto: 2, routeGeneration: 1, pendingRespawn: "upgrade" });
  const router = await releaseRouter(root, [live], "2.0.0");

  await expect(router.adopt(live.ready, fakeConnection())).resolves.toMatchObject({ routeGeneration: 2 });

  expect(router.pendingRespawn("marked")).toBe("upgrade");
  expect(await persistedWorkers(root)).toEqual([{ ...live.metadata, routeGeneration: 2 }]);
  await router.close();
});

it("records a durable pending replacement only for the run that still owns the session", async () => {
  const root = await fixture();
  const live = await liveWorker(root, "superseded", { cliVersion: "1.9.0" });
  const router = await releaseRouter(root, [live], "2.0.0");

  await expect(router.markPendingRespawn("superseded", "other-run")).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
  expect(await persistedWorkers(root)).toEqual([live.metadata]);

  await router.markPendingRespawn("superseded", "run-superseded");
  expect(await persistedWorkers(root)).toEqual([{ ...live.metadata, pendingRespawn: "upgrade" }]);
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

/** Pathnames this process currently holds open beneath one directory, one entry per descriptor. @param {string} directory */
async function openPathsUnder(directory) {
  const prefix = `${await realpath(directory)}/`;
  const targets = await Promise.all((await readdir("/proc/self/fd")).map((fd) => readlink(join("/proc/self/fd", fd)).catch(() => "")));
  return targets.filter((target) => target.startsWith(prefix)).sort();
}

// Operator-visible failure: a launch calls ensure from the worker's bound connection and again after
// workerSupervisor.launch returns. Both missing the session map built two read models, and the
// loser's canonical-history handle was dropped unclosed. Node 25 turns that into a fatal
// ERR_INVALID_STATE when the collector finalizes it, killing the daemon a minute after a launch.
it("opens one viewer read model for concurrent ensure calls on the same session and leaks no descriptor", async () => {
  const root = await fixture();
  const registry = new RegistryStore(join(root, "sessions"));
  const recovered = await reconcileRuntime({ root, daemonEpoch: "epoch", inspect: async () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } });

  // The session is registered after recovery, exactly as a launch registers it before ensure runs.
  const canonicalSessionFile = join(await realpath(root), "racing.jsonl");
  await writeFile(canonicalSessionFile, "", { mode: 0o600 });
  await registry.create({ ...record("racing", { pid: 801, startIdentity: "racing-worker", processGroupId: 801 }), sessionFile: canonicalSessionFile, canonicalSessionFile });

  const before = await openPathsUnder(root);
  const [first, second] = await Promise.all([recovered.viewer.ensure("racing"), recovered.viewer.ensure("racing")]);
  const opened = await openPathsUnder(root);

  // Pi's own session file is the only thing this daemon opens for a viewer.
  expect(opened.filter((path) => !before.includes(path))).toEqual([canonicalSessionFile]);
  expect(second).toBe(first);

  await recovered.close();
});

// A rejected attempt must not poison the map: the launch that retries has to be able to open it.
it("lets the next caller retry a session whose first concurrent open failed", async () => {
  const root = await fixture();
  const registry = new RegistryStore(join(root, "sessions"));
  const recovered = await reconcileRuntime({ root, daemonEpoch: "epoch", inspect: async () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } });
  const canonicalSessionFile = join(await realpath(root), "retried.jsonl");
  // A required Pi shape this normalizer refuses fails the open for both concurrent callers.
  await writeFile(canonicalSessionFile, `${JSON.stringify({ type: "message", id: "broken", message: { role: "assistant" } })}\n`, { mode: 0o600 });
  const created = await registry.create({ ...record("retried", { pid: 802, startIdentity: "retried-worker", processGroupId: 802 }), sessionFile: canonicalSessionFile, canonicalSessionFile });

  const before = await openPathsUnder(root);
  const attempts = await Promise.allSettled([recovered.viewer.ensure("retried"), recovered.viewer.ensure("retried")]);
  expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
  expect(await openPathsUnder(root)).toEqual(before);

  await writeFile(canonicalSessionFile, `${JSON.stringify({ type: "message", id: "fixed", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })}\n`, { mode: 0o600 });
  await expect(recovered.viewer.ensure("retried")).resolves.toMatchObject({ sessionId: created.sessionId });
  await recovered.close();
});
