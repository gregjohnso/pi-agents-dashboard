import { stripVTControlCharacters } from "node:util";

import { afterEach, expect, it, vi } from "vitest";

import { createStandaloneViewer } from "./standalone.mjs";

/**
 * Where terminal input goes in the viewer `pi-agents attach` opens.
 *
 * `createStandaloneViewer` focuses Pi's editor rather than the component that routes input to the
 * viewer. Operator-visible failure: every key that is not typing — Escape to leave the session,
 * Ctrl+S to steer, the scroll keys — reaches the editor instead of the session and does nothing,
 * so an attached operator cannot get out of the session or steer the run.
 */

const at = "2026-08-25T00:00:00Z";

class FakeTerminal {
  columns = 80;
  rows = 24;
  /** @type {((data: string) => void) | undefined} */ input;
  writes = [];
  start(onInput) { this.input = onInput; }
  stop() { this.input = undefined; }
  write(data) { this.writes.push(data); }
  hideCursor() {}
  showCursor() {}
}

function snapshot() {
  return {
    version: 1, sessionId: "s", registryRevision: 1, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "0" }, runtime: null,
    taskState: "READY", processState: "LIVE", outcome: "NONE",
    activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "snapshot", startedAt: at },
    model: null, thinkingLevel: null,
    items: [{ kind: "user_message", itemId: "u", content: [{ type: "text", text: "hello" }] }],
    tools: [], pendingUi: [], errors: [],
  };
}

/** One subscription whose events never arrive, ended by the viewer's own unsubscribe. */
function createSubscription() {
  let waiter;
  let ended = false;
  const events = {
    async next() {
      if (ended) return { value: undefined, done: true };
      return new Promise((resolve) => { waiter = resolve; });
    },
    async return() {
      ended = true;
      waiter?.({ value: undefined, done: true });
      waiter = undefined;
      return { value: undefined, done: true };
    },
  };
  return { events, unsubscribe() { void events.return(); } };
}

function fakeClient() {
  return {
    commands: [],
    async subscribeViewer() {
      const subscription = createSubscription();
      return { snapshot: snapshot(), events: subscription.events, unsubscribe: () => subscription.unsubscribe() };
    },
    onConnectionChange() { return () => {}; },
    async command(operation, payload) { this.commands.push({ operation, payload }); return { accepted: true }; },
    async sessionMenu() { return { commands: [], models: [], model: null, color: null }; },
  };
}

const viewers = [];
afterEach(async () => {
  await Promise.all(viewers.splice(0).map((viewer) => viewer.close()));
});

/** One real alternate-screen viewer over a terminal this test can type into. */
async function attachedViewer() {
  const terminal = new FakeTerminal();
  const onReturn = vi.fn();
  const client = fakeClient();
  const viewer = await createStandaloneViewer({
    sessionId: "s", client, terminal, onReturn, now: () => 0,
    persistence: { async load() { return undefined; }, async save() {} },
  });
  viewers.push(viewer);
  await viewer.open();
  return { client, onReturn, terminal, viewer };
}

function painted(terminal) {
  return stripVTControlCharacters(terminal.writes.join(""));
}

it("leaves the session when the operator presses Escape", async () => {
  const { onReturn, terminal } = await attachedViewer();
  await vi.waitFor(() => expect(painted(terminal)).toContain("hello"));

  terminal.input("\x1b");

  await vi.waitFor(() => expect(onReturn).toHaveBeenCalledTimes(1), { timeout: 2_000, interval: 20 });
});

it("arms a steer when the operator presses Ctrl+S", async () => {
  const { terminal } = await attachedViewer();
  await vi.waitFor(() => expect(painted(terminal)).toContain("hello"));

  terminal.input("\x13");

  await vi.waitFor(() => expect(painted(terminal)).toContain("Steer at next supported boundary"), { timeout: 2_000, interval: 20 });
});

// Control: routing every key through the viewer must still leave typing in Pi's editor.
it("types into the prompt", async () => {
  const { terminal } = await attachedViewer();
  await vi.waitFor(() => expect(painted(terminal)).toContain("hello"));

  for (const character of "rebase") terminal.input(character);

  await vi.waitFor(() => expect(painted(terminal)).toContain("rebase"), { timeout: 2_000, interval: 20 });
});
