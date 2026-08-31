import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { pumpViewerSubscription } from "./daemon.mjs";
import { ViewerStoreError, createViewerStore } from "./viewer-store.mjs";

/** @type {string[]} */
const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));
async function location() { const directory = await mkdtemp(join(tmpdir(), "viewer-store-")); directories.push(directory); return directory; }
const draft = { eventId: "event-1", timestamp: "2026-08-25T00:00:00.000Z", payload: { kind: "user_message", itemId: "user-1", content: [{ type: "text", text: "hello" }] } };
const cursor = (/** @type {number} */ sequence, /** @type {string} */ epoch = "epoch-1", /** @type {string} */ sessionId = "session-1") => ({ daemonEpoch: epoch, sessionId, sequence: String(sequence) });
const snapshot = (/** @type {number} */ sequence, /** @type {string} */ text = "hello") => ({
  version: 1, sessionId: "session-1", registryRevision: 1, cursor: cursor(sequence), runtime: null, role: "observer",
  taskState: "READY", processState: "SLEEPING", outcome: "NONE",
  activity: { kind: "activity", phase: "idle", label: "Idle", sourceEventId: "source", startedAt: "2026-08-25T00:00:00.000Z" },
  model: null, thinkingLevel: null, items: [{ kind: "user_message", itemId: "user-1", content: [{ type: "text", text }] }], tools: [], pendingUi: [], errors: [],
});

describe("durable per-session viewer store", () => {
  it("persists before broadcast, uses independent session cursors, and replays strictly after the cursor", async () => {
    /** @type {string[]} */
    const phases = [];
    const store = await createViewerStore({ directory: await location(), sessionId: "session-1", daemonEpoch: "epoch-1", failpoint: (phase) => { phases.push(phase); } });
    const subscriber = store.subscribe();
    const first = await store.append(draft);
    const received = await subscriber.next();
    expect(first.cursor).toEqual(cursor(1));
    expect(received.value).toEqual(first);
    expect(phases).toContain("after_persist_before_broadcast");
    expect(await store.replay(cursor(0))).toEqual([first]);
    expect(await store.replay(first.cursor)).toEqual([]);
    await subscriber.return();
    await store.close();
  });

  it("is idempotent for duplicate stable IDs and rejects changed reuse", async () => {
    const store = await createViewerStore({ directory: await location(), sessionId: "session-1", daemonEpoch: "epoch-1" });
    const first = await store.append(draft);
    expect(await store.append(draft)).toEqual(first);
    await expect(store.append({ ...draft, payload: { ...draft.payload, content: [{ type: "text", text: "changed" }] } })).rejects.toMatchObject({ code: "VIEWER_EVENT_ID_CONFLICT" });
    expect(store.currentCursor()).toEqual(cursor(1));
    await store.close();
  });

  it("rejects session, epoch, malformed, and future cursors", async () => {
    const store = await createViewerStore({ directory: await location(), sessionId: "session-1", daemonEpoch: "epoch-1" });
    await store.append(draft);
    await expect(store.replay(cursor(0, "old"))).rejects.toMatchObject({ code: "DAEMON_EPOCH_MISMATCH" });
    await expect(store.replay(cursor(0, "epoch-1", "other"))).rejects.toMatchObject({ code: "VIEWER_SESSION_MISMATCH" });
    await expect(store.replay(cursor(2))).rejects.toBeInstanceOf(ViewerStoreError);
    await store.close();
  });

  it("recovers a synced event after a crash before broadcast and bounds slow subscribers", async () => {
    const directory = await location();
    const crashing = await createViewerStore({ directory, sessionId: "session-1", daemonEpoch: "epoch-1", subscriberLimit: 1, failpoint(phase) { if (phase === "after_persist_before_broadcast") throw new Error("crash"); } });
    await expect(crashing.append(draft)).rejects.toThrow("crash");
    await crashing.close();
    const recovered = await createViewerStore({ directory, sessionId: "session-1", daemonEpoch: "epoch-1", subscriberLimit: 1 });
    expect(await recovered.replay()).toHaveLength(1);
    const subscriber = recovered.subscribe(cursor(1));
    await recovered.append({ ...draft, eventId: "event-2" });
    await recovered.append({ ...draft, eventId: "event-3" });
    await expect(subscriber.next()).rejects.toMatchObject({ code: "SUBSCRIBER_OVERFLOW" });
    await recovered.close();
  });

  it("keeps recovery checkpoints outside public v1, and keeps the prior snapshot when publication fails", async () => {
    const directory = await location();
    const checkpoint = { activeAssistant: { itemId: "assistant-1", blocks: [{ contentIndex: 0, type: "thinking", text: "reason" }, { contentIndex: 2, type: "text", text: "ans" }] } };
    const store = await createViewerStore({ directory, sessionId: "session-1", daemonEpoch: "epoch-1" });
    const event = await store.append({ eventId: "delta-1", timestamp: draft.timestamp, payload: { kind: "assistant_delta", itemId: "assistant-1", delta: "ans" }, internalCheckpoint: checkpoint });
    await store.publishSnapshot(snapshot(1), checkpoint);
    expect(event.payload).toEqual({ kind: "assistant_delta", itemId: "assistant-1", delta: "ans" });
    expect(await store.getSnapshot()).toEqual(snapshot(1));
    await store.close();

    const recovered = await createViewerStore({ directory, sessionId: "session-1", daemonEpoch: "epoch-1" });
    expect(await recovered.getCheckpoint()).toEqual(checkpoint);
    expect((await recovered.replay())[0].payload).toEqual({ kind: "assistant_delta", itemId: "assistant-1", delta: "ans" });
    await recovered.close();

    const failing = await createViewerStore({ directory, sessionId: "session-1", daemonEpoch: "epoch-1", failpoint(phase) { if (phase === "before_snapshot_publish") throw new Error("snapshot crash"); } });
    await expect(failing.publishSnapshot(snapshot(1, "changed"))).rejects.toThrow("snapshot crash");
    expect(await failing.getSnapshot()).toEqual(snapshot(1));
    await failing.close();
  });

  it("uses one ordered replay/live pump and waits for each write before reading the next event", async () => {
    const store = await createViewerStore({ directory: await location(), sessionId: "session-1", daemonEpoch: "epoch-1", subscriberLimit: 2 });
    await store.append(draft);
    const subscription = store.subscribe();
    /** @type {string[]} */
    const writes = [];
    /** @type {(value?: unknown) => void} */
    let releaseFirst = () => {};
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    const pumping = pumpViewerSubscription(subscription, async (event) => {
      writes.push(event.eventId);
      if (event.eventId === "event-1") await firstBlocked;
    });
    await Promise.resolve();
    await store.append({ ...draft, eventId: "event-2" });
    expect(writes).toEqual(["event-1"]);
    releaseFirst();
    while (writes.length < 2) await Promise.resolve();
    expect(writes).toEqual(["event-1", "event-2"]);
    await subscription.return();
    await pumping;
    await store.close();
  });

  it("exposes no acknowledgement method and writes no retired acknowledgement file", async () => {
    const directory = await location();
    const store = await createViewerStore({ directory, sessionId: "session-1", daemonEpoch: "epoch-1" });
    await store.append(draft);
    await store.publishSnapshot(snapshot(1));
    expect(Object.keys(store).filter((name) => /ack/iu.test(name))).toEqual([]);
    await store.close();
    expect((await readdir(directory)).filter((name) => name.endsWith(".acks.json"))).toEqual([]);
  });
});
