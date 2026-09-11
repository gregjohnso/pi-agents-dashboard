import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { afterEach, expect, it, vi } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { createStandaloneViewer } from "../app/standalone.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

/**
 * What the operator does: attach to a session, press Ctrl+T, pick a thinking level.
 *
 * This drives the real terminal path — alternate-screen input, the viewer, the daemon socket, a real
 * worker, and a bounded fake Pi — so a Ctrl+T that reaches nothing, a level that never gets to Pi,
 * or a footer that claims a level Pi never confirmed is a failure here.
 */

const fakePiSource = await readFile(fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url)), "utf8");
const harness = createRealProcessHarness("thinking-picker-acceptance");
/** @type {any[]} */
const closers = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  await harness.cleanup();
});

class FakeTerminal {
  columns = 80;
  rows = 24;
  /** @type {((data: string) => void) | undefined} */ input;
  /** @type {string[]} */ writes = [];
  start(onInput) { this.input = onInput; }
  stop() { this.input = undefined; }
  write(data) { this.writes.push(data); }
  hideCursor() {}
  showCursor() {}
}

/** @param {FakeTerminal} terminal */
function painted(terminal) {
  return stripVTControlCharacters(terminal.writes.join(""));
}

/** One state root running a real daemon over the bounded fake Pi. @param {Record<string, string>} extraEnv */
async function liveSession(extraEnv) {
  const root = await harness.stateRoot("pi-agents-thinking-picker-", ["canonical", "daemon", "sessions", "runs", "index"]);
  const executable = join(root, "pi");
  const log = join(root, "fake-pi.jsonl");
  await writeFile(executable, fakePiSource, { mode: 0o700 });
  await chmod(executable, 0o700);
  const env = { ...process.env, FAKE_PI_LOG: log, ...extraEnv };
  const started = await harness.daemon("start", { root, piBin: executable, env, timeoutMs: 20_000 });
  expect(started).toMatchObject({ code: 0 });
  const client = createDaemonClient({
    socketPath: join(root, "daemon", "control.sock"),
    token: (await readFile(join(root, "daemon", "control.token"), "utf8")).trim(),
    clientId: "thinking-picker", attachId: "thinking-picker-process", reconnect: false, maxBytes: 256 * 1024,
  });
  closers.push(() => client.close());
  await client.connect();
  const launched = await client.request({
    version: 1, clientId: "thinking-picker", requestId: "launch-thinking", op: "launch",
    payload: { prompt: "hold this session open", cwd: root, sourceSessionId: "dashboard-thinking-picker", isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: [] } },
  });
  if (!launched.ok) throw new Error(`Launch failed: ${JSON.stringify(launched)}`);
  const records = await new RegistryStore(join(root, "sessions")).list();
  if (records[0]?.ownership?.process !== undefined) await harness.record("launched worker", records[0].ownership.process);
  return { client, log, root, sessionId: launched.result.sessionId };
}

/** @param {any} client @param {string} sessionId */
async function attachedViewer(client, sessionId) {
  const terminal = new FakeTerminal();
  const viewer = await createStandaloneViewer({
    sessionId, client, terminal, onReturn: () => {},
    persistence: { async load() { return undefined; }, async save() {} },
  });
  closers.push(() => viewer.close());
  await viewer.open();
  await vi.waitFor(() => expect(painted(terminal)).toContain("no-model"), { timeout: 20_000, interval: 20 });
  return { terminal, viewer };
}

/** @param {string} log */
async function piCommands(log) {
  return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.kind === "command");
}

it("changes this session's thinking level from Ctrl+T through the daemon to Pi, and shows what Pi confirmed", async () => {
  const session = await liveSession({ FAKE_PI_THINKING_LEVELS: "off,low,high" });
  const { terminal } = await attachedViewer(session.client, session.sessionId);
  expect(painted(terminal)).toContain("thinking off");

  terminal.input("\x14");
  await vi.waitFor(() => expect(painted(terminal)).toContain("Select a thinking level"), { timeout: 20_000, interval: 20 });
  const picker = painted(terminal);
  for (const level of ["off", "low", "high"]) expect(picker).toContain(level);

  // Up from the current level wraps to the last one Pi offered.
  terminal.input("\x1b[A");
  terminal.input("\r");

  await vi.waitFor(async () => expect((await piCommands(session.log)).map((entry) => entry.command)).toContain("set_thinking_level"), { timeout: 20_000, interval: 50 });
  // The footer moves only once Pi's own thinking_level_changed event has travelled back.
  await vi.waitFor(() => expect(painted(terminal)).toContain("no-model • high"), { timeout: 20_000, interval: 20 });
  expect((await piCommands(session.log)).filter((entry) => entry.command === "set_thinking_level")).toHaveLength(1);
}, 90_000);

// Pi answers the thinking query per model, and a worker whose Pi does not answer it at all reports
// no levels. Opening a picker on nothing would leave the operator inside an empty list.
it("says the levels are unavailable rather than opening an empty picker", async () => {
  const session = await liveSession({ FAKE_PI_MISSING: "get_available_thinking_levels" });
  const { terminal } = await attachedViewer(session.client, session.sessionId);

  terminal.input("\x14");

  await vi.waitFor(() => expect(painted(terminal)).toContain("THINKING_LEVELS_UNAVAILABLE"), { timeout: 20_000, interval: 20 });
  expect(painted(terminal)).not.toContain("Select a thinking level");
  expect((await piCommands(session.log)).map((entry) => entry.command)).not.toContain("set_thinking_level");
}, 90_000);
