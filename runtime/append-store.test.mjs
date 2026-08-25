import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDurableAppendStore } from "./append-store.mjs";

/** @type {string[]} */
const directories = [];

/** @returns {Promise<string>} */
async function path() {
  const directory = await mkdtemp(join(tmpdir(), "append-store-"));
  directories.push(directory);
  return join(directory, "records.jsonl");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable append store", () => {
  it("rejects writes and syncs after an incomplete append", async () => {
    const storePath = await path();
    const probe = await open(storePath, "a", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalWrite = prototype.write;
    let writeAttempt = 0;
    const write = vi.spyOn(prototype, "write").mockImplementation(function (buffer) {
      writeAttempt += 1;
      if (writeAttempt === 1) return originalWrite.call(this, /** @type {Buffer} */ (buffer).subarray(0, 3));
      return Promise.resolve({ bytesWritten: 0, buffer });
    });
    const sync = vi.spyOn(prototype, "sync");
    const store = await openDurableAppendStore({ path: storePath, maxRecordBytes: 1024 });
    sync.mockClear();
    try {
      await expect(store.write({ value: 1 })).rejects.toMatchObject({ name: "AppendStoreError", code: "WRITE_STALLED" });
      await expect(store.write({ value: 2 })).rejects.toMatchObject({ name: "AppendStoreError", code: "STORE_FAILED" });
      await expect(store.sync()).rejects.toMatchObject({ name: "AppendStoreError", code: "STORE_FAILED" });
      expect(write).toHaveBeenCalledTimes(2);
      expect(sync).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      sync.mockRestore();
      await store.close();
    }
  });
});
