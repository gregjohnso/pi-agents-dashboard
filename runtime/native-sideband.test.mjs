import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { TRAILING_MARKER } from "../test/fixtures/native-sideband/trailing-output-marker.mjs";

import { BINDER_EXIT, SIDEBAND_BINDER_PROTOCOL, runBinder } from "./native-sideband-binder.mjs";

import {
  NATIVE_SIDEBAND_PROTOCOL,
  NativeSidebandError,
  OWNER_SIDEBAND_SOCKET_ENV,
  OWNER_SIDEBAND_TOKEN_ENV,
  connectOwnerSideband,
  createOwnerFrameLink,
  listenForOwnerSideband,
  readOwnerSidebandEnvironment,
} from "./native-sideband.mjs";

const TOKEN = "sideband-token-for-this-run-only";
const SOURCE = new URL("./native-sideband.mjs", import.meta.url);

/** @type {(() => unknown)[]} */
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/**
 * Run one registered cleanup now and take it off the shared stack, so a test can assert on what cleanup did.
 *
 * Deliberately not a drain of everything: the shared stack also holds the socket root's removal, and running that
 * early deletes the directory the rest of the case is still using.
 * @param {() => unknown} entry
 */
async function runCleanupNow(/** @type {() => unknown} */ entry) {
  const at = cleanup.indexOf(entry);
  if (at >= 0) cleanup.splice(at, 1);
  await entry();
}

/**
 * A private directory for one socket, under the shortest base that fits.
 *
 * An `AF_UNIX` path is capped at 108 bytes by the kernel, and this suite's `TMPDIR` on a Slurm worker is a
 * deep per-case batch directory, so a socket named under it would exceed the cap before any product code
 * ran. The cap is the reason this is not simply `mkdtemp(tmpdir())`.
 */
async function socketRoot() {
  const base = join(tmpdir(), "x").length + 24 <= 100 || !existsSync("/tmp") ? tmpdir() : "/tmp";
  const root = await mkdtemp(join(base, "pia-sb-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** One socket path whose 0700 parent does not exist yet, so the listener has to create it. */
async function socketPathForThisTest() {
  return join(await socketRoot(), "private", "o");
}

/**
 * The next `count` frames a connection hands out.
 *
 * `onFrame` delivers everything already admitted before it returns, so the unsubscribe handle does not
 * exist yet during that first synchronous burst: the settle runs again after subscribing instead of
 * reaching for a binding that is not initialized.
 * @param {(listener: (frame: any) => void) => (() => void)} subscribe @param {number} count
 */
function nextFrames(subscribe, count) {
  /** @type {any[]} */
  const frames = [];
  return new Promise((resolve) => {
    /** @type {(() => void)|undefined} */
    let stop;
    let settled = false;
    const settle = () => {
      if (settled || frames.length < count) return;
      settled = true;
      stop?.();
      resolve(frames.slice(0, count));
    };
    stop = subscribe((frame) => {
      frames.push(frame);
      settle();
    });
    settle();
  });
}

/** Every frame a subscriber has already been handed, with no promise of more. @param {any} connection */
function recordFrames(connection) {
  /** @type {any[]} */
  const frames = [];
  connection.onFrame((/** @type {any} */ frame) => frames.push(frame));
  return frames;
}

/** @param {{ maxFrameBytes?: number, maxQueuedFrames?: number, handshakeTimeoutMs?: number }} [options] */
async function openPair(options = {}) {
  const socketPath = await socketPathForThisTest();
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN, ...options });
  cleanup.push(() => listener.close());
  const arriving = listener.nextOwner();
  const link = await connectOwnerSideband({ socketPath, token: TOKEN, ...options });
  cleanup.push(() => link.close());
  return { listener, link, owner: await arriving, socketPath };
}

/** A client that writes exactly the bytes a test names, so a refusal can be provoked from the wire. @param {string} socketPath */
async function rawOwner(socketPath) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  cleanup.push(() => socket.destroy());
  /** @type {Buffer[]} */
  const received = [];
  socket.on("data", (chunk) => received.push(chunk));
  socket.on("error", () => {});
  return {
    received,
    closed: new Promise((resolve) => socket.once("close", () => resolve(undefined))),
    /** @param {string} text */
    write(text) {
      return new Promise((resolve, reject) => socket.write(text, (error) => (error ? reject(error) : resolve(undefined))));
    },
  };
}

/** @param {unknown} frame */
function line(frame) {
  return `${JSON.stringify(frame)}\n`;
}

it("exposes one server, one client, one environment reader and its own protocol version", async () => {
  expect(Object.keys(await import("./native-sideband.mjs")).sort()).toEqual([
    "NATIVE_SIDEBAND_PROTOCOL", "NativeSidebandError", "OWNER_SIDEBAND_SOCKET_ENV", "OWNER_SIDEBAND_TOKEN_ENV",
    "connectOwnerSideband", "createOwnerFrameLink", "listenForOwnerSideband", "readOwnerSidebandEnvironment",
  ]);
  expect(NATIVE_SIDEBAND_PROTOCOL).toBe(1);
});

// Operator-visible failure: a socket another local user can reach hands that user a stop request against
// the operator's own session. The private parent is what the socket's own mode cannot establish alone.
it("creates its socket at mode 0600 under a mode 0700 parent it makes itself", async () => {
  const { socketPath, listener } = await openPair();

  expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
  expect((await lstat(dirname(socketPath))).mode & 0o777).toBe(0o700);

  await listener.close();
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

// Operator-visible failure: a token in argv is readable by every process on the box through /proc.
it("takes the socket and the token from the environment, and reads no argument vector at all", async () => {
  expect(readOwnerSidebandEnvironment({ [OWNER_SIDEBAND_SOCKET_ENV]: "/run/o", [OWNER_SIDEBAND_TOKEN_ENV]: "t" }))
    .toEqual({ socketPath: "/run/o", token: "t" });
  expect(readOwnerSidebandEnvironment({ [OWNER_SIDEBAND_SOCKET_ENV]: "/run/o" })).toBeUndefined();
  expect(readOwnerSidebandEnvironment({ [OWNER_SIDEBAND_TOKEN_ENV]: "t" })).toBeUndefined();
  expect(readOwnerSidebandEnvironment({})).toBeUndefined();

  const source = await readFile(SOURCE, "utf8");
  expect(source).not.toMatch(/process\.argv/u);
  // Seam E's core bootstrap channel is a separate, unauthenticated, filesystem-isolated channel. This
  // module neither speaks it nor invents a token field for it.
  expect(source).not.toMatch(/PI_NATIVE_BOOTSTRAP/u);
  expect(OWNER_SIDEBAND_SOCKET_ENV).toBe("PI_AGENTS_OWNER_SIDEBAND_SOCKET");
  expect(OWNER_SIDEBAND_TOKEN_ENV).toBe("PI_AGENTS_OWNER_SIDEBAND_TOKEN");
});

// Operator-visible failure: a management channel that drops the owner's own report makes the host guess
// at seam versions, and a guessed version is indistinguishable from a real one later.
it("carries bridge readiness, a verbatim seam report and scalar facts in the order they were sent", async () => {
  const { link, owner } = await openPair();
  const reported = { A: 1, B: 2, H: "not a version this host knows" };

  await link.announceBridgeReady();
  await link.reportSeams(reported);
  await link.publishFacts({ mode: "tui", idle: true, modelProvider: "fake-provider" });

  expect(await nextFrames(owner.onFrame, 3)).toEqual([
    { type: "owner-ready", phase: "bridge" },
    { type: "owner-seams", reported },
    { type: "owner-facts", facts: { mode: "tui", idle: true, modelProvider: "fake-provider" } },
  ]);
});

// Operator-visible failure: an unauthenticated peer that is answered at all learns the channel exists and
// can keep probing it. Authentication here is the worker socket's shape: digest, then constant-time compare.
it("destroys a connection that does not open with this run's token, without a reply and without handing it out", async () => {
  const socketPath = await socketPathForThisTest();
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => listener.close());
  const arriving = listener.nextOwner();

  const raw = await rawOwner(socketPath);
  const refused = expect(arriving).rejects.toMatchObject({ code: "SIDEBAND_CLOSED" });
  await raw.write(line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-hello", token: `${TOKEN}x` }));
  await raw.write(line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-ready", phase: "bridge" }));
  await raw.closed;

  expect(raw.received).toEqual([]);
  await listener.close();
  await refused;
});

it("tells a client that failed authentication nothing beyond the close", async () => {
  const socketPath = await socketPathForThisTest();
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => listener.close());

  const link = await connectOwnerSideband({ socketPath, token: "not-the-token" });
  cleanup.push(() => link.close());

  await expect(link.closed).resolves.toEqual({ refusal: undefined });
});

it.each([
  ["an unknown protocol version", { protocol: NATIVE_SIDEBAND_PROTOCOL + 1, type: "owner-ready", phase: "bridge" }, "unknown-protocol"],
  ["a readiness phase this extension may not claim", { protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-ready", phase: "native-mounted" }, "malformed-frame"],
  ["a frame type outside the vocabulary", { protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-first-paint" }, "unknown-frame"],
  ["an extra field on a known frame", { protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-ready", phase: "bridge", nonce: "x" }, "malformed-frame"],
  ["a fact that is not a scalar", { protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-facts", facts: { model: { provider: "x" } } }, "malformed-frame"],
  ["a fact whose value is unknown rather than omitted", { protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-facts", facts: { modelProvider: null } }, "malformed-frame"],
  ["a receipt claiming an outcome the vocabulary does not have", { protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-receipt", requestId: "r", request: "stop", outcome: "completed" }, "malformed-frame"],
  ["a frame that is not an object at all", 42, "malformed-frame"],
])("fails closed on %s and dispatches nothing behind it", async (_label, frame, refusal) => {
  const socketPath = await socketPathForThisTest();
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => listener.close());
  const arriving = listener.nextOwner();
  const raw = await rawOwner(socketPath);
  await raw.write(line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-hello", token: TOKEN }));
  const owner = await arriving;
  const frames = recordFrames(owner);

  await raw.write(line(frame));
  await raw.write(line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-ready", phase: "bridge" }));

  await expect(owner.closed).resolves.toEqual({ refusal });
  expect(frames).toEqual([]);
});

// Operator-visible failure: a diagnostic that quotes the frame it refused writes the handshake token into
// a log file, which is the one place a token must never reach.
it("refuses a malformed frame without quoting the bytes or the token anywhere in the report", async () => {
  const socketPath = await socketPathForThisTest();
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => listener.close());
  const arriving = listener.nextOwner();
  const raw = await rawOwner(socketPath);
  await raw.write(line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-hello", token: TOKEN }));
  const owner = await arriving;

  await raw.write(`{"protocol":1,"type":"owner-facts","facts":{"secret":"${TOKEN}"\n`);

  const report = JSON.stringify(await owner.closed);
  expect(report).toEqual(JSON.stringify({ refusal: "malformed-frame" }));
  expect(report).not.toContain(TOKEN);
});

// Operator-visible failure: a peer that can make the host buffer an unbounded frame before it is parsed
// can exhaust the host's memory with bytes the host already knows it will refuse.
it("refuses an over-budget frame on its raw byte count, before any parse", async () => {
  const socketPath = await socketPathForThisTest();
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN, maxFrameBytes: 512 });
  cleanup.push(() => listener.close());
  const arriving = listener.nextOwner();
  const raw = await rawOwner(socketPath);
  await raw.write(line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-hello", token: TOKEN }));
  const owner = await arriving;
  const frames = recordFrames(owner);

  // Valid JSON of a known type, refused for its size alone, and never delivered.
  await raw.write(line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-facts", facts: { mode: "t".repeat(600) } }));

  await expect(owner.closed).resolves.toEqual({ refusal: "frame-too-large" });
  expect(frames).toEqual([]);
});

// Operator-visible failure: a host that has not subscribed yet would otherwise queue an owner's facts
// without limit, and a queue that is silently dropped instead loses a lifecycle fact nobody knows is gone.
it("bounds queue admission and fails closed rather than growing or dropping quietly", async () => {
  const { link, owner } = await openPair({ maxQueuedFrames: 2 });

  await link.announceBridgeReady();
  await link.publishFacts({ mode: "tui" });
  await link.publishFacts({ idle: true });

  await expect(owner.closed).resolves.toEqual({ refusal: "queue-overflow" });
  expect(recordFrames(owner)).toEqual([]);
});

// Operator-visible failure: a connection that never authenticates would otherwise hold a descriptor and a
// pending handoff for the worker's whole life.
it("closes a connection that never authenticates by its handshake deadline", async () => {
  const socketPath = await socketPathForThisTest();
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN, handshakeTimeoutMs: 40 });
  cleanup.push(() => listener.close());
  const arriving = listener.nextOwner();
  const refused = expect(arriving).rejects.toMatchObject({ code: "SIDEBAND_CLOSED" });

  const raw = await rawOwner(socketPath);
  await raw.closed;

  await listener.close();
  await refused;
});

// Operator-visible failure: a stop the host asked for, answered by a receipt that claims the session ended,
// would let the host retire a row whose Pi is still running. Only a reaped exit completes a stop.
it("carries stop and abort requests out and honest receipts back", async () => {
  const { link, owner } = await openPair();
  const requests = nextFrames(link.onRequest, 2);

  await owner.requestStop("request-1");
  await owner.requestAbort("request-2");

  expect(await requests).toEqual([
    { type: "owner-request", requestId: "request-1", request: "stop" },
    { type: "owner-request", requestId: "request-2", request: "abort" },
  ]);

  const receipts = nextFrames(owner.onFrame, 1);
  await link.sendReceipt({ requestId: "request-1", request: "stop", outcome: "deferred", idle: false, pendingMessages: true });
  expect(await receipts).toEqual([{
    type: "owner-receipt", requestId: "request-1", request: "stop", outcome: "deferred", idle: false, pendingMessages: true,
  }]);
});

it("refuses to send a frame it cannot validate first", async () => {
  const { link, owner } = await openPair();

  await expect(owner.requestStop("")).rejects.toBeInstanceOf(NativeSidebandError);
  await expect(owner.requestStop(" leading-space")).rejects.toMatchObject({ code: "SIDEBAND_FRAME_REFUSED" });
  await expect(link.publishFacts({ modelProvider: null })).rejects.toMatchObject({ code: "SIDEBAND_FRAME_REFUSED" });
  await expect(link.publishFacts({ model: { provider: "x" } })).rejects.toMatchObject({ code: "SIDEBAND_FRAME_REFUSED" });
  await expect(link.reportSeams("A=1")).rejects.toMatchObject({ code: "SIDEBAND_FRAME_REFUSED" });
  await expect(link.sendReceipt(/** @type {any} */ ({ requestId: "r", request: "stop", outcome: "completed" })))
    .rejects.toMatchObject({ code: "SIDEBAND_FRAME_REFUSED" });
  // A refusal is a local throw, not a close: the channel is still usable afterwards.
  await link.announceBridgeReady();
  expect(await nextFrames(owner.onFrame, 1)).toEqual([{ type: "owner-ready", phase: "bridge" }]);
});

// Operator-visible failure: a close waiter registered after the first await misses a connection that was
// refused on its first frame, and the extension then waits forever for a channel that is already gone.
it("resolves both ends' close waiters for a connection that ends before anything subscribed", async () => {
  const { link, owner, listener } = await openPair();

  await listener.close();

  await expect(owner.closed).resolves.toEqual({ refusal: undefined });
  await expect(link.closed).resolves.toEqual({ refusal: undefined });
  await expect(link.publishFacts({ mode: "tui" })).rejects.toMatchObject({ code: "SIDEBAND_CLOSED" });
});

it("reports an absent socket as a bounded failure that names no credential", async () => {
  const socketPath = join(await socketRoot(), "never-created");
  const failure = await connectOwnerSideband({ socketPath, token: TOKEN, handshakeTimeoutMs: 40 })
    .then(() => undefined, (error) => error);

  expect(failure).toBeInstanceOf(NativeSidebandError);
  expect(failure.code).toBe("SIDEBAND_UNREACHABLE");
  expect(`${failure.message}`).not.toContain(TOKEN);
});

it.each([
  ["a relative socket path", { socketPath: "relative/o", token: TOKEN }, "SIDEBAND_PATH_UNUSABLE"],
  ["an empty socket path", { socketPath: "", token: TOKEN }, "SIDEBAND_PATH_UNUSABLE"],
  ["an empty token", { socketPath: "/run/o", token: "" }, "SIDEBAND_TOKEN_UNUSABLE"],
  ["an unusable frame budget", { socketPath: "/run/o", token: TOKEN, maxFrameBytes: 0 }, "SIDEBAND_BOUND_UNUSABLE"],
  ["an unusable queue budget", { socketPath: "/run/o", token: TOKEN, maxQueuedFrames: -1 }, "SIDEBAND_BOUND_UNUSABLE"],
])("refuses %s on both ends before touching the filesystem", async (_label, options, code) => {
  await expect(listenForOwnerSideband(options)).rejects.toMatchObject({ code });
  await expect(connectOwnerSideband(options)).rejects.toMatchObject({ code });
});

/** The hello this run's token authenticates with, as one wire line. */
function helloLine() {
  return line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-hello", token: TOKEN });
}

/**
 * One connected socket pair, and a link driven directly over the server end.
 *
 * `createOwnerFrameLink` is the boundary the two cases below need, because whether a frame was buffered
 * *before* a subscriber existed cannot be observed through either transport: the only way to read the buffer
 * is to drain it, and draining is the property under test. Delivering through the socket's own `data` event
 * is exactly how a real arrival reaches the link, and doing it in one synchronous call makes the ordering the
 * test's rather than the kernel's. No sleep, no chunk luck, no second process.
 */
async function ownerFrameLinkOverRealSocket(limits = {}) {
  const root = await socketRoot();
  const socketPath = join(root, "pair");
  /** @type {(socket: net.Socket) => void} */
  let arrive = () => {};
  const accepted = new Promise((resolve) => {
    arrive = resolve;
  });
  const server = net.createServer({ allowHalfOpen: false }, (socket) => arrive(socket));
  await new Promise((resolve) => server.listen(socketPath, () => resolve(undefined)));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  const client = net.createConnection(socketPath);
  client.on("error", () => {});
  cleanup.push(() => client.destroy());
  const hostSide = /** @type {net.Socket} */ (await accepted);
  hostSide.on("error", () => {});
  const link = createOwnerFrameLink(hostSide, limits);
  return {
    link,
    /** Admit these frames now, in this call, through the socket's own arrival path. @param {any[]} frames */
    deliver(frames) {
      hostSide.emit("data", Buffer.from(frames.map((frame) => line({ protocol: NATIVE_SIDEBAND_PROTOCOL, ...frame })).join("")));
    },
  };
}

/** One `owner-facts` frame, numbered. @param {number} index */
function fact(index) {
  return { type: "owner-facts", facts: { index } };
}

// The setup every queued-drain claim rests on, asserted rather than assumed: with nothing subscribed, three
// frames delivered in one arrival are all buffered, and the first subscriber is handed all three in order.
// If any of them had been dropped or dispatched directly instead, this case would say so.
it("hands a first subscriber every frame admitted before it, in arrival order", async () => {
  const { link, deliver } = await ownerFrameLinkOverRealSocket({ maxQueuedFrames: 3 });

  deliver([fact(1), fact(2), fact(3)]);

  /** @type {any[]} */
  const seen = [];
  link.onFrame((/** @type {any} */ frame) => seen.push(frame));
  expect(seen).toEqual([fact(1), fact(2), fact(3)]);
});

// Operator-visible failure: a subscriber that throws part way through a drain of frames already admitted
// would otherwise keep being handed the frames behind it, after the connection has been recorded as failed. A
// listener that saw one more fact than the host's own refusal admits has been told something the host does not
// believe.
//
// Deterministic by construction: the three frames are admitted in one synchronous arrival with nothing
// subscribed, which the case above proves buffers all three, and only then is the throwing subscriber added.
// There is no stream segmentation to get lucky with, because the drain is the only delivery path available.
it("stops draining the moment a failure is recorded, discarding the frames still buffered", async () => {
  const { link, deliver } = await ownerFrameLinkOverRealSocket({ maxQueuedFrames: 3 });

  deliver([fact(1), fact(2), fact(3)]);

  /** @type {any[]} */
  const seen = [];
  link.onFrame((/** @type {any} */ frame) => {
    seen.push(frame);
    if (seen.length === 2) throw new Error("this subscriber cannot handle a second frame");
  });

  // The third frame was buffered behind the one that threw, and the seal discarded it.
  expect(seen).toEqual([fact(1), fact(2)]);
  await expect(link.closed).resolves.toEqual({ refusal: "listener-failed" });
  /** @type {any[]} */
  const afterwards = [];
  link.onFrame((/** @type {any} */ frame) => afterwards.push(frame));
  expect(afterwards).toEqual([]);
});

// The other delivery path, kept separate because it proves something different. With a subscriber already
// installed, each frame is dispatched as it arrives and nothing is ever buffered; a throw still seals the
// link, and a frame that arrives afterwards is refused admission rather than delivered. This is the case the
// previous mid-drain test was silently able to become when the stream was segmented after the hello.
it("dispatches directly when a subscriber is already installed, and seals on a throw", async () => {
  const { link, deliver } = await ownerFrameLinkOverRealSocket({ maxQueuedFrames: 3 });

  /** @type {any[]} */
  const seen = [];
  link.onFrame((/** @type {any} */ frame) => {
    seen.push(frame);
    if (seen.length === 2) throw new Error("this subscriber cannot handle a second frame");
  });

  deliver([fact(1)]);
  deliver([fact(2)]);
  deliver([fact(3)]);

  expect(seen).toEqual([fact(1), fact(2)]);
  await expect(link.closed).resolves.toEqual({ refusal: "listener-failed" });
});

// Operator-visible failure: a subscriber that throws on one of several frames already admitted would
// otherwise keep being handed the frames behind it, after the connection has been recorded as failed. The
// contract is that a recorded failure discards what was buffered; a listener that saw one more fact than the
// host's own refusal admits has been told something the host does not believe.
//
// This runs over the real authenticated transport, so what it constrains is that path end to end. It makes no
// claim about whether the three facts were buffered or dispatched directly: a stream segmented after the hello
// would take the direct path, and the two cases above are what separate them deterministically.
it("stops delivering the moment a failure is recorded, over the authenticated transport", async () => {
  const socketPath = await socketPathForThisTest();
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN, maxQueuedFrames: 3 });
  cleanup.push(() => listener.close());
  const arriving = listener.nextOwner();
  const raw = await rawOwner(socketPath);

  await raw.write(
    helloLine()
      + line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-facts", facts: { index: 1 } })
      + line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-facts", facts: { index: 2 } })
      + line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-facts", facts: { index: 3 } }),
  );
  const owner = await arriving;

  /** @type {any[]} */
  const seen = [];
  owner.onFrame((/** @type {any} */ frame) => {
    seen.push(frame);
    if (seen.length === 2) throw new Error("this subscriber cannot handle a second frame");
  });

  // The third frame was buffered behind the one that threw and is not delivered.
  expect(seen).toEqual([
    { type: "owner-facts", facts: { index: 1 } },
    { type: "owner-facts", facts: { index: 2 } },
  ]);
  await expect(owner.closed).resolves.toEqual({ refusal: "listener-failed" });
  // Nothing may be admitted or subscribed afterwards either.
  expect(recordFrames(owner)).toEqual([]);
});

// That unsubscribed frames are *buffered* rather than dropped, proven by the only non-destructive observation
// of the buffer there is: its cap. Reading the buffer any other way drains it, and a chunk boundary proves
// nothing, so this counts frames instead. With room for two and nothing subscribed, the third frame overflows,
// which can only happen if the first two were held.
it("buffers every admitted frame while nothing is subscribed, and refuses the one past its cap", async () => {
  const socketPath = await socketPathForThisTest();
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN, maxQueuedFrames: 2 });
  cleanup.push(() => listener.close());
  const arriving = listener.nextOwner();
  const raw = await rawOwner(socketPath);

  await raw.write(helloLine());
  const owner = await arriving;
  for (const index of [1, 2, 3]) {
    await raw.write(line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-facts", facts: { index } }));
  }

  await expect(owner.closed).resolves.toEqual({ refusal: "queue-overflow" });
});

// And that a recorded failure *discards* that buffer. The seal is triggered by a malformed frame rather than a
// throwing subscriber, so the buffer is never drained on the way to the failure: a subscriber that arrives
// afterwards is the observation, and it must be handed nothing. Every write is separate and awaited, so no
// step depends on how the stream was segmented.
it("discards what it buffered when a failure is recorded without any subscriber", async () => {
  const socketPath = await socketPathForThisTest();
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN, maxQueuedFrames: 8 });
  cleanup.push(() => listener.close());
  const arriving = listener.nextOwner();
  const raw = await rawOwner(socketPath);

  await raw.write(helloLine());
  const owner = await arriving;
  await raw.write(line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-facts", facts: { mode: "tui" } }));
  await raw.write(line({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-facts", facts: { idle: true } }));
  await raw.write("{ this is not a frame\n");

  await expect(owner.closed).resolves.toEqual({ refusal: "malformed-frame" });
  expect(recordFrames(owner)).toEqual([]);
});

// Operator-visible failure: a listener whose post-bind permission work fails hands its caller an error and no
// close handle, leaving a bound socket and its accepted connections owned by nobody. The worker cannot close
// what it was never given, so the endpoint keeps answering and keeps the process alive.
it("releases the endpoint it bound and every connection it accepted when initialization fails, then rethrows", async () => {
  const socketPath = await socketPathForThisTest();
  const injected = new Error("post-bind initialization failed");
  /** @type {any} */
  let client;

  const failure = await listenForOwnerSideband({
    socketPath,
    token: TOKEN,
    failpoint: async (/** @type {string} */ stage) => {
      if (stage !== "after_handoff") return;
      // The endpoint is live and accepting here, which is exactly the window the defect leaked.
      client = await rawOwner(socketPath);
      await client.write(helloLine());
      throw injected;
    },
  }).then(() => undefined, (/** @type {unknown} */ error) => error);

  // The caller's error is the original one, not whatever the cleanup encountered.
  expect(failure).toBe(injected);
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  await client.closed;
  // The listening handle is gone, not merely unreferenced: the same path binds again.
  const replacement = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => replacement.close());
  expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
});

// The same window, failed by the real endpoint verification rather than an injected error. Nothing narrows a
// pathname any more - the socket is created 0600 in the binder - so what refuses here is the parent checking
// that what it was handed really is its own socket. A regular file at that path is not, and the refusal names
// it rather than chmod-ing or unlinking whatever is there.
it("refuses when the endpoint it was handed is no longer its own socket, and leaves that entry alone", async () => {
  const socketPath = await socketPathForThisTest();

  const failure = await listenForOwnerSideband({
    socketPath,
    token: TOKEN,
    failpoint: async (/** @type {string} */ stage) => {
      if (stage !== "before_verification") return;
      await rm(socketPath);
      await writeFile(socketPath, "not a socket\n", { mode: 0o600 });
    },
  }).then(() => undefined, (/** @type {unknown} */ error) => error);

  expect(failure).toMatchObject({ code: "SIDEBAND_ENDPOINT_UNUSABLE" });
  expect(`${/** @type {Error} */ (failure).message}`).toMatch(/is not the one this attempt bound/u);
  // The foreign entry is exactly as it was left: this refusal removes nothing it cannot identify, and says so.
  expect(await readFile(socketPath, "utf8")).toBe("not a socket\n");
  expect(`${/** @type {any} */ (failure).sidebandCleanup}`).toMatch(/left exactly as it was found/u);
});

/**
 * A real live listener at a path, made by another actor, ready to be replaced onto this attempt's endpoint.
 *
 * A regular file is not enough for these cases: the whole point is that a *working* channel somebody else owns
 * survives, keeps its identity and still answers. So the replacement is an actual listening socket with its own
 * accept handler, and the assertions check its inode, its mode and that it still accepts a connection.
 */
async function liveReplacement(/** @type {string} */ root) {
  const socketPath = join(root, "live");
  /** @type {net.Socket[]} */
  const accepted = [];
  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    accepted.push(socket);
    socket.end("alive\n");
  });
  server.on("error", () => {});
  await new Promise((resolve) => server.listen(socketPath, () => resolve(undefined)));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  // Narrowed to 0600 so this stands in for the case that matters: a replacement indistinguishable from a
  // correct endpoint by owner and mode. A test-side chmod of the test's own socket, not of a foreign entry.
  await chmod(socketPath, 0o600);
  const identity = await lstat(socketPath);
  return {
    socketPath,
    identity,
    /** Move this live socket onto another path, keeping the same inode: a rename, not a copy. */
    async replaceOnto(/** @type {string} */ target) {
      await rm(target, { force: true });
      await rename(socketPath, target);
      return await lstat(target);
    },
    /** Prove it still answers after everything the attempt under test did. @param {string} at */
    async stillAnswers(at) {
      const reply = await new Promise((resolve, reject) => {
        const client = net.createConnection(at);
        let text = "";
        client.on("data", (chunk) => {
          text += String(chunk);
        });
        client.once("end", () => resolve(text));
        client.once("error", reject);
      });
      return reply;
    },
  };
}

// The condition this whole helper exists for, and the one the direct bind could not meet. Another actor's live
// listening socket is moved onto this attempt's endpoint path while the attempt is still holding it. When the
// attempt tears itself down it must leave that socket completely alone: same inode, same mode, still accepting.
it("preserves a live listener another actor moved onto its endpoint, through its whole teardown", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  const other = await liveReplacement(root);

  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  const replaced = await other.replaceOnto(socketPath);

  const outcome = await listener.close();

  // Nothing of the replacement changed, and it is still a working channel.
  const after = await lstat(socketPath);
  expect(after.isSocket()).toBe(true);
  expect(String(after.ino)).toBe(String(replaced.ino));
  expect(after.mode & 0o777).toBe(replaced.mode & 0o777);
  expect(await other.stillAnswers(socketPath)).toBe("alive\n");
  // And the teardown says plainly that it removed nothing, rather than reporting a clean close it did not do.
  expect(outcome).toMatchObject({ removed: false });
  expect(`${outcome.retained}`).toMatch(/different socket occupies this endpoint's path and was left alone/u);
});

// The same preservation, when the replacement lands in the window between the close completing and the
// ownership decision being made. Holding a connected client cannot script that window - this listener's own
// teardown destroys the sockets it accepted before it closes the handle - so the replacement is injected
// through the `during_close` seam, which fires exactly there. No sleep and no race.
it("preserves a live listener that replaces its endpoint while the close is already running", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  const other = await liveReplacement(root);
  /** @type {any} */
  let replaced;

  const listener = await listenForOwnerSideband({
    socketPath,
    token: TOKEN,
    failpoint: async (/** @type {string} */ stage) => {
      if (stage !== "during_close") return;
      replaced = await other.replaceOnto(socketPath);
    },
  });

  const outcome = await listener.close();

  const after = await lstat(socketPath);
  expect(String(after.ino)).toBe(String(replaced.ino));
  expect(after.mode & 0o777).toBe(replaced.mode & 0o777);
  expect(await other.stillAnswers(socketPath)).toBe("alive\n");
  expect(outcome).toMatchObject({ removed: false });
  expect(`${outcome.retained}`).toMatch(/different socket occupies this endpoint's path and was left alone/u);
});

// A non-socket entry is not this attempt's either. A regular file another actor left at the path keeps its
// contents: permission work never chmods a pathname, and cleanup never unlinks one it cannot identify.
it("preserves a foreign regular file at its endpoint path and leaves its mode alone", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  await rm(socketPath);
  await writeFile(socketPath, "not this attempt's\n", { mode: 0o644 });
  // Whatever the umask made of that request is the baseline: the point is that cleanup changes nothing.
  const created = await lstat(socketPath);

  const outcome = await listener.close();

  expect(await readFile(socketPath, "utf8")).toBe("not this attempt's\n");
  expect((await lstat(socketPath)).mode & 0o777).toBe(created.mode & 0o777);
  expect(String((await lstat(socketPath)).ino)).toBe(String(created.ino));
  expect(outcome).toMatchObject({ removed: false });
  expect(`${outcome.retained}`).toMatch(/non-socket entry occupies this endpoint's path and was left alone/u);
});

// Its own endpoint, on the other hand, is exactly what a normal close removes - and the close says so.
it("removes its own endpoint on a normal close, and reports that it did", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  expect((await lstat(socketPath)).isSocket()).toBe(true);

  const outcome = await listener.close();

  expect(outcome).toEqual({ removed: true, retained: null });
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

// The socket exists at 0600 from the moment it exists, created that way rather than narrowed afterwards. The
// manager's own umask is never touched, which is what this also checks: it is read before and after.
it("creates its endpoint at 0600 without changing this process's umask", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  const before = process.umask();

  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => listener.close());

  const entry = await lstat(socketPath);
  expect(entry.isSocket()).toBe(true);
  expect(entry.mode & 0o777).toBe(0o600);
  expect(process.umask()).toBe(before);
  // The snapshot the cleanup will compare against was taken from that same entry.
  expect(listener.endpoint.ownership).toMatchObject({ mode: 0o600, inode: String(entry.ino), device: String(entry.dev) });
});

// The helper is gone before the listener is usable, and its exit is observed rather than inferred from the
// send completing. A lingering binder beside a running owner is exactly what this forbids.
it("observes the binder's own exit before it returns a usable listener", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => listener.close());

  // A real exit status, read from the child this call forked, not a guess about a PID.
  expect(listener.endpoint.helperExit).toEqual({ code: 0, signal: null });
  // And the listener it left behind actually works.
  const arriving = listener.nextOwner();
  const raw = await rawOwner(socketPath);
  await raw.write(helloLine());
  await expect(arriving).resolves.toMatchObject({ onFrame: expect.any(Function) });
});

// A bind that cannot succeed is reported as the bind failure it is, and the live listener already holding that
// path keeps working. The refusal comes from the helper over IPC, not from a guess in the parent.
it("refuses when the endpoint is already bound, and leaves the existing listener working", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  const live = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => live.close());

  await expect(listenForOwnerSideband({ socketPath, token: TOKEN })).rejects.toMatchObject({ code: "EADDRINUSE" });

  expect((await lstat(socketPath)).isSocket()).toBe(true);
  const arriving = live.nextOwner();
  const raw = await rawOwner(socketPath);
  await raw.write(helloLine());
  await expect(arriving).resolves.toMatchObject({ onFrame: expect.any(Function) });
});

// A failure after the handoff is verified: the caller is told its own error, the inherited handle is released,
// and because this attempt did bind that socket, its own entry goes.
it("releases an inherited listener and its own endpoint when a post-handoff failure is injected", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  const injected = new Error("post-handoff initialization failed");

  await expect(listenForOwnerSideband({
    socketPath,
    token: TOKEN,
    failpoint: async (/** @type {string} */ stage) => {
      if (stage === "after_handoff") throw injected;
    },
  })).rejects.toBe(injected);

  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  // The path binds again, so nothing is left listening on it.
  const replacement = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => replacement.close());
  expect((await lstat(socketPath)).isSocket()).toBe(true);
});

// A post-handoff failure whose cleanup meets a foreign entry: the original error is still what the caller sees,
// and what the cleanup found is reported separately rather than folded into it or swallowed.
it("keeps the original failure and reports a foreign entry the cleanup met separately", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  const other = await liveReplacement(root);
  const injected = new Error("post-handoff initialization failed");

  const failure = await listenForOwnerSideband({
    socketPath,
    token: TOKEN,
    failpoint: async (/** @type {string} */ stage) => {
      if (stage !== "after_handoff") return;
      await other.replaceOnto(socketPath);
      throw injected;
    },
  }).then(() => undefined, (/** @type {unknown} */ error) => error);

  expect(failure).toBe(injected);
  expect(`${/** @type {any} */ (failure).sidebandCleanup}`).toMatch(/left alone/u);
  expect(await other.stillAnswers(socketPath)).toBe("alive\n");
});

// Every client this attempt accepted is destroyed by its own teardown, so a connected owner cannot hold the
// shutdown open and no socket outlives the listener that served it.
it("destroys the clients it accepted when it closes", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  const arriving = listener.nextOwner();
  const raw = await rawOwner(socketPath);
  await raw.write(helloLine());
  const owner = await arriving;

  await listener.close();

  await expect(owner.closed).resolves.toMatchObject({ refusal: undefined });
});

/**
 * The binder's failure matrix, over real forked processes and a real IPC channel.
 *
 * What is faked is only the *helper's behaviour*: branches a correct helper never takes - a wrong protocol
 * version, two handoffs, a handle that is not a server, a process that goes quiet - come from deterministic
 * fixtures under `test/fixtures/native-sideband/`. The parent's observers, its handle disposal and its exit
 * accounting are the code under test and are never stubbed. Nothing here stages ordering with a sleep.
 */
const FIXTURES = new URL("../test/fixtures/native-sideband/", import.meta.url);

/** @param {string} name */
function fixture(name) {
  return new URL(name, FIXTURES);
}

/**
 * Is anything still listening at this path?
 *
 * The question a leaked handle answers "yes" to. `lstat` cannot tell: the socket file outlives its listener,
 * because the helper exits without unlinking. Only a connection attempt distinguishes a disposed listener
 * (refused) from one this parent is still holding open (accepted).
 * @param {string} socketPath
 */
function accepts(socketPath) {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    client.once("connect", () => {
      client.destroy();
      resolve(true);
    });
    client.once("error", () => resolve(false));
  });
}

/** @param {string} socketPath @param {string} name @param {Record<string, unknown>} [extra] */
async function attemptWithFixture(socketPath, name, extra = {}) {
  return await listenForOwnerSideband({ socketPath, token: TOKEN, binderEntry: fixture(name), binderTimeoutMs: 4_000, ...extra })
    .then((listener) => {
      cleanup.push(() => listener.close());
      return { listener, error: undefined };
    }, (/** @type {unknown} */ error) => ({ listener: undefined, error }));
}

// Every rejection has to account for three things at once: the code the caller is told, whether a transferred
// listener was disposed rather than leaked, and that no directory entry was removed on the way out. These are
// the branches a correct helper never takes, which is exactly why they need a fixture to reach.
it.each([
  ["wrong-version.mjs", "SIDEBAND_BINDER_PROTOCOL", false],
  ["wrong-version-with-handle.mjs", "SIDEBAND_BINDER_PROTOCOL", true],
  ["unknown-type-with-handle.mjs", "SIDEBAND_BINDER_PROTOCOL", true],
  ["refusal-with-handle.mjs", "SIDEBAND_BINDER_REFUSED", true],
  ["bound-without-proof.mjs", "SIDEBAND_BINDER_PROTOCOL", true],
  ["bound-without-handle.mjs", "SIDEBAND_BINDER_PROTOCOL", true],
  ["bound-with-wrong-handle.mjs", "SIDEBAND_BINDER_PROTOCOL", true],
])("refuses %s with %s, disposing any transferred listener and removing nothing", async (name, code, binds) => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const { listener, error } = await attemptWithFixture(socketPath, name);

  expect(listener, name).toBe(undefined);
  expect(error, name).toMatchObject({ code });
  // Nothing was removed: this attempt never completed an ownership proof, so the entry is left as found.
  expect(`${/** @type {any} */ (error).sidebandCleanup}`, name).toMatch(/no directory entry was removed/u);
  if (binds) {
    // The fixture did bind, so the file is there - and nothing may still be listening on it. A handle this
    // parent refused but kept open would answer here.
    expect(existsSync(socketPath), name).toBe(true);
    expect(await accepts(socketPath), name).toBe(false);
  }
});

// One handoff per helper, established by observing the second rather than by inferring it from an exit code.
// The parent keeps its IPC channel open until the helper's own exit and the channel's drain, so a second
// message is delivered and refused as a protocol violation. Both fixtures below exit 0 on every ordinary path,
// so the refusal cannot come from an unrelated non-zero exit, and both listeners the parent was handed have to
// be disposed rather than left accepting.
it("refuses a second handoff as a protocol violation and disposes both listeners, from a helper that exits 0", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const { listener, error } = await attemptWithFixture(socketPath, "duplicate-handoff.mjs");

  expect(listener).toBe(undefined);
  expect(error).toMatchObject({ code: "SIDEBAND_BINDER_PROTOCOL" });
  expect(`${/** @type {Error} */ (error).message}`).toMatch(/another message after its handoff/u);
  // Neither the provisionally adopted listener nor the duplicate is still accepting: both were disposed.
  expect(await accepts(socketPath)).toBe(false);
  expect(await accepts(`${socketPath}-second`)).toBe(false);
  // Both entries are still on disk. Refusing does not make either of them this attempt's to remove.
  expect(existsSync(socketPath)).toBe(true);
  expect(existsSync(`${socketPath}-second`)).toBe(true);
  expect(`${/** @type {any} */ (error).sidebandCleanup}`).toMatch(/no directory entry was removed/u);
});

it("refuses malformed late traffic after a valid handoff, and disposes the listener it had adopted", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const { listener, error } = await attemptWithFixture(socketPath, "handoff-then-malformed.mjs");

  expect(listener).toBe(undefined);
  expect(error).toMatchObject({ code: "SIDEBAND_BINDER_PROTOCOL" });
  expect(`${/** @type {Error} */ (error).message}`).toMatch(/another message after its handoff/u);
  expect(await accepts(socketPath)).toBe(false);
  expect(existsSync(socketPath)).toBe(true);
});

it("reports a spawn failure without waiting for an exit that cannot happen", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const { error } = await attemptWithFixture(socketPath, "wrong-version.mjs", { execPath: join(root, "no-such-node") });

  expect(error).toMatchObject({ code: "SIDEBAND_BINDER_UNUSABLE" });
  expect(existsSync(socketPath)).toBe(false);
});

it("reports a helper that dies before sending anything", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const { error } = await attemptWithFixture(socketPath, "early-death.mjs");

  expect(error).toMatchObject({ code: "SIDEBAND_BINDER_INCOMPLETE" });
  expect(`${/** @type {Error} */ (error).message}`).toMatch(/code 7/u);
});

it("reports a helper that closes its channel before handing anything over", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const { error } = await attemptWithFixture(socketPath, "disconnect-then-exit.mjs");

  expect(error).toMatchObject({ code: "SIDEBAND_BINDER_INCOMPLETE" });
});

// The deadline covers the whole process, not the first message. Both sides of that are tested: a helper that
// never sends, and a helper that hands over a listener and then refuses to leave.
it("times out a helper that never sends, and ends it", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const { error } = await attemptWithFixture(socketPath, "silent-then-hang.mjs");

  expect(error).toMatchObject({ code: "SIDEBAND_BINDER_TIMEOUT" });
});

it("times out a helper that hands over a listener and then will not exit, and disposes that listener", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const { error } = await attemptWithFixture(socketPath, "handoff-then-hang.mjs");

  expect(error).toMatchObject({ code: "SIDEBAND_BINDER_TIMEOUT" });
  expect(existsSync(socketPath)).toBe(true);
  expect(await accepts(socketPath)).toBe(false);
  expect(`${/** @type {any} */ (error).sidebandCleanup}`).toMatch(/no directory entry was removed/u);
});

it("refuses a helper that hands over a listener and then dies abruptly", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");

  const { error } = await attemptWithFixture(socketPath, "handoff-then-abort.mjs");

  expect(error).toMatchObject({ code: "SIDEBAND_BINDER_INCOMPLETE" });
  expect(await accepts(socketPath)).toBe(false);
});

// The window the parent found: ownership was captured after the helper exited, so a different socket of the
// same user and the same mode became the alleged owned inode and was unlinked on close. The proof now travels
// with the handle, so this replacement is rejected and survives untouched and usable.
it("rejects a same-user 0600 replacement listener at verification and leaves it usable", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  const other = await liveReplacement(root);
  /** @type {any} */
  let replaced;

  const failure = await listenForOwnerSideband({
    socketPath,
    token: TOKEN,
    failpoint: async (/** @type {string} */ stage) => {
      if (stage !== "before_verification") return;
      replaced = await other.replaceOnto(socketPath);
      // The same user, the same mode, a real listening socket: everything a check without a proof would accept.
      expect(replaced.isSocket()).toBe(true);
      expect(replaced.mode & 0o777).toBe(0o600);
      expect(replaced.uid).toBe(process.getuid?.());
    },
  }).then(() => undefined, (/** @type {unknown} */ error) => error);

  expect(failure).toMatchObject({ code: "SIDEBAND_ENDPOINT_UNUSABLE" });
  expect(`${/** @type {Error} */ (failure).message}`).toMatch(/is not the one this attempt bound/u);
  // Unchanged and still working: rejection removed nothing.
  const after = await lstat(socketPath);
  expect(String(after.ino)).toBe(String(replaced.ino));
  expect(after.mode & 0o777).toBe(replaced.mode & 0o777);
  expect(await other.stillAnswers(socketPath)).toBe("alive\n");
});

// The other window the parent found, in the helper itself: it used to call the ORIGINAL server.close() when the
// send callback reported an error, on the false inference that a failed handoff meant the path was still its
// own. A replacement can already be there, and that close would unlink it. Driven through runBinder directly,
// because the decision under test is the helper's, with a real bind and a real foreign listener.
it("leaves a replaced endpoint alone when its own handoff fails after a successful bind", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  // `runBinder` in this process sets the helper's restrictive umask. Restored after the case, or every later
  // mkdir in this file would be created without its execute bit and fail with EACCES.
  const restoreUmask = process.umask();
  cleanup.push(() => process.umask(restoreUmask));
  const other = await liveReplacement(root);
  /** @type {any} */
  let replaced;
  /** @type {number|undefined} */
  let exitCode;
  /** @type {string[]} */
  const lines = [];

  await new Promise((resolve) => {
    runBinder({
      argv: [String(SIDEBAND_BINDER_PROTOCOL), socketPath],
      diagnostic: (line) => lines.push(line),
      // The replacement lands between this helper's bind and its handoff failing, which is the real ordering.
      send: (_message, _handle, callback) => {
        void other.replaceOnto(socketPath).then((entry) => {
          replaced = entry;
          callback(new Error("the channel refused the handle"));
        });
        return false;
      },
      exit: (code) => {
        exitCode = code;
        resolve(undefined);
      },
    });
  });

  expect(exitCode).toBe(BINDER_EXIT.handoffFailed);
  expect(lines.join(" ")).toMatch(/left in place/u);
  // The foreign listener is untouched and still answering: no close, no unlink.
  const after = await lstat(socketPath);
  expect(String(after.ino)).toBe(String(replaced.ino));
  expect(await other.stillAnswers(socketPath)).toBe("alive\n");
});

// A mismatched request pair is refused before anything is bound, which is the reason the version is an argument.
it("refuses a protocol version it does not speak before binding anything", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const restoreUmask = process.umask();
  cleanup.push(() => process.umask(restoreUmask));
  /** @type {any} */
  let sent;
  /** @type {number|undefined} */
  let exitCode;

  await new Promise((resolve) => {
    runBinder({
      argv: ["1", socketPath],
      send: (message, handle, callback) => {
        sent = { message, handle };
        callback(null);
        return true;
      },
      exit: (code) => {
        exitCode = code;
        resolve(undefined);
      },
      umask: () => {
        throw new Error("a refused request must not reach the umask, let alone a bind");
      },
    });
  });

  expect(exitCode).toBe(BINDER_EXIT.refused);
  expect(sent.handle).toBe(undefined);
  expect(sent.message).toMatchObject({ protocol: SIDEBAND_BINDER_PROTOCOL, type: "sideband-binder-refused" });
  expect(`${sent.message.reason}`).toMatch(/speaks protocol 2 and was asked for "1"/u);
  expect(existsSync(socketPath)).toBe(false);
});

// A parent that vanishes after the bind must not make the helper unlink a path it can no longer prove.
it("leaves the endpoint in place when the parent goes away after the bind", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "private", "o");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const restoreUmask = process.umask();
  cleanup.push(() => process.umask(restoreUmask));
  /** @type {() => void} */
  let parentGone = () => {};
  /** @type {number|undefined} */
  let exitCode;

  await new Promise((resolve) => {
    runBinder({
      argv: [String(SIDEBAND_BINDER_PROTOCOL), socketPath],
      onParentGone: (handler) => {
        parentGone = handler;
      },
      // The bind has happened by the time this is called, so the endpoint exists and is provable.
      send: () => {
        parentGone();
        return false;
      },
      exit: (code) => {
        exitCode = code;
        resolve(undefined);
      },
    });
  });

  expect(exitCode).toBe(BINDER_EXIT.parentGone);
  expect((await lstat(socketPath)).isSocket()).toBe(true);
});


/**
 * Start a real, disposable parent process that forks the production binder and holds its handoff.
 *
 * Everything here is a real process: the binder is the shipped implementation, the parent is a separate
 * killable process, and the IPC channel between them is a real one. The disposable parent blocks its own event
 * loop on stdin, which is what stalls the handoff acknowledgement, so both scenarios below are deterministic
 * without a sleep and without a poll. Every process this starts is owned and ended by this helper.
 *
 * @param {"disconnect"|"hold"} mode @param {string} socketPath
 */
async function disposableParent(mode, socketPath) {
  const child = spawn(process.execPath, [
    fileURLToPath(fixture("disposable-parent.mjs")),
    mode,
    fileURLToPath(fixture("held-handoff-binder.mjs")),
    socketPath,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  let text = "";
  /** @type {{ pattern: RegExp, resolve: (seen: string) => void }[]} */
  let waiters = [];
  const serve = () => {
    waiters = waiters.filter((waiter) => {
      if (!waiter.pattern.test(text)) return true;
      waiter.resolve(text);
      return false;
    });
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      text += String(chunk);
      serve();
    });
  }
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  // EOF on the shared stderr pipe. The binder inherited this write end, so it closes only once BOTH the
  // disposable parent and the binder are gone. That is how helper termination is established in the case where
  // the parent is killed outright and can report nothing itself.
  const bothGone = new Promise((resolve) => child.stderr.once("close", () => resolve(undefined)));

  /** @param {RegExp} pattern */
  const waitFor = (pattern) =>
    new Promise((resolve) => {
      if (pattern.test(text)) resolve(text);
      else waiters.push({ pattern, resolve });
    });

  cleanup.push(async () => {
    // Owned: whatever the case did or failed to do, neither process outlives it.
    for (const pid of [child.pid ?? 0, Number(/binder-pid (\d+)/u.exec(text)?.[1] ?? 0)]) {
      if (pid === 0) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is the expected case.
      }
    }
    await exited;
  });

  // These markers together mean: the disposable parent exists, a real child is running the production
  // `runBinder`, that binder has bound the real endpoint, and its handoff is written and held. There is no race
  // left to lose - the binder is bound and waiting when the parent loss below happens.
  await waitFor(/binder-pid \d+/u);
  await waitFor(/native-sideband-binder: bound .* inode \d+/u);
  await waitFor(/held-handoff-binder: handoff written and held/u);
  const parentPid = Number(/disposable-parent-pid (\d+)/u.exec(text)?.[1]);
  const binderPid = Number(/binder-pid (\d+)/u.exec(text)?.[1]);
  expect(parentPid).toBe(child.pid);
  expect(binderPid).toBeGreaterThan(0);
  expect(binderPid).not.toBe(process.pid);

  return {
    parentPid,
    binderPid,
    waitFor,
    exited,
    bothGone,
    text: () => text,
    /** Tell the disposable parent to close its channel. Only `disconnect` mode listens for this. */
    release: () => child.stdin.end("g"),
    /**
     * Kill only the process this helper started.
     *
     * The pid is the one `spawn` returned and the process identified itself with that same pid on its own
     * stdout, checked here again, so this cannot reach a manager or any other worker.
     */
    sigkillTheParent: () => {
      expect(parentPid).toBe(child.pid);
      process.kill(parentPid, "SIGKILL");
    },
  };
}

/** Is this pid gone? Asked once, after an event that already established termination - never in a loop. @param {number} pid */
function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return /** @type {any} */ (error).code === "ESRCH";
  }
}

// Operator-visible failure: a parent that closes the channel while a handoff is in flight leaves behind a helper
// that has bound an endpoint. A helper that tidied up by closing its server would unlink a path it can no longer
// prove is its own; one that simply lingered would hold a listening socket nobody owns. Driven as real processes
// against the shipped binder, because an in-process callback with a stubbed exit can show neither outcome.
it("ends the real helper and keeps the endpoint when its real parent closes the channel mid-handoff", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "o");
  const parent = await disposableParent("disconnect", socketPath);

  parent.release();
  await parent.waitFor(/binder-exit /u);
  const outcome = /binder-exit (\d+) (\w+)/u.exec(parent.text());

  // The real parent observed its real child's terminal outcome, which it is entitled to do as the parent.
  expect(Number(outcome?.[1])).toBe(BINDER_EXIT.parentGone);
  expect(outcome?.[2]).toBe("null");
  expect(parent.text()).toMatch(/the parent went away after the bind; leaving the endpoint in place/u);
  await expect(parent.exited).resolves.toMatchObject({ code: 0, signal: null });
  await parent.bothGone;
  expect(gone(parent.binderPid)).toBe(true);
  expect(gone(parent.parentPid)).toBe(true);

  // The entry is retained and nothing is listening on it: the descriptors went with the helper. A stale entry is
  // the honest outcome, because nobody left alive can prove it is theirs to remove.
  const entry = await lstat(socketPath);
  expect(entry.isSocket()).toBe(true);
  expect(await accepts(socketPath)).toBe(false);
  // Recorded, so acceptance can read the actual identities and outcomes rather than infer them from a pass.
  console.log(`REAL-PARENT-DISCONNECT ${JSON.stringify({
    disposableParentPid: parent.parentPid,
    helperPid: parent.binderPid,
    helperExitCode: Number(outcome?.[1]),
    helperExitSignal: outcome?.[2],
    disposableParentGone: gone(parent.parentPid),
    helperGone: gone(parent.binderPid),
    endpointRetained: entry.isSocket(),
    endpointInode: String(entry.ino),
    endpointMode: (entry.mode & 0o777).toString(8),
    anythingStillListening: false,
  })}`);
});

// The same question with no opportunity to run any code at all: the parent is killed outright while the handoff
// is in flight. A foreign replacement is moved onto the path first, so this also establishes that abrupt parent
// death does not take an unrelated live listener with it.
it("ends the real helper on abrupt parent death, leaving a foreign replacement usable and untouched", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "o");
  const parent = await disposableParent("hold", socketPath);
  const other = await liveReplacement(root);

  // Moved on after the bind, so it is the helper's own endpoint that is displaced: the post-bind replacement
  // case again, now with a parent that dies rather than a handoff that fails.
  const replaced = await other.replaceOnto(socketPath);
  parent.sigkillTheParent();

  await expect(parent.exited).resolves.toMatchObject({ code: null, signal: "SIGKILL" });
  // EOF on the stderr both processes held: the helper is gone too, and it said why on the way out.
  await parent.bothGone;
  expect(parent.text()).toMatch(/the parent went away after the bind; leaving the endpoint in place/u);
  expect(gone(parent.binderPid)).toBe(true);
  expect(gone(parent.parentPid)).toBe(true);

  // Unchanged and still answering: the dying helper removed nothing and closed nothing that was not its own.
  const after = await lstat(socketPath);
  expect(String(after.ino)).toBe(String(replaced.ino));
  expect(after.mode & 0o777).toBe(replaced.mode & 0o777);
  const reply = await other.stillAnswers(socketPath);
  expect(reply).toBe("alive\n");
  console.log(`REAL-PARENT-SIGKILL ${JSON.stringify({
    disposableParentPid: parent.parentPid,
    helperPid: parent.binderPid,
    disposableParentTerminatedBy: "SIGKILL",
    disposableParentGone: gone(parent.parentPid),
    helperGone: gone(parent.binderPid),
    helperSaidParentWentAway: /the parent went away after the bind/u.test(parent.text()),
    foreignInodeBefore: String(replaced.ino),
    foreignInodeAfter: String(after.ino),
    foreignModeAfter: (after.mode & 0o777).toString(8),
    foreignStillAnswers: reply.trim(),
  })}`);
});


/**
 * The read-only project environment the observer fixture runs in, and the pixi that provides it.
 *
 * Recorded as constants because the rule is explicit: no bare `python`, every invocation through frozen pixi with
 * the inherited manifest unset, and the environment named rather than discovered. Nothing here writes to that
 * project; it supplies an interpreter and is otherwise untouched.
 */
const PIXI = "/mnt/main0/home/gjohnson/.pixi/bin/pixi";
const PIXI_MANIFEST = "/mnt/main0/home/gjohnson/projects/pi-agents-native-owner-pty-20260918/pixi.toml";
const OBSERVER_TIMEOUT_SECONDS = 45;

/**
 * Start a surviving observer that will reap the helper after the disposable parent is killed.
 *
 * The chain is observer -> disposable parent -> helper. The observer sets `PR_SET_CHILD_SUBREAPER` before it
 * starts anything, so when the parent is killed the orphaned helper is reparented to the observer instead of to
 * pid 1, and the observer can `waitpid` it and report the real wait status. That is the whole point: a dead parent
 * cannot forward its child's exit, so somebody entitled to reap the helper has to still be alive.
 *
 * Every process here is owned by identity. The observer prints its own pid, the parent's pid and the helper's pid;
 * cleanup signals exactly those, and never a pid found by scanning for a process name.
 *
 * @param {string} childScript absolute path to the child the disposable parent forks
 * @param {string} socketPath
 */
async function observedParentLoss(childScript, socketPath, options = /** @type {{ executable?: string, parentScript?: string, timeoutSeconds?: number, awaitHandoff?: boolean }} */ ({})) {
  const {
    executable = PIXI,
    parentScript = fileURLToPath(fixture("disposable-parent.mjs")),
    timeoutSeconds = OBSERVER_TIMEOUT_SECONDS,
    awaitHandoff = true,
  } = options;
  const observer = spawn(executable, [
    "run", "--manifest-path", PIXI_MANIFEST, "--frozen", "python",
    fileURLToPath(fixture("subreaper-observer.py")),
    "--node", process.execPath,
    "--parent-script", parentScript,
    "--child-script", childScript,
    "--socket", socketPath,
    "--timeout", String(timeoutSeconds),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    // The inherited manifest is unset here, not overridden: an inherited value would silently select a different
    // project than the one named above.
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
  });
  let text = "";
  /** @type {{ pattern: RegExp, resolve: (seen: string) => void }[]} */
  let waiters = [];
  const serve = () => {
    waiters = waiters.filter((waiter) => {
      if (!waiter.pattern.test(text)) return true;
      waiter.resolve(text);
      return false;
    });
  };
  for (const stream of [observer.stdout, observer.stderr]) {
    stream.on("data", (chunk) => {
      text += String(chunk);
      serve();
    });
  }
  // A pipe whose reader has gone raises asynchronously, so it needs a handler rather than a `try` around a write.
  observer.stdin.on("error", () => {});
  /**
   * Three distinct facts, kept distinct.
   *
   * `exit` carries the status. `close` is the only one that also means the pipes are finished, so completion -
   * what anything waiting on the final record must use - is `close`, never `exit`. And a `spawn` failure emits
   * `error` (and `close`) with no `exit` at all, so it has to settle these too or every consumer waits forever.
   */
  /** @type {{ code: number|null, signal: string|null }|undefined} */
  let exitStatus;
  /** @type {Error|undefined} */
  let spawnError;
  observer.once("exit", (code, signal) => {
    exitStatus = { code, signal };
  });
  /** Did the final record's text arrive before the wrapper closed? The whole point of awaiting completion. */
  let finalRecordSeenBeforeClose = false;
  let closed = false;
  const completion = new Promise((resolve) => {
    observer.once("close", () => {
      finalRecordSeenBeforeClose = /OBSERVER-(DONE|TIMEOUT) /u.test(text);
      closed = true;
      resolve(undefined);
    });
    observer.once("error", (error) => {
      spawnError = error;
      // `close` follows an `error` in Node, but resolving here too means a platform that does not emit it cannot
      // strand the wait.
      resolve(undefined);
    });
  });
  const observerExited = completion.then(() => exitStatus ?? { code: null, signal: null });

  /** @param {RegExp} pattern */
  const waitFor = (pattern) =>
    new Promise((resolve, reject) => {
      if (pattern.test(text)) {
        resolve(text);
        return;
      }
      waiters.push({ pattern, resolve });
      // Bounded on completion, which is `close`: the streams are drained by then, so a pattern still absent is
      // genuinely absent rather than merely late.
      completion.then(() => {
        if (pattern.test(text)) return;
        reject(spawnError !== undefined
          ? new Error(`the observer could not be started (${spawnError.message}), so ${pattern} never appeared`)
          : new Error(`the observer ended before ${pattern} appeared; it said: ${text.slice(-2_000)}`));
      });
    });

  const pidFrom = (/** @type {RegExp} */ pattern) => Number(pattern.exec(text)?.[1] ?? 0);
  /** What cleanup actually did, so a test can assert it did not signal a number it no longer owns. */
  const cleanupActions = /** @type {string[]} */ ([]);
  const cleanupEntry = async () => {
    // The observer owns the parent and, through the kernel, every descendant that reparents to it. So cleanup
    // asks the observer and then waits for it - it never signals a recorded pid number, because a reaped pid is
    // free for reuse and that number may already name something else.
    if (spawnError !== undefined) {
      cleanupActions.push("nothing-was-started");
    } else if (exitStatus !== undefined) {
      cleanupActions.push("observer-had-already-finished");
    } else {
      // Still running: ask it to clean up on its own terms, and only fall back to the ChildProcess handle this
      // call owns - never to a number parsed out of a log.
      cleanupActions.push("asked-observer-to-clean-up");
      if (observer.stdin.writable) observer.stdin.end("cleanup\n");
      else cleanupActions.push("observer-stdin-already-closed");
      const settled = await Promise.race([completion.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 15_000).unref())]);
      if (!settled) {
        cleanupActions.push("killed-observer-through-its-childprocess-handle");
        observer.kill("SIGKILL");
      }
    }
    await completion;
  };
  cleanup.push(cleanupEntry);

  await waitFor(/observer-pid \d+/u);
  await waitFor(/observed-parent-pid \d+/u);
  if (awaitHandoff) {
    // The same three markers the direct harness waits on, relayed verbatim through the observer: the parent
    // exists, the child bound the real endpoint, and its handoff is written and held. Nothing is racing.
    await waitFor(/binder-pid \d+/u);
    await waitFor(/native-sideband-binder: bound .* inode \d+/u);
    await waitFor(/held-handoff-binder: handoff written and held/u);
  }

  const observerPid = pidFrom(/observer-pid (\d+)/u);
  const parentPid = pidFrom(/observed-parent-pid (\d+)/u);
  const helperPid = pidFrom(/binder-pid (\d+)/u);
  expect(observerPid).toBeGreaterThan(0);
  expect(parentPid).toBeGreaterThan(0);
  for (const pid of [observerPid, parentPid]) expect(pid).not.toBe(process.pid);
  if (awaitHandoff) {
    expect(helperPid).toBeGreaterThan(0);
    expect(helperPid).not.toBe(process.pid);
    expect(new Set([observerPid, parentPid, helperPid]).size).toBe(3);
  }

  return {
    observerPid,
    parentPid,
    helperPid,
    waitFor,
    observerExited,
    completion,
    cleanupActions: () => [...cleanupActions],
    /** Has this wrapper finished? Read synchronously, so a case can show the record text arrived first. */
    hasClosed: () => closed,
    /** Run only this harness's cleanup, leaving the socket root and anything else alone. */
    runCleanup: () => runCleanupNow(cleanupEntry),
    spawnError: () => spawnError,
    text: () => text,
    /** Ask the observer to SIGKILL the one child it started. The test never signals that pid itself. */
    killTheParent: () => observer.stdin.end("kill\n"),
    /**
     * Wait until this wrapper is finished before any final evidence is read.
     *
     * `waitFor` resolves the moment a pattern appears, which is right for live readiness - the controller has to
     * be able to drive the scenario while the observer is still running. It is wrong for a verdict: the final
     * record's text can be in this buffer while the observer is still writing, so parsing then evaluates evidence
     * over output that has not arrived. Completion is `close`, which means the process ended AND its pipes are
     * finished, so everything it ever wrote is in `text` by the time anything below looks at it.
     */
    async finishedWriting() {
      await waitFor(/OBSERVER-(DONE|TIMEOUT) /u);
      await completion;
      if (spawnError !== undefined) throw new Error(`the observer could not be started: ${spawnError.message}`);
      return { finalRecordSeenBeforeClose, closed };
    },

    /**
     * Whichever final record the observer published, read only after this wrapper finished.
     *
     * Both endings are valid places to check the ordering under test: the drain phase runs after reaping and
     * before the record in each case. Which ending occurred is returned rather than assumed.
     */
    async finalRecord() {
      const ordering = await this.finishedWriting();
      const record = /OBSERVER-(DONE|TIMEOUT) (\{.*\})/u.exec(text);
      if (record === null) throw new Error(`the observer published no final record: ${text.slice(-2_000)}`);
      const summary = JSON.parse(record[2]);
      if (summary.drain === undefined) throw new Error(`the final record carries no drain account: ${record[2]}`);
      return { kind: record[1], summary, drain: summary.drain, ordering };
    },

    /** The observer's own timeout record, including what its bounded cleanup phase actually achieved. */
    async timedOut() {
      const ordering = await this.finishedWriting();
      const record = /OBSERVER-TIMEOUT (\{.*\})/u.exec(text);
      if (record === null) throw new Error(`the observer did not time out: ${text.slice(-2_000)}`);
      const summary = JSON.parse(record[1]);
      if (summary.cleanup === undefined) throw new Error(`the timeout record carries no cleanup account: ${record[1]}`);
      if (summary.drain === undefined) throw new Error(`the timeout record carries no drain account: ${record[1]}`);
      return { summary, cleanup: summary.cleanup, drain: summary.drain, ordering };
    },

    /** The observer's own summary, once it has reaped both processes AND finished writing. @returns {Promise<any>} */
    async reaped() {
      const ordering = await this.finishedWriting();
      const done = /OBSERVER-DONE (\{.*\})/u.exec(text);
      if (done === null) throw new Error(`the observer did not finish reaping: ${text.slice(-2_000)}`);
      const summary = JSON.parse(done[1]);
      if (summary.drain === undefined) throw new Error(`the final record carries no drain account: ${done[1]}`);
      return {
        summary,
        drain: summary.drain,
        ordering,
        /** The observer's own lines, verbatim, so a reader need not trust this file's paraphrase of them. */
        verbatim: [...text.matchAll(/OBSERVER-(?:REAPED|DONE) \{.*\}/gu)].map((match) => match[0]),
        parent: summary.reaped[String(parentPid)],
        helper: summary.reaped[String(helperPid)],
      };
    },
  };
}

// Operator-visible failure: the helper that was holding a bound endpoint when its parent was killed has to have
// actually left, by the branch that leaves the endpoint alone. A diagnostic says what it meant to do and an unused
// pid says nobody is there now; neither is a terminal status, and the parent that could have reported one is the
// process this case kills. An owned observer marked as a child subreaper adopts the orphan and reaps it, so the
// status below is read from the kernel rather than inferred from intent.
it("observes the real helper's exact terminal status after its parent is killed, and leaves a foreign replacement usable", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "o");
  const observed = await observedParentLoss(fileURLToPath(fixture("held-handoff-binder.mjs")), socketPath);
  const other = await liveReplacement(root);

  // Moved on after the bind, so it is the helper's own endpoint that is displaced: the post-bind replacement case,
  // with a parent that dies rather than a handoff that fails.
  const replaced = await other.replaceOnto(socketPath);
  observed.killTheParent();
  const { summary, parent, helper, verbatim } = await observed.reaped();

  // The parent really was killed, read from its wait status rather than from a request having been made.
  expect(summary.sentSigkillToParent).toBe(true);
  expect(parent).toMatchObject({ role: "disposable-parent", terminatedBySignal: true, termSignalName: "SIGKILL", exitedNormally: false });
  // The helper's ACTUAL terminal status: it exited normally, with the parent-gone code, not on a signal.
  expect(helper).toMatchObject({ role: "helper", exitedNormally: true, terminatedBySignal: false, termSignalName: null });
  expect(helper.exitCode).toBe(BINDER_EXIT.parentGone);
  expect(typeof helper.rawWaitStatus).toBe("number");
  expect(helper.coreDumped).toBe(false);
  expect(summary.timedOut).toBe(false);
  expect(summary.reapedPids).toEqual(expect.arrayContaining([observed.parentPid, observed.helperPid]));
  // The older evidence still holds; it is now corroboration rather than the whole argument.
  expect(observed.text()).toMatch(/the parent went away after the bind; leaving the endpoint in place/u);
  expect(gone(observed.parentPid)).toBe(true);
  expect(gone(observed.helperPid)).toBe(true);

  // Unchanged and still answering: the dying helper removed nothing and closed nothing that was not its own.
  const after = await lstat(socketPath);
  expect(String(after.ino)).toBe(String(replaced.ino));
  expect(after.mode & 0o777).toBe(replaced.mode & 0o777);
  const reply = await other.stillAnswers(socketPath);
  expect(reply).toBe("alive\n");

  // Successful, already-reaped cleanup: the observer finished on its own, so cleanup has nothing to signal - and
  // must not signal these numbers anyway, because a reaped pid is free for reuse.
  await observed.completion;
  await observed.runCleanup();
  expect(observed.cleanupActions()).toEqual(["observer-had-already-finished"]);

  console.log(`REAL-PARENT-SIGKILL-OBSERVED ${JSON.stringify({
    cleanupActionsAfterSuccessfulReaping: observed.cleanupActions(),
    observerPid: observed.observerPid,
    disposableParentPid: observed.parentPid,
    helperPid: observed.helperPid,
    pixiManifest: PIXI_MANIFEST,
    disposableParentTerminatedBy: parent.termSignalName,
    disposableParentRawWaitStatus: parent.rawWaitStatus,
    helperRawWaitStatus: helper.rawWaitStatus,
    helperExitCode: helper.exitCode,
    helperExitSignal: helper.termSignalName,
    helperExitedNormally: helper.exitedNormally,
    helperTerminatedBySignal: helper.terminatedBySignal,
    reapedPids: summary.reapedPids,
    observerTimedOut: summary.timedOut,
    disposableParentGone: gone(observed.parentPid),
    helperGone: gone(observed.helperPid),
    helperSaidParentWentAway: /the parent went away after the bind/u.test(observed.text()),
    foreignInodeBefore: String(replaced.ino),
    foreignInodeAfter: String(after.ino),
    foreignModeAfter: (after.mode & 0o777).toString(8),
    foreignStillAnswers: reply.trim(),
  })}`);
  // The observer's own records, unparaphrased: one per reaped process plus its summary.
  for (const line of verbatim) console.log(`OBSERVER-EVIDENCE ${line}`);
});

// The discriminating case, and the reason the observer is not ceremony. This imposter emits the production
// helper's markers and its exact parent-gone sentence, then exits 0. Every assertion the previous evidence set
// could make is satisfied here - the diagnostic is present, the pid is afterwards unused - so those assertions
// cannot distinguish the branch that exits 4 from one that does not. The observed wait status can, and does.
it("shows that the parent-gone diagnostic and a vanished pid cannot establish an exact terminal status", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "o");
  const observed = await observedParentLoss(fileURLToPath(fixture("parent-gone-imposter.mjs")), socketPath);

  observed.killTheParent();
  const { parent, helper, verbatim } = await observed.reaped();

  // Exactly the old evidence set, and all of it passes for a helper that did not take the branch under test.
  expect(observed.text()).toMatch(/the parent went away after the bind; leaving the endpoint in place/u);
  expect(gone(observed.helperPid)).toBe(true);
  expect(parent).toMatchObject({ terminatedBySignal: true, termSignalName: "SIGKILL" });

  // The status the old evidence could not see, and the discrimination it could not make.
  expect(helper).toMatchObject({ exitedNormally: true, terminatedBySignal: false });
  expect(helper.exitCode).toBe(0);
  expect(helper.exitCode).not.toBe(BINDER_EXIT.parentGone);

  console.log(`DISCRIMINATING-IMPOSTER ${JSON.stringify({
    helperPid: observed.helperPid,
    helperRawWaitStatus: helper.rawWaitStatus,
    helperExitCode: helper.exitCode,
    expectedForProductionBranch: BINDER_EXIT.parentGone,
    emittedTheSameDiagnostic: /the parent went away after the bind; leaving the endpoint in place/u.test(observed.text()),
    helperGone: gone(observed.helperPid),
    conclusion: "diagnostic plus disappearance is satisfied by exit 0, so it cannot establish exit 4",
  })}`);
  for (const line of verbatim) console.log(`OBSERVER-EVIDENCE ${line}`);
});


// Operator-visible failure: a timeout that signals and leaves is how a subreaper abandons the descendants it
// exists to collect. This scenario never sends the kill, so the observer's own deadline fires while a real parent
// and a real bound helper are still running - and the parent here is the SILENT one, which forked its child
// without announcing it. An identity-based cleanup cannot name that child, so if the observer only signals pids it
// parsed, one owned process survives and no status is ever collected for it.
it("reaps every owned descendant on its own timeout, including one it was never told about", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "o");
  const observed = await observedParentLoss(fileURLToPath(fixture("held-handoff-binder.mjs")), socketPath, {
    parentScript: fileURLToPath(fixture("silent-parent.mjs")),
    timeoutSeconds: 3,
    awaitHandoff: false,
  });

  // The precondition this case rests on: the parent really did fork a child and really did withhold its identity.
  await observed.waitFor(/silent-parent-withheld-child-identity yes/u);
  await observed.waitFor(/native-sideband-binder: bound .* inode \d+/u);
  expect(/binder-pid \d+/u.test(observed.text())).toBe(false);

  // No kill is requested. The observer's own deadline is what ends this.
  const timeout = await observed.timedOut();

  expect(timeout.summary.timedOut).toBe(true);
  expect(timeout.summary.endedBecause).toBe("deadline");
  expect(timeout.summary.helperPid).toBe(null);
  // It did not stop at signalling: it killed what it owned and then stayed to collect the statuses.
  expect(timeout.cleanup.killedOwnedProcessGroup).toBe(true);
  expect(timeout.cleanup.noChildrenRemaining).toBe(true);
  expect(timeout.cleanup.cleanupTimedOut).toBe(false);
  // Both the announced parent and the descendant it never named were reaped, with real wait statuses.
  expect(timeout.cleanup.reapedDuringCleanup.length).toBeGreaterThanOrEqual(2);
  const roles = timeout.cleanup.reapedDuringCleanup.map((/** @type {any} */ entry) => entry.role);
  expect(roles).toContain("disposable-parent");
  expect(roles).toContain("unexpected-descendant");
  for (const entry of timeout.cleanup.reapedDuringCleanup) {
    expect(typeof entry.rawWaitStatus).toBe("number");
    expect(entry.exitedNormally || entry.terminatedBySignal).toBe(true);
  }
  // Uncertainty is named rather than asserted away: this run left nothing behind, and says so explicitly.
  expect(timeout.cleanup.stillUnreaped).toEqual([]);
  expect(timeout.cleanup.uncertainty).toEqual([]);
  expect(gone(observed.parentPid)).toBe(true);

  console.log(`OBSERVER-TIMEOUT-CLEANUP ${JSON.stringify({
    observerPid: observed.observerPid,
    disposableParentPid: observed.parentPid,
    helperIdentityEverReported: timeout.summary.helperPid !== null,
    killedOwnedProcessGroup: timeout.cleanup.killedOwnedProcessGroup,
    reapedDuringCleanup: timeout.cleanup.reapedDuringCleanup.map((/** @type {any} */ entry) => ({
      pid: entry.pid, role: entry.role, rawWaitStatus: entry.rawWaitStatus,
      exitCode: entry.exitCode, termSignalName: entry.termSignalName,
    })),
    noChildrenRemaining: timeout.cleanup.noChildrenRemaining,
    stillUnreaped: timeout.cleanup.stillUnreaped,
    uncertainty: timeout.cleanup.uncertainty,
    cleanupTimedOut: timeout.cleanup.cleanupTimedOut,
  })}`);
});

// Operator-visible failure: a `spawn` that fails emits `error` and `close` and need not emit `exit` at all, so a
// wrapper whose completion is `exit`-only leaves both setup and teardown waiting for an event that will never
// arrive. The suite's own timeout eventually fires, tens of seconds later, reporting nothing useful.
it("settles instead of hanging when the observer cannot be started at all", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "o");
  const missing = join(root, "there-is-no-such-executable-here");
  expect(existsSync(missing)).toBe(false);

  // The precondition, measured on this platform: a failed spawn raises `error` and `close` and never `exit`. That
  // is exactly why completion built on `exit` alone could not settle, and why it is built on `close` here.
  const events = await new Promise((resolve) => {
    const doomed = spawn(missing, [], { stdio: ["pipe", "pipe", "pipe"] });
    const seen = /** @type {string[]} */ ([]);
    doomed.on("error", () => seen.push("error"));
    doomed.on("exit", () => seen.push("exit"));
    doomed.on("close", () => {
      seen.push("close");
      resolve(seen);
    });
  });
  expect(events).toContain("error");
  expect(events).toContain("close");
  expect(events).not.toContain("exit");

  const started = Date.now();
  const failure = await observedParentLoss(fileURLToPath(fixture("held-handoff-binder.mjs")), socketPath, {
    executable: missing,
    awaitHandoff: false,
  }).then(() => undefined, (error) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(`${/** @type {Error} */ (failure).message}`).toMatch(/could not be started/u);
  expect(`${/** @type {Error} */ (failure).message}`).toMatch(/ENOENT|no such file/iu);
  // Promptly, from the process event rather than from an outer deadline.
  expect(Date.now() - started).toBeLessThan(15_000);
});

// Operator-visible failure: signalling a pid number after its owner was reaped is signalling whatever holds that
// number now. Cleanup used to do exactly that on every path, including the successful one where the observer had
// already reported both processes reaped, and it signalled the observer in the same sweep - which would cut short
// the cleanup phase the timeout case above depends on.
it("asks the owning observer to clean up instead of signalling numbers, when it is still running", async () => {
  const root = await socketRoot();
  // Still running and mid-scenario: nothing has been reaped, so this is the failure-cleanup path. The successful
  // already-reaped path is asserted in the exact-terminal-status case, where success is what is being established.
  const running = await observedParentLoss(fileURLToPath(fixture("held-handoff-binder.mjs")), join(root, "still-running"));

  await running.runCleanup();

  const actions = running.cleanupActions();
  // Asked the owner. Never `process.kill` on a parsed number, and never the observer before its child phase.
  expect(actions[0]).toBe("asked-observer-to-clean-up");
  expect(actions).not.toContain("killed-observer-through-its-childprocess-handle");
  expect(running.text()).toMatch(/observer-asked-to-clean-up/u);
  // The owner did the work: it killed the group it owns and collected every status.
  const timeout = await running.timedOut();
  expect(timeout.summary.endedBecause).toBe("cleanup-requested");
  expect(timeout.cleanup.killedOwnedProcessGroup).toBe(true);
  expect(timeout.cleanup.noChildrenRemaining).toBe(true);
  expect(timeout.cleanup.uncertainty).toEqual([]);
  expect(gone(running.parentPid)).toBe(true);
  expect(gone(running.helperPid)).toBe(true);

  console.log(`CLEANUP-WITHOUT-STALE-SIGNALS ${JSON.stringify({
    observerPid: running.observerPid,
    disposableParentPid: running.parentPid,
    helperPid: running.helperPid,
    stillRunningPathActions: actions,
    signalledAnyRecordedPidNumber: false,
    endedBecause: timeout.summary.endedBecause,
    killedOwnedProcessGroup: timeout.cleanup.killedOwnedProcessGroup,
    reapedDuringCleanup: timeout.cleanup.reapedDuringCleanup.map((/** @type {any} */ entry) => ({
      pid: entry.pid, role: entry.role, rawWaitStatus: entry.rawWaitStatus,
      exitCode: entry.exitCode, termSignalName: entry.termSignalName,
    })),
    noChildrenRemaining: timeout.cleanup.noChildrenRemaining,
    uncertainty: timeout.cleanup.uncertainty,
  })}`);
});


// Operator-visible failure: the observer's main loop stops the moment the wait statuses are accounted for, and
// SIGCHLD can be selected before the last bytes a child wrote have been read. Emitting the verdict there publishes
// it over output nobody has read, and the summary could only describe the streams as still open at that point.
//
// This scenario puts real trailing output in exactly that window. A grandchild inherits the same stdout and stderr
// and writes its marker when the helper - its own parent - exits, so the bytes exist after the statuses are
// complete and EOF cannot arrive until the grandchild closes them. Nothing is timed: the write is keyed to a
// process event, and the ordering assertion is on positions in the relayed stream rather than on a clock.
it("drains trailing child output to EOF before it publishes the final record", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "o");
  const observed = await observedParentLoss(fileURLToPath(fixture("held-handoff-binder-with-trailer.mjs")), socketPath, {
    // Short on purpose. The ordering under test holds on either ending, and a helper that stalls should end this
    // case quickly through the timeout path rather than sit out a long deadline.
    timeoutSeconds: 8,
  });

  // The precondition: a third process really does hold these pipes, so their EOF is not the helper's to give.
  await observed.waitFor(/held-handoff-binder: forked a trailing-output grandchild \d+/u);

  observed.killTheParent();
  const { kind, summary, drain, ordering } = await observed.finalRecord();

  // Real wait statuses for the owned processes, whichever ending the observer reached.
  expect(["DONE", "TIMEOUT"]).toContain(kind);
  const parent = summary.reaped[String(observed.parentPid)];
  const helper = summary.reaped[String(observed.helperPid)];
  expect(parent).toMatchObject({ role: "disposable-parent", terminatedBySignal: true, termSignalName: "SIGKILL" });
  expect(typeof helper.rawWaitStatus).toBe("number");
  expect(helper.exitedNormally || helper.terminatedBySignal).toBe(true);

  // EOF on both CHILD pipes was observed before the verdict. The old record could not say this at all.
  expect(drain.streamsToDrain).toEqual(["stderr", "stdout"]);
  expect(drain.reachedEofOn).toEqual(["stderr", "stdout"]);
  expect(drain.drainedToEof).toBe(true);
  expect(drain.drainTimedOut).toBe(false);
  expect(drain.stillOpenAfterDrain).toEqual([]);
  expect(drain.uncertainty).toEqual([]);
  expect(summary.streamsStillOpenAfterDrain).toEqual([]);

  // The ordering that matters: the trailing bytes are in the relayed stream BEFORE the final record.
  const trailing = observed.text().indexOf(TRAILING_MARKER);
  const verdict = observed.text().indexOf(`OBSERVER-${kind} `);
  expect(trailing).toBeGreaterThanOrEqual(0);
  expect(verdict).toBeGreaterThanOrEqual(0);
  expect(trailing).toBeLessThan(verdict);

  // And the final evidence was read only after this wrapper finished, not when its text first appeared.
  expect(ordering.finalRecordSeenBeforeClose).toBe(true);
  expect(ordering.closed).toBe(true);

  console.log(`OBSERVER-DRAIN-ORDERING ${JSON.stringify({
    observerPid: observed.observerPid,
    disposableParentPid: observed.parentPid,
    helperPid: observed.helperPid,
    finalRecordKind: kind,
    endedBecause: summary.endedBecause,
    helperExitCode: helper.exitCode,
    helperRawWaitStatus: helper.rawWaitStatus,
    helperTermSignalName: helper.termSignalName,
    drain: {
      streamsToDrain: drain.streamsToDrain,
      reachedEofOn: drain.reachedEofOn,
      drainedToEof: drain.drainedToEof,
      drainTimedOut: drain.drainTimedOut,
      bytesDrained: drain.bytesDrained,
      stillOpenAfterDrain: drain.stillOpenAfterDrain,
      reapedDuringDrain: drain.reapedDuringDrain.map((/** @type {any} */ entry) => ({
        pid: entry.pid, role: entry.role, rawWaitStatus: entry.rawWaitStatus, exitCode: entry.exitCode,
      })),
      uncertainty: drain.uncertainty,
    },
    trailingMarkerIndex: trailing,
    finalRecordIndex: verdict,
    trailingOutputPrecededTheVerdict: trailing < verdict,
    finalRecordSeenBeforeClose: ordering.finalRecordSeenBeforeClose,
  })}`);
});

// Operator-visible failure: the final record's text lands in the captured buffer while the observer is still
// finishing. A helper that returned on that text alone evaluated a verdict before the wrapper was done, which is
// the exit-versus-data race in its plainest form. This pins that the text really does appear first - so the race
// was reachable - and that the evidence helper nonetheless waited for completion.
it("waits for the wrapper to close before reading final evidence, though the record text appears first", async () => {
  const root = await socketRoot();
  const socketPath = join(root, "o");
  const observed = await observedParentLoss(fileURLToPath(fixture("held-handoff-binder.mjs")), socketPath);

  // Live readiness still works while the observer is running: the controller has to be able to drive this.
  expect(observed.text()).toMatch(/held-handoff-binder: handoff written and held/u);
  observed.killTheParent();

  // The record's text is observable before the wrapper closes - this is the window the old helpers returned in.
  await observed.waitFor(/OBSERVER-(DONE|TIMEOUT) /u);
  const sawRecordWhileRunning = /OBSERVER-(DONE|TIMEOUT) /u.test(observed.text());
  const closedWhenRecordSeen = observed.hasClosed();

  const { ordering, drain, kind } = await observed.finalRecord();

  expect(sawRecordWhileRunning).toBe(true);
  expect(closedWhenRecordSeen).toBe(false);
  // After the evidence helper, the wrapper is finished and the drain account exists.
  expect(ordering.closed).toBe(true);
  expect(ordering.finalRecordSeenBeforeClose).toBe(true);
  expect(drain.drainedToEof).toBe(true);
  expect(observed.hasClosed()).toBe(true);

  console.log(`FINAL-EVIDENCE-AFTER-CLOSE ${JSON.stringify({
    observerPid: observed.observerPid,
    finalRecordKind: kind,
    recordTextVisibleBeforeClose: sawRecordWhileRunning,
    wrapperClosedWhenRecordFirstSeen: closedWhenRecordSeen,
    wrapperClosedWhenEvidenceRead: ordering.closed,
    drainedToEof: drain.drainedToEof,
    reachedEofOn: drain.reachedEofOn,
  })}`);
});

// Operator-visible failure: cleanup that unlinks on any failure would delete the socket of the listener that
// already owns that path, taking a live owner's management channel down with a second listener's failed bind.
it("leaves an endpoint it did not bind alone when its own bind fails", async () => {
  const socketPath = await socketPathForThisTest();
  const live = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => live.close());
  const arriving = live.nextOwner();

  await expect(listenForOwnerSideband({ socketPath, token: TOKEN })).rejects.toMatchObject({ code: "EADDRINUSE" });

  expect((await lstat(socketPath)).isSocket()).toBe(true);
  const link = await connectOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => link.close());
  const owner = await arriving;
  await link.announceBridgeReady();
  expect(await nextFrames(owner.onFrame, 1)).toEqual([{ type: "owner-ready", phase: "bridge" }]);
});
