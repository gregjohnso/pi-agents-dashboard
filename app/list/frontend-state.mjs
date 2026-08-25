/** Validate frontend persistence using the recovery contract. @param {any} state */
export function validateFrontendState(state) {
  const allowed = ["schemaVersion", "clientId", "cursor", "viewState", "launchDraft"];
  if (typeof state !== "object" || state === null || Array.isArray(state) || Object.keys(state).some((key) => !allowed.includes(key)) || state.schemaVersion !== 1 || typeof state.clientId !== "string" || state.clientId.length === 0 || typeof state.viewState !== "object" || state.viewState === null || Array.isArray(state.viewState) || typeof state.launchDraft !== "object" || state.launchDraft === null || Array.isArray(state.launchDraft)) throw Object.assign(new Error("Frontend state is malformed"), { code: "FRONTEND_STATE_CORRUPT" });
  if (state.cursor !== undefined && (typeof state.cursor !== "object" || state.cursor === null || Array.isArray(state.cursor) || Object.keys(state.cursor).some((key) => !["daemonEpoch", "sequence"].includes(key)) || typeof state.cursor.daemonEpoch !== "string" || !/^(0|[1-9]\d*)$/u.test(state.cursor.sequence))) throw Object.assign(new Error("Frontend cursor is malformed"), { code: "FRONTEND_STATE_CORRUPT" });
  return state;
}
