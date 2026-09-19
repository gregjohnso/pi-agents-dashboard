/**
 * One real Pi owner under a pseudo-terminal this host owns, and the two test-only transports that reach it.
 *
 * What is real here, and what is not, stated before anything else:
 *
 * - **Real.** The Pi process is the accepted cohort's own bundled CLI. The pseudo-terminal is opened by this
 *   worktree's `openOwnerPty`, so this process holds the master descriptor and every byte a case decodes is a
 *   `Buffer` read off that master while Pi is still running. The input target, its publication, its dispatch
 *   and the attachment-host registration are the installed `pi-tui`'s own public API, called inside Pi's
 *   process. The bootstrap channel is Pi's own protocol-2 sideband over a real unix socket. The blocked
 *   `session_start` handler is a real extension handler that never resolves.
 * - **Not real, and never claimed to be.** {@link relayedInputTargetRegistry} is a *test transport*, versioned
 *   and named as such. The published registry is process-local to Pi; nothing here makes it shared. The
 *   adapter relays one snapshot's *facts* and forwards one dispatch call to the process that owns the
 *   registry, and it is not product wiring: the integration owner builds the real transport later.
 *
 * The Pi-side half is {@link PI_SIDE_PRELOAD}, loaded with `node --import` so it runs before the CLI's main
 * entry and can register the attachment host before the renderer's startup queries. It speaks
 * {@link RELAY_PROTOCOL_VERSION} and nothing else: an unknown version is refused rather than guessed.
 */

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";

/** This transport's own version. The Pi side refuses anything else, so a drifted fixture fails loudly. */
export const RELAY_PROTOCOL_VERSION = 1;

const here = path.dirname(fileURLToPath(import.meta.url));
/** The Pi-side consumer, loaded with `--import` before the CLI's main entry. */
export const PI_SIDE_PRELOAD = path.join(here, "pi-side-target-relay.mjs");
/** The extension that registers the fake provider at load time and then blocks `session_start` forever. */
export const PI_SIDE_EXTENSION = path.join(here, "blocking-provider-extension.ts");

/**
 * One newline-delimited JSON channel, framed the way both sidebands here are framed.
 *
 * `waitFor` resolves from an arriving frame, never from a poll: a case that waits forever fails on its own
 * bound instead of hanging the suite.
 *
 * @param {(frame: any) => void} [onFrame]
 */
function frameChannel(onFrame) {
  /** @type {any[]} */
  const frames = [];
  /** @type {{ predicate: (frame: any) => boolean, resolve: (frame: any) => void }[]} */
  const waiters = [];
  return {
    frames,
    deliver(frame) {
      frames.push(frame);
      if (onFrame !== undefined) onFrame(frame);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(frame)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    },
    /** @param {(frame: any) => boolean} predicate @param {string} label @param {number} [timeoutMs] */
    waitFor(predicate, label, timeoutMs = 60_000) {
      const existing = frames.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          reject(new Error(`no ${label} arrived within ${timeoutMs}ms; frames so far: ${JSON.stringify(frames).slice(0, 2000)}`));
        }, timeoutMs);
        waiter.resolve = (frame) => {
          clearTimeout(timer);
          resolve(frame);
        };
      });
    },
  };
}

/** @param {net.Socket} socket @param {(line: string) => void} onLine */
function readLines(socket, onLine) {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim().length > 0) onLine(line);
      newline = buffered.indexOf("\n");
    }
  });
}

/**
 * The host-side relay for Pi's process-local input target.
 *
 * `snapshot()` answers the facts of the last publication frame the Pi side sent — `apiVersion`,
 * `producerVersion`, the publication record and the unavailable reason — and a `target` whose
 * `dispatchNativeInput` forwards one labelled span to the process that owns the registry and resolves with
 * that process's own `dispatchNativeInput` result. Nothing is invented: when the Pi side reports no target,
 * this reports no target, and the host refuses by the registry's own reason.
 *
 * @param {string} socketPath
 */
export async function relayedInputTargetRegistry(socketPath) {
  const channel = frameChannel();
  /** @type {any} */
  let state = { apiVersion: null, producerVersion: null, publication: null, reason: "relay-not-connected", hasTarget: false };
  /** @type {((snapshot: any) => void)[]} */
  const listeners = [];
  /** @type {Map<string, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  /** @type {net.Socket | null} */
  let peer = null;
  let dispatchSequence = 0;

  const snapshot = () => ({
    apiVersion: state.apiVersion,
    producerVersion: state.producerVersion,
    publication: state.publication,
    reason: state.hasTarget ? null : state.reason,
    target: state.hasTarget
      ? {
          publication: state.publication,
          /** @param {{ attachmentEpoch: any, bytes: Uint8Array, binding: { generation: number } }} input */
          dispatchNativeInput(input) {
            if (peer === null || peer.destroyed) return Promise.resolve({ admitted: false, reason: "target-revoked" });
            dispatchSequence += 1;
            const requestId = `dispatch-${dispatchSequence}`;
            return new Promise((resolve, reject) => {
              pending.set(requestId, { resolve, reject });
              const timer = setTimeout(() => {
                if (!pending.delete(requestId)) return;
                reject(new Error(`the Pi side never answered ${requestId} within 60000ms`));
              }, 60_000);
              pending.set(requestId, {
                resolve: (value) => {
                  clearTimeout(timer);
                  resolve(value);
                },
                reject: (error) => {
                  clearTimeout(timer);
                  reject(error);
                },
              });
              peer?.write(
                `${JSON.stringify({
                  type: "dispatch",
                  relayProtocol: RELAY_PROTOCOL_VERSION,
                  requestId,
                  attachmentEpoch: input.attachmentEpoch,
                  bytesBase64: Buffer.from(input.bytes).toString("base64"),
                  binding: input.binding,
                })}\n`,
              );
            });
          },
        }
      : null,
  });

  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    peer = connection;
    connection.on("error", () => {});
    readLines(connection, (line) => {
      const frame = JSON.parse(line);
      channel.deliver(frame);
      if (frame.type === "publication") {
        state = {
          apiVersion: frame.apiVersion ?? null,
          producerVersion: frame.producerVersion ?? null,
          publication: frame.publication ?? null,
          reason: frame.reason ?? null,
          hasTarget: frame.hasTarget === true,
        };
        const current = snapshot();
        for (const listener of [...listeners]) listener(current);
        return;
      }
      if (frame.type === "dispatch-result") {
        const waiting = pending.get(frame.requestId);
        if (waiting === undefined) return;
        pending.delete(frame.requestId);
        if (frame.failed === true) waiting.reject(new Error(String(frame.error)));
        else waiting.resolve(frame.result);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });

  return {
    relayProtocol: RELAY_PROTOCOL_VERSION,
    frames: channel.frames,
    waitFor: channel.waitFor,
    /** Exactly the published snapshot/subscription shape the host consumes, relayed from Pi's own process. */
    registry: {
      snapshot,
      /** @param {(snapshot: any) => void} listener */
      subscribe(listener) {
        listeners.push(listener);
        return {
          snapshot: snapshot(),
          unsubscribe() {
            const at = listeners.indexOf(listener);
            if (at >= 0) listeners.splice(at, 1);
          },
        };
      },
    },
    async close() {
      peer?.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * Pi's own protocol-2 bootstrap sideband, host side: the listener Pi connects out to.
 *
 * The hello is whatever Pi really sends; the host validates it. `send` is the exact shape
 * `createPtyHost({ presentation })` consumes: one command frame in, its own reply frame out, correlated by
 * `requestId` and rejected when the channel is lost.
 *
 * @param {string} socketPath
 */
export async function bootstrapListener(socketPath) {
  const channel = frameChannel();
  /** @type {Map<string, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const waiting = new Map();
  /** @type {net.Socket | null} */
  let peer = null;
  /** @type {any} */
  let hello = null;

  const abandon = () => {
    for (const [requestId, settle] of [...waiting.entries()]) {
      waiting.delete(requestId);
      settle.reject(new Error("the bootstrap channel closed before this request was answered"));
    }
  };

  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    peer = connection;
    connection.on("error", abandon);
    connection.on("close", abandon);
    readLines(connection, (line) => {
      const frame = JSON.parse(line);
      channel.deliver(frame);
      if (frame.type === "native-bootstrap") hello = frame;
      const settle = waiting.get(frame.requestId);
      if (settle === undefined) return;
      waiting.delete(frame.requestId);
      settle.resolve(frame);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });

  return {
    frames: channel.frames,
    waitFor: channel.waitFor,
    /** The channel the host consumes: Pi's own hello, and one command to its own reply. */
    channel: {
      get hello() {
        return hello;
      },
      /** @param {any} command */
      send(command) {
        return new Promise((resolve, reject) => {
          if (peer === null || peer.destroyed) {
            reject(new Error("Pi has not connected to the bootstrap sideband"));
            return;
          }
          waiting.set(command.requestId, { resolve, reject });
          peer.write(`${JSON.stringify(command)}\n`);
        });
      },
    },
    async close() {
      abandon();
      peer?.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * The disposable root one Pi owner runs in: its own HOME, agent, session and project directories.
 *
 * Socket pathnames are short on purpose. A unix socket path is bounded well below a filesystem path, and a
 * long temporary directory silently fails to bind.
 */
export async function disposablePiRoot() {
  const root = await mkdtemp("/tmp/host-real-pi-");
  const owned = {
    root,
    home: path.join(root, "h"),
    agent: path.join(root, "a"),
    sessions: path.join(root, "s"),
    project: path.join(root, "p"),
    bootstrapSocket: path.join(root, "b"),
    relaySocket: path.join(root, "r"),
    relayLog: path.join(root, "relay.log"),
    extensionLog: path.join(root, "extension.log"),
  };
  for (const directory of [owned.home, owned.agent, owned.sessions, owned.project]) await mkdir(directory, { recursive: true });
  return {
    ...owned,
    async remove() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * A client whose terminal output is a real `Writable`, acknowledging only what that stream accepted in order.
 *
 * The same boundary the unit suite uses, kept here so a real-Pi case proves an acknowledgement means the
 * client's own local admission rather than this host's socket, an OS flush, a parse or a pixel.
 *
 * @param {{ highWaterMark?: number, stall?: boolean }} [options]
 */
export function attachedClient({ highWaterMark = 1 << 20, stall = false } = {}) {
  /** @type {Buffer[]} */
  const accepted = [];
  /** @type {(() => void)[]} */
  const held = [];
  let handed = 0;
  let stalled = stall;
  const terminal = new Writable({
    highWaterMark,
    write(chunk, _encoding, callback) {
      const settle = () => {
        accepted.push(Buffer.from(chunk));
        callback();
      };
      if (stalled) held.push(settle);
      else settle();
    },
  });
  terminal.on("error", () => {});
  return {
    terminal,
    text: () => Buffer.concat(accepted).toString("utf8"),
    latin1: () => Buffer.concat(accepted).toString("latin1"),
    acceptedBytes: () => accepted.reduce((total, chunk) => total + chunk.byteLength, 0),
    handedBytes: () => handed,
    queuedBytes: () => terminal.writableLength,
    stall() {
      stalled = true;
    },
    releaseWrites() {
      stalled = false;
      for (const settle of held.splice(0)) settle();
    },
    /** Every byte handed over has been accepted, in order, by this client's own terminal output. */
    locallyAdmitted: () => handed > 0 && Buffer.concat(accepted).byteLength === handed && !terminal.errored,
    sink: {
      /** @param {Uint8Array} payload */
      write(payload) {
        handed += payload.byteLength;
        return terminal.write(Buffer.from(payload));
      },
      queuedBytes: () => terminal.writableLength,
      /** @param {() => void} listener */
      onDrain(listener) {
        terminal.on("drain", listener);
      },
    },
  };
}

/**
 * The launch recipe for one real Pi owner on a terminal this process owns.
 *
 * `--import` puts the Pi-side relay in front of the CLI's main entry, so the attachment host is registered
 * before the renderer's startup capability query rather than from a publication callback. The one extension
 * registers the fake provider at load time and then blocks `session_start` forever, which is the condition the
 * published target exists for.
 *
 * @param {{ cohort: { bundledCli: string, tuiPackageRoot: string, codingAgentEntry: string }, owned: any, profile: any, cols: number, rows: number }} launch
 */
export function ownerLaunch({ cohort, owned, profile, cols, rows }) {
  return {
    command: process.execPath,
    args: [
      "--import",
      PI_SIDE_PRELOAD,
      cohort.bundledCli,
      "--tui-mode",
      "regular",
      "--no-extensions",
      "-e",
      PI_SIDE_EXTENSION,
      "--provider",
      "host-real-pi-fake",
      "--model",
      "deterministic-echo",
      "-nt",
    ],
    env: {
      PATH: "/usr/bin:/bin",
      HOME: owned.home,
      TERM: profile.term,
      COLUMNS: String(cols),
      LINES: String(rows),
      LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: owned.agent,
      PI_CODING_AGENT_SESSION_DIR: owned.sessions,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_NATIVE_BOOTSTRAP_SOCKET: owned.bootstrapSocket,
      PI_NATIVE_BOOTSTRAP_PROTOCOL: "2",
      HOST_RELAY_SOCKET: owned.relaySocket,
      HOST_RELAY_LOG: owned.relayLog,
      HOST_RELAY_PROTOCOL: String(RELAY_PROTOCOL_VERSION),
      HOST_RELAY_TUI_PACKAGE: cohort.tuiPackageRoot,
      HOST_RELAY_PROFILE: JSON.stringify(profile),
      HOST_BLOCKING_EXTENSION_LOG: owned.extensionLog,
    },
    cwd: owned.project,
    cols,
    rows,
  };
}

/**
 * Resolve when a fixture log really contains `needle`, driven by the filesystem's own change events.
 *
 * `fs.watch` is an inotify subscription, not a poll: the content is re-read when the file changes and once at
 * the start, so a record that already landed is not missed and nothing sleeps.
 *
 * @param {string} logPath @param {string} needle @param {string} label @param {number} [timeoutMs]
 */
export function waitForLogRecord(logPath, needle, label, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    /** @type {import("node:fs").FSWatcher | null} */
    let watcher = null;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolve(undefined);
    };
    const timer = setTimeout(() => finish(new Error(`${label} never appeared in ${logPath} within ${timeoutMs}ms`)), timeoutMs);
    const check = async () => {
      try {
        const text = await readFile(logPath, "utf8");
        if (text.includes(needle)) finish(null);
      } catch {
        // Not written yet. The watcher on its directory reports the create, so there is nothing to retry here.
      }
    };
    try {
      watcher = watch(path.dirname(logPath), () => void check());
    } catch (error) {
      finish(/** @type {Error} */ (error));
      return;
    }
    void check();
  });
}

/** Write one line a case can read back, so a fixture's own observations are inspectable after a failure. */
export async function recordFixtureNote(logPath, note) {
  await writeFile(logPath, `${JSON.stringify(note)}\n`, { flag: "a" });
}

/** A child spawned only to read a terminfo fact. Never a renderer and never a Pi. */
export function probeCommand(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ code: null, stdout, stderr: String(error.message) }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
