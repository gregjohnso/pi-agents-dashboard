import { createHash, timingSafeEqual } from "node:crypto";
import { unlink } from "node:fs/promises";
import net from "node:net";
import { dirname, isAbsolute } from "node:path";

import { JsonlFramingError, createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";
import { chmodPrivateSocket, ensurePrivateDirectory } from "./permissions.mjs";

/**
 * The owner sideband: one authenticated management channel between a worker and the owner extension
 * running inside its Pi process.
 *
 * This is **not** seam E's core bootstrap channel. That one is created by Pi's own `main()` before any
 * extension is loaded, is isolated by the filesystem alone, carries readiness and presentation, and
 * authenticates nothing. Inventing a token for it would describe a channel that does not exist. This
 * channel is the other one: it opens from the extension's `session_start`, after the TUI has already
 * mounted, and it carries management only — bridge readiness, the owner's own reported seam table,
 * structured lifecycle and model facts, and stop/abort requests with their receipts.
 *
 * `NATIVE_SIDEBAND_PROTOCOL` is this channel's own version and is stamped on every frame in both
 * directions, because the worker and the owner extension are separate processes from separate releases:
 * a frame naming any other version is refused by version rather than read field by field.
 *
 * Authentication is the worker socket's shape and nothing more ([worker-socket.mjs](worker-socket.mjs)):
 * the connecting side's **first** frame carries the run's token, the receiver compares digests in
 * constant time, and a connection that fails is destroyed without a reply. None of that module's daemon
 * or worker responsibilities, its replacement rule, or the capability probe's `HELLO` — which was never
 * authentication — is reused here.
 *
 * Everything inbound is bounded before it is believed: the raw byte count of a frame is checked before
 * any UTF-8 decode or parse, a validated frame is queued only up to a fixed admission budget, and an
 * unauthenticated, unknown-version, malformed, unknown or over-budget frame closes the connection and
 * discards whatever was buffered behind it. No refusal, error or resolved value carries the token, the
 * handshake frame, the environment or the refused bytes: a refusal names its reason and nothing else.
 */

export const NATIVE_SIDEBAND_PROTOCOL = 1;
/** Where the worker put this run's socket. Read from the environment; never an argument, which /proc exposes. */
export const OWNER_SIDEBAND_SOCKET_ENV = "PI_AGENTS_OWNER_SIDEBAND_SOCKET";
/** This run's token. Read from the environment for the same reason. */
export const OWNER_SIDEBAND_TOKEN_ENV = "PI_AGENTS_OWNER_SIDEBAND_TOKEN";

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_QUEUED_FRAMES = 64;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_REPORTED_ENTRIES = 32;
const MAX_REPORTED_NAME_LENGTH = 64;
const MAX_FACT_ENTRIES = 32;
const MAX_FACT_TEXT_LENGTH = 4096;
const FACT_NAME = /^[a-z][A-Za-z0-9]{0,39}$/u;
const REQUESTS = ["stop", "abort"];
/**
 * What a receipt may claim. There is deliberately no completed outcome: `ctx.shutdown()` is request-only
 * and idle-deferred, so only the worker observing a reaped exit completes a stop.
 */
const OUTCOMES = ["requested", "deferred", "no-run", "unsupported"];
/** The public context methods a receipt may report as absent, so a gap is named rather than guessed around. */
const MISSING_METHODS = ["shutdown", "abort", "isIdle", "hasPendingMessages"];

/** @typedef {"unauthenticated"|"unknown-protocol"|"malformed-frame"|"unknown-frame"|"frame-too-large"|"queue-overflow"|"handshake-timeout"|"listener-failed"} SidebandRefusal */
/** @typedef {{ type: "owner-ready", phase: "bridge" }} OwnerReadyFrame */
/** @typedef {{ type: "owner-seams", reported: Record<string, unknown> }} OwnerSeamsFrame */
/** @typedef {{ type: "owner-facts", facts: Record<string, string|number|boolean> }} OwnerFactsFrame */
/** @typedef {{ requestId: string, request: "stop"|"abort", outcome: "requested"|"deferred"|"no-run"|"unsupported", idle?: boolean, pendingMessages?: boolean, missing?: string }} OwnerReceipt */
/** @typedef {OwnerReceipt & { type: "owner-receipt" }} OwnerReceiptFrame */
/** @typedef {OwnerReadyFrame|OwnerSeamsFrame|OwnerFactsFrame|OwnerReceiptFrame} OwnerFrame */
/** @typedef {{ type: "owner-request", requestId: string, request: "stop"|"abort" }} HostRequestFrame */
/** @typedef {{ ok: any, refusal?: undefined }|{ ok?: undefined, refusal: SidebandRefusal }} FrameVerdict */
/** @typedef {{ refusal: SidebandRefusal|undefined }} SidebandClose */

/** A sideband failure callers can handle without reading its text. The text never carries a credential. */
export class NativeSidebandError extends Error {
  /**
   * @param {"SIDEBAND_PATH_UNUSABLE"|"SIDEBAND_TOKEN_UNUSABLE"|"SIDEBAND_BOUND_UNUSABLE"|"SIDEBAND_LISTENER_UNUSABLE"|"SIDEBAND_UNREACHABLE"|"SIDEBAND_CLOSED"|"SIDEBAND_FRAME_REFUSED"} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = "NativeSidebandError";
    this.code = code;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function plainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** @param {Record<string, unknown>} frame @param {readonly string[]} required @param {readonly string[]} [optional] */
function exact(frame, required, optional = []) {
  const allowed = [...required, ...optional];
  return Object.keys(frame).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(frame, key));
}

/** @param {unknown} value */
function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && value.trim() === value;
}

/**
 * The owner's own seam report, carried verbatim.
 *
 * Only its shape and size are checked. An unusable entry is the host's to drop when it reads the table,
 * because this channel forwards what the owner reported and asserts no version of its own.
 * @param {unknown} value
 */
function reportedTable(value) {
  if (!plainRecord(value)) return false;
  const names = Object.keys(value);
  return names.length <= MAX_REPORTED_ENTRIES
    && names.every((name) => name.length > 0 && name.length <= MAX_REPORTED_NAME_LENGTH);
}

/**
 * One flat record of scalar facts.
 *
 * `null`, `undefined`, a nested object and an empty string are all refused, so an unknown fact has to be
 * **omitted** rather than carried as a placeholder a later consumer could read as a real value.
 * @param {unknown} value
 */
function factsRecord(value) {
  if (!plainRecord(value)) return false;
  const names = Object.keys(value);
  if (names.length > MAX_FACT_ENTRIES) return false;
  return names.every((name) => {
    if (!FACT_NAME.test(name)) return false;
    const fact = value[name];
    if (typeof fact === "boolean") return true;
    if (typeof fact === "number") return Number.isSafeInteger(fact);
    return typeof fact === "string" && fact.length > 0 && fact.length <= MAX_FACT_TEXT_LENGTH;
  });
}

/** @param {Record<string, unknown>} frame @returns {FrameVerdict} */
function validateReceiptFrame(frame) {
  if (!exact(frame, ["protocol", "type", "requestId", "request", "outcome"], ["idle", "pendingMessages", "missing"])) {
    return { refusal: "malformed-frame" };
  }
  if (!identifier(frame.requestId)) return { refusal: "malformed-frame" };
  if (typeof frame.request !== "string" || !REQUESTS.includes(frame.request)) return { refusal: "malformed-frame" };
  if (typeof frame.outcome !== "string" || !OUTCOMES.includes(frame.outcome)) return { refusal: "malformed-frame" };
  for (const name of ["idle", "pendingMessages"]) {
    if (Object.hasOwn(frame, name) && typeof frame[name] !== "boolean") return { refusal: "malformed-frame" };
  }
  if (Object.hasOwn(frame, "missing") && (typeof frame.missing !== "string" || !MISSING_METHODS.includes(frame.missing))) {
    return { refusal: "malformed-frame" };
  }
  /** @type {Record<string, unknown>} */
  const ok = { type: "owner-receipt", requestId: frame.requestId, request: frame.request, outcome: frame.outcome };
  for (const name of ["idle", "pendingMessages", "missing"]) {
    if (Object.hasOwn(frame, name)) ok[name] = frame[name];
  }
  return { ok };
}

/** Everything the owner extension may say, validated before it reaches any consumer. @param {unknown} value @returns {FrameVerdict} */
function validateOwnerFrame(value) {
  if (!plainRecord(value)) return { refusal: "malformed-frame" };
  const frame = value;
  if (frame.protocol !== NATIVE_SIDEBAND_PROTOCOL) return { refusal: "unknown-protocol" };
  switch (frame.type) {
    case "owner-ready":
      // The only readiness phase this extension can honestly claim. It registers after the TUI mounted.
      if (!exact(frame, ["protocol", "type", "phase"]) || frame.phase !== "bridge") return { refusal: "malformed-frame" };
      return { ok: { type: "owner-ready", phase: "bridge" } };
    case "owner-seams":
      if (!exact(frame, ["protocol", "type", "reported"]) || !reportedTable(frame.reported)) return { refusal: "malformed-frame" };
      return { ok: { type: "owner-seams", reported: frame.reported } };
    case "owner-facts":
      if (!exact(frame, ["protocol", "type", "facts"]) || !factsRecord(frame.facts)) return { refusal: "malformed-frame" };
      return { ok: { type: "owner-facts", facts: frame.facts } };
    case "owner-receipt":
      return validateReceiptFrame(frame);
    default:
      return { refusal: "unknown-frame" };
  }
}

/** Everything the worker may ask for. @param {unknown} value @returns {FrameVerdict} */
function validateHostFrame(value) {
  if (!plainRecord(value)) return { refusal: "malformed-frame" };
  const frame = value;
  if (frame.protocol !== NATIVE_SIDEBAND_PROTOCOL) return { refusal: "unknown-protocol" };
  if (frame.type !== "owner-request") return { refusal: "unknown-frame" };
  if (!exact(frame, ["protocol", "type", "requestId", "request"])) return { refusal: "malformed-frame" };
  if (!identifier(frame.requestId)) return { refusal: "malformed-frame" };
  if (typeof frame.request !== "string" || !REQUESTS.includes(frame.request)) return { refusal: "malformed-frame" };
  return { ok: { type: "owner-request", requestId: frame.requestId, request: frame.request } };
}

/** @param {unknown} supplied @param {string} expected */
function sameToken(supplied, expected) {
  const digest = (/** @type {string} */ value) => createHash("sha256").update(value, "utf8").digest();
  return typeof supplied === "string" && timingSafeEqual(digest(supplied), digest(expected));
}

/** @param {unknown} value @param {string} token */
function isOwnerHello(value, token) {
  if (!plainRecord(value)) return false;
  const frame = value;
  return exact(frame, ["protocol", "type", "token"])
    && frame.protocol === NATIVE_SIDEBAND_PROTOCOL
    && frame.type === "owner-hello"
    && sameToken(frame.token, token);
}

/**
 * One connected socket, framed, bounded and validated.
 *
 * Both lifecycle waiters are installed here, before the first `await` any caller could reach: the close
 * settlement and, for the authenticating side, the handshake deadline. A connection refused on its very
 * first frame therefore still settles, and one that never authenticates is not held open by hope.
 *
 * @param {net.Socket} socket
 * @param {{ maxFrameBytes: number, maxQueuedFrames: number, validate: (value: unknown) => FrameVerdict,
 *   handshake?: { timeoutMs: number, accept: (value: unknown) => boolean, accepted: () => void } }} options
 */
function createLink(socket, { maxFrameBytes, maxQueuedFrames, validate, handshake }) {
  const encoder = createJsonlEncoder({ maxBytes: maxFrameBytes });
  const decoder = createJsonlDecoder({ maxBytes: maxFrameBytes });
  /** @type {any[]} */
  const queued = [];
  /** @type {Set<(frame: any) => void>} */
  const listeners = new Set();
  /** @type {SidebandRefusal|undefined} */
  let refusal;
  /** @type {NodeJS.Timeout|undefined} */
  let deadline;
  let open = handshake === undefined;
  let finished = false;
  /** @type {(value: SidebandClose) => void} */
  let settle = () => {};
  /** @type {Promise<SidebandClose>} */
  const closed = new Promise((resolve) => {
    settle = resolve;
  });

  /**
   * Make admission, delivery, subscription and the deadline inert.
   *
   * This runs in the same turn as the decision that ended the link, not when the socket's close event
   * arrives a turn later: a frame already admitted must never reach a subscriber after a refusal, and a
   * subscriber must not be retained past one.
   */
  const seal = () => {
    finished = true;
    queued.length = 0;
    listeners.clear();
    clearTimeout(deadline);
  };

  socket.on("error", () => {});
  socket.once("close", () => {
    seal();
    settle({ refusal });
  });

  /** @param {SidebandRefusal|undefined} reason */
  const failClosed = (reason) => {
    if (finished) return;
    refusal = reason;
    seal();
    socket.destroy();
  };

  /** @param {any} frame */
  const dispatch = (frame) => {
    for (const listener of [...listeners]) {
      try {
        listener(frame);
      } catch {
        failClosed("listener-failed");
        return;
      }
    }
  };

  /** @param {any} frame */
  const deliver = (frame) => {
    if (finished) return;
    if (listeners.size > 0) {
      dispatch(frame);
      return;
    }
    // Admission is bounded, and overflow closes the connection rather than dropping a fact silently: a
    // dropped lifecycle fact is indistinguishable from one that was never published.
    if (queued.length >= maxQueuedFrames) {
      failClosed("queue-overflow");
      return;
    }
    queued.push(frame);
  };

  if (handshake !== undefined) {
    deadline = setTimeout(() => failClosed("handshake-timeout"), handshake.timeoutMs);
    deadline.unref();
  }

  socket.on("data", (chunk) => {
    if (finished) return;
    /** @type {unknown[]} */
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      // The byte budget is enforced by the decoder before any UTF-8 decode or parse, so an over-budget
      // frame is refused on its raw length and never becomes a value.
      const code = error instanceof JsonlFramingError ? error.code : undefined;
      failClosed(code === "FRAME_TOO_LARGE" ? "frame-too-large" : "malformed-frame");
      return;
    }
    for (const value of frames) {
      if (finished) return;
      if (!open && handshake !== undefined) {
        if (!handshake.accept(value)) {
          failClosed("unauthenticated");
          return;
        }
        open = true;
        clearTimeout(deadline);
        handshake.accepted();
        continue;
      }
      const verdict = validate(value);
      if (verdict.refusal !== undefined) {
        failClosed(verdict.refusal);
        return;
      }
      deliver(verdict.ok);
    }
  });

  /** @param {unknown} frame */
  const write = (frame) => {
    if (finished || socket.destroyed) {
      return Promise.reject(new NativeSidebandError("SIDEBAND_CLOSED", "The owner sideband connection is closed"));
    }
    /** @type {Buffer} */
    let record;
    try {
      record = encoder.encode(frame);
    } catch (cause) {
      return Promise.reject(new NativeSidebandError("SIDEBAND_FRAME_REFUSED", "The owner sideband refused a frame that exceeds its byte budget", { cause }));
    }
    return new Promise((resolve, reject) => socket.write(record, (error) => (error
      ? reject(new NativeSidebandError("SIDEBAND_CLOSED", "The owner sideband connection is closed"))
      : resolve(undefined))));
  };

  return {
    closed,
    /**
     * Subscribe to validated frames. Everything already admitted is delivered **before this returns**,
     * so a subscriber sees the queue in arrival order and the queue cannot outlive the subscription.
     * A listener that throws fails the connection closed, exactly as an unreadable frame does, and nothing
     * behind the frame it threw on is delivered: the link is sealed in that same turn.
     * @param {(frame: any) => void} listener
     */
    onFrame(listener) {
      if (typeof listener !== "function") throw new NativeSidebandError("SIDEBAND_LISTENER_UNUSABLE", "A sideband frame listener must be a function");
      // A sealed link takes no subscriber: there is nothing left to deliver and nothing more can arrive.
      if (finished) return () => {};
      listeners.add(listener);
      for (const frame of queued.splice(0)) {
        if (finished) break;
        dispatch(frame);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    /** The unauthenticated first frame, which is never validated as a message and never logged. @param {unknown} frame */
    sendHello(frame) {
      return write(frame);
    },
    /** @param {Record<string, unknown>} frame @param {(value: unknown) => FrameVerdict} validateOutbound */
    send(frame, validateOutbound) {
      const verdict = validateOutbound({ protocol: NATIVE_SIDEBAND_PROTOCOL, ...frame });
      if (verdict.refusal !== undefined) {
        return Promise.reject(new NativeSidebandError("SIDEBAND_FRAME_REFUSED", `The owner sideband refused an outbound frame: ${verdict.refusal}`));
      }
      return write({ protocol: NATIVE_SIDEBAND_PROTOCOL, ...verdict.ok });
    },
    close() {
      failClosed(undefined);
    },
  };
}

/** @param {unknown} supplied @param {number} fallback @param {string} name @returns {number} */
function bound(supplied, fallback, name) {
  const value = supplied ?? fallback;
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1) {
    throw new NativeSidebandError("SIDEBAND_BOUND_UNUSABLE", `The owner sideband needs a positive ${name}`);
  }
  return /** @type {number} */ (value);
}

/** @param {{ socketPath?: unknown, token?: unknown, maxFrameBytes?: unknown, maxQueuedFrames?: unknown, handshakeTimeoutMs?: unknown }} options */
function boundedOptions(options) {
  const { socketPath, token } = options;
  if (typeof socketPath !== "string" || socketPath.length === 0 || !isAbsolute(socketPath)) {
    throw new NativeSidebandError("SIDEBAND_PATH_UNUSABLE", "The owner sideband needs one absolute socket path");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new NativeSidebandError("SIDEBAND_TOKEN_UNUSABLE", "The owner sideband needs this run's token");
  }
  return {
    socketPath,
    token,
    maxFrameBytes: bound(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, "maxFrameBytes"),
    maxQueuedFrames: bound(options.maxQueuedFrames, DEFAULT_MAX_QUEUED_FRAMES, "maxQueuedFrames"),
    handshakeTimeoutMs: bound(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, "handshakeTimeoutMs"),
  };
}

/**
 * The socket and token this process was launched with, or `undefined` when it was not managed at all.
 *
 * Both come from the environment. Neither is ever read from or written to an argument vector, because
 * `/proc/<pid>/cmdline` is world readable and a token there is a token every local process holds.
 * @param {Record<string, string|undefined>} [env]
 */
export function readOwnerSidebandEnvironment(env = process.env) {
  const socketPath = env[OWNER_SIDEBAND_SOCKET_ENV];
  const token = env[OWNER_SIDEBAND_TOKEN_ENV];
  if (typeof socketPath !== "string" || socketPath.length === 0) return undefined;
  if (typeof token !== "string" || token.length === 0) return undefined;
  return { socketPath, token };
}

/**
 * Listen for this run's owner extension. The worker's end.
 *
 * The socket is created inside a mode-0700 directory this call guarantees, then narrowed to mode 0600 and
 * revalidated, so no window exists in which another local user could reach it. Each authenticated
 * connection is handed out separately rather than replacing the one before it: one owner generation is
 * one connection, and which of them the worker keeps is the worker's decision, not this listener's.
 *
 * @param {{ socketPath: string, token: string, maxFrameBytes?: number, maxQueuedFrames?: number, handshakeTimeoutMs?: number,
 *   failpoint?: (stage: "after_bind") => Promise<void> }} options
 */
export async function listenForOwnerSideband(options) {
  const { socketPath, token, maxFrameBytes, maxQueuedFrames, handshakeTimeoutMs } = boundedOptions(options);
  // One failpoint, one stage, following the recovery seam in `state-migration.mjs`: the window between a
  // successful bind and a finished endpoint is the only place a caller holds no close handle, so it is the
  // only place a test can script a failure without racing an accept.
  const failpoint = options.failpoint ?? (async () => {});
  if (typeof failpoint !== "function") throw new TypeError("The owner sideband failpoint must be a function");
  await ensurePrivateDirectory(dirname(socketPath));

  /** @type {any[]} */
  const waiting = [];
  /** @type {{ resolve: (connection: any) => void, reject: (error: unknown) => void }[]} */
  const takers = [];
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  let closing = false;
  let discarding = false;

  /** @param {any} connection */
  const handOff = (connection) => {
    const taker = takers.shift();
    if (taker === undefined) waiting.push(connection);
    else taker.resolve(connection);
  };

  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    // A connection accepted in the same turn a discard began is this listener's to end, not to hold:
    // `server.close` waits for every accepted socket, so keeping one would stall its own shutdown.
    if (discarding) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    /** @type {any} */
    let link;
    link = createLink(socket, {
      maxFrameBytes,
      maxQueuedFrames,
      validate: validateOwnerFrame,
      handshake: {
        timeoutMs: handshakeTimeoutMs,
        accept: (value) => isOwnerHello(value, token),
        accepted: () => handOff({
          closed: link.closed,
          onFrame: link.onFrame,
          /** @param {string} requestId */
          requestStop: (requestId) => link.send({ type: "owner-request", requestId, request: "stop" }, validateHostFrame),
          /** @param {string} requestId */
          requestAbort: (requestId) => link.send({ type: "owner-request", requestId, request: "abort" }, validateHostFrame),
          close: link.close,
        }),
      },
    });
  });
  server.on("error", () => {});

  /**
   * End everything this call owns: the sockets it accepted, its listening handle, and — only when this call
   * actually bound it — the endpoint file.
   *
   * Accepted sockets go first because `server.close` waits for all of them, so a connected owner would
   * otherwise hold this shutdown open indefinitely. `ownsEndpoint` is false for a bind that never
   * succeeded: a path another live listener owns is that listener's socket, and removing it would take a
   * running owner's management channel down with this call's failure.
   * @param {boolean} ownsEndpoint
   */
  const discardListener = async (ownsEndpoint) => {
    discarding = true;
    for (const socket of [...sockets]) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    if (ownsEndpoint) await unlink(socketPath).catch(() => {});
  };

  let bound = false;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve(undefined);
      });
    });
    bound = true;
    await failpoint("after_bind");
    await chmodPrivateSocket(socketPath);
  } catch (error) {
    // Until this call returns its close handle, nobody else can end what it started, so it ends it here and
    // reports the original failure rather than whatever the cleanup met.
    await discardListener(bound);
    throw error;
  }

  return {
    socketPath,
    /** The next authenticated owner connection. Rejects once this listener is closed. */
    nextOwner() {
      const queued = waiting.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closing) return Promise.reject(new NativeSidebandError("SIDEBAND_CLOSED", "The owner sideband listener is closed"));
      return new Promise((resolve, reject) => takers.push({ resolve, reject }));
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const taker of takers.splice(0)) {
        taker.reject(new NativeSidebandError("SIDEBAND_CLOSED", "The owner sideband listener is closed"));
      }
      for (const connection of waiting.splice(0)) connection.close();
      await discardListener(true);
    },
  };
}

/** @param {string} socketPath @param {number} timeoutMs */
function openSocket(socketPath, timeoutMs) {
  return /** @type {Promise<net.Socket>} */ (new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    // This channel must never be the reason Pi stays alive.
    socket.unref();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new NativeSidebandError("SIDEBAND_UNREACHABLE", "The owner sideband socket did not connect before its deadline"));
    }, timeoutMs);
    timer.unref();
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "connect failed";
      reject(new NativeSidebandError("SIDEBAND_UNREACHABLE", `The owner sideband socket is unreachable: ${code}`));
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
  }));
}

/**
 * Connect to the worker that launched this process, and authenticate. The owner extension's end.
 *
 * The connect itself is bounded, so a socket that is gone is one reported failure rather than a hang
 * inside a Pi startup handler. The hello is the first frame written and is never logged or echoed.
 *
 * @param {{ socketPath: string, token: string, maxFrameBytes?: number, maxQueuedFrames?: number, handshakeTimeoutMs?: number }} options
 */
export async function connectOwnerSideband(options) {
  const { socketPath, token, maxFrameBytes, maxQueuedFrames, handshakeTimeoutMs } = boundedOptions(options);
  const socket = await openSocket(socketPath, handshakeTimeoutMs);
  const link = createLink(socket, { maxFrameBytes, maxQueuedFrames, validate: validateHostFrame });
  await link.sendHello({ protocol: NATIVE_SIDEBAND_PROTOCOL, type: "owner-hello", token });
  return {
    closed: link.closed,
    onRequest: link.onFrame,
    /** The one readiness phase this extension may claim, and it takes no argument for exactly that reason. */
    announceBridgeReady: () => link.send({ type: "owner-ready", phase: "bridge" }, validateOwnerFrame),
    /** @param {unknown} reported */
    reportSeams: (reported) => link.send({ type: "owner-seams", reported }, validateOwnerFrame),
    /** @param {unknown} facts */
    publishFacts: (facts) => link.send({ type: "owner-facts", facts }, validateOwnerFrame),
    /** @param {OwnerReceipt} receipt */
    sendReceipt: (receipt) => link.send({ type: "owner-receipt", ...receipt }, validateOwnerFrame),
    close: link.close,
  };
}
