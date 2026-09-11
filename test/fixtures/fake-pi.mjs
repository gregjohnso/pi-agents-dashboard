#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const logPath = process.env.FAKE_PI_LOG;
const missing = new Set((process.env.FAKE_PI_MISSING ?? "").split(",").filter(Boolean));
// Pi refuses a `prompt` sent during a run unless the caller names `streamingBehavior`, and queues it
// as a steer or a follow-up when it does. FAKE_PI_STREAMING models that state machine: "active"
// starts with a run already going, "on_prompt" starts idle and begins one on the first accepted
// prompt. Unset, this fake accepts every prompt exactly as it always has.
const streamingMode = process.env.FAKE_PI_STREAMING;
let streaming = streamingMode === "active";
// Pi reports thinking levels per model and refuses to be driven outside the set it reported, so a
// dashboard that offers a level this list does not carry fails here rather than silently drifting.
const thinkingLevels = (process.env.FAKE_PI_THINKING_LEVELS ?? "off,low,high").split(",").filter(Boolean);
let thinkingLevel = thinkingLevels[0] ?? "off";
const log = (entry) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`, { mode: 0o600 });
};

log({
  kind: "start",
  argv: process.argv.slice(2),
  providerInvocation: false,
  workerTokenPresent: Object.hasOwn(process.env, "PI_AGENTS_WORKER_TOKEN"),
  boundaryMarker: process.env.PI_AGENTS_BOUNDARY_MARKER,
});
if (process.argv.includes("--version")) {
  process.stdout.write(process.env.FAKE_PI_VERSION_OUTPUT ?? `${process.env.FAKE_PI_VERSION ?? "1.0.0"}\n`);
  process.exit(Number(process.env.FAKE_PI_VERSION_EXIT ?? "0"));
}

const sessionIndex = process.argv.indexOf("--session");
const sessionFile = sessionIndex === -1 ? undefined : process.argv[sessionIndex + 1];
if (process.argv[0] === undefined || process.argv[2] !== "--mode" || process.argv[3] !== "rpc" || sessionFile === undefined) {
  log({ kind: "invalid_launch" });
  process.exit(2);
}
writeFileSync(sessionFile, `${JSON.stringify({ type: "session", pid: process.pid })}\n`, { flag: "a", mode: 0o600 });
if (process.env.FAKE_PI_MALFORMED === "1" || process.env.FAKE_PI_MALFORMED_SESSION === sessionFile) {
  process.stdout.write("{malformed}\n");
} else if (process.env.FAKE_PI_INVALID_UTF8 === "1") {
  process.stdout.write(Buffer.from([...Buffer.from('{"type":"probe_event","value":"'), 0xff, ...Buffer.from('"}\n')]));
} else if (process.env.FAKE_PI_OVERSIZED_FRAME === "1") {
  process.stdout.write(`${JSON.stringify({ type: "probe_event", value: "x".repeat(70_000) })}\n`);
} else if (process.env.FAKE_PI_EVENT) {
  process.stdout.write(`${JSON.stringify({ type: process.env.FAKE_PI_EVENT })}\n`);
}

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline === -1) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    let command;
    try { command = JSON.parse(line); } catch { continue; }
    const type = command.type;
    const responseId = process.env.FAKE_PI_WRONG_RESPONSE_ID === type ? `wrong-${command.id}` : command.id;
    const validPrompt = ["prompt", "follow_up", "steer"].includes(type) && typeof command.message === "string";
    log({ kind: "command", command: type, message: validPrompt ? command.message : undefined, valid: validPrompt, providerInvocation: validPrompt, streamingBehavior: validPrompt ? command.streamingBehavior : undefined });
    if (type === "extension_ui_response" && process.env.FAKE_PI_DELAYED_UNKNOWN_EXTENSION_UI_RESPONSE_MS) {
      setTimeout(() => process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: false, error: "unknown command" })}\n`), Number(process.env.FAKE_PI_DELAYED_UNKNOWN_EXTENSION_UI_RESPONSE_MS));
      continue;
    }
    if (type === "__pi_agents_unknown_command__") {
      process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: process.env.FAKE_PI_UNKNOWN_SUCCESS === "1", error: process.env.FAKE_PI_UNKNOWN_SUCCESS === "1" ? undefined : "unknown command" })}\n`);
      continue;
    }
    if (missing.has(type)) {
      process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: false, error: "unknown command" })}\n`);
      continue;
    }
    if (type === "get_state") {
      const reportedSessionFile = process.env.FAKE_PI_RUNTIME_STATE_SESSION_PATH !== undefined && !sessionFile.includes("pi-agents-probe-")
        ? process.env.FAKE_PI_RUNTIME_STATE_SESSION_PATH
        : process.env.FAKE_PI_STATE_SESSION_PATH ?? sessionFile;
      process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: true, data: { sessionId: "fake", sessionFile: reportedSessionFile, model: null, thinkingLevel } })}\n`);
      continue;
    }
    if (type === "get_available_thinking_levels") {
      process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: true, data: { levels: thinkingLevels } })}\n`);
      continue;
    }
    if (type === "set_thinking_level") {
      if (!thinkingLevels.includes(command.level)) {
        process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: false, error: `unknown thinking level: ${command.level}` })}\n`);
        continue;
      }
      const changed = thinkingLevel !== command.level;
      thinkingLevel = command.level;
      process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: true })}\n`);
      // Pi publishes the level it settled on, and only when it moved.
      if (changed) process.stdout.write(`${JSON.stringify({ type: "thinking_level_changed", level: thinkingLevel })}\n`);
      continue;
    }
    if (["prompt", "follow_up", "steer"].includes(type) && typeof command.message !== "string") {
      process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: false, error: "message is required" })}\n`);
      continue;
    }
    if (streamingMode !== undefined && validPrompt) {
      if (type === "prompt" && streaming && command.streamingBehavior === undefined) {
        process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." })}\n`);
        continue;
      }
      if (type === "prompt") streaming = true;
    }
    if (type === "extension_ui_response" && process.env.FAKE_PI_ONE_WAY_EXTENSION_UI_RESPONSE === "1") continue;
    if (type === "extension_ui_response" && typeof command.requestId !== "string") {
      process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: false, error: "requestId is required" })}\n`);
      continue;
    }
    process.stdout.write(`${JSON.stringify({ id: responseId, type: "response", command: type, success: true })}\n`);
    if (process.env.FAKE_PI_EVENT_AFTER_COMMAND === type) {
      process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `later:${sessionFile}` }], timestamp: Date.now() } })}\n`);
    }
    if (process.env.FAKE_PI_EXIT_AFTER_COMMAND === type) process.exit(7);
  }
});

// A session that streams without being prompted, so a measurement can hold one session's viewer
// ingest busy while an operator attaches to or detaches from that same session.
const streamMs = Number(process.env.FAKE_PI_STREAM_MS);
if (Number.isSafeInteger(streamMs) && streamMs > 0) {
  setInterval(() => process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `stream:${sessionFile}` }], timestamp: Date.now() } })}\n`), streamMs).unref?.();
}

const exitMs = Number(process.env.FAKE_PI_EXIT_MS);
if (Number.isSafeInteger(exitMs) && exitMs > 0) setTimeout(() => process.exit(0), exitMs);
