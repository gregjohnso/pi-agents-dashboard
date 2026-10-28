#!/usr/bin/env node
/**
 * The existing session manager, with native Pi in place of the reconstructed viewer.
 *
 *   node manager-demo.mjs [--real] [--cwd <dir>] [--sessions <dir>] [--state <dir>] [--pi-config <dir>]
 *
 * Dashboard metadata saves by default under `~/.pi-agents`, so a session is still discoverable after this manager
 * exits. `--state <dir>` overrides that. What is saved there is metadata ABOUT sessions and never session content:
 * **Pi owns transcripts** and chooses their location from its own configuration, which this entry point does not
 * touch. `--sessions` remains the short runtime/socket home, and `--pi-config` remains fake-fixture only.
 *
 * This is a private opt-in entry point. It starts the SAME dashboard the installed app starts —
 * `createStandaloneList`, `DashboardController`, the launch composer, the row renderer, the navigation
 * helpers and `runViewerTransition`, none of them reimplemented here — and injects exactly two things:
 *
 *   1. a native backend, so rows and launches come from persistent native Pi owners instead of the
 *      daemon. The installed daemon is neither started nor contacted.
 *   2. a native opener, so Right/Enter hands this terminal to whole native Pi instead of mounting the
 *      RPC viewer. That is the one substitution the strategy calls for.
 *
 * What the operator does, all of it the existing manager's own behaviour:
 *
 *   Up/Down   move the selection
 *   type      the launch composer takes the prompt; Enter launches a new native session
 *   Right     open the selected session's whole native Pi (Enter on a row does the same)
 *   Left      inside Pi, at an empty prompt, returns here; with text it moves the cursor, and only a
 *             second Left returns. A dialog or overlay keeps Left. F9 remains as a fallback.
 *   q         leave the list; every session keeps running
 *
 * Returning preserves the session, the unsubmitted draft and the selected row, because the owner is
 * never stopped and the controller is the same instance reopened.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spawn } from "node:child_process";

import { createNativeBackend } from "../../app/list/native-backend.mjs";
import { createStandaloneList } from "../../app/list/standalone-list.mjs";

const DEMO = fileURLToPath(new URL("./demo.mjs", import.meta.url));

/** How much of a refused attachment's stderr is kept. Its refusal line is last, so the tail is what matters. */
const ATTACH_STDERR_BYTES = 8 * 1024;
/** How much of a reason is put on one status line. */
const ATTACH_REASON_BYTES = 400;

/**
 * The error the list shows for an attachment that ended badly.
 *
 * The attachment reports a refusal as one JSON line on its stderr. Reading it is what turns "native attachment
 * ended with code 1" into the manager's own named reason on the list's status line - which is the only place the
 * operator can see why a keypress did not open a session. A child that said nothing usable still gets an honest
 * generic message rather than a guess.
 *
 * @param {string} stderrTail @param {number|null} code @param {string|null} signal
 */
function attachFailure(stderrTail, code, signal) {
  const ended = `native attachment ended with code ${code}${signal ? ` signal ${signal}` : ""}`;
  for (const line of stderrTail.split("\n").reverse()) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (parsed?.attached !== false || typeof parsed.reason !== "string") continue;
    const reason = parsed.reason.slice(0, ATTACH_REASON_BYTES);
    return Object.assign(new Error(reason), { code: typeof parsed.refusalCode === "string" ? parsed.refusalCode : "ATTACH_REFUSED" });
  }
  return Object.assign(new Error(ended), { code: "ATTACH_FAILED" });
}

/**
 * Hand this terminal to one native attachment, and take it back when the attachment ends.
 *
 * The dashboard owns an alternate-screen TUI and this terminal's raw mode, so the handoff is explicit:
 * stop the TUI, run the attachment with inherited stdio so Pi renders and reads directly, then let the
 * transition reopen the list. Stopping the TUI is not stopping the session — the owner is a separate
 * persistent process and is never signalled here.
 *
 * It is shaped as the object `runViewerTransition` already drives (`open`, `closed`, `close`,
 * `openError`, `layoutRoot`) so the existing transition, and its ordering guarantees, are reused
 * rather than restated.
 */
function createNativeAttachmentViewer({ root, attachmentId, node, tui, onAttachRefusal }) {
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let child;
  let settled = false;
  const viewer = {
    openError: undefined,
    /** No layout: while Pi has the terminal, this frontend paints nothing at all. */
    layoutRoot: undefined,
    async open() {
      // The list gives the terminal up before Pi is handed it, and the screen is preserved so the
      // operator's scrollback is not thrown away by the switch.
      tui.stop({ preserveScreen: true });
      // Hold the terminal in raw mode ACROSS the handoff. `tui.stop()` hands cooked mode back, and the
      // attachment is a separate process, so without this the tty echoes every keystroke typed between the stop
      // and the child's own raw-mode call - a whole process spawn and a socket round trip later. That is where
      // the literal `^[[C` an operator saw came from: the Right arrow that opened the session, echoed as text
      // into Pi's display. Raw mode is a property of the tty, so the inherited stdio starts raw and no keystroke
      // is ever echoed. The list restores it when the attachment ends.
      const rawAcrossHandoff = process.stdin.isTTY === true;
      if (rawAcrossHandoff) process.stdin.setRawMode(true);
      // stdin and stdout stay inherited: Pi reads keys directly and paints directly, and nothing here touches
      // that. stderr is a PIPE, which does two things - it keeps this attachment's diagnostics off a terminal Pi
      // owns, and it is how a refusal's own reason reaches the list. Previously the child wrote a JSON refusal
      // that nobody read, so the operator saw only "ended with code 1".
      child = spawn(node, [DEMO, "attach", "--root", root, "--id", attachmentId], { stdio: ["inherit", "inherit", "pipe"] });
      // Bounded, and the tail is kept because the refusal line is written last.
      let childStderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        childStderr = `${childStderr}${chunk}`.slice(-ATTACH_STDERR_BYTES);
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        // The list owns the terminal again from here, and it repaints it.
        try {
          if (rawAcrossHandoff && process.stdin.isTTY) process.stdin.setRawMode(false);
        } catch {
          // A terminal that has gone away needs no restoration.
        }
        if (code !== 0) {
          const failure = attachFailure(childStderr, code, signal);
          viewer.openError = failure;
          // The list's own status line is superseded by the next thing the operator does, so the refusal is also
          // handed back as a durable fact about the row. Only the manager's own named code travels; a generic
          // failure says nothing about attach compatibility and is ignored downstream.
          onAttachRefusal?.({ code: failure.code, reason: failure.message });
        }
        resolveClosed();
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        viewer.openError = error;
        resolveClosed();
      });
      await closed;
    },
    closed,
    async close() {
      // Ending the attachment is the operator's own gesture. Nothing is signalled from here, so a
      // close that races the gesture cannot cut the session's terminal out from under Pi.
      if (!settled) await closed;
    },
  };
  return viewer;
}

/**
 * This entry point's options, resolved from an explicit argv.
 *
 * `cwd` and `homeDir` are parameters rather than ambient reads so a test can run against a disposable home. That
 * matters here specifically: the metadata home has a default, and a test that silently picked up the real home
 * would write real operator metadata.
 *
 * @param {{ argv: string[], cwd: string, homeDir: string }} input
 */
export function resolveManagerOptions({ argv, cwd, homeDir }) {
  const at = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : path.resolve(argv[index + 1]);
  };
  const stateIndex = argv.indexOf("--state");
  // A flag with a default needs its missing value REFUSED rather than absorbed. Without this, `--state` alone would
  // quietly fall back to the default the operator was trying to override, and `--state --sessions <dir>` would take
  // the next flag's name as a directory. Only the flag this change touches is checked; the rest are left alone.
  if (stateIndex !== -1) {
    const value = argv[stateIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--state needs a directory: it was given ${value === undefined ? "nothing" : `the flag ${value}`}`);
    }
  }
  const piConfigIndex = argv.indexOf("--pi-config");
  return {
    mode: argv.includes("--real") ? "real" : "fake",
    projectCwd: at("--cwd", cwd),
    // The short RUNTIME/socket home. Unchanged, and deliberately NOT derived from the metadata home: `<root>/s` has
    // to fit in a `sockaddr_un`, which a path under the operator's home cannot be relied on to do.
    sessionsHome: at("--sessions", path.join("/tmp", `pi-manager-demo-${process.getuid?.() ?? 0}`)),
    // The dashboard's METADATA home, saved by default so a session is still discoverable after this manager exits.
    // It holds records ABOUT sessions - owner and Pi session ids, the path Pi reported for its session file, an
    // observed exit - and never session content: Pi still owns transcripts and still chooses where they live.
    stateHome: stateIndex === -1 ? path.join(homeDir, ".pi-agents") : path.resolve(argv[stateIndex + 1]),
    stateHomeIsDefault: stateIndex === -1,
    // Fake automation only. Pi selects its own session directory from its configuration; this just gives a fixture a
    // private, real Pi configuration home. Absent by default, so real mode gets the operator's own configuration.
    piConfigHome: piConfigIndex === -1 ? undefined : path.resolve(argv[piConfigIndex + 1]),
  };
}

/** Run the native dashboard with already-resolved options from either entry point. */
export async function runNativeManager(options) {
  const {
    mode,
    projectCwd,
    sessionsHome,
    stateHome,
    piConfigHome,
    manifestPath,
    cohortRoot,
    stdin = process.stdin,
    stdout = process.stdout,
  } = options;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("the manager needs a real terminal on stdin and stdout; run it from a terminal, not a pipe");
  }
  await mkdir(sessionsHome, { recursive: true });

  // The trace file lives outside the sessions home on purpose: writing it inside would be a change to
  // the directory the list watches, and a traced read would invalidate the list it just answered.
  const client = createNativeBackend({
    sessionsHome, node: process.execPath, mode, projectCwd,
    traceFile: process.env.PI_NATIVE_BACKEND_TRACE,
    // Where the dashboard's own records live. Saved by default under the operator's home, so a session stays
    // discoverable after this manager exits; `--state` overrides it. These are records ABOUT sessions, never
    // session content - Pi owns transcripts and picks their location from its own configuration.
    stateHome,
    piConfigHome,
    manifestPath,
    cohortRoot,
    // This terminal's real size, not the demo's 100x30 default: the session the operator opens should be the
    // size of the window he opened it from. An attaching client re-asserts its own size anyway, so this is the
    // starting point rather than the only chance to get it right.
    cols: stdout.columns, rows: stdout.rows,
  });
  const attachmentId = `manager-${process.pid}`;

  const list = await createStandaloneList({
    cwd: projectCwd,
    // This list reads every session directory over a control socket, so its first load is only as fast as the
    // slowest owner. Paint the loading surface first: a wedged owner then costs a row its detail instead of
    // leaving a blank terminal with nothing to quit.
    paintBeforeFirstLoad: true,
    // A frontend identity, with no daemon root: the injected client never reads one.
    frontend: { root: sessionsHome, clientId: attachmentId, attachId: attachmentId },
    client,
    async openViewer(sessionId, context) {
      const root = client.rootFor(sessionId);
      await client.assertOpenable(sessionId);
      await context.runViewerTransition({
        sessionId,
        client: context.client,
        controller: context.controller,
        createViewer: () => createNativeAttachmentViewer({
          root,
          attachmentId,
          node: process.execPath,
          tui: context.tui,
          onAttachRefusal: (refusal) => client.noteAttachRefusal(sessionId, refusal),
        }),
        activateViewer(viewer) { context.activateViewer(viewer); },
        activateList: context.activateList,
        // Pi restored this terminal on its way out, so the list restarts its own screen here.
        restoreListFocus() { context.tui.start(); },
        onRestoreClosed: context.onRestoreClosed,
        shouldRestore: context.shouldRestore,
      });
    },
  });

  await list.closed;
  client.close();
  stdout.write(`left the manager. sessions under ${sessionsHome} are still running\n`);
}

async function main() {
  const options = resolveManagerOptions({ argv: process.argv.slice(2), cwd: process.cwd(), homeDir: homedir() });
  await runNativeManager(options);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
