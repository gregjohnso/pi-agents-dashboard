import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

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
      if (stage !== "after_bind") return;
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

// The same window, failed by the real permission finalizer rather than an injected error: the socket this
// call bound is no longer a socket when it is narrowed, so `chmodPrivateSocket` itself rejects.
it("takes the same cleanup path when the real permission narrowing rejects", async () => {
  const socketPath = await socketPathForThisTest();

  const failure = await listenForOwnerSideband({
    socketPath,
    token: TOKEN,
    failpoint: async (/** @type {string} */ stage) => {
      if (stage !== "after_bind") return;
      await rm(socketPath);
      await writeFile(socketPath, "not a socket\n", { mode: 0o600 });
    },
  }).then(() => undefined, (/** @type {unknown} */ error) => error);

  expect(`${/** @type {Error} */ (failure).message}`).toMatch(/not a socket/iu);
  // Its own endpoint path is cleared, whatever replaced it, exactly as a successful close clears it.
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const replacement = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => replacement.close());
  expect((await lstat(socketPath)).isSocket()).toBe(true);
});

// A recorded platform limit, pinned so a change in it is noticed rather than assumed.
//
// Closing a bound pipe server removes the pathname libuv bound, before any code in this module runs: the
// explicit unlink in `discardListener` is a no-op for a path this call bound, and guarding it by the current
// entry's identity changes nothing. So a listener that bound this path and then failed takes a post-bind
// replacement down with it, whoever made that replacement. This module cannot arbitrate that through Node's
// public surface — there is no way to release a pipe server's handle without unlinking its bound pathname,
// and no public way to bind a listener to an externally created socket descriptor that carries no pathname.
//
// The exposure is bounded to one UID: the endpoint lives in a directory this call guarantees at mode 0700, so
// the only actor that can replace the entry is another process of the same user. If this case ever fails,
// Node stopped unlinking on close and the ownership question above is worth reopening.
it("records that closing a bound listener removes the pathname, replacement or not", async () => {
  const socketPath = await socketPathForThisTest();
  const foreign = `${socketPath}-foreign`;

  const failure = await listenForOwnerSideband({
    socketPath,
    token: TOKEN,
    failpoint: async (/** @type {string} */ stage) => {
      if (stage !== "after_bind") return;
      // Another actor replaces this path with its own live listening socket, then this call fails.
      await rm(socketPath);
      const other = await listenForOwnerSideband({ socketPath: foreign, token: TOKEN });
      cleanup.push(() => other.close());
      await rename(foreign, socketPath);
      throw new Error("the endpoint was replaced before this call finished");
    },
  }).then(() => undefined, (/** @type {unknown} */ error) => error);

  // The original failure is what the caller is told, whatever the cleanup met.
  expect(`${/** @type {Error} */ (failure).message}`).toBe("the endpoint was replaced before this call finished");
  // And the replacement is gone, removed by the close of the handle that had bound this pathname.
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
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
