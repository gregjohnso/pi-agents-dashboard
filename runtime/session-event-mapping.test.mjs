import { describe, expect, it } from "vitest";

import { sessionEventForPiEvent } from "./session-event-mapping.mjs";

describe("Pi event to session state mapping", () => {
  it("marks a session working on every turn, not only on the run's first event", () => {
    // Pi emits agent_start once per run but turn_start per model call, so a run start that is
    // missed on reconnect must not leave the row stuck at READY.
    expect(sessionEventForPiEvent({ type: "agent_start" })).toMatchObject({ type: "TURN_STARTED" });
    expect(sessionEventForPiEvent({ type: "turn_start" })).toMatchObject({ type: "TURN_STARTED" });
  });

  it("settles only when Pi settles the whole run", () => {
    expect(sessionEventForPiEvent({ type: "agent_settled" })).toMatchObject({ type: "TURN_COMPLETED" });
    // A turn ends between tool calls while the run continues.
    expect(sessionEventForPiEvent({ type: "turn_end", message: {} })).toBeUndefined();
    expect(sessionEventForPiEvent({ type: "agent_end" })).toBeUndefined();
  });

  it("reports activity without changing task state", () => {
    expect(sessionEventForPiEvent({ type: "tool_execution_start", toolName: "bash" })).toMatchObject({ type: "ACTIVITY_SNAPSHOT", tool: { summary: "bash" } });
    expect(sessionEventForPiEvent({ type: "message_update" })).toMatchObject({ type: "ACTIVITY_SNAPSHOT" });
    expect(sessionEventForPiEvent({ type: "extension_ui_request" })).toMatchObject({ type: "UI_REQUESTED" });
    expect(sessionEventForPiEvent({ type: "text_delta" })).toBeUndefined();
  });
});
