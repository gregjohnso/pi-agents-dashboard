import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertPiExecutableIdentity, piExecutableCacheKey } from "./pi-executable.mjs";

/** @type {readonly ("get_state"|"prompt"|"follow_up"|"steer"|"abort"|"extension_ui_response")[]} */
const REQUIRED_COMMANDS = ["get_state", "prompt", "follow_up", "steer", "abort", "extension_ui_response"];

/** @param {any} child @param {number} timeoutMs @param {(finish: (error?: unknown, value?: any) => void) => void} start */
function boundedChild(child, timeoutMs, start) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(Object.assign(new Error("Pi capability probe timed out"), { code: "PI_PROBE_TIMEOUT" })), timeoutMs);
    /** @param {unknown} [error] @param {any} [value] */
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners("error");
      try { child.kill?.("SIGKILL"); } catch {}
      if (error !== undefined) reject(error); else resolve(value);
    };
    child.once("error", (/** @type {unknown} */ cause) => finish(cause));
    start(finish);
  });
}

/** @param {string} executable @param {any} spawnImpl @param {number} timeoutMs @param {NodeJS.ProcessEnv} env */
async function probeHelp(executable, spawnImpl, timeoutMs, env) {
  const child = spawnImpl(executable, ["--help"], { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  return boundedChild(child, timeoutMs, (finish) => {
    let stdout = "";
    child.stdout?.on("data", (/** @type {Buffer} */ chunk) => { stdout += chunk.toString("utf8"); });
    child.once("exit", (/** @type {number | null} */ code) => finish(code === 0 ? undefined : Object.assign(new Error("Pi --help failed"), { code: "PI_PROBE_HELP_FAILED" }), stdout));
  });
}

/** @param {string} executable @param {string} sessionFile @param {any} spawnImpl @param {number} timeoutMs @param {NodeJS.ProcessEnv} env */
async function probeRpc(executable, sessionFile, spawnImpl, timeoutMs, env) {
  const child = spawnImpl(executable, ["--mode", "rpc", "--session", sessionFile], { env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  return boundedChild(child, timeoutMs, (finish) => {
    const ids = new Map();
    const responses = new Map();
    /** @type {string[]} */
    const events = [];
    let buffer = "";
    let malformed = false;
    const commands = [
      { type: "get_state" },
      { type: "prompt" },
      { type: "follow_up" },
      { type: "steer" },
      { type: "abort" },
      { type: "extension_ui_response" },
    ].map((command) => {
      const id = randomUUID();
      ids.set(id, command.type);
      return { id, ...command };
    });
    const complete = () => {
      if (malformed) return finish(undefined, { jsonl: false, responses, events });
      if (responses.size === commands.length) finish(undefined, { jsonl: true, responses, events });
    };
    child.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { malformed = true; complete(); return; }
        if (frame?.type === "response" && typeof frame.id === "string" && ids.has(frame.id)) responses.set(ids.get(frame.id), frame);
        else if (typeof frame?.type === "string") events.push(frame.type);
      }
      complete();
    });
    child.once("exit", () => finish(undefined, { jsonl: !malformed && responses.size > 0, responses, events }));
    for (const command of commands) child.stdin?.write(`${JSON.stringify(command)}\n`);
  });
}

/**
 * Detect public Pi behavior without sending any valid inference command.
 * @param {{ executable: import("../shared/contracts.mjs").ExecutableIdentity, spawnImpl?: any, cache?: Map<string, import("../shared/contracts.mjs").PiCapabilityReport>, timeoutMs?: number, env?: NodeJS.ProcessEnv }} options
 */
export async function probePiCapabilities({ executable, spawnImpl = spawn, cache = new Map(), timeoutMs = 5_000, env = process.env }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
  await assertPiExecutableIdentity(executable);
  const key = piExecutableCacheKey(executable);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const help = /** @type {string} */ (await probeHelp(executable.realpath, spawnImpl, timeoutMs, env));
  const directory = await mkdtemp(join(tmpdir(), "pi-dashboard-probe-"));
  try {
    const rpc = await probeRpc(executable.realpath, join(directory, "non-canonical-session.jsonl"), spawnImpl, timeoutMs, env);
    const commands = REQUIRED_COMMANDS.filter((command) => {
      const response = rpc.responses.get(command);
      if (response === undefined) return false;
      if (command === "get_state") return response.success === true && typeof response.data === "object" && response.data !== null && typeof response.data.sessionId === "string" && typeof response.data.sessionFile === "string";
      if (response.success === true) return true;
      return typeof response.error === "string" && !/unknown command/iu.test(response.error);
    });
    const rpcMode = /--mode\s+rpc/iu.test(help);
    const reportedVersion = /^pi\s+(.+)$/imu.exec(help)?.[1]?.trim() ?? null;
    const missingRequired = [
      ...(!rpcMode ? ["rpcMode"] : []),
      ...(!rpc.jsonl ? ["jsonl"] : []),
      ...REQUIRED_COMMANDS.filter((command) => !commands.includes(command)),
    ];
    const report = /** @type {import("../shared/contracts.mjs").PiCapabilityReport} */ ({
      executable,
      reportedVersion,
      rpcMode,
      jsonl: rpc.jsonl,
      commands,
      events: rpc.events,
      missingRequired,
    });
    cache.set(key, report);
    return report;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
