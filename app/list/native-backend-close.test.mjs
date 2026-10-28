import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createNativeBackend } from "./native-backend.mjs";
import { createSavedOwnerRecord, writeSavedOwnerSnapshot } from "../../examples/native-session-demo/saved-owner-record.mjs";
import { writeOwnerRecord } from "../../examples/native-session-demo/demo-root.mjs";
import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";

const EXIT = { code: 0, signal: null, waitObserved: true, disposition: "graceful" };
const DEAD_OWNER = { pid: 2147483647, startIdentity: "12345", processGroupId: 2147483647 };
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture({ owner = DEAD_OWNER, exit = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pia-close-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const sessionsHome = path.join(dir, "runtime");
  const stateHome = path.join(dir, "state");
  const root = path.join(sessionsHome, "session-1700000000011");
  const sessionFile = path.join(dir, "pi-session.jsonl");
  const worktree = path.join(dir, "worktree");
  await mkdir(root, { recursive: true });
  await mkdir(worktree);
  await writeFile(sessionFile, "Pi's canonical transcript\n");
  await writeFile(path.join(worktree, "draft.txt"), "keep this work\n");
  const record = await createSavedOwnerRecord({ recordsHome: stateHome, sessionId: path.basename(root), runtimeRoot: root });
  cleanup.push(() => record.close());
  let sequence = 0;
  const facts = { sessionId: "pi-current", sessionFile, sessionName: "my session", idle: true, pendingMessages: false };
  async function snapshot(status) {
    await writeSavedOwnerSnapshot(record, { sequence: ++sequence, owner, cwd: worktree, facts, exit: status });
  }
  await snapshot(exit);
  const creation = { root, owner, durable: { ownerId: record.ownerId } };
  await writeOwnerRecord(root, creation);
  let stopped = exit !== null;
  const calls = [];
  const status = () => ({ root, owner, durable: creation.durable, bridge: { connected: true, facts }, projectCwd: worktree, exit: null });
  async function control(_root, frame) {
    calls.push(frame.type);
    if (stopped) return { reachable: false, reason: "no control socket" };
    if (frame.type === "status") return { reachable: true, answer: { status: status() } };
    if (frame.type === "stop") {
      await snapshot(EXIT);
      stopped = true;
      return { reachable: true, answer: { exit: EXIT } };
    }
    throw Error(`unexpected control frame ${frame.type}`);
  }
  function client(askControl = control) {
    const backend = createNativeBackend({ sessionsHome, stateHome, askControl });
    cleanup.push(() => backend.close());
    return backend;
  }
  return { client, root, sessionFile, worktree, record, owner, calls, status, creation };
}

it("returns the stopped row immediately and treats a repeat stop after socket removal as already stopped", async () => {
  const f = await fixture();
  const client = f.client();
  await client.getState();
  const first = await client.stop(path.basename(f.root), 1, "stop-1");
  expect(first.session).toMatchObject({ sessionId: path.basename(f.root), processState: "EXITED", taskState: "STOPPED", stateReported: true });
  const second = await client.stop(path.basename(f.root), 1, "stop-2");
  expect(second).toMatchObject({ observedExit: true, alreadyStopped: true, exit: EXIT });
  const { sessions } = await client.getState();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ processState: "EXITED", taskState: "STOPPED" });
});

it("does not republish a live row from a status read started before a successful stop", async () => {
  const f = await fixture();
  let release;
  let reached;
  const started = new Promise((resolve) => { reached = resolve; });
  const client = f.client(async (root, frame) => {
    if (frame.type !== "status") {
      f.calls.push(frame.type);
      await writeSavedOwnerSnapshot(f.record, { sequence: 2, owner: f.owner, exit: EXIT });
      return { reachable: true, answer: { exit: EXIT } };
    }
    const old = f.status();
    reached();
    await new Promise((resolve) => { release = resolve; });
    return { reachable: true, answer: { status: old } };
  });
  const pending = client.getState();
  await started;
  await client.stop(path.basename(f.root), 1, "close");
  release();
  expect((await pending).sessions[0]).toMatchObject({ processState: "EXITED", taskState: "STOPPED" });
});

it("clears a stopped runtime persistently without deleting its transcript, worktree, runtime, or owner metadata", async () => {
  const f = await fixture({ exit: EXIT });
  const original = await readFile(f.record.paths.record, "utf8");
  const client = f.client();
  const { sessions } = await client.getState();
  expect(sessions).toHaveLength(1);
  const row = sessions[0];
  expect(await client.delete(row.sessionId, row.revision, "clear")).toMatchObject({ deleted: true });
  expect((await f.client().getState()).sessions).toEqual([]);
  expect(await readFile(f.sessionFile, "utf8")).toBe("Pi's canonical transcript\n");
  expect(await readFile(path.join(f.worktree, "draft.txt"), "utf8")).toBe("keep this work\n");
  expect(await readFile(f.record.paths.record, "utf8")).toBe(original);
  expect(JSON.parse(await readFile(path.join(f.root, "owner.json"), "utf8"))).toEqual(f.creation);
  expect(await client.delete(row.sessionId, row.revision, "clear-again")).toMatchObject({ deleted: true });
});

it("does not resurrect a cleared row from a status read that was already in flight", async () => {
  const f = await fixture({ exit: EXIT });
  let release;
  let reached;
  const started = new Promise((resolve) => { reached = resolve; });
  const client = f.client(async () => {
    const old = f.status();
    reached();
    await new Promise((resolve) => { release = resolve; });
    return { reachable: true, answer: { status: old } };
  });
  const pending = client.getState();
  await started;
  await client.delete(path.basename(f.root), 1, "clear-during-read");
  release();
  expect((await pending).sessions).toEqual([]);
});

it("invalidates another dashboard after an owner is cleared", async () => {
  const f = await fixture({ exit: EXIT });
  const reader = f.client();
  let notifications = 0;
  await reader.subscribeListChanges(() => { notifications += 1; });
  expect((await reader.getState()).sessions).toHaveLength(1);
  await f.client().delete(path.basename(f.root), 1, "clear-other-window");
  await vi.waitFor(() => expect(notifications).toBeGreaterThan(0));
  expect((await reader.getState()).sessions).toEqual([]);
});

it("refuses clear when recorded process identity is malformed", async () => {
  const f = await fixture({ owner: { ...DEAD_OWNER, startIdentity: "not-a-start-time" }, exit: EXIT });
  await expect(f.client().delete(`saved:${f.record.ownerId}`, 1, "clear-unknown")).rejects.toMatchObject({ code: "SESSION_STATE_UNKNOWN" });
});

it("clears a saved stopped row when its runtime is already gone, without sending a control request", async () => {
  const f = await fixture({ exit: EXIT });
  await rm(f.root, { recursive: true });
  const client = f.client();
  const row = (await client.getState()).sessions[0];
  expect(row.durable.savedOnly).toBe(true);
  expect(await client.delete(row.sessionId, row.revision, "clear-saved")).toMatchObject({ deleted: true });
  expect((await f.client().getState()).sessions).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(await readFile(f.sessionFile, "utf8")).toBe("Pi's canonical transcript\n");
});

it("refuses clear for an exact live owner, even if a saved record claims it exited", async () => {
  const f = await fixture({ owner: await inspectProcessIdentity(process.pid), exit: EXIT });
  const client = f.client();
  await expect(client.delete(`saved:${f.record.ownerId}`, 1, "clear-live")).rejects.toMatchObject({ code: "SESSION_LIVE" });
  expect(await readFile(f.sessionFile, "utf8")).toBe("Pi's canonical transcript\n");
});

it("checks revisions before clearing a stopped row", async () => {
  const f = await fixture({ exit: EXIT });
  const client = f.client();
  await expect(client.delete(path.basename(f.root), 99, "stale-clear")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect((await client.getState()).sessions.length).toBeGreaterThan(0);
});

it("clearing an old saved owner cannot hide a new owner reusing its runtime path", async () => {
  const f = await fixture({ exit: EXIT });
  const replacement = { ...f.creation, owner: await inspectProcessIdentity(process.pid), durable: { ownerId: "a-different-owner" } };
  await writeOwnerRecord(f.root, replacement);
  const client = f.client(async () => ({ reachable: true, answer: { status: { ...f.status(), owner: replacement.owner, durable: replacement.durable } } }));
  const row = (await client.getState()).sessions.find((candidate) => candidate.durable?.savedOnly === true);
  expect(await client.delete(row.sessionId, row.revision, "clear-old")).toMatchObject({ deleted: true });
  const rows = (await client.getState()).sessions;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ sessionId: path.basename(f.root), processState: "LIVE" });
});
