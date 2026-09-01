import { describe, expect, it } from "vitest";

import { MAX_LIVE_TAIL_BYTES, createLiveTail } from "./worker-live-tail.mjs";

/** @param {number} index @param {number} [size] */
const delta = (index, size = 16) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `${index}`.padEnd(size, "x") } });
const dialog = (/** @type {string} */ id) => ({ type: "extension_ui_request", id, method: "confirm", title: "Continue?" });

describe("worker live tail", () => {
  it("keeps the newest frames in source order within its byte bound", () => {
    const tail = createLiveTail({ maxBytes: 400 });
    for (let index = 0; index < 40; index += 1) tail.record(delta(index));
    expect(tail.bytes).toBeLessThanOrEqual(400);
    expect(tail.dropped).toBeGreaterThan(0);
    const deltas = tail.frames().map((frame) => Number(frame.assistantMessageEvent.delta.replace(/x+$/u, "")));
    expect(deltas).toEqual([...deltas].sort((left, right) => left - right));
    expect(deltas.at(-1)).toBe(39);
    expect(deltas.length + tail.dropped).toBe(40);
  });

  it("forwards and forgets one frame larger than a whole retained frame is allowed to be", () => {
    const tail = createLiveTail({ maxFrameBytes: 200 });
    tail.record(delta(0));
    tail.record(delta(1, 4_096));
    expect(tail.frames()).toEqual([delta(0)]);
    expect(tail.dropped).toBe(1);
  });

  // Pi is blocked on a person until the dialog is answered, and a frontend attaching later can only
  // learn about it from this tail. Losing it would leave the operator with a session that looks idle
  // and answers nothing.
  it("holds an unresolved Pi dialog request while the frames around it are dropped", () => {
    const tail = createLiveTail({ maxBytes: 300 });
    tail.record(dialog("ui-1"));
    for (let index = 0; index < 40; index += 1) tail.record(delta(index));
    expect(tail.frames()[0]).toEqual(dialog("ui-1"));
    expect(tail.bytes).toBeLessThanOrEqual(300);

    // Once Pi resolves it there is nothing to answer, so it evicts like any other frame.
    tail.record({ type: "extension_ui_resolved", id: "ui-1" });
    for (let index = 40; index < 80; index += 1) tail.record(delta(index));
    expect(tail.frames().some((frame) => frame.type === "extension_ui_request")).toBe(false);
  });

  it("keeps the byte bound even when only unresolved dialogs are left", () => {
    const tail = createLiveTail({ maxBytes: 200 });
    for (let index = 0; index < 20; index += 1) tail.record(dialog(`ui-${index}`));
    expect(tail.bytes).toBeLessThanOrEqual(200);
    expect(tail.frames().length).toBeGreaterThan(0);
    expect(tail.frames().at(-1)).toEqual(dialog("ui-19"));
  });

  it("defaults to the retained-output budget Claude Code's host keeps and refuses an invalid bound", () => {
    const tail = createLiveTail();
    for (let index = 0; index < 5_000; index += 1) tail.record(delta(index, 256));
    expect(tail.bytes).toBeLessThanOrEqual(MAX_LIVE_TAIL_BYTES);
    expect(tail.bytes).toBeGreaterThan(MAX_LIVE_TAIL_BYTES - 1_024);
    for (const bound of [0, -1, 1.5, "256"]) expect(() => createLiveTail({ maxBytes: /** @type {any} */ (bound) })).toThrow(/maxBytes/u);
  });

  it("drops a frame it cannot serialize instead of throwing at the worker's frame handler", () => {
    const tail = createLiveTail();
    /** @type {any} */
    const cyclic = { type: "message_update" };
    cyclic.self = cyclic;
    tail.record(cyclic);
    expect(tail.frames()).toEqual([]);
    expect(tail.dropped).toBe(1);
  });
});
