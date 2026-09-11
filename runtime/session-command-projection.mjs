/** Project one validated session_command payload onto the exact request a worker delivers to Pi. */

/**
 * Both delivery paths project here. The launch channel once rebuilt this inline and kept only a
 * subset of the fields, so a command carrying any other one reached the worker stripped and was
 * refused there. One mapping is the fix: a new variant becomes deliverable on both paths at once.
 * @param {any} payload
 */
export function sessionCommandPayload(payload) {
  if (payload.command === "set_model") return { command: "set_model", model: { ...payload.model } };
  if (payload.command === "set_thinking_level") return { command: "set_thinking_level", level: payload.level };
  if (payload.command === "set_session_name") return { command: "set_session_name", name: payload.name };
  if (payload.command === "abort_retry") return { command: "abort_retry" };
  return payload.instructions === undefined ? { command: "compact" } : { command: "compact", instructions: payload.instructions };
}
