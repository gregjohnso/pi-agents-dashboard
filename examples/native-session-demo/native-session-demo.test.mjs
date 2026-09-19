/**
 * Focused cases for the demo's own seams: its frame bounds, its authentication, its cohort selection and its
 * fake provider's determinism. None of them launches Pi.
 *
 * The user flow itself is `smoke.mjs`, which needs a real pseudo-terminal, a real bundled CLI and about ten
 * seconds. It runs here only when `PI_NATIVE_DEMO_SMOKE` selects it, so the routine suite stays short.
 */

import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCohort } from "./cohort.mjs";
import { createRoot, demoPaths, removeOwnedRoot, tokenMatches } from "./demo-root.mjs";
import { FAKE_REPLY_PREFIX, createFakeStreamSimple, deterministicReply } from "./fake-provider.mjs";
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

  it("refuses a symlinked root, and never follows it when removing", async () => {
    const parent = await temporaryDirectory();
    const target = path.join(parent, "target");
    await mkdir(target);
    await writeFile(path.join(target, "keep.txt"), "target content\n");
    const root = path.join(parent, "link");
    await symlink(target, root);

    await expect(createRoot(root)).rejects.toThrowError(/already exists/u);
    const removal = await removeOwnedRoot(root, { ownerId: "a root this process never created" });
    expect(removal.removed).toBe(false);
    expect(await readlink(root)).toBe(target);
    expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("target content\n");
  });

  it("creates a fresh 0700 root it owns, and removes that one on request", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "fresh");
    const created = await createRoot(root);

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(demoPaths(root).token)).mode & 0o777).toBe(0o600);
    expect(created.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(typeof created.ownership.ownerId).toBe("string");

    const removal = await removeOwnedRoot(root, created.ownership);
    expect(removal.removed).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it("preserves a root that was replaced after this process created it", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "replaced");
    const created = await createRoot(root);
    await rm(root, { recursive: true, force: true });
    await mkdir(root);
    await writeFile(path.join(root, "someone-else.txt"), "later\n");

    const removal = await removeOwnedRoot(root, created.ownership);
    expect(removal.removed).toBe(false);
    expect(await readFile(path.join(root, "someone-else.txt"), "utf8")).toBe("later\n");
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

  it("queues what the destination refused, pauses the source once and writes nothing more", () => {
    const { source, destination, relay } = relayPair();
    relay.send(Buffer.from("one"), Buffer.from("two"), Buffer.from("three"));

    expect(relay.queuedCount()).toBe(2);
    expect(relay.sourcePaused()).toBe(true);
    expect(source.isPaused()).toBe(true);
    expect(destination.writableLength).toBe(3);
    expect(destination.listenerCount("drain")).toBe(1);
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

  it("does not resume a source the attachment has finished with", async () => {
    const { source, destination, relay } = relayPair(() => false);
    relay.send(Buffer.from("one"), Buffer.from("two"));
    expect(relay.sourcePaused()).toBe(true);
    const seen = [];
    const allSeen = new Promise((resolve) => {
      destination.on("data", (chunk) => {
        seen.push(chunk.toString("utf8"));
        if (seen.join("") === "onetwo") resolve(undefined);
      });
    });
    await allSeen;

    expect(seen).toEqual(["one", "two"]);
    expect(source.isPaused()).toBe(true);
    expect(relay.sourcePaused()).toBe(true);
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
      const result = await runSmoke({ root: `/tmp/pi-nsd-vitest-${process.pid}-${Date.now()}`, evidenceDir: path.join(directory, "evidence") });
      expect(result.failures).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.owner.identityAfterDetach.startIdentity).toBe(result.owner.identityAtStart.startIdentity);
      expect(result.owner.absenceAfterStop.gone).toBe(true);
      expect(result.owner.exitAfterStop.observed).toBe(true);
    },
    300_000,
  );
});
