import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  OWNER_SIDEBAND_SOCKET_ENV,
  OWNER_SIDEBAND_TOKEN_ENV,
  connectOwnerSideband,
  listenForOwnerSideband,
} from "../runtime/native-sideband.mjs";
import ownerExtension, { OWNER_WIDGET_KEY, registerOwnerExtension } from "./pi-agents-owner.mjs";

const TOKEN = "owner-extension-token-for-this-run-only";
const SOURCE = new URL("./pi-agents-owner.mjs", import.meta.url);

/**
 * Every member of Pi's public extension surface this extension is allowed to read.
 *
 * The suite records the reads one run actually performs and compares them with these lists, so a private
 * field or an undocumented method appears as an extra name rather than as prose in a review.
 */
const PUBLIC_CONTEXT_READS = [
  "abort", "cwd", "hasPendingMessages", "hasUI", "isIdle", "mode", "model", "sessionManager", "shutdown",
  "thinkingLevel", "ui",
];
const PUBLIC_UI_READS = ["setWidget"];
const PUBLIC_SESSION_MANAGER_READS = ["getSessionFile", "getSessionId"];

/** @type {(() => unknown)[]} */
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/**
 * One real disposable host listener, and the options that point this extension at it.
 *
 * The socket root is not `mkdtemp(tmpdir())` because an `AF_UNIX` path is capped at 108 bytes and this
 * suite's `TMPDIR` on a Slurm worker is a deep per-case batch directory.
 */
async function hostListener() {
  const base = join(tmpdir(), "x").length + 24 <= 100 || !existsSync("/tmp") ? tmpdir() : "/tmp";
  const root = await mkdtemp(join(base, "pia-oe-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "private", "o");
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => listener.close());
  const failures = [];
  let report = () => {};
  const reported = new Promise((resolve) => { report = resolve; });
  return {
    listener,
    failures,
    options: {
      env: { [OWNER_SIDEBAND_SOCKET_ENV]: socketPath, [OWNER_SIDEBAND_TOKEN_ENV]: TOKEN },
      onFailure: (failure) => {
        failures.push(failure);
        report(failure);
      },
    },
    // A frame that never arrives is almost always a failure the extension reported instead, so the wait
    // loses to that report rather than sitting out the whole per-test budget saying nothing.
    frames: (connection, count) => Promise.race([
      nextFrames(connection.onFrame, count),
      reported.then((failure) => {
        throw new Error(`the extension reported ${failure.code} instead of sending ${count} frames`);
      }),
    ]),
  };
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

function createFakePi() {
  const handlers = new Map();
  return {
    pi: {
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    events: () => [...handlers.keys()].sort(),
    async emit(event, payload, ctx) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

/**
 * One fake extension context that records every property read through it.
 *
 * `setWidget` invokes a component factory synchronously with the live TUI and the theme, which is what Pi's
 * interactive mode does, and ignores the factory the way Pi's RPC mode does.
 */
function createFakeCtx({ drop = [], tuiId = "tui-1", tuiMode = true, ...fields } = {}) {
  const reads = [];
  const uiReads = [];
  const sessionManagerReads = [];
  const calls = [];
  const tui = { id: tuiId, terminal: {} };
  const theme = { fg: (_name, text) => text };
  const widget = { key: undefined, component: undefined };
  const recorder = (target, into) => new Proxy(target, {
    get(source, name) {
      if (typeof name === "string") into.push(name);
      return source[name];
    },
  });
  const sessionManager = {
    getSessionFile: () => "/sessions/owner.jsonl",
    getSessionId: () => "session-1",
    ...fields.sessionManager,
  };
  const target = {
    mode: "tui",
    hasUI: true,
    cwd: "/owner/work",
    model: { provider: "fake-provider", id: "fake-model", name: "Fake", baseUrl: "http://127.0.0.1:0/unused", contextWindow: 1000 },
    thinkingLevel: "off",
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() { calls.push("abort"); },
    shutdown() { calls.push("shutdown"); },
    ...fields,
    sessionManager: recorder(sessionManager, sessionManagerReads),
    ui: recorder({
      setWidget(key, content) {
        calls.push(`setWidget:${key}`);
        widget.component?.dispose?.();
        widget.key = key;
        widget.component = typeof content === "function" && tuiMode ? content(tui, theme) : undefined;
      },
    }, uiReads),
  };
  for (const name of drop) delete target[name];
  return { ctx: recorder(target, reads), tui, calls, widget, reads, uiReads, sessionManagerReads };
}

/**
 * The gate is "nothing undeclared", not a fixed count: every name here has to be one Pi publishes and one this
 * extension has a stated reason to follow. The list grew as the row learned to follow a run - the agent-loop
 * boundaries and `model_select` for live status, `session_info_changed` for a name Pi confirmed - and an entry
 * appearing here without a reason is the failure this case is for.
 */
it("registers only for the Pi events it has a reason to follow", () => {
  const fake = createFakePi();
  registerOwnerExtension(fake.pi, { env: {} });
  expect(fake.events()).toEqual([
    // Live status: Pi's own agent-loop boundaries, kept distinct because `agent_end` is not `agent_settled`.
    "agent_end", "agent_settled", "agent_start", "before_agent_start",
    // Every user message, including one sent mid-turn, for the automatic title.
    "message_end",
    // The model Pi confirmed, rather than the one a launch asked for.
    "model_select",
    // The session name Pi confirmed, including a rename this manager asked for.
    "session_info_changed",
    // The session's own lifetime.
    "session_shutdown", "session_start",
  ]);
  expect(typeof ownerExtension).toBe("function");
});

// Operator-visible failure: a host that reads this extension's hello as a mounted, ready or painted receipt
// marks a session usable before any frame reached a terminal. This extension registers after the TUI mounted
// and can never observe a frame, so the bridge is the only phase it is entitled to claim.
it("emits exactly one bridge phase per session and never another readiness phase", async () => {
  const host = await hostListener();
  const fake = createFakePi();
  const registration = registerOwnerExtension(fake.pi, host.options);
  const first = host.listener.nextOwner();

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, createFakeCtx().ctx);
  await registration.whenBridgeSettled();
  const opening = await host.frames(await first, 2);

  const second = host.listener.nextOwner();
  await fake.emit("session_start", { type: "session_start", reason: "reload" }, createFakeCtx({ tuiId: "tui-2" }).ctx);
  await registration.whenBridgeSettled();
  const reloaded = await host.frames(await second, 2);

  expect(opening.filter((frame) => frame.type === "owner-ready")).toEqual([{ type: "owner-ready", phase: "bridge" }]);
  expect(reloaded.filter((frame) => frame.type === "owner-ready")).toEqual([{ type: "owner-ready", phase: "bridge" }]);
  const source = await readFile(SOURCE, "utf8");
  for (const phase of ["native-mounted", "first-paint", "readinessSnapshot"]) {
    expect(source).not.toContain(phase);
  }
});

// Operator-visible failure: a seam table this extension edits, filters or invents makes the host act on a
// capability the owner never reported.
it("forwards the owner's reported seam table verbatim", async () => {
  const host = await hostListener();
  const fake = createFakePi();
  const reported = { A: 1, B: 2, G: 1, H: "a name this host does not know" };
  const registration = registerOwnerExtension(fake.pi, { ...host.options, readReportedSeams: () => reported });
  const arriving = host.listener.nextOwner();

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, createFakeCtx().ctx);
  await registration.whenBridgeSettled();
  const frames = await host.frames(await arriving, 3);

  expect(frames[1]).toEqual({ type: "owner-seams", reported });
});

it.each([
  ["no reader at all", undefined],
  ["a reader that reports nothing", () => undefined],
  ["a reader that answers with something that is not a table", () => 3],
])("sends no seam frame when the owner reports %s", async (_label, readReportedSeams) => {
  const host = await hostListener();
  const fake = createFakePi();
  const registration = registerOwnerExtension(fake.pi, { ...host.options, readReportedSeams });
  const arriving = host.listener.nextOwner();

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, createFakeCtx().ctx);
  await registration.whenBridgeSettled();
  const frames = await host.frames(await arriving, 2);

  expect(frames.map((frame) => frame.type)).toEqual(["owner-ready", "owner-facts"]);
});

// Operator-visible failure: a captured ctx is invalid after a session replacement, so a TUI handle kept from
// the previous session addresses a TUI that is gone.
it("re-captures the public TUI through the widget factory on every session start and keeps no stale handle", async () => {
  const fake = createFakePi();
  const registration = registerOwnerExtension(fake.pi, { env: {} });
  const opening = createFakeCtx({ tuiId: "tui-1" });
  const reloaded = createFakeCtx({ tuiId: "tui-2" });

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, opening.ctx);
  expect(registration.publicTui()).toBe(opening.tui);
  expect(opening.widget.key).toBe(OWNER_WIDGET_KEY);
  expect(opening.widget.component.render(80)).toEqual([]);

  await fake.emit("session_start", { type: "session_start", reason: "reload" }, reloaded.ctx);
  expect(registration.publicTui()).toBe(reloaded.tui);

  await fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, reloaded.ctx);
  expect(registration.publicTui()).toBeUndefined();
});

it("captures nothing where the widget factory is not honoured, rather than reporting a handle it never got", async () => {
  const fake = createFakePi();
  const registration = registerOwnerExtension(fake.pi, { env: {} });
  const rpc = createFakeCtx({ mode: "rpc", tuiMode: false });

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, rpc.ctx);

  expect(registration.publicTui()).toBeUndefined();
});

// Operator-visible failure: `ctx.shutdown()` is request-only and idle-deferred, so a receipt read as a
// completed stop retires a row whose Pi is still running and still holding the operator's work.
it.each([
  ["a streaming session", { isIdle: () => false, hasPendingMessages: () => false }, { outcome: "deferred", idle: false, pendingMessages: false }],
  ["a session holding queued text", { isIdle: () => true, hasPendingMessages: () => true }, { outcome: "deferred", idle: true, pendingMessages: true }],
  ["an idle session", { isIdle: () => true, hasPendingMessages: () => false }, { outcome: "requested", idle: true, pendingMessages: false }],
])("answers a stop request from %s with a receipt that claims no completion", async (_label, state, expected) => {
  const host = await hostListener();
  const fake = createFakePi();
  const registration = registerOwnerExtension(fake.pi, host.options);
  const arriving = host.listener.nextOwner();
  const session = createFakeCtx(state);

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, session.ctx);
  await registration.whenBridgeSettled();
  const owner = await arriving;
  const receipt = host.frames(owner, 3);
  await owner.requestStop("stop-1");

  expect((await receipt)[2]).toEqual({ type: "owner-receipt", requestId: "stop-1", request: "stop", ...expected });
  expect(session.calls.filter((call) => call === "shutdown")).toEqual(["shutdown"]);
});

it.each([
  ["a streaming session", { isIdle: () => false }, "requested"],
  ["an idle session with no run to abort", { isIdle: () => true }, "no-run"],
])("answers an abort request from %s through the public abort", async (_label, state, outcome) => {
  const host = await hostListener();
  const fake = createFakePi();
  const registration = registerOwnerExtension(fake.pi, host.options);
  const arriving = host.listener.nextOwner();
  const session = createFakeCtx(state);

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, session.ctx);
  await registration.whenBridgeSettled();
  const owner = await arriving;
  const receipt = host.frames(owner, 3);
  await owner.requestAbort("abort-1");

  expect((await receipt)[2]).toMatchObject({ requestId: "abort-1", request: "abort", outcome });
  expect(session.calls.filter((call) => call === "abort")).toEqual(["abort"]);
});

// Operator-visible failure: substituting a guessed method for a missing one makes a stop look delivered when
// nothing was asked of Pi at all.
it("names the missing public method instead of guessing one when the context has no shutdown", async () => {
  const host = await hostListener();
  const fake = createFakePi();
  const registration = registerOwnerExtension(fake.pi, host.options);
  const arriving = host.listener.nextOwner();
  const session = createFakeCtx({ drop: ["shutdown"] });

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, session.ctx);
  await registration.whenBridgeSettled();
  const owner = await arriving;
  const receipt = host.frames(owner, 3);
  await owner.requestStop("stop-1");

  expect((await receipt)[2]).toEqual({
    type: "owner-receipt", requestId: "stop-1", request: "stop", outcome: "unsupported", missing: "shutdown",
  });
  expect(session.calls).not.toContain("shutdown");
});

// Operator-visible failure: a guessed provider or state field reads exactly like a real one to every later
// consumer, and a row built from it reports a session that does not exist.
it("publishes only the lifecycle and model facts it can read, omitting every unknown one", async () => {
  const host = await hostListener();
  const fake = createFakePi();
  const registration = registerOwnerExtension(fake.pi, host.options);
  const complete = host.listener.nextOwner();

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, createFakeCtx().ctx);
  await registration.whenBridgeSettled();
  const known = (await host.frames(await complete, 2))[1];

  expect(known).toEqual({
    type: "owner-facts",
    facts: {
      sessionReason: "startup", mode: "tui", hasUi: true, cwd: "/owner/work",
      sessionFile: "/sessions/owner.jsonl", sessionId: "session-1",
      idle: true, pendingMessages: false, tuiCaptured: true,
      modelProvider: "fake-provider", modelId: "fake-model", thinkingLevel: "off",
    },
  });

  const sparse = host.listener.nextOwner();
  await fake.emit("session_start", { type: "session_start", reason: "resume" }, createFakeCtx({
    drop: ["model", "thinkingLevel", "isIdle"],
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "session-2" },
  }).ctx);
  await registration.whenBridgeSettled();
  const unknown = (await host.frames(await sparse, 2))[1];

  expect(unknown).toEqual({
    type: "owner-facts",
    facts: {
      sessionReason: "resume", mode: "tui", hasUi: true, cwd: "/owner/work",
      sessionId: "session-2", pendingMessages: false, tuiCaptured: true,
    },
  });
});

// Operator-visible failure: a credential the owner's model registry holds, published as a fact, reaches the
// host's durable state and every diagnostic that quotes it.
it("never publishes a credential, a base URL or the handshake token", async () => {
  const host = await hostListener();
  const fake = createFakePi();
  const registration = registerOwnerExtension(fake.pi, host.options);
  const arriving = host.listener.nextOwner();
  const session = createFakeCtx();

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, session.ctx);
  await registration.whenBridgeSettled();
  const frames = await host.frames(await arriving, 2);

  const published = JSON.stringify({ frames, failures: host.failures, widget: session.widget.key });
  expect(published).not.toContain(TOKEN);
  expect(published).not.toContain("127.0.0.1");
  expect(published).not.toContain("baseUrl");
  expect(session.widget.component.render(120)).toEqual([]);
});

// Operator-visible failure: reading a private Pi field couples this extension to Pi's internals, and the next
// Pi release breaks the management channel with no warning at all.
it("reads only documented public extension surface, and patches nothing", async () => {
  const host = await hostListener();
  const fake = createFakePi();
  const registration = registerOwnerExtension(fake.pi, host.options);
  const arriving = host.listener.nextOwner();
  const session = createFakeCtx();

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, session.ctx);
  await registration.whenBridgeSettled();
  const owner = await arriving;
  const receipt = host.frames(owner, 3);
  await owner.requestStop("stop-1");
  await receipt;
  await fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, session.ctx);

  expect([...new Set(session.reads)].filter((name) => !PUBLIC_CONTEXT_READS.includes(name))).toEqual([]);
  expect([...new Set(session.uiReads)].filter((name) => !PUBLIC_UI_READS.includes(name))).toEqual([]);
  expect([...new Set(session.sessionManagerReads)].filter((name) => !PUBLIC_SESSION_MANAGER_READS.includes(name))).toEqual([]);

  const source = await readFile(SOURCE, "utf8");
  for (const forbidden of ["Symbol.for(", "getPrototypeOf", "defineProperty", ".prototype", "process.argv", "node:fs"]) {
    expect(source).not.toContain(forbidden);
  }
  expect(source).not.toMatch(/@earendil-works\/pi-(?:tui|coding-agent)\//u);
});

// Operator-visible failure: a connection that lands after its session was replaced speaks for a session that
// no longer exists, and a receipt it sends is attributed to the replacement.
it("closes a connection whose session was replaced before it opened, and emits nothing on it", async () => {
  const host = await hostListener();
  const fake = createFakePi();
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const registration = registerOwnerExtension(fake.pi, {
    ...host.options,
    connect: async (target) => {
      await held;
      return connectOwnerSideband(target);
    },
  });
  const arriving = host.listener.nextOwner();

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, createFakeCtx().ctx);
  await fake.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, createFakeCtx().ctx);
  release();
  await registration.whenBridgeSettled();

  const owner = await arriving;
  await expect(owner.closed).resolves.toEqual({ refusal: undefined });
  expect(host.failures).toEqual([]);
  expect(registration.publicTui()).toBeUndefined();
});

it("does nothing but capture the TUI when no sideband is configured for this process", async () => {
  const fake = createFakePi();
  let attempts = 0;
  const registration = registerOwnerExtension(fake.pi, {
    env: {},
    connect: async () => {
      attempts += 1;
      throw new Error("must not connect");
    },
  });
  const session = createFakeCtx();

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, session.ctx);
  await registration.whenBridgeSettled();

  expect(attempts).toBe(0);
  expect(registration.publicTui()).toBe(session.tui);
});

// Operator-visible failure: a fake context proves what this extension does with a shape, not that the
// shape is Pi's. This reads the installed declaration, so a member Pi removes is named here rather than
// discovered when a real stop silently does nothing. It is a compatibility check, not proof of a stop:
// only a real Pi, reaped by the worker, can establish that.
it("calls only members the installed Pi still declares on its public extension context", async () => {
  const types = new URL("./core/extensions/types.d.ts", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const declaration = await readFile(types, "utf8");

  const missing = [
    "isIdle(): boolean",
    "abort(): void",
    "hasPendingMessages(): boolean",
    "shutdown(): void",
    "sessionManager: ReadonlySessionManager",
    "mode: ExtensionMode",
    "hasUI: boolean",
    "cwd: string",
    "model: Model<any> | undefined",
    "thinkingLevel?: ThinkingLevel",
    // The widget factory overload is the supported route to the public TUI this extension captures.
    "setWidget(key: string, content: ((tui: TUI, theme: Theme) => Component & {",
    'reason: "startup" | "reload" | "new" | "resume" | "fork"',
  ].filter((member) => !declaration.includes(member));

  expect(missing).toEqual([]);
});

it("reports a failed connection by code alone and leaves the session running", async () => {
  const fake = createFakePi();
  const failures = [];
  const registration = registerOwnerExtension(fake.pi, {
    env: {
      [OWNER_SIDEBAND_SOCKET_ENV]: "/nonexistent-directory-for-this-test/o",
      [OWNER_SIDEBAND_TOKEN_ENV]: TOKEN,
    },
    onFailure: (failure) => failures.push(failure),
  });
  const session = createFakeCtx();

  await fake.emit("session_start", { type: "session_start", reason: "startup" }, session.ctx);
  await registration.whenBridgeSettled();

  expect(failures).toEqual([{ code: "SIDEBAND_UNREACHABLE", generation: 1 }]);
  expect(registration.publicTui()).toBe(session.tui);
});
