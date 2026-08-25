import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  JsonlFramingError,
  createJsonlDecoder,
  createJsonlEncoder,
  encodeJsonl,
} from "./jsonl.mjs";

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

  it("accepts an optional CR before LF", () => {
    const decoder = createJsonlDecoder({ maxBytes: 1024 });

    expect(decoder.push(Buffer.from('{"ok":true}\r\n'))).toEqual([{ ok: true }]);
  });

  it("returns typed errors for malformed JSON without returning a partial message", () => {
    const decoder = createJsonlDecoder({ maxBytes: 1024 });

    expect(() => decoder.push(Buffer.from('{"partial":\n'))).toThrowError(
      expect.objectContaining({ name: "JsonlFramingError", code: "MALFORMED_JSON" }),
    );
  });

  it("returns typed errors for malformed UTF-8", () => {
    const decoder = createJsonlDecoder({ maxBytes: 1024 });

    expect(() => decoder.push(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]))).toThrowError(
      expect.objectContaining({ name: "JsonlFramingError", code: "INVALID_UTF8" }),
    );
  });

  it("enforces the frame byte limit before JSON parsing", () => {
    const decoder = createJsonlDecoder({ maxBytes: 7 });

    expect(() => decoder.push(Buffer.from("not-json\n"))).toThrowError(
      expect.objectContaining({ name: "JsonlFramingError", code: "FRAME_TOO_LARGE" }),
    );
  });

  it("rejects an incomplete final record", () => {
    const decoder = createJsonlDecoder({ maxBytes: 1024 });
    expect(decoder.push(Buffer.from('{"ok":true}'))).toEqual([]);

    expect(() => decoder.end()).toThrowError(
      expect.objectContaining({ name: "JsonlFramingError", code: "INCOMPLETE_FRAME" }),
    );
  });

  it("rejects invalid limits", () => {
    expect(() => createJsonlDecoder({ maxBytes: 0 })).toThrowError(TypeError);
  });
});

describe("JSONL encoder", () => {
  it("encodes one LF-terminated JSON record", () => {
    expect(encodeJsonl({ text: "line\nbreak" }).toString("utf8")).toBe(
      '{"text":"line\\nbreak"}\n',
    );
  });

  it("returns a typed error when the value cannot be represented as JSON", () => {
    expect(() => encodeJsonl(undefined)).toThrowError(JsonlFramingError);
    expect(() => encodeJsonl(1n)).toThrowError(
      expect.objectContaining({ code: "NOT_SERIALIZABLE" }),
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
