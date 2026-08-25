import net from "node:net";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createDaemonRuntime } from "../runtime/daemon.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";

const roots = [];
const runtimes = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "dashboard-destructive-"));
  roots.push(root);
  for (const name of ["daemon", "sessions", "queue", "runs", "index"]) await mkdir(join(root, name), { mode: 0o700 });
  return root;
}

function record(root, sessionId, overrides = {}) {
  const at = "2026-08-25T12:00:00.000Z";
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId,
    sessionFile: join(root, `${sessionId}.jsonl`),
    canonicalSessionFile: join(root, `${sessionId}.jsonl`),
    cwd: join(root, "shared-cwd"),
    taskState: "READY",
    processState: "EXITED",
    outcome: "READY_FOR_REVIEW",
    activity: { kind: "assistant_final", summary: "done", updatedAt: at },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function connect(runtime, role = "frontend") {
  const encoder = createJsonlEncoder({ maxBytes: 1024 * 1024 });
  const decoder = createJsonlDecoder({ maxBytes: 1024 * 1024 });
  const socket = net.createConnection(runtime.socketPath);
  const queue = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    for (const frame of decoder.push(chunk)) {
      const waiter = waiters.shift();
      if (waiter === undefined) queue.push(frame);
      else waiter(frame);
    }
  });
  socket.once("connect", () => socket.write(encoder.encode({ version: 1, token: runtime.token, role })));
  const next = () => queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve));
  return {
    socket,
    next,
    send(value) { socket.write(encoder.encode(value)); },
    close() { socket.destroy(); },
  };
}

function request(clientId, requestId, op, payload) {
  return { version: 1, clientId, requestId, op, payload };
}

it("journals Stop before exact-group escalation and leaves task/outcome independent", async () => {
  const root = await fixtureRoot();
  const worker = { pid: 9101, startIdentity: "910100", processGroupId: 9101 };
  const sentinelPgid = 9202;
  let alive = true;
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "stop-target", {
    processState: "LIVE",
    ownership: { kind: "managed", runId: "run-stop", process: worker, acquiredAt: "2026-08-25T12:00:00.000Z", heartbeatAt: "2026-08-25T12:00:00.000Z" },
    latestRunId: "run-stop",
  });
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: session.sessionId, runId: "run-stop", leaseId: "lease-stop", generation: 1, identity: worker, piChildIdentity: worker }] })}\n`, { mode: 0o600 });
  const signals = [];
  const runtime = await createDaemonRuntime({
    root,
    reconnectTimeoutMs: 1000,
    stopPolicy: { gracefulMs: 1, terminateMs: 1 },
    sleepImpl: async () => {},
    inspect: async (pid) => {
      if (pid === process.pid) return { pid, startIdentity: "1", processGroupId: process.pid };
      if (pid === worker.pid && alive) return worker;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    signalProcessGroupImpl(pgid, signal) {
      signals.push({ pgid, signal });
      if (pgid === worker.processGroupId && signal === "SIGTERM") alive = false;
    },
  });
  runtimes.push(runtime);
  const workerSocket = connect(runtime, "worker");
  await workerSocket.next();
  workerSocket.send({ version: 1, type: "worker_ready", token: "worker-token", sessionId: session.sessionId, runId: "run-stop", leaseId: "lease-stop", generation: 1, worker, piChild: worker });
  await runtime.ready;

  const frontend = connect(runtime);
  await frontend.next();
  frontend.send(request("client", "stop-request", "stop", { sessionId: session.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  expect(signals).toEqual([{ pgid: worker.processGroupId, signal: "SIGTERM" }]);
  expect(signals.some((entry) => entry.pgid === sentinelPgid)).toBe(false);
  const stopped = await registry.get(session.sessionId);
  expect(stopped).toMatchObject({ processState: "EXITED", taskState: "READY", outcome: "READY_FOR_REVIEW" });
  expect(stopped.ownership).toBeUndefined();
  const journal = await readFile(join(root, "queue", "commands.jsonl"), "utf8");
  expect(journal.indexOf('"stage":"DELIVERY_ATTEMPTED"')).toBeLessThan(journal.indexOf('"stage":"WORKER_ACKNOWLEDGED"'));
  frontend.close();
  workerSocket.close();
});

it("refuses observer, live, and symlink-replaced Delete targets without invoking trash", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const live = record(root, "live-delete", { processState: "LIVE" });
  await writeFile(live.canonicalSessionFile, "live\n");
  await registry.create(live);
  const target = join(root, "actual-session.jsonl");
  await writeFile(target, "actual\n");
  const replaced = record(root, "replaced-delete");
  await symlink(target, replaced.canonicalSessionFile);
  await registry.create(replaced);
  const trash = vi.fn();
  const runtime = await createDaemonRuntime({ root, trashSessionFile: trash });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();

  frontend.send(request("client", "live-delete-request", "delete", { sessionId: live.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED", error: { code: "SESSION_LIVE" } } } });
  frontend.send(request("client", "attach-observer", "attach", { sessionId: replaced.sessionId, role: "observer" }));
  expect(await frontend.next()).toMatchObject({ result: { role: "observer" } });
  frontend.send(request("client", "observer-delete", "delete", { sessionId: replaced.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ ok: false, error: { code: "OBSERVER_READ_ONLY" } });
  frontend.send(request("client", "detach-observer", "detach", { sessionId: replaced.sessionId }));
  expect(await frontend.next()).toMatchObject({ ok: true });
  frontend.send(request("client", "replaced-delete-request", "delete", { sessionId: replaced.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED", error: { code: "SESSION_PATH_UNSAFE" } } } });
  expect(trash).not.toHaveBeenCalled();
  frontend.close();
});

it("keeps Delete response-loss safe, preserves shared cwd/worktree, and retries only after explicit resolution", async () => {
  const root = await fixtureRoot();
  const sharedCwd = join(root, "shared-cwd");
  const worktree = join(root, "managed-worktree");
  await mkdir(sharedCwd);
  await mkdir(worktree);
  await writeFile(join(sharedCwd, "keep.txt"), "shared\n");
  await writeFile(join(worktree, "keep.txt"), "worktree\n");
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "delete-target", { cwd: sharedCwd, isolation: { mode: "worktree", worktreePath: worktree, branch: "agent/delete" } });
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  const trash = vi.fn(async (path) => rename(path, `${path}.trash`));
  let failOnce = true;
  const runtime = await createDaemonRuntime({
    root,
    trashSessionFile: trash,
    destructiveFailpoint(stage) {
      if (stage === "delete_after_trash" && failOnce) {
        failOnce = false;
        throw new Error("lost after trash");
      }
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  const deletion = request("client", "delete-request", "delete", { sessionId: session.sessionId, revision: 0 });
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "DELIVERY_UNKNOWN" } } });
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "DELIVERY_UNKNOWN" } } });
  expect(trash).toHaveBeenCalledTimes(1);

  frontend.send(request("client", "resolve-delete", "resolve_delivery", { targetClientId: "client", targetRequestId: "delete-request", resolution: "retry_at_risk" }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "ACCEPTED" } } });
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "COMPLETED" } } });
  expect(trash).toHaveBeenCalledTimes(1);
  expect(await registry.get(session.sessionId)).toBeUndefined();
  expect(await readFile(join(sharedCwd, "keep.txt"), "utf8")).toBe("shared\n");
  expect(await readFile(join(worktree, "keep.txt"), "utf8")).toBe("worktree\n");
  frontend.close();
});
