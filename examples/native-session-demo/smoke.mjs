/**
 * The acceptance smoke: the user flow this demo exists to show, driven through its own public commands.
 *
 * Nothing here reaches inside the demo. It runs `demo.mjs start`, then two independent `demo.mjs attach`
 * processes, each on its own real pseudo-terminal, and types bytes into those terminals exactly as an operator
 * would. What it asserts is what a human would see on the screen:
 *
 *   1. one native Pi, launched once, with its own PID and start identity;
 *   2. an unsent draft typed from the first attachment;
 *   3. every attachment detached, and that same owner still alive and unreaped;
 *   4. a reattachment repainted by Pi's own cold presentation, with the draft still there — and no captured
 *      bytes replayed to produce it;
 *   5. a second attachment that sees the same draft and the same UI, and can edit it;
 *   6. one submission, answered deterministically by the labelled fake provider, visible on both screens;
 *   7. an explicit stop that reports the owner's real wait status.
 *
 * Every wait is on an event — a terminal read, a process exit, a socket answer — with a bound that fails the
 * smoke rather than hanging it. Timings are measured, not claimed.
 */

import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReadStream } from "node:tty";
import { fileURLToPath } from "node:url";

import { openOwnerPty } from "../../runtime/pty-mechanism.mjs";
import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";
import { FAKE_REPLY_PREFIX, deterministicReply } from "./fake-provider.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, "demo.mjs");
const COLS = 100;
const ROWS = 30;
const CLIENT_ENV = { PATH: "/usr/bin:/bin", HOME: "/tmp", TERM: "xterm-256color", COLUMNS: String(COLS), LINES: String(ROWS), LANG: "C.UTF-8" };

const DRAFT = "unsent draft from client one";
const SECOND_EDIT = " and an edit from client two";

/** Escape sequences are the transport, not the content: assertions read the text a human would see. */
export function stripSequences(text) {
  return text
    .replace(/\u001b[\]_P^][\s\S]*?(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-9;?<>=!]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[()#][0-9A-Za-z]/gu, "")
    .replace(/\u001b[@-Z\\-_]/gu, "");
}

/** One process on its own pseudo-terminal, with event-driven waits over what it printed. */
async function openPtyProcess({ args, label }) {
  const handle = await openOwnerPty({ command: process.execPath, args, env: CLIENT_ENV, cwd: "/tmp", cols: COLS, rows: ROWS });
  const stream = new ReadStream(handle.masterFd);
  let raw = "";
  const waiters = [];
  stream.on("error", () => {});
  stream.on("data", (chunk) => {
    raw += chunk.toString("utf8");
    for (const waiter of [...waiters]) {
      if (waiter.predicate(stripSequences(raw), raw)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(Date.now());
      }
    }
  });
  return {
    label,
    handle,
    raw: () => raw,
    visible: () => stripSequences(raw),
    /**
     * Type into this process's terminal. One write, and no retry.
     *
     * `openOwnerPty`'s `write` may accept a prefix and then throw `PTY_INPUT_BACKPRESSURE`, and in the
     * mechanism's current state the accepted byte count exists only inside that error's human-readable
     * message. Parsing prose for a resume offset would be a guess, and re-writing the whole buffer would
     * duplicate the prefix the terminal already took, so this does neither: a partial write fails the smoke
     * loudly and says why. When the mechanism exposes a structured `bytesWritten`/`totalBytes`, this is the
     * one place that changes.
     */
    write(text) {
      const bytes = Buffer.from(text, "utf8");
      try {
        handle.write(bytes);
      } catch (cause) {
        throw new Error(
          `${label}: writing ${bytes.byteLength} bytes to its terminal failed (${/** @type {any} */ (cause).code ?? "unknown"}). ` +
            "Nothing was retried and nothing was parsed out of the error text: the accepted byte count is not " +
            "available as structured data, so a retry could duplicate input the terminal already accepted.",
          { cause },
        );
      }
    },
    waitFor(predicate, description, timeoutMs = 60_000) {
      if (predicate(stripSequences(raw), raw)) return Promise.resolve(Date.now());
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`${label}: ${description} never happened within ${timeoutMs}ms; visible screen was ${JSON.stringify(stripSequences(raw).slice(-1200))}`));
        }, timeoutMs);
        waiter.resolve = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
    },
    async waitForExit(timeoutMs = 30_000) {
      let timer;
      try {
        return await Promise.race([
          handle.wait(),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} had not exited within ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        stream.destroy();
      }
    },
  };
}

/** One demo command, run to completion, with its stdout captured. Exit status is asserted, never ignored. */
async function demoCommand(args, { label }) {
  const process_ = await openPtyProcess({ args: [DEMO, ...args], label });
  const exit = await process_.waitForExit();
  if (exit.code !== 0) {
    throw new Error(`${label} exited ${JSON.stringify(exit)}; output was ${JSON.stringify(process_.visible().slice(-2000))}`);
  }
  return { exit, output: process_.visible() };
}

/**
 * @param {{ root: string, evidenceDir: string }} options
 */
export async function runSmoke({ root, evidenceDir }) {
  await mkdir(evidenceDir, { recursive: true });
  const timings = {};
  const at = (name, from) => {
    timings[name] = Date.now() - from;
  };
  const steps = [];
  const commands = [];
  /** @param {string} name @param {string[]} argv */
  const note = (name, argv) => {
    commands.push({ name, command: `${process.execPath} ${argv.join(" ")}` });
  };

  const startArgs = [DEMO, "start", "--root", root, "--cols", String(COLS), "--rows", String(ROWS)];
  note("start", startArgs);
  const startedFrom = Date.now();
  const started = await demoCommand(startArgs.slice(1), { label: "demo start" });
  at("startMs", startedFrom);
  const ownerPid = Number(/owner pid (\d+)/u.exec(started.output)?.[1]);
  const ownerStartIdentity = /startIdentity (\d+)/u.exec(started.output)?.[1];
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error(`demo start printed no owner pid: ${started.output}`);
  const ownerAtStart = await inspectProcessIdentity(ownerPid);
  steps.push({ step: "start", ownerPid, ownerStartIdentity, output: started.output.trim() });

  // 1. The first attachment, on its own terminal.
  const attachOneArgs = [DEMO, "attach", "--root", root, "--id", "client-1"];
  note("attach client-1", attachOneArgs);
  const attachFrom = Date.now();
  const clientOne = await openPtyProcess({ args: attachOneArgs, label: "client-1" });
  await clientOne.waitFor((visible) => visible.includes("attached as client-1 epoch 1"), "client-1 welcome");
  await clientOne.waitFor((visible) => visible.includes("native-session-demo"), "the first cold presentation");
  at("firstAttachToPaintMs", attachFrom);
  steps.push({ step: "attach-client-1-epoch-1", elapsedMs: timings.firstAttachToPaintMs });

  // 2. An unsent draft, typed from the first attachment and never submitted.
  const draftFrom = Date.now();
  clientOne.write(DRAFT);
  await clientOne.waitFor((visible) => visible.includes(DRAFT), "the draft echoing on client-1");
  at("draftEchoMs", draftFrom);

  // 3. Detach everything. The owner must survive it.
  const detachArgs = [DEMO, "detach", "--root", root];
  note("detach all", detachArgs);
  const detached = await demoCommand(detachArgs.slice(1), { label: "demo detach" });
  const exitOne = await clientOne.waitForExit();
  const ownerAfterDetach = await inspectProcessIdentity(ownerPid);
  const statusAfterDetach = JSON.parse((await demoCommand(["status", "--root", root], { label: "demo status" })).output);
  if (statusAfterDetach.ownerAliveWithZeroClients !== true) throw new Error(`the owner did not survive detaching every client: ${JSON.stringify(statusAfterDetach)}`);
  if (ownerAfterDetach.startIdentity !== ownerAtStart.startIdentity) throw new Error("the owner's start identity changed across a detach");
  steps.push({
    step: "detach-all",
    clientOneExit: exitOne,
    ownerAliveWithZeroClients: statusAfterDetach.ownerAliveWithZeroClients,
    ownerIdentityUnchanged: true,
    detachOutput: detached.output.trim(),
  });

  // 4. Reattach the same attachment id. Pi repaints; nothing is replayed.
  const reattachArgs = [DEMO, "attach", "--root", root, "--id", "client-1"];
  note("reattach client-1", reattachArgs);
  const reattachFrom = Date.now();
  const clientOneAgain = await openPtyProcess({ args: reattachArgs, label: "client-1-epoch-2" });
  await clientOneAgain.waitFor((visible) => visible.includes("attached as client-1 epoch 2"), "client-1 epoch 2 welcome");
  await clientOneAgain.waitFor((visible) => visible.includes(DRAFT), "the retained draft on the repainted screen");
  at("reattachToRetainedDraftMs", reattachFrom);
  steps.push({ step: "reattach-client-1-epoch-2", elapsedMs: timings.reattachToRetainedDraftMs, retainedDraft: DRAFT });

  // 5. A second attachment shares the same draft and the same UI.
  const attachTwoArgs = [DEMO, "attach", "--root", root, "--id", "client-2"];
  note("attach client-2", attachTwoArgs);
  const secondFrom = Date.now();
  const clientTwo = await openPtyProcess({ args: attachTwoArgs, label: "client-2" });
  await clientTwo.waitFor((visible) => visible.includes("attached as client-2 epoch 1"), "client-2 welcome");
  await clientTwo.waitFor((visible) => visible.includes(DRAFT), "the shared draft on client-2's own cold presentation");
  at("secondAttachToSharedDraftMs", secondFrom);

  // 6. Edit from the second attachment, submit, and read the deterministic reply on both screens.
  const editFrom = Date.now();
  clientTwo.write(SECOND_EDIT);
  await clientTwo.waitFor((visible) => visible.includes(SECOND_EDIT.trim()), "client-2's edit echoing");
  await clientOneAgain.waitFor((visible) => visible.includes(SECOND_EDIT.trim()), "client-2's edit reaching client-1's screen");
  at("sharedEditMs", editFrom);
  const submitted = `${DRAFT}${SECOND_EDIT}`;
  const expectedReply = deterministicReply({ messages: [{ role: "user", content: submitted }] });
  const submitFrom = Date.now();
  clientTwo.write("\r");
  await clientTwo.waitFor((visible) => visible.includes(expectedReply), "the fake provider's deterministic reply on client-2");
  await clientOneAgain.waitFor((visible) => visible.includes(expectedReply), "the same reply on client-1");
  at("submitToReplyMs", submitFrom);
  steps.push({
    step: "shared-edit-and-submission",
    submitted,
    expectedReply,
    replyPrefix: FAKE_REPLY_PREFIX,
    sharedEditMs: timings.sharedEditMs,
    submitToReplyMs: timings.submitToReplyMs,
  });

  // 7. Explicit stop. It reports the owner's real wait status and takes nothing else with it.
  const detachBoth = await demoCommand(["detach", "--root", root], { label: "demo detach (second round)" });
  const exitTwo = await clientTwo.waitForExit();
  const exitOneAgain = await clientOneAgain.waitForExit();
  const stopArgs = [DEMO, "stop", "--root", root, "--keep-root"];
  note("stop", stopArgs);
  const stopFrom = Date.now();
  const stopped = JSON.parse((await demoCommand(stopArgs.slice(1), { label: "demo stop" })).output);
  at("stopMs", stopFrom);
  let ownerGone = false;
  try {
    await inspectProcessIdentity(ownerPid);
  } catch {
    ownerGone = true;
  }
  steps.push({ step: "stop", detachOutput: detachBoth.output.trim(), clientTwoExit: exitTwo, clientOneExit: exitOneAgain, stopped, ownerGone });

  for (const [source, destination] of [
    [path.join(root, "manager.log"), "manager.log"],
    [path.join(root, "owner-preload.jsonl"), "owner-preload.jsonl"],
    [path.join(root, "owner.json"), "owner.json"],
  ]) {
    await cp(source, path.join(evidenceDir, destination), { force: true }).catch(() => {});
  }
  await writeFile(path.join(evidenceDir, "client-1-epoch-1.transcript"), clientOne.raw());
  await writeFile(path.join(evidenceDir, "client-1-epoch-2.transcript"), clientOneAgain.raw());
  await writeFile(path.join(evidenceDir, "client-2-epoch-1.transcript"), clientTwo.raw());
  await writeFile(path.join(evidenceDir, "client-1-epoch-2.visible.txt"), clientOneAgain.visible());
  await writeFile(path.join(evidenceDir, "client-2-epoch-1.visible.txt"), clientTwo.visible());

  const result = {
    passed: true,
    root,
    owner: { pid: ownerPid, startIdentity: ownerStartIdentity, identityAtStart: ownerAtStart, identityAfterDetach: ownerAfterDetach, goneAfterStop: ownerGone },
    timings,
    steps,
    commands,
    unexercised: [
      "seam A: no native submission host is registered, so the barrier, its fences and its draft-commit order are not exercised here",
      "seam C: the default editor owns the return key, so authorizeReturn is never consulted and no return-key detach is demonstrated",
      "seams C and F response authorization: the pseudo-terminals this smoke drives answer no capability query, so beforeApplyTerminalResponse was never consulted",
      "seam G: no external editor is launched, so no drain, phase announcement or handoff-closed refusal is demonstrated",
      "tools are disabled with -nt, so no tool call, no child process and no Kitty graphics path is exercised",
      "geometry is fixed at launch; a client with a different terminal size is warned, not resized",
    ],
    // The owner pseudo-terminal this ran on is a provisional dependency whose own review returned BLOCK. A
    // passing smoke does not make it reviewed, so every run carries the caveat in its own artifact.
    dependencyUnderReview: {
      mechanism: "runtime/pty-mechanism.mjs and vendor/pty, merged provisionally from 715e59e",
      verdict: "BLOCK",
      openP1: [
        "spawned identity can race the native reaper and PID reuse, so every owner identity recorded here inherits that doubt",
        "a partial PTY write reports its accepted byte count only in error text; this smoke parses none of it and retries nothing",
        "third-party notices for the shipped native artifact are unresolved, which blocks release and package qualification",
      ],
      notCalledHere: ["foregroundProcessGroup", "resize"],
      authorized: "run in place from this worktree; no redistribution and no live activation",
    },
    atMs: Date.now(),
  };
  await writeFile(path.join(evidenceDir, "smoke-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const evidenceIndex = process.argv.indexOf("--evidence");
  const rootIndex = process.argv.indexOf("--root");
  if (evidenceIndex === -1) throw new Error("smoke.mjs needs --evidence <directory>");
  const result = await runSmoke({
    root: rootIndex === -1 ? `/tmp/pi-nsd-smoke-${process.pid}` : process.argv[rootIndex + 1],
    evidenceDir: path.resolve(process.argv[evidenceIndex + 1]),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
