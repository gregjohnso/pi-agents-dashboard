/**
 * Focused cases for the demo's own seams: its frame bounds, its authentication, its cohort selection and its
 * fake provider's determinism. None of them launches Pi.
 *
 * The user flow itself is `smoke.mjs`, which needs a real pseudo-terminal, a real bundled CLI and about ten
 * seconds. It runs here only when `PI_NATIVE_DEMO_SMOKE` selects it, so the routine suite stays short.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCohort } from "./cohort.mjs";
import { tokenMatches } from "./demo-root.mjs";
import { FAKE_REPLY_PREFIX, createFakeStreamSimple, deterministicReply } from "./fake-provider.mjs";
import { MAX_FRAME_BYTES, createFrameReader, encodeFrame } from "./protocol.mjs";
import { runSmoke, stripSequences } from "./smoke.mjs";

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
      const result = await runSmoke({ root: `/tmp/pi-nsd-vitest-${process.pid}`, evidenceDir: path.join(directory, "evidence") });
      expect(result.passed).toBe(true);
      expect(result.owner.identityAfterDetach.startIdentity).toBe(result.owner.identityAtStart.startIdentity);
      expect(result.owner.goneAfterStop).toBe(true);
    },
    300_000,
  );
});
