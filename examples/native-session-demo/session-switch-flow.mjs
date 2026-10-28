/**
 * Does native `/new` and `/resume` survive the manager's attachment?
 *
 * Diagnosis first: this flow does not assume where the break is. It drives the ACTUAL launcher, types the real
 * commands into the real Pi, and reads STRUCTURED identity facts the owner already publishes - `sessionId`,
 * `sessionFile` and the owner pid - so "a new session started" and "the same Pi is still alive" are answered from
 * the owner's own report rather than from anything scraped off a screen.
 *
 * Fixture only: disposable HOME, XDG_CONFIG_HOME, sessions home and project, the demo's own fake provider, and a
 * previous session this flow created itself. No operator configuration, provider, credentials or live transcript is
 * read, and no live root is touched.
 *
 * Per-owner private session store: each owner runs with its own HOME, so `/resume` can only ever see sessions that
 * owner created. That boundary is deliberate and is disclosed rather than worked around.
 */

import { execFileSync, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER_DEMO = path.join(HERE, "manager-demo.mjs");
const DEMO = path.join(HERE, "demo.mjs");
const NODE = process.execPath;
const COLS = 181;
const ROWS = 79;
const BARRIER_MS = 180_000;
const POLL_MS = 150;

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
    pane: () => run(["capture-pane", "-p", "-t", "switch"]).split("\n"),
    cursor: () => {
      const [x, y] = run(["display-message", "-p", "-t", "switch", "#{cursor_x},#{cursor_y}"]).trim().split(",");
      return { x: Number(x), y: Number(y) };
    },
    keys: (...keys) => run(["send-keys", "-t", "switch", ...keys]),
    literal: (text) => run(["send-keys", "-l", "-t", "switch", text]),
    alive: () => run(["list-sessions"], { allowFailure: true }).includes("switch"),
    kill: () => run(["kill-server"], { allowFailure: true }),
  };
}

async function until(tmux, predicate, description) {
  const deadline = Date.now() + BARRIER_MS;
  let pane = [];
  while (Date.now() < deadline) {
    pane = tmux.pane();
    if (predicate(pane)) return pane;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${description} never happened within ${BARRIER_MS}ms; pane tail was ${JSON.stringify(pane.slice(-18).join("\n"))}`);
}

function statusOf(root) {
  return new Promise((resolve, reject) => {
    execFile(NODE, [DEMO, "status", "--root", root], { timeout: 60_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(`status failed: ${stderr || error.message}`)) : resolve(JSON.parse(stdout.slice(stdout.indexOf("{")))));
  });
}

/** The owner's own report of which session it is on, and whether it is the same process. */
async function identity(root) {
  const status = await statusOf(root).catch(() => undefined);
  const facts = status?.bridge?.facts ?? {};
  return {
    ownerPid: status?.owner?.pid ?? null,
    startIdentity: status?.owner?.startIdentity ?? null,
    sessionId: typeof facts.sessionId === "string" ? facts.sessionId : null,
    sessionFile: typeof facts.sessionFile === "string" ? facts.sessionFile : null,
    agentPhase: facts.agentPhase ?? null,
    sessionName: typeof facts.sessionName === "string" ? facts.sessionName : null,
  };
}

/** Wait until the owner reports a session identity that satisfies `predicate`. */
async function untilIdentity(root, predicate, description) {
  const deadline = Date.now() + BARRIER_MS;
  let seen;
  while (Date.now() < deadline) {
    seen = await identity(root);
    if (predicate(seen)) return seen;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${description} never happened; last identity was ${JSON.stringify(seen)}`);
}

/** Type into Pi's editor and confirm the bytes actually land there, which is what "input works" means. */
async function typingWorks(tmux, text, label) {
  tmux.literal(text);
  const pane = await until(tmux, (lines) => lines.some((line) => line.includes(text)), `${label}: ${JSON.stringify(text)} in Pi's editor`);
  const cursor = tmux.cursor();
  const row = pane.findIndex((line) => line.includes(text));
  const column = row === -1 ? -1 : pane[row].indexOf(text) + text.length;
  return { text, row, column, cursor, cursorJustPastText: row === cursor.y && cursor.x === column };
}

/** Clear whatever is in Pi's editor, so the next command is typed alone. */
async function clearEditor(tmux, previous) {
  for (let index = 0; index < previous.length + 6; index += 1) tmux.keys("BSpace");
  await until(tmux, (lines) => !lines.some((line) => line.includes(previous)), "the editor cleared");
}

/** @param {{ evidenceDir: string }} options */
export async function runSessionSwitchFlow({ evidenceDir }) {
  await mkdir(evidenceDir, { recursive: true });
  const steps = [];
  const socketName = `pia-switch-${process.pid}`;
  const tmux = tmuxRunner(socketName);
  const home = await mkdtemp(path.join(tmpdir(), "pia-switch-home-"));
  const sessionsHome = await mkdtemp(path.join(tmpdir(), "pia-switch-sessions-"));
  const project = await mkdtemp(path.join(tmpdir(), "pia-switch-project-"));
  /** @type {string[]} */
  const created = [];
  const snap = async (name) => {
    await writeFile(path.join(evidenceDir, `${name}.pane.txt`), tmux.pane().join("\n") + "\n").catch(() => {});
  };
  try {
    await writeFile(path.join(project, "README.md"), "disposable project for the native session-switch reproduction\n");
    const configRoot = path.join(path.dirname(sessionsHome), `${path.basename(sessionsHome)}-config`);
    await mkdir(configRoot, { recursive: true });
    await mkdir(path.join(home, "tmp"), { recursive: true });

    tmux.run([
      "new-session", "-d", "-s", "switch", "-x", String(COLS), "-y", String(ROWS),
      "-e", `HOME=${home}`, "-e", `XDG_CONFIG_HOME=${configRoot}`, "-e", `TMPDIR=${path.join(home, "tmp")}`,
      "--", NODE, MANAGER_DEMO, "--sessions", sessionsHome, "--cwd", project,
    ]);
    await until(tmux, (pane) => pane.some((line) => line.includes("Sessions")), "the dashboard's first paint");

    // One session, launched the way an operator launches one.
    const task = "first fixture task";
    tmux.literal(task);
    await until(tmux, (pane) => pane.some((line) => line.includes(task)), "the prompt in the composer");
    tmux.keys("Enter");
    const rowPane = await until(tmux, (pane) => pane.some((line) => /session-\d{10,}/u.test(line)), "the session row");
    const sessionDir = /session-\d{10,}/u.exec(rowPane.find((line) => /session-\d{10,}/u.test(line)))[0];
    const root = path.join(sessionsHome, sessionDir);
    created.push(root);
    const atLaunch = await untilIdentity(root, (seen) => seen.sessionId !== null, "the owner reporting its first session identity");
    steps.push({ step: "launched", sessionDir, atLaunch });

    // Open it and establish a baseline: input reaches Pi's editor before any switch.
    tmux.keys("Right");
    await until(tmux, (pane) => pane.some((line) => line.includes("%/128k") || line.includes("deterministic-echo")), "Pi's own screen");
    const baseline = await typingWorks(tmux, "baseline typing before any switch", "baseline");
    steps.push({ step: "baseline-input-works", ...baseline });
    await snap("01-baseline");
    await clearEditor(tmux, baseline.text);

    // ---- /new ----
    tmux.literal("/new");
    await until(tmux, (pane) => pane.some((line) => line.includes("/new")), "/new in Pi's editor");
    await snap("02-new-typed");
    tmux.keys("Enter");
    // The owner's OWN identity report is the evidence a new session began, not anything on screen.
    let afterNew;
    let newFailure;
    try {
      afterNew = await untilIdentity(root, (seen) => seen.sessionId !== null && seen.sessionId !== atLaunch.sessionId, "a NEW session identity after /new");
    } catch (error) {
      newFailure = error.message;
      afterNew = await identity(root);
    }
    await snap("03-after-new");
    const newInput = newFailure === undefined
      ? await typingWorks(tmux, "typing after slash new", "after /new").catch((error) => ({ failure: error.message }))
      : { skipped: "no new identity was reported" };
    steps.push({
      step: "slash-new",
      identityChanged: afterNew.sessionId !== null && afterNew.sessionId !== atLaunch.sessionId,
      samePiProcess: afterNew.ownerPid !== null && afterNew.ownerPid === atLaunch.ownerPid,
      before: atLaunch,
      after: afterNew,
      inputAfter: newInput,
      failure: newFailure ?? null,
    });
    await snap("04-after-new-typing");

    // ---- /resume ----
    // Only a session this fixture's own owner created can be resumed: the owner has a private HOME, so its
    // session store contains exactly what it made here.
    if (newInput.text !== undefined) await clearEditor(tmux, newInput.text);
    tmux.literal("/resume");
    await until(tmux, (pane) => pane.some((line) => line.includes("/resume")), "/resume in Pi's editor");
    tmux.keys("Enter");
    let picker;
    let resumeFailure;
    try {
      picker = await until(
        tmux,
        (pane) => pane.some((line) => /resume|session/iu.test(line) && !line.includes("/resume")),
        "the native resume picker",
      );
      await snap("05-resume-picker");
    } catch (error) {
      resumeFailure = error.message;
      await snap("05-resume-picker-missing");
    }
    let afterResume = await identity(root);
    let resumeInput = { skipped: "the picker never appeared" };
    if (resumeFailure === undefined) {
      // Take the picker's own default selection: this flow does not guess at key bindings beyond Enter.
      tmux.keys("Enter");
      afterResume = await identity(root);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      afterResume = await identity(root);
      await snap("06-after-resume");
      resumeInput = await typingWorks(tmux, "typing after slash resume", "after /resume").catch((error) => ({ failure: error.message }));
      await snap("07-after-resume-typing");
    }
    steps.push({
      step: "slash-resume",
      pickerAppeared: resumeFailure === undefined,
      samePiProcess: afterResume.ownerPid !== null && afterResume.ownerPid === atLaunch.ownerPid,
      after: afterResume,
      inputAfter: resumeInput,
      failure: resumeFailure ?? null,
    });

    // The initial prompt must not be resubmitted when session_start fires again for a switch.
    const promptFile = `${root}.prompt`;
    const claimed = `${promptFile}.claimed`;
    const preload = await readFile(path.join(root, "owner-preload.jsonl"), "utf8").catch(() => "");
    steps.push({
      step: "initial-prompt-not-resubmitted",
      pendingPromptFileRemains: await readFile(promptFile, "utf8").then(() => true).catch(() => false),
      claimedMarkerPresent: await readFile(claimed, "utf8").then(() => true).catch(() => false),
      preloadDispatchRefusals: preload.split("\n").filter((line) => line.includes("dispatchFailed") || line.includes("stale-binding") || line.includes("target-revoked")).slice(0, 6),
    });

    // The composer's own answer to the same two commands, on the real list. This is what the operator actually
    // hit: the in-Pi commands work, and typing them HERE used to be a dead end.
    // (Checked after returning to the list, below.)

    // Return to the list and reopen, so a switch has not broken the manager's own navigation.
    tmux.keys("C-a");
    await new Promise((resolve) => setTimeout(resolve, 400));
    tmux.keys("Left");
    await new Promise((resolve) => setTimeout(resolve, 200));
    tmux.keys("Left");
    const listAgain = await until(tmux, (pane) => pane.some((line) => line.includes("Sessions")), "the list after returning").catch(() => undefined);
    steps.push({ step: "returned-to-list", returned: listAgain !== undefined, rowName: (listAgain ?? []).find((line) => line.includes(sessionDir))?.trim().slice(0, 160) ?? null });
    await snap("08-back-on-list");

    // What the composer answers for Pi's own commands, read off the real list.
    /** @type {Record<string, string>} */
    const composerAnswers = {};
    for (const command of ["/new", "/resume"]) {
      tmux.literal(command);
      await until(tmux, (pane) => pane.some((line) => line.includes(command)), `${command} in the composer`);
      tmux.keys("Enter");
      const answered = await until(
        tmux,
        (pane) => pane.some((line) => line.includes("PI_SESSION_COMMAND")),
        `the composer's answer for ${command}`,
      );
      composerAnswers[command] = (answered.find((line) => line.includes("PI_SESSION_COMMAND")) ?? "").trim().slice(0, 220);
      await snap(`09-composer${command.replace("/", "-")}`);
      await clearEditor(tmux, command).catch(() => {});
    }
    steps.push({
      step: "composer-points-at-the-session",
      answers: composerAnswers,
      bothActionable: Object.values(composerAnswers).every((line) => /inside a session/u.test(line) && /Enter/u.test(line)),
    });

    const passed = steps.find((s) => s.step === "slash-new")?.failure === null
      && steps.find((s) => s.step === "slash-resume")?.failure === null;
    const record = { passed, geometry: `${COLS}x${ROWS}`, sessionsHome, root, steps, atMs: Date.now() };
    await writeFile(path.join(evidenceDir, "session-switch-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } catch (error) {
    await writeFile(path.join(evidenceDir, "session-switch-result.json"),
      `${JSON.stringify({ passed: false, steps, failure: error.message, atMs: Date.now() }, null, 2)}\n`).catch(() => {});
    await snap("99-failure");
    throw error;
  } finally {
    tmux.kill();
    // Only fixture-owned roots, and only through the demo's own stop with its exit evidence.
    for (const root of created) {
      await new Promise((resolve) => execFile(NODE, [DEMO, "stop", "--root", root], { timeout: 60_000 }, (error, stdout) => {
        void writeFile(path.join(evidenceDir, "stop.json"), `${stdout ?? ""}${error ? `\n${error.message}` : ""}\n`).catch(() => {});
        resolve(undefined);
      }));
    }
    for (const directory of [home, sessionsHome, project]) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--evidence");
  const evidenceDir = index === -1 ? path.join(tmpdir(), "session-switch-evidence") : path.resolve(process.argv[index + 1]);
  runSessionSwitchFlow({ evidenceDir })
    .then((record) => {
      console.log(JSON.stringify(record, null, 2));
      if (!record.passed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
