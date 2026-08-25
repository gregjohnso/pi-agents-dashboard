import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";

const FILE_MODE = 0o600;
const READ_CHUNK_BYTES = 64 * 1024;

/** A hostile-path or corrupt-record failure in a durable append store. */
export class AppendStoreError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "AppendStoreError";
    this.code = code;
  }
}

/** @returns {number} */
function currentUid() {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Durable append stores require a POSIX user ID");
  return uid;
}

/** @param {import("node:fs/promises").FileHandle} handle @param {number} uid */
async function validateHandle(handle, uid) {
  const metadata = await handle.stat();
  if (!metadata.isFile()) throw new AppendStoreError("UNSAFE_STORE", "Durable append store must be a regular file");
  if (metadata.uid !== uid) throw new AppendStoreError("UNSAFE_STORE", "Durable append store has the wrong owner");
  if ((metadata.mode & 0o777) !== FILE_MODE) throw new AppendStoreError("UNSAFE_STORE", "Durable append store must have mode 0600");
}

/** @param {string} path */
async function syncParent(path) {
  const directory = await fs.open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Open an owner-validated, no-follow append store and recover one incomplete final record.
 *
 * @param {{ path: string, maxRecordBytes: number }} options
 */
export async function openDurableAppendStore({ path, maxRecordBytes }) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("path is required");
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new TypeError("maxRecordBytes must be a positive safe integer");
  const uid = currentUid();
  const baseFlags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW;
  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let handle;
  let created = false;
  try {
    try {
      handle = await fs.open(path, baseFlags | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
      created = true;
      await handle.chmod(FILE_MODE);
    } catch (error) {
      if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      handle = await fs.open(path, baseFlags);
    }
    await validateHandle(handle, uid);
    if (created) {
      await handle.sync();
      await syncParent(path);
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {});
    if (created) await fs.rm(path, { force: true }).catch(() => {});
    throw error;
  }

  /** @param {(record: unknown) => void} onRecord @returns {Promise<void>} */
  async function recoverRecords(onRecord) {
    if (handle === undefined) throw new AppendStoreError("STORE_CLOSED", "Durable append store is closed");
    if (typeof onRecord !== "function") throw new TypeError("onRecord is required");
    let carry = Buffer.alloc(0);
    let offset = 0;
    let completeOffset = 0;
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      let available = carry.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (;;) {
        const newline = available.indexOf(0x0a, start);
        if (newline === -1) break;
        const recordBytes = available.subarray(start, newline);
        if (recordBytes.length > maxRecordBytes) throw new AppendStoreError("RECORD_TOO_LARGE", "Persisted record exceeds its byte limit");
        if (recordBytes.length > 0) {
          let text;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(recordBytes);
          } catch (cause) {
            throw new AppendStoreError("STORE_CORRUPT", "Persisted record is not valid UTF-8", { cause });
          }
          let record;
          try {
            record = JSON.parse(text);
          } catch (cause) {
            throw new AppendStoreError("STORE_CORRUPT", "Persisted record contains malformed JSON", { cause });
          }
          onRecord(record);
        }
        completeOffset += newline - start + 1;
        start = newline + 1;
      }
      carry = Buffer.from(available.subarray(start));
      if (carry.length > maxRecordBytes) throw new AppendStoreError("RECORD_TOO_LARGE", "Persisted record exceeds its byte limit");
    }
    if (carry.length > 0) {
      await handle.truncate(completeOffset);
      await handle.sync();
    }
    return undefined;
  }

  return {
    recoverRecords,
    /** @param {unknown} record */
    async write(record) {
      if (handle === undefined) throw new AppendStoreError("STORE_CLOSED", "Durable append store is closed");
      const json = JSON.stringify(record);
      if (json === undefined) throw new TypeError("Append store record must be JSON serializable");
      const line = Buffer.from(`${json}\n`, "utf8");
      if (line.length - 1 > maxRecordBytes) throw new AppendStoreError("RECORD_TOO_LARGE", "Append store record exceeds its byte limit");
      await handle.write(line);
    },
    async sync() {
      if (handle === undefined) throw new AppendStoreError("STORE_CLOSED", "Durable append store is closed");
      await handle.sync();
    },
    async close() {
      if (handle === undefined) return;
      const closing = handle;
      handle = undefined;
      await closing.close();
    },
  };
}
