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
 * What the operator does: attach to a session, press Pi's own Shift+Tab and Ctrl+T.
 *
 * This drives the real terminal path — alternate-screen input, the viewer, the daemon socket, a real
 * worker, and a bounded fake Pi — so a key that reaches nothing, a level that never gets to Pi, a
 * footer that claims a level Pi never confirmed, or a thinking toggle that asks Pi for anything at
 * all is a failure here.
 */

const fakePiSource = await readFile(fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url)), "utf8");
const harness = createRealProcessHarness("thinking-keys-acceptance");
/** @type {any[]} */
const closers = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
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
  const root = await harness.stateRoot("pi-agents-thinking-keys-", ["canonical", "daemon", "sessions", "runs", "index"]);
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
    clientId: "thinking-keys", attachId: "thinking-keys-process", reconnect: false, maxBytes: 256 * 1024,
  });
  closers.push(() => client.close());
  await client.connect();
  const launched = await client.request({
    version: 1, clientId: "thinking-keys", requestId: "launch-thinking", op: "launch",
    payload: { prompt: "hold this session open", cwd: root, sourceSessionId: "dashboard-thinking-keys", isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: [] } },
  });
  if (!launched.ok) throw new Error(`Launch failed: ${JSON.stringify(launched)}`);
  const records = await new RegistryStore(join(root, "sessions")).list();
  if (records[0]?.ownership?.process !== undefined) await harness.record("launched worker", records[0].ownership.process);
  return { client, log, root, sessionId: launched.result.sessionId };
}

/**
 * One attached viewer whose keys come from an empty Pi agent directory: Pi reads
 * `PI_CODING_AGENT_DIR` for the operator's own `keybindings.json`, and a remap of his would
 * otherwise decide what this test presses.
 * @param {any} client @param {string} sessionId @param {string} agentDir
 */
async function attachedViewer(client, sessionId, agentDir) {
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
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

it("cycles this session's thinking level from Shift+Tab through the daemon to Pi, and shows what Pi confirmed", async () => {
  const session = await liveSession({ FAKE_PI_THINKING_LEVELS: "off,low,high" });
  const { terminal } = await attachedViewer(session.client, session.sessionId, session.root);
  expect(painted(terminal)).toContain("thinking off");

  terminal.input("\x1b[Z");

  await vi.waitFor(async () => expect((await piCommands(session.log)).map((entry) => entry.command)).toContain("set_thinking_level"), { timeout: 20_000, interval: 50 });
  // The footer moves only once Pi's own thinking_level_changed event has travelled back.
  await vi.waitFor(() => expect(painted(terminal)).toContain("no-model • low"), { timeout: 20_000, interval: 20 });
  const sent = await piCommands(session.log);
  expect(sent.filter((entry) => entry.command === "set_thinking_level")).toHaveLength(1);
  expect(painted(terminal)).not.toContain("Select a thinking level");
  // Reading this session's menu is a Pi `get_state`, and the viewer normalizer republishes each of
  // those as a `model_state` event. A viewer that reloads its menu on every one of them asks again
  // forever: the run that found this logged 11,732 Pi commands here and the operator's key never got
  // through. Measured after the repair: 3 `get_state` for this whole attach, key press and
  // confirmation. The bound is what makes a returning loop fail here rather than time out.
  expect(sent.filter((entry) => entry.command === "get_state").length).toBeLessThan(40);
}, 90_000);

// Ctrl+T is about what this transcript shows, so it must reach Pi with nothing at all.
it("hides thinking blocks on Ctrl+T without sending Pi a command", async () => {
  const session = await liveSession({ FAKE_PI_THINKING_LEVELS: "off,low,high" });
  const { terminal } = await attachedViewer(session.client, session.sessionId, session.root);

  terminal.input("\x14");

  await vi.waitFor(() => expect(painted(terminal)).toContain("Thinking blocks: hidden"), { timeout: 20_000, interval: 20 });
  // The worker keeps reading state on its own, so what matters is that no level and no prompt moved.
  expect((await piCommands(session.log)).map((entry) => entry.command)).not.toContain("set_thinking_level");
  expect(painted(terminal)).toContain("thinking off");
}, 90_000);

// Pi answers the thinking query per model, and a worker whose Pi does not answer it at all reports
// no levels. Cycling into nothing would send Pi a level it never offered.
it("says the levels are unavailable rather than sending a level Pi never offered", async () => {
  const session = await liveSession({ FAKE_PI_MISSING: "get_available_thinking_levels" });
  const { terminal } = await attachedViewer(session.client, session.sessionId, session.root);

  terminal.input("\x1b[Z");

  await vi.waitFor(() => expect(painted(terminal)).toContain("THINKING_LEVELS_UNAVAILABLE"), { timeout: 20_000, interval: 20 });
  expect((await piCommands(session.log)).map((entry) => entry.command)).not.toContain("set_thinking_level");
}, 90_000);
