const REPLAY_STAGES = new Set(["RECEIVED", "RPC_WRITE_STARTED", "RPC_ACKNOWLEDGED", "DELIVERY_UNKNOWN", "FAILED"]);

/** Validate one worker replay record using the recovery contract. @param {unknown} value @returns {value is Record<string, any>} */
export function validateWorkerReplayRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return typeof record.clientId === "string" && record.clientId.length > 0 &&
    typeof record.requestId === "string" && record.requestId.length > 0 &&
    typeof record.op === "string" && REPLAY_STAGES.has(/** @type {string} */ (record.stage)) &&
    typeof record.at === "string";
}
