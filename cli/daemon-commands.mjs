import net from "node:net";
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupStaleDaemon, inspectDaemonEndpoint } from "../runtime/daemon-lifecycle.mjs";
import { createJsonlDecoder, createJsonlEncoder } from "../runtime/jsonl.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";

const STATUS_CODES = { HEALTHY: 0, UNHEALTHY: 1, STALE: 1, ABSENT: 3, CONFLICT: 5 };

export function resolveRuntimeRoot(env = process.env) {
  const home = env.HOME ?? homedir();
  return resolve(env.PI_AGENTS_DASHBOARD_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-agents-dashboard"));
}

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
    const timer = setTimeout(() => finish(false), timeoutMs);
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
        const frame = decoder.push(chunk)[0];
        if (frame !== undefined) finish(frame?.version === 1 && frame?.kind === "authenticated");
      } catch { finish(false); }
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

function spawnDaemon(file, argv) {
  const child = spawn(process.execPath, [file, ...argv], { detached: true, shell: false, stdio: "ignore" });
  child.unref();
  return child;
}

async function waitForStatus(root, desired, options) {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let endpoint;
  while (Date.now() < deadline) {
    endpoint = await options.inspectEndpoint({ root, inspect: options.inspect, probe: options.probe });
    if (desired.includes(endpoint.status)) return endpoint;
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
    return { code: STATUS_CODES[endpoint.status] ?? 1, result: { kind: "daemon_status", root, ...endpoint } };
  }
  if (command === "start") {
    const current = await inspectEndpoint(common);
    if (current.status === "HEALTHY") return { code: 0, result: { kind: "daemon_started", alreadyRunning: true, root, publication: current.publication } };
    if (current.status !== "ABSENT") return { code: current.status === "CONFLICT" ? 5 : 1, error: { code: current.status === "UNHEALTHY" ? "DAEMON_UNHEALTHY" : "STALE_ENDPOINT_REQUIRES_RECOVER", message: "Daemon start refused until endpoint ownership is resolved" } };
    const entry = await daemonEntryPoint();
    const child = (options.spawnDaemon ?? spawnDaemon)(entry, ["--root", root]);
    child.once?.("error", () => {});
    const endpoint = await waitForStatus(root, ["HEALTHY", "CONFLICT", "UNHEALTHY"], { ...options, inspect, probe, inspectEndpoint });
    if (endpoint?.status === "HEALTHY") return { code: 0, result: { kind: "daemon_started", alreadyRunning: false, root, publication: endpoint.publication } };
    return { code: endpoint?.status === "CONFLICT" ? 5 : 1, error: { code: "DAEMON_START_FAILED", message: "Daemon did not become healthy before the startup deadline" } };
  }
  if (command === "recover") {
    const current = await inspectEndpoint(common);
    if (current.status === "STALE") await (options.cleanupStale ?? cleanupStaleDaemon)(common);
    else if (current.status === "HEALTHY") return { code: 0, result: { kind: "daemon_recovered", alreadyRunning: true, root } };
    else if (current.status !== "ABSENT") return { code: current.status === "CONFLICT" ? 5 : 1, error: { code: "RECOVERY_REFUSED", message: "Live or ambiguous daemon identity cannot be cleaned up" } };
    return runDaemonCommand("start", { ...options, root });
  }
  if (command === "stop") {
    const current = await inspectEndpoint(common);
    if (current.status === "ABSENT") return { code: 3, error: { code: "DAEMON_ABSENT", message: "Daemon is not running" } };
    if (current.status !== "HEALTHY") return { code: current.status === "CONFLICT" ? 5 : 1, error: { code: "STOP_REFUSED", message: "Daemon identity is not healthy and exact" } };
    const actual = await inspect(current.publication.pid);
    if (actual.pid !== current.publication.pid || actual.startIdentity !== current.publication.startIdentity || actual.processGroupId !== current.publication.processGroupId) return { code: 5, error: { code: "DAEMON_IDENTITY_CONFLICT", message: "Daemon identity changed before stop" } };
    (options.signalDaemon ?? process.kill)(current.publication.pid, "SIGTERM");
    const endpoint = await waitForStatus(root, ["ABSENT"], { ...options, inspect, probe, inspectEndpoint });
    return endpoint?.status === "ABSENT" ? { code: 0, result: { kind: "daemon_stopped", root } } : { code: 1, error: { code: "DAEMON_STOP_TIMEOUT", message: "Daemon did not stop before the deadline" } };
  }
  if (command === "restart") {
    const current = await inspectEndpoint(common);
    if (current.status === "HEALTHY") {
      const stopped = await runDaemonCommand("stop", { ...options, root });
      if (stopped.code !== 0) return stopped;
    } else if (current.status !== "ABSENT") return { code: current.status === "CONFLICT" ? 5 : 1, error: { code: "RESTART_REFUSED", message: "Daemon endpoint requires explicit recovery" } };
    return runDaemonCommand("start", { ...options, root });
  }
  return { code: 2, error: { code: "INVALID_DAEMON_COMMAND", message: "Expected start, status, restart, recover, or stop" } };
}
