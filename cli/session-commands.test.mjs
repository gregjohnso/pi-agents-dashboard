import net from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
          socket.write(encoder.encode({ version: 1, kind: "authenticated" }));
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
          socket.write(encoder.encode({ version: 1, kind: "authenticated" }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  const requester = createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 1024, timeoutMs: 500 });
  await expect(requester("stop", { sessionId: "exact", revision: 1 }, "request-timeout")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
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
