import { describe, expect, it } from "vitest";

import { LIST_COMMANDS, commandName, draftChoices, matchingListCommands, parseListCommand } from "./list-commands.mjs";

const choices = { models: ["anthropic/claude", "google/gemini"], thinkingLevels: ["off", "high"] };
const unknown = { models: [], thinkingLevels: [] };

describe("list slash commands", () => {
    it("leaves a prompt that does not begin with a slash alone", () => {
        expect(parseListCommand("fix the failing test", choices)).toEqual({ kind: "not_a_command" });
        expect(commandName("fix the failing test")).toBeUndefined();
        expect(commandName("  /model anthropic/claude ")).toBe("/model");
        expect(commandName("/")).toBe("/");
    });
    it("offers every command for a bare slash and narrows as the name is typed", () => {
        expect(matchingListCommands("/").map((command) => command.name)).toEqual(LIST_COMMANDS);
        expect(matchingListCommands("/m").map((command) => command.name)).toEqual(["/model"]);
        expect(matchingListCommands("/h")[0]).toMatchObject({ name: "/help", summary: expect.any(String) });
        expect(matchingListCommands("/zz")).toEqual([]);
        expect(matchingListCommands("  /mo").map((command) => command.name)).toEqual(["/model"]);
        // An argument means the operator has chosen; the menu stops offering alternatives.
        expect(matchingListCommands("/model anthropic/claude").map((command) => command.name)).toEqual(["/model"]);
    });
    it("sets an exact model and requires the provider/id form", () => {
        expect(parseListCommand("/model google/gemini", choices)).toEqual({ kind: "set_model", model: { provider: "google", id: "gemini" } });
        expect(parseListCommand("/model google", choices)).toMatchObject({ kind: "rejected", code: "MODEL_FORMAT_REQUIRED" });
        // The choices are only what this frontend has seen, so an unseen model is typed text, not an error.
        expect(parseListCommand("/model openai/gpt", choices)).toEqual({ kind: "set_model", model: { provider: "openai", id: "gpt" } });
    });
    it("opens a picker for a bare choice command and says so when it knows no values", () => {
        expect(parseListCommand("/model", choices)).toEqual({ kind: "pick_model" });
        expect(parseListCommand("/thinking", choices)).toEqual({ kind: "pick_thinking" });
        expect(parseListCommand("/model", unknown)).toMatchObject({ kind: "rejected", code: "MODEL_CHOICES_UNKNOWN", message: expect.stringContaining("/model provider/id") });
        expect(parseListCommand("/thinking", unknown)).toMatchObject({ kind: "rejected", code: "THINKING_CHOICES_UNKNOWN", message: expect.stringContaining("/thinking") });
    });
    it("sets any typed thinking level", () => {
        expect(parseListCommand("/thinking high", choices)).toEqual({ kind: "set_thinking", level: "high" });
        expect(parseListCommand("/thinking xhigh", choices)).toEqual({ kind: "set_thinking", level: "xhigh" });
    });
    it("carries a working directory through for the caller to check", () => {
        expect(parseListCommand("/cwd /repo/alpha", choices)).toEqual({ kind: "set_cwd", path: "/repo/alpha" });
        expect(parseListCommand("/cwd", choices)).toMatchObject({ kind: "rejected", code: "CWD_REQUIRED" });
    });
    it("names both isolation modes and refuses anything else", () => {
        expect(parseListCommand("/isolation worktree", choices)).toEqual({ kind: "set_isolation", isolationMode: "worktree" });
        expect(parseListCommand("/isolation shared", choices)).toEqual({ kind: "set_isolation", isolationMode: "shared_directory" });
        expect(parseListCommand("/isolation shared_directory", choices)).toEqual({ kind: "set_isolation", isolationMode: "shared_directory" });
        expect(parseListCommand("/isolation", choices)).toEqual({ kind: "pick_isolation" });
        expect(parseListCommand("/isolation sandbox", choices)).toMatchObject({ kind: "rejected", code: "UNKNOWN_ISOLATION_MODE", message: expect.stringContaining("sandbox") });
    });
    it("names the next session or clears the name so the agent picks one", () => {
        expect(parseListCommand("/name Coverage loader", choices)).toEqual({ kind: "set_name", name: "Coverage loader" });
        expect(parseListCommand("/name", choices)).toEqual({ kind: "set_name", name: "" });
        expect(parseListCommand(`/name ${"n".repeat(129)}`, choices)).toMatchObject({ kind: "rejected", code: "SESSION_NAME_TOO_LONG" });
    });
    it("opens the help overlay", () => {
        expect(parseListCommand("/help", choices)).toEqual({ kind: "help" });
    });
    it("refuses an unknown command by name and lists the known ones", () => {
        for (const text of ["/modle anthropic/claude", "/login"]) {
            const rejected = parseListCommand(text, choices);
            expect(rejected).toMatchObject({ kind: "rejected", code: "UNKNOWN_LIST_COMMAND", message: expect.stringContaining(text.split(" ")[0]) });
            for (const known of LIST_COMMANDS) expect(rejected.message).toContain(known);
        }
    });
    it("sources model and thinking choices from the draft, the visible sessions, and the launch defaults", () => {
        const sessions = [
            { model: { provider: "google", id: "gemini" }, thinkingLevel: "off" },
            { model: { provider: "anthropic", id: "claude" } },
            { thinkingLevel: "high" },
            {},
        ];
        const draft = { model: { provider: "anthropic", id: "opus" }, thinkingLevel: "max" };
        const defaults = { model: { provider: "openai", id: "gpt" }, thinkingLevel: "low" };
        expect(draftChoices(draft, sessions, defaults)).toEqual({
            models: ["anthropic/claude", "anthropic/opus", "google/gemini", "openai/gpt"],
            thinkingLevels: ["high", "low", "max", "off"],
        });
        expect(draftChoices({ model: { provider: "", id: "" }, thinkingLevel: "" }, [], undefined)).toEqual({ models: [], thinkingLevels: [] });
    });
});
