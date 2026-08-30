import { SESSION_COLORS } from "../../shared/contracts.mjs";

/** @typedef {{name:string,source:string,description?:string,argumentHint?:string}} MenuCommand */
/** @typedef {{commands:MenuCommand[],models:{provider:string,id:string}[],model:{provider:string,id:string}|null,summaryModel?:{provider:string,id:string}|null,name?:string|null,color?:string|null}} SessionMenu */

const BUILTIN_SOURCE = "builtin";
const DEFAULT_COLOR = "default";
// Pi rebinds its running process to another session file for these; the dashboard binds one worker to one
// canonical file, so it refuses by name rather than desynchronising the registry and the viewer stream.
const REBIND_COMMANDS = { "/fork": "fork", "/clone": "clone", "/switch": "switch_session" };

/** @type {SessionMenu} */
export const EMPTY_SESSION_MENU = { commands: [], models: [], model: null, summaryModel: null };

/** @param {{provider:string,id:string}} model */
function modelValue(model) {
  return `${model.provider}/${model.id}`;
}

/** @param {string} prefix @param {string[]} values */
function completions(prefix, values) {
  const needle = prefix.trim().toLowerCase();
  return values.filter((value) => value.toLowerCase().includes(needle)).map((value) => ({ value, label: value }));
}

/** @param {string} name */
function bareName(name) {
  return name.startsWith("/") ? name.slice(1) : name;
}

/**
 * Build the viewer editor's command list. Pi's autocomplete re-adds the leading slash,
 * so every name here is bare.
 * @param {SessionMenu} menu
 * @returns {{name:string,description?:string,argumentHint?:string,source:string,getArgumentCompletions?:(prefix:string)=>{value:string,label:string}[]}[]}
 */
export function sessionSlashCommands(menu) {
  const models = menu.models.map(modelValue);
  const builtins = [
    { name: "model", description: menu.model === null ? "Select the session model" : `Model: ${modelValue(menu.model)}`, argumentHint: "<provider/id>", source: BUILTIN_SOURCE, getArgumentCompletions: (prefix) => completions(prefix, models) },
    { name: "model-summary", description: menu.summaryModel == null ? "Dashboard summaries: off" : `Dashboard summaries: ${modelValue(menu.summaryModel)}`, argumentHint: "<provider/id|off>", source: BUILTIN_SOURCE, getArgumentCompletions: (prefix) => completions(prefix, ["off", ...models]) },
    { name: "rename", description: menu.name == null ? "Name this session" : `Name: ${menu.name}`, argumentHint: "<name>", source: BUILTIN_SOURCE },
    { name: "color", description: menu.color == null ? "Set this session's dashboard color" : `Color: ${menu.color}`, argumentHint: "<color>", source: BUILTIN_SOURCE, getArgumentCompletions: (prefix) => completions(prefix, [DEFAULT_COLOR, ...SESSION_COLORS]) },
    { name: "compact", description: "Compact the conversation", argumentHint: "[instructions]", source: BUILTIN_SOURCE },
    { name: "abort-retry", description: "Stop an in-progress retry without stopping the session", source: BUILTIN_SOURCE },
    { name: "new", description: "Open the dashboard's New Session composer", source: BUILTIN_SOURCE },
    { name: "resume", description: "Return to the dashboard session list", source: BUILTIN_SOURCE },
    { name: "fork", description: "Unavailable: forking rebinds Pi's session file", source: BUILTIN_SOURCE },
    { name: "clone", description: "Unavailable: cloning rebinds Pi's session file", source: BUILTIN_SOURCE },
    { name: "help", description: "List the viewer's commands and keys", source: BUILTIN_SOURCE },
  ];
  const builtinNames = new Set(builtins.map((command) => command.name));
  return [
    ...builtins,
    ...menu.commands
      .map((command) => ({ ...command, name: bareName(command.name) }))
      .filter((command) => !builtinNames.has(command.name)),
  ];
}

/**
 * Resolve one submitted editor line into a prompt or an exact session command.
 * @param {string} text
 * @param {SessionMenu} menu
 * @returns {{kind:"prompt",text:string}|{kind:"session_command",payload:Record<string,any>}|{kind:"settings",payload:Record<string,any>}|{kind:"session_color",color:string|null}|{kind:"dashboard",action:"new_session"|"session_list"}|{kind:"help"}|{kind:"rejected",code:string,message:string}}
 */
export function parseSlashSubmission(text, menu) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "prompt", text: trimmed };
  const separator = trimmed.search(/\s/u);
  const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const argument = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (name === "/model") {
    if (argument.length === 0) return { kind: "rejected", code: "MODEL_REQUIRED", message: menu.models.length === 0 ? "This session reported no models. Stop and reopen it to refresh Pi's command menu." : `Choose a model: ${menu.models.map(modelValue).join(", ")}` };
    const selected = menu.models.find((model) => modelValue(model) === argument);
    if (selected === undefined) return { kind: "rejected", code: "UNKNOWN_MODEL", message: `Unknown model: ${argument}` };
    return { kind: "session_command", payload: { command: "set_model", model: { ...selected } } };
  }
  if (name === "/model-summary") {
    if (argument.length === 0) return { kind: "rejected", code: "SUMMARY_MODEL_REQUIRED", message: menu.models.length === 0 ? "This session reported no models. Stop and reopen it to refresh Pi's command menu." : `Choose a summary model or off: ${menu.models.map(modelValue).join(", ")}` };
    if (argument === "off") return { kind: "settings", payload: { summaryModel: null } };
    const selected = menu.models.find((model) => modelValue(model) === argument);
    if (selected === undefined) return { kind: "rejected", code: "UNKNOWN_MODEL", message: `Unknown model: ${argument}` };
    return { kind: "settings", payload: { summaryModel: { ...selected } } };
  }
  if (name === "/rename") {
    if (argument.length === 0) return { kind: "rejected", code: "SESSION_NAME_REQUIRED", message: "Type a session name: /rename <name>" };
    if (argument.length > 128) return { kind: "rejected", code: "SESSION_NAME_TOO_LONG", message: "Session names are limited to 128 characters" };
    return { kind: "session_command", payload: { command: "set_session_name", name: argument } };
  }
  if (name === "/color") {
    if (argument.length === 0) return { kind: "rejected", code: "SESSION_COLOR_REQUIRED", message: `Choose a color: ${[DEFAULT_COLOR, ...SESSION_COLORS].join(", ")}` };
    if (argument === DEFAULT_COLOR) return { kind: "session_color", color: null };
    if (!SESSION_COLORS.includes(argument)) return { kind: "rejected", code: "UNKNOWN_SESSION_COLOR", message: `Unknown color: ${argument}. Choose ${[DEFAULT_COLOR, ...SESSION_COLORS].join(", ")}` };
    return { kind: "session_color", color: argument };
  }
  if (name === "/compact") {
    return { kind: "session_command", payload: argument.length === 0 ? { command: "compact" } : { command: "compact", instructions: argument } };
  }
  if (name === "/abort-retry") return { kind: "session_command", payload: { command: "abort_retry" } };
  if (name === "/new") return { kind: "dashboard", action: "new_session" };
  if (name === "/resume") return { kind: "dashboard", action: "session_list" };
  if (name === "/help") return { kind: "help" };
  if (Object.hasOwn(REBIND_COMMANDS, name)) {
    return {
      kind: "rejected", code: "SESSION_REBIND_UNSUPPORTED",
      message: `${name} needs Pi's ${REBIND_COMMANDS[name]}, which rebinds this process to a different session file. The dashboard binds one worker to one session file, so it would lose track of this session. Use /new for a fresh session.`,
    };
  }
  return { kind: "prompt", text: trimmed };
}
