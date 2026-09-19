import { createHash, timingSafeEqual } from "node:crypto";
import { fork } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import net from "node:net";
import { dirname, isAbsolute } from "node:path";

import { JsonlFramingError, createJsonlDecoder, createJsonlEncoder } from "./jsonl.mjs";
import { SIDEBAND_BINDER_PROTOCOL, isBinderMessage } from "./native-sideband-binder.mjs";
import { ensurePrivateDirectory } from "./permissions.mjs";

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
   * @param {"SIDEBAND_PATH_UNUSABLE"|"SIDEBAND_TOKEN_UNUSABLE"|"SIDEBAND_BOUND_UNUSABLE"|"SIDEBAND_LISTENER_UNUSABLE"|"SIDEBAND_UNREACHABLE"|"SIDEBAND_CLOSED"|"SIDEBAND_FRAME_REFUSED"|"SIDEBAND_BINDER_UNUSABLE"|"SIDEBAND_BINDER_PROTOCOL"|"SIDEBAND_BINDER_REFUSED"|"SIDEBAND_BINDER_TIMEOUT"|"SIDEBAND_BINDER_INCOMPLETE"|"SIDEBAND_BIND_FAILED"|"SIDEBAND_ENDPOINT_UNUSABLE"|"EADDRINUSE"} code
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
 * The owner-frame side of `createLink`, over a socket the caller already has.
 *
 * This exists as a named boundary because the queue's one load-bearing property cannot be observed through
 * either transport: whether a frame was **buffered before a subscriber existed** is only visible by draining
 * it, and draining is the thing under test. Driving the link directly makes delivery ordering the caller's,
 * so a test can admit frames with nothing subscribed and then subscribe, instead of hoping a socket write
 * arrives as one chunk.
 *
 * It adds no wire format, no option and no behaviour: it is `createLink` with this module's own owner-frame
 * validator and no handshake, which is exactly the shape `connectOwnerSideband` builds after its hello. Both
 * transports above keep their own handshakes and remain the only way a real peer is admitted.
 *
 * @param {net.Socket} socket @param {{ maxFrameBytes?: number, maxQueuedFrames?: number }} [limits]
 */
export function createOwnerFrameLink(socket, limits = {}) {
  const { maxFrameBytes, maxQueuedFrames } = boundedOptions({ socketPath: "/owner-frame-link", token: "owner-frame-link", ...limits });
  return createLink(socket, { maxFrameBytes, maxQueuedFrames, validate: validateOwnerFrame });
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

/** How long the whole bind, handoff and helper completion may take. Bounded, and never a poll. */
const BINDER_HANDOFF_TIMEOUT_MS = 10_000;
/** The mode the binder creates its socket at, verified here rather than narrowed by a later chmod. */
const PRIVATE_SOCKET_MODE = 0o600;
const BINDER_ENTRY = new URL("./native-sideband-binder.mjs", import.meta.url);

/**
 * Does the entry at this path have exactly the identity the helper proved it bound?
 *
 * Every field is compared, and device and inode are decimal strings on both sides so nothing turns on a
 * rounded `Number`. This is the check that a same-user, mode-0600 replacement socket cannot pass: it is a
 * different inode, so it is not the entry this attempt created, however valid it looks on its own.
 * @param {{ device: string, inode: string, mode: number, uid: number }} proof @param {any} metadata
 */
function sameEntry(proof, metadata) {
  return metadata.isSocket()
    && !metadata.isSymbolicLink()
    && String(metadata.dev) === proof.device
    && String(metadata.ino) === proof.inode
    && Number(metadata.mode & 0o777n) === proof.mode
    && Number(metadata.uid) === proof.uid;
}

/**
 * Bind one private socket in a short-lived helper and take the listener over from it.
 *
 * The helper is the process that binds, and it is gone before this returns. That is the point: a handle
 * received over IPC carries no pathname, so closing it later unlinks nothing and a replacement another actor
 * put at that path survives this attempt's teardown.
 *
 * Four properties this owes its caller, each of which was wrong before and is now the shape of the code:
 *
 * - **One terminal outcome.** `outcome` moves from `pending` to `adopted` or `refused` exactly once, and a
 *   refusal reached after adoption still wins. A duplicate that arrives after a valid handoff but before the
 *   helper exits therefore fails the attempt rather than being noticed too late to matter.
 * - **Every transferred handle is disposed unless it is adopted.** That includes a handle riding on the first
 *   malformed, unknown-version or refusal message, which previously leaked a listening server.
 * - **The deadline covers the whole process**, not the first message: bind, handoff, and the helper's own
 *   completion. A spawn failure that emits `error` and `close` without ever emitting `exit` is completion, and
 *   so is a helper that goes quiet while holding nothing.
 * - **Ownership is the helper's proof, not this process's guess.** The identity is captured in the helper
 *   between `listen` and the send; this side compares the path against it. Adopting whichever valid-looking
 *   socket happened to be at the path is exactly the window that let a foreign 0600 socket be unlinked.
 *
 * @param {{ socketPath: string, execPath?: string, timeoutMs?: number, binderEntry?: URL|string,
 *   failpoint?: (stage: "before_verification") => Promise<void> }} request
 */
async function bindThroughHelper({ socketPath, execPath = process.execPath, timeoutMs = BINDER_HANDOFF_TIMEOUT_MS, binderEntry = BINDER_ENTRY, failpoint }) {
  /** @type {any} */
  let helper;
  try {
    helper = fork(binderEntry, [String(SIDEBAND_BINDER_PROTOCOL), socketPath], {
      execPath,
      // Nothing of this process's own invocation reaches the helper: no inherited V8 or loader flags, no
      // NODE_OPTIONS, no preloads, and no credential or provider variable. It gets a PATH-less minimum.
      execArgv: [],
      env: { PATH: "/usr/bin:/bin" },
      // Its stdout and stderr are streams for a human, never a protocol; the handle arrives on the IPC channel.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: false,
    });
  } catch (cause) {
    throw new NativeSidebandError("SIDEBAND_BINDER_UNUSABLE", `the socket binder could not be started: ${/** @type {Error} */ (cause).message}`, { cause });
  }

  /** @type {string[]} */
  const diagnostics = [];
  const collect = (/** @type {unknown} */ chunk) => {
    if (diagnostics.length >= 16) return;
    diagnostics.push(String(chunk).slice(0, 512));
  };
  helper.stdout?.on("data", collect);
  helper.stderr?.on("data", collect);
  helper.stdout?.on("error", () => {});
  helper.stderr?.on("error", () => {});

  /** @type {"pending"|"adopted"|"refused"} */
  let outcome = "pending";
  // Read through a call, because every write to `outcome` happens in one of the observers below. A direct read
  // here would be narrowed to its initial value, and the typechecker would call the adopted branch unreachable.
  const outcomeNow = () => outcome;
  /** @type {net.Server|undefined} */
  let inherited;
  /** @type {{ device: string, inode: string, mode: number, uid: number }|undefined} */
  let proof;
  /** @type {{ code: any, message: string }|undefined} */
  let refusal;
  /** @type {{ code: number|null, signal: string|null }|undefined} */
  let exited;
  let completed = false;
  /** @type {() => void} */
  let settleFirst = () => {};
  /** @type {() => void} */
  let settleCompletion = () => {};
  const answered = new Promise((resolve) => {
    settleFirst = () => resolve(undefined);
  });
  const completion = new Promise((resolve) => {
    settleCompletion = () => resolve(undefined);
  });
  /** @type {() => void} */
  let settleDeadline = () => {};
  // Kept apart from `completion`, which means the helper really finished. Conflating them let the wait below
  // give up on time and then let `abandon` believe the helper was already gone.
  const deadline = new Promise((resolve) => {
    settleDeadline = () => resolve(undefined);
  });

  /** A handle this attempt is not adopting is this attempt's to end. @param {unknown} handle */
  const disposeHandle = (handle) => {
    if (handle === undefined || handle === null) return;
    const closable = /** @type {any} */ (handle);
    try {
      if (typeof closable.close === "function") closable.close();
      else if (typeof closable.destroy === "function") closable.destroy();
    } catch {
      // A handle that cannot be closed is recorded by the refusal that accompanies it, not thrown from here.
    }
  };

  /** The one terminal refusal. Reached after adoption it still wins. @param {any} code @param {string} message */
  const refuse = (code, message) => {
    if (refusal === undefined) refusal = { code, message };
    if (outcome !== "refused") outcome = "refused";
    settleFirst();
  };

  const noteCompletion = () => {
    completed = true;
    settleCompletion();
    settleFirst();
  };

  // Installed before the helper can possibly have finished its bind, so nothing below races a late listener.
  helper.once("error", (/** @type {Error} */ error) => {
    refuse("SIDEBAND_BINDER_UNUSABLE", `the socket binder could not be started: ${error.message}`);
    // A spawn failure emits `error` and `close` and may never emit `exit`; `close` below is what completes it.
  });
  // Completion needs two independent facts, and an exit alone is not enough. A child's exit is reported through
  // SIGCHLD, with no ordering against the IPC channel, so settling on it races a handoff that has been written
  // and acknowledged but not yet emitted on this side - and the attempt would report an incomplete helper for a
  // listener it was about to receive. The channel's own `disconnect` is the drain signal: the channel is parsed
  // in order, so every message the helper sent has been emitted before it. Both, then, and not either.
  let channelClosed = helper.connected === false;
  const completeWhenDrained = () => {
    if (exited !== undefined && channelClosed) noteCompletion();
  };
  helper.once("exit", (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
    exited = { code, signal };
    completeWhenDrained();
  });
  helper.once("disconnect", () => {
    channelClosed = true;
    completeWhenDrained();
  });
  // The backstop for a child that never reached `exit` at all, such as a spawn failure, so nothing below waits
  // for an event that cannot arrive.
  helper.once("close", () => {
    channelClosed = true;
    noteCompletion();
  });
  // No refusal is raised for `disconnect`. A channel closing is what every ending child does, and treating it
  // as a failure both pre-empted the accurate diagnosis and could discard a handoff already in flight. What
  // decides is observed completion below, and a child that disconnects without completing meets the deadline.
  helper.on("message", (/** @type {unknown} */ message, /** @type {unknown} */ handle) => {
    // Anything arriving once this attempt has an outcome is late. Its handle is still this attempt's to end,
    // and a late message after a valid handoff fails the attempt rather than being quietly ignored.
    if (outcome !== "pending") {
      disposeHandle(handle);
      refuse("SIDEBAND_BINDER_PROTOCOL", `the socket binder sent another message after its ${outcome === "adopted" ? "handoff" : "refusal"}`);
      return;
    }
    if (!isBinderMessage(message)) {
      disposeHandle(handle);
      refuse("SIDEBAND_BINDER_PROTOCOL", `the socket binder sent a message this parent does not accept: ${String(JSON.stringify(message)).slice(0, 256)}`);
      return;
    }
    const sent = /** @type {any} */ (message);
    if (sent.type === "sideband-bind-failed") {
      disposeHandle(handle);
      refuse(sent.code === "EADDRINUSE" ? "EADDRINUSE" : "SIDEBAND_BIND_FAILED", sent.message ?? "the socket binder could not bind the endpoint");
      return;
    }
    if (sent.type === "sideband-binder-refused") {
      disposeHandle(handle);
      refuse("SIDEBAND_BINDER_REFUSED", `the socket binder refused this request: ${sent.reason}`);
      return;
    }
    if (!(handle instanceof net.Server)) {
      disposeHandle(handle);
      refuse("SIDEBAND_BINDER_PROTOCOL", "the socket binder reported a bound endpoint without handing over its listener");
      return;
    }
    inherited = handle;
    proof = { device: sent.proof.device, inode: sent.proof.inode, mode: sent.proof.mode, uid: sent.proof.uid };
    outcome = "adopted";
    settleFirst();
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    refuse("SIDEBAND_BINDER_TIMEOUT", `the socket binder did not finish binding, handing over and exiting within ${timeoutMs}ms`);
    settleDeadline();
  }, timeoutMs);
  timer.unref();

  /**
   * End what this attempt holds, without unlinking anything.
   *
   * It never bound the pathname, so it has nothing to remove: the inherited handle carries no pathname and the
   * helper's own entry, if it made one, is only removable against a proof this attempt did not complete.
   */
  const abandon = async () => {
    clearTimeout(timer);
    disposeHandle(inherited);
    inherited = undefined;
    if (!completed) {
      // This is the process this call forked and holds a handle to, so there is no PID guess here.
      helper.kill("SIGKILL");
      // The real completion, never the deadline: a caller that has been told this attempt failed must not find
      // the helper still running and still listening on the endpoint it was handed.
      await completion;
    }
  };

  try {
    await answered;
    if (outcomeNow() === "adopted") {
      // The helper must be gone before this listener is usable. An acknowledged send is not that proof, so its
      // real completion is awaited, bounded by the same deadline a stuck helper would otherwise outlast.
      if (helper.connected) helper.disconnect();
      if (!completed) await Promise.race([completion, deadline]);
      if (timedOut) throw new NativeSidebandError("SIDEBAND_BINDER_TIMEOUT", `the socket binder handed over a listener and then did not exit within ${timeoutMs}ms`);
      // Re-checked after completion: a duplicate or late message during the wait is a refusal that must land.
      if (refusal !== undefined) throw new NativeSidebandError(refusal.code, refusal.message);
      if (exited === undefined || exited.code !== 0) {
        throw new NativeSidebandError("SIDEBAND_BINDER_INCOMPLETE", `the socket binder handed over a listener and then ended with code ${exited?.code ?? "none"} signal ${exited?.signal ?? "none"}`);
      }
    }
    clearTimeout(timer);
    if (refusal !== undefined) throw new NativeSidebandError(refusal.code, refusal.message);
    if (inherited === undefined || proof === undefined) {
      const how = exited === undefined ? "without sending anything" : `after ending with code ${exited.code} signal ${exited.signal}`;
      throw new NativeSidebandError("SIDEBAND_BINDER_INCOMPLETE", `the socket binder finished ${how}${diagnostics.length > 0 ? `: ${diagnostics.join(" ").trim()}` : ""}`);
    }
    if (failpoint !== undefined) await failpoint("before_verification");
    // Compared against the helper's proof, not adopted from what is there. A different socket of the same user
    // and the same mode is a different inode, and this is where that is caught.
    const metadata = await lstat(socketPath, { bigint: true });
    if (!sameEntry(proof, metadata)) {
      throw new NativeSidebandError(
        "SIDEBAND_ENDPOINT_UNUSABLE",
        `the endpoint at ${socketPath} is not the one this attempt bound: expected device ${proof.device} inode ${proof.inode} mode ${proof.mode.toString(8)} uid ${proof.uid}, found device ${String(metadata.dev)} inode ${String(metadata.ino)} mode ${Number(metadata.mode & 0o777n).toString(8)} uid ${String(metadata.uid)}`,
      );
    }
    if (proof.uid !== process.getuid?.()) throw new NativeSidebandError("SIDEBAND_ENDPOINT_UNUSABLE", "The owner sideband endpoint has the wrong owner");
    if (proof.mode !== PRIVATE_SOCKET_MODE) {
      // Verified, not narrowed: a `chmod` here would be a write to a pathname that may no longer be ours.
      throw new NativeSidebandError("SIDEBAND_ENDPOINT_UNUSABLE", `The owner sideband endpoint is mode ${proof.mode.toString(8)} and must be created 0600`);
    }
    return { server: inherited, ownership: proof, helperExit: exited };
  } catch (error) {
    // Nothing here has completed an ownership proof, so nothing here removes a directory entry. A refusal that
    // leaves an entry behind says so, rather than guessing that it was this attempt's to delete.
    await abandon();
    if (error instanceof NativeSidebandError) {
      Object.defineProperty(error, "sidebandCleanup", {
        value: "no directory entry was removed: this attempt did not complete an ownership proof, so whatever is at that path is left exactly as it was found and is explicit uncertainty",
        enumerable: false,
      });
    }
    throw error;
  }
}

/**
 * Listen for this run's owner extension. The worker's end.
 *
 * The socket is created inside a mode-0700 directory this call guarantees, then narrowed to mode 0600 and
 * revalidated, so no window exists in which another local user could reach it. Each authenticated
 * connection is handed out separately rather than replacing the one before it: one owner generation is
 * one connection, and which of them the worker keeps is the worker's decision, not this listener's.
 *
 * The endpoint is bound by a short-lived helper and handed here over IPC, which is what makes this call's
 * teardown ownership-safe: a received handle carries no pathname, so closing it unlinks nothing and this call
 * removes the entry only while it still matches the snapshot taken when the socket came into existence. The
 * helper is observed to have exited before this resolves.
 *
 * @param {{ socketPath: string, token: string, maxFrameBytes?: number, maxQueuedFrames?: number, handshakeTimeoutMs?: number,
 *   binderTimeoutMs?: number, execPath?: string, binderEntry?: URL|string,
 *   failpoint?: (stage: "before_verification"|"after_handoff"|"during_close") => Promise<void> }} options
 */
export async function listenForOwnerSideband(options) {
  const { socketPath, token, maxFrameBytes, maxQueuedFrames, handshakeTimeoutMs } = boundedOptions(options);
  // One failpoint, one stage: the window between a verified handoff and a returned close handle is the only
  // place a caller holds nothing it could close, so it is the only place a test can script a failure without
  // racing an accept.
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

  // The handoff comes first: everything below attaches to a listener this process received rather than bound.
  const { server, ownership, helperExit } = await bindThroughHelper({
    socketPath,
    execPath: options.execPath,
    timeoutMs: options.binderTimeoutMs,
    binderEntry: options.binderEntry,
    failpoint,
  });

  const onConnection = (/** @type {net.Socket} */ socket) => {
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
  };
  server.on("connection", onConnection);
  server.on("error", () => {});

  /**
   * End everything this call owns, and nothing that stopped being its own.
   *
   * Accepted sockets go first because `server.close` waits for all of them, so a connected owner would
   * otherwise hold this shutdown open indefinitely. Then the **inherited** listening handle closes, which
   * unlinks nothing: it carries no pathname, because a different process bound it.
   *
   * That is what makes the last step an ownership decision rather than a hope. The entry is re-read after the
   * close and removed only while it still matches the snapshot taken when this attempt's socket came into
   * existence — same device, same inode, still a socket, still this user, still 0600. A regular file, a
   * symbolic link, another user's socket or a live replacement another actor bound is left exactly where it
   * is. An entry that cannot be read, or one that is there but does not match, is retained and reported as
   * uncertainty: this call does not guess, take over or retry.
   *
   * The two outcomes are kept apart on purpose. `removed` is this attempt's own endpoint going away on a
   * normal close. `retained` names what was found instead, so a caller can say why a path is still occupied
   * rather than reporting a clean teardown it did not achieve.
   */
  const discardListener = async () => {
    discarding = true;
    for (const socket of [...sockets]) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    // The window the decision names: the listening handle is released and the ownership decision has not been
    // made yet. A replacement that lands here must still be preserved.
    await failpoint("during_close").catch(() => {});
    /** @type {any} */
    let metadata;
    try {
      metadata = await lstat(socketPath, { bigint: true });
    } catch (error) {
      const code = /** @type {any} */ (error).code;
      // Gone already is the one case that needs no decision; anything else is unreadable, so it is retained.
      if (code === "ENOENT" || code === "ENOTDIR") return { removed: false, retained: null };
      return { removed: false, retained: `the endpoint could not be read (${code ?? "unknown"}), so it was left alone` };
    }
    if (!sameEntry(ownership, metadata)) {
      return {
        removed: false,
        retained: metadata.isSocket()
          ? "a different socket occupies this endpoint's path and was left alone"
          : "a non-socket entry occupies this endpoint's path and was left alone",
      };
    }
    try {
      await unlink(socketPath);
      return { removed: true, retained: null };
    } catch (error) {
      // A cleanup failure is surfaced, never folded into success.
      return { removed: false, retained: `this endpoint could not be removed: ${/** @type {Error} */ (error).message}` };
    }
  };

  try {
    // The one window in which this call holds a usable listener and its caller holds nothing to close it with.
    await failpoint("after_handoff");
  } catch (error) {
    // The original failure is what the caller is told; what the cleanup met is reported separately.
    const outcome = await discardListener();
    if (outcome.retained !== null) {
      Object.defineProperty(error, "sidebandCleanup", { value: outcome.retained, enumerable: false });
    }
    throw error;
  }

  return {
    socketPath,
    /** What this attempt's own endpoint looked like when it came into existence, and the helper that made it. */
    endpoint: { ownership, helperExit },
    /** The next authenticated owner connection. Rejects once this listener is closed. */
    nextOwner() {
      const queued = waiting.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closing) return Promise.reject(new NativeSidebandError("SIDEBAND_CLOSED", "The owner sideband listener is closed"));
      return new Promise((resolve, reject) => takers.push({ resolve, reject }));
    },
    /**
     * Close this listener and report what became of its endpoint.
     *
     * The return value is deliberately not a boolean: `removed` says this attempt's own socket went away, and
     * `retained` names whatever was found instead. A caller that needs to know the path is clear has to read
     * it rather than assume a close achieved that.
     */
    async close() {
      if (closing) return { removed: false, retained: "this listener was already closing" };
      closing = true;
      for (const taker of takers.splice(0)) {
        taker.reject(new NativeSidebandError("SIDEBAND_CLOSED", "The owner sideband listener is closed"));
      }
      for (const connection of waiting.splice(0)) connection.close();
      return await discardListener();
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
