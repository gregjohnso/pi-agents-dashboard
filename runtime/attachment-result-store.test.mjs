import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createAttachmentResultStore } from "./attachment-result-store.mjs";

/** @type {string[]} */
const directories = [];

async function storePath() {
  const directory = await mkdtemp(join(tmpdir(), "attachment-results-"));
  directories.push(directory);
  return join(directory, "results.jsonl");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const attach = { version: 1, clientId: "client", requestId: "request", op: "attach", payload: { sessionId: "session", role: "composer" } };
const attached = { ok: true, result: { kind: "attached", sessionId: "session", role: "composer" } };

describe("attachment result store", () => {
  it("recovers exact append-only outcomes and truncates a torn final record", async () => {
    const path = await storePath();
    const first = await createAttachmentResultStore({ path });
    await first.put(attach, attached);
    await first.close();
    await appendFile(path, '{"schemaVersion":1,"request"');

    const recovered = await createAttachmentResultStore({ path });
    expect(recovered.get(attach)).toEqual(attached);
    await recovered.close();
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  it("recovers a prepared response and permits one append-only failure completion", async () => {
    const path = await storePath();
    const first = await createAttachmentResultStore({ path });
    await first.prepare(attach, attached);
    await first.close();

    const recovered = await createAttachmentResultStore({ path });
    expect(recovered.get(attach)).toEqual(attached);
    const failed = { ok: false, error: { code: "BROADCAST_FAILED", message: "broadcast failed", retryable: false } };
    await recovered.put(attach, failed);
    await recovered.close();
    const completed = await createAttachmentResultStore({ path });
    expect(completed.get(attach)).toEqual(failed);
    await completed.close();
  });

  it("rejects conflicting requests and strict malformed durable records", async () => {
    const path = await storePath();
    const first = await createAttachmentResultStore({ path });
    await first.put(attach, attached);
    expect(() => first.get({ ...attach, payload: { sessionId: "session", role: "observer" } })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    await first.close();

    await appendFile(path, `${JSON.stringify({ schemaVersion: 1, phase: "COMPLETED", requestCanonical: "bad", request: attach, outcome: { ok: true, result: { ...attached.result, extra: true } } })}\n`);
    await expect(createAttachmentResultStore({ path })).rejects.toMatchObject({ code: "ATTACHMENT_RESULTS_CORRUPT" });
  });
});
