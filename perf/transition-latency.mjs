// Keypress-to-frame latency and byte volume for the list <-> viewer transition, under a real PTY.
// Usage: node perf/transition-latency.mjs [--base <dir>] [--sessions N] [--items N] [--repeats N] [--label name] [--stream-ms N]
//
// The gestures are the operator's own: Right opens the selected session, Left returns to the list.
// Three things about the previous version measured nothing after the native viewer layout landed,
// and each is asserted against rather than assumed here:
//   - `Alt+Enter follow-up` is no longer painted; the hints line is Pi's own lowercase key text.
//   - `pi-agents` appears in the viewer's own header, so it could not tell a return from an entry.
//   - Home is `tui.altScreen.top` now, so it scrolls the viewport instead of selecting the first row.
// Every session is given the same transcript depth, so no row selection is needed at all.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { runDaemonCommand } from "../cli/daemon-commands.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const BASE = option("base", tmpdir());
const SESSIONS = Number(option("sessions", "6"));
const ITEMS = Number(option("items", "60"));
const REPEATS = Number(option("repeats", "7"));
const LABEL = option("label", "run");
const PHASE_LOG = option("phase-log", "");
// `immediate` adds the operator who does not wait: one keystroke and one Right sent the moment the
// list first paints, which is when it is still paying for Pi's own components on that keypress.
const MODE = option("mode", "settled");
// Frames every STREAM_MS from every fake Pi, so the transition competes with its own session's ingest.
const STREAM_MS = option("stream-ms", "");

// One mark each, and neither can appear on the other surface: the hints line is the viewer's own and
// the list draws no such line, and the session panel's border title is the list's own. `checkMarks`
// fails the run if either ever shows up on the wrong screen.
const VIEWER_MARK = Buffer.from("alt+enter follow-up");
const LIST_MARK = Buffer.from("\u256d\u2500 Sessions");
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const QUIET_MS = 400;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  const root = await mkdtemp(join(BASE, "pi-agents-perf-"));
  const executable = join(root, "pi");
  await writeFile(executable, await readFile(fileURLToPath(new URL("../test/fixtures/fake-pi.mjs", import.meta.url)), "utf8"), { mode: 0o700 });
  await chmod(executable, 0o700);
  const env = {
    ...process.env,
    PI_AGENTS_STATE_DIR: root,
    FAKE_PI_EVENT_AFTER_COMMAND: "follow_up",
    TERM: "xterm-256color",
    COLUMNS: "120",
    LINES: "40",
    // The frontend's own stage marks for one transition: attached, list-closed, viewer-open,
    // viewer-closed, list-reopened, each in milliseconds from the keypress that started it.
    ...(PHASE_LOG === "" ? {} : { PI_AGENTS_UI_TIMING: PHASE_LOG }),
    ...(STREAM_MS === "" ? {} : { FAKE_PI_STREAM_MS: STREAM_MS }),
  };

  // Start the daemon before the pseudo-terminal: a loaded box can miss the frontend's 15 s deadline.
  const started = await runDaemonCommand("start", { root, piBin: executable, env, timeoutMs: 180_000 });
  if (started.code !== 0) throw new Error(`daemon start failed: ${JSON.stringify(started.error)}`);

  const token = (await readFile(join(root, "daemon", "control.token"), "utf8")).trim();
  const client = createDaemonClient({ socketPath: join(root, "daemon", "control.sock"), token, clientId: "perf-harness", reconnect: false, maxBytes: 1024 * 1024 });
  await client.connect();
  const request = (op, payload) => client.request({ version: 1, clientId: "perf-harness", requestId: randomUUID(), op, payload });

  const sessionIds = [];
  for (let index = 0; index < SESSIONS; index += 1) {
    const launched = await request("launch", { prompt: `perf session ${index}`, cwd: root, sourceSessionId: "perf-harness", isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: sessionIds.slice() } });
    if (!launched.ok) throw new Error(`launch failed: ${JSON.stringify(launched.error)}`);
    sessionIds.push(launched.result.sessionId);
  }
  // Every session carries the same transcript depth, so whichever row the list selects on its own is
  // the one this opens and the sample does not depend on a sort order or on a selection keystroke.
  for (const sessionId of sessionIds) {
    const attached = await request("attach", { sessionId, activate: true });
    if (!attached.ok) throw new Error(`attach failed: ${JSON.stringify(attached.error)}`);
    for (let index = 0; index < ITEMS; index += 1) {
      const sent = await request("follow_up", { sessionId, text: `perf item ${index}` });
      if (!sent.ok) throw new Error(`follow_up failed: ${JSON.stringify(sent.error)}`);
    }
    await request("detach", { sessionId });
  }
  await client.close();

  const transcriptPath = join(root, "transcript");
  const child = spawn("script", ["-qfec", `node ./bin/pi-agents.mjs --pi-bin ${executable}`, transcriptPath], { cwd: process.cwd(), env, detached: true, stdio: ["pipe", "pipe", "pipe"] });

  let buffer = Buffer.alloc(0);
  let bytes = 0;
  let lastOutputAt = Date.now();
  const onOutput = (chunk) => {
    const data = Buffer.from(chunk);
    buffer = Buffer.concat([buffer, data]);
    bytes += data.length;
    lastOutputAt = Date.now();
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);

  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
  const guard = setTimeout(kill, 300_000);

  /** Wait until output past `from` contains `mark`; report elapsed ms and bytes since the keypress. */
  async function waitFor(mark, from, bytesFrom, deadlineMs = 30_000) {
    const startedAt = Date.now();
    for (;;) {
      if (buffer.indexOf(mark, from) !== -1) return { ms: Date.now() - startedAt, bytes: bytes - bytesFrom };
      if (Date.now() - startedAt > deadlineMs) throw new Error(`Timed out waiting for ${mark}\n--- tail ---\n${buffer.toString("utf8").slice(-2000)}`);
      await sleep(1);
    }
  }

  // A streaming session never goes quiet, so the wait is bounded rather than unconditional.
  async function quiesce(maxMs = 5_000) {
    const startedAt = Date.now();
    for (;;) {
      if (Date.now() - lastOutputAt >= QUIET_MS || Date.now() - startedAt >= maxMs) return;
      await sleep(20);
    }
  }

  /** Fail loudly if a mark ever appears on the surface it is supposed to tell apart. @param {Buffer} absent */
  function checkMarks(from, absent, surface) {
    if (buffer.indexOf(absent, from) !== -1) throw new Error(`${absent} appeared on the ${surface} screen; this measurement cannot tell the two surfaces apart`);
  }

  const results = { label: LABEL, mode: MODE, keystroke: [], right: [], left: [], immediate: undefined, firstPaintMs: undefined };
  const spawnedAt = Date.now();
  try {
    await waitFor(LIST_MARK, 0, 0, 120_000);
    results.firstPaintMs = Date.now() - spawnedAt;

    if (MODE === "immediate") {
      // Nothing is quiesced and nothing is waited for: this is the cost the operator pays when he
      // does not pause after the list appears.
      let from = buffer.length;
      let bytesFrom = bytes;
      child.stdin.write("z");
      const warmupKeystroke = await waitFor(Buffer.from("❯ z"), from, bytesFrom, 60_000);
      child.stdin.write("\x7f");
      from = buffer.length;
      bytesFrom = bytes;
      child.stdin.write(RIGHT);
      const entered = await waitFor(VIEWER_MARK, from, bytesFrom, 120_000);
      checkMarks(from, LIST_MARK, "viewer");
      await quiesce();
      from = buffer.length;
      bytesFrom = bytes;
      child.stdin.write(LEFT);
      const returned = await waitFor(LIST_MARK, from, bytesFrom, 60_000);
      results.immediate = { keystrokeMs: warmupKeystroke.ms, rightMs: entered.ms, leftMs: returned.ms };
    }
    await quiesce();

    // Floor: one printable key echoed into the list composer, same pseudo-terminal path.
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const from = buffer.length;
      const bytesFrom = bytes;
      child.stdin.write("z");
      const echo = await waitFor(Buffer.from("❯ z"), from, bytesFrom, 10_000);
      results.keystroke.push({ ms: echo.ms, bytes: echo.bytes, settledMs: echo.ms, settledBytes: echo.bytes });
      await quiesce();
      child.stdin.write("\x7f");
      await sleep(150);
      await quiesce();
    }

    // The first cycle of a process pays the viewer's dynamic imports; the rest do not. They are
    // reported apart because they are different questions, and averaging them hides both.
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const listFrom = buffer.length;
      let bytesFrom = bytes;
      let startedAt = Date.now();
      child.stdin.write(RIGHT);
      const entered = await waitFor(VIEWER_MARK, listFrom, bytesFrom);
      checkMarks(listFrom, LIST_MARK, "viewer");
      await quiesce();
      results.right.push({ cold: repeat === 0, ms: entered.ms, bytes: entered.bytes, settledMs: Date.now() - startedAt, settledBytes: bytes - bytesFrom });

      const viewerFrom = buffer.length;
      bytesFrom = bytes;
      startedAt = Date.now();
      // One Left, because this frontend never typed into the prompt: that is the clean-left gesture.
      child.stdin.write(LEFT);
      const returned = await waitFor(LIST_MARK, viewerFrom, bytesFrom);
      checkMarks(viewerFrom, VIEWER_MARK, "list");
      await quiesce();
      results.left.push({ cold: repeat === 0, ms: returned.ms, bytes: returned.bytes, settledMs: Date.now() - startedAt, settledBytes: bytes - bytesFrom });
    }

    child.stdin.write("\x03");
    await Promise.race([new Promise((resolve) => child.on("exit", resolve)), sleep(15_000)]);
  } finally {
    clearTimeout(guard);
    kill();
    await runDaemonCommand("stop", { root, env, allowLiveWorkers: true, stopWorkers: true, yes: true }).catch(() => {});
    await sleep(300);
  }

  const summarize = (samples) => {
    if (samples.length === 0) return { n: 0 };
    const pick = (key) => [...samples].map((sample) => sample[key]).sort((left, right) => left - right);
    const median = (values) => values[Math.floor(values.length / 2)];
    const ms = pick("ms");
    return {
      n: samples.length, msMedian: median(ms), msMin: ms[0], msMax: ms[ms.length - 1],
      bytesMedian: median(pick("bytes")),
      settledMsMedian: median(pick("settledMs")), settledBytesMedian: median(pick("settledBytes")),
    };
  };
  const cold = (samples) => summarize(samples.filter((sample) => sample.cold));
  const warm = (samples) => summarize(samples.filter((sample) => !sample.cold));
  const stages = PHASE_LOG === "" ? undefined : await readFile(PHASE_LOG, "utf8").then((text) => {
    const byStage = {};
    for (const line of text.trim().split("\n").filter(Boolean)) {
      const [, stage, elapsed] = line.split(" ");
      (byStage[stage] ??= []).push(Number.parseInt(elapsed, 10));
    }
    return byStage;
  }).catch(() => undefined);
  console.log(JSON.stringify({
    label: LABEL, base: BASE, sessions: SESSIONS, items: ITEMS, streamMs: STREAM_MS,
    loadavg: (await readFile("/proc/loadavg", "utf8")).trim(),
    mode: MODE, firstPaintMs: results.firstPaintMs, immediate: results.immediate,
    keystroke: summarize(results.keystroke),
    rightCold: cold(results.right), rightWarm: warm(results.right),
    leftCold: cold(results.left), leftWarm: warm(results.left),
    stages, raw: results,
  }, undefined, 2));
  // A daemon that is still unlinking its own files can lose a race with this cleanup.
  await rm(root, { recursive: true, force: true }).catch(async () => { await sleep(2_000); await rm(root, { recursive: true, force: true }).catch(() => {}); });
}

await main();
