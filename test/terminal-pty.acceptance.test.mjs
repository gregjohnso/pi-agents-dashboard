import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

const ENTER_ALT_SCREEN = Buffer.from("\x1b[?1049h");
const EXIT_ALT_SCREEN = Buffer.from("\x1b[?1049l");
const SHOW_CURSOR = Buffer.from("\x1b[?25h");
const ENABLE_AUTOWRAP = Buffer.from("\x1b[?7h");
const FOCUSED_COMPOSER = Buffer.from("\u256d\u2500 prompt ");

it("navigates to New Session, quits with Ctrl+C, and restores the real terminal", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-dashboard-pty-"));
  const stateRoot = join(temporaryRoot, "state");
  const transcriptPath = join(temporaryRoot, "transcript");
  const env = {
    ...process.env,
    PI_DASHBOARD_STATE_DIR: stateRoot,
    TERM: "xterm-256color",
    COLUMNS: "80",
    LINES: "24",
  };
  const command = "node ./bin/pi-dashboard.mjs; code=$?; printf '\\n__STTY__\\n'; stty -a; exit \"$code\"";
  const child = spawn("script", ["-qfec", command, transcriptPath], {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = Buffer.alloc(0);
  let stage = "startup";
  const onOutput = (chunk) => {
    output = Buffer.concat([output, Buffer.from(chunk)]);
    if (stage === "startup" && output.includes(Buffer.from("describe a task for a new session"))) {
      stage = "down";
      child.stdin.write("\x1b[B");
    } else if (stage === "down" && output.includes(FOCUSED_COMPOSER)) {
      stage = "typing";
      child.stdin.write("x");
    } else if (stage === "typing" && output.includes(Buffer.from("❯ x"))) {
      stage = "quit";
      child.stdin.write("\x03");
    }
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);

  const timeout = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }, 45_000);
  let result;
  let transcript;
  let stopped;
  try {
    result = await new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    transcript = await readFile(transcriptPath);
  } finally {
    clearTimeout(timeout);
    stopped = spawnSync("node", ["./bin/pi-dashboard.mjs", "daemon", "stop"], {
      cwd: process.cwd(), env, encoding: "utf8", timeout: 10_000,
    });
    await rm(temporaryRoot, { recursive: true, force: true });
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
