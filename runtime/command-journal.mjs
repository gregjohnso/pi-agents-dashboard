// @ts-nocheck
import { open } from "node:fs/promises";

const MAX_RECORD_BYTES = 1024 * 1024;

export class CommandJournalError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "CommandJournalError"; this.code = code; }
}

function keyOf(value) { return `${value.clientId}\u0000${value.requestId}`; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function assertKey(key) {
  if (!key || typeof key.clientId !== "string" || !key.clientId || typeof key.requestId !== "string" || !key.requestId) throw new TypeError("Request key requires exact clientId and requestId");
}

/** Create an append-only, fsync-backed durable command journal. */
export async function createCommandJournal({ path, now = () => new Date().toISOString(), failpoint = () => {} }) {
  const handle = await open(path, "a+", 0o600);
  await handle.chmod(0o600);
  const text = await handle.readFile("utf8");
  const records = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new CommandJournalError("JOURNAL_CORRUPT", "Journal record exceeds limit");
    try { records.push(JSON.parse(line)); } catch (cause) { throw new CommandJournalError("JOURNAL_CORRUPT", `Malformed command journal: ${cause instanceof Error ? cause.message : "invalid JSON"}`); }
  }
  const byKey = new Map();
  for (const record of records) {
    const list = byKey.get(keyOf(record.status)) ?? [];
    list.push(record); byKey.set(keyOf(record.status), list);
  }
  let tail = Promise.resolve();
  async function append(record) {
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) - 1 > MAX_RECORD_BYTES) throw new CommandJournalError("RECORD_TOO_LARGE", "Command journal record exceeds limit");
    await handle.write(line, null, "utf8");
    await failpoint("before_sync", record);
    await handle.sync();
    const list = byKey.get(keyOf(record.status)) ?? [];
    list.push(record); byKey.set(keyOf(record.status), list);
    await failpoint("after_sync", record);
    return record.status;
  }
  function serialize(action) { const result = tail.then(action); tail = result.catch(() => {}); return result; }
  function current(key) { const list = byKey.get(keyOf(key)); return list?.at(-1); }

  for (const list of byKey.values()) {
    const previous = list.at(-1);
    if (previous.status.stage === "DELIVERY_ATTEMPTED") {
      await append({ commandCanonical: previous.commandCanonical, command: previous.command, status: { ...previous.status, stage: "DELIVERY_UNKNOWN", updatedAt: now() } });
    }
  }

  return {
    accept(command) { return serialize(async () => {
      assertKey(command);
      const existing = current(command);
      if (existing) {
        if (existing.commandCanonical !== canonical(command)) throw new CommandJournalError("IDEMPOTENCY_CONFLICT", "Request IDs were already used with a different command");
        return existing.status;
      }
      const timestamp = now();
      return append({ commandCanonical: canonical(command), command, status: { clientId: command.clientId, requestId: command.requestId, operation: command.op, stage: "ACCEPTED", acceptedAt: timestamp, updatedAt: timestamp } });
    }); },
    transition(key, allowed, next, error) { return serialize(async () => {
      assertKey(key); const previous = current(key);
      if (!previous) throw new CommandJournalError("COMMAND_NOT_FOUND", "Command was not accepted");
      if (previous.status.stage === "DELIVERY_UNKNOWN") throw new CommandJournalError("DELIVERY_UNKNOWN_REQUIRES_RESOLUTION", "Ambiguous delivery requires retry_at_risk or abandon");
      if (!allowed.includes(previous.status.stage)) throw new CommandJournalError("INVALID_TRANSITION", `Cannot transition from ${previous.status.stage}`);
      const status = { ...previous.status, stage: next, updatedAt: now() };
      if (error !== undefined) status.error = error; else delete status.error;
      return append({ commandCanonical: previous.commandCanonical, command: previous.command, status });
    }); },
    resolveDelivery(key, resolution) { return serialize(async () => {
      assertKey(key); const previous = current(key);
      if (!previous || previous.status.stage !== "DELIVERY_UNKNOWN") throw new CommandJournalError("INVALID_DELIVERY_RESOLUTION", "Only DELIVERY_UNKNOWN may be explicitly resolved");
      if (resolution !== "retry_at_risk" && resolution !== "abandon") throw new CommandJournalError("INVALID_DELIVERY_RESOLUTION", "Resolution must be retry_at_risk or abandon");
      const status = { ...previous.status, stage: resolution === "retry_at_risk" ? "ACCEPTED" : "FAILED", updatedAt: now() };
      if (resolution === "abandon") status.error = { code: "DELIVERY_ABANDONED", message: "Delivery was explicitly abandoned", retryable: false }; else delete status.error;
      return append({ commandCanonical: previous.commandCanonical, command: previous.command, status });
    }); },
    async get(key) { await tail; assertKey(key); return current(key)?.status; },
    async history(key) { await tail; assertKey(key); return (byKey.get(keyOf(key)) ?? []).map((record) => record.status); },
    async close() { await tail; await handle.close(); },
  };
}
