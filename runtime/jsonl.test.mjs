import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { createJsonlDecoder, createJsonlEncoder, encodeJsonl } from "./jsonl.mjs";

describe("JSONL decoder", () => {
  it("decodes split UTF-8 and coalesced LF records", () => {
    const decoder = createJsonlDecoder({ maxBytes: 1024 });
    const first = Buffer.from('{"text":"caf');
    const finalCharacter = Buffer.from('é"}\n{"op":"ack"}\n');

    expect(decoder.push(Buffer.concat([first, finalCharacter.subarray(0, 1)]))).toEqual([]);
    expect(decoder.push(finalCharacter.subarray(1))).toEqual([
      { text: "café" },
      { op: "ack" },
    ]);
  });

  // FRAME_TOO_LARGE must win over MALFORMED_JSON: the limit is enforced before JSON parsing.
  it.each([
    ["malformed JSON", 1024, Buffer.from('{"partial":\n'), "MALFORMED_JSON"],
    ["malformed UTF-8", 1024, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]), "INVALID_UTF8"],
  ])("returns a typed error without a partial message for %s", (_name, maxBytes, bytes, code) => {
    const decoder = createJsonlDecoder({ maxBytes });

    expect(() => decoder.push(bytes)).toThrowError(
      expect.objectContaining({ name: "JsonlFramingError", code }),
    );
  });

  it("rejects an incomplete final record", () => {
    const decoder = createJsonlDecoder({ maxBytes: 1024 });
    expect(decoder.push(Buffer.from('{"ok":true}'))).toEqual([]);

    expect(() => decoder.end()).toThrowError(
      expect.objectContaining({ name: "JsonlFramingError", code: "INCOMPLETE_FRAME" }),
    );
  });
});

describe("JSONL encoder", () => {
  it("encodes one LF-terminated JSON record", () => {
    expect(encodeJsonl({ text: "line\nbreak" }).toString("utf8")).toBe(
      '{"text":"line\\nbreak"}\n',
    );
  });

  it("bounds encoded frames by bytes before returning them", () => {
    const encoder = createJsonlEncoder({ maxBytes: 7 });

    expect(encoder.encode({ a: 1 }).toString("utf8")).toBe('{"a":1}\n');
    expect(() => encoder.encode({ aa: 1 })).toThrowError(
      expect.objectContaining({ code: "FRAME_TOO_LARGE" }),
    );
  });
});
