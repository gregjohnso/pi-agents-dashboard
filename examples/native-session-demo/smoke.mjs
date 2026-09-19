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
 *
 * A pass is a conjunction, not a default. `passed` is true only when every step above held *and* the stop was
 * verified: the original owner demonstrably gone, and an actual raw `wait(2)` status for it. An inspection that
 * cannot answer — a permission error, malformed proc data, an ambiguous identity — is uncertainty, and
 * uncertainty fails. The standalone run and the Vitest wrapper read that same verdict.
 */

import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReadStream } from "node:tty";
import { fileURLToPath } from "node:url";

import { openOwnerPty } from "../../runtime/pty-mechanism.mjs";
import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "../../runtime/process-signaler.mjs";
import { FAKE_REPLY_PREFIX, deterministicReply } from "./fake-provider.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, "demo.mjs");
const COLS = 100;
const ROWS = 30;
const CLIENT_ENV = { PATH: "/usr/bin:/bin", HOME: "/tmp", TERM: "xterm-256color", COLUMNS: String(COLS), LINES: String(ROWS), LANG: "C.UTF-8" };
/** Only ever applied to a process this smoke spawned, re-verified by identity immediately before every signal. */
const CLEANUP_STOP_POLICY = { gracefulMs: 2_000, terminateMs: 2_000 };

const DRAFT = "unsent draft from client one";
const SECOND_EDIT = " and an edit from client two";

/**
 * Is the process that owned this session demonstrably gone?
 *
 * `ENOENT`/`ESRCH` from procfs is absence. A live PID carrying another start identity is absence too: the
 * original owner is gone and the number was reused. Everything else — `EACCES`, malformed proc data, an
 * ambiguous identity — is an inspection that could not answer, and that is not absence.
 *
 * @param {number} pid @param {string} startIdentity
 * @param {(pid: number) => Promise<{ pid: number, processGroupId: number, startIdentity: string }>} [inspect]
 */
export async function verifyOwnerAbsence(pid, startIdentity, inspect = inspectProcessIdentity) {
  try {
    const found = await inspect(pid);
    if (found.startIdentity !== startIdentity) {
      return { gone: true, reason: `pid ${pid} now carries start identity ${found.startIdentity}, not the owner's ${startIdentity}`, observed: found };
    }
    return { gone: false, reason: `pid ${pid} is still live with the owner's start identity ${startIdentity}`, observed: found };
  } catch (cause) {
    const code = /** @type {any} */ (cause)?.code ?? null;
    if (code === "ENOENT" || code === "ESRCH") return { gone: true, reason: `procfs reports ${code} for pid ${pid}`, code };
    return { gone: false, reason: `inspecting pid ${pid} could not answer (${code ?? /** @type {Error} */ (cause).message}), so absence is unproven`, code };
  }
}

/**
 * What the stop answer actually proves about the owner's exit.
 *
 * A disposition is a description of what the manager did; only a raw `wait(2)` status with an exit code or a
 * terminating signal is evidence that the owner exited. A stop that timed out without one is reported as
 * unverified rather than successful, and its diagnostics are kept.
 *
 * @param {any} exit
 */
export function describeOwnerExit(exit) {
  if (exit === null || typeof exit !== "object") return { observed: false, reason: "the stop answer carried no exit record" };
  const disposition = exit.disposition ?? null;
  if (exit.waitObserved === false) return { observed: false, reason: `the manager observed no wait status (disposition ${JSON.stringify(disposition)})`, disposition };
  if (!Number.isInteger(exit.status)) return { observed: false, reason: `the stop answer carried no raw wait status (disposition ${JSON.stringify(disposition)})`, disposition };
  if (!Number.isInteger(exit.code) && typeof exit.signal !== "string") {
    return { observed: false, reason: `raw wait status ${exit.status} named neither an exit code nor a terminating signal`, disposition };
  }
  return { observed: true, status: exit.status, code: Number.isInteger(exit.code) ? exit.code : null, signal: typeof exit.signal === "string" ? exit.signal : null, disposition };
}

/** Escape sequences are the transport, not the content: assertions read the text a human would see. */
export function stripSequences(text) {
  return text
    .replace(/\u001b[\]_P^][\s\S]*?(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-9;?<>=!]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[()#][0-9A-Za-z]/gu, "")
    .replace(/\u001b[@-Z\\-_]/gu, "");
}

/** One process on its own pseudo-terminal, with event-driven waits over what it printed. */
async function openPtyProcess({ args, label, spawned }) {
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
  const opened = {
    label,
    handle,
    raw: () => raw,
    visible: () => stripSequences(raw),
    /**
     * Type into this process's terminal. One write, and no retry.
     *
     * `openOwnerPty`'s `write` refuses a partial write with numeric `bytesWritten`/`totalBytes` on the error, so
     * the accepted suffix boundary is data rather than prose. This smoke still does not retry: it types spans a
     * terminal's input buffer takes whole, so a partial write means something it does not model happened. It
     * fails loudly and reports those two numbers as numbers — nothing is parsed out of the message text.
     */
    write(text) {
      const bytes = Buffer.from(text, "utf8");
      try {
        handle.write(bytes);
      } catch (cause) {
        const failure = /** @type {{ code?: string, bytesWritten?: number | null, totalBytes?: number | null }} */ (cause);
        throw new Error(
          `${label}: writing ${bytes.byteLength} bytes to its terminal failed (${failure.code ?? "unknown"}, ` +
            `bytesWritten ${failure.bytesWritten ?? "null"} of totalBytes ${failure.totalBytes ?? "null"}). ` +
            "Nothing was retried: this smoke types spans small enough to be accepted whole, so a partial write is " +
            "a condition it does not model. The counts above are read as numbers from the error, never parsed from its text.",
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
  // Recorded so a failure can stop exactly the processes this smoke started, by their own spawned identity.
  spawned.push(opened);
  return opened;
}

/** Stop one process this smoke started, and only while its recorded identity still matches. */
async function stopIdentifiedProcess(identity, label) {
  const outcome = await stopVerifiedProcessGroup(
    { pid: identity.pid, processGroupId: identity.processGroupId, startIdentity: identity.startIdentity },
    { inspect: (pid) => inspectProcessIdentity(pid), requestGraceful: async () => {}, signalProcessGroup, sleep },
    CLEANUP_STOP_POLICY,
  );
  return { label, pid: identity.pid, ...outcome };
}

/**
 * Clean up after a smoke that did not pass: this demo's own owner, through its own `stop`, and the client
 * processes this smoke spawned. Every signal goes through the repository's verified group stop, which re-reads
 * PID, start identity and process group first, so a recycled PID is refused. Nothing broader is signalled.
 */
async function cleanUpAfterFailure({ root, spawned, owner }) {
  const record = { demoStop: null, owner: null, spawned: [] };
  try {
    const answer = await demoCommand(["stop", "--root", root, "--keep-root"], { label: "demo stop (cleanup)", spawned });
    record.demoStop = { exit: answer.exit, output: answer.output.trim().slice(-600) };
  } catch (error) {
    record.demoStop = { error: /** @type {Error} */ (error).message };
  }
  if (owner !== undefined && owner !== null) {
    record.owner = await stopIdentifiedProcess(owner, "owner").catch((error) => ({ label: "owner", error: error.message }));
  }
  for (const process_ of spawned) {
    if (process_.handle.reapIfExited() !== null) continue;
    record.spawned.push(await stopIdentifiedProcess(process_.handle.owner, process_.label).catch((error) => ({ label: process_.label, error: error.message })));
  }
  return record;
}

/** One demo command, run to completion, with its stdout captured. Exit status is asserted, never ignored. */
async function demoCommand(args, { label, spawned }) {
  const process_ = await openPtyProcess({ args: [DEMO, ...args], label, spawned });
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
  /** Every process this smoke spawned, so a failure stops exactly those and nothing else. */
  const spawned = [];
  /** @type {{ pid: number, processGroupId: number, startIdentity: string } | null} */
  let owner = null;
  try {
    return await driveSmoke({ root, evidenceDir, spawned, recordOwner: (identity) => { owner = identity; } });
  } catch (error) {
    const cleanup = await cleanUpAfterFailure({ root, spawned, owner });
    const failure = {
      failed: true,
      failures: [/** @type {Error} */ (error).message],
      root,
      owner,
      cleanup,
      note: "This run did not pass. The demo's own stop was attempted and only this smoke's own processes were signalled, by verified identity. A smoke-result.json beside this file, if present, holds the step evidence collected before the failure.",
      atMs: Date.now(),
    };
    await writeFile(path.join(evidenceDir, "smoke-failure.json"), `${JSON.stringify(failure, null, 2)}\n`);
    throw error;
  }
}

/**
 * @param {{ root: string, evidenceDir: string, spawned: any[], recordOwner: (identity: { pid: number, processGroupId: number, startIdentity: string }) => void }} options
 */
async function driveSmoke({ root, evidenceDir, spawned, recordOwner }) {
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
  const started = await demoCommand(startArgs.slice(1), { label: "demo start", spawned });
  at("startMs", startedFrom);
  const ownerPid = Number(/owner pid (\d+)/u.exec(started.output)?.[1]);
  const ownerStartIdentity = /startIdentity (\d+)/u.exec(started.output)?.[1];
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error(`demo start printed no owner pid: ${started.output}`);
  const ownerAtStart = await inspectProcessIdentity(ownerPid);
  recordOwner(ownerAtStart);
  steps.push({ step: "start", ownerPid, ownerStartIdentity, output: started.output.trim() });

  // 1. The first attachment, on its own terminal.
  const attachOneArgs = [DEMO, "attach", "--root", root, "--id", "client-1"];
  note("attach client-1", attachOneArgs);
  const attachFrom = Date.now();
  const clientOne = await openPtyProcess({ args: attachOneArgs, label: "client-1", spawned });
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
  const detached = await demoCommand(detachArgs.slice(1), { label: "demo detach", spawned });
  const exitOne = await clientOne.waitForExit();
  const ownerAfterDetach = await inspectProcessIdentity(ownerPid);
  const statusAfterDetach = JSON.parse((await demoCommand(["status", "--root", root], { label: "demo status", spawned })).output);
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
  const clientOneAgain = await openPtyProcess({ args: reattachArgs, label: "client-1-epoch-2", spawned });
  await clientOneAgain.waitFor((visible) => visible.includes("attached as client-1 epoch 2"), "client-1 epoch 2 welcome");
  await clientOneAgain.waitFor((visible) => visible.includes(DRAFT), "the retained draft on the repainted screen");
  at("reattachToRetainedDraftMs", reattachFrom);
  steps.push({ step: "reattach-client-1-epoch-2", elapsedMs: timings.reattachToRetainedDraftMs, retainedDraft: DRAFT });

  // 5. A second attachment shares the same draft and the same UI.
  const attachTwoArgs = [DEMO, "attach", "--root", root, "--id", "client-2"];
  note("attach client-2", attachTwoArgs);
  const secondFrom = Date.now();
  const clientTwo = await openPtyProcess({ args: attachTwoArgs, label: "client-2", spawned });
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
  const detachBoth = await demoCommand(["detach", "--root", root], { label: "demo detach (second round)", spawned });
  const exitTwo = await clientTwo.waitForExit();
  const exitOneAgain = await clientOneAgain.waitForExit();
  const stopArgs = [DEMO, "stop", "--root", root, "--keep-root"];
  note("stop", stopArgs);
  const stopFrom = Date.now();
  const stopped = JSON.parse((await demoCommand(stopArgs.slice(1), { label: "demo stop", spawned })).output);
  at("stopMs", stopFrom);
  // A pass needs both: the original owner demonstrably gone, and an actual wait status for it. Either one
  // missing — including an inspection that could not answer — fails this run.
  const absenceAfterStop = await verifyOwnerAbsence(ownerPid, ownerAtStart.startIdentity);
  const exitAfterStop = describeOwnerExit(stopped.exit);
  const failures = [];
  if (!absenceAfterStop.gone) failures.push(`the original owner was not demonstrably gone after stop: ${absenceAfterStop.reason}`);
  if (!exitAfterStop.observed) failures.push(`the stop reported no usable wait result: ${exitAfterStop.reason}`);
  steps.push({ step: "stop", detachOutput: detachBoth.output.trim(), clientTwoExit: exitTwo, clientOneExit: exitOneAgain, stopped, absenceAfterStop, exitAfterStop });

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
    passed: failures.length === 0,
    failures,
    root,
    owner: { pid: ownerPid, startIdentity: ownerStartIdentity, identityAtStart: ownerAtStart, identityAfterDetach: ownerAfterDetach, absenceAfterStop, exitAfterStop },
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
    // The owner pseudo-terminal this ran on is merged from a reviewed correction whose remaining verdict is
    // release-only. A passing smoke is not a release qualification, so every run carries that caveat.
    dependency: {
      mechanism: "runtime/pty-mechanism.mjs and vendor/pty, merged from a08bfcaa9706324eadf7347a738e81552c2cdb98",
      artifactSha256: "1ed4ec08eb43cb1f608d5aa156d0232bc7b6965ad14852e2410ba7c64a68d7e5",
      functionalFindingsResolved: [
        "the owner's identity is bound at birth from a /proc snapshot read before the waiting thread starts, so a recorded PID, start identity and session cannot belong to a recycled PID",
        "later foreground-group reads compare start identity and refuse a changed one",
        "a partial or failed terminal write carries numeric bytesWritten/totalBytes; this smoke reports those numbers and parses no prose",
      ],
      openVerdict: "BLOCK, release-only",
      openP1: [
        "@replit/ruspty@3.7.1 declares MIT but supplies no authoritative license notice, which blocks redistribution and package qualification",
      ],
      openP2: ["the generated provenance description understates its input groups; not a functional or release blocker, and not addressed here"],
      notCalledHere: ["foregroundProcessGroup", "resize"],
      authorized: "private demo integration, run in place from this worktree; no publication, redistribution or live activation",
    },
    atMs: Date.now(),
  };
  await writeFile(path.join(evidenceDir, "smoke-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (failures.length > 0) {
    // The artifact above is written first: a failed verification keeps its diagnostics instead of erasing them.
    throw new Error(`the stop was not verified: ${failures.join("; ")}`);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const evidenceIndex = process.argv.indexOf("--evidence");
  const rootIndex = process.argv.indexOf("--root");
  if (evidenceIndex === -1) throw new Error("smoke.mjs needs --evidence <directory>");
  const result = await runSmoke({
    // The default root is unique per run, because the manager refuses a root it did not create itself.
    root: rootIndex === -1 ? `/tmp/pi-nsd-smoke-${process.pid}-${Date.now()}` : process.argv[rootIndex + 1],
    evidenceDir: path.resolve(process.argv[evidenceIndex + 1]),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
