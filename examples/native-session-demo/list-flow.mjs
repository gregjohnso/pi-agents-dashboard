#!/usr/bin/env node
/**
 * The approved flow, end to end, through the paths an operator actually uses.
 *
 *   1. start one session under a disposable sessions home, and see it as a fact-built list row;
 *   2. attach, and type an **unsubmitted** draft into real Pi;
 *   3. press F9 — the in-Pi return gesture — and come back to the list;
 *   4. prove the owner is untouched: same pid, same start identity, still alive, zero attachments;
 *   5. attach again, and find the same draft still in the editor;
 *   6. submit it, and check the labelled fake provider's exact deterministic reply;
 *   7. stop only this session's owner, with a verified wait status and procfs-confirmed absence.
 *
 * The gesture is the point. Step 3 sends the bytes an F9 key press produces and asserts that the *attachment*
 * ended while the *owner* did not. Nothing here parses a key or scrapes state: the draft is checked on the
 * rendered screen, but every lifecycle claim comes from the manager's own `status` answer and from procfs.
 *
 * A second attachment is kept open across the return, so "detach only the terminal that asked" is asserted
 * rather than assumed: it must still be attached and still see the session afterwards.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readSessions, describeSession } from "./list-demo.mjs";
import { FAKE_REPLY_PREFIX, deterministicReply } from "./fake-provider.mjs";
import { RETURN_SHORTCUT } from "./return-channel.mjs";
import { demoCommand, describeOwnerExit, openPtyProcess, stopIdentifiedProcess, verifyOwnerAbsence, waitForAttachmentDiagnostic } from "./smoke.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, "demo.mjs");
/** The bytes an F9 key press produces. The legacy sequence the installed Pi maps to `f9`. */
const F9 = "\u001b[20~";
const DRAFT = "an unsent draft that must survive returning to the list";

/** Ask one session's manager for its status, through the demo's own control command. */
async function sessionStatus(root, spawned, label) {
  const answer = await demoCommand(["status", "--root", root], { label, spawned });
  return JSON.parse(answer.output.slice(answer.output.indexOf("{")));
}

export async function runListFlow({ sessionsHome, evidenceDir }) {
  const spawned = [];
  const steps = [];
  const root = path.join(sessionsHome, "session-flow");
  let owner;
  try {
    // 1. Start one session, and read it back as a list row built from facts.
    const started = await demoCommand(["start", "--root", root], { label: "start", spawned });
    const initial = await sessionStatus(root, spawned, "status after start");
    owner = initial.owner;
    const listed = await readSessions(sessionsHome);
    const row = listed.find((session) => session.root === root);
    if (row === undefined || !row.live) throw new Error(`the list did not show the started session as live: ${JSON.stringify(listed)}`);
    if (row.owner.pid !== owner.pid) throw new Error(`the list row named pid ${row.owner.pid}, the manager named ${owner.pid}`);
    steps.push({
      step: "list-shows-started-session",
      startExit: started.exit,
      row: describeSession(row),
      ownerPid: owner.pid,
      ownerMode: initial.ownerMode,
      providerIsFake: initial.providerIsFake,
      attachments: row.attachments,
    });

    // 2. Open it, and type a draft that is never submitted.
    const first = await openPtyProcess({ args: [DEMO, "attach", "--root", root, "--id", "list-1"], label: "attachment-1", spawned });
    await waitForAttachmentDiagnostic(root, "attached as list-1 epoch 1", 1, "the first attachment's welcome");
    await first.waitFor((visible) => visible.includes("native-session-demo"), "the first cold presentation");
    // A second terminal stays attached across the return, so per-attachment detach is proven, not assumed.
    const bystander = await openPtyProcess({ args: [DEMO, "attach", "--root", root, "--id", "bystander"], label: "bystander", spawned });
    await waitForAttachmentDiagnostic(root, "attached as bystander epoch 1", 1, "the bystander's welcome");
    first.write(DRAFT);
    await first.waitFor((visible) => visible.includes(DRAFT), "the draft echoing on the first attachment");
    await bystander.waitFor((visible) => visible.includes(DRAFT), "the draft reaching the bystander");
    steps.push({ step: "typed-unsubmitted-draft", draft: DRAFT, attachments: (await sessionStatus(root, spawned, "status with two attachments")).attachments });

    // 3. The gesture. F9 inside Pi, and the attachment ends.
    //
    // A refusal is reported out loud by the extension, so the wait resolves on either outcome rather than
    // timing out with nothing to read: a refused gesture names its own reason.
    first.write(F9);
    const ended = first.waitForExit(45_000).then(
      (exit) => ({ kind: "exit", exit }),
      (error) => ({ kind: "timeout", detail: error.message }),
    );
    const refused = first.waitFor((visible) => visible.includes("did not return to the list"), "a refusal notice", 45_000).then(
      () => ({ kind: "refused" }),
      () => ({ kind: "no-refusal" }),
    );
    const outcome = await Promise.race([ended, refused]);
    if (outcome.kind !== "exit") {
      throw new Error(
        `${RETURN_SHORTCUT} did not return to the list (${outcome.kind}${outcome.detail ? `: ${outcome.detail}` : ""}). ` +
          `Visible screen was ${JSON.stringify(first.visible().slice(-1500))}`,
      );
    }
    const firstExit = outcome.exit;
    if (firstExit.code !== 0) throw new Error(`${RETURN_SHORTCUT} ended the attachment with ${JSON.stringify(firstExit)}`);

    // 4. The owner is untouched, and only the terminal that asked was detached.
    const afterReturn = await sessionStatus(root, spawned, "status after the return gesture");
    const stillAttached = afterReturn.attachments.map((attachment) => attachment.attachmentId);
    if (afterReturn.owner.pid !== owner.pid || afterReturn.owner.startIdentity !== owner.startIdentity) {
      throw new Error(`the owner changed across the return: ${JSON.stringify({ before: owner, after: afterReturn.owner })}`);
    }
    if (afterReturn.exit !== null || afterReturn.reaped !== null) throw new Error(`the owner ended across the return: ${JSON.stringify(afterReturn.exit)}`);
    if (stillAttached.includes("list-1")) throw new Error("the returning attachment is still attached");
    if (!stillAttached.includes("bystander")) throw new Error(`the bystander was detached too: ${JSON.stringify(stillAttached)}`);
    if (afterReturn.returns.length !== 1 || afterReturn.returns[0].attachmentId !== "list-1" || afterReturn.returns[0].epoch !== 1) {
      throw new Error(`the manager did not record exactly one return for list-1 epoch 1: ${JSON.stringify(afterReturn.returns)}`);
    }
    steps.push({
      step: "returned-to-list",
      shortcut: RETURN_SHORTCUT,
      attachmentExit: firstExit,
      ownerPidUnchanged: afterReturn.owner.pid === owner.pid,
      ownerStartIdentityUnchanged: afterReturn.owner.startIdentity === owner.startIdentity,
      recordedReturns: afterReturn.returns,
      stillAttached,
    });

    // The list, re-read from facts, must now show the same session running with the bystander attached.
    const afterRow = (await readSessions(sessionsHome)).find((session) => session.root === root);
    if (afterRow === undefined || !afterRow.live || afterRow.attachments !== 1) {
      throw new Error(`the list did not show the session still running with one attachment: ${JSON.stringify(afterRow)}`);
    }
    steps.push({ step: "list-shows-session-still-running", row: describeSession(afterRow) });

    // 5. Reopen, and find the same draft.
    const second = await openPtyProcess({ args: [DEMO, "attach", "--root", root, "--id", "list-1"], label: "attachment-2", spawned });
    await waitForAttachmentDiagnostic(root, "attached as list-1 epoch 2", 1, "the reopened attachment's welcome");
    await second.waitFor((visible) => visible.includes(DRAFT), "the retained draft on the repainted screen");
    steps.push({ step: "reopened-same-session-with-draft", epoch: 2, retainedDraft: DRAFT });

    // 6. Submit it, and check the fake provider's own digest of the exact prompt it received.
    //
    // The digest is the assertion rather than the whole reply on purpose. It is `sha256(prompt)[:12]`, computed
    // by the provider from the text Pi actually submitted, so finding it proves the draft arrived byte-exact —
    // and being short it cannot be broken across a line wrap, which a long reply can be.
    const expectedReply = deterministicReply({ messages: [{ role: "user", content: DRAFT }] });
    const digest = expectedReply.slice(FAKE_REPLY_PREFIX.length + 1).split(" ")[0];
    if (!/^[0-9a-f]{12}$/u.test(digest)) throw new Error(`the expected digest was not read cleanly: ${JSON.stringify(digest)}`);
    second.write("\r");
    await second.waitFor((visible) => visible.includes(`${FAKE_REPLY_PREFIX} ${digest}`), "the fake provider's prefix and exact prompt digest");
    await bystander.waitFor((visible) => visible.includes(digest), "the same digest on the bystander's screen");
    steps.push({ step: "submitted-and-answered", submitted: DRAFT, expectedReply, promptDigest: digest });

    // 7. Stop this session's owner, and verify it is really gone.
    const secondExit = await second.waitForExit().catch(() => null);
    const stopAnswer = await demoCommand(["stop", "--root", root], { label: "stop", spawned });
    const stopped = JSON.parse(stopAnswer.output.slice(stopAnswer.output.indexOf("{")));
    const absence = await verifyOwnerAbsence(owner.pid, owner.startIdentity);
    steps.push({
      step: "stopped",
      exit: describeOwnerExit(stopped.exit),
      absence,
      reopenedAttachmentExit: secondExit,
    });

    const record = { passed: true, sessionsHome, root, owner, shortcut: RETURN_SHORTCUT, steps, atMs: Date.now() };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "list-flow-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(path.join(evidenceDir, "attachment-2.visible.txt"), second.visible());
    await writeFile(path.join(evidenceDir, "bystander.visible.txt"), bystander.visible());
    return record;
  } catch (error) {
    // Clean up only what this flow started, each by its own recorded identity.
    const cleanup = { demoStop: null, spawned: [] };
    cleanup.demoStop = await demoCommand(["stop", "--root", root], { label: "stop (cleanup)", spawned: [] })
      .then((answer) => ({ exit: answer.exit }))
      .catch((failure) => ({ error: failure.message }));
    for (const process_ of spawned) {
      if (process_.handle.reapIfExited() !== null) continue;
      cleanup.spawned.push(await stopIdentifiedProcess(process_.handle.owner, process_.label).catch((failure) => ({ label: process_.label, error: failure.message })));
    }
    const record = { passed: false, sessionsHome, root, owner, steps, failure: /** @type {Error} */ (error).message, cleanup, atMs: Date.now() };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "list-flow-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    // Every screen this flow drove, so a failure is diagnosed from what the operator would have seen.
    for (const process_ of spawned) {
      if (typeof process_.visible !== "function") continue;
      await writeFile(path.join(evidenceDir, `${process_.label}.visible.txt`), process_.visible()).catch(() => {});
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidenceIndex = process.argv.indexOf("--evidence");
  const evidenceDir = evidenceIndex === -1 ? path.join(tmpdir(), "list-flow-evidence") : path.resolve(process.argv[evidenceIndex + 1]);
  const sessionsHome = await mkdtemp(path.join(tmpdir(), "pi-list-flow-"));
  const record = await runListFlow({ sessionsHome, evidenceDir });
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}
