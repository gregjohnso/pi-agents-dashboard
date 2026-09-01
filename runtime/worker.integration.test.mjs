import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { OwnershipManager } from "./ownership.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "./process-signaler.mjs";
import { RecoveredWorkerRouter } from "./reconciliation.mjs";
import { RegistryStore } from "./registry-store.mjs";
import { createWorkerControlSocket } from "./test-fixtures.mjs";
import { maintainDaemonConnection } from "./worker.mjs";
import { WorkerSupervisor } from "./worker-supervisor.mjs";

const CONNECTOR = fileURLToPath(new URL("./daemon-connector.mjs", import.meta.url));

/** @type {any[]} */
const controlSockets = [];

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
  await Promise.all(controlSockets.splice(0).map((control) => control.close()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** @param {string} root @param {string} sessionId @returns {import("../shared/contracts.mjs").SessionRecord} */
function record(root, sessionId) {
  const now = "2026-08-25T12:00:00.000Z";
  const canonicalSessionFile = join(root, `${sessionId}.jsonl`);
  return {
    schemaVersion: /** @type {const} */ (1),
    revision: 0,
    sessionId,
    sessionFile: canonicalSessionFile,
    canonicalSessionFile,
    cwd: root,
    taskState: "READY",
    processState: "EXITED",
    outcome: "NONE",
    activity: { kind: "saved_session", summary: "Saved", updatedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

/** @param {number} pid @param {number} [timeoutMs] */
async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await inspectProcessIdentity(pid);
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? "")) return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Worker ${pid} did not exit within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** @param {RegistryStore} registry @param {string} sessionId @param {number} [timeoutMs] */
// A hard wait, not a vitest budget: --testTimeout cannot extend it, so it failed above about load 13.
async function waitForOwnershipRelease(registry, sessionId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while ((await registry.get(sessionId))?.ownership !== undefined) {
    if (Date.now() >= deadline) throw new Error(`Ownership for ${sessionId} was not released`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** @param {() => Promise<boolean> | boolean} predicate */
async function waitUntil(predicate) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** @param {string[]} ids */
async function setup(ids) {
  const root = await mkdtemp(join(tmpdir(), "dashboard-worker-integration-"));
  cleanup.push(root);
  const sessions = join(root, "sessions");
  const runs = join(root, "runs");
  await mkdir(sessions, { mode: 0o700 });
  await mkdir(runs, { mode: 0o700 });
  const registry = new RegistryStore(sessions);
  for (const id of ids) await registry.create(record(root, id));
  const fakeEntry = join(root, "fake-rpc-entry.mjs");
  await writeFile(fakeEntry, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
if (process.argv.includes("--version")) { process.stdout.write("1.0.0\\n"); process.exit(0); }
const sessionIndex = process.argv.indexOf("--session");
if (sessionIndex === -1) throw new Error("missing --session");
const sessionFile = process.argv[sessionIndex + 1];
await writeFile(sessionFile, JSON.stringify({ pid: process.pid }) + "\\n", { flag: "wx", mode: 0o600 });
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  for (;;) {
    const newline = input.indexOf("\\n");
    if (newline === -1) break;
    const command = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    let response;
    if (command.type === "get_state") response = { id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "fake", sessionFile, ...(process.env.FAKE_RPC_MODEL === undefined ? {} : { model: JSON.parse(process.env.FAKE_RPC_MODEL) }) } };
    else if (command.type === "__pi_agents_unknown_command__") response = { id: command.id, type: "response", command: command.type, success: false, error: "unknown command" };
    else if (["prompt", "follow_up", "steer"].includes(command.type) && typeof command.message !== "string") response = { id: command.id, type: "response", command: command.type, success: false, error: "message is required" };
    else if (command.type === "extension_ui_response" && typeof command.requestId !== "string") response = { id: command.id, type: "response", command: command.type, success: false, error: "requestId is required" };
    else response = { id: command.id, type: "response", command: command.type, success: true };
    process.stdout.write(JSON.stringify(response) + "\\n");
  }
});
`, { mode: 0o700 });
  const router = new RecoveredWorkerRouter({ registry, inspect: inspectProcessIdentity, metadataPath: join(root, "daemon", "workers.json") });
  await router.load();
  const control = await createWorkerControlSocket({ root, router, registry });
  controlSockets.push(control);
  return { root, runs, registry, fakeEntry, router, control, launchSeams: { daemonConnector: CONNECTOR, daemonConnectConfig: control.connectConfig } };
}

it("starts two bounded workers as distinct process-group leaders and opens sessions only after bind", async () => {
  const { root, runs, registry, fakeEntry, router, control, launchSeams } = await setup(["one", "two"]);
  const ownership = new OwnershipManager(registry);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership,
    runsDirectory: runs,
    env: { ...process.env, PI_AGENTS_TEST_EXIT_MS: "700" },
    startTimeoutMs: 2_000,
  });

  const [one, two] = await Promise.all([
    supervisor.launch({ sessionId: "one", canonicalSessionFile: join(root, "one.jsonl"), cwd: root, runId: "run-one", piPath: fakeEntry, ...launchSeams }),
    supervisor.launch({ sessionId: "two", canonicalSessionFile: join(root, "two.jsonl"), cwd: root, runId: "run-two", piPath: fakeEntry, ...launchSeams }),
  ]);

  expect(one.identity.pid).not.toBe(two.identity.pid);
  expect(one.piChildIdentity.pid).not.toBe(two.piChildIdentity.pid);
  expect(one.piChildIdentity.pid).not.toBe(one.identity.pid);
  expect(two.piChildIdentity.pid).not.toBe(two.identity.pid);
  expect(one.identity.processGroupId).toBe(one.identity.pid);
  expect(two.identity.processGroupId).toBe(two.identity.pid);
  expect(JSON.parse(await readFile(join(root, "one.jsonl"), "utf8"))).toEqual({ pid: one.piChildIdentity.pid });
  expect(JSON.parse(await readFile(join(root, "two.jsonl"), "utf8"))).toEqual({ pid: two.piChildIdentity.pid });
  expect((await registry.get("one"))?.ownership?.process).toEqual(one.identity);
  expect((await registry.get("two"))?.ownership?.process).toEqual(two.identity);

  await supervisor.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect(inspectProcessIdentity(one.identity.pid)).resolves.toEqual(one.identity);
  await expect(inspectProcessIdentity(two.identity.pid)).resolves.toEqual(two.identity);
  await Promise.all([waitForExit(one.identity.pid), waitForExit(two.identity.pid)]);
  await Promise.all([waitForOwnershipRelease(registry, "one"), waitForOwnershipRelease(registry, "two")]);
});

it("records the model the launched worker read from Pi at readiness", async () => {
  const { root, runs, registry, fakeEntry, router, launchSeams } = await setup(["one"]);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership: new OwnershipManager(registry),
    runsDirectory: runs,
    env: { ...process.env, PI_AGENTS_TEST_EXIT_MS: "700", FAKE_RPC_MODEL: JSON.stringify({ provider: "openai-codex", id: "gpt-5.6-sol" }) },
    startTimeoutMs: 5_000,
  });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: join(root, "one.jsonl"), cwd: root, runId: "run-model", piPath: fakeEntry, model: { provider: "anthropic", id: "requested" }, ...launchSeams });

  // Readiness is the first write that may name a model, and it names the one Pi reported rather
  // than the one the launch asked for.
  expect(await registry.get("one")).toMatchObject({ model: { provider: "openai-codex", id: "gpt-5.6-sol" } });
  await supervisor.close();
  await waitForExit(launched.identity.pid);
  await waitForOwnershipRelease(registry, "one");
});

it("fails the session with a process error when the Pi child exits unexpectedly", async () => {
  const { root, runs, registry, fakeEntry, router, control, launchSeams } = await setup(["one"]);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership: new OwnershipManager(registry),
    runsDirectory: runs,
    env: { ...process.env, PI_AGENTS_TEST_EXIT_MS: "300" },
    startTimeoutMs: 2_000,
    launchStopPolicy: { gracefulMs: 100, terminateMs: 100 },
  });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: join(root, "one.jsonl"), cwd: root, runId: "run-pi-crash", piPath: fakeEntry, ...launchSeams });

  await waitForExit(launched.identity.pid);
  await waitForOwnershipRelease(registry, "one");
  expect(await registry.get("one")).toMatchObject({ taskState: "FAILED", processState: "EXITED", activity: { kind: "process_error" } });
  await supervisor.close();
});

it("refuses a second writer for one canonical session", async () => {
  const { root, runs, registry, fakeEntry, router, control, launchSeams } = await setup(["one"]);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership: new OwnershipManager(registry),
    runsDirectory: runs,
    env: { ...process.env, PI_AGENTS_TEST_EXIT_MS: "500" },
    startTimeoutMs: 2_000,
  });
  const request = { sessionId: "one", canonicalSessionFile: join(root, "one.jsonl"), cwd: root, piPath: fakeEntry, ...launchSeams };

  const results = await Promise.allSettled([
    supervisor.launch({ ...request, runId: "run-one" }),
    supervisor.launch({ ...request, runId: "run-two" }),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ code: "OWNERSHIP_CONFLICT" });
  const launched = /** @type {any} */ (results.find((result) => result.status === "fulfilled")?.value);
  if (launched === undefined) throw new Error("Expected one launched worker");
  await supervisor.close();
  await waitForExit(launched.identity.pid);
  await waitForOwnershipRelease(registry, "one");
});

it("rejects invalid reconnect configuration before starting the worker loop", async () => {
  const connect = /** @type {any} */ (undefined);
  await expect(maintainDaemonConnection({ connect, onConnection: async () => {}, delaysMs: [5], sleep: async () => {} })).rejects.toBeInstanceOf(TypeError);
});

it("reconnects with bounded backoff after repeated failures and eventually succeeds", async () => {
  /** @type {string[]} */
  const calls = [];
  let attempts = 0;
  const controller = new AbortController();

  await maintainDaemonConnection({
    signal: controller.signal,
    delaysMs: [5, 10],
    sleep: async (ms) => { calls.push(`sleep:${ms}`); },
    connect: async () => {
      attempts += 1;
      calls.push(`connect:${attempts}`);
      if (attempts < 3) throw new Error("daemon unavailable");
      return { closed: Promise.resolve(), close() {} };
    },
    onConnection: async () => {
      calls.push(`connected:${attempts}`);
      if (attempts === 4) controller.abort();
    },
  });

  expect(calls).toEqual([
    "connect:1",
    "sleep:5",
    "connect:2",
    "sleep:10",
    "connect:3",
    "connected:3",
    "sleep:5",
    "connect:4",
    "connected:4",
  ]);
});

it("treats throwing connection cleanup as best-effort and keeps reconnecting", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const reconnecting = maintainDaemonConnection({
    signal: controller.signal,
    delaysMs: [5],
    sleep: async () => {},
    connect: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          closed: Promise.resolve(),
          close() { throw new Error("normal cleanup failed"); },
        };
      }
      return {
        closed: Promise.resolve(),
        async close() { throw new Error("abort cleanup failed"); },
      };
    },
    onConnection: async () => {
      if (attempts === 2) controller.abort();
    },
  });

  await expect(reconnecting).resolves.toBeUndefined();
  expect(attempts).toBe(2);
});

it("keeps retrying when setup and cleanup both fail before eventual success", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await expect(maintainDaemonConnection({
    signal: controller.signal,
    delaysMs: [5, 10],
    sleep: async () => {},
    connect: async () => ({
      closed: Promise.resolve(),
      async close() { throw new Error("cleanup rejected"); },
    }),
    onConnection: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("connection setup failed");
      controller.abort();
    },
  })).resolves.toBeUndefined();
  expect(attempts).toBe(3);
});

it("closes the active daemon connection and returns on explicit shutdown", async () => {
  const controller = new AbortController();
  const connection = {
    closed: new Promise(() => {}),
    async close() { throw new Error("shutdown cleanup rejected"); },
  };
  const reconnecting = maintainDaemonConnection({
    signal: controller.signal,
    delaysMs: [5],
    sleep: async () => {},
    connect: async () => connection,
    onConnection: async () => { controller.abort(); },
  });

  await expect(reconnecting).resolves.toBeUndefined();
});

/** @param {string} root */
async function workerEntries(root) {
  try { return JSON.parse(await readFile(join(root, "daemon", "workers.json"), "utf8")).workers; }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return []; throw error; }
}

it("reconnects after daemon restart from a socket-only launch and retains the run token across adoption", async () => {
  const { root, runs, registry, fakeEntry, router, control, launchSeams } = await setup(["one"]);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership: new OwnershipManager(registry),
    runsDirectory: runs,
    startTimeoutMs: 5_000,
  });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: join(root, "one.jsonl"), cwd: root, runId: "run-reconnect", piPath: fakeEntry, ...launchSeams, reconnectDelaysMs: [5, 10] });
  const adopted = router.route("one");
  const [reserved] = await workerEntries(root);
  expect(reserved).toMatchObject({ sessionId: "one", runId: "run-reconnect", identity: launched.identity });
  expect(typeof reserved.token).toBe("string");

  // Dropping the daemon's end of the route is what a daemon restart looks like to a live worker.
  await supervisor.close();
  await waitUntil(() => router.route("one") !== undefined && router.route("one") !== adopted);
  const reconnected = router.route("one");
  expect(reconnected.routeGeneration).toBeGreaterThan(adopted.routeGeneration);
  // A replacement daemon holds none of this session's frames, and Pi has not written the newest of
  // them to its own file yet, so the worker replays its live tail before anything new on this
  // connection. The launch connection sent none, because that daemon had every frame already.
  const replayed = control.frames.filter((/** @type {any} */ frame) => frame.type === "pi_tail");
  expect(replayed).toHaveLength(1);
  expect(replayed[0]).toMatchObject({ version: 1, sessionId: "one", dropped: 0 });
  expect(replayed[0].frames.map((/** @type {any} */ frame) => frame.type)).toContain("response");
  // Adoption never rotates a run's token, so the same secret still authenticates this worker.
  expect((await workerEntries(root))[0].token).toBe(reserved.token);

  await expect(reconnected.connection.request({ version: 1, type: "command", token: reconnected.metadata.token, id: "reconnected-command", command: { clientId: "reconnect-client", requestId: "reconnect-request", op: "prompt", text: "still alive" } }, {}))
    .resolves.toMatchObject({ stage: "RPC_ACKNOWLEDGED" });

  // The run token is private: it must not reach any captured worker output or rotating diagnostic.
  const runDirectory = join(runs, (await registry.get("one"))?.runHash ?? "missing");
  const captured = await Promise.all((await readdir(runDirectory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => readFile(join(entry.parentPath ?? runDirectory, entry.name), "utf8").catch(() => "")));
  expect(captured.filter((text) => text.includes(reserved.token))).toEqual([]);
  expect(captured.length).toBeGreaterThan(0);

  // Ending the run over the reconnected route, rather than waiting out a self-exit timer, keeps this
  // test to its own subject and pins that the readopted route can still carry a graceful shutdown.
  await expect(stopVerifiedProcessGroup(launched.identity, {
    inspect: inspectProcessIdentity,
    requestGraceful: async () => { await reconnected.connection.send({ version: 1, type: "shutdown", token: reconnected.metadata.token }); },
    signalProcessGroup,
    sleep,
  }, { gracefulMs: 5_000, terminateMs: 5_000 })).resolves.toMatchObject({ disposition: "GRACEFUL" });
  await waitForOwnershipRelease(registry, "one", 5_000);
});

it("issues a new token only for a new run and removes the old entry at terminal reconciliation", async () => {
  const { root, runs, registry, fakeEntry, router, launchSeams } = await setup(["one"]);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership: new OwnershipManager(registry),
    runsDirectory: runs,
    env: { ...process.env, PI_AGENTS_TEST_EXIT_MS: "150" },
    startTimeoutMs: 5_000,
    launchStopPolicy: { gracefulMs: 100, terminateMs: 100 },
  });
  const first = await supervisor.launch({ sessionId: "one", canonicalSessionFile: join(root, "one.jsonl"), cwd: root, runId: "run-first", piPath: fakeEntry, ...launchSeams });
  const firstToken = (await workerEntries(root))[0].token;

  await waitForExit(first.pid, 5_000);
  await waitForOwnershipRelease(registry, "one", 5_000);
  await waitUntil(async () => (await workerEntries(root)).length === 0);

  await rm(join(root, "one.jsonl"), { force: true });
  const second = await supervisor.launch({ sessionId: "one", canonicalSessionFile: join(root, "one.jsonl"), cwd: root, runId: "run-second", piPath: fakeEntry, ...launchSeams });
  const [respawned] = await workerEntries(root);
  expect(respawned.runId).toBe("run-second");
  expect(respawned.token).not.toBe(firstToken);
  await supervisor.close();
  await waitForExit(second.pid, 5_000);
  await waitForOwnershipRelease(registry, "one", 5_000);

  // The row names its run directory relative to the state root, so a renamed root still resolves it.
  const runHash = (await registry.get("one"))?.runHash;
  expect(runHash).not.toContain("/");
  const renamed = `${root}-renamed`;
  cleanup.push(renamed);
  await rename(root, renamed);
  await expect(stat(join(renamed, "runs", String(runHash), "worker.stderr.log"))).resolves.toMatchObject({ size: expect.any(Number) });
  await rename(renamed, root);
});

// Operator-visible failure: a daemon restart is the moment a socket-only launch has nothing left in
// memory to identify its worker with. If the replacement daemon cannot authenticate the live run
// from durable state, the session goes unreachable while its worker and Pi child keep running.
it("adopts a live socket-only worker into a replacement daemon from its persisted run token", async () => {
  const { root, runs, registry, fakeEntry, router, control, launchSeams } = await setup(["one"]);
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    ownership: new OwnershipManager(registry),
    runsDirectory: runs,
    startTimeoutMs: 5_000,
  });
  const launched = await supervisor.launch({ sessionId: "one", canonicalSessionFile: join(root, "one.jsonl"), cwd: root, runId: "run-restart", piPath: fakeEntry, ...launchSeams, reconnectDelaysMs: [5, 10] });
  const [reserved] = await workerEntries(root);
  expect(reserved).toMatchObject({ sessionId: "one", runId: "run-restart", identity: launched.identity, piChildIdentity: launched.piChildIdentity });

  // A daemon restart takes the router and the control socket with it; the worker keeps running.
  await control.close();
  controlSockets.splice(controlSockets.indexOf(control), 1);
  await router.close();

  const replacement = new RecoveredWorkerRouter({ registry, inspect: inspectProcessIdentity, metadataPath: join(root, "daemon", "workers.json") });
  await replacement.load();
  // The replacement daemon knows this run only from what the launch persisted before it spawned.
  expect(replacement.metadata("one")).toMatchObject({ runId: "run-restart", token: reserved.token, identity: launched.identity, piChildIdentity: launched.piChildIdentity });
  expect(replacement.route("one")).toBeUndefined();
  controlSockets.push(await createWorkerControlSocket({ root, router: replacement, registry }));

  await waitUntil(() => replacement.route("one") !== undefined);
  const adopted = replacement.route("one");
  expect(adopted.metadata.token).toBe(reserved.token);
  expect(adopted.routeGeneration).toBeGreaterThan(0);
  await expect(adopted.connection.request({ version: 1, type: "command", token: adopted.metadata.token, id: "after-restart", command: { clientId: "restart-client", requestId: "restart-request", op: "prompt", text: "still alive" } }, {}))
    .resolves.toMatchObject({ stage: "RPC_ACKNOWLEDGED" });
  // The restart never touched the worker: it is the same process group the launch spawned.
  expect(await inspectProcessIdentity(launched.pid)).toEqual(launched.identity);

  // Graceful Stop over the readopted route, which is the reason the restart has to reach the worker.
  await expect(supervisor.stop(launched, {
    inspect: inspectProcessIdentity,
    requestGraceful: async () => { await adopted.connection.send({ version: 1, type: "shutdown", token: adopted.metadata.token }); },
    signalProcessGroup,
    sleep,
  }, { gracefulMs: 5_000, terminateMs: 5_000 })).resolves.toMatchObject({ disposition: "GRACEFUL" });
  await waitForOwnershipRelease(registry, "one", 5_000);
});
