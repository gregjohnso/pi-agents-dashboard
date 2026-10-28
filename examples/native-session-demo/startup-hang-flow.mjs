/**
 * The startup hang, reproduced and corrected through the ACTUAL manager-demo.
 *
 * A disposable sessions home holds two peers: one healthy manager stand-in and one WEDGED one that accepts the
 * control connection and never answers. That is the shape of the reported incident - the frontend sat in
 * `epoll_wait` with a blank screen - and it is reproducible without touching any live session, because a listen
 * backlog is the kernel's: `connect` succeeds and the writes land in a buffer even when nothing ever calls
 * `accept`.
 *
 * What this asserts, in the order an operator experiences it:
 *   1. the screen paints while the first read is still outstanding;
 *   2. the healthy row loads beside the silent peer;
 *   3. the silent peer gets a clear STALE outcome, never EXITED or STOPPED;
 *   4. quit still works.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { demoPaths } from "./demo-root.mjs";
import { createFrameReader, encodeFrame } from "./protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER_DEMO = path.join(HERE, "manager-demo.mjs");
const NODE = process.execPath;
const COLS = 181;
const ROWS = 79;
const BARRIER_MS = 60_000;
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
    pane: () => run(["capture-pane", "-p", "-t", "hang"]).split("\n"),
    keys: (...keys) => run(["send-keys", "-t", "hang", ...keys]),
    alive: () => run(["list-sessions"], { allowFailure: true }).includes("hang"),
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

/** One peer that either answers status properly or accepts and says nothing at all. */
async function peer(sessionsHome, sessionId, behaviour) {
  const root = path.join(sessionsHome, sessionId);
  await mkdir(root, { recursive: true });
  const paths = demoPaths(root);
  await writeFile(paths.token, "startup-hang-fixture-token\n");
  let connections = 0;
  /** @type {Set<net.Socket>} */
  const accepted = new Set();
  const server = net.createServer((socket) => {
    connections += 1;
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => {});
    // The wedged peer: it never writes and never closes. Nothing here is a stub of the real manager's logic; it is
    // only a socket that behaves the way a stopped or wedged process behaves.
    if (behaviour === "silent") return;
    const reader = createFrameReader(
      ({ header }) => {
        if (header?.type !== "status") return;
        socket.write(encodeFrame({
          type: "status",
          status: {
            root,
            owner: { pid: process.pid, startIdentity: `identity-${sessionId}` },
            geometry: { cols: COLS, rows: ROWS },
            geometryRevision: 1,
            attachments: [],
            exit: null,
            reaped: null,
            projectCwd: root,
            readiness: [{ phase: "native-mounted" }],
            presentations: [],
            bridge: { connected: true, facts: { agentPhase: "settled", idle: true, pendingMessages: false } },
          },
        }));
      },
      () => socket.destroy(),
    );
    socket.on("data", (chunk) => reader.push(chunk));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.controlSocket, () => resolve(undefined));
  });
  return {
    root,
    connections: () => connections,
    async close() {
      for (const socket of [...accepted]) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/** @param {{ evidenceDir: string }} options */
export async function runStartupHangFlow({ evidenceDir }) {
  await mkdir(evidenceDir, { recursive: true });
  const steps = [];
  const socketName = `pia-hang-${process.pid}`;
  const tmux = tmuxRunner(socketName);
  const home = await mkdtemp(path.join(tmpdir(), "pia-hang-home-"));
  const sessionsHome = await mkdtemp(path.join(tmpdir(), "pia-hang-sessions-"));
  const project = await mkdtemp(path.join(tmpdir(), "pia-hang-project-"));
  /** @type {{ close: () => Promise<void> }[]} */
  const peers = [];
  try {
    await writeFile(path.join(project, "README.md"), "disposable project for the startup-hang reproduction\n");
    const configRoot = path.join(path.dirname(sessionsHome), `${path.basename(sessionsHome)}-config`);
    await mkdir(configRoot, { recursive: true });
    await mkdir(path.join(home, "tmp"), { recursive: true });

    const healthy = await peer(sessionsHome, "session-1700000000101", "healthy");
    const wedged = await peer(sessionsHome, "session-1700000000102", "silent");
    peers.push(healthy, wedged);
    steps.push({ step: "two-peers-one-wedged", healthy: healthy.root, wedged: wedged.root });

    const startedAt = Date.now();
    tmux.run([
      "new-session", "-d", "-s", "hang", "-x", String(COLS), "-y", String(ROWS),
      "-e", `HOME=${home}`, "-e", `XDG_CONFIG_HOME=${configRoot}`, "-e", `TMPDIR=${path.join(home, "tmp")}`,
      "--", NODE, MANAGER_DEMO, "--sessions", sessionsHome, "--cwd", project,
    ]);

    // 1. The screen must appear while the read is still outstanding. Before the correction this stayed blank.
    const loadingPane = await until(
      tmux,
      (pane) => pane.some((line) => line.includes("loading sessions")) || pane.some((line) => line.includes("Sessions")),
      "the first paint",
    );
    const firstPaintMs = Date.now() - startedAt;
    steps.push({
      step: "first-paint-did-not-wait-for-every-owner",
      firstPaintMs,
      sawLoadingSurface: loadingPane.some((line) => line.includes("loading sessions")),
    });

    // 2. The healthy owner loads fully, despite its wedged neighbour.
    const rowsPane = await until(
      tmux,
      (pane) => pane.some((line) => line.includes("session-1700000000101") && /READY/u.test(line)),
      "the healthy row, loaded beside the silent peer",
    );
    const healthyRow = rowsPane.find((line) => line.includes("session-1700000000101")) ?? "";
    steps.push({
      step: "healthy-row-loaded-beside-the-silent-peer",
      healthyRow: healthyRow.trim().slice(0, 160),
      healthyIsReady: /READY/u.test(healthyRow),
    });

    // 3. The wedged peer's timeout is never dressed up as a death. It is STALE, and the dashboard's default `live`
    // view keeps only LIVE rows, so it is filtered OUT of this screen rather than shown - existing behaviour, not
    // something this correction changes. What matters here is that nothing claims it exited or was stopped.
    const wedgedRow = rowsPane.find((line) => line.includes("session-1700000000102")) ?? "";
    steps.push({
      step: "silent-peer-never-claimed-dead",
      wedgedRowOnDefaultView: wedgedRow.trim().slice(0, 200) || "(filtered out of the default live view, as STALE is)",
      noExitedOrStoppedClaim: !/session-1700000000102[^\n]*(EXITED|STOPPED)/u.test(rowsPane.join("\n")),
      note: "the STALE outcome itself is asserted directly in startup-hang.test.mjs, where the row object is read",
    });
    await writeFile(
      path.join(evidenceDir, "startup.pane.txt"),
      rowsPane.map((line, index) => `${String(index).padStart(3, " ")} ${line}`).join("\n") + "\n",
    );
    if (!/READY/u.test(healthyRow)) throw new Error(`the healthy row did not load beside the silent peer: ${healthyRow.trim()}`);
    if (/session-1700000000102[^\n]*(EXITED|STOPPED)/u.test(rowsPane.join("\n"))) {
      throw new Error("a timeout was reported as a death for the wedged peer");
    }

    // 4. Quit must work, which it could not while a close waited on a read that never answered.
    const quitAt = Date.now();
    tmux.keys("C-c");
    await new Promise((resolve) => setTimeout(resolve, 300));
    tmux.keys("C-c");
    const deadline = Date.now() + 30_000;
    while (tmux.alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    const quitMs = Date.now() - quitAt;
    const exited = !tmux.alive();
    steps.push({ step: "quit-stayed-responsive", quitMs, frontendExited: exited });
    if (!exited) throw new Error(`the frontend did not quit within 30s of Ctrl+C twice (${quitMs}ms)`);

    const record = { passed: true, geometry: `${COLS}x${ROWS}`, firstPaintMs, quitMs, steps, atMs: Date.now() };
    await writeFile(path.join(evidenceDir, "startup-hang-result.json"), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } catch (error) {
    await writeFile(path.join(evidenceDir, "startup-hang-result.json"),
      `${JSON.stringify({ passed: false, steps, failure: error.message, atMs: Date.now() }, null, 2)}\n`).catch(() => {});
    await writeFile(path.join(evidenceDir, "startup.pane.txt"), tmux.pane().join("\n")).catch(() => {});
    throw error;
  } finally {
    tmux.kill();
    for (const entry of peers) await entry.close().catch(() => {});
    for (const directory of [home, sessionsHome, project]) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--evidence");
  const evidenceDir = index === -1 ? path.join(tmpdir(), "startup-hang-evidence") : path.resolve(process.argv[index + 1]);
  runStartupHangFlow({ evidenceDir })
    .then((record) => console.log(JSON.stringify(record, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
