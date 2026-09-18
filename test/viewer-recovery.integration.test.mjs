import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { listenForDaemon } from "../runtime/worker-socket.mjs";
import { createDaemonRuntime } from "../runtime/daemon.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { createLiveTail } from "../runtime/worker-live-tail.mjs";

/** @type {string[]} */
const directories = [];
/** @type {any[]} */
const workers = [];
/** @type {any[]} */
const runtimes = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close().catch(() => {})));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const at = "2026-08-25T00:00:00.000Z";
const identity = { pid: 811, startIdentity: "worker-shared", processGroupId: 811 };
const piChildIdentity = { pid: 812, startIdentity: "pi-shared", processGroupId: 811 };
const workerToken = "shared-worker-token";

/** @param {number} pid */
async function inspect(pid) {
  if (pid === process.pid) return { pid, startIdentity: "daemon", processGroupId: process.pid };
  if (pid === identity.pid) return identity;
  if (pid === piChildIdentity.pid) return piChildIdentity;
  throw Object.assign(new Error("gone"), { code: "ESRCH" });
}

/** One state root holding one live session whose canonical file already carries a completed turn. */
async function liveSession() {
  const directory = await mkdtemp(join(tmpdir(), "viewer-recovery-"));
  directories.push(directory);
  const root = join(directory, "state");
  for (const name of ["daemon", "sessions", "runs", "index"]) await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const sessionFile = join(directory, "canonical.jsonl");
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: at, cwd: directory }),
    JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: at, message: { role: "user", content: "hello" } }),
  ].join("\n") + "\n", { mode: 0o600 });
  const registry = new RegistryStore(join(root, "sessions"));
  await registry.create({
    schemaVersion: 1, revision: 0, sessionId: "session-1", sessionFile, canonicalSessionFile: sessionFile, cwd: directory,
    taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "worker", summary: "running", updatedAt: at },
    ownership: { kind: "managed", runId: "run-shared", process: identity, acquiredAt: at, heartbeatAt: at },
    latestRunId: "run-shared", createdAt: at, updatedAt: at,
  });
  await mkdir(join(root, "daemon", "workers"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "session-1", runId: "run-shared", leaseId: "lease-shared", generation: 1, identity, piChildIdentity, token: workerToken, socketPath: workerSocketPath(root), proto: 2 }] })}\n`, { mode: 0o600 });
  return { root, sessionFile, registry };
}

/** @param {string} root */
async function openDaemon(root) {
  const daemon = await createDaemonRuntime({ root, inspect, reconnectTimeoutMs: 5_000 });
  runtimes.push(daemon);
  return daemon;
}

/** @param {any} daemon @param {string} clientId */
async function openClient(daemon, clientId) {
  const client = createDaemonClient({ socketPath: daemon.socketPath, token: daemon.token, maxBytes: 512 * 1024, clientId, reconnect: false });
  await client.connect();
  return client;
}

/**
 * One worker that keeps the same bounded live tail `runtime/installed-pi-worker.mjs` keeps, from the
 * same module: frames produced while no daemon is listening stay in memory and are replayed on the
 * next connection, and the tail's own bound decides what survives.
 */
async function fakeWorker({ root, maxBytes = undefined }) {
  const controller = new AbortController();
  const tail = createLiveTail(maxBytes === undefined ? {} : { maxBytes });
  /** @type {string[]} */
  const commands = [];
  /** @type {any} */
  let live;
  let connections = 0;
  const listener = await listenForDaemon({ socketPath: workerSocketPath(root), token: workerToken, maxBytes: 512 * 1024 });
  const run = (async () => {
    while (!controller.signal.aborted) {
      /** @type {any} */
      let connection;
      try {
        connection = await listener.next();
        if (connection === undefined) return;
        live = connection;
        connections += 1;
        connection.onMessage((/** @type {any} */ message) => {
          if (message?.type !== "command") return;
          commands.push(message.command.op);
          void connection.send({ version: 1, type: "command_result", token: workerToken, id: message.id, ok: true, record: { clientId: message.command.clientId, requestId: message.command.requestId, op: message.command.op, stage: "RPC_ACKNOWLEDGED", at, result: null } });
        });
        await connection.send({ version: 1, type: "worker_ready", token: workerToken, sessionId: "session-1", runId: "run-shared", leaseId: "lease-shared", generation: 1, worker: identity, piChild: piChildIdentity });
        if (connections > 1) await connection.send({ version: 1, type: "pi_tail", token: workerToken, sessionId: "session-1", frames: tail.frames(), dropped: tail.dropped });
        await connection.closed;
        live = undefined;
      } catch {
        return;
      }
    }
  })();
  const worker = {
    get connections() { return connections; },
    /** The operations this worker was asked to run, in the order its route delivered them. */
    get commands() { return commands; },
    /** Produce one Pi frame: it joins the tail whether or not a daemon is listening. @param {any} frame */
    async frame(frame) {
      tail.record(frame);
      await live?.send({ version: 1, type: "pi_frame", token: workerToken, sessionId: "session-1", frame }).catch(() => {});
    },
    get dropped() { return tail.dropped; },
    /** Lose the daemon connection without losing Pi, which is what a socket error looks like here. */
    drop() { live?.close(); },
    async stop() { controller.abort(); await listener.close(); await run; },
  };
  workers.push(worker);
  return worker;
}

/** The socket this session's worker listens on, which the daemon names before it spawns. @param {string} root */
function workerSocketPath(root) {
  return join(root, "daemon", "workers", "session-1.sock");
}

/** @param {any} daemon */
async function waitForWorker(daemon) {
  const deadline = Date.now() + 10_000;
  while (!daemon.status().connectedWorkers.includes("session-1")) {
    if (Date.now() > deadline) throw new Error("worker route was not adopted");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** @param {any[]} items */
function assistantText(items) {
  return items.filter((item) => item.kind === "assistant_message").map((item) => item.content.map((/** @type {any} */ block) => block.text).join("")).join("|");
}

/** @param {any} subscription @param {string} kind */
async function nextPayload(subscription, kind) {
  for (let read = 0; read < 20; read += 1) {
    const { value } = await subscription.events.next();
    if (value?.payload?.kind === kind) return value.payload;
  }
  throw new Error(`No ${kind} event arrived`);
}

// A failed bash tool prints its output verbatim, and that output can start or end with whitespace.
// The viewer contract refuses a padded error summary, so a normalizer that forwards one closes this
// session's worker route, and the reconnect replays the same frame into a snapshot that cannot open.
it("keeps the worker route, command delivery, and snapshot reopen working after a padded tool failure", async () => {
  const { root } = await liveSession();
  const daemon = await openDaemon(root);
  const worker = await fakeWorker({ root });
  await daemon.ready;
  await waitForWorker(daemon);
  const client = await openClient(daemon, "client-tool-failure");
  const subscription = await client.subscribeViewer("session-1");
  await worker.frame({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "npm test" } });
  await worker.frame({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { content: [{ type: "text", text: " WARN cache miss\nexit 1\n" }] }, isError: true });

  expect(await nextPayload(subscription, "tool_finished")).toMatchObject({ tool: { id: "tool-1", state: "failed", error: "WARN cache miss\nexit 1" } });
  subscription.unsubscribe();
  expect(worker.connections).toBe(1);
  expect(daemon.status().connectedWorkers).toContain("session-1");
  await client.command("interrupt", { sessionId: "session-1" });
  expect(worker.commands.at(-1)).toBe("interrupt");

  const reopened = await client.subscribeViewer("session-1");
  reopened.unsubscribe();
  expect(reopened.snapshot.tools).toEqual([expect.objectContaining({ id: "tool-1", state: "failed", error: "WARN cache miss\nexit 1" })]);
  await client.close();
});

it("keeps no durable viewer transcript beside Pi's own session file", async () => {
  const { root } = await liveSession();
  const daemon = await openDaemon(root);
  const worker = await fakeWorker({ root });
  await daemon.ready;
  await waitForWorker(daemon);
  const client = await openClient(daemon, "client-no-durable");
  const subscription = await client.subscribeViewer("session-1");
  await worker.frame({ type: "message_start", message: { role: "assistant", timestamp: at } });
  await worker.frame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streaming" } });
  await subscription.events.next();
  subscription.unsubscribe();
  await client.close();

  // Pi's session file is the only transcript on disk. The live tail lives in the worker's memory.
  expect(await readdir(join(root, "index"), { recursive: true })).toEqual([]);
});
it("replays the frames a worker buffered while the daemon was absent, once", async () => {
  const { root, sessionFile } = await liveSession();
  const first = await openDaemon(root);
  const worker = await fakeWorker({ root });
  await first.ready;
  await waitForWorker(first);
  await worker.frame({ type: "message_start", message: { role: "assistant", timestamp: at } });
  await worker.frame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } });
  await first.close();
  runtimes.splice(runtimes.indexOf(first), 1);

  // Pi keeps streaming while no daemon is listening. Nothing durable can record these frames; the
  // process that produced them is the one that never restarted, so it still holds them.
  await worker.frame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " and more" } });
  // Pi also completed the earlier turn in its own session file, which is the seam this must not double.
  await appendFile(sessionFile, `${JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "answer" }] } })}\n`);

  const second = await openDaemon(root);
  await second.ready;
  await waitForWorker(second);
  const client = await openClient(second, "client-tail");
  const { snapshot, unsubscribe } = await client.subscribeViewer("session-1");
  unsubscribe();
  expect(snapshot.items.map((/** @type {any} */ item) => item.itemId)).toEqual(["user-1", "assistant-1", expect.any(String)]);
  expect(assistantText(snapshot.items)).toBe("answer|partial and more");
  await client.close();
});

it("tells a viewer to resynchronize when its worker reconnects mid-turn, with no lost or duplicated item", async () => {
  const { root, sessionFile } = await liveSession();
  const daemon = await openDaemon(root);
  const worker = await fakeWorker({ root });
  await daemon.ready;
  await waitForWorker(daemon);
  const client = await openClient(daemon, "client-midturn");
  const first = await client.subscribeViewer("session-1");
  await worker.frame({ type: "message_start", message: { role: "assistant", timestamp: at } });
  await worker.frame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "mid" } });
  await vi.waitFor(async () => expect((await first.events.next()).value.payload.kind).toBeDefined());

  // The worker's socket dies mid-turn while Pi keeps going. Its reconnect replays the tail, which
  // rebuilds this session, so the subscription the viewer is reading can no longer describe it.
  worker.drop();
  await vi.waitFor(() => expect(worker.connections).toBeGreaterThan(1));
  await worker.frame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "-turn" } });
  await expect(vi.waitFor(() => first.events.next(), { timeout: 5_000 })).rejects.toMatchObject({ code: "VIEWER_RESYNCHRONIZED" });

  const { snapshot, unsubscribe } = await client.subscribeViewer("session-1");
  unsubscribe();
  expect(snapshot.items.map((/** @type {any} */ item) => item.kind)).toEqual(["user_message", "assistant_message"]);
  expect(assistantText(snapshot.items)).toBe("mid-turn");
  await client.close();
  expect(await readdir(join(root, "index"), { recursive: true })).toEqual([]);
  expect(sessionFile).toContain("canonical.jsonl");
});

// The answer to the tail's bound is a resynchronize, not a freeze and not an error: completed history
// comes from Pi's file, the newest live frames come from what the tail still holds, and the operator
// loses only partial text older than the bound.
it("serves canonical history plus the surviving tail when the worker's buffer overflowed", async () => {
  const { root, sessionFile } = await liveSession();
  const first = await openDaemon(root);
  const worker = await fakeWorker({ root, maxBytes: 256 });
  await first.ready;
  await waitForWorker(first);
  await first.close();
  runtimes.splice(runtimes.indexOf(first), 1);

  await appendFile(sessionFile, `${JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "completed answer" }] } })}\n`);
  await worker.frame({ type: "message_start", message: { role: "assistant", timestamp: at } });
  for (let index = 0; index < 30; index += 1) await worker.frame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `${index} `.padEnd(24, "y") } });

  const second = await openDaemon(root);
  await second.ready;
  await waitForWorker(second);
  const client = await openClient(second, "client-overflow");
  const { snapshot, unsubscribe } = await client.subscribeViewer("session-1");
  unsubscribe();
  expect(worker.dropped).toBeGreaterThan(0);
  expect(snapshot.errors).toEqual([]);
  expect(snapshot.items.map((/** @type {any} */ item) => item.itemId)).toEqual(["user-1", "assistant-1", expect.any(String)]);
  // Completed history is whole, and the streaming item holds the newest text rather than all of it.
  expect(assistantText(snapshot.items)).toContain("completed answer");
  expect(assistantText(snapshot.items)).toContain("29 ");
  expect(assistantText(snapshot.items)).not.toContain("0 y");
  await client.close();
});
