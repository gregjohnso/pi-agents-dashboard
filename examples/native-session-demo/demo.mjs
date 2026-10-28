#!/usr/bin/env node
/**
 * The demo's command line. Five commands and no hidden state.
 *
 *   start    open one owner pseudo-terminal, launch the real native Pi on it, and return
 *   attach   join that owner from this terminal; run it in as many terminals as you like
 *   detach   close one attachment, or all of them; the owner keeps running with zero clients
 *   status   the owner's identity, readiness, presentations and attachments
 *   stop     stop that owner, and keep only its own private directory behind for inspection
 *   serve    what `start` runs in the background; run it yourself to watch the manager's log on stderr
 *
 * This is a development-only integration demo. It is not a product entry point, it ships in no tarball, and
 * the provider it configures is a labelled fake that calls no model.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attach } from "./client.mjs";
import { DEFAULT_MANIFEST } from "./cohort.mjs";
import { defaultRoot, demoPaths, readToken } from "./demo-root.mjs";
import { runManager } from "./manager.mjs";
import { createFrameReader, encodeFrame } from "./protocol.mjs";
import { isNativeSessionName } from "../../runtime/native-sideband.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(HERE, "demo.mjs");
/** The owner width this demo's smoke and geometry cases exercise. A tested reference, not a proven threshold. */
const TESTED_REFERENCE_COLS = 100;

const USAGE = `native-session-demo — one persistent native Pi, many attachments

  node ${SELF} start  [--root <dir>] [--cols <n>] [--rows <n>] [--manifest <file>] [--cohort <consumer root>] [--real [--cwd <dir>]]
  node ${SELF} attach [--root <dir>] [--id <attachment id>]
  node ${SELF} detach [--root <dir>] [--id <attachment id>]
  node ${SELF} status [--root <dir>]
  node ${SELF} stop   [--root <dir>] [--keep-root]
  node ${SELF} serve  [--root <dir>] [--cols <n>] [--rows <n>] [--manifest <file>] [--cohort <consumer root>] [--real [--cwd <dir>]]

  --root      where the owner keeps its socket, token and disposable state (default ${defaultRoot()}).
              Pi's session transcripts are NOT kept here: Pi chooses where those go.
  --state     an optional durable home for this manager's own METADATA about owners it launched - owner and Pi
              session ids, the path Pi reported for its session file, and an observed exit. No transcript is
              copied, moved or written there. Without it nothing durable is recorded and saved rows never appear.
  --pi-config a private Pi CONFIGURATION home, for fixtures only. Pi still selects its own session directory,
              just underneath this configuration instead of a normal account's.
  --manifest  the verified-cohort manifest that selects which installed Pi runs
              (default ${DEFAULT_MANIFEST})
  --initial-prompt-file
              a file whose exact bytes are submitted once as this session's first task. A file, not an
              argument, so a prompt may begin with a dash and may contain newlines
  --provider / --model
              the provider and model this session should run. Omit both to leave Pi its own selection.
  --real      launch Pi with YOUR normal configuration: your model selection, credentials, tools and
              extensions, your PATH, and --cwd as the project directory. Pi also stores this session wherever
              your own configuration puts it, exactly as a direct Pi run would. Without --real the owner runs
              sealed, with a labelled fake provider that calls no model, under a disposable configuration.
  --keep-root accepted for compatibility. \`stop\` removes no directory in any case: it reaps the owner and
              leaves its root behind, so remove a root yourself once you have read it
`;

/** @param {string[]} argv */
function parseArguments(argv) {
  const options = { root: defaultRoot(), keepRoot: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };
    if (argument === "--root") options.root = path.resolve(value());
    // The DURABLE METADATA home. Separate from `--root` on purpose: `--root` is short because `<root>/s` must fit
    // in a `sockaddr_un`, while this is never a socket path and may be as long as the filesystem allows. It holds
    // records ABOUT sessions, never session content.
    else if (argument === "--state") options.stateHome = path.resolve(value());
    // Fixtures only: a private, real Pi CONFIGURATION home, so Pi selects its own session directory under a path a
    // test controls and that outlives this manager. Configuration of Pi, not a transcript store of this demo's own.
    else if (argument === "--pi-config") options.piConfigHome = path.resolve(value());
    else if (argument === "--cols") options.cols = Number(value());
    else if (argument === "--rows") options.rows = Number(value());
    else if (argument === "--manifest") options.manifestPath = path.resolve(value());
    else if (argument === "--cohort") options.cohortRoot = path.resolve(value());
    else if (argument === "--id") options.attachmentId = value();
    else if (argument === "--real") options.mode = "real";
    else if (argument === "--cwd") options.projectCwd = path.resolve(value());
    else if (argument === "--initial-prompt-file") options.initialPromptFile = path.resolve(value());
    else if (argument === "--provider") options.requestedProvider = value();
    else if (argument === "--model") options.requestedModel = value();
    else if (argument === "--name") {
      options.requestedName = value();
      if (!isNativeSessionName(options.requestedName)) throw new Error("Invalid native session name");
    }
    else if (argument === "--keep-root") options.keepRoot = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

/**
 * One control connection: authenticate, send one frame, resolve with the first answer.
 *
 * @param {string} root @param {Record<string, unknown>} frame @param {string} expected
 */
async function control(root, frame, expected) {
  const paths = demoPaths(root);
  if (!existsSync(paths.controlSocket)) throw new Error(`No demo owner at ${root}: ${paths.controlSocket} does not exist`);
  const token = await readToken(root);
  const socket = net.connect(paths.controlSocket);
  return new Promise((resolve, reject) => {
    const reader = createFrameReader(
      ({ header }) => {
        if (header.type === expected) {
          resolve(header);
          socket.end();
        } else if (header.type === "refused") {
          reject(new Error(`the manager refused this control connection: ${header.text}`));
          socket.end();
        }
      },
      (error) => {
        reject(error);
        socket.destroy();
      },
    );
    socket.on("connect", () => {
      socket.write(encodeFrame({ type: "hello", role: "control", token }));
      socket.write(encodeFrame(frame));
    });
    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => reject(new Error(`the manager closed the control connection before answering ${frame.type}`)));
  });
}

/**
 * What the operator should be told about a requested owner width, or null when there is nothing to say.
 *
 * The owner's geometry is fixed once at launch and every attachment receives that one render, so the width chosen
 * here is the width all typing is laid out at. The default, 100x30, is the size this demo's own acceptance smoke
 * and its geometry cases exercise.
 *
 * Two owner widths have been captured on a text screen: at 100 the 82-character sample draft occupied one row; at
 * 60 the same draft wrapped after 59 columns, leaving the last cell of the pre-wrap row blank. That blank cell is a
 * line-break pad in the rendered row, which is a DISPLAY observation: at 100 the submitted text was separately
 * confirmed byte-exact from the fake provider's own prompt digest, but at 60 no post-submit stream was retained, so
 * submitted-text integrity at that width is untested. 60 is the only narrow width measured.
 *
 * So this warns and nothing more. It is guidance, not a fix, not a refusal and not a resize: 100 is a tested
 * reference point, NOT a proven threshold, and no safe minimum has been established.
 * @param {number | undefined} cols
 */
export function widthGuidance(cols) {
  if (typeof cols !== "number" || !Number.isFinite(cols) || cols >= TESTED_REFERENCE_COLS) return null;
  return (
    `note: --cols ${cols} is below this demo's tested default of ${TESTED_REFERENCE_COLS}. The owner's geometry is ` +
    "fixed at launch and shared by every attachment, so this is the width all typing is laid out at. A 60-column " +
    "capture showed a long line wrapping after 59 columns with the last cell of the pre-wrap row left blank, which " +
    "is a line-break pad in the rendered row. That is a display observation only: whether typed text is submitted " +
    `unchanged at this width has not been checked here. ${TESTED_REFERENCE_COLS} is a tested reference, not a ` +
    "proven threshold, and no safe minimum has been measured. Starting anyway.\n"
  );
}

/** `serve` in the background, waiting for the manager's own ready record rather than polling for a file. */
async function start(options) {
  const paths = demoPaths(options.root);
  const guidance = widthGuidance(options.cols);
  if (guidance !== null) process.stderr.write(guidance);
  if (existsSync(options.root)) {
    throw new Error(
      `${options.root} already exists. The manager creates its root exclusively and never adopts or deletes a ` +
        "path it did not create, so stop the owner that owns it, remove it yourself, or pass another --root.",
    );
  }
  const argv = [SELF, "serve", "--root", options.root];
  if (options.mode === "real") argv.push("--real");
  // Forwarded to the detached manager, which is the process that actually owns durable persistence: it keeps
  // writing while every dashboard is closed.
  if (options.stateHome) argv.push("--state", options.stateHome);
  if (options.piConfigHome) argv.push("--pi-config", options.piConfigHome);
  if (options.projectCwd) argv.push("--cwd", options.projectCwd);
  if (options.initialPromptFile) argv.push("--initial-prompt-file", options.initialPromptFile);
  if (options.requestedProvider) argv.push("--provider", options.requestedProvider);
  if (options.requestedModel) argv.push("--model", options.requestedModel);
  if (options.requestedName) argv.push("--name", options.requestedName);
  if (options.cols) argv.push("--cols", String(options.cols));
  if (options.rows) argv.push("--rows", String(options.rows));
  if (options.manifestPath) argv.push("--manifest", options.manifestPath);
  if (options.cohortRoot) argv.push("--cohort", options.cohortRoot);

  const child = spawn(process.execPath, argv, { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  child.unref();
  let buffered = "";
  const record = await new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(buffered.slice(0, newline)));
    });
    child.stdout.on("close", () => reject(new Error(`the manager exited before it was ready; see ${paths.log}`)));
    child.on("error", reject);
  });
  child.stdout.destroy();
  return record;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  const options = parseArguments(rest);

  if (command === "serve") {
    // The manager appends its own log inside the root it holds open; this is only where it is echoed.
    const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
    await runManager({
      ...options,
      log,
      onReady: (record) => {
        process.stdout.write(`${JSON.stringify(record)}\n`);
        process.stdout.end();
      },
    });
    return;
  }

  if (command === "start") {
    const record = await start(options);
    process.stdout.write(
      [
        `owner pid ${record.owner.pid}, startIdentity ${record.owner.startIdentity}, process group ${record.owner.processGroupId}`,
        `manager pid ${record.managerPid}, log ${record.managerLog}`,
        `root ${record.root}, control socket ${record.controlSocket}`,
        `geometry ${record.geometry.cols}x${record.geometry.rows}, provider ${record.provider}`,
        `cohort ${record.cohort.bundledCli}`,
        "",
        `attach:  node ${SELF} attach --root ${record.root} --id client-1`,
        `detach:  node ${SELF} detach --root ${record.root}`,
        `status:  node ${SELF} status --root ${record.root}`,
        `stop:    node ${SELF} stop   --root ${record.root}`,
        "",
      ].join("\n"),
    );
    return;
  }

  if (command === "attach") {
    // Diagnostics go to the attachment's own log, never to the terminal: while an attachment lives the terminal
    // belongs to Pi's renderer, and a line printed into it moves the real cursor out from under the editor.
    const logPath = path.join(options.root, "attach-diagnostics.log");
    const outcome = await attach({
      root: options.root,
      attachmentId: options.attachmentId,
      diagnostics: (text) => {
        try {
          appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`);
        } catch {
          // An unwritable log must not end the attachment, and must not fall back to the terminal.
        }
      },
    });
    if (outcome.welcome === undefined) {
      // A refusal is the manager's answer, not a crash. One bounded JSON line on stderr, which the list reads
      // from the pipe it gave this process and puts on its own status line after it has the terminal back.
      process.stderr.write(`${JSON.stringify({ attached: false, refusalCode: outcome.refusalCode ?? null, reason: outcome.reason, diagnostics: outcome.diagnostics ?? [] })}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "detach") {
    const answer = await control(options.root, { type: "detach", attachmentId: options.attachmentId }, "detached");
    process.stdout.write(`${JSON.stringify({ detached: answer.attachments, remaining: answer.remaining, owner: answer.owner, ownerReaped: answer.ownerReaped }, null, 2)}\n`);
    return;
  }

  if (command === "status") {
    const answer = await control(options.root, { type: "status" }, "status");
    process.stdout.write(`${JSON.stringify(answer.status, null, 2)}\n`);
    return;
  }

  if (command === "stop") {
    const answer = await control(options.root, { type: "stop", keepRoot: options.keepRoot }, "stopped");
    process.stdout.write(`${JSON.stringify({ owner: answer.owner, exit: answer.exit, rootKept: answer.rootKept, rootRetention: answer.rootRetention }, null, 2)}\n`);
    return;
  }

  throw new Error(`unknown command ${command}\n\n${USAGE}`);
}

// Run as a script, not on import. Same guard `runtime/native-sideband-binder.mjs` uses, so `widthGuidance` above can
// be exercised directly by a focused test while `node demo.mjs ...` - including the `serve` child `start` spawns,
// whose argv[1] is this same file - behaves exactly as before.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
