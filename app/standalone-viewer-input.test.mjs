import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, expect, it, vi } from "vitest";

import { createStandaloneViewer } from "./standalone.mjs";

/**
 * Where terminal input goes in the viewer `pi-agents attach` opens.
 *
 * `createStandaloneViewer` focuses Pi's editor rather than the component that routes input to the
 * viewer. Operator-visible failure: every key that is not typing — Escape to leave the session, the
 * scroll keys — reaches the editor instead of the session and does nothing, so an attached operator
 * cannot get out of the session, and Alt+Enter cannot reach the editor action that queues a
 * follow-up.
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
  vi.unstubAllEnvs();
});

/**
 * One real alternate-screen viewer over a terminal this test can type into.
 *
 * Pi reads the operator's own `keybindings.json` from `PI_CODING_AGENT_DIR`, so this points it at a
 * directory that holds nothing: a remap of his must not decide what these keys do here.
 */
async function attachedViewer() {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "pi-agents-default-keybindings"));
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

it("sends Enter as a prompt and Alt+Enter as a follow-up from the attached terminal", async () => {
  const { client, terminal } = await attachedViewer();
  await vi.waitFor(() => expect(painted(terminal)).toContain("hello"));

  for (const character of "ship it") terminal.input(character);
  terminal.input("\r");
  await vi.waitFor(() => expect(client.commands).toHaveLength(1), { timeout: 2_000, interval: 20 });
  for (const character of "then deploy") terminal.input(character);
  terminal.input("\x1b\r");

  await vi.waitFor(() => expect(client.commands).toEqual([
    { operation: "prompt", payload: { sessionId: "s", text: "ship it" } },
    { operation: "follow_up", payload: { sessionId: "s", text: "then deploy" } },
  ]), { timeout: 2_000, interval: 20 });
});

it("leaves the attached session when a second Ctrl+C lands inside the window", async () => {
  const { onReturn, terminal } = await attachedViewer();
  await vi.waitFor(() => expect(painted(terminal)).toContain("hello"));

  terminal.input("\x03");
  expect(onReturn).not.toHaveBeenCalled();
  terminal.input("\x03");

  await vi.waitFor(() => expect(onReturn).toHaveBeenCalledTimes(1), { timeout: 2_000, interval: 20 });
});
