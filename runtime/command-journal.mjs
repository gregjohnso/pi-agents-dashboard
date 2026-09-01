import { openDurableAppendStore, AppendStoreError } from "./append-store.mjs";

const MAX_RECORD_BYTES = 1024 * 1024;

/** @typedef {import("../shared/contracts.mjs").ClientRequest} DurableCommand */
/** @typedef {import("../shared/contracts.mjs").CommandStage} CommandStage */
/** @typedef {import("../shared/contracts.mjs").CommandStatus} CommandStatus */
/** @typedef {import("../shared/contracts.mjs").DashboardError} DashboardError */
/** @typedef {{ clientId: string, requestId: string }} RequestKey */
/** @typedef {{ commandCanonical: string, command: DurableCommand, status: CommandStatus }} JournalRecord */
/** @typedef {(name: "before_sync" | "after_sync", record: JournalRecord) => void | Promise<void>} JournalFailpoint */

/** @type {Readonly<Record<CommandStage, ReadonlySet<CommandStage>>>} */
const TRANSITIONS = {
  ACCEPTED: new Set(["DELIVERY_ATTEMPTED", "FAILED"]),
  DELIVERY_ATTEMPTED: new Set(["WORKER_ACKNOWLEDGED", "DELIVERY_UNKNOWN"]),
  WORKER_ACKNOWLEDGED: new Set(["COMPLETED", "FAILED"]),
  COMPLETED: new Set(),
  DELIVERY_UNKNOWN: new Set(),
  FAILED: new Set(),
};

/** A durable command journal failure with a stable code. */
export class CommandJournalError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "CommandJournalError";
    this.code = code;
  }
}

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** @param {unknown} value @returns {asserts value is RequestKey} */
function assertKey(value) {
  if (typeof value !== "object" || value === null) throw new TypeError("Request key requires exact clientId and requestId");
  const key = /** @type {Partial<RequestKey>} */ (value);
  if (typeof key.clientId !== "string" || key.clientId.length === 0 || typeof key.requestId !== "string" || key.requestId.length === 0) {
    throw new TypeError("Request key requires exact clientId and requestId");
  }
}

/** @param {unknown} value @returns {value is JournalRecord} */
function isJournalRecord(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = /** @type {Partial<JournalRecord>} */ (value);
  if (typeof record.commandCanonical !== "string" || typeof record.command !== "object" || record.command === null || typeof record.status !== "object" || record.status === null) return false;
  return typeof record.status.clientId === "string" && typeof record.status.requestId === "string" && Object.hasOwn(TRANSITIONS, record.status.stage)
    && record.command.clientId === record.status.clientId && record.command.requestId === record.status.requestId;
}

/**
 * Create an append-only, fsync-backed durable command journal.
 *
 * @param {{ path: string, now?: () => string, failpoint?: JournalFailpoint }} options
 */
export async function createCommandJournal({ path, now = () => new Date().toISOString(), failpoint = () => {} }) {
  const store = await openDurableAppendStore({ path, maxRecordBytes: MAX_RECORD_BYTES });
  /** @type {Map<string, Map<string, JournalRecord[]>>} */
  const byClient = new Map();
  try {
    await store.recoverRecords((value) => {
      if (!isJournalRecord(value)) throw new CommandJournalError("JOURNAL_CORRUPT", "Command journal contains an invalid record");
      listFor(value.status, true).push(value);
    });
  } catch (cause) {
    await store.close();
    if (cause instanceof CommandJournalError) throw cause;
    throw new CommandJournalError("JOURNAL_CORRUPT", cause instanceof Error ? cause.message : "Command journal is corrupt", { cause });
  }

  let tail = Promise.resolve();

  /** @param {RequestKey} key @param {boolean} [create] @returns {JournalRecord[]} */
  function listFor(key, create = false) {
    let requests = byClient.get(key.clientId);
    if (requests === undefined && create) {
      requests = new Map();
      byClient.set(key.clientId, requests);
    }
    let list = requests?.get(key.requestId);
    if (list === undefined && create) {
      list = [];
      requests?.set(key.requestId, list);
    }
    return list ?? [];
  }

  /** @param {RequestKey} key @returns {JournalRecord | undefined} */
  function current(key) {
    return listFor(key).at(-1);
  }

  /** @param {JournalRecord} record @returns {Promise<CommandStatus>} */
  async function append(record) {
    try {
      await store.write(record);
      await failpoint("before_sync", record);
      await store.sync();
      listFor(record.status, true).push(record);
      await failpoint("after_sync", record);
      return record.status;
    } catch (cause) {
      if (cause instanceof AppendStoreError && cause.code === "RECORD_TOO_LARGE") {
        throw new CommandJournalError("RECORD_TOO_LARGE", "Command journal record exceeds limit", { cause });
      }
      throw cause;
    }
  }

  /** @template T @param {() => Promise<T>} action @returns {Promise<T>} */
  function serialize(action) {
    const result = tail.then(action);
    tail = result.then(() => {}, () => {});
    return result;
  }

  for (const requests of byClient.values()) {
    for (const list of requests.values()) {
      const previous = list.at(-1);
      if (previous?.status.stage === "DELIVERY_ATTEMPTED") {
        await append({
          commandCanonical: previous.commandCanonical,
          command: previous.command,
          status: { ...previous.status, stage: "DELIVERY_UNKNOWN", updatedAt: now() },
        });
      }
    }
  }

  return {
    /** Persist a terminal command fingerprint without scheduling command delivery. @param {DurableCommand} command @returns {Promise<{ status: CommandStatus, created: boolean }>} */
    tombstone(command) {
      return serialize(async () => {
        assertKey(command);
        const existing = current(command);
        if (existing !== undefined) {
          if (existing.commandCanonical !== canonical(command)) throw new CommandJournalError("IDEMPOTENCY_CONFLICT", "Request IDs were already used with a different command");
          return { status: existing.status, created: false };
        }
        const timestamp = now();
        const status = await append({
          commandCanonical: canonical(command),
          command,
          status: { clientId: command.clientId, requestId: command.requestId, operation: command.op, stage: "COMPLETED", acceptedAt: timestamp, updatedAt: timestamp },
        });
        return { status, created: true };
      });
    },
    /** @param {DurableCommand} command @returns {Promise<CommandStatus>} */
    accept(command) {
      return serialize(async () => {
        assertKey(command);
        const existing = current(command);
        if (existing !== undefined) {
          if (existing.commandCanonical !== canonical(command)) throw new CommandJournalError("IDEMPOTENCY_CONFLICT", "Request IDs were already used with a different command");
          return existing.status;
        }
        const timestamp = now();
        return append({
          commandCanonical: canonical(command),
          command,
          status: { clientId: command.clientId, requestId: command.requestId, operation: command.op, stage: "ACCEPTED", acceptedAt: timestamp, updatedAt: timestamp },
        });
      });
    },
    /** @param {RequestKey} key @param {readonly CommandStage[]} allowed @param {CommandStage} next @param {DashboardError} [error] @returns {Promise<CommandStatus>} */
    transition(key, allowed, next, error) {
      return serialize(async () => {
        assertKey(key);
        const previous = current(key);
        if (previous === undefined) throw new CommandJournalError("COMMAND_NOT_FOUND", "Command was not accepted");
        const stage = previous.status.stage;
        if (stage === "DELIVERY_UNKNOWN") throw new CommandJournalError("DELIVERY_UNKNOWN_REQUIRES_RESOLUTION", "Ambiguous delivery requires retry_at_risk or abandon");
        if (!allowed.includes(stage) || !TRANSITIONS[stage].has(next)) throw new CommandJournalError("INVALID_TRANSITION", `Cannot transition from ${stage} to ${next}`);
        const status = /** @type {CommandStatus} */ ({ ...previous.status, stage: next, updatedAt: now() });
        if (error !== undefined) status.error = error;
        else delete status.error;
        return append({ commandCanonical: previous.commandCanonical, command: previous.command, status });
      });
    },
    /** @param {RequestKey} key @param {import("../shared/contracts.mjs").DeliveryResolution} resolution @returns {Promise<CommandStatus>} */
    resolveDelivery(key, resolution) {
      return serialize(async () => {
        assertKey(key);
        const previous = current(key);
        if (previous?.status.stage !== "DELIVERY_UNKNOWN") throw new CommandJournalError("INVALID_DELIVERY_RESOLUTION", "Only DELIVERY_UNKNOWN may be explicitly resolved");
        const status = /** @type {CommandStatus} */ ({ ...previous.status, stage: resolution === "retry_at_risk" ? "ACCEPTED" : "FAILED", updatedAt: now() });
        if (resolution === "abandon") status.error = { code: "DELIVERY_ABANDONED", message: "Delivery was explicitly abandoned", retryable: false };
        else if (resolution === "retry_at_risk") delete status.error;
        else throw new CommandJournalError("INVALID_DELIVERY_RESOLUTION", "Resolution must be retry_at_risk or abandon");
        return append({ commandCanonical: previous.commandCanonical, command: previous.command, status });
      });
    },
    /** @param {RequestKey} key @returns {Promise<CommandStatus | undefined>} */
    async get(key) {
      await tail;
      assertKey(key);
      return current(key)?.status;
    },
    /** @param {RequestKey} key @returns {Promise<CommandStatus[]>} */
    async history(key) {
      await tail;
      assertKey(key);
      return listFor(key).map((record) => record.status);
    },
    async close() {
      await tail;
      await store.close();
    },
  };
}
