import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OwnershipManager } from "./ownership.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "./process-signaler.mjs";
import { registryCoordinationScope } from "./registry-store.mjs";
import { SessionCoordinator } from "./session-coordinator.mjs";
import { reduceSessionState } from "./state-reducer.mjs";

const DEFAULT_WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const DEFAULT_RPC_ENTRY = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
const admissionStates = new WeakMap();
const DEFAULT_LAUNCH_STOP_POLICY = Object.freeze({ gracefulMs: 5_000, terminateMs: 5_000 });

/** @typedef {(command: string, argv: string[], options: any) => any} SpawnLike */

/** @typedef {import("../shared/contracts.js").ProcessIdentity} ProcessIdentity */
/**
 * @typedef {object} WorkerHello
 * @property {1} version
 * @property {"worker_hello"} type
 * @property {string} token
 * @property {string} sessionId
 * @property {string} runId
 * @property {string} leaseId
 * @property {number} generation
 * @property {ProcessIdentity} worker
 * @property {ProcessIdentity} piChild
 */

/** A stable worker admission or handshake failure. */
export class WorkerSupervisorError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "WorkerSupervisorError";
    this.code = code;
  }
}

/** @param {unknown} value */
function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : "", "utf8").digest();
}

/** @param {unknown} supplied @param {string} expected */
function authenticated(supplied, expected) {
  return typeof supplied === "string" && timingSafeEqual(digest(supplied), digest(expected));
}

/** @param {unknown} a @param {unknown} b */
function sameIdentity(a, b) {
  const first = /** @type {Partial<ProcessIdentity>} */ (a);
  const second = /** @type {Partial<ProcessIdentity>} */ (b);
  return typeof a === "object" && a !== null && typeof b === "object" && b !== null &&
    first.pid === second.pid && first.startIdentity === second.startIdentity && first.processGroupId === second.processGroupId;
}

/** @param {any} child @returns {{ promise: Promise<{ code: number | null, signal: NodeJS.Signals | null }>, terminal: boolean }} */
function observeExit(child) {
  const observation = { terminal: false, promise: /** @type {any} */ (undefined) };
  observation.promise = new Promise((resolveExit) => {
    child.once("exit", (/** @type {number | null} */ code, /** @type {NodeJS.Signals | null} */ signal) => {
      observation.terminal = true;
      resolveExit({ code, signal });
    });
  });
  return observation;
}

/** @param {any} child @param {string} type @param {number} timeoutMs @returns {Promise<any>} */
function waitForMessage(child, type, timeoutMs) {
  return new Promise((resolveMessage, rejectMessage) => {
    const timer = setTimeout(() => finish(new WorkerSupervisorError("WORKER_START_TIMEOUT", `Timed out waiting for ${type}`)), timeoutMs);
    /** @param {any} message */
    const onMessage = (message) => {
      if (message?.type === type) finish(undefined, message);
    };
    /** @param {unknown} cause */
    const onError = (cause) => finish(new WorkerSupervisorError("WORKER_PROCESS_FAILED", "Worker process failed", { cause }));
    /** @param {number | null} code @param {NodeJS.Signals | null} signal */
    const onExit = (code, signal) => finish(new WorkerSupervisorError("WORKER_PROCESS_EXITED", `Worker exited before ${type} (${code ?? signal ?? "unknown"})`));
    /** @param {unknown} [error] @param {any} [message] */
    const finish = (error, message) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error !== undefined) rejectMessage(error);
      else resolveMessage(message);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

/** @param {any} child @param {any} message */
async function sendMessage(child, message) {
  if (typeof child.send !== "function" || child.connected === false) throw new WorkerSupervisorError("WORKER_CHANNEL_CLOSED", "Worker IPC channel is closed");
  await new Promise((resolveSend, rejectSend) => {
    child.send(message, (/** @type {Error | null} */ error) => error ? rejectSend(error) : resolveSend(undefined));
  });
}

/** @param {object} scope */
function admissionState(scope) {
  let state = admissionStates.get(scope);
  if (state === undefined) {
    state = { tail: Promise.resolve(), reservations: new Map(), sessions: new SessionCoordinator() };
    admissionStates.set(scope, state);
  }
  return state;
}

/** @template T @param {{ tail: Promise<void> }} state @param {() => Promise<T>} action */
function underAdmissionLock(state, action) {
  const result = state.tail.then(action);
  state.tail = result.then(() => {}, () => {});
  return result;
}

/** Supervise authenticated detached workers without coupling them to daemon lifetime. */
export class WorkerSupervisor {
  #registry;
  #ownership;
  #runsDirectory;
  #maxLive;
  #spawn;
  #inspect;
  #workerPath;
  #rpcEntry;
  #env;
  #randomId;
  #startTimeoutMs;
  #launchStopPolicy;
  #signalProcessGroup;
  #sleep;
  #admission;
  #handles = new Set();
  #supervisions = new Set();

  /**
   * @param {{ registry: import("./registry-store.mjs").RegistryStore, ownership?: OwnershipManager, runsDirectory: string, maxLive?: number | null, spawnImpl?: SpawnLike, inspect?: typeof inspectProcessIdentity, workerPath?: string, rpcEntry?: string, env?: NodeJS.ProcessEnv, randomId?: () => string, startTimeoutMs?: number, launchStopPolicy?: { gracefulMs: number, terminateMs: number }, signalProcessGroupImpl?: typeof signalProcessGroup, sleepImpl?: typeof sleep }} options
   */
  constructor({ registry, ownership = new OwnershipManager(registry), runsDirectory, maxLive = null, spawnImpl = spawn, inspect = inspectProcessIdentity, workerPath = DEFAULT_WORKER_PATH, rpcEntry = DEFAULT_RPC_ENTRY, env = process.env, randomId = randomUUID, startTimeoutMs = 15_000, launchStopPolicy = DEFAULT_LAUNCH_STOP_POLICY, signalProcessGroupImpl = signalProcessGroup, sleepImpl = sleep }) {
    if (maxLive !== null && (!Number.isSafeInteger(maxLive) || maxLive <= 0)) throw new TypeError("maxLive must be null or a positive integer");
    if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs <= 0) throw new TypeError("startTimeoutMs must be a positive integer");
    if (!Number.isSafeInteger(launchStopPolicy?.gracefulMs) || launchStopPolicy.gracefulMs <= 0 || !Number.isSafeInteger(launchStopPolicy?.terminateMs) || launchStopPolicy.terminateMs <= 0) throw new TypeError("launchStopPolicy must contain positive integer delays");
    if (typeof signalProcessGroupImpl !== "function" || typeof sleepImpl !== "function") throw new TypeError("Launch stop dependencies must be functions");
    if (typeof runsDirectory !== "string" || resolve(runsDirectory) !== runsDirectory) throw new TypeError("runsDirectory must be an absolute canonical path");
    this.#registry = registry;
    this.#ownership = ownership;
    this.#runsDirectory = runsDirectory;
    this.#maxLive = maxLive;
    this.#spawn = spawnImpl;
    this.#inspect = inspect;
    this.#workerPath = workerPath;
    this.#rpcEntry = rpcEntry;
    this.#env = { ...env };
    this.#randomId = randomId;
    this.#startTimeoutMs = startTimeoutMs;
    this.#launchStopPolicy = launchStopPolicy;
    this.#signalProcessGroup = signalProcessGroupImpl;
    this.#sleep = sleepImpl;
    this.#admission = admissionState(registryCoordinationScope(registry));
  }

  /** @param {string} sessionId */
  async #reserve(sessionId) {
    const reservation = Symbol(sessionId);
    await Promise.all([...this.#supervisions]
      .filter((supervision) => supervision.exit.terminal)
      .map((supervision) => this.#reconcileTerminal(supervision)));
    await underAdmissionLock(this.#admission, async () => {
      const live = new Set((await this.#registry.list()).filter((record) => record.processState === "LIVE" || record.ownership !== undefined).map((record) => record.sessionId));
      for (const pendingSessionId of this.#admission.reservations.values()) live.add(pendingSessionId);
      if (this.#maxLive !== null && !live.has(sessionId) && live.size >= this.#maxLive) {
        throw new WorkerSupervisorError("WORKER_CAP_REACHED", `Worker cap ${this.#maxLive} is reached`);
      }
      this.#admission.reservations.set(reservation, sessionId);
    });
    return reservation;
  }

  /** @param {symbol | undefined} reservation */
  async #unreserve(reservation) {
    if (reservation === undefined) return;
    await underAdmissionLock(this.#admission, async () => { this.#admission.reservations.delete(reservation); });
  }

  /** @param {any} supervision @param {boolean} [verifiedTerminal] */
  async #reconcileTerminal(supervision, verifiedTerminal = false) {
    if ((!supervision.exit.terminal && !verifiedTerminal)) return;
    if (supervision.reconcilePromise !== undefined) return supervision.reconcilePromise;
    supervision.reconcilePromise = (async () => {
      supervision.handle?.terminal();
      if (supervision.handle !== undefined) this.#handles.delete(supervision.handle);
      try {
        await this.#ownership.release(supervision.sessionId, supervision.lease.leaseId, supervision.lease.generation);
        this.#supervisions.delete(supervision);
      } catch (error) {
        supervision.reconcilePromise = undefined;
        throw error;
      }
    })();
    return supervision.reconcilePromise;
  }

  /** @param {any} supervision */
  async #stopFailedLaunch(supervision) {
    if (supervision.exit.terminal) {
      await this.#reconcileTerminal(supervision);
      return;
    }
    if (supervision.identity === undefined) {
      await sendMessage(supervision.child, { version: 1, type: "reject" }).catch(() => {});
      supervision.child.disconnect?.();
      return;
    }
    const inspect = async (/** @type {number} */ pid) => {
      if (supervision.exit.terminal) throw Object.assign(new Error("Worker exited"), { code: "ENOENT" });
      return this.#inspect(pid);
    };
    const result = await stopVerifiedProcessGroup(supervision.identity, {
      inspect,
      requestGraceful: async () => {
        await sendMessage(supervision.child, { version: 1, type: "shutdown", token: supervision.token }).catch(() => {});
      },
      signalProcessGroup: this.#signalProcessGroup,
      sleep: this.#sleep,
    }, this.#launchStopPolicy).catch(() => ({ disposition: "AMBIGUOUS_IDENTITY" }));
    if (["ALREADY_EXITED", "GRACEFUL", "TERMINATED", "STALE_IDENTITY"].includes(result.disposition)) {
      await this.#reconcileTerminal(supervision, true);
    }
  }

  /**
   * Launch one session worker. Same-session launches serialize; different sessions overlap after admission.
   * @param {{ sessionId: string, canonicalSessionFile: string, cwd: string, runId: string, sessionRecord?: import("../shared/contracts.js").SessionRecord, model?: { provider: string, id: string }, thinkingLevel?: string, name?: string, rpcEntry?: string, daemonConnector?: string, daemonConnectConfig?: Record<string, unknown>, reconnectDelaysMs?: number[] }} request
   */
  launch(request) {
    if (typeof request?.sessionId !== "string" || request.sessionId.length === 0) return Promise.reject(new TypeError("sessionId is required"));
    return this.#admission.sessions.run(request.sessionId, () => this.#launch(request));
  }

  /** @param {{ sessionId: string, canonicalSessionFile: string, cwd: string, runId: string, sessionRecord?: import("../shared/contracts.js").SessionRecord, model?: { provider: string, id: string }, thinkingLevel?: string, name?: string, rpcEntry?: string, daemonConnector?: string, daemonConnectConfig?: Record<string, unknown>, reconnectDelaysMs?: number[] }} request */
  async #launch({ sessionId, canonicalSessionFile, cwd, runId, sessionRecord, model, thinkingLevel, name, rpcEntry = this.#rpcEntry, daemonConnector, daemonConnectConfig = {}, reconnectDelaysMs = [100, 250, 500, 1_000, 2_000] }) {
    if ([canonicalSessionFile, cwd, runId, rpcEntry].some((value) => typeof value !== "string" || value.length === 0)) throw new TypeError("Worker launch fields must be non-empty strings");
    let record = await this.#registry.get(sessionId);
    if (record === undefined) {
      if (sessionRecord === undefined) throw new Error(`Unknown registry session: ${sessionId}`);
      await this.#registry.create(sessionRecord);
      record = await this.#registry.get(sessionId);
    }
    if (record?.canonicalSessionFile !== canonicalSessionFile) throw Object.assign(new Error("Worker launch requires the canonical registry session file"), { code: "CANONICAL_SESSION_MISMATCH" });

    let reservation;
    let lease;
    let child;
    /** @type {any} */
    let supervision;
    let stdoutHandle;
    let stderrHandle;
    try {
      reservation = await this.#reserve(sessionId);
      lease = await this.#ownership.acquire(sessionId, canonicalSessionFile, runId);
      const token = this.#randomId();
      if (typeof token !== "string" || token.length === 0) throw new TypeError("Worker token generator must return a non-empty string");
      const runDirectory = join(this.#runsDirectory, createHash("sha256").update(`${runId}\0${token}`).digest("hex"));
      await mkdir(runDirectory, { mode: 0o700 });
      stdoutHandle = await open(join(runDirectory, "worker.stdout.log"), "wx", 0o600);
      stderrHandle = await open(join(runDirectory, "worker.stderr.log"), "wx", 0o600);
      const replayPath = join(runDirectory, "worker-replay.jsonl");
      const argv = [
        this.#workerPath,
        "--session-id", sessionId,
        "--canonical-session-file", canonicalSessionFile,
        "--cwd", cwd,
        "--run-id", runId,
        "--lease-id", lease.leaseId,
        "--generation", String(lease.generation),
        "--replay-path", replayPath,
        "--rpc-entry", rpcEntry,
      ];
      if (model !== undefined) argv.push("--model-provider", model.provider, "--model-id", model.id);
      if (thinkingLevel !== undefined) argv.push("--thinking-level", thinkingLevel);
      if (name !== undefined) argv.push("--name", name);
      if (daemonConnector !== undefined) {
        if (typeof daemonConnector !== "string" || daemonConnector.length === 0) throw new TypeError("daemonConnector must be a non-empty string");
        if (typeof daemonConnectConfig !== "object" || daemonConnectConfig === null || Array.isArray(daemonConnectConfig)) throw new TypeError("daemonConnectConfig must be an object");
        if (!Array.isArray(reconnectDelaysMs) || reconnectDelaysMs.length === 0 || reconnectDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay <= 0)) throw new TypeError("reconnectDelaysMs must contain positive integers");
        argv.push(
          "--daemon-connector", daemonConnector,
          "--daemon-connect-config", JSON.stringify(daemonConnectConfig),
          "--reconnect-delays-ms", JSON.stringify(reconnectDelaysMs),
        );
      }
      child = this.#spawn(process.execPath, argv, {
        cwd,
        env: { ...this.#env, PI_DASHBOARD_WORKER_TOKEN: token },
        detached: true,
        shell: false,
        stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd, "ipc"],
      });
      const exit = observeExit(child);
      supervision = { child, token, sessionId, lease, exit, identity: undefined, handle: undefined, reconcilePromise: undefined };
      this.#supervisions.add(supervision);
      void exit.promise.then(() => this.#reconcileTerminal(supervision)).catch(() => {});
      const helloPromise = waitForMessage(child, "worker_hello", this.#startTimeoutMs);
      await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
      stdoutHandle = undefined;
      stderrHandle = undefined;

      const hello = /** @type {WorkerHello} */ (await helloPromise);
      const childPid = child.pid;
      if (!Number.isSafeInteger(childPid) || /** @type {number} */ (childPid) <= 0) throw new WorkerSupervisorError("WORKER_IDENTITY_MISMATCH", "Spawned worker did not expose a valid PID");
      const inspected = await this.#inspect(/** @type {number} */ (childPid));
      supervision.identity = inspected;
      if (!authenticated(hello.token, token)) throw new WorkerSupervisorError("WORKER_AUTH_FAILED", "Worker hello authentication failed");
      if (hello.version !== 1 || hello.sessionId !== sessionId || hello.runId !== runId || hello.leaseId !== lease.leaseId || hello.generation !== lease.generation) {
        throw new WorkerSupervisorError("WORKER_HELLO_MISMATCH", "Worker hello did not match the ownership lease");
      }
      if (!sameIdentity(hello.worker, inspected) || !sameIdentity(hello.piChild, inspected) || inspected.pid !== childPid || inspected.processGroupId !== childPid) {
        throw new WorkerSupervisorError("WORKER_IDENTITY_MISMATCH", "Worker PID, start identity, or process group did not match");
      }

      await this.#ownership.bindProcesses(sessionId, lease.leaseId, lease.generation, inspected, inspected);
      if (supervision.exit.terminal) throw new WorkerSupervisorError("WORKER_PROCESS_EXITED", "Worker exited after ownership binding");
      const readyPromise = waitForMessage(child, "worker_ready", this.#startTimeoutMs);
      void readyPromise.catch(() => {});
      await sendMessage(child, { version: 1, type: "activate", token, leaseId: lease.leaseId, generation: lease.generation });
      const ready = await readyPromise;
      if (!authenticated(ready.token, token) || ready.sessionId !== sessionId || ready.runId !== runId) {
        throw new WorkerSupervisorError("WORKER_READY_MISMATCH", "Worker readiness did not match the authenticated launch");
      }

      await this.#writeWorkerEvent(sessionId, { type: "WORKER_READY", at: new Date().toISOString() });
      const handle = this.#createHandle({ child, token, sessionId, runId, lease, identity: inspected });
      supervision.handle = handle;
      this.#handles.add(handle);
      if (supervision.exit.terminal) throw new WorkerSupervisorError("WORKER_PROCESS_EXITED", "Worker exited after readiness");
      child.unref?.();
      return handle;
    } catch (error) {
      await stdoutHandle?.close().catch(() => {});
      await stderrHandle?.close().catch(() => {});
      if (supervision !== undefined) {
        await this.#stopFailedLaunch(supervision);
      } else if (lease !== undefined) {
        await this.#ownership.release(sessionId, lease.leaseId, lease.generation).catch(() => {});
      }
      throw error;
    } finally {
      await this.#unreserve(reservation);
    }
  }

  /** @param {string} sessionId @param {any} event */
  async #writeWorkerEvent(sessionId, event) {
    const current = await this.#registry.get(sessionId);
    if (current === undefined) throw new Error(`Unknown registry session: ${sessionId}`);
    const next = reduceSessionState(current, event);
    if (next === current) return current;
    return this.#registry.update(sessionId, current.revision, {
      taskState: next.taskState,
      processState: next.processState,
      outcome: next.outcome,
      activity: next.activity,
      updatedAt: next.updatedAt,
    });
  }

  /** @param {string} sessionId @param {any} event */
  async #applyWorkerEvent(sessionId, event) {
    return this.#admission.sessions.run(sessionId, () => this.#writeWorkerEvent(sessionId, event));
  }

  /** @param {{ child: any, token: string, sessionId: string, runId: string, lease: import("./ownership.mjs").WriterLease, identity: ProcessIdentity }} options */
  #createHandle({ child, token, sessionId, runId, lease, identity }) {
    let sequence = 0;
    /** @type {Map<string, { resolve(value: unknown): void, reject(error: unknown): void }>} */
    const pending = new Map();
    /** @param {any} message */
    const onMessage = (message) => {
      if (!authenticated(message?.token, token)) return;
      if (message?.type === "worker_event" && message.sessionId === sessionId) {
        void this.#applyWorkerEvent(sessionId, message.event).catch(() => {});
        return;
      }
      if (message?.type !== "command_result") return;
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      message.ok ? request.resolve(message.record) : request.reject(Object.assign(new Error(message.error?.message ?? "Worker command failed"), { code: message.error?.code ?? "RPC_FAILED", delivered: message.error?.deliveryUnknown !== true }));
    };
    const onDisconnect = () => {
      for (const request of pending.values()) request.reject(Object.assign(new Error("Worker delivery became ambiguous"), { code: "DELIVERY_UNKNOWN" }));
      pending.clear();
    };
    child.on("message", onMessage);
    child.once("disconnect", onDisconnect);

    const handle = {
      ready: true,
      sessionId,
      runId,
      leaseId: lease.leaseId,
      generation: lease.generation,
      identity,
      piChildIdentity: identity,
      pid: identity.pid,
      processGroupId: identity.processGroupId,
      /** @param {import("../shared/contracts.js").ClientRequest} command @param {any} journal */
      async deliver(command, journal) {
        const accepted = await journal.accept(command);
        if (accepted.stage !== "ACCEPTED") return accepted;
        const key = { clientId: command.clientId, requestId: command.requestId };
        const retryAtRisk = (await journal.history(key)).some((/** @type {import("../shared/contracts.js").CommandStatus} */ status) => status.stage === "DELIVERY_UNKNOWN");
        await journal.transition(key, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
        const id = `${runId}:${++sequence}`;
        try {
          const result = new Promise((resolveResult, rejectResult) => pending.set(id, { resolve: resolveResult, reject: rejectResult }));
          const payload = /** @type {{ text?: string }} */ (command.payload);
          await sendMessage(child, { version: 1, type: "command", token, id, command: { clientId: command.clientId, requestId: command.requestId, op: command.op, text: payload.text, retryAtRisk } });
          await result;
          await journal.transition(key, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
          return journal.transition(key, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
        } catch (error) {
          pending.delete(id);
          const failure = /** @type {{ delivered?: boolean, code?: string }} */ (error);
          if (failure?.delivered === true) {
            await journal.transition(key, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
            return journal.transition(key, ["WORKER_ACKNOWLEDGED"], "FAILED", { code: failure.code ?? "RPC_FAILED", message: error instanceof Error ? error.message : "Worker command failed", retryable: false });
          }
          return journal.transition(key, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
        }
      },
      terminal() {
        onDisconnect();
        child.off("message", onMessage);
        child.off("disconnect", onDisconnect);
      },
      detach() {
        child.off("message", onMessage);
        if (child.connected !== false) child.disconnect?.();
      },
    };
    return handle;
  }

  /**
   * Stop one owned worker only through Task 6's verified identity boundary.
   * @param {any} handle
   * @param {Parameters<typeof stopVerifiedProcessGroup>[1]} deps
   * @param {Parameters<typeof stopVerifiedProcessGroup>[2]} policy
   */
  async stop(handle, deps, policy) {
    if (!this.#handles.has(handle)) throw new WorkerSupervisorError("UNKNOWN_WORKER", "Worker handle is not owned by this supervisor");
    const result = await stopVerifiedProcessGroup(handle.identity, deps, policy);
    if (["ALREADY_EXITED", "GRACEFUL", "TERMINATED", "STALE_IDENTITY"].includes(result.disposition)) {
      const supervision = [...this.#supervisions].find((candidate) => candidate.handle === handle);
      if (supervision !== undefined) await this.#reconcileTerminal(supervision, true);
    }
    return result;
  }

  /** Detach daemon IPC from workers without signaling their process groups. */
  async close() {
    for (const handle of this.#handles) handle.detach();
    this.#handles.clear();
  }
}
