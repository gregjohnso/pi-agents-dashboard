/**
 * Startup order: the screen must not wait for every owner, and a quit during the first load must stick.
 *
 * `createStandaloneList` awaited `controller.open()` before starting its TUI. That first load reads every session
 * directory over a control socket, so one wedged owner meant a blank terminal with no list, no error and nothing
 * to quit - which is the startup hang this file pins.
 *
 * The correction is opt-in (`paintBeforeFirstLoad`), so the daemon-backed default keeps the order it was
 * qualified with. Both orders are asserted here.
 */

import { afterEach, expect, it } from "vitest";

import { ScreenTerminal } from "../../test/alt-screen-harness.mjs";
import { createStandaloneList } from "./standalone-list.mjs";

/** @type {(() => unknown)[]} */
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function row(sessionId) {
  const at = new Date().toISOString();
  return {
    schemaVersion: 1, revision: 1, sessionId, sessionFile: `/s/${sessionId}.jsonl`, canonicalSessionFile: `/s/${sessionId}.jsonl`,
    cwd: "/repo", name: sessionId, taskState: "READY", processState: "LIVE", outcome: "NONE",
    activity: { kind: "native", summary: "idle", updatedAt: at }, createdAt: at, updatedAt: at,
  };
}

/**
 * A list whose very first `getState` is held open, standing in for the read that waits on a wedged owner.
 *
 * @param {{ paintBeforeFirstLoad: boolean }} options
 */
async function listWithHeldFirstRead({ paintBeforeFirstLoad }) {
  let releaseFirstRead = () => {};
  const held = new Promise((resolve) => {
    releaseFirstRead = resolve;
  });
  let reads = 0;
  const client = {
    async getState() {
      reads += 1;
      if (reads === 1) await held;
      return { sessions: [row("healthy")], cursor: { daemonEpoch: "epoch", sequence: String(reads) } };
    },
    async subscribeListChanges() { return () => {}; },
    async preflightLaunch(draft) { return { canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }; },
    async launch() { return { kind: "launched", sessionId: "healthy" }; },
    async getModels() { return []; },
    async refreshSummaries() { return []; },
    async close() {},
  };
  const terminal = new ScreenTerminal({ columns: 120, rows: 30 });
  const started = createStandaloneList({
    cwd: "/repo",
    frontend: { root: "/frontend", clientId: "startup-client", attachId: "startup-client" },
    client,
    terminal,
    paintBeforeFirstLoad,
    openViewer: async () => {},
  });
  return { started, releaseFirstRead, terminal, reads: () => reads };
}

/** Whatever the harness screen currently shows, as one string. */
const screenOf = (terminal) => terminal.text();

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** Wait for a condition rather than for a duration, so the close grace is not guessed at. */
async function until(condition, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${description} did not happen within ${timeoutMs}ms`);
}

it("paints the existing loading surface before the first read finishes", async () => {
  const { started, releaseFirstRead, terminal } = await listWithHeldFirstRead({ paintBeforeFirstLoad: true });
  await settle();

  // The screen exists and says it is loading. Not blank, and not an empty list that would read as "no sessions".
  const duringLoad = screenOf(terminal);
  expect(duringLoad.length).toBeGreaterThan(0);
  expect(duringLoad).toMatch(/loading/iu);
  expect(duringLoad).not.toMatch(/no sessions|nothing to show/iu);

  releaseFirstRead();
  const list = await started;
  cleanup.push(() => list.close());
  await settle();
  // And the rows arrive once the read completes.
  expect(screenOf(terminal)).toMatch(/healthy/u);
});

it("keeps the daemon-backed default order, which paints only after the first read", async () => {
  const { started, releaseFirstRead, terminal } = await listWithHeldFirstRead({ paintBeforeFirstLoad: false });
  await settle();
  // Unchanged behaviour: nothing is painted while the first read is outstanding.
  expect(screenOf(terminal)).not.toMatch(/loading/iu);

  releaseFirstRead();
  const list = await started;
  cleanup.push(() => list.close());
  await settle();
  expect(screenOf(terminal)).toMatch(/healthy/u);
});

it("lets a quit during the first load stick, and does not repaint when the read finally answers", async () => {
  const { started, releaseFirstRead, terminal } = await listWithHeldFirstRead({ paintBeforeFirstLoad: true });
  await settle();
  expect(screenOf(terminal)).toMatch(/loading/iu);

  // The operator quits while the load is still outstanding. Ctrl+C twice is the existing leave gesture.
  terminal.type("\u0003");
  await settle();
  terminal.type("\u0003");
  // The close reports only after a bounded grace for the outstanding read, so this waits for the condition.
  await until(() => terminal.input === undefined, "the screen being given up after the quit");
  // The screen was given up: this harness drops its input handler on stop, so stdin is no longer held.
  expect(terminal.input).toBeUndefined();
  const framesAtQuit = terminal.frames;

  // The held read now answers. It must not bring the screen back, repaint it, or take stdin again.
  releaseFirstRead();
  const list = await started;
  cleanup.push(() => list.close());
  await settle();

  expect(terminal.frames).toBe(framesAtQuit);
  expect(screenOf(terminal)).not.toMatch(/healthy/u);
  expect(terminal.input).toBeUndefined();
});
