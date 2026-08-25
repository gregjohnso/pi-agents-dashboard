import { constants } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionHistoryReader } from "./session-history.mjs";

/** @type {string[]} */
const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

/** @param {string[]} lines */
async function fixture(lines) {
  const directory = await mkdtemp(join(tmpdir(), "session-history-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  const bytes = Buffer.from(lines.join("\n"), "utf8");
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, bytes };
}

const records = [
  { type: "session", version: 3, id: "session-1", timestamp: "2026-08-25T00:00:00.000Z", cwd: "/repo" },
  { type: "message", id: "user-1", parentId: null, timestamp: "2026-08-25T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", data: "private-base64", mimeType: "image/png" }], attachments: [{ id: "file-1", type: "file", fileName: "notes.txt", mimeType: "text/plain", size: 12 }] } },
  { type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-08-25T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: "answer" }, { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "notes.txt" } }] } },
  { type: "message", id: "result-1", parentId: "assistant-1", timestamp: "2026-08-25T00:00:03.000Z", message: { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false } },
  { type: "custom_message", id: "custom-1", parentId: "result-1", timestamp: "2026-08-25T00:00:04.000Z", customType: "example", content: "visible", display: true },
  { type: "future_entry", id: "future-1", parentId: "custom-1", timestamp: "2026-08-25T00:00:05.000Z", private: "not-for-viewer" },
];

/** @param {unknown} value */
function line(value) { return JSON.stringify(value); }

describe("canonical Pi session history", () => {
  it("reads literal public JSONL formats without changing source bytes and returns stable byte/line positions", async () => {
    const { path, bytes } = await fixture([...records.map(line), ""]);
    const reader = await createSessionHistoryReader({ path });
    const first = await reader.read();
    const second = await reader.read();

    expect(first.entries.map(({ entry }) => entry)).toEqual(records);
    expect(first.entries.map(({ sourceId }) => sourceId)).toEqual(records.map((entry) => entry.id));
    expect(first.entries[1].position).toMatchObject({ line: 2, byteStart: Buffer.byteLength(`${line(records[0])}\n`), byteEnd: Buffer.byteLength(`${line(records[0])}\n${line(records[1])}\n`) });
    expect(Buffer.concat(first.entries.map(({ rawBytes }) => Buffer.concat([rawBytes, Buffer.from("\n")])))).toEqual(bytes);
    expect(second).toEqual({ entries: [], errors: [], position: first.position });
    expect(await readFile(path)).toEqual(bytes);
    await reader.close();
  });

  it("advances only across complete appended lines and preserves deterministic fallback source IDs", async () => {
    const entry = { type: "message", parentId: null, timestamp: "2026-08-25T00:00:00.000Z", message: { role: "user", content: "hello" } };
    const { path } = await fixture([line(entry)]);
    const reader = await createSessionHistoryReader({ path });
    expect((await reader.read()).entries).toEqual([]);
    await appendFile(path, "\n");
    const completed = await reader.read();
    expect(completed.entries).toHaveLength(1);
    expect(completed.entries[0].sourceId).toMatch(/^history-/u);
    expect((await reader.read()).position).toEqual(completed.position);
    await reader.close();
  });

  it("opens with no-follow and rejects pathname/descriptor identity replacement", async () => {
    const { path } = await fixture([`${line(records[0])}\n`]);
    const close = vi.fn(async () => {});
    const openImpl = vi.fn(async (_path, flags) => ({ stat: async () => ({ dev: 2, ino: 2, isFile: () => true }), close }));
    await expect(createSessionHistoryReader({
      path,
      fsOps: {
        open: openImpl,
        lstat: async () => ({ dev: 1, ino: 1, isFile: () => true, isSymbolicLink: () => false }),
        realpath: async () => path,
      },
    })).rejects.toMatchObject({ code: "SESSION_HISTORY_UNSAFE" });
    expect(openImpl).toHaveBeenCalledWith(path, expect.any(Number));
    expect(openImpl.mock.calls[0][1] & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports bounded typed parse errors without exposing malformed source text", async () => {
    const malformed = `{\"secret\":\"${"x".repeat(10_000)}\"`;
    const { path, bytes } = await fixture([malformed, line(records[0]), ""]);
    const reader = await createSessionHistoryReader({ path, maxErrorMessageBytes: 128 });
    const result = await reader.read();

    expect(result.entries).toHaveLength(1);
    expect(result.errors).toEqual([expect.objectContaining({ code: "SESSION_HISTORY_PARSE_ERROR", line: 1, byteStart: 0, byteEnd: Buffer.byteLength(`${malformed}\n`), retryable: false })]);
    expect(Buffer.byteLength(result.errors[0].message)).toBeLessThanOrEqual(128);
    expect(result.errors[0].message).not.toContain("secret");
    expect(await readFile(path)).toEqual(bytes);
    await reader.close();
  });
});
