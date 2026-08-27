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

let automaticAttachment = 0;

function connect(runtime, role = "frontend") {
  const encoder = createJsonlEncoder({ maxBytes: 1024 * 1024 });
  const decoder = createJsonlDecoder({ maxBytes: 1024 * 1024 });
  const socket = net.createConnection(runtime.socketPath);
  const queue = [];
  const waiters = [];
  const attachmentRoles = new Map();
  socket.on("data", (chunk) => {
    for (const frame of decoder.push(chunk)) {
      if (typeof frame?.requestId === "string" && frame.requestId.startsWith("automatic-composer-")) continue;
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
    send(value) {
      if (value.op === "attach") attachmentRoles.set(value.payload.sessionId, value.payload.role);
      else if (value.op === "detach") attachmentRoles.delete(value.payload.sessionId);
      else if (["prompt", "follow_up", "steer", "interrupt", "ui_response", "stop", "delete"].includes(value.op) && (value.op !== "stop" && value.op !== "delete" || Number.isSafeInteger(value.payload.revision)) && !attachmentRoles.has(value.payload.sessionId)) {
        attachmentRoles.set(value.payload.sessionId, "composer");
        socket.write(encoder.encode({ version: 1, clientId: value.clientId, requestId: `automatic-composer-${automaticAttachment++}`, op: "attach", payload: { sessionId: value.payload.sessionId, role: "composer" } }));
      }
      socket.write(encoder.encode(value));
    },
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
  let killRequested = false;
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
      if (pgid === worker.processGroupId && signal === "SIGKILL") killRequested = true;
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
  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "DELIVERY_UNKNOWN" } } });
  expect(killRequested).toBe(true);
  expect(signals).toEqual([
    { pgid: worker.processGroupId, signal: "SIGTERM" },
    { pgid: worker.processGroupId, signal: "SIGKILL" },
  ]);
  expect(signals.some((entry) => entry.pgid === sentinelPgid)).toBe(false);
  const pending = await registry.get(session.sessionId);
  expect(pending).toMatchObject({ revision: 0, processState: "LIVE", taskState: "READY", outcome: "READY_FOR_REVIEW", ownership: { runId: "run-stop" } });

  alive = false;
  frontend.send(request("client", "resolve-stop", "resolve_delivery", { targetClientId: "client", targetRequestId: "stop-request", resolution: "retry_at_risk" }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "ACCEPTED" } } });
  frontend.send(request("client", "stop-request", "stop", { sessionId: session.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "command", status: { stage: "COMPLETED" } } });
  const stopped = await registry.get(session.sessionId);
  expect(stopped).toMatchObject({ processState: "EXITED", taskState: "STOPPED", outcome: "READY_FOR_REVIEW" });
  expect(stopped.ownership).toBeUndefined();
  const journal = await readFile(join(root, "queue", "commands.jsonl"), "utf8");
  expect(journal.indexOf('"stage":"DELIVERY_ATTEMPTED"')).toBeLessThan(journal.lastIndexOf('"stage":"WORKER_ACKNOWLEDGED"'));
  frontend.close();
  workerSocket.close();
});

it("keeps stale ownership unresolved until exact terminal process evidence exists", async () => {
  const root = await fixtureRoot();
  const worker = { pid: 9301, startIdentity: "930100", processGroupId: 9301 };
  const replacement = { ...worker, startIdentity: "930199" };
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "stale-stop", { processState: "LIVE", ownership: { kind: "managed", runId: "run-stale", process: worker, acquiredAt: "2026-08-25T12:00:00.000Z", heartbeatAt: "2026-08-25T12:00:00.000Z" }, latestRunId: "run-stale" });
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: session.sessionId, runId: "run-stale", leaseId: "lease-stale", generation: 1, identity: worker, piChildIdentity: worker }] })}\n`, { mode: 0o600 });
  let stale = false;
  const runtime = await createDaemonRuntime({ root, reconnectTimeoutMs: 1_000, inspect: async (pid) => pid === process.pid ? { pid, startIdentity: "1", processGroupId: process.pid } : stale ? replacement : worker });
  runtimes.push(runtime);
  const workerSocket = connect(runtime, "worker");
  await workerSocket.next();
  workerSocket.send({ version: 1, type: "worker_ready", token: "stale-token", sessionId: session.sessionId, runId: "run-stale", leaseId: "lease-stale", generation: 1, worker, piChild: worker });
  await runtime.ready;
  stale = true;
  const frontend = connect(runtime);
  await frontend.next();
  frontend.send(request("client", "stale-stop-request", "stop", { sessionId: session.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED", error: { code: "STALE_IDENTITY" } } } });
  expect(await registry.get(session.sessionId)).toMatchObject({ processState: "LIVE", ownership: { runId: "run-stale", process: worker } });
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

  frontend.send(request("legacy-client", "legacy-delete", "delete", { sessionId: live.sessionId }));
  expect(await frontend.next()).toMatchObject({ ok: false, error: { code: "REVISION_REQUIRED" } });
  expect(trash).not.toHaveBeenCalled();
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

it("forgets a session without a trash capability and preserves session and worktree paths", async () => {
  const root = await fixtureRoot();
  const worktreePath = join(root, "managed-worktree");
  await mkdir(worktreePath, { mode: 0o700 });
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "trash-unavailable", { isolation: { mode: "worktree", worktreePath, branch: "dashboard/trash-unavailable" } });
  await writeFile(session.canonicalSessionFile, "session\n");
  await writeFile(join(worktreePath, "sentinel"), "keep\n");
  await registry.create(session);
  const runtime = await createDaemonRuntime({ root });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();

  frontend.send(request("client", "delete-without-trash", "delete", { sessionId: session.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "COMPLETED" } } });
  await expect(readFile(session.canonicalSessionFile, "utf8")).resolves.toBe("session\n");
  await expect(readFile(join(worktreePath, "sentinel"), "utf8")).resolves.toBe("keep\n");
  expect(await registry.get(session.sessionId)).toBeUndefined();
  frontend.close();
});

it("does not redeliver a PREPARED Delete until explicit retry_at_risk", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "delete-prepared");
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  let throwBeforeEffect = true;
  const trash = vi.fn(async (path) => {
    if (throwBeforeEffect) throw new Error("trash delivery threw before effect");
    await rename(path, `${path}.trash`);
  });
  let runtime = await createDaemonRuntime({ root, trashSessionFile: trash });
  runtimes.push(runtime);
  await runtime.ready;
  let frontend = connect(runtime);
  await frontend.next();
  const deletion = request("client", "delete-prepared-request", "delete", { sessionId: session.sessionId, revision: 0 });

  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "DELIVERY_UNKNOWN" } } });
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "DELIVERY_UNKNOWN" } } });
  expect(trash).toHaveBeenCalledTimes(1);
  frontend.close();
  await runtime.close();
  runtimes.splice(runtimes.indexOf(runtime), 1);

  runtime = await createDaemonRuntime({ root, trashSessionFile: trash });
  runtimes.push(runtime);
  await runtime.ready;
  frontend = connect(runtime);
  await frontend.next();
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "DELIVERY_UNKNOWN" } } });
  expect(trash).toHaveBeenCalledTimes(1);

  throwBeforeEffect = false;
  frontend.send(request("client", "resolve-delete-prepared", "resolve_delivery", { targetClientId: "client", targetRequestId: "delete-prepared-request", resolution: "retry_at_risk" }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "ACCEPTED" } } });
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "COMPLETED" } } });
  expect(trash).toHaveBeenCalledTimes(2);
  expect(await registry.get(session.sessionId)).toBeUndefined();
  frontend.close();
});

it("reopens a crash-window PREPARED Delete as DELIVERY_UNKNOWN without trash redelivery", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "delete-reopened-prepared");
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  const trash = vi.fn(async (path) => rename(path, `${path}.trash`));
  let failPrepare = true;
  let runtime = await createDaemonRuntime({
    root,
    trashSessionFile: trash,
    destructiveFailpoint(stage) {
      if (stage === "delete_after_prepare" && failPrepare) throw new Error("crash after durable prepare");
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  let frontend = connect(runtime);
  await frontend.next();
  const deletion = request("client", "delete-reopened-prepared-request", "delete", { sessionId: session.sessionId, revision: 0 });
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ ok: false, error: { code: "REQUEST_FAILED" } });
  expect(trash).not.toHaveBeenCalled();
  frontend.close();
  await runtime.close();
  runtimes.splice(runtimes.indexOf(runtime), 1);

  failPrepare = false;
  runtime = await createDaemonRuntime({ root, trashSessionFile: trash });
  runtimes.push(runtime);
  await runtime.ready;
  expect(await runtime.commandStatus({ clientId: "client", requestId: "delete-reopened-prepared-request" })).toMatchObject({ stage: "DELIVERY_UNKNOWN" });
  expect(trash).not.toHaveBeenCalled();
  frontend = connect(runtime);
  await frontend.next();
  frontend.send(request("client", "resolve-delete-reopened", "resolve_delivery", { targetClientId: "client", targetRequestId: "delete-reopened-prepared-request", resolution: "retry_at_risk" }));
  await frontend.next();
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "COMPLETED" } } });
  expect(trash).toHaveBeenCalledTimes(1);
  frontend.close();
});

it.each([
  ["missing size", (identity) => { delete identity.size; }],
  ["string dev", (identity) => { identity.dev = "1"; }],
  ["negative inode", (identity) => { identity.ino = -1; }],
  ["invalid mtime", (identity) => { identity.mtimeMs = null; }],
  ["unknown identity field", (identity) => { identity.extra = true; }],
])("fails recovered Delete closed for %s identity metadata", async (_name, corruptIdentity) => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, `delete-invalid-identity-${_name.replaceAll(" ", "-")}`);
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  let runtime = await createDaemonRuntime({
    root,
    trashSessionFile: vi.fn(),
    destructiveFailpoint(stage) { if (stage === "delete_after_prepare") throw new Error("stop after prepare"); },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  frontend.send(request("client", `request-${session.sessionId}`, "delete", { sessionId: session.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ ok: false });
  frontend.close();
  await runtime.close();
  runtimes.splice(runtimes.indexOf(runtime), 1);

  const path = join(root, "daemon", "delete-results.json");
  const store = JSON.parse(await readFile(path, "utf8"));
  corruptIdentity(Object.values(store.entries)[0].identity);
  await writeFile(path, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  runtime = await createDaemonRuntime({ root, trashSessionFile: vi.fn() });
  runtimes.push(runtime);
  await expect(runtime.ready).rejects.toThrow("Delete recovery store is invalid");
});

it("reconciles throw-after-effect Delete delivery without invoking trash twice", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "delete-after-effect");
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  const trash = vi.fn(async (path) => {
    await rename(path, `${path}.trash`);
    throw new Error("trash delivery threw after effect");
  });
  const runtime = await createDaemonRuntime({ root, trashSessionFile: trash });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  const deletion = request("client", "delete-after-effect-request", "delete", { sessionId: session.sessionId, revision: 0 });
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "DELIVERY_UNKNOWN" } } });
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "DELIVERY_UNKNOWN" } } });
  expect(trash).toHaveBeenCalledTimes(1);
  frontend.send(request("client", "resolve-delete-after-effect", "resolve_delivery", { targetClientId: "client", targetRequestId: "delete-after-effect-request", resolution: "retry_at_risk" }));
  await frontend.next();
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "COMPLETED" } } });
  expect(trash).toHaveBeenCalledTimes(1);
  expect(await registry.get(session.sessionId)).toBeUndefined();
  frontend.close();
});

it("reconciles an exact missing PREPARED Delete without another trash attempt", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "delete-missing");
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  const trash = vi.fn(async () => { throw new Error("trash delivery threw before effect"); });
  const runtime = await createDaemonRuntime({ root, trashSessionFile: trash });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  const deletion = request("client", "delete-missing-request", "delete", { sessionId: session.sessionId, revision: 0 });
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "DELIVERY_UNKNOWN" } } });
  await rename(session.canonicalSessionFile, `${session.canonicalSessionFile}.trash`);
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "DELIVERY_UNKNOWN" } } });
  expect(trash).toHaveBeenCalledTimes(1);
  expect(await registry.get(session.sessionId)).toBeUndefined();

  frontend.send(request("client", "resolve-delete-missing", "resolve_delivery", { targetClientId: "client", targetRequestId: "delete-missing-request", resolution: "retry_at_risk" }));
  await frontend.next();
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "COMPLETED" } } });
  expect(trash).toHaveBeenCalledTimes(1);
  expect(await registry.get(session.sessionId)).toBeUndefined();
  frontend.close();
});

it.each([
  ["revision", async (root, registry, session) => registry.update(session.sessionId, 0, { updatedAt: "2026-08-25T12:00:01.000Z" })],
  ["field", async (root, _registry, session) => writeFile(join(root, "sessions", `${session.sessionId}.json`), `${JSON.stringify({ ...session, taskState: "FAILED" })}\n`, { mode: 0o600 })],
  ["ownership", async (root, _registry, session) => writeFile(join(root, "sessions", `${session.sessionId}.json`), `${JSON.stringify({ ...session, processState: "STALE", ownership: { kind: "managed", runId: "changed", process: { pid: 444, startIdentity: "4440", processGroupId: 444 }, acquiredAt: session.createdAt, heartbeatAt: session.createdAt } })}\n`, { mode: 0o600 })],
])("refuses missing-file Delete reconciliation after a %s change", async (_name, changeRecord) => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, `delete-changed-${_name}`);
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  const trash = vi.fn(async (path) => {
    await rename(path, `${path}.trash`);
    throw new Error("trash delivery threw after effect");
  });
  const runtime = await createDaemonRuntime({ root, trashSessionFile: trash });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  const deletion = request("client", `delete-changed-request-${_name}`, "delete", { sessionId: session.sessionId, revision: 0 });
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "DELIVERY_UNKNOWN" } } });
  await changeRecord(root, registry, session);
  frontend.send(request("client", `resolve-delete-changed-${_name}`, "resolve_delivery", { targetClientId: "client", targetRequestId: `delete-changed-request-${_name}`, resolution: "retry_at_risk" }));
  await frontend.next();
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED", error: { code: "DELETE_RECONCILIATION_REFUSED" } } } });
  expect(trash).toHaveBeenCalledTimes(1);
  expect(await registry.get(session.sessionId)).toBeDefined();
  frontend.close();
});

it("refuses a replacement PREPARED target and never retries after abandon", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "delete-replaced-prepared");
  await writeFile(session.canonicalSessionFile, "original\n");
  await registry.create(session);
  const trash = vi.fn(async () => { throw new Error("trash delivery threw before effect"); });
  const runtime = await createDaemonRuntime({ root, trashSessionFile: trash });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  const deletion = request("client", "delete-replaced-prepared-request", "delete", { sessionId: session.sessionId, revision: 0 });
  frontend.send(deletion);
  await frontend.next();
  await rename(session.canonicalSessionFile, `${session.canonicalSessionFile}.original`);
  await writeFile(session.canonicalSessionFile, "replacement\n");
  frontend.send(request("client", "resolve-delete-replaced", "resolve_delivery", { targetClientId: "client", targetRequestId: "delete-replaced-prepared-request", resolution: "retry_at_risk" }));
  await frontend.next();
  frontend.send(deletion);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED", error: { code: "DELETE_RECONCILIATION_REFUSED" } } } });
  expect(trash).toHaveBeenCalledTimes(1);

  const second = record(root, "delete-abandoned");
  await writeFile(second.canonicalSessionFile, "session\n");
  await registry.create(second);
  const abandoned = request("client", "delete-abandoned-request", "delete", { sessionId: second.sessionId, revision: 0 });
  frontend.send(abandoned);
  await frontend.next();
  frontend.send(request("client", "resolve-delete-abandoned", "resolve_delivery", { targetClientId: "client", targetRequestId: "delete-abandoned-request", resolution: "abandon" }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED" } } });
  frontend.send(abandoned);
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED" } } });
  expect(trash).toHaveBeenCalledTimes(2);
  frontend.close();
});
