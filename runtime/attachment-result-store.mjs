import { openDurableAppendStore, AppendStoreError } from "./append-store.mjs";

const MAX_RECORD_BYTES = 64 * 1024;

/** A durable attachment-result failure with a stable code. */
export class AttachmentResultStoreError extends Error {
  /** @param {string} code @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(code, message, options) {
    super(message, options);
    this.name = "AttachmentResultStoreError";
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

/** @param {unknown} value @param {readonly string[]} allowed */
function exactKeys(value, allowed) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === allowed.length
    && Object.keys(value).every((key) => allowed.includes(key));
}

/** @param {any} request */
function validRequest(request) {
  if (!exactKeys(request, ["version", "clientId", "requestId", "op", "payload"]) || request.version !== 1 || typeof request.clientId !== "string" || request.clientId.length === 0 || typeof request.requestId !== "string" || request.requestId.length === 0) return false;
  if (request.op === "attach") return exactKeys(request.payload, ["sessionId", "role"]) && typeof request.payload.sessionId === "string" && request.payload.sessionId.length > 0 && ["composer", "observer"].includes(request.payload.role);
  return request.op === "detach" && exactKeys(request.payload, ["sessionId"]) && typeof request.payload.sessionId === "string" && request.payload.sessionId.length > 0;
}

/** @param {any} outcome @param {any} request */
function validOutcome(outcome, request) {
  if (outcome?.ok === true) {
    if (!exactKeys(outcome, ["ok", "result"])) return false;
    if (request.op === "attach") return exactKeys(outcome.result, ["kind", "sessionId", "role"]) && outcome.result.kind === "attached" && outcome.result.sessionId === request.payload.sessionId && ["composer", "observer"].includes(outcome.result.role);
    return exactKeys(outcome.result, ["kind", "sessionId"]) && outcome.result.kind === "detached" && outcome.result.sessionId === request.payload.sessionId;
  }
  return outcome?.ok === false && exactKeys(outcome, ["ok", "error"]) && exactKeys(outcome.error, ["code", "message", "retryable"])
    && typeof outcome.error.code === "string" && outcome.error.code.length > 0 && typeof outcome.error.message === "string" && typeof outcome.error.retryable === "boolean";
}

/** @param {any} value */
export function validateAttachmentResultRecord(value) {
  return exactKeys(value, ["schemaVersion", "phase", "requestCanonical", "request", "outcome"])
    && value.schemaVersion === 1
    && ["PREPARED", "COMPLETED"].includes(value.phase)
    && typeof value.requestCanonical === "string"
    && validRequest(value.request)
    && value.requestCanonical === canonical(value.request)
    && validOutcome(value.outcome, value.request);
}

/** Open the strict append-only attachment response store. */
export async function createAttachmentResultStore(/** @type {{ path: string }} */ { path }) {
  const store = await openDurableAppendStore({ path, maxRecordBytes: MAX_RECORD_BYTES });
  const outcomes = new Map();
  const key = (/** @type {any} */ request) => `${request.clientId}\0${request.requestId}`;
  try {
    await store.recoverRecords((value) => {
      if (!validateAttachmentResultRecord(value)) throw new AttachmentResultStoreError("ATTACHMENT_RESULTS_CORRUPT", "Attachment result store contains an invalid record");
      const record = /** @type {any} */ (value);
      const existing = outcomes.get(key(record.request));
      const validTransition = existing === undefined || (existing.phase === "PREPARED" && record.phase === "COMPLETED" && existing.requestCanonical === record.requestCanonical);
      if (!validTransition) throw new AttachmentResultStoreError("ATTACHMENT_RESULTS_CORRUPT", "Attachment result store contains conflicting records");
      outcomes.set(key(record.request), record);
    });
  } catch (cause) {
    await store.close();
    if (cause instanceof AttachmentResultStoreError) throw cause;
    throw new AttachmentResultStoreError("ATTACHMENT_RESULTS_CORRUPT", cause instanceof Error ? cause.message : "Attachment result store is corrupt", { cause });
  }

  let tail = Promise.resolve();
  return {
    /** @param {any} request */
    get(request) {
      if (!validRequest(request)) throw new TypeError("Attachment result lookup requires a strict attachment request");
      const existing = outcomes.get(key(request));
      if (existing === undefined) return undefined;
      if (existing.requestCanonical !== canonical(request)) throw new AttachmentResultStoreError("IDEMPOTENCY_CONFLICT", "Request IDs were already used with a different attachment request");
      return existing.phase === "COMPLETED" ? structuredClone(existing.outcome) : undefined;
    },
    /** @param {any} request */
    phase(request) {
      if (!validRequest(request)) throw new TypeError("Attachment result lookup requires a strict attachment request");
      const existing = outcomes.get(key(request));
      if (existing === undefined) return undefined;
      if (existing.requestCanonical !== canonical(request)) throw new AttachmentResultStoreError("IDEMPOTENCY_CONFLICT", "Request IDs were already used with a different attachment request");
      return existing.phase;
    },
    entries() {
      return [...outcomes.values()].map((record) => ({ phase: record.phase, request: structuredClone(record.request) }));
    },
    /** @param {"PREPARED" | "COMPLETED"} phase @param {any} request @param {any} outcome */
    append(phase, request, outcome) {
      const operation = tail.then(async () => {
        if (!["PREPARED", "COMPLETED"].includes(phase) || !validRequest(request) || !validOutcome(outcome, request)) throw new TypeError("Attachment result record is invalid");
        const requestCanonical = canonical(request);
        const existing = outcomes.get(key(request));
        if (existing !== undefined && existing.requestCanonical !== requestCanonical) throw new AttachmentResultStoreError("IDEMPOTENCY_CONFLICT", "Attachment result conflicts with the durable request");
        if (phase === "PREPARED" && existing !== undefined) return structuredClone(existing.outcome);
        if (phase === "COMPLETED" && existing?.phase === "COMPLETED") {
          if (canonical(existing.outcome) !== canonical(outcome)) throw new AttachmentResultStoreError("IDEMPOTENCY_CONFLICT", "Attachment result conflicts with the durable request");
          return structuredClone(existing.outcome);
        }
        const record = { schemaVersion: 1, phase, requestCanonical, request: structuredClone(request), outcome: structuredClone(outcome) };
        try {
          await store.write(record);
          await store.sync();
        } catch (cause) {
          if (cause instanceof AppendStoreError && cause.code === "RECORD_TOO_LARGE") throw new AttachmentResultStoreError("RECORD_TOO_LARGE", "Attachment result record exceeds limit", { cause });
          throw cause;
        }
        outcomes.set(key(request), record);
        return structuredClone(outcome);
      });
      tail = operation.then(() => {}, () => {});
      return operation;
    },
    /** @param {any} request @param {any} outcome */
    prepare(request, outcome) { return this.append("PREPARED", request, outcome); },
    /** @param {any} request @param {any} outcome */
    put(request, outcome) { return this.append("COMPLETED", request, outcome); },
    async close() {
      await tail;
      await store.close();
    },
  };
}
