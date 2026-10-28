#!/usr/bin/env node
/**
 * The approved flow, through the ACTUAL existing dashboard, on a real terminal.
 *
 * This drives `manager-demo.mjs` — which starts `createStandaloneList` and `DashboardController`, the
 * same manager the installed app starts — with nothing but keystrokes:
 *
 *   type a prompt, Enter   the launch composer launches a native session
 *   Down / Up              the existing row navigation moves the selection
 *   Right                  opens the selected session's whole native Pi
 *   type a draft           reaches Pi's own editor
 *   Left (mid-draft)       stays in Pi and moves the cursor
 *   Escape-opened dialog   keeps its own keys, Left included
 *   Left at empty prompt   returns to the list
 *   Right again            same owner, same draft
 *   q                      leaves the list with the owner still running
 *
 * Every lifecycle claim is read from the owner's own `status`, never from the screen. Cleanup stops only
 * identities this flow started.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNativeBackend, rowStateFromStatus } from "../../app/list/native-backend.mjs";
import { FAKE_REPLY_PREFIX, deterministicReply } from "./fake-provider.mjs";
import { demoCommand, describeOwnerExit, openPtyProcess, stopIdentifiedProcess, verifyOwnerAbsence, waitForAttachmentEpoch } from "./smoke.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER = path.join(HERE, "manager-demo.mjs");
const LEFT = "\u001b[D";
const RIGHT = "\u001b[C";
const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ESCAPE = "\u001b";
const PROMPT = "first native session from the list";
const DRAFT = "an unsent draft that must survive Left";

/**
 * Wait until a marker has appeared at least `count` times.
 *
 * The harness accumulates everything printed, so asking only whether a marker is present matches the
 * first time it ever appeared. Anything that happens twice — opening a session, returning to the list —
 * has to be waited for by occurrence.
 */
function waitForOccurrence(process_, marker, count, description, timeoutMs = 90_000) {
  return process_.waitFor(
    (visible) => visible.split(marker).length - 1 >= count,
    `${description} (occurrence ${count} of ${JSON.stringify(marker)})`,
    timeoutMs,
  );
}

async function statusOf(root, spawned, label) {
  const answer = await demoCommand(["status", "--root", root], { label, spawned });
  return JSON.parse(answer.output.slice(answer.output.indexOf("{")));
}

export async function runManagerFlow({ sessionsHome, evidenceDir }) {
  const spawned = [];
  const steps = [];
  let manager;
  let root;
  let owner;
  try {
    // The backend traces outside the sessions home, so tracing cannot itself invalidate the list.
    const traceFile = path.join(evidenceDir, "backend.log");
    await mkdir(evidenceDir, { recursive: true });
    manager = await openPtyProcess({
      args: [MANAGER, "--sessions", sessionsHome], label: "manager-demo", spawned,
      env: { PI_NATIVE_BACKEND_TRACE: traceFile },
    });
    // The existing dashboard's own first paint, not a list this flow wrote.
    await manager.waitFor((visible) => /Sessions|sessions/u.test(visible), "the existing dashboard's first paint", 120_000);
    steps.push({ step: "existing-dashboard-opened", sessionsHome });

    // The launch composer: type a prompt into the list and press Enter.
    manager.write(PROMPT);
    await manager.waitFor((visible) => visible.includes(PROMPT), "the prompt echoing in the launch composer");
    manager.write("\r");
    await manager.waitFor((visible) => /session-\d{10,}/u.test(visible), "a launched native session row", 180_000);
    const listed = /session-(\d{10,})/u.exec(manager.visible());
    root = path.join(sessionsHome, `session-${listed[1]}`);
    const started = await statusOf(root, spawned, "status after the composer launch");
    owner = started.owner;
    steps.push({ step: "launched-from-list-composer", prompt: PROMPT, root, ownerPid: owner.pid, ownerMode: started.ownerMode });

    // A second session, so row navigation has somewhere to move.
    manager.write("a second session");
    manager.write("\r");
    await manager.waitFor((visible) => (visible.match(/session-\d{10,}/gu) ?? []).length >= 2, "a second launched row", 180_000);
    steps.push({ step: "second-session-launched" });

    // The existing navigation: Down then Up must move the selection and come back.
    manager.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterDown = manager.visible();
    manager.write(UP);
    await new Promise((resolve) => setTimeout(resolve, 400));
    steps.push({ step: "row-navigation-moved", downChangedScreen: afterDown !== manager.visible() });

    // Right opens whole native Pi on this terminal.
    manager.write(RIGHT);
    // Epoch-scoped: an append-only log means a plain count can be satisfied by an earlier attachment's line.
    await waitForAttachmentEpoch(root, 1, "the native attachment's welcome");
    await waitForOccurrence(manager, "native-session-demo", 1, "Pi's own widget on this terminal");
    const attached = await statusOf(root, spawned, "status while attached through the dashboard");
    steps.push({ step: "right-opened-native-pi", attachments: attached.attachments });

    // Typing reaches Pi's editor, which is the proof the list gave up this terminal.
    manager.write(DRAFT);
    await manager.waitFor((visible) => visible.includes(DRAFT), "the draft echoing from Pi's own editor");

    // Left mid-draft is an editing key: it must NOT return to the list.
    manager.write(LEFT);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const stillAttached = await statusOf(root, spawned, "status after Left while editing");
    if (stillAttached.attachments.length !== 1) {
      throw new Error(`Left while editing left Pi: attachments were ${JSON.stringify(stillAttached.attachments)}`);
    }
    if (stillAttached.returns.length !== 0) throw new Error(`Left while editing returned: ${JSON.stringify(stillAttached.returns)}`);
    steps.push({ step: "left-while-editing-stays-in-pi", attachments: stillAttached.attachments, recordedReturns: stillAttached.returns });

    // A dialog owns its own keys, Left included: Escape opens Pi's own interrupt/dialog path, and the
    // attachment must survive a Left pressed while it is up.
    manager.write(ESCAPE);
    await new Promise((resolve) => setTimeout(resolve, 400));
    manager.write(LEFT);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const afterDialog = await statusOf(root, spawned, "status after Left inside a dialog");
    if (afterDialog.attachments.length !== 1 || afterDialog.returns.length !== 0) {
      throw new Error(`Left inside a dialog returned to the list: ${JSON.stringify({ attachments: afterDialog.attachments, returns: afterDialog.returns })}`);
    }
    steps.push({ step: "dialog-keeps-its-keys", attachments: afterDialog.attachments });

    // Clear the draft, then return. Ctrl+U is Pi's own delete-to-line-start, so nothing here decodes a key.
    //
    // One Left is not the gesture at this point, and that is the helper's design rather than a limitation:
    // the editor has been edited, so `editedOrHistory` is set and a single Left stays an editing key. The
    // approved return for a dirtied editor is Left twice inside the helper's window, which is what keeps a
    // half-typed prompt safe from a stray press.
    manager.write("\u0015");
    await new Promise((resolve) => setTimeout(resolve, 500));
    manager.write(LEFT);
    await new Promise((resolve) => setTimeout(resolve, 120));
    manager.write(LEFT);
    await manager.waitFor((visible) => /Sessions/u.test(visible), "the list repainting after the double Left", 90_000);
    const afterReturn = await statusOf(root, spawned, "status after the eligible Left");
    if (afterReturn.owner.pid !== owner.pid || afterReturn.owner.startIdentity !== owner.startIdentity) {
      throw new Error(`the owner changed across the return: ${JSON.stringify({ before: owner, after: afterReturn.owner })}`);
    }
    if (afterReturn.exit !== null || afterReturn.reaped !== null) throw new Error(`the owner ended across the return: ${JSON.stringify(afterReturn.exit)}`);
    if (afterReturn.attachments.length !== 0) throw new Error(`the returning attachment is still attached: ${JSON.stringify(afterReturn.attachments)}`);
    if (afterReturn.returns.length !== 1) throw new Error(`expected one recorded return, got ${JSON.stringify(afterReturn.returns)}`);
    steps.push({
      step: "eligible-left-returned-to-list",
      gesture: "Left twice after editing, which is the helper's window for a dirtied editor",
      ownerPidUnchanged: true,
      ownerStartIdentityUnchanged: true,
      recordedReturns: afterReturn.returns,
    });

    // The selected row is retained, so Right reopens the SAME session without navigating again.
    manager.write(RIGHT);
    await waitForAttachmentEpoch(root, 2, "the reopened attachment's welcome");
    const reopened = await statusOf(root, spawned, "status after reopening from the retained row");
    if (reopened.owner.pid !== owner.pid) throw new Error(`reopening reached a different owner: ${reopened.owner.pid} vs ${owner.pid}`);
    const epochs = reopened.attachments.map((attachment) => attachment.epoch);
    if (!epochs.some((epoch) => epoch >= 2)) throw new Error(`expected a later epoch on reopen, saw ${JSON.stringify(reopened.attachments)}`);
    steps.push({ step: "selection-retained-same-owner-reopened", ownerPid: reopened.owner.pid, attachments: reopened.attachments });

    // Leave the list. The dashboard's own quit is Pi's Ctrl+C gesture: the first press empties the
    // prompt and leaves the list standing, and only a second press inside the window quits. Quitting is
    // this frontend leaving - it stops no session, which is the property asserted immediately below.
    manager.write(LEFT);
    await new Promise((resolve) => setTimeout(resolve, 120));
    manager.write(LEFT);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    manager.write("\u0003");
    await new Promise((resolve) => setTimeout(resolve, 300));
    manager.write("\u0003");
    const managerExit = await manager.waitForExit(90_000);
    const afterQuit = await statusOf(root, spawned, "status after leaving the list");
    if (afterQuit.owner.pid !== owner.pid || afterQuit.exit !== null || afterQuit.reaped !== null) {
      throw new Error(`leaving the list did not leave the owner running: ${JSON.stringify({ owner: afterQuit.owner, exit: afterQuit.exit })}`);
    }
    steps.push({ step: "list-exit-left-owner-running", quitGesture: "double Ctrl+C, the dashboard's own", managerExit, ownerPid: afterQuit.owner.pid });

    // Owned cleanup: every session this flow created, by its own root, not just the one under test.
    const created = (await readdir(sessionsHome, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(sessionsHome, entry.name));
    const stops = [];
    let primaryExit;
    for (const sessionRoot of created) {
      const answer = await demoCommand(["stop", "--root", sessionRoot], { label: `stop ${path.basename(sessionRoot)}`, spawned })
        .then((result) => JSON.parse(result.output.slice(result.output.indexOf("{"))))
        .catch((failure) => ({ error: failure.message }));
      if (sessionRoot === root) primaryExit = answer.exit;
      stops.push({ root: sessionRoot, exit: answer.exit === undefined ? undefined : describeOwnerExit(answer.exit), error: answer.error });
    }
    const absence = await verifyOwnerAbsence(owner.pid, owner.startIdentity);
    steps.push({ step: "stopped", exit: primaryExit === undefined ? undefined : describeOwnerExit(primaryExit), stops, absence });

    const record = { passed: true, sessionsHome, root, owner, steps, atMs: Date.now() };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "manager-flow-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(evidenceDir, "manager-flow.visible.txt"), manager.visible());
    return record;
  } catch (error) {
    // Cleanup on failure covers every session this flow created, for the same reason the success path does.
    const cleanup = { stops: [], spawned: [] };
    const created = (await readdir(sessionsHome, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(sessionsHome, entry.name));
    for (const sessionRoot of created) {
      cleanup.stops.push(await demoCommand(["stop", "--root", sessionRoot], { label: `stop ${path.basename(sessionRoot)} (cleanup)`, spawned: [] })
        .then((answer) => ({ root: sessionRoot, exit: answer.exit }))
        .catch((failure) => ({ root: sessionRoot, error: failure.message })));
    }
    for (const process_ of spawned) {
      if (process_.handle.reapIfExited() !== null) continue;
      cleanup.spawned.push(await stopIdentifiedProcess(process_.handle.owner, process_.label).catch((failure) => ({ label: process_.label, error: failure.message })));
    }
    await mkdir(evidenceDir, { recursive: true });
    // Whatever the backend recorded about a refused launch, verbatim. A launch that failed is the most
    // likely reason this flow stalls, and one status line is not enough to diagnose it.
    const launchFailures = await readFile(path.join(sessionsHome, "launch-failures.log"), "utf8").catch(() => null);
    if (launchFailures !== null) await writeFile(path.join(evidenceDir, "launch-failures.log"), launchFailures);
    await writeFile(
      path.join(evidenceDir, "manager-flow-result.json"),
      `${JSON.stringify({ passed: false, sessionsHome, root: root ?? null, owner: owner ?? null, steps, failure: /** @type {Error} */ (error).message, launchFailures, cleanup, atMs: Date.now() }, null, 2)}\n`,
    );
    if (manager !== undefined) {
      await writeFile(path.join(evidenceDir, "manager-flow.visible.txt"), manager.visible()).catch(() => {});
    }
    throw error;
  }
}

/**
 * The narrower thing the operator actually reported: type a prompt, press Enter, and get a row you can use.
 *
 * Kept separate from the full flow because it is the regression for one specific failure. A launch can succeed
 * while the row never appears - which is exactly what happened when live owners were reported with a
 * `processState` the dashboard's default view filters out - so this asserts the row is VISIBLE on the rendered
 * screen with a usable state, and then opens it, rather than trusting that the launch call returned.
 *
 * `mode` exercises `--real` argument and launch propagation. Real mode here still runs against a disposable
 * HOME with no account, no operator extensions and no model call: it proves the real code path launches and
 * renders, not that a provider answered.
 *
 * @param {{ sessionsHome: string, evidenceDir: string, mode?: "fake" | "real", projectCwd?: string }} options
 */
export async function runLaunchVisibleFlow({ sessionsHome, evidenceDir, mode = "fake", projectCwd }) {
  const spawned = [];
  const steps = [];
  let manager;
  try {
    await mkdir(evidenceDir, { recursive: true });
    const args = [MANAGER, "--sessions", sessionsHome];
    if (mode === "real") args.push("--real", "--cwd", projectCwd ?? sessionsHome);
    manager = await openPtyProcess({
      args, label: `manager-${mode}`, spawned,
      env: { PI_NATIVE_BACKEND_TRACE: path.join(evidenceDir, "backend.log") },
    });
    await manager.waitFor((visible) => /Sessions/u.test(visible), "the existing dashboard's first paint", 120_000);
    steps.push({ step: "dashboard-opened", mode });

    manager.write(`a ${mode} session from the list`);
    await manager.waitFor((visible) => visible.includes(`a ${mode} session from the list`), "the prompt in the composer");
    manager.write("\r");

    // The row must appear ON SCREEN, named and in a usable state. This is the assertion the operator's
    // report was about: a launch that returns is not a session he can use.
    await manager.waitFor((visible) => /session-\d{10,}/u.test(visible), "a named session row on screen", 180_000);
    await manager.waitFor(
      (visible) => /session-\d{10,}\s+READY/u.test(visible.replace(/\u2026/gu, "")) || /READY/u.test(visible),
      "the row in a usable state",
      120_000,
    );
    const listed = /session-(\d{10,})/u.exec(manager.visible());
    const root = path.join(sessionsHome, `session-${listed[1]}`);
    const status = await statusOf(root, spawned, "status for the visible row");
    if (status.processState !== undefined) throw new Error("status should carry owner facts, not a row state");
    if (status.exit !== null || status.reaped !== null) throw new Error(`the owner behind the visible row is not alive: ${JSON.stringify(status.exit)}`);
    steps.push({ step: "prompt-enter-gave-a-visible-usable-row", root, ownerPid: status.owner.pid, ownerMode: status.ownerMode, providerIsFake: status.providerIsFake });

    // Usable means openable: Right hands the terminal to that session's Pi.
    manager.write("\u001b[C");
    await waitForAttachmentEpoch(root, 1, "the attachment opening from the visible row");
    const attached = await statusOf(root, spawned, "status while attached");
    steps.push({ step: "visible-row-opens", attachments: attached.attachments });

    const record = { passed: true, mode, sessionsHome, steps, atMs: Date.now() };
    await writeFile(path.join(evidenceDir, "launch-visible-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(evidenceDir, "launch-visible.visible.txt"), manager.visible());
    return record;
  } finally {
    // Owned cleanup either way: every session this flow created, plus its own processes.
    const created = (await readdir(sessionsHome, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(sessionsHome, entry.name));
    const stops = [];
    for (const sessionRoot of created) {
      stops.push(await demoCommand(["stop", "--root", sessionRoot], { label: `stop ${path.basename(sessionRoot)}`, spawned: [] })
        .then((answer) => ({ root: sessionRoot, exit: answer.exit }))
        .catch((failure) => ({ root: sessionRoot, error: failure.message })));
    }
    for (const process_ of spawned) {
      if (process_.handle.reapIfExited() !== null) continue;
      await stopIdentifiedProcess(process_.handle.owner, process_.label).catch(() => {});
    }
    await writeFile(path.join(evidenceDir, "launch-visible-cleanup.json"), `${JSON.stringify({ stops }, null, 2)}\n`).catch(() => {});
  }
}

/**
 * The operator's two blockers, through the ACTUAL manager-demo entry point on a non-100x30 terminal.
 *
 *   launch -> open -> type/edit -> submit -> eligible Left back -> reopen (same owner, same draft)
 *   -> resize the client PTY -> the owner's own dimensions follow, and input still works
 *
 * The terminal is deliberately 118x41 so a size that was merely inherited from the old 100x30 default would
 * show up as a failure rather than as a coincidence.
 *
 * @param {{ sessionsHome: string, evidenceDir: string }} options
 */
export async function runInputAndSizeFlow({ sessionsHome, evidenceDir }) {
  const spawned = [];
  const steps = [];
  let manager;
  const DRAFT = "a draft that must survive the round trip";
  try {
    await mkdir(evidenceDir, { recursive: true });
    const repo = await disposableRepository();
    manager = await openPtyProcess({
      args: [MANAGER, "--sessions", sessionsHome, "--cwd", repo], label: "manager-io", spawned,
      env: { PI_NATIVE_BACKEND_TRACE: path.join(evidenceDir, "backend.log") },
      cols: 118, rows: 41,
    });
    await manager.waitFor((visible) => /Sessions/u.test(visible), "the dashboard's first paint", 120_000);
    steps.push({ step: "dashboard-opened", terminal: { cols: 118, rows: 41 } });

    manager.write("a task for the sizing flow");
    await manager.waitFor((visible) => visible.includes("a task for the sizing flow"), "the prompt in the composer");
    manager.write("\r");
    await manager.waitFor((visible) => /session-\d{10,}/u.test(visible), "a named session row", 180_000);
    const root = path.join(sessionsHome, `session-${/session-(\d{10,})/u.exec(manager.visible())[1]}`);

    // The owner must be at the TERMINAL's size, not the demo's old default.
    const launched = await statusOf(root, spawned, "status after launch");
    if (launched.geometry.cols === 100 && launched.geometry.rows === 30) {
      throw new Error(`the owner took the old fixed default instead of this 118x41 terminal: ${JSON.stringify(launched.geometry)}`);
    }
    steps.push({ step: "owner-started-at-this-terminals-size", geometry: launched.geometry, geometryRevision: launched.geometryRevision });

    // Open it, type, and confirm input reaches Pi at all - the first blocker.
    manager.write("\u001b[C");
    await waitForAttachmentEpoch(root, 1, "the attachment");
    // Readiness arrives on the ingress channel a moment after `start` returns, because `start` waits for
    // native-mounted on the bootstrap sideband instead. Waiting for it is the test being correct about the
    // protocol; an earlier draft asserted it instantly and failed on its own impatience rather than on a defect.
    let attached;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      attached = await statusOf(root, spawned, "status while attached");
      if (attached.ingressReady === true) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (attached.ingressReady !== true) throw new Error("the session never became ready for input while attached");
    manager.write(DRAFT);
    await manager.waitFor((visible) => visible.includes(DRAFT), "the draft echoing from Pi's own editor", 60_000);
    steps.push({ step: "input-reaches-pi", ingressReady: attached.ingressReady, geometry: attached.geometry });

    // Resize the client's terminal mid-session, the way a window drag does.
    manager.handle.resize(92, 26);
    let resized;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      resized = await statusOf(root, spawned, "status after resize");
      if (resized.geometry.cols === 92 && resized.geometry.rows === 26) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (resized.geometry.cols !== 92 || resized.geometry.rows !== 26) {
      throw new Error(`the resize did not reach the owner: ${JSON.stringify(resized.geometry)}`);
    }
    // And input still works afterwards, which is what makes it a usable resize rather than a reported one.
    const afterResize = " typed after the resize";
    manager.write(afterResize);
    await manager.waitFor((visible) => visible.includes(afterResize.trim()), "typing after the resize", 60_000);
    steps.push({ step: "resize-reached-the-owner-and-stayed-usable", geometry: resized.geometry, geometryRevision: resized.geometryRevision });

    // Eligible Left back to the list, then reopen: same owner, same draft.
    //
    // The cursor is at the end of the draft after typing, and Left there is an editing key - correctly so. The
    // gesture's boundary is the start of the line, so Pi's own `tui.editor.cursorLineStart` (Ctrl+A) moves
    // there first. Nothing is deleted, because the draft is what the reopen has to prove survived.
    manager.write("\u0001");
    await new Promise((resolve) => setTimeout(resolve, 400));
    manager.write("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 150));
    manager.write("\u001b[D");
    // The existing dashboard has no "still running" banner of its own, so the return is judged on the owner's
    // own facts: the attachment is gone and the owner is the same process. Waiting on a screen string that
    // belongs to a different list is what made an earlier draft of this step time out on a return that worked.
    let returned;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      returned = await statusOf(root, spawned, "status after the return");
      if (returned.attachments.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (returned.attachments.length !== 0) throw new Error(`Left did not detach the attachment: ${JSON.stringify(returned.attachments)}`);
    if (returned.owner.pid !== launched.owner.pid) throw new Error("the owner changed across the return");
    if (returned.exit !== null || returned.reaped !== null) throw new Error("the owner ended across the return");
    if ((returned.returns ?? []).length !== 1) throw new Error(`expected one recorded return, got ${JSON.stringify(returned.returns)}`);
    manager.write("\u001b[C");
    await waitForAttachmentEpoch(root, 2, "the reopened attachment");
    await manager.waitFor((visible) => visible.split(DRAFT).length - 1 >= 2, "the retained draft on reopen", 60_000);
    const reopened = await statusOf(root, spawned, "status after reopen");
    steps.push({
      step: "left-returned-and-reopened-same-owner-and-draft",
      ownerPidUnchanged: reopened.owner.pid === launched.owner.pid,
      geometry: reopened.geometry,
      refusals: (reopened.geometryRefusals ?? []).length,
    });

    const record = { passed: true, sessionsHome, root, steps, atMs: Date.now() };
    await writeFile(path.join(evidenceDir, "input-and-size-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(evidenceDir, "input-and-size.visible.txt"), manager.visible());
    return record;
  } catch (error) {
    await mkdir(evidenceDir, { recursive: true });
    // Ingress lifecycle for whatever session this flow created, so an input failure is diagnosed from the
    // manager's and the pre-TUI caller's own records rather than from the screen.
    const diagnostics = {};
    for (const entry of (await readdir(sessionsHome, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory())) {
      const sessionRoot = path.join(sessionsHome, entry.name);
      diagnostics[entry.name] = {
        managerIngress: await readFile(path.join(sessionRoot, "manager.log"), "utf8")
          .then((text) => text.split("\n").filter((line) => /ingress|attached|held|refused/u.test(line)))
          .catch((failure) => [`unreadable: ${failure.message}`]),
        preload: await readFile(path.join(sessionRoot, "owner-preload.jsonl"), "utf8")
          .then((text) => text.trim().split("\n").map((line) => {
            try {
              const parsed = JSON.parse(line);
              const kept = { event: parsed.event };
              for (const key of ["mode", "hasDispatch", "reason", "message", "tuiMode", "frameType", "code"]) if (parsed[key] !== undefined) kept[key] = parsed[key];
              return kept;
            } catch { return { unparsed: true }; }
          }))
          .catch((failure) => [`unreadable: ${failure.message}`]),
      };
    }
    await writeFile(path.join(evidenceDir, "input-and-size-result.json"),
      `${JSON.stringify({ passed: false, sessionsHome, steps, failure: error.message, diagnostics, atMs: Date.now() }, null, 2)}\n`);
    if (manager !== undefined) await writeFile(path.join(evidenceDir, "input-and-size.visible.txt"), manager.visible()).catch(() => {});
    throw error;
  } finally {
    const created = (await readdir(sessionsHome, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory()).map((entry) => path.join(sessionsHome, entry.name));
    for (const sessionRoot of created) {
      await demoCommand(["stop", "--root", sessionRoot], { label: `stop ${path.basename(sessionRoot)}`, spawned: [] }).catch(() => {});
    }
    for (const process_ of spawned) {
      if (process_.handle.reapIfExited() !== null) continue;
      await stopIdentifiedProcess(process_.handle.owner, process_.label).catch(() => {});
    }
  }
}

/**
 * Live status and model selection, through the ACTUAL existing dashboard.
 *
 *   /model -> pick the SECOND fixture identity -> type a task -> Enter
 *   -> the row carries that model, Pi confirms it back, and the state moves working -> settled
 *      with no refresh and no relaunch
 *   -> Left returns, reopening keeps the same owner and the draft
 *
 * Fixture provider only: two labelled identities registered by the demo's own extension, a disposable
 * configuration directory, and no real provider call.
 *
 * @param {{ sessionsHome: string, evidenceDir: string }} options
 */
export async function runStatusAndModelsFlow({ sessionsHome, evidenceDir }) {
  const spawned = [];
  const steps = [];
  let manager;
  const DRAFT = "a draft that must survive status and model work";
  try {
    await mkdir(evidenceDir, { recursive: true });
    const repo = await disposableRepository();
    manager = await openPtyProcess({
      args: [MANAGER, "--sessions", sessionsHome, "--cwd", repo], label: "manager-status", spawned,
      env: {
        PI_NATIVE_BACKEND_TRACE: path.join(evidenceDir, "backend.log"),
        // The fixture holds its turn open long enough for WORKING to be observable. Without it the reply lands
        // in under a millisecond and this flow could only ever see the settled state.
        PI_DEMO_FAKE_DELAY_MS: "6000",
      },
      cols: 120, rows: 42,
    });
    await manager.waitFor((visible) => /Sessions/u.test(visible), "the dashboard's first paint", 120_000);

    // The EXISTING picker, opened the way the existing composer opens it.
    // `/model` is the existing composer's own command: typing it offers the suggestion, and submitting it is
    // what opens the picker overlay against `client.getModels()`.
    manager.write("/model");
    await manager.waitFor((visible) => visible.includes("model for the next session"), "the composer offering /model");
    manager.write("\r");
    await manager.waitFor((visible) => visible.includes("deterministic-echo"), "the fixture catalogue in the picker", 180_000);
    const sawAlt = manager.visible().includes("deterministic-echo-alt");
    // Choose the SECOND identity, so the selection cannot be confused with a default.
    manager.write("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 400));
    manager.write("\r");
    await manager.waitFor((visible) => visible.includes("deterministic-echo-alt"), "the chosen model on the composer", 60_000);
    steps.push({ step: "existing-picker-offered-two-identities", sawAlt, chose: "deterministic-echo-alt" });

    manager.write("run with the chosen model");
    await manager.waitFor((visible) => visible.includes("run with the chosen model"), "the prompt in the composer");
    manager.write("\r");
    await manager.waitFor((visible) => /session-\d{10,}/u.test(visible), "a named session row", 180_000);
    const root = path.join(sessionsHome, `session-${/session-(\d{10,})/u.exec(manager.visible())[1]}`);

    // The launch must have carried the chosen model, and Pi must confirm it back.
    let status;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      status = await statusOf(root, spawned, "status");
      if (status.bridge?.facts?.modelId !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (status.bridge?.facts?.modelId !== "deterministic-echo-alt") {
      throw new Error(`Pi confirmed model ${JSON.stringify(status.bridge?.facts?.modelId)}, not the chosen deterministic-echo-alt`);
    }
    steps.push({
      step: "chosen-model-reached-pi-and-was-confirmed-back",
      confirmed: { provider: status.bridge.facts.modelProvider, id: status.bridge.facts.modelId },
    });

    // Live status: the row's own state must move as Pi reports, with the list left open.
    const rows = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const state = rowStateFromStatus(await statusOf(root, spawned, "status"), {});
      rows.push({ taskState: state.taskState, agentPhase: state.agentPhase, known: state.stateIsKnown });
      if (state.agentPhase === "settled") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const settled = rows[rows.length - 1];
    if (settled.agentPhase !== "settled") throw new Error(`the run never reported settling: ${JSON.stringify(rows.slice(-3))}`);
    const sawWorking = rows.some((entry) => entry.taskState === "WORKING" || entry.agentPhase === "start");
    // Asserted, not merely recorded: "the state followed the run" is only true if the run was seen running.
    if (!sawWorking) throw new Error(`the row never reported WORKING before settling: ${JSON.stringify(rows.slice(0, 4))}`);
    steps.push({ step: "state-followed-the-run-without-refresh", sawWorking, settled, samples: rows.length });

    // Open it, type a draft, and come back: the earlier work must still hold.
    manager.write("\u001b[C");
    await waitForAttachmentEpoch(root, 1, "the attachment");
    manager.write(DRAFT);
    await manager.waitFor((visible) => visible.includes(DRAFT), "the draft echoing from Pi", 60_000);
    manager.write("\u0001");
    await new Promise((resolve) => setTimeout(resolve, 400));
    manager.write("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 150));
    manager.write("\u001b[D");
    let returned;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      returned = await statusOf(root, spawned, "status after return");
      if (returned.attachments.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (returned.attachments.length !== 0) throw new Error("Left did not detach");
    if (returned.owner.pid !== status.owner.pid) throw new Error("the owner changed across the return");
    manager.write("\u001b[C");
    await waitForAttachmentEpoch(root, 2, "the reopened attachment");
    await manager.waitFor((visible) => visible.split(DRAFT).length - 1 >= 2, "the retained draft", 60_000);
    steps.push({ step: "return-and-reopen-kept-owner-and-draft", ownerPidUnchanged: returned.owner.pid === status.owner.pid });

    const record = { passed: true, sessionsHome, root, steps, atMs: Date.now() };
    await writeFile(path.join(evidenceDir, "status-and-models-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(evidenceDir, "status-and-models.visible.txt"), manager.visible());
    return record;
  } catch (error) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "status-and-models-result.json"),
      `${JSON.stringify({ passed: false, sessionsHome, steps, failure: error.message, atMs: Date.now() }, null, 2)}\n`);
    if (manager !== undefined) await writeFile(path.join(evidenceDir, "status-and-models.visible.txt"), manager.visible()).catch(() => {});
    throw error;
  } finally {
    const created = (await readdir(sessionsHome, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory()).map((entry) => path.join(sessionsHome, entry.name));
    for (const sessionRoot of created) {
      await demoCommand(["stop", "--root", sessionRoot], { label: `stop ${path.basename(sessionRoot)}`, spawned: [] }).catch(() => {});
    }
    for (const process_ of spawned) {
      if (process_.handle.reapIfExited() !== null) continue;
      await stopIdentifiedProcess(process_.handle.owner, process_.label).catch(() => {});
    }
  }
}

/** A disposable Git repository, so worktree isolation has something real to branch from. */
async function disposableRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-delivery-repo-"));
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "--quiet"]);
  git(["config", "user.email", "demo@example.invalid"]);
  git(["config", "user.name", "Demo"]);
  await writeFile(path.join(root, "README.md"), "disposable\n");
  git(["add", "README.md"]);
  git(["commit", "--quiet", "-m", "base"]);
  return realpath(root);
}

/**
 * The task the operator typed actually runs, and runs once.
 *
 * `runLaunchVisibleFlow` proves a usable row appears. This proves the session is doing the thing he asked for:
 * the labelled fake provider answers with `DEMO-FAKE-REPLY <sha256(prompt)[:12]>`, so finding that digest on
 * the attached screen means the composer's exact bytes reached the provider. Nothing is typed after attaching,
 * which is what makes it a delivery proof rather than a second submission.
 *
 * The prompt deliberately begins with a dash and spans lines, because argv would not have carried it.
 *
 * @param {{ sessionsHome: string, evidenceDir: string, projectCwd?: string }} options
 */
export async function runPromptDeliveryFlow({ sessionsHome, evidenceDir, projectCwd }) {
  const spawned = [];
  const steps = [];
  let manager;
  const PROMPT = "--summarise this repository\nsecond line of the task";
  try {
    await mkdir(evidenceDir, { recursive: true });
    // The composer defaults to WORKTREE isolation, and this backend honours that rather than acknowledging
    // it, so the launch cwd has to be a real repository. A disposable one is created here for that reason:
    // pointing at a plain directory is refused before launch, which is the other half of the correction.
    const repo = projectCwd ?? await disposableRepository();
    manager = await openPtyProcess({
      args: [MANAGER, "--sessions", sessionsHome, "--cwd", repo],
      label: "manager-delivery", spawned,
      env: { PI_NATIVE_BACKEND_TRACE: path.join(evidenceDir, "backend.log") },
    });
    await manager.waitFor((visible) => /Sessions/u.test(visible), "the existing dashboard's first paint", 120_000);

    // The composer takes the prompt. A newline would submit, so the second line is typed as a literal
    // continuation the same way a paste would arrive: the composer collapses it, and the backend sends the
    // exact bytes the composer holds. The digest is computed from those same bytes below.
    const typed = PROMPT.replace(/\n/gu, " ");
    manager.write(typed);
    await manager.waitFor((visible) => visible.includes("--summarise this repository"), "the prompt in the composer");
    manager.write("\r");
    await manager.waitFor((visible) => /session-\d{10,}/u.test(visible), "a named session row", 180_000);
    const listed = /session-(\d{10,})/u.exec(manager.visible());
    const root = path.join(sessionsHome, `session-${listed[1]}`);
    steps.push({ step: "launched-with-a-task", typed });

    // Open it and look for the provider's answer to THAT prompt. Nothing is typed here.
    manager.write("\u001b[C");
    await waitForAttachmentEpoch(root, 1, "the attachment");
    const expected = deterministicReply({ messages: [{ role: "user", content: typed }] });
    const digest = expected.slice(FAKE_REPLY_PREFIX.length + 1).split(" ")[0];
    if (!/^[0-9a-f]{12}$/u.test(digest)) throw new Error(`the expected digest was not read cleanly: ${JSON.stringify(digest)}`);
    await manager.waitFor(
      (visible) => visible.includes(`${FAKE_REPLY_PREFIX} ${digest}`),
      `the provider's reply to the INITIAL prompt (digest ${digest}), with nothing typed after attaching`,
      180_000,
    );
    steps.push({ step: "provider-answered-the-initial-prompt", promptDigest: digest, typedAfterAttach: "" });

    // Exactly once: the prompt file was claimed by rename, and the claim is the once-only token.
    const promptFile = path.join(sessionsHome, `session-${listed[1]}.prompt`);
    const claimed = `${promptFile}.sent`;
    const stillPending = await readFile(promptFile, "utf8").then(() => true, () => false);
    const wasClaimed = await readFile(claimed, "utf8").then((text) => text === typed, () => false);
    if (stillPending) throw new Error("the prompt file was not claimed, so a replacement session could submit it again");
    if (!wasClaimed) throw new Error(`the claimed prompt file does not hold the exact submitted text: ${claimed}`);
    steps.push({ step: "submitted-exactly-once", claimedFile: claimed, pendingFileRemains: stillPending });

    const record = { passed: true, sessionsHome, root, prompt: typed, steps, atMs: Date.now() };
    await writeFile(path.join(evidenceDir, "prompt-delivery-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(evidenceDir, "prompt-delivery.visible.txt"), manager.visible());
    return record;
  } finally {
    const created = (await readdir(sessionsHome, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(sessionsHome, entry.name));
    for (const sessionRoot of created) {
      await demoCommand(["stop", "--root", sessionRoot], { label: `stop ${path.basename(sessionRoot)}`, spawned: [] }).catch(() => {});
    }
    for (const process_ of spawned) {
      if (process_.handle.reapIfExited() !== null) continue;
      await stopIdentifiedProcess(process_.handle.owner, process_.label).catch(() => {});
    }
  }
}


/**
 * `/rename <new name>` for the selected session, through the ACTUAL existing dashboard.
 *
 * Two fixture sessions exist when the rename is typed, so "only the selected one" is a claim this flow can
 * falsify rather than assume. The selection is driven to the TOP row with Up presses, and the top row's identity
 * is read from the rendered order before the rename, so no ANSI highlight has to be parsed.
 *
 * What it proves end to end:
 *   - the selected owner records the new name, and the OTHER owner does not;
 *   - the row in the existing list shows it;
 *   - reopening keeps the same owner PID and the draft typed into it;
 *   - a BRAND NEW backend reads the same name, so it is Pi's persisted metadata and not an in-memory alias.
 *
 * Fixture provider, disposable configuration, no real provider call.
 * @param {{ sessionsHome: string, evidenceDir: string }} options
 */
export async function runRenameFlow({ sessionsHome, evidenceDir }) {
  const spawned = [];
  const steps = [];
  let manager;
  const NEW_NAME = "renamed by the operator";
  const DRAFT = "a draft that must survive a rename";
  try {
    await mkdir(evidenceDir, { recursive: true });
    const repo = await disposableRepository();
    manager = await openPtyProcess({
      args: [MANAGER, "--sessions", sessionsHome, "--cwd", repo], label: "manager-rename", spawned,
      env: { PI_NATIVE_BACKEND_TRACE: path.join(evidenceDir, "backend.log") },
      cols: 120, rows: 42,
    });
    await manager.waitFor((visible) => /Sessions/u.test(visible), "the dashboard's first paint", 120_000);

    // Two sessions, so the rename has something to be wrong about.
    for (const task of ["first fixture session", "second fixture session"]) {
      manager.write(task);
      await manager.waitFor((visible) => visible.includes(task), `the prompt ${JSON.stringify(task)}`);
      manager.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await manager.waitFor((visible) => new Set(visible.match(/session-\d{10,}/gu) ?? []).size >= 2, "two session rows", 180_000);

    // Drive the selection to the top row, then read the rendered order. The first id painted is that row.
    for (let press = 0; press < 5; press += 1) {
      manager.write("\u001b[A");
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const painted = [...new Set(manager.visible().match(/session-\d{10,}/gu) ?? [])];
    if (painted.length < 2) throw new Error(`expected two session ids on screen, saw ${JSON.stringify(painted)}`);
    const [selectedId, otherId] = painted;
    const selectedRoot = path.join(sessionsHome, selectedId);
    const otherRoot = path.join(sessionsHome, otherId);
    const before = {
      selected: (await statusOf(selectedRoot, spawned, "selected before")).bridge?.facts?.sessionName ?? null,
      other: (await statusOf(otherRoot, spawned, "other before")).bridge?.facts?.sessionName ?? null,
    };
    steps.push({ step: "two-sessions-and-a-known-selection", selectedId, otherId, before });

    // The existing composer's own command path: type it, submit it.
    manager.write(`/rename ${NEW_NAME}`);
    await manager.waitFor((visible) => visible.includes(`/rename ${NEW_NAME}`), "the rename command in the composer");
    manager.write("\r");

    // The owner must CONFIRM it, which is what the row is allowed to show.
    let confirmed;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      confirmed = (await statusOf(selectedRoot, spawned, "selected after")).bridge?.facts?.sessionName ?? null;
      if (confirmed === NEW_NAME) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (confirmed !== NEW_NAME) throw new Error(`the selected owner reports ${JSON.stringify(confirmed)}, not the new name`);
    const otherAfter = (await statusOf(otherRoot, spawned, "other after")).bridge?.facts?.sessionName ?? null;
    if (otherAfter === NEW_NAME) throw new Error(`the OTHER session was renamed too, which means the wrong owner was asked`);
    steps.push({ step: "only-the-selected-owner-recorded-the-name", selected: confirmed, other: otherAfter });

    await manager.waitFor((visible) => visible.includes(NEW_NAME), "the new name on the existing row", 60_000);
    steps.push({ step: "the-existing-row-shows-the-confirmed-name" });

    // The rename must not have disturbed the session: same owner, and a draft survives a return and reopen.
    const status = await statusOf(selectedRoot, spawned, "status before opening");
    manager.write("\u001b[C");
    await waitForAttachmentEpoch(selectedRoot, 1, "the attachment");
    manager.write(DRAFT);
    await manager.waitFor((visible) => visible.includes(DRAFT), "the draft echoing from Pi", 60_000);
    manager.write("\u0001");
    await new Promise((resolve) => setTimeout(resolve, 400));
    manager.write("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 150));
    manager.write("\u001b[D");
    let returned;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      returned = await statusOf(selectedRoot, spawned, "status after return");
      if (returned.attachments.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (returned.attachments.length !== 0) throw new Error("Left did not detach");
    if (returned.owner.pid !== status.owner.pid) throw new Error("the owner changed across the rename and return");
    manager.write("\u001b[C");
    await waitForAttachmentEpoch(selectedRoot, 2, "the reopened attachment");
    await manager.waitFor((visible) => visible.split(DRAFT).length - 1 >= 2, "the retained draft", 60_000);
    steps.push({ step: "same-owner-and-draft-survived-the-rename", ownerPid: returned.owner.pid, ownerPidUnchanged: true });

    // A brand new reader: nothing of this rename lives in the dashboard's memory.
    const fresh = createNativeBackend({ sessionsHome });
    let freshName;
    try {
      const rows = (await fresh.getState()).sessions;
      freshName = rows.find((row) => row.sessionId === selectedId)?.name ?? null;
      const freshOther = rows.find((row) => row.sessionId === otherId)?.name ?? null;
      if (freshName !== NEW_NAME) throw new Error(`a fresh backend read ${JSON.stringify(freshName)}, not the persisted new name`);
      if (freshOther === NEW_NAME) throw new Error("a fresh backend attributed the new name to the other session");
      steps.push({ step: "a-fresh-backend-read-the-persisted-name", selected: freshName, other: freshOther });
    } finally {
      fresh.close();
    }

    const record = { passed: true, sessionsHome, selectedRoot, otherRoot, newName: NEW_NAME, steps, atMs: Date.now() };
    await writeFile(path.join(evidenceDir, "rename-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(evidenceDir, "rename.visible.txt"), manager.visible());
    return record;
  } catch (error) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "rename-result.json"),
      `${JSON.stringify({ passed: false, sessionsHome, steps, failure: error.message, atMs: Date.now() }, null, 2)}\n`);
    if (manager !== undefined) await writeFile(path.join(evidenceDir, "rename.visible.txt"), manager.visible()).catch(() => {});
    throw error;
  } finally {
    const created = (await readdir(sessionsHome, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory()).map((entry) => path.join(sessionsHome, entry.name));
    for (const sessionRoot of created) {
      await demoCommand(["stop", "--root", sessionRoot], { label: `stop ${path.basename(sessionRoot)}`, spawned: [] }).catch(() => {});
    }
    for (const process_ of spawned) {
      if (process_.handle.reapIfExited() !== null) continue;
      await stopIdentifiedProcess(process_.handle.owner, process_.label).catch(() => {});
    }
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--evidence");
  const evidenceDir = index === -1 ? path.join(tmpdir(), "manager-flow-evidence") : path.resolve(process.argv[index + 1]);
  const sessionsHome = await mkdtemp(path.join(tmpdir(), "pi-manager-flow-"));
  if (process.argv.includes("--rename")) {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "pi-rename-flow-"));
    runRenameFlow({ sessionsHome, evidenceDir })
      .then((record) => console.log(JSON.stringify(record, null, 2)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  } else if (process.argv.includes("--status-and-models")) {
    const record = await runStatusAndModelsFlow({ sessionsHome, evidenceDir });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else if (process.argv.includes("--input-and-size")) {
    const record = await runInputAndSizeFlow({ sessionsHome, evidenceDir });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else if (process.argv.includes("--delivery")) {
    const record = await runPromptDeliveryFlow({ sessionsHome, evidenceDir });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else if (process.argv.includes("--launch-only")) {
    const modeIndex = process.argv.indexOf("--mode");
    const mode = modeIndex === -1 ? "fake" : process.argv[modeIndex + 1];
    const record = await runLaunchVisibleFlow({ sessionsHome, evidenceDir, mode, projectCwd: sessionsHome });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else {
    const record = await runManagerFlow({ sessionsHome, evidenceDir });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  }
}
