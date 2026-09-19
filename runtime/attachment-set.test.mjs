import { expect, it } from "vitest";

import { AttachmentSetError, createAttachmentSet } from "./attachment-set.mjs";
import { nextAttachmentEpoch } from "../shared/native-contracts.mjs";

const CAP = 8;

/**
 * A sink that records exactly what it was handed, and reports the queue sizes the case scripts.
 *
 * Deterministic on purpose: the post-write queue size is the one fact backpressure turns on, so it is a
 * script rather than a real socket's timing. Every byte array reaches `writes` by reference, so a copy made
 * anywhere between `broadcast` and the sink would show up as a different object.
 *
 * @param {{ queuedAfterWrite?: number[], writeThrows?: unknown, queuedBytesThrows?: unknown, queuedBytesReturns?: unknown, onDrainThrows?: unknown, log?: string[], label?: string }} [script]
 */
function deterministicSink({ queuedAfterWrite = [0], writeThrows, queuedBytesThrows, queuedBytesReturns, onDrainThrows, log = [], label = "sink" } = {}) {
  /** @type {Uint8Array[]} */
  const writes = [];
  /** @type {(() => void)[]} */
  const drainListeners = [];
  let queuedBytesCalls = 0;
  const sink = {
    writes,
    drainListeners,
    /** @param {Uint8Array} bytes */
    write(bytes) {
      log.push(`${label}.write:${bytes.byteLength}`);
      if (writeThrows !== undefined) throw writeThrows;
      writes.push(bytes);
      return queuedAfterWrite[Math.min(writes.length, queuedAfterWrite.length) - 1] <= CAP;
    },
    queuedBytes() {
      queuedBytesCalls += 1;
      log.push(`${label}.queuedBytes`);
      if (queuedBytesThrows !== undefined) throw queuedBytesThrows;
      if (queuedBytesReturns !== undefined) return /** @type {number} */ (queuedBytesReturns);
      return writes.length === 0 ? 0 : queuedAfterWrite[Math.min(writes.length, queuedAfterWrite.length) - 1];
    },
    /** @param {() => void} listener */
    onDrain(listener) {
      if (onDrainThrows !== undefined) throw onDrainThrows;
      drainListeners.push(listener);
    },
    /** Every registered listener, as a real drain would call them. */
    drain() {
      for (const listener of drainListeners) listener();
    },
    queuedBytesCallCount() {
      return queuedBytesCalls;
    },
  };
  return sink;
}

/** @param {number} byteLength @param {number} fill */
function bytes(byteLength, fill) {
  return new Uint8Array(byteLength).fill(fill);
}

/** @param {{ attachmentId?: string, queuedAfterWrite?: number[] }} [options] */
function setWithOneAttachment({ attachmentId = "viewer-a", queuedAfterWrite = [0] } = {}) {
  const set = createAttachmentSet({ queuedByteCap: CAP });
  const sink = deterministicSink({ queuedAfterWrite });
  const epoch = set.add({ attachmentId, epoch: 1 }, sink);
  return { set, sink, epoch };
}

it("marks an attachment resync-required on the first broadcast that carries its queue past the cap", () => {
  const { set, sink } = setWithOneAttachment({ queuedAfterWrite: [CAP + 1] });
  const frame = bytes(4, 0x41);

  const result = set.broadcast(frame);

  expect(sink.writes).toEqual([frame]);
  expect(sink.writes[0]).toBe(frame);
  expect(result.markedResyncRequired).toEqual([{ attachmentId: "viewer-a", epoch: 1 }]);
  expect(set.attachments()[0].state).toBe("resync-required");
});

it("accepts a false write whose queue stays at the cap and keeps broadcasting to it", () => {
  const { set, sink } = setWithOneAttachment({ queuedAfterWrite: [CAP] });

  const first = set.broadcast(bytes(4, 0x41));
  const second = set.broadcast(bytes(4, 0x42));

  expect(sink.write(bytes(1, 0x43))).toBe(true);
  expect(first.markedResyncRequired).toEqual([]);
  expect(second.delivered).toEqual([{ attachmentId: "viewer-a", epoch: 1 }]);
  expect(set.attachments()[0].state).toBe("live");
});

it("keeps a slow attachment listed and input-eligible after it is marked resync-required", () => {
  const { set, epoch } = setWithOneAttachment({ queuedAfterWrite: [CAP + 1] });

  set.broadcast(bytes(4, 0x41));

  expect(set.attachments()).toEqual([
    { attachmentId: "viewer-a", epoch: 1, state: "resync-required", inputEligible: true, drains: 0, awaitingPresentationNonce: false },
  ]);
  expect(set.isInputEligible(epoch)).toBe(true);
});

it("writes no further byte to a resync-required attachment while its live peer keeps receiving", () => {
  const log = /** @type {string[]} */ ([]);
  const set = createAttachmentSet({ queuedByteCap: CAP });
  const slow = deterministicSink({ queuedAfterWrite: [CAP + 1], log, label: "slow" });
  const live = deterministicSink({ queuedAfterWrite: [1], log, label: "live" });
  set.add({ attachmentId: "slow", epoch: 1 }, slow);
  set.add({ attachmentId: "live", epoch: 1 }, live);

  set.broadcast(bytes(2, 0x41));
  const second = set.broadcast(bytes(3, 0x42));

  expect(slow.writes.map((written) => written.byteLength)).toEqual([2]);
  expect(live.writes.map((written) => written.byteLength)).toEqual([2, 3]);
  expect(log).toEqual(["slow.write:2", "slow.queuedBytes", "live.write:2", "live.queuedBytes", "live.write:3", "live.queuedBytes"]);
  expect(second.skipped).toEqual([{ attachmentId: "slow", epoch: 1 }]);
  expect(second.delivered).toEqual([{ attachmentId: "live", epoch: 1 }]);
});

it("leaves resync-required set when the sink only drains", () => {
  const { set, sink } = setWithOneAttachment({ queuedAfterWrite: [CAP + 1] });
  set.broadcast(bytes(4, 0x41));

  sink.drain();

  expect(set.attachments()[0].drains).toBe(1);
  expect(set.attachments()[0].state).toBe("resync-required");
  expect(sink.writes).toHaveLength(1);
});

it("clears resync-required only for the nonce the host recorded after the resync", () => {
  const { set, epoch } = setWithOneAttachment({ queuedAfterWrite: [CAP + 1] });
  set.broadcast(bytes(4, 0x41));
  expect(set.recordPresentationNonce(epoch, "nonce-repaint")).toBe(true);

  expect(set.acknowledgePresentation(epoch, "nonce-other")).toBe(false);
  expect(set.acknowledgePresentation(epoch, undefined)).toBe(false);
  expect(set.attachments()[0].state).toBe("resync-required");
  expect(set.acknowledgePresentation(epoch, "nonce-repaint")).toBe(true);
  expect(set.attachments()[0].state).toBe("live");
});

it("refuses a presentation recorded before the resync as proof of a current screen", () => {
  const { set, epoch } = setWithOneAttachment({ queuedAfterWrite: [CAP + 1] });
  set.recordPresentationNonce(epoch, "nonce-before");

  set.broadcast(bytes(4, 0x41));

  expect(set.acknowledgePresentation(epoch, "nonce-before")).toBe(false);
  expect(set.attachments()[0].state).toBe("resync-required");
  set.recordPresentationNonce(epoch, "nonce-after");
  expect(set.acknowledgePresentation(epoch, "nonce-after")).toBe(true);
});

it("refuses a consumed or superseded nonce as proof against a later resync", () => {
  const { set, sink, epoch } = setWithOneAttachment({ queuedAfterWrite: [CAP + 1] });
  set.broadcast(bytes(4, 0x41));
  set.recordPresentationNonce(epoch, "nonce-one");
  expect(set.acknowledgePresentation(epoch, "nonce-one")).toBe(true);
  set.recordPresentationNonce(epoch, "nonce-two");
  set.recordPresentationNonce(epoch, "nonce-three");

  set.broadcast(bytes(4, 0x42));

  expect(sink.writes).toHaveLength(2);
  expect(set.acknowledgePresentation(epoch, "nonce-one")).toBe(false);
  expect(set.acknowledgePresentation(epoch, "nonce-two")).toBe(false);
  expect(set.attachments()[0].state).toBe("resync-required");
});

it("refuses an equal or older epoch on add, and preserves the highest epoch across removals", () => {
  const set = createAttachmentSet({ queuedByteCap: CAP });
  set.add({ attachmentId: "viewer-a", epoch: 1 }, deterministicSink());
  set.add({ attachmentId: "viewer-a", epoch: 2 }, deterministicSink());
  expect(set.remove({ attachmentId: "viewer-a", epoch: 2 })).toBe(true);

  for (const stale of [1, 2]) {
    expect(() => set.add({ attachmentId: "viewer-a", epoch: stale }, deterministicSink())).toThrow(AttachmentSetError);
  }
  expect(set.highestIssuedEpoch("viewer-a")).toEqual({ attachmentId: "viewer-a", epoch: 2 });
  expect(set.attachments()).toEqual([]);
  const reconnect = nextAttachmentEpoch("viewer-a", set.highestIssuedEpoch("viewer-a"));
  expect(set.add(reconnect, deterministicSink())).toEqual({ attachmentId: "viewer-a", epoch: 3 });
});

it("ignores a stale remove, drain and acknowledgement from the connection a reconnect replaced", () => {
  const set = createAttachmentSet({ queuedByteCap: CAP });
  const first = deterministicSink({ queuedAfterWrite: [CAP + 1] });
  const stale = { attachmentId: "viewer-a", epoch: 1 };
  set.add(stale, first);
  set.recordPresentationNonce(stale, "nonce-first");
  const second = deterministicSink({ queuedAfterWrite: [CAP + 1] });
  const current = set.add({ attachmentId: "viewer-a", epoch: 2 }, second);
  set.broadcast(bytes(4, 0x41));
  set.recordPresentationNonce(current, "nonce-second");

  first.drain();

  expect(set.remove(stale)).toBe(false);
  expect(set.acknowledgePresentation(stale, "nonce-first")).toBe(false);
  expect(set.acknowledgePresentation(stale, "nonce-second")).toBe(false);
  expect(set.recordPresentationNonce(stale, "nonce-stale")).toBe(false);
  expect(set.isInputEligible(stale)).toBe(false);
  expect(set.attachments()).toEqual([
    { attachmentId: "viewer-a", epoch: 2, state: "resync-required", inputEligible: true, drains: 0, awaitingPresentationNonce: true },
  ]);
  expect(first.writes).toHaveLength(0);
  expect(set.acknowledgePresentation(current, "nonce-second")).toBe(true);
});

it("replays nothing to a reconnect and hands it only the bytes broadcast afterwards", () => {
  const { set, sink } = setWithOneAttachment();
  const before = bytes(4, 0x41);
  set.broadcast(before);

  const reconnected = deterministicSink();
  set.add({ attachmentId: "viewer-a", epoch: 2 }, reconnected);
  expect(reconnected.writes).toEqual([]);
  const after = bytes(3, 0x42);
  set.broadcast(after);

  expect(reconnected.writes).toEqual([after]);
  expect(reconnected.writes[0]).toBe(after);
  expect(sink.writes).toEqual([before]);
});

it("exposes no operation that could resend an accepted byte, and retains no byte container", () => {
  const { set, sink } = setWithOneAttachment();
  const frame = bytes(4, 0x41);

  set.broadcast(frame);
  frame.fill(0x5a);

  expect(Object.keys(set).sort()).toEqual([
    "acknowledgePresentation",
    "add",
    "attachments",
    "broadcast",
    "highestIssuedEpoch",
    "isInputEligible",
    "recordPresentationNonce",
    "remove",
  ]);
  // The one byte array that exists is the caller's, still held by the caller's sink and mutated in place.
  expect(sink.writes[0]).toBe(frame);
  expect(sink.writes[0][0]).toBe(0x5a);
  expect(JSON.stringify(set.attachments())).toBe(
    JSON.stringify([{ attachmentId: "viewer-a", epoch: 1, state: "live", inputEligible: true, drains: 0, awaitingPresentationNonce: false }]),
  );
});

it("marks a sink whose write throws resync-required, keeps it a member and reports the failure", () => {
  const set = createAttachmentSet({ queuedByteCap: CAP });
  const failure = new Error("socket closed");
  const sink = deterministicSink({ writeThrows: failure });
  const epoch = set.add({ attachmentId: "viewer-a", epoch: 1 }, sink);

  const result = set.broadcast(bytes(4, 0x41));

  expect(result.delivered).toEqual([]);
  expect(result.failures).toEqual([{ attachment: { attachmentId: "viewer-a", epoch: 1 }, reason: "write", error: failure }]);
  expect(sink.queuedBytesCallCount()).toBe(0);
  expect(set.isInputEligible(epoch)).toBe(true);
  expect(set.attachments()[0].state).toBe("resync-required");
  expect(set.acknowledgePresentation(epoch, "nonce-anything")).toBe(false);
});

it("marks a sink whose queue size is unusable rather than treating it as under the cap", () => {
  const set = createAttachmentSet({ queuedByteCap: CAP });
  const thrown = new Error("no queue");
  set.add({ attachmentId: "throwing", epoch: 1 }, deterministicSink({ queuedBytesThrows: thrown }));
  set.add({ attachmentId: "negative", epoch: 1 }, deterministicSink({ queuedBytesReturns: -1 }));
  set.add({ attachmentId: "fractional", epoch: 1 }, deterministicSink({ queuedBytesReturns: 1.5 }));

  const result = set.broadcast(bytes(4, 0x41));

  expect(result.delivered).toEqual([]);
  expect(result.markedResyncRequired.map((marked) => marked.attachmentId)).toEqual(["throwing", "negative", "fractional"]);
  expect(result.failures.map((entry) => entry.reason)).toEqual(["queue", "queue", "queue"]);
  expect(result.failures[0].error).toBe(thrown);
  expect(set.attachments().map((attachment) => attachment.state)).toEqual(["resync-required", "resync-required", "resync-required"]);
});

it("holds a copy of the epoch record, so mutating the caller's record moves no authority", () => {
  const set = createAttachmentSet({ queuedByteCap: CAP });
  const caller = { attachmentId: "viewer-a", epoch: 2 };

  const held = set.add(caller, deterministicSink());
  caller.epoch = 99;

  expect(held).toEqual({ attachmentId: "viewer-a", epoch: 2 });
  expect(set.attachments()[0].epoch).toBe(2);
  expect(set.isInputEligible(caller)).toBe(false);
  expect(set.remove({ attachmentId: "viewer-a", epoch: 2 })).toBe(true);
});

it("refuses an unusable cap, an unusable sink and an unusable broadcast without changing membership", () => {
  for (const cap of [0, -1, 1.5, "8"]) {
    expect(() => createAttachmentSet({ queuedByteCap: /** @type {number} */ (cap) })).toThrow(AttachmentSetError);
  }
  const set = createAttachmentSet({ queuedByteCap: CAP });
  const sink = deterministicSink();

  const sinkWithoutDrain = /** @type {import("./attachment-set.mjs").AttachmentSink} */ (/** @type {unknown} */ ({ write: sink.write, queuedBytes: sink.queuedBytes }));
  expect(() => set.add({ attachmentId: "viewer-a", epoch: 1 }, sinkWithoutDrain)).toThrow(AttachmentSetError);
  expect(() => set.add({ attachmentId: "viewer-a", epoch: 1 }, deterministicSink({ onDrainThrows: new Error("closed") }))).toThrow(AttachmentSetError);
  expect(set.attachments()).toEqual([]);
  expect(set.highestIssuedEpoch("viewer-a")).toBe(null);

  set.add({ attachmentId: "viewer-a", epoch: 1 }, sink);
  expect(() => set.broadcast(/** @type {Uint8Array} */ (/** @type {unknown} */ ("not bytes")))).toThrow(AttachmentSetError);
  expect(sink.writes).toEqual([]);
  expect(() => set.recordPresentationNonce({ attachmentId: "viewer-a", epoch: 1 }, /** @type {string} */ (/** @type {unknown} */ (undefined)))).toThrow(AttachmentSetError);
  expect(() => set.add({ attachmentId: "viewer-a", epoch: 0 }, deterministicSink())).toThrow(TypeError);
});
