import net from "node:net";
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupStaleDaemon, inspectDaemonEndpoint } from "../runtime/daemon-lifecycle.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "../runtime/process-signaler.mjs";
import { createDaemonRequester, createPersistentDaemonRequester, loadCliClientIdentity, resolveRuntimeRoot } from "./session-commands.mjs";

export { resolveRuntimeRoot };

const STATUS_CODES = { HEALTHY: 0, UNHEALTHY: 1, STALE: 1, ABSENT: 3, CONFLICT: 5 };
const DEFAULT_STOP_POLICY = Object.freeze({ gracefulMs: 500, terminateMs: 500 });

export async function daemonEntryPoint() {
  return realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../runtime/daemon.mjs"));
}

export async function probeDaemon(publication, { timeoutMs = 500 } = {}) {
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

function spawnDaemon(file, argv, env) {
  const child = spawn(process.execPath, [file, ...argv], { detached: true, shell: false, stdio: "ignore", env });
  child.unref();
  return child;
}

async function waitForStatus(root, desired, options) {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let endpoint;
  let childExitCode;
  options.child?.once?.("exit", (/** @type {number | null} */ code) => { childExitCode = code; });
  while (Date.now() < deadline) {
    if (childExitCode !== undefined) return { status: "PROCESS_EXITED", exitCode: childExitCode };
    endpoint = await options.inspectEndpoint({ root, inspect: options.inspect, probe: options.probe });
    if (desired.includes(endpoint.status) && (!options.requireReady || endpoint.status !== "HEALTHY" || endpoint.daemonState === "READY" || endpoint.daemonState === undefined)) return endpoint;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return endpoint;
}

export async function runDaemonCommand(command, options = {}) {
  const root = options.root ?? resolveRuntimeRoot(options.env);
  const inspect = options.inspect ?? inspectProcessIdentity;
  const probe = options.probe ?? probeDaemon;
  const inspectEndpoint = options.inspectEndpoint ?? inspectDaemonEndpoint;
  const common = { root, inspect, probe };
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
    const child = (options.spawnDaemon ?? spawnDaemon)(entry, argv, options.env ?? process.env);
    child.once?.("error", () => {});
    const endpoint = await waitForStatus(root, ["HEALTHY", "CONFLICT"], { ...options, inspect, probe, inspectEndpoint, requireReady: true, child });
    if (endpoint?.status === "HEALTHY") return { code: 0, result: { kind: "daemon_started", alreadyRunning: false, root, publication: endpoint.publication } };
    const ownershipConflict = endpoint?.status === "CONFLICT" || (endpoint?.status === "PROCESS_EXITED" && endpoint.exitCode === 5);
    return { code: ownershipConflict ? 5 : 1, error: { code: ownershipConflict ? "DAEMON_RECOVERY_CONFLICT" : "DAEMON_START_FAILED", message: ownershipConflict ? "Daemon recovery found an ownership conflict" : "Daemon did not become healthy before the startup deadline" } };
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
    const clientId = options.request === undefined && options.composerRequest === undefined ? await loadCliClientIdentity({ root, randomId: options.randomId }) : undefined;
    const persistent = clientId === undefined ? undefined : await createPersistentDaemonRequester({ root, clientId, timeoutMs: options.timeoutMs });
    const request = options.composerRequest ?? persistent?.request ?? options.request ?? createDaemonRequester({ root, clientId, timeoutMs: options.timeoutMs });
    const claimsComposer = options.composerRequest !== undefined || persistent !== undefined;
    try {
      const state = await request("get_state", {});
      const liveSessions = state.sessions.filter((record) => record.ownership !== undefined || ["LIVE", "SLEEPING"].includes(record.processState));
      if (liveSessions.length > 0 && options.allowLiveWorkers !== true && (options.stopWorkers !== true || options.yes !== true)) {
        return { code: 1, error: { code: "WORKERS_LIVE", message: "Daemon stop requires --stop-workers --yes while workers are live" }, result: { kind: "live_workers", sessionIds: liveSessions.map((record) => record.sessionId) } };
      }
      if (liveSessions.length > 0 && options.stopWorkers === true) {
        let outcomes;
        try { outcomes = await Promise.all(liveSessions.map(async (record) => {
          if (claimsComposer) {
            const attached = await request("attach", { sessionId: record.sessionId, role: "composer" });
            if (attached?.kind !== "attached" || attached.role !== "composer") return attached;
          }
          let outcome;
          try { outcome = await request("stop", { sessionId: record.sessionId, revision: record.revision }); return outcome; }
          finally { if (claimsComposer && outcome !== undefined) await request("detach", { sessionId: record.sessionId }).catch(() => {}); }
        })); }
        catch (error) { if (error?.code === "DELIVERY_UNKNOWN" || (error?.code === "CONNECTION_CLOSED" && error?.submitted === true)) return { code: 1, error: { code: "DELIVERY_UNKNOWN", message: "A worker Stop delivery is ambiguous; daemon remains running" } }; throw error; }
        const refused = outcomes.find((outcome) => outcome?.kind !== "command" || outcome.status?.stage !== "COMPLETED");
        if (refused !== undefined) return { code: 1, error: { code: refused?.status?.stage === "DELIVERY_UNKNOWN" ? "DELIVERY_UNKNOWN" : "WORKER_STOP_REFUSED", message: "A worker stop did not complete; daemon remains running" }, result: refused };
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
    let endpoint = await waitForStatus(root, ["ABSENT", "STALE"], { ...options, inspect, probe, inspectEndpoint });
    if (endpoint?.status === "STALE") {
      try {
        await (options.cleanupStale ?? cleanupStaleDaemon)(common);
        endpoint = await inspectEndpoint(common);
      } catch (error) {
        return { code: 5, error: { code: error?.code ?? "DAEMON_IDENTITY_CONFLICT", message: error instanceof Error ? error.message : "Daemon cleanup identity changed" } };
      }
    }
    return endpoint?.status === "ABSENT" ? { code: 0, result: { kind: "daemon_stopped", root } } : { code: 1, error: { code: "DAEMON_STOP_TIMEOUT", message: "Daemon did not stop before the deadline" } };
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
