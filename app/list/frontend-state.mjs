/**
 * Validate frontend persistence using the recovery contract.
 *
 * `cursor` is a retired key: this release replays no list history, so nothing reads it and nothing
 * writes it. It stays in the allowed set unchecked because a file an earlier release wrote still
 * carries one, and refusing that key would make the dashboard fail to open on its own saved state.
 * @param {any} state
 */
export function validateFrontendState(state) {
  const allowed = ["schemaVersion", "clientId", "cursor", "viewState", "launchDraft"];
  if (typeof state !== "object" || state === null || Array.isArray(state) || Object.keys(state).some((key) => !allowed.includes(key)) || state.schemaVersion !== 1 || typeof state.clientId !== "string" || state.clientId.length === 0 || typeof state.viewState !== "object" || state.viewState === null || Array.isArray(state.viewState) || typeof state.launchDraft !== "object" || state.launchDraft === null || Array.isArray(state.launchDraft)) throw Object.assign(new Error("Frontend state is malformed"), { code: "FRONTEND_STATE_CORRUPT" });
  return state;
}
