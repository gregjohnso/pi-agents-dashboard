import { chmod, copyFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { signalProcessGroup, sleep } from "../runtime/process-signaler.mjs";
import { RecoveredWorkerRouter } from "../runtime/reconciliation.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { createWorkerControlClient } from "../runtime/test-fixtures.mjs";
import { WorkerSupervisor } from "../runtime/worker-supervisor.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const harness = createRealProcessHarness("installed-pi");
/** @type {any[]} */
const controlSockets = [];
afterEach(async () => {
  await Promise.all(controlSockets.splice(0).map((control) => control.close()));
  await harness.cleanup();
});

/** Launch one real worker and record it, so a timeout around this test cannot leave it running. */
async function launch(supervisor, request) {
  const handle = await supervisor.launch(request);
  await harness.record(`worker ${request.runId}`, handle.identity);
  return handle;
}

/** @param {number} pid @param {number} [timeoutMs] */
async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await inspectProcessIdentity(pid);
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Worker ${pid} did not exit within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function setup() {
  const root = await harness.stateRoot("installed-pi-", ["sessions", "runs"]);
  const sessions = join(root, "sessions");
  const runs = join(root, "runs");
  const executable = join(root, "pi");
  await copyFile(FIXTURE, executable);
  await chmod(executable, 0o700);
  const sessionFile = join(root, "session.jsonl");
  const now = "2026-08-25T12:00:00.000Z";
  const registry = new RegistryStore(sessions);
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "one", sessionFile, canonicalSessionFile: sessionFile, cwd: root, taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "saved_session", summary: "Saved", updatedAt: now }, createdAt: now, updatedAt: now });
  const control = createWorkerControlClient({ registry });
  controlSockets.push(control);
  const router = new RecoveredWorkerRouter({ registry, inspect: inspectProcessIdentity, metadataPath: join(root, "daemon", "workers.json"), ...control.routerSeams });
  await router.load();
  return { root, runs, registry, executable, sessionFile, router, control, log: join(root, "pi.log") };
}

it("omits optional launch flags by default and includes only selected model and name flags", async () => {
  const { root, runs, registry, executable, sessionFile, log, router, control } = await setup();
  const supervisor = new WorkerSupervisor({ registry, router, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_EXIT_MS: "700" }, startTimeoutMs: 2_000 });
  await launch(supervisor, { sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-options", model: { provider: "fake provider", id: "model;id" }, thinkingLevel: "high", name: "name with spaces" });
  const childStart = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.kind === "start" && entry.argv.includes(sessionFile));
  // Pi restores its own thinking level from the session file, so no launch selects one.
  expect(childStart.argv).toEqual(["--mode", "rpc", "--session", sessionFile, "--provider", "fake provider", "--model", "model;id", "--name", "name with spaces"]);
  await supervisor.close();
});

// Operator-visible failure: exposing the run credential to Pi lets an extension impersonate the
// daemon on the worker socket. Removing anything else from Pi's environment can break its tools.
it("keeps the worker socket credential out of installed Pi while preserving unrelated environment", async () => {
  const { root, runs, registry, executable, sessionFile, log, router } = await setup();
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    runsDirectory: runs,
    configuredPiPath: executable,
    env: { ...process.env, FAKE_PI_LOG: log, PI_AGENTS_BOUNDARY_MARKER: "preserved" },
    startTimeoutMs: 2_000,
  });
  const handle = await launch(supervisor, { sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-environment" });
  const route = router.route("one");

  try {
    const childStart = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.kind === "start" && entry.argv.includes(sessionFile));
    expect(childStart).toMatchObject({ workerTokenPresent: false, boundaryMarker: "preserved" });
  } finally {
    await stopWorker(supervisor, handle, route);
  }
});

// Operator-visible failure: if Pi crashes while the daemon is absent, generic reconciliation must
// not turn the failed row back into a ready, exited session and hide the process error details.
it("retains Pi child crash details through daemon absence and replacement reconciliation", async () => {
  const root = await harness.stateRoot("installed-pi-crash-recovery-", ["runs"]);
  const executable = join(root, "pi");
  await copyFile(FIXTURE, executable);
  await chmod(executable, 0o700);
  const env = { ...process.env, PI_AGENTS_TEST_EXIT_MS: "5000", PI_AGENTS_IDLE_EXIT_MS: "0" };
  const started = await harness.daemon("start", { root, piBin: executable, env, timeoutMs: 20_000 });
  expect(started).toMatchObject({ code: 0, result: { kind: "daemon_started" } });
  const client = createDaemonClient({ socketPath: join(root, "daemon", "control.sock"), token: (await readFile(join(root, "daemon", "control.token"), "utf8")).trim(), clientId: "crash-recovery", reconnect: false, maxBytes: 256 * 1024 });
  await client.connect();
  const launched = await client.request({
    version: 1,
    clientId: "crash-recovery",
    requestId: "launch",
    op: "launch",
    payload: { prompt: "wait", cwd: root, sourceSessionId: "source", isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: [] } },
  });
  if (!launched.ok) throw new Error(`Launch failed: ${JSON.stringify(launched)}`);
  const registry = new RegistryStore(join(root, "sessions"));
  const [live] = await registry.list();
  if (live?.ownership?.process === undefined || typeof live.runHash !== "string") throw new Error("Launch did not publish worker ownership and run directory");
  await harness.record("worker awaiting Pi crash", live.ownership.process);
  await client.close();

  const stopped = await harness.daemon("stop", { root, allowLiveWorkers: true, env });
  expect(stopped.code).toBe(0);
  await waitForExit(live.ownership.process.pid, 10_000);
  const causePath = join(root, "runs", live.runHash, "terminal-cause.json");
  expect((await stat(causePath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(causePath, "utf8"))).toMatchObject({
    schemaVersion: 1,
    sessionId: live.sessionId,
    runId: live.ownership.runId,
    event: { type: "PI_CHILD_CRASHED", summary: "Pi exited unexpectedly (SIGTERM)" },
  });

  const replacement = await harness.daemon("start", { root, piBin: executable, env, timeoutMs: 20_000 });
  expect(replacement).toMatchObject({ code: 0, result: { kind: "daemon_started" } });
  const recovered = await registry.get(live.sessionId);
  expect(recovered).toMatchObject({ taskState: "FAILED", processState: "EXITED", activity: { kind: "process_error", summary: "Pi exited unexpectedly (SIGTERM)" } });
  expect(recovered?.ownership).toBeUndefined();
  await expect(readFile(causePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("rejects malformed RPC, releases ownership, and stops the exact child group", async () => {
  const { root, runs, registry, executable, sessionFile, log, router, control } = await setup();
  const supervisor = new WorkerSupervisor({ registry, router, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_MALFORMED_SESSION: sessionFile }, startTimeoutMs: 1_000 });
  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-malformed" })).rejects.toMatchObject({ code: "WORKER_PROCESS_EXITED" });
  expect((await registry.get("one")).ownership).toBeUndefined();
  const childStart = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.kind === "start" && entry.argv.includes(sessionFile));
  await expect(inspectProcessIdentity(childStart.pid)).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|ESRCH/u) });
});

it("rejects readiness when get_state reports a different canonical session file", async () => {
  const { root, runs, registry, executable, sessionFile, router, control } = await setup();
  const supervisor = new WorkerSupervisor({ registry, router, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_RUNTIME_STATE_SESSION_PATH: join(root, "wrong.jsonl") }, startTimeoutMs: 1_000 });
  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-state-mismatch" })).rejects.toMatchObject({ code: "WORKER_PROCESS_EXITED" });
  expect((await registry.get("one")).ownership).toBeUndefined();
});

it("holds a startup frame on the reservation and delivers it over the adopted route", async () => {
  const { root, runs, registry, executable, sessionFile, router, control } = await setup();
  const supervisor = new WorkerSupervisor({ registry, router, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_EVENT: "startup_notice", FAKE_PI_EXIT_MS: "700" }, startTimeoutMs: 2_000 });
  await launch(supervisor, { sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-startup-frame" });
  // A frame Pi emitted before the route existed is held on the reservation and arrives after adoption.
  const deadline = Date.now() + 5_000;
  while (!control.frames.some((/** @type {any} */ frame) => frame.type === "pi_frame" && frame.frame?.type === "startup_notice")) {
    if (Date.now() >= deadline) throw new Error("Startup frame never crossed the adopted route");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await supervisor.close();
});

it("launches a distinct installed Pi child with exact structured argv and persisted runtime identity", async () => {
  const { root, runs, registry, executable, sessionFile, log, router, control } = await setup();
  const supervisor = new WorkerSupervisor({
    registry,
    router,
    runsDirectory: runs,
    configuredPiPath: executable,
    env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_EXIT_MS: "700" },
    startTimeoutMs: 2_000,
  });
  const handle = await launch(supervisor, { sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-one", piPath: executable });

  expect(handle.piChildIdentity.pid).not.toBe(handle.identity.pid);
  expect(handle.identity.processGroupId).toBe(handle.identity.pid);
  expect(handle.piChildIdentity.processGroupId).toBe(handle.identity.processGroupId);
  const logEntries = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  const childStarts = logEntries.filter((entry) => entry.kind === "start" && entry.argv.includes(sessionFile));
  expect(childStarts).toEqual([expect.objectContaining({ argv: ["--mode", "rpc", "--session", sessionFile] })]);
  expect(childStarts[0].pid).toBe(handle.piChildIdentity.pid);
  expect(logEntries.filter((entry) => entry.kind === "start" && entry.argv.includes("--version"))).toHaveLength(1);
  expect(logEntries.filter((entry) => entry.kind === "start" && entry.argv.includes("--help"))).toHaveLength(0);
  expect(logEntries.filter((entry) => entry.kind === "command").map(({ command, providerInvocation }) => [command, providerInvocation])).toEqual(expect.arrayContaining([
    ["get_state", false], ["prompt", false], ["follow_up", false], ["steer", false], ["abort", false], ["extension_ui_response", false],
  ]));
  expect(logEntries.some((entry) => entry.providerInvocation)).toBe(false);
  expect(await registry.get("one")).toMatchObject({
    ownership: { process: handle.identity },
    runtime: {
      executable: { realpath: executable },
      supervisor: handle.identity,
      piChild: handle.piChildIdentity,
      piVersion: "1.0.0",
      rpcAdapterVersion: 1,
    },
  });

  await supervisor.close();
  await expect(inspectProcessIdentity(handle.piChildIdentity.pid)).resolves.toEqual(handle.piChildIdentity);
});

/** Read every command the fake Pi children were asked to run, in order. @param {string} log */
async function piCommands(log) {
  return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.kind === "command");
}

/** Stop one launched worker through the verified process-identity boundary Stop uses. */
async function stopWorker(supervisor, handle, route) {
  await supervisor.stop(handle, {
    inspect: inspectProcessIdentity,
    requestGraceful: async () => { await route.connection.send({ version: 1, type: "shutdown", token: route.metadata.token }); },
    signalProcessGroup,
    sleep,
  }, { gracefulMs: 5_000, terminateMs: 5_000 });
}

it("delivers the operator's text once while Pi is already running a turn, with no refusal reaching him", async () => {
  const { root, runs, registry, executable, sessionFile, log, router } = await setup();
  const supervisor = new WorkerSupervisor({ registry, router, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_STREAMING: "active" }, startTimeoutMs: 5_000 });
  const handle = await launch(supervisor, { sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-busy-prompt" });
  const route = router.route("one");

  try {
    // Pi started this turn before any turn_state event reached the dashboard, so the dashboard still
    // believes the session is idle and sends `prompt`. Pi's state decides, not that cached belief.
    await expect(route.connection.request({ version: 1, type: "command", token: route.metadata.token, id: "busy-prompt", command: { clientId: "dashboard", requestId: "push", op: "prompt", text: "push" } }, {}))
      .resolves.toMatchObject({ stage: "RPC_ACKNOWLEDGED" });

    expect((await piCommands(log)).filter((entry) => entry.message === "push")).toEqual([
      expect.objectContaining({ command: "prompt", streamingBehavior: "steer" }),
    ]);
  } finally {
    await stopWorker(supervisor, handle, route);
  }
});

it("keeps both dashboards' text when each submits believing the same session is idle", async () => {
  const { root, runs, registry, executable, sessionFile, log, router } = await setup();
  const supervisor = new WorkerSupervisor({ registry, router, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_STREAMING: "on_prompt" }, startTimeoutMs: 5_000 });
  const handle = await launch(supervisor, { sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-two-dashboards" });
  const route = router.route("one");
  const command = (clientId, text) => route.connection.request({ version: 1, type: "command", token: route.metadata.token, id: `submit-${clientId}`, command: { clientId, requestId: `submit-${clientId}`, op: "prompt", text } }, {});

  try {
    // The first submission starts the turn. The second dashboard's cache cannot have seen that yet.
    await expect(command("dashboard-a", "ship it")).resolves.toMatchObject({ stage: "RPC_ACKNOWLEDGED" });
    await expect(command("dashboard-b", "and push")).resolves.toMatchObject({ stage: "RPC_ACKNOWLEDGED" });

    expect((await piCommands(log)).filter((entry) => ["ship it", "and push"].includes(entry.message))).toEqual([
      expect.objectContaining({ command: "prompt", message: "ship it", streamingBehavior: "steer" }),
      expect.objectContaining({ command: "prompt", message: "and push", streamingBehavior: "steer" }),
    ]);
  } finally {
    await stopWorker(supervisor, handle, route);
  }
});
