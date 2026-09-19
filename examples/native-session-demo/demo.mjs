#!/usr/bin/env node
/**
 * The demo's command line. Five commands and no hidden state.
 *
 *   start    open one owner pseudo-terminal, launch the real native Pi on it, and return
 *   attach   join that owner from this terminal; run it in as many terminals as you like
 *   detach   close one attachment, or all of them; the owner keeps running with zero clients
 *   status   the owner's identity, readiness, presentations and attachments
 *   stop     stop that owner and clean up only what this demo created
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(HERE, "demo.mjs");

const USAGE = `native-session-demo — one persistent native Pi, many attachments

  node ${SELF} start  [--root <dir>] [--cols <n>] [--rows <n>] [--manifest <file>] [--cohort <consumer root>]
  node ${SELF} attach [--root <dir>] [--id <attachment id>]
  node ${SELF} detach [--root <dir>] [--id <attachment id>]
  node ${SELF} status [--root <dir>]
  node ${SELF} stop   [--root <dir>] [--keep-root]
  node ${SELF} serve  [--root <dir>] [--cols <n>] [--rows <n>] [--manifest <file>] [--cohort <consumer root>]

  --root      where the owner keeps its socket, token and disposable state (default ${defaultRoot()})
  --manifest  the verified-cohort manifest that selects which installed Pi runs
              (default ${DEFAULT_MANIFEST})
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
    else if (argument === "--cols") options.cols = Number(value());
    else if (argument === "--rows") options.rows = Number(value());
    else if (argument === "--manifest") options.manifestPath = path.resolve(value());
    else if (argument === "--cohort") options.cohortRoot = path.resolve(value());
    else if (argument === "--id") options.attachmentId = value();
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

/** `serve` in the background, waiting for the manager's own ready record rather than polling for a file. */
async function start(options) {
  const paths = demoPaths(options.root);
  if (existsSync(paths.controlSocket)) {
    throw new Error(`A demo owner already holds ${paths.controlSocket}; stop it first or pass another --root`);
  }
  const argv = [SELF, "serve", "--root", options.root];
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
    const paths = demoPaths(options.root);
    const log = (line) => {
      const entry = `${new Date().toISOString()} ${line}\n`;
      try {
        appendFileSync(paths.log, entry);
      } catch {
        // The log directory is created with the root; a failure here must not stop the owner.
      }
      process.stderr.write(entry);
    };
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
        `geometry ${record.geometry.cols}x${record.geometry.rows}, provider ${record.provider} (FAKE: deterministic, no model is called)`,
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
    const outcome = await attach({ root: options.root, attachmentId: options.attachmentId });
    if (outcome.welcome === undefined) process.exitCode = 1;
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
    process.stdout.write(`${JSON.stringify({ owner: answer.owner, exit: answer.exit, rootKept: answer.rootKept }, null, 2)}\n`);
    return;
  }

  throw new Error(`unknown command ${command}\n\n${USAGE}`);
}

await main();
