import { describe, expect, it } from "vitest";
import { createChoiceOverlay, createCommandMenuOverlay, createHelpOverlay, createPathCompletionOverlay, createSessionConfirmation, describeOverlay, filterChoiceOverlay, } from "./dashboard-overlays.mjs";
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
        expect(described.rows[1].text).toContain("/cwd <path>");
        expect(described.rows.every((/** @type {{text:string}} */ row) => !row.text.includes("/thinking"))).toBe(true);
        expect(describeOverlay(createCommandMenuOverlay("/zz", 0)).rows[0].text).toContain("/model");
    });
    it("draws directory completions like the command menu and bounds how many rows it takes", () => {
        const items = [{ value: "alpha/", label: "alpha/" }, { value: "alpine/", label: "alpine/" }];
        const described = describeOverlay(createPathCompletionOverlay(items, "al", 1), { completionRows: 8 });
        expect(described.rows.map((row) => row.text)).toEqual(["  alpha/", "❯ alpine/"]);
        const many = Array.from({ length: 60 }, (_, index) => ({ value: `dir-${index}/`, label: `dir-${index}/` }));
        const windowed = describeOverlay(createPathCompletionOverlay(many, "", 40), { completionRows: 4 });
        // A directory of sixty children may not push the session list off the screen.
        expect(windowed.rows).toHaveLength(4);
        expect(windowed.rows.some((row) => row.text === "❯ dir-40/")).toBe(true);
    });
    it("windows a long picker around the selected value and counts it in the title", () => {
        const values = Array.from({ length: 20 }, (_, index) => `provider/model-${index}`);
        const described = describeOverlay(createChoiceOverlay("model", "Model", values, "provider/model-15"), { choiceRows: 5 });
        expect(described.title).toBe("Model 16/20");
        expect(described.rows).toHaveLength(6);
        expect(described.rows.some((row) => row.text.includes("❯ provider/model-15"))).toBe(true);
        expect(described.rows.at(-1)).toMatchObject({ emphasis: true });
    });
    it("draws one windowful of a catalog-sized picker rather than every row", () => {
        const values = Array.from({ length: 300 }, (_, index) => `provider/model-${index}`);
        const described = describeOverlay(createChoiceOverlay("model", "Model", values, "provider/model-299"), { choiceRows: 8 });
        expect(described.title).toBe("Model 300/300");
        expect(described.rows).toHaveLength(9);
        expect(described.rows.some((row) => row.text.includes("❯ provider/model-299"))).toBe(true);
    });
    it("narrows a picker to what the operator types and keeps the highlight it can", () => {
        const values = ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4", "google/gemini-3-pro", "openai/gpt-6"];
        const overlay = createChoiceOverlay("model", "Model", values, "google/gemini-3-pro");
        expect(overlay).toMatchObject({ filter: "", index: 2 });
        const narrowed = filterChoiceOverlay(overlay, "CLAUDE");
        expect(narrowed.values).toEqual(["anthropic/claude-opus-4", "anthropic/claude-sonnet-4"]);
        expect(describeOverlay(narrowed, { choiceRows: 8 }).title).toBe("Model 1/2 · CLAUDE");
        const widened = filterChoiceOverlay(narrowed, "");
        expect(widened.values).toEqual(values);
        expect(widened.values[widened.index]).toBe("anthropic/claude-opus-4");
    });
    it("says a picker matches nothing instead of drawing an empty frame", () => {
        const empty = filterChoiceOverlay(createChoiceOverlay("model", "Model", ["anthropic/claude"], "anthropic/claude"), "zzz");
        expect(empty.values).toEqual([]);
        const described = describeOverlay(empty, { choiceRows: 8 });
        expect(described.title).toBe("Model 0/0 · zzz");
        expect(described.rows[0]).toMatchObject({ text: expect.stringContaining("zzz"), emphasis: true });
    });
    it("names only keys the list still answers", () => {
        const bindings = createHelpOverlay().bindings;
        const keys = bindings.map((binding) => binding.keys);
        // Ctrl+J is the line-feed byte, which the list answers as Enter. Tab no longer moves a
        // launch-field cursor: every launch field is set through its slash command, and Tab now
        // only completes the directory typed after /cwd.
        expect(keys.join(" ")).not.toContain("Ctrl+J");
        expect(bindings.find((binding) => binding.keys === "Tab")?.action).toContain("/cwd");
        expect(keys.join(" ")).toContain("Ctrl+W");
        // Thinking is Pi's to set, so the help text offers no key or command for it.
        expect(createHelpOverlay().bindings.map((binding) => `${binding.keys} ${binding.action}`).join(" ")).not.toContain("thinking");
    });
    it("starts a picker on the current value, or on the first when it is unset", () => {
        expect(createChoiceOverlay("isolation", "Isolation", ["worktree", "shared_directory"], "shared_directory")).toMatchObject({ kind: "choice", field: "isolation", index: 1 });
        expect(createChoiceOverlay("model", "Model", ["anthropic/claude", "openai/gpt"], "").index).toBe(0);
    });
});
