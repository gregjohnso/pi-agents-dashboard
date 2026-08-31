import { EventEmitter } from "node:events";
import net from "node:net";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { DEFAULT_STOP_ESCALATION_MS, createDaemonRequester, createPersistentDaemonRequester, destructiveRequestTimeoutMs, loadCliClientIdentity, runAgentsCommand, runLogsCommand, runSessionCommand } from "./session-commands.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function stateRoot() {
  const root = await mkdtemp(join(tmpdir(), "dashboard-cli-state-"));
  roots.push(root);
  return root;
}

const inactive = {
  sessionId: "exact-session-id",
  revision: 4,
  processState: "EXITED",
  isolation: { mode: "worktree", worktreePath: "/managed/worktree", branch: "agent/exact" },
};

const stopArgv = ["stop", "exact-session-id", "--revision", "4", "--yes"];
const rmArgv = ["rm", "exact-session-id", "--revision", "4", "--yes"];
const respawnArgv = ["respawn", "exact-session-id", "--revision", "4", "--yes"];
const authenticated = { version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "epoch", pid: 1 };

/** @param {string} operation @param {string} stage @param {string} clientId @param {string} requestId */
function commandStatus(operation, stage, clientId, requestId) {
  const at = "2026-08-25T12:00:00.000Z";
  return { clientId, requestId, operation, stage, acceptedAt: at, updatedAt: at };
}

/** A destructive request the daemon never confirms, which leaves one pending record behind. */
const ambiguousRequest = async (_op, _payload, requestId) => ({ kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId } });
const completedRequest = async (_op, _payload, requestId) => ({ kind: "command", status: { stage: "COMPLETED", clientId: "cli-stable", requestId } });

/** Run one ambiguous Delete and return the single pending record it published. @param {string} root @param {any} [request] */
async function pendingAfterAmbiguousDelete(root, request = ambiguousRequest) {
  await runSessionCommand(rmArgv, { root, randomId: () => "stable", request });
  const directory = join(root, "cli", "pending");
  const [name] = (await readdir(directory)).filter((candidate) => candidate.endsWith(".json"));
  return { directory, name, key: name.slice(0, -5), path: join(directory, name) };
}

async function daemonServer(root, respond, authentication = authenticated, { closeOnInputEnd = true } = {}) {
  const daemon = join(root, "daemon");
  await mkdir(daemon, { mode: 0o700 });
  await writeFile(join(daemon, "control.token"), "secret\n", { mode: 0o600 });
  const socketPath = join(daemon, "control.sock");
  const sockets = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    const decoder = createJsonlDecoder({ maxBytes: 4096 });
    const encoder = createJsonlEncoder({ maxBytes: 4096 });
    let authorized = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (!authorized) {
          authorized = true;
          socket.write(encoder.encode(authentication));
        } else respond(socket, encoder, frame);
      }
    });
    socket.on("end", () => { if (closeOnInputEnd) socket.end(); });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  return Object.assign(server, { sockets });
}

/** Half-open connections keep close() pending, so drop them first. @param {net.Server & {sockets: net.Socket[]}} server */
async function closeServer(server) {
  for (const socket of server.sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}

/** @param {net.Socket} socket @param {any} encoder @param {any} frame @param {() => void} [afterWrite] */
function grantComposer(socket, encoder, frame, afterWrite) {
  socket.write(encoder.encode({ version: 1, requestId: frame.requestId, ok: true, result: { kind: "attached", sessionId: "exact-session-id", role: "composer" } }), afterWrite);
}

it("claims composer, sends the exact revision-bound stop, and releases", async () => {
  const root = await stateRoot();
  const operations = [];
  const request = vi.fn(async (op, payload) => {
    operations.push([op, payload]);
    if (op === "attach") return { kind: "attached", sessionId: "exact-session-id", role: "composer" };
    if (op === "detach") return { kind: "detached", sessionId: "exact-session-id" };
    return { kind: "command", status: { stage: "COMPLETED" } };
  });
  await expect(runSessionCommand(stopArgv, { composerRequest: request, root })).resolves.toMatchObject({ code: 0 });
  expect(operations).toEqual([
    ["attach", { sessionId: "exact-session-id", role: "composer" }],
    ["stop", { sessionId: "exact-session-id", revision: 4 }],
    ["detach", { sessionId: "exact-session-id" }],
  ]);
});

it("never replays a destructive request when the composer socket is lost after the stop is submitted", async () => {
  const root = await stateRoot();
  const operations = [];
  const server = await daemonServer(root, (socket, encoder, frame) => {
    operations.push(frame.op);
    if (frame.op === "attach") grantComposer(socket, encoder, frame);
    else if (frame.op === "stop") socket.destroy();
  });
  await expect(runSessionCommand(stopArgv, { root, randomId: () => "lost-socket", timeoutMs: 200 })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(operations).toEqual(["attach", "stop"]);
  await closeServer(server);
});

it.each([
  ["missing confirmation", ["stop", "exact-session-id", "--revision", "4"]],
  ["path-like session ID", ["stop", "sessions/exact-session-id", "--revision", "4", "--yes"]],
  ["unknown flag", ["stop", "exact-session-id", "--revision", "4", "--yes", "--force"]],
  ["respawn without confirmation", ["respawn", "exact-session-id", "--revision", "4"]],
  ["respawn without a revision", ["respawn", "exact-session-id", "--yes"]],
  ["respawn on a path-like session ID", ["respawn", "sessions/exact-session-id", "--revision", "4", "--yes"]],
])("rejects strict destructive grammar: %s", async (_name, argv) => {
  const request = vi.fn();
  await expect(runSessionCommand(argv, { request })).resolves.toMatchObject({ code: 2, error: { code: "INVALID_SYNTAX" } });
  expect(request).not.toHaveBeenCalled();
});

it.each([
  ["status", ["status", "exact-session-id"]],
  ["delete", ["delete", "exact-session-id", "--revision", "4", "--yes"]],
])("rejects the retired %s verb", async (_name, argv) => {
  const request = vi.fn();
  await expect(runSessionCommand(argv, { request })).resolves.toMatchObject({ code: 2, error: { code: "INVALID_SYNTAX" } });
  expect(request).not.toHaveBeenCalled();
});

// rm is the operator's verb only. The daemon operation and the durable pending action keep the
// spelling a running daemon and an earlier release already wrote, because both cross a boundary.
it("sends rm as the delete operation and records delete as the pending action", async () => {
  const root = await stateRoot();
  const request = vi.fn(ambiguousRequest);
  await expect(runSessionCommand(rmArgv, { root, randomId: () => "stable", request })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN" } });
  expect(request.mock.calls[0][0]).toBe("delete");
  const { path } = await pendingAfterAmbiguousDelete(root, request);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ action: "delete", sessionId: "exact-session-id", revision: 4 });
});

// respawn ends a worker's process group, so it takes the same convention as stop and rm: a full
// identifier, an exact revision, and explicit confirmation, with its own durable pending action.
it("claims composer, sends the exact revision-bound respawn, and records respawn as the pending action", async () => {
  const root = await stateRoot();
  const operations = [];
  const request = vi.fn(async (op, payload, requestId) => {
    operations.push([op, payload]);
    if (op === "attach") return { kind: "attached", sessionId: "exact-session-id", role: "composer" };
    if (op === "detach") return { kind: "detached", sessionId: "exact-session-id" };
    return { kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId } };
  });
  await expect(runSessionCommand(respawnArgv, { root, randomId: () => "stable", composerRequest: request })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN" } });
  expect(operations).toEqual([
    ["attach", { sessionId: "exact-session-id", role: "composer" }],
    ["respawn", { sessionId: "exact-session-id", revision: 4 }],
    ["detach", { sessionId: "exact-session-id" }],
  ]);
  const [name] = (await readdir(join(root, "cli", "pending"))).filter((candidate) => candidate.endsWith(".json"));
  expect(JSON.parse(await readFile(join(root, "cli", "pending", name), "utf8"))).toMatchObject({ action: "respawn", sessionId: "exact-session-id", revision: 4 });
});

it("reads every session row for agents without opening the list", async () => {
  const sessions = [inactive, { ...inactive, sessionId: "failed-session-id", processState: "EXITED", taskState: "FAILED" }];
  const request = vi.fn(async (op) => (op === "get_state" ? { kind: "state", sessions } : undefined));
  await expect(runAgentsCommand({ request })).resolves.toEqual({ code: 0, result: { kind: "agents", sessions } });
  expect(request).toHaveBeenCalledTimes(1);
});

it("persists one private stable CLI client identity", async () => {
  const root = await stateRoot();
  const first = await loadCliClientIdentity({ root, randomId: () => "stable-cli-id" });
  const second = await loadCliClientIdentity({ root, randomId: () => "different-id" });
  expect(first).toBe("cli-stable-cli-id");
  expect(second).toBe(first);
});

it("serializes empty-state identity initialization and returns one complete winner", async () => {
  const root = await stateRoot();
  let releaseWinner;
  const winnerBlocked = new Promise((resolve) => { releaseWinner = resolve; });
  let enteredPublish;
  const publishEntered = new Promise((resolve) => { enteredPublish = resolve; });
  const first = loadCliClientIdentity({
    root,
    randomId: () => "first",
    identityFailpoint: async (stage) => {
      if (stage === "identity_before_publish") {
        enteredPublish();
        await winnerBlocked;
      }
    },
  });
  await publishEntered;
  const second = loadCliClientIdentity({ root, randomId: () => "second" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await readdir(join(root, "cli"))).filter((name) => name === "client-id")).toEqual([]);
  releaseWinner();
  await expect(Promise.all([first, second])).resolves.toEqual(["cli-first", "cli-first"]);
  expect(await readFile(join(root, "cli", "client-id"), "utf8")).toBe("cli-first\n");
  expect((await readdir(join(root, "cli"))).filter((name) => name.includes(".tmp") || name.endsWith(".lock"))).toEqual([]);
});

it("recovers a dead identity initializer lock before reading the stable winner", async () => {
  const root = await stateRoot();
  await expect(loadCliClientIdentity({ root, randomId: () => "stable" })).resolves.toBe("cli-stable");
  const lockPath = join(root, "cli", ".client-id.lock");
  const token = "dead-identity-token";
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, token), `${JSON.stringify({ token, owner: { pid: 2147483647, startIdentity: "1" } })}\n`, { mode: 0o600 });
  await expect(loadCliClientIdentity({ root, randomId: () => "different" })).resolves.toBe("cli-stable");
  expect((await readdir(join(root, "cli"))).filter((name) => name.endsWith(".lock"))).toEqual([]);
});

it("fails closed with a typed compatibility error when hard-link publication is unsupported", async () => {
  const root = await stateRoot();
  const fsOps = {
    ...fs,
    link: vi.fn(async () => { throw Object.assign(new Error("unsupported publication"), { code: "EXDEV" }); }),
  };
  await expect(loadCliClientIdentity({ root, randomId: () => "unsupported", fsOps })).rejects.toMatchObject({ code: "ATOMIC_PUBLICATION_UNSUPPORTED" });
  expect(await readdir(join(root, "cli"))).toEqual([]);
});

it("keeps worktree cleanup separate and supplies an authoritative ownership reader", async () => {
  const request = vi.fn(async (op) => op === "get_state" ? { kind: "state", sessions: [inactive] } : undefined);
  const cleanupManagedWorktree = vi.fn(async (_record, options) => {
    expect(await options.readLiveOwnership()).toBeNull();
    return { disposition: "REMOVED" };
  });

  await expect(runSessionCommand(["cleanup", "exact-session-id", "--revision", "4", "--yes"], {
    request,
    cleanupManagedWorktree,
  })).resolves.toMatchObject({ code: 0, result: { disposition: "REMOVED" } });
  expect(cleanupManagedWorktree).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalledWith("delete", expect.anything());
});

it("refuses cleanup when revision changes or live ownership appears", async () => {
  const changed = { ...inactive, revision: 5, processState: "LIVE", ownership: { runId: "late" } };
  const request = vi.fn(async () => ({ kind: "state", sessions: [changed] }));
  const cleanupManagedWorktree = vi.fn();

  await expect(runSessionCommand(["cleanup", "exact-session-id", "--revision", "4", "--yes"], {
    request,
    cleanupManagedWorktree,
  })).resolves.toMatchObject({ code: 1, error: { code: "REVISION_CONFLICT" } });
  expect(cleanupManagedWorktree).not.toHaveBeenCalled();
});

it("fails closed rather than mixing a rotated CLI identity with a pending request ID", async () => {
  const root = await stateRoot();
  const request = vi.fn(async (_op, _payload, requestId) => ({ kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-original", requestId } }));

  await runSessionCommand(rmArgv, { request, root, randomId: () => "original" });
  await writeFile(join(root, "cli", "client-id"), "cli-rotated\n", { mode: 0o600 });

  await expect(runSessionCommand(rmArgv, { request, root })).rejects.toMatchObject({
    code: "CLI_CLIENT_IDENTITY_CHANGED",
    pendingClientId: "cli-original",
    currentClientId: "cli-rotated",
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it("persists and reuses an ambiguous destructive request identity until durable completion", async () => {
  const root = await stateRoot();
  const requestIds = [];
  const request = vi.fn(async (_op, _payload, requestId) => {
    requestIds.push(requestId);
    return requestIds.length === 1
      ? { kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli", requestId } }
      : { kind: "command", status: { stage: "COMPLETED", clientId: "cli", requestId } };
  });
  await expect(runSessionCommand(rmArgv, { request, root })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN" } });
  await expect(runSessionCommand(rmArgv, { request, root })).resolves.toMatchObject({ code: 0 });
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
});

it.each([
  ["ends without answering", (socket) => socket.end(), {}, 200],
  ["holds the connection open past the deadline", () => {}, { closeOnInputEnd: false }, 100],
])("settles a submitted request as DELIVERY_UNKNOWN when the peer %s", async (_name, respond, serverOptions, timeoutMs) => {
  const root = await stateRoot();
  const server = await daemonServer(root, respond, undefined, serverOptions);
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs });
  await expect(requester("delete", { sessionId: "exact", revision: 1 }, "request-full")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId: "request-full" });
  await closeServer(server);
});

it("reports a read-only timeout as a timeout, never as an ambiguous delivery", async () => {
  const root = await stateRoot();
  const server = await daemonServer(root, () => {}, undefined, { closeOnInputEnd: false });
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 100 });
  await expect(requester("get_state", {}, "read-only-request")).rejects.toMatchObject({ code: "DAEMON_REQUEST_TIMEOUT" });
  await closeServer(server);
});

it("returns one validated response when the peer immediately ends the connection", async () => {
  const root = await stateRoot();
  const response = { version: 1, requestId: "response-boundary", ok: true, result: { kind: "state", sessions: [], cursor: { daemonEpoch: "epoch", sequence: "0" } } };
  const server = await daemonServer(root, (socket, encoder) => socket.end(encoder.encode(response)));
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("get_state", {}, "response-boundary")).resolves.toEqual(response.result);
  await closeServer(server);
});

it("finalizes one complete response from a peer that never closes the connection", async () => {
  const root = await stateRoot();
  const daemon = join(root, "daemon");
  await mkdir(daemon, { mode: 0o700 });
  await writeFile(join(daemon, "control.token"), "secret\n", { mode: 0o600 });
  const encoder = createJsonlEncoder({ maxBytes: 4096 });
  const response = { version: 1, requestId: "scripted-response", ok: true, result: { kind: "state", sessions: [], cursor: { daemonEpoch: "epoch", sequence: "0" } } };
  class ScriptedSocket extends EventEmitter {
    write(_chunk, callback) {
      callback?.();
      queueMicrotask(() => this.emit("data", encoder.encode(authenticated)));
      return true;
    }
    end(_chunk, callback) {
      callback?.();
      queueMicrotask(() => this.emit("data", encoder.encode(response)));
      return this;
    }
    destroy() {}
  }
  const socket = new ScriptedSocket();
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 20, createConnection: () => {
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  } });
  await expect(requester("get_state", {}, "scripted-response")).resolves.toEqual(response.result);
});

it.each([
  ["a duplicate response in one flush", (socket, encoder, response) => socket.write(Buffer.concat([encoder.encode(response), encoder.encode(response)])), "DUPLICATE_DAEMON_RESPONSE", {}],
  ["a trailing frame in one flush", (socket, encoder, response) => socket.write(Buffer.concat([encoder.encode(response), encoder.encode({ nonsense: true })])), "UNEXPECTED_DAEMON_FRAME", {}],
  ["a partial frame in one flush", (socket, encoder, response) => socket.end(Buffer.concat([encoder.encode(response), Buffer.from("{\"")])), "INCOMPLETE_FRAME", {}],
  ["a delayed duplicate response", (socket, encoder, response) => { socket.write(encoder.encode(response)); setTimeout(() => socket.end(encoder.encode(response)), 10); }, "DUPLICATE_DAEMON_RESPONSE", { closeOnInputEnd: false }],
  ["a delayed trailing frame", (socket, encoder, response) => { socket.write(encoder.encode(response)); setTimeout(() => socket.end(encoder.encode({ nonsense: true })), 10); }, "UNEXPECTED_DAEMON_FRAME", { closeOnInputEnd: false }],
  ["delayed partial data", (socket, encoder, response) => { socket.write(encoder.encode(response)); setTimeout(() => socket.end(Buffer.from("{\"")), 10); }, "TRAILING_DAEMON_DATA", { closeOnInputEnd: false }],
])("refuses the response when the daemon sends %s", async (_name, send, code, serverOptions) => {
  const root = await stateRoot();
  const response = { version: 1, requestId: "response-boundary", ok: true, result: { kind: "state", sessions: [], cursor: { daemonEpoch: "epoch", sequence: "0" } } };
  const server = await daemonServer(root, (socket, encoder) => send(socket, encoder, response), undefined, serverOptions);
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("get_state", {}, "response-boundary")).rejects.toMatchObject({ code });
  await closeServer(server);
});

it.each([
  ["unknown state", { ...authenticated, state: "MYSTERY" }],
  ["unknown field", { ...authenticated, extra: true }],
  ["truthy error in READY", { ...authenticated, error: "bad" }],
  ["malformed FAILED error", { ...authenticated, state: "FAILED", error: { code: "FAILED", message: "bad" } }],
  ["wrong recovery marker", { ...authenticated, state: "RECONCILING" }],
])("rejects invalid authentication: %s", async (_name, authentication) => {
  const root = await stateRoot();
  const submitted = vi.fn();
  const server = await daemonServer(root, submitted, authentication);
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("delete", { sessionId: "exact", revision: 1 }, "auth-request")).rejects.toMatchObject({ code: "INVALID_DAEMON_AUTHENTICATION" });
  expect(submitted).not.toHaveBeenCalled();
  await closeServer(server);
});

it.each([
  ["unknown successful result", { version: 1, requestId: "strict-request", ok: true, result: { kind: "mystery" } }, "INVALID_DAEMON_RESPONSE"],
  ["wrong request ID", { version: 1, requestId: "other", ok: true, result: { kind: "state", sessions: [], cursor: { daemonEpoch: "epoch", sequence: "0" } } }, "UNEXPECTED_DAEMON_RESPONSE"],
  ["event frame", { version: 1, cursor: { daemonEpoch: "epoch", sequence: "1" }, occurredAt: "now", kind: "command_changed", payload: {} }, "UNEXPECTED_DAEMON_FRAME"],
  ["invalid error", { version: 1, requestId: "strict-request", ok: false, error: { code: "NO", message: "bad" } }, "INVALID_DAEMON_RESPONSE"],
])("rejects %s as a typed protocol failure", async (_name, frame, code) => {
  const root = await stateRoot();
  const server = await daemonServer(root, (socket, encoder) => socket.write(encoder.encode(frame)));
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("get_state", {}, "strict-request")).rejects.toMatchObject({ code });
  await closeServer(server);
});

// The request reached the daemon and its answer was unusable, so the delete may already have run.
it("classifies a destructive response that cannot be parsed as delivery unknown", async () => {
  const root = await stateRoot();
  const server = await daemonServer(root, (socket, encoder, frame) => socket.write(encoder.encode({ version: 1, requestId: frame.requestId, ok: true, result: { kind: "command", status: { stage: "MYSTERY" } } })));
  const requester = await createPersistentDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 2_000 });
  await expect(requester.request("delete", { sessionId: "exact", revision: 1 }, "unparseable-request")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId: "unparseable-request", submitted: true });
  await requester.close();
  await closeServer(server);
});

it("classifies an unvalidated delete response as delivery unknown and retains pending identity", async () => {
  const root = await stateRoot();
  const server = await daemonServer(root, (socket, encoder, frame) => {
    if (frame.op === "attach") grantComposer(socket, encoder, frame);
    else if (frame.op === "detach") socket.write(encoder.encode({ version: 1, requestId: frame.requestId, ok: true, result: { kind: "detached", sessionId: "exact-session-id" } }));
    else socket.write(encoder.encode({ version: 1, requestId: frame.requestId, ok: true, result: { kind: "mystery" } }));
  });
  await expect(runSessionCommand(rmArgv, { root, randomId: () => "stable", timeoutMs: 200 })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId: expect.any(String) } });
  expect(await readdir(join(root, "cli", "pending"))).toHaveLength(1);
  await closeServer(server);
});

it.each([
  ["wrong operation", commandStatus("delete", "COMPLETED", "cli-stable", "strict-request")],
  ["nonterminal stage", commandStatus("stop", "ACCEPTED", "cli-stable", "strict-request")],
])("rejects command result with %s", async (_name, status) => {
  const root = await stateRoot();
  const frame = { version: 1, requestId: "strict-request", ok: true, result: { kind: "command", status } };
  const server = await daemonServer(root, (socket, encoder) => socket.write(encoder.encode(frame)));
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("stop", { sessionId: "exact", revision: 1 }, "strict-request")).rejects.toMatchObject({ code: "UNEXPECTED_DAEMON_RESPONSE" });
  await closeServer(server);
});

it("publishes only complete pending winners while concurrent creators wait on the per-key lock", async () => {
  const root = await stateRoot();
  let releasePublish;
  const publishBlocked = new Promise((resolve) => { releasePublish = resolve; });
  let enteredPublish;
  const publishEntered = new Promise((resolve) => { enteredPublish = resolve; });
  const requestIds = [];
  const request = vi.fn(async (_op, _payload, requestId) => {
    requestIds.push(requestId);
    return { kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId } };
  });
  const first = runSessionCommand(rmArgv, {
    root,
    randomId: () => "stable",
    request,
    pendingFailpoint: async (stage) => {
      if (stage === "pending_before_publish") {
        enteredPublish();
        await publishBlocked;
      }
    },
  });
  await publishEntered;
  const second = runSessionCommand(rmArgv, { root, randomId: () => "stable", request });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await readdir(join(root, "cli", "pending"))).filter((name) => name.endsWith(".json"))).toEqual([]);
  releasePublish();
  await Promise.all([first, second]);
  expect(new Set(requestIds).size).toBe(1);
  const [name] = (await readdir(join(root, "cli", "pending"))).filter((candidate) => candidate.endsWith(".json"));
  expect(JSON.parse(await readFile(join(root, "cli", "pending", name), "utf8"))).toMatchObject({ requestId: requestIds[0] });
});

it("restores and refuses a replacement raced into atomic pending clear", async () => {
  const root = await stateRoot();
  const { path } = await pendingAfterAmbiguousDelete(root);
  const original = JSON.parse(await readFile(path, "utf8"));
  let releaseClear;
  const clearBlocked = new Promise((resolve) => { releaseClear = resolve; });
  let enteredClear;
  const clearEntered = new Promise((resolve) => { enteredClear = resolve; });
  const completing = runSessionCommand(rmArgv, {
    root,
    request: completedRequest,
    pendingFailpoint: async (stage) => {
      if (stage === "pending_before_clear") {
        enteredClear();
        await clearBlocked;
      }
    },
  });
  await clearEntered;
  const replacement = { ...original, requestId: "replacement-request" };
  await rm(path);
  await writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  releaseClear();
  await expect(completing).rejects.toMatchObject({ code: "CLI_STATE_UNSAFE" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
});

it("recovers the exact atomic tombstone left by a crashed pending clearer", async () => {
  const root = await stateRoot();
  const requestIds = [];
  const request = vi.fn(async (_op, _payload, requestId) => {
    requestIds.push(requestId);
    return { kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId } };
  });
  const { directory, name, key, path } = await pendingAfterAmbiguousDelete(root, request);
  await rename(path, join(directory, `.${key}.clear.crashed.tmp`));

  await runSessionCommand(rmArgv, { root, randomId: () => "stable", request });

  expect(requestIds[1]).toBe(requestIds[0]);
  expect(await readFile(join(directory, name), "utf8")).toContain(requestIds[0]);
  expect((await readdir(directory)).some((candidate) => candidate.includes(".clear."))).toBe(false);
});

it("recovers a dead exact pending lock holder before clearing", async () => {
  const root = await stateRoot();
  const { directory, key } = await pendingAfterAmbiguousDelete(root);
  const lockPath = join(directory, `.${key}.lock`);
  const token = "dead-token";
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, token), `${JSON.stringify({ token, owner: { pid: 2147483647, startIdentity: "1" } })}\n`, { mode: 0o600 });

  await expect(runSessionCommand(rmArgv, { root, request: completedRequest })).resolves.toMatchObject({ code: 0 });
  expect((await readdir(directory)).filter((candidate) => candidate.endsWith(".json"))).toEqual([]);
});

it.each(["corrupt", "symlink"])("fails closed for %s pending state", async (kind) => {
  const root = await stateRoot();
  const { path } = await pendingAfterAmbiguousDelete(root);
  if (kind === "corrupt") await writeFile(path, "not-json\n", { mode: 0o600 });
  if (kind === "symlink") {
    const target = join(root, "pending-target");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
  }
  await expect(runSessionCommand(rmArgv, { root, request: ambiguousRequest })).rejects.toMatchObject({ code: expect.stringMatching(/^CLI_STATE_/u) });
});

it("resolves delivery only for exact full client/request IDs and clears abandoned pending state", async () => {
  const root = await stateRoot();
  let destructiveRequestId;
  const request = vi.fn(async (op, payload, requestId) => {
    if (op === "delete") {
      destructiveRequestId = requestId;
      return { kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "target-client-full", requestId } };
    }
    expect(payload).toEqual({ targetClientId: "target-client-full", targetRequestId: destructiveRequestId, resolution: "abandon" });
    return { kind: "command", status: { stage: "FAILED", clientId: "target-client-full", requestId: destructiveRequestId } };
  });
  await runSessionCommand(rmArgv, { request, root });
  await expect(runSessionCommand(["resolve-delivery", "target-client-full", destructiveRequestId, "abandon", "--yes"], { request, root })).resolves.toMatchObject({ code: 0 });
  expect(request).toHaveBeenCalledTimes(2);
  await expect(runSessionCommand(["resolve-delivery", "target", destructiveRequestId, "abandon", "--yes", "extra"], { request, root })).resolves.toMatchObject({ code: 2 });
});

it("derives the destructive deadline from the daemon stop policy and never shortens it", async () => {
  const configured = await stateRoot();
  await writeFile(join(configured, "dashboard.json"), JSON.stringify({ stop: { gracefulMs: 7_000, terminateMs: 3_000 } }), { mode: 0o600 });
  await expect(destructiveRequestTimeoutMs(configured)).resolves.toBe(7_000 + 3_000 + 1_000);
  await expect(destructiveRequestTimeoutMs(await stateRoot(), undefined, 200)).resolves.toBe(DEFAULT_STOP_ESCALATION_MS);
});

const runHash = "a".repeat(64);
const logSession = { sessionId: "exact-session-id", revision: 4, runHash };

/** One get_state responder holding at most one row. @param {any} [session] */
function stateWith(session) {
  return async (/** @type {string} */ op) => {
    expect(op).toBe("get_state");
    return { kind: "state", sessions: session === undefined ? [] : [session] };
  };
}

/** Build one run directory the way the supervisor and the rotating diagnostics writer do.
 * @param {string} root @param {{ worker?: string | Buffer, segments?: Record<string, string | Buffer> }} contents
 */
async function runFixture(root, { worker, segments = {} } = {}) {
  const directory = join(root, "runs", runHash);
  await mkdir(join(directory, "diagnostics"), { recursive: true, mode: 0o700 });
  if (worker !== undefined) await writeFile(join(directory, "worker.stderr.log"), worker, { mode: 0o600 });
  for (const [name, text] of Object.entries(segments)) await writeFile(join(directory, "diagnostics", name), text, { mode: 0o600 });
  return directory;
}

/** @param {string} root */
async function startupLog(root, text = "DashboardConfigError: dashboard.json is invalid\n") {
  await mkdir(join(root, "daemon"), { recursive: true, mode: 0o700 });
  const path = join(root, "daemon", "startup.log");
  await writeFile(path, text, { mode: 0o600 });
  return path;
}

it("prints the whole daemon startup log when no session is named and it fits the bound", async () => {
  const root = await stateRoot();
  const path = await startupLog(root);
  const result = await runLogsCommand(undefined, { root });
  expect(result.code).toBe(0);
  expect(result.result.sources).toEqual([{ path, bytes: 48, truncated: false }]);
  expect(result.result.text).toBe(`==> ${path} <==\nDashboardConfigError: dashboard.json is invalid\n`);
});

it("reads the newest Pi stderr segment before worker stderr and names both full paths", async () => {
  const root = await stateRoot();
  const directory = await runFixture(root, {
    worker: "worker stderr line\n",
    segments: { "stderr.00000000.jsonl": "retired segment\n", "stderr.00000009.jsonl": "newest segment\n", "rpc.00000009.jsonl": "rpc traffic\n" },
  });
  const result = await runLogsCommand("exact-session-id", { root, request: stateWith(logSession) });
  expect(result.code).toBe(0);
  expect(result.result.sources.map((/** @type {any} */ source) => source.path)).toEqual([
    join(directory, "diagnostics", "stderr.00000009.jsonl"),
    join(directory, "worker.stderr.log"),
  ]);
  expect(result.result.text).toContain("newest segment");
  expect(result.result.text).not.toContain("retired segment");
  expect(result.result.text).not.toContain("rpc traffic");
});

it("reads a prepared session's run directory before any worker metadata exists", async () => {
  const root = await stateRoot();
  await runFixture(root, {
    worker: "WORKER_PROCESS_EXITED: Worker exited before worker_hello (SIGTERM)\n",
    segments: { "stderr.00000000.jsonl": '{"type":"pi_stderr","text":"pi: unknown model claude-nope"}\n' },
  });
  const prepared = { sessionId: "exact-session-id", revision: 0, taskState: "FAILED", processState: "EXITED", latestRunId: "run-1", runHash };
  expect(prepared.ownership).toBeUndefined();
  const result = await runLogsCommand("exact-session-id", { root, request: stateWith(prepared) });
  expect(result.code).toBe(0);
  const { text } = result.result;
  expect(text).toContain("pi: unknown model claude-nope");
  expect(text.indexOf("unknown model")).toBeLessThan(text.indexOf("WORKER_PROCESS_EXITED"));
});

it("resolves the run directory under the current root after that root is renamed in place", async () => {
  const root = await stateRoot();
  await runFixture(root, { worker: "worker stderr line\n", segments: { "stderr.00000000.jsonl": "pi complaint\n" } });
  const renamed = `${root}-renamed`;
  roots.push(renamed);
  await rename(root, renamed);
  const result = await runLogsCommand("exact-session-id", { root: renamed, request: stateWith(logSession) });
  expect(result.result.sources.map((/** @type {any} */ source) => source.path)).toEqual([
    join(renamed, "runs", runHash, "diagnostics", "stderr.00000000.jsonl"),
    join(renamed, "runs", runHash, "worker.stderr.log"),
  ]);
  expect(result.result.text).toContain("pi complaint");
});

it("gives the Pi segment the whole 262144-byte budget first and still names the starved worker log", async () => {
  const root = await stateRoot();
  const directory = await runFixture(root, { worker: "worker stderr line\n", segments: { "stderr.00000000.jsonl": `${"p".repeat(300_000)}\n` } });
  const result = await runLogsCommand("exact-session-id", { root, request: stateWith(logSession) });
  expect(result.result.sources).toEqual([
    { path: join(directory, "diagnostics", "stderr.00000000.jsonl"), bytes: 262_144, truncated: true },
    { path: join(directory, "worker.stderr.log"), bytes: 0, truncated: true },
  ]);
  expect(result.result.text).toContain(join(directory, "worker.stderr.log"));
  expect(result.result.text).not.toContain("worker stderr line");
});

// 26 bytes into a 41-byte segment lands inside a two-byte character.
it("emits only complete UTF-8 when the bound cuts into a character", async () => {
  const root = await stateRoot();
  await runFixture(root, { segments: { "stderr.00000000.jsonl": `${"é".repeat(20)}\n` } });
  const result = await runLogsCommand("exact-session-id", { root, maxTailBytes: 26, request: stateWith(logSession) });
  expect(result.result.sources[0]).toMatchObject({ bytes: 26, truncated: true });
  expect(result.result.text).not.toContain("\uFFFD");
  expect(result.result.text).toBe(`==> ${join(root, "runs", runHash, "diagnostics", "stderr.00000000.jsonl")} (tail) <==\n${"é".repeat(12)}\n`);
});

// A killed writer leaves the last character half on disk; it must not reach the operator as U+FFFD.
it("emits only complete UTF-8 when the log itself ends mid-character", async () => {
  const root = await stateRoot();
  await runFixture(root, { worker: Buffer.concat([Buffer.from("worker ok\n"), Buffer.from([0xc3])]) });
  const result = await runLogsCommand("exact-session-id", { root, request: stateWith(logSession) });
  expect(result.result.sources[0]).toMatchObject({ bytes: 11, truncated: false });
  expect(result.result.text).not.toContain("\uFFFD");
  expect(result.result.text.endsWith("worker ok\n")).toBe(true);
});

it("refuses a symbolic link where an owned regular log belongs", async () => {
  const root = await stateRoot();
  const directory = await runFixture(root, { segments: { "stderr.00000000.jsonl": "pi complaint\n" } });
  const target = join(root, "outside.log");
  await writeFile(target, "not this file\n", { mode: 0o600 });
  await symlink(target, join(directory, "worker.stderr.log"));
  await expect(runLogsCommand("exact-session-id", { root, request: stateWith(logSession) }))
    .resolves.toMatchObject({ code: 1, error: { code: "LOG_SOURCE_UNSAFE" } });
});

it("refuses a log source replaced between its identity check and the end of the read", async () => {
  const root = await stateRoot();
  const path = await startupLog(root);
  const logFailpoint = async (/** @type {string} */ stage) => {
    if (stage !== "after_read") return;
    await rm(path);
    await writeFile(path, "a different file entirely\n", { mode: 0o600 });
  };
  await expect(runLogsCommand(undefined, { root, logFailpoint }))
    .resolves.toMatchObject({ code: 1, error: { code: "LOG_SOURCE_UNSAFE" } });
});

it.each([["parent escape", "../outside"], ["nested path", "nested/hash"], ["current directory", "."], ["empty name", ""]])(
  "refuses a run hash that is not a root-relative directory name: %s",
  async (_name, badHash) => {
    const root = await stateRoot();
    await expect(runLogsCommand("exact-session-id", { root, request: stateWith({ ...logSession, runHash: badHash }) }))
      .resolves.toMatchObject({ code: 1, error: { code: "LOG_SOURCE_UNSAFE" } });
  },
);

it("names every path it searched when the session has no readable log", async () => {
  const root = await stateRoot();
  const result = await runLogsCommand("exact-session-id", { root, request: stateWith(logSession) });
  expect(result).toMatchObject({ code: 1, error: { code: "LOGS_NOT_FOUND" } });
  expect(result.error.message).toContain(join(root, "runs", runHash, "worker.stderr.log"));
  await expect(runLogsCommand("exact-session-id", { root, request: stateWith({ sessionId: "exact-session-id", revision: 4 }) }))
    .resolves.toMatchObject({ code: 1, error: { code: "LOGS_NOT_FOUND" } });
});

it("refuses an unknown exact session ID and a prefix of a known one", async () => {
  const root = await stateRoot();
  const request = stateWith(logSession);
  await expect(runLogsCommand("exact-session", { root, request })).resolves.toMatchObject({ code: 1, error: { code: "SESSION_NOT_FOUND" } });
  await expect(runLogsCommand("sessions/exact-session-id", { root, request: vi.fn() })).resolves.toMatchObject({ code: 2, error: { code: "INVALID_SYNTAX" } });
});
