/**
 * `/rename <new name>` for the selected session.
 *
 * The contract under test, stated once: the manager asks the CURRENT owner generation to rename itself, the
 * owner mutates only through Pi's public `setSessionName`, and the row shows the name Pi CONFIRMED through
 * `getSessionName` - never the name that was merely requested. An owner that does not advertise the capability
 * is refused locally, so no unsupported frame is ever written to it and its bridge survives.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OWNER_SIDEBAND_SOCKET_ENV,
  OWNER_SIDEBAND_TOKEN_ENV,
  connectOwnerSideband,
  listenForOwnerSideband,
} from "../../runtime/native-sideband.mjs";
import { registerOwnerExtension } from "../../extension/pi-agents-owner.mjs";
import { createBridgeConsumer } from "./manager.mjs";
import { EMPTY_DRAFT_CHOICES, LIST_COMMAND_MENU, parseListCommand } from "../../app/list/list-commands.mjs";
import { DashboardController } from "../../app/list/dashboard.mjs";

const TOKEN = "manager-rename-token-for-this-run-only";

/** @type {(() => unknown)[]} */
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** One real disposable host listener. AF_UNIX paths cap at 108 bytes, so the root stays short. */
async function hostListener() {
  const base = join(tmpdir(), "x").length + 24 <= 100 || !existsSync("/tmp") ? tmpdir() : "/tmp";
  const root = await mkdtemp(join(base, "pia-rn-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "o");
  const listener = await listenForOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => listener.close());
  return { listener, socketPath };
}

/** One real connected host/owner pair. `nextOwner()` is pending before the owner dials in. */
async function linkPair() {
  const { listener, socketPath } = await hostListener();
  const arriving = listener.nextOwner();
  const ownerLink = await connectOwnerSideband({ socketPath, token: TOKEN });
  cleanup.push(() => ownerLink.close());
  return { host: await arriving, ownerLink, socketPath };
}

/** The next request the owner side is handed. */
function nextRequest(ownerLink) {
  return new Promise((resolve) => ownerLink.onRequest(resolve));
}

function consumerFor() {
  /** @type {string[]} */
  const lines = [];
  return { consumer: createBridgeConsumer({ log: (line) => lines.push(line) }), lines };
}

/** A fake owner connection that records what the manager actually wrote to it. */
function fakeOwnerConnection() {
  /** @type {((frame: any) => void)[]} */
  const listeners = [];
  let settle = () => {};
  const closed = new Promise((resolve) => {
    settle = resolve;
  });
  /** @type {any[]} */
  const sent = [];
  let closes = 0;
  return {
    connection: {
      closed,
      onFrame(listener) {
        listeners.push(listener);
        return () => {};
      },
      requestStop: async (requestId) => void sent.push({ request: "stop", requestId }),
      requestAbort: async (requestId) => void sent.push({ request: "abort", requestId }),
      requestRename: async (requestId, name) => void sent.push({ request: "rename", requestId, name }),
      requestColor: async (requestId, color) => void sent.push({ request: "color", requestId, color }),
      close() {
        closes += 1;
      },
    },
    emit(frame) {
      for (const listener of [...listeners]) listener(frame);
    },
    endWith(outcome) {
      settle(outcome);
      return closed;
    },
    sent,
    closes: () => closes,
  };
}

const READY = { type: "owner-ready", phase: "bridge" };
const FACTS = (facts) => ({ type: "owner-facts", facts });

describe("the rename host frame is validated on both boundaries", () => {
  it("carries a name the owner receives byte-exact, including its inner spaces", async () => {
    const { host, ownerLink } = await linkPair();
    const arriving = nextRequest(ownerLink);
    await host.requestRename("rename-1", "my new session name");
    expect(await arriving).toMatchObject({ type: "owner-request", requestId: "rename-1", request: "rename", name: "my new session name" });
  });

  it("refuses a rename with no name at the sending boundary, so nothing is written", async () => {
    const { host, ownerLink } = await linkPair();
    await expect(host.requestRename("rename-2", "")).rejects.toThrow();
    // The owner is untouched and its link is still usable.
    const arriving = nextRequest(ownerLink);
    await host.requestRename("rename-3", "a real name");
    expect(await arriving).toMatchObject({ request: "rename", name: "a real name" });
  });

  it("refuses a whitespace-only name, an over-long name and control characters", async () => {
    const { host } = await linkPair();
    await expect(host.requestRename("r-a", "   ")).rejects.toThrow();
    await expect(host.requestRename("r-b", "x".repeat(129))).rejects.toThrow();
    await expect(host.requestRename("r-c", "bad\u0000name")).rejects.toThrow();
    await expect(host.requestRename("r-d", "bad\nname")).rejects.toThrow();
    await expect(host.requestRename("r-e", "bad\u001b[31mname")).rejects.toThrow();
    // Exactly at the limit is allowed.
    await expect(host.requestRename("r-f", "x".repeat(128))).resolves.not.toThrow();
  });

  it("leaves stop and abort with their existing exact shapes", async () => {
    const { host, ownerLink } = await linkPair();
    const arriving = nextRequest(ownerLink);
    await host.requestStop("stop-1");
    // No name field appears on a stop, and the frame still carries exactly what it always did.
    expect(await arriving).toEqual({ type: "owner-request", requestId: "stop-1", request: "stop" });
  });
});

describe("sending a rename is gated on the current generation's advertised capability", () => {
  it("refuses locally when the connected owner never advertised rename support, and does not touch its bridge", async () => {
    const { consumer } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);
    owner.emit(READY);
    owner.emit(FACTS({ agentPhase: "settled" }));

    const record = await consumer.request("rename", "req-1", "a new name");

    expect(record.sent).toBe(false);
    expect(record.admitted).toBe(false);
    expect(String(record.reason)).toMatch(/rename/iu);
    // Nothing was written, so no unsupported frame could tear the bridge down.
    expect(owner.sent).toEqual([]);
    expect(owner.closes()).toBe(0);
    const status = consumer.status();
    expect(status.connected).toBe(true);
    expect(status.refusal).toBeNull();
  });

  it("sends the rename when the connected owner advertises support", async () => {
    const { consumer } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);
    owner.emit(READY);
    owner.emit(FACTS({ renameSupported: true }));

    const record = await consumer.request("rename", "req-2", "a new name");

    expect(record.sent).toBe(true);
    expect(owner.sent).toEqual([{ request: "rename", requestId: "req-2", name: "a new name" }]);
  });

  it("does not carry a previous generation's capability over to its replacement", async () => {
    const { consumer } = consumerFor();
    const first = fakeOwnerConnection();
    consumer.adopt(first.connection);
    first.emit(READY);
    first.emit(FACTS({ renameSupported: true }));
    expect((await consumer.request("rename", "req-3", "first name")).sent).toBe(true);

    // A replacement owner that does not advertise the capability must be refused, not trusted.
    const second = fakeOwnerConnection();
    consumer.adopt(second.connection);
    second.emit(READY);
    second.emit(FACTS({ agentPhase: "start" }));

    const record = await consumer.request("rename", "req-4", "second name");
    expect(record.sent).toBe(false);
    expect(second.sent).toEqual([]);
    expect(second.closes()).toBe(0);
    expect(consumer.status().connected).toBe(true);
  });

  it("refuses a rename when the generation withdraws the capability in a later snapshot", async () => {
    const { consumer } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);
    owner.emit(READY);
    owner.emit(FACTS({ renameSupported: true }));
    owner.emit(FACTS({ agentPhase: "start" }));

    const record = await consumer.request("rename", "req-5", "a new name");
    expect(record.sent).toBe(false);
    expect(owner.sent).toEqual([]);
  });
});

describe("the owner renames only through Pi's public API", () => {
  /** One fake `pi` that records what the extension called, with an optional failure. */
  function fakePi({ supported = true, failWith = undefined } = {}) {
    const handlers = new Map();
    let stored = "original name";
    const calls = [];
    const pi = {
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      getSessionName() {
        calls.push("getSessionName");
        return stored;
      },
    };
    if (supported) {
      pi.setSessionName = (name) => {
        calls.push(`setSessionName:${name}`);
        if (failWith !== undefined) throw new Error(failWith);
        stored = name;
      };
    }
    return {
      pi,
      calls,
      storedName: () => stored,
      async emit(event, payload, ctx) {
        for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
      },
    };
  }

  function fakeContext() {
    return {
      ui: { setWidget() {} },
      mode: "tui",
      hasUI: true,
      cwd: "/tmp/disposable",
      sessionManager: { getSessionFile: () => "/tmp/disposable/session.jsonl", getSessionId: () => "session-1" },
      model: { provider: "fixture", id: "one" },
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort() {},
      shutdown() {},
    };
  }

  async function ownerFor(options) {
    const { listener, socketPath } = await hostListener();
    const arriving = listener.nextOwner();
    const harness = fakePi(options);
    registerOwnerExtension(harness.pi, {
      env: { [OWNER_SIDEBAND_SOCKET_ENV]: socketPath, [OWNER_SIDEBAND_TOKEN_ENV]: TOKEN },
      onFailure: () => {},
    });
    await harness.emit("session_start", { type: "session_start" }, fakeContext());
    const host = await arriving;
    /** @type {any[]} */
    const frames = [];
    host.onFrame((frame) => frames.push(frame));
    // Let the bridge announce itself before anything is asked of it.
    for (let i = 0; i < 40 && !frames.some((f) => f.type === "owner-facts"); i += 1) await new Promise((r) => setTimeout(r, 25));
    return { host, harness, frames, factsFor: () => frames.filter((f) => f.type === "owner-facts").at(-1)?.facts ?? {} };
  }

  it("advertises the capability only when Pi actually offers setSessionName", async () => {
    const supported = await ownerFor({ supported: true });
    expect(supported.factsFor().renameSupported).toBe(true);
    const bare = await ownerFor({ supported: false });
    expect(bare.factsFor().renameSupported).toBeUndefined();
  });

  it("mutates through setSessionName and publishes the name getSessionName confirms", async () => {
    const { host, harness, frames, factsFor } = await ownerFor({});
    const before = frames.length;
    await host.requestRename("rn-1", "a confirmed name");
    for (let i = 0; i < 60 && !frames.slice(before).some((f) => f.type === "owner-receipt"); i += 1) await new Promise((r) => setTimeout(r, 25));

    expect(harness.calls).toContain("setSessionName:a confirmed name");
    expect(harness.storedName()).toBe("a confirmed name");
    // The published name is the one Pi confirmed, read back through the public getter.
    expect(factsFor().sessionName).toBe("a confirmed name");
    expect(frames.slice(before).find((f) => f.type === "owner-receipt")).toMatchObject({ request: "rename", outcome: "requested" });
  });

  it("answers unsupported and mutates nothing when Pi offers no setSessionName", async () => {
    const { host, harness, frames } = await ownerFor({ supported: false });
    const before = frames.length;
    await host.requestRename("rn-2", "a new name");
    for (let i = 0; i < 60 && !frames.slice(before).some((f) => f.type === "owner-receipt"); i += 1) await new Promise((r) => setTimeout(r, 25));

    expect(frames.slice(before).find((f) => f.type === "owner-receipt")).toMatchObject({ request: "rename", outcome: "unsupported" });
    expect(harness.calls.some((call) => call.startsWith("setSessionName"))).toBe(false);
    expect(harness.storedName()).toBe("original name");
  });

  it("keeps the old name and does not report success when the public API throws", async () => {
    const { host, harness, frames, factsFor } = await ownerFor({ failWith: "pi refused this name" });
    const before = frames.length;
    await host.requestRename("rn-3", "a rejected name");
    for (let i = 0; i < 60 && !frames.slice(before).some((f) => f.type === "owner-receipt"); i += 1) await new Promise((r) => setTimeout(r, 25));

    // The old name survives, and the row is told so rather than being shown the requested name.
    expect(harness.storedName()).toBe("original name");
    expect(factsFor().sessionName).toBe("original name");
    const receipt = frames.slice(before).find((f) => f.type === "owner-receipt");
    expect(receipt.outcome).not.toBe("requested");
    expect(factsFor().renameError).toBeTruthy();
  });
});

describe("the /rename command", () => {
  const parse = (text) => parseListCommand(text, EMPTY_DRAFT_CHOICES);

  it("is offered in the command menu, alongside the unchanged /name", () => {
    const names = LIST_COMMAND_MENU.map((command) => command.name);
    expect(names).toContain("/rename");
    expect(names).toContain("/name");
    // /name still sets the NEXT launch's name and reaches no session.
    expect(parse("/name later launch")).toEqual({ kind: "set_name", name: "later launch" });
  });

  it("targets the selected session and preserves inner spaces", () => {
    expect(parse("/rename my new session name")).toEqual({ kind: "rename_session", name: "my new session name" });
  });

  it("gives a concise usage error with no name", () => {
    const parsed = parse("/rename");
    expect(parsed.kind).toBe("rejected");
    expect(parsed.message).toMatch(/\/rename <new name>/u);
    expect(parsed.message.length).toBeLessThan(80);
  });

  it("reuses the existing 128-character limit and refuses control characters", () => {
    expect(parse(`/rename ${"x".repeat(129)}`)).toMatchObject({ kind: "rejected", code: "SESSION_NAME_TOO_LONG" });
    expect(parse(`/rename ${"x".repeat(128)}`)).toMatchObject({ kind: "rename_session" });
    expect(parse("/rename bad\u0000name")).toMatchObject({ kind: "rejected" });
    expect(parse("/rename bad\u001b[31mname")).toMatchObject({ kind: "rejected" });
  });
});

describe("the controller renames the row the operator selected", () => {
  /** Two fixture sessions, so "the selected one" is a claim a case can actually falsify. */
  function rows() {
    return ["session-alpha", "session-beta"].map((sessionId) => ({
      schemaVersion: 1, revision: 1, sessionId, name: sessionId,
      sessionFile: `/tmp/${sessionId}/session.jsonl`, canonicalSessionFile: `/tmp/${sessionId}/session.jsonl`,
      cwd: "/repo", taskState: "READY", processState: "LIVE", stateReported: true,
      activity: { kind: "native", summary: "idle" }, attachments: [], model: { provider: "fixture", id: "one" },
      updatedAtMs: 1, createdAtMs: 1, outcome: "NONE",
    }));
  }

  function controllerFor({ rename, sessions } = {}) {
    const calls = [];
    let current = sessions ?? rows();
    const client = {
      async getState() { return { sessions: current, cursor: { coverage: "complete" } }; },
      async subscribeListChanges() { return () => {}; },
      async preflightLaunch(draft) { return { canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }; },
      async launch() { return { kind: "launched", sessionId: "launched" }; },
      async getModels() { return []; },
      async refreshSummaries() { return []; },
      async rename(sessionId, revision, requestId, name) {
        calls.push({ sessionId, revision, name });
        if (rename !== undefined) return rename(sessionId, name);
        // The backend answers with the name the owner confirmed, which is what the next read shows.
        current = current.map((row) => (row.sessionId === sessionId ? { ...row, name } : row));
        return { sessionId, name, confirmed: true };
      },
    };
    const controller = new DashboardController({
      client, openViewer: async () => {}, clientId: "rename-client", sourceSessionId: "source",
      launchDefaults: { cwd: "/repo", model: { provider: "fixture", id: "one" }, name: "next" },
      requestRender: () => {}, worktreeCapability: async () => ({ available: true }),
    });
    return { controller, calls };
  }

  it("refuses with a specific message when there is no row to rename, and calls nothing", async () => {
    // An empty list is the real "nothing is selected": the list keeps a selection whenever it has a row.
    const { controller, calls } = controllerFor({ sessions: [] });
    await controller.open();
    expect(controller.selectedSession()).toBeUndefined();
    controller.setComposerPrompt("/rename a new name");
    await controller.runListCommand();
    expect(controller.status.kind).toBe("error");
    expect(controller.status.code).toBe("NO_SESSION_SELECTED");
    expect(String(controller.status.message)).toMatch(/select/iu);
    expect(calls).toEqual([]);
  });

  it("renames only the selected session, never the other fixture", async () => {
    const { controller, calls } = controllerFor();
    await controller.open();
    controller.selectSession("session-beta");
    controller.setComposerPrompt("/rename beta renamed");
    await controller.runListCommand();
    expect(calls).toEqual([{ sessionId: "session-beta", revision: 1, name: "beta renamed" }]);
  });

  it("captures the target when the command is submitted, so a later selection change cannot retarget it", async () => {
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { controller, calls } = controllerFor({
      rename: async (sessionId, name) => {
        await gate;
        return { sessionId, name, confirmed: true };
      },
    });
    await controller.open();
    controller.selectSession("session-alpha");
    controller.setComposerPrompt("/rename alpha renamed");
    const submitted = controller.runListCommand();
    // The operator moves the selection while the rename is still travelling.
    controller.selectSession("session-beta");
    release();
    await submitted;
    expect(calls).toEqual([{ sessionId: "session-alpha", revision: 1, name: "alpha renamed" }]);
  });

  it("keeps the old name visible and reports the failure when the rename fails", async () => {
    const { controller } = controllerFor({
      rename: async () => {
        throw Object.assign(new Error("owner does not advertise rename support"), { code: "RENAME_UNSUPPORTED" });
      },
    });
    await controller.open();
    controller.selectSession("session-alpha");
    controller.setComposerPrompt("/rename alpha renamed");
    await controller.runListCommand();
    expect(controller.status.kind).toBe("error");
    expect(controller.status.code).toBe("RENAME_UNSUPPORTED");
    // The row still carries the name it had.
    expect(controller.sessions.find((s) => s.sessionId === "session-alpha").name).toBe("session-alpha");
  });

  it("clears the composer only when the rename was accepted", async () => {
    const { controller } = controllerFor();
    await controller.open();
    controller.selectSession("session-alpha");
    controller.setComposerPrompt("/rename alpha renamed");
    await controller.runListCommand();
    expect(controller.composerDraft.prompt).toBe("");
  });
});

describe("a color asked for from the list", () => {
  it("carries one of session-color's names to the owner, and refuses anything else at the sending boundary", async () => {
    const { host, ownerLink } = await linkPair();
    const arriving = nextRequest(ownerLink);
    await host.requestColor("color-1", "red");
    expect(await arriving).toMatchObject({ type: "owner-request", requestId: "color-1", request: "color", color: "red" });
    await expect(host.requestColor("color-2", "magenta")).rejects.toThrow();
  });

  it("is sent only to an owner generation that advertises color support", async () => {
    const { consumer } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);
    owner.emit(READY);
    owner.emit(FACTS({ agentPhase: "settled" }));
    const refused = await consumer.request("color", "req-c1", "red");
    expect(refused).toMatchObject({ sent: false });
    expect(owner.sent).toEqual([]);
    expect(owner.closes()).toBe(0);
    owner.emit(FACTS({ colorSupported: true }));
    expect((await consumer.request("color", "req-c2", "red")).sent).toBe(true);
    expect(owner.sent).toEqual([{ request: "color", requestId: "req-c2", color: "red" }]);
  });
});
