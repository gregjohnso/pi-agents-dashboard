import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createCommandJournal } from "./command-journal.mjs";
import { OwnershipManager } from "./ownership.mjs";
import { RegistryStore } from "./registry-store.mjs";
import { WorkerSupervisor } from "./worker-supervisor.mjs";
import { createWorkerCommandDispatcher, createWorkerReplayStore, replayDeliveryIsAmbiguous } from "./worker.mjs";

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

/** @param {string[]} [sessionIds] @param {{ randomId?: () => string }} [options] */
async function setup(sessionIds = ["one"], options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dashboard-supervisor-"));
  cleanup.push(root);
  const sessions = join(root, "sessions");
  const runs = join(root, "runs");
  await mkdir(sessions, { mode: 0o700 });
  await mkdir(runs, { mode: 0o700 });
  const registry = new RegistryStore(sessions);
  for (const id of sessionIds) await registry.create(sessionRecord(root, id));
  const ownership = new OwnershipManager(registry, {
    randomId: options.randomId ?? (() => `lease-${Math.random()}`),
  });
  return { root, runs, registry, ownership };
}

/** @param {{ order?: string[], helloOverrides?: Record<string, unknown>, readyOverrides?: Record<string, unknown>, holdReady?: boolean, activateSendError?: boolean, readyExitTiming?: "before" | "after", commandBehavior?: "success" | "disconnect" | "delivery_unknown" | "explicit_error", commandResponder?: (command: any) => Promise<any>, world?: any }} [configuration] */
function fakeWorkerFactory({ order = [], helloOverrides = {}, readyOverrides = {}, holdReady = false, activateSendError = false, readyExitTiming, commandBehavior, commandResponder, world } = {}) {
  let nextPid = 9100;
  /** @type {any[]} */
  const children = [];
  /** @type {any[]} */
  const calls = [];
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
    child.connected = true;
    child.killed = false;
    child.send = vi.fn((message, callback) => {
      order.push(`parent:${message.type}`);
      if (message.type === "activate" && activateSendError) {
        callback?.(new Error("activation send failed"));
        return false;
      }
      callback?.();
      if (message.type === "activate") {
        queueMicrotask(() => {
          const worker = { pid: child.pid, startIdentity: String(child.pid), processGroupId: child.pid };
          const piChild = { pid: child.pid + 100, startIdentity: String(child.pid + 100), processGroupId: child.pid };
          child.emit("message", {
            version: 1,
            type: "pi_child",
            token: options.env.PI_DASHBOARD_WORKER_TOKEN,
            sessionId: argv[argv.indexOf("--session-id") + 1],
            runId: argv[argv.indexOf("--run-id") + 1],
            leaseId: argv[argv.indexOf("--lease-id") + 1],
            generation: Number(argv[argv.indexOf("--generation") + 1]),
            worker,
            piChild,
          });
        });
      }
      if (message.type === "child_bound" && !holdReady) {
        queueMicrotask(() => {
          if (readyExitTiming === "before") exitGroup(child);
          const worker = { pid: child.pid, startIdentity: String(child.pid), processGroupId: child.pid };
          const piChild = { pid: child.pid + 100, startIdentity: String(child.pid + 100), processGroupId: child.pid };
          child.emit("message", {
            version: 1,
            type: "worker_ready",
            token: options.env.PI_DASHBOARD_WORKER_TOKEN,
            sessionId: argv[argv.indexOf("--session-id") + 1],
            runId: argv[argv.indexOf("--run-id") + 1],
            worker,
            piChild,
            ...readyOverrides,
          });
          if (readyExitTiming === "after") exitGroup(child);
        });
      }
      if (message.type === "command" && commandBehavior === "success") {
        queueMicrotask(() => child.emit("message", { version: 1, type: "command_result", token: options.env.PI_DASHBOARD_WORKER_TOKEN, id: message.id, ok: true, record: { stage: "RPC_ACKNOWLEDGED" } }));
      }
      if (message.type === "command" && commandBehavior === "disconnect") {
        queueMicrotask(() => child.disconnect());
      }
      if (message.type === "command" && ["delivery_unknown", "explicit_error"].includes(commandBehavior ?? "")) {
        queueMicrotask(() => child.emit("message", {
          version: 1,
          type: "command_result",
          token: options.env.PI_DASHBOARD_WORKER_TOKEN,
          id: message.id,
          ok: false,
          error: {
            code: commandBehavior === "delivery_unknown" ? "RPC_WRITE_FAILED" : "RPC_COMMAND_FAILED",
            message: "Pi RPC failed",
            deliveryUnknown: commandBehavior === "delivery_unknown",
          },
        }));
      }
      if (message.type === "command" && commandResponder !== undefined) {
        void commandResponder(message.command).then((response) => child.emit("message", {
          version: 1,
          type: "command_result",
          token: options.env.PI_DASHBOARD_WORKER_TOKEN,
          id: message.id,
          ...response,
        }));
      }
      if (message.type === "reject" || message.type === "shutdown") {
        child.connected = false;
        queueMicrotask(() => {
          child.emit("disconnect");
          exitGroup(child);
        });
      }
      return true;
    });
    child.disconnect = vi.fn(() => {
      child.connected = false;
      child.emit("disconnect");
    });
    child.unref = vi.fn();
    calls.push({ command, argv, options, child });
    children.push(child);
    queueMicrotask(() => {
      const identity = { pid: child.pid, startIdentity: String(child.pid), processGroupId: child.pid };
      child.emit("message", {
        version: 1,
        type: "worker_hello",
        token: options.env.PI_DASHBOARD_WORKER_TOKEN,
        sessionId: argv[argv.indexOf("--session-id") + 1],
        runId: argv[argv.indexOf("--run-id") + 1],
        leaseId: argv[argv.indexOf("--lease-id") + 1],
        generation: Number(argv[argv.indexOf("--generation") + 1]),
        worker: identity,
        ...helloOverrides,
      });
    });
    return child;
  };
  return { calls, children, spawnImpl, exitGroup };
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
  const { runs, registry, ownership } = await setup();
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
  const workers = fakeWorkerFactory({ order });
  const supervisor = new WorkerSupervisor({
    registry,
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

it("queues complete frames continuously after launch and before the first handle listener", async () => {
  const { runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory();
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => "continuous-frame-token" });
  const handle = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "continuous-frame" });
  const frame = { type: "gap_frame", sequence: 1 };
  workers.children[0].emit("message", { version: 1, type: "pi_frame", token: "continuous-frame-token", sessionId: "one", frame });
  /** @type {Record<string, unknown>[]} */
  const received = [];
  handle.onFrame((/** @type {Record<string, unknown>} */ nextFrame) => received.push(nextFrame));
  expect(received).toEqual([frame]);
  await supervisor.close();
});

it("bounds complete frames by count and reports deterministic overflow before retained frames", async () => {
  const { runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory();
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => "frame-count-token" });
  const handle = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "frame-count" });
  const frame = { type: "queued" };
  const frameBytes = Buffer.byteLength(JSON.stringify(frame));
  Array.from({ length: 300 }).forEach(() => workers.children[0].emit("message", { version: 1, type: "pi_frame", token: "frame-count-token", sessionId: "one", frame }));
  /** @type {Record<string, unknown>[]} */
  const received = [];
  handle.onFrame((/** @type {Record<string, unknown>} */ nextFrame) => received.push(nextFrame));
  expect(received[0]).toEqual({ type: "pi_dashboard_frame_queue_overflow", droppedFrames: 44, droppedBytes: 44 * frameBytes, recovery: "snapshot_or_diagnostics" });
  expect(received.slice(1)).toEqual(Array.from({ length: 256 }, () => frame));
  await supervisor.close();
});

it("bounds complete frames by bytes and reports an oversized dropped frame", async () => {
  const { runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory();
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => "frame-bytes-token" });
  const handle = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "frame-bytes" });
  const oversized = { type: "oversized", payload: "x".repeat(1024 * 1024) };
  const retained = { type: "retained", sequence: 2 };
  workers.children[0].emit("message", { version: 1, type: "pi_frame", token: "frame-bytes-token", sessionId: "one", frame: oversized });
  workers.children[0].emit("message", { version: 1, type: "pi_frame", token: "frame-bytes-token", sessionId: "one", frame: retained });
  /** @type {Record<string, unknown>[]} */
  const received = [];
  handle.onFrame((/** @type {Record<string, unknown>} */ nextFrame) => received.push(nextFrame));
  expect(received).toEqual([
    { type: "pi_dashboard_frame_queue_overflow", droppedFrames: 1, droppedBytes: Buffer.byteLength(JSON.stringify(oversized)), recovery: "snapshot_or_diagnostics" },
    retained,
  ]);
  await supervisor.close();
});

it("classifies missing Pi discovery as a pre-child refusal", async () => {
  const { runs, registry, ownership } = await setup();
  const supervisor = new WorkerSupervisor({
    registry,
    ownership,
    runsDirectory: runs,
    resolveExecutableImpl: async () => { throw Object.assign(new Error("missing"), { code: "PI_EXECUTABLE_NOT_FOUND" }); },
  });

  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "missing" })).rejects.toMatchObject({ code: "PI_EXECUTABLE_NOT_FOUND", preChild: true });
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
  expect(await readdir(runs)).toEqual([]);
});

it("refuses missing capabilities before ownership or run artifacts exist", async () => {
  const { runs, registry, ownership } = await setup();
  const executable = { realpath: "/fake/pi", device: "1", inode: "2", size: 3, modifiedTimeNs: "4" };
  const supervisor = new WorkerSupervisor({
    registry,
    ownership,
    runsDirectory: runs,
    resolveExecutableImpl: async () => executable,
    probeCapabilitiesImpl: async () => ({ executable, reportedVersion: "old", rpcMode: true, jsonl: true, commands: ["get_state"], events: [], missingRequired: ["steer"] }),
  });

  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "unsupported" })).rejects.toMatchObject({ code: "UNSUPPORTED_PI_CAPABILITY", missingCapabilities: ["steer"], preChild: true });
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
  expect(await readdir(runs)).toEqual([]);
});

it("refuses executable replacement after probing and before worker spawn", async () => {
  const { runs, registry, ownership } = await setup();
  const executable = { realpath: "/fake/pi", device: "1", inode: "2", size: 3, modifiedTimeNs: "4" };
  const capabilities = /** @type {import("../shared/contracts.mjs").PiCapabilityReport} */ ({ executable, reportedVersion: "current", rpcMode: true, jsonl: true, commands: ["get_state", "prompt", "follow_up", "steer", "abort", "extension_ui_response"], events: [], missingRequired: [] });
  const supervisor = new WorkerSupervisor({
    registry,
    ownership,
    runsDirectory: runs,
    resolveExecutableImpl: async () => executable,
    probeCapabilitiesImpl: async () => capabilities,
    assertExecutableImpl: async () => { throw Object.assign(new Error("replaced"), { code: "PI_EXECUTABLE_REPLACED" }); },
  });

  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "replaced" })).rejects.toMatchObject({ code: "PI_EXECUTABLE_REPLACED", preChild: true });
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
});

it("carries generation with lease ID and rejects a generation-mismatched hello", async () => {
  const { runs, registry, ownership } = await setup(["one"], { randomId: () => "same-lease" });
  const workers = fakeWorkerFactory({ helloOverrides: { generation: 999 } });
  const supervisor = new WorkerSupervisor({
    registry,
    ownership,
    runsDirectory: runs,
    spawnImpl: workers.spawnImpl,
    inspect,
    randomId: () => "token",
    ...fastLaunchStop,
  });

  await expect(supervisor.launch({
    sessionId: "one",
    canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile,
    cwd: "/repo",
    runId: "run-1",
  })).rejects.toMatchObject({ code: "WORKER_HELLO_MISMATCH" });
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
});

it("rejects hello authentication and process identity mismatches without binding", async () => {
  const { runs, registry, ownership } = await setup(["one", "two"]);
  const badAuth = fakeWorkerFactory({ helloOverrides: { token: "wrong-token" } });
  const authSupervisor = new WorkerSupervisor({
    registry,
    ownership,
    runsDirectory: runs,
    spawnImpl: badAuth.spawnImpl,
    inspect,
    randomId: () => "expected-token",
    ...fastLaunchStop,
  });
  await expect(authSupervisor.launch({
    sessionId: "one",
    canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile,
    cwd: "/repo",
    runId: "run-auth",
  })).rejects.toMatchObject({ code: "WORKER_AUTH_FAILED" });

  const badIdentity = fakeWorkerFactory({ helloOverrides: {
    worker: { pid: 777, startIdentity: "forged", processGroupId: 777 },
    piChild: { pid: 777, startIdentity: "forged", processGroupId: 777 },
  } });
  const identitySupervisor = new WorkerSupervisor({
    registry,
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
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
  expect((await getRecord(registry, "two")).ownership).toBeUndefined();
});

it("atomically enforces the live-worker cap across concurrent different-session launches", async () => {
  const { runs, registry, ownership } = await setup(["one", "two"]);
  const workers = fakeWorkerFactory({ holdReady: true });
  const supervisor = new WorkerSupervisor({
    registry,
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
  const { runs, registry, ownership } = await setup();
  const supervisor = new WorkerSupervisor({
    registry,
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
  const { runs, registry, ownership } = await setup();
  const world = processWorld();
  const workers = fakeWorkerFactory({ ...workerOptions, world });
  const supervisor = new WorkerSupervisor({
    registry,
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

it("stops and releases ownership when readiness state persistence fails", async () => {
  const { runs, registry, ownership } = await setup();
  const world = processWorld();
  const workers = fakeWorkerFactory({ world });
  const originalUpdate = registry.update.bind(registry);
  let updates = 0;
  registry.update = async (...args) => {
    updates += 1;
    if (updates === 2) throw new Error("ready persistence failed");
    return originalUpdate(...args);
  };
  const supervisor = new WorkerSupervisor({
    registry,
    ownership,
    runsDirectory: runs,
    spawnImpl: workers.spawnImpl,
    randomId: () => "ready-persistence-token",
    ...world.seams,
  });

  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-ready-persistence" })).rejects.toThrow("ready persistence failed");
  await waitUntil(async () => (await getRecord(registry, "one")).ownership === undefined);
});

it("releases ownership and cap capacity when a ready worker and its Pi child both exit", async () => {
  const { runs, registry, ownership } = await setup(["one", "two"]);
  const workers = fakeWorkerFactory();
  const world = processWorld();
  const supervisor = new WorkerSupervisor({
    registry,
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
  const { runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory();
  const world = processWorld({ signalKills: false });
  const supervisor = new WorkerSupervisor({
    registry,
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
  const { runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory();
  const world = processWorld({ signalKills: false });
  const supervisor = new WorkerSupervisor({
    registry,
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
  const { runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory();
  const world = processWorld();
  const supervisor = new WorkerSupervisor({
    registry,
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

it("reconciles ownership when the worker exits between binding and activation", async () => {
  const { runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory({ activateSendError: true });
  const originalBind = ownership.bindProcesses.bind(ownership);
  ownership.bindProcesses = async (...args) => {
    const result = await originalBind(...args);
    queueMicrotask(() => workers.children[0].emit("exit", 1, null));
    return result;
  };
  const supervisor = new WorkerSupervisor({
    registry,
    ownership,
    runsDirectory: runs,
    spawnImpl: workers.spawnImpl,
    inspect,
    randomId: () => "bind-exit-token",
    launchStopPolicy: { gracefulMs: 1, terminateMs: 1 },
    sleepImpl: async () => {},
    signalProcessGroupImpl: async () => {},
  });

  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-bind-exit" })).rejects.toBeDefined();
  await waitUntil(async () => (await getRecord(registry, "one")).ownership === undefined);
});

it("reconciles an exit observed before readiness persistence without restoring LIVE", async () => {
  const { runs, registry, ownership } = await setup();
  const world = processWorld();
  const workers = fakeWorkerFactory({ readyExitTiming: "before", world });
  const supervisor = new WorkerSupervisor({
    registry,
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

it.each(["during", "after"])("reconciles an exit observed %s the readiness write before launch rejects", async (boundary) => {
  const { runs, registry, ownership } = await setup();
  const world = processWorld();
  const workers = fakeWorkerFactory({ world });
  const originalUpdate = registry.update.bind(registry);
  let updates = 0;
  registry.update = async (...args) => {
    updates += 1;
    if (updates === 2 && boundary === "during") workers.exitGroup(workers.children[0]);
    const result = await originalUpdate(...args);
    if (updates === 2 && boundary === "after") workers.exitGroup(workers.children[0]);
    return result;
  };
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, randomId: () => `exit-${boundary}-ready-token`, ...world.seams });

  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: `exit-${boundary}-ready` })).rejects.toMatchObject({ code: "WORKER_PROCESS_EXITED" });
  expect(await getRecord(registry, "one")).toMatchObject({ processState: "EXITED" });
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
});

it("discards a queued worker event after exit and removes listeners before durable release", async () => {
  const { runs, registry, ownership } = await setup();
  const world = processWorld();
  const workers = fakeWorkerFactory({ world });
  const originalRelease = ownership.release.bind(ownership);
  let listenersAtRelease;
  ownership.release = async (...args) => {
    listenersAtRelease = workers.children[0].listenerCount("message");
    return originalRelease(...args);
  };
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, randomId: () => "queued-event-token", ...world.seams });
  await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "queued-event" });
  const revision = (await getRecord(registry, "one")).revision;

  workers.children[0].emit("message", {
    type: "worker_event",
    token: "queued-event-token",
    sessionId: "one",
    event: { type: "TURN_STARTED", at: "2026-08-25T12:01:00.000Z" },
  });
  workers.exitGroup(workers.children[0]);

  await waitUntil(async () => (await getRecord(registry, "one")).ownership === undefined);
  expect(await getRecord(registry, "one")).toMatchObject({ revision: revision + 1, taskState: "READY", processState: "EXITED" });
  expect(listenersAtRelease).toBe(0);
});

it("finishes terminal reconciliation after an event races its registry write", async () => {
  const { runs, registry, ownership } = await setup();
  const world = processWorld();
  const workers = fakeWorkerFactory({ world });
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, randomId: () => "event-release-token", ...world.seams });
  await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "event-release" });
  const originalUpdate = registry.update.bind(registry);
  registry.update = async (...args) => {
    const result = await originalUpdate(...args);
    if (args[2]?.taskState === "WORKING") workers.exitGroup(workers.children[0]);
    return result;
  };

  workers.children[0].emit("message", {
    type: "worker_event",
    token: "event-release-token",
    sessionId: "one",
    event: { type: "TURN_STARTED", at: "2026-08-25T12:02:00.000Z" },
  });

  await waitUntil(async () => (await getRecord(registry, "one")).ownership === undefined);
  expect(await getRecord(registry, "one")).toMatchObject({ processState: "EXITED" });
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
});

it("retries failed terminal release during admission and admits the next session", async () => {
  const { runs, registry, ownership } = await setup(["one", "two"]);
  const world = processWorld();
  const workers = fakeWorkerFactory({ world });
  const originalRelease = ownership.release.bind(ownership);
  let releases = 0;
  ownership.release = async (...args) => {
    releases += 1;
    if (releases === 1) throw new Error("release persistence failed");
    return originalRelease(...args);
  };
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, maxLive: 1, spawnImpl: workers.spawnImpl, randomId: () => `release-retry-${workers.calls.length}`, ...world.seams });
  await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "release-retry-one" });
  workers.exitGroup(workers.children[0]);
  await waitUntil(async () => releases === 1);

  await expect(supervisor.launch({ sessionId: "two", canonicalSessionFile: (await getRecord(registry, "two")).canonicalSessionFile, cwd: "/repo", runId: "release-retry-two" })).resolves.toMatchObject({ sessionId: "two" });
  expect(releases).toBeGreaterThanOrEqual(2);
  expect((await getRecord(registry, "one")).ownership).toBeUndefined();
});

it("does not charge an ownership-free stale LIVE record against managed capacity", async () => {
  const { runs, registry, ownership } = await setup(["one", "two"]);
  const one = await getRecord(registry, "one");
  await registry.update("one", one.revision, { processState: "LIVE", updatedAt: "2026-08-25T12:03:00.000Z" });
  const workers = fakeWorkerFactory();
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, maxLive: 1, spawnImpl: workers.spawnImpl, inspect, randomId: () => "stale-live-cap-token" });

  await expect(supervisor.launch({ sessionId: "two", canonicalSessionFile: (await getRecord(registry, "two")).canonicalSessionFile, cwd: "/repo", runId: "stale-live-cap" })).resolves.toMatchObject({ sessionId: "two" });
});

it("answers read-only worker requests and carries session command payloads over the launch channel", async () => {
  /** @type {any[]} */
  const delivered = [];
  const { root, runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory({
    commandResponder: async (/** @type {any} */ command) => {
      delivered.push(command);
      return { ok: true, record: { clientId: command.clientId, requestId: command.requestId, op: command.op, stage: "RPC_ACKNOWLEDGED", at: new Date().toISOString(), result: command.op === "get_session_commands" ? { commands: [], models: [{ provider: "anthropic", id: "claude" }], thinkingLevels: ["off"], model: null, thinkingLevel: null } : null } };
    },
  });
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => "request-token" });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-request" });

  await expect(launched.request("get_session_commands")).resolves.toMatchObject({ result: { models: [{ provider: "anthropic", id: "claude" }] } });

  const journal = await createCommandJournal({ path: join(root, "commands.jsonl") });
  const command = /** @type {import("../shared/contracts.mjs").ClientRequest} */ ({ version: 1, clientId: "client", requestId: "model", op: "session_command", payload: { sessionId: "one", command: "set_model", model: { provider: "anthropic", id: "claude" } } });
  await expect(launched.deliver(command, journal)).resolves.toMatchObject({ stage: "COMPLETED" });
  expect(delivered.at(-1)).toMatchObject({ op: "session_command", sessionCommand: { command: "set_model", model: { provider: "anthropic", id: "claude" } } });

  const rename = /** @type {import("../shared/contracts.mjs").ClientRequest} */ ({ version: 1, clientId: "client", requestId: "rename", op: "session_command", payload: { sessionId: "one", command: "set_session_name", name: "Coverage loader" } });
  await expect(launched.deliver(rename, journal)).resolves.toMatchObject({ stage: "COMPLETED" });
  expect(delivered.at(-1)).toMatchObject({ sessionCommand: { command: "set_session_name", name: "Coverage loader" } });
  await journal.close();
  await supervisor.close();
});

it("journals exact command stages before delivery and preserves request identity", async () => {
  /** @type {string[]} */
  const order = [];
  const { root, runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory({ order, commandBehavior: "success" });
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => "command-token" });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-command" });
  const journal = await createCommandJournal({
    path: join(root, "commands.jsonl"),
    failpoint: async (name, record) => {
      if (name === "after_sync") order.push(`journal:${record.status.clientId}:${record.status.requestId}:${record.status.stage}`);
    },
  });
  const command = /** @type {import("../shared/contracts.mjs").ClientRequest} */ ({ version: 1, clientId: "client\0exact", requestId: "request\0exact", op: "prompt", payload: { sessionId: "one", text: "hello" } });

  await launched.deliver(command, journal);

  expect(await journal.history(command)).toEqual([
    expect.objectContaining({ clientId: "client\0exact", requestId: "request\0exact", stage: "ACCEPTED" }),
    expect.objectContaining({ stage: "DELIVERY_ATTEMPTED" }),
    expect.objectContaining({ stage: "WORKER_ACKNOWLEDGED" }),
    expect.objectContaining({ stage: "COMPLETED" }),
  ]);
  expect(order.indexOf("journal:client\0exact:request\0exact:ACCEPTED")).toBeLessThan(order.indexOf("parent:command"));
  await journal.close();
  await supervisor.close();
});

it("marks delivery unknown when the worker channel is lost after delivery starts", async () => {
  const { root, runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory({ commandBehavior: "disconnect" });
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => "disconnect-token" });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "run-disconnect" });
  const journal = await createCommandJournal({ path: join(root, "commands.jsonl") });
  const command = /** @type {import("../shared/contracts.mjs").ClientRequest} */ ({ version: 1, clientId: "client", requestId: "ambiguous", op: "prompt", payload: { sessionId: "one", text: "hello" } });

  await expect(launched.deliver(command, journal)).resolves.toMatchObject({ stage: "DELIVERY_UNKNOWN" });
  expect((await journal.get(command))?.stage).toBe("DELIVERY_UNKNOWN");
  await journal.close();
  await supervisor.close();
});

it("keeps the upstream journal ambiguous when the replay tail cannot advance past RPC_WRITE_STARTED", async () => {
  const { root, runs, registry, ownership } = await setup();
  const replay = await createWorkerReplayStore({
    append: async (record) => {
      if (record.stage === "DELIVERY_UNKNOWN") throw new Error("delivery unknown append failed");
    },
  });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter: {
    async prompt() { throw Object.assign(new Error("Pi stream closed"), { code: "RPC_STREAM_CLOSED" }); },
  } });
  const workers = fakeWorkerFactory({
    commandResponder: async (workerCommand) => {
      try {
        return { ok: true, record: await dispatcher.deliver(workerCommand) };
      } catch (error) {
        const failure = /** @type {{ code?: string, deliveryUnknown?: boolean }} */ (error);
        return {
          ok: false,
          error: {
            code: failure?.code ?? "RPC_FAILED",
            message: error instanceof Error ? error.message : "RPC failed",
            deliveryUnknown: failure?.deliveryUnknown === true || replayDeliveryIsAmbiguous(replay, workerCommand),
          },
        };
      }
    },
  });
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => "append-failure-upstream-token" });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: "append-failure-upstream" });
  const journal = await createCommandJournal({ path: join(root, "append-failure-commands.jsonl") });
  const command = /** @type {import("../shared/contracts.mjs").ClientRequest} */ ({ version: 1, clientId: "client", requestId: "append-failure", op: "prompt", payload: { sessionId: "one", text: "hello" } });

  await expect(launched.deliver(command, journal)).resolves.toMatchObject({ stage: "DELIVERY_UNKNOWN" });
  expect(replay.current(command)).toMatchObject({ stage: "RPC_WRITE_STARTED" });
  expect((await journal.history(command)).map(({ stage }) => stage)).toEqual(["ACCEPTED", "DELIVERY_ATTEMPTED", "DELIVERY_UNKNOWN"]);
  await journal.close();
  await supervisor.close();
});

it.each([
  ["ambiguous Pi transport loss", "delivery_unknown", "DELIVERY_UNKNOWN"],
  ["explicit Pi error", "explicit_error", "FAILED"],
])("journals %s at the matching delivery boundary", async (_name, commandBehavior, expectedStage) => {
  const { root, runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory({ commandBehavior: /** @type {any} */ (commandBehavior) });
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, inspect, randomId: () => `result-${commandBehavior}` });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: (await getRecord(registry, "one")).canonicalSessionFile, cwd: "/repo", runId: `run-${commandBehavior}` });
  const journal = await createCommandJournal({ path: join(root, `commands-${commandBehavior}.jsonl`) });
  const command = /** @type {import("../shared/contracts.mjs").ClientRequest} */ ({ version: 1, clientId: "client", requestId: commandBehavior, op: "prompt", payload: { sessionId: "one", text: "hello" } });

  await expect(launched.deliver(command, journal)).resolves.toMatchObject({ stage: expectedStage });
  expect((await journal.get(command))?.stage).toBe(expectedStage);
  await journal.close();
  await supervisor.close();
});

it("routes stop through verified Task 6 identity and releases only after observed exit", async () => {
  const { runs, registry, ownership } = await setup();
  const world = processWorld();
  const workers = fakeWorkerFactory({ world });
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, randomId: () => "stop-token", ...world.seams });
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
  const { runs, registry, ownership } = await setup();
  const world = processWorld();
  const workers = fakeWorkerFactory({ world });
  const supervisor = new WorkerSupervisor({ registry, ownership, runsDirectory: runs, spawnImpl: workers.spawnImpl, randomId: () => "stale-token", ...world.seams });
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

it("uses detached no-shell spawning, ignored stdin, file logs, and disconnects without signaling", async () => {
  const { runs, registry, ownership } = await setup();
  const workers = fakeWorkerFactory();
  const supervisor = new WorkerSupervisor({
    registry,
    ownership,
    runsDirectory: runs,
    spawnImpl: workers.spawnImpl,
    inspect,
    env: { PATH: "/safe/path", PI_UNRELATED: "retained" },
    randomId: () => "secret-token",
  });
  const canonicalSessionFile = (await getRecord(registry, "one")).canonicalSessionFile;

  const launched = await supervisor.launch({
    sessionId: "one",
    canonicalSessionFile,
    cwd: "/repo;not shell",
    runId: "run;one",
    model: { provider: "fake", id: "model;id" },
    thinkingLevel: "high",
    name: "safe;name",
    piPath: "/tmp/fake;pi",
    daemonConnector: "/tmp/fake connector.mjs",
    daemonConnectConfig: { socketPath: "/tmp/daemon socket" },
    reconnectDelaysMs: [10, 20],
  });
  const call = workers.calls[0];
  expect(call.command).toBe(process.execPath);
  expect(call.options).toMatchObject({ detached: true, shell: false });
  expect(call.options.stdio[0]).toBe("ignore");
  expect(typeof call.options.stdio[1]).toBe("number");
  expect(typeof call.options.stdio[2]).toBe("number");
  expect(call.options.env).toEqual({
    PATH: "/safe/path",
    PI_UNRELATED: "retained",
    PI_DASHBOARD_WORKER_TOKEN: "secret-token",
  });
  expect(call.argv).toContain(canonicalSessionFile);
  expect(call.argv).toContain("run;one");
  expect(call.argv).toContain("model;id");
  expect(call.argv.slice(call.argv.indexOf("--daemon-connector"))).toEqual([
    "--daemon-connector", "/tmp/fake connector.mjs",
    "--daemon-connect-config", JSON.stringify({ socketPath: "/tmp/daemon socket" }),
    "--reconnect-delays-ms", "[10,20]",
  ]);

  await supervisor.close();
  expect(call.child.disconnect).toHaveBeenCalledOnce();
  expect(call.child.killed).toBe(false);
  expect(launched.identity.pid).toBe(call.child.pid);
});
