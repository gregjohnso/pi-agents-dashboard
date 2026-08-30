import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";

const MAX_RPC_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_PRELISTENER_FRAME_BYTES = 1024 * 1024;

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

/**
 * Build the one argument list a worker launches Pi with. `installed-pi-worker.mjs` spawns it for
 * real and `PiRpcAdapter.start` reuses it, so the flag set cannot drift between the two.
 * @param {{ sessionFile: string, model?: { provider: string, id: string }, thinkingLevel?: string, name?: string }} options
 */
export function piRpcArgv({ sessionFile, model, thinkingLevel, name }) {
  const argv = ["--mode", "rpc", "--session", sessionFile];
  if (model !== undefined) argv.push("--provider", model.provider, "--model", model.id);
  if (thinkingLevel !== undefined) argv.push("--thinking", thinkingLevel);
  if (name !== undefined) argv.push("--name", name);
  return argv;
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
  #encoder;
  #decoder;
  /** @type {Map<string, PendingRequest>} */
  #pending = new Map();
  /** @type {Set<(frame: Record<string, unknown>) => void>} */
  #frameListeners = new Set();
  /** @type {Set<(event: Record<string, unknown>) => void>} */
  #eventListeners = new Set();
  /** @type {{ frame: Record<string, unknown>, bytes: number }[]} */
  #bufferedFrames = [];
  #bufferedFrameBytes = 0;
  /** @type {{ event: Record<string, unknown>, bytes: number }[]} */
  #bufferedEvents = [];
  #bufferedEventBytes = 0;
  #stderr = "";
  /** @type {PiRpcError | undefined} */
  #failed;
  #closed = false;
  #ownedProcess;
  #diagnostics;
  #diagnosticBytes = Buffer.alloc(0);

  /** @param {{ input: NodeJS.WritableStream, output: NodeJS.ReadableStream, process?: import("node:child_process").ChildProcess, ownedProcess?: boolean, diagnostics?: { append(record: Uint8Array): Promise<unknown> | unknown }, maxRecordBytes?: number }} options */
  constructor({ input, output, process: child, ownedProcess = false, diagnostics, maxRecordBytes = MAX_RPC_FRAME_BYTES }) {
    if (typeof input?.write !== "function" || typeof output?.on !== "function") {
      throw new TypeError("Pi RPC requires writable input and readable output streams");
    }
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) throw new TypeError("maxRecordBytes must be a positive integer");
    if (diagnostics !== undefined && typeof diagnostics.append !== "function") throw new TypeError("diagnostics must expose append(record)");
    this.#input = input;
    this.#output = output;
    this.#process = child;
    this.#ownedProcess = ownedProcess;
    this.#diagnostics = diagnostics;
    this.#encoder = createJsonlEncoder({ maxBytes: maxRecordBytes });
    this.#decoder = createJsonlDecoder({ maxBytes: maxRecordBytes });

    output.on("data", (chunk) => this.#consume(chunk));
    output.on("end", () => {
      if (this.#diagnosticBytes.length > 0) {
        void Promise.resolve(this.#diagnostics?.append(Buffer.from(this.#diagnosticBytes))).catch(() => {});
        this.#diagnosticBytes = Buffer.alloc(0);
      }
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
   * Start an installed Pi executable with structured arguments.
   * @param {{ executable: string, cwd: string, sessionFile: string, model?: { provider: string, id: string }, thinkingLevel?: string, name?: string, env?: NodeJS.ProcessEnv, spawnImpl?: SpawnLike }} options
   */
  static async start({ executable, cwd, sessionFile, model, thinkingLevel, name, env = process.env, spawnImpl = spawn }) {
    if (typeof executable !== "string" || typeof cwd !== "string" || typeof sessionFile !== "string") throw new TypeError("executable, cwd, and sessionFile are required");
    const child = spawnImpl(executable, piRpcArgv({ sessionFile, model, thinkingLevel, name }), {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.stdin === null || child.stdout === null) throw new PiRpcError("RPC_PROCESS_FAILED", "Pi RPC process did not expose pipes");
    return new PiRpcAdapter({ input: child.stdin, output: child.stdout, process: child, ownedProcess: true });
  }

  /**
   * Connect the adapter to one installed Pi child's owned pipes.
   * @param {{ input: NodeJS.WritableStream, output: NodeJS.ReadableStream, diagnostics?: { append(record: Uint8Array): Promise<unknown> | unknown }, maxRecordBytes?: number, process?: import("node:child_process").ChildProcess }} options
   */
  static connect({ input, output, diagnostics, maxRecordBytes, process: child }) {
    return new PiRpcAdapter({ input, output, diagnostics, maxRecordBytes, process: child });
  }

  /** @param {Uint8Array} chunk */
  #consume(chunk) {
    if (this.#failed !== undefined || this.#closed) return;
    this.#diagnosticBytes = Buffer.concat([this.#diagnosticBytes, Buffer.from(chunk)]);
    for (;;) {
      const newline = this.#diagnosticBytes.indexOf(0x0a);
      if (newline === -1) break;
      const record = this.#diagnosticBytes.subarray(0, newline + 1);
      this.#diagnosticBytes = this.#diagnosticBytes.subarray(newline + 1);
      void Promise.resolve(this.#diagnostics?.append(Buffer.from(record))).catch(() => {});
    }
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
      if (this.#frameListeners.size === 0) {
        let bytes;
        try { bytes = Buffer.byteLength(JSON.stringify(frame)); } catch { bytes = MAX_PRELISTENER_FRAME_BYTES + 1; }
        if (bytes <= MAX_PRELISTENER_FRAME_BYTES) {
          while (this.#bufferedFrameBytes + bytes > MAX_PRELISTENER_FRAME_BYTES && this.#bufferedFrames.length > 0) {
            const removed = this.#bufferedFrames.shift();
            if (removed !== undefined) this.#bufferedFrameBytes -= removed.bytes;
          }
          this.#bufferedFrames.push({ frame, bytes });
          this.#bufferedFrameBytes += bytes;
        }
      } else {
        for (const listener of this.#frameListeners) {
          try { listener(frame); } catch {}
        }
      }
      if (frame.type === "response") {
        if (typeof frame.id !== "string") {
          this.#fail(new PiRpcError("MALFORMED_RPC_OUTPUT", "Pi emitted an uncorrelated RPC response"));
          return;
        }
        const pending = this.#pending.get(frame.id);
        if (pending === undefined) {
          if (frame.command === "extension_ui_response") continue;
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
      if (this.#eventListeners.size === 0) {
        let bytes;
        try { bytes = Buffer.byteLength(JSON.stringify(frame)); } catch { bytes = MAX_PRELISTENER_FRAME_BYTES + 1; }
        if (bytes <= MAX_PRELISTENER_FRAME_BYTES) {
          while (this.#bufferedEventBytes + bytes > MAX_PRELISTENER_FRAME_BYTES && this.#bufferedEvents.length > 0) {
            const removed = this.#bufferedEvents.shift();
            if (removed !== undefined) this.#bufferedEventBytes -= removed.bytes;
          }
          this.#bufferedEvents.push({ event: frame, bytes });
          this.#bufferedEventBytes += bytes;
        }
      } else {
        for (const listener of this.#eventListeners) {
          try { listener(frame); } catch {}
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

  /** @param {string} type @param {Record<string, unknown>} [fields] */
  async #sendOneWay(type, fields = {}) {
    if (this.#closed) throw new PiRpcError("RPC_CLOSED", "Pi RPC adapter is closed");
    if (this.#failed !== undefined) throw this.#failed;
    try {
      await writeAll(this.#input, this.#encoder.encode({ id: randomUUID(), type, ...fields }));
    } catch (cause) {
      const error = new PiRpcError("RPC_WRITE_FAILED", "Pi RPC command write failed", { cause });
      this.#fail(error);
      throw error;
    }
  }

  /** @param {string} text */
  async prompt(text) { await this.#request("prompt", { message: text }); }
  /** @param {string} text */
  async steer(text) { await this.#request("steer", { message: text }); }
  /** @param {string} text */
  async followUp(text) { await this.#request("follow_up", { message: text }); }
  async abort() { await this.#request("abort"); }
  /** @param {{ requestId: string, response: unknown }} response */
  async uiResponse(response) { await this.#sendOneWay("extension_ui_response", response); }
  async getState() { return this.#request("get_state"); }
  async getCommands() { return this.#request("get_commands"); }
  async getAvailableModels() { return this.#request("get_available_models"); }
  async getAvailableThinkingLevels() { return this.#request("get_available_thinking_levels"); }
  /** @param {{ provider: string, id: string }} model */
  async setModel(model) { return this.#request("set_model", { provider: model.provider, modelId: model.id }); }
  /** @param {string} level */
  async setThinkingLevel(level) { return this.#request("set_thinking_level", { level }); }
  /** @param {string} name */
  async setSessionName(name) { return this.#request("set_session_name", { name }); }
  /** @param {string} [instructions] */
  async compact(instructions) { return this.#request("compact", instructions === undefined ? {} : { customInstructions: instructions }); }
  /** @param {boolean} enabled */
  async setAutoCompaction(enabled) { return this.#request("set_auto_compaction", { enabled }); }
  /** @param {boolean} enabled */
  async setAutoRetry(enabled) { return this.#request("set_auto_retry", { enabled }); }
  async abortRetry() { return this.#request("abort_retry"); }
  /** @param {"all"|"one-at-a-time"} mode */
  async setSteeringMode(mode) { return this.#request("set_steering_mode", { mode }); }
  /** @param {"all"|"one-at-a-time"} mode */
  async setFollowUpMode(mode) { return this.#request("set_follow_up_mode", { mode }); }

  /** @param {(frame: Record<string, unknown>) => void} listener */
  onFrame(listener) {
    if (typeof listener !== "function") throw new TypeError("RPC frame listener must be a function");
    this.#frameListeners.add(listener);
    for (const buffered of this.#bufferedFrames.splice(0)) {
      this.#bufferedFrameBytes -= buffered.bytes;
      try { listener(buffered.frame); } catch {}
    }
    return () => this.#frameListeners.delete(listener);
  }

  /** @param {(event: Record<string, unknown>) => void} listener */
  onEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("RPC event listener must be a function");
    this.#eventListeners.add(listener);
    for (const buffered of this.#bufferedEvents.splice(0)) {
      this.#bufferedEventBytes -= buffered.bytes;
      try { listener(buffered.event); } catch {}
    }
    return () => this.#eventListeners.delete(listener);
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
