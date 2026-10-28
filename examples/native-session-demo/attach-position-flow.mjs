/**
 * The operator's symptom, reproduced and then asserted away: "look at where my text ends up when i type".
 *
 * This is a LOCAL reproduction at 181x79 against an ALREADY-RUNNING owner, entered repeatedly from the list, with
 * typing immediately after entry. It exists because the earlier evidence could only show input digests, owner
 * geometry and raw output strings - none of which is the editor's visible position.
 *
 * The screen and the cursor are read from tmux, a real terminal emulator, through its documented formats
 * (`#{cursor_x}`, `#{cursor_y}`) and `capture-pane`. Nothing here parses escape sequences, stitches wrapped rows
 * or reconstructs a screen: the emulator interprets the stream and is asked where its cursor is. A private
 * `-L` socket is used, so no existing tmux server is touched.
 *
 * Deterministic by construction: every wait is a barrier on the emulator's own content, and the only injected
 * timing is the fixture provider's own reply delay, which is a knob on the fake provider rather than a sleep in
 * this file. Fixture provider, disposable configuration, no operator credentials and no real model call.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER_DEMO = path.join(HERE, "manager-demo.mjs");
const NODE = process.execPath;
const COLS = 181;
const ROWS = 79;
/** How long any single content barrier waits. A barrier ends as soon as the screen says so. */
const BARRIER_MS = 120_000;
const POLL_MS = 100;

/** One isolated tmux server, so no existing session of the operator's is visible or reachable from here. */
function tmuxRunner(socketName) {
  const run = (args, { allowFailure = false } = {}) => {
    try {
      return execFileSync("tmux", ["-L", socketName, ...args], { encoding: "utf8", timeout: 30_000 });
    } catch (error) {
      if (allowFailure) return "";
      throw new Error(`tmux ${args.join(" ")} failed: ${error.stderr || error.message}`);
    }
  };
  return {
    run,
    /** The pane exactly as the emulator has it, one string per row. */
    pane: () => run(["capture-pane", "-p", "-t", "repro"]).split("\n"),
    /** The emulator's own cursor, which is what "where my text ends up" actually means. */
    cursor: () => {
      const [x, y] = run(["display-message", "-p", "-t", "repro", "#{cursor_x},#{cursor_y}"]).trim().split(",");
      return { x: Number(x), y: Number(y) };
    },
    keys: (...keys) => run(["send-keys", "-t", "repro", ...keys]),
    kill: () => run(["kill-server"], { allowFailure: true }),
  };
}

/** Wait until the emulator's own screen satisfies `predicate`. @param {(pane:string[])=>boolean} predicate */
async function until(tmux, predicate, description) {
  const deadline = Date.now() + BARRIER_MS;
  let pane = [];
  while (Date.now() < deadline) {
    pane = tmux.pane();
    if (predicate(pane)) return pane;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${description} never happened within ${BARRIER_MS}ms; pane tail was ${JSON.stringify(pane.slice(-14).join("\n"))}`);
}

/**
 * Where a piece of typed text actually is, and where the emulator's cursor actually is.
 *
 * The row is found by scanning the emulator's own rows for the text; the cursor is tmux's. "In the editor" is
 * decided by the cursor sharing the row with the text and sitting just past it - which is exactly the property
 * that failed for the operator, whose text landed in a row of attach notices while the editor stayed empty.
 */
function locate(tmux, typed) {
  const pane = tmux.pane();
  const cursor = tmux.cursor();
  const row = pane.findIndex((line) => line.includes(typed));
  const column = row === -1 ? -1 : pane[row].indexOf(typed) + typed.length;
  return { pane, cursor, row, column, onCursorRow: row === cursor.y, cursorJustPastText: row === cursor.y && cursor.x === column };
}

/** Diagnostics that must never appear on a screen Pi owns, and the echo an unmanaged cooked window produced. */
const FORBIDDEN_ON_SCREEN = ["attached as ", "notice:", "detached:", "\u001b[C", "^[[C", "[[C"];

function screenIsClean(pane) {
  const text = pane.join("\n");
  return FORBIDDEN_ON_SCREEN.filter((needle) => text.includes(needle));
}

async function statusOf(root) {
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(NODE, [path.join(HERE, "demo.mjs"), "status", "--root", root], { timeout: 60_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(`status failed: ${stderr || error.message}`)) : resolve({ stdout }));
  });
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

/**
 * @param {{ evidenceDir: string }} options
 */
export async function runAttachPositionFlow({ evidenceDir }) {
  await mkdir(evidenceDir, { recursive: true });
  const steps = [];
  const socketName = `pia-repro-${process.pid}`;
  const tmux = tmuxRunner(socketName);
  const home = await mkdtemp(path.join(tmpdir(), "pia-pos-home-"));
  const sessionsHome = await mkdtemp(path.join(tmpdir(), "pia-pos-sessions-"));
  const project = await mkdtemp(path.join(tmpdir(), "pia-pos-project-"));
  /** @type {string[]} */
  const created = [];
  try {
    await writeFile(path.join(project, "README.md"), "disposable project for the attach-position reproduction\n");
    // A disposable configuration root, a sibling of the sessions home so it is never listed as a session.
    const configRoot = path.join(path.dirname(sessionsHome), `${path.basename(sessionsHome)}-config`);
    await mkdir(configRoot, { recursive: true });

    tmux.run([
      "new-session", "-d", "-s", "repro", "-x", String(COLS), "-y", String(ROWS),
      "-e", `HOME=${home}`, "-e", `XDG_CONFIG_HOME=${configRoot}`, "-e", `TMPDIR=${path.join(home, "tmp")}`,
      // The fixture provider's own reply delay, so "streaming" is a real state this flow can enter - a knob on
      // the fake provider, not a sleep in this file.
      "-e", "PI_DEMO_FAKE_DELAY_MS=15000",
      "--", NODE, MANAGER_DEMO, "--sessions", sessionsHome, "--cwd", project,
    ]);
    await mkdir(path.join(home, "tmp"), { recursive: true });
    await until(tmux, (pane) => pane.some((line) => line.includes("Sessions")), "the dashboard's first paint");
    steps.push({ step: "dashboard-up-at-181x79", geometry: `${COLS}x${ROWS}` });

    // An ALREADY-RUNNING owner: launched, then left to run before any attachment is made.
    tmux.keys("a long running fixture task");
    await until(tmux, (pane) => pane.some((line) => line.includes("a long running fixture task")), "the prompt in the composer");
    tmux.keys("Enter");
    const rowPane = await until(tmux, (pane) => pane.some((line) => /session-\d{10,}/u.test(line)), "the session row");
    const sessionId = /session-(\d{10,})/u.exec(rowPane.find((line) => /session-\d{10,}/u.test(line)))[0];
    const root = path.join(sessionsHome, sessionId);
    created.push(root);
    // Wait for the owner to be genuinely up, from the manager's own readiness rather than a sleep.
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const status = await statusOf(root).catch(() => undefined);
      if (status?.readiness?.some((entry) => entry.phase === "native-mounted")) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    steps.push({ step: "owner-already-running-before-any-attachment", sessionId });

    /** Whether Pi itself says a run is in progress. Its own published facts, not a string on the screen. */
    const loopState = async () => {
      const facts = (await statusOf(root).catch(() => undefined))?.bridge?.facts ?? {};
      return { agentPhase: facts.agentPhase, idle: facts.idle, running: facts.agentPhase === "start" || facts.idle === false };
    };
    /** Wait until Pi's own facts report the loop running, or settled. @param {boolean} running */
    const untilLoop = async (running, description) => {
      const deadline = Date.now() + BARRIER_MS;
      let state = {};
      while (Date.now() < deadline) {
        state = await loopState();
        if (state.running === running) return state;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`${description}: Pi's own facts never reported running=${running}; last was ${JSON.stringify(state)}`);
    };

    /** One entry, immediate typing, a position check, and a return to the list. */
    const enterTypeAndReturn = async (label, typed, expectStreaming) => {
      const loopBefore = await loopState();
      tmux.keys("Right");
      // Pi's own screen is the barrier - not any diagnostic of ours, because there are none on screen any more.
      await until(tmux, (pane) => pane.some((line) => line.includes("0.0%") || line.includes("%/128k") || line.includes("deterministic-echo")), `${label}: Pi's own screen`);
      // Typed IMMEDIATELY after entry, which is when the old cooked-echo window used to swallow and echo keys.
      tmux.keys(typed);
      await until(tmux, (pane) => pane.some((line) => line.includes(typed)), `${label}: the typed text on Pi's screen`);
      const located = locate(tmux, typed);
      const dirty = screenIsClean(located.pane);
      // Pi's own report of its loop at the moment of entry. The context meter is always on screen, so it is
      // never used as a streaming signal.
      const streaming = loopBefore.running === true;
      const record = {
        step: `${label}-visible-editor-position`,
        typed,
        cursor: located.cursor,
        textRow: located.row,
        textEndColumn: located.column,
        cursorOnTextRow: located.onCursorRow,
        cursorJustPastText: located.cursorJustPastText,
        forbiddenOnScreen: dirty,
        loopAtEntry: loopBefore,
        enteredWhileRunning: streaming,
      };
      steps.push(record);
      // The emulator's own rows at the moment of the check, with the cursor row marked, so a reviewer sees the
      // screen the assertion was made against rather than only its numbers.
      await writeFile(
        path.join(evidenceDir, `${label}.pane.txt`),
        located.pane.map((line, index) => `${index === located.cursor.y ? "CURSOR>" : "       "}${String(index).padStart(3, " ")} ${line}`).join("\n")
          + `\n\n# emulator cursor x=${located.cursor.x} y=${located.cursor.y}; ${JSON.stringify(typed)} on row ${located.row} ending at column ${located.column}\n`,
      );
      if (located.row === -1) throw new Error(`${label}: the typed text is not on the screen at all`);
      if (!located.onCursorRow) throw new Error(`${label}: the emulator's cursor is on row ${located.cursor.y} but the typed text is on row ${located.row} - the text is not where the editor is`);
      if (!located.cursorJustPastText) throw new Error(`${label}: the cursor is at column ${located.cursor.x}, not just past the typed text at ${located.column}`);
      if (dirty.length > 0) throw new Error(`${label}: diagnostics or an echoed key reached Pi's display: ${JSON.stringify(dirty)}`);
      if (expectStreaming === true && !streaming) throw new Error(`${label}: expected to enter while Pi's loop was running, and its facts said ${JSON.stringify(loopBefore)}`);
      if (expectStreaming === false && streaming) throw new Error(`${label}: expected to enter with Pi's loop idle, and its facts said ${JSON.stringify(loopBefore)}`);
      // Back to the list through the existing return gesture; the owner is never signalled.
      tmux.keys("C-a");
      tmux.keys("Left");
      tmux.keys("Left");
      await until(tmux, (pane) => pane.some((line) => line.includes("Sessions")), `${label}: the list again`);
      return record;
    };

    // 1. Entered while the fixture's reply is genuinely still streaming, by Pi's own account.
    await untilLoop(true, "the fixture's run starting");
    await enterTypeAndReturn("streaming-entry", "typed while streaming", true);
    // 2. Entered again, now idle, and the draft from the first entry must still be there.
    tmux.keys("Right");
    await until(tmux, (pane) => pane.some((line) => line.includes("typed while streaming")), "the retained draft on reopen");
    steps.push({ step: "draft-retained-across-list-session-list" });
    tmux.keys("C-a");
    tmux.keys("Left");
    tmux.keys("Left");
    await until(tmux, (pane) => pane.some((line) => line.includes("Sessions")), "the list after the draft check");
    // 3. A third entry with the loop IDLE, so the position is shown to hold in both states.
    await untilLoop(false, "the fixture's run settling");
    await enterTypeAndReturn("idle-entry", " and again", false);

    // Every supported attachment got its OWN fresh native presentation.
    const status = await statusOf(root);
    const presented = (status.presentations ?? []).filter((entry) => entry.result?.presented === true);
    const failed = (status.presentations ?? []).filter((entry) => entry.result?.presented !== true);
    steps.push({
      step: "every-supported-attach-got-a-fresh-native-presentation",
      attachments: (status.presentations ?? []).length,
      presented: presented.length,
      failedOrRefused: failed.length,
      epochs: presented.map((entry) => entry.epoch),
    });
    if (presented.length < 3) throw new Error(`expected a fresh presentation for each of the 3 attachments, saw ${presented.length}: ${JSON.stringify(status.presentations)}`);
    if (status.owner?.pid === undefined) throw new Error("the owner is gone");
    steps.push({ step: "owner-still-alive-after-every-cycle", ownerPid: status.owner.pid });

    // The attachment's diagnostics exist - off the terminal, where they belong.
    const diagnostics = await readFile(path.join(root, "attach-diagnostics.log"), "utf8").catch(() => "");
    if (!diagnostics.includes("attached as ")) throw new Error("the attachment recorded no diagnostics off-terminal");
    steps.push({ step: "diagnostics-recorded-off-terminal", lines: diagnostics.trim().split("\n").length });

    const record = { passed: true, geometry: `${COLS}x${ROWS}`, sessionsHome, root, steps, atMs: Date.now() };
    await writeFile(path.join(evidenceDir, "attach-position-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(evidenceDir, "attach-position.pane.txt"), tmux.pane().join("\n"));
    return record;
  } catch (error) {
    await writeFile(path.join(evidenceDir, "attach-position-result.json"),
      `${JSON.stringify({ passed: false, steps, failure: error.message, atMs: Date.now() }, null, 2)}\n`).catch(() => {});
    await writeFile(path.join(evidenceDir, "attach-position.pane.txt"), tmux.pane().join("\n")).catch(() => {});
    throw error;
  } finally {
    for (const root of created) {
      await new Promise((resolve) => execFile(NODE, [path.join(HERE, "demo.mjs"), "stop", "--root", root], { timeout: 60_000 }, () => resolve(undefined)));
    }
    tmux.kill();
    for (const directory of [home, sessionsHome, project]) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--evidence");
  const evidenceDir = index === -1 ? path.join(tmpdir(), "attach-position-evidence") : path.resolve(process.argv[index + 1]);
  runAttachPositionFlow({ evidenceDir })
    .then((record) => console.log(JSON.stringify(record, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
