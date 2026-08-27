import { describe, expect, it } from "vitest";

import { sessionEventForPiEvent } from "./session-event-mapping.mjs";
import { reduceSessionState } from "./state-reducer.mjs";

const at = "2026-08-25T12:00:00.000Z";

/**
 * One run as recorded under ~/.local/state/pi-dashboard/runs/*\/diagnostics/rpc.*.jsonl: every run
 * in every recording is `agent_start (turn_start turn_end)+ agent_end agent_settled`, with 1 to 35
 * turns per run.
 */
const RECORDED_RUN = ["agent_start", "turn_start", "turn_end", "turn_start", "turn_end", "turn_start", "turn_end", "agent_end", "agent_settled"];

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

  it("holds a recorded run WORKING from its first event until Pi settles it", () => {
    let record = /** @type {any} */ ({ schemaVersion: 1, revision: 0, sessionId: "run", sessionFile: "/sessions/run.jsonl", canonicalSessionFile: "/sessions/run.jsonl", cwd: "/repo", taskState: "READY", processState: "LIVE", outcome: "NONE", activity: { kind: "idle", summary: "Idle", updatedAt: at }, createdAt: at, updatedAt: at });
    /** @type {string[]} */
    const states = [];
    for (const type of RECORDED_RUN) {
      const event = sessionEventForPiEvent({ type });
      if (event !== undefined) record = reduceSessionState(record, { ...event, at });
      states.push(record.taskState);
    }
    expect(states).toEqual(["WORKING", "WORKING", "WORKING", "WORKING", "WORKING", "WORKING", "WORKING", "WORKING", "READY"]);
  });

  it("reports activity without changing task state", () => {
    expect(sessionEventForPiEvent({ type: "tool_execution_start", toolName: "bash" })).toMatchObject({ type: "ACTIVITY_SNAPSHOT", tool: { summary: "bash" } });
    expect(sessionEventForPiEvent({ type: "message_update" })).toMatchObject({ type: "ACTIVITY_SNAPSHOT" });
    expect(sessionEventForPiEvent({ type: "extension_ui_request" })).toMatchObject({ type: "UI_REQUESTED" });
    expect(sessionEventForPiEvent({ type: "text_delta" })).toBeUndefined();
  });
});
