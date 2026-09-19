/**
 * Deterministic doubles for the three accepted native consumer capabilities, at their real boundaries.
 *
 * Each double exists because the real half lives somewhere this host process cannot reach, and each one is
 * exactly as real as that boundary allows:
 *
 * - **The input target registry is process-local to Pi.** `nativeInputTargetSnapshot` reads a container inside
 *   the Pi process, so an external host can never call it and see a publication. What crosses to the host is the
 *   snapshot's *shape*, which is what {@link publishedInputTargetRegistry} implements: publication records with
 *   monotonic sequences, the two-identity staleness rule (publication **and** registered host), synchronous
 *   revocation, host release/replacement reasons, seam G's `handoff-closed`, and a registry state this copy
 *   cannot interpret, which throws rather than answering "no target". It is not Pi's renderer, and a real
 *   renderer publication needs a Pi-side adapter that is not this worktree's to write.
 * - **The bootstrap channel is a real socket.** {@link bootstrapChannel} opens a real unix-domain listener, has
 *   a peer connect out and speak the published newline-terminated JSON frames — protocol 1 or protocol 2, hello
 *   first — so the host's activation check, command frame and result binding cross a real transport.
 * - **A client acknowledgement is its own local Writable's acceptance.** {@link terminalOutputClient} puts a
 *   real `node:stream` `Writable` behind the attachment sink and acknowledges only from that stream's own
 *   ordered write callbacks, so "accepted in order by the client's terminal output" is the thing being tested
 *   rather than the host's socket admission, an OS flush, a parse or a pixel.
 */

import { createServer, connect } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

/** The published unavailability reasons, so a case names one the contract really declares. */
export const TARGET_UNAVAILABLE_REASONS = Object.freeze(["producer-absent", "revoked", "host-released", "host-replaced"]);

/**
 * The accepted build's own public API, imported from the cohort a run selected, or `null` when none is.
 *
 * `PI_NATIVE_ARTIFACTS_MANIFEST` names the immutable manifest; there is no default path, because a manifest
 * holds absolute paths into one machine's build output and a leftover copy would point a later run at a stale
 * build. The package root is imported exactly as a consumer imports it — no deep path, no checkout, no private
 * field — which is the only way the framing this host arms is the framing the running Pi writes.
 *
 * @returns {Promise<{ selected: boolean, api: any, manifest: any }>}
 */
export async function acceptedMarkerApi() {
  const selected = process.env.PI_NATIVE_ARTIFACTS_MANIFEST;
  if (selected === undefined || selected.trim().length === 0) return { selected: false, api: null, manifest: null };
  const manifestPath = path.resolve(selected);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.tuiPackageRoot !== "string" || manifest.tuiPackageRoot.length === 0) {
    throw new Error(`${manifestPath} names no usable tuiPackageRoot`);
  }
  const require = createRequire(path.join(manifest.tuiPackageRoot, "package.json"));
  const entry = require.resolve(manifest.tuiPackageRoot);
  const api = await import(new URL(`file://${entry}`).href);
  return { selected: true, api, manifest };
}

/**
 * One process-local publication registry with the published snapshot/subscription surface.
 *
 * `dispatch` answers what the real `ProcessTerminal` answers: `{ admitted: true, consumedThrough }`, or a named
 * refusal that keeps the bytes the sender's. Staleness is re-read synchronously on every call from this
 * registry's own container, so a handle a consumer cached refuses itself rather than relying on notification.
 *
 * @param {{ handoffClosed?: boolean, unsupportedState?: boolean }} [options]
 */
export function publishedInputTargetRegistry({ handoffClosed = false, unsupportedState = false } = {}) {
  const container = {
    apiVersion: 1,
    producerVersion: /** @type {number | null} */ (null),
    publication: /** @type {null | { publicationId: string, sequence: number, producerVersion: number }} */ (null),
    /** The host object the current publication captured. `host-replaced` is this moving, not the publication. */
    publishedHost: /** @type {object | null} */ (null),
    host: /** @type {object | null} */ (null),
    mounted: /** @type {object | null} */ (null),
    revokedReason: /** @type {string | null} */ (null),
    handoffClosed,
    unsupportedState,
  };
  let sequence = 0;
  /** @type {((snapshot: any) => void)[]} */
  const listeners = [];
  /** @type {{ attachmentEpoch: any, bytes: Uint8Array, generation: number }[]} */
  const dispatched = [];
  let consumedThrough = 0;

  /** Why this publication currently has no usable handle, or `null` when it has one. */
  const unavailableReason = () => {
    if (container.producerVersion === null) return "producer-absent";
    if (container.publication === null || container.mounted === null) return container.revokedReason ?? "revoked";
    if (container.host === null) return "host-released";
    if (container.host !== container.publishedHost) return "host-replaced";
    return null;
  };

  const target = () => {
    if (unavailableReason() !== null) return null;
    const publication = container.publication;
    const capturedHost = container.publishedHost;
    return {
      publication,
      /** @param {{ attachmentEpoch: any, bytes: Uint8Array, binding: { generation: number } }} input */
      dispatchNativeInput(input) {
        // Both identities are re-read now, not captured-and-trusted: an older copy can move the host without
        // notifying anybody, so the handle is what keeps a stale dispatch safe.
        if (container.publication !== publication || container.host !== capturedHost) {
          return Promise.resolve({ admitted: false, reason: "target-revoked" });
        }
        if (container.handoffClosed) {
          return Promise.resolve({ admitted: false, consumedThrough, reason: "handoff-closed" });
        }
        dispatched.push({ attachmentEpoch: input.attachmentEpoch, bytes: input.bytes, generation: input.binding.generation });
        consumedThrough += input.bytes.byteLength;
        return Promise.resolve({ admitted: true, consumedThrough });
      },
    };
  };

  const snapshot = () => {
    if (container.unsupportedState) {
      throw new Error("this copy cannot interpret the registry's publication record, so it refuses rather than resetting it");
    }
    const handle = target();
    return {
      apiVersion: container.apiVersion,
      producerVersion: container.producerVersion,
      publication: container.publication,
      target: handle,
      reason: unavailableReason(),
    };
  };

  const notify = () => {
    const current = container.unsupportedState ? null : snapshot();
    for (const listener of [...listeners]) listener(current);
  };

  return {
    dispatched,
    /** The consumer-facing half: exactly `nativeInputTargetSnapshot` and `subscribeNativeInputTarget`. */
    registry: {
      snapshot,
      /** @param {(snapshot: any) => void} listener */
      subscribe(listener) {
        // Registered before the snapshot is read, so a caller cannot lose a transition between the two.
        listeners.push(listener);
        return {
          snapshot: container.unsupportedState ? null : snapshot(),
          unsubscribe() {
            const at = listeners.indexOf(listener);
            if (at >= 0) listeners.splice(at, 1);
          },
        };
      },
    },
    /** A producer of this build publishing at the end of its start, which mints a higher sequence every time. */
    mountProducer() {
      container.mounted = {};
      container.producerVersion = 1;
      sequence += 1;
      if (container.host === null) container.host = {};
      container.publication = { publicationId: `publication-${sequence}`, sequence, producerVersion: 1 };
      container.publishedHost = container.host;
      container.revokedReason = null;
      notify();
      return container.publication;
    },
    /** Synchronous revocation, at the first point of stop. `producerVersion` stays set once observed. */
    revoke() {
      container.mounted = null;
      container.publication = null;
      container.publishedHost = null;
      container.revokedReason = "revoked";
      notify();
    },
    /** Registration rotates the publication for a new host; release revokes that publication only. */
    registerHost() {
      const registered = {};
      container.host = registered;
      if (container.mounted !== null) {
        sequence += 1;
        container.publication = { publicationId: `publication-${sequence}`, sequence, producerVersion: 1 };
        container.publishedHost = registered;
      }
      container.revokedReason = null;
      notify();
      return {
        release() {
          if (container.host === registered) container.host = null;
          notify();
        },
      };
    },
    /** A different host object is now registered while the publication captured the previous one. */
    replaceHost() {
      container.host = {};
      notify();
    },
    closeHandoff(closed = true) {
      container.handoffClosed = closed;
    },
  };
}

/**
 * A real bootstrap socket: a listener the host owns, a peer that connects out and sends the hello first.
 *
 * `answer` decides each command's reply frame, so a case can be slow, negative, unbound or silent. Frames are
 * newline-terminated JSON in both directions, which is the published framing.
 *
 * @param {{ protocol?: 1 | 2, orderedPresentation?: any, answer?: (command: any) => Promise<any> | any }} [options]
 */
export async function bootstrapChannel({ protocol = 2, orderedPresentation, answer } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "native-host-bootstrap-"));
  const socketPath = path.join(directory, "bootstrap.sock");
  /** @type {any[]} */
  const commands = [];
  /** @type {Map<string, (frame: any) => void>} */
  const waiting = new Map();
  /** @type {(() => void)[]} */
  const commandListeners = [];
  /** @type {any} */
  let helloFrame = null;
  let helloResolve = /** @type {(frame: any) => void} */ (() => {});
  const helloArrived = new Promise((resolve) => {
    helloResolve = resolve;
  });
  /** @type {any} */
  let peer = null;

  const server = createServer((connection) => {
    peer = connection;
    let buffered = "";
    const abandonWaiting = () => {
      // A lost control channel is a rejected send, not a silent wait: an outstanding request becomes uncertain
      // and its caller has to treat the attempt as failed.
      for (const [requestId, settle] of [...waiting.entries()]) {
        waiting.delete(requestId);
        settle(Promise.reject(new Error("the bootstrap channel closed before this request was answered")));
      }
    };
    connection.on("error", abandonWaiting);
    connection.on("close", abandonWaiting);
    connection.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (line.trim().length === 0) continue;
        const frame = JSON.parse(line);
        if (frame.type === "native-bootstrap") {
          helloFrame = frame;
          helloResolve(frame);
          continue;
        }
        const settle = waiting.get(frame.requestId);
        if (settle !== undefined) {
          waiting.delete(frame.requestId);
          settle(frame);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, () => resolve(undefined)));

  // Pi's side: connect out, hello first, then one reply per command.
  const pi = connect(socketPath);
  pi.on("error", () => {});
  await new Promise((resolve) => pi.once("connect", () => resolve(undefined)));
  const send = (/** @type {any} */ frame) => pi.write(`${JSON.stringify(frame)}\n`);
  send(
    protocol === 2
      ? {
          type: "native-bootstrap",
          protocol: 2,
          pid: process.pid,
          capability: "native-presentation",
          reached: [],
          orderedPresentation: orderedPresentation ?? { version: 1, markerCodec: "dcs-pi-native-present-v1", tokenBytes: 32, maxMarkerBytes: 128, freshChunkMax: 16384 },
        }
      : { type: "native-bootstrap", protocol: 1, pid: process.pid, capability: "native-presentation", reached: [] },
  );
  let piBuffered = "";
  pi.on("data", async (chunk) => {
    piBuffered += chunk.toString("utf8");
    let newline = piBuffered.indexOf("\n");
    while (newline >= 0) {
      const line = piBuffered.slice(0, newline);
      piBuffered = piBuffered.slice(newline + 1);
      newline = piBuffered.indexOf("\n");
      if (line.trim().length === 0) continue;
      const command = JSON.parse(line);
      commands.push(command);
      for (const listener of commandListeners.splice(0)) listener();
      if (answer === undefined) continue;
      const reply = await answer(command);
      if (reply !== undefined && reply !== null) send(reply);
    }
  });
  await helloArrived;

  return {
    socketPath,
    commands,
    /** The host-facing channel: the hello it received, and one command frame to its reply frame. */
    channel: {
      get hello() {
        return helloFrame;
      },
      /** @param {any} command */
      send(command) {
        return new Promise((resolve, reject) => {
          waiting.set(command.requestId, resolve);
          const written = peer?.write?.(`${JSON.stringify(command)}\n`);
          if (written === undefined) reject(new Error("the bootstrap peer is gone"));
        });
      },    },
    /** Drop the peer, so a case can show a lost control channel rather than describe one. */
    loseTransport() {
      for (const [requestId, settle] of [...waiting.entries()]) {
        waiting.delete(requestId);
        settle(Promise.reject(new Error("the bootstrap channel was lost before this request was answered")));
      }
      peer?.destroy();
      pi.destroy();
    },
    /** Resolves when Pi's side has really received one more command. No sleep, no poll. */
    nextCommand() {
      return new Promise((resolve) => commandListeners.push(() => resolve(undefined)));
    },
    async close() {
      pi.destroy();
      peer?.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * One client whose terminal output really is a `Writable`, acknowledging only what that stream accepted.
 *
 * The sink is what the host writes to; the `Writable` is the client's own local terminal. `acknowledgeable()`
 * is true only once every byte handed to the sink has been accepted in order by that stream, which is the exact
 * boundary a recovery acknowledgement is allowed to mean. Production client transport is a later task: this is
 * the deterministic harness that boundary is exercised through, not that transport.
 *
 * The sink's byte-accounting contract, which the prospective queue bound depends on: `queuedBytes()` is the
 * exact number of bytes this transport has accepted and not yet completed — the `Writable`'s own
 * `writableLength` — so it rises by exactly what a write handed over and falls only as the stream drains. A
 * host may therefore treat `queuedBytes() + chunk.byteLength` as the queue that write would produce. `peakQueued`
 * records the high-water mark that really occurred, so a case proves the bound instead of describing it.
 *
 * @param {{ highWaterMark?: number, failAt?: number, stall?: boolean, throwAt?: number, admitBeforeThrow?: number, onSinkWrite?: (index: number) => void, onQueuedBytes?: (index: number) => void }} [options]
 */
export function terminalOutputClient({ highWaterMark = 64, failAt = -1, stall = false, throwAt = -1, admitBeforeThrow = 0, onSinkWrite, onQueuedBytes } = {}) {
  /** @type {Buffer[]} */
  const accepted = [];
  /** @type {(() => void)[]} */
  const held = [];
  /** Every byte count this host handed to the sink, in order, so a case can assert the sizes it chose. */
  /** @type {number[]} */
  const handedSizes = [];
  let handed = 0;
  let writes = 0;
  let sinkWrites = 0;
  let queueReads = 0;
  let queueHookArmed = false;
  let peakQueued = 0;
  let faultArmed = throwAt < 0;
  let faultCounter = 0;
  let stalled = stall;
  const terminal = new Writable({
    highWaterMark,
    write(chunk, _encoding, callback) {
      writes += 1;
      if (writes === failAt) {
        callback(new Error("the client's terminal output rejected this chunk"));
        return;
      }
      const settle = () => {
        accepted.push(Buffer.from(chunk));
        callback();
      };
      // A stalled client is a real one that has not finished writing: its queue grows, which is exactly how an
      // attachment falls behind the cap. Nothing is dropped; the callbacks are held until released.
      if (stalled) held.push(settle);
      else settle();
    },
  });
  terminal.on("error", () => {});
  return {
    terminal,
    acceptedText: () => Buffer.concat(accepted).toString("latin1"),
    acceptedBytes: () => accepted.reduce((total, chunk) => total + chunk.byteLength, 0),
    handedBytes: () => handed,
    /** Let the client finish what it was handed, in the order it was handed. */
    releaseWrites() {
      stalled = false;
      for (const settle of held.splice(0)) settle();
    },
    /** Stop finishing writes again, so a drained client can be made slow for one recovery attempt. */
    stall() {
      stalled = true;
    },
    /** The largest queue this client's own transport ever really held. */
    peakQueued: () => peakQueued,
    /** Start measuring the high-water mark again, so a case bounds one route rather than the whole session. */
    resetPeak() {
      peakQueued = terminal.writableLength;
    },
    /** What this client's transport reports outstanding right now: the precondition a bound case asserts. */
    queuedBytes: () => terminal.writableLength,
    /** The byte count of every write handed over, in order. */
    handedSizes: () => [...handedSizes],
    /** How many times the host wrote to this client's sink, so a case can prove no retry and no later chunk. */
    sinkWrites: () => sinkWrites,
    /** How many times the host read this client's queue. */
    queueReads: () => queueReads,
    /** Start counting toward `throwAt` now, so the fault lands on a chosen fresh chunk. */
    armFault() {
      faultArmed = true;
      faultCounter = 0;
    },
    /** Let `onQueuedBytes` fire from here on, so a case reenters from a chosen queue read. */
    armQueueHook() {
      queueHookArmed = true;
      queueReads = 0;
    },
    /** Sink writes since the fault was armed: the writes a case is reasoning about, and nothing before them. */
    freshWrites: () => faultCounter,
    /** Every byte handed over has been accepted, in order, by this client's own terminal output. */
    acknowledgeable: () => handed > 0 && Buffer.concat(accepted).byteLength === handed && !terminal.errored,
    sink: {
      /** @param {Uint8Array} payload */
      write(payload) {
        sinkWrites += 1;
        handedSizes.push(payload.byteLength);
        // The client's own transport speaking for itself: a hook that can reenter the host synchronously, and a
        // channel that admits a chosen prefix and then throws — the only shape a write with no accepted-byte
        // count can present.
        if (onSinkWrite !== undefined) onSinkWrite(sinkWrites);
        if (faultArmed) faultCounter += 1;
        // The fault is counted from the moment a case arms it, so an attachment's own initialization write is
        // never the write that throws: a case chooses which fresh chunk fails.
        if (faultArmed && faultCounter === throwAt) {
          const admitted = Math.max(0, Math.min(admitBeforeThrow, payload.byteLength));
          if (admitted > 0) {
            handed += admitted;
            terminal.write(Buffer.from(payload.subarray(0, admitted)));
            peakQueued = Math.max(peakQueued, terminal.writableLength);
          }
          throw new Error(`the client's transport threw after admitting ${admitted} of ${payload.byteLength} bytes`);
        }
        handed += payload.byteLength;
        // A `false` return is this stream's high-water mark. The bytes are admitted once either way.
        const accepting = terminal.write(Buffer.from(payload));
        peakQueued = Math.max(peakQueued, terminal.writableLength);
        return accepting;
      },
      queuedBytes() {
        queueReads += 1;
        if (queueHookArmed && onQueuedBytes !== undefined) onQueuedBytes(queueReads);
        return terminal.writableLength;
      },
      /** @param {() => void} listener */
      onDrain(listener) {
        terminal.on("drain", listener);
      },
    },
  };
}
