import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { OwnershipManager } from "./ownership.mjs";
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

/** Spawn a worker that completes the hello, Pi bind, and readiness handshakes without a process. */
function fakeWorkerSpawn() {
  let nextPid = 9100;
  return (/** @type {string} */ _command, /** @type {string[]} */ argv, /** @type {any} */ options) => {
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = nextPid++;
    child.connected = true;
    const token = options.env.PI_AGENTS_WORKER_TOKEN;
    const identity = () => ({
      worker: { pid: child.pid, startIdentity: String(child.pid), processGroupId: child.pid },
      piChild: { pid: child.pid + 100, startIdentity: String(child.pid + 100), processGroupId: child.pid },
    });
    const argument = (/** @type {string} */ flag) => argv[argv.indexOf(flag) + 1];
    const handshake = { sessionId: argument("--session-id"), runId: argument("--run-id"), leaseId: argument("--lease-id"), generation: Number(argument("--generation")) };
    child.send = vi.fn((/** @type {any} */ message, /** @type {any} */ callback) => {
      callback?.();
      if (message.type === "activate") queueMicrotask(() => child.emit("message", { version: 1, type: "pi_child", token, ...handshake, ...identity() }));
      if (message.type === "child_bound") queueMicrotask(() => child.emit("message", { version: 1, type: "worker_ready", token, ...handshake, ...identity() }));
      return true;
    });
    child.disconnect = vi.fn();
    child.unref = vi.fn();
    queueMicrotask(() => child.emit("message", { version: 1, type: "worker_hello", token, ...handshake, worker: identity().worker }));
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
  const supervisor = new WorkerSupervisor({
    registry,
    ownership: new OwnershipManager(registry, { randomId: () => "lease-one" }),
    runsDirectory: runs,
    spawnImpl: fakeWorkerSpawn(),
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
