/**
 * The two operator-flow blockers the user hit: input dies, and the window size is ignored.
 *
 * Both are driven against a REAL owner and a REAL manager over the authenticated control socket, because
 * both defects live in that path and a fake-mode unit double would have missed them.
 *
 * What the live session proved before any of this was written (`logs/live-diagnosis.txt`):
 *
 *   21:02:16  in-Pi ingress caller connected from pid 1853378
 *   21:02:19  labelled ingress ready ... flushing 0 held frame(s)      <- input worked
 *   21:03:19  in-Pi ingress caller connected from pid 1853378          <- a SECOND ingress
 *   21:03:19  the in-Pi ingress caller disconnected                    <- and readiness died with it
 *
 * `status` then reported `ingressReady: false` with the owner still alive and its cold presentation
 * successful, which is exactly "I can get in, but I can't type": output flows, input is held forever.
 */

import net from "node:net";
import { mkdtemp, mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { demoPaths, readToken } from "./demo-root.mjs";
import { encodeFrame, createFrameReader } from "./protocol.mjs";
import { demoCommand, openPtyProcess, stopIdentifiedProcess, waitForAttachmentDiagnostic } from "./smoke.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, "demo.mjs");
/** Deliberately not 100x30, so a size that is merely inherited from a default is visible as a failure. */
const CLIENT_COLS = 132;
const CLIENT_ROWS = 43;

/** Everything a case started, stopped in the order that leaves nothing behind. */
const started = { roots: [], spawned: [] };

afterEach(async () => {
  for (const root of started.roots.splice(0)) {
    await demoCommand(["stop", "--root", root], { label: "stop", spawned: [] }).catch(() => {});
  }
  for (const process_ of started.spawned.splice(0)) {
    if (process_.handle.reapIfExited() !== null) continue;
    await stopIdentifiedProcess(process_.handle.owner, process_.label).catch(() => {});
  }
});

async function statusOf(root) {
  const answer = await demoCommand(["status", "--root", root], { label: "status", spawned: [] });
  return JSON.parse(answer.output.slice(answer.output.indexOf("{")));
}

/** Start one owner in fake mode, in its own disposable root. */
async function startOwner({ cols, rows } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "native-io-"));
  const root = path.join(home, "session");
  const args = ["start", "--root", root];
  if (cols !== undefined) args.push("--cols", String(cols), "--rows", String(rows));
  await demoCommand(args, { label: "start", spawned: [] });
  started.roots.push(root);
  return root;
}

/**
 * Connect to the control socket as an `ingress` peer and close again, exactly as a second in-process
 * registration did in the live session. Nothing is dispatched: the point is the connection's arrival and
 * departure, which is what reset readiness.
 */
async function connectAndDropIngress(root) {
  const paths = demoPaths(root);
  const token = await readToken(root);
  const socket = net.connect(paths.controlSocket);
  const refusals = [];
  const reader = createFrameReader(({ header }) => refusals.push(header), () => {});
  socket.on("data", (chunk) => reader.push(chunk));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  // The token matters: without it the manager refuses the connection before it is ever an ingress caller, and
  // a test that omits it proves nothing. An earlier draft of this case did exactly that and passed against the
  // defect, so the acceptance below is explicit.
  socket.write(encodeFrame({ type: "hello", role: "ingress", token, pid: process.pid }));
  // Give the manager a turn to adopt it before it goes away.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const refused = refusals.find((header) => header.type === "refused");
  if (refused !== undefined) throw new Error(`the manager refused this ingress connection, so the case is vacuous: ${refused.text}`);
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 400));
}

describe("input survives an ingress caller that connects and drops", () => {
  it("keeps the session typable after a second ingress connection comes and goes", async () => {
    const root = await startOwner();
    // `start` returns at native-mounted, which is the bootstrap sideband; ingress readiness is a separate
    // channel that announces itself a moment later, so it is waited for rather than assumed.
    await expect.poll(async () => (await statusOf(root)).ingressReady, { timeout: 60_000, interval: 500 }).toBe(true);

    // The live failure, reproduced: a second ingress arrives and immediately goes away.
    await connectAndDropIngress(root);

    const after = await statusOf(root);
    // The defect: readiness was reset and never restored, so every later keystroke was held forever.
    expect(after.ingressReady, "a dropped extra ingress must not take input readiness with it").toBe(true);

    // And prove it with a real keystroke rather than trusting the flag.
    const client = await openPtyProcess({ args: [DEMO, "attach", "--root", root, "--id", "io-1"], label: "io-1", spawned: started.spawned });
    await waitForAttachmentDiagnostic(root, "attached as io-1 epoch 1", 1, "the welcome");
    await client.waitFor((visible) => visible.includes("native-session-demo"), "the cold presentation");
    const typed = "typing after the ingress blip";
    client.write(typed);
    await client.waitFor((visible) => visible.includes(typed), "the draft echoing back from Pi", 60_000);
  }, 240_000);
});

describe("the owner runs where the launch said", () => {
  it("runs the owner process in the requested cwd, not the sealed project directory", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "native-cwd-"));
    await writeFile(path.join(workdir, "marker.txt"), "here\n");
    const home = await mkdtemp(path.join(tmpdir(), "native-io-"));
    const root = path.join(home, "session");
    await demoCommand(["start", "--root", root, "--cwd", workdir], { label: "start", spawned: [] });
    started.roots.push(root);
    const status = await statusOf(root);
    // The owner's own cwd, read from procfs rather than inferred.
    const ownerCwd = await readlink(`/proc/${status.owner.pid}/cwd`);
    expect(ownerCwd).toBe(await realpath(workdir));
  }, 180_000);
});

describe("the owner uses the attaching terminal's real size", () => {
  it("starts at the terminal's dimensions rather than a fixed 100x30", async () => {
    const root = await startOwner({ cols: CLIENT_COLS, rows: CLIENT_ROWS });
    const status = await statusOf(root);
    expect(status.geometry).toEqual({ cols: CLIENT_COLS, rows: CLIENT_ROWS });
    // Capabilities are negotiated once and stay put; only rows and columns move.
    expect(status.profileId).toBe("native-session-demo-owner");
  }, 180_000);

  it("follows a client resize through the authenticated path, and stays typable", async () => {
    const root = await startOwner({ cols: CLIENT_COLS, rows: CLIENT_ROWS });
    const client = await openPtyProcess({ args: [DEMO, "attach", "--root", root, "--id", "io-resize"], label: "io-resize", spawned: started.spawned });
    await waitForAttachmentDiagnostic(root, "attached as io-resize epoch 1", 1, "the welcome");
    await client.waitFor((visible) => visible.includes("native-session-demo"), "the cold presentation");

    // Change the CLIENT's terminal, the way a window drag does.
    const nextCols = 96;
    const nextRows = 28;
    client.handle.resize(nextCols, nextRows);
    await client.waitFor(() => true, "a turn for the resize to travel", 5_000).catch(() => {});
    await expect.poll(async () => (await statusOf(root)).geometry, { timeout: 60_000, interval: 1_000 })
      .toEqual({ cols: nextCols, rows: nextRows });

    // A resize must not cost the operator his input path.
    const typed = "typing after a resize";
    client.write(typed);
    await client.waitFor((visible) => visible.includes(typed), "the draft echoing after the resize", 60_000);
  }, 240_000);

  it("refuses a resize that names a stale attachment epoch, and keeps the current size", async () => {
    const root = await startOwner({ cols: CLIENT_COLS, rows: CLIENT_ROWS });
    const paths = demoPaths(root);
    const token = await readToken(root);
    const socket = net.connect(paths.controlSocket);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const seen = [];
    const reader = createFrameReader(({ header }) => seen.push(header), () => {});
    socket.on("data", (chunk) => reader.push(chunk));
    socket.write(encodeFrame({ type: "hello", role: "client", token, attachmentId: "io-stale" }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    // An epoch this attachment never held: the manager must not resize on it.
    socket.write(encodeFrame({ type: "resize", cols: 41, rows: 11, epoch: 99 }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    socket.destroy();
    const status = await statusOf(root);
    expect(status.geometry).toEqual({ cols: CLIENT_COLS, rows: CLIENT_ROWS });
    expect(status.geometryRefusals ?? []).not.toEqual([]);
  }, 180_000);

  it("refuses impossible dimensions rather than resizing to them", async () => {
    const root = await startOwner({ cols: CLIENT_COLS, rows: CLIENT_ROWS });
    const paths = demoPaths(root);
    const token = await readToken(root);
    const socket = net.connect(paths.controlSocket);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(encodeFrame({ type: "hello", role: "client", token, attachmentId: "io-bad" }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const bad of [{ cols: 0, rows: 10 }, { cols: 80, rows: -1 }, { cols: 1e6, rows: 10 }, { cols: 80.5, rows: 10 }]) {
      socket.write(encodeFrame({ type: "resize", cols: bad.cols, rows: bad.rows, epoch: 1 }));
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
    socket.destroy();
    expect((await statusOf(root)).geometry).toEqual({ cols: CLIENT_COLS, rows: CLIENT_ROWS });
  }, 180_000);
});
