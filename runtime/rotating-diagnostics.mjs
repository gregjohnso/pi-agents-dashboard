import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_RPC_SEGMENT_BYTES = 8_388_608;
const DEFAULT_RPC_SEGMENTS = 4;
const DEFAULT_STDERR_BYTES = 8_388_608;
const HASH_PLACEHOLDER = "0".repeat(64);
const MIN_DIAGNOSTIC_SEGMENT_BYTES = Math.max(
  Buffer.byteLength(`${JSON.stringify({ type: "diagnostic_oversized_record", originalBytes: Number.MAX_SAFE_INTEGER, sha256: HASH_PLACEHOLDER })}\n`),
  Buffer.byteLength(`${JSON.stringify({ type: "diagnostic_truncation", removedBytes: Number.MAX_SAFE_INTEGER, removedRecords: Number.MAX_SAFE_INTEGER })}\n`),
);

/** @param {string | Uint8Array | Record<string, unknown>} record */
function encodeRecord(record) {
  if (typeof record === "string" || record instanceof Uint8Array) {
    const bytes = Buffer.from(record);
    return bytes.at(-1) === 0x0a ? bytes : Buffer.concat([bytes, Buffer.from("\n")]);
  }
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

/** @param {Buffer} bytes @param {number} limit */
function boundedRecord(bytes, limit) {
  if (bytes.length <= limit) return bytes;
  const metadata = Buffer.from(`${JSON.stringify({
    type: "diagnostic_oversized_record",
    originalBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })}\n`);
  if (metadata.length > limit) throw new RangeError("Diagnostic segment limit is too small for oversized-record metadata");
  return metadata;
}

/** @param {string} path */
async function recoverCompleteRecords(path) {
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.at(-1) === 0x0a) return bytes;
  const newline = bytes.lastIndexOf(0x0a);
  await truncate(path, newline === -1 ? 0 : newline + 1);
  return newline === -1 ? Buffer.alloc(0) : bytes.subarray(0, newline + 1);
}

/**
 * Open one private segmented diagnostic stream.
 * @param {{ directory: string, prefix: string, segmentBytes: number, segments: number }} options
 */
export async function openRotatingWriter({ directory, prefix, segmentBytes, segments }) {
  if (typeof directory !== "string" || typeof prefix !== "string" || prefix.length === 0) throw new TypeError("Diagnostic directory and prefix are required");
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes <= 0 || !Number.isSafeInteger(segments) || segments <= 0) throw new TypeError("Diagnostic limits must be positive integers");
  if (segmentBytes < MIN_DIAGNOSTIC_SEGMENT_BYTES || segmentBytes * segments > Number.MAX_SAFE_INTEGER) throw new RangeError("Diagnostic limits cannot retain bounded metadata");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const expression = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.(\\d+)\\.jsonl$`, "u");
  /** @type {{ index: number, path: string, bytes: number, records: number }[]} */
  const active = [];
  for (const name of await readdir(directory)) {
    const match = expression.exec(name);
    if (match === null) continue;
    const path = join(directory, name);
    await chmod(path, 0o600);
    const contents = await recoverCompleteRecords(path);
    active.push({ index: Number(match[1] ?? "0"), path, bytes: contents.length, records: contents.length === 0 ? 0 : contents.toString("utf8").split("\n").length - 1 });
  }
  active.sort((a, b) => a.index - b.index);
  while (active.length > segments) {
    const removed = active.shift();
    if (removed !== undefined) await rm(removed.path, { force: true });
  }
  let nextIndex = (active.at(-1)?.index ?? -1) + 1;
  let tail = Promise.resolve();
  let closed = false;

  async function createSegment() {
    const index = nextIndex++;
    const path = join(directory, `${prefix}.${String(index).padStart(8, "0")}.jsonl`);
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    const segment = { index, path, bytes: 0, records: 0 };
    active.push(segment);
    return segment;
  }

  async function removeOldest() {
    let removedBytes = 0;
    let removedRecords = 0;
    while (active.length >= segments) {
      const removed = active.shift();
      if (removed === undefined) break;
      removedBytes += removed.bytes;
      removedRecords += removed.records;
      await rm(removed.path, { force: true });
    }
    return { removedBytes, removedRecords };
  }

  /** @param {Buffer} bytes @param {any} segment */
  async function write(segment, bytes) {
    const handle = await open(segment.path, "a", 0o600);
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    segment.bytes += bytes.length;
    segment.records += 1;
  }

  /** @param {string | Uint8Array | Record<string, unknown>} record */
  async function appendNow(record) {
    const bytes = boundedRecord(encodeRecord(record), segmentBytes);
    let segment = active.at(-1);
    if (segment === undefined) segment = await createSegment();
    if (segment.bytes + bytes.length > segmentBytes) {
      const removed = await removeOldest();
      segment = await createSegment();
      if (removed.removedBytes > 0) {
        const markerRecord = { type: "diagnostic_truncation", ...removed };
        const marker = Buffer.from(`${JSON.stringify(markerRecord)}\n`);
        if (marker.length + bytes.length > segmentBytes) {
          const boundedMarker = Buffer.from(`${JSON.stringify({
            ...markerRecord,
            droppedIncomingBytes: bytes.length,
            droppedIncomingSha256: createHash("sha256").update(bytes).digest("hex"),
          })}\n`);
          if (marker.length > segmentBytes) throw new RangeError("Diagnostic segment limit is too small for truncation metadata");
          await write(segment, boundedMarker.length <= segmentBytes ? boundedMarker : marker);
          return;
        }
        await write(segment, marker);
      }
    }
    await write(segment, bytes);
  }

  return {
    /** @param {string | Uint8Array | Record<string, unknown>} record */
    append(record) {
      if (closed) return Promise.reject(new Error("Diagnostic writer is closed"));
      const result = tail.then(() => appendNow(record));
      tail = result.then(() => {}, () => {});
      return result;
    },
    async close() { closed = true; await tail; },
  };
}

/** Open the schema-2 RPC and stderr diagnostic limits for one run. @param {{ directory: string, rpcSegmentBytes?: number, rpcSegments?: number, stderrBytes?: number }} options */
export async function openRotatingDiagnostics({ directory, rpcSegmentBytes = DEFAULT_RPC_SEGMENT_BYTES, rpcSegments = DEFAULT_RPC_SEGMENTS, stderrBytes = DEFAULT_STDERR_BYTES }) {
  const rpc = await openRotatingWriter({ directory, prefix: "rpc", segmentBytes: rpcSegmentBytes, segments: rpcSegments });
  const stderr = await openRotatingWriter({ directory, prefix: "stderr", segmentBytes: stderrBytes, segments: 1 });
  return {
    rpc,
    stderr,
    async close() { await Promise.all([rpc.close(), stderr.close()]); },
  };
}
