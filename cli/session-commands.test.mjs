import net from "node:net";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

async function daemonServer(root, respond) {
  const daemon = join(root, "daemon");
  await mkdir(daemon, { mode: 0o700 });
  await writeFile(join(daemon, "control.token"), "secret\n", { mode: 0o600 });
  const socketPath = join(daemon, "control.sock");
  const server = net.createServer((socket) => {
    const decoder = createJsonlDecoder({ maxBytes: 4096 });
    const encoder = createJsonlEncoder({ maxBytes: 4096 });
    let authenticated = false;
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (!authenticated) {
          authenticated = true;
          socket.write(encoder.encode({ version: 1, kind: "authenticated", state: "READY", recovering: false, daemonEpoch: "epoch", pid: 1 }));
        } else respond(socket, encoder, frame);
      }
    });
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
