import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

it("recovers an existing root that still holds retired viewer acknowledgement files", async () => {
  const { root, sessionFile } = await setup();
  const first = await open(root, "client-retired");
  const firstSnapshot = await first.client.getViewerSnapshot("session-1");
  await first.client.close();
  await first.daemon.close();

  const viewerDirectory = join(root, "index", "viewer");
  const eventsFile = (await readdir(viewerDirectory)).find((name) => name.endsWith(".events.jsonl"));
  if (eventsFile === undefined) throw new Error("Viewer event store was not created");
  // Whatever a retired file holds cannot matter once no production code names its path, so this
  // seeds a path that fails every read with EISDIR. It stays green only while nothing opens it.
  const retired = join(viewerDirectory, `${eventsFile.slice(0, -".events.jsonl".length)}.acks.json`);
  await mkdir(retired, { recursive: true });

  const assistant = { type: "message", id: "assistant-1", parentId: "user-1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "answer" }] } };
  await appendFile(sessionFile, `${JSON.stringify(assistant)}\n`);
  const second = await open(root, "client-retired-2");
  const replay = second.client.subscribeViewer("session-1", firstSnapshot.cursor)[Symbol.asyncIterator]();
  await expect(replay.next()).resolves.toMatchObject({ value: { payload: { kind: "assistant_message", itemId: "assistant-1" } }, done: false });
  await replay.return?.();
  const recovered = await second.client.getViewerSnapshot("session-1");
  expect(recovered.items).toEqual([
    expect.objectContaining({ kind: "user_message", itemId: "user-1" }),
    expect.objectContaining({ kind: "assistant_message", itemId: "assistant-1" }),
  ]);
  await second.client.close();
  await second.daemon.close();
  expect((await stat(retired)).isDirectory()).toBe(true);
});

// The two halves of this were each already tested and never together: the store refuses a replay
// larger than its subscriber bound, and the client subscribes over a socket. A viewer that fell that
// far behind used to receive the refusal as nothing at all.
it("tells a viewer that its resumed subscription replays more than the daemon's subscriber bound", async () => {
  const { root, sessionFile } = await setup();
  const answers = Array.from({ length: 120 }, (_, index) => ({
    type: "message", id: `assistant-${index}`, parentId: index === 0 ? "user-1" : `assistant-${index - 1}`, timestamp: at,
    message: { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] },
  }));
  await appendFile(sessionFile, answers.map((answer) => `${JSON.stringify(answer)}\n`).join(""));
  const { daemon, client } = await open(root, "client-overflow");
  const snapshot = await client.getViewerSnapshot("session-1");
  expect(BigInt(snapshot.cursor.sequence)).toBeGreaterThan(100n);

  const behind = client.subscribeViewer("session-1", { ...snapshot.cursor, sequence: "0" })[Symbol.asyncIterator]();
  const refused = behind.next().then(() => "delivered", (/** @type {unknown} */ error) => error);
  await expect(Promise.race([refused, new Promise((resolve) => setTimeout(() => resolve("waited for a refusal that reached nobody"), 2_000))]))
    .resolves.toMatchObject({ code: "SUBSCRIBER_OVERFLOW" });
  await behind.return?.();
  await client.close();
  await daemon.close();
});

it("keeps a published event authoritative when re-derived history content drifts", async () => {
  const { root } = await setup();
  const first = await open(root, "client-drift");
  await first.client.getViewerSnapshot("session-1");
  await first.client.close();
  await first.daemon.close();

  const viewerDirectory = join(root, "index", "viewer");
  const eventsFile = (await readdir(viewerDirectory)).find((name) => name.endsWith(".events.jsonl"));
  if (eventsFile === undefined) throw new Error("Viewer event store was not created");
  const eventsPath = join(viewerDirectory, eventsFile);
  const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const drifted = events.map((event) => event.payload?.kind === "user_message"
    ? { ...event, payload: { ...event.payload, content: [{ type: "text", text: "drifted transcript" }] } }
    : event);
  await writeFile(eventsPath, `${drifted.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });

  const second = await open(root, "client-drift-2");
  await expect(second.client.getViewerSnapshot("session-1")).resolves.toMatchObject({ sessionId: "session-1" });
  const preserved = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(preserved.filter((event) => event.payload?.kind === "user_message").map((event) => event.payload.content)).toEqual([[{ type: "text", text: "drifted transcript" }]]);
  await second.client.close();
  await second.daemon.close();
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
  replay.applied(replayed.value.cursor);
  await replay.return?.();

  // The resume cursor is the frontend's own and reaches no durable daemon file, so both windows it
  // can drop in have to behave: a frontend that dropped before applying sees the event again, and
  // one that applied it resumes past it.
  const unapplied = second.client.subscribeViewer("session-1", firstSnapshot.cursor)[Symbol.asyncIterator]();
  await expect(unapplied.next()).resolves.toMatchObject({ value: { eventId: replayed.value.eventId }, done: false });
  await unapplied.return?.();
  const resumed = second.client.subscribeViewer("session-1", replayed.value.cursor)[Symbol.asyncIterator]();
  const pending = resumed.next();
  await expect(Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("idle"), 50))])).resolves.toBe("idle");
  await resumed.return?.();
  await pending;
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
