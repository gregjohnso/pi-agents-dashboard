import { connectOwnerSideband, isNativeSessionColor, isNativeSessionName, readOwnerSidebandEnvironment } from "../runtime/native-sideband.mjs";
import { generateNativeLabel } from "../runtime/native-labels.mjs";
import { summarizePromptInput } from "../runtime/summaries.mjs";

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

/** @typedef {{ generation: number, disposed: boolean, tui: unknown, link: any, pi?: any, agentPhase?: string, renameError?: string, labelFacts?: any, labelController?: AbortController, labelWork?: Promise<void>, labelPrompts?: string[], labelMessages?: any[], pendingRequests?: number, completedRequests?: number, labelAttempts?: number, labelRunning?: boolean, automaticName?: string, automaticNameEvents?: string[], nameChanged?: boolean, sessionColor?: string }} OwnerSession */

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
function collectFacts(event, ctx, session, agentPhase) {
  const sessionManager = ctx.sessionManager;
  const model = isRecord(ctx.model) ? ctx.model : undefined;
  const pi = session.pi;
  return omitUnknown({
    // Advertised so the manager can refuse a rename LOCALLY against an owner that cannot do it, instead of
    // writing a frame an older owner refuses as malformed - which would destroy its bridge. Present only when
    // Pi actually offers the public mutator, so this is a capability rather than an intention.
    renameSupported: typeof pi?.setSessionName === "function" ? true : undefined,
    // The name Pi CONFIRMED, read back through its own public getter. A merely requested name never appears
    // here, so a row cannot show a rename that did not take effect.
    sessionName: text(readThrough(pi, "getSessionName")),
    renameError: text(session.renameError),
    // The user's session-color extension announces its colour on Pi's event bus; present only once it has.
    sessionColor: text(session.sessionColor),
    colorSupported: session.sessionColor !== undefined ? true : undefined,
    ...session.labelFacts,
    // Which of Pi's own agent-loop events was last seen: "start", "end" or "settled". It is the event's own
    // name and nothing inferred - Pi's `agent_end` carries no error, so no failure is ever read from it.
    agentPhase: text(agentPhase),
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

/**
 * Rename this session through Pi's own public `setSessionName`, and report only what Pi confirms.
 *
 * Nothing here writes a session file, injects a keystroke or keeps a display alias: Pi owns the metadata, so Pi
 * is the only writer. A mutator this Pi does not offer is answered `unsupported`; one that throws leaves the
 * previous name in place and records why.
 *
 * @param {any} request @param {OwnerSession} session
 */
function renameReceipt(request, session) {
  const base = { requestId: request.requestId, request: "rename" };
  const setSessionName = session.pi?.setSessionName;
  if (typeof setSessionName !== "function") {
    session.renameError = "this Pi does not offer setSessionName, so the session was not renamed";
    return { ...base, outcome: "unsupported" };
  }
  try {
    session.nameChanged = true;
    session.pi.setSessionName(request.name);
    session.renameError = undefined;
    return { ...base, outcome: "requested" };
  } catch (error) {
    // The old name stands. `no-run` is the existing outcome for a request that did not run.
    session.renameError = `setSessionName failed, so the previous name is unchanged: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400);
    return { ...base, outcome: "no-run" };
  }
}

/**
 * Change the colour through session-color, which owns `/color`, and report whether it took. session-color answers
 * synchronously on the bus, so a colour it did not echo back was not applied. @param {any} request @param {OwnerSession} session
 */
function colorReceipt(request, session) {
  const base = { requestId: request.requestId, request: "color" };
  const events = session.pi?.events;
  if (typeof events?.emit !== "function" || session.sessionColor === undefined) return { ...base, outcome: "unsupported" };
  events.emit("session-color:set", { color: request.color });
  return { ...base, outcome: session.sessionColor === request.color ? "requested" : "no-run" };
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
  if (request.request === "stop") session.labelController?.abort();
  const receipt = request.request === "rename"
    ? renameReceipt(request, session)
    : request.request === "color"
    ? colorReceipt(request, session)
    : request.request === "stop"
      ? stopReceipt(ctx, request.requestId)
      : abortReceipt(ctx, request.requestId);
  if (session.disposed || session.link !== link) return;
  // The confirmed name is published BEFORE the receipt, so nothing can read "requested" and still find the old
  // name on the row. A receipt is an answer, not evidence the rename applied; the published fact is evidence.
  if (request.request === "rename" || request.request === "color") {
    try {
      await link.publishFacts(collectFacts(undefined, ctx, session, session.agentPhase));
    } catch (error) {
      onFailure({ code: failureCode(error), generation: session.generation });
    }
    if (session.disposed || session.link !== link) return;
  }
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
 *   readReportedSeams?: () => unknown, onFailure?: (failure: { code: string, generation: number }) => void, labelTimeoutMs?: number }} [options]
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
  /** The colour session-color last announced, which can arrive before this extension's own session_start. */
  let announcedColor;
  /** The context of the current session, for publishes that no Pi event hands one to. */
  let currentCtx;

  /** @param {OwnerSession|undefined} session */
  const dispose = (session) => {
    if (session === undefined || session.disposed) return;
    session.disposed = true;
    session.labelController?.abort();
    session.tui = undefined;
    const link = session.link;
    session.link = undefined;
    link?.close();
  };

  pi.on("session_start", (event, ctx) => {
    dispose(current);
    /** @type {OwnerSession} */
    const session = { generation: generation + 1, disposed: false, tui: undefined, link: undefined, pi };
    generation = session.generation;
    session.sessionColor = announcedColor;
    current = session;
    currentCtx = ctx;
    captureTui(ctx, session, settings.onFailure);
    settled = openBridge(session, event, ctx, settings);
  });

  /**
   * Republish this session's facts, so a row can follow the run instead of freezing at startup.
   *
   * This reuses the bridge's existing `publishFacts` and Pi's own lifecycle events. It adds no channel and no
   * schedule: a publish happens only when Pi says something changed, which is what keeps the manager's status
   * a push and stops a read from causing the next read.
   *
   * @param {string} agentPhase @param {any} event @param {any} ctx
   */
  const republish = (agentPhase, event, ctx) => {
    const session = current;
    if (session === undefined || session.disposed) return;
    // A model change is not an agent-loop transition, so it refreshes the observed model while leaving the
    // phase exactly as Pi last reported it. Overwriting it would lose the fact that a run is still going.
    if (agentPhase !== undefined) session.agentPhase = agentPhase;
    // Chained onto the bridge's own work rather than gated on it. A fast run can start and settle before the
    // bridge has finished connecting, and dropping those phases lost the whole state of a short task; the link
    // is read when the publish actually runs, so the phase survives the wait.
    settled = settled
      .then(() => session.disposed ? undefined : session.link?.publishFacts(collectFacts(event, ctx, session, session.agentPhase)))
      .catch((error) => settings.onFailure({ code: failureCode(error), generation: session.generation }));
  };

  // Two attempts per generation: after two completed requests, then a refresh or retry on the next request.
  /** @param {OwnerSession} session @param {any} ctx @param {string} transcript */
  const label = (session, ctx, transcript) => {
    const controller = session.labelController;
    if (controller === undefined) return;
    session.labelWork = (session.labelWork ?? Promise.resolve()).then(async () => {
      if (session.disposed || controller.signal.aborted) return;
      session.labelFacts = { ...session.labelFacts, labelVersion: 1, labelStatus: "pending", labelFailureReason: undefined, labelStopReason: undefined };
      republish(undefined, undefined, ctx);
      const result = await generateNativeLabel(ctx.modelRegistry, transcript, {
        signal: controller.signal, timeoutMs: options.labelTimeoutMs, fakeMode: settings.env.PI_DEMO_FAKE_PROVIDER === "1",
      });
      if (session.disposed || controller.signal.aborted) return;
      session.labelFacts = {
        ...session.labelFacts, labelVersion: 1, labelStatus: result.status,
        labelFailureReason: result.failureReason, labelStopReason: result.stopReason,
        labelModelProvider: result.modelProvider, labelModelId: result.modelId,
        ...(result.description === undefined ? {} : { labelDescription: result.description }),
      };
      const publicPi = session.pi;
      if (result.name !== undefined && !session.nameChanged && typeof publicPi?.getSessionName === "function" && typeof publicPi?.setSessionName === "function") {
        try {
          const currentName = publicPi.getSessionName();
          if (!currentName || currentName === session.automaticName) {
            session.automaticNameEvents = [...(session.automaticNameEvents ?? []), result.name];
            publicPi.setSessionName(result.name);
            session.automaticName = publicPi.getSessionName();
          }
        } catch {
          session.labelFacts.labelStatus = "error";
          session.labelFacts.labelFailureReason = "rename-failed";
        }
      }
      republish(undefined, undefined, ctx);
    }).catch(() => {
      if (session.disposed || controller.signal.aborted) return;
      session.labelFacts = { ...session.labelFacts, labelVersion: 1, labelStatus: "error", labelFailureReason: "request-failed" };
      republish(undefined, undefined, ctx);
    }).finally(() => { session.labelRunning = false; });
  };

  pi.on("before_agent_start", (event, ctx) => {
    const session = current;
    if (session === undefined || session.disposed || (session.labelAttempts ?? 0) >= 2 || readOwnerSidebandEnvironment(settings.env) === undefined || event.messageType === "custom" || typeof event.prompt !== "string" || !event.prompt.trim()) return;
    session.labelController ??= new AbortController();
    session.pendingRequests = (session.pendingRequests ?? 0) + 1;
    session.labelPrompts = [...(session.labelPrompts ?? []), event.prompt.slice(0, 1800)].slice(-3);
  });

  // Pi's own agent-loop boundaries. `agent_settled` is the only one that means no retry, compaction or queued
  // continuation will run, so it is kept distinct from `agent_end`.
  pi.on("agent_start", (event, ctx) => republish("start", event, ctx));
  pi.on("agent_end", (event, ctx) => {
    if (current?.labelController && (current.labelAttempts ?? 0) < 2) {
      current.labelMessages = (event.messages ?? []).slice(-40).filter((message) => message.role === "assistant" || message.role === "user").map((message) => ({
        kind: message.role === "user" ? "user_message" : "assistant_message",
        content: (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? []).slice(-4).filter((part) => part.type === "text").map((part) => ({ type: "text", text: part.text.slice(0, 6000) })),
      }));
    }
    republish("end", event, ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    republish("settled", event, ctx);
    const session = current;
    if (session === undefined || session.disposed || !session.pendingRequests) return;
    session.completedRequests = (session.completedRequests ?? 0) + session.pendingRequests;
    session.pendingRequests = 0;
    if (session.completedRequests < 2 || session.labelRunning || (session.labelAttempts ?? 0) >= 2) return;
    session.labelAttempts = (session.labelAttempts ?? 0) + 1;
    session.labelRunning = true;
    const prompts = (session.labelPrompts ?? []).map((prompt) => `User: ${prompt}`).join("\n");
    const excerpt = summarizePromptInput(session.labelMessages ?? []).slice(-500);
    label(session, ctx, `${prompts}\n${excerpt}`);
    session.labelMessages = undefined;
  });
  // Pi owns `/model`. Observing its selection back is how a row shows the model Pi confirmed rather than the
  // one a launch asked for.
  pi.on("model_select", (event, ctx) => republish(undefined, event, ctx));
  // Pi's own name-change event, so a name Pi applied for any reason - a rename asked for here, or Pi's own
  // naming - reaches the row without this extension polling for it.
  pi.on("session_info_changed", (event, ctx) => {
    if (current !== undefined) {
      // Earlier extensions can defer delivery of our own name-change event until after the setter returns.
      if (current.automaticNameEvents?.length && current.automaticNameEvents[0] === event.name) current.automaticNameEvents.shift();
      else current.nameChanged = true;
    }
    republish(undefined, event, ctx);
  });

  // session-color owns /color; it announces every change, including one asked for from the list.
  pi.events?.on?.("session-color:changed", (/** @type {any} */ data) => {
    if (!isNativeSessionColor(data?.color)) return;
    announcedColor = data.color;
    if (current === undefined || current.disposed) return;
    current.sessionColor = data.color;
    republish(undefined, undefined, currentCtx);
  });

  // The list's /rename, inside the session too: Pi's own setter, the same one Pi's /name uses.
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("rename", {
      description: "Rename this session",
      handler: async (/** @type {string} */ args, /** @type {any} */ ctx) => {
        const name = (args ?? "").trim();
        if (!isNativeSessionName(name) || typeof pi.setSessionName !== "function") {
          ctx?.ui?.notify?.("Usage: /rename <name>", "warning");
          return;
        }
        if (current !== undefined) current.nameChanged = true;
        pi.setSessionName(name);
        ctx?.ui?.notify?.(`Session renamed to ${name}`, "info");
      },
    });
  }

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
