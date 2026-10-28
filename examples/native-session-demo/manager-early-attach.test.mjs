import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runManager } from "./manager.mjs";
import { readToken } from "./demo-root.mjs";
import { createFrameReader, encodeFrame } from "./protocol.mjs";

const controls = vi.hoisted(() => ({ onFrame: undefined, present: undefined, finish: undefined }));
vi.mock("node:tty", async () => {
  const { PassThrough } = await import("node:stream");
  return { ReadStream: PassThrough };
});
vi.mock("../../runtime/pty-mechanism.mjs", () => ({
  openOwnerPty: async () => {
    let exit = null;
    const waited = new Promise((resolve) => { controls.finish = (value) => { exit = value; resolve(value); }; });
    return { masterFd: undefined, owner: { pid: 424243, startIdentity: "synthetic-owner", processGroupId: 424243 },
      reapIfExited: () => exit, wait: () => waited, resize() {}, write() {} };
  },
}));
vi.mock("./bootstrap-sideband.mjs", () => ({
  startBootstrapSideband: async (_socket, options) => {
    controls.onFrame = options.onFrame;
    return { close: async () => {}, connected: () => true, present: controls.present };
  },
}));

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("waits for Pi to mount before asking a connected-but-loading Pi to present", async () => {
  controls.present = vi.fn(async () => ({ presented: true, presentationNonce: "nonce" }));
  const dir = await mkdtemp(path.join(tmpdir().length < 60 ? tmpdir() : "/tmp", "pia-ea-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "runtime");
  const starting = runManager({ root, cohortRoot: "/mnt/main0/home/gjohnson/projects/pi-agents-pi14-work/cohort-4189339", log: () => {}, onReady: () => {} });
  starting.catch(() => {});
  await expect.poll(() => existsSync(path.join(root, "s")) && controls.onFrame !== undefined).toBe(true);

  const frames = [];
  const socket = net.connect(path.join(root, "s"));
  cleanup.push(() => socket.destroy());
  const reader = createFrameReader(({ header }) => frames.push(header.type), () => {});
  socket.on("data", (chunk) => reader.push(chunk));
  const token = await readToken(root);
  socket.write(encodeFrame({ type: "hello", role: "client", token, attachmentId: "early", cols: 80, rows: 24 }));

  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(controls.present).not.toHaveBeenCalled();
  expect(frames).not.toContain("welcome");
  expect(frames).not.toContain("refused");

  controls.onFrame({ type: "native-readiness", readiness: { phase: "native-mounted" } });
  const manager = await starting;
  cleanup.push(async () => { controls.finish({ status: 0, code: 0, signal: null, coreDumped: false }); await manager.stop(true); });
  await expect.poll(() => frames).toContain("welcome");
  expect(controls.present).toHaveBeenCalledTimes(1);
});
