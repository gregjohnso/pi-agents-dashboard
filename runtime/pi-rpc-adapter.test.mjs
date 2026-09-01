import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";

import { PiRpcAdapter } from "./pi-rpc-adapter.mjs";
import { collectSessionMenu, createWorkerCommandDispatcher, createWorkerReplayStore, replayDeliveryIsAmbiguous } from "./worker.mjs";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** @param {(command: any, child: any) => void} [onCommand] @returns {any} */
function fakeRpcProcess(onCommand = () => {}) {
  const child = /** @type {any} */ (new EventEmitter());
  child.pid = 4321;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let input = "";
  child.stdin.on("data", (/** @type {Buffer} */ chunk) => {
    input += chunk.toString("utf8");
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline === -1) break;
      const command = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      onCommand(command, child);
    }
  });
  return child;
}

/** Resolve to `"stalled"` when a promise outlives the wait, so a hang reads as a hang. @param {Promise<any>} promise @param {number} ms */
async function settledWithin(promise, ms) {
  return Promise.race([
    promise.then((value) => ({ value }), (error) => error),
    new Promise((resolve) => setTimeout(() => resolve("stalled"), ms)),
  ]);
}

it("uses the public RPC entry with structured argv and an exact environment", async () => {
  /** @type {any[]} */
  const calls = [];
  const child = fakeRpcProcess((command, process) => {
    process.stdout.write(`${JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: command.type === "get_state" ? { sessionId: "pi-1" } : undefined,
    })}\n`);
  });
  /** @param {string} command @param {string[]} argv @param {any} options */
  const spawnImpl = (command, argv, options) => {
    calls.push({ command, argv, options });
    return child;
  };

  const adapter = await PiRpcAdapter.start({
    cwd: "/tmp/a cwd",
    sessionFile: "/tmp/session ; not-shell.jsonl",
    model: { provider: "fake-provider", id: "model with spaces" },
    name: "name; still one arg",
    env: { PATH: "/exact/path", SAFE: "value" },
    executable: "/installed/pi",
    spawnImpl,
  });

  expect(calls).toEqual([{
    command: "/installed/pi",
    argv: [
      "--mode",
      "rpc",
      "--session",
      "/tmp/session ; not-shell.jsonl",
      "--provider",
      "fake-provider",
      "--model",
      "model with spaces",
      "--name",
      "name; still one arg",
    ],
    options: {
      cwd: "/tmp/a cwd",
      env: { PATH: "/exact/path", SAFE: "value" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  }]);
  await expect(adapter.getState()).resolves.toEqual({ sessionId: "pi-1" });
  await adapter.close();
});

it("recovers a durable in-flight Pi write as ambiguous without writing again", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-replay-"));
  cleanup.push(root);
  const path = join(root, "replay.jsonl");
  const replay = await createWorkerReplayStore({ path });
  const key = { clientId: "client", requestId: "request", op: "prompt" };
  await replay.append({ ...key, stage: "RECEIVED" });
  await replay.append({ ...key, stage: "RPC_WRITE_STARTED" });
  await replay.close();

  const recovered = await createWorkerReplayStore({ path });
  const prompt = vi.fn();
  const dispatcher = createWorkerCommandDispatcher({ replay: recovered, adapter: { prompt } });

  await expect(dispatcher.deliver({ ...key, text: "do not replay" })).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
  expect(prompt).not.toHaveBeenCalled();
  expect(recovered.current(key)).toMatchObject({ stage: "DELIVERY_UNKNOWN" });
  await dispatcher.close();
});

// Acceptance is this fsync and nothing else: there is no daemon-side journal holding the operator's
// text, so a record that does not carry it leaves a crash between acceptance and the Pi write with
// no durable copy of what he typed.
it("keeps the operator's text on every durable record that accepts it", async () => {
  /** @type {any[]} */
  const records = [];
  const replay = await createWorkerReplayStore({ append: async (record) => { records.push(record); } });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter: {
    async prompt() { throw Object.assign(new Error("stream closed"), { code: "RPC_STREAM_CLOSED" }); },
  } });

  await expect(dispatcher.deliver({ clientId: "client", requestId: "accepted-text", op: "prompt", text: "the exact words he typed" })).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
  expect(records.map((record) => [record.stage, record.text])).toEqual([
    ["RECEIVED", "the exact words he typed"],
    ["RPC_WRITE_STARTED", "the exact words he typed"],
    ["DELIVERY_UNKNOWN", "the exact words he typed"],
  ]);
});

it("marks stream loss after RPC_WRITE_STARTED as delivery unknown", async () => {
  const code = "RPC_STREAM_CLOSED";
  /** @type {any[]} */
  const records = [];
  const replay = await createWorkerReplayStore({ append: async (record) => { records.push(record); } });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter: {
    async prompt() { throw Object.assign(new Error("transport failed"), { code }); },
    getStderr() { return "provider stderr"; },
  } });

  await expect(dispatcher.deliver({ clientId: "client", requestId: code, op: "prompt", text: "hello" })).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", deliveryUnknown: true });
  expect(records.map((record) => record.stage)).toEqual(["RECEIVED", "RPC_WRITE_STARTED", "DELIVERY_UNKNOWN"]);
  expect(records.at(-1)).toMatchObject({ stage: "DELIVERY_UNKNOWN", stderr: "provider stderr" });
});

it("reports delivery unknown when persisting that result fails after the durable Pi write boundary", async () => {
  /** @type {any[]} */
  const records = [];
  const appendFailure = new Error("delivery unknown append failed");
  const replay = await createWorkerReplayStore({
    append: async (record) => {
      if (record.stage === "DELIVERY_UNKNOWN") throw appendFailure;
      records.push(record);
    },
  });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter: {
    async prompt() { throw Object.assign(new Error("stream closed"), { code: "RPC_STREAM_CLOSED" }); },
  } });

  await expect(dispatcher.deliver({ clientId: "client", requestId: "append-failure", op: "prompt", text: "hello" })).rejects.toMatchObject({
    code: "DELIVERY_UNKNOWN",
    deliveryUnknown: true,
    cause: appendFailure,
  });
  expect(records.map((record) => record.stage)).toEqual(["RECEIVED", "RPC_WRITE_STARTED"]);
  const key = { clientId: "client", requestId: "append-failure" };
  expect(replay.current(key)).toMatchObject({ stage: "RPC_WRITE_STARTED" });
  expect(replayDeliveryIsAmbiguous(replay, key)).toBe(true);
});

it("records an explicit Pi error acknowledgement before the terminal failure", async () => {
  /** @type {any[]} */
  const records = [];
  const child = fakeRpcProcess((command, process) => {
    process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "provider refused" })}\n`);
  });
  const adapter = await PiRpcAdapter.start({
    cwd: "/tmp",
    sessionFile: "/tmp/fake-session.jsonl",
    env: {},
    executable: "/installed/pi",
    spawnImpl: () => child,
  });
  const replay = await createWorkerReplayStore({ append: async (record) => { records.push(record); } });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter });

  await expect(dispatcher.deliver({ clientId: "client", requestId: "refused", op: "prompt", text: "hello" })).rejects.toMatchObject({ code: "RPC_COMMAND_FAILED", acknowledged: true });
  expect(records.map((record) => record.stage)).toEqual(["RECEIVED", "RPC_WRITE_STARTED", "RPC_ACKNOWLEDGED", "FAILED"]);
  await adapter.close();
});

it("tells Pi what to do with text that arrives during a run, for both operations a dashboard sends", async () => {
  /** @type {any[]} */
  const seen = [];
  const child = fakeRpcProcess((command, process) => {
    seen.push(command);
    process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true })}\n`);
  });
  const adapter = await PiRpcAdapter.start({ cwd: "/tmp", sessionFile: "/tmp/fake-session.jsonl", env: {}, executable: "/installed/pi", spawnImpl: () => child });
  const replay = await createWorkerReplayStore({ append: async () => {} });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter });

  // A dashboard picks the operation from a `working` flag that is one event behind Pi. Either pick
  // reaches Pi as one prompt carrying the behavior, so Pi's own state decides what happens to it.
  await dispatcher.deliver({ clientId: "client", requestId: "believed-idle", op: "prompt", text: "push" });
  await dispatcher.deliver({ clientId: "client", requestId: "believed-working", op: "follow_up", text: "then deploy" });

  expect(seen.map(({ type, message, streamingBehavior }) => ({ type, message, streamingBehavior }))).toEqual([
    { type: "prompt", message: "push", streamingBehavior: "followUp" },
    { type: "prompt", message: "then deploy", streamingBehavior: "followUp" },
  ]);
  await dispatcher.close();
  await adapter.close();
});

it("resubmits the same text as a follow-up when Pi refuses a prompt it is already too busy to accept", async () => {
  /** @type {any[]} */
  const records = [];
  /** @type {any[]} */
  const seen = [];
  // A Pi that does not read `streamingBehavior` refuses every prompt while it is running a turn.
  const child = fakeRpcProcess((command, process) => {
    seen.push(command);
    const refused = command.type === "prompt";
    process.stdout.write(`${JSON.stringify(refused
      ? { id: command.id, type: "response", command: command.type, success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." }
      : { id: command.id, type: "response", command: command.type, success: true })}\n`);
  });
  const adapter = await PiRpcAdapter.start({ cwd: "/tmp", sessionFile: "/tmp/fake-session.jsonl", env: {}, executable: "/installed/pi", spawnImpl: () => child });
  const replay = await createWorkerReplayStore({ append: async (record) => { records.push(record); } });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter });

  await expect(dispatcher.deliver({ clientId: "client", requestId: "busy", op: "prompt", text: "push" })).resolves.toMatchObject({ stage: "RPC_ACKNOWLEDGED" });

  // The refusal is acknowledged, so Pi queued nothing: the text is delivered exactly once.
  expect(seen.map(({ type, message }) => [type, message])).toEqual([["prompt", "push"], ["follow_up", "push"]]);
  expect(records.map((record) => record.stage)).toEqual(["RECEIVED", "RPC_WRITE_STARTED", "RPC_ACKNOWLEDGED"]);
  await dispatcher.close();
  await adapter.close();
});

it("fails unsupported operations before recording RPC_WRITE_STARTED", async () => {
  /** @type {any[]} */
  const records = [];
  const replay = await createWorkerReplayStore({ append: async (record) => { records.push(record); } });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter: {} });

  await expect(dispatcher.deliver({ clientId: "client", requestId: "unsupported", op: "unknown" })).rejects.toMatchObject({ code: "UNSUPPORTED_WORKER_OPERATION" });
  expect(records.map((record) => record.stage)).toEqual(["RECEIVED", "FAILED"]);
});

it("refuses a session query the worker no longer dispatches", async () => {
  /** @type {any[]} */
  const records = [];
  const replay = await createWorkerReplayStore({ append: async (record) => { records.push(record); } });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter: {} });

  await expect(dispatcher.deliver({ clientId: "client", requestId: "stats", op: "session_query" })).rejects.toMatchObject({ code: "UNSUPPORTED_WORKER_OPERATION" });
  expect(records.map((record) => record.stage)).toEqual(["RECEIVED", "FAILED"]);
});

it("persists exact invalid RPC bytes before fatal decoding", async () => {
  const child = fakeRpcProcess((_command, process) => process.stdout.write(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a])));
  const diagnostics = { append: vi.fn(async () => {}) };
  const adapter = PiRpcAdapter.connect({ input: child.stdin, output: child.stdout, diagnostics });
  await expect(adapter.getState()).rejects.toMatchObject({ code: "MALFORMED_RPC_OUTPUT" });
  expect(diagnostics.append).toHaveBeenCalledWith(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]));
  await adapter.close();
});

it("rejects malformed Pi output, retains stderr, and does not respawn", async () => {
  const child = fakeRpcProcess((_command, process) => {
    process.stderr.write("fake provider stderr\n");
    process.stdout.write("{malformed}\n");
  });
  let spawns = 0;
  const adapter = await PiRpcAdapter.start({
    cwd: "/tmp",
    sessionFile: "/tmp/session.jsonl",
    env: {},
    executable: "/installed/pi",
    spawnImpl() {
      spawns += 1;
      return child;
    },
  });

  await expect(adapter.prompt("no model call")).rejects.toMatchObject({ code: "MALFORMED_RPC_OUTPUT" });
  expect(adapter.getStderr()).toContain("fake provider stderr");
  await expect(adapter.getState()).rejects.toMatchObject({ code: "MALFORMED_RPC_OUTPUT" });
  expect(spawns).toBe(1);
  await adapter.close();
});

it("exposes the retry brake but no session query and no settings passthrough", async () => {
  /** @type {any[]} */
  const sent = [];
  const child = fakeRpcProcess((command, process) => {
    sent.push(command);
    process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true })}\n`);
  });
  const adapter = PiRpcAdapter.connect({ input: child.stdin, output: child.stdout, maxRecordBytes: 4_096 });

  for (const method of ["getSessionStats", "getTree", "exportHtml", "setAutoCompaction", "setAutoRetry", "setSteeringMode", "setFollowUpMode"]) expect(/** @type {any} */ (adapter)[method], method).toBeUndefined();
  await expect(adapter.abortRetry()).resolves.toBeUndefined();

  expect(sent.map(({ type }) => type)).toEqual(["abort_retry"]);
  await adapter.close();
});

it("discovers commands and applies model and compaction changes, but no thinking change", async () => {
  /** @type {any[]} */
  const sent = [];
  /** @type {Record<string, any>} */
  const data = {
    get_commands: { commands: [{ name: "review", description: "Review", source: "extension" }] },
    get_available_models: { models: [{ provider: "anthropic", id: "claude" }] },
    set_model: { provider: "anthropic", id: "claude" },
    compact: { compacted: true },
  };
  const child = fakeRpcProcess((command, process) => {
    sent.push(command);
    process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: data[command.type] })}\n`);
  });
  const adapter = PiRpcAdapter.connect({ input: child.stdin, output: child.stdout, maxRecordBytes: 4_096 });

  await expect(adapter.getCommands()).resolves.toEqual(data.get_commands);
  await expect(adapter.getAvailableModels()).resolves.toEqual(data.get_available_models);
  await expect(adapter.setModel({ provider: "anthropic", id: "claude" })).resolves.toEqual(data.set_model);
  await expect(adapter.compact("keep decisions")).resolves.toEqual(data.compact);
  for (const method of ["getAvailableThinkingLevels", "setThinkingLevel"]) expect(/** @type {any} */ (adapter)[method], method).toBeUndefined();
  expect(sent.map(({ type }) => type)).toEqual(["get_commands", "get_available_models", "set_model", "compact"]);
  expect(sent[2]).toMatchObject({ provider: "anthropic", modelId: "claude" });
  expect(sent[3]).toMatchObject({ customInstructions: "keep decisions" });
  await adapter.close();
});

it("collects a session menu with no thinking values and never asks Pi for them", async () => {
  const getAvailableThinkingLevels = vi.fn(async () => ({ levels: ["off", "high"] }));
  const menu = await collectSessionMenu({
    getState: async () => ({ model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high" }),
    getCommands: async () => ({ commands: [{ name: "review", source: "extension" }] }),
    getAvailableModels: async () => ({ models: [{ provider: "anthropic", id: "claude" }] }),
    getAvailableThinkingLevels,
  });

  expect(menu).toEqual({
    commands: [{ name: "/review", source: "extension" }],
    models: [{ provider: "anthropic", id: "claude" }],
    model: { provider: "anthropic", id: "claude" },
  });
  expect(getAvailableThinkingLevels).not.toHaveBeenCalled();
});

it("refuses a thinking level the worker no longer applies to Pi", async () => {
  /** @type {any[]} */
  const records = [];
  const replay = await createWorkerReplayStore({ append: async (record) => { records.push(record); } });
  const setThinkingLevel = vi.fn();
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter: { setThinkingLevel } });

  await expect(dispatcher.deliver({ clientId: "client", requestId: "thinking", op: "session_command", sessionCommand: { command: "set_thinking_level", level: "high" } }))
    .rejects.toMatchObject({ code: "INVALID_SESSION_COMMAND" });
  expect(setThinkingLevel).not.toHaveBeenCalled();
  expect(records.map((record) => record.stage)).toEqual(["RECEIVED", "FAILED"]);
});

// Operator-visible failure: a Pi that answers nothing held the worker's serialized command queue
// open forever, so every later command for that session waited behind it with no error to show.
it("expires a request Pi never answers and keeps the adapter usable", async () => {
  const child = fakeRpcProcess((command, process) => {
    if (command.type === "get_state") process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "still-usable" } })}\n`);
  });
  const adapter = PiRpcAdapter.connect({ input: child.stdin, output: child.stdout, requestTimeoutMs: 20 });

  expect(await settledWithin(adapter.prompt("never answered"), 500)).toMatchObject({ code: "RPC_TIMEOUT", acknowledged: false });
  expect(await settledWithin(adapter.getState(), 500)).toEqual({ value: { sessionId: "still-usable" } });
  await adapter.close();
});

it("ignores a late response for an expired request instead of failing the whole adapter", async () => {
  /** @type {any} */
  let held;
  const child = fakeRpcProcess((command, process) => {
    if (command.type === "prompt") held = command;
    else process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "still-usable" } })}\n`);
  });
  const adapter = PiRpcAdapter.connect({ input: child.stdin, output: child.stdout, requestTimeoutMs: 20 });

  expect(await settledWithin(adapter.prompt("answered too late"), 500)).toMatchObject({ code: "RPC_TIMEOUT" });
  child.stdout.write(`${JSON.stringify({ id: held.id, type: "response", command: "prompt", success: true })}\n`);
  expect(await settledWithin(adapter.getState(), 500)).toEqual({ value: { sessionId: "still-usable" } });
  await adapter.close();
});

// The bytes may already have reached Pi, so an expiry is ambiguous delivery, never a failure.
it("records an expired Pi request as ambiguous delivery", async () => {
  /** @type {any[]} */
  const records = [];
  const replay = await createWorkerReplayStore({ append: async (record) => { records.push(record); } });
  const child = fakeRpcProcess(() => {});
  const adapter = PiRpcAdapter.connect({ input: child.stdin, output: child.stdout, requestTimeoutMs: 20 });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter });

  expect(await settledWithin(dispatcher.deliver({ clientId: "client", requestId: "expired", op: "prompt", text: "hello" }), 500))
    .toMatchObject({ code: "DELIVERY_UNKNOWN", deliveryUnknown: true });
  expect(records.map((record) => record.stage)).toEqual(["RECEIVED", "RPC_WRITE_STARTED", "DELIVERY_UNKNOWN"]);
  expect(records.at(-1).error).toMatchObject({ code: "RPC_TIMEOUT" });
  await adapter.close();
});

it("sends one-way UI responses without blocking the next correlated command", async () => {
  /** @type {string[]} */
  const commands = [];
  const child = fakeRpcProcess((command, process) => {
    commands.push(command.type);
    if (command.type === "get_state") process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "session" } })}\n`);
  });
  const diagnostics = { append: vi.fn(async () => {}) };
  const adapter = PiRpcAdapter.connect({ input: child.stdin, output: child.stdout, diagnostics, maxRecordBytes: 1_024 });

  await expect(adapter.uiResponse({ requestId: "ui-1", response: true })).resolves.toBeUndefined();
  await expect(adapter.getState()).resolves.toEqual({ sessionId: "session" });
  expect(commands).toEqual(["extension_ui_response", "get_state"]);
  await adapter.close();
});

it("validates correlated responses and contains event-listener failures", async () => {
  const child = fakeRpcProcess((command, process) => {
    process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    process.stdout.write(`${JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
    })}\n`);
  });
  const adapter = await PiRpcAdapter.start({
    cwd: "/tmp",
    sessionFile: "/tmp/session.jsonl",
    env: {},
    executable: "/installed/pi",
    spawnImpl: () => child,
  });
  let observed = 0;
  adapter.onEvent(() => {
    observed += 1;
    throw new Error("listener failure");
  });

  await expect(adapter.abort()).resolves.toBeUndefined();
  expect(observed).toBe(1);
  await adapter.close();
});
