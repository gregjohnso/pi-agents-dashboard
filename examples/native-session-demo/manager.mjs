/**
 * One persistent native Pi owner, and the manager that holds it.
 *
 * The shape is deliberately thin. Pi is the whole product: it owns the editor, the draft, the transcript, the
 * key classification and every byte on the screen. This process owns three things Pi cannot own for itself —
 * the pseudo-terminal Pi runs on, which client a byte span came from, and when a cold client should be
 * repainted — and nothing else. There is no second viewer, no second editor, no replayed byte tail and no
 * reconstruction of Pi's state from what it drew.
 *
 * What happens, in order:
 *
 * 1. A control socket and seam E's bootstrap sideband are created in a `0700` directory.
 * 2. One owner pseudo-terminal is opened and the real bundled CLI is launched on it, once, with a replaced
 *    environment: a disposable HOME, a disposable agent and session directory, no discovered extensions and
 *    no credential. The native spawn replaces the inherited environment rather than adding to it, so nothing
 *    of the operator's own configuration reaches the owner.
 * 3. Pi connects out to the sideband and reports `native-mounted` before extensions load. From that moment
 *    clients may attach and see output; nothing here waits for first paint or initialization.
 * 4. A client's bytes are forwarded to the in-process pre-TUI caller, which dispatches them as labelled
 *    native input under that client's attachment epoch. Pi frames and classifies them.
 * 5. An attach — first or later — asks Pi for one cold presentation, which renders a complete frame from the
 *    live component tree. The draft on that screen is Pi's own, not a copy of it.
 * 6. Detach closes client connections only. The owner keeps the same PID and start identity with zero
 *    clients attached, because this process still holds the terminal.
 */

import { rm, chmod } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { ReadStream } from "node:tty";
import { fileURLToPath } from "node:url";

import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";
import { openOwnerPty } from "../../runtime/pty-mechanism.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "../../runtime/process-signaler.mjs";
import { startBootstrapSideband } from "./bootstrap-sideband.mjs";
import { resolveCohort } from "./cohort.mjs";
import { createRoot, demoPaths, removeOwnedRoot, tokenMatches, writeOwnerRecord } from "./demo-root.mjs";
import { FAKE_MODEL_ID, FAKE_PROVIDER_ID } from "./fake-provider.mjs";
import { createPendingInputQueue } from "./pending-input.mjs";
import { createFrameReader, encodeFrame, MAX_BODY_BYTES } from "./protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, "owner-preload.mjs");
const EXTENSION = path.join(HERE, "owner-extension.ts");

/** One shared geometry for every attachment. There is no per-client viewport and no controller role. */
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
/** A client this far behind is disconnected by name rather than being allowed to stall the owner. */
const CLIENT_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
/** Bytes a client may send before the in-Pi caller is ready. Admitted bytes are delivered in order, once. */
const PENDING_INPUT_LIMIT_BYTES = 64 * 1024;
const GRACEFUL_EXIT_WAIT_MS = 5_000;
/** How long `start` waits for Pi's own `native-mounted` before it reports a failure instead of a ready owner. */
const MOUNT_WAIT_MS = 60_000;
const STOP_POLICY = { gracefulMs: 3_000, terminateMs: 3_000 };

/** The launch-fixed profile. The owner decides it before Pi negotiates; no client can change it. */
function launchProfile(cols, rows) {
  return {
    profileId: "native-session-demo-owner",
    term: "xterm-256color",
    capabilities: {
      kittyKeyboard: true,
      kittyGraphics: false,
      mouse: true,
      bracketedPaste: true,
      synchronizedOutput: true,
      trueColor: true,
    },
    cellSize: null,
    geometry: { cols, rows },
  };
}

/**
 * @param {{ root: string, cols?: number, rows?: number, manifestPath?: string, cohortRoot?: string, log: (line: string) => void, onReady: (record: any) => void }} options
 */
export async function runManager({ root, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, manifestPath, cohortRoot, log, onReady }) {
  const startedAtMs = Date.now();
  const cohort = resolveCohort({ manifestPath, cohortRoot });
  const { paths, token, ownership } = await createRoot(root);
  const profile = launchProfile(cols, rows);
  const ingressLog = path.join(root, "owner-preload.jsonl");

  /** Every attachment the manager has ever issued, so an epoch is never reused for an attachment id. */
  const epochs = new Map();
  /** @type {Map<string, { id: string, epoch: number, socket: net.Socket, notices: string[] }>} */
  const clients = new Map();
  /** @type {net.Socket | undefined} */
  let ingress;
  let ingressReady = false;
  /** Bytes a client sent before the in-Pi caller was ready: bounded before admission, drained in order. */
  const pendingInput = createPendingInputQueue(PENDING_INPUT_LIMIT_BYTES);
  let inputSequence = 0;
  /** @type {any[]} */
  const readiness = [];
  /** @type {any[]} */
  const presentations = [];
  /** @type {any[]} */
  const childPhases = [];
  let bootstrapHello;
  let stopping = false;
  /** @type {any} */
  let exitRecord = null;
  /** Resolved when Pi records `native-mounted`: the phase at which a client can attach and see output. */
  let resolveMounted;
  const mounted = new Promise((resolve) => {
    resolveMounted = resolve;
  });

  const noteReadiness = (entry) => {
    readiness.push(entry);
    if (entry.phase === "native-mounted") resolveMounted(entry);
  };

  const sideband = await startBootstrapSideband(paths.bootstrapSocket, {
    onFrame: (frame) => {
      if (frame.type === "native-bootstrap") {
        bootstrapHello = frame;
        for (const entry of frame.reached ?? []) noteReadiness({ ...entry, viaHello: true, atHostMs: Date.now() });
        log(`sideband hello: pid ${frame.pid}, seam ${frame.capability?.seam}, reached ${(frame.reached ?? []).map((e) => e.phase).join(",") || "none"}`);
      } else if (frame.type === "native-readiness") {
        noteReadiness({ ...frame.readiness, atHostMs: Date.now() });
        log(`readiness ${frame.readiness.phase} at ${Date.now() - startedAtMs}ms`);
      } else if (frame.type === "error") {
        log(`sideband error: ${JSON.stringify(frame.error)}`);
      }
    },
    onError: (error) => log(`sideband transport: ${error.message}`),
  });

  const ownerEnv = {
    // A replaced environment, not an augmented one: the native spawn does not inherit, and this is the whole
    // list. No API key, no operator HOME, no operator agent directory, no real session store.
    PATH: "/usr/bin:/bin",
    HOME: paths.home,
    TERM: profile.term,
    COLUMNS: String(cols),
    LINES: String(rows),
    LANG: "C.UTF-8",
    PI_CODING_AGENT_DIR: paths.agent,
    PI_CODING_AGENT_SESSION_DIR: paths.sessions,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_NATIVE_BOOTSTRAP_SOCKET: paths.bootstrapSocket,
    PI_DEMO_TUI_PACKAGE: cohort.tuiPackageRoot,
    PI_DEMO_CONTROL_SOCKET: paths.controlSocket,
    PI_DEMO_TOKEN: token,
    PI_DEMO_PROFILE: JSON.stringify(profile),
    PI_DEMO_LOG: ingressLog,
  };
  const ownerArgs = [
    "--import",
    PRELOAD,
    cohort.bundledCli,
    "--tui-mode",
    "regular",
    "--no-extensions",
    "-e",
    EXTENSION,
    "--provider",
    FAKE_PROVIDER_ID,
    "--model",
    FAKE_MODEL_ID,
    // The fake provider answers text only. Tool execution is not part of what this demo shows.
    "-nt",
  ];

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.controlSocket, () => resolve(undefined));
  });
  await chmod(paths.controlSocket, 0o600);

  const handle = await openOwnerPty({ command: process.execPath, args: ownerArgs, env: ownerEnv, cwd: paths.project, cols, rows });
  // The one place this process takes the master descriptor into a stream. The stream owns its lifetime from
  // here on, so nothing else closes that fd: a second close could land on a descriptor the runtime recycled.
  const ownerOutput = new ReadStream(handle.masterFd);
  ownerOutput.on("error", (error) => log(`owner terminal read: ${error.message}`));

  const ownerIdentity = { ...handle.owner, launchedAtMs: startedAtMs };
  log(`owner pid ${ownerIdentity.pid}, startIdentity ${ownerIdentity.startIdentity}, session ${ownerIdentity.sessionId}, geometry ${cols}x${rows}`);

  const send = (socket, header, body) => {
    if (socket.destroyed) return;
    try {
      socket.write(encodeFrame(header, body));
    } catch (error) {
      log(`frame write failed: ${/** @type {Error} */ (error).message}`);
    }
  };

  const resumeOwnerOutputIfDrained = () => {
    if (stopping) return;
    for (const client of clients.values()) {
      if (client.socket.writableLength > CLIENT_BUFFER_LIMIT_BYTES / 4) return;
    }
    ownerOutput.resume();
  };

  // One ordered fan-out of the owner's own bytes. Nothing is retained for a later client: a reattachment is
  // repainted by Pi, not replayed from here.
  ownerOutput.on("data", (chunk) => {
    for (let offset = 0; offset < chunk.byteLength; offset += MAX_BODY_BYTES) {
      const slice = chunk.subarray(offset, Math.min(offset + MAX_BODY_BYTES, chunk.byteLength));
      for (const client of clients.values()) send(client.socket, { type: "output" }, slice);
    }
    for (const client of clients.values()) {
      if (client.socket.writableLength > CLIENT_BUFFER_LIMIT_BYTES) {
        log(`client ${client.id} epoch ${client.epoch} is ${client.socket.writableLength} bytes behind; disconnecting it rather than stalling the owner`);
        detachClient(client, "backpressure: this client fell too far behind the owner's output");
      } else if (client.socket.writableLength > CLIENT_BUFFER_LIMIT_BYTES / 4) {
        ownerOutput.pause();
      }
    }
  });

  /** @param {{ id: string, epoch: number, socket: net.Socket }} client @param {string} reason */
  function detachClient(client, reason) {
    if (!clients.has(client.id)) return;
    clients.delete(client.id);
    send(client.socket, { type: "bye", reason });
    client.socket.end();
    log(`detached ${client.id} epoch ${client.epoch}: ${reason}`);
    resumeOwnerOutputIfDrained();
  }

  function forwardInput(entry) {
    inputSequence += 1;
    send(ingress, { type: "input", sequence: inputSequence, attachmentId: entry.attachmentId, epoch: entry.epoch, generation: entry.generation }, entry.bytes);
  }

  function flushPendingInput() {
    for (const entry of pendingInput.drain()) forwardInput(entry);
  }

  async function presentTo(client) {
    if (!sideband.connected()) {
      send(client.socket, { type: "notice", text: "Pi has not connected to the bootstrap sideband yet, so no cold presentation was requested" });
      return;
    }
    const requestedAtMs = Date.now();
    try {
      const result = await sideband.present({ attachmentId: client.id, epoch: client.epoch, geometryRevision: 1 });
      const record = { attachmentId: client.id, epoch: client.epoch, requestedAtMs, elapsedMs: Date.now() - requestedAtMs, result };
      presentations.push(record);
      log(`cold presentation for ${client.id} epoch ${client.epoch}: ${JSON.stringify(result)} in ${record.elapsedMs}ms`);
    } catch (error) {
      presentations.push({ attachmentId: client.id, epoch: client.epoch, requestedAtMs, error: /** @type {Error} */ (error).message });
      log(`cold presentation for ${client.id} failed: ${/** @type {Error} */ (error).message}`);
      send(client.socket, { type: "notice", text: `cold presentation failed: ${/** @type {Error} */ (error).message}` });
    }
  }

  function statusRecord() {
    return {
      root,
      owner: ownerIdentity,
      geometry: { cols, rows },
      profileId: profile.profileId,
      provider: `${FAKE_PROVIDER_ID}/${FAKE_MODEL_ID}`,
      providerIsFake: true,
      cohort: { consumerRoot: cohort.consumerRoot, bundledCli: cohort.bundledCli, manifest: cohort.manifestPath, buildSlurmJobId: cohort.buildSlurmJobId, patchedTreeHash: cohort.patchedTreeHash },
      bootstrapPid: bootstrapHello?.pid ?? null,
      readiness,
      presentations,
      childPhases,
      ingressReady,
      attachments: [...clients.values()].map((client) => ({ attachmentId: client.id, epoch: client.epoch })),
      issuedEpochs: [...epochs.entries()].map(([id, epoch]) => ({ attachmentId: id, epoch })),
      reaped: handle.reapIfExited(),
      exit: exitRecord,
      ownerAliveWithZeroClients: clients.size === 0 && handle.reapIfExited() === null,
      atMs: Date.now(),
    };
  }

  server.on("connection", (socket) => {
    let role = null;
    /** @type {{ id: string, epoch: number, socket: net.Socket, notices: string[] } | undefined} */
    let client;
    socket.on("error", () => {});

    const refuse = (text) => {
      send(socket, { type: "refused", text });
      socket.end();
    };

    const reader = createFrameReader(
      ({ header, body }) => {
        // Nothing is forwarded before the token is accepted.
        if (role === null) {
          if (header.type !== "hello" || !tokenMatches(header.token, token)) {
            log(`refused a connection: ${header.type === "hello" ? "bad token" : `first frame was ${header.type}`}`);
            refuse("authentication failed");
            return;
          }
          role = header.role;
          if (role === "ingress") {
            ingress = socket;
            log(`in-Pi ingress caller connected from pid ${header.pid}`);
            return;
          }
          if (role === "control") {
            return;
          }
          if (role !== "client") {
            refuse(`unknown role ${JSON.stringify(role)}`);
            return;
          }
          const id = typeof header.attachmentId === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(header.attachmentId) ? header.attachmentId : `a${epochs.size + 1}`;
          const superseded = clients.get(id);
          const epoch = (epochs.get(id) ?? 0) + 1;
          epochs.set(id, epoch);
          if (superseded) detachClient(superseded, "superseded by a newer epoch of the same attachment id");
          client = { id, epoch, socket, notices: [] };
          clients.set(id, client);
          log(`attached ${id} epoch ${epoch}, ${clients.size} client(s) now attached`);
          send(socket, {
            type: "welcome",
            attachmentId: id,
            epoch,
            geometry: { cols, rows },
            owner: ownerIdentity,
            provider: `${FAKE_PROVIDER_ID}/${FAKE_MODEL_ID} (FAKE: deterministic, no model is called)`,
            ingressReady,
          });
          void presentTo(client);
          return;
        }

        if (role === "ingress") {
          if (header.type === "ingress-ready") {
            ingressReady = true;
            log(`labelled ingress ready in Pi pid ${header.pid}, tui mode ${header.tuiMode}; flushing ${pendingInput.length()} held frame(s)`);
            flushPendingInput();
          } else if (header.type === "ingress-unavailable") {
            log(`labelled ingress unavailable: ${header.reason}`);
          } else if (header.type === "input-result") {
            if (header.admitted === false) {
              log(`Pi refused input sequence ${header.sequence}: ${header.reason}`);
              for (const attached of clients.values()) send(attached.socket, { type: "notice", text: `Pi refused a labelled input span: ${header.reason}` });
            }
          } else if (header.type === "child-terminal-phase") {
            childPhases.push({ ...header.phase, atHostMs: Date.now() });
            log(`child terminal ${header.phase.phase} ${header.phase.childPhaseId} ${header.phase.reason}`);
          }
          return;
        }

        if (role === "control") {
          if (header.type === "status") {
            send(socket, { type: "status", status: statusRecord() });
          } else if (header.type === "detach") {
            const targets = header.attachmentId ? [clients.get(header.attachmentId)].filter(Boolean) : [...clients.values()];
            for (const target of targets) detachClient(target, "operator detach");
            send(socket, { type: "detached", attachments: targets.map((target) => ({ attachmentId: target.id, epoch: target.epoch })), remaining: clients.size, owner: ownerIdentity, ownerReaped: handle.reapIfExited() });
          } else if (header.type === "stop") {
            send(socket, { type: "stopping" });
            void stop(header.keepRoot === true).then((record) => {
              // The answer goes out before the listener is closed: a control connection that was torn down
              // first would leave the operator without the owner's real exit status.
              send(socket, { type: "stopped", ...record });
              socket.end();
              server.close(() => process.exit(0));
              setTimeout(() => process.exit(0), 1_000).unref();
            });
          } else {
            refuse(`unknown control frame ${JSON.stringify(header.type)}`);
          }
          return;
        }

        if (role === "client") {
          if (header.type === "input") {
            const entry = { attachmentId: client.id, epoch: client.epoch, generation: 1, bytes: Buffer.from(body) };
            if (ingressReady && ingress && !ingress.destroyed) {
              forwardInput(entry);
              return;
            }
            // The bound is decided before the bytes are held, so a refused span is never delivered later.
            const admission = pendingInput.admit(entry);
            if (admission.outcome === "refused") {
              // Refusing the attachment is honest; silently discarding an operator's keystrokes is not.
              detachClient(client, `the in-Pi labelled ingress was not ready and ${admission.reason}`);
            }
          } else if (header.type === "detach") {
            detachClient(client, "client requested detach");
          }
        }
      },
      (error) => {
        log(`refused a peer frame: ${error.code} ${error.message}`);
        socket.destroy();
      },
    );

    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("drain", resumeOwnerOutputIfDrained);
    socket.on("close", () => {
      if (client && clients.get(client.id) === client) {
        clients.delete(client.id);
        log(`attachment ${client.id} epoch ${client.epoch} closed its connection, ${clients.size} client(s) remain`);
        resumeOwnerOutputIfDrained();
      }
      if (role === "ingress" && ingress === socket) {
        ingress = undefined;
        ingressReady = false;
        log("the in-Pi ingress caller disconnected");
      }
    });
  });

  /**
   * Explicit stop: this owner, and nothing else.
   *
   * The graceful gesture is Pi's own end-of-input, dispatched through the same labelled path a client's keys
   * take, so Pi decides what it means. Escalation past that is the repository's verified group stop, which
   * re-reads PID, start identity and process group immediately before every signal, so a recycled PID cannot
   * be signalled. The reaped status is read before any signal, because after one it can no longer be told
   * apart from the exit it caused.
   *
   * @param {boolean} keepRoot
   */
  async function stop(keepRoot) {
    if (stopping) return { alreadyStopping: true };
    stopping = true;
    const stopStartedMs = Date.now();
    for (const client of [...clients.values()]) detachClient(client, "the owner is stopping");

    const alreadyReaped = handle.reapIfExited();
    if (alreadyReaped === null && ingressReady && ingress && !ingress.destroyed) {
      log("dispatching Pi's own end-of-input as the graceful stop gesture");
      forwardInput({ attachmentId: "manager-stop", epoch: 1, generation: 1, bytes: Buffer.from([0x04]) });
    }
    let exit = await Promise.race([handle.wait(), sleep(GRACEFUL_EXIT_WAIT_MS).then(() => null)]);
    let disposition = exit ? "graceful" : null;
    if (!exit) {
      log("the owner did not exit on its own; escalating through the verified group stop");
      const outcome = await stopVerifiedProcessGroup(
        { pid: ownerIdentity.pid, processGroupId: ownerIdentity.processGroupId, startIdentity: ownerIdentity.startIdentity },
        {
          inspect: (pid) => inspectProcessIdentity(pid),
          requestGraceful: async () => {},
          signalProcessGroup,
          sleep,
        },
        STOP_POLICY,
      );
      disposition = outcome.disposition;
      log(`verified group stop: ${JSON.stringify(outcome)}`);
      exit = await Promise.race([handle.wait(), sleep(GRACEFUL_EXIT_WAIT_MS).then(() => null)]);
    }
    exitRecord = { ...(exit ?? {}), waitObserved: exit !== null, disposition, elapsedMs: Date.now() - stopStartedMs };
    if (exit === null) {
      log(`no raw wait status was observed for owner ${ownerIdentity.pid} within ${GRACEFUL_EXIT_WAIT_MS}ms of ${disposition ?? "the graceful gesture"}; this teardown is unverified, not graceful`);
    }
    log(`owner ${ownerIdentity.pid} exit: ${JSON.stringify(exitRecord)}`);

    const finalStatus = statusRecord();
    await writeOwnerRecord(root, { ...finalStatus, stopped: true });
    // Destroying the read stream closes the master descriptor, which is this process's only claim on the
    // terminal. It happens once, after the owner is gone, and nothing closes that fd again.
    ownerOutput.destroy();
    await sideband.close();
    // The root is removed only while it is still the one `createRoot` created here. A root that was replaced,
    // or a `--keep-root` run, keeps its evidence: a failed teardown must not delete someone else's directory.
    const rootRemoval = keepRoot
      ? { removed: false, reason: "--keep-root was asked for, so this owner's root and its evidence are kept" }
      : await removeOwnedRoot(root, ownership);
    if (!rootRemoval.removed) {
      await rm(paths.controlSocket, { force: true });
      log(`stopped; root kept: ${rootRemoval.reason}`);
    } else {
      log(`stopped; root removed: ${rootRemoval.reason}`);
    }
    return { owner: ownerIdentity, exit: exitRecord, rootKept: !rootRemoval.removed, rootRemoval };
  }

  // `start` returns at `native-mounted`, not at first paint and not at initialization. That is the phase at
  // which a key reaches the editor and a frame reaches the terminal, so it is the phase at which attaching is
  // meaningful — and a blocking startup dialog must not hold an operator's attach command.
  const mountedRecord = await Promise.race([
    mounted,
    sleep(MOUNT_WAIT_MS).then(() => {
      throw new Error(`Pi did not record native-mounted within ${MOUNT_WAIT_MS}ms; see ${paths.log}`);
    }),
  ]);
  log(`native-mounted after ${mountedRecord.atHostMs - startedAtMs}ms; attaching is now meaningful`);

  const record = {
    ...statusRecord(),
    controlSocket: paths.controlSocket,
    bootstrapSocket: paths.bootstrapSocket,
    ingressLog,
    managerPid: process.pid,
    managerLog: paths.log,
  };
  await writeOwnerRecord(root, record);
  onReady(record);

  // A silent exit of the owner is reported, not hidden: the record keeps the real wait status.
  void handle.wait().then(
    async (exit) => {
      if (stopping) return;
      exitRecord = { ...exit, disposition: "exited-on-its-own" };
      log(`the owner exited on its own: ${JSON.stringify(exit)}`);
      for (const client of [...clients.values()]) detachClient(client, `the owner exited: ${JSON.stringify(exit)}`);
      await writeOwnerRecord(root, { ...statusRecord(), stopped: false });
    },
    (error) => log(`waiting for the owner failed: ${error.message}`),
  );

  return { stop, statusRecord };
}
