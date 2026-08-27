import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { OwnershipManager } from "./ownership.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { RegistryStore } from "./registry-store.mjs";
import { maintainDaemonConnection } from "./worker.mjs";
import { WorkerSupervisor } from "./worker-supervisor.mjs";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
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
async function waitForExit(pid, timeoutMs = 2_000) {
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

/** @param {RegistryStore} registry @param {string} sessionId */
async function waitForOwnershipRelease(registry, sessionId) {
  const deadline = Date.now() + 1_000;
  while ((await registry.get(sessionId))?.ownership !== undefined) {
    if (Date.now() >= deadline) throw new Error(`Ownership for ${sessionId} was not released`);
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
if (process.argv.includes("--help")) { process.stdout.write("pi fake\\n--mode rpc\\n"); process.exit(0); }
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
    if (command.type === "get_state") response = { id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "fake", sessionFile } };
    else if (command.type === "__pi_dashboard_unknown_command__") response = { id: command.id, type: "response", command: command.type, success: false, error: "unknown command" };
    else if (["prompt", "follow_up", "steer"].includes(command.type) && typeof command.message !== "string") response = { id: command.id, type: "response", command: command.type, success: false, error: "message is required" };
    else if (command.type === "extension_ui_response" && typeof command.requestId !== "string") response = { id: command.id, type: "response", command: command.type, success: false, error: "requestId is required" };
    else response = { id: command.id, type: "response", command: command.type, success: true };
    process.stdout.write(JSON.stringify(response) + "\\n");
  }
});
`, { mode: 0o700 });
  return { root, runs, registry, fakeEntry };
}

it("starts two bounded workers as distinct process-group leaders and opens sessions only after bind", async () => {
  const { root, runs, registry, fakeEntry } = await setup(["one", "two"]);
  const ownership = new OwnershipManager(registry);
  const supervisor = new WorkerSupervisor({
    registry,
    ownership,
    runsDirectory: runs,
    env: { ...process.env, PI_DASHBOARD_TEST_EXIT_MS: "700" },
    startTimeoutMs: 2_000,
  });

  const [one, two] = await Promise.all([
    supervisor.launch({ sessionId: "one", canonicalSessionFile: join(root, "one.jsonl"), cwd: root, runId: "run-one", piPath: fakeEntry }),
    supervisor.launch({ sessionId: "two", canonicalSessionFile: join(root, "two.jsonl"), cwd: root, runId: "run-two", piPath: fakeEntry }),
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

it("refuses a second writer for one canonical session", async () => {
  const { root, runs, registry, fakeEntry } = await setup(["one"]);
  const supervisor = new WorkerSupervisor({
    registry,
    ownership: new OwnershipManager(registry),
    runsDirectory: runs,
    env: { ...process.env, PI_DASHBOARD_TEST_EXIT_MS: "500" },
    startTimeoutMs: 2_000,
  });
  const request = { sessionId: "one", canonicalSessionFile: join(root, "one.jsonl"), cwd: root, piPath: fakeEntry };

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

it("disposes an active reconnect channel synchronously when worker shutdown aborts", async () => {
  const { root, runs, registry, fakeEntry } = await setup(["one"]);
  const marker = join(root, "reconnect-cleanup.txt");
  const connector = join(root, "stuck-daemon-connector.mjs");
  await writeFile(connector, `
import { appendFileSync } from "node:fs";
export async function connectDaemon({ config }) {
  let listener;
  const log = (value) => appendFileSync(config.marker, value + "\\n");
  return {
    closed: new Promise(() => {}),
    close() { log("close"); throw new Error("close failed"); },
    onMessage(nextListener) {
      listener = (message) => { log("deliver:" + message.type); nextListener(message); };
      return () => { log("remove"); listener = undefined; };
    },
    async send(message) {
      log("send:" + message.type);
      if (message.type !== "worker_ready") return;
      listener({ type: "shutdown", token: message.token });
      log("after-abort:" + (listener === undefined ? "removed" : "active"));
      listener?.({ type: "shutdown", token: message.token });
      process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
    },
  };
}
`, { mode: 0o600 });
  const supervisor = new WorkerSupervisor({
    registry,
    ownership: new OwnershipManager(registry),
    runsDirectory: runs,
    env: process.env,
    startTimeoutMs: 2_000,
    // The worker exits before its Pi child does, so the lease is released only after the child-anchored stop proves the child gone.
    launchStopPolicy: { gracefulMs: 100, terminateMs: 100 },
  });
  const launched = await supervisor.launch({
    sessionId: "one",
    canonicalSessionFile: join(root, "one.jsonl"),
    cwd: root,
    runId: "run-reconnect-cleanup",
    piPath: fakeEntry,
    daemonConnector: connector,
    daemonConnectConfig: { marker },
    reconnectDelaysMs: [5],
  });

  await supervisor.close();
  await waitForExit(launched.pid);
  const calls = (await readFile(marker, "utf8")).trim().split("\n");
  expect(calls).toContain("remove");
  expect(calls).toContain("after-abort:removed");
  expect(calls.filter((call) => call === "deliver:shutdown")).toHaveLength(1);
  expect(calls).not.toContain("send:worker_event");
  await waitForOwnershipRelease(registry, "one");
});

it("starts the injected daemon connector after inherited IPC disconnect while Pi remains alive", async () => {
  const { root, runs, registry, fakeEntry } = await setup(["one"]);
  const marker = join(root, "reconnected.txt");
  const connector = join(root, "fake-daemon-connector.mjs");
  await writeFile(connector, `
import { writeFile } from "node:fs/promises";
export async function connectDaemon({ config }) {
  let onMessage;
  return {
    closed: new Promise(() => {}),
    close() {},
    onMessage(listener) { onMessage = listener; return () => {}; },
    async send(message) {
      if (message.type === "worker_ready") {
        queueMicrotask(() => onMessage({ type: "command", token: message.token, id: "reconnected-command", command: { clientId: "reconnect-client", requestId: "reconnect-request", op: "prompt", text: "still alive" } }));
      }
      if (message.type === "command_result") await writeFile(config.marker, JSON.stringify({ ok: message.ok, stage: message.record?.stage }), { mode: 0o600 });
    },
  };
}
`, { mode: 0o600 });
  const supervisor = new WorkerSupervisor({
    registry,
    ownership: new OwnershipManager(registry),
    runsDirectory: runs,
    env: { ...process.env, PI_DASHBOARD_TEST_EXIT_MS: "700" },
    startTimeoutMs: 2_000,
  });
  const launched = await supervisor.launch({
    sessionId: "one",
    canonicalSessionFile: join(root, "one.jsonl"),
    cwd: root,
    runId: "run-reconnect",
    piPath: fakeEntry,
    daemonConnector: connector,
    daemonConnectConfig: { marker },
    reconnectDelaysMs: [5, 10],
  });

  await supervisor.close();
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ ok: true, stage: "RPC_ACKNOWLEDGED" });
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await expect(inspectProcessIdentity(launched.pid)).resolves.toEqual(launched.identity);
  await waitForExit(launched.pid);
  await waitForOwnershipRelease(registry, "one");
});
