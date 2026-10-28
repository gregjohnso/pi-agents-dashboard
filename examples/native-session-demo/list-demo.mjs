#!/usr/bin/env node
/**
 * The demo the approved flow describes: a list of sessions, real Pi, and back to the list.
 *
 *   node list-demo.mjs            open the list (fake provider, safe to run anywhere)
 *   node list-demo.mjs --real     open the list, and open sessions with YOUR Pi configuration
 *
 * What the operator does: pick a session with the arrow keys, press Enter to open it, work in the whole native
 * Pi — their own model, tools and extensions in `--real` — then press **F9** to come back to this list. The
 * session keeps running with nobody attached; opening it again lands in the same Pi, with the same unsubmitted
 * draft still in the editor.
 *
 * Three deliberate properties:
 *
 *   - **the list shows facts, not screen scrapings.** Each row is built from the manager's own `status` answer:
 *     owner pid, start identity, attachment count, and whether the owner is still alive. Nothing is inferred
 *     from rendered output.
 *   - **returning is a detachment.** F9 detaches exactly the terminal that pressed it, through the manager's
 *     existing per-attachment detach. Pi is not stopped, restarted or replaced, other terminals attached to the
 *     same session are untouched, and quitting this list leaves every session running.
 *   - **the list owns its own terminal.** While a session is open the attachment owns the terminal; the list
 *     redraws only after the attachment has restored it.
 *
 * This is a development-only demo. It is not a product entry point and it ships in no tarball.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { demoPaths, readToken } from "./demo-root.mjs";
import { createFrameReader, encodeFrame } from "./protocol.mjs";
import { RETURN_SHORTCUT } from "./return-channel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, "demo.mjs");
const DEFAULT_SESSIONS_HOME = path.join("/tmp", `pi-list-demo-${process.getuid?.() ?? 0}`);

/** One control request against one session root. Never throws for a dead session: it reports it. */
async function askSession(root, frame, expected) {
  const paths = demoPaths(root);
  if (!existsSync(paths.controlSocket)) return { reachable: false, reason: "no control socket" };
  let token;
  try {
    token = await readToken(root);
  } catch (error) {
    return { reachable: false, reason: `unreadable token: ${/** @type {Error} */ (error).message}` };
  }
  const socket = net.connect(paths.controlSocket);
  return new Promise((resolve) => {
    const settle = (value) => {
      resolve(value);
      socket.destroy();
    };
    const reader = createFrameReader(
      ({ header }) => {
        if (header.type === expected) settle({ reachable: true, answer: header });
        else if (header.type === "refused") settle({ reachable: false, reason: `refused: ${header.text}` });
      },
      (error) => settle({ reachable: false, reason: `protocol: ${error.message}` }),
    );
    socket.on("connect", () => {
      socket.write(encodeFrame({ type: "hello", role: "control", token }));
      socket.write(encodeFrame(frame));
    });
    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("error", (error) => settle({ reachable: false, reason: error.message }));
    socket.on("close", () => settle({ reachable: false, reason: "closed before answering" }));
  });
}

/**
 * Every session under this home, with the facts the manager reports for it.
 *
 * A directory whose manager is gone is listed as unreachable rather than hidden: the operator created it, and
 * silently dropping it would be the list inventing state.
 */
export async function readSessions(sessionsHome) {
  const entries = await readdir(sessionsHome, { withFileTypes: true }).catch(() => []);
  const roots = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(sessionsHome, entry.name));
  const sessions = await Promise.all(
    roots.map(async (root) => {
      const probe = await askSession(root, { type: "status" }, "status");
      if (!probe.reachable) return { root, name: path.basename(root), live: false, detail: probe.reason };
      const status = probe.answer.status;
      return {
        root,
        name: path.basename(root),
        live: status.exit === null && status.reaped === null,
        owner: status.owner,
        attachments: status.attachments.length,
        geometry: status.geometry,
        provider: status.provider,
        providerIsFake: status.providerIsFake,
        ownerMode: status.ownerMode,
        returns: Array.isArray(status.returns) ? status.returns.length : 0,
        detail: null,
      };
    }),
  );
  return sessions.sort((left, right) => left.name.localeCompare(right.name));
}

/** One row, from facts only. */
export function describeSession(session) {
  if (!session.live) return `${session.name}  —  not running (${session.detail ?? "owner exited"})`;
  const attached = session.attachments === 0 ? "running, nobody attached" : `running, ${session.attachments} attached`;
  return `${session.name}  —  ${attached}  ·  pid ${session.owner.pid}  ·  ${session.geometry.cols}x${session.geometry.rows}  ·  ${session.provider}`;
}

/** What the list paints. Pure, so its layout is testable without a terminal. */
export function renderList({ sessions, selected, sessionsHome, mode, message }) {
  const lines = [
    `pi native session list  ·  ${mode === "real" ? "REAL: your own Pi configuration" : "fake provider, no model is called"}`,
    `${sessionsHome}`,
    "",
  ];
  if (sessions.length === 0) lines.push("  (no sessions yet — press n to create one)");
  for (const [index, session] of sessions.entries()) {
    lines.push(`${index === selected ? ">" : " "} ${describeSession(session)}`);
  }
  lines.push(
    "",
    `  enter open   n new   d detach others   x stop   r refresh   q quit`,
    `  inside a session, press ${RETURN_SHORTCUT.toUpperCase()} to come back here — the session keeps running`,
  );
  if (message) lines.push("", `  ${message}`);
  return lines;
}

/** Run one demo command to completion, inheriting this terminal only when it needs it. */
function runDemo(args, { interactive = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DEMO, ...args], {
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (out += chunk));
    child.on("close", (code, signal) => resolve({ code, signal, output: out }));
    child.on("error", (error) => resolve({ code: null, signal: null, output: error.message }));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--real") ? "real" : "fake";
  const homeIndex = argv.indexOf("--sessions");
  const sessionsHome = homeIndex === -1 ? DEFAULT_SESSIONS_HOME : path.resolve(argv[homeIndex + 1]);
  const cwdIndex = argv.indexOf("--cwd");
  const projectCwd = cwdIndex === -1 ? process.cwd() : path.resolve(argv[cwdIndex + 1]);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("the list needs a real terminal; run it from a terminal, not a pipe");
  }
  await mkdir(sessionsHome, { recursive: true });

  let selected = 0;
  let message = mode === "real" ? "real mode: sessions you open use your own Pi configuration, models and tools" : "";
  let sessions = await readSessions(sessionsHome);

  const paint = () => {
    process.stdout.write("\u001b[2J\u001b[H");
    process.stdout.write(`${renderList({ sessions, selected, sessionsHome, mode, message }).join("\r\n")}\r\n`);
  };
  const refresh = async () => {
    sessions = await readSessions(sessionsHome);
    if (selected >= sessions.length) selected = Math.max(0, sessions.length - 1);
    paint();
  };

  /** Hand this terminal to one attachment, then take it back and repaint. */
  const open = async (session) => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\u001b[2J\u001b[H");
    const outcome = await runDemo(["attach", "--root", session.root, "--id", `list-${process.pid}`], { interactive: true });
    message =
      outcome.code === 0
        ? `returned from ${session.name} — it is still running`
        : `${session.name} attachment ended with code ${outcome.code}${outcome.signal ? ` signal ${outcome.signal}` : ""}`;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    await refresh();
  };

  const create = async () => {
    const root = path.join(sessionsHome, `session-${Date.now()}`);
    message = `starting ${path.basename(root)}…`;
    paint();
    const args = ["start", "--root", root];
    if (mode === "real") args.push("--real", "--cwd", projectCwd);
    const outcome = await runDemo(args);
    message = outcome.code === 0 ? `started ${path.basename(root)}` : `could not start: ${outcome.output.trim().split("\n").pop()}`;
    await refresh();
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  paint();

  for await (const chunk of process.stdin) {
    const key = chunk.toString("utf8");
    const current = sessions[selected];
    if (key === "q" || key === "\u0003") break;
    else if (key === "\u001b[A") selected = Math.max(0, selected - 1);
    else if (key === "\u001b[B") selected = Math.min(sessions.length - 1, selected + 1);
    else if (key === "n") { await create(); continue; }
    else if (key === "r") { message = ""; await refresh(); continue; }
    else if (key === "\r" && current?.live) { await open(current); continue; }
    else if (key === "d" && current?.live) {
      const probe = await askSession(current.root, { type: "detach" }, "detached");
      message = probe.reachable ? `detached ${probe.answer.attachments.length} attachment(s) from ${current.name}` : `could not detach: ${probe.reason}`;
      await refresh();
      continue;
    } else if (key === "x" && current) {
      const probe = await askSession(current.root, { type: "stop" }, "stopped");
      message = probe.reachable ? `stopped ${current.name} (${probe.answer.exit?.disposition ?? "no exit record"})` : `could not stop: ${probe.reason}`;
      await refresh();
      continue;
    }
    paint();
  }

  process.stdin.setRawMode(false);
  process.stdout.write("\u001b[2J\u001b[H");
  process.stdout.write(`left the list. ${sessions.filter((session) => session.live).length} session(s) still running under ${sessionsHome}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
