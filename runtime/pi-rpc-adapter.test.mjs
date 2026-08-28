import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";

import { PiRpcAdapter } from "./pi-rpc-adapter.mjs";
import { createWorkerCommandDispatcher, createWorkerReplayStore, replayDeliveryIsAmbiguous } from "./worker.mjs";

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
    thinkingLevel: "high",
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
      "--thinking",
      "high",
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

it("fails unsupported operations before recording RPC_WRITE_STARTED", async () => {
  /** @type {any[]} */
  const records = [];
  const replay = await createWorkerReplayStore({ append: async (record) => { records.push(record); } });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter: {} });

  await expect(dispatcher.deliver({ clientId: "client", requestId: "unsupported", op: "unknown" })).rejects.toMatchObject({ code: "UNSUPPORTED_WORKER_OPERATION" });
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

it("forwards read-only queries and session toggles with Pi's own parameter names", async () => {
  /** @type {any[]} */
  const sent = [];
  /** @type {Record<string, any>} */
  const data = {
    get_session_stats: { messageCount: 12, totalTokens: 3400 },
    get_tree: { tree: { id: "root" }, leafId: "leaf-1" },
    export_html: { path: "/tmp/session.html" },
  };
  const child = fakeRpcProcess((command, process) => {
    sent.push(command);
    process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: data[command.type] })}\n`);
  });
  const adapter = PiRpcAdapter.connect({ input: child.stdin, output: child.stdout, maxRecordBytes: 4_096 });

  await expect(adapter.getSessionStats()).resolves.toEqual(data.get_session_stats);
  await expect(adapter.getTree()).resolves.toEqual(data.get_tree);
  await expect(adapter.exportHtml("/tmp/session.html")).resolves.toEqual(data.export_html);
  await expect(adapter.setAutoCompaction(false)).resolves.toBeUndefined();
  await expect(adapter.setAutoRetry(true)).resolves.toBeUndefined();
  await expect(adapter.abortRetry()).resolves.toBeUndefined();
  await expect(adapter.setSteeringMode("all")).resolves.toBeUndefined();
  await expect(adapter.setFollowUpMode("one-at-a-time")).resolves.toBeUndefined();

  expect(sent.map(({ type }) => type)).toEqual(["get_session_stats", "get_tree", "export_html", "set_auto_compaction", "set_auto_retry", "abort_retry", "set_steering_mode", "set_follow_up_mode"]);
  expect(sent[2]).toMatchObject({ outputPath: "/tmp/session.html" });
  expect(sent[3]).toMatchObject({ enabled: false });
  expect(sent[4]).toMatchObject({ enabled: true });
  expect(sent[6]).toMatchObject({ mode: "all" });
  expect(sent[7]).toMatchObject({ mode: "one-at-a-time" });
  await adapter.close();
});

it("discovers commands and applies model, thinking, and compaction changes", async () => {
  /** @type {any[]} */
  const sent = [];
  /** @type {Record<string, any>} */
  const data = {
    get_commands: { commands: [{ name: "review", description: "Review", source: "extension" }] },
    get_available_models: { models: [{ provider: "anthropic", id: "claude" }] },
    get_available_thinking_levels: { levels: ["off", "high"] },
    set_model: { provider: "anthropic", id: "claude" },
    set_thinking_level: undefined,
    compact: { compacted: true },
  };
  const child = fakeRpcProcess((command, process) => {
    sent.push(command);
    process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: data[command.type] })}\n`);
  });
  const adapter = PiRpcAdapter.connect({ input: child.stdin, output: child.stdout, maxRecordBytes: 4_096 });

  await expect(adapter.getCommands()).resolves.toEqual(data.get_commands);
  await expect(adapter.getAvailableModels()).resolves.toEqual(data.get_available_models);
  await expect(adapter.getAvailableThinkingLevels()).resolves.toEqual(data.get_available_thinking_levels);
  await expect(adapter.setModel({ provider: "anthropic", id: "claude" })).resolves.toEqual(data.set_model);
  await expect(adapter.setThinkingLevel("high")).resolves.toBeUndefined();
  await expect(adapter.compact("keep decisions")).resolves.toEqual(data.compact);
  expect(sent.map(({ type }) => type)).toEqual(["get_commands", "get_available_models", "get_available_thinking_levels", "set_model", "set_thinking_level", "compact"]);
  expect(sent[3]).toMatchObject({ provider: "anthropic", modelId: "claude" });
  expect(sent[5]).toMatchObject({ customInstructions: "keep decisions" });
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
