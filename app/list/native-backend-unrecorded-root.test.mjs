import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { createNativeBackend } from "./native-backend.mjs";

const DEAD_PID = 2147483646;
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A runtime root whose launch died before writing its creation record: only ownership.json and the preload log. */
async function fixture({ managerPid = DEAD_PID, ownerPid = DEAD_PID, reachable = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pia-unrecorded-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const sessionsHome = path.join(dir, "runtime");
  const stateHome = path.join(dir, "state");
  const root = path.join(sessionsHome, "session-1700000000021");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "ownership.json"), JSON.stringify({ ownerId: "11111111-2222-4333-8444-555555555555", createdByPid: managerPid, createdAtMs: 1700000000021 }));
  await writeFile(path.join(root, "owner-preload.jsonl"), `${JSON.stringify({ atMs: 1700000000500, event: "registered", pid: ownerPid })}\n`);
  const calls = [];
  async function control(_root, frame) {
    calls.push(frame.type);
    return reachable ? { reachable: true, answer: { status: { root, bridge: { connected: false } } } } : { reachable: false, reason: "connect ECONNREFUSED" };
  }
  const client = () => {
    const backend = createNativeBackend({ sessionsHome, stateHome, askControl: control });
    cleanup.push(() => backend.close());
    return backend;
  };
  return { client, root, calls, sessionId: path.basename(root) };
}

it("clears an unrecorded root whose manager and owner are gone, keeping the root's files", async () => {
  const f = await fixture();
  const client = f.client();
  const [row] = (await client.getState()).sessions;
  expect(row).toMatchObject({ sessionId: f.sessionId, processState: "STALE" });
  expect(await client.delete(row.sessionId, row.revision)).toMatchObject({ deleted: true });
  expect((await f.client().getState()).sessions).toEqual([]);
  expect((await readdir(f.root)).sort()).toEqual(["owner-preload.jsonl", "ownership.json"]);
});

it("refuses to clear an unrecorded root while its manager process exists", async () => {
  const f = await fixture({ managerPid: process.pid });
  await expect(f.client().delete(f.sessionId, 1)).rejects.toMatchObject({ code: "SESSION_LIVE" });
  expect((await f.client().getState()).sessions).toHaveLength(1);
});

it("refuses to clear an unrecorded root while its registered owner process exists", async () => {
  const f = await fixture({ ownerPid: process.pid });
  await expect(f.client().delete(f.sessionId, 1)).rejects.toMatchObject({ code: "SESSION_LIVE" });
});

it("refuses to clear an unrecorded root whose control socket still answers", async () => {
  const f = await fixture({ reachable: true });
  await expect(f.client().delete(f.sessionId, 1)).rejects.toMatchObject({ code: "SESSION_LIVE" });
});
