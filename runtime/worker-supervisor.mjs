import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OwnershipManager } from "./ownership.mjs";
import { probePiCapabilities } from "./pi-capability-probe.mjs";
import { assertPiExecutableIdentity, resolvePiExecutable } from "./pi-executable.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "./process-signaler.mjs";
import { registryCoordinationScope } from "./registry-store.mjs";
import { reduceSessionState } from "./state-reducer.mjs";

const DEFAULT_WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const admissionStates = new WeakMap();
const MAX_QUEUED_FRAME_BYTES = 1024 * 1024;
const MAX_QUEUED_FRAMES = 256;
const MAX_BUFFERED_STARTUP_EVENTS = 256;
const DEFAULT_LAUNCH_STOP_POLICY = Object.freeze({ gracefulMs: 5_000, terminateMs: 5_000 });

/** @typedef {(command: string, argv: string[], options: any) => any} SpawnLike */

/** @typedef {import("../shared/contracts.mjs").ProcessIdentity} ProcessIdentity */
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

/** @param {any} supervision @param {number} bytes */
function recordFrameDrop(supervision, bytes) {
  supervision.droppedFrameCount += 1;
  supervision.droppedFrameBytes += bytes;
}

/** @param {any} supervision @param {Record<string, unknown>} frame */
function queueFrame(supervision, frame) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(frame)); } catch { return; }
  if (bytes > MAX_QUEUED_FRAME_BYTES) {
    recordFrameDrop(supervision, bytes);
    return;
  }
  while (supervision.queuedFrames.length >= MAX_QUEUED_FRAMES || supervision.queuedFrameBytes + bytes > MAX_QUEUED_FRAME_BYTES) {
    const removed = supervision.queuedFrames.shift();
    if (removed === undefined) break;
    supervision.queuedFrameBytes -= removed.bytes;
    recordFrameDrop(supervision, removed.bytes);
  }
  supervision.queuedFrames.push({ frame, bytes });
  supervision.queuedFrameBytes += bytes;
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

/** @param {any} child @param {() => void} onTerminal @returns {{ terminal: boolean, detach: () => void }} */
function observeExit(child, onTerminal) {
  const observation = { terminal: false, detach: () => child.off("exit", onExit) };
  const onExit = () => {
    observation.terminal = true;
    onTerminal();
  };
  child.once("exit", onExit);
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

/** @param {ReturnType<typeof registryCoordinationScope>} scope */
function admissionState(scope) {
  let state = admissionStates.get(scope);
  if (state === undefined) {
    state = { tail: Promise.resolve(), reservations: new Map(), launchingSessions: new Set(), sessions: scope.lifecycle };
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
  #configuredPiPath;
  #env;
  #injectedSpawn;
  #capabilityCache;
  #resolveExecutable;
  #probeCapabilities;
  #assertExecutable;
  #randomId;
  #startTimeoutMs;
  #launchStopPolicy;
  #signalProcessGroup;
  #sleep;
  #admission;
  #handles = new Set();
  #supervisions = new Set();

  /**
   * @param {{ registry: import("./registry-store.mjs").RegistryStore, ownership?: OwnershipManager, runsDirectory: string, maxLive?: number | null, spawnImpl?: SpawnLike, inspect?: typeof inspectProcessIdentity, workerPath?: string, configuredPiPath?: string | null, env?: NodeJS.ProcessEnv, randomId?: () => string, startTimeoutMs?: number, launchStopPolicy?: { gracefulMs: number, terminateMs: number }, signalProcessGroupImpl?: typeof signalProcessGroup, sleepImpl?: typeof sleep, resolveExecutableImpl?: typeof resolvePiExecutable, probeCapabilitiesImpl?: typeof probePiCapabilities, assertExecutableImpl?: typeof assertPiExecutableIdentity, capabilityCache?: Map<string, import("../shared/contracts.mjs").PiCapabilityReport> }} options
   */
  constructor({ registry, ownership = new OwnershipManager(registry), runsDirectory, maxLive = null, spawnImpl = spawn, inspect = inspectProcessIdentity, workerPath = DEFAULT_WORKER_PATH, configuredPiPath = null, env = process.env, randomId = randomUUID, startTimeoutMs = 15_000, launchStopPolicy = DEFAULT_LAUNCH_STOP_POLICY, signalProcessGroupImpl = signalProcessGroup, sleepImpl = sleep, resolveExecutableImpl = resolvePiExecutable, probeCapabilitiesImpl = probePiCapabilities, assertExecutableImpl = assertPiExecutableIdentity, capabilityCache = new Map() }) {
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
    this.#configuredPiPath = configuredPiPath;
    this.#env = { ...env };
    this.#injectedSpawn = spawnImpl !== spawn;
    this.#capabilityCache = capabilityCache;
    this.#resolveExecutable = resolveExecutableImpl;
    this.#probeCapabilities = probeCapabilitiesImpl;
    this.#assertExecutable = assertExecutableImpl;
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
    const terminals = [...this.#supervisions].filter((supervision) =>
      (supervision.lifecycle === "terminal" || supervision.exit.terminal) &&
      (supervision.sessionId === sessionId || !this.#admission.launchingSessions.has(supervision.sessionId)));
    await Promise.all(terminals.map((supervision) => supervision.sessionId === sessionId
      ? this.#reconcileTerminalLocked(supervision)
      : this.#admission.sessions.run(supervision.sessionId, () => this.#reconcileTerminalLocked(supervision))));
    await underAdmissionLock(this.#admission, async () => {
      const live = new Set((await this.#registry.list()).filter((record) => record.ownership !== undefined).map((record) => record.sessionId));
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

  /** @param {any} supervision */
  #queueTerminalReconciliation(supervision) {
    void this.#admission.sessions.run(supervision.sessionId, () => this.#reconcileTerminalLocked(supervision)).catch(() => {});
  }

  /** @param {any} supervision @param {boolean} [verifiedTerminal] */
  async #reconcileTerminalLocked(supervision, verifiedTerminal = false) {
    if (supervision.lifecycle === "reconciled") return;
    if (!supervision.exit.terminal && !verifiedTerminal) return;
    supervision.lifecycle = "terminal";
    const handle = supervision.handle;
    handle?.terminal();
    supervision.exit.detach();
    supervision.child.off("message", supervision.messageReceiver);
    supervision.handle = undefined;
    if (handle !== undefined) this.#handles.delete(handle);
    await this.#ownership.release(supervision.sessionId, supervision.lease.leaseId, supervision.lease.generation);
    supervision.lifecycle = "reconciled";
    this.#supervisions.delete(supervision);
  }

  /** @param {any} supervision */
  async #stopFailedLaunchLocked(supervision) {
    if (supervision.exit.terminal) {
      if (supervision.piChildIdentity !== undefined && supervision.identity !== undefined) {
        try {
          const piChild = await this.#inspect(supervision.piChildIdentity.pid);
          if (sameIdentity(piChild, supervision.piChildIdentity) && piChild.processGroupId === supervision.identity.processGroupId) {
            await this.#signalProcessGroup(supervision.identity.processGroupId, "SIGKILL");
          }
        } catch {
        }
      }
      await this.#reconcileTerminalLocked(supervision);
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
    if (["ALREADY_EXITED", "GRACEFUL", "TERMINATED", "KILLED", "STALE_IDENTITY"].includes(result.disposition)) {
      await this.#reconcileTerminalLocked(supervision, true);
    }
  }

  /**
   * Launch one session worker. Same-session launches serialize; different sessions overlap after admission.
   * @param {{ sessionId: string, canonicalSessionFile: string, cwd: string, runId: string, sessionRecord?: import("../shared/contracts.mjs").SessionRecord, model?: { provider: string, id: string }, thinkingLevel?: string, name?: string, piPath?: string, daemonConnector?: string, daemonConnectConfig?: Record<string, unknown>, reconnectDelaysMs?: number[] }} request
   */
  launch(request) {
    if (typeof request?.sessionId !== "string" || request.sessionId.length === 0) return Promise.reject(new TypeError("sessionId is required"));
    return this.#admission.sessions.runNested(request.sessionId, async () => {
      this.#admission.launchingSessions.add(request.sessionId);
      try {
        return await this.#launch(request);
      } finally {
        this.#admission.launchingSessions.delete(request.sessionId);
      }
    });
  }

  /** @param {{ sessionId: string, canonicalSessionFile: string, cwd: string, runId: string, sessionRecord?: import("../shared/contracts.mjs").SessionRecord, model?: { provider: string, id: string }, thinkingLevel?: string, name?: string, piPath?: string, daemonConnector?: string, daemonConnectConfig?: Record<string, unknown>, reconnectDelaysMs?: number[] }} request */
  async #launch({ sessionId, canonicalSessionFile, cwd, runId, sessionRecord, model, thinkingLevel, name, piPath, daemonConnector, daemonConnectConfig = {}, reconnectDelaysMs = [100, 250, 500, 1_000, 2_000] }) {
    if ([canonicalSessionFile, cwd, runId].some((value) => typeof value !== "string" || value.length === 0)) throw new TypeError("Worker launch fields must be non-empty strings");
    let record = await this.#registry.get(sessionId);
    if (record === undefined) {
      if (sessionRecord === undefined) throw new Error(`Unknown registry session: ${sessionId}`);
      await this.#registry.create(sessionRecord);
      record = await this.#registry.get(sessionId);
    }
    if (record?.canonicalSessionFile !== canonicalSessionFile) throw Object.assign(new Error("Worker launch requires the canonical registry session file"), { code: "CANONICAL_SESSION_MISMATCH" });

    let executable;
    let capabilities;
    const selectedPath = piPath;
    try {
      if (this.#injectedSpawn) {
        executable = { realpath: selectedPath ?? process.execPath, device: "injected", inode: "injected", size: 0, modifiedTimeNs: "0" };
        capabilities = /** @type {import("../shared/contracts.mjs").PiCapabilityReport} */ ({ executable, reportedVersion: "injected", rpcMode: true, jsonl: true, commands: ["get_state", "prompt", "follow_up", "steer", "abort", "extension_ui_response"], events: [], missingRequired: [] });
      } else {
        executable = await this.#resolveExecutable({ cliPath: selectedPath, configuredPath: this.#configuredPiPath, pathEnv: this.#env.PATH ?? "" });
        capabilities = await this.#probeCapabilities({ executable, cache: this.#capabilityCache, timeoutMs: this.#startTimeoutMs, env: this.#env });
        if (capabilities.missingRequired.length > 0) {
          throw Object.assign(new WorkerSupervisorError("UNSUPPORTED_PI_CAPABILITY", `Installed Pi is missing required capabilities: ${capabilities.missingRequired.join(", ")}`), { missingCapabilities: capabilities.missingRequired });
        }
      }
    } catch (error) {
      if (typeof error === "object" && error !== null) Object.assign(error, { preChild: true });
      throw error;
    }

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
      const diagnosticsDirectory = join(runDirectory, "diagnostics");
      const argv = [
        this.#workerPath,
        "--session-id", sessionId,
        "--canonical-session-file", canonicalSessionFile,
        "--cwd", cwd,
        "--run-id", runId,
        "--lease-id", lease.leaseId,
        "--generation", String(lease.generation),
        "--replay-path", replayPath,
        "--pi-executable", executable.realpath,
        "--pi-identity", JSON.stringify(executable),
        "--capabilities", JSON.stringify(capabilities),
        "--diagnostics-directory", diagnosticsDirectory,
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
      if (!this.#injectedSpawn) await this.#assertExecutable(executable);
      child = this.#spawn(process.execPath, argv, {
        cwd,
        env: { ...this.#env, PI_DASHBOARD_WORKER_TOKEN: token },
        detached: true,
        shell: false,
        stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd, "ipc"],
      });
      supervision = { child, token, sessionId, lease, exit: undefined, identity: undefined, handle: undefined, lifecycle: "launching", queuedFrames: [], queuedFrameBytes: 0, droppedFrameCount: 0, droppedFrameBytes: 0, startupEvents: [], frameListeners: new Set(), commandResultHandler: undefined };
      supervision.messageReceiver = (/** @type {any} */ message) => {
        if (!authenticated(message?.token, token)) return;
        if (message.type === "pi_frame" && message.sessionId === sessionId && typeof message.frame === "object" && message.frame !== null) {
          if (supervision.frameListeners.size > 0) {
            for (const listener of supervision.frameListeners) {
              try { listener(message.frame); } catch {}
            }
            return;
          }
          queueFrame(supervision, message.frame);
        } else if (message.type === "worker_event" && message.sessionId === sessionId) {
          if (supervision.lifecycle === "active") {
            void this.#applyWorkerEvent(supervision, message.event).catch(() => {});
          } else if (supervision.lifecycle === "launching") {
            if (supervision.startupEvents.length >= MAX_BUFFERED_STARTUP_EVENTS) supervision.startupEvents.shift();
            supervision.startupEvents.push(message.event);
          }
        } else if (message.type === "command_result") {
          supervision.commandResultHandler?.(message);
        }
      };
      child.on("message", supervision.messageReceiver);
      const exit = observeExit(child, () => {
        if (supervision.lifecycle === "reconciled") return;
        supervision.lifecycle = "terminal";
        this.#queueTerminalReconciliation(supervision);
      });
      supervision.exit = exit;
      this.#supervisions.add(supervision);
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
      if (!sameIdentity(hello.worker, inspected) || inspected.pid !== childPid || inspected.processGroupId !== childPid) {
        throw new WorkerSupervisorError("WORKER_IDENTITY_MISMATCH", "Worker PID, start identity, or process group did not match");
      }

      await this.#ownership.bindProcesses(sessionId, lease.leaseId, lease.generation, inspected, inspected);
      if (supervision.exit.terminal) throw new WorkerSupervisorError("WORKER_PROCESS_EXITED", "Worker exited after ownership binding");
      const piChildPromise = waitForMessage(child, "pi_child", this.#startTimeoutMs);
      void piChildPromise.catch(() => {});
      await sendMessage(child, { version: 1, type: "activate", token, leaseId: lease.leaseId, generation: lease.generation });
      const piMessage = await piChildPromise;
      if (!authenticated(piMessage.token, token) || piMessage.sessionId !== sessionId || piMessage.runId !== runId || piMessage.leaseId !== lease.leaseId || piMessage.generation !== lease.generation) {
        throw new WorkerSupervisorError("WORKER_CHILD_MISMATCH", "Pi child handshake did not match the authenticated launch");
      }
      const piInspected = await this.#inspect(piMessage.piChild?.pid);
      if (!sameIdentity(piMessage.worker, inspected) || !sameIdentity(piMessage.piChild, piInspected) || piInspected.pid === inspected.pid || piInspected.processGroupId !== inspected.processGroupId) {
        throw new WorkerSupervisorError("WORKER_IDENTITY_MISMATCH", "Pi child identity or process-group membership did not match");
      }
      supervision.piChildIdentity = piInspected;
      const runtime = {
        executable,
        piVersion: capabilities.reportedVersion,
        capabilities,
        rpcAdapterVersion: /** @type {const} */ (1),
        viewerProtocolVersion: /** @type {const} */ (1),
        supervisor: inspected,
        piChild: piInspected,
      };
      await this.#ownership.bindPiChild(sessionId, lease.leaseId, lease.generation, piInspected, runtime);
      const readyPromise = waitForMessage(child, "worker_ready", this.#startTimeoutMs);
      void readyPromise.catch(() => {});
      await sendMessage(child, { version: 1, type: "child_bound", token, leaseId: lease.leaseId, generation: lease.generation });
      const ready = await readyPromise;
      if (!authenticated(ready.token, token) || ready.sessionId !== sessionId || ready.runId !== runId || !sameIdentity(ready.worker, inspected) || !sameIdentity(ready.piChild, piInspected)) {
        throw new WorkerSupervisorError("WORKER_READY_MISMATCH", "Worker readiness did not match the authenticated launch");
      }

      await this.#writeWorkerEventLocked(supervision, { type: "WORKER_READY", at: new Date().toISOString() }, "launching");
      if (supervision.exit.terminal || supervision.lifecycle !== "launching") {
        await this.#reconcileTerminalLocked(supervision);
        throw new WorkerSupervisorError("WORKER_PROCESS_EXITED", "Worker exited after readiness");
      }
      supervision.lifecycle = "active";
      const handle = this.#createHandle(supervision);
      supervision.handle = handle;
      this.#handles.add(handle);
      for (const event of supervision.startupEvents.splice(0)) void this.#applyWorkerEvent(supervision, event).catch(() => {});
      child.unref?.();
      return handle;
    } catch (error) {
      await stdoutHandle?.close().catch(() => {});
      await stderrHandle?.close().catch(() => {});
      if (supervision !== undefined) {
        await this.#stopFailedLaunchLocked(supervision);
      } else if (lease !== undefined) {
        await this.#ownership.release(sessionId, lease.leaseId, lease.generation).catch(() => {});
      }
      if (child === undefined && typeof error === "object" && error !== null) Object.assign(error, { preChild: true });
      throw error;
    } finally {
      await this.#unreserve(reservation);
    }
  }

  /** @param {any} supervision @param {any} event @param {"launching" | "active"} lifecycle */
  async #writeWorkerEventLocked(supervision, event, lifecycle) {
    const launchEvent = lifecycle === "launching";
    if (supervision.exit.terminal || supervision.lifecycle !== lifecycle || !this.#supervisions.has(supervision)) {
      if (launchEvent) throw new WorkerSupervisorError("WORKER_PROCESS_EXITED", "Worker exited before readiness persistence");
      return undefined;
    }
    const current = await this.#registry.get(supervision.sessionId);
    if (current === undefined) throw new Error(`Unknown registry session: ${supervision.sessionId}`);
    const ownsRecord = current.ownership?.runId === supervision.lease.runId &&
      current.ownership?.acquiredAt === supervision.lease.acquiredAt &&
      sameIdentity(current.ownership?.process, supervision.identity);
    if (!ownsRecord) {
      if (launchEvent) throw new WorkerSupervisorError("STALE_LEASE", "Worker readiness no longer owns the session");
      return undefined;
    }
    if (supervision.exit.terminal || supervision.lifecycle !== lifecycle) {
      if (launchEvent) throw new WorkerSupervisorError("WORKER_PROCESS_EXITED", "Worker exited before readiness persistence");
      return undefined;
    }
    const next = reduceSessionState(current, event);
    const updated = next === current ? current : await this.#registry.update(supervision.sessionId, current.revision, {
      taskState: next.taskState,
      processState: next.processState,
      outcome: next.outcome,
      activity: next.activity,
      updatedAt: next.updatedAt,
    });
    if (supervision.exit.terminal || supervision.lifecycle === "terminal") {
      await this.#reconcileTerminalLocked(supervision);
      if (launchEvent) throw new WorkerSupervisorError("WORKER_PROCESS_EXITED", "Worker exited during readiness persistence");
    }
    return updated;
  }

  /** @param {any} supervision @param {any} event */
  async #applyWorkerEvent(supervision, event) {
    return this.#admission.sessions.run(supervision.sessionId, () => this.#writeWorkerEventLocked(supervision, event, "active"));
  }

  /** @param {any} supervision */
  #createHandle(supervision) {
    const { child, token, sessionId, lease, identity } = supervision;
    const runId = lease.runId;
    let sequence = 0;
    /** @type {Map<string, { resolve(value: unknown): void, reject(error: unknown): void }>} */
    const pending = new Map();
    /** @type {Set<(frame: Record<string, unknown>) => void>} */
    const frameListeners = supervision.frameListeners;
    /** @param {any} message */
    const onCommandResult = (message) => {
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      message.ok ? request.resolve(message.record) : request.reject(Object.assign(new Error(message.error?.message ?? "Worker command failed"), { code: message.error?.code ?? "RPC_FAILED", delivered: message.error?.deliveryUnknown !== true }));
    };
    supervision.commandResultHandler = onCommandResult;
    const onDisconnect = () => {
      for (const request of pending.values()) request.reject(Object.assign(new Error("Worker delivery became ambiguous"), { code: "DELIVERY_UNKNOWN" }));
      pending.clear();
    };
    child.once("disconnect", onDisconnect);

    const handle = {
      ready: true,
      sessionId,
      runId,
      leaseId: lease.leaseId,
      generation: lease.generation,
      identity,
      piChildIdentity: supervision.piChildIdentity,
      pid: identity.pid,
      processGroupId: identity.processGroupId,
      /** @param {import("../shared/contracts.mjs").ClientRequest} command @param {any} journal */
      async deliver(command, journal) {
        if (supervision.lifecycle !== "active" || supervision.exit.terminal) {
          throw Object.assign(new Error("Worker delivery became ambiguous"), { code: "DELIVERY_UNKNOWN" });
        }
        const accepted = await journal.accept(command);
        if (accepted.stage !== "ACCEPTED") return accepted;
        const key = { clientId: command.clientId, requestId: command.requestId };
        const retryAtRisk = (await journal.history(key)).some((/** @type {import("../shared/contracts.mjs").CommandStatus} */ status) => status.stage === "DELIVERY_UNKNOWN");
        await journal.transition(key, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
        const id = `${runId}:${++sequence}`;
        try {
          const result = new Promise((resolveResult, rejectResult) => pending.set(id, { resolve: resolveResult, reject: rejectResult }));
          const payload = /** @type {{ text?: string, uiRequestId?: string, response?: unknown }} */ (command.payload);
          await sendMessage(child, { version: 1, type: "command", token, id, command: { clientId: command.clientId, requestId: command.requestId, op: command.op, text: payload.text, response: command.op === "ui_response" ? { requestId: payload.uiRequestId, response: payload.response } : undefined, retryAtRisk } });
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
      /** @param {(frame: Record<string, unknown>) => void} listener */
      onFrame(listener) {
        if (typeof listener !== "function") throw new TypeError("Frame listener must be a function");
        frameListeners.add(listener);
        if (supervision.droppedFrameCount > 0) {
          const overflow = {
            type: "pi_dashboard_frame_queue_overflow",
            droppedFrames: supervision.droppedFrameCount,
            droppedBytes: supervision.droppedFrameBytes,
            recovery: "snapshot_or_diagnostics",
          };
          supervision.droppedFrameCount = 0;
          supervision.droppedFrameBytes = 0;
          try { listener(overflow); } catch {}
        }
        for (const buffered of supervision.queuedFrames.splice(0)) {
          supervision.queuedFrameBytes -= buffered.bytes;
          try { listener(buffered.frame); } catch {}
        }
        return () => frameListeners.delete(listener);
      },
      terminal() {
        onDisconnect();
        frameListeners.clear();
        supervision.commandResultHandler = undefined;
        child.off("message", supervision.messageReceiver);
        child.off("disconnect", onDisconnect);
      },
      detach() {
        frameListeners.clear();
        supervision.commandResultHandler = undefined;
        child.off("message", supervision.messageReceiver);
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
    const supervision = [...this.#supervisions].find((candidate) => candidate.handle === handle);
    if (supervision === undefined || !this.#handles.has(handle)) throw new WorkerSupervisorError("UNKNOWN_WORKER", "Worker handle is not owned by this supervisor");
    return this.#admission.sessions.run(supervision.sessionId, async () => {
      if (supervision.lifecycle !== "active" || supervision.handle !== handle || !this.#handles.has(handle)) {
        throw new WorkerSupervisorError("UNKNOWN_WORKER", "Worker handle is not owned by this supervisor");
      }
      if (supervision.exit.terminal) {
        await this.#reconcileTerminalLocked(supervision);
        throw new WorkerSupervisorError("UNKNOWN_WORKER", "Worker has already exited");
      }
      const result = await stopVerifiedProcessGroup(handle.identity, deps, policy);
      if (["ALREADY_EXITED", "GRACEFUL", "TERMINATED", "KILLED", "STALE_IDENTITY"].includes(result.disposition)) {
        await this.#reconcileTerminalLocked(supervision, true);
      }
      return result;
    });
  }

  /** Detach daemon IPC from workers without signaling their process groups. */
  async close() {
    const handles = [...this.#handles];
    this.#handles.clear();
    const results = await Promise.allSettled(handles.map(async (handle) => handle.detach()));
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, "Worker supervisor detached with errors");
  }
}
