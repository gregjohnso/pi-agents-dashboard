import { appendFile, chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { EventStoreError, createEventStore } from "./event-store.mjs";

/** @type {string[]} */
const directories = [];
/** @returns {Promise<string>} */
async function path() { const directory = await mkdtemp(join(tmpdir(), "events-")); directories.push(directory); return join(directory, "events.jsonl"); }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const change = { kind: "attachment_changed", payload: { sessionId: "session-1", clientId: "client-1", role: "observer", attached: true } };

describe("event store", () => {
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

  it("resolves pending iterators when the store closes", async () => {
    const store = await createEventStore({ path: await path(), daemonEpoch: "epoch-1" });
    const subscriber = store.subscribe();
    const pending = subscriber.next();
    await store.close();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });

  it("rejects symlinks and existing stores with unsafe modes", async () => {
    const storePath = await path();
    const target = `${storePath}.target`;
    await writeFile(target, "", { mode: 0o600 });
    await symlink(target, storePath);
    await expect(createEventStore({ path: storePath, daemonEpoch: "epoch-1" })).rejects.toBeDefined();

    const unsafePath = await path();
    await writeFile(unsafePath, "", { mode: 0o600 });
    await chmod(unsafePath, 0o644);
    await expect(createEventStore({ path: unsafePath, daemonEpoch: "epoch-1" })).rejects.toThrow(/0600/);
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
