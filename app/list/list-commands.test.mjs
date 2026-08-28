import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { resolvePiExecutable } from "../../runtime/pi-executable.mjs";
import { LIST_COMMANDS, PI_THINKING_LEVELS, commandName, draftChoices, matchingListCommands, parseListCommand } from "./list-commands.mjs";

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
        expect(parseListCommand("/model", { ...unknown, models: ["anthropic/claude"] })).toEqual({ kind: "pick_model" });
        expect(parseListCommand("/thinking", unknown)).toMatchObject({ kind: "rejected", code: "THINKING_CHOICES_UNKNOWN", message: expect.stringContaining("/thinking") });
    });
    it("sets any typed thinking level, including one the scale does not name", () => {
        expect(parseListCommand("/thinking high", choices)).toEqual({ kind: "set_thinking", level: "high" });
        expect(parseListCommand("/thinking xhigh", choices)).toEqual({ kind: "set_thinking", level: "xhigh" });
        // The scale is what the picker offers, not a validator: Pi refuses an unknown level at launch.
        expect(parseListCommand("/thinking ludicrous", choices)).toEqual({ kind: "set_thinking", level: "ludicrous" });
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
            thinkingLevels: [...PI_THINKING_LEVELS],
        });
        expect(draftChoices({ model: { provider: "", id: "" }, thinkingLevel: "" }, [], undefined)).toEqual({ models: [], thinkingLevels: [...PI_THINKING_LEVELS] });
    });
    it("offers Pi's whole thinking scale in its own order, plus any level seen that it does not name", () => {
        const seen = draftChoices({ model: { provider: "", id: "" }, thinkingLevel: "ludicrous" }, [{ thinkingLevel: "high" }], undefined);
        expect(seen.thinkingLevels).toEqual([...PI_THINKING_LEVELS, "ludicrous"]);
    });
    it("offers Pi's own catalog alongside what the frontend has seen, without duplicating either", () => {
        const catalog = [{ provider: "openai", id: "gpt-6", thinking: true }, { provider: "anthropic", id: "claude", thinking: true }, { provider: "", id: "", thinking: false }];
        const cold = draftChoices({ model: { provider: "", id: "" }, thinkingLevel: "" }, [], undefined, catalog);
        expect(cold.models).toEqual(["anthropic/claude", "openai/gpt-6"]);
        const seen = draftChoices({ model: { provider: "anthropic", id: "claude" }, thinkingLevel: "" }, [], undefined, catalog);
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

/** Read `pi --help`. It runs no inference, opens no session, and writes nothing. @param {string} executable */
async function piHelp(executable) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, ["--help"], { stdio: ["ignore", "pipe", "pipe"], shell: false });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.once("error", reject);
        child.once("exit", (code) => { if (code === 0) resolve(stdout); else reject(new Error(`pi --help exited ${code}`)); });
    });
}

describe("installed pi thinking scale", () => {
    const upgradeNotice = "The installed pi no longer names exactly the thinking levels PI_THINKING_LEVELS lists in app/list/list-commands.mjs, verified against pi 0.84.3. Update the constant to Pi's own off-to-max order; do not invent one.";

    it("still names exactly the levels the list offers, in Pi's own order", async () => {
        // No skip when pi is missing: a canary that quietly stops running stops being a canary.
        const executable = await resolvePiExecutable({ pathEnv: process.env.PATH ?? "" });
        const line = (await piHelp(executable.realpath)).split("\n").find((row) => row.trimStart().startsWith("--thinking"));
        expect(line, upgradeNotice).toBeDefined();
        const levels = String(line).slice(String(line).indexOf(":") + 1).split(",").map((level) => level.trim()).filter((level) => level !== "");
        expect(levels, upgradeNotice).toEqual([...PI_THINKING_LEVELS]);
    });
});
