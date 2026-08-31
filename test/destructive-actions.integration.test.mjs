import net from "node:net";
import { mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createDaemonRuntime } from "../runtime/daemon.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { forbidMutationBeneath, mutationAttempts, releaseMutationGuards } from "./fixtures/path-mutation-guard.mjs";

// Delete's own guard: every module in this suite's graph reaches the filesystem through this wrapper,
// so a mutation beneath a guarded path is refused at the call rather than discovered afterwards.
vi.mock("node:fs/promises", async (importOriginal) => {
  const [actual, { guardFsPromises }] = await Promise.all([importOriginal(), import("./fixtures/path-mutation-guard.mjs")]);
  return guardFsPromises(actual);
});

const roots = [];
const runtimes = [];
afterEach(async () => {
  releaseMutationGuards();
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
      else if (["prompt", "follow_up", "steer", "interrupt", "ui_response", "stop", "delete", "respawn"].includes(value.op) && (!["stop", "delete", "respawn"].includes(value.op) || Number.isSafeInteger(value.payload.revision)) && !attachmentRoles.has(value.payload.sessionId)) {
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

// Operator-visible failure: an upgrade that replaced a worker without the destructive convention would
// end a session the operator never named, at a revision he never read. respawn takes the same full
// identifier, exact revision, and confirmation as stop and rm, and touches no Pi file.
it("respawns a stale worker through the guarded destructive path and preserves the canonical Pi session", async () => {
  const root = await fixtureRoot();
  const worker = { pid: 9401, startIdentity: "940100", processGroupId: 9401 };
  let alive = true;
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "respawn-target", {
    processState: "LIVE",
    ownership: { kind: "managed", runId: "run-respawn", process: worker, acquiredAt: "2026-08-25T12:00:00.000Z", heartbeatAt: "2026-08-25T12:00:00.000Z" },
    latestRunId: "run-respawn",
  });
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: session.sessionId, runId: "run-respawn", leaseId: "lease-respawn", generation: 1, identity: worker, piChildIdentity: worker, cliVersion: "1.9.0" }] })}\n`, { mode: 0o600 });
  const signals = [];
  const launches = [];
  const diagnostics = [];
  const runtime = await createDaemonRuntime({
    root,
    cliVersion: "2.0.0",
    recordDiagnostic: (entry) => { diagnostics.push(entry); },
    reconnectTimeoutMs: 1_000,
    stopPolicy: { gracefulMs: 1, terminateMs: 1 },
    sleepImpl: async () => {},
    inspect: async (pid) => {
      if (pid === process.pid) return { pid, startIdentity: "1", processGroupId: process.pid };
      if (pid === worker.pid && alive) return worker;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    signalProcessGroupImpl(pgid, signal) {
      signals.push({ pgid, signal });
      if (signal === "SIGTERM") alive = false;
    },
    workerSupervisor: { useRouter() {}, async launch(request) { launches.push(request.sessionId); return { sessionId: request.sessionId }; }, async close() {} },
  });
  runtimes.push(runtime);
  const workerSocket = connect(runtime, "worker");
  await workerSocket.next();
  workerSocket.send({ version: 1, type: "worker_ready", token: "respawn-token", sessionId: session.sessionId, runId: "run-respawn", leaseId: "lease-respawn", generation: 1, worker, piChild: worker });
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();

  frontend.send(request("client", "no-revision", "respawn", { sessionId: session.sessionId }));
  expect(await frontend.next()).toMatchObject({ ok: false, error: { code: "REVISION_REQUIRED" } });
  frontend.send(request("client", "wrong-revision", "respawn", { sessionId: session.sessionId, revision: 7 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED", error: { code: "REVISION_CONFLICT" } } } });
  expect(signals).toEqual([]);
  expect(diagnostics).toEqual([expect.objectContaining({ event: "respawn_refused", sessionId: session.sessionId, code: "REVISION_CONFLICT" })]);

  frontend.send(request("client", "respawn-request", "respawn", { sessionId: session.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ ok: true, result: { kind: "command", status: { operation: "respawn", stage: "COMPLETED" } } });

  expect(signals).toEqual([{ pgid: worker.processGroupId, signal: "SIGTERM" }]);
  expect(launches).toEqual(["respawn-target"]);
  expect(await readFile(session.canonicalSessionFile, "utf8")).toBe("session\n");
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

// Operator-visible failure: rm unlinking Pi's canonical session file or removing a managed worktree
// would destroy work the dashboard only borrowed. Every case below refuses the mutation itself rather
// than checking for damage afterwards, so a reintroduced delete seam fails at the call, not at cleanup.
it("gains no delete path from a supplied trash callback", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "supplied-trash");
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  const trash = vi.fn(async (path) => rename(path, `${path}.trash`));
  const runtime = await createDaemonRuntime({ root, trashSessionFile: trash });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  forbidMutationBeneath(session.canonicalSessionFile);

  frontend.send(request("client", "supplied-trash-request", "delete", { sessionId: session.sessionId, revision: 0 }));
  const response = await frontend.next();

  expect(mutationAttempts()).toEqual([]);
  expect(trash).not.toHaveBeenCalled();
  expect(response).toMatchObject({ result: { status: { stage: "COMPLETED" } } });
  await expect(readFile(session.canonicalSessionFile, "utf8")).resolves.toBe("session\n");
  expect(await registry.get(session.sessionId)).toBeUndefined();
  frontend.close();
});

it("refuses a revision-free, live, or observer Delete and mutates neither session path", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const live = record(root, "live-delete", { processState: "LIVE" });
  await writeFile(live.canonicalSessionFile, "live\n");
  await registry.create(live);
  const observed = record(root, "observed-delete");
  await writeFile(observed.canonicalSessionFile, "observed\n");
  await registry.create(observed);
  const runtime = await createDaemonRuntime({ root });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  forbidMutationBeneath(live.canonicalSessionFile, observed.canonicalSessionFile);

  frontend.send(request("legacy-client", "legacy-delete", "delete", { sessionId: live.sessionId }));
  expect(await frontend.next()).toMatchObject({ ok: false, error: { code: "REVISION_REQUIRED" } });
  frontend.send(request("client", "live-delete-request", "delete", { sessionId: live.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED", error: { code: "SESSION_LIVE" } } } });
  frontend.send(request("client", "attach-observer", "attach", { sessionId: observed.sessionId, role: "observer" }));
  expect(await frontend.next()).toMatchObject({ result: { role: "observer" } });
  frontend.send(request("client", "observer-delete", "delete", { sessionId: observed.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ ok: false, error: { code: "OBSERVER_READ_ONLY" } });

  expect(mutationAttempts()).toEqual([]);
  await expect(readFile(live.canonicalSessionFile, "utf8")).resolves.toBe("live\n");
  await expect(readFile(observed.canonicalSessionFile, "utf8")).resolves.toBe("observed\n");
  expect(await registry.get(live.sessionId)).toBeDefined();
  expect(await registry.get(observed.sessionId)).toBeDefined();
  frontend.close();
});

it("forgets an inactive row and preserves the canonical Pi file and the worktree", async () => {
  const root = await fixtureRoot();
  const worktreePath = join(root, "managed-worktree");
  await mkdir(join(worktreePath, "src"), { recursive: true, mode: 0o700 });
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "forget-inactive", { isolation: { mode: "worktree", worktreePath, branch: "dashboard/forget-inactive" } });
  await writeFile(session.canonicalSessionFile, "session\n");
  await writeFile(join(worktreePath, "src", "sentinel"), "keep\n");
  await registry.create(session);
  const runtime = await createDaemonRuntime({ root });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  forbidMutationBeneath(session.canonicalSessionFile, worktreePath);

  frontend.send(request("client", "forget-inactive-request", "delete", { sessionId: session.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "COMPLETED" } } });

  expect(mutationAttempts()).toEqual([]);
  await expect(readFile(session.canonicalSessionFile, "utf8")).resolves.toBe("session\n");
  await expect(readFile(join(worktreePath, "src", "sentinel"), "utf8")).resolves.toBe("keep\n");
  expect(await registry.get(session.sessionId)).toBeUndefined();
  const journal = await readFile(join(root, "queue", "commands.jsonl"), "utf8");
  expect(journal.indexOf('"stage":"DELIVERY_ATTEMPTED"')).toBeLessThan(journal.lastIndexOf('"stage":"WORKER_ACKNOWLEDGED"'));
  frontend.close();
});

// A canonical path that is a symlink is Pi's business, not the dashboard's: forgetting the row reads
// the path at most, so the operator loses no file whichever way the link points.
it("forgets a row whose canonical session file is a symlink without following or replacing it", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const target = join(root, "actual-session.jsonl");
  await writeFile(target, "actual\n");
  const linked = record(root, "linked-delete");
  await symlink(target, linked.canonicalSessionFile);
  await registry.create(linked);
  const runtime = await createDaemonRuntime({ root });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  forbidMutationBeneath(linked.canonicalSessionFile, target);

  frontend.send(request("client", "linked-delete-request", "delete", { sessionId: linked.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "COMPLETED" } } });

  expect(mutationAttempts()).toEqual([]);
  expect(await readlink(linked.canonicalSessionFile)).toBe(target);
  await expect(readFile(target, "utf8")).resolves.toBe("actual\n");
  expect(await registry.get(linked.sessionId)).toBeUndefined();
  frontend.close();
});

it("refuses Delete at a changed revision and keeps the row and its paths", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "changed-revision-delete");
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  const runtime = await createDaemonRuntime({ root });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  await registry.update(session.sessionId, 0, { updatedAt: "2026-08-25T12:00:01.000Z" });
  forbidMutationBeneath(session.canonicalSessionFile);

  frontend.send(request("client", "changed-revision-request", "delete", { sessionId: session.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED", error: { code: "REVISION_CONFLICT" } } } });

  expect(mutationAttempts()).toEqual([]);
  await expect(readFile(session.canonicalSessionFile, "utf8")).resolves.toBe("session\n");
  expect(await registry.get(session.sessionId)).toMatchObject({ revision: 1 });
  frontend.close();
});

it("refuses Delete while stale worker metadata is authoritative and forgets once its process is gone", async () => {
  const root = await fixtureRoot();
  const worker = { pid: 9501, startIdentity: "950100", processGroupId: 9501 };
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "stale-metadata-delete", { latestRunId: "run-stale-delete" });
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  await writeFile(join(root, "daemon", "workers.json"), `${JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: session.sessionId, runId: "run-stale-delete", leaseId: "lease-stale-delete", generation: 1, identity: worker, piChildIdentity: worker }] })}\n`, { mode: 0o600 });
  let alive = true;
  const runtime = await createDaemonRuntime({
    root,
    reconnectTimeoutMs: 1_000,
    inspect: async (pid) => {
      if (pid === process.pid) return { pid, startIdentity: "1", processGroupId: process.pid };
      if (pid === worker.pid && alive) return worker;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const frontend = connect(runtime);
  await frontend.next();
  forbidMutationBeneath(session.canonicalSessionFile);

  frontend.send(request("client", "stale-metadata-request", "delete", { sessionId: session.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "FAILED", error: { code: "OWNERSHIP_CONFLICT" } } } });
  expect(await registry.get(session.sessionId)).toBeDefined();

  alive = false;
  frontend.send(request("client", "stale-metadata-retry", "delete", { sessionId: session.sessionId, revision: 0 }));
  expect(await frontend.next()).toMatchObject({ result: { status: { stage: "COMPLETED" } } });

  expect(mutationAttempts()).toEqual([]);
  await expect(readFile(session.canonicalSessionFile, "utf8")).resolves.toBe("session\n");
  expect(await registry.get(session.sessionId)).toBeUndefined();
  frontend.close();
});

it("refuses Delete while a relaunch of the same session is in flight", async () => {
  const root = await fixtureRoot();
  const registry = new RegistryStore(join(root, "sessions"));
  const session = record(root, "relaunching-delete");
  await writeFile(session.canonicalSessionFile, "session\n");
  await registry.create(session);
  /** @type {() => void} */
  let launchStarted = () => {};
  const started = new Promise((resolve) => { launchStarted = () => resolve(undefined); });
  /** @type {() => void} */
  let releaseLaunch = () => {};
  const released = new Promise((resolve) => { releaseLaunch = () => resolve(undefined); });
  const runtime = await createDaemonRuntime({
    root,
    workerSupervisor: {
      useRouter() {},
      async launch(launchRequest) { launchStarted(); await released; return { sessionId: launchRequest.sessionId }; },
      async close() {},
    },
  });
  runtimes.push(runtime);
  await runtime.ready;
  const activating = connect(runtime);
  await activating.next();
  const deleting = connect(runtime);
  await deleting.next();
  forbidMutationBeneath(session.canonicalSessionFile);

  activating.send(request("activating-client", "activate-attach", "attach", { sessionId: session.sessionId, role: "composer", activate: true }));
  await started;
  deleting.send(request("deleting-client", "relaunching-delete-request", "delete", { sessionId: session.sessionId, revision: 0 }));
  expect(await deleting.next()).toMatchObject({ result: { status: { stage: "FAILED", error: { code: "OWNERSHIP_CONFLICT" } } } });

  expect(mutationAttempts()).toEqual([]);
  await expect(readFile(session.canonicalSessionFile, "utf8")).resolves.toBe("session\n");
  expect(await registry.get(session.sessionId)).toBeDefined();
  releaseLaunch();
  expect(await activating.next()).toMatchObject({ ok: true });
  deleting.close();
  activating.close();
});
