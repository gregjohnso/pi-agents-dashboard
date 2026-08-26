import { chmod, copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { WorkerSupervisor } from "../runtime/worker-supervisor.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
/** @type {string[]} */
const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "installed-pi-"));
  cleanup.push(root);
  const sessions = join(root, "sessions");
  const runs = join(root, "runs");
  await mkdir(sessions, { mode: 0o700 });
  await mkdir(runs, { mode: 0o700 });
  const executable = join(root, "pi");
  await copyFile(FIXTURE, executable);
  await chmod(executable, 0o700);
  const sessionFile = join(root, "session.jsonl");
  const now = "2026-08-25T12:00:00.000Z";
  const registry = new RegistryStore(sessions);
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "one", sessionFile, canonicalSessionFile: sessionFile, cwd: root, taskState: "READY", processState: "EXITED", outcome: "NONE", activity: { kind: "saved_session", summary: "Saved", updatedAt: now }, createdAt: now, updatedAt: now });
  return { root, runs, registry, executable, sessionFile, log: join(root, "pi.log") };
}

it("omits optional launch flags by default and includes only selected model, thinking, and name flags", async () => {
  const { root, runs, registry, executable, sessionFile, log } = await setup();
  const supervisor = new WorkerSupervisor({ registry, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_EXIT_MS: "700" }, startTimeoutMs: 2_000 });
  await supervisor.launch({ sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-options", model: { provider: "fake provider", id: "model;id" }, thinkingLevel: "high", name: "name with spaces" });
  const childStart = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.kind === "start" && entry.argv.includes(sessionFile));
  expect(childStart.argv).toEqual(["--mode", "rpc", "--session", sessionFile, "--provider", "fake provider", "--model", "model;id", "--thinking", "high", "--name", "name with spaces"]);
  await supervisor.close();
});

it("rejects malformed RPC, releases ownership, and stops the exact child group", async () => {
  const { root, runs, registry, executable, sessionFile, log } = await setup();
  const supervisor = new WorkerSupervisor({ registry, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_MALFORMED_SESSION: sessionFile }, startTimeoutMs: 1_000 });
  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-malformed" })).rejects.toMatchObject({ code: "WORKER_PROCESS_EXITED" });
  expect((await registry.get("one")).ownership).toBeUndefined();
  const childStart = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.kind === "start" && entry.argv.includes(sessionFile));
  await expect(inspectProcessIdentity(childStart.pid)).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|ESRCH/u) });
});

it("rejects readiness when get_state reports a different canonical session file", async () => {
  const { root, runs, registry, executable, sessionFile } = await setup();
  const supervisor = new WorkerSupervisor({ registry, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_RUNTIME_STATE_SESSION_PATH: join(root, "wrong.jsonl") }, startTimeoutMs: 1_000 });
  await expect(supervisor.launch({ sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-state-mismatch" })).rejects.toMatchObject({ code: "WORKER_PROCESS_EXITED" });
  expect((await registry.get("one")).ownership).toBeUndefined();
});

it("buffers startup frames until worker and parent listeners are ready", async () => {
  const { root, runs, registry, executable, sessionFile } = await setup();
  const supervisor = new WorkerSupervisor({ registry, runsDirectory: runs, configuredPiPath: executable, env: { ...process.env, FAKE_PI_EVENT: "startup_notice", FAKE_PI_EXIT_MS: "700" }, startTimeoutMs: 2_000 });
  const handle = await supervisor.launch({ sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-startup-frame" });
  /** @type {Record<string, unknown>[]} */
  const frames = [];
  handle.onFrame((frame) => frames.push(frame));
  expect(frames).toContainEqual({ type: "startup_notice" });
  await supervisor.close();
});

it("launches a distinct installed Pi child with exact structured argv and persisted runtime identity", async () => {
  const { root, runs, registry, executable, sessionFile, log } = await setup();
  const supervisor = new WorkerSupervisor({
    registry,
    runsDirectory: runs,
    configuredPiPath: executable,
    env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_EXIT_MS: "700" },
    startTimeoutMs: 2_000,
  });
  const handle = await supervisor.launch({ sessionId: "one", canonicalSessionFile: sessionFile, cwd: root, runId: "run-one", piPath: executable });

  expect(handle.piChildIdentity.pid).not.toBe(handle.identity.pid);
  expect(handle.identity.processGroupId).toBe(handle.identity.pid);
  expect(handle.piChildIdentity.processGroupId).toBe(handle.identity.processGroupId);
  const logEntries = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  const childStarts = logEntries.filter((entry) => entry.kind === "start" && entry.argv.includes(sessionFile));
  expect(childStarts).toEqual([expect.objectContaining({ argv: ["--mode", "rpc", "--session", sessionFile] })]);
  expect(childStarts[0].pid).toBe(handle.piChildIdentity.pid);
  expect(logEntries.filter((entry) => entry.kind === "start" && entry.argv.includes("--help"))).toHaveLength(1);
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
      rpcAdapterVersion: 1,
    },
  });

  await supervisor.close();
  await expect(inspectProcessIdentity(handle.piChildIdentity.pid)).resolves.toEqual(handle.piChildIdentity);
});
