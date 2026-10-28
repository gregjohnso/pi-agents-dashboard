/**
 * Focused cases for the demo's own seams: its frame bounds, its authentication, its cohort selection and its
 * fake provider's determinism. None of them launches Pi.
 *
 * The user flow itself is `smoke.mjs`, which needs a real pseudo-terminal, a real bundled CLI and about ten
 * seconds. It runs here only when `PI_NATIVE_DEMO_SMOKE` selects it, so the routine suite stays short.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "../../runtime/process-signaler.mjs";

import { DEFAULT_COHORT, DEFAULT_MANIFEST, resolveCohort } from "./cohort.mjs";
import { widthGuidance } from "./demo.mjs";
import { FRONTEND_MODE_RESTORE, createAttachmentTeardown } from "./client.mjs";
import { createRoot, demoPaths, readToken, tokenMatches, writeOwnerRecord } from "./demo-root.mjs";import { FAKE_REPLY_PREFIX, createFakeStreamSimple, deterministicReply } from "./fake-provider.mjs";
import { createBridgeConsumer } from "./manager.mjs";
import { createPausingRelay } from "./pausing-relay.mjs";
import { createPendingInputQueue } from "./pending-input.mjs";
import { MAX_FRAME_BYTES, createFrameReader, encodeFrame } from "./protocol.mjs";
import { describeOwnerExit, runSmoke, stripSequences, verifyOwnerAbsence } from "./smoke.mjs";

/** @type {string[]} */
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "native-session-demo-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** What another program's directory looks like when it takes the place of a root this demo created. */
const REPLACEMENT_SENTINELS = {
  "owner.json": '{"whose":"not this demo\'s"}\n',
  "manager.log": "another program's log line\n",
  s: "not a socket, and not this demo's\n",
  b: "not a sideband, and not this demo's\n",
  "notes.txt": "the operator's own notes\n",
};

/**
 * Put an unowned directory where a root used to be, optionally carrying a *copy* of this demo's ownership
 * marker: a copied marker is not directory identity, and a demo that reads one as authority is reading a file
 * it does not own.
 *
 * @param {string} at @param {{ ownershipFrom?: string }} options
 */
async function plantReplacement(at, { ownershipFrom } = {}) {
  await mkdir(at, { mode: 0o755 });
  for (const [name, content] of Object.entries(REPLACEMENT_SENTINELS)) {
    await writeFile(path.join(at, name), content, { mode: 0o644 });
  }
  if (ownershipFrom !== undefined) await cp(path.join(ownershipFrom, "ownership.json"), path.join(at, "ownership.json"));
  await chmod(at, 0o755);
  return snapshotDirectory(at);
}

/** Every name, every byte and the mode: what must be identical after a stop that touched the real root. */
async function snapshotDirectory(at) {
  const entries = (await readdir(at)).sort();
  const contents = {};
  for (const name of entries) contents[name] = await readFile(path.join(at, name), "utf8");
  return { mode: (await stat(at)).mode & 0o777, entries, contents };
}

/**
 * Read one stream as the write order it received, without ending it.
 *
 * A disposed relay must be able to write nothing more, and a stream that had been ended would report a later
 * write as an error rather than as the silence these cases are asserting.
 */
function collectWrites(stream) {
  const chunks = [];
  const waiters = [];
  const receivedBytes = () => chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  stream.on("data", (chunk) => {
    chunks.push(chunk);
    for (const waiter of [...waiters]) {
      if (receivedBytes() < waiter.bytes) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  return {
    /** Everything written once at least `bytes` have arrived, plus one loop turn for anything that should not. */
    async settle(bytes) {
      if (receivedBytes() < bytes) await new Promise((resolve) => waiters.push({ bytes, resolve }));
      await new Promise((resolve) => setImmediate(resolve));
      return Buffer.concat(chunks);
    },
  };
}

/** Collect what one reader made of a byte stream, frames and refusal alike. */
function read(chunks) {
  const frames = [];
  const refusals = [];
  const reader = createFrameReader((frame) => frames.push(frame), (error) => refusals.push(error));
  for (const chunk of chunks) reader.push(chunk);
  return { frames, refusals };
}

describe("the demo's frame codec", () => {
  it("round-trips a header and a binary body across arbitrary chunk boundaries", () => {
    const body = Buffer.from([0x1b, 0x5b, 0x41, 0x00, 0xff, 0x0d]);
    const frame = encodeFrame({ type: "input", attachmentId: "client-1", epoch: 2 }, body);
    const { frames, refusals } = read([...frame].map((byte) => Buffer.from([byte])));
    expect(refusals).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0].header).toMatchObject({ protocol: 1, type: "input", attachmentId: "client-1", epoch: 2 });
    expect([...frames[0].body]).toEqual([...body]);
  });

  it("delivers two frames sent in one write, in order", () => {
    const first = encodeFrame({ type: "output" }, Buffer.from("a"));
    const second = encodeFrame({ type: "output" }, Buffer.from("b"));
    const { frames } = read([Buffer.concat([first, second])]);
    expect(frames.map((frame) => frame.body.toString("utf8"))).toEqual(["a", "b"]);
  });

  it("refuses a declared length above the frame bound before reading its body", () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const { frames, refusals } = read([oversized]);
    expect(frames).toEqual([]);
    expect(refusals[0].code).toBe("DEMO_FRAME_TOO_LARGE");
  });

  it("refuses a header that is not JSON, and one that carries another protocol", () => {
    const notJson = Buffer.concat([Buffer.alloc(6), Buffer.from("{oops")]);
    notJson.writeUInt32BE(7, 0);
    notJson.writeUInt16BE(5, 4);
    expect(read([notJson]).refusals[0].code).toBe("DEMO_HEADER_UNPARSEABLE");

    const headerBytes = Buffer.from(JSON.stringify({ protocol: 2, type: "hello" }), "utf8");
    const wrongProtocol = Buffer.allocUnsafe(6 + headerBytes.byteLength);
    wrongProtocol.writeUInt32BE(2 + headerBytes.byteLength, 0);
    wrongProtocol.writeUInt16BE(headerBytes.byteLength, 4);
    headerBytes.copy(wrongProtocol, 6);
    expect(read([wrongProtocol]).refusals[0].code).toBe("DEMO_PROTOCOL_MISMATCH");
  });

  it("refuses a body above the bound at encode time rather than emitting it", () => {
    expect(() => encodeFrame({ type: "output" }, Buffer.alloc(MAX_FRAME_BYTES))).toThrowError(/above the/u);
  });
});

describe("the demo's connection token", () => {
  it("accepts only the exact token, and never a prefix or another type", () => {
    const token = "a".repeat(64);
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token.slice(0, 63), token)).toBe(false);
    expect(tokenMatches(`${token}b`, token)).toBe(false);
    expect(tokenMatches(`${"a".repeat(63)}b`, token)).toBe(false);
    expect(tokenMatches(undefined, token)).toBe(false);
    expect(tokenMatches(1, token)).toBe(false);
  });
});

describe("the owner bridge consumer", () => {
  /**
   * One fake owner generation: the connection shape `listenForOwnerSideband` hands out, and nothing more.
   *
   * The behaviour under test is entirely this manager's own bookkeeping, so there is no socket, no Pi and no
   * cohort here. Every frame is delivered synchronously by the case itself, which is what makes the
   * supersession and flood assertions deterministic rather than timing-dependent.
   */
  function fakeOwnerConnection() {
    /** @type {((frame: any) => void)[]} */
    const listeners = [];
    /** @type {(outcome: any) => void} */
    let settle = () => {};
    const closed = new Promise((resolve) => {
      settle = resolve;
    });
    /** @type {any[]} */
    const sent = [];
    let closes = 0;
    return {
      connection: {
        closed,
        /** @param {(frame: any) => void} listener */
        onFrame(listener) {
          listeners.push(listener);
          return () => {};
        },
        /** @param {string} requestId */
        requestStop: async (requestId) => {
          sent.push({ request: "stop", requestId });
        },
        /** @param {string} requestId */
        requestAbort: async (requestId) => {
          sent.push({ request: "abort", requestId });
        },
        close() {
          closes += 1;
        },
      },
      /** @param {any} frame */
      emit(frame) {
        for (const listener of [...listeners]) listener(frame);
      },
      /** @param {any} outcome */
      endWith(outcome) {
        settle(outcome);
        return closed;
      },
      sent,
      closes: () => closes,
    };
  }

  function consumerFor() {
    /** @type {string[]} */
    const lines = [];
    return { consumer: createBridgeConsumer({ log: (line) => lines.push(line) }), lines };
  }

  const READY = { type: "owner-ready", phase: "bridge" };
  /** @param {Record<string, unknown>} facts */
  const FACTS = (facts) => ({ type: "owner-facts", facts });

  // Operator-visible failure: an authenticated peer - which, as the manager itself discloses, includes any Pi
  // descendant that inherited the token - can send valid frames forever, and retaining each one grew this
  // process's memory, its log, every status response and the final owner record without bound.
  //
  // The protection is a bound on what is RETAINED, not a lifetime quota on how many times a producer may speak.
  // `owner-facts` is a replaced snapshot, so a live session legitimately republishes it on every phase of every
  // turn; a lifetime quota therefore killed the bridge of exactly the long session it was meant to protect.
  // Readiness and the seam table are still announced once each, because a second of either is outside the
  // contract rather than an update.
  it("absorbs a flood of replaced snapshots without growing its record, its log or its status", () => {
    const { consumer, lines } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);

    owner.emit(READY);
    for (let index = 0; index < 5_000; index += 1) owner.emit(FACTS({ index }));

    const status = consumer.status();
    // What the flood left behind is bounded: no frame history, a bounded diagnostic ring, a bounded log.
    expect(JSON.stringify(status).length).toBeLessThan(20_000);
    expect(status.diagnostics.length).toBeLessThanOrEqual(64);
    expect(lines.length).toBeLessThan(20);
    // The generation is still the operator's session, and the latest snapshot is the one on screen.
    expect(status.connected).toBe(true);
    expect(status.refusal).toBeNull();
    expect(status.facts).toEqual({ index: 4_999 });
    expect(owner.closes()).toBe(0);
  });

  // A second readiness announcement is still outside the contract, and still costs the generation.
  it("still refuses a second readiness announcement", () => {
    const { consumer } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);

    owner.emit(READY);
    owner.emit(READY);

    expect(String(consumer.status().refusal)).toMatch(/owner-ready frames and this owner generation may send 1/u);
    expect(owner.closes()).toBe(1);
  });

  // The exact cut-off the correction removes: report 513 used to refuse and close the bridge, so a persistent
  // session lost its status updates as a matter of course rather than through any misbehaviour.
  it("keeps one generation connected across more than 512 legitimate replacements", () => {
    const { consumer, lines } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);

    owner.emit(READY);
    for (let index = 0; index < 600; index += 1) {
      owner.emit(FACTS({ agentPhase: index % 2 === 0 ? "start" : "settled", turn: index }));
    }

    const status = consumer.status();
    expect(status.connected).toBe(true);
    expect(status.refusal).toBeNull();
    expect(status.generation).toBe(1);
    expect(owner.closes()).toBe(0);
    // The latest snapshot is visible, and only the latest is retained.
    expect(status.facts).toEqual({ agentPhase: "settled", turn: 599 });
    expect(JSON.stringify(status).length).toBeLessThan(20_000);
    expect(lines.length).toBeLessThan(20);
  });

  it("refuses a receipt for a request this manager never sent", () => {
    const { consumer } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);

    owner.emit({ type: "owner-receipt", requestId: "never-asked", request: "stop", outcome: "requested" });

    expect(String(consumer.status().refusal)).toMatch(/answered request never-asked, which this manager did not send/u);
    expect(owner.closes()).toBe(1);
  });

  // A receipt is authorised by the request it answers, which is what keeps legitimate continuing work
  // uncapped: each new request admits exactly one more receipt, and a repeat answer is unsolicited.
  it("keeps a receipt for a request it did send, and refuses a second answer to it", async () => {
    const { consumer } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);

    const record = await consumer.request("stop", "request-1");
    expect(record).toMatchObject({ request: "stop", requestId: "request-1", sent: true, generation: 1 });
    expect(owner.sent).toEqual([{ request: "stop", requestId: "request-1" }]);
    owner.emit({ type: "owner-receipt", requestId: "request-1", request: "stop", outcome: "requested" });
    expect(consumer.status().receipts).toEqual([
      { type: "owner-receipt", requestId: "request-1", request: "stop", outcome: "requested" },
    ]);

    owner.emit({ type: "owner-receipt", requestId: "request-1", request: "stop", outcome: "requested" });
    expect(String(consumer.status().refusal)).toMatch(/answered request request-1, which this manager did not send/u);
  });

  // Operator-visible failure: a reload is a new generation, and the previous connection has to end rather than
  // stay subscribed. Deriving current facts from every generation meant a value the new one correctly omits as
  // unknown survived from the older snapshot, and the single readiness phase each generation announces
  // accumulated into ["bridge", "bridge"] - both of which contradict what this channel says it reports.
  it("supersedes the previous generation, and reports only the current one's readiness and facts", () => {
    const { consumer } = consumerFor();
    const first = fakeOwnerConnection();
    consumer.adopt(first.connection);
    first.emit(READY);
    first.emit(FACTS({ mode: "tui", thinkingLevel: "off", sessionId: "session-one" }));
    expect(consumer.status()).toMatchObject({ generation: 1, readyPhases: ["bridge"] });

    // The session reloads. This generation could not read a thinking level, and says so by omitting it.
    const second = fakeOwnerConnection();
    consumer.adopt(second.connection);
    expect(first.closes()).toBe(1);
    second.emit(READY);
    second.emit(FACTS({ mode: "tui", sessionId: "session-two" }));

    const status = consumer.status();
    expect(status.generation).toBe(2);
    expect(status.generations).toBe(2);
    // Exactly one phase, not one per generation.
    expect(status.readyPhases).toEqual(["bridge"]);
    // The omitted fact is gone, and the one that changed is this generation's.
    expect(status.facts).toEqual({ mode: "tui", sessionId: "session-two" });
    expect(status.connected).toBe(true);
  });

  it("lets no late event from a superseded generation reach the current one", async () => {
    const { consumer } = consumerFor();
    const first = fakeOwnerConnection();
    consumer.adopt(first.connection);
    first.emit(READY);
    const stale = await consumer.request("stop", "request-stale");
    expect(stale.generation).toBe(1);

    const second = fakeOwnerConnection();
    consumer.adopt(second.connection);
    second.emit(READY);
    second.emit(FACTS({ sessionId: "session-two" }));

    // Everything the superseded generation still does: more frames, its own receipt, and its close settling.
    first.emit(FACTS({ sessionId: "session-one" }));
    first.emit({ type: "owner-receipt", requestId: "request-stale", request: "stop", outcome: "requested" });
    for (let index = 0; index < 100; index += 1) first.emit(FACTS({ index }));
    await first.endWith({ refusal: undefined });

    const status = consumer.status();
    expect(status.generation).toBe(2);
    expect(status.readyPhases).toEqual(["bridge"]);
    expect(status.facts).toEqual({ sessionId: "session-two" });
    // The old generation's receipt did not become the current one's, and its flood did not refuse generation 2.
    expect(status.receipts).toEqual([]);
    expect(status.requests).toEqual([]);
    expect(status.refusal).toBe(null);
    expect(status.connected).toBe(true);
  });

  it("reports no owner once the current generation closes, and sends nothing to it", async () => {
    const { consumer } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);
    owner.emit(READY);
    await owner.endWith({ refusal: undefined });

    expect(consumer.status().connected).toBe(false);
    expect(consumer.activeGeneration()).toBe(undefined);
    const record = await consumer.request("stop", "request-after-close");
    expect(record).toMatchObject({ sent: false, requestId: null });
    expect(`${record.reason}`).toMatch(/no owner generation is currently connected/u);
    expect(owner.sent).toEqual([]);
  });

  // Operator-visible failure: authorizing work is not a retention bound. Every authorized request and every
  // receipt answering one used to be kept for the generation's whole life and serialized into every status
  // response and the final owner record, so a peer doing nothing but legitimate work regrew exactly the memory,
  // status and log problem the flood case was supposed to have closed. The flood case only repeated
  // `owner-facts` and the receipt case sent one request, so neither could see this.
  it("bounds what it retains across many authorized requests, without refusing any of them", async () => {
    const { consumer, lines } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);

    // Sequential, so nothing is ever in flight twice: each answer frees the slot before the next request.
    for (let index = 0; index < 500; index += 1) {
      const id = `request-${index}-${"i".repeat(200)}`;
      const record = await consumer.request("stop", id);
      expect(record).toMatchObject({ admitted: true, sent: true });
      owner.emit({ type: "owner-receipt", requestId: id, request: "stop", outcome: "requested", note: "n".repeat(400) });
    }

    const status = consumer.status();
    // Every one of the 500 was authorized, sent and answered: nothing was refused and nothing was invented.
    expect(status.totals).toMatchObject({ requested: 500, sent: 500, receipted: 500, refused: 0, capacityRefusals: 0 });
    expect(status.refusal).toBe(null);
    expect(status.connected).toBe(true);
    // What is retained is bounded by entries and by bytes, and what was dropped is counted rather than hidden.
    // The field names are unchanged - they cross a process boundary - and what changed is that their contents
    // are a bounded window with an explicit count of what was dropped.
    expect(status.requests.length).toBeLessThanOrEqual(16);
    expect(status.receipts.length).toBeLessThanOrEqual(16);
    expect(status.totals.droppedRequests).toBeGreaterThan(400);
    expect(status.totals.droppedReceipts).toBeGreaterThan(400);
    // The status response and the final owner record are the same shape, so one bound covers both.
    expect(JSON.stringify(status).length).toBeLessThan(40_000);
    // The bridge's own log emission is bounded for the life of this consumer, by entries and by UTF-8 bytes,
    // and by each line's size. This is non-authoritative diagnostics, not Pi's transcript: 500 legitimate
    // requests were all admitted, sent and answered above, and what is bounded is only what this consumer
    // writes about them. Per-line truncation alone is not a bound on retention.
    expect(lines.length).toBeLessThanOrEqual(status.counts.logBudgetEntries);
    expect(Buffer.byteLength(lines.join("\n"), "utf8")).toBeLessThanOrEqual(status.counts.logBudgetBytes);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(200);
    // What was not written is counted rather than hidden, and the two counters account for every attempt.
    expect(status.counts.logEmitted).toBe(lines.length);
    expect(status.counts.logDropped).toBeGreaterThan(400);
    // Exactly one suppression notice, counted as one of the emitted entries, so neither the notice nor the
    // reserve it needs can be what overruns the budget.
    expect(lines.filter((line) => line.includes("lifetime log budget"))).toHaveLength(1);
    expect(lines[lines.length - 1]).toMatch(/lifetime log budget/u);
  });

  // Operator-visible failure: a budget reset per generation is not a lifetime bound. A peer that reconnects,
  // is superseded, gets refused and fills its in-flight window over and over drives the reconnect, capacity and
  // refusal log paths rather than the request path, so bounding only the request line leaves the on-disk log
  // growing with churn. Every bridge-consumer log path shares one lifetime budget.
  it("keeps its lifetime log budget across reconnect, capacity and refusal churn", async () => {
    const { consumer, lines } = consumerFor();

    for (let generation = 0; generation < 40; generation += 1) {
      const owner = fakeOwnerConnection();
      consumer.adopt(owner.connection);
      // Fill the in-flight window and then keep asking, so the capacity-refusal path runs repeatedly.
      for (let index = 0; index < 12; index += 1) await consumer.request("stop", `churn-${generation}-${index}`);
      // A second readiness phase is outside the producer's contract, so this generation is refused and closed.
      owner.emit(READY);
      owner.emit(READY);
    }

    const status = consumer.status();
    expect(status.generations).toBe(40);
    expect(lines.length).toBeLessThanOrEqual(status.counts.logBudgetEntries);
    expect(Buffer.byteLength(lines.join("\n"), "utf8")).toBeLessThanOrEqual(status.counts.logBudgetBytes);
    expect(status.counts.logEmitted).toBe(lines.length);
    // Far more was attempted than written, across the reconnect, capacity and refusal paths alike.
    expect(status.counts.logDropped).toBeGreaterThan(100);
    expect(lines.filter((line) => line.includes("lifetime log budget"))).toHaveLength(1);
  });

  // An entry count alone is not a bound. A request id or an error string may be near the wire's own frame
  // limit, so a ring of sixteen of them would still be a megabyte in every status response.
  it("bounds retention by bytes as well as entries when ids are near the wire limit", async () => {
    const { consumer } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);

    for (let index = 0; index < 16; index += 1) {
      const id = `huge-${index}-${"x".repeat(60_000)}`;
      await consumer.request("stop", id);
      owner.emit({ type: "owner-receipt", requestId: id, request: "stop", outcome: "requested" });
    }

    const status = consumer.status();
    expect(status.totals).toMatchObject({ requested: 16, sent: 16, receipted: 16 });
    // Sixteen entries would have fitted the count bound; the byte bound is what keeps this small.
    expect(JSON.stringify(status).length).toBeLessThan(40_000);
    for (const entry of [...status.requests, ...status.receipts]) {
      expect(`${entry.requestId}`.length).toBeLessThanOrEqual(256);
    }
  });

  // A peer that never answers must not be able to grow the in-flight bookkeeping without limit. The answer is
  // a named capacity result: still-authorized requests are not evicted, no receipt is fabricated, the owner's
  // connection is not refused, and work resumes as soon as one answer arrives.
  it("refuses admission by named capacity when the peer stops answering, and resumes when it answers", async () => {
    const { consumer } = consumerFor();
    const owner = fakeOwnerConnection();
    consumer.adopt(owner.connection);

    /** @type {any[]} */
    const admitted = [];
    for (let index = 0; index < 8; index += 1) {
      admitted.push(await consumer.request("stop", `unanswered-${index}`));
    }
    expect(admitted.every((record) => record.admitted === true && record.sent === true)).toBe(true);

    const full = await consumer.request("stop", "one-too-many");
    expect(full).toMatchObject({ admitted: false, sent: false, requestId: null, inFlight: 8 });
    expect(`${full.reason}`).toMatch(/in-flight capacity/u);
    // The generation is refused nothing: it is still connected, still unrefused, and its work still pending.
    expect(consumer.status()).toMatchObject({ connected: true, refusal: null, inFlightRequests: 8, inFlightCapacity: 8 });
    expect(consumer.status().totals).toMatchObject({ requested: 9, sent: 8, capacityRefusals: 1 });
    // Nothing was sent for the refused one, so nothing is owed for it.
    expect(owner.sent.length).toBe(8);

    // One answer frees one slot, and the next request goes through.
    owner.emit({ type: "owner-receipt", requestId: "unanswered-0", request: "stop", outcome: "requested" });
    const afterwards = await consumer.request("stop", "now-there-is-room");
    expect(afterwards).toMatchObject({ admitted: true, sent: true });
    expect(consumer.status().inFlightRequests).toBe(8);
  });

  // Retired bookkeeping goes with its generation: a superseded owner's in-flight work is not the new one's.
  it("clears retired request bookkeeping when a generation is superseded", async () => {
    const { consumer } = consumerFor();
    const first = fakeOwnerConnection();
    consumer.adopt(first.connection);
    for (let index = 0; index < 4; index += 1) await consumer.request("stop", `old-${index}`);
    expect(consumer.status().inFlightRequests).toBe(4);

    const second = fakeOwnerConnection();
    consumer.adopt(second.connection);

    const status = consumer.status();
    expect(status.generation).toBe(2);
    expect(status.inFlightRequests).toBe(0);
    expect(status.requests).toEqual([]);
    expect(status.totals).toMatchObject({ requested: 0, sent: 0, receipted: 0 });
    // A late receipt for the old generation's work changes nothing here.
    first.emit({ type: "owner-receipt", requestId: "old-0", request: "stop", outcome: "requested" });
    expect(consumer.status()).toMatchObject({ generation: 2, inFlightRequests: 0, refusal: null });
  });

  it("bounds its diagnostic ring across reconnect churn, and says how many entries it dropped", () => {
    const { consumer } = consumerFor();
    for (let index = 0; index < 200; index += 1) consumer.adopt(fakeOwnerConnection().connection);

    const status = consumer.status();
    expect(status.generations).toBe(200);
    expect(status.diagnostics.length).toBe(64);
    expect(status.counts.droppedEvents).toBeGreaterThan(0);
    expect(status.counts.supersededGenerations).toBe(199);
  });
});

// The owner's geometry is fixed once at launch and shared by every attachment, so the width chosen at `start` is
// the width all typing is laid out at. Two owner widths were captured on a text screen: at 100 an 82-character
// draft occupied one row, at 60 the same draft wrapped after 59 columns with the last cell of the pre-wrap row
// left blank. That blank cell is a line-break pad in the rendered row, which is a display observation: submitted
// text was confirmed byte-exact at 100 from the provider's own prompt digest, and is untested at 60 because no
// post-submit stream was retained. A reader of a long line sees the spacing, and 60 is the only narrow width
// measured. `start` therefore says
// so instead of launching a below-default width silently. It is guidance, not a fix, not a refusal, not a resize.
describe("the owner width guidance at start", () => {
  it("says nothing for the tested default or anything wider", () => {
    expect(widthGuidance(100)).toBe(null);
    expect(widthGuidance(120)).toBe(null);
    // Absent or unusable input is the manager's default, so there is nothing to warn about.
    expect(widthGuidance(undefined)).toBe(null);
    expect(widthGuidance(Number.NaN)).toBe(null);
  });

  it("warns for a below-default width, naming the measurement and refusing to call 100 a threshold", () => {
    const guidance = widthGuidance(60);
    expect(guidance).not.toBe(null);
    expect(guidance).toContain("--cols 60");
    expect(guidance).toContain("tested default of 100");
    // The mechanism the operator needs: one launch-fixed geometry shared by every attachment.
    expect(guidance).toMatch(/fixed at launch and shared by every attachment/u);
    // The measurement, stated as what it is.
    expect(guidance).toMatch(/wrapping after 59 columns/u);
    expect(guidance).toMatch(/a line-break pad in the rendered row/u);
    // It must separate display from input: the pad is what was seen, and integrity at that width is untested.
    expect(guidance).toMatch(/display observation only/u);
    expect(guidance).toMatch(/whether typed text is submitted unchanged at this width has not been checked here/u);
    // And the limits: a reference point, not a threshold, and no minimum claimed.
    expect(guidance).toMatch(/not a proven threshold/u);
    expect(guidance).toMatch(/no safe minimum has been measured/u);
    // It warns and continues. It must not promise a fix or announce a refusal or a resize.
    expect(guidance).toContain("Starting anyway.");
    expect(guidance).not.toMatch(/refus|reject|clamp|resiz|corrupt|fixed the|now correct/iu);
  });

  it("warns just below the default and not at it, without inventing a minimum in between", () => {
    expect(widthGuidance(99)).not.toBe(null);
    expect(widthGuidance(80)).not.toBe(null);
    expect(widthGuidance(100)).toBe(null);
    // No 80-column safe minimum is asserted anywhere: 80 is warned about exactly like 60.
    expect(widthGuidance(80)).toBe(widthGuidance(60).replace("--cols 60", "--cols 80"));
  });
});

// The attach note used to frame the CLIENT's size as the concern. The geometry cases showed the owner renders once
// at its launch size and every attachment receives those same bytes, so the note now states that mechanism and
// stops there: it does not claim a narrower client is harmless, because the cursor question is unresolved and only
// one ASCII sample was measured.
describe("the attach note about geometry", () => {
  const clientSource = readFile(fileURLToPath(new URL("./client.mjs", import.meta.url)), "utf8");

  /**
   * Updated for the adaptive-sizing increment, which replaced the launch-fixed wording. The gate's point is
   * unchanged: the note must state the single shared terminal, and it must say plainly when this owner did not
   * take this terminal's size rather than leaving the operator to guess.
   */
  it("states the single shared terminal and names an owner that did not adopt this size", async () => {
    const source = await clientSource;
    expect(source).toMatch(/There is one Pi terminal for the/u);
    expect(source).toMatch(/this owner did not adopt this size/u);
    expect(source).toMatch(/an owner started before resize support cannot/u);
    // And it says what happens to that owner: nothing.
    expect(source).toMatch(/left running as it is rather than replaced/u);
  });

  it("claims nothing about how a differently sized terminal looks", async () => {
    const source = await clientSource;
    // The specific overclaim to stay out of: that a narrower client is fine.
    expect(source).not.toMatch(/harmless|safe to attach|renders correctly at any size/iu);
  });
});

describe("cohort selection", () => {
  it("refuses a manifest whose consumer root is not installed", async () => {
    const directory = await temporaryDirectory();
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ consumerRoot: path.join(directory, "absent-consumer") }));
    expect(() => resolveCohort({ manifestPath })).toThrowError(/The selected cohort is incomplete/u);
  });

  it("refuses a manifest with no consumer root at all", async () => {
    const directory = await temporaryDirectory();
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ patchedTreeHash: "abc" }));
    expect(() => resolveCohort({ manifestPath })).toThrowError(/names no consumerRoot/u);
  });

  it("resolves packaged cohort paths from the manifest rather than the caller's cwd", async () => {
    const directory = await temporaryDirectory();
    const consumerRoot = path.join(directory, "consumer");
    const bundledCli = path.join(consumerRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    const tuiPackageRoot = path.join(consumerRoot, "node_modules/@earendil-works/pi-tui");
    await Promise.all([
      mkdir(path.dirname(bundledCli), { recursive: true }),
      mkdir(tuiPackageRoot, { recursive: true }),
    ]);
    await writeFile(bundledCli, "packaged cli\n");
    const manifestPath = path.join(directory, "cohort-manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      consumerRoot: "consumer",
      bundledCliPath: "consumer/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      bundledCliSha256: createHash("sha256").update("packaged cli\n").digest("hex"),
    }));

    const cohort = resolveCohort({ manifestPath });
    expect(cohort.consumerRoot).toBe(consumerRoot);
    expect(cohort.bundledCli).toBe(bundledCli);
    expect(cohort.tuiPackageRoot).toBe(tuiPackageRoot);
  });

  it("refuses packaged Pi bytes that do not match the manifest digest", async () => {
    const directory = await temporaryDirectory();
    const consumerRoot = path.join(directory, "consumer");
    const bundledCli = path.join(consumerRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    await Promise.all([
      mkdir(path.dirname(bundledCli), { recursive: true }),
      mkdir(path.join(consumerRoot, "node_modules/@earendil-works/pi-tui"), { recursive: true }),
    ]);
    await writeFile(bundledCli, "changed cli\n");
    const manifestPath = path.join(directory, "cohort-manifest.json");
    await writeFile(manifestPath, JSON.stringify({ consumerRoot: "consumer", bundledCliSha256: "0".repeat(64) }));

    expect(() => resolveCohort({ manifestPath })).toThrowError(/digest mismatch/u);
  });

  it("defaults to the Pi 1.4.0 cohort and tells the truth about which patch bytes built it", async () => {
    const patches = new URL("../../vendor/pi/patches/", import.meta.url);
    const manifest = JSON.parse(await readFile(DEFAULT_MANIFEST, "utf8"));
    const series = (await readFile(new URL("series", patches), "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    expect(manifest.series).toEqual(series);
    expect(series).toEqual([
      "0002-native-ingress-return-profile.patch",
      "0003-native-presentation-readiness.patch",
      "0005-native-child-handoff.patch",
      "0007-native-input-listener-provenance.patch",
    ]);
    expect(manifest.mode).toBe("patched");

    /** @param {string} name */
    const digestOf = async (name) => createHash("sha256").update(await readFile(new URL(name, patches))).digest("hex");
    const built = new Map(manifest.appliedPatches.map((/** @type {any} */ entry) => [entry.name, entry]));
    // Every patch in the default cohort is byte-identical to this tree's, so the bytes that ran came from these files.
    for (const [position, name] of series.entries()) {
      expect(built.get(name)).toEqual({ position: position + 1, name, sha256: await digestOf(name) });
    }

    const cohort = resolveCohort({});
    expect(cohort.manifestPath).toBe(DEFAULT_MANIFEST);
    expect(cohort.buildSlurmJobId).toBe(DEFAULT_COHORT.buildSlurmJobId);
    expect(cohort.upstreamCommit).toBe(DEFAULT_COHORT.upstreamCommit);
    expect(cohort.series).toEqual(series);
    expect(cohort.patchedTreeHash).toBe(DEFAULT_COHORT.patchedTreeHash);
    expect(createHash("sha256").update(await readFile(cohort.bundledCli)).digest("hex")).toBe(manifest.bundledCliSha256);
    expect(JSON.parse(await readFile(path.join(cohort.tuiPackageRoot, "package.json"), "utf8")).version).toBe(DEFAULT_COHORT.piVersion);
  });

  it("speaks bootstrap protocol 1", () => {
    expect(resolveCohort({}).bootstrapProtocolInUse).toBe(1);
  });
});

// Operator-visible failure: the README's commands are the public way in, and the reviewed six-patch default, the
// smoke evidence and the launch command all belong to THIS checkout. A `$DEMO` hard-coded to another checkout runs
// a different tree's code against these instructions, so the documented default is not what the reader executes.
// This regression fails for exactly that mistake and passes only when the assignment resolves inside this
// repository - checked by resolving it, never by starting the protected demo.
describe("the README's runnable command", () => {
  const readmePath = fileURLToPath(new URL("./README.md", import.meta.url));
  /** The repository root, which the README documents as the cwd its commands are pasted from. */
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

  /** @param {string} text */
  const demoAssignment = (text) => /^DEMO=(.*)$/mu.exec(text)?.[1] ?? null;

  it("assigns DEMO inside this checkout and nowhere else", async () => {
    const readme = await readFile(readmePath, "utf8");
    const assigned = demoAssignment(readme);
    expect(assigned).not.toBe(null);

    // Resolved the way a shell would from the documented cwd, with $PWD being the repository root.
    const expanded = String(assigned).replaceAll("\"", "").replace("$PWD", repositoryRoot.replace(/\/$/u, ""));
    const resolved = path.resolve(repositoryRoot, expanded);
    expect(existsSync(resolved)).toBe(true);
    // The file it names is this repository's own demo entry point, not another tree's copy of it.
    expect(resolved).toBe(fileURLToPath(new URL("./demo.mjs", import.meta.url)));
    expect(path.relative(repositoryRoot, resolved)).toBe(path.join("examples", "native-session-demo", "demo.mjs"));
    // Nothing was executed: this resolves a path and reads a file.
  });

  // The discriminating half. The exact wrong-checkout assignment the review found must be rejected by the same
  // rule, so a future edit that reintroduces any foreign checkout cannot pass by naming a real file.
  it("rejects a DEMO that names a different checkout, even one that exists", () => {
    const foreign = "/mnt/main0/home/gjohnson/projects/pi-agents-native-demo-20260919/examples/native-session-demo/demo.mjs";
    const resolvedForeign = path.resolve(repositoryRoot, foreign);
    expect(resolvedForeign).not.toBe(fileURLToPath(new URL("./demo.mjs", import.meta.url)));
    expect(resolvedForeign.startsWith(repositoryRoot)).toBe(false);
    // And it is not merely absent - it is a real other checkout, which is why an existence check alone is not
    // the test. The rule is that the command has to resolve into THIS repository.
    expect(foreign).toMatch(/pi-agents-native-demo-20260919/u);
  });

  it("documents the Pi 1.4.0 default cohort", async () => {
    const readme = await readFile(readmePath, "utf8");
    expect(readme).toContain(DEFAULT_COHORT.buildSlurmJobId);
    expect(readme).toContain(DEFAULT_COHORT.patchedTreeHash);
    expect(readme).toContain(DEFAULT_COHORT.upstreamCommit);
  });
});

describe("the labelled fake provider", () => {
  it("answers the same prompt with the same bytes, and a different prompt differently", () => {
    const one = deterministicReply({ messages: [{ role: "user", content: "hello" }] });
    expect(one).toBe(deterministicReply({ messages: [{ role: "user", content: "hello" }] }));
    expect(one.startsWith(FAKE_REPLY_PREFIX)).toBe(true);
    expect(one).not.toBe(deterministicReply({ messages: [{ role: "user", content: "hello " }] }));
  });

  it("streams start, one text block and done, and says aborted rather than inventing a reply", () => {
    const events = [];
    const stream = { push: (event) => events.push(event), end: () => events.push({ type: "end" }) };
    const streamSimple = createFakeStreamSimple({ createStream: () => stream });
    const model = { api: "openai-completions", provider: "native-session-demo-fake", id: "deterministic-echo" };

    streamSimple(model, { messages: [{ role: "user", content: "ping" }] }, undefined);
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done", "end"]);
    const done = events.find((event) => event.type === "done");
    expect(done.message.content).toEqual([{ type: "text", text: deterministicReply({ messages: [{ role: "user", content: "ping" }] }) }]);
    expect(done.message.usage.cost.total).toBe(0);

    events.length = 0;
    streamSimple(model, { messages: [{ role: "user", content: "ping" }] }, { signal: { aborted: true } });
    expect(events.map((event) => event.type)).toEqual(["start", "error", "end"]);
    expect(events[1].error.stopReason).toBe("aborted");
  });
});

describe("the demo root's ownership", () => {
  it("refuses a pre-existing directory and leaves its content, its mode and its token untouched", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "operator-directory");
    await mkdir(root);
    await chmod(root, 0o755);
    await writeFile(path.join(root, "notes.txt"), "the operator's own file\n");
    await writeFile(demoPaths(root).token, "not-a-demo-token\n", { mode: 0o644 });

    await expect(createRoot(root)).rejects.toThrowError(/already exists/u);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("the operator's own file\n");
    expect(await readFile(demoPaths(root).token, "utf8")).toBe("not-a-demo-token\n");
    expect((await stat(root)).mode & 0o777).toBe(0o755);
  });

  it("refuses a symlinked root, and leaves the link and its target alone", async () => {
    const parent = await temporaryDirectory();
    const target = path.join(parent, "target");
    await mkdir(target);
    await writeFile(path.join(target, "keep.txt"), "target content\n");
    const root = path.join(parent, "link");
    await symlink(target, root);

    await expect(createRoot(root)).rejects.toThrowError(/already exists/u);
    expect(await readlink(root)).toBe(target);
    expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("target content\n");
  });

  it("creates a fresh 0700 root and holds that directory open", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "fresh");
    const created = await createRoot(root);

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(demoPaths(root).token)).mode & 0o777).toBe(0o600);
    expect(created.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(typeof created.ownership.ownerId).toBe("string");
    expect(created.anchor.anchoredRoot).toBe(`/proc/${process.pid}/fd/${created.anchor.fd}`);
    expect(await created.anchor.namesCreatedDirectory()).toBe(true);
    expect((await stat(created.anchor.anchoredRoot)).ino).toBe((await stat(root)).ino);

    await created.anchor.close();
  });

  it("writes through the descriptor it opened, never through a path that was replaced", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "replaced");
    const renamed = path.join(parent, "renamed");
    const created = await createRoot(root);
    await rename(root, renamed);
    const planted = await plantReplacement(root, { ownershipFrom: renamed });

    await writeOwnerRecord(created.anchor.anchoredRoot, { stopped: true });

    expect(await created.anchor.namesCreatedDirectory()).toBe(false);
    expect(JSON.parse(await readFile(path.join(renamed, "owner.json"), "utf8")).stopped).toBe(true);
    expect(await snapshotDirectory(root)).toEqual(planted);

    await created.anchor.close();
  });
});

describe("the pre-ingress input queue", () => {
  const span = (text) => ({ attachmentId: "client-1", epoch: 1, generation: 1, bytes: Buffer.from(text, "utf8") });

  it("refuses the span that would cross the bound instead of holding it", () => {
    const queue = createPendingInputQueue(8);
    expect(queue.admit(span("12345")).outcome).toBe("held");
    expect(queue.admit(span("6789")).outcome).toBe("refused");
    expect(queue.heldBytes()).toBe(5);
    expect(queue.length()).toBe(1);
    expect(queue.drain().map((entry) => entry.bytes.toString("utf8"))).toEqual(["12345"]);
    expect(queue.heldBytes()).toBe(0);
    expect(queue.length()).toBe(0);
  });

  it("stays inside its bound across repeated overflow attempts, and delivers the accepted bytes once", () => {
    const queue = createPendingInputQueue(8);
    expect(queue.admit(span("1234")).outcome).toBe("held");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(queue.admit(span("56789")).outcome).toBe("refused");
    }
    expect(queue.heldBytes()).toBe(4);
    expect(queue.length()).toBe(1);
    expect(queue.drain().map((entry) => entry.bytes.toString("utf8"))).toEqual(["1234"]);
    expect(queue.drain()).toEqual([]);
  });

  it("holds no entry for an empty span, however many arrive", () => {
    const queue = createPendingInputQueue(8);
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      expect(queue.admit(span("")).outcome).toBe("empty");
    }
    expect(queue.length()).toBe(0);
    expect(queue.heldBytes()).toBe(0);
  });
});

describe("the frontend's pausing relay", () => {
  /** A destination that accepts one byte before it says no, and a real readable source to pause. */
  function relayPair(canResumeSource = () => true) {
    const source = new PassThrough();
    const destination = new PassThrough({ highWaterMark: 1 });
    return { source, destination, relay: createPausingRelay({ source, destination, canResumeSource }) };
  }

  /** Everything the destination ever took, in write order, read out after the fact. */
  async function written(destination, bytes) {
    return (await collectWrites(destination).settle(bytes)).toString("utf8");
  }

  it("queues what the destination refused, pauses the source once and writes nothing more", () => {
    const { source, destination, relay } = relayPair();
    relay.send(Buffer.from("one"), Buffer.from("two"), Buffer.from("three"));

    expect(relay.queuedCount()).toBe(2);
    expect(relay.sourcePaused()).toBe(true);
    expect(source.isPaused()).toBe(true);
    expect(destination.writableLength).toBe(3);
    expect(destination.listenerCount("drain")).toBe(1);
  });

  it("stays blocked across every later send until the destination drains", () => {
    const { destination, relay } = relayPair();
    relay.send(Buffer.from("one"));
    expect(destination.writableLength).toBe(3);
    expect(relay.blocked()).toBe(true);

    relay.send(Buffer.from("two"));
    relay.send(Buffer.from("three"), Buffer.from("four"));

    expect(destination.writableLength).toBe(3);
    expect(relay.queuedCount()).toBe(3);
    expect(relay.queuedBytes()).toBe(12);
    expect(destination.listenerCount("drain")).toBe(1);
  });

  it("queues every frame decoded from one socket read after the first write was refused", async () => {
    const { destination, relay } = relayPair();
    const chunk = Buffer.concat([
      encodeFrame({ type: "output" }, Buffer.from("aaa")),
      encodeFrame({ type: "output" }, Buffer.from("bbb")),
      encodeFrame({ type: "output" }, Buffer.from("ccc")),
    ]);
    const reader = createFrameReader(
      ({ body }) => relay.send(body),
      (error) => {
        throw error;
      },
    );
    reader.push(chunk);

    expect(destination.writableLength).toBe(3);
    expect(relay.queuedCount()).toBe(2);
    expect(await written(destination, 9)).toBe("aaabbbccc");
  });

  it("writes only the unwritten remainder on drain, in order, and resumes the source once", async () => {
    const { source, destination, relay } = relayPair();
    const resumed = once(source, "resume");
    relay.send(Buffer.from("one"), Buffer.from("two"), Buffer.from("three"));
    const seen = [];
    const allSeen = new Promise((resolve) => {
      destination.on("data", (chunk) => {
        seen.push(chunk.toString("utf8"));
        if (seen.join("") === "onetwothree") resolve(undefined);
      });
    });
    await Promise.all([allSeen, resumed]);

    expect(seen).toEqual(["one", "two", "three"]);
    expect(relay.queuedCount()).toBe(0);
    expect(relay.sourcePaused()).toBe(false);
    expect(destination.listenerCount("drain")).toBe(1);
  });

  it("flushes the remainder to a live destination but leaves a source it may not resume paused", async () => {
    const { source, destination, relay } = relayPair(() => false);
    relay.send(Buffer.from("one"), Buffer.from("two"));
    expect(relay.sourcePaused()).toBe(true);

    expect(await written(destination, 6)).toBe("onetwo");
    expect(source.isPaused()).toBe(true);
    expect(relay.sourcePaused()).toBe(true);
  });

  it("writes nothing more once it is disposed, drops what it held by count, and refuses a later send", async () => {
    const { source, destination, relay } = relayPair();
    relay.send(Buffer.from("one"), Buffer.from("two"), Buffer.from("three"));

    const disposal = relay.dispose("the attachment ended");
    expect(disposal).toMatchObject({ reason: "the attachment ended", discardedChunks: 2, discardedBytes: 8 });
    expect(relay.queuedCount()).toBe(0);
    expect(destination.listenerCount("drain")).toBe(0);
    expect(relay.dispose("again")).toMatchObject({ reason: "the attachment ended", discardedChunks: 2 });
    expect(() => relay.send(Buffer.from("four"))).toThrowError(/disposed/u);

    destination.emit("drain");
    expect(await written(destination, 3)).toBe("one");
    expect(source.isPaused()).toBe(true);
  });
});

describe("one attachment's teardown", () => {
  /** The client's own wiring, with a terminal and a socket that each take one byte before saying no. */
  function frontend() {
    const stdin = new PassThrough();
    const stdout = new PassThrough({ highWaterMark: 1 });
    const socket = new PassThrough({ highWaterMark: 1 });
    const notices = [];
    let finished = false;
    const toTerminal = createPausingRelay({ source: socket, destination: stdout, canResumeSource: () => !finished });
    const toManager = createPausingRelay({ source: stdin, destination: socket, canResumeSource: () => !finished });
    const teardown = createAttachmentTeardown({ toManager, toTerminal, stdin, stdout, notice: (text) => notices.push(text) });
    return { stdin, stdout, socket, notices, toTerminal, toManager, teardown, finish: () => (finished = true) };
  }

  /** Everything one side ever took, in write order. */
  async function written(stream, bytes) {
    return collectWrites(stream).settle(bytes);
  }

  it("restores this terminal last, and nothing the relay held is written after that", async () => {
    const { stdout, notices, toTerminal, teardown, finish } = frontend();
    toTerminal.send(Buffer.from("owner output one"), Buffer.from("owner output two"));
    finish();

    teardown.restore("the manager closed this attachment");
    stdout.emit("drain");

    const seen = (await written(stdout, 16 + FRONTEND_MODE_RESTORE.length)).toString("utf8");
    expect(seen).toBe(`owner output one${FRONTEND_MODE_RESTORE}`);
    expect(seen.endsWith(FRONTEND_MODE_RESTORE)).toBe(true);
    expect(notices.join("\n")).toMatch(/16 byte\(s\) of the owner's output were dropped/u);
  });

  it("keeps the detach frame behind the input the socket already took, and drops the rest by count", async () => {
    const { socket, notices, toManager, teardown, finish } = frontend();
    const first = encodeFrame({ type: "input" }, Buffer.from("typed-one"));
    const second = encodeFrame({ type: "input" }, Buffer.from("typed-two"));
    const detach = encodeFrame({ type: "detach" });
    toManager.send(first, second);
    finish();

    teardown.disposeRelays("this client received SIGTERM");
    socket.write(detach);
    teardown.restore("this client received SIGTERM");
    socket.emit("drain");

    const frames = read([await written(socket, first.byteLength + detach.byteLength)]).frames;
    expect(frames.map((frame) => frame.header.type)).toEqual(["input", "detach"]);
    expect(frames[0].body.toString("utf8")).toBe("typed-one");
    expect(notices.join("\n")).toMatch(/typed byte\(s\) in 1 frame\(s\) had not reached the manager/u);
  });

  it("does not resume this terminal's stdin after the attachment finished", async () => {
    const { stdin, socket, toManager, teardown, finish } = frontend();
    toManager.send(encodeFrame({ type: "input" }, Buffer.from("one")), encodeFrame({ type: "input" }, Buffer.from("two")));
    expect(stdin.isPaused()).toBe(true);
    finish();

    teardown.restore("the manager closed this attachment");
    socket.emit("drain");
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdin.isPaused()).toBe(true);
    expect(() => toManager.send(encodeFrame({ type: "input" }, Buffer.from("three")))).toThrowError(/disposed/u);
  });
});

describe("the smoke's stop verification", () => {
  it("reads procfs absence as absence and every other inspection failure as uncertainty", async () => {
    const failing = (code) => () => Promise.reject(Object.assign(new Error(`inspect failed: ${code}`), { code }));
    expect((await verifyOwnerAbsence(4242, "999", failing("ENOENT"))).gone).toBe(true);
    expect((await verifyOwnerAbsence(4242, "999", failing("ESRCH"))).gone).toBe(true);
    expect((await verifyOwnerAbsence(4242, "999", failing("EACCES"))).gone).toBe(false);
    expect((await verifyOwnerAbsence(4242, "999", failing("AMBIGUOUS_IDENTITY"))).gone).toBe(false);
    expect((await verifyOwnerAbsence(4242, "999", failing(undefined))).gone).toBe(false);
  });

  it("calls a live owner present, and a recycled PID absent", async () => {
    const live = await verifyOwnerAbsence(4242, "999", async () => ({ pid: 4242, processGroupId: 4242, startIdentity: "999" }));
    expect(live.gone).toBe(false);
    expect(live.reason).toMatch(/still/u);
    const recycled = await verifyOwnerAbsence(4242, "999", async () => ({ pid: 4242, processGroupId: 4242, startIdentity: "1000" }));
    expect(recycled.gone).toBe(true);
  });

  it("requires an actual wait status before it calls a stop successful", () => {
    expect(describeOwnerExit(undefined).observed).toBe(false);
    expect(describeOwnerExit(null).observed).toBe(false);
    expect(describeOwnerExit({ disposition: "TERMINATED", elapsedMs: 10 }).observed).toBe(false);
    expect(describeOwnerExit({ status: 0, code: null, signal: null }).observed).toBe(false);
    expect(describeOwnerExit({ status: 0, code: 0, signal: null, waitObserved: false }).observed).toBe(false);

    const graceful = describeOwnerExit({ status: 0, code: 0, signal: null, waitObserved: true, disposition: "graceful" });
    expect(graceful).toMatchObject({ observed: true, status: 0, code: 0, signal: null });
    const signalled = describeOwnerExit({ status: 9, code: null, signal: "SIGKILL", waitObserved: true });
    expect(signalled).toMatchObject({ observed: true, status: 9, code: null, signal: "SIGKILL" });
  });
});

describe("transcript reading", () => {
  it("strips the escape sequences a screen assertion must not depend on", () => {
    expect(stripSequences("\u001b[?25l\u001b[38;5;239mdraft\u001b[39m\u001b]0;title\u0007")).toBe("draft");
  });
});

// The real user flow: two disposable clients, one real bundled CLI on one real pseudo-terminal.
describe.runIf(process.env.PI_NATIVE_DEMO_SMOKE === "1")("the native session demo, end to end", () => {
  it(
    "keeps one owner across a full detach, repaints a retained draft, shares it with a second attachment and answers it",
    async () => {
      const directory = await temporaryDirectory();
      // A fresh root per run: the manager refuses a root it did not create, so a kept one is never reused.
      const root = `/tmp/pi-nsd-vitest-${process.pid}-${Date.now()}`;
      const result = await runSmoke({ root, evidenceDir: path.join(directory, "evidence") });
      expect(result.failures).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.owner.identityAfterDetach.startIdentity).toBe(result.owner.identityAtStart.startIdentity);
      expect(result.owner.absenceAfterStop.gone).toBe(true);
      expect(result.owner.exitAfterStop.observed).toBe(true);
      // `stop` now retains every root, so this harness removes the one sandbox it named for this run itself,
      // after its owner is verified gone. It never removes a root an operator passed in.
      await rm(root, { recursive: true, force: true });
    },
    300_000,
  );
});

/**
 * One real manager, started through its own `serve` command, whose root is taken away from under it.
 *
 * These need the same prerequisites as the smoke — a real pseudo-terminal and the selected cohort's bundled
 * CLI — so they run behind the same selector rather than in the routine suite.
 */
describe.runIf(process.env.PI_NATIVE_DEMO_SMOKE === "1")("a manager whose root is replaced under it", () => {
  const DEMO = fileURLToPath(new URL("demo.mjs", import.meta.url));
  /** One budget for a whole case, its failure path included, and the harness timeout just above it. */
  const CASE_BUDGET_MS = 25_000;
  const CASE_TIMEOUT_MS = 30_000;
  /** Only ever applied to a process one case recorded, re-verified by identity immediately before the signal. */
  const CLEANUP_STOP_POLICY = { gracefulMs: 2_000, terminateMs: 2_000 };

  /**
   * Every wait in a case is bounded by what is left of that case's budget.
   *
   * Unbounded waits are how the first version of these cases hung: it registered `close` and `exit` listeners
   * after awaiting the stop, by which time both had already fired. The listeners are registered at spawn and
   * connect now, and a wait that still cannot finish fails inside the budget so the cleanup below runs.
   */
  function caseBudget() {
    const endsAtMs = Date.now() + CASE_BUDGET_MS;
    const remainingMs = () => Math.max(1, endsAtMs - Date.now());
    return {
      remainingMs,
      /** @param {Promise<any>} promise @param {string} what */
      wait(promise, what) {
        const budgetMs = remainingMs();
        let timer;
        return Promise.race([
          Promise.resolve(promise).finally(() => clearTimeout(timer)),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${what} did not happen within the ${budgetMs}ms this case had left`)), budgetMs);
          }),
        ]);
      },
    };
  }

  /** One manager in its own process, resolved at its own ready record, with both terminal events bound now. */
  async function serveOneOwner(root, budget) {
    const child = spawn(process.execPath, [DEMO, "serve", "--root", root], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // Bound before the first await: a process that is already gone emits neither `exit` nor `close` again.
    const exited = once(child, "exit");
    let stdout = "";
    const ready = await budget.wait(
      new Promise((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          const newline = stdout.indexOf("\n");
          if (newline !== -1) resolve(JSON.parse(stdout.slice(0, newline)));
        });
        child.stdout.on("close", () => reject(new Error(`the manager exited before it was ready: ${stderr.slice(-2000)}`)));
        child.on("error", reject);
      }),
      `the manager's ready record for ${root}`,
    );
    return { child, ready, exited, stderr: () => stderr };
  }

  /** One authenticated connection, opened while the root path still names the directory the manager created. */
  async function connectToManager(root, hello, budget) {
    const token = await readToken(root);
    const socket = net.connect(demoPaths(root).controlSocket);
    const closed = once(socket, "close");
    socket.on("error", () => {});
    await budget.wait(once(socket, "connect"), `the ${hello.role} connection to ${root}`);
    const frames = [];
    const waiters = [];
    const reader = createFrameReader(
      (frame) => {
        frames.push(frame);
        for (const waiter of [...waiters]) {
          if (waiter.type !== frame.header.type) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame.header);
        }
      },
      (error) => {
        throw error;
      },
    );
    socket.on("data", (chunk) => reader.push(chunk));
    socket.write(encodeFrame({ ...hello, token }));
    return {
      socket,
      closed,
      send: (frame) => socket.write(encodeFrame(frame)),
      awaitFrame(type) {
        const seen = frames.find((frame) => frame.header.type === type);
        if (seen !== undefined) return Promise.resolve(seen.header);
        const budgetMs = budget.remainingMs();
        return new Promise((resolve, reject) => {
          const waiter = { type, resolve };
          waiters.push(waiter);
          const timer = setTimeout(
            () => reject(new Error(`no ${type} frame within the ${budgetMs}ms this case had left; saw ${frames.map((frame) => frame.header.type).join(",")}`)),
            budgetMs,
          );
          waiter.resolve = (header) => {
            clearTimeout(timer);
            resolve(header);
          };
        });
      },
    };
  }

  /**
   * Start an owner, rename its root away, put another directory in its place and stop it through the control
   * connection that was authenticated before any of that happened.
   *
   * Whatever happens, the case ends by reaping exactly the two processes it recorded: its own manager child by
   * its own pid, and that manager's owner only while the identity the ready record named still matches. Nothing
   * broader is signalled, and the manager shares this worker's process group, so it is never group-signalled.
   *
   * @param {{ ownershipCopied: boolean, replaceAfterStopFrame: boolean }} how
   */
  async function driveReplacedStop({ ownershipCopied, replaceAfterStopFrame }) {
    const budget = caseBudget();
    const sandbox = await temporaryDirectory();
    const root = path.join(sandbox, "r");
    const renamed = path.join(sandbox, "renamed");
    /** @type {(() => Promise<void>)[]} */
    const reap = [];
    try {
      const { child, ready, exited, stderr } = await serveOneOwner(root, budget);
      reap.push(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      reap.push(async () => {
        const owner = ready.owner;
        const found = await inspectProcessIdentity(owner.pid).catch(() => null);
        if (found === null || found.startIdentity !== owner.startIdentity) return;
        await stopVerifiedProcessGroup(
          { pid: owner.pid, processGroupId: owner.processGroupId, startIdentity: owner.startIdentity },
          { inspect: (pid) => inspectProcessIdentity(pid), requestGraceful: async () => {}, signalProcessGroup, sleep },
          CLEANUP_STOP_POLICY,
        );
      });
      const control = await connectToManager(root, { type: "hello", role: "control" }, budget);
      const client = await connectToManager(root, { type: "hello", role: "client", attachmentId: "client-1" }, budget);
      reap.push(async () => {
        control.socket.destroy();
        client.socket.destroy();
      });
      await client.awaitFrame("welcome");

      const replace = async () => {
        await rename(root, renamed);
        return plantReplacement(root, ownershipCopied ? { ownershipFrom: renamed } : {});
      };

      let planted;
      if (!replaceAfterStopFrame) planted = await replace();
      control.send({ type: "stop" });
      // Near teardown, not before a single check: the manager is already stopping when the root changes.
      if (replaceAfterStopFrame) planted = await replace();

      const stopped = await control.awaitFrame("stopped");
      const bye = await client.awaitFrame("bye");
      await budget.wait(client.closed, "the client connection closing");
      const [managerExitCode] = await budget.wait(exited, "the manager process exiting");
      return { root, renamed, ready, stopped, bye, planted, managerExitCode, stderr };
    } finally {
      for (const cleanup of reap.reverse()) await cleanup();
    }
  }

  /** The directory that took the root's place: same names, same bytes, same mode. */
  async function expectReplacementUntouched({ root, planted }) {
    expect(await snapshotDirectory(root)).toEqual(planted);
  }

  /** This demo's own owner, gone for real, with its evidence in the directory the manager actually held. */
  async function expectOwnerStoppedForReal({ renamed, ready, stopped, bye, managerExitCode }) {
    expect(stopped.exit.waitObserved).toBe(true);
    expect(Number.isInteger(stopped.exit.status)).toBe(true);
    expect(stopped.rootKept).toBe(true);
    expect(stopped.rootRetention.pathStillNamesCreatedDirectory).toBe(false);
    expect(bye.reason).toMatch(/stopping/u);
    expect(managerExitCode).toBe(0);
    expect((await verifyOwnerAbsence(ready.owner.pid, ready.owner.startIdentity)).gone).toBe(true);
    expect(JSON.parse(await readFile(path.join(renamed, "owner.json"), "utf8")).stopped).toBe(true);
    expect(await readFile(path.join(renamed, "manager.log"), "utf8")).toMatch(/root is retained/u);
    // Both sockets were unlinked by the paths the manager bound, which resolve through its own descriptor.
    expect(existsSync(path.join(renamed, "s"))).toBe(false);
    expect(existsSync(path.join(renamed, "b"))).toBe(false);
  }

  it(
    "leaves an unmarked directory that replaced its root exactly as it found it",
    async () => {
      const run = await driveReplacedStop({ ownershipCopied: false, replaceAfterStopFrame: false });
      await expectReplacementUntouched(run);
      await expectOwnerStoppedForReal(run);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "leaves a directory carrying a copied ownership marker alone: a copied marker is not identity",
    async () => {
      const run = await driveReplacedStop({ ownershipCopied: true, replaceAfterStopFrame: false });
      expect(run.planted.entries).toContain("ownership.json");
      await expectReplacementUntouched(run);
      await expectOwnerStoppedForReal(run);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "leaves a marked replacement alone when it arrives while the stop is already running",
    async () => {
      const run = await driveReplacedStop({ ownershipCopied: true, replaceAfterStopFrame: true });
      await expectReplacementUntouched(run);
      await expectOwnerStoppedForReal(run);
    },
    CASE_TIMEOUT_MS,
  );
});
