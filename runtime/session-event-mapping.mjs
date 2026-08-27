/** Translate one Pi RPC event into the session-state event the daemon reduces, if any. */

/**
 * Pi emits `agent_start`/`agent_settled` once per run and `turn_start`/`turn_end` per model call.
 * Working state follows either start, so a run start missed during a reconnect cannot leave a row
 * stuck at READY; only `agent_settled` ends the run, because a turn ends between tool calls.
 * @param {Record<string, unknown>} event
 * @returns {any | undefined}
 */
export function sessionEventForPiEvent(event) {
  const at = new Date().toISOString();
  switch (event.type) {
    case "agent_start":
    case "turn_start":
      return { type: "TURN_STARTED", at };
    case "agent_settled":
      return { type: "TURN_COMPLETED", at };
    case "extension_ui_request":
      return { type: "UI_REQUESTED", at, summary: "Waiting for Pi extension input" };
    case "tool_execution_start":
      return { type: "ACTIVITY_SNAPSHOT", at, tool: { summary: typeof event.toolName === "string" ? event.toolName : "Pi tool running" } };
    case "message_update":
      return { type: "ACTIVITY_SNAPSHOT", at, assistantStream: { summary: "Pi assistant streaming" } };
    case "message_end":
      return { type: "ACTIVITY_SNAPSHOT", at, finalAssistant: { summary: "Pi assistant response received" } };
    default:
      return undefined;
  }
}
