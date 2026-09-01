import { chmod, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { createDaemonRuntime } from "../runtime/daemon.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { WorkerSupervisor } from "../runtime/worker-supervisor.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const fakePiSource = await readFile(fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url)), "utf8");
const harness = createRealProcessHarness("lifecycle-acceptance");
const runtimes = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  // The harness stops each detached daemon before its root disappears, because a daemon whose
  // publication is deleted can no longer be stopped by identity, then reaps every worker and Pi
  // child recorded below by that same exact identity.
  await harness.cleanup();
});

function sourceFor(version) {
  return fakePiSource.replace('process.env.FAKE_PI_VERSION ?? "1.0.0"', JSON.stringify(version));
}

function record(root, sessionId) {
  const at = "2026-08-25T12:00:00.000Z";
  const canonicalSessionFile = join(root, "canonical", `${sessionId}.jsonl`);
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId,
    sessionFile: canonicalSessionFile,
    canonicalSessionFile,
    cwd: root,
    taskState: "READY",
    processState: "EXITED",
    outcome: "NONE",
    activity: { kind: "saved_session", summary: "Saved", updatedAt: at },
    createdAt: at,
    updatedAt: at,
  };
}

async function setupRoot(prefix) {
  return harness.stateRoot(prefix, ["canonical", "daemon", "sessions", "queue", "runs", "index"]);
}

function request(clientId, requestId, op, payload) {
  return { version: 1, clientId, requestId, op, payload };
}

async function waitForSnapshot(client, sessionId, predicate) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const snapshot = await client.getViewerSnapshot(sessionId);
    if (predicate(snapshot)) return snapshot;
    if (Date.now() >= deadline) throw new Error(`Viewer snapshot for ${sessionId} did not reach the expected state`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function nextMatching(iterator, predicate) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Viewer replay did not contain the expected event");
    const next = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Viewer replay timed out")), remaining)),
    ]);
    if (next.done) throw new Error("Viewer replay ended before the expected event");
    if (predicate(next.value)) return next.value;
  }
}

it("starts the production daemon with launch resolution and delivers the composer prompt", async () => {
  const root = await setupRoot("pi-agents-production-launch-");
  const executable = join(root, "pi");
  const log = join(root, "fake-pi.jsonl");
  await writeFile(executable, sourceFor("0.84.0"), { mode: 0o700 });
  await chmod(executable, 0o700);
  const env = { ...process.env, FAKE_PI_LOG: log, FAKE_PI_EVENT_AFTER_COMMAND: "prompt", FAKE_PI_ONE_WAY_EXTENSION_UI_RESPONSE: "1" };
  let client;
  try {
    const started = await harness.daemon("start", { root, piBin: executable, env, timeoutMs: 20_000 });
    expect(started).toMatchObject({ code: 0, result: { kind: "daemon_started" } });
    client = createDaemonClient({ socketPath: join(root, "daemon", "control.sock"), token: (await readFile(join(root, "daemon", "control.token"), "utf8")).trim(), clientId: "production-launch", reconnect: false, maxBytes: 256 * 1024 });
    await client.connect();
    const launched = await client.request(request("production-launch", "launch-request", "launch", {
      prompt: "who are you?",
      cwd: root,
      sourceSessionId: "dashboard-production-launch",
      isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: [] },
    }));
    if (!launched.ok) throw new Error(`Production launch failed: ${JSON.stringify(launched)}`);
    expect(launched).toMatchObject({ ok: true, result: { kind: "launched", sessionId: expect.any(String) } });
    const state = await client.request(request("production-launch", "state-after-launch", "get_state", {}));
    expect(state).toMatchObject({ ok: true, result: { kind: "state", sessions: [expect.objectContaining({ sessionId: launched.result.sessionId })] } });
    const records = await new RegistryStore(join(root, "sessions")).list();
    if (records[0]?.ownership?.process !== undefined) await harness.record("launched worker", records[0].ownership.process);
    expect(records).toEqual([expect.objectContaining({ sessionId: launched.result.sessionId, cwd: root, isolation: { mode: "shared_directory", canonicalCwd: root }, processState: "LIVE" })]);
    const commands = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).filter((entry) => entry.kind === "command");
    expect(commands.some((entry) => entry.command === "prompt" && entry.message === "who are you?" && entry.valid === true)).toBe(true);
  } finally {
    await client?.close();
    const stopped = await harness.daemon("stop", { root, allowLiveWorkers: true, env });
    if (![0, 3].includes(stopped.code)) throw new Error(`Production daemon cleanup failed: ${JSON.stringify(stopped)}`);
  }
}, 30_000);

it("keeps two mixed-version fake Pi children alive across frontend close and daemon restart, then replays later frames", async () => {
  const root = await setupRoot("pi-agents-lifecycle-acceptance-");
  const executable = join(root, "pi-current");
  const replacement = join(root, "pi-next");
  const log = join(root, "fake-pi.jsonl");
  await writeFile(executable, sourceFor("0.84.1"), { mode: 0o700 });
  await chmod(executable, 0o700);

  const registry = new RegistryStore(join(root, "sessions"));
  const supervisor = new WorkerSupervisor({
    registry,
    runsDirectory: join(root, "runs"),
    configuredPiPath: executable,
    env: { ...process.env, FAKE_PI_EVENT_AFTER_COMMAND: "prompt", FAKE_PI_LOG: log },
    startTimeoutMs: 2_000,
  });
  const handles = [];
  const managedSupervisor = {
    useRouter: (router) => supervisor.useRouter(router),
    async launch(launch) {
      const handle = await supervisor.launch(launch);
      handles.push(handle);
      await harness.record(`worker for ${launch.sessionId}`, handle.identity);
      return handle;
    },
    close: () => supervisor.close(),
  };
  const launches = new Map([
    ["launch-one", { sessionId: "one", runId: "run-one" }],
    ["launch-two", { sessionId: "two", runId: "run-two" }],
  ]);
  const resolveLaunchRequest = async (launchRequest) => {
    const selected = launches.get(launchRequest.requestId);
    if (selected === undefined) throw new Error("Unknown acceptance launch");
    const sessionRecord = record(root, selected.sessionId);
    return { ...selected, sessionRecord, canonicalSessionFile: sessionRecord.canonicalSessionFile, cwd: root, piPath: executable };
  };

  const firstRuntime = await createDaemonRuntime({ root, workerSupervisor: managedSupervisor, resolveLaunchRequest, hostProbe: async () => ({ blockers: [] }), reconnectTimeoutMs: 2_000 });
  runtimes.push(firstRuntime);
  await firstRuntime.ready;
  const first = createDaemonClient({ socketPath: firstRuntime.socketPath, token: firstRuntime.token, clientId: "frontend-before", reconnect: false, maxBytes: 256 * 1024 });
  await first.connect();
  const launchPayload = { prompt: "bounded fake task", cwd: root, sourceSessionId: "source", isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: [] } };
  const launchedOne = first.request(request("frontend-before", "launch-one", "launch", launchPayload));

  await writeFile(replacement, sourceFor("0.84.2"), { mode: 0o700 });
  await chmod(replacement, 0o700);
  const firstResponse = await launchedOne;
  expect(firstResponse).toMatchObject({ ok: true, result: { kind: "launched", sessionId: "one" } });
  await rename(replacement, executable);
  const secondResponse = await first.request(request("frontend-before", "launch-two", "launch", launchPayload));
  expect(secondResponse).toMatchObject({ ok: true, result: { kind: "launched", sessionId: "two" } });
  expect(handles).toHaveLength(2);

  const beforeRecords = await Promise.all([registry.get("one"), registry.get("two")]);
  expect(beforeRecords).toEqual([
    expect.objectContaining({ sessionId: "one", canonicalSessionFile: join(root, "canonical", "one.jsonl"), runtime: expect.objectContaining({ piVersion: "0.84.1", rpcAdapterVersion: 1 }) }),
    expect.objectContaining({ sessionId: "two", canonicalSessionFile: join(root, "canonical", "two.jsonl"), runtime: expect.objectContaining({ piVersion: "0.84.2", rpcAdapterVersion: 1 }) }),
  ]);
  expect(beforeRecords[0].runtime.executable).not.toEqual(beforeRecords[1].runtime.executable);
  expect(new Set(handles.flatMap((handle) => [handle.identity.pid, handle.piChildIdentity.pid])).size).toBe(4);
  expect(handles.every((handle) => handle.identity.processGroupId === handle.identity.pid && handle.piChildIdentity.processGroupId === handle.identity.processGroupId)).toBe(true);

  const probeLog = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  expect(probeLog.filter((entry) => entry.kind === "start" && entry.argv.includes("--version"))).toHaveLength(2);
  expect(probeLog.filter((entry) => entry.kind === "start" && entry.argv.includes("--help"))).toHaveLength(0);
  expect(probeLog.filter((entry) => entry.kind === "start" && entry.argv.includes("--mode")).every((entry) => entry.argv.slice(0, 4).join(" ") === `--mode rpc --session ${entry.argv[3]}` && entry.providerInvocation === false)).toBe(true);
  expect(probeLog.filter((entry) => entry.kind === "command").every((entry) => entry.providerInvocation === false)).toBe(true);

  const prior = new Map();
  for (const sessionId of ["one", "two"]) prior.set(sessionId, (await first.getViewerSnapshot(sessionId)).cursor);
  await first.close();
  await firstRuntime.close();
  runtimes.splice(runtimes.indexOf(firstRuntime), 1);
  for (const handle of handles) {
    await expect(inspectProcessIdentity(handle.identity.pid)).resolves.toEqual(handle.identity);
    await expect(inspectProcessIdentity(handle.piChildIdentity.pid)).resolves.toEqual(handle.piChildIdentity);
  }

  const secondRuntime = await createDaemonRuntime({ root, hostProbe: async () => ({ blockers: [] }), reconnectTimeoutMs: 2_000 });
  runtimes.push(secondRuntime);
  await secondRuntime.ready;
  expect(secondRuntime.daemonEpoch).toBe(firstRuntime.daemonEpoch);
  const afterRestart = await Promise.all([registry.get("one"), registry.get("two")]);
  expect(afterRestart.map((value) => [value.sessionId, value.canonicalSessionFile, value.runtime.piVersion, value.ownership.runId])).toEqual([
    ["one", join(root, "canonical", "one.jsonl"), "0.84.1", "run-one"],
    ["two", join(root, "canonical", "two.jsonl"), "0.84.2", "run-two"],
  ]);

  const second = createDaemonClient({ socketPath: secondRuntime.socketPath, token: secondRuntime.token, clientId: "frontend-after", attachId: "attach-after-restart", reconnect: false, maxBytes: 256 * 1024 });
  await second.connect();
  for (const sessionId of ["one", "two"]) {
    const attachment = await second.request(request("frontend-after", `attach-${sessionId}`, "attach", { sessionId }));
    expect(attachment).toMatchObject({ ok: true, result: { kind: "attached", sessionId } });
    const response = await second.request(request("frontend-after", `prompt-${sessionId}`, "prompt", { sessionId, text: `later ${sessionId}` }));
    expect(response).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  }

  for (const sessionId of ["one", "two"]) {
    const expectedText = `later:${join(root, "canonical", `${sessionId}.jsonl`)}`;
    const snapshot = await waitForSnapshot(second, sessionId, (value) => JSON.stringify(value.items).includes(expectedText));
    expect(snapshot.sessionId).toBe(sessionId);
    const replay = second.subscribeViewer(sessionId, prior.get(sessionId))[Symbol.asyncIterator]();
    const replayed = await nextMatching(replay, (value) => value.payload.kind === "assistant_message" && JSON.stringify(value.payload).includes(expectedText));
    expect(BigInt(replayed.cursor.sequence)).toBeGreaterThan(BigInt(prior.get(sessionId).sequence));
    await replay.return?.();
  }
  await second.close();
}, 20_000);

it("refuses a missing required capability before ownership, canonical writer, or run artifacts", async () => {
  const root = await setupRoot("pi-agents-capability-acceptance-");
  const executable = join(root, "pi");
  await writeFile(executable, sourceFor("0.84.4"), { mode: 0o700 });
  await chmod(executable, 0o700);
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "unsupported");
  await registry.create(session);
  const supervisor = new WorkerSupervisor({ registry, runsDirectory: join(root, "runs"), configuredPiPath: executable, env: { ...process.env, FAKE_PI_MISSING: "steer" }, startTimeoutMs: 2_000 });

  await expect(supervisor.launch({ sessionId: session.sessionId, canonicalSessionFile: session.canonicalSessionFile, cwd: root, runId: "unsupported-run" })).rejects.toMatchObject({ code: "UNSUPPORTED_PI_CAPABILITY", missingCapabilities: ["steer"] });
  expect((await registry.get(session.sessionId)).ownership).toBeUndefined();
  await expect(readFile(session.canonicalSessionFile)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(join(root, "runs"))).toEqual([]);
  await supervisor.close();
});
