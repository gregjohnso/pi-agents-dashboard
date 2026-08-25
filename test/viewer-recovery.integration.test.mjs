import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { createDaemonRuntime } from "../runtime/daemon.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";

const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));
const at = "2026-08-25T00:00:00.000Z";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "viewer-recovery-"));
  directories.push(directory);
  const root = join(directory, "state");
  const sessions = join(root, "sessions");
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const sessionFile = join(directory, "canonical.jsonl");
  const header = { type: "session", version: 3, id: "session-1", timestamp: at, cwd: directory };
  const user = { type: "message", id: "user-1", parentId: null, timestamp: at, message: { role: "user", content: "hello" } };
  await writeFile(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`, { mode: 0o600 });
  const registry = new RegistryStore(sessions);
  await registry.create({ schemaVersion: 1, revision: 0, sessionId: "session-1", sessionFile, canonicalSessionFile: sessionFile, cwd: directory, taskState: "READY", processState: "SLEEPING", outcome: "NONE", activity: { kind: "idle", summary: "Idle", updatedAt: at }, createdAt: at, updatedAt: at });
  return { root, sessionFile };
}

/** @param {string} root @param {string} clientId */
async function open(root, clientId) {
  const daemon = await createDaemonRuntime({ root });
  await daemon.ready;
  const client = createDaemonClient({ socketPath: daemon.socketPath, token: daemon.token, maxBytes: 256 * 1024, clientId, reconnect: false });
  await client.connect();
  return { daemon, client };
}

it("fails daemon reconciliation closed when durable viewer state is corrupt", async () => {
  const { root } = await setup();
  const first = await open(root, "client-corrupt");
  await first.client.getViewerSnapshot("session-1");
  await first.client.close();
  await first.daemon.close();
  const viewerDirectory = join(root, "index", "viewer");
  const eventsFile = (await readdir(viewerDirectory)).find((name) => name.endsWith(".events.jsonl"));
  if (eventsFile === undefined) throw new Error("Viewer event store was not created");
  await appendFile(join(viewerDirectory, eventsFile), `${JSON.stringify({ invalid: true })}\n`);
  const daemon = await createDaemonRuntime({ root });
  await expect(daemon.ready).rejects.toMatchObject({ code: "VIEWER_STORE_CORRUPT" });
  await daemon.close().catch(() => {});
});

it("reconstructs normalized snapshots from canonical history and durable viewer events across daemon restart", async () => {
  const { root, sessionFile } = await setup();
  const original = await readFile(sessionFile);
  const first = await open(root, "client-1");
  const firstSnapshot = await first.client.getViewerSnapshot("session-1");
  expect(firstSnapshot.items).toEqual([expect.objectContaining({ kind: "user_message", itemId: "user-1" })]);
  expect(JSON.stringify(firstSnapshot)).not.toContain("canonical.jsonl");
  await first.client.close();
  await first.daemon.close();
  expect(await readFile(sessionFile)).toEqual(original);

  const assistant = { type: "message", id: "assistant-1", parentId: "user-1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "answer" }] } };
  await appendFile(sessionFile, `${JSON.stringify(assistant)}\n`);
  const second = await open(root, "client-2");
  const replay = second.client.subscribeViewer("session-1", firstSnapshot.cursor)[Symbol.asyncIterator]();
  const replayed = await replay.next();
  expect(replayed).toMatchObject({ value: { sessionId: "session-1", payload: { kind: "assistant_message", itemId: "assistant-1" } }, done: false });
  await expect(second.client.ackViewer(replayed.value.cursor)).resolves.toEqual(replayed.value.cursor);
  await replay.return?.();
  const recovered = await second.client.getViewerSnapshot("session-1");
  expect(recovered.items).toEqual([
    expect.objectContaining({ kind: "user_message", itemId: "user-1" }),
    expect.objectContaining({ kind: "assistant_message", itemId: "assistant-1" }),
  ]);
  expect(recovered.cursor.daemonEpoch).toBe(firstSnapshot.cursor.daemonEpoch);
  expect(BigInt(recovered.cursor.sequence)).toBeGreaterThan(BigInt(firstSnapshot.cursor.sequence));
  await second.client.close();
  await second.daemon.close();
});
