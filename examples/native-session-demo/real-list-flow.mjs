#!/usr/bin/env node
/**
 * The approved flow through the list the operator actually runs.
 *
 * `list-flow.mjs` proves the session mechanics but opens `demo.mjs attach` itself, so it never executes
 * `list-demo.mjs`. This drives the real entry point on a real terminal, with only keystrokes:
 *
 *   n            create a session
 *   Enter        open it — the list hands this terminal to the attachment
 *   <draft>      type, and do not submit
 *   F9           return to the list
 *   Enter        open the same session again
 *   (draft)      still there, at a new epoch, in the same owner
 *   q            leave the list
 *
 * What this catches that the other path cannot: whether the list gives up and takes back terminal ownership
 * correctly. The list sets raw mode and reads stdin; the attachment then needs that same stdin. If the list
 * kept reading, keystrokes meant for Pi would be eaten; if it failed to resume afterwards, the list would be
 * dead after the first return. Both are only visible by driving the real loop.
 *
 * Owner survival is checked against the manager's own status, not against anything on screen, and the session
 * is stopped through the demo's own `stop` at the end.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FAKE_REPLY_PREFIX, deterministicReply } from "./fake-provider.mjs";
import { RETURN_SHORTCUT } from "./return-channel.mjs";
import { demoCommand, describeOwnerExit, openPtyProcess, stopIdentifiedProcess, verifyOwnerAbsence, waitForAttachmentEpoch } from "./smoke.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIST = path.join(HERE, "list-demo.mjs");
/** The bytes an F9 key press produces: the legacy sequence the installed Pi maps to `f9`. */
const F9 = "\u001b[20~";
const DRAFT = "a draft typed through the real list entry point";

/**
 * Wait until a marker has appeared at least `count` times.
 *
 * The harness accumulates everything the terminal printed, so a predicate that merely asks whether a marker is
 * present matches the FIRST time it ever appeared. Every paint of this list contains its own title, so the
 * second return has to be waited for by occurrence, not by presence. Getting this wrong is what made an earlier
 * run send `q` into Pi's editor instead of the list.
 */
function waitForOccurrence(process_, marker, count, description, timeoutMs = 60_000) {
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

export async function runRealListFlow({ sessionsHome, evidenceDir }) {
  const spawned = [];
  const steps = [];
  let root;
  let owner;
  let list;
  try {
    list = await openPtyProcess({ args: [LIST, "--sessions", sessionsHome], label: "list-demo", spawned });
    await list.waitFor((visible) => visible.includes("pi native session list"), "the list's first paint");
    await list.waitFor((visible) => visible.includes("no sessions yet"), "the empty-list line");
    // The list must name the return key, because that is the only way back out of a session.
    await list.waitFor((visible) => visible.includes(RETURN_SHORTCUT.toUpperCase()), "the return key in the footer");
    steps.push({ step: "list-opened", sessionsHome });

    // n: create a session. The list starts the owner itself.
    list.write("n");
    await list.waitFor((visible) => /started session-\d+/u.test(visible), "the list reporting a started session", 180_000);
    await list.waitFor((visible) => visible.includes("running, nobody attached"), "the new session's own row");
    const listed = /started (session-\d+)/u.exec(list.visible());
    root = path.join(sessionsHome, listed[1]);
    const started = await statusOf(root, spawned, "status after the list created it");
    owner = started.owner;
    steps.push({ step: "created-through-list", root, ownerPid: owner.pid, ownerMode: started.ownerMode });

    // Enter: open it. From here the attachment owns this terminal, so the next thing on screen is Pi.
    list.write("\r");
    // Epoch-scoped: an append-only log means a plain count can be satisfied by an earlier attachment's line.
    await waitForAttachmentEpoch(root, 1, "the attachment's welcome");
    await list.waitFor((visible) => visible.includes("native-session-demo"), "Pi's own widget on this terminal");
    const attachedStatus = await statusOf(root, spawned, "status while attached through the list");
    if (attachedStatus.attachments.length !== 1) {
      throw new Error(`expected exactly one attachment from the list, saw ${JSON.stringify(attachedStatus.attachments)}`);
    }
    steps.push({ step: "opened-through-list", attachments: attachedStatus.attachments });

    // Typing goes to Pi, which is the proof the list stopped reading this terminal's stdin.
    list.write(DRAFT);
    await list.waitFor((visible) => visible.includes(DRAFT), "the draft echoing from Pi, not eaten by the list");
    steps.push({ step: "typed-unsubmitted-draft", draft: DRAFT });

    // F9: back to the list. The owner must survive and the list must be interactive again.
    list.write(F9);
    await waitForOccurrence(list, "it is still running", 1, "the list's own return message");
    const afterReturn = await statusOf(root, spawned, "status after returning to the list");
    if (afterReturn.owner.pid !== owner.pid || afterReturn.owner.startIdentity !== owner.startIdentity) {
      throw new Error(`the owner changed across the return: ${JSON.stringify({ before: owner, after: afterReturn.owner })}`);
    }
    if (afterReturn.exit !== null || afterReturn.reaped !== null) throw new Error(`the owner ended across the return: ${JSON.stringify(afterReturn.exit)}`);
    if (afterReturn.attachments.length !== 0) throw new Error(`the returning attachment is still attached: ${JSON.stringify(afterReturn.attachments)}`);
    if (afterReturn.returns.length !== 1) throw new Error(`expected one recorded return, got ${JSON.stringify(afterReturn.returns)}`);
    steps.push({
      step: "returned-to-list",
      shortcut: RETURN_SHORTCUT,
      ownerPidUnchanged: true,
      ownerStartIdentityUnchanged: true,
      recordedReturns: afterReturn.returns,
      attachments: afterReturn.attachments,
    });

    // The list is alive after taking its terminal back: refresh responds, which needs stdin resumed.
    list.write("r");
    await waitForOccurrence(list, "running, nobody attached", 2, "the refreshed row showing nobody attached");
    steps.push({ step: "list-interactive-after-return" });

    // Enter again: the same owner, and the draft is still in it.
    list.write("\r");
    await waitForAttachmentEpoch(root, 2, "the second attachment's welcome");
    await waitForOccurrence(list, DRAFT, 2, "the retained draft on the repainted screen");
    const reopened = await statusOf(root, spawned, "status after reopening through the list");
    if (reopened.owner.pid !== owner.pid) throw new Error(`reopening reached a different owner: ${reopened.owner.pid} vs ${owner.pid}`);
    const epochs = reopened.attachments.map((attachment) => attachment.epoch);
    if (!epochs.includes(2)) throw new Error(`expected the reopened attachment at epoch 2, saw ${JSON.stringify(reopened.attachments)}`);
    steps.push({ step: "reopened-through-list", ownerPid: reopened.owner.pid, attachments: reopened.attachments });

    // Submit, and match the provider's digest of the exact prompt: proof the draft survived byte-exact.
    const expectedReply = deterministicReply({ messages: [{ role: "user", content: DRAFT }] });
    const digest = expectedReply.slice(FAKE_REPLY_PREFIX.length + 1).split(" ")[0];
    if (!/^[0-9a-f]{12}$/u.test(digest)) throw new Error(`the expected digest was not read cleanly: ${JSON.stringify(digest)}`);
    list.write("\r");
    await list.waitFor((visible) => visible.includes(`${FAKE_REPLY_PREFIX} ${digest}`), "the provider's prefix and prompt digest", 120_000);
    steps.push({ step: "submitted-and-answered", submitted: DRAFT, expectedReply, promptDigest: digest });

    // Return once more, then quit the list. Quitting must leave the owner running.
    list.write(F9);
    await waitForOccurrence(list, "it is still running", 2, "the list's second return message");
    list.write("q");
    const listExit = await list.waitForExit(60_000);
    if (listExit.code !== 0) throw new Error(`the list exited ${JSON.stringify(listExit)}`);
    const afterQuit = await statusOf(root, spawned, "status after quitting the list");
    if (afterQuit.owner.pid !== owner.pid || afterQuit.exit !== null || afterQuit.reaped !== null) {
      throw new Error(`quitting the list did not leave the owner running: ${JSON.stringify({ owner: afterQuit.owner, exit: afterQuit.exit })}`);
    }
    steps.push({ step: "quit-list-owner-survived", listExit, ownerPid: afterQuit.owner.pid, attachments: afterQuit.attachments });

    // Owned cleanup: this session's own stop, then verified absence.
    const stopAnswer = await demoCommand(["stop", "--root", root], { label: "stop", spawned });
    const stopped = JSON.parse(stopAnswer.output.slice(stopAnswer.output.indexOf("{")));
    const absence = await verifyOwnerAbsence(owner.pid, owner.startIdentity);
    steps.push({ step: "stopped", exit: describeOwnerExit(stopped.exit), absence });

    const record = { passed: true, sessionsHome, root, owner, shortcut: RETURN_SHORTCUT, steps, atMs: Date.now() };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "real-list-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(evidenceDir, "real-list.visible.txt"), list.visible());
    return record;
  } catch (error) {
    const cleanup = { demoStop: null, spawned: [] };
    if (root !== undefined) {
      cleanup.demoStop = await demoCommand(["stop", "--root", root], { label: "stop (cleanup)", spawned: [] })
        .then((answer) => ({ exit: answer.exit }))
        .catch((failure) => ({ error: failure.message }));
    }
    for (const process_ of spawned) {
      if (process_.handle.reapIfExited() !== null) continue;
      cleanup.spawned.push(await stopIdentifiedProcess(process_.handle.owner, process_.label).catch((failure) => ({ label: process_.label, error: failure.message })));
    }
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.join(evidenceDir, "real-list-result.json"),
      `${JSON.stringify({ passed: false, sessionsHome, root: root ?? null, owner: owner ?? null, steps, failure: /** @type {Error} */ (error).message, cleanup, atMs: Date.now() }, null, 2)}\n`,
    );
    if (list !== undefined) {
      await writeFile(path.join(evidenceDir, "real-list.visible.txt"), list.visible()).catch(() => {});
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--evidence");
  const evidenceDir = index === -1 ? path.join(tmpdir(), "real-list-evidence") : path.resolve(process.argv[index + 1]);
  const sessionsHome = await mkdtemp(path.join(tmpdir(), "pi-real-list-"));
  const record = await runRealListFlow({ sessionsHome, evidenceDir });
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}
