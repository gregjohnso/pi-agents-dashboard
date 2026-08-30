import { describe, expect, it } from "vitest";

import { LIST_COMMANDS, commandName, draftChoices, matchingListCommands, parseListCommand } from "./list-commands.mjs";

const choices = { models: ["anthropic/claude", "google/gemini"] };
const unknown = { models: [] };

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
        // With a catalog loaded, a model Pi does not offer is refused here rather than at launch.
        expect(parseListCommand("/model openai/gpt", choices)).toMatchObject({ kind: "rejected", code: "MODEL_UNKNOWN" });
    });
    it("opens a picker for a bare choice command and says so when it knows no values", () => {
        expect(parseListCommand("/model", choices)).toEqual({ kind: "pick_model" });
        expect(parseListCommand("/model", unknown)).toMatchObject({ kind: "rejected", code: "MODEL_CHOICES_UNKNOWN", message: expect.stringContaining("/model provider/id") });
        expect(parseListCommand("/model", { ...unknown, models: ["anthropic/claude"] })).toEqual({ kind: "pick_model" });
    });
    it.each(["/thinking", "/thinking high", "/thinking ludicrous"])("refuses %s, because the next launch selects no thinking level", (text) => {
        expect(parseListCommand(text, choices)).toMatchObject({ kind: "rejected", code: "UNKNOWN_LIST_COMMAND" });
    });
    it("names no thinking command in the launch menu and offers no thinking values", () => {
        expect(LIST_COMMANDS).not.toContain("/thinking");
        expect(matchingListCommands("/t")).toEqual([]);
        expect(draftChoices({ model: { provider: "anthropic", id: "opus" }, thinkingLevel: "max" }, [{ thinkingLevel: "high" }], { thinkingLevel: "low" })).toEqual({ models: ["anthropic/opus"] });
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
    it("sources model choices from the draft, the visible sessions, and the launch defaults", () => {
        const sessions = [
            { model: { provider: "google", id: "gemini" }, thinkingLevel: "off" },
            { model: { provider: "anthropic", id: "claude" } },
            { thinkingLevel: "high" },
            {},
        ];
        const draft = { model: { provider: "anthropic", id: "opus" } };
        const defaults = { model: { provider: "openai", id: "gpt" } };
        expect(draftChoices(draft, sessions, defaults)).toEqual({
            models: ["anthropic/claude", "anthropic/opus", "google/gemini", "openai/gpt"],
        });
        expect(draftChoices({ model: { provider: "", id: "" } }, [], undefined)).toEqual({ models: [] });
    });
    it("offers Pi's own catalog alongside what the frontend has seen, without duplicating either", () => {
        const catalog = [{ provider: "openai", id: "gpt-6", thinking: true }, { provider: "anthropic", id: "claude", thinking: true }, { provider: "", id: "", thinking: false }];
        const cold = draftChoices({ model: { provider: "", id: "" } }, [], undefined, catalog);
        expect(cold.models).toEqual(["anthropic/claude", "openai/gpt-6"]);
        const seen = draftChoices({ model: { provider: "anthropic", id: "claude" } }, [], undefined, catalog);
        expect(seen.models).toEqual(["anthropic/claude", "openai/gpt-6"]);
    });
    it("names why it has no models to offer and still takes a model typed in full", () => {
        const unavailable = { ...unknown, modelsUnavailable: { code: "MODEL_CATALOG_TIMEOUT", message: "Listing Pi models timed out" } };
        const rejected = parseListCommand("/model", unavailable);
        expect(rejected).toMatchObject({ kind: "rejected", code: "MODEL_CATALOG_TIMEOUT" });
        expect(rejected.message).toContain("Listing Pi models timed out");
        expect(rejected.message).toContain("/model provider/id");
        expect(parseListCommand("/model openai/gpt-6", unavailable)).toEqual({ kind: "set_model", model: { provider: "openai", id: "gpt-6" } });
    });
});

describe("model values checked against Pi's catalog", () => {
    const catalog = { models: ["anthropic/claude-opus-5", "openai-codex/gpt-5.6-sol"] };

    it("refuses a model the catalog does not list, naming it", () => {
        // The menu hint reads /model [provider/id]; typing it literally launched a session Pi killed.
        expect(parseListCommand("/model provider/id", catalog)).toMatchObject({ kind: "rejected", code: "MODEL_UNKNOWN", message: expect.stringContaining("provider/id") });
    });

    it("accepts a model the catalog lists", () => {
        expect(parseListCommand("/model anthropic/claude-opus-5", catalog)).toMatchObject({ kind: "set_model", model: { provider: "anthropic", id: "claude-opus-5" } });
    });

    it("accepts anything when the catalog is unavailable, so an offline daemon cannot block a launch", () => {
        expect(parseListCommand("/model local/whatever", { models: [] })).toMatchObject({ kind: "set_model", model: { provider: "local", id: "whatever" } });
    });
});
