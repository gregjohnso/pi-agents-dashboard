import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recordLaunchStage } from "./launch-trace.mjs";
import { OwnershipManager } from "./ownership.mjs";
import { probePiCapabilities } from "./pi-capability-probe.mjs";
import { assertPiExecutableIdentity, resolvePiExecutable } from "./pi-executable.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "./process-signaler.mjs";
import { registryCoordinationScope } from "./registry-store.mjs";
import { reduceSessionState } from "./state-reducer.mjs";

const DEFAULT_WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const admissionStates = new WeakMap();
const DEFAULT_LAUNCH_STOP_POLICY = Object.freeze({ gracefulMs: 5_000, terminateMs: 5_000 });
/** Stop dispositions that prove the worker process group is gone, so its lease can be released. */
const PROVEN_TERMINAL_DISPOSITIONS = ["ALREADY_EXITED", "GRACEFUL", "TERMINATED", "KILLED", "STALE_IDENTITY"];
/** Child-anchored stop dispositions that prove the recorded Pi child is gone. A changed identity is ambiguous here, not proof. */
const PROVEN_PI_CHILD_DISPOSITIONS = ["ALREADY_EXITED", "GRACEFUL", "TERMINATED", "KILLED"];

/** @typedef {(command: string, argv: string[], options: any) => any} SpawnLike */

/** @typedef {import("../shared/contracts.mjs").ProcessIdentity} ProcessIdentity */

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

/** @param {unknown} error */
function exited(error) {
  return error instanceof Error && ["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "");
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

/** Abandon one startup wait as soon as the spawned worker dies. @param {any} child @param {Promise<any>} awaited @param {string} what @returns {Promise<any>} */
function untilWorkerExits(child, awaited, what) {
  return new Promise((resolveValue, rejectValue) => {
    /** @param {number | null} code @param {NodeJS.Signals | null} signal */
    const onExit = (code, signal) => rejectValue(new WorkerSupervisorError("WORKER_PROCESS_EXITED", `Worker exited before ${what} (${code ?? signal ?? "unknown"})`));
    /** @param {unknown} cause */
    const onError = (cause) => rejectValue(new WorkerSupervisorError("WORKER_PROCESS_FAILED", "Worker process failed", { cause }));
    child.once("exit", onExit);
    child.once("error", onError);
    awaited.then(resolveValue, rejectValue).finally(() => {
      child.off("exit", onExit);
      child.off("error", onError);
    });
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
  #router;
  #cliVersion;
  #handles = new Set();
  #supervisions = new Set();

  /**
   * @param {{ registry: import("./registry-store.mjs").RegistryStore, ownership?: OwnershipManager, runsDirectory: string, maxLive?: number | null, spawnImpl?: SpawnLike, inspect?: typeof inspectProcessIdentity, workerPath?: string, configuredPiPath?: string | null, env?: NodeJS.ProcessEnv, randomId?: () => string, startTimeoutMs?: number, launchStopPolicy?: { gracefulMs: number, terminateMs: number }, signalProcessGroupImpl?: typeof signalProcessGroup, sleepImpl?: typeof sleep, resolveExecutableImpl?: typeof resolvePiExecutable, probeCapabilitiesImpl?: typeof probePiCapabilities, assertExecutableImpl?: typeof assertPiExecutableIdentity, capabilityCache?: Map<string, import("../shared/contracts.mjs").PiCapabilityReport>, router?: any, cliVersion?: string }} options
   */
  constructor({ registry, ownership = new OwnershipManager(registry), runsDirectory, maxLive = null, spawnImpl = spawn, inspect = inspectProcessIdentity, workerPath = DEFAULT_WORKER_PATH, configuredPiPath = null, env = process.env, randomId = randomUUID, startTimeoutMs = 15_000, launchStopPolicy = DEFAULT_LAUNCH_STOP_POLICY, signalProcessGroupImpl = signalProcessGroup, sleepImpl = sleep, resolveExecutableImpl = resolvePiExecutable, probeCapabilitiesImpl = probePiCapabilities, assertExecutableImpl = assertPiExecutableIdentity, capabilityCache = new Map(), router = undefined, cliVersion = undefined }) {
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
    this.#router = router;
    this.#cliVersion = cliVersion;
    this.#admission = admissionState(registryCoordinationScope(registry));
  }

  /** The daemon owns the router, so it supplies it once its runtime exists. @param {any} router */
  useRouter(router) {
    if (this.#router !== undefined && this.#router !== router) throw new TypeError("Worker supervisor already routes through a different router");
    this.#router = router;
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

  /**
   * Record a surviving or unverifiable Pi child on the session it still owns, without releasing the lease.
   * @param {any} supervision @param {string} summary
   */
  async #markStaleLocked(supervision, summary) {
    const current = await this.#registry.get(supervision.sessionId);
    if (current === undefined || current.processState === "STALE") return;
    const ownsRecord = current.ownership?.runId === supervision.lease.runId &&
      current.ownership?.acquiredAt === supervision.lease.acquiredAt &&
      sameIdentity(current.ownership?.process, supervision.identity);
    if (!ownsRecord) return;
    const next = reduceSessionState(current, { type: "WORKER_CRASHED", at: new Date().toISOString(), summary });
    await this.#registry.update(supervision.sessionId, current.revision, {
      processState: next.processState,
      activity: next.activity,
      updatedAt: next.updatedAt,
    });
  }

  /**
   * The Pi child, not the supervisor, holds the canonical session file open, so a lease may only be
   * released once the exact recorded child is provably gone. Anything unproven keeps the lease.
   * @param {any} supervision
   */
  async #piChildTerminalLocked(supervision) {
    const expected = supervision.piChildIdentity;
    // A launch that failed before the Pi child handshake has no recorded child that can outlive it.
    if (expected === undefined) return true;
    let state;
    try {
      state = sameIdentity(await this.#inspect(expected.pid), expected) ? "LIVE" : "REPLACED";
    } catch (error) {
      state = exited(error) ? "GONE" : "AMBIGUOUS";
    }
    if (state === "GONE") return true;
    await this.#markStaleLocked(supervision, state === "LIVE"
      ? "Supervisor exited while its Pi child still owns the session file"
      : "Supervisor exited and its Pi child identity is unverifiable");
    // Only a worker that reached readiness has no other stop owner; a failed launch is torn down by #stopFailedLaunchLocked.
    if (state !== "LIVE" || supervision.activated !== true || supervision.piChildStopped === true) return false;
    supervision.piChildStopped = true;
    const result = await stopVerifiedProcessGroup(expected, {
      inspect: (/** @type {number} */ pid) => this.#inspect(pid),
      requestGraceful: async () => {},
      signalProcessGroup: this.#signalProcessGroup,
      sleep: this.#sleep,
    }, this.#launchStopPolicy).catch(() => ({ disposition: "AMBIGUOUS_IDENTITY" }));
    return PROVEN_PI_CHILD_DISPOSITIONS.includes(result.disposition);
  }

  /** @param {any} supervision @param {boolean} [verifiedTerminal] */
  async #reconcileTerminalLocked(supervision, verifiedTerminal = false) {
    if (supervision.lifecycle === "reconciled") return;
    if (!supervision.exit.terminal && !verifiedTerminal) return;
    supervision.lifecycle = "terminal";
    const handle = supervision.handle;
    supervision.exit.detach();
    supervision.reservation?.close();
    supervision.handle = undefined;
    if (handle !== undefined) this.#handles.delete(handle);
    if (!(await this.#piChildTerminalLocked(supervision))) return;
    await this.#ownership.release(supervision.sessionId, supervision.lease.leaseId, supervision.lease.generation);
    // The token is private per-run state, so a proven-terminal run leaves nothing behind to authenticate.
    await this.#router?.forgetRun(supervision.sessionId, supervision.token);
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
      await supervision.reservation?.send({ version: 1, type: "reject", token: supervision.token }).catch(() => {});
      await this.#router?.forgetRun(supervision.sessionId, supervision.token).catch(() => {});
      return;
    }
    const inspect = async (/** @type {number} */ pid) => {
      if (supervision.exit.terminal) throw Object.assign(new Error("Worker exited"), { code: "ENOENT" });
      return this.#inspect(pid);
    };
    const result = await stopVerifiedProcessGroup(supervision.identity, {
      inspect,
      requestGraceful: async () => {
        await supervision.reservation?.send({ version: 1, type: "shutdown", token: supervision.token }).catch(() => {});
      },
      signalProcessGroup: this.#signalProcessGroup,
      sleep: this.#sleep,
    }, this.#launchStopPolicy).catch(() => ({ disposition: "AMBIGUOUS_IDENTITY" }));
    if (PROVEN_TERMINAL_DISPOSITIONS.includes(result.disposition)) {
      await this.#reconcileTerminalLocked(supervision, true);
    }
  }

  /**
   * Launch one session worker. Same-session launches serialize; different sessions overlap after admission.
   * @param {{ sessionId: string, canonicalSessionFile: string, cwd: string, runId: string, sessionRecord?: import("../shared/contracts.mjs").SessionRecord, model?: { provider: string, id: string }, name?: string, piPath?: string, daemonConnector?: string, daemonConnectConfig?: Record<string, unknown>, reconnectDelaysMs?: number[] }} request
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

  /** @param {{ sessionId: string, canonicalSessionFile: string, cwd: string, runId: string, runHash?: string, sessionRecord?: import("../shared/contracts.mjs").SessionRecord, model?: { provider: string, id: string }, name?: string, piPath?: string, daemonConnector?: string, daemonConnectConfig?: Record<string, unknown>, reconnectDelaysMs?: number[] }} request */
  async #launch({ sessionId, canonicalSessionFile, cwd, runId, runHash, sessionRecord, model, name, piPath, daemonConnector, daemonConnectConfig = {}, reconnectDelaysMs = [100, 250, 500, 1_000, 2_000] }) {
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
    try {
      if (this.#injectedSpawn) {
        executable = { realpath: piPath ?? process.execPath, device: "injected", inode: "injected", size: 0, modifiedTimeNs: "0" };
        capabilities = /** @type {import("../shared/contracts.mjs").PiCapabilityReport} */ ({ executable, reportedVersion: "injected", rpcMode: true, jsonl: true, commands: ["get_state", "prompt", "follow_up", "steer", "abort", "extension_ui_response"], events: [], missingRequired: [] });
      } else {
        executable = await this.#resolveExecutable({ cliPath: piPath, configuredPath: this.#configuredPiPath, pathEnv: this.#env.PATH ?? "" });
        capabilities = await this.#probeCapabilities({ executable, cache: this.#capabilityCache, timeoutMs: this.#startTimeoutMs, env: this.#env });
        if (capabilities.missingRequired.length > 0) {
          throw Object.assign(new WorkerSupervisorError("UNSUPPORTED_PI_CAPABILITY", `Installed Pi is missing required capabilities: ${capabilities.missingRequired.join(", ")}`), { missingCapabilities: capabilities.missingRequired });
        }
      }
    } catch (error) {
      if (typeof error === "object" && error !== null) Object.assign(error, { preChild: true });
      throw error;
    }

    if (this.#router === undefined) throw new WorkerSupervisorError("WORKER_ROUTER_UNAVAILABLE", "Worker launch requires the control-socket router");
    let capacity;
    let lease;
    let child;
    /** @type {any} */
    let supervision;
    /** @type {any} */
    let reservation;
    let token;
    let stdoutHandle;
    let stderrHandle;
    try {
      capacity = await this.#reserve(sessionId);
      const directoryName = runHash ?? createHash("sha256").update(`${runId}\0${this.#randomId()}`).digest("hex");
      if (typeof directoryName !== "string" || directoryName.length === 0 || directoryName.includes("/")) throw new TypeError("runHash must be a root-relative directory name");
      lease = await this.#ownership.acquire(sessionId, canonicalSessionFile, runId);
      token = this.#randomId();
      if (typeof token !== "string" || token.length === 0) throw new TypeError("Worker token generator must return a non-empty string");
      const runDirectory = join(this.#runsDirectory, directoryName);
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
      // The reservation exists before spawn, so a worker that reaches the control socket before
      // `spawn` returns waits on its token instead of being refused.
      reservation = await this.#router.reserve({ sessionId, runId, leaseId: lease.leaseId, generation: lease.generation, token, ...(this.#cliVersion === undefined ? {} : { cliVersion: this.#cliVersion }) });
      child = this.#spawn(process.execPath, argv, {
        cwd,
        env: { ...this.#env, PI_AGENTS_WORKER_TOKEN: token },
        detached: true,
        shell: false,
        stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
      });
      reservation.spawned(child.pid);
      supervision = { child, token, sessionId, lease, reservation, exit: undefined, identity: undefined, handle: undefined, route: undefined, lifecycle: "launching", activated: false, piChildStopped: false };
      const exit = observeExit(child, () => {
        if (supervision.lifecycle === "reconciled") return;
        supervision.lifecycle = "terminal";
        this.#queueTerminalReconciliation(supervision);
      });
      supervision.exit = exit;
      this.#supervisions.add(supervision);
      await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
      stdoutHandle = undefined;
      stderrHandle = undefined;

      const childPid = child.pid;
      if (!Number.isSafeInteger(childPid) || /** @type {number} */ (childPid) <= 0) throw new WorkerSupervisorError("WORKER_IDENTITY_MISMATCH", "Spawned worker did not expose a valid PID");
      const inspected = await untilWorkerExits(child, reservation.connected(this.#startTimeoutMs), "its startup connection");
      supervision.identity = inspected;

      await this.#ownership.bindProcesses(sessionId, lease.leaseId, lease.generation, inspected, inspected, directoryName);
      if (supervision.exit.terminal) throw new WorkerSupervisorError("WORKER_PROCESS_EXITED", "Worker exited after ownership binding");
      const piChildPromise = untilWorkerExits(child, reservation.waitFor("pi_child", this.#startTimeoutMs), "pi_child");
      void piChildPromise.catch(() => {});
      await reservation.send({ version: 1, type: "activate", token, leaseId: lease.leaseId, generation: lease.generation });
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
      // Adoption compares the ready frame against this session's recorded worker and Pi-child
      // identities, so registration comes first.
      await this.#router.register({ sessionId, runId, leaseId: lease.leaseId, generation: lease.generation, identity: inspected, piChildIdentity: piInspected });
      const readyPromise = untilWorkerExits(child, reservation.waitFor("worker_ready", this.#startTimeoutMs), "worker_ready");
      void readyPromise.catch(() => {});
      await reservation.send({ version: 1, type: "child_bound", token, leaseId: lease.leaseId, generation: lease.generation });
      const ready = await readyPromise;
      if (!authenticated(ready.token, token) || ready.sessionId !== sessionId || ready.runId !== runId || !sameIdentity(ready.worker, inspected) || !sameIdentity(ready.piChild, piInspected)) {
        throw new WorkerSupervisorError("WORKER_READY_MISMATCH", "Worker readiness did not match the authenticated launch");
      }
      // Readiness never precedes adoption: the row says a session is live only once its route exists.
      const route = await this.#router.adopt(ready, reservation.connection);
      supervision.route = route;
      reservation.adopt(route);

      await this.#writeWorkerEventLocked(supervision, { type: "WORKER_READY", at: new Date().toISOString() }, "launching");
      recordLaunchStage("ready_persisted", sessionId);
      if (supervision.exit.terminal || supervision.lifecycle !== "launching") {
        await this.#reconcileTerminalLocked(supervision);
        throw new WorkerSupervisorError("WORKER_PROCESS_EXITED", "Worker exited after readiness");
      }
      supervision.lifecycle = "active";
      supervision.activated = true;
      const handle = this.#createHandle(supervision);
      supervision.handle = handle;
      this.#handles.add(handle);
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
      if (child === undefined && token !== undefined) await this.#router?.forgetRun(sessionId, token).catch(() => {});
      throw error;
    } finally {
      reservation?.close();
      await this.#unreserve(capacity);
    }
  }

  /** @param {any} supervision @param {any} event @param {"launching" | "active"} lifecycle */
  async #writeWorkerEventLocked(supervision, event, lifecycle) {
    const launchEvent = lifecycle === "launching";
    // A crashed Pi child only moves the record toward EXITED, and its report races the supervisor exit it
    // caused, so it stays writable until the lease is released.
    const afterExit = event?.type === "PI_CHILD_CRASHED" && !launchEvent && supervision.lifecycle !== "reconciled";
    const writable = () => afterExit || (!supervision.exit.terminal && supervision.lifecycle === lifecycle);
    if (!writable() || !this.#supervisions.has(supervision)) {
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
    if (!writable()) {
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

  /** @param {any} supervision */
  #createHandle(supervision) {
    const { sessionId, lease, identity } = supervision;
    return {
      ready: true,
      sessionId,
      runId: lease.runId,
      leaseId: lease.leaseId,
      generation: lease.generation,
      identity,
      piChildIdentity: supervision.piChildIdentity,
      pid: identity.pid,
      processGroupId: identity.processGroupId,
      /** Drop the daemon's end of this worker's route; the worker reconnects on its own. */
      detach() {
        supervision.route?.connection.close?.();
      },
    };
  }

  /**
   * Stop one owned worker only through the verified process-identity boundary.
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
      if (PROVEN_TERMINAL_DISPOSITIONS.includes(result.disposition)) {
        await this.#reconcileTerminalLocked(supervision, true);
      }
      return result;
    });
  }

  /** Drop the daemon end of every worker route without signaling their process groups. */
  async close() {
    const handles = [...this.#handles];
    this.#handles.clear();
    const results = await Promise.allSettled(handles.map(async (handle) => handle.detach()));
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, "Worker supervisor detached with errors");
  }
}
