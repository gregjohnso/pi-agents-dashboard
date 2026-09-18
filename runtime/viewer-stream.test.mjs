import { describe, expect, it } from "vitest";

import { pumpViewerSubscription } from "./daemon.mjs";
import { createViewerStream } from "./viewer-stream.mjs";

const draft = { eventId: "event-1", timestamp: "2026-08-25T00:00:00.000Z", payload: { kind: "user_message", itemId: "user-1", content: [{ type: "text", text: "hello" }] } };
const cursor = (/** @type {number} */ sequence) => ({ daemonEpoch: "epoch-1", sessionId: "session-1", sequence: String(sequence) });
const stream = (/** @type {number} */ subscriberLimit = 100) => createViewerStream({ sessionId: "session-1", daemonEpoch: "epoch-1", subscriberLimit });

describe("live per-session viewer stream", () => {
  it("numbers events within the daemon epoch and delivers only what a subscriber opened for", async () => {
    const live = stream();
    const before = live.append(draft);
    const subscriber = live.subscribe();
    const after = live.append({ ...draft, eventId: "event-2" });
    expect(before.cursor).toEqual(cursor(1));
    expect(live.currentCursor()).toEqual(cursor(2));
    // A subscription starts where it was opened. Nothing replays, because nothing is retained.
    await expect(subscriber.next()).resolves.toEqual({ value: after, done: false });
    await subscriber.return();
    live.close();
  });

  it("refuses an event the viewer contract does not admit rather than publishing it", () => {
    const live = stream();
    expect(() => live.append({ ...draft, payload: { kind: "user_message", itemId: "user-1" } })).toThrowError(expect.objectContaining({ code: "INVALID_VIEWER_EVENT" }));
    // The refused event still consumed its sequence, so no later event reuses that cursor.
    expect(live.currentCursor()).toEqual(cursor(1));
    live.close();
  });

  it("drops a subscriber that stops reading past its bound, with the code its reader receives", async () => {
    const live = stream(1);
    const subscriber = live.subscribe();
    live.append(draft);
    live.append({ ...draft, eventId: "event-2" });
    await expect(subscriber.next()).resolves.toMatchObject({ value: { eventId: "event-1" } });
    await expect(subscriber.next()).rejects.toMatchObject({ code: "SUBSCRIBER_OVERFLOW" });
    live.close();
  });

  it("ends every subscriber with the resynchronize code when the session is rebuilt", async () => {
    const live = stream();
    const reading = live.subscribe();
    const waiting = live.subscribe();
    live.append(draft);
    await expect(waiting.next()).resolves.toMatchObject({ value: { eventId: "event-1" } });
    const pending = waiting.next();
    live.resynchronize("VIEWER_RESYNCHRONIZED", "rebuilt from canonical history and the worker tail");
    // A subscriber holding events reads them first and learns why the stream stopped after them.
    await expect(reading.next()).resolves.toMatchObject({ value: { eventId: "event-1" } });
    await expect(reading.next()).rejects.toMatchObject({ code: "VIEWER_RESYNCHRONIZED" });
    // A reader already waiting learns the code where it waited, not a clean end it would report as
    // an empty stream.
    await expect(pending).rejects.toMatchObject({ code: "VIEWER_RESYNCHRONIZED" });
    live.close();
  });

  it("pumps one subscription in order and waits for each write before reading the next event", async () => {
    const live = stream(4);
    const subscription = live.subscribe();
    live.append(draft);
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
    live.append({ ...draft, eventId: "event-2" });
    expect(writes).toEqual(["event-1"]);
    releaseFirst();
    while (writes.length < 2) await Promise.resolve();
    expect(writes).toEqual(["event-1", "event-2"]);
    await subscription.return();
    await pumping;
    live.close();
  });

});
