import { describe, expect, it } from "vitest";
import { createChoiceOverlay, createCommandMenuOverlay, createSessionConfirmation, describeOverlay, } from "./dashboard-overlays.mjs";
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
    it("describes the command menu with its highlight, argument hints, and no match", () => {
        const described = describeOverlay(createCommandMenuOverlay("/", 1));
        expect(described.title).toBe("Commands");
        expect(described.rows[0].text.startsWith("❯")).toBe(false);
        expect(described.rows[1].text).toContain("❯");
        expect(described.rows[1].text).toContain("/thinking [level]");
        expect(describeOverlay(createCommandMenuOverlay("/zz", 0)).rows[0].text).toContain("/model");
    });
    it("windows a long picker around the selected value and counts it in the title", () => {
        const values = Array.from({ length: 20 }, (_, index) => `provider/model-${index}`);
        const described = describeOverlay(createChoiceOverlay("model", "Model", values, "provider/model-15"), { choiceRows: 5 });
        expect(described.title).toBe("Model 16/20");
        expect(described.rows).toHaveLength(6);
        expect(described.rows.some((row) => row.text.includes("❯ provider/model-15"))).toBe(true);
        expect(described.rows.at(-1)).toMatchObject({ emphasis: true });
    });
    it("starts a picker on the current value, or on the first when it is unset", () => {
        expect(createChoiceOverlay("isolation", "Isolation", ["worktree", "shared_directory"], "shared_directory")).toMatchObject({ kind: "choice", field: "isolation", index: 1 });
        expect(createChoiceOverlay("thinking", "Thinking", ["high", "off"], "").index).toBe(0);
    });
});
