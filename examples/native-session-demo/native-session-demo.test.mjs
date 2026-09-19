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

import { DEFAULT_MANIFEST, resolveCohort } from "./cohort.mjs";
import { FRONTEND_MODE_RESTORE, createAttachmentTeardown } from "./client.mjs";
import { createRoot, demoPaths, readToken, tokenMatches, writeOwnerRecord } from "./demo-root.mjs";import { FAKE_REPLY_PREFIX, createFakeStreamSimple, deterministicReply } from "./fake-provider.mjs";
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

  it("defaults to the installed cohort built from exactly this tree's ordered patch series", async () => {
    const patches = new URL("../../vendor/pi/patches/", import.meta.url);
    const manifest = JSON.parse(await readFile(DEFAULT_MANIFEST, "utf8"));
    const series = (await readFile(new URL("series", patches), "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(manifest.series).toEqual(series);
    // Not just the names: the cohort the demo launches was built from these exact patch bytes, in this order.
    const digests = [];
    for (const [position, name] of series.entries()) {
      digests.push({ position: position + 1, name, sha256: createHash("sha256").update(await readFile(new URL(name, patches))).digest("hex") });
    }
    expect(manifest.appliedPatches).toEqual(digests);
    const cohort = resolveCohort({});
    expect(cohort.manifestPath).toBe(DEFAULT_MANIFEST);
    expect(cohort.patchedTreeHash).toBe(manifest.patchedTreeHash);
    expect(createHash("sha256").update(await readFile(cohort.bundledCli)).digest("hex")).toBe(manifest.bundledCliSha256);
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
