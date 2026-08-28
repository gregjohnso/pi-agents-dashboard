import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CommandJournalError, createCommandJournal } from "./command-journal.mjs";

/** @typedef {import("../shared/contracts.mjs").ClientRequest} ClientRequest */

/** @type {string[]} */
const directories = [];
/** @type {ClientRequest} */
const command = { version: 1, clientId: "client-1", requestId: "request-1", op: "prompt", payload: { sessionId: "session-1", text: "hello" } };
/** @returns {Promise<string>} */
async function path() { const directory = await mkdtemp(join(tmpdir(), "journal-")); directories.push(directory); return join(directory, "commands.jsonl"); }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("command journal", () => {
  it("syncs acceptance before returning and returns the same status for an exact duplicate", async () => {
    const journalPath = await path();
    /** @type {string[]} */
    const boundaries = [];
    const journal = await createCommandJournal({ path: journalPath, now: () => "2026-01-01T00:00:00.000Z", failpoint: (name) => { boundaries.push(name); } });
    const accepted = await journal.accept(command);
    expect(accepted.stage).toBe("ACCEPTED");
    expect(boundaries).toEqual(["before_sync", "after_sync"]);
    await journal.close();
    const reopened = await createCommandJournal({ path: journalPath });
    expect(await reopened.accept(command)).toEqual(accepted);
    await reopened.close();
  });

  it("reconciles attachment result phases without weakening exact request identity", async () => {
    const journalPath = await path();
    /** @type {ClientRequest} */
    const attachment = { version: 1, clientId: "client-1", requestId: "attach-1", op: "attach", payload: { sessionId: "session-1", role: "composer" } };
    const journal = await createCommandJournal({ path: journalPath });
    await journal.accept(attachment);
    await journal.transition(attachment, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
    expect((await journal.reconcileAttachment(attachment, "PREPARED")).stage).toBe("DELIVERY_UNKNOWN");
    await expect(journal.reconcileAttachment({ ...attachment, payload: { ...attachment.payload, role: "observer" } }, "PREPARED")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await journal.close();

    const reopened = await createCommandJournal({ path: journalPath });
    expect((await reopened.reconcileAttachment(attachment, "COMPLETED")).stage).toBe("COMPLETED");
    await reopened.close();
  });

  it("recovers a synced acceptance when the response boundary fails", async () => {
    const journalPath = await path();
    const journal = await createCommandJournal({ path: journalPath, failpoint(name) { if (name === "after_sync") throw new Error("crash"); } });
    await expect(journal.accept(command)).rejects.toThrow("crash");
    await journal.close();
    const reopened = await createCommandJournal({ path: journalPath });
    expect((await reopened.get({ clientId: "client-1", requestId: "request-1" }))?.stage).toBe("ACCEPTED");
    await reopened.close();
  });

  it("preserves every acknowledgement boundary and gates ambiguous delivery resolution", async () => {
    const journal = await createCommandJournal({ path: await path() });
    await journal.accept(command);
    const key = { clientId: command.clientId, requestId: command.requestId };
    await journal.transition(key, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
    await journal.transition(key, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
    await expect(journal.transition(key, ["DELIVERY_UNKNOWN"], "WORKER_ACKNOWLEDGED")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN_REQUIRES_RESOLUTION" });
    expect((await journal.resolveDelivery(key, "retry_at_risk")).stage).toBe("ACCEPTED");
    await journal.transition(key, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
    await journal.transition(key, ["DELIVERY_ATTEMPTED"], "WORKER_ACKNOWLEDGED");
    await journal.transition(key, ["WORKER_ACKNOWLEDGED"], "COMPLETED");
    expect((await journal.history(key)).map(({ stage }) => stage)).toEqual(["ACCEPTED", "DELIVERY_ATTEMPTED", "DELIVERY_UNKNOWN", "ACCEPTED", "DELIVERY_ATTEMPTED", "WORKER_ACKNOWLEDGED", "COMPLETED"]);
    await journal.close();
  });

  it("recovers a delivery attempt without durable worker acknowledgement as DELIVERY_UNKNOWN", async () => {
    const journalPath = await path();
    const journal = await createCommandJournal({ path: journalPath });
    await journal.accept(command);
    const key = { clientId: command.clientId, requestId: command.requestId };
    await journal.transition(key, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
    await journal.close();
    const reopened = await createCommandJournal({ path: journalPath });
    expect((await reopened.get(key))?.stage).toBe("DELIVERY_UNKNOWN");
    expect((await reopened.history(key)).map(({ stage }) => stage)).toEqual(["ACCEPTED", "DELIVERY_ATTEMPTED", "DELIVERY_UNKNOWN"]);
    await reopened.close();
  });

  it("incrementally discards an incomplete final record after a crash", async () => {
    const journalPath = await path();
    const journal = await createCommandJournal({ path: journalPath });
    await journal.accept(command);
    await journal.close();
    await appendFile(journalPath, '{"commandCanonical":');
    const reopened = await createCommandJournal({ path: journalPath });
    expect(await reopened.get(command)).toMatchObject({ stage: "ACCEPTED" });
    await reopened.close();
  });

  it("only explicit abandon resolves delivery unknown", async () => {
    const journal = await createCommandJournal({ path: await path() });
    await journal.accept(command);
    const key = { clientId: command.clientId, requestId: command.requestId };
    await journal.transition(key, ["ACCEPTED"], "DELIVERY_ATTEMPTED");
    await journal.transition(key, ["DELIVERY_ATTEMPTED"], "DELIVERY_UNKNOWN");
    expect((await journal.resolveDelivery(key, "abandon")).stage).toBe("FAILED");
    await expect(journal.resolveDelivery(key, "abandon")).rejects.toBeInstanceOf(CommandJournalError);
    await journal.close();
  });
});
