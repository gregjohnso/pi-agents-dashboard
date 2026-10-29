import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createNativeBackend } from "./native-backend.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pia-fresh-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const sessionsHome = path.join(dir, "runtime");
  const stateHome = path.join(dir, "state");
  await mkdir(path.join(sessionsHome, "session-1700000000031"), { recursive: true });
  await mkdir(path.join(stateHome, "owners", "owner-a"), { recursive: true });
  const backend = createNativeBackend({ sessionsHome, stateHome, askControl: async () => ({ reachable: false, reason: "fixture" }), ...options });
  cleanup.push(() => backend.close());
  const changed = vi.fn();
  const unsubscribe = await backend.subscribeListChanges(changed);
  cleanup.push(async () => unsubscribe());
  return { sessionsHome, stateHome, changed };
}

it("refreshes the list when a manager rewrites its owner record, which it does on every state change", async () => {
  const { stateHome, changed } = await fixture();
  await writeFile(path.join(stateHome, "owners", "owner-a", "owner.json"), JSON.stringify({ sequence: 2 }));
  await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 2000 });
});

it("refreshes for an owner whose record directory appeared after the list subscribed", async () => {
  const { stateHome, changed } = await fixture();
  await mkdir(path.join(stateHome, "owners", "owner-b"));
  await writeFile(path.join(stateHome, "owners", "owner-b", "owner.json"), JSON.stringify({ sequence: 1 }));
  await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 2000 });
});

it("coalesces a burst of record writes into one refresh", async () => {
  const { stateHome, changed } = await fixture();
  for (let sequence = 1; sequence <= 5; sequence += 1) await writeFile(path.join(stateHome, "owners", "owner-a", "owner.json"), JSON.stringify({ sequence }));
  await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 2000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(changed).toHaveBeenCalledTimes(1);
});

it("still refreshes on a slow timer when no record changes", async () => {
  const { changed } = await fixture({ safetyRefreshMs: 150 });
  await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
});

it("does not refresh for a runtime root's own log churn", async () => {
  const { sessionsHome, changed } = await fixture();
  for (let line = 0; line < 5; line += 1) await writeFile(path.join(sessionsHome, "session-1700000000031", "manager.log"), `line ${line}\n`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(changed).not.toHaveBeenCalled();
});
