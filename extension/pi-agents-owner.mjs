import { connectOwnerSideband, readOwnerSidebandEnvironment } from "../runtime/native-sideband.mjs";

/**
 * The owner-local management extension. One job: give the worker that launched this Pi a structured,
 * authenticated management channel, using nothing but Pi's public extension API.
 *
 * What it does, and the reason for each part:
 *
 * - It registers on `session_start` and **re-captures** the public TUI there every time, through the
 *   component factory `ctx.ui.setWidget` is handed. A captured context is invalid after a session
 *   replacement or a `/reload`, so a handle kept across one addresses a TUI that is gone. No private
 *   field is read, no Pi object is wrapped or patched, and the widget itself draws no line at all: it is
 *   the supported route to the handle, not a place to put an interface.
 * - It opens the sideband **beside** startup rather than in front of it. Pi awaits every `session_start`
 *   handler, the TUI is already mounted and taking input by then, and nothing load-bearing may sit
 *   behind an extension handler that could await indefinitely.
 * - It emits exactly one readiness phase, `bridge`, and can emit no other. The mounted, ready and
 *   painted receipts belong to seam E: this extension registers after the TUI mounted, cannot observe a
 *   frame, and a hello is not a frame. The host takes those from the core bootstrap instead.
 * - It forwards the owner's reported seam table **verbatim** and asserts no version of its own. Nothing
 *   is reported when nothing was reported, because an invented version is indistinguishable from a real
 *   one to every later consumer.
 * - It publishes structured lifecycle and model facts and **omits** every value it cannot read. It never
 *   publishes a credential, a base URL or the handshake token, and it never writes a file: the worker
 *   owns every durable record and every fsync.
 * - A stop request goes to `ctx.shutdown()` and an abort request to `ctx.abort()`, and each returns a
 *   receipt saying what was asked and what the session looked like when it was asked. `ctx.shutdown()` is
 *   request-only and idle-deferred, so no receipt completes a stop; only the worker observing a reaped
 *   exit does.
 * - Every resource is bound to the generation that created it. A connection that lands after its session
 *   was replaced is closed and speaks for nobody, and a late request cannot reach the replacement.
 *
 * `readReportedSeams` has no default reader on purpose. The accepted native cohort publishes no seam
 * version table to an extension — seam G's single supported-version constant is a module export, not a
 * table — so the composition that knows how to read one supplies it. Guessing at a name here would
 * manufacture an owner fact the native API does not expose.
 */

export const OWNER_WIDGET_KEY = "pi-agents-owner";

const MAX_FACT_TEXT_LENGTH = 4096;
/** A widget for a session that has already been replaced: it renders nothing and captures nothing. */
const EMPTY_WIDGET = { render: () => [], invalidate: () => {} };

/** @typedef {{ generation: number, disposed: boolean, tui: unknown, link: any }} OwnerSession */

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FACT_TEXT_LENGTH ? value : undefined;
}

/** One public predicate, or `undefined` when this context does not expose it. @param {any} source @param {string} name */
function observedBoolean(source, name) {
  const probe = source?.[name];
  if (typeof probe !== "function") return undefined;
  try {
    const value = probe.call(source);
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** @param {any} source @param {string} name */
function readThrough(source, name) {
  const method = source?.[name];
  if (typeof method !== "function") return undefined;
  try {
    return method.call(source);
  } catch {
    return undefined;
  }
}

/** @param {Record<string, unknown>} facts */
function omitUnknown(facts) {
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
}

/** The error code alone. A message could carry a path, and a cause could carry a frame. @param {unknown} error */
function failureCode(error) {
  const code = isRecord(error) ? /** @type {any} */ (error).code : undefined;
  return typeof code === "string" ? code : "SIDEBAND_FAILED";
}

/** @param {any} event @param {any} ctx @param {OwnerSession} session */
function collectFacts(event, ctx, session) {
  const sessionManager = ctx.sessionManager;
  const model = isRecord(ctx.model) ? ctx.model : undefined;
  return omitUnknown({
    sessionReason: text(isRecord(event) ? event.reason : undefined),
    mode: text(ctx.mode),
    hasUi: typeof ctx.hasUI === "boolean" ? ctx.hasUI : undefined,
    cwd: text(ctx.cwd),
    sessionFile: text(readThrough(sessionManager, "getSessionFile")),
    sessionId: text(readThrough(sessionManager, "getSessionId")),
    idle: observedBoolean(ctx, "isIdle"),
    pendingMessages: observedBoolean(ctx, "hasPendingMessages"),
    tuiCaptured: session.tui !== undefined,
    modelProvider: text(model?.provider),
    modelId: text(model?.id),
    thinkingLevel: text(ctx.thinkingLevel),
  });
}

/** @param {any} ctx @param {string} requestId */
function stopReceipt(ctx, requestId) {
  if (typeof ctx.shutdown !== "function") {
    return { requestId, request: "stop", outcome: "unsupported", missing: "shutdown" };
  }
  const idle = observedBoolean(ctx, "isIdle");
  const pendingMessages = observedBoolean(ctx, "hasPendingMessages");
  ctx.shutdown();
  // Pi acts on the request now only where it is already idle with nothing queued. Anything else, and an
  // unreadable state included, is a deferral: this receipt never claims the process ended.
  const outcome = idle === true && pendingMessages === false ? "requested" : "deferred";
  return omitUnknown({ requestId, request: "stop", outcome, idle, pendingMessages });
}

/** @param {any} ctx @param {string} requestId */
function abortReceipt(ctx, requestId) {
  if (typeof ctx.abort !== "function") {
    return { requestId, request: "abort", outcome: "unsupported", missing: "abort" };
  }
  const idle = observedBoolean(ctx, "isIdle");
  const pendingMessages = observedBoolean(ctx, "hasPendingMessages");
  ctx.abort();
  // An abort against an idle session cancels nothing, and saying so is worth more than a receipt that
  // reads as though a run was stopped.
  const outcome = idle === true ? "no-run" : "requested";
  return omitUnknown({ requestId, request: "abort", outcome, idle, pendingMessages });
}

/** @param {any} ctx @param {OwnerSession} session @param {(failure: { code: string, generation: number }) => void} onFailure */
function captureTui(ctx, session, onFailure) {
  try {
    ctx.ui.setWidget(OWNER_WIDGET_KEY, (/** @type {unknown} */ tui) => {
      if (session.disposed) return EMPTY_WIDGET;
      session.tui = tui;
      return {
        // Nothing is drawn. A component that overruns the viewport takes Pi's renderer down, and this
        // extension has no interface to offer the operator in the first place.
        render: () => [],
        invalidate: () => {},
        dispose: () => {
          if (session.tui === tui) session.tui = undefined;
        },
      };
    });
  } catch (error) {
    onFailure({ code: failureCode(error), generation: session.generation });
  }
}

/** @param {any} request @param {any} ctx @param {OwnerSession} session @param {any} link @param {(failure: { code: string, generation: number }) => void} onFailure */
async function answerRequest(request, ctx, session, link, onFailure) {
  if (session.disposed || session.link !== link) return;
  const receipt = request.request === "stop"
    ? stopReceipt(ctx, request.requestId)
    : abortReceipt(ctx, request.requestId);
  if (session.disposed || session.link !== link) return;
  try {
    await link.sendReceipt(receipt);
  } catch (error) {
    onFailure({ code: failureCode(error), generation: session.generation });
  }
}

/** @param {OwnerSession} session @param {any} event @param {any} ctx @param {any} settings */
async function openBridge(session, event, ctx, settings) {
  const target = readOwnerSidebandEnvironment(settings.env);
  // An unmanaged Pi has no sideband at all, and that is a complete, silent answer.
  if (target === undefined) return;
  /** @type {any} */
  let link;
  try {
    link = await settings.connect(target);
  } catch (error) {
    settings.onFailure({ code: failureCode(error), generation: session.generation });
    return;
  }
  if (session.disposed) {
    link.close();
    return;
  }
  session.link = link;
  void link.closed.then(() => {
    if (session.link === link) session.link = undefined;
  });
  // Subscribed before anything is announced, so a request that arrives immediately is answered rather
  // than admitted into a queue nobody is draining.
  link.onRequest((/** @type {any} */ request) => {
    void answerRequest(request, ctx, session, link, settings.onFailure);
  });
  try {
    await link.announceBridgeReady();
    const reported = settings.readReportedSeams();
    if (isRecord(reported)) await link.reportSeams(reported);
    await link.publishFacts(collectFacts(event, ctx, session));
  } catch (error) {
    settings.onFailure({ code: failureCode(error), generation: session.generation });
  }
}

/**
 * Register this extension's two handlers on one Pi extension API.
 *
 * @param {{ on: (event: string, handler: (event: any, ctx: any) => unknown) => unknown }} pi
 * @param {{ env?: Record<string, string|undefined>, connect?: (target: { socketPath: string, token: string }) => Promise<any>,
 *   readReportedSeams?: () => unknown, onFailure?: (failure: { code: string, generation: number }) => void }} [options]
 */
export function registerOwnerExtension(pi, options = {}) {
  const settings = {
    env: options.env ?? process.env,
    connect: typeof options.connect === "function" ? options.connect : connectOwnerSideband,
    readReportedSeams: typeof options.readReportedSeams === "function" ? options.readReportedSeams : () => undefined,
    onFailure: typeof options.onFailure === "function" ? options.onFailure : () => {},
  };
  let generation = 0;
  /** @type {OwnerSession|undefined} */
  let current;
  /** @type {Promise<void>} */
  let settled = Promise.resolve();

  /** @param {OwnerSession|undefined} session */
  const dispose = (session) => {
    if (session === undefined || session.disposed) return;
    session.disposed = true;
    session.tui = undefined;
    const link = session.link;
    session.link = undefined;
    link?.close();
  };

  pi.on("session_start", (event, ctx) => {
    dispose(current);
    /** @type {OwnerSession} */
    const session = { generation: generation + 1, disposed: false, tui: undefined, link: undefined };
    generation = session.generation;
    current = session;
    captureTui(ctx, session, settings.onFailure);
    settled = openBridge(session, event, ctx, settings);
  });

  pi.on("session_shutdown", () => {
    dispose(current);
    current = undefined;
  });

  return {
    /** The public TUI this session's widget factory was handed, or `undefined` where it was not. */
    publicTui: () => current?.tui,
    /** Joins the current session's bridge work. Pi's own startup never waits on this. */
    whenBridgeSettled: () => settled,
  };
}

/** @param {{ on: (event: string, handler: (event: any, ctx: any) => unknown) => unknown }} pi */
export default function (pi) {
  registerOwnerExtension(pi);
}
