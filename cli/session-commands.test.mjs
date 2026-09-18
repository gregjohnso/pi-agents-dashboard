import net from "node:net";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { DEFAULT_STOP_ESCALATION_MS, createDaemonRequester, destructiveRequestTimeoutMs, loadCliClientIdentity, runAgentsCommand, runLogsCommand, runSessionCommand } from "./session-commands.mjs";

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

/** A destructive command whose outcome the daemon could not attribute. */
const ambiguousRequest = async () => { throw Object.assign(new Error("Daemon response was lost after submission"), { code: "DELIVERY_UNKNOWN" }); };

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
// The command carries the installation clientId, its own request ID, and an exact revision. It
// claims nothing first: the daemon authorized this client when it authenticated the socket.
it("sends the exact revision-bound stop alone", async () => {
  const root = await stateRoot();
  const operations = [];
  const request = vi.fn(async (op, payload) => {
    operations.push([op, payload]);
    return { kind: "command", sessionId: "exact-session-id" };
  });
  await expect(runSessionCommand(stopArgv, { request: request, root })).resolves.toMatchObject({ code: 0 });
  expect(operations).toEqual([["stop", { sessionId: "exact-session-id", revision: 4 }]]);
});

it("never replays a destructive request when the socket is lost after the stop is submitted", async () => {
  const root = await stateRoot();
  const operations = [];
  const server = await daemonServer(root, (socket, encoder, frame) => {
    operations.push(frame.op);
    if (frame.op === "stop") socket.destroy();
  });
  await expect(runSessionCommand(stopArgv, { root, randomId: () => "lost-socket", timeoutMs: 200 })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(operations).toEqual(["stop"]);
  await closeServer(server);
});

it.each([
  ["missing confirmation", ["stop", "exact-session-id", "--revision", "4"]],
  ["path-like session ID", ["stop", "sessions/exact-session-id", "--revision", "4", "--yes"]],
])("rejects strict destructive grammar: %s", async (_name, argv) => {
  const request = vi.fn();
  await expect(runSessionCommand(argv, { request })).resolves.toMatchObject({ code: 2, error: { code: "INVALID_SYNTAX" } });
  expect(request).not.toHaveBeenCalled();
});

it.each([
  ["status", ["status", "exact-session-id"]],
])("rejects the retired %s verb", async (_name, argv) => {
  const request = vi.fn();
  await expect(runSessionCommand(argv, { request })).resolves.toMatchObject({ code: 2, error: { code: "INVALID_SYNTAX" } });
  expect(request).not.toHaveBeenCalled();
});

// rm is the operator's verb only; the wire operation keeps the spelling a running daemon already
// speaks. An ambiguous answer names the session and revision he can read the outcome from, and
// writes nothing: the row's own revision is the record.
it("sends rm as the delete operation and records nothing about the attempt", async () => {
  const root = await stateRoot();
  const request = vi.fn(ambiguousRequest);
  await expect(runSessionCommand(rmArgv, { root, randomId: () => "stable", request })).resolves.toMatchObject({ code: 1, error: { code: "DELIVERY_UNKNOWN", sessionId: "exact-session-id", revision: 4 } });
  expect(request.mock.calls[0][0]).toBe("delete");
  await expect(readdir(join(root, "cli", "pending"))).rejects.toMatchObject({ code: "ENOENT" });
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

/** One CLI requester on one held connection, closed however the test ends. */
async function withRequester(root, options, run) {
  const requester = await createDaemonRequester({ root, clientId: "cli-stable", maxBytes: 4096, ...options });
  try { return await run(requester.request); } finally { await requester.close(); }
}

it.each([
  ["ends without answering", (socket) => socket.end(), {}, 200],
])("settles a submitted request as DELIVERY_UNKNOWN when the peer %s", async (_name, respond, serverOptions, timeoutMs) => {
  const root = await stateRoot();
  const server = await daemonServer(root, respond, undefined, serverOptions);
  await withRequester(root, { timeoutMs }, async (request) => {
    await expect(request("delete", { sessionId: "exact", revision: 1 }, "request-full")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId: "request-full" });
  });
  await closeServer(server);
});

it("reports a read-only timeout as a timeout, never as an ambiguous delivery", async () => {
  const root = await stateRoot();
  const server = await daemonServer(root, () => {}, undefined, { closeOnInputEnd: false });
  await withRequester(root, { timeoutMs: 100 }, async (request) => {
    await expect(request("get_state", {}, "read-only-request")).rejects.toMatchObject({ code: "DAEMON_REQUEST_TIMEOUT" });
  });
  await closeServer(server);
});

// The shared client's rule, which the CLI now inherits: an answer that fails strict validation
// rejects the one request that owns it and keeps the connection. A destructive request whose answer
// cannot be read may already have run, so it is ambiguous rather than a clean failure.
it.each([
  ["an unparseable successful result", { ok: true, result: { kind: "mystery" } }],
])("rejects only the request that owns %s", async (_name, answer) => {
  const root = await stateRoot();
  const server = await daemonServer(root, (socket, encoder, frame) => socket.write(encoder.encode({ version: 1, requestId: frame.requestId, ...answer })), undefined, { closeOnInputEnd: false });
  await withRequester(root, { timeoutMs: 200 }, async (request) => {
    await expect(request("get_state", {}, "read-request")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(request("delete", { sessionId: "exact", revision: 1 }, "delete-request")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId: "delete-request", submitted: true });
  });
  await closeServer(server);
});

// The request reached the daemon and its answer was unusable, so the delete may already have run.
it("classifies a destructive response that cannot be parsed as delivery unknown", async () => {
  const root = await stateRoot();
  const server = await daemonServer(root, (socket, encoder, frame) => socket.write(encoder.encode({ version: 1, requestId: frame.requestId, ok: true, result: { kind: "command" } })));
  await withRequester(root, { timeoutMs: 2_000 }, async (request) => {
    await expect(request("delete", { sessionId: "exact", revision: 1 }, "unparseable-request")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "cli-stable", requestId: "unparseable-request", submitted: true });
  });
  await closeServer(server);
});

// A command answer for another session is not this command's answer, and the stop it answers may
// still have run, so the operator is told it is ambiguous rather than that nothing happened.
it("refuses a command answer that names a different session", async () => {
  const root = await stateRoot();
  const server = await daemonServer(root, (socket, encoder) => socket.write(encoder.encode({ version: 1, requestId: "strict-request", ok: true, result: { kind: "command", sessionId: "another-session" } })));
  await withRequester(root, { timeoutMs: 200 }, async (request) => {
    await expect(request("stop", { sessionId: "exact", revision: 1 }, "strict-request")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", requestId: "strict-request" });
  });
  await closeServer(server);
});

/** One session row shaped the way the daemon publishes it, so strict response validation accepts it. */
const wireSession = {
  schemaVersion: 1,
  revision: 4,
  sessionId: "exact-session-id",
  sessionFile: "/pi/sessions/exact.json",
  canonicalSessionFile: "/pi/sessions/exact.json",
  cwd: "/repo",
  taskState: "STOPPED",
  processState: "EXITED",
  outcome: "NONE",
  activity: { kind: "idle", summary: "", updatedAt: "2026-01-01T00:00:00.000Z" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  isolation: { mode: "worktree", worktreePath: "/managed/worktree", branch: "agent/exact" },
};

// One command is one authenticated conversation. Cleanup reads the row, then re-reads it at the
// ownership boundary; on the retired per-request socket that was two connections and two handshakes.
it("runs every request of one command on one authenticated connection", async () => {
  const root = await stateRoot();
  const server = await daemonServer(root, (socket, encoder, frame) =>
    socket.write(encoder.encode({ version: 1, requestId: frame.requestId, ok: true, result: { kind: "state", sessions: [wireSession], cursor: { daemonEpoch: "epoch", sequence: "0" } } })));
  const cleanupManagedWorktree = vi.fn(async (_isolation, cleanupOptions) => {
    expect(await cleanupOptions.readLiveOwnership()).toBeNull();
    return { disposition: "REMOVED" };
  });
  await expect(runSessionCommand(["cleanup", "exact-session-id", "--revision", "4", "--yes"], { root, randomId: () => "stable", timeoutMs: 2_000, cleanupManagedWorktree }))
    .resolves.toMatchObject({ code: 0, result: { disposition: "REMOVED" } });
  expect(server.sockets).toHaveLength(1);
  await closeServer(server);
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

it.each([["parent escape", "../outside"], ["empty name", ""]])(
  "refuses a run hash that is not a root-relative directory name: %s",
  async (_name, badHash) => {
    const root = await stateRoot();
    await expect(runLogsCommand("exact-session-id", { root, request: stateWith({ ...logSession, runHash: badHash }) }))
      .resolves.toMatchObject({ code: 1, error: { code: "LOG_SOURCE_UNSAFE" } });
  },
);

it("refuses an unknown exact session ID and a prefix of a known one", async () => {
  const root = await stateRoot();
  const request = stateWith(logSession);
  await expect(runLogsCommand("exact-session", { root, request })).resolves.toMatchObject({ code: 1, error: { code: "SESSION_NOT_FOUND" } });
  await expect(runLogsCommand("sessions/exact-session-id", { root, request: vi.fn() })).resolves.toMatchObject({ code: 2, error: { code: "INVALID_SYNTAX" } });
});
