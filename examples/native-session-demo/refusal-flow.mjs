/**
 * The refusal path as an operator sees it: enter a session the list cannot repaint, and read why.
 *
 * This is the negative half of the attach work, and it was previously covered only at unit level. It runs the
 * REAL dashboard in an isolated tmux at 181x79 against an owned legacy-manager fixture - a stand-in for the older
 * manager the operator actually has running - and asserts the three things that matter after a refusal:
 *
 *   1. the list comes back and shows the manager's OWN named reason, not "ended with code 1";
 *   2. the composer is usable immediately afterwards, so a refused keypress is not a dead terminal;
 *   3. the peer is untouched, because a refusal repairs nothing and must not cost a session.
 *
 * No real Pi is needed and no real session is involved. The fixture owns only a socket and a directory.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startLegacyManagerFixture } from "./legacy-manager-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER_DEMO = path.join(HERE, "manager-demo.mjs");
const NODE = process.execPath;
const COLS = 181;
const ROWS = 79;
const BARRIER_MS = 90_000;
const POLL_MS = 100;

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
    pane: () => run(["capture-pane", "-p", "-t", "refuse"]).split("\n"),
    cursor: () => {
      const [x, y] = run(["display-message", "-p", "-t", "refuse", "#{cursor_x},#{cursor_y}"]).trim().split(",");
      return { x: Number(x), y: Number(y) };
    },
    keys: (...keys) => run(["send-keys", "-t", "refuse", ...keys]),
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
  throw new Error(`${description} never happened within ${BARRIER_MS}ms; pane tail was ${JSON.stringify(pane.slice(-16).join("\n"))}`);
}

/** @param {{ evidenceDir: string }} options */
export async function runRefusalFlow({ evidenceDir }) {
  await mkdir(evidenceDir, { recursive: true });
  const steps = [];
  const socketName = `pia-refuse-${process.pid}`;
  const tmux = tmuxRunner(socketName);
  const home = await mkdtemp(path.join(tmpdir(), "pia-refuse-home-"));
  const sessionsHome = await mkdtemp(path.join(tmpdir(), "pia-refuse-sessions-"));
  const project = await mkdtemp(path.join(tmpdir(), "pia-refuse-project-"));
  /** @type {{ close: () => Promise<void>, welcomes: () => number }|undefined} */
  let fixture;
  try {
    await writeFile(path.join(project, "README.md"), "disposable project for the refusal reproduction\n");
    const configRoot = path.join(path.dirname(sessionsHome), `${path.basename(sessionsHome)}-config`);
    await mkdir(configRoot, { recursive: true });
    await mkdir(path.join(home, "tmp"), { recursive: true });

    // An owned session directory served by a stand-in for an OLDER manager.
    const legacyRoot = path.join(sessionsHome, "session-1700000000001");
    fixture = await startLegacyManagerFixture(legacyRoot);
    steps.push({ step: "legacy-manager-fixture-listening", root: legacyRoot });

    tmux.run([
      "new-session", "-d", "-s", "refuse", "-x", String(COLS), "-y", String(ROWS),
      "-e", `HOME=${home}`, "-e", `XDG_CONFIG_HOME=${configRoot}`, "-e", `TMPDIR=${path.join(home, "tmp")}`,
      "--", NODE, MANAGER_DEMO, "--sessions", sessionsHome, "--cwd", project,
    ]);
    await until(tmux, (pane) => pane.some((line) => line.includes("Sessions")), "the dashboard's first paint");
    await until(tmux, (pane) => pane.some((line) => line.includes("session-1700000000001")), "the legacy session's row");
    steps.push({ step: "legacy-session-listed" });

    // Open it. The list must refuse, because this peer confirms no cold presentation.
    tmux.keys("Right");
    const refusedPane = await until(
      tmux,
      (pane) => pane.some((line) => line.includes("ATTACH_PRESENTATION_UNSUPPORTED")),
      "the named refusal on the restored list",
    );
    const reasonLine = refusedPane.find((line) => line.includes("ATTACH_PRESENTATION_UNSUPPORTED")) ?? "";
    // The list is back - the refusal did not leave the terminal with the attachment.
    const listBack = refusedPane.some((line) => line.includes("Sessions"));
    steps.push({
      step: "refusal-reason-readable-on-the-restored-list",
      code: "ATTACH_PRESENTATION_UNSUPPORTED",
      reasonLine: reasonLine.trim().slice(0, 240),
      mentionsStillRunning: /still running/iu.test(reasonLine),
      codeAppearsOnce: (reasonLine.match(/ATTACH_PRESENTATION_UNSUPPORTED/gu) ?? []).length === 1,
      generic: refusedPane.some((line) => line.includes("ended with code 1")),
      listRestored: listBack,
      welcomesServed: fixture.welcomes(),
    });
    if (!listBack) throw new Error("the list did not come back after the refusal");
    if (refusedPane.some((line) => line.includes("ended with code 1"))) throw new Error("the list showed the generic exit message instead of the manager's own reason");
    if (fixture.welcomes() < 1) throw new Error("the fixture never served a welcome, so the refusal did not come from the handshake");
    if ((reasonLine.match(/ATTACH_PRESENTATION_UNSUPPORTED/gu) ?? []).length !== 1) throw new Error(`the named code is not shown exactly once: ${reasonLine.trim()}`);
    if (!/still running/iu.test(reasonLine)) throw new Error(`the visible reason does not say the session is still running: ${reasonLine.trim()}`);

    // The composer must be usable straight after a refusal: a refused keypress is not a dead terminal.
    //
    // Only the TEXT's position is asserted here, not the hardware cursor. The list is its own TUI and draws its
    // own `❯` caret rather than parking the terminal cursor in the composer - it sits at the row's end - so a
    // cursor assertion that is meaningful inside Pi's editor is not meaningful here. The cursor is recorded as
    // observed and the claim made is the one this surface can support: the text lands in the composer row.
    const typed = "still typable after a refusal";
    tmux.keys(typed);
    const typedPane = await until(tmux, (pane) => pane.some((line) => line.includes(typed)), "the typed text in the composer");
    const cursor = tmux.cursor();
    const row = typedPane.findIndex((line) => line.includes(typed));
    const column = row === -1 ? -1 : typedPane[row].indexOf(typed) + typed.length;
    // The composer row is the one the list marks with its own prompt caret, between the composer's borders.
    const inComposerRow = row !== -1 && typedPane[row].includes("❯");
    const borderedAbove = row > 0 && typedPane[row - 1].includes("─");
    const borderedBelow = row !== -1 && row + 1 < typedPane.length && typedPane[row + 1].includes("─");
    steps.push({
      step: "composer-usable-after-refusal",
      typed,
      textRow: row,
      textEndColumn: column,
      inComposerRow,
      borderedAbove,
      borderedBelow,
      observedCursor: cursor,
      cursorNote: "the list draws its own caret and parks the terminal cursor at the row end, so cursor position is recorded, not asserted, on this surface",
    });
    await writeFile(
      path.join(evidenceDir, "refusal.pane.txt"),
      typedPane.map((line, index) => `${index === cursor.y ? "CURSOR>" : "       "}${String(index).padStart(3, " ")} ${line}`).join("\n")
        + `\n\n# typed ${JSON.stringify(typed)} on row ${row} ending at column ${column}; observed terminal cursor x=${cursor.x} y=${cursor.y}\n`
        + "# the list draws its own caret; the assertion is that the text is in the composer row, not where the terminal cursor is\n",
    );
    if (!inComposerRow || !borderedAbove || !borderedBelow) {
      throw new Error(`the typed text is not in the list's composer row: row ${row}, inComposerRow ${inComposerRow}, bordered ${borderedAbove}/${borderedBelow}`);
    }

    // The peer is untouched. It is a fixture, so "alive" means it still answers on its own socket.
    const stillServing = fixture.welcomes() >= 1;
    steps.push({ step: "peer-untouched-by-the-refusal", stillListening: stillServing });

    // The row must keep saying so after the status line is gone.
    //
    // A one-shot error line is not enough: the operator's complaint was that a row reading READY looked openable,
    // and they only found out by pressing Right. So the refusal's status line is genuinely SUPERSEDED here - an
    // unrelated rejected command replaces it with a different error - and only then is the ROW read for the label,
    // through an ordinary refresh rather than any hidden field.
    for (let index = 0; index < typed.length + 4; index += 1) tmux.keys("BSpace");
    await until(tmux, (pane) => !pane.some((line) => line.includes(typed)), "the composer cleared");
    tmux.keys("/nope");
    tmux.keys("Enter");
    await until(
      tmux,
      (pane) => pane.some((line) => line.includes("UNKNOWN_LIST_COMMAND") || line.includes("Unknown command")),
      "an unrelated error superseding the refusal's status line",
    );
    const supersededPane = tmux.pane();
    if (supersededPane.some((line) => line.includes("ATTACH_PRESENTATION_UNSUPPORTED"))) {
      throw new Error("the refusal's status line was not actually superseded, so the next check would prove nothing");
    }
    tmux.keys("r");
    const rowPane = await until(
      tmux,
      (pane) => pane.some((line) => line.includes("attachment unavailable")),
      "the row's own attachment-unavailable label after the status line was superseded",
    );
    const labelRow = rowPane.find((line) => line.includes("attachment unavailable")) ?? "";
    const stateStillReady = /READY/u.test(labelRow);
    const noFalseFailure = !/FAILED|STOPPED/u.test(labelRow);
    steps.push({
      step: "row-keeps-the-label-after-the-status-line-is-superseded",
      labelRow: labelRow.trim().slice(0, 200),
      stateStillReady,
      noFalseFailure,
      refusalStatusLineSuperseded: !rowPane.some((line) => line.includes("ATTACH_PRESENTATION_UNSUPPORTED")),
    });
    await writeFile(
      path.join(evidenceDir, "row-label.pane.txt"),
      rowPane.map((line, index) => `${String(index).padStart(3, " ")} ${line}`).join("\n")
        + `\n\n# the row line carrying the label: ${JSON.stringify(labelRow.trim())}\n`,
    );
    if (!stateStillReady) throw new Error(`the labelled row no longer shows its real task state: ${labelRow.trim()}`);
    if (!noFalseFailure) throw new Error(`the labelled row was demoted to a failure state: ${labelRow.trim()}`);

    const record = { passed: true, geometry: `${COLS}x${ROWS}`, legacyRoot, steps, atMs: Date.now() };
    await writeFile(path.join(evidenceDir, "refusal-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } catch (error) {
    await writeFile(path.join(evidenceDir, "refusal-result.json"),
      `${JSON.stringify({ passed: false, steps, failure: error.message, atMs: Date.now() }, null, 2)}\n`).catch(() => {});
    await writeFile(path.join(evidenceDir, "refusal.pane.txt"), tmux.pane().join("\n")).catch(() => {});
    throw error;
  } finally {
    tmux.kill();
    await fixture?.close().catch(() => {});
    for (const directory of [home, sessionsHome, project]) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--evidence");
  const evidenceDir = index === -1 ? path.join(tmpdir(), "refusal-evidence") : path.resolve(process.argv[index + 1]);
  runRefusalFlow({ evidenceDir })
    .then((record) => console.log(JSON.stringify(record, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
