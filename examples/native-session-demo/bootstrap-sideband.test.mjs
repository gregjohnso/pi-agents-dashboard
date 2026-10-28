/**
 * The bootstrap sideband's peer identity.
 *
 * This channel is deliberately unauthenticated - the module says so - and its socket lives inside the owner's
 * `0700` root, so "who may connect" is filesystem permission alone. Pi's OWN DESCENDANTS pass that trivially:
 * a spawned tool inherits the environment that names this socket. The operator-visible consequence, taken from a
 * real session's `manager.log`, is that a running session stops being able to repaint:
 *
 *   23:49:05 sideband hello: pid 1911163   <- the owner
 *   23:50:19 cold presentation for epoch 1: {"presented":true,...}
 *   23:51:36 sideband hello: pid 1913319   <- NOT the owner
 *   23:51:45 sideband hello: pid 1914886
 *   23:51:54 sideband hello: pid 1916424
 *   ...and every later attach answered "Pi has not connected to the bootstrap sideband yet"
 *
 * Each late connection replaced the peer and then exited, so the manager lost its only route to a cold
 * presentation for a session that was still running perfectly well.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { startBootstrapSideband } from "./bootstrap-sideband.mjs";

const OWNER_PID = 4242;

/** @type {(() => unknown)[]} */
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listener({ resolveIdentity = true, identityDeadlineMs } = {}) {
  const base = join(tmpdir(), "x").length + 24 <= 100 || !existsSync("/tmp") ? tmpdir() : "/tmp";
  const root = await mkdtemp(join(base, "pia-bs-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "b");
  /** @type {any[]} */
  const frames = [];
  /** @type {string[]} */
  const errors = [];
  // The owner's pid is not known when this listener is created: the manager spawns Pi afterwards and can only
  // identify it once `openOwnerPty` has read its birth proc snapshot. The test therefore controls exactly when
  // identity resolves, which is the window this file is about.
  let identify = () => {};
  const whenOwnerPid = new Promise((resolve) => {
    identify = resolve;
  });
  if (resolveIdentity) identify(OWNER_PID);
  const sideband = await startBootstrapSideband(socketPath, {
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error.message),
    whenOwnerPid,
    ...(identityDeadlineMs === undefined ? {} : { identityDeadlineMs }),
  });
  cleanup.push(() => sideband.close?.());
  return { sideband, socketPath, frames, errors, identify: () => identify(OWNER_PID) };
}

/** One peer that speaks the bootstrap protocol: it says hello, and answers `present` like Pi does. */
async function peer(socketPath, { pid, answerPresent = true } = {}) {
  const socket = net.createConnection(socketPath);
  cleanup.push(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      const command = JSON.parse(line);
      if (command.type === "present" && answerPresent) {
        socket.write(`${JSON.stringify({ type: "presentation-result", requestId: command.requestId, result: { presented: true, cold: true, byPid: pid } })}\n`);
      }
    }
  });
  socket.write(`${JSON.stringify({ type: "native-bootstrap", protocol: 1, pid, capability: { seam: "E" }, reached: [] })}\n`);
  return socket;
}

/** Give the listener a moment to admit or refuse what was just written. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

it("keeps the owner's connection when a descendant connects and exits", async () => {
  const { sideband, socketPath } = await listener();
  await peer(socketPath, { pid: OWNER_PID });
  await settle();
  expect(sideband.connected()).toBe(true);
  await expect(sideband.present({ attachmentId: "a", epoch: 1, geometryRevision: 1 })).resolves.toMatchObject({ presented: true, byPid: OWNER_PID });

  // A Pi descendant that inherited the socket path connects, then exits - exactly the real log's pids.
  const descendant = await peer(socketPath, { pid: 1913319 });
  await settle();
  descendant.destroy();
  await settle();

  // The owner is still running and still connected, so a later attach must still be able to repaint.
  expect(sideband.connected()).toBe(true);
  await expect(sideband.present({ attachmentId: "b", epoch: 4, geometryRevision: 1 })).resolves.toMatchObject({ presented: true, byPid: OWNER_PID });
});

it("never lets a descendant answer a presentation in the owner's place", async () => {
  const { sideband, socketPath } = await listener();
  await peer(socketPath, { pid: OWNER_PID });
  await settle();
  // A descendant that would happily answer must not be the one asked.
  await peer(socketPath, { pid: 99999 });
  await settle();
  const result = await sideband.present({ attachmentId: "c", epoch: 2, geometryRevision: 1 });
  expect(result.byPid).toBe(OWNER_PID);
});

it("does not report a descendant's hello as the owner's readiness", async () => {
  const { socketPath, frames } = await listener();
  await peer(socketPath, { pid: OWNER_PID });
  await settle();
  await peer(socketPath, { pid: 1914886 });
  await settle();
  const helloes = frames.filter((frame) => frame.type === "native-bootstrap");
  expect(helloes).toHaveLength(1);
  expect(helloes[0].pid).toBe(OWNER_PID);
});

it("keeps two peers' bytes out of each other's frames", async () => {
  const { socketPath, frames } = await listener();
  const owner = await peer(socketPath, { pid: OWNER_PID });
  await settle();
  // Two connections writing partial lines must not be reassembled into one another's frames.
  const other = net.createConnection(socketPath);
  cleanup.push(() => other.destroy());
  await new Promise((resolve) => other.once("connect", resolve));
  other.write('{"type":"native-read');
  owner.write(`${JSON.stringify({ type: "native-readiness", readiness: { phase: "native-mounted" } })}\n`);
  await settle();
  other.write('iness","readiness":{"phase":"forged"}}\n');
  await settle();
  const phases = frames.filter((frame) => frame.type === "native-readiness").map((frame) => frame.readiness.phase);
  expect(phases).toContain("native-mounted");
  expect(phases).not.toContain("forged");
});

/**
 * The unresolved-identity window.
 *
 * The listener is created before Pi is spawned, and the manager can only name the owner once `openOwnerPty` has
 * spawned it AND read its birth proc snapshot - so there is a real window in which a hello can arrive while the
 * configured owner identity is still unknown. Treating that as a wildcard let the first arrival take the slot;
 * refusing outright would lose the real owner permanently, because Pi connects exactly once per launch. The
 * decision is therefore DEFERRED, bounded by a deadline, and settled by claimed pid once identity is known.
 *
 * Claimed-pid matching is not authentication and is not described as such: this channel's trust boundary stays
 * filesystem permission - a unix socket, mode 0600, inside the owner's 0700 root. The pid check keeps Pi's own
 * descendants, which pass that boundary by inheriting the path, from taking the owner's slot.
 */
it("adopts the owner's hello that arrived before its identity was known", async () => {
  const { sideband, socketPath, frames, identify } = await listener({ resolveIdentity: false });
  const owner = await peer(socketPath, { pid: OWNER_PID });
  await settle();
  // Nothing has been decided yet, so nothing is adopted and nothing is thrown away.
  expect(sideband.connected()).toBe(false);
  // Frames Pi sends while the decision is pending must not be lost either.
  owner.write(`${JSON.stringify({ type: "native-readiness", readiness: { phase: "native-mounted" } })}\n`);
  await settle();

  identify();
  await settle();

  expect(sideband.connected()).toBe(true);
  await expect(sideband.present({ attachmentId: "a", epoch: 1, geometryRevision: 1 })).resolves.toMatchObject({ presented: true, byPid: OWNER_PID });
  // The hello and the frame that arrived behind it are both delivered, in the order Pi wrote them.
  // (`presentation-result` also reaches `onFrame`, exactly as before, so only Pi's own two are compared.)
  expect(frames.filter((frame) => frame.type !== "presentation-result").map((frame) => frame.type))
    .toEqual(["native-bootstrap", "native-readiness"]);
});

it("never treats an unknown owner identity as a wildcard for a foreign hello", async () => {
  const { sideband, socketPath, frames, identify } = await listener({ resolveIdentity: false });
  await peer(socketPath, { pid: 1913319 });
  await settle();
  expect(sideband.connected()).toBe(false);

  identify();
  await settle();

  // The foreign claim is refused by pid once identity is known, and never held the channel.
  expect(sideband.connected()).toBe(false);
  expect(frames).toEqual([]);
  expect(sideband.refusals().candidates).toBe(1);
});

it("settles a race in the unresolved window in the owner's favour", async () => {
  const { sideband, socketPath, frames, identify } = await listener({ resolveIdentity: false });
  // A descendant claims first, then the real owner arrives - both before identity is known.
  await peer(socketPath, { pid: 1914886 });
  await settle();
  const owner = await peer(socketPath, { pid: OWNER_PID });
  await settle();
  expect(sideband.connected()).toBe(false);

  identify();
  await settle();

  expect(sideband.connected()).toBe(true);
  await expect(sideband.present({ attachmentId: "b", epoch: 1, geometryRevision: 1 })).resolves.toMatchObject({ byPid: OWNER_PID });
  const helloes = frames.filter((frame) => frame.type === "native-bootstrap");
  expect(helloes).toHaveLength(1);
  expect(helloes[0].pid).toBe(OWNER_PID);
  expect(owner.destroyed).toBe(false);
});

it("refuses visibly when the owner identity never resolves", async () => {
  const { sideband, socketPath, frames, errors } = await listener({ resolveIdentity: false, identityDeadlineMs: 150 });
  await peer(socketPath, { pid: OWNER_PID });
  await new Promise((resolve) => setTimeout(resolve, 400));

  // Bounded, not a buffer that grows and not a poll: the wait ends, and it ends loudly.
  expect(sideband.connected()).toBe(false);
  expect(frames).toEqual([]);
  expect(errors.join(" ")).toMatch(/identity/iu);
});

it("bounds what a pending claimant may queue before the decision", async () => {
  const { sideband, socketPath, errors } = await listener({ resolveIdentity: false });
  const owner = await peer(socketPath, { pid: OWNER_PID });
  await settle();
  for (let index = 0; index < 64; index += 1) {
    owner.write(`${JSON.stringify({ type: "native-readiness", readiness: { phase: `p${index}` } })}\n`);
  }
  await settle();
  expect(sideband.connected()).toBe(false);
  expect(errors.join(" ")).toMatch(/queued|bound/iu);
});
