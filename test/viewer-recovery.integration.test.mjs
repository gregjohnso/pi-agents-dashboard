import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { connectDaemon } from "../runtime/daemon-connector.mjs";
import { createDaemonRuntime } from "../runtime/daemon.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";

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
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(root, name), { recursive: true, mode: 0o700 });
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
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "session-1", runId: "run-shared", leaseId: "lease-shared", generation: 1, identity, piChildIdentity, token: workerToken }] })}\n`, { mode: 0o600 });
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
 * One worker that keeps its own bounded live tail, exactly as `runtime/installed-pi-worker.mjs` does:
 * frames produced while no daemon is listening stay in memory and are replayed on the next connection.
 */
function fakeWorker({ socketPath, tokenPath }) {
  const controller = new AbortController();
  /** @type {any[]} */
  const tail = [];
  /** @type {any} */
  let live;
  let connections = 0;
  const run = (async () => {
    while (!controller.signal.aborted) {
      /** @type {any} */
      let connection;
      try {
        connection = await connectDaemon({ config: { socketPath, tokenPath, maxBytes: 512 * 1024 }, signal: controller.signal });
        live = connection;
        connections += 1;
        await connection.send({ version: 1, type: "worker_ready", token: workerToken, sessionId: "session-1", runId: "run-shared", leaseId: "lease-shared", generation: 1, worker: identity, piChild: piChildIdentity });
        if (connections > 1) await connection.send({ version: 1, type: "pi_tail", token: workerToken, sessionId: "session-1", frames: [...tail], dropped: 0 });
        await connection.closed;
      } catch {
      } finally {
        live = undefined;
        connection?.close();
      }
      if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  const worker = {
    get connections() { return connections; },
    /** Produce one Pi frame: it joins the tail whether or not a daemon is listening. @param {any} frame */
    async frame(frame) {
      tail.push(frame);
      await live?.send({ version: 1, type: "pi_frame", token: workerToken, sessionId: "session-1", frame }).catch(() => {});
    },
    async stop() { controller.abort(); await run; },
  };
  workers.push(worker);
  return worker;
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

it("keeps no durable viewer transcript beside Pi's own session file", async () => {
  const { root } = await liveSession();
  const daemon = await openDaemon(root);
  const worker = fakeWorker({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath });
  await daemon.ready;
  await waitForWorker(daemon);
  const client = await openClient(daemon, "client-no-durable");
  const subscription = await client.subscribeViewer("session-1");
  await worker.frame({ type: "message_start", message: { role: "assistant", timestamp: at } });
  await worker.frame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streaming" } });
  const iterator = subscription[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return?.();
  await client.close();

  // Pi's session file is the only transcript on disk. The live tail lives in the worker's memory.
  expect(await readdir(join(root, "index"), { recursive: true })).toEqual([]);
});
