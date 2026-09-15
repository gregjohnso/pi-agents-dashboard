import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createStandaloneViewer } from "../app/standalone.mjs";
import { ScreenTerminal, mouseReport } from "./alt-screen-harness.mjs";

/**
 * What Pi owns once the viewer is one of its layouts: the transcript viewport, the keys that move
 * it, the wheel, text selection, hyperlinks and search.
 *
 * Every assertion here reads the painted alternate screen of a real `TuiAltScreen`, so a viewer that
 * clipped the transcript itself, or that swallowed mouse bytes before Pi saw them, fails.
 */

const at = "2026-08-25T00:00:00Z";
const TRANSCRIPT_LINES = 60;
const LINK = `\x1b]8;;https://example.com/report\x1b\\report\x1b]8;;\x1b\\`;

function line(index) { return `line ${String(index).padStart(2, "0")}`; }

function snapshot() {
  return {
    version: 1, sessionId: "s", registryRevision: 1, cursor: { daemonEpoch: "epoch", sessionId: "s", sequence: "0" }, runtime: null,
    taskState: "READY", processState: "LIVE", outcome: "NONE",
    activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "snapshot", startedAt: at },
    model: { provider: "anthropic", id: "opus" }, thinkingLevel: null,
    items: [
      ...Array.from({ length: TRANSCRIPT_LINES }, (_, index) => ({ kind: "system_message", itemId: `i-${index}`, text: line(index), level: "info" })),
      { kind: "system_message", itemId: "link", text: LINK, level: "info" },
    ],
    tools: [], pendingUi: [], errors: [],
  };
}

function createSubscription() {
  /** @type {any} */
  let waiter;
  let ended = false;
  const events = {
    async next() {
      if (ended) return { value: undefined, done: true };
      return new Promise((resolve) => { waiter = resolve; });
    },
    async return() { ended = true; waiter?.({ value: undefined, done: true }); waiter = undefined; return { value: undefined, done: true }; },
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

async function attachedViewer({ columns = 80, rows = 24 } = {}) {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "pi-agents-default-keybindings"));
  const terminal = new ScreenTerminal({ columns, rows });
  const copySelection = vi.fn(async () => true);
  const openUrl = vi.fn();
  const viewer = await createStandaloneViewer({
    sessionId: "s", client: fakeClient(), terminal, onReturn: vi.fn(), now: () => 0, copySelection, openUrl,
    persistence: { async load() { return undefined; }, async save() {} },
  });
  viewers.push(viewer);
  await viewer.open();
  await vi.waitFor(() => expect(terminal.text()).toContain(line(TRANSCRIPT_LINES - 1)), { timeout: 5_000, interval: 20 });
  return { copySelection, openUrl, terminal, viewer };
}

/** The screen row holding the operator's draft, which is the dock row a scroll must never move. */
function promptRow(terminal, draft) {
  const rows = terminal.screen();
  const index = rows.findIndex((row) => row.includes(draft));
  return { index, row: rows[index] };
}

function footerRow(terminal) {
  const rows = terminal.screen();
  const index = rows.findIndex((row) => row.includes("opus"));
  return { index, row: rows[index] };
}

it("scrolls the transcript with Pi's own viewport keys while the dock stays put", async () => {
  const { terminal } = await attachedViewer();
  for (const character of "draft") terminal.type(character);
  await vi.waitFor(() => expect(promptRow(terminal, "draft").index).toBeGreaterThan(0), { timeout: 5_000, interval: 20 });
  const prompt = promptRow(terminal, "draft");
  const footer = footerRow(terminal);
  expect(terminal.text()).not.toContain(line(0));

  terminal.type("\x1b[5~");
  await vi.waitFor(() => expect(terminal.text()).not.toContain(line(TRANSCRIPT_LINES - 1)), { timeout: 5_000, interval: 20 });
  expect(promptRow(terminal, "draft")).toEqual(prompt);
  expect(footerRow(terminal)).toEqual(footer);

  terminal.type("\x1b[H");
  await vi.waitFor(() => expect(terminal.text()).toContain(line(0)), { timeout: 5_000, interval: 20 });
  expect(promptRow(terminal, "draft")).toEqual(prompt);

  terminal.type("\x1b[F");
  await vi.waitFor(() => expect(terminal.text()).toContain(line(TRANSCRIPT_LINES - 1)), { timeout: 5_000, interval: 20 });

  // One wheel notch up moves the transcript and nothing else.
  const beforeWheel = terminal.text();
  terminal.type(mouseReport({ button: 64, column: 10, row: 5 }));
  await vi.waitFor(() => expect(terminal.text()).not.toBe(beforeWheel), { timeout: 5_000, interval: 20 });
  expect(promptRow(terminal, "draft")).toEqual(prompt);
});

it("searches the whole transcript, not the part that happens to be on screen", async () => {
  const { terminal } = await attachedViewer();
  expect(terminal.text()).not.toContain(line(4));

  // Ctrl+Shift+F is Pi's own `tui.altScreen.search`. The assertion reads the line below the query's
  // own match, because the search bar echoes the query itself.
  terminal.type("\x1b[102;6u");
  for (const character of line(3)) terminal.type(character);

  await vi.waitFor(() => expect(terminal.text()).toContain(line(4)), { timeout: 5_000, interval: 20 });
  expect(terminal.text()).not.toContain(line(TRANSCRIPT_LINES - 1));
});

it("hands a dragged selection to the injected clipboard once and an OSC 8 click to the opener", async () => {
  const { copySelection, openUrl, terminal } = await attachedViewer();
  const rows = terminal.screen();
  const target = rows.findIndex((row) => row.includes(line(TRANSCRIPT_LINES - 1)));
  const column = rows[target].indexOf(line(TRANSCRIPT_LINES - 1));

  terminal.type(mouseReport({ button: 0, column, row: target }));
  terminal.type(mouseReport({ button: 32, column: column + 6, row: target }));
  terminal.type(mouseReport({ button: 0, column: column + 6, row: target, release: true }));

  await vi.waitFor(() => expect(copySelection).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 20 });
  expect(copySelection.mock.calls[0][0]).toContain("line 5");

  const linkRow = terminal.screen().findIndex((row) => row.includes("report"));
  const linkColumn = terminal.screen()[linkRow].indexOf("report");
  terminal.type(mouseReport({ button: 0, column: linkColumn, row: linkRow }));
  terminal.type(mouseReport({ button: 0, column: linkColumn, row: linkRow, release: true }));

  await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/report"), { timeout: 5_000, interval: 20 });
  expect(copySelection).toHaveBeenCalledTimes(1);
});
