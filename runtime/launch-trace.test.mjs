import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { OwnershipManager } from "./ownership.mjs";
import { RecoveredWorkerRouter } from "./reconciliation.mjs";
import { RegistryStore } from "./registry-store.mjs";
import { WorkerSupervisor } from "./worker-supervisor.mjs";

// Spelled out rather than imported, so a rename of the variable the measurement driver sets fails here.
const TRACE_VARIABLE = "PI_AGENTS_LAUNCH_TRACE";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
  delete process.env[TRACE_VARIABLE];
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** The fake worker group: a supervisor at `pid` leads the group, and its Pi child is `pid + 100`. */
const inspect = async (/** @type {number} */ pid) => ({ pid, startIdentity: String(pid), processGroupId: pid >= 9200 ? pid - 100 : pid });

/** Spawn a worker that listens on the socket the launch named and completes its handshakes. @param {any} sockets */
function fakeWorkerSpawn(sockets) {
  let nextPid = 9100;
  return (/** @type {string} */ _command, /** @type {string[]} */ argv, /** @type {any} */ options) => {
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = nextPid++;
    child.unref = vi.fn();
    const token = options.env.PI_AGENTS_WORKER_TOKEN;
    const identity = () => ({
      worker: { pid: child.pid, startIdentity: String(child.pid), processGroupId: child.pid },
      piChild: { pid: child.pid + 100, startIdentity: String(child.pid + 100), processGroupId: child.pid },
    });
    const argument = (/** @type {string} */ flag) => argv[argv.indexOf(flag) + 1];
    const handshake = { sessionId: argument("--session-id"), runId: argument("--run-id"), leaseId: argument("--lease-id"), generation: Number(argument("--generation")) };
    /** @type {Set<(frame: any) => void>} */
    const listeners = new Set();
    /** @type {any[]} */
    const buffered = [];
    /** @param {any} frame */
    const toDaemon = (frame) => {
      if (listeners.size === 0) buffered.push(frame);
      else for (const listener of [...listeners]) listener(frame);
    };
    /** @type {(value?: unknown) => void} */
    let resolveClosed = () => {};
    const connection = {
      closed: new Promise((resolve) => { resolveClosed = resolve; }),
      close: () => resolveClosed(undefined),
      async send(/** @type {any} */ message) {
        if (message.type === "activate") queueMicrotask(() => toDaemon({ version: 1, type: "pi_child", token, ...handshake, ...identity() }));
        if (message.type === "child_bound") queueMicrotask(() => toDaemon({ version: 1, type: "worker_ready", token, ...handshake, ...identity() }));
      },
      async request() { throw new Error("Unexpected worker request"); },
      /** @param {(frame: any) => void} listener */
      onMessage(listener) {
        listeners.add(listener);
        for (const frame of buffered.splice(0)) listener(frame);
        return () => listeners.delete(listener);
      },
    };
    sockets.listening.set(argument("--worker-socket"), connection);
    queueMicrotask(() => toDaemon({ version: 1, type: "hello", token, ...handshake, worker: identity().worker }));
    return child;
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "launch-trace-"));
  cleanup.push(root);
  const sessions = join(root, "sessions");
  const runs = join(root, "runs");
  await mkdir(sessions, { mode: 0o700 });
  await mkdir(runs, { mode: 0o700 });
  const now = "2026-08-25T12:00:00.000Z";
  const sessionFile = join(root, "one.jsonl");
  const registry = new RegistryStore(sessions);
  await registry.create({
    schemaVersion: 1, revision: 0, sessionId: "one", sessionFile, canonicalSessionFile: sessionFile, cwd: "/repo",
    taskState: "READY", processState: "EXITED", outcome: "NONE",
    activity: { kind: "saved_session", summary: "Saved", updatedAt: now }, createdAt: now, updatedAt: now,
  });
  await mkdir(join(root, "daemon"), { mode: 0o700 });
  /** Worker sockets, keyed by the path the launch named for each run. @type {Map<string, any>} */
  const listening = new Map();
  const sockets = { listening, connect: async (/** @type {any} */ { socketPath }) => listening.get(socketPath) ?? Promise.reject(Object.assign(new Error("unreachable"), { code: "WORKER_SOCKET_UNREACHABLE" })) };
  const router = new RecoveredWorkerRouter({ registry, inspect, metadataPath: join(root, "daemon", "workers.json"), connect: sockets.connect });
  await router.load();
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership: new OwnershipManager(registry, { randomId: () => "lease-one" }),
    runsDirectory: runs,
    spawnImpl: fakeWorkerSpawn(sockets),
    inspect,
    randomId: () => "trace-token",
  });
  return { root, registry, sessionFile, supervisor };
}

it("records readiness persistence once, for the launched session, when a destination is configured", async () => {
  const { root, registry, sessionFile, supervisor } = await setup();
  const tracePath = join(root, "launch-trace.ndjson");
  process.env[TRACE_VARIABLE] = tracePath;

  await supervisor.launch({ sessionId: "one", canonicalSessionFile: sessionFile, cwd: "/repo", runId: "run-trace" });
  await supervisor.close();

  const text = await readFile(tracePath, "utf8").catch(() => "");
  const recorded = text.trim().length === 0 ? [] : text.trim().split("\n").map((line) => JSON.parse(line));
  expect(recorded.map((entry) => entry.stage)).toEqual(["ready_persisted"]);
  expect(recorded[0]?.sessionId).toBe("one");
  expect(Number.isSafeInteger(recorded[0]?.at)).toBe(true);
  // Readiness is already persisted by the time the stage is recorded, which is what the sample assumes.
  expect(await registry.get("one")).toMatchObject({ processState: "LIVE", taskState: "READY" });
});

it("writes no trace at all when no destination is configured", async () => {
  const { root, sessionFile, supervisor } = await setup();
  delete process.env[TRACE_VARIABLE];

  await supervisor.launch({ sessionId: "one", canonicalSessionFile: sessionFile, cwd: "/repo", runId: "run-untraced" });
  await supervisor.close();

  await expect(access(join(root, "launch-trace.ndjson"))).rejects.toMatchObject({ code: "ENOENT" });
});
