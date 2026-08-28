/** @typedef {{models:string[],thinkingLevels:string[]}} DraftChoices */
/** @typedef {{name:string,argumentHint:string,summary:string}} ListCommand */

/** The dashboard's own commands. Each one configures the next launch; none of them reaches a session. */
export const LIST_COMMAND_MENU = [
    { name: "/model", argumentHint: "[provider/id]", summary: "model for the next session" },
    { name: "/thinking", argumentHint: "[level]", summary: "thinking level for the next session" },
    { name: "/cwd", argumentHint: "<path>", summary: "working directory for the next session" },
    { name: "/isolation", argumentHint: "[worktree|shared]", summary: "worktree or shared directory" },
    { name: "/name", argumentHint: "[text]", summary: "session name; empty lets the agent name it" },
    { name: "/help", argumentHint: "", summary: "the dashboard's keys and commands" },
];
export const LIST_COMMANDS = LIST_COMMAND_MENU.map((command) => command.name);
export const EMPTY_DRAFT_CHOICES = Object.freeze({ models: Object.freeze([]), thinkingLevels: Object.freeze([]) });

const ISOLATION_MODES = { worktree: "worktree", shared: "shared_directory", shared_directory: "shared_directory" };
const MAX_SESSION_NAME = 128;

/** Split one submitted line into its command name and the rest. @param {string} text */
function split(text) {
    const trimmed = text.trim();
    const separator = trimmed.search(/\s/u);
    return separator === -1
        ? { name: trimmed, argument: "" }
        : { name: trimmed.slice(0, separator), argument: trimmed.slice(separator + 1).trim() };
}

/** The command word of a submitted line, or undefined when the line is a prompt. @param {string} text */
export function commandName(text) {
    const { name } = split(text);
    return name.startsWith("/") ? name : undefined;
}

/**
 * The commands a partially typed line still admits. A line that already carries an argument
 * matches only the command it names, so the menu stops offering alternatives.
 * @param {string} text @returns {ListCommand[]}
 */
export function matchingListCommands(text) {
    const { name, argument } = split(text);
    if (!name.startsWith("/")) return [];
    if (argument !== "") return LIST_COMMAND_MENU.filter((command) => command.name === name);
    return LIST_COMMAND_MENU.filter((command) => command.name.startsWith(name));
}

/** @param {{provider?:string,id?:string}|undefined} model */
function modelValue(model) {
    return model === undefined || !model.provider || !model.id ? undefined : `${model.provider}/${model.id}`;
}

/**
 * The values this frontend can offer without asking the daemon or a worker: the draft's own value,
 * whatever the session records in memory report, and the launch defaults.
 * @param {any} draft @param {any[]} sessions @param {any} [defaults] @returns {DraftChoices}
 */
export function draftChoices(draft, sessions, defaults) {
    const sources = [draft, ...sessions, defaults ?? {}];
    const models = new Set();
    const thinkingLevels = new Set();
    for (const source of sources) {
        const model = modelValue(source?.model);
        if (model !== undefined) models.add(model);
        if (typeof source?.thinkingLevel === "string" && source.thinkingLevel !== "") thinkingLevels.add(source.thinkingLevel);
    }
    return { models: [...models].sort(), thinkingLevels: [...thinkingLevels].sort() };
}

/** @param {string} code @param {string} message @returns {{kind:"rejected",code:string,message:string}} */
function rejected(code, message) {
    return { kind: "rejected", code, message };
}

/**
 * Resolve one submitted list prompt into a draft edit, a picker, or a refusal.
 * A slash prompt never launches and never touches an existing session.
 * @param {string} text @param {DraftChoices} choices
 * @returns {{kind:"not_a_command"}|{kind:"set_model",model:{provider:string,id:string}}|{kind:"pick_model"}|{kind:"set_thinking",level:string}|{kind:"pick_thinking"}|{kind:"set_cwd",path:string}|{kind:"set_isolation",isolationMode:string}|{kind:"pick_isolation"}|{kind:"set_name",name:string}|{kind:"help"}|{kind:"rejected",code:string,message:string}}
 */
export function parseListCommand(text, choices) {
    const { name, argument } = split(text);
    if (!name.startsWith("/")) return { kind: "not_a_command" };
    if (name === "/model") {
        if (argument === "") {
            return choices.models.length === 0
                ? rejected("MODEL_CHOICES_UNKNOWN", "No model is known here yet. Type /model provider/id.")
                : { kind: "pick_model" };
        }
        const separator = argument.indexOf("/");
        const provider = argument.slice(0, separator);
        const id = argument.slice(separator + 1);
        if (separator === -1 || provider === "" || id === "") return rejected("MODEL_FORMAT_REQUIRED", `Name the provider too: /model provider/id, not ${argument}`);
        return { kind: "set_model", model: { provider, id } };
    }
    if (name === "/thinking") {
        if (argument === "") {
            return choices.thinkingLevels.length === 0
                ? rejected("THINKING_CHOICES_UNKNOWN", "No thinking level is known here yet. Type /thinking <level>.")
                : { kind: "pick_thinking" };
        }
        return { kind: "set_thinking", level: argument };
    }
    if (name === "/cwd") {
        if (argument === "") return rejected("CWD_REQUIRED", "Type a directory: /cwd <path>");
        return { kind: "set_cwd", path: argument };
    }
    if (name === "/isolation") {
        if (argument === "") return { kind: "pick_isolation" };
        const isolationMode = ISOLATION_MODES[argument];
        if (isolationMode === undefined) return rejected("UNKNOWN_ISOLATION_MODE", `Unknown isolation mode: ${argument}. Choose worktree or shared.`);
        return { kind: "set_isolation", isolationMode };
    }
    if (name === "/name") {
        if (argument.length > MAX_SESSION_NAME) return rejected("SESSION_NAME_TOO_LONG", `Session names are limited to ${MAX_SESSION_NAME} characters`);
        return { kind: "set_name", name: argument };
    }
    if (name === "/help") return { kind: "help" };
    return rejected("UNKNOWN_LIST_COMMAND", `Unknown command: ${name}. Known: ${LIST_COMMANDS.join(" ")}`);
}
