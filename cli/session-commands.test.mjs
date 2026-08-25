import { EventEmitter } from "node:events";
import net from "node:net";
import * as fs from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { createDaemonRequester, loadCliClientIdentity, runSessionCommand } from "./session-commands.mjs";

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

function commandStatus(operation, stage, clientId, requestId) {
  const at = "2026-08-25T12:00:00.000Z";
  return { clientId, requestId, operation, stage, acceptedAt: at, updatedAt: at };
}

async function daemonServer(root, respond, authentication = { version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "epoch", pid: 1 }, { closeOnInputEnd = true } = {}) {
  const daemon = join(root, "daemon");
  await mkdir(daemon, { mode: 0o700 });
  await writeFile(join(daemon, "control.token"), "secret\n", { mode: 0o600 });
  const socketPath = join(daemon, "control.sock");
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const decoder = createJsonlDecoder({ maxBytes: 4096 });
    const encoder = createJsonlEncoder({ maxBytes: 4096 });
    let authenticated = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (!authenticated) {
          authenticated = true;
          socket.write(encoder.encode(authentication));
        } else respond(socket, encoder, frame);
      }
    });
    socket.on("end", () => { if (closeOnInputEnd) socket.end(); });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  return server;
}

it("requires exact ID, revision, and confirmation for stop and delete", async () => {
  const root = await stateRoot();
  const request = vi.fn(async () => ({ kind: "command", status: { stage: "COMPLETED" } }));
  await expect(runSessionCommand(["stop", "exact-session-id", "--revision", "4"], { request, root })).resolves.toMatchObject({ code: 2 });
  await expect(runSessionCommand(["stop", "exact-session-id", "--revision", "4", "--yes"], { request, root })).resolves.toMatchObject({ code: 0 });
  expect(request).toHaveBeenCalledWith("stop", { sessionId: "exact-session-id", revision: 4 }, expect.any(String));
});

it.each([
  ["stop", ["stop", "exact-session-id", "--revision", "4", "--revision", "4", "--yes"]],
  ["duplicate yes", ["delete", "exact-session-id", "--revision", "4", "--yes", "--yes"]],
  ["duplicate value", ["cleanup", "exact-session-id", "--revision", "4", "4", "--yes"]],
  ["unknown", ["stop", "exact-session-id", "--revision", "4", "--yes", "--force"]],
])("rejects strict destructive grammar: %s", async (_name, argv) => {
  const request = vi.fn();
  await expect(runSessionCommand(argv, { request })).resolves.toMatchObject({ code: 2, error: { code: "INVALID_SYNTAX" } });
  expect(request).not.toHaveBeenCalled();
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

it("cleans identity locks and publication temps when the initializing winner crashes", async () => {
  const root = await stateRoot();
  await expect(loadCliClientIdentity({
    root,
    randomId: () => "crashed",
    identityFailpoint(stage) { if (stage === "identity_before_publish") throw new Error("simulated identity crash"); },
  })).rejects.toThrow("simulated identity crash");
  expect(await readdir(join(root, "cli"))).toEqual([]);
  await expect(loadCliClientIdentity({ root, randomId: () => "recovered" })).resolves.toBe("cli-recovered");
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

it("bounds an EEXIST winner reread by configured attempts", async () => {
  const root = await stateRoot();
  const fsOps = {
    ...fs,
    link: vi.fn(async () => { throw Object.assign(new Error("winner not visible"), { code: "EEXIST" }); }),
  };
  await expect(loadCliClientIdentity({ root, randomId: () => "loser", fsOps, winnerReadAttempts: 2, winnerReadTimeoutMs: 100, winnerReadDelayMs: 1 })).rejects.toMatchObject({ code: "CLI_STATE_BUSY" });
  expect(fsOps.link).toHaveBeenCalledTimes(1);
  expect(await readdir(join(root, "cli"))).toEqual([]);
});

it.each(["EPERM", "EOPNOTSUPP", "EXDEV"])('fails closed with a typed compatibility error when hard-link publication returns %s', async (code) => {
  const root = await stateRoot();
  const fsOps = {
    ...fs,
    link: vi.fn(async () => { throw Object.assign(new Error("unsupported publication"), { code }); }),
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
  const argv = ["delete", "exact-session-id", "--revision", "4", "--yes"];

  await runSessionCommand(argv, { request, root, randomId: () => "original" });
  await writeFile(join(root, "cli", "client-id"), "cli-rotated\n", { mode: 0o600 });

  await expect(runSessionCommand(argv, { request, root })).rejects.toMatchObject({
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
  const argv = ["delete", "exact-session-id", "--revision", "4", "--yes"];
  await expect(runSessionCommand(argv, { request, root })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN" } });
  await expect(runSessionCommand(argv, { request, root })).resolves.toMatchObject({ code: 0 });
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
});

it.each(["end", "close"])("settles %s after submission exactly once as DELIVERY_UNKNOWN", async (boundary) => {
  const root = await stateRoot();
  const daemon = join(root, "daemon");
  await mkdir(daemon, { mode: 0o700 });
  await writeFile(join(daemon, "control.token"), "secret\n", { mode: 0o600 });
  const socketPath = join(daemon, "control.sock");
  const server = net.createServer((socket) => {
    const decoder = createJsonlDecoder({ maxBytes: 1024 });
    const encoder = createJsonlEncoder({ maxBytes: 1024 });
    let authenticated = false;
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (!authenticated) {
          authenticated = true;
          socket.write(encoder.encode({ version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "epoch", pid: 1 }));
        } else if (frame.op === "delete") {
          boundary === "end" ? socket.end() : socket.destroy();
        }
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 1024, timeoutMs: 100 });
  await expect(requester("delete", { sessionId: "exact", revision: 1 }, "request-full")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId: "request-full" });
  await new Promise((resolve) => server.close(resolve));
});

it.each(["end", "close"])("returns one validated response when the peer immediately emits %s", async (boundary) => {
  const root = await stateRoot();
  const response = { version: 1, requestId: "response-boundary", ok: true, result: { kind: "state", sessions: [] } };
  const server = await daemonServer(root, (socket, encoder) => {
    if (boundary === "end") socket.end(encoder.encode(response));
    else socket.write(encoder.encode(response), () => socket.destroy());
  });
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("get_state", {}, "response-boundary")).resolves.toEqual(response.result);
  await new Promise((resolve) => server.close(resolve));
});

it("half-closes its write side exactly once and accepts a complete response at an error boundary", async () => {
  const root = await stateRoot();
  const daemon = join(root, "daemon");
  await mkdir(daemon, { mode: 0o700 });
  await writeFile(join(daemon, "control.token"), "secret\n", { mode: 0o600 });
  const encoder = createJsonlEncoder({ maxBytes: 4096 });
  class ErrorAfterResponseSocket extends EventEmitter {
    writes = 0;
    ends = 0;
    destroyed = false;
    write(_chunk, callback) {
      this.writes += 1;
      callback?.();
      queueMicrotask(() => this.emit("data", encoder.encode({ version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "epoch", pid: 1 })));
      return true;
    }
    end(_chunk, callback) {
      this.ends += 1;
      callback?.();
      queueMicrotask(() => {
        this.emit("data", encoder.encode({ version: 1, requestId: "response-error", ok: true, result: { kind: "state", sessions: [] } }));
        this.emit("error", new Error("peer reset"));
      });
      return this;
    }
    destroy() { this.destroyed = true; }
  }
  const socket = new ErrorAfterResponseSocket();
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200, createConnection: () => {
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  } });
  await expect(requester("get_state", {}, "response-error")).resolves.toEqual({ kind: "state", sessions: [] });
  expect(socket.writes).toBe(1);
  expect(socket.ends).toBe(1);
});

it.each([
  ["duplicate", (encoder, response) => encoder.encode(response), "DUPLICATE_DAEMON_RESPONSE"],
  ["trailing", (encoder) => encoder.encode({ nonsense: true }), "UNEXPECTED_DAEMON_FRAME"],
  ["partial", () => Buffer.from("{\""), "TRAILING_DAEMON_DATA"],
])("rejects delayed %s data before the response boundary", async (_name, encodeSuffix, code) => {
  const root = await stateRoot();
  const response = { version: 1, requestId: "response-delayed", ok: true, result: { kind: "state", sessions: [] } };
  const server = await daemonServer(root, (socket, encoder) => {
    socket.write(encoder.encode(response));
    setTimeout(() => socket.end(encodeSuffix(encoder, response)), 10);
  }, undefined, { closeOnInputEnd: false });
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("get_state", {}, "response-delayed")).rejects.toMatchObject({ code });
  await new Promise((resolve) => server.close(resolve));
});

it("finalizes one complete candidate at the configured timeout for a persistent peer", async () => {
  const root = await stateRoot();
  const daemon = join(root, "daemon");
  await mkdir(daemon, { mode: 0o700 });
  await writeFile(join(daemon, "control.token"), "secret\n", { mode: 0o600 });
  const encoder = createJsonlEncoder({ maxBytes: 4096 });
  class PersistentResponseSocket extends EventEmitter {
    destroyed = false;
    write(_chunk, callback) {
      callback?.();
      queueMicrotask(() => this.emit("data", encoder.encode({ version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "epoch", pid: 1 })));
      return true;
    }
    end(_chunk) {
      queueMicrotask(() => this.emit("data", encoder.encode({ version: 1, requestId: "response-persistent", ok: true, result: { kind: "state", sessions: [] } })));
      return this;
    }
    destroy() { this.destroyed = true; }
  }
  const socket = new PersistentResponseSocket();
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 20, createConnection: () => {
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  } });
  await expect(requester("get_state", {}, "response-persistent")).resolves.toEqual({ kind: "state", sessions: [] });
  expect(socket.destroyed).toBe(true);
});

it("rejects a validated response followed by a partial trailing frame", async () => {
  const root = await stateRoot();
  const response = { version: 1, requestId: "response-partial", ok: true, result: { kind: "state", sessions: [] } };
  const server = await daemonServer(root, (socket, encoder) => socket.end(Buffer.concat([encoder.encode(response), Buffer.from("{\"")])));
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("get_state", {}, "response-partial")).rejects.toMatchObject({ code: "INCOMPLETE_FRAME" });
  await new Promise((resolve) => server.close(resolve));
});

it("bounds response wait and classifies timeout after submission as DELIVERY_UNKNOWN", async () => {
  const root = await stateRoot();
  const daemon = join(root, "daemon");
  await mkdir(daemon, { mode: 0o700 });
  await writeFile(join(daemon, "control.token"), "secret\n", { mode: 0o600 });
  const socketPath = join(daemon, "control.sock");
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    const decoder = createJsonlDecoder({ maxBytes: 1024 });
    const encoder = createJsonlEncoder({ maxBytes: 1024 });
    let authenticated = false;
    socket.on("data", (chunk) => {
      for (const _frame of decoder.push(chunk)) {
        if (!authenticated) {
          authenticated = true;
          socket.write(encoder.encode({ version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "epoch", pid: 1 }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 1024, timeoutMs: 500 });
  await expect(requester("stop", { sessionId: "exact", revision: 1 }, "request-timeout")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
  await new Promise((resolve) => server.close(resolve));
});

it("creates and sends one pending identity atomically across concurrent destructive invocations", async () => {
  const root = await stateRoot();
  const received = [];
  const waiting = [];
  const server = await daemonServer(root, (socket, encoder, frame) => {
    received.push(frame);
    waiting.push({ socket, encoder, frame });
    if (waiting.length === 2) {
      for (const item of waiting) {
        item.socket.write(item.encoder.encode({
          version: 1,
          requestId: item.frame.requestId,
          ok: true,
          result: { kind: "command", status: commandStatus("delete", "DELIVERY_UNKNOWN", item.frame.clientId, item.frame.requestId) },
        }));
      }
    }
  });
  const argv = ["delete", "exact-session-id", "--revision", "4", "--yes"];
  await Promise.all([
    runSessionCommand(argv, { root, randomId: () => "stable", timeoutMs: 500 }),
    runSessionCommand(argv, { root, randomId: () => "stable", timeoutMs: 500 }),
  ]);
  expect(new Set(received.map(({ clientId }) => clientId))).toEqual(new Set(["cli-stable"]));
  expect(new Set(received.map(({ requestId }) => requestId)).size).toBe(1);
  const names = await readdir(join(root, "cli", "pending"));
  expect(names).toHaveLength(1);
  const pending = JSON.parse(await readFile(join(root, "cli", "pending", names[0]), "utf8"));
  expect(pending).toMatchObject({ clientId: "cli-stable", requestId: received[0].requestId });
  await new Promise((resolve) => server.close(resolve));
});

it("publishes only complete pending winners while concurrent creators wait on the per-key lock", async () => {
  const root = await stateRoot();
  const argv = ["delete", "exact-session-id", "--revision", "4", "--yes"];
  let releasePublish;
  const publishBlocked = new Promise((resolve) => { releasePublish = resolve; });
  let enteredPublish;
  const publishEntered = new Promise((resolve) => { enteredPublish = resolve; });
  const requestIds = [];
  const request = vi.fn(async (_op, _payload, requestId) => {
    requestIds.push(requestId);
    return { kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId } };
  });
  const first = runSessionCommand(argv, {
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
  const second = runSessionCommand(argv, { root, randomId: () => "stable", request });
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
  const argv = ["delete", "exact-session-id", "--revision", "4", "--yes"];
  const ambiguous = vi.fn(async (_op, _payload, requestId) => ({ kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId } }));
  await runSessionCommand(argv, { root, randomId: () => "stable", request: ambiguous });
  const directory = join(root, "cli", "pending");
  const [name] = (await readdir(directory)).filter((candidate) => candidate.endsWith(".json"));
  const path = join(directory, name);
  const original = JSON.parse(await readFile(path, "utf8"));
  let releaseClear;
  const clearBlocked = new Promise((resolve) => { releaseClear = resolve; });
  let enteredClear;
  const clearEntered = new Promise((resolve) => { enteredClear = resolve; });
  const completing = runSessionCommand(argv, {
    root,
    request: async (_op, _payload, requestId) => ({ kind: "command", status: { stage: "COMPLETED", clientId: "cli-stable", requestId } }),
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

it("restores pending publication when clear fails after the atomic tombstone", async () => {
  const root = await stateRoot();
  const argv = ["delete", "exact-session-id", "--revision", "4", "--yes"];
  await runSessionCommand(argv, {
    root,
    randomId: () => "stable",
    request: async (_op, _payload, requestId) => ({ kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId } }),
  });
  const directory = join(root, "cli", "pending");
  const [name] = (await readdir(directory)).filter((candidate) => candidate.endsWith(".json"));
  const path = join(directory, name);
  const original = await readFile(path, "utf8");
  await expect(runSessionCommand(argv, {
    root,
    request: async (_op, _payload, requestId) => ({ kind: "command", status: { stage: "COMPLETED", clientId: "cli-stable", requestId } }),
    pendingFailpoint(stage) { if (stage === "pending_after_tombstone") throw new Error("simulated clear crash"); },
  })).rejects.toThrow("simulated clear crash");
  expect(await readFile(path, "utf8")).toBe(original);
});

it("recovers the exact atomic tombstone left by a crashed pending clearer", async () => {
  const root = await stateRoot();
  const argv = ["delete", "exact-session-id", "--revision", "4", "--yes"];
  const requestIds = [];
  const request = vi.fn(async (_op, _payload, requestId) => {
    requestIds.push(requestId);
    return { kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId } };
  });
  await runSessionCommand(argv, { root, randomId: () => "stable", request });
  const directory = join(root, "cli", "pending");
  const [name] = (await readdir(directory)).filter((candidate) => candidate.endsWith(".json"));
  const key = name.slice(0, -5);
  await rename(join(directory, name), join(directory, `.${key}.clear.crashed.tmp`));

  await runSessionCommand(argv, { root, randomId: () => "stable", request });

  expect(requestIds[1]).toBe(requestIds[0]);
  expect(await readFile(join(directory, name), "utf8")).toContain(requestIds[0]);
  expect((await readdir(directory)).some((candidate) => candidate.includes(".clear."))).toBe(false);
});

it("recovers a dead exact pending lock holder before clearing", async () => {
  const root = await stateRoot();
  const argv = ["delete", "exact-session-id", "--revision", "4", "--yes"];
  await runSessionCommand(argv, {
    root,
    randomId: () => "stable",
    request: async (_op, _payload, requestId) => ({ kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId } }),
  });
  const directory = join(root, "cli", "pending");
  const [name] = (await readdir(directory)).filter((candidate) => candidate.endsWith(".json"));
  const key = name.slice(0, -5);
  const lockPath = join(directory, `.${key}.lock`);
  const token = "dead-token";
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, token), `${JSON.stringify({ token, owner: { pid: 2147483647, startIdentity: "1" } })}\n`, { mode: 0o600 });

  await expect(runSessionCommand(argv, {
    root,
    request: async (_op, _payload, requestId) => ({ kind: "command", status: { stage: "COMPLETED", clientId: "cli-stable", requestId } }),
  })).resolves.toMatchObject({ code: 0 });
  expect((await readdir(directory)).filter((candidate) => candidate.endsWith(".json"))).toEqual([]);
});

it("ignores an unpublished private temp left by a crashed pending creator", async () => {
  const root = await stateRoot();
  const directory = join(root, "cli", "pending");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, ".publish-crashed.tmp"), "", { mode: 0o600 });
  await runSessionCommand(["delete", "exact-session-id", "--revision", "4", "--yes"], {
    root,
    randomId: () => "stable",
    request: async (_op, _payload, requestId) => ({ kind: "command", status: { stage: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId } }),
  });
  expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
});

it.each(["corrupt", "symlink", "wrong-mode"])("fails closed for %s pending state", async (kind) => {
  const root = await stateRoot();
  const request = vi.fn(async () => ({ kind: "command", status: { stage: "DELIVERY_UNKNOWN" } }));
  const argv = ["delete", "exact-session-id", "--revision", "4", "--yes"];
  await runSessionCommand(argv, { root, request });
  const directory = join(root, "cli", "pending");
  const [name] = await readdir(directory);
  const path = join(directory, name);
  if (kind === "corrupt") await writeFile(path, "not-json\n", { mode: 0o600 });
  if (kind === "wrong-mode") await chmod(path, 0o644);
  if (kind === "symlink") {
    const target = join(root, "pending-target");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
  }
  await expect(runSessionCommand(argv, { root, request })).rejects.toMatchObject({ code: expect.stringMatching(/^CLI_STATE_/u) });
});

it("does not clear a newer pending winner with a stale terminal result", async () => {
  const root = await stateRoot();
  let completeFirst;
  const first = new Promise((resolve) => { completeFirst = resolve; });
  const request = vi.fn(async (_op, _payload, requestId) => {
    await first;
    return { kind: "command", status: { stage: "COMPLETED", requestId } };
  });
  const argv = ["delete", "exact-session-id", "--revision", "4", "--yes"];
  const running = runSessionCommand(argv, { root, request });
  while (request.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const directory = join(root, "cli", "pending");
  const [name] = await readdir(directory);
  const path = join(directory, name);
  const stale = JSON.parse(await readFile(path, "utf8"));
  const newer = { ...stale, requestId: "new-winner-request" };
  await writeFile(path, `${JSON.stringify(newer)}\n`, { mode: 0o600 });
  completeFirst();
  await running;
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(newer);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
});

it.each([
  ["unknown state", { version: 1, kind: "authenticated", state: "MYSTERY", recovering: false, daemonEpoch: "epoch", pid: 1 }],
  ["unknown field", { version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "epoch", pid: 1, extra: true }],
  ["truthy error in READY", { version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "epoch", pid: 1, error: "bad" }],
  ["malformed FAILED error", { version: 1, kind: "authenticated", state: "FAILED", recovering: false, daemonEpoch: "epoch", pid: 1, error: { code: "FAILED", message: "bad" } }],
  ["wrong recovery marker", { version: 1, kind: "authenticated", state: "RECONCILING", recovering: false, daemonEpoch: "epoch", pid: 1 }],
])("rejects invalid authentication: %s", async (_name, authentication) => {
  const root = await stateRoot();
  const submitted = vi.fn();
  const server = await daemonServer(root, submitted, authentication);
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("delete", { sessionId: "exact", revision: 1 }, "auth-request")).rejects.toMatchObject({ code: "INVALID_DAEMON_AUTHENTICATION" });
  expect(submitted).not.toHaveBeenCalled();
  await new Promise((resolve) => server.close(resolve));
});

it.each([
  ["unknown successful result", { version: 1, requestId: "strict-request", ok: true, result: { kind: "mystery" } }, "INVALID_DAEMON_RESPONSE"],
  ["wrong request ID", { version: 1, requestId: "other", ok: true, result: { kind: "state", sessions: [] } }, "UNEXPECTED_DAEMON_RESPONSE"],
  ["event frame", { version: 1, cursor: { daemonEpoch: "epoch", sequence: "1" }, occurredAt: "now", kind: "command_changed", payload: {} }, "UNEXPECTED_DAEMON_FRAME"],
  ["invalid error", { version: 1, requestId: "strict-request", ok: false, error: { code: "NO", message: "bad" } }, "INVALID_DAEMON_RESPONSE"],
])("rejects %s as a typed protocol failure", async (_name, frame, code) => {
  const root = await stateRoot();
  const server = await daemonServer(root, (socket, encoder) => socket.write(encoder.encode(frame)));
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("get_state", {}, "strict-request")).rejects.toMatchObject({ code });
  await new Promise((resolve) => server.close(resolve));
});

it("retains pending identity when a successful daemon frame fails validation", async () => {
  const root = await stateRoot();
  const server = await daemonServer(root, (socket, encoder, frame) => socket.write(encoder.encode({ version: 1, requestId: frame.requestId, ok: true, result: { kind: "mystery" } })));
  await expect(runSessionCommand(["delete", "exact-session-id", "--revision", "4", "--yes"], { root, randomId: () => "stable", timeoutMs: 200 })).rejects.toMatchObject({ code: "INVALID_DAEMON_RESPONSE" });
  expect(await readdir(join(root, "cli", "pending"))).toHaveLength(1);
  await new Promise((resolve) => server.close(resolve));
});

it.each([
  ["duplicate response", (encoder, response) => Buffer.concat([encoder.encode(response), encoder.encode(response)]), "DUPLICATE_DAEMON_RESPONSE"],
  ["trailing frame", (encoder, response) => Buffer.concat([encoder.encode(response), encoder.encode({ nonsense: true })]), "UNEXPECTED_DAEMON_FRAME"],
])("rejects a %s without accepting the first frame", async (_name, encodeFrames, code) => {
  const root = await stateRoot();
  const response = { version: 1, requestId: "strict-request", ok: true, result: { kind: "state", sessions: [] } };
  const server = await daemonServer(root, (socket, encoder) => socket.write(encodeFrames(encoder, response)));
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, timeoutMs: 200 });
  await expect(requester("get_state", {}, "strict-request")).rejects.toMatchObject({ code });
  await new Promise((resolve) => server.close(resolve));
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
  await new Promise((resolve) => server.close(resolve));
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
  await runSessionCommand(["delete", "exact-session-id", "--revision", "4", "--yes"], { request, root });
  await expect(runSessionCommand(["resolve-delivery", "target-client-full", destructiveRequestId, "abandon", "--yes"], { request, root })).resolves.toMatchObject({ code: 0 });
  expect(request).toHaveBeenCalledTimes(2);
  await expect(runSessionCommand(["resolve-delivery", "target", destructiveRequestId, "abandon", "--yes", "extra"], { request, root })).resolves.toMatchObject({ code: 2 });
});
