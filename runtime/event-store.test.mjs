import { appendFile, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStoreError, createEventStore, parseCursorSequence } from "./event-store.mjs";

/** @type {string[]} */
const directories = [];
/** @returns {Promise<string>} */
async function path() { const directory = await mkdtemp(join(tmpdir(), "events-")); directories.push(directory); return join(directory, "events.jsonl"); }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const change = { kind: "attachment_changed", payload: { sessionId: "session-1", clientId: "client-1", role: "observer", attached: true } };

describe("event store", () => {
  it("shares exact arbitrary-size sequence parsing with session-scoped viewer cursors", () => {
    expect(parseCursorSequence("18446744073709551616")).toBe(18446744073709551616n);
    expect(() => parseCursorSequence("01")).toThrow(/canonical/u);
  });

  it("persists monotonically exact string cursors and replays strictly after a cursor", async () => {
    const store = await createEventStore({ path: await path(), daemonEpoch: "epoch-1", now: () => "2026-01-01T00:00:00.000Z" });
    const first = await store.append(change);
    const second = await store.append(change);
    expect(first.cursor).toEqual({ daemonEpoch: "epoch-1", sequence: "1" });
    expect((await store.replay(first.cursor)).map((event) => event.cursor)).toEqual([second.cursor]);
    await store.close();
  });

  it("rejects daemon epoch mismatch and invalid or future cursors", async () => {
    const store = await createEventStore({ path: await path(), daemonEpoch: "epoch-1" });
    await store.append(change);
    await expect(store.replay({ daemonEpoch: "old", sequence: "0" })).rejects.toMatchObject({ code: "DAEMON_EPOCH_MISMATCH" });
    await expect(store.replay({ daemonEpoch: "epoch-1", sequence: "2" })).rejects.toBeInstanceOf(EventStoreError);
    await store.close();
  });

  it("persists before publish and supports replay after a broadcast-boundary crash", async () => {
    const storePath = await path();
    const store = await createEventStore({ path: storePath, daemonEpoch: "epoch-1", failpoint(name) { if (name === "after_persist_before_broadcast") throw new Error("crash"); } });
    await expect(store.append(change)).rejects.toThrow("crash");
    await store.close();
    const reopened = await createEventStore({ path: storePath, daemonEpoch: "epoch-1" });
    expect(await reopened.replay()).toHaveLength(1);
    await reopened.close();
  });

  it("rejects an initial replay larger than the subscriber bound", async () => {
    const store = await createEventStore({ path: await path(), daemonEpoch: "epoch-1", subscriberLimit: 1 });
    await store.append(change);
    await store.append(change);
    expect(() => store.subscribe()).toThrow(expect.objectContaining({ code: "SUBSCRIBER_OVERFLOW" }));
    await store.close();
  });

  it.each([
    ["pending when the store closes", /** @param {any} store */ async (store) => { const pending = store.subscribe().next(); await store.close(); return pending; }],
    ["created after the store closes", /** @param {any} store */ async (store) => { await store.close(); return store.subscribe().next(); }],
  ])("finishes an iterator %s", async (_label, iterate) => {
    const store = await createEventStore({ path: await path(), daemonEpoch: "epoch-1" });
    await expect(iterate(store)).resolves.toEqual({ value: undefined, done: true });
  });

  it("persists complete records across deterministic short writes", async () => {
    const storePath = await path();
    const probe = await open(storePath, "a", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalWrite = prototype.write;
    const write = vi.spyOn(prototype, "write").mockImplementation(function (buffer) {
      const bytes = /** @type {Buffer} */ (buffer);
      return originalWrite.call(this, bytes.subarray(0, Math.min(7, bytes.length)));
    });
    try {
      const store = await createEventStore({ path: storePath, daemonEpoch: "epoch-1" });
      await store.append(change);
      await store.close();
      expect(write.mock.calls.length).toBeGreaterThan(1);
    } finally {
      write.mockRestore();
    }
    const reopened = await createEventStore({ path: storePath, daemonEpoch: "epoch-1" });
    await expect(reopened.replay()).resolves.toHaveLength(1);
    await reopened.close();
  });

  it("poisons the store after a partial write stalls and recovers the torn tail on reopen", async () => {
    const storePath = await path();
    const probe = await open(storePath, "a", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalWrite = prototype.write;
    let writeAttempt = 0;
    const write = vi.spyOn(prototype, "write").mockImplementation(function (buffer) {
      writeAttempt += 1;
      if (writeAttempt === 1) return originalWrite.call(this, /** @type {Buffer} */ (buffer).subarray(0, 7));
      if (writeAttempt === 2) return Promise.resolve({ bytesWritten: 0, buffer });
      return originalWrite.call(this, buffer);
    });
    const store = await createEventStore({ path: storePath, daemonEpoch: "epoch-1" });
    try {
      await expect(store.append(change)).rejects.toMatchObject({ name: "AppendStoreError", code: "WRITE_STALLED" });
      await expect(store.append(change)).rejects.toMatchObject({ name: "AppendStoreError", code: "STORE_FAILED" });
    } finally {
      write.mockRestore();
      await store.close();
    }

    const reopened = await createEventStore({ path: storePath, daemonEpoch: "epoch-1" });
    await expect(reopened.replay()).resolves.toEqual([]);
    await expect(reopened.append(change)).resolves.toMatchObject({ cursor: { daemonEpoch: "epoch-1", sequence: "1" } });
    await reopened.close();

    const verified = await createEventStore({ path: storePath, daemonEpoch: "epoch-1" });
    await expect(verified.replay()).resolves.toHaveLength(1);
    await verified.close();
  });

  it("incrementally discards an incomplete final record after a crash", async () => {
    const storePath = await path();
    const store = await createEventStore({ path: storePath, daemonEpoch: "epoch-1" });
    await store.append(change);
    await store.close();
    await appendFile(storePath, '{"version":1,"cursor":');
    const reopened = await createEventStore({ path: storePath, daemonEpoch: "epoch-1" });
    await expect(reopened.replay()).resolves.toHaveLength(1);
    await reopened.close();
  });

  it("bounds slow subscribers and closes them rather than buffering without limit", async () => {
    const store = await createEventStore({ path: await path(), daemonEpoch: "epoch-1", subscriberLimit: 1 });
    const subscriber = store.subscribe();
    await store.append(change);
    await store.append(change);
    await expect(subscriber.next()).rejects.toMatchObject({ code: "SUBSCRIBER_OVERFLOW" });
    await store.close();
  });
});
