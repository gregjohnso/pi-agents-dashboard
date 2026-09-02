import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteJson } from "./atomic-file.mjs";
import { traceSessionLock } from "./lock-trace.mjs";
import { RegistryStore, registryCoordinationScope } from "./registry-store.mjs";
import { SessionCoordinator } from "./session-coordinator.mjs";
import { createSessionHistoryReader, SessionHistoryError } from "./session-history.mjs";
import { reduceSessionState } from "./state-reducer.mjs";
import { createViewerNormalizer } from "./viewer-normalizer.mjs";
import { createViewerStream } from "./viewer-stream.mjs";
import { WORKER_SOCKET_PROTOCOL, connectToWorker } from "./worker-socket.mjs";
import { readWorkerTerminalCause, retireWorkerTerminalCause, validWorkerTerminalCause, workerTerminalCausePath } from "./worker-terminal-cause.mjs";

/** Frames the startup connection carries before its route is adopted. */
const LAUNCH_CONTROL_TYPES = ["hello", "pi_child", "worker_ready"];
/** A startup connection holds only what the launch has not consumed yet; a flood is a defect, not backpressure. */
const MAX_RESERVATION_BUFFERED_FRAMES = 256;
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
 * The daemon names this run's socket here, before anything is spawned, and connects to it once the
 * worker is listening. Nothing creates that path until the worker does, so a daemon that dies
 * between the reservation and the spawn leaves no socket a later daemon could read as a live worker.
 */
class LaunchReservation {
  /** @param {any} options */
  constructor({ token, sessionId, runId, leaseId, generation, socketPath, maxBytes, inspect, connect, release }) {
    this.token = token;
    this.sessionId = sessionId;
    this.runId = runId;
    this.leaseId = leaseId;
    this.generation = generation;
    this.socketPath = socketPath;
    this.maxBytes = maxBytes;
    this.inspect = inspect;
    this.connect = connect;
    this.release = release;
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
    /** Detach this launch's frame listener once the route it established takes them over. */
    this.stopDelivering = () => {};
    this.closed = false;
  }

  /**
   * Connect to the worker this launch just spawned and verify who answered.
   *
   * The PID is already known here, because the daemon connects rather than being connected to; the
   * only wait is for the worker to reach `listen`, which the connect retries through.
   * @param {number} pid @param {number} timeoutMs
   */
  async connected(pid, timeoutMs) {
    if (this.connection !== undefined) throw Object.assign(new Error("This launch is already connected"), { code: "WORKER_ALREADY_CONNECTED" });
    const connection = await this.connect({ socketPath: this.socketPath, token: this.token, maxBytes: this.maxBytes, timeoutMs });
    if (this.closed) {
      connection.close?.();
      throw Object.assign(new Error("Launch reservation was released"), { code: "WORKER_CHANNEL_CLOSED" });
    }
    this.connection = connection;
    this.stopDelivering = connection.onMessage((/** @type {any} */ frame) => this.deliver(frame));
    const frame = await this.waitFor("hello", timeoutMs);
    if (!sameToken(frame.token, this.token) || frame.sessionId !== this.sessionId || frame.runId !== this.runId || frame.leaseId !== this.leaseId || frame.generation !== this.generation) {
      throw Object.assign(new Error("Worker socket did not answer for the reserved launch"), { code: "WORKER_HELLO_MISMATCH" });
    }
    const inspected = await this.inspect(pid);
    if (!sameIdentity(frame.worker, inspected) || inspected.pid !== pid || inspected.processGroupId !== pid) {
      throw Object.assign(new Error("Worker socket claimed an identity that is not the spawned process-group leader"), { code: "WORKER_IDENTITY_MISMATCH" });
    }
    this.identity = inspected;
    return inspected;
  }

  /** Hand one startup frame to its waiter, or hold it until the route is adopted. @param {any} frame */
  deliver(frame) {
    // The token is checked by each frame's own consumer rather than here, so a frame carrying the
    // wrong one is refused by name instead of leaving its launch waiting out the startup bound.
    if (LAUNCH_CONTROL_TYPES.includes(frame?.type)) {
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
    for (const waiter of this.waiters.values()) waiter.reject(Object.assign(new Error("Launch reservation was released"), { code: "WORKER_CHANNEL_CLOSED" }));
    this.waiters.clear();
    // A launch that never adopted its route owns this connection, so releasing the reservation closes
    // it. Once adopted the route owns it, and the daemon keeps it.
    if (this.route === undefined) this.connection?.close?.();
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
  const allowed = ["sessionId", "runId", "leaseId", "generation", "identity", "piChildIdentity", "token", "socketPath", "proto", "cliVersion", "routeGeneration", "pendingRespawn"];
  const bound = worker?.identity !== undefined || worker?.piChildIdentity !== undefined;
  const counter = (/** @type {unknown} */ value) => value === undefined || (Number.isSafeInteger(value) && /** @type {number} */ (value) > 0);
  if (typeof worker !== "object" || worker === null || Array.isArray(worker) || Object.keys(worker).some((key) => !allowed.includes(key)) || [worker.sessionId, worker.runId, worker.leaseId].some((value) => typeof value !== "string" || value.length === 0) || !Number.isSafeInteger(worker.generation) || worker.generation <= 0 || (bound && (!validIdentity(worker.identity) || !validIdentity(worker.piChildIdentity))) || (worker.token !== undefined && (typeof worker.token !== "string" || worker.token.length === 0)) || (worker.socketPath !== undefined && (typeof worker.socketPath !== "string" || worker.socketPath.length === 0)) || !counter(worker.proto) || !counter(worker.routeGeneration) || (worker.pendingRespawn !== undefined && worker.pendingRespawn !== PENDING_RESPAWN_UPGRADE) || (worker.cliVersion !== undefined && (typeof worker.cliVersion !== "string" || worker.cliVersion.length === 0))) throw new TypeError("Worker recovery metadata record is invalid");
  return worker;
}

/**
 * A live worker this daemon could not connect to. It is a report, never a signal: the worker is Pi's
 * parent and keeps running, so the session stays live, says on its own row why it is out of reach,
 * and is still stoppable by recorded process identity. Every other conflict still refuses the start.
 */
export const WORKER_UNREACHABLE = "WORKER_UNREACHABLE";
/**
 * A live worker whose recorded Pi child is provably gone and whose durable cause recovery already
 * recorded. The worker still holds its lease, so this is a report about one session, not a conflict
 * that may refuse the start and take every other session down with it.
 */
export const PI_CHILD_CRASH_REPORTED = "PI_CHILD_CRASH_REPORTED";

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

/**
 * A short, unique file name for one run's worker socket.
 *
 * Short because a Unix socket path is bounded at 108 bytes on Linux and a state root under a home
 * directory already spends half of that; unique because a respawn is a new run under the same
 * session, and two runs must never name the same socket. It carries no secret: the run's token
 * authenticates the connection, and this only has to be distinct.
 * @param {{ sessionId: string, runId: string, generation: number }} run
 */
function runSocketName(run) {
  return createHash("sha256").update(`${run.sessionId}\0${run.runId}\0${run.generation}`, "utf8").digest("hex").slice(0, 16);
}

/**
 * Remove one ended run's socket file. The worker unlinks its own on a graceful stop; this covers the
 * run that was killed, so a path a later daemon would only be refused by does not survive its run.
 * @param {{ socketPath?: string }} worker
 */
async function forgetSocket(worker) {
  if (typeof worker?.socketPath !== "string") return;
  await fs.unlink(worker.socketPath).catch(() => {});
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
  #socketsDirectory;
  #maxBytes;
  #connect;
  #onWorkerFrame;
  #onRouteAdopted;
  #onWorkerUnreachable;
  #reconnectTimeoutMs;
  #closing = false;
  #cliVersion;

  /**
   * @param {{ registry: RegistryStore, inspect(pid: number): Promise<any>, metadataPath: string, maxBytes?: number, connect?: (options: { socketPath: string, token: string, maxBytes: number, timeoutMs: number }) => Promise<any>, onWorkerFrame?: (frame: any, connection: any, metadata: any, routeGeneration: number) => Promise<void>, onRouteAdopted?: (route: any, launched: boolean) => Promise<void>, onWorkerUnreachable?: (report: { sessionId: string, cause: string, message: string }) => void, reconnectTimeoutMs?: number, cliVersion?: string }} options
   */
  constructor({ registry, inspect, metadataPath, maxBytes = 1024 * 1024, connect = connectToWorker, onWorkerFrame = async () => {}, onRouteAdopted = async () => {}, onWorkerUnreachable = () => {}, reconnectTimeoutMs = 15_000, cliVersion = undefined }) {
    this.#registry = registry;
    this.#inspect = inspect;
    this.#metadataPath = metadataPath;
    this.#socketsDirectory = join(dirname(metadataPath), "workers");
    this.#maxBytes = maxBytes;
    this.#connect = connect;
    this.#onWorkerFrame = onWorkerFrame;
    this.#onRouteAdopted = onRouteAdopted;
    this.#onWorkerUnreachable = onWorkerUnreachable;
    this.#reconnectTimeoutMs = reconnectTimeoutMs;
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
   * Reserve one run, naming the socket its worker will listen on, before anything is spawned.
   *
   * The path is durable state from this moment, so a replacement daemon reconnects to the same run
   * from `daemon/workers.json` alone. Nothing here creates the path: the worker does, by listening.
   * @param {{ sessionId: string, runId: string, leaseId: string, generation: number, token: string, cliVersion?: string }} launch
   */
  async reserve(launch) {
    return this.#lifecycle.runNested(launch.sessionId, async () => {
      if (this.#reservations.has(launch.token)) throw Object.assign(new Error("Launch token is already reserved"), { code: "WORKER_TOKEN_REUSED" });
      await fs.mkdir(this.#socketsDirectory, { recursive: true, mode: 0o700 });
      const socketPath = join(this.#socketsDirectory, `${runSocketName(launch)}.sock`);
      const worker = validateWorkerMetadata({
        sessionId: launch.sessionId,
        runId: launch.runId,
        leaseId: launch.leaseId,
        generation: launch.generation,
        token: launch.token,
        socketPath,
        proto: WORKER_SOCKET_PROTOCOL,
        ...(launch.cliVersion === undefined ? {} : { cliVersion: launch.cliVersion }),
      });
      this.#workers.set(launch.sessionId, worker);
      await this.#persist();
      const reservation = new LaunchReservation({
        ...launch,
        socketPath,
        maxBytes: this.#maxBytes,
        inspect: (/** @type {number} */ pid) => this.#inspect(pid),
        connect: this.#connect,
        release: () => { if (this.#reservations.get(launch.token) === reservation) this.#reservations.delete(launch.token); },
      });
      // The launch owns this connection's frames until its route exists; from adoption the route does.
      reservation.onAdopted = (/** @type {LaunchReservation} */ adopted) => {
        adopted.stopDelivering();
        this.#serveConnection(adopted.connection, true, adopted.drainBuffered()).adopted(adopted.route);
      };
      this.#reservations.set(launch.token, reservation);
      return reservation;
    });
  }

  /**
   * Hold one connection's frames until its route exists, then deliver them in arrival order.
   *
   * A worker writes its readiness and its live tail in one step, so the tail is already in flight
   * while adoption is still running. Buffering it here is what keeps a rebuild from losing the only
   * copy of the frames Pi has not written to its own file yet.
   * @param {any} connection @param {boolean} launched @param {any[]} [initialFrames]
   */
  #serveConnection(connection, launched, initialFrames = []) {
    const buffered = [...initialFrames];
    /** @type {any} */
    let route;
    let chain = Promise.resolve();
    /** @param {any} frame */
    const run = (frame) => {
      chain = chain.then(() => this.#onWorkerFrame(frame, connection, route.metadata, route.routeGeneration)).catch(() => connection.close?.());
    };
    connection.onMessage((/** @type {any} */ frame) => {
      // The frame that establishes a route is never one of the frames routed over it.
      if (frame?.type === "worker_ready") return;
      if (route === undefined) buffered.push(frame);
      else run(frame);
    });
    return {
      /** @param {any} adopted */
      adopted: (adopted) => {
        route = adopted;
        chain = chain.then(() => this.#onRouteAdopted(adopted, launched)).catch(() => {});
        for (const frame of buffered.splice(0)) run(frame);
      },
    };
  }

  /**
   * Connect to one live worker's own socket and adopt the route it answers with.
   *
   * This is what a daemon replacement costs now: the roster names the socket and the token, so
   * adoption is a connect and a readiness frame rather than a negotiation over a connection the
   * worker had to start. A run this daemon cannot reach is reported, never signalled.
   * @param {string} sessionId @param {number} timeoutMs
   */
  async connectRun(sessionId, timeoutMs) {
    const metadata = this.#workers.get(sessionId);
    if (metadata === undefined) throw Object.assign(new Error("No reserved run owns this session"), { code: "WORKER_METADATA_MISSING" });
    if (metadata.proto !== WORKER_SOCKET_PROTOCOL || typeof metadata.socketPath !== "string" || typeof metadata.token !== "string") {
      throw Object.assign(new Error(`This session's worker speaks worker protocol ${metadata.proto ?? 1}, not ${WORKER_SOCKET_PROTOCOL}: it listens on no socket, so this daemon cannot reach it`), { code: "WORKER_PROTOCOL_INCOMPATIBLE" });
    }
    const connection = await this.#connect({ socketPath: metadata.socketPath, token: metadata.token, maxBytes: this.#maxBytes, timeoutMs });
    /** @type {any} */
    let resolveReady;
    /** @type {any} */
    let rejectReady;
    const readyFrame = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const removeReadyListener = connection.onMessage((/** @type {any} */ frame) => { if (frame?.type === "worker_ready") resolveReady(frame); });
    const timer = setTimeout(() => rejectReady(Object.assign(new Error("Worker did not announce readiness on its own socket"), { code: "WORKER_START_TIMEOUT" })), timeoutMs);
    timer.unref?.();
    connection.closed.then(() => rejectReady(Object.assign(new Error("Worker socket closed before readiness"), { code: "WORKER_SOCKET_UNREACHABLE" })), () => {});
    try {
      const served = this.#serveConnection(connection, false);
      const ready = await readyFrame;
      removeReadyListener();
      const route = await this.adopt(ready, connection);
      served.adopted(route);
      return route;
    } catch (error) {
      connection.close?.();
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
        ...(carried?.socketPath === undefined ? {} : { socketPath: carried.socketPath }),
        proto: WORKER_SOCKET_PROTOCOL,
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

  /** Drop one run's durable worker entry, including its token and its socket. @param {string} sessionId @param {string} token */
  async forgetRun(sessionId, token) {
    return this.#lifecycle.runNested(sessionId, async () => {
      const current = this.#workers.get(sessionId);
      if (current === undefined || current.token !== token) return;
      this.#workers.delete(sessionId);
      const route = this.#routes.get(sessionId);
      this.#routes.delete(sessionId);
      await this.#persist();
      await forgetSocket(current);
      route?.connection.close?.();
    });
  }

  /** @param {string} sessionId */
  metadata(sessionId) {
    return this.#workers.get(sessionId);
  }

  /** The launch this daemon reserved under one run token, while that launch is still running. @param {string} token */
  reservationFor(token) {
    return this.#reservations.get(token);
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
      if (expected.proto !== undefined && expected.proto !== WORKER_SOCKET_PROTOCOL) throw Object.assign(new Error(`Worker speaks protocol ${expected.proto}, not ${WORKER_SOCKET_PROTOCOL}`), { code: "WORKER_PROTOCOL_INCOMPATIBLE" });
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
      expected.proto = WORKER_SOCKET_PROTOCOL;
      expected.routeGeneration = routeGeneration;
      await this.#persist();
      const previous = this.#routes.get(frame.sessionId);
      const route = { connection, metadata: expected, routeGeneration };
      this.#routes.set(frame.sessionId, route);
      previous?.connection.close?.();
      connection.closed.finally(() => {
        if (this.#routes.get(frame.sessionId) !== route) return;
        this.#routes.delete(frame.sessionId);
        // The worker owns the socket and outlives this connection, so a route that drops is this
        // daemon's to re-open. Leaving it closed would strand a live session in silence until the
        // next daemon start; a reconnect that fails reports the run unreachable instead.
        void this.#reopenRoute(frame.sessionId, expected.runId);
      }).catch(() => {});
      return route;
    }, "router_adopt");
  }

  /** @param {string} sessionId */
  route(sessionId) {
    return this.#routes.get(sessionId);
  }

  /**
   * Re-open one live run's route after its connection dropped. Only the run that still owns the
   * session is re-opened, and never during shutdown: a deliberate close must stay closed.
   * @param {string} sessionId @param {string} runId
   */
  async #reopenRoute(sessionId, runId) {
    if (this.#closing || this.#workers.get(sessionId)?.runId !== runId || this.#routes.has(sessionId)) return;
    try {
      await this.connectRun(sessionId, this.#reconnectTimeoutMs);
    } catch (error) {
      if (this.#closing || this.#workers.get(sessionId)?.runId !== runId) return;
      const failure = /** @type {any} */ (error);
      this.#onWorkerUnreachable({ sessionId, cause: failure?.code ?? "WORKER_SOCKET_UNREACHABLE", message: error instanceof Error ? error.message : "Worker socket is unreachable" });
    }
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
          await forgetSocket(metadata);
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

  /**
   * Verify one terminal frame against the current route, ownership, lease, and live worker identity,
   * and against the durable cause when the worker published one. The Pi child has exited by
   * definition, so nothing here inspects it: only its recorded identity is compared.
   * @param {any} metadata @param {any} connection @param {number} routeGeneration @param {any} cause
   */
  async #assertCurrentTerminal(metadata, connection, routeGeneration, cause) {
    this.#assertRoute(metadata, connection, routeGeneration);
    const record = await this.#registry.get(metadata.sessionId);
    this.#assertRoute(metadata, connection, routeGeneration);
    if (record?.ownership === undefined || record.ownership.runId !== metadata.runId || !sameIdentity(record.ownership.process, metadata.identity)) throw Object.assign(new Error("Worker no longer owns the durable session"), { code: "OWNERSHIP_CONFLICT" });
    if (this.#workers.get(metadata.sessionId)?.leaseId !== metadata.leaseId || this.#workers.get(metadata.sessionId)?.generation !== metadata.generation) throw Object.assign(new Error("Worker lease or generation changed"), { code: "OWNERSHIP_CONFLICT" });
    if (cause !== undefined && !validWorkerTerminalCause(cause, { sessionId: metadata.sessionId, runId: metadata.runId, leaseId: metadata.leaseId, generation: metadata.generation, worker: metadata.identity, piChild: metadata.piChildIdentity })) throw Object.assign(new Error("Terminal cause does not match the owning run"), { code: "OWNERSHIP_CONFLICT" });
    const actualWorker = await this.#inspect(metadata.identity.pid);
    this.#assertRoute(metadata, connection, routeGeneration);
    if (!sameIdentity(actualWorker, metadata.identity)) throw Object.assign(new Error("Worker process identity changed"), { code: "PROCESS_IDENTITY_CONFLICT" });
    return record;
  }

  /** Serialize one terminal frame the worker backed with a durable cause. @param {any} metadata @param {any} connection @param {number} routeGeneration @param {any} cause @param {(record: any) => Promise<any>} action */
  runCurrentTerminal(metadata, connection, routeGeneration, cause, action) {
    return this.#serializeRoute(metadata.sessionId, async () => action(await this.#assertCurrentTerminal(metadata, connection, routeGeneration, cause)), "router_terminal_frame");
  }

  /**
   * Serialize one terminal frame from a worker that published no durable cause, which is what a
   * worker built before that format sends. Everything but the cause is verified as it is for a
   * cause-backed frame, and the exited Pi child is not inspected: this frame is the report of its
   * exit, so requiring it to answer would refuse every legacy crash and drop the route with it.
   * @param {any} metadata @param {any} connection @param {number} routeGeneration @param {(record: any) => Promise<any>} action
   */
  runCurrentTerminalEvent(metadata, connection, routeGeneration, action) {
    return this.#serializeRoute(metadata.sessionId, async () => action(await this.#assertCurrentTerminal(metadata, connection, routeGeneration, undefined)), "router_terminal_frame");
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
    this.#closing = true;
    for (const reservation of [...this.#reservations.values()]) reservation.close();
    const routes = [...this.#routes.values()];
    this.#routes.clear();
    for (const route of routes) route.connection.close?.();
    await Promise.all([this.#lifecycle.idle(), this.#frames.idle()]);
  }
}

/**
 * Open every per-session normalized viewer read model before daemon mutation admission.
 *
 * Nothing here is durable. Completed history comes from Pi's own session file on every read, the
 * frames Pi has not written there yet come from the worker's bounded tail, and the merge of the two
 * is one normalizer per session held in this daemon's memory. A restart therefore rebuilds rather
 * than recovers, and `index/viewer` is never opened.
 * @param {{ daemonEpoch: string, registry: RegistryStore }} options
 */
async function createViewerRecovery({ daemonEpoch, registry }) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** One in-flight open per session, so a second caller joins the first instead of building its own reader. @type {Map<string, Promise<any>>} */
  const opening = new Map();

  /** @param {any} state */
  async function snapshotState(state) {
    const current = await registry.get(state.sessionId);
    if (current === undefined) throw Object.assign(new Error(`Unknown viewer session: ${state.sessionId}`), { code: "SESSION_NOT_FOUND" });
    return state.normalizer.snapshot({
      daemonEpoch,
      sequence: state.stream.currentCursor().sequence,
      registryRevision: current.revision,
      runtime: current.runtime ?? null,
      model: current.model ?? null,
      thinkingLevel: current.thinkingLevel ?? null,
      taskState: current.taskState,
      processState: current.processState,
      outcome: current.outcome,
    });
  }

  /** @param {any} state */
  async function readHistory(state) {
    const history = await state.reader.read();
    for (const error of history.errors) state.normalizer.consumeError(error);
    for (const item of history.entries) {
      for (const draft of state.normalizer.consumeHistory(item.entry, { ...item.position, sourceId: item.sourceId })) state.stream.append(draft);
    }
  }

  /** Open one no-follow reader over Pi's canonical file, or a reader that reports why it could not. @param {any} record @param {any} normalizer */
  async function openHistoryReader(record, normalizer) {
    try {
      return await createSessionHistoryReader({ path: record.canonicalSessionFile });
    } catch (error) {
      const missing = /** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT";
      if (!missing && !(error instanceof SessionHistoryError)) throw error;
      const historyError = /** @type {SessionHistoryError} */ (error);
      normalizer.consumeError({ code: missing ? "SESSION_HISTORY_MISSING" : historyError.code, message: missing ? "Canonical session history is unavailable" : historyError.message, retryable: missing });
      return { async read() { return { entries: [], errors: [], position: { byteOffset: 0, line: 0 } }; }, async close() {} };
    }
  }

  /**
   * Join whichever attempt is already opening this session, or start the only one. The in-flight
   * promise is recorded before this function's first await, so two concurrent callers cannot both
   * reach openNewSession and drop the loser's history handle unclosed. A rejected attempt is
   * forgotten rather than cached, so the next caller opens the session again.
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
    const stream = createViewerStream({ sessionId: record.sessionId, daemonEpoch });
    const normalizer = createViewerNormalizer({ sessionId: record.sessionId, protocolVersion: 1, now: () => new Date().toISOString() });
    const reader = await openHistoryReader(record, normalizer);
    const state = { sessionId: record.sessionId, stream, normalizer, reader };
    sessions.set(record.sessionId, state);
    try {
      await readHistory(state);
    } catch (error) {
      // Canonical history Pi wrote in a shape this normalizer refuses leaves no half-read session
      // behind: the handle is closed and the map forgets it, so a later open reads the file again
      // rather than serving the state this attempt stopped in the middle of.
      sessions.delete(record.sessionId);
      stream.close();
      await reader.close().catch(() => {});
      throw error;
    }
    return state;
  }

  try {
    for (const record of await registry.list()) await openSession(record);
  } catch (error) {
    await Promise.allSettled([...sessions.values()].map((state) => state.reader.close()));
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
      return state.normalizer.consumeFrame(frame).map((/** @type {any} */ draft) => state.stream.append(draft));
    },
    /**
     * Rebuild one session's normalized state from Pi's canonical file plus the tail its worker just
     * replayed, and tell every subscriber to start again from the result.
     *
     * This is the only path that reaches a mid-turn transcript after this daemon started, and it runs
     * on every worker connection after the launch: the tail carries frames this daemon never saw, and
     * frames it did see before the connection dropped. Rebuilding from scratch is what makes it
     * idempotent, since a fingerprint in the normalizer collapses a message that appears in both
     * sources but nothing collapses a frame ingested twice into the same normalizer.
     *
     * Subscribers are ended before the rebuild, not after, so none of them receives the rebuilt
     * events as though they were new; each answers with one fresh snapshot of the result.
     * @param {string} sessionId @param {any[]} frames
     */
    async rebuild(sessionId, frames) {
      const state = sessions.get(sessionId);
      if (state === undefined) throw Object.assign(new Error(`Unknown viewer session: ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      const record = await registry.get(sessionId);
      if (record === undefined) throw Object.assign(new Error(`Unknown viewer session: ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      state.stream.resynchronize("VIEWER_RESYNCHRONIZED", "This session was rebuilt from Pi's session file and its worker's live tail");
      const normalizer = createViewerNormalizer({ sessionId, protocolVersion: 1, now: () => new Date().toISOString() });
      const reader = await openHistoryReader(record, normalizer);
      const previous = state.reader;
      state.normalizer = normalizer;
      state.reader = reader;
      await previous.close().catch(() => {});
      await readHistory(state);
      for (const frame of frames) {
        try {
          for (const draft of normalizer.consumeFrame(frame)) state.stream.append(draft);
        } catch (error) {
          // One replayed frame this normalizer refuses costs that frame, not the rebuild: refusing the
          // whole tail would leave the worker resending it on every reconnect and never recovering.
          const failure = /** @type {any} */ (error);
          normalizer.consumeError({ code: failure?.code ?? "VIEWER_TAIL_FRAME_REFUSED", message: error instanceof Error ? error.message : "Replayed Pi frame was refused", retryable: false });
        }
      }
    },
    /**
     * One session's normalized transcript, read from memory. Unlike snapshot it reads no canonical
     * history, so background work never puts file IO on a request the operator is waiting behind.
     * @param {string} sessionId
     */
    transcript(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) return undefined;
      return { sequence: state.stream.currentCursor().sequence, items: state.normalizer.transcriptItems() };
    },
    /**
     * One snapshot and the subscription that continues it. Both are taken here, in one step, because
     * an event published between them would be missing from the snapshot and from the subscription:
     * nothing is retained to replay it from. The caller holds this session's frame lock, which is what
     * an ingest takes, so no frame can land in that gap.
     * @param {string} sessionId
     */
    async subscribe(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) throw Object.assign(new Error(`Unknown viewer session: ${sessionId}`), { code: "SESSION_NOT_FOUND" });
      await readHistory(state);
      const snapshot = await snapshotState(state);
      return { snapshot, cursor: state.stream.currentCursor(), subscription: state.stream.subscribe() };
    },
    async close() {
      for (const state of sessions.values()) state.stream.close();
      const results = await Promise.allSettled([...sessions.values()].map((state) => state.reader.close()));
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, "Viewer history readers closed with errors");
    },
  };
}

/** @param {{ root: string, daemonEpoch: string, inspect(pid: number): Promise<any>, adoptTimeoutMs?: number, onViewerReady?: (viewer: any) => void | Promise<void>, router?: RecoveredWorkerRouter, signal?: AbortSignal }} options */
export async function reconcileRuntime({ root, daemonEpoch, inspect, adoptTimeoutMs = 15_000, onViewerReady = () => {}, router: suppliedRouter, signal }) {
  const registry = new RegistryStore(join(root, "sessions"));
  /** @type {any} */
  let viewer;
  const router = suppliedRouter ?? new RecoveredWorkerRouter({ registry, inspect, metadataPath: join(root, "daemon", "workers.json") });
  const cancelled = () => {
    if (signal?.aborted) throw Object.assign(new Error("Reconciliation was cancelled"), { code: "RECONCILIATION_CANCELLED" });
  };
  try {
    cancelled();
    await router.load();
    viewer = await createViewerRecovery({ daemonEpoch, registry });
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
        const causePath = typeof current.runHash === "string" ? workerTerminalCausePath(root, current.runHash) : undefined;
        const cause = causePath === undefined ? undefined : await readWorkerTerminalCause(causePath, {
          sessionId: current.sessionId,
          runId: metadata.runId,
          leaseId: metadata.leaseId,
          generation: metadata.generation,
          worker: metadata.identity,
          piChild: metadata.piChildIdentity,
        });
        const next = reduceSessionState(current, cause?.event ?? { type: "WORKER_EXITED", at: new Date().toISOString() });
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
        if (cause !== undefined) await retireWorkerTerminalCause(/** @type {string} */ (causePath));
        repairedSessions.push(updated);
        return undefined;
      });
    };
    /**
     * Record a live worker's crashed Pi child from the cause that worker published. The worker still
     * owns the lease and still owns the acknowledgement handshake, so neither is touched here: the
     * cause stays on disk for whichever of the worker or a later recovery consumes it.
     * @param {any} record @param {any} metadata
     */
    const reportLiveWorkerPiCrash = async (record, metadata) => {
      if (typeof record.runHash !== "string") return false;
      const cause = await readWorkerTerminalCause(workerTerminalCausePath(root, record.runHash), {
        sessionId: record.sessionId,
        runId: metadata.runId,
        leaseId: metadata.leaseId,
        generation: metadata.generation,
        worker: metadata.identity,
        piChild: metadata.piChildIdentity,
      });
      if (cause === undefined) return false;
      return router.runSession(record.sessionId, async () => {
        const current = await registry.get(record.sessionId);
        if (current === undefined || current.revision !== record.revision || current.ownership === undefined) return false;
        const next = reduceSessionState(current, cause.event);
        repairedSessions.push(await registry.update(current.sessionId, current.revision, {
          taskState: next.taskState,
          processState: next.processState,
          outcome: next.outcome,
          activity: next.activity,
          updatedAt: next.updatedAt,
        }));
        return true;
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
        if (!exited(error)) {
          conflicts.push({ sessionId: record.sessionId, reason: "PI_CHILD_IDENTITY_AMBIGUOUS", ownership: record.ownership, metadata });
          continue;
        }
        const reported = await reportLiveWorkerPiCrash(record, metadata);
        conflicts.push({ sessionId: record.sessionId, reason: reported ? PI_CHILD_CRASH_REPORTED : "PI_CHILD_EXITED", ownership: record.ownership, metadata });
        continue;
      }
      if (!sameIdentity(piChild, metadata.piChildIdentity)) {
        conflicts.push({ sessionId: record.sessionId, reason: "PI_CHILD_IDENTITY_MISMATCH", ownership: record.ownership, metadata, actual: piChild });
        continue;
      }
      liveWorkers.push({ sessionId: record.sessionId, runId: record.ownership.runId, identity: actual, piChildIdentity: piChild, metadata });
    }
    cancelled();
    // Adoption is a connect, not a wait. The roster names each live worker's socket and its token, so
    // this daemon reaches every one of them at once and learns immediately which it cannot, instead
    // of polling for workers that have to find it first.
    await Promise.all(liveWorkers.map(async (worker) => {
      try {
        await router.connectRun(worker.sessionId, adoptTimeoutMs);
      } catch (error) {
        const failure = /** @type {any} */ (error);
        conflicts.push({ sessionId: worker.sessionId, reason: "WORKER_UNREACHABLE", cause: failure?.code ?? "WORKER_SOCKET_UNREACHABLE", message: error instanceof Error ? error.message : "Worker socket is unreachable", ownership: worker });
      }
    }));
    await atomicWriteJson(join(root, "daemon", "reconciliation.json"), { schemaVersion: 1, daemonEpoch, completedAt: new Date().toISOString(), conflicts });
    return {
      registry,
      router,
      liveWorkers,
      conflicts,
      unreachableWorkers: conflicts.filter((conflict) => conflict.reason === WORKER_UNREACHABLE),
      repairedSessions,
      viewer,
      async close() {
        const results = await Promise.allSettled([router.close(), viewer.close()]);
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length > 0) throw new AggregateError(errors, "Reconciliation stores closed with errors");
      },
    };
  } catch (error) {
    await Promise.allSettled([viewer?.close()]);
    if (suppliedRouter === undefined) await router.close().catch(() => {});
    throw error;
  }
}
