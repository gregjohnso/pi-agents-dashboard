import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { createNativeBackend } from "./native-backend.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function backendAnswering(probe) {
  const dir = await mkdtemp(path.join(tmpdir(), "pia-open-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const sessionsHome = path.join(dir, "runtime");
  await mkdir(path.join(sessionsHome, "session-1700000000021"), { recursive: true });
  const frames = [];
  const backend = createNativeBackend({
    sessionsHome,
    askControl: async (_root, frame) => { frames.push(frame.type); return probe; },
  });
  cleanup.push(() => backend.close());
  return { backend, frames };
}

const live = (extra) => ({ reachable: true, answer: { status: { owner: { pid: 1 }, exit: null, ...extra } } });

it("refuses to open a session whose Pi has not mounted yet, without touching it", async () => {
  const { backend, frames } = await backendAnswering(live({ ingressReady: false }));
  await expect(backend.assertOpenable("session-1700000000021")).rejects.toMatchObject({ code: "SESSION_STARTING", message: "Still starting — try again in a moment" });
  expect(frames).toEqual(["status"]);
});

it.each([
  ["a ready session", live({ ingressReady: true })],
  ["an older manager that reports no readiness", live({})],
  ["an exited owner, whose own attach reports the exit", live({ ingressReady: false, exit: { code: 0 } })],
  ["an unreachable owner, whose own attach reports the failure", { reachable: false, reason: "no control socket" }],
])("leaves opening %s to the existing attach path", async (_name, probe) => {
  const { backend } = await backendAnswering(probe);
  await expect(backend.assertOpenable("session-1700000000021")).resolves.toBeUndefined();
});
