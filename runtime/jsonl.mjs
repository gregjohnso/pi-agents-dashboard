import { Buffer } from "node:buffer";

/** @typedef {"INVALID_UTF8" | "MALFORMED_JSON" | "FRAME_TOO_LARGE" | "INCOMPLETE_FRAME" | "NOT_SERIALIZABLE" | "DECODER_FAILED"} JsonlFramingErrorCode */

/** A framing failure that callers can handle without inspecting error text. */
export class JsonlFramingError extends Error {
  /**
   * @param {JsonlFramingErrorCode} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = "JsonlFramingError";
    this.code = code;
  }
}

/** @param {unknown} maxBytes */
function validateMaxBytes(maxBytes) {
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  return maxBytes;
}

/**
 * Encode one value as a line-feed-terminated JSON record.
 *
 * @param {unknown} value
 * @returns {Buffer}
 */
export function encodeJsonl(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new JsonlFramingError("NOT_SERIALIZABLE", "Value is not JSON serializable", { cause });
  }
  if (json === undefined) {
    throw new JsonlFramingError("NOT_SERIALIZABLE", "Value is not JSON serializable");
  }
  return Buffer.from(`${json}\n`, "utf8");
}

/**
 * Create a per-record JSONL encoder with a byte limit excluding the delimiter.
 *
 * @param {{ maxBytes: number }} options
 */
export function createJsonlEncoder({ maxBytes }) {
  const limit = validateMaxBytes(maxBytes);
  return {
    /** @param {unknown} value */
    encode(value) {
      const record = encodeJsonl(value);
      if (record.byteLength - 1 > limit) {
        throw new JsonlFramingError(
          "FRAME_TOO_LARGE",
          `JSONL frame exceeds the ${limit}-byte limit`,
        );
      }
      return record;
    },
  };
}

/**
 * Create a bounded incremental decoder for line-feed-delimited JSON records.
 *
 * @param {{ maxBytes: number }} options
 */
export function createJsonlDecoder({ maxBytes }) {
  const limit = validateMaxBytes(maxBytes);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let frameText = "";
  let frameBytes = 0;
  let failed = false;

  /** @param {Uint8Array} bytes */
  function append(bytes) {
    if (frameBytes + bytes.byteLength > limit) {
      failed = true;
      throw new JsonlFramingError(
        "FRAME_TOO_LARGE",
        `JSONL frame exceeds the ${limit}-byte limit`,
      );
    }
    frameBytes += bytes.byteLength;
    try {
      frameText += utf8.decode(bytes, { stream: true });
    } catch (cause) {
      failed = true;
      throw new JsonlFramingError("INVALID_UTF8", "JSONL frame contains invalid UTF-8", { cause });
    }
  }

  function finishFrame() {
    try {
      frameText += utf8.decode();
    } catch (cause) {
      failed = true;
      throw new JsonlFramingError("INVALID_UTF8", "JSONL frame contains invalid UTF-8", { cause });
    }

    const json = frameText.endsWith("\r") ? frameText.slice(0, -1) : frameText;
    frameText = "";
    frameBytes = 0;

    try {
      return JSON.parse(json);
    } catch (cause) {
      failed = true;
      throw new JsonlFramingError("MALFORMED_JSON", "JSONL frame contains malformed JSON", {
        cause,
      });
    }
  }

  return {
    /**
     * Decode every complete record in a chunk. Incomplete records remain buffered.
     *
     * @param {Uint8Array} chunk
     * @returns {unknown[]}
     */
    push(chunk) {
      if (failed) {
        throw new JsonlFramingError("DECODER_FAILED", "JSONL decoder cannot continue after an error");
      }
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("chunk must be a Uint8Array");
      }

      const records = [];
      let offset = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline === -1) {
          append(chunk.subarray(offset));
          return records;
        }
        append(chunk.subarray(offset, newline));
        records.push(finishFrame());
        offset = newline + 1;
      }
    },

    /** Reject a final partial record; JSONL messages require an LF delimiter. */
    end() {
      if (failed) {
        throw new JsonlFramingError("DECODER_FAILED", "JSONL decoder cannot continue after an error");
      }
      if (frameBytes === 0) {
        return [];
      }
      try {
        utf8.decode();
      } catch (cause) {
        failed = true;
        throw new JsonlFramingError("INVALID_UTF8", "JSONL frame contains invalid UTF-8", { cause });
      }
      failed = true;
      throw new JsonlFramingError(
        "INCOMPLETE_FRAME",
        "JSONL stream ended before the line-feed delimiter",
      );
    },
  };
}
