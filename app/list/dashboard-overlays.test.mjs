import { describe, expect, it } from "vitest";
import { createSessionConfirmation, describeOverlay, } from "./dashboard-overlays.mjs";
const session = {
    schemaVersion: 1,
    revision: 2,
    sessionId: "session-1",
    sessionFile: "/sessions/session-1.jsonl",
    canonicalSessionFile: "/sessions/session-1.jsonl",
    cwd: "/repo",
    model: { provider: "anthropic", id: "claude" },
    thinkingLevel: "high",
    taskState: "READY",
    processState: "LIVE",
    outcome: "READY_FOR_REVIEW",
    activity: { kind: "assistant_final", summary: "Ready for review", updatedAt: "2026-08-25T12:00:00.000Z" },
    createdAt: "2026-08-25T11:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
};
describe("dashboard overlays", () => {
    it("binds Stop/Delete confirmation to exact session identity, revision, state, and action", () => {
        const stop = createSessionConfirmation(session);
        expect(stop).toMatchObject({ kind: "session_confirmation", action: "stop", sessionId: "session-1", revision: 2, processState: "LIVE" });
        const sleeping = { ...session, processState: "SLEEPING" };
        expect(createSessionConfirmation(sleeping).action).toBe("stop");
        const staleOwned = {
            ...session,
            processState: "STALE",
            ownership: {
                kind: "managed",
                runId: "run-1",
                process: { pid: 10, startIdentity: "100", processGroupId: 10 },
                acquiredAt: session.createdAt,
                heartbeatAt: session.updatedAt,
            },
        };
        expect(createSessionConfirmation(staleOwned).action).toBe("stop");
        expect(createSessionConfirmation({ ...staleOwned, ownership: undefined }).action).toBe("delete");
        const exited = createSessionConfirmation({ ...session, processState: "EXITED" });
        expect(exited.action).toBe("delete");
        // Clearing a session the operator just stopped reads differently from an unprompted Delete.
        expect(describeOverlay({ ...exited, clearingStopped: true }).title).toBe("Clear stopped session");
        expect(describeOverlay(exited).title).toBe("Confirm DELETE");
    });
});
