import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "../runtime/process-signaler.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const ENTER_ALT_SCREEN = Buffer.from("\x1b[?1049h");
const EXIT_ALT_SCREEN = Buffer.from("\x1b[?1049l");
const SHOW_CURSOR = Buffer.from("\x1b[?25h");
const ENABLE_AUTOWRAP = Buffer.from("\x1b[?7h");
const harness = createRealProcessHarness("terminal-pty");

afterEach(() => harness.cleanup());

it("navigates to New Session, quits with Ctrl+C, and restores the real terminal", async () => {
  const temporaryRoot = await harness.stateRoot("pi-agents-pty-");
  const stateRoot = harness.daemonRoot(join(temporaryRoot, "state"));
  const transcriptPath = join(temporaryRoot, "transcript");
  const env = {
    ...process.env,
    PI_AGENTS_STATE_DIR: stateRoot,
    TERM: "xterm-256color",
    COLUMNS: "80",
    LINES: "24",
  };
  const command = "node ./bin/pi-agents.mjs; code=$?; printf '\\n__STTY__\\n'; stty -a; exit \"$code\"";
  const child = spawn("script", ["-qfec", command, transcriptPath], {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Recorded before anything is asserted: the dashboard this drives starts its own daemon, and a
  // test that times out here never reaches the code below that would stop either of them.
  const pty = await harness.record("pty session leader", await inspectProcessIdentity(/** @type {number} */ (child.pid)));
  let output = Buffer.alloc(0);
  let stage = "startup";
  const onOutput = (chunk) => {
    output = Buffer.concat([output, Buffer.from(chunk)]);
    if (stage === "startup" && output.includes(Buffer.from("pi-agents"))) {
      // Typing needs no navigation: the composer is not a focus stop.
      stage = "typing";
      child.stdin.write("x");
    } else if (stage === "typing" && output.includes(Buffer.from("❯ x"))) {
      stage = "quit";
      child.stdin.write("\x03");
    }
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);

  // The dashboard is driven by the bytes above, so nothing else ends this wait. The bound stops the
  // recorded process group by verified identity rather than by a bare PID, and the assertions below
  // then read the unfinished transcript and say what stage the interface reached.
  const timeout = setTimeout(() => {
    void stopVerifiedProcessGroup(pty, { inspect: inspectProcessIdentity, requestGraceful: async () => {}, signalProcessGroup, sleep }, { gracefulMs: 2_000, terminateMs: 2_000 });
  }, 45_000);
  let result;
  let transcript;
  let stopped;
  try {
    result = await new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    transcript = await readFile(transcriptPath);
  } finally {
    clearTimeout(timeout);
    // Through the installed executable, because that is the path an operator takes and the only one
    // that proves this entry point still stops a daemon it started under a real terminal.
    stopped = spawnSync("node", ["./bin/pi-agents.mjs", "daemon", "stop"], {
      cwd: process.cwd(), env, encoding: "utf8", timeout: 10_000,
    });
  }

  expect(stage).toBe("quit");
  expect(result).toEqual({ code: 0, signal: null });
  expect(stopped.status).toBe(0);
  expect(transcript.includes(ENTER_ALT_SCREEN)).toBe(true);
  expect(transcript.includes(EXIT_ALT_SCREEN)).toBe(true);
  expect(transcript.includes(SHOW_CURSOR)).toBe(true);
  expect(transcript.includes(ENABLE_AUTOWRAP)).toBe(true);
  expect(transcript.includes(Buffer.from("❯ x"))).toBe(true);

  const sttyMarker = transcript.indexOf(Buffer.from("__STTY__"));
  expect(sttyMarker).toBeGreaterThanOrEqual(0);
  const stty = transcript.subarray(sttyMarker).toString("utf8");
  expect(stty).toMatch(/(?:^|[\s;])isig(?:[\s;]|$)/u);
  expect(stty).toMatch(/(?:^|[\s;])icanon(?:[\s;]|$)/u);
  expect(stty).toMatch(/(?:^|[\s;])echo(?:[\s;]|$)/u);
}, 60_000);
