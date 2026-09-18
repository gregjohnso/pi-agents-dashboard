import { chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it, vi } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { createStandaloneList } from "../app/list/standalone-list.mjs";
import { createStandaloneViewer } from "../app/standalone.mjs";
import { SPINNER_INTERVAL_MS } from "../app/spinner.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { ScreenTerminal } from "./alt-screen-harness.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

/**
 * The throbber in an open session, while the model is thinking and nothing else is happening.
 *
 * Operator-visible failure: a turn that runs for seconds without publishing an event freezes the
 * spinner and its elapsed counter, so a working session reads as a hung one. Nothing here types a
 * key or emits an event during the measurement window; the surface has to repaint on its own.
 */

const at = "2026-08-25T00:00:00Z";
const FRAMES = new Set(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
const fakePiSource = await readFile(fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url)), "utf8");
const harness = createRealProcessHarness("viewer-throbber-acceptance");
/** @type {any[]} */
const closers = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
  await harness.cleanup();
});

function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

/** The spinner glyph on the painted screen, or undefined when no status line is drawn. */
function glyph(terminal) {
  for (const line of terminal.screen()) {
    const found = [...line].find((character) => FRAMES.has(character));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Watch the painted screen over one window, touching nothing. */
async function watchGlyphs(terminal, windowMs) {
  /** @type {(string | undefined)[]} */
  const seen = [];
  const until = Date.now() + windowMs;
  while (Date.now() < until) {
    seen.push(glyph(terminal));
    await sleep(SPINNER_INTERVAL_MS / 4);
  }
  return seen;
}

/** A session whose turn is running and whose stream is silent: no events at all after the snapshot. */
function workingSnapshot() {
  return {
    version: 1, sessionId: "s", registryRevision: 1, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "0" }, runtime: null,
    taskState: "WORKING", processState: "LIVE", outcome: "NONE",
    activity: { kind: "activity", phase: "assistant_streaming", label: "Assistant streaming", sourceEventId: "snapshot", startedAt: at },
    model: { provider: "anthropic", id: "opus" }, thinkingLevel: null,
    items: [{ kind: "user_message", itemId: "u", content: [{ type: "text", text: "think about this" }] }],
    tools: [], pendingUi: [], errors: [],
  };
}

function silentSubscription() {
  /** @type {any} */
  let waiter;
  /** @type {any[]} */
  const queue = [];
  let ended = false;
  const events = {
    async next() {
      if (queue.length > 0) return { value: queue.shift(), done: false };
      if (ended) return { value: undefined, done: true };
      return new Promise((resolve) => { waiter = resolve; });
    },
    async return() { ended = true; waiter?.({ value: undefined, done: true }); waiter = undefined; return { value: undefined, done: true }; },
  };
  return {
    events,
    unsubscribe() { void events.return(); },
    // Queued rather than handed to whoever happens to be waiting: the pump reads one event at a
    // time, so a second push that arrives while it is still applying the first must not be dropped.
    /** @param {any} event */
    push(event) {
      if (waiter === undefined) { queue.push(event); return; }
      const resume = waiter;
      waiter = undefined;
      resume({ value: event, done: false });
    },
  };
}

/**
 * One state root running a real daemon and one session.
 *
 * `held` decides what that session is doing: a turn stalled inside a tool call, which is the quiet
 * thinking turn the throbber tests need, or a settled row that repaints for nothing at all, which is
 * what a status line has to reach on its own.
 * @param {{ held?: boolean }} [options]
 */
async function heldSession({ held = true } = {}) {
  const root = await harness.stateRoot("pi-agents-throbber-", ["canonical", "daemon", "sessions", "runs", "index"]);
  const executable = join(root, "pi");
  await writeFile(executable, fakePiSource, { mode: 0o700 });
  await chmod(executable, 0o700);
  // `FAKE_PI_QUEUE` is what makes the fake Pi run a real agent turn for a delivered prompt, and the
  // gate file is never created, so that run stalls inside its tool call: the session stays WORKING
  // and publishes nothing further. That is the quiet thinking turn, with a real worker behind it.
  const env = { ...process.env, FAKE_PI_LOG: join(root, "fake-pi.jsonl"), ...(held ? { FAKE_PI_QUEUE: "1", FAKE_PI_TOOL_GATE: join(root, "never-released") } : {}) };
  const started = await harness.daemon("start", { root, piBin: executable, env, timeoutMs: 20_000 });
  expect(started).toMatchObject({ code: 0 });
  const client = createDaemonClient({
    socketPath: join(root, "daemon", "control.sock"),
    token: (await readFile(join(root, "daemon", "control.token"), "utf8")).trim(),
    clientId: "throbber-launcher", attachId: "throbber-launcher-process", reconnect: false, maxBytes: 256 * 1024,
  });
  await client.connect();
  const launched = await client.request({
    version: 1, clientId: "throbber-launcher", requestId: "launch-throbber", op: "launch",
    payload: { prompt: "hold this turn open", cwd: root, sourceSessionId: "dashboard-throbber", isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: [] } },
  });
  if (!launched.ok) throw new Error(`Launch failed: ${JSON.stringify(launched)}`);
  const registry = new RegistryStore(join(root, "sessions"));
  const records = await registry.list();
  if (records[0]?.ownership?.process !== undefined) await harness.record("launched worker", records[0].ownership.process);
  await client.close();
  return { piBin: executable, registry, root, sessionId: launched.result.sessionId };
}

/**
 * A list with nothing running repaints for nothing. So an answer written onto its status line has to
 * ask for the frame that shows it.
 *
 * Operator-visible failure: the viewer's components failed to load, the frontend recorded the error,
 * and the operator saw his unchanged list with no explanation until he happened to press another
 * key. Every other test of this path had a working session on screen, whose throbber repainted at
 * 80 ms and hid it.
 */
it("paints the failure of a viewer open onto an idle list without waiting for another keypress", async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "pi-agents-default-keybindings"));
  const { piBin, root } = await heldSession({ held: false });
  const terminal = new ScreenTerminal({ columns: 100, rows: 30 });
  /** @type {(error: Error) => void} */
  let refuse;
  const list = await createStandaloneList({
    cwd: root, terminal,
    frontend: { root, piBin, clientId: "idle-error-host", attachId: "idle-error-host-process", async close() {} },
    loadViewerModules: () => new Promise((_resolve, reject) => { refuse = reject; }),
  });
  closers.push(() => list.close());
  await vi.waitFor(() => expect(terminal.text()).toContain("hold this turn open"), { timeout: 30_000, interval: 20 });
  // Settled and quiet: no throbber, and no frame for half a second. A list that repaints on its own
  // would paint this error whatever the frontend did, which is how every other test of this path
  // missed it.
  await vi.waitFor(() => expect(terminal.text()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u), { timeout: 30_000, interval: 20 });
  await vi.waitFor(async () => {
    const before = terminal.frames;
    await sleep(500);
    expect(terminal.frames).toBe(before);
  }, { timeout: 30_000, interval: 20 });

  terminal.type("\x1b[C");
  // One keypress and every frame it schedules, before the refusal: pi-tui coalesces and trails a
  // second frame after a throttled request, and a refusal riding on that one would prove nothing.
  terminal.type("d");
  await vi.waitFor(() => expect(terminal.text()).toContain("❯ d"), { timeout: 30_000, interval: 20 });
  await vi.waitFor(async () => {
    const before = terminal.frames;
    await sleep(300);
    expect(terminal.frames).toBe(before);
  }, { timeout: 30_000, interval: 20 });
  const painted = terminal.frames;

  refuse(Object.assign(new Error("viewer components unavailable"), { code: "VIEWER_IMPORT_FAILED" }));

  // Promptly, on the frame the failure itself asks for. The window is deliberately shorter than any
  // background repaint this list has (its summary refresh is 750 ms), so a pass cannot be one of
  // those arriving later and carrying the error by accident.
  await vi.waitFor(() => expect(terminal.text()).toContain("VIEWER_IMPORT_FAILED"), { timeout: 400, interval: 10 });
  expect(terminal.frames).toBeGreaterThan(painted);
}, 120_000);

/**
 * Opening a session imports Pi's components on the keypress, because a background warm-up does not
 * remove that cost, it moves it onto whatever the operator does next (measured: a first keystroke
 * waited 4.4 s behind it). What must hold is that a failed import is answered and retried.
 */
it("retries the viewer import after one fails, and opens the session on the next press", async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "pi-agents-default-keybindings"));
  const { piBin, registry, root, sessionId } = await heldSession();
  await vi.waitFor(async () => expect(await registry.get(sessionId)).toMatchObject({ taskState: "WORKING" }), { timeout: 30_000, interval: 50 });
  const terminal = new ScreenTerminal({ columns: 100, rows: 30 });
  let attempts = 0;
  const list = await createStandaloneList({
    cwd: root, terminal,
    frontend: { root, piBin, clientId: "retry-host", attachId: "retry-host-process", async close() {} },
    loadViewerModules: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(Object.assign(new Error("viewer components unavailable"), { code: "VIEWER_IMPORT_FAILED" }));
      return Promise.all([import("../app/viewer/pi-component-adapters.mjs"), import("../app/viewer/viewer-controller.mjs")]);
    },
  });
  closers.push(() => list.close());
  await vi.waitFor(() => expect(terminal.text()).toContain("hold this turn open"), { timeout: 30_000, interval: 20 });
  // Nothing imports Pi before a session is opened, which is what keeps the list's first paint fast.
  expect(attempts).toBe(0);

  // A failed import is the answer to that keypress, and it may not leave the frontend unable to open
  // a session ever again, which is what a `switching` flag nothing reset did.
  terminal.type("\x1b[C");
  // The list answers with the failure's own code, the way a refused attach is answered.
  await vi.waitFor(() => expect(terminal.text()).toContain("VIEWER_IMPORT_FAILED"), { timeout: 30_000, interval: 20 });
  terminal.type("\x1b[C");

  await vi.waitFor(() => expect(terminal.text()).toContain(`· ${sessionId} ·`), { timeout: 60_000, interval: 20 });
  expect(attempts).toBe(2);
}, 120_000);
