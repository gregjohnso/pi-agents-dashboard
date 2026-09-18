import { describe, expect, it } from "vitest";

import { LIST_COMMANDS, commandName, draftChoices, matchingListCommands, parseListCommand } from "./list-commands.mjs";

const choices = { models: ["anthropic/claude", "google/gemini"] };
const unknown = { models: [] };

describe("list slash commands", () => {
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
    it.each(["/thinking high"])("refuses %s, because the next launch selects no thinking level", (text) => {
        expect(parseListCommand(text, choices)).toMatchObject({ kind: "rejected", code: "UNKNOWN_LIST_COMMAND" });
    });
    it("names both isolation modes and refuses anything else", () => {
        expect(parseListCommand("/isolation worktree", choices)).toEqual({ kind: "set_isolation", isolationMode: "worktree" });
        expect(parseListCommand("/isolation shared", choices)).toEqual({ kind: "set_isolation", isolationMode: "shared_directory" });
        expect(parseListCommand("/isolation shared_directory", choices)).toEqual({ kind: "set_isolation", isolationMode: "shared_directory" });
        expect(parseListCommand("/isolation", choices)).toEqual({ kind: "pick_isolation" });
        expect(parseListCommand("/isolation sandbox", choices)).toMatchObject({ kind: "rejected", code: "UNKNOWN_ISOLATION_MODE", message: expect.stringContaining("sandbox") });
    });
    it("refuses an unknown command by name and lists the known ones", () => {
        for (const text of ["/modle anthropic/claude", "/login"]) {
            const rejected = parseListCommand(text, choices);
            expect(rejected).toMatchObject({ kind: "rejected", code: "UNKNOWN_LIST_COMMAND", message: expect.stringContaining(text.split(" ")[0]) });
            for (const known of LIST_COMMANDS) expect(rejected.message).toContain(known);
        }
    });
});

describe("model values checked against Pi's catalog", () => {
    const catalog = { models: ["anthropic/claude-opus-5", "openai-codex/gpt-5.6-sol"] };

    it("refuses a model the catalog does not list, naming it", () => {
        // The menu hint reads /model [provider/id]; typing it literally launched a session Pi killed.
        expect(parseListCommand("/model provider/id", catalog)).toMatchObject({ kind: "rejected", code: "MODEL_UNKNOWN", message: expect.stringContaining("provider/id") });
    });

    it("accepts anything when the catalog is unavailable, so an offline daemon cannot block a launch", () => {
        expect(parseListCommand("/model local/whatever", { models: [] })).toMatchObject({ kind: "set_model", model: { provider: "local", id: "whatever" } });
    });
});
