// Keypress-to-frame latency and byte volume for the list <-> viewer transition, under a real PTY.
// Usage: node perf/transition-latency.mjs [--base <dir>] [--sessions N] [--items N] [--repeats N] [--label name] [--stream-ms N]
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
// Frames every STREAM_MS from every fake Pi, so the transition competes with its own session's ingest.
const STREAM_MS = option("stream-ms", "");

const VIEWER_MARK = Buffer.from("COMPOSER");
const LIST_MARK = Buffer.from("pi-agents");
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
    ...(PHASE_LOG === "" ? {} : { PI_AGENTS_PERF_LOG: PHASE_LOG, PI_AGENTS_DAEMON_PERF_LOG: `${PHASE_LOG}.daemon` }),
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
  // One deep transcript, so the session the measurement opens carries a realistic item count.
  const deep = sessionIds[0];
  const attached = await request("attach", { sessionId: deep, role: "composer", activate: true });
  if (!attached.ok) throw new Error(`attach failed: ${JSON.stringify(attached.error)}`);
  for (let index = 0; index < ITEMS; index += 1) {
    const sent = await request("follow_up", { sessionId: deep, text: `perf item ${index}` });
    if (!sent.ok) throw new Error(`follow_up failed: ${JSON.stringify(sent.error)}`);
  }
  await request("detach", { sessionId: deep });
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

  const results = { label: LABEL, keystroke: [], enter: [], back: [] };
  try {
    await waitFor(LIST_MARK, 0, 0, 120_000);
    await quiesce();
    // Home selects the first row, which owns the deep transcript.
    child.stdin.write("\x1b[H");
    await sleep(300);
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

    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      // Home re-selects the deep row and flushes anything the input tap is still holding.
      child.stdin.write("\x1b[H");
      await sleep(250);
      await quiesce();
      let from = buffer.length;
      let bytesFrom = bytes;
      let startedAt = Date.now();
      child.stdin.write("\r");
      const enter = await waitFor(VIEWER_MARK, from, bytesFrom);
      await quiesce();
      results.enter.push({ ms: enter.ms, bytes: enter.bytes, settledMs: Date.now() - startedAt, settledBytes: bytes - bytesFrom });

      from = buffer.length;
      bytesFrom = bytes;
      startedAt = Date.now();
      child.stdin.write("\x1b");
      // A dead first Escape is the symptom under test: after 2 s the operator presses again.
      let presses = 1;
      let back;
      try {
        back = await waitFor(LIST_MARK, from, bytesFrom, 2_000);
      } catch {
        presses = 2;
        child.stdin.write("\x1b");
        await waitFor(LIST_MARK, from, bytesFrom, 20_000);
        back = { ms: Date.now() - startedAt, bytes: bytes - bytesFrom };
      }
      await quiesce();
      results.back.push({ ms: back.ms, bytes: back.bytes, presses, settledMs: Date.now() - startedAt, settledBytes: bytes - bytesFrom });
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
    const pick = (key) => [...samples].map((sample) => sample[key]).sort((left, right) => left - right);
    const median = (values) => values[Math.floor(values.length / 2)];
    const ms = pick("ms");
    return {
      n: samples.length, msMedian: median(ms), msMin: ms[0], msMax: ms[ms.length - 1],
      presses: samples.map((sample) => sample.presses).filter((value) => value !== undefined),
      bytesMedian: median(pick("bytes")),
      settledMsMedian: median(pick("settledMs")), settledBytesMedian: median(pick("settledBytes")),
    };
  };
  console.log(JSON.stringify({
    label: LABEL, base: BASE, sessions: SESSIONS, items: ITEMS, streamMs: STREAM_MS,
    loadavg: (await readFile("/proc/loadavg", "utf8")).trim(),
    keystroke: summarize(results.keystroke), enter: summarize(results.enter), back: summarize(results.back), raw: results,
  }, undefined, 2));
  // A daemon that is still unlinking its own files can lose a race with this cleanup.
  await rm(root, { recursive: true, force: true }).catch(async () => { await sleep(2_000); await rm(root, { recursive: true, force: true }).catch(() => {}); });
}

await main();
