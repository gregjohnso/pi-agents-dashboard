import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-file.mjs";
import { createCommandJournal } from "./command-journal.mjs";
import { traceSessionLock } from "./lock-trace.mjs";
import { RegistryStore, registryCoordinationScope } from "./registry-store.mjs";
import { SessionCoordinator } from "./session-coordinator.mjs";
import { createSessionHistoryReader, SessionHistoryError } from "./session-history.mjs";
import { reduceSessionState } from "./state-reducer.mjs";
import { createViewerNormalizer } from "./viewer-normalizer.mjs";
import { createViewerStore } from "./viewer-store.mjs";

/** Frames the startup connection carries before its route is adopted. */
const LAUNCH_CONTROL_TYPES = ["pi_child", "worker_ready"];
/** A startup connection holds only what the launch has not consumed yet; a flood is a defect, not backpressure. */
const MAX_RESERVATION_BUFFERED_FRAMES = 256;
/** The worker socket protocol this daemon speaks, recorded per worker and independent of any release. */
const WORKER_PROTOCOL_VERSION = 1;
/**
 * The one reason a run is marked for replacement: its code is behind the daemon's, or unknown. The
 * mark is written before the daemon signals anything, so a restart resumes the guarded replacement
 * instead of leaving the operator on a worker the daemon had already decided to replace.
 */
const PENDING_RESPAWN_UPGRADE = "upgrade";
const SEMANTIC_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;

/**
 * Compare one worker's release with this daemon's release. Callers compare only after the route is
 * adopted, so an old worker never blocks startup.
 *
 * Only the numeric major, minor, and patch parts decide the answer; a prerelease or build suffix on
 * the same triple is the same release. Anything absent or unparseable is UNKNOWN, which follows the
 * stale path and is never treated as a downgrade.
 *
 * @param {unknown} workerVersion @param {unknown} daemonVersion
 * @returns {"CURRENT" | "STALE" | "NEWER" | "UNKNOWN"}
 */
function workerReleaseStatus(workerVersion, daemonVersion) {
  const worker = typeof workerVersion === "string" ? SEMANTIC_VERSION.exec(workerVersion) : null;
  const daemon = typeof daemonVersion === "string" ? SEMANTIC_VERSION.exec(daemonVersion) : null;
  if (worker === null || daemon === null) return "UNKNOWN";
  for (let part = 1; part <= 3; part += 1) {
    const difference = Number(worker[part]) - Number(daemon[part]);
    if (difference !== 0) return difference < 0 ? "STALE" : "NEWER";
  }
  return "CURRENT";
}

/** @param {any} left @param {any} right */
function sameIdentity(left, right) {
  return left?.pid === right?.pid && left?.startIdentity === right?.startIdentity && left?.processGroupId === right?.processGroupId;
}

/** @param {unknown} value */
function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : "", "utf8").digest();
}

/** @param {unknown} supplied @param {string} expected */
function sameToken(supplied, expected) {
  return typeof supplied === "string" && timingSafeEqual(digest(supplied), digest(expected));
}

/** @returns {any} */
function deferred() {
  /** @type {any} */
  const box = { settled: false };
  box.promise = new Promise((resolveValue, rejectValue) => {
    box.resolve = (/** @type {any} */ value) => { if (!box.settled) { box.settled = true; resolveValue(value); } };
    box.reject = (/** @type {unknown} */ error) => { if (!box.settled) { box.settled = true; rejectValue(error); } };
  });
  box.promise.catch(() => {});
  return box;
}

/**
 * One launch this daemon reserved before it spawned the worker, keyed by the per-run token.
 *
 * A worker can reach the control socket before `spawn` returns, so a startup connection whose PID is
 * not published yet waits here instead of being refused.
 */
class LaunchReservation {
  /** @param {any} options */
  constructor({ token, sessionId, runId, leaseId, generation, inspect, release }) {
    this.token = token;
    this.sessionId = sessionId;
    this.runId = runId;
    this.leaseId = leaseId;
    this.generation = generation;
    this.inspect = inspect;
    this.release = release;
    this.spawnedPid = deferred();
    this.connectionArrived = deferred();
    /** @type {any} */
    this.connection = undefined;
    /** @type {any} */
    this.identity = undefined;
    /** @type {any} */
    this.route = undefined;
    /** @type {Map<string, any>} */
    this.waiters = new Map();
    /** @type {any[]} */
    this.pending = [];
    /** @type {any[]} */
    this.buffered = [];
    /** @type {((reservation: LaunchReservation) => void) | undefined} */
    this.onAdopted = undefined;
    this.closed = false;
  }

  /** The exact PID exists only after `spawn` returns. @param {number} pid */
  spawned(pid) {
    this.spawnedPid.resolve(pid);
  }

  /** The launch waits here for its own worker to arrive and be verified. @param {number} timeoutMs */
  connected(timeoutMs) {
    /** @type {any} */
    let timer;
    return Promise.race([
      /** @type {Promise<any>} */ (this.connectionArrived.promise),
      new Promise((_, rejectWait) => {
        timer = setTimeout(() => rejectWait(Object.assign(new Error("Timed out waiting for the worker startup connection"), { code: "WORKER_START_TIMEOUT" })), timeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** @param {any} frame @param {any} connection @param {number} timeoutMs */
  async bind(frame, connection, timeoutMs) {
    try {
      return await this.#bind(frame, connection, timeoutMs);
    } catch (error) {
      this.connectionArrived.reject(error);
      throw error;
    }
  }

  /** @param {any} frame @param {any} connection @param {number} timeoutMs */
  async #bind(frame, connection, timeoutMs) {
    if (this.connection !== undefined) throw Object.assign(new Error("A startup connection already claimed this launch"), { code: "WORKER_ALREADY_CONNECTED" });
    if (frame.sessionId !== this.sessionId || frame.runId !== this.runId || frame.leaseId !== this.leaseId || frame.generation !== this.generation) {
      throw Object.assign(new Error("Startup connection did not match the reserved launch"), { code: "WORKER_HELLO_MISMATCH" });
    }
    /** @type {any} */
    let timer;
    const pid = await Promise.race([
      this.spawnedPid.promise,
      new Promise((_, rejectWait) => {
        timer = setTimeout(() => rejectWait(Object.assign(new Error("Spawned PID did not arrive before the startup connection deadline"), { code: "WORKER_SPAWN_TIMEOUT" })), timeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    const inspected = await this.inspect(pid);
    if (!sameIdentity(frame.worker, inspected) || inspected.pid !== pid || inspected.processGroupId !== pid) {
      throw Object.assign(new Error("Startup connection claimed an identity that is not the spawned process-group leader"), { code: "WORKER_IDENTITY_MISMATCH" });
    }
    this.connection = connection;
    this.identity = inspected;
    this.connectionArrived.resolve(inspected);
    return inspected;
  }

  /** Hand one startup frame to its waiter, or hold it until the route is adopted. @param {any} frame */
  deliver(frame) {
    if (LAUNCH_CONTROL_TYPES.includes(frame?.type) && sameToken(frame?.token, this.token)) {
      const waiter = this.waiters.get(frame.type);
      if (waiter === undefined) {
        this.pending.push(frame);
        return;
      }
      this.waiters.delete(frame.type);
      waiter.resolve(frame);
      return;
    }
    if (this.buffered.length >= MAX_RESERVATION_BUFFERED_FRAMES) this.buffered.shift();
    this.buffered.push(frame);
  }

  /** @param {string} type @param {number} timeoutMs */
  waitFor(type, timeoutMs) {
    const queued = this.pending.findIndex((frame) => frame.type === type);
    if (queued >= 0) return Promise.resolve(this.pending.splice(queued, 1)[0]);
    if (this.closed) return Promise.reject(Object.assign(new Error("Launch reservation was released"), { code: "WORKER_CHANNEL_CLOSED" }));
    const waiter = deferred();
    this.waiters.set(type, waiter);
    const timer = setTimeout(() => {
      this.waiters.delete(type);
      waiter.reject(Object.assign(new Error(`Timed out waiting for ${type} on the control socket`), { code: "WORKER_START_TIMEOUT" }));
    }, timeoutMs);
    timer.unref?.();
    /** @type {Promise<any>} */
    const settled = waiter.promise;
    return settled.finally(() => clearTimeout(timer));
  }

  /** @param {any} message */
  async send(message) {
    if (this.connection === undefined) throw Object.assign(new Error("Startup connection is not bound"), { code: "WORKER_CHANNEL_CLOSED" });
    await this.connection.send(message);
  }

  /** Publish the adopted route so the connection's own handler takes over. @param {any} route */
  adopt(route) {
    this.route = route;
    this.onAdopted?.(this);
  }

  drainBuffered() {
    return this.buffered.splice(0);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionArrived.reject(Object.assign(new Error("Launch reservation was released"), { code: "WORKER_CHANNEL_CLOSED" }));
    for (const waiter of this.waiters.values()) waiter.reject(Object.assign(new Error("Launch reservation was released"), { code: "WORKER_CHANNEL_CLOSED" }));
    this.waiters.clear();
    this.release();
  }
}

/** @param {any} value */
function validIdentity(value) {
  return Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value.startIdentity === "string" && value.startIdentity.length > 0 && Number.isSafeInteger(value.processGroupId) && value.processGroupId > 0;
}

/**
 * A worker entry exists from the moment its run is reserved, which is before `spawn`, so both
 * process identities are absent until the launch binds them and present together afterwards.
 * @param {any} worker
 */
function validateWorkerMetadata(worker) {
  const allowed = ["sessionId", "runId", "leaseId", "generation", "identity", "piChildIdentity", "token", "proto", "cliVersion", "routeGeneration", "pendingRespawn"];
  const bound = worker?.identity !== undefined || worker?.piChildIdentity !== undefined;
  const counter = (/** @type {unknown} */ value) => value === undefined || (Number.isSafeInteger(value) && /** @type {number} */ (value) > 0);
  if (typeof worker !== "object" || worker === null || Array.isArray(worker) || Object.keys(worker).some((key) => !allowed.includes(key)) || [worker.sessionId, worker.runId, worker.leaseId].some((value) => typeof value !== "string" || value.length === 0) || !Number.isSafeInteger(worker.generation) || worker.generation <= 0 || (bound && (!validIdentity(worker.identity) || !validIdentity(worker.piChildIdentity))) || (worker.token !== undefined && (typeof worker.token !== "string" || worker.token.length === 0)) || !counter(worker.proto) || !counter(worker.routeGeneration) || (worker.pendingRespawn !== undefined && worker.pendingRespawn !== PENDING_RESPAWN_UPGRADE) || (worker.cliVersion !== undefined && (typeof worker.cliVersion !== "string" || worker.cliVersion.length === 0))) throw new TypeError("Worker recovery metadata record is invalid");
  return worker;
}

/**
 * A launch never outlives the daemon that ran it, so a still-"launching" record with no owning
 * worker at startup is provably abandoned rather than in flight.
 * @param {any} record
 */
export function abandonedLaunch(record) {
  return record?.activity?.kind === "launching" && record.ownership === undefined && record.processState === "EXITED";
}

/** @param {unknown} error */
function exited(error) {
  return error instanceof Error && ["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "");
}

/** @param {string} path @returns {Promise<any[]>} */
async function latestJournalRecords(path) {
  let text;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }
  const latest = new Map();
  for (const line of text.trimEnd().split("\n")) {
    if (line.length === 0) continue;
    const record = JSON.parse(line);
    if (record?.status?.clientId !== undefined && record?.status?.requestId !== undefined) latest.set(`${record.status.clientId}\0${record.status.requestId}`, record);
  }
  return [...latest.values()];
}

export class RecoveredWorkerRouter {
  #registry;
  #inspect;
  #metadataPath;
  #workers = new Map();
  #routes = new Map();
  #routeGenerations = new Map();
  #lifecycle;
  // Viewer frames mutate one session's normalized stream, not its registry record, so they order
  // against each other on their own queue instead of the lifecycle lock an attach or detach needs.
  #frames = new SessionCoordinator();
  #loaded = false;
  /** @type {Map<string, LaunchReservation>} */
  #reservations = new Map();
  #bindTimeoutMs;
  #cliVersion;

  /** @param {{ registry: RegistryStore, inspect(pid: number): Promise<any>, metadataPath: string, bindTimeoutMs?: number, cliVersion?: string }} options */
  constructor({ registry, inspect, metadataPath, bindTimeoutMs = 15_000, cliVersion = undefined }) {
    this.#registry = registry;
    this.#inspect = inspect;
    this.#metadataPath = metadataPath;
    this.#bindTimeoutMs = bindTimeoutMs;
    this.#cliVersion = cliVersion;
    this.#lifecycle = registryCoordinationScope(registry).lifecycle;
  }

  async load() {
    if (this.#loaded) return;
    try {
      const metadata = await fs.lstat(this.#metadataPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw new TypeError("Worker recovery metadata must be a private owned file");
      const value = JSON.parse(await fs.readFile(this.#metadataPath, "utf8"));
      if (value?.schemaVersion !== 1 || !Array.isArray(value.workers) || Object.keys(value).some((key) => !["schemaVersion", "workers"].includes(key))) throw new TypeError("Worker recovery metadata is invalid");
      for (const candidate of value.workers) {
        const worker = validateWorkerMetadata(candidate);
        if (this.#workers.has(worker.sessionId)) throw new TypeError("Worker recovery metadata contains duplicate sessions");
        // A reserved-but-unbound run can only be answered by the daemon that spawned it, so a
        // replacement daemon inherits nothing from it.
        if (worker.identity === undefined) continue;
        this.#workers.set(worker.sessionId, worker);
        // Route generations continue across daemon restarts, so a public generation that changed
        // reports a real reconnect rather than this daemon's own counter starting over.
        if (worker.routeGeneration !== undefined) this.#routeGenerations.set(worker.sessionId, worker.routeGeneration);
      }
    } catch (error) {
      if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    }
    this.#loaded = true;
  }

  async #persist() {
    await atomicWriteJson(this.#metadataPath, { schemaVersion: 1, workers: [...this.#workers.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)) });
  }

  /**
   * Reserve one run before its worker is spawned, so a startup connection that arrives before the
   * PID is published has something to wait on, and so a replacement daemon can authenticate the
   * same run from durable state.
   * @param {{ sessionId: string, runId: string, leaseId: string, generation: number, token: string, cliVersion?: string }} launch
   */
  async reserve(launch) {
    return this.#lifecycle.runNested(launch.sessionId, async () => {
      if (this.#reservations.has(launch.token)) throw Object.assign(new Error("Launch token is already reserved"), { code: "WORKER_TOKEN_REUSED" });
      const worker = validateWorkerMetadata({
        sessionId: launch.sessionId,
        runId: launch.runId,
        leaseId: launch.leaseId,
        generation: launch.generation,
        token: launch.token,
        proto: WORKER_PROTOCOL_VERSION,
        ...(launch.cliVersion === undefined ? {} : { cliVersion: launch.cliVersion }),
      });
      this.#workers.set(launch.sessionId, worker);
      await this.#persist();
      const reservation = new LaunchReservation({
        ...launch,
        inspect: (/** @type {number} */ pid) => this.#inspect(pid),
        release: () => { if (this.#reservations.get(launch.token) === reservation) this.#reservations.delete(launch.token); },
      });
      this.#reservations.set(launch.token, reservation);
      return reservation;
    });
  }

  /**
   * Claim one worker startup connection for the launch that minted its token. Returns undefined for
   * any frame that is not a startup hello, so a reconnecting worker still adopts its route directly.
   * @param {any} frame @param {any} connection @param {(reservation: LaunchReservation) => void} onAdopted
   */
  async beginLaunchConnection(frame, connection, onAdopted) {
    if (frame?.type !== "hello") return undefined;
    const allowed = ["version", "type", "token", "sessionId", "runId", "leaseId", "generation", "worker"];
    if (typeof frame !== "object" || Array.isArray(frame) || frame.version !== 1 || Object.keys(frame).some((key) => !allowed.includes(key))) throw Object.assign(new Error("Invalid worker hello frame"), { code: "INVALID_WORKER_FRAME" });
    const reservation = typeof frame.token === "string" ? this.#reservations.get(frame.token) : undefined;
    if (reservation === undefined || !sameToken(frame.token, reservation.token)) throw Object.assign(new Error("Worker hello does not match any launch this daemon spawned"), { code: "WORKER_AUTHENTICATION_FAILED" });
    reservation.onAdopted = onAdopted;
    await reservation.bind(frame, connection, this.#bindTimeoutMs);
    return reservation;
  }

  /** @param {any} handle */
  async register(handle) {
    return this.#lifecycle.runNested(handle.sessionId, async () => {
      const routeGeneration = (this.#routeGenerations.get(handle.sessionId) ?? 0) + 1;
      this.#routeGenerations.set(handle.sessionId, routeGeneration);
      const record = await this.#registry.get(handle.sessionId);
      if (record?.ownership === undefined || record.ownership.runId !== handle.runId || !sameIdentity(record.ownership.process, handle.identity)) throw Object.assign(new Error("Launched worker does not own the durable registry record"), { code: "OWNERSHIP_CONFLICT" });
      const reserved = this.#workers.get(handle.sessionId);
      // Adoption never rotates a run's token; the reservation minted it and a respawn mints a new one.
      const carried = reserved?.runId === handle.runId && reserved.leaseId === handle.leaseId ? reserved : undefined;
      this.#workers.set(handle.sessionId, {
        sessionId: handle.sessionId,
        runId: handle.runId,
        leaseId: handle.leaseId,
        generation: handle.generation,
        identity: handle.identity,
        piChildIdentity: handle.piChildIdentity,
        ...(carried?.token === undefined ? {} : { token: carried.token }),
        proto: WORKER_PROTOCOL_VERSION,
        ...(carried?.cliVersion === undefined ? {} : { cliVersion: carried.cliVersion }),
      });
      await this.#persist();
      const previous = this.#routes.get(handle.sessionId);
      if (previous !== undefined && previous.routeGeneration < routeGeneration) {
        this.#routes.delete(handle.sessionId);
        previous.connection.close?.();
      }
    });
  }

  /** Drop one run's durable worker entry, including its token. @param {string} sessionId @param {string} token */
  async forgetRun(sessionId, token) {
    return this.#lifecycle.runNested(sessionId, async () => {
      const current = this.#workers.get(sessionId);
      if (current === undefined || current.token !== token) return;
      this.#workers.delete(sessionId);
      const route = this.#routes.get(sessionId);
      this.#routes.delete(sessionId);
      await this.#persist();
      route?.connection.close?.();
    });
  }

  /** @param {string} sessionId */
  metadata(sessionId) {
    return this.#workers.get(sessionId);
  }

  /** Compare one worker's recorded release with this daemon's, which callers do only after adoption. @param {string} sessionId */
  releaseStatus(sessionId) {
    return workerReleaseStatus(this.#workers.get(sessionId)?.cliVersion, this.#cliVersion);
  }

  /**
   * Record that this exact run is to be replaced, before anything signals it. Only the run that still
   * owns the session may be marked, so a mark can never outlive the run it was decided for; the entry
   * and its mark are removed together when the run ends.
   * @param {string} sessionId @param {string} runId
   */
  async markPendingRespawn(sessionId, runId) {
    return this.#serializeRoute(sessionId, async () => {
      const worker = this.#workers.get(sessionId);
      if (worker === undefined || worker.runId !== runId) throw Object.assign(new Error("Pending replacement does not match the run that owns this session"), { code: "OWNERSHIP_CONFLICT" });
      if (worker.pendingRespawn === PENDING_RESPAWN_UPGRADE) return;
      worker.pendingRespawn = PENDING_RESPAWN_UPGRADE;
      await this.#persist();
    }, "router_mark_respawn");
  }

  /** @param {string} sessionId */
  pendingRespawn(sessionId) {
    return this.#workers.get(sessionId)?.pendingRespawn;
  }

  connectedSessionIds() {
    return [...this.#routes.keys()];
  }

  /** @template T @param {string} sessionId @param {() => Promise<T>} action @param {string} label */
  #serializeRoute(sessionId, action, label) {
    // Startup adoption runs inside the launch, which already holds this session's lifecycle lock.
    // Nesting is a no-op for every other caller, none of which holds it.
    return traceSessionLock(label, sessionId, (traced) => this.#lifecycle.runNested(sessionId, traced), action);
  }

  /**
   * Adopt one authenticated route from a worker's readiness frame. The frame may carry the model Pi
   * reported when the worker read its initial state; adoption only admits it, and the launch decides
   * whether to record it.
   * @param {any} frame @param {any} connection
   */
  async adopt(frame, connection) {
    const allowed = ["version", "type", "token", "sessionId", "runId", "leaseId", "generation", "worker", "piChild", "model"];
    if (typeof frame !== "object" || frame === null || Array.isArray(frame) || Object.keys(frame).some((key) => !allowed.includes(key)) || frame.version !== 1 || frame.type !== "worker_ready") throw Object.assign(new Error("Invalid worker ready frame"), { code: "INVALID_WORKER_FRAME" });
    return this.#serializeRoute(frame.sessionId, async () => {
      const expected = this.#workers.get(frame.sessionId);
      if (expected === undefined || expected.runId !== frame.runId || expected.leaseId !== frame.leaseId || expected.generation !== frame.generation || !sameIdentity(expected.identity, frame.worker) || !sameIdentity(expected.piChildIdentity, frame.piChild)) throw Object.assign(new Error("Worker ownership or generation conflicts with durable state"), { code: "OWNERSHIP_CONFLICT" });
      if (expected.token !== undefined && expected.token !== frame.token) throw Object.assign(new Error("Worker authentication failed"), { code: "WORKER_AUTHENTICATION_FAILED" });
      // Protocol compatibility is decided before anything else about this worker, and an incompatible
      // one simply stays unreachable: nothing here signals the process it belongs to.
      if (expected.proto !== undefined && expected.proto !== WORKER_PROTOCOL_VERSION) throw Object.assign(new Error(`Worker speaks protocol ${expected.proto}, not ${WORKER_PROTOCOL_VERSION}`), { code: "WORKER_PROTOCOL_INCOMPATIBLE" });
      const routeGeneration = (this.#routeGenerations.get(frame.sessionId) ?? 0) + 1;
      this.#routeGenerations.set(frame.sessionId, routeGeneration);
      const record = await this.#registry.get(frame.sessionId);
      if (this.#routeGenerations.get(frame.sessionId) !== routeGeneration) throw Object.assign(new Error("Worker connection was superseded during registration"), { code: "STALE_WORKER_CONNECTION" });
      if (record?.ownership === undefined || record.ownership.runId !== frame.runId || !sameIdentity(record.ownership.process, frame.worker)) throw Object.assign(new Error("Worker ownership or generation conflicts with durable state"), { code: "OWNERSHIP_CONFLICT" });
      const [actualWorker, actualPiChild] = await Promise.all([
        this.#inspect(frame.worker.pid),
        frame.piChild.pid === frame.worker.pid ? Promise.resolve(undefined) : this.#inspect(frame.piChild.pid),
      ]);
      if (this.#routeGenerations.get(frame.sessionId) !== routeGeneration) throw Object.assign(new Error("Worker connection was superseded during identity validation"), { code: "STALE_WORKER_CONNECTION" });
      if (!sameIdentity(actualWorker, frame.worker) || (actualPiChild !== undefined && !sameIdentity(actualPiChild, frame.piChild))) throw Object.assign(new Error("Worker or Pi-child process identity changed"), { code: "PROCESS_IDENTITY_CONFLICT" });
      if (expected.token === undefined) {
        if (typeof frame.token !== "string" || frame.token.length === 0) throw Object.assign(new Error("Worker authentication token is missing"), { code: "WORKER_AUTHENTICATION_FAILED" });
        expected.token = frame.token;
      }
      // An authenticated live version-1 route is itself the proof of a baseline record's protocol.
      expected.proto = WORKER_PROTOCOL_VERSION;
      expected.routeGeneration = routeGeneration;
      await this.#persist();
      const previous = this.#routes.get(frame.sessionId);
      const route = { connection, metadata: expected, routeGeneration };
      this.#routes.set(frame.sessionId, route);
      previous?.connection.close?.();
      connection.closed.finally(() => {
        if (this.#routes.get(frame.sessionId) === route) this.#routes.delete(frame.sessionId);
      }).catch(() => {});
      return route;
    }, "router_adopt");
  }

  /** @param {string} sessionId */
  route(sessionId) {
    return this.#routes.get(sessionId);
  }

  /** Serialize a daemon lifecycle action with route adoption, replacement, and worker frames. @param {string} sessionId @param {(state: any) => Promise<any>} action */
  runSession(sessionId, action) {
    return this.#serializeRoute(sessionId, async () => {
      const metadata = this.#workers.get(sessionId);
      const route = this.#routes.get(sessionId);
      let forgotten = false;
      return action({
        metadata,
        route,
        forget: async () => {
          if (forgotten) return;
          // A graceful stop kills the worker, which closes the route this action captured. An absent
          // route is that expected close; only a different route means the worker was replaced.
          const current = this.#routes.get(sessionId);
          if (this.#workers.get(sessionId) !== metadata || (current !== undefined && current !== route)) {
            throw Object.assign(new Error("Worker route changed during lifecycle action"), { code: "STALE_WORKER_CONNECTION" });
          }
          forgotten = true;
          this.#workers.delete(sessionId);
          this.#routes.delete(sessionId);
          await this.#persist();
          route?.connection.close?.();
        },
      });
    }, "router_session");
  }

  /** @param {any} metadata @param {any} connection @param {number} routeGeneration */
  #assertRoute(metadata, connection, routeGeneration) {
    const route = this.#routes.get(metadata?.sessionId);
    if (this.#workers.get(metadata?.sessionId) !== metadata || this.#routeGenerations.get(metadata?.sessionId) !== routeGeneration || route?.metadata !== metadata || route?.connection !== connection || route?.routeGeneration !== routeGeneration) throw Object.assign(new Error("Worker connection was replaced"), { code: "STALE_WORKER_CONNECTION" });
  }

  /** Verify the current route and both live process identities before one frame boundary. @param {any} metadata @param {any} connection @param {number} routeGeneration */
  async #assertCurrent(metadata, connection, routeGeneration) {
    this.#assertRoute(metadata, connection, routeGeneration);
    const record = await this.#registry.get(metadata.sessionId);
    this.#assertRoute(metadata, connection, routeGeneration);
    if (record?.ownership === undefined || record.ownership.runId !== metadata.runId || !sameIdentity(record.ownership.process, metadata.identity)) throw Object.assign(new Error("Worker no longer owns the durable session"), { code: "OWNERSHIP_CONFLICT" });
    const [actualWorker, actualPiChild] = await Promise.all([
      this.#inspect(metadata.identity.pid),
      metadata.piChildIdentity.pid === metadata.identity.pid ? Promise.resolve(undefined) : this.#inspect(metadata.piChildIdentity.pid),
    ]);
    this.#assertRoute(metadata, connection, routeGeneration);
    if (!sameIdentity(actualWorker, metadata.identity) || (actualPiChild !== undefined && !sameIdentity(actualPiChild, metadata.piChildIdentity))) throw Object.assign(new Error("Worker or Pi-child process identity changed"), { code: "PROCESS_IDENTITY_CONFLICT" });
    if (this.#workers.get(metadata.sessionId)?.leaseId !== metadata.leaseId || this.#workers.get(metadata.sessionId)?.generation !== metadata.generation) throw Object.assign(new Error("Worker lease or generation changed"), { code: "OWNERSHIP_CONFLICT" });
  }

  /** Serialize one worker frame against connection replacement. @param {any} metadata @param {any} connection @param {number} routeGeneration @param {() => Promise<any>} action */
  runCurrent(metadata, connection, routeGeneration, action) {
    return this.#serializeRoute(metadata.sessionId, async () => {
      await this.#assertCurrent(metadata, connection, routeGeneration);
      return action();
    }, "router_frame");
  }

  /** Ingest one session's viewer frames in arrival order, off the lifecycle lock. @template T @param {string} sessionId @param {() => Promise<T>} action */
  runFrame(sessionId, action) {
    return traceSessionLock("viewer_ingest", sessionId, (traced) => this.#frames.run(sessionId, traced), action);
  }

  /**
   * Check this frame's route and both process identities, then ingest it in arrival order. The
   * identity check re-reads the route after every await, so the only window a concurrent adopt can
   * win is between the last check and the ingest, where a late frame costs a duplicate viewer event
   * rather than a registry write.
   * @param {any} metadata @param {any} connection @param {number} routeGeneration @param {() => Promise<any>} action
   */
  runCurrentFrame(metadata, connection, routeGeneration, action) {
    return this.runFrame(metadata.sessionId, async () => {
      await this.#assertCurrent(metadata, connection, routeGeneration);
      return action();
    });
  }

  async close() {
    for (const reservation of [...this.#reservations.values()]) reservation.close();
    const routes = [...this.#routes.values()];
    this.#routes.clear();
    for (const route of routes) route.connection.close?.();
    await Promise.all([this.#lifecycle.idle(), this.#frames.idle()]);
  }
}

/** Recover every per-session normalized stream before daemon mutation admission. @param {{ root: string, daemonEpoch: string, registry: RegistryStore }} options */
async function createViewerRecovery({ root, daemonEpoch, registry }) {
  const directory = join(root, "index", "viewer");
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** One in-flight open per session, so a second caller joins the first instead of building its own store. @type {Map<string, Promise<any>>} */
  const opening = new Map();

  /** @param {any} state */
  async function publish(state) {
    const current = await registry.get(state.sessionId);
    if (current === undefined) throw Object.assign(new Error(`Unknown viewer session: ${state.sessionId}`), { code: "SESSION_NOT_FOUND" });
    const snapshot = state.normalizer.snapshot({
      daemonEpoch,
      sequence: state.store.currentCursor().sequence,
      registryRevision: current.revision,
      runtime: current.runtime ?? null,
      model: current.model ?? null,
      thinkingLevel: current.thinkingLevel ?? null,
      taskState: current.taskState,
      processState: current.processState,
      outcome: current.outcome,
    });
    return state.store.publishSnapshot(snapshot, state.normalizer.checkpoint());
  }

  /** @param {any} state */
  async function readHistory(state) {
    const history = await state.reader.read();
    for (const error of history.errors) state.normalizer.consumeError(error);
    for (const item of history.entries) {
      const drafts = state.normalizer.consumeHistory(item.entry, { ...item.position, sourceId: item.sourceId });
      for (const draft of drafts) {
        try {
          await state.store.append(draft);
        } catch (error) {
          // A published event is authoritative: frontends already consumed it at that cursor, so re-derived drift never rewrites history.
          if (/** @type {any} */ (error)?.code !== "VIEWER_EVENT_ID_CONFLICT") throw error;
        }
      }
    }
  }

  /**
   * Join whichever attempt is already opening this session, or start the only one. The in-flight
   * promise is recorded before this function's first await, so two concurrent callers cannot both
   * reach openNewSession and drop the loser's event, checkpoint and history handles unclosed. A
   * rejected attempt is forgotten rather than cached, so the next caller opens the session again.
   * @param {any} record
   */
  async function openSession(record) {
    const inFlight = opening.get(record.sessionId);
    if (inFlight !== undefined) return inFlight;
    const existing = sessions.get(record.sessionId);
    if (existing !== undefined) return existing;
    const attempt = openNewSession(record);
    opening.set(record.sessionId, attempt);
    try { return await attempt; } finally { opening.delete(record.sessionId); }
  }

  /** @param {any} record */
  async function openNewSession(record) {
    const store = await createViewerStore({ directory, sessionId: record.sessionId, daemonEpoch });
    const normalizer = createViewerNormalizer({ sessionId: record.sessionId, protocolVersion: 1, now: () => new Date().toISOString() });
    let reader;
    try {
      reader = await createSessionHistoryReader({ path: record.canonicalSessionFile });
    } catch (error) {
      const missing = /** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT";
      if (!missing && !(error instanceof SessionHistoryError)) throw error;
      const historyError = /** @type {SessionHistoryError} */ (error);
      normalizer.consumeError({ code: missing ? "SESSION_HISTORY_MISSING" : historyError.code, message: missing ? "Canonical session history is unavailable" : historyError.message, retryable: missing });
      reader = { async read() { return { entries: [], errors: [], position: { byteOffset: 0, line: 0 } }; }, async close() {} };
    }
    const state = { sessionId: record.sessionId, store, normalizer, reader };
    sessions.set(record.sessionId, state);
    const snapshot = await store.getSnapshot();
    if (snapshot !== undefined) normalizer.restore(snapshot);
    const replay = await store.replay(snapshot?.cursor);
    for (const event of replay) normalizer.applyViewerEvent(event);
    const checkpoint = await store.getCheckpoint();
    if (checkpoint !== undefined) normalizer.restoreCheckpoint(checkpoint);
    await readHistory(state);
    await publish(state);
    return state;
  }

  try {
    for (const record of await registry.list()) await openSession(record);
  } catch (error) {
    await Promise.allSettled([...sessions.values()].flatMap((state) => [state.reader.close(), state.store.close()]));
    throw error;
  }

  return {
    /** @param {string} sessionId */
    async ensure(sessionId) {
      const record = await registry.get(sessionId);
      if (record === undefined) throw Object.assign(new Error(`Unknown viewer session: ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      return openSession(record);
    },
    /** @param {string} sessionId @param {any} frame */
    async ingest(sessionId, frame) {
      const state = sessions.get(sessionId);
      if (state === undefined) throw Object.assign(new Error(`Unknown viewer session: ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      /** @type {any[]} */
      const persisted = [];
      for (const draft of state.normalizer.consumeFrame(frame)) persisted.push(await state.store.append(draft));
      await publish(state);
      return persisted;
    },
    /**
     * One session's normalized transcript and cursor, read from memory. Unlike snapshot it reads no
     * canonical history and publishes no snapshot, so background work never puts a durable write on
     * a request the operator is waiting behind.
     * @param {string} sessionId
     */
    transcript(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) return undefined;
      return { sequence: state.store.currentCursor().sequence, items: state.normalizer.transcriptItems() };
    },
    /** @param {string} sessionId */
    async snapshot(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) throw Object.assign(new Error(`Unknown viewer session: ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      await readHistory(state);
      return publish(state);
    },
    /** @param {string} sessionId */
    store(sessionId) { return sessions.get(sessionId)?.store; },
    async close() {
      const results = await Promise.allSettled([...sessions.values()].flatMap((state) => [state.reader.close(), state.store.close()]));
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, "Viewer recovery stores closed with errors");
    },
  };
}

/** @param {{ root: string, daemonEpoch: string, inspect(pid: number): Promise<any>, waitForReconnect?: (workers: any[], router: RecoveredWorkerRouter) => Promise<string[]>, onViewerReady?: (viewer: any) => void | Promise<void>, router?: RecoveredWorkerRouter, signal?: AbortSignal }} options */
export async function reconcileRuntime({ root, daemonEpoch, inspect, waitForReconnect = async () => [], onViewerReady = () => {}, router: suppliedRouter, signal }) {
  const registry = new RegistryStore(join(root, "sessions"));
  const journalPath = join(root, "queue", "commands.jsonl");
  /** @type {any} */
  let journal;
  /** @type {any} */
  let viewer;
  const router = suppliedRouter ?? new RecoveredWorkerRouter({ registry, inspect, metadataPath: join(root, "daemon", "workers.json") });
  const cancelled = () => {
    if (signal?.aborted) throw Object.assign(new Error("Reconciliation was cancelled"), { code: "RECONCILIATION_CANCELLED" });
  };
  try {
    cancelled();
    journal = await createCommandJournal({ path: journalPath });
    cancelled();
    await router.load();
    viewer = await createViewerRecovery({ root, daemonEpoch, registry });
    await onViewerReady(viewer);
    cancelled();
    /** Session records this recovery rewrote. The list is invalidated once for all of them. @type {any[]} */
    const repairedSessions = [];
    for (const record of await registry.list()) {
      cancelled();
      if (!abandonedLaunch(record)) continue;
      const next = reduceSessionState(record, { type: "LAUNCH_ABANDONED", at: new Date().toISOString() });
      const updated = await registry.update(record.sessionId, record.revision, {
        taskState: next.taskState,
        processState: next.processState,
        outcome: next.outcome,
        activity: next.activity,
        updatedAt: next.updatedAt,
      });
      repairedSessions.push(updated);
    }
    cancelled();
    /**
     * The Pi child, not the supervisor, holds the canonical session file open. A supervisor that is gone
     * or replaced only frees the lease once its recorded child is gone or replaced too.
     * @param {any} record @param {string} supervisorReason
     */
    const reclaimOrConflict = async (record, supervisorReason) => {
      const metadata = router.metadata(record.sessionId);
      if (metadata === undefined) return { reason: supervisorReason, ownership: record.ownership };
      try {
        if (sameIdentity(await inspect(metadata.piChildIdentity.pid), metadata.piChildIdentity)) {
          return { reason: "PI_CHILD_ORPHANED", ownership: record.ownership, metadata };
        }
      } catch (error) {
        if (!exited(error)) return { reason: "PI_CHILD_IDENTITY_AMBIGUOUS", ownership: record.ownership, metadata };
      }
      return router.runSession(record.sessionId, async (/** @type {any} */ { forget }) => {
        const current = await registry.get(record.sessionId);
        if (current === undefined || current.revision !== record.revision || current.ownership === undefined) {
          return { reason: supervisorReason, ownership: record.ownership, metadata };
        }
        const next = reduceSessionState(current, { type: "WORKER_EXITED", at: new Date().toISOString() });
        const updated = await registry.update(current.sessionId, current.revision, {
          taskState: next.taskState,
          processState: next.processState,
          outcome: next.outcome,
          activity: next.activity,
          updatedAt: next.updatedAt,
          ownership: undefined,
        });
        // Worker metadata is what lets a later daemon find this child again, so it is forgotten only now.
        await forget();
        repairedSessions.push(updated);
        return undefined;
      });
    };
    /** @type {any[]} */
    const liveWorkers = [];
    /** @type {any[]} */
    const conflicts = [];
    for (const record of await registry.list()) {
      cancelled();
      if (record.ownership === undefined) continue;
      let actual;
      try {
        actual = await inspect(record.ownership.process.pid);
      } catch (error) {
        if (!exited(error)) {
          conflicts.push({ sessionId: record.sessionId, reason: "PROCESS_IDENTITY_AMBIGUOUS", ownership: record.ownership });
          continue;
        }
        const unresolved = await reclaimOrConflict(record, "WORKER_EXITED");
        if (unresolved !== undefined) conflicts.push({ sessionId: record.sessionId, ...unresolved });
        continue;
      }
      if (!sameIdentity(actual, record.ownership.process)) {
        const unresolved = await reclaimOrConflict(record, "PROCESS_IDENTITY_MISMATCH");
        if (unresolved !== undefined) conflicts.push({ sessionId: record.sessionId, actual, ...unresolved });
        continue;
      }
      const metadata = router.metadata(record.sessionId);
      if (metadata === undefined) {
        conflicts.push({ sessionId: record.sessionId, reason: "OWNERSHIP_METADATA_MISSING", ownership: record.ownership });
        continue;
      }
      if (metadata.runId !== record.ownership.runId || !sameIdentity(metadata.identity, actual)) {
        conflicts.push({ sessionId: record.sessionId, reason: "OWNERSHIP_METADATA_CONFLICT", ownership: record.ownership, metadata });
        continue;
      }
      let piChild;
      try {
        piChild = metadata.piChildIdentity.pid === metadata.identity.pid ? actual : await inspect(metadata.piChildIdentity.pid);
      } catch (error) {
        conflicts.push({ sessionId: record.sessionId, reason: exited(error) ? "PI_CHILD_EXITED" : "PI_CHILD_IDENTITY_AMBIGUOUS", ownership: record.ownership, metadata });
        continue;
      }
      if (!sameIdentity(piChild, metadata.piChildIdentity)) {
        conflicts.push({ sessionId: record.sessionId, reason: "PI_CHILD_IDENTITY_MISMATCH", ownership: record.ownership, metadata, actual: piChild });
        continue;
      }
      liveWorkers.push({ sessionId: record.sessionId, runId: record.ownership.runId, identity: actual, piChildIdentity: piChild, metadata });
    }
    cancelled();
    const reconnected = new Set(await waitForReconnect(liveWorkers, router));
    cancelled();
    for (const worker of liveWorkers) {
      if (!reconnected.has(worker.sessionId) && !router.connectedSessionIds().includes(worker.sessionId)) conflicts.push({ sessionId: worker.sessionId, reason: "WORKER_RECONNECT_TIMEOUT", ownership: worker });
    }
    const commands = await latestJournalRecords(journalPath);
    const recoveryActions = commands.map((record) => ({
      clientId: record.status.clientId,
      requestId: record.status.requestId,
      sessionId: record.command?.payload?.sessionId,
      command: record.command,
      action: record.status.stage === "ACCEPTED" ? "SAFE_REDELIVERY" : record.status.stage === "DELIVERY_UNKNOWN" ? "DELIVERY_AMBIGUOUS" : "NO_REDELIVERY",
    }));
    await atomicWriteJson(join(root, "daemon", "reconciliation.json"), { schemaVersion: 1, daemonEpoch, completedAt: new Date().toISOString(), conflicts, recoveryActions });
    return {
      registry,
      journal,
      router,
      liveWorkers,
      conflicts,
      repairedSessions,
      recoveryActions,
      viewer,
      async close() {
        const results = await Promise.allSettled([router.close(), journal.close(), viewer.close()]);
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length > 0) throw new AggregateError(errors, "Reconciliation stores closed with errors");
      },
    };
  } catch (error) {
    await Promise.allSettled([journal?.close(), viewer?.close()]);
    if (suppliedRouter === undefined) await router.close().catch(() => {});
    throw error;
  }
}
