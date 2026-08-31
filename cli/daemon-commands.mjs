import net from "node:net";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { abandonDaemonStartChild, cleanupStaleDaemon, identifyDaemonChild, inspectDaemonEndpoint } from "../runtime/daemon-lifecycle.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "../runtime/process-signaler.mjs";
import { adoptRenamedStateRoot } from "../runtime/state-root-adoption.mjs";
import { createDaemonRequester, createPersistentDaemonRequester, destructiveRequestTimeoutMs, loadCliClientIdentity, resolveRuntimeRoot } from "./session-commands.mjs";

export { resolveRuntimeRoot };

const STATUS_CODES = { HEALTHY: 0, UNHEALTHY: 1, STALE: 1, ABSENT: 3, CONFLICT: 5 };
const DEFAULT_STOP_POLICY = Object.freeze({ gracefulMs: 500, terminateMs: 500 });
const STARTUP_LOG_MAX_BYTES = 1024 * 1024;
const STARTUP_REPORT_BYTES = 4 * 1024;
// How long a stopped daemon may keep matching its published identity after the endpoint is gone.
const PROCESS_EXIT_PROOF_MS = 2_000;
const PROCESS_EXIT_POLL_MS = 25;
// How long a daemon child may take to publish a healthy endpoint. 24 concurrent cold starts on this
// box at load 6 took 4.7 s to 5.5 s each, and this suite has read a 15 s cap as a product failure
// three times under real load. The bound stays because a daemon that never publishes has to be
// named rather than hang the command line; 90 s keeps it under the 120 s test timeout, so the
// command's own DAEMON_START_FAILED and its captured startup log still win over a bare harness
// timeout. Callers on a tighter budget pass `timeoutMs`.
const DAEMON_START_DEADLINE_MS = 90_000;
// The stop wait begins after the process group has already been signalled, so it measures only how
// long the kernel takes to reap it. It stays short on purpose: an unkillable daemon is the failure
// worth reporting quickly, and lengthening it would only delay DAEMON_STOP_TIMEOUT.
const DAEMON_STOP_DEADLINE_MS = 15_000;

export async function daemonEntryPoint() {
  return realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../runtime/daemon.mjs"));
}

// The liveness probe is a socket round trip with no request in it, but it still waits behind
// whatever the daemon's event loop is already doing. Measured on this box at 1-minute load 7.04:
// one daemon holding 400 session rows, with 48 concurrent clients reading `get_state`, answered 31
// probes with a median of 380 ms, a worst of 557 ms, and 7 of them over 500 ms. The former 500 ms
// default therefore read a healthy daemon as UNHEALTHY under ordinary client load, which refused
// `daemon start` with DAEMON_UNHEALTHY and `daemon stop` with STOP_REFUSED on the single pre-flight
// probe. 5 s is nine times that worst case and still bounded: a daemon that never answers has to be
// named rather than hang the command line. Callers on a tighter budget pass `probeTimeoutMs`.
export const DAEMON_PROBE_TIMEOUT_MS = 5_000;

export async function probeDaemon(publication, { timeoutMs = DAEMON_PROBE_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("probe timeoutMs must be a positive safe integer");
  const token = (await readFile(publication.tokenPath, "utf8")).trim();
  const socketPath = join(dirname(publication.tokenPath), "control.sock");
  const encoder = createJsonlEncoder({ maxBytes: 64 * 1024 });
  const decoder = createJsonlDecoder({ maxBytes: 64 * 1024 });
  return new Promise((resolveProbe) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish({ reachable: false }), timeoutMs);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(value);
    };
    socket.once("connect", () => socket.write(encoder.encode({ version: 1, token })));
    socket.on("data", (chunk) => {
      try {
        const frame = /** @type {any} */ (decoder.push(chunk)[0]);
        if (frame !== undefined) finish(frame?.version === 1 && frame?.kind === "authenticated" ? { reachable: true, state: frame.state, error: frame.error } : { reachable: false });
      } catch { finish({ reachable: false }); }
    });
    socket.once("error", () => finish({ reachable: false }));
    socket.once("close", () => finish({ reachable: false }));
  });
}

async function requestDaemonStop(publication, { timeoutMs = 500 } = {}) {
  const token = (await readFile(publication.tokenPath, "utf8")).trim();
  const socketPath = join(dirname(publication.tokenPath), "control.sock");
  const encoder = createJsonlEncoder({ maxBytes: 64 * 1024 });
  await new Promise((resolveRequest, rejectRequest) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(Object.assign(new Error("Daemon stop request timed out"), { code: "DAEMON_STOP_TIMEOUT" })), timeoutMs);
    const finish = (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectRequest(error);
      else resolveRequest(undefined);
    };
    socket.once("connect", () => socket.write(encoder.encode({ version: 1, token, role: "control", action: "stop" }), (error) => finish(error)));
    socket.once("error", finish);
  });
}

/** @param {string} file @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {number | "ignore"} stderr */
function spawnDaemon(file, argv, env, stderr) {
  const child = spawn(process.execPath, [file, ...argv], { detached: true, shell: false, stdio: ["ignore", "ignore", stderr], env });
  child.unref();
  return child;
}

/** Open the private log that keeps a failing daemon child's stderr instead of discarding it. @param {string} root */
async function openStartupLog(root) {
  try {
    const directory = join(root, "daemon");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "startup.log");
    const handle = await open(path, "a+", 0o600);
    await handle.chmod(0o600);
    const { size } = await handle.stat();
    if (size <= STARTUP_LOG_MAX_BYTES) return { path, handle, offset: size };
    await handle.truncate(0);
    return { path, handle, offset: 0 };
  } catch {
    return undefined;
  }
}

/** Read back only what this start attempt's child wrote. @param {{ path: string, handle: any, offset: number } | undefined} capture */
async function readStartupOutput(capture) {
  if (capture === undefined) return "";
  try {
    const { size } = await capture.handle.stat();
    const start = Math.max(capture.offset, size - STARTUP_REPORT_BYTES);
    if (size <= start) return "";
    const { bytesRead, buffer } = await capture.handle.read(Buffer.alloc(size - start), 0, size - start, start);
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Prove one published daemon process is gone, by the same exact identity that authorized signaling it.
 *
 * @param {any} publication @param {(pid: number) => Promise<any>} inspect
 * @returns {Promise<{ reason: string, identity?: any, error?: unknown } | undefined>} the survivor, or undefined once it is gone
 */
async function waitForProcessExit(publication, inspect) {
  const deadline = Date.now() + PROCESS_EXIT_PROOF_MS;
  for (;;) {
    /** @type {any} */
    let actual;
    try {
      actual = await inspect(publication.pid);
    } catch (error) {
      if (error instanceof Error && ["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) return undefined;
      return { reason: "AMBIGUOUS_IDENTITY", error };
    }
    if (actual?.pid !== publication.pid || actual?.startIdentity !== publication.startIdentity || actual?.processGroupId !== publication.processGroupId) return undefined;
    if (Date.now() >= deadline) return { reason: "STILL_RUNNING", identity: actual };
    await new Promise((resolveWait) => setTimeout(resolveWait, PROCESS_EXIT_POLL_MS));
  }
}

async function waitForStatus(root, desired, options, defaultTimeoutMs) {
  const deadline = Date.now() + (options.timeoutMs ?? defaultTimeoutMs);
  let endpoint;
  /** @type {any} */
  let childFailure;
  options.child?.once?.("exit", (/** @type {number | null} */ code) => { childFailure ??= { status: "PROCESS_EXITED", exitCode: code }; });
  options.child?.once?.("error", (/** @type {unknown} */ error) => { childFailure ??= { status: "PROCESS_FAILED", error }; });
  while (Date.now() < deadline) {
    if (childFailure !== undefined) return childFailure;
    endpoint = await options.inspectEndpoint({ root, inspect: options.inspect, probe: options.probe, probeTimeoutMs: options.probeTimeoutMs });
    if (desired.includes(endpoint.status) && (!options.requireReady || endpoint.status !== "HEALTHY" || endpoint.daemonState === "READY" || endpoint.daemonState === undefined)) return endpoint;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return endpoint;
}

export async function runDaemonCommand(command, options = {}) {
  let root = options.root ?? resolveRuntimeRoot(options.env);
  if (command === "start" && options.root === undefined) {
    // Starting is the only command that creates a state root, so it is the last place that can
    // refuse to leave the operator's sessions behind in the root this build shipped under. Every
    // start path takes the same adopt, defer, or refuse decision rather than opening an empty root.
    try {
      root = (await (options.adoptStateRoot ?? adoptRenamedStateRoot)({ env: options.env ?? process.env })).root;
    } catch (error) {
      return { code: 1, error: { code: /** @type {any} */ (error)?.code ?? "STATE_ROOT_UNUSABLE", message: error instanceof Error ? error.message : "State root cannot be resolved" } };
    }
  }
  const inspect = options.inspect ?? inspectProcessIdentity;
  const probe = options.probe ?? probeDaemon;
  const inspectEndpoint = options.inspectEndpoint ?? inspectDaemonEndpoint;
  const probeTimeoutMs = options.probeTimeoutMs ?? DAEMON_PROBE_TIMEOUT_MS;
  const common = { root, inspect, probe, probeTimeoutMs };
  if (command === "status") {
    const endpoint = await inspectEndpoint(common);
    const code = endpoint.status === "HEALTHY" && endpoint.daemonState !== undefined && endpoint.daemonState !== "READY" ? 1 : STATUS_CODES[endpoint.status] ?? 1;
    return { code, result: { kind: "daemon_status", root, ...endpoint } };
  }
  if (command === "start") {
    const current = await inspectEndpoint(common);
    if (current.status === "HEALTHY") return { code: 0, result: { kind: "daemon_started", alreadyRunning: true, root, publication: current.publication } };
    if (current.status !== "ABSENT") return { code: current.status === "CONFLICT" ? 5 : 1, error: { code: current.status === "UNHEALTHY" ? "DAEMON_UNHEALTHY" : "STALE_ENDPOINT_REQUIRES_RECOVER", message: "Daemon start refused until endpoint ownership is resolved" } };
    const entry = await daemonEntryPoint();
    const argv = ["--root", root];
    if (options.piBin !== undefined) argv.push("--pi-bin", options.piBin);
    const capture = await openStartupLog(root);
    try {
      const child = (options.spawnDaemon ?? spawnDaemon)(entry, argv, options.env ?? process.env, capture?.handle.fd ?? "ignore");
      child.once?.("error", () => {});
      // Read before the wait, not after it: at the deadline this PID may already name someone else.
      const spawned = await identifyDaemonChild(child, inspect);
      const endpoint = await waitForStatus(root, ["HEALTHY", "CONFLICT"], { ...options, inspect, probe, probeTimeoutMs, inspectEndpoint, requireReady: true, child }, DAEMON_START_DEADLINE_MS);
      if (endpoint?.status === "HEALTHY") return { code: 0, result: { kind: "daemon_started", alreadyRunning: false, root, publication: endpoint.publication } };
      // Every remaining path gives up on this child, and a child nobody stops publishes itself
      // seconds later and owns the root forever.
      const abandoned = await abandonDaemonStartChild(spawned, { ...common, signalProcessGroup: options.signalProcessGroup, sleep: options.sleep, cleanupStale: options.cleanupStale, stopPolicy: options.stopPolicy ?? DEFAULT_STOP_POLICY });
      if (endpoint?.status === "CONFLICT" || (endpoint?.status === "PROCESS_EXITED" && endpoint.exitCode === 5)) return { code: 5, error: { code: "DAEMON_RECOVERY_CONFLICT", message: "Daemon recovery found an ownership conflict" } };
      const reason = endpoint?.status === "PROCESS_EXITED"
        ? `Daemon exited with code ${endpoint.exitCode} before becoming healthy`
        : endpoint?.status === "PROCESS_FAILED"
          ? `Daemon could not be spawned: ${endpoint.error instanceof Error ? endpoint.error.message : String(endpoint.error)}`
          : "Daemon did not become healthy before the startup deadline";
      const summary = abandoned.summary === undefined ? reason : `${reason}; ${abandoned.summary}`;
      const output = await readStartupOutput(capture);
      return { code: 1, error: { code: "DAEMON_START_FAILED", message: output !== "" ? `${summary}:\n${output}` : capture === undefined ? summary : `${summary}; ${capture.path} is empty` } };
    } finally {
      await capture?.handle.close().catch(() => {});
    }
  }
  if (command === "recover") {
    const current = await inspectEndpoint(common);
    if (current.status === "STALE") {
      try {
        await (options.cleanupStale ?? cleanupStaleDaemon)(common);
      } catch (error) {
        return { code: ["DAEMON_BUSY", "DAEMON_IDENTITY_CONFLICT"].includes(error?.code) ? 5 : 1, error: { code: error?.code ?? "RECOVERY_REFUSED", message: error instanceof Error ? error.message : "Stale recovery failed" } };
      }
    } else if (current.status === "HEALTHY" && current.daemonState === "READY") return { code: 0, result: { kind: "daemon_recovered", alreadyRunning: true, root } };
    else if (current.status !== "ABSENT") return { code: current.status === "CONFLICT" ? 5 : 1, error: { code: "RECOVERY_REFUSED", message: "Live or ambiguous daemon identity cannot be cleaned up" } };
    return runDaemonCommand("start", { ...options, root });
  }
  if (command === "stop") {
    const current = await inspectEndpoint(common);
    if (current.status === "ABSENT") return { code: 3, error: { code: "DAEMON_ABSENT", message: "Daemon is not running" } };
    if (current.status !== "HEALTHY") return { code: current.status === "CONFLICT" ? 5 : 1, error: { code: "STOP_REFUSED", message: "Daemon identity is not healthy and exact" } };
    const clientId = options.request === undefined && options.heldConnectionRequest === undefined ? await loadCliClientIdentity({ root, randomId: options.randomId }) : undefined;
    // A worker Stop only answers after the daemon's own SIGTERM-then-SIGKILL escalation, so a shorter deadline reports a false ambiguous delivery.
    const persistent = clientId === undefined ? undefined : await (options.createPersistentRequester ?? createPersistentDaemonRequester)({ root, clientId, timeoutMs: await destructiveRequestTimeoutMs(root, undefined, options.timeoutMs) });
    const request = options.heldConnectionRequest ?? persistent?.request ?? options.request ?? createDaemonRequester({ root, clientId, timeoutMs: options.timeoutMs });
    /** @type {string[]} */
    let stoppedSessionIds = [];
    try {
      const state = await request("get_state", {});
      const liveSessions = state.sessions.filter((record) => record.ownership !== undefined || ["LIVE", "SLEEPING"].includes(record.processState));
      if (liveSessions.length > 0 && options.allowLiveWorkers !== true && (options.stopWorkers !== true || options.yes !== true)) {
        return { code: 1, error: { code: "WORKERS_LIVE", message: "Daemon stop requires --stop-workers --yes while workers are live" }, result: { kind: "live_workers", sessionIds: liveSessions.map((record) => record.sessionId) } };
      }
      if (liveSessions.length > 0 && options.stopWorkers === true) {
        let outcomes;
        try { outcomes = await Promise.all(liveSessions.map((record) => request("stop", { sessionId: record.sessionId, revision: record.revision }))); }
        catch (error) { if (error?.code === "DELIVERY_UNKNOWN" || (error?.code === "CONNECTION_CLOSED" && error?.submitted === true)) return { code: 1, error: { code: "DELIVERY_UNKNOWN", message: "A worker Stop delivery is ambiguous; daemon remains running" } }; throw error; }
        const refused = outcomes.find((outcome) => outcome?.kind !== "command" || outcome.status?.stage !== "COMPLETED");
        if (refused !== undefined) return { code: 1, error: { code: refused?.status?.stage === "DELIVERY_UNKNOWN" ? "DELIVERY_UNKNOWN" : "WORKER_STOP_REFUSED", message: "A worker stop did not complete; daemon remains running" }, result: refused };
        stoppedSessionIds = liveSessions.map((record) => record.sessionId);
      }
    } finally { await persistent?.close(); }
    const ownership = { pid: current.publication.pid, startIdentity: current.publication.startIdentity, processGroupId: current.publication.processGroupId };
    const stop = options.stopProcessGroup ?? stopVerifiedProcessGroup;
    const disposition = await stop(ownership, {
      inspect,
      requestGraceful: options.requestGraceful ?? (() => requestDaemonStop(current.publication, options)),
      signalProcessGroup: options.signalProcessGroup ?? signalProcessGroup,
      sleep: options.sleep ?? sleep,
    }, options.stopPolicy ?? DEFAULT_STOP_POLICY);
    if (["STALE_IDENTITY", "AMBIGUOUS_IDENTITY", "CANCELLED"].includes(disposition.disposition)) return { code: 5, error: { code: "DAEMON_IDENTITY_CONFLICT", message: `Daemon stop refused at exact identity boundary: ${disposition.disposition}` } };
    let endpoint = await waitForStatus(root, ["ABSENT", "STALE"], { ...options, inspect, probe, probeTimeoutMs, inspectEndpoint }, DAEMON_STOP_DEADLINE_MS);
    if (endpoint?.status === "STALE") {
      try {
        await (options.cleanupStale ?? cleanupStaleDaemon)(common);
        endpoint = await inspectEndpoint(common);
      } catch (error) {
        return { code: 5, error: { code: error?.code ?? "DAEMON_IDENTITY_CONFLICT", message: error instanceof Error ? error.message : "Daemon cleanup identity changed" } };
      }
    }
    if (endpoint?.status !== "ABSENT") return { code: 1, error: { code: "DAEMON_STOP_TIMEOUT", message: "Daemon did not stop before the deadline" } };
    // The daemon removes its publication as the last step of its own shutdown, so an absent
    // endpoint proves only that the endpoint was released. A hung or unkillable process still owns
    // the root, and restart would start a second daemon beside it.
    const survivor = await waitForProcessExit(current.publication, inspect);
    if (survivor !== undefined) return { code: 5, error: { code: "DAEMON_STILL_RUNNING", message: `Daemon ${current.publication.pid} still matches its published process identity after stop: ${survivor.reason}` } };
    return { code: 0, result: { kind: "daemon_stopped", root, stoppedSessionIds } };
  }
  if (command === "restart") {
    const current = await inspectEndpoint(common);
    if (current.status === "HEALTHY") {
      const stopped = await runDaemonCommand("stop", { ...options, root, allowLiveWorkers: true });
      if (stopped.code !== 0) return stopped;
    } else if (current.status !== "ABSENT") return { code: current.status === "CONFLICT" ? 5 : 1, error: { code: "RESTART_REFUSED", message: "Daemon endpoint requires explicit recovery" } };
    return runDaemonCommand("start", { ...options, root });
  }
  return { code: 2, error: { code: "INVALID_DAEMON_COMMAND", message: "Expected start, status, restart, recover, or stop" } };
}
