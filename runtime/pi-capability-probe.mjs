import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJsonlDecoder } from "./jsonl.mjs";
import { assertPiExecutableIdentity, piExecutableCacheKey } from "./pi-executable.mjs";

const PROBE_MAX_RECORD_BYTES = 65_536;
const UNKNOWN_COMMAND = "__pi_dashboard_unknown_command__";
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
    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0;
    child.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
      bytes += chunk.byteLength;
      if (bytes > PROBE_MAX_RECORD_BYTES) return finish(Object.assign(new Error("Pi --help exceeded the probe byte limit"), { code: "PI_PROBE_HELP_FAILED" }));
      chunks.push(Buffer.from(chunk));
    });
    child.once("exit", (/** @type {number | null} */ code) => {
      if (code !== 0) return finish(Object.assign(new Error("Pi --help failed"), { code: "PI_PROBE_HELP_FAILED" }));
      try {
        finish(undefined, new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch (cause) {
        finish(Object.assign(new Error("Pi --help was not valid UTF-8", { cause }), { code: "PI_PROBE_HELP_FAILED" }));
      }
    });
  });
}

/** @param {string} executable @param {string} sessionFile @param {any} spawnImpl @param {number} timeoutMs @param {NodeJS.ProcessEnv} env */
async function probeRpc(executable, sessionFile, spawnImpl, timeoutMs, env) {
  const child = spawnImpl(executable, ["--mode", "rpc", "--session", sessionFile], { env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  return boundedChild(child, timeoutMs, (finish) => {
    const decoder = createJsonlDecoder({ maxBytes: PROBE_MAX_RECORD_BYTES });
    const ids = new Map();
    const responses = new Map();
    /** @type {string[]} */
    const events = [];
    let responseCount = 0;
    let correlationValid = true;
    let framingValid = true;
    const commands = [
      { type: "get_state" },
      { type: "prompt" },
      { type: "follow_up" },
      { type: "steer" },
      { type: "abort" },
      { type: "extension_ui_response" },
      { type: UNKNOWN_COMMAND },
    ].map((command) => {
      const id = randomUUID();
      ids.set(id, command.type);
      return { id, ...command };
    });
    const result = () => ({ jsonl: framingValid && responseCount > 0, correlationValid, responses, events });
    child.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        framingValid = false;
        finish(undefined, result());
        return;
      }
      for (const frame of frames) {
        const candidate = /** @type {any} */ (frame);
        if (candidate?.type === "response") {
          responseCount += 1;
          const expectedCommand = typeof candidate.id === "string" ? ids.get(candidate.id) : undefined;
          if (expectedCommand === undefined || candidate.command !== expectedCommand || responses.has(expectedCommand)) {
            correlationValid = false;
          } else {
            responses.set(expectedCommand, candidate);
          }
        } else if (typeof candidate?.type === "string") {
          events.push(candidate.type);
        }
      }
      if (responseCount >= commands.length) finish(undefined, result());
    });
    child.once("exit", () => {
      try { decoder.end(); } catch { framingValid = false; }
      finish(undefined, result());
    });
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
    const temporarySessionFile = join(directory, "non-canonical-session.jsonl");
    const rpc = await probeRpc(executable.realpath, temporarySessionFile, spawnImpl, timeoutMs, env);
    const commands = REQUIRED_COMMANDS.filter((command) => {
      const response = rpc.responses.get(command);
      if (response === undefined) return false;
      if (command === "get_state") return response.success === true && typeof response.data === "object" && response.data !== null && typeof response.data.sessionId === "string" && response.data.sessionFile === temporarySessionFile;
      if (command === "abort") return response.success === true;
      return response.success === false && typeof response.error === "string" && response.error.length > 0 && !/unknown command/iu.test(response.error);
    });
    const unknownResponse = rpc.responses.get(UNKNOWN_COMMAND);
    const unknownCommandValid = unknownResponse?.success === false && typeof unknownResponse.error === "string" && /unknown command/iu.test(unknownResponse.error);
    const temporarySessionValid = commands.includes("get_state");
    const rpcMode = /--mode\s+rpc/iu.test(help);
    const reportedVersion = /^pi\s+(.+)$/imu.exec(help)?.[1]?.trim() ?? null;
    const missingRequired = [
      ...(!rpcMode ? ["rpcMode"] : []),
      ...(!rpc.jsonl ? ["jsonl"] : []),
      ...(!rpc.correlationValid ? ["response_correlation"] : []),
      ...(!unknownCommandValid ? ["unknown_command_validation"] : []),
      ...(!temporarySessionValid ? ["temporary_session_isolation"] : []),
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
