import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";

import { piConfirmedModel } from "../shared/contracts.mjs";
import { openPiExecutableBinding } from "./pi-executable.mjs";
import { PiRpcAdapter, piRpcArgv } from "./pi-rpc-adapter.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { openRotatingDiagnostics } from "./rotating-diagnostics.mjs";
import { sessionEventForPiEvent } from "./session-event-mapping.mjs";
import { MAX_LIVE_TAIL_BYTES, createLiveTail } from "./worker-live-tail.mjs";
import { listenForDaemon } from "./worker-socket.mjs";
import { createWorkerCommandDispatcher, createWorkerReplayStore, replayDeliveryIsAmbiguous, serveDaemonConnections } from "./worker.mjs";
import { WORKER_TERMINAL_CAUSE_FILE, publishWorkerTerminalCause, retireWorkerTerminalCause } from "./worker-terminal-cause.mjs";

const MAX_PENDING_PARENT_MESSAGES = 256;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
/** A crash report must not outlive its own exit: stop waiting for the channel and leave. */
const CRASH_REPORT_TIMEOUT_MS = 1_000;

/** @param {unknown} supplied @param {string} expected */
function matchesToken(supplied, expected) {
  const digest = (/** @type {string} */ value) => createHash("sha256").update(value, "utf8").digest();
  return typeof supplied === "string" && timingSafeEqual(digest(supplied), digest(expected));
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new TypeError("Worker arguments must be flag/value pairs");
    values.set(key.slice(2), value);
  }
  for (const required of ["session-id", "canonical-session-file", "cwd", "run-id", "lease-id", "generation", "replay-path", "pi-executable", "pi-identity", "capabilities", "diagnostics-directory", "worker-socket", "startup-deadline-ms"]) {
    if (!values.has(required)) throw new TypeError(`Missing worker argument: --${required}`);
  }
  const generation = Number(values.get("generation"));
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new TypeError("Worker generation must be positive");
  const startupDeadlineMs = Number(values.get("startup-deadline-ms"));
  if (!Number.isSafeInteger(startupDeadlineMs) || startupDeadlineMs <= 0) throw new TypeError("Worker startup deadline must be positive");
  const maxFrameBytes = values.has("max-frame-bytes") ? Number(values.get("max-frame-bytes")) : DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 128) throw new TypeError("Worker frame bound must be at least 128 bytes");
  let executable;
  let capabilities;
  try {
    executable = JSON.parse(values.get("pi-identity"));
    capabilities = JSON.parse(values.get("capabilities"));
  } catch (cause) {
    throw new TypeError("Worker structured arguments must contain valid JSON", { cause });
  }
  return {
    sessionId: values.get("session-id"), canonicalSessionFile: values.get("canonical-session-file"), cwd: values.get("cwd"), runId: values.get("run-id"),
    leaseId: values.get("lease-id"), generation, replayPath: values.get("replay-path"), piExecutable: values.get("pi-executable"), executable, capabilities,
    diagnosticsDirectory: values.get("diagnostics-directory"), model: values.has("model-provider") ? { provider: values.get("model-provider"), id: values.get("model-id") } : undefined,
    name: values.get("name"), workerSocket: values.get("worker-socket"), startupDeadlineMs, maxFrameBytes,
  };
}


/** @param {NodeJS.Process} runtimeProcess */
export async function runInstalledPiWorker(runtimeProcess) {
  const options = parseArgs(runtimeProcess.argv.slice(2));
  const token = runtimeProcess.env.PI_AGENTS_WORKER_TOKEN;
  if (typeof token !== "string" || token.length === 0) throw new Error("Worker requires an authenticated launch token");
  const reconnectController = new AbortController();
  // This worker owns its socket. The daemon named the path before it spawned this process and
  // recorded it against this run, so a replacement daemon reconnects to it rather than waiting to be
  // found. Nothing exists at that path until this call, which is why a daemon that died between
  // naming it and spawning leaves nothing a later daemon can mistake for a live worker.
  const listener = await listenForDaemon({ socketPath: options.workerSocket, token, maxBytes: options.maxFrameBytes });
  /**
   * A worker nobody ever connects to holds no Pi child and none of the operator's text, so waiting
   * forever costs a process and gains nothing. This bounds the launch handshake only: once readiness
   * is sent it is cleared, and from then on the worker outlives daemon absence indefinitely.
   */
  const startupDeadline = setTimeout(() => {
    runtimeProcess.stderr.write(`${JSON.stringify({ event: "worker_startup_deadline", code: "WORKER_STARTUP_DEADLINE", sessionId: options.sessionId, runId: options.runId, socketPath: options.workerSocket, deadlineMs: options.startupDeadlineMs, at: new Date().toISOString() })}\n`);
    void listener.close().finally(() => runtimeProcess.exit(1));
  }, options.startupDeadlineMs);
  // The startup connection is the only worker channel: a launch carries no inter-process channel.
  const launchConnection = await listener.next();
  /** @type {((message: any) => Promise<unknown>) | undefined} */
  let sendToDaemon = (/** @type {any} */ message) => Promise.resolve(launchConnection.send(message));
  /** @param {any} message */
  const sendWorkerMessage = (message) => void sendToDaemon?.(message).catch(() => {});
  /** @type {{ message: any, send: (message: any) => unknown }[]} */
  const pendingParentMessages = [];
  /** @type {((message: any, send: (message: any) => unknown) => void) | undefined} */
  let transportMessageHandler;
  /** @type {Set<(message: any) => boolean>} */
  const launchWaiters = new Set();
  /** @type {((message: any) => boolean) | undefined} */
  let terminalCauseAcknowledgement;
  /** @param {any} message */
  const acceptTerminalCauseAcknowledgement = (message) => terminalCauseAcknowledgement?.(message) === true;
  /** @param {any} message */
  const onDaemonMessage = (message) => {
    for (const waiter of [...launchWaiters]) {
      if (waiter(message)) return;
    }
    if (acceptTerminalCauseAcknowledgement(message)) return;
    if (!matchesToken(message?.token, token) || !["command", "shutdown"].includes(message.type)) return;
    const send = (/** @type {any} */ response) => sendToDaemon?.(response);
    if (transportMessageHandler !== undefined) {
      transportMessageHandler(message, send);
    } else if (pendingParentMessages.length < MAX_PENDING_PARENT_MESSAGES) {
      pendingParentMessages.push({ message, send });
    } else if (message.type === "shutdown") {
      pendingParentMessages.shift();
      pendingParentMessages.push({ message, send });
    } else {
      void send({ version: 1, type: "command_result", token, id: message.id, ok: false, error: { code: "WORKER_NOT_READY", message: "Worker parent queue is full", deliveryUnknown: false } });
    }
  };
  launchConnection.onMessage(onDaemonMessage);
  /** @param {(message: any) => boolean} matches @param {string} code @returns {Promise<any>} */
  const awaitLaunchMessage = (matches, code) => new Promise((resolveMessage, rejectMessage) => {
    /** @param {any} message */
    const waiter = (message) => {
      if (message?.type === "reject" && matchesToken(message?.token, token)) {
        launchWaiters.delete(waiter);
        rejectMessage(Object.assign(new Error("Worker rejected"), { code: "WORKER_REJECTED" }));
        return true;
      }
      if (!matches(message)) return false;
      launchWaiters.delete(waiter);
      resolveMessage(message);
      return true;
    };
    launchWaiters.add(waiter);
    Promise.resolve(launchConnection.closed).finally(() => {
      if (!launchWaiters.delete(waiter)) return;
      rejectMessage(Object.assign(new Error("Worker launch connection closed"), { code }));
    }).catch(() => {});
  });
  const supervisorIdentity = await inspectProcessIdentity(runtimeProcess.pid);
  await launchConnection.send({ version: 1, type: "hello", token, sessionId: options.sessionId, runId: options.runId, leaseId: options.leaseId, generation: options.generation, worker: supervisorIdentity });

  const activation = await awaitLaunchMessage((message) => message?.type === "activate", "WORKER_DISCONNECTED");
  if (!matchesToken(activation?.token, token) || activation?.leaseId !== options.leaseId || activation?.generation !== options.generation) throw Object.assign(new Error("Worker activation mismatch"), { code: "WORKER_ACTIVATION_MISMATCH" });

  const executableBinding = await openPiExecutableBinding(options.executable);
  const diagnostics = await openRotatingDiagnostics({ directory: options.diagnosticsDirectory });
  const argv = piRpcArgv({ sessionFile: options.canonicalSessionFile, model: options.model, name: options.name });
  const piEnvironment = { ...runtimeProcess.env };
  delete piEnvironment.PI_AGENTS_WORKER_TOKEN;
  let piChild;
  try {
    piChild = spawn(executableBinding.executionPath, argv, { cwd: options.cwd, env: piEnvironment, detached: false, shell: false, stdio: ["pipe", "pipe", "pipe", executableBinding.handle.fd] });
  } finally {
    await executableBinding.handle.close();
  }
  if (piChild.stdin === null || piChild.stdout === null || piChild.stderr === null || !Number.isSafeInteger(piChild.pid)) throw Object.assign(new Error("Pi child did not expose owned pipes"), { code: "RPC_PROCESS_FAILED" });
  piChild.stderr.on("data", (chunk) => { void diagnostics.stderr.append(chunk).catch(() => {}); });
  const adapter = PiRpcAdapter.connect({ input: piChild.stdin, output: piChild.stdout, diagnostics: diagnostics.rpc, process: piChild, maxRecordBytes: 16 * 1024 * 1024 });
  // This worker holds the session's live tail. A daemon that restarts has none of these frames and
  // Pi has not written the newest of them to its own session file yet, so the process that produced
  // them is the one that keeps them. The whole tail travels in one frame, so it stays under half of
  // the control socket's own bound.
  const liveTail = createLiveTail({ maxBytes: Math.min(MAX_LIVE_TAIL_BYTES, Math.floor(options.maxFrameBytes / 2)) });
  adapter.onFrame((frame) => {
    liveTail.record(frame);
    sendWorkerMessage({ version: 1, type: "pi_frame", token, sessionId: options.sessionId, frame });
  });
  adapter.onEvent((event) => {
    const stateEvent = sessionEventForPiEvent(event);
    if (stateEvent !== undefined) sendWorkerMessage({ version: 1, type: "worker_event", token, sessionId: options.sessionId, event: stateEvent });
  });
  const piChildPid = /** @type {number} */ (piChild.pid);
  const piChildIdentity = await inspectProcessIdentity(piChildPid);
  if (piChildIdentity.pid === supervisorIdentity.pid || piChildIdentity.processGroupId !== supervisorIdentity.processGroupId) throw Object.assign(new Error("Pi child process identity did not inherit the supervisor group"), { code: "WORKER_IDENTITY_MISMATCH" });
  await launchConnection.send({ version: 1, type: "pi_child", token, sessionId: options.sessionId, runId: options.runId, leaseId: options.leaseId, generation: options.generation, worker: supervisorIdentity, piChild: piChildIdentity });
  await awaitLaunchMessage((message) => message?.type === "child_bound" && matchesToken(message.token, token), "WORKER_DISCONNECTED");

  const initialState = await adapter.getState();
  if (initialState?.sessionFile !== options.canonicalSessionFile) {
    throw Object.assign(new Error("Installed Pi get_state did not retain the canonical session file"), { code: "CANONICAL_SESSION_MISMATCH" });
  }
  const replay = await createWorkerReplayStore({ path: options.replayPath });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    reconnectController.abort();
    clearTimeout(startupDeadline);
    await dispatcher.close().catch(() => {});
    await adapter.close().catch(() => {});
    piChild.stdin?.end();
    // The worker owns this socket, so it removes it: a path left behind is one a later daemon would
    // connect to and be refused by, when the honest answer is that this run is gone.
    await listener.close().catch(() => {});
    await diagnostics.close().catch(() => {});
    runtimeProcess.exit(0);
  };
  /** @param {any} message @param {(message: any) => Promise<unknown> | unknown} send */
  const onTransportMessage = (message, send) => {
    if (acceptTerminalCauseAcknowledgement(message)) return;
    if (!matchesToken(message?.token, token)) return;
    if (message.type === "shutdown") { void shutdown(); return; }
    if (message.type !== "command") return;
    dispatcher.deliver(message.command).then(
      (/** @type {any} */ record) => send({ version: 1, type: "command_result", token, id: message.id, ok: true, record }),
      (/** @type {any} */ error) => send({ version: 1, type: "command_result", token, id: message.id, ok: false, error: { code: error?.code ?? "RPC_FAILED", message: error instanceof Error ? error.message : "RPC failed", deliveryUnknown: error?.deliveryUnknown === true || replayDeliveryIsAmbiguous(replay, message.command) } }),
    ).catch(() => {});
  };
  transportMessageHandler = onTransportMessage;
  for (const pending of pendingParentMessages.splice(0)) onTransportMessage(pending.message, pending.send);
  if (shuttingDown) return;
  // Pi is the authority on which model this session runs, and its initial state is the first moment
  // it says so. Readiness carries that answer, so a row shows a model without waiting for a reconnect.
  const confirmedModel = piConfirmedModel(initialState);
  const ready = { version: 1, type: "worker_ready", token, sessionId: options.sessionId, runId: options.runId, leaseId: options.leaseId, generation: options.generation, worker: supervisorIdentity, piChild: piChildIdentity, ...(confirmedModel === undefined ? {} : { model: confirmedModel }) };
  await launchConnection.send(ready);
  // The launch is over, so the startup bound is over with it. From here the worker is Pi's parent
  // and outlives daemon absence indefinitely, which is the point of it owning the socket.
  clearTimeout(startupDeadline);

  void Promise.resolve(launchConnection.closed).finally(() => {
    if (shuttingDown) return;
    sendToDaemon = undefined;
    void serveDaemonConnections({
      signal: reconnectController.signal,
      accept: () => listener.next(),
      onConnection: async (/** @type {any} */ connection) => {
        const connectionSend = (/** @type {any} */ message) => Promise.resolve(connection.send(message));
        sendToDaemon = connectionSend;
        const removeMessageListener = connection.onMessage((/** @type {any} */ message) => onTransportMessage(message, connectionSend));
        const dispose = () => { try { removeMessageListener?.(); } catch {} };
        reconnectController.signal.addEventListener("abort", dispose, { once: true });
        Promise.resolve(connection.closed).finally(() => { reconnectController.signal.removeEventListener("abort", dispose); dispose(); }).catch(() => {});
        // Readiness and the tail are written in one step, before this function awaits anything: a
        // frame Pi produces during the awaits is written after both, so the daemon reads the tail and
        // then that frame, with nothing repeated and nothing missing between them. The launch
        // connection sends no tail, because the daemon that spawned this worker has every frame.
        const readied = connectionSend(ready);
        const replayed = connectionSend({ version: 1, type: "pi_tail", token, sessionId: options.sessionId, frames: liveTail.frames(), dropped: liveTail.dropped });
        await readied;
        await replayed;
      },
    }).catch(() => {});
  }).catch(() => {});
  /** @param {number | null} code @param {NodeJS.Signals | null} signal */
  const reportPiChildExit = async (code, signal) => {
    const event = { type: "PI_CHILD_CRASHED", at: new Date().toISOString(), summary: `Pi exited unexpectedly (${signal ?? code ?? "unknown"})` };
    const cause = {
      schemaVersion: 1,
      sessionId: options.sessionId,
      runId: options.runId,
      leaseId: options.leaseId,
      generation: options.generation,
      worker: supervisorIdentity,
      piChild: piChildIdentity,
      event,
    };
    const causePath = join(dirname(options.replayPath), WORKER_TERMINAL_CAUSE_FILE);
    await publishWorkerTerminalCause(causePath, cause);
    let acknowledged = false;
    /** @type {(value?: unknown) => void} */
    let resolveAcknowledged;
    const acknowledgement = new Promise((resolve) => { resolveAcknowledged = resolve; });
    terminalCauseAcknowledgement = (message) => {
      if (!matchesToken(message?.token, token) || message?.version !== 1 || message?.type !== "terminal_cause_ack" || message.sessionId !== options.sessionId || message.runId !== options.runId || message.leaseId !== options.leaseId || message.generation !== options.generation) return false;
      acknowledged = true;
      resolveAcknowledged();
      return true;
    };
    void Promise.resolve(sendToDaemon?.({ version: 1, type: "worker_event", token, sessionId: options.sessionId, event })).catch(() => {});
    await Promise.race([acknowledgement, new Promise((resolveTimeout) => setTimeout(resolveTimeout, CRASH_REPORT_TIMEOUT_MS))]);
    terminalCauseAcknowledgement = undefined;
    if (acknowledged) await retireWorkerTerminalCause(causePath);
  };
  piChild.once("exit", (code, signal) => {
    if (shuttingDown) return;
    void reportPiChildExit(code, signal).catch(() => {})
      .finally(() => listener.close().catch(() => {}))
      .finally(() => diagnostics.close().catch(() => {}).finally(() => runtimeProcess.exit(0)));
  });
  const testExitMs = Number(runtimeProcess.env.PI_AGENTS_TEST_EXIT_MS);
  if (Number.isSafeInteger(testExitMs) && testExitMs > 0) setTimeout(() => piChild.kill("SIGTERM"), testExitMs);
}
