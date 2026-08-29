import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import { openPiExecutableBinding } from "./pi-executable.mjs";
import { PiRpcAdapter, piRpcArgv } from "./pi-rpc-adapter.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";
import { openRotatingDiagnostics } from "./rotating-diagnostics.mjs";
import { sessionEventForPiEvent } from "./session-event-mapping.mjs";
import { createWorkerCommandDispatcher, createWorkerReplayStore, maintainDaemonConnection, replayDeliveryIsAmbiguous } from "./worker.mjs";

const MAX_PENDING_PARENT_MESSAGES = 256;
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
  for (const required of ["session-id", "canonical-session-file", "cwd", "run-id", "lease-id", "generation", "replay-path", "pi-executable", "pi-identity", "capabilities", "diagnostics-directory"]) {
    if (!values.has(required)) throw new TypeError(`Missing worker argument: --${required}`);
  }
  const generation = Number(values.get("generation"));
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new TypeError("Worker generation must be positive");
  let executable;
  let capabilities;
  let daemonConnectConfig;
  let reconnectDelaysMs;
  try {
    executable = JSON.parse(values.get("pi-identity"));
    capabilities = JSON.parse(values.get("capabilities"));
    daemonConnectConfig = JSON.parse(values.get("daemon-connect-config") ?? "{}");
    reconnectDelaysMs = JSON.parse(values.get("reconnect-delays-ms") ?? "[100,250,500,1000,2000]");
  } catch (cause) {
    throw new TypeError("Worker structured arguments must contain valid JSON", { cause });
  }
  return {
    sessionId: values.get("session-id"), canonicalSessionFile: values.get("canonical-session-file"), cwd: values.get("cwd"), runId: values.get("run-id"),
    leaseId: values.get("lease-id"), generation, replayPath: values.get("replay-path"), piExecutable: values.get("pi-executable"), executable, capabilities,
    diagnosticsDirectory: values.get("diagnostics-directory"), model: values.has("model-provider") ? { provider: values.get("model-provider"), id: values.get("model-id") } : undefined,
    thinkingLevel: values.get("thinking-level"), name: values.get("name"), daemonConnector: values.get("daemon-connector"), daemonConnectConfig, reconnectDelaysMs,
  };
}


/** @param {NodeJS.Process} runtimeProcess */
export async function runInstalledPiWorker(runtimeProcess) {
  const options = parseArgs(runtimeProcess.argv.slice(2));
  const token = runtimeProcess.env.PI_AGENTS_WORKER_TOKEN;
  if (typeof token !== "string" || token.length === 0 || typeof runtimeProcess.send !== "function") throw new Error("Worker requires an authenticated IPC launch channel");
  /** @type {((message: any) => Promise<unknown>) | undefined} */
  let sendToDaemon;
  /** @param {any} message */
  const sendWorkerMessage = (message) => runtimeProcess.connected ? runtimeProcess.send?.(message) : void sendToDaemon?.(message).catch(() => {});
  /** @type {{ message: any, send: (message: any) => unknown }[]} */
  const pendingParentMessages = [];
  /** @type {((message: any, send: (message: any) => unknown) => void) | undefined} */
  let transportMessageHandler;
  /** @param {any} message */
  const onParentMessage = (message) => {
    if (!matchesToken(message?.token, token) || !["command", "shutdown"].includes(message.type)) return;
    const send = (/** @type {any} */ response) => runtimeProcess.send?.(response);
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
  runtimeProcess.on("message", onParentMessage);
  const supervisorIdentity = await inspectProcessIdentity(runtimeProcess.pid);
  runtimeProcess.send({ version: 1, type: "worker_hello", token, sessionId: options.sessionId, runId: options.runId, leaseId: options.leaseId, generation: options.generation, worker: supervisorIdentity });

  const activation = /** @type {any} */ (await new Promise((resolveActivation, rejectActivation) => {
    /** @param {unknown} [error] @param {any} [message] */
    const finish = (error, message) => {
      runtimeProcess.off("message", onMessage);
      runtimeProcess.off("disconnect", onDisconnect);
      if (error) rejectActivation(error); else resolveActivation(message);
    };
    /** @param {any} message */
    const onMessage = (message) => message?.type === "activate" ? finish(undefined, message) : message?.type === "reject" ? finish(Object.assign(new Error("Worker rejected"), { code: "WORKER_REJECTED" })) : undefined;
    const onDisconnect = () => finish(Object.assign(new Error("Worker launch channel closed"), { code: "WORKER_DISCONNECTED" }));
    runtimeProcess.on("message", onMessage);
    runtimeProcess.once("disconnect", onDisconnect);
  }));
  if (!matchesToken(activation?.token, token) || activation?.leaseId !== options.leaseId || activation?.generation !== options.generation) throw Object.assign(new Error("Worker activation mismatch"), { code: "WORKER_ACTIVATION_MISMATCH" });

  const executableBinding = await openPiExecutableBinding(options.executable);
  const diagnostics = await openRotatingDiagnostics({ directory: options.diagnosticsDirectory });
  const argv = piRpcArgv({ sessionFile: options.canonicalSessionFile, model: options.model, thinkingLevel: options.thinkingLevel, name: options.name });
  let piChild;
  try {
    piChild = spawn(executableBinding.executionPath, argv, { cwd: options.cwd, env: runtimeProcess.env, detached: false, shell: false, stdio: ["pipe", "pipe", "pipe", executableBinding.handle.fd] });
  } finally {
    await executableBinding.handle.close();
  }
  if (piChild.stdin === null || piChild.stdout === null || piChild.stderr === null || !Number.isSafeInteger(piChild.pid)) throw Object.assign(new Error("Pi child did not expose owned pipes"), { code: "RPC_PROCESS_FAILED" });
  piChild.stderr.on("data", (chunk) => { void diagnostics.stderr.append(chunk).catch(() => {}); });
  const adapter = PiRpcAdapter.connect({ input: piChild.stdin, output: piChild.stdout, diagnostics: diagnostics.rpc, process: piChild, maxRecordBytes: 16 * 1024 * 1024 });
  adapter.onFrame((frame) => sendWorkerMessage({ version: 1, type: "pi_frame", token, sessionId: options.sessionId, frame }));
  adapter.onEvent((event) => {
    const stateEvent = sessionEventForPiEvent(event);
    if (stateEvent !== undefined) sendWorkerMessage({ version: 1, type: "worker_event", token, sessionId: options.sessionId, event: stateEvent });
  });
  const piChildPid = /** @type {number} */ (piChild.pid);
  const piChildIdentity = await inspectProcessIdentity(piChildPid);
  if (piChildIdentity.pid === supervisorIdentity.pid || piChildIdentity.processGroupId !== supervisorIdentity.processGroupId) throw Object.assign(new Error("Pi child process identity did not inherit the supervisor group"), { code: "WORKER_IDENTITY_MISMATCH" });
  runtimeProcess.send({ version: 1, type: "pi_child", token, sessionId: options.sessionId, runId: options.runId, leaseId: options.leaseId, generation: options.generation, worker: supervisorIdentity, piChild: piChildIdentity });
  await new Promise((resolveBound, rejectBound) => {
    /** @param {unknown} [error] */
    const finish = (error) => { runtimeProcess.off("message", onMessage); runtimeProcess.off("disconnect", onDisconnect); error ? rejectBound(error) : resolveBound(undefined); };
    /** @param {any} message */
    const onMessage = (message) => message?.type === "child_bound" && matchesToken(message.token, token) ? finish() : message?.type === "shutdown" ? finish(new Error("Worker stopped before child bind")) : undefined;
    const onDisconnect = () => finish(new Error("Worker channel closed before child bind"));
    runtimeProcess.on("message", onMessage);
    runtimeProcess.once("disconnect", onDisconnect);
  });

  const initialState = await adapter.getState();
  if (initialState?.sessionFile !== options.canonicalSessionFile) {
    throw Object.assign(new Error("Installed Pi get_state did not retain the canonical session file"), { code: "CANONICAL_SESSION_MISMATCH" });
  }
  const replay = await createWorkerReplayStore({ path: options.replayPath });
  const dispatcher = createWorkerCommandDispatcher({ replay, adapter });
  const reconnectController = new AbortController();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    reconnectController.abort();
    await dispatcher.close().catch(() => {});
    await adapter.close().catch(() => {});
    piChild.stdin?.end();
    await diagnostics.close().catch(() => {});
    runtimeProcess.exit(0);
  };
  /** @param {any} message @param {(message: any) => Promise<unknown> | unknown} send */
  const onTransportMessage = (message, send) => {
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
  const ready = { version: 1, type: "worker_ready", token, sessionId: options.sessionId, runId: options.runId, leaseId: options.leaseId, generation: options.generation, worker: supervisorIdentity, piChild: piChildIdentity };
  runtimeProcess.send(ready);

  if (options.daemonConnector !== undefined) {
    runtimeProcess.once("disconnect", () => {
      void maintainDaemonConnection({
        signal: reconnectController.signal, delaysMs: options.reconnectDelaysMs, sleep: (/** @type {number} */ ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
        connect: async () => {
          const target = options.daemonConnector.startsWith("file:") ? options.daemonConnector : pathToFileURL(options.daemonConnector).href;
          const connector = await import(target);
          return connector.connectDaemon({ config: options.daemonConnectConfig, signal: reconnectController.signal });
        },
        onConnection: async (/** @type {any} */ connection) => {
          const connectionSend = (/** @type {any} */ message) => Promise.resolve(connection.send(message));
          sendToDaemon = connectionSend;
          const removeMessageListener = connection.onMessage((/** @type {any} */ message) => onTransportMessage(message, connectionSend));
          const dispose = () => { try { removeMessageListener?.(); } catch {} };
          reconnectController.signal.addEventListener("abort", dispose, { once: true });
          Promise.resolve(connection.closed).finally(() => { reconnectController.signal.removeEventListener("abort", dispose); dispose(); }).catch(() => {});
          await connectionSend(ready);
        },
      }).catch(() => {});
    });
  }
  /** @param {number | null} code @param {NodeJS.Signals | null} signal */
  const reportPiChildExit = async (code, signal) => {
    const event = { type: "PI_CHILD_CRASHED", at: new Date().toISOString(), summary: `Pi exited unexpectedly (${signal ?? code ?? "unknown"})` };
    const message = { version: 1, type: "worker_event", token, sessionId: options.sessionId, event };
    const delivered = runtimeProcess.connected
      ? new Promise((resolveSend) => { runtimeProcess.send?.(message, () => resolveSend(undefined)); })
      : Promise.resolve(sendToDaemon?.(message));
    await Promise.race([delivered, new Promise((resolveTimeout) => setTimeout(resolveTimeout, CRASH_REPORT_TIMEOUT_MS))]);
  };
  piChild.once("exit", (code, signal) => {
    if (shuttingDown) return;
    void reportPiChildExit(code, signal).catch(() => {}).finally(() => diagnostics.close().catch(() => {}).finally(() => runtimeProcess.exit(0)));
  });
  const testExitMs = Number(runtimeProcess.env.PI_AGENTS_TEST_EXIT_MS);
  if (Number.isSafeInteger(testExitMs) && testExitMs > 0) setTimeout(() => piChild.kill("SIGTERM"), testExitMs);
}
