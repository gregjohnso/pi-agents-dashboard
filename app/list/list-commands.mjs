import { SESSION_COLOR_NAMES } from "../../runtime/native-sideband.mjs";
/** @typedef {{models:string[],modelsUnavailable?:{code:string,message:string}}} DraftChoices */
/** @typedef {{name:string,argumentHint:string,summary:string}} ListCommand */

/** Expand a leading `~`, which a shell would have expanded but the composer never sees. @param {string} path */
function expandHome(path) {
    const home = process.env.HOME;
    if (home === undefined || home === "") return path;
    if (path === "~") return home;
    return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/** The dashboard's own commands. Each one configures the next launch; none of them reaches a session. */
export const LIST_COMMAND_MENU = [
    { name: "/model", argumentHint: "[provider/id]", summary: "model for the next session" },
    { name: "/cwd", argumentHint: "<path>", summary: "working directory for the next session" },
    { name: "/isolation", argumentHint: "[worktree|shared]", summary: "worktree or shared directory" },
    { name: "/name", argumentHint: "[text]", summary: "session name; empty lets the agent name it" },
    { name: "/rename", argumentHint: "<new name>", summary: "rename the selected session" },
    { name: "/color", argumentHint: "<color>", summary: "color the selected session" },
    { name: "/help", argumentHint: "", summary: "the dashboard's keys and commands" },
];
export const LIST_COMMANDS = LIST_COMMAND_MENU.map((command) => command.name);
export const EMPTY_DRAFT_CHOICES = Object.freeze({ models: Object.freeze([]) });

const ISOLATION_MODES = { worktree: "worktree", shared: "shared_directory", shared_directory: "shared_directory" };
const MAX_SESSION_NAME = 128;
/**
 * Pi's own session commands, which belong to a session and not to this list.
 *
 * Reproducing the operator's report against the real launcher showed `/new` and `/resume` work exactly as Pi
 * intends once a session is open - a new identity, the same Pi process, input still landing in the editor. The
 * only thing that failed was typing them HERE, where the answer was "Unknown command", which is true and tells
 * the operator nothing. Naming them is not implementing them: the list still creates and resumes nothing, and
 * they are deliberately absent from `LIST_COMMAND_MENU` so nothing offers them as if this surface owned them.
 */
const PI_SESSION_COMMANDS = ["/new", "/resume"];
// The same class of characters the row renderer already refuses to print. A name is one line of display text,
// so a newline or an escape sequence in it is not a name.
const NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

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
 * The models a picker can offer: the draft's own value, whatever the session records in memory
 * report, the launch defaults, and Pi's own catalog when the caller has read it. A cold dashboard
 * has none of the first three, so the catalog is what makes its picker complete.
 * @param {any} draft @param {any[]} sessions @param {any} [defaults] @param {{provider:string,id:string}[]} [catalog] @returns {DraftChoices}
 */
export function draftChoices(draft, sessions, defaults, catalog = []) {
    const sources = [draft, ...sessions, defaults ?? {}];
    const models = new Set();
    for (const source of sources) {
        const model = modelValue(source?.model);
        if (model !== undefined) models.add(model);
    }
    for (const entry of catalog) {
        const model = modelValue(entry);
        if (model !== undefined) models.add(model);
    }
    return { models: [...models].sort() };
}

/** @param {string} code @param {string} message @returns {{kind:"rejected",code:string,message:string}} */
function rejected(code, message) {
    return { kind: "rejected", code, message };
}

/**
 * Resolve one submitted list prompt into a draft edit, a picker, a rename, or a refusal.
 * A slash prompt never launches. `/rename` is the only one that reaches an existing session.
 * @param {string} text @param {DraftChoices} choices
 * @returns {{kind:"not_a_command"}|{kind:"set_model",model:{provider:string,id:string}}|{kind:"pick_model"}|{kind:"set_cwd",path:string}|{kind:"set_isolation",isolationMode:string}|{kind:"pick_isolation"}|{kind:"set_name",name:string}|{kind:"rename_session",name:string}|{kind:"help"}|{kind:"rejected",code:string,message:string}}
 */
export function parseListCommand(text, choices) {
    const { name, argument } = split(text);
    if (!name.startsWith("/")) return { kind: "not_a_command" };
    if (name === "/model") {
        if (argument === "") {
            if (choices.models.length > 0) return { kind: "pick_model" };
            // A refusal names the daemon's own reason when there is one, so an empty picker is never mute.
            const unavailable = choices.modelsUnavailable;
            return unavailable === undefined
                ? rejected("MODEL_CHOICES_UNKNOWN", "No model is known here yet. Type /model provider/id.")
                : rejected(unavailable.code, `${unavailable.message}. Type /model provider/id.`);
        }
        const separator = argument.indexOf("/");
        const provider = argument.slice(0, separator);
        const id = argument.slice(separator + 1);
        if (separator === -1 || provider === "" || id === "") return rejected("MODEL_FORMAT_REQUIRED", `Name the provider too: /model provider/id, not ${argument}`);
        // Checked only when the catalog loaded: an unknown model launches a session Pi kills on startup,
        // and the hint text itself, provider/id, is the value operators type first.
        if (choices.models.length > 0 && !choices.models.includes(argument))
            return rejected("MODEL_UNKNOWN", `Pi does not offer ${argument}. Press Enter on /model to pick one.`);
        return { kind: "set_model", model: { provider, id } };
    }
    if (name === "/cwd") {
        if (argument === "") return rejected("CWD_REQUIRED", "Type a directory: /cwd <path>");
        return { kind: "set_cwd", path: expandHome(argument) };
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
    // `/rename` is the one command here that reaches an EXISTING session. It never launches one and never
    // touches the next launch's name, which is still what `/name` sets. `split` keeps everything after the
    // command word, so the spaces inside a name survive.
    if (name === "/rename") {
        if (argument === "") return rejected("SESSION_RENAME_NAME_REQUIRED", "Type a name: /rename <new name>");
        if (argument.length > MAX_SESSION_NAME) return rejected("SESSION_NAME_TOO_LONG", `Session names are limited to ${MAX_SESSION_NAME} characters`);
        if (NAME_CONTROL_CHARACTERS.test(argument)) return rejected("SESSION_NAME_NOT_PRINTABLE", "A session name cannot contain control characters");
        return { kind: "rename_session", name: argument };
    }
    if (name === "/color") {
        const color = argument.toLowerCase();
        if (color === "") return rejected("SESSION_COLOR_REQUIRED", `Type a color: /color <${SESSION_COLOR_NAMES.join("|")}>`);
        if (!SESSION_COLOR_NAMES.includes(color)) return rejected("SESSION_COLOR_UNKNOWN", `Unknown color ${argument}. Use ${SESSION_COLOR_NAMES.join(", ")}.`);
        return { kind: "color_session", color };
    }
    if (name === "/help") return { kind: "help" };
    // Pi's own, and answered with the gesture that reaches them rather than a dead end.
    if (PI_SESSION_COMMANDS.includes(name)) {
        return rejected(
            "PI_SESSION_COMMAND",
            `${name} is Pi's own command and runs inside a session, not in this list. Open one with Enter or \u2192, then type ${name} there.`,
        );
    }
    return rejected("UNKNOWN_LIST_COMMAND", `Unknown command: ${name}. Known: ${LIST_COMMANDS.join(" ")}`);
}
