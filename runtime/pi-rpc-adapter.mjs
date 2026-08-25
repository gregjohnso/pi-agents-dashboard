import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";

const MAX_RPC_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const PUBLIC_RPC_ENTRY = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));

/** @typedef {(command: string, argv: string[], options: any) => any} SpawnLike */
/** @typedef {{ command: string, resolve(value: unknown): void, reject(error: unknown): void }} PendingRequest */

/** A typed failure at the documented Pi JSONL boundary. */
export class PiRpcError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown, acknowledged?: boolean }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "PiRpcError";
    this.code = code;
    this.acknowledged = options?.acknowledged === true;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} response @param {string} expectedId @param {string} command */
function validateResponse(response, expectedId, command) {
  if (!isRecord(response) || response.type !== "response" || response.id !== expectedId || response.command !== command || typeof response.success !== "boolean") {
    throw new PiRpcError("INVALID_RPC_RESPONSE", `Pi returned an invalid ${command} response`);
  }
  if (!response.success) {
    if (typeof response.error !== "string") {
      throw new PiRpcError("INVALID_RPC_RESPONSE", `Pi returned an invalid ${command} error response`);
    }
    throw new PiRpcError("RPC_COMMAND_FAILED", response.error, { acknowledged: true });
  }
  return response.data;
}

/** @param {NodeJS.WritableStream} stream @param {Uint8Array} bytes */
async function writeAll(stream, bytes) {
  await new Promise((resolve, reject) => {
    stream.write(bytes, (error) => error ? reject(error) : resolve(undefined));
  });
}

/** The narrow documented Pi RPC command adapter used by one worker. */
export class PiRpcAdapter {
  #input;
  #output;
  #process;
  #encoder = createJsonlEncoder({ maxBytes: MAX_RPC_FRAME_BYTES });
  #decoder = createJsonlDecoder({ maxBytes: MAX_RPC_FRAME_BYTES });
  /** @type {Map<string, PendingRequest>} */
  #pending = new Map();
  /** @type {Set<(event: Record<string, unknown>) => void>} */
  #listeners = new Set();
  #stderr = "";
  /** @type {PiRpcError | undefined} */
  #failed;
  #closed = false;
  #ownedProcess;

  /** @param {{ input: NodeJS.WritableStream, output: NodeJS.ReadableStream, process?: import("node:child_process").ChildProcess, ownedProcess?: boolean }} options */
  constructor({ input, output, process: child, ownedProcess = false }) {
    if (typeof input?.write !== "function" || typeof output?.on !== "function") {
      throw new TypeError("Pi RPC requires writable input and readable output streams");
    }
    this.#input = input;
    this.#output = output;
    this.#process = child;
    this.#ownedProcess = ownedProcess;

    output.on("data", (chunk) => this.#consume(chunk));
    output.on("end", () => {
      try {
        this.#decoder.end();
        this.#fail(new PiRpcError("RPC_STREAM_CLOSED", "Pi RPC output closed"));
      } catch (cause) {
        this.#fail(new PiRpcError("MALFORMED_RPC_OUTPUT", "Pi RPC output ended with an incomplete frame", { cause }));
      }
    });
    output.on("error", (cause) => this.#fail(new PiRpcError("RPC_STREAM_FAILED", "Pi RPC output failed", { cause })));
    child?.stderr?.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    child?.on("error", (cause) => this.#fail(new PiRpcError("RPC_PROCESS_FAILED", "Pi RPC process failed", { cause })));
    child?.on("exit", (code, signal) => {
      if (!this.#closed) this.#fail(new PiRpcError("RPC_PROCESS_EXITED", `Pi RPC process exited (${code ?? signal ?? "unknown"})`));
    });
  }

  /**
   * Start the documented public Pi RPC entry with structured arguments.
   * @param {{ cwd: string, sessionFile: string, model?: { provider: string, id: string }, thinkingLevel?: string, name?: string, env?: NodeJS.ProcessEnv, rpcEntry?: string, spawnImpl?: SpawnLike }} options
   */
  static async start({ cwd, sessionFile, model, thinkingLevel, name, env = process.env, rpcEntry = PUBLIC_RPC_ENTRY, spawnImpl = spawn }) {
    if (typeof cwd !== "string" || typeof sessionFile !== "string") throw new TypeError("cwd and sessionFile are required");
    const argv = [rpcEntry, "--session", sessionFile];
    if (model !== undefined) argv.push("--provider", model.provider, "--model", model.id);
    if (thinkingLevel !== undefined) argv.push("--thinking", thinkingLevel);
    if (name !== undefined) argv.push("--name", name);
    const child = spawnImpl(process.execPath, argv, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.stdin === null || child.stdout === null) throw new PiRpcError("RPC_PROCESS_FAILED", "Pi RPC process did not expose pipes");
    return new PiRpcAdapter({ input: child.stdin, output: child.stdout, process: child, ownedProcess: true });
  }

  /** Connect the adapter to an already-gated public RPC entry in this worker process. */
  /** @param {{ input: NodeJS.WritableStream, output: NodeJS.ReadableStream }} options */
  static connect({ input, output }) {
    return new PiRpcAdapter({ input, output });
  }

  /** @param {Uint8Array} chunk */
  #consume(chunk) {
    if (this.#failed !== undefined || this.#closed) return;
    let frames;
    try {
      frames = this.#decoder.push(chunk);
    } catch (cause) {
      this.#fail(new PiRpcError("MALFORMED_RPC_OUTPUT", "Pi emitted malformed RPC output", { cause }));
      return;
    }
    for (const frame of frames) {
      if (!isRecord(frame) || typeof frame.type !== "string") {
        this.#fail(new PiRpcError("MALFORMED_RPC_OUTPUT", "Pi emitted an invalid RPC frame"));
        return;
      }
      if (frame.type === "response") {
        if (typeof frame.id !== "string") {
          this.#fail(new PiRpcError("MALFORMED_RPC_OUTPUT", "Pi emitted an uncorrelated RPC response"));
          return;
        }
        const pending = this.#pending.get(frame.id);
        if (pending === undefined) {
          this.#fail(new PiRpcError("MALFORMED_RPC_OUTPUT", "Pi emitted an unknown RPC response"));
          return;
        }
        this.#pending.delete(frame.id);
        try {
          pending.resolve(validateResponse(frame, frame.id, pending.command));
        } catch (error) {
          pending.reject(error);
          if (error instanceof PiRpcError && error.code === "INVALID_RPC_RESPONSE") this.#fail(error);
        }
        continue;
      }
      for (const listener of this.#listeners) {
        try {
          listener(frame);
        } catch {
          // Listener failures do not own the RPC stream.
        }
      }
    }
  }

  /** @param {PiRpcError} error */
  #fail(error) {
    if (this.#failed !== undefined || this.#closed) return;
    this.#failed = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  /** @param {string} type @param {Record<string, unknown>} [fields] */
  async #request(type, fields = {}) {
    if (this.#closed) throw new PiRpcError("RPC_CLOSED", "Pi RPC adapter is closed");
    if (this.#failed !== undefined) throw this.#failed;
    const id = randomUUID();
    const result = new Promise((resolve, reject) => this.#pending.set(id, { command: type, resolve, reject }));
    try {
      await writeAll(this.#input, this.#encoder.encode({ id, type, ...fields }));
    } catch (cause) {
      this.#pending.delete(id);
      const error = new PiRpcError("RPC_WRITE_FAILED", "Pi RPC command write failed", { cause });
      this.#fail(error);
      throw error;
    }
    return result;
  }

  /** @param {string} text */
  async prompt(text) { await this.#request("prompt", { message: text }); }
  /** @param {string} text */
  async steer(text) { await this.#request("steer", { message: text }); }
  /** @param {string} text */
  async followUp(text) { await this.#request("follow_up", { message: text }); }
  async abort() { await this.#request("abort"); }
  async getState() { return this.#request("get_state"); }

  /** @param {(event: Record<string, unknown>) => void} listener */
  onEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("RPC event listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getStderr() { return this.#stderr; }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const error = new PiRpcError("RPC_CLOSED", "Pi RPC adapter is closed");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (this.#ownedProcess && typeof this.#input.end === "function") this.#input.end();
  }
}
