#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const logPath = process.env.FAKE_PI_LOG;
const missing = new Set((process.env.FAKE_PI_MISSING ?? "").split(",").filter(Boolean));
const log = (entry) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`, { mode: 0o600 });
};

log({ kind: "start", argv: process.argv.slice(2), providerInvocation: false });
if (process.argv.includes("--help")) {
  process.stdout.write(`pi ${process.env.FAKE_PI_VERSION ?? "1.0.0"}\n--mode rpc\n`);
  process.exit(0);
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
    const validPrompt = ["prompt", "follow_up", "steer"].includes(type) && typeof command.message === "string";
    log({ kind: "command", command: type, valid: validPrompt, providerInvocation: validPrompt });
    if (missing.has(type)) {
      process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: type, success: false, error: "unknown command" })}\n`);
      continue;
    }
    if (type === "get_state") {
      process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: type, success: true, data: { sessionId: "fake", sessionFile, model: null, thinkingLevel: "off" } })}\n`);
      continue;
    }
    if (["prompt", "follow_up", "steer"].includes(type) && typeof command.message !== "string") {
      process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: type, success: false, error: "message is required" })}\n`);
      continue;
    }
    if (type === "extension_ui_response" && typeof command.requestId !== "string") {
      process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: type, success: false, error: "requestId is required" })}\n`);
      continue;
    }
    process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: type, success: true })}\n`);
    if (process.env.FAKE_PI_EXIT_AFTER_COMMAND === type) process.exit(7);
  }
});

const exitMs = Number(process.env.FAKE_PI_EXIT_MS);
if (Number.isSafeInteger(exitMs) && exitMs > 0) setTimeout(() => process.exit(0), exitMs);
