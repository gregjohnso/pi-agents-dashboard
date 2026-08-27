import { describe, expect, it } from "vitest";
import { createDeliveryUnknownOverlay, createHelpOverlay, createMetadataOverlay, createSessionConfirmation, createSessionIntent, createSharedDirectoryOverlay, } from "./dashboard-overlays.mjs";
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
    it("keeps task, process, outcome, and activity independent in metadata", () => {
        expect(createMetadataOverlay(session)).toMatchObject({
            kind: "metadata",
            sessionId: "session-1",
            fields: {
                taskState: "READY",
                processState: "LIVE",
                outcome: "READY_FOR_REVIEW",
                activity: "Ready for review",
            },
        });
    });
    it("returns typed help and exact-path shared warning surfaces", () => {
        expect(createHelpOverlay().kind).toBe("help");
        expect(createSharedDirectoryOverlay("/canonical/repo", ["a", "b"])).toEqual({
            kind: "shared_directory_confirmation",
            canonicalCwd: "/canonical/repo",
            ownerSessionIds: ["a", "b"],
            requiredInput: "/canonical/repo",
        });
    });
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
        expect(createSessionConfirmation({ ...session, processState: "EXITED" }).action).toBe("delete");
    });
    it("keeps the Task 13 intent seam aligned with the bound confirmation", () => {
        expect(createSessionIntent(session)).toEqual({ kind: "session_intent", action: "stop", sessionId: "session-1", revision: 2 });
        expect(createSessionIntent({ ...session, processState: "EXITED" })).toEqual({ kind: "session_intent", action: "delete", sessionId: "session-1", revision: 2 });
    });
    it("offers only explicit DELIVERY_UNKNOWN resolution actions", () => {
        expect(createDeliveryUnknownOverlay("client", "request")).toEqual({
            kind: "delivery_unknown",
            clientId: "client",
            requestId: "request",
            actions: ["retry_at_risk", "abandon"],
        });
    });
});
