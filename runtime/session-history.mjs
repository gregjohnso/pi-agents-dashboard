import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ERROR_MESSAGE_BYTES = 512;
const READ_CHUNK_BYTES = 64 * 1024;

/** A bounded, session-scoped canonical history read failure. */
export class SessionHistoryError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "SessionHistoryError";
    this.code = code;
    this.retryable = false;
  }
}

/** @param {string} value @param {number} maxBytes */
function boundedUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

/** @param {string} path @param {number} line @param {Buffer} rawBytes */
function fallbackSourceId(path, line, rawBytes) {
  const hash = createHash("sha256");
  hash.update(path, "utf8");
  hash.update("\0", "utf8");
  hash.update(String(line), "utf8");
  hash.update("\0", "utf8");
  hash.update(rawBytes.subarray(0, Math.min(rawBytes.length, 65_536)));
  hash.update(`\0${rawBytes.length}`, "utf8");
  return `history-${hash.digest("hex").slice(0, 24)}`;
}

/**
 * Open one canonical Pi JSONL session for incremental, read-only consumption.
 *
 * @param {{ path: string, maxRecordBytes?: number, maxErrorMessageBytes?: number }} options
 */
export async function createSessionHistoryReader({ path, maxRecordBytes = DEFAULT_MAX_RECORD_BYTES, maxErrorMessageBytes = DEFAULT_MAX_ERROR_MESSAGE_BYTES }) {
  if (typeof path !== "string" || resolve(path) !== path) throw new TypeError("Session history path must be absolute and canonical");
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new TypeError("maxRecordBytes must be a positive safe integer");
  if (!Number.isSafeInteger(maxErrorMessageBytes) || maxErrorMessageBytes < 64) throw new TypeError("maxErrorMessageBytes must be at least 64");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(path) !== path) throw new SessionHistoryError("SESSION_HISTORY_UNSAFE", "Canonical session history must be a regular non-symlink file");
  const handle = await open(path, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let scanOffset = 0;
  let consumedOffset = 0;
  let lineNumber = 0;
  let carry = Buffer.alloc(0);
  let oversizedBytes = 0;
  let closed = false;

  /** @param {Buffer} rawBytes @param {number} byteStart @param {number} byteEnd @param {number} line */
  function parseLine(rawBytes, byteStart, byteEnd, line) {
    try {
      const text = decoder.decode(rawBytes);
      const entry = JSON.parse(text);
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new TypeError("record is not an object");
      const sourceId = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : fallbackSourceId(path, line, rawBytes);
      return { entry: /** @type {Record<string, any>} */ (entry), position: { line, byteStart, byteEnd }, sourceId, rawBytes };
    } catch (cause) {
      const detail = cause instanceof SyntaxError ? "invalid JSON" : cause instanceof TypeError && cause.message === "record is not an object" ? cause.message : "invalid UTF-8";
      throw new SessionHistoryError("SESSION_HISTORY_PARSE_ERROR", boundedUtf8(`Canonical session line ${line} contains ${detail}; ${rawBytes.length} source bytes were not interpreted`, maxErrorMessageBytes), { cause });
    }
  }

  return {
    async read() {
      if (closed) throw new SessionHistoryError("SESSION_HISTORY_CLOSED", "Session history reader is closed");
      const current = await handle.stat();
      if (current.size < scanOffset) throw new SessionHistoryError("SESSION_HISTORY_TRUNCATED", "Canonical session history became shorter while being read");
      /** @type {Array<{ entry: Record<string, any>, position: { line: number, byteStart: number, byteEnd: number }, sourceId: string, rawBytes: Buffer }>} */
      const entries = [];
      /** @type {Array<{ code: string, message: string, retryable: false, line: number, byteStart: number, byteEnd: number, sourceId: string }>} */
      const errors = [];
      while (scanOffset < current.size) {
        const length = Math.min(READ_CHUNK_BYTES, current.size - scanOffset);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(chunk, 0, length, scanOffset);
        if (bytesRead === 0) break;
        scanOffset += bytesRead;
        let remaining = chunk.subarray(0, bytesRead);
        while (remaining.length > 0) {
          const newline = remaining.indexOf(0x0a);
          const part = newline === -1 ? remaining : remaining.subarray(0, newline);
          if (oversizedBytes > 0 || carry.length + part.length > maxRecordBytes) {
            oversizedBytes += carry.length + part.length;
            carry = Buffer.alloc(0);
          } else if (part.length > 0) {
            carry = carry.length === 0 ? Buffer.from(part) : Buffer.concat([carry, part]);
          }
          if (newline === -1) break;
          const byteStart = consumedOffset;
          const byteEnd = scanOffset - remaining.length + newline + 1;
          lineNumber += 1;
          if (oversizedBytes > 0) {
            const message = boundedUtf8(`Canonical session line ${lineNumber} exceeds the ${maxRecordBytes}-byte record limit; ${oversizedBytes} source bytes were not interpreted`, maxErrorMessageBytes);
            errors.push({ code: "SESSION_HISTORY_RECORD_TOO_LARGE", message, retryable: false, line: lineNumber, byteStart, byteEnd, sourceId: `history-error-${lineNumber}` });
            oversizedBytes = 0;
          } else if (carry.length > 0) {
            try {
              entries.push(parseLine(carry, byteStart, byteEnd, lineNumber));
            } catch (error) {
              const typed = /** @type {SessionHistoryError} */ (error);
              errors.push({ code: typed.code, message: typed.message, retryable: false, line: lineNumber, byteStart, byteEnd, sourceId: fallbackSourceId(path, lineNumber, carry) });
            }
          } else {
            const message = boundedUtf8(`Canonical session line ${lineNumber} is empty`, maxErrorMessageBytes);
            errors.push({ code: "SESSION_HISTORY_PARSE_ERROR", message, retryable: false, line: lineNumber, byteStart, byteEnd, sourceId: `history-error-${lineNumber}` });
          }
          carry = Buffer.alloc(0);
          consumedOffset = byteEnd;
          remaining = remaining.subarray(newline + 1);
        }
      }
      return { entries, errors, position: { byteOffset: consumedOffset, line: lineNumber } };
    },
    position() { return { byteOffset: consumedOffset, line: lineNumber }; },
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

/** Read all currently complete lines from a canonical Pi JSONL session. @param {Parameters<typeof createSessionHistoryReader>[0]} options */
export async function readSessionHistory(options) {
  const reader = await createSessionHistoryReader(options);
  try {
    return await reader.read();
  } finally {
    await reader.close();
  }
}
