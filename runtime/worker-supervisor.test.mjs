import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { OwnershipManager } from "./ownership.mjs";
import { RecoveredWorkerRouter } from "./reconciliation.mjs";
import { RegistryStore } from "./registry-store.mjs";
import { WorkerSupervisor } from "./worker-supervisor.mjs";

/** @type {string[]} */
const cleanup = [];
const fastLaunchStop = {
  launchStopPolicy: { gracefulMs: 1, terminateMs: 1 },
  sleepImpl: async () => {},
  signalProcessGroupImpl: async () => {},
};
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** @param {string} root @param {string} sessionId @returns {import("../shared/contracts.mjs").SessionRecord} */
function sessionRecord(root, sessionId) {
  const now = "2026-08-25T12:00:00.000Z";
  const sessionFile = join(root, `${sessionId}.jsonl`);
  return {
    schemaVersion: /** @type {const} */ (1),
    revision: 0,
    sessionId,
    sessionFile,
    canonicalSessionFile: sessionFile,
    cwd: "/repo with spaces",
    taskState: "READY",
    processState: "EXITED",
    outcome: "NONE",
    activity: { kind: "saved_session", summary: "Saved", updatedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

/** @param {string[]} [sessionIds] @param {{ randomId?: () => string, inspect?: (pid: number) => Promise<any> }} [options] */
async function setup(sessionIds = ["one"], options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dashboard-supervisor-"));
  cleanup.push(root);
  const sessions = join(root, "sessions");
  const runs = join(root, "runs");
  const daemon = join(root, "daemon");
  await mkdir(sessions, { mode: 0o700 });
  await mkdir(runs, { mode: 0o700 });
  await mkdir(daemon, { mode: 0o700 });
  const registry = new RegistryStore(sessions);
  for (const id of sessionIds) await registry.create(sessionRecord(root, id));
  const ownership = new OwnershipManager(registry, {
    randomId: options.randomId ?? (() => `lease-${Math.random()}`),
  });
  const metadataPath = join(daemon, "workers.json");
  let current = options.inspect ?? inspect;
  const sockets = fakeWorkerSockets();
  const router = new RecoveredWorkerRouter({ registry, inspect: (/** @type {number} */ pid) => current(pid), metadataPath, connect: sockets.connect });
  await router.load();
  return {
    root, runs, registry, ownership, router, metadataPath, sockets,
    /** The router must see the same process world the supervisor does. @param {(pid: number) => Promise<any>} next */
    useInspect(next) { current = next; },
    workers: async () => JSON.parse(await readFile(metadataPath, "utf8")).workers,
  };
}

/** One in-process stand-in for a worker's own socket, which the daemon connects to. @param {(message: any) => void} onDaemonMessage */
function fakeConnection(onDaemonMessage) {
  /** @type {(value?: unknown) => void} */
  let resolveClosed = () => {};
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  /** @type {Set<(frame: any) => void>} */
  const listeners = new Set();
  /** Frames written before the daemon subscribed, which a real socket holds in its buffer. @type {any[]} */
  const buffered = [];
  const connection = {
    closed,
    close: () => resolveClosed(undefined),
    async send(/** @type {any} */ message) { onDaemonMessage(message); },
    async request() { throw new Error("Unexpected worker request in this fixture"); },
    /** @param {(frame: any) => void} listener */
    onMessage(listener) {
      listeners.add(listener);
      for (const frame of buffered.splice(0)) listener(frame);
      return () => listeners.delete(listener);
    },
    /** One frame this worker writes to whatever daemon is connected. @param {any} frame */
    emit(frame) {
      if (listeners.size === 0) buffered.push(frame);
      else for (const listener of [...listeners]) listener(frame);
    },
  };
  return connection;
}

/**
 * The worker sockets a router connects to. A path nothing listens on is retried until the launch's
 * own deadline, which is what a worker still on its way to `listen` looks like.
 */
function fakeWorkerSockets() {
  /** @type {Map<string, any>} */
  const listening = new Map();
  return {
    listening,
    /** @param {{ socketPath: string, timeoutMs: number }} options */
    async connect({ socketPath, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const connection = listening.get(socketPath);
        if (connection !== undefined) return connection;
        if (Date.now() >= deadline) throw Object.assign(new Error(`Worker socket is unreachable: ${socketPath}`), { code: "WORKER_SOCKET_UNREACHABLE" });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

/**
 * A fake worker that listens on the socket the launch named for it, as a real one does.
 *
 * @param {{ sockets?: any, order?: string[], helloOverrides?: Record<string, unknown>, readyOverrides?: Record<string, unknown>, holdReady?: boolean, holdHello?: boolean, activateSendError?: boolean, readyExitTiming?: "before" | "after", world?: any }} [configuration]
 */
function fakeWorkerFactory({ sockets, order = [], helloOverrides = {}, readyOverrides = {}, holdReady = false, holdHello = false, activateSendError = false, readyExitTiming, world } = {}) {
  let nextPid = 9100;
  /** @type {any[]} */
  const children = [];
  /** @type {any[]} */
  const calls = [];
  /** @type {any[]} */
  const helloFailures = [];
  /** The ordinary exit: a supervisor and its Pi child both leave the process table. @param {any} child @param {number} code */
  const exitGroup = (child, code = 1) => {
    world?.exit(child.pid);
    world?.exit(piChildPid(child.pid));
    child.emit("exit", code, null);
  };
  /** @param {string} command @param {string[]} argv @param {any} options */
  const spawnImpl = (command, argv, options) => {
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = nextPid++;
    child.killed = false;
    child.unref = vi.fn();
    const token = options.env.PI_AGENTS_WORKER_TOKEN;
    const sessionId = argv[argv.indexOf("--session-id") + 1];
    const runId = argv[argv.indexOf("--run-id") + 1];
    const leaseId = argv[argv.indexOf("--lease-id") + 1];
    const generation = Number(argv[argv.indexOf("--generation") + 1]);
    const socketPath = argv[argv.indexOf("--worker-socket") + 1];
    const worker = () => ({ pid: child.pid, startIdentity: String(child.pid), processGroupId: child.pid });
    const piChild = () => ({ pid: piChildPid(child.pid), startIdentity: String(piChildPid(child.pid)), processGroupId: child.pid });
    /** @param {any} frame */
    const toDaemon = (frame) => connection.emit(frame);
    const connection = fakeConnection((/** @type {any} */ message) => {
      order.push(`parent:${message.type}`);
      if (message.type === "activate") {
        if (activateSendError) throw new Error("activation send failed");
        queueMicrotask(() => void toDaemon({ version: 1, type: "pi_child", token, sessionId, runId, leaseId, generation, worker: worker(), piChild: piChild() }));
      }
      if (message.type === "child_bound" && !holdReady) {
        queueMicrotask(() => {
          if (readyExitTiming === "before") exitGroup(child);
          void toDaemon({ version: 1, type: "worker_ready", token, sessionId, runId, leaseId, generation, worker: worker(), piChild: piChild(), ...readyOverrides });
          if (readyExitTiming === "after") queueMicrotask(() => exitGroup(child));
        });
      }
      if (message.type === "reject" || message.type === "shutdown") {
        queueMicrotask(() => {
          connection.close();
          exitGroup(child);
        });
      }
    });
    child.connection = connection;
    calls.push({ command, argv, options, child });
    children.push(child);
    /** Start listening on the socket the launch named, answering the daemon's connect with hello. @param {Record<string, unknown>} [overrides] */
    child.listen = (overrides = {}) => {
      sockets.listening.set(socketPath, connection);
      queueMicrotask(() => toDaemon({ version: 1, type: "hello", token, sessionId, runId, leaseId, generation, worker: worker(), ...helloOverrides, ...overrides }));
    };
    if (!holdHello) child.listen();
    child.socketPath = socketPath;
    return child;
  };
  return { calls, children, spawnImpl, exitGroup, helloFailures };
}

/** @param {number} pid */
const inspect = async (pid) => ({ pid, startIdentity: String(pid), processGroupId: pid >= 9200 ? pid - 100 : pid });

/** The fake worker group: a supervisor at `pid` leads the group, and its Pi child is `pid + 100`. */
const piChildPid = (/** @type {number} */ supervisorPid) => supervisorPid + 100;

/**
 * Deterministic `/proc` plus signal seams, ordered so a test can pin what was inspected before a signal.
 *
 * @param {{ signalKills?: boolean }} [options]
 */
function processWorld({ signalKills = true } = {}) {
  /** @type {Set<number>} */
  const dead = new Set();
  /** @type {Set<number>} */
  const unreadable = new Set();
  /** @type {Map<number, string>} */
  const startIdentities = new Map();
  /** @type {string[]} */
  const log = [];
  /** @param {number} pid */
  const markDead = (pid) => { dead.add(pid); };
  /** @param {number} pid */
  const markUnreadable = (pid) => { unreadable.add(pid); };
  /** @param {number} pid @param {string} startIdentity */
  const recycle = (pid, startIdentity) => { startIdentities.set(pid, startIdentity); };
  const seams = {
    /** @param {number} pid */
    inspect: async (pid) => {
      log.push(`inspect:${pid}`);
      if (dead.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (unreadable.has(pid)) throw Object.assign(new Error("unreadable"), { code: "AMBIGUOUS_IDENTITY" });
      return { pid, startIdentity: startIdentities.get(pid) ?? String(pid), processGroupId: pid >= 9200 ? pid - 100 : pid };
    },
    /** @param {number} pgid @param {NodeJS.Signals} signal */
    signalProcessGroupImpl: async (pgid, signal) => {
      log.push(`signal:${pgid}:${signal}`);
      if (!signalKills) return;
      dead.add(pgid);
      dead.add(piChildPid(pgid));
    },
    sleepImpl: async () => {},
    launchStopPolicy: { gracefulMs: 1, terminateMs: 1 },
  };
  return { log, exit: markDead, hide: markUnreadable, recycle, seams };
}

/** @param {RegistryStore} registry @param {string} sessionId @returns {Promise<any>} */
async function getRecord(registry, sessionId) {
  const found = await registry.get(sessionId);
  if (found === undefined) throw new Error(`Missing test session ${sessionId}`);
  return found;
}

/** @param {() => Promise<boolean>} predicate */
async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}

it("creates and binds the registry before activation and reports ready after authenticated hello", async () => {
  /** @type {string[]} */
  const order = [];
  const { runs, registry, ownership, router, sockets } = await setup();
  const originalBind = ownership.bindProcesses.bind(ownership);
  ownership.bindProcesses = async (...args) => {
    order.push("bind-supervisor");
    return originalBind(...args);
  };
  const originalBindPiChild = ownership.bindPiChild.bind(ownership);
  ownership.bindPiChild = async (...args) => {
    order.push("bind-pi-child");
    return originalBindPiChild(...args);
  };
  const workers = fakeWorkerFactory({ sockets, order });
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    spawnImpl: workers.spawnImpl,
    inspect,
    randomId: () => "token-and-run",
  });

  const launched = await supervisor.launch({
    sessionId: "one",
    canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile,
    cwd: "/repo with spaces",
    runId: "run-1",
    piPath: "/tmp/fake pi executable",
  });

  expect(order).toEqual(["bind-supervisor", "parent:activate", "bind-pi-child", "parent:child_bound"]);
  expect(launched).toMatchObject({ ready: true, sessionId: "one", runId: "run-1" });
  expect(await getRecord(registry, "one")).toMatchObject({
    processState: "LIVE",
    ownership: { process: launched.identity },
  });
});

it("records the model Pi confirmed at readiness and leaves it absent when Pi named none", async () => {
  const { runs, registry, ownership, router, sockets } = await setup(["one", "two"]);
  const confirming = fakeWorkerFactory({ sockets, readyOverrides: { model: { provider: "openai-codex", id: "gpt-5.6-sol" } } });
  const confirmingSupervisor = new WorkerSupervisor({ registry, router, ownership, runsDirectory: runs, spawnImpl: confirming.spawnImpl, inspect, randomId: () => "confirmed-model-token" });
  await confirmingSupervisor.launch({
    sessionId: "one",
    canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile,
    cwd: "/repo",
    runId: "run-confirmed-model",
    model: { provider: "anthropic", id: "requested" },
  });

  // The request still reaches Pi through the worker's arguments; only the row waits for Pi's answer.
  expect(confirming.calls[0].argv).toEqual(expect.arrayContaining(["--model-provider", "anthropic", "--model-id", "requested"]));
  expect(await getRecord(registry, "one")).toMatchObject({ processState: "LIVE", model: { provider: "openai-codex", id: "gpt-5.6-sol" } });

  const silent = fakeWorkerFactory({ sockets });
  const silentSupervisor = new WorkerSupervisor({ registry, router, ownership, runsDirectory: runs, spawnImpl: silent.spawnImpl, inspect, randomId: () => "unconfirmed-model-token" });
  await silentSupervisor.launch({
    sessionId: "two",
    canonicalSessionFile: (await getRecord(registry, "two")).canonicalSessionFile,
    cwd: "/repo",
    runId: "run-unconfirmed-model",
    model: { provider: "anthropic", id: "requested" },
  });

  // Absence means Pi has not said yet. It never falls back to what the launch asked for.
  expect(await getRecord(registry, "two")).not.toHaveProperty("model");
  await confirmingSupervisor.close();
  await silentSupervisor.close();
});

it("authenticates and adopts the startup socket before activation, and persists the run token privately", async () => {
  const { runs, registry, ownership, router, sockets, metadataPath, workers: persisted } = await setup();
  const workers = fakeWorkerFactory({ sockets, holdHello: true });
  const supervisor = new WorkerSupervisor({ registry, router, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => "startup-socket-token", cliVersion: "9.9.9" });
  const launched = supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-startup" });

  await waitUntil(async () => workers.children.length === 1);
  // The run and its token are durable before the worker is spawned, so a replacement daemon can
  // authenticate the same run.
  expect(await persisted()).toEqual([{ sessionId: "one", runId: "run-startup", leaseId: expect.any(String), generation: 1, token: "startup-socket-token", socketPath: workers.children[0].socketPath, proto: 2, cliVersion: "9.9.9" }]);
  expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);
  expect(workers.calls[0].options.stdio).toEqual(["ignore", expect.any(Number), expect.any(Number)]);
  expect(workers.calls[0].options.env.NODE_CHANNEL_FD).toBeUndefined();

  workers.children[0].listen();
  const handle = await launched;
  const adopted = router.route("one");
  expect(adopted).toMatchObject({ metadata: { sessionId: "one", token: "startup-socket-token" }, connection: workers.children[0].connection });
  expect(adopted.routeGeneration).toBeGreaterThan(0);
  expect(await persisted()).toEqual([{ sessionId: "one", runId: "run-startup", leaseId: handle.leaseId, generation: 1, identity: handle.identity, piChildIdentity: handle.piChildIdentity, token: "startup-socket-token", socketPath: workers.children[0].socketPath, proto: 2, cliVersion: "9.9.9", routeGeneration: adopted.routeGeneration }]);
  await supervisor.close();
});

// A spawned worker takes a moment to reach listen, so the daemon's connect retries rather than
// refusing. Past the launch's own deadline it stops, and the launch fails by name.
it("retries the connect until the spawned worker listens, and gives up at the launch deadline", async () => {
  const { runs, registry, ownership, router, sockets } = await setup(["one", "two"]);
  const workers = fakeWorkerFactory({ sockets, holdHello: true });
  const supervisor = new WorkerSupervisor({ registry, router, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => "late-listen-token", startTimeoutMs: 2_000 });

  const launched = supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-late" });
  await waitUntil(async () => workers.children.length === 1);
  let settled = false;
  void launched.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  workers.children[0].listen();
  await expect(launched).resolves.toMatchObject({ sessionId: "one", ready: true });

  const silent = fakeWorkerFactory({ sockets, holdHello: true });
  const impatient = new WorkerSupervisor({
    registry, router, ownership, runsDirectory: runs, spawnImpl: silent.spawnImpl, inspect,
    randomId: () => "never-listens-token", startTimeoutMs: 60, ...fastLaunchStop,
  });
  await expect(impatient.launch({ sessionId: "two", canonicalSessionFile: (await getRecord(registry, "two")).canonicalSessionFile, cwd: "/repo", runId: "run-silent" }))
    .rejects.toMatchObject({ code: "WORKER_SOCKET_UNREACHABLE" });
  expect(router.route("two")).toBeUndefined();
  await supervisor.close();
});

it("rejects a worker socket that answers without the per-run token", async () => {
  const { runs, registry, ownership, router, sockets } = await setup();
  const workers = fakeWorkerFactory({ sockets, holdHello: true, helloOverrides: { token: "not-the-run-token" } });
  const supervisor = new WorkerSupervisor({
    registry, router, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect,
    randomId: () => "expected-run-token", startTimeoutMs: 60, ...fastLaunchStop,
  });

  const launched = supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-forged" });
  await waitUntil(async () => workers.children.length === 1);
  workers.children[0].listen();
  await expect(launched).rejects.toMatchObject({ code: "WORKER_HELLO_MISMATCH" });
  expect(router.route("one")).toBeUndefined();
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
});

it("holds pre-adoption worker frames on the reservation and hands them over in arrival order", async () => {
  const { runs, registry, ownership, router, sockets } = await setup();
  const workers = fakeWorkerFactory({ sockets, holdReady: true });
  const supervisor = new WorkerSupervisor({ registry, router, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => "buffered-frames-token", startTimeoutMs: 200, ...fastLaunchStop });
  const launched = supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-buffered" });

  await waitUntil(async () => router.reservationFor("buffered-frames-token")?.connection !== undefined);
  const reservation = /** @type {any} */ (router.reservationFor("buffered-frames-token"));
  for (const sequence of [1, 2, 3]) workers.children[0].connection.emit({ version: 1, type: "pi_frame", token: "buffered-frames-token", sessionId: "one", frame: { sequence } });
  await waitUntil(async () => reservation.buffered.length === 3);
  expect(reservation.drainBuffered().map((/** @type {any} */ frame) => frame.frame.sequence)).toEqual([1, 2, 3]);
  await expect(launched).rejects.toMatchObject({ code: "WORKER_START_TIMEOUT" });
});

it("classifies missing Pi discovery as a pre-child refusal", async () => {
  const { runs, registry, ownership, router, sockets } = await setup();
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    resolveExecutableImpl: async () => { throw Object.assign(new Error("missing"), { code: "PI_EXECUTABLE_NOT_FOUND" }); },
  });

  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "missing" })).rejects.toMatchObject({ code: "PI_EXECUTABLE_NOT_FOUND", preChild: true });
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
  expect(await readdir(runs)).toEqual([]);
});

it("refuses a startup socket whose claimed identity is not the spawned process-group leader", async () => {
  const { runs, registry, ownership, router, sockets } = await setup(["one", "two"]);
  const badIdentity = fakeWorkerFactory({ sockets, helloOverrides: {
    worker: { pid: 777, startIdentity: "forged", processGroupId: 777 },
  } });
  const identitySupervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    spawnImpl: badIdentity.spawnImpl,
    inspect,
    randomId: () => "identity-token",
    ...fastLaunchStop,
  });
  await expect(identitySupervisor.launch({
    sessionId: "two",
    canonicalSessionFile: (await getRecord(registry, "two")).canonicalSessionFile,
    cwd: "/repo",
    runId: "run-identity",
  })).rejects.toMatchObject({ code: "WORKER_IDENTITY_MISMATCH" });

  const badRun = fakeWorkerFactory({ sockets, helloOverrides: { runId: "another-run" } });
  const runSupervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    spawnImpl: badRun.spawnImpl,
    inspect,
    randomId: () => "run-mismatch-token",
    ...fastLaunchStop,
  });
  await expect(runSupervisor.launch({
    sessionId: "one",
    canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile,
    cwd: "/repo",
    runId: "run-auth",
  })).rejects.toMatchObject({ code: "WORKER_HELLO_MISMATCH" });
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
  expect((await getRecord(registry, "two")).ownership).toBeUndefined();
  expect(router.route("one")).toBeUndefined();
  expect(router.route("two")).toBeUndefined();
});

it("atomically enforces the live-worker cap across concurrent different-session launches", async () => {
  const { runs, registry, ownership, router, sockets } = await setup(["one", "two"]);
  const workers = fakeWorkerFactory({ sockets, holdReady: true });
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    maxLive: 1,
    spawnImpl: workers.spawnImpl,
    inspect,
    randomId: () => `token-${Math.random()}`,
    startTimeoutMs: 100,
    ...fastLaunchStop,
  });

  const launches = await Promise.allSettled([
    supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-1" }),
    supervisor.launch({ sessionId: "two", canonicalSessionFile: (await getRecord(registry, "two")).canonicalSessionFile, cwd: "/repo", runId: "run-2" }),
  ]);

  expect(launches.filter((result) => result.status === "rejected" && result.reason?.code === "WORKER_CAP_REACHED")).toHaveLength(1);
  expect(workers.calls).toHaveLength(1);
});

it("releases pending ownership after spawn failure", async () => {
  const { runs, registry, ownership, router, sockets } = await setup();
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    spawnImpl() {
      throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    },
    inspect,
    randomId: () => "token",
  });

  await expect(supervisor.launch({
    sessionId: "one",
    canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile,
    cwd: "/repo",
    runId: "run-1",
  })).rejects.toThrow("spawn failed");
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
  await expect(ownership.acquire("one", (await getRecord(registry, "one")).canonicalSessionFile, "run-2")).resolves.toMatchObject({ generation: 2 });
});

it.each([
  ["activation send", { activateSendError: true }],
  ["readiness authentication", { readyOverrides: { token: "wrong" } }],
])("stops and releases durable ownership after %s failure", async (_boundary, workerOptions) => {
  const { runs, registry, ownership, router, sockets, useInspect } = await setup();
  const world = processWorld();
  useInspect(world.seams.inspect);
  const workers = fakeWorkerFactory({ sockets, ...workerOptions, world });
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    spawnImpl: workers.spawnImpl,
    randomId: () => "boundary-token",
    startTimeoutMs: 50,
    ...world.seams,
  });

  await expect(supervisor.launch({
    sessionId: "one",
    canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile,
    cwd: "/repo",
    runId: "run-boundary",
  })).rejects.toBeDefined();
  await waitUntil(async () => (await getRecord(registry, "one")).ownership === undefined);
  await expect(ownership.acquire("one", (await getRecord(registry, "one")).canonicalSessionFile, "next-run")).resolves.toMatchObject({ generation: 2 });
});

it("releases ownership and cap capacity when a ready worker and its Pi child both exit", async () => {
  const { runs, registry, ownership, router, sockets, useInspect } = await setup(["one", "two"]);
  const workers = fakeWorkerFactory({ sockets });
  const world = processWorld();
  useInspect(world.seams.inspect);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    maxLive: 1,
    spawnImpl: workers.spawnImpl,
    randomId: () => `exit-token-${workers.calls.length}`,
    ...world.seams,
  });
  const one = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-one" });

  world.exit(piChildPid(workers.children[0].pid));
  workers.children[0].emit("exit", 7, null);
  await waitUntil(async () => (await getRecord(registry, "one")).ownership === undefined);
  await expect(supervisor.launch({ sessionId: "two", canonicalSessionFile: (await getRecord(registry, "two")).canonicalSessionFile, cwd: "/repo", runId: "run-two" })).resolves.toMatchObject({ sessionId: "two" });
  await expect(supervisor.stop(one, /** @type {any} */ ({}), { gracefulMs: 1, terminateMs: 1 })).rejects.toMatchObject({ code: "UNKNOWN_WORKER" });
});

it("retains ownership and refuses a second writer while the orphaned Pi child stays exact and live", async () => {
  const { runs, registry, ownership, router, sockets, useInspect } = await setup();
  const workers = fakeWorkerFactory({ sockets });
  const world = processWorld({ signalKills: false });
  useInspect(world.seams.inspect);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    spawnImpl: workers.spawnImpl,
    randomId: () => `orphan-token-${workers.calls.length}`,
    ...world.seams,
  });
  const canonicalSessionFile = (await getRecord(registry, "one")).canonicalSessionFile;
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile, cwd: "/repo", runId: "run-orphan" });

  workers.children[0].emit("exit", 9, null);
  await waitUntil(async () => (await getRecord(registry, "one")).processState === "STALE");

  const record = await getRecord(registry, "one");
  expect(record.ownership).toMatchObject({ runId: "run-orphan", process: launched.identity });
  expect(record.activity).toMatchObject({ kind: "process_error" });
  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile, cwd: "/repo", runId: "run-second-writer" })).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
  expect(workers.calls).toHaveLength(1);
  const signals = world.log.map((entry, index) => [entry, world.log[index - 1]]).filter(([entry]) => entry.startsWith("signal:"));
  expect(signals.length).toBeGreaterThan(0);
  for (const [entry, previous] of signals) {
    expect(entry).toMatch(new RegExp(`^signal:${launched.identity.processGroupId}:`, "u"));
    expect(previous).toBe(`inspect:${piChildPid(launched.identity.pid)}`);
  }
});

it("releases ownership once the orphaned Pi child is provably gone", async () => {
  const { runs, registry, ownership, router, sockets, useInspect } = await setup();
  const workers = fakeWorkerFactory({ sockets });
  const world = processWorld({ signalKills: false });
  useInspect(world.seams.inspect);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    spawnImpl: workers.spawnImpl,
    randomId: () => `orphan-release-token-${workers.calls.length}`,
    ...world.seams,
  });
  const canonicalSessionFile = (await getRecord(registry, "one")).canonicalSessionFile;
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile, cwd: "/repo", runId: "run-orphan-release" });
  workers.children[0].emit("exit", 9, null);
  await waitUntil(async () => (await getRecord(registry, "one")).processState === "STALE");

  world.exit(piChildPid(launched.identity.pid));

  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile, cwd: "/repo", runId: "run-after-orphan" })).resolves.toMatchObject({ sessionId: "one", runId: "run-after-orphan" });
  expect(await getRecord(registry, "one")).toMatchObject({ processState: "LIVE", ownership: { runId: "run-after-orphan" } });
});

it.each([
  ["ambiguous", (/** @type {any} */ world, /** @type {number} */ pid) => world.hide(pid)],
  ["a recycled process id", (/** @type {any} */ world, /** @type {number} */ pid) => world.recycle(pid, "recycled")],
])("retains ownership and signals nothing when the recorded Pi child inspection is %s", async (_name, confuse) => {
  const { runs, registry, ownership, router, sockets, useInspect } = await setup();
  const workers = fakeWorkerFactory({ sockets });
  const world = processWorld();
  useInspect(world.seams.inspect);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    spawnImpl: workers.spawnImpl,
    randomId: () => `ambiguous-child-token-${workers.calls.length}`,
    ...world.seams,
  });
  const canonicalSessionFile = (await getRecord(registry, "one")).canonicalSessionFile;
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile, cwd: "/repo", runId: "run-ambiguous-child" });

  confuse(world, piChildPid(launched.identity.pid));
  workers.children[0].emit("exit", 9, null);
  await waitUntil(async () => (await getRecord(registry, "one")).processState === "STALE");

  expect((await getRecord(registry, "one")).ownership).toMatchObject({ runId: "run-ambiguous-child" });
  expect(world.log.filter((entry) => entry.startsWith("signal:"))).toEqual([]);
  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile, cwd: "/repo", runId: "run-second-writer" })).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
});

it("reconciles an exit observed before readiness persistence without restoring LIVE", async () => {
  const { runs, registry, ownership, router, sockets, useInspect } = await setup();
  const world = processWorld();
  useInspect(world.seams.inspect);
  const workers = fakeWorkerFactory({ sockets, readyExitTiming: "before", world });
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    spawnImpl: workers.spawnImpl,
    randomId: () => "exit-before-ready-token",
    ...world.seams,
  });

  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "exit-before-ready" })).rejects.toMatchObject({ code: "WORKER_PROCESS_EXITED" });
  expect(await getRecord(registry, "one")).toMatchObject({ processState: "EXITED" });
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
});

it("retries failed terminal release during admission and admits the next session", async () => {
  const { runs, registry, ownership, router, sockets, useInspect } = await setup(["one", "two"]);
  const world = processWorld();
  useInspect(world.seams.inspect);
  const workers = fakeWorkerFactory({ sockets, world });
  const originalRelease = ownership.release.bind(ownership);
  let releases = 0;
  ownership.release = async (...args) => {
    releases += 1;
    if (releases === 1) throw new Error("release persistence failed");
    return originalRelease(...args);
  };
  const supervisor = new WorkerSupervisor({ registry, router, ownership, runsDirectory: runs, maxLive: 1, spawnImpl: workers.spawnImpl, randomId: () => `release-retry-${workers.calls.length}`, ...world.seams });
  await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "release-retry-one" });
  workers.exitGroup(workers.children[0]);
  await waitUntil(async () => releases === 1);

  await expect(supervisor.launch({ sessionId: "two", canonicalSessionFile: (await getRecord(registry, "two")).canonicalSessionFile, cwd: "/repo", runId: "release-retry-two" })).resolves.toMatchObject({ sessionId: "two" });
  expect(releases).toBeGreaterThanOrEqual(2);
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
});

it("does not charge an ownership-free stale LIVE record against managed capacity", async () => {
  const { runs, registry, ownership, router, sockets } = await setup(["one", "two"]);
  const one = await getRecord(registry, "one");
  await registry.update("one", one.revision, { processState: "LIVE", updatedAt: "2026-08-25T12:03:00.000Z" });
  const workers = fakeWorkerFactory({ sockets });
  const supervisor = new WorkerSupervisor({ registry, router, ownership, runsDirectory: runs, maxLive: 1, spawnImpl: workers.spawnImpl, inspect, randomId: () => "stale-live-cap-token" });

  await expect(supervisor.launch({ sessionId: "two", canonicalSessionFile: (await getRecord(registry, "two")).canonicalSessionFile, cwd: "/repo", runId: "stale-live-cap" })).resolves.toMatchObject({ sessionId: "two" });
});

it("routes stop through verified Task 6 identity and releases only after observed exit", async () => {
  const { runs, registry, ownership, router, sockets, useInspect } = await setup();
  const world = processWorld();
  useInspect(world.seams.inspect);
  const workers = fakeWorkerFactory({ sockets, world });
  const supervisor = new WorkerSupervisor({ registry, router, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, randomId: () => "stop-token", ...world.seams });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-stop" });
  let inspections = 0;
  const requestGraceful = vi.fn(async () => { workers.exitGroup(workers.children[0]); });
  const signalProcessGroup = vi.fn();

  await expect(supervisor.stop(launched, {
    inspect: async () => {
      inspections += 1;
      if (inspections <= 2) return launched.identity;
      throw Object.assign(new Error("exited"), { code: "ENOENT" });
    },
    requestGraceful,
    signalProcessGroup,
    sleep: async () => {},
  }, { gracefulMs: 1, terminateMs: 1 })).resolves.toEqual({ disposition: "GRACEFUL" });

  expect(requestGraceful).toHaveBeenCalledWith(launched.identity);
  expect(signalProcessGroup).not.toHaveBeenCalled();
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
});

it("releases stale exact identity without signaling a replacement process", async () => {
  const { runs, registry, ownership, router, sockets, useInspect } = await setup();
  const world = processWorld();
  useInspect(world.seams.inspect);
  const workers = fakeWorkerFactory({ sockets, world });
  const supervisor = new WorkerSupervisor({ registry, router, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, randomId: () => "stale-token", ...world.seams });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-stale" });
  const requestGraceful = vi.fn();
  const signalProcessGroup = vi.fn();
  // The supervisor PID was recycled, so its Pi child is gone from the process table too.
  world.exit(piChildPid(launched.identity.pid));

  await expect(supervisor.stop(launched, {
    inspect: async () => ({ ...launched.identity, startIdentity: "999999" }),
    requestGraceful,
    signalProcessGroup,
    sleep: async () => {},
  }, { gracefulMs: 1, terminateMs: 1 })).resolves.toEqual({ disposition: "STALE_IDENTITY" });
  expect(requestGraceful).not.toHaveBeenCalled();
  expect(signalProcessGroup).not.toHaveBeenCalled();
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
});
