/** @typedef {{name:string,source:string,description?:string,argumentHint?:string}} MenuCommand */
/** @typedef {{commands:MenuCommand[],models:{provider:string,id:string}[],thinkingLevels:string[],model:{provider:string,id:string}|null,thinkingLevel:string|null}} SessionMenu */

const BUILTIN_SOURCE = "builtin";

/** @type {SessionMenu} */
export const EMPTY_SESSION_MENU = { commands: [], models: [], thinkingLevels: [], model: null, thinkingLevel: null };

/** @param {{provider:string,id:string}} model */
function modelValue(model) {
  return `${model.provider}/${model.id}`;
}

/** @param {string} prefix @param {string[]} values */
function completions(prefix, values) {
  const needle = prefix.trim().toLowerCase();
  return values.filter((value) => value.toLowerCase().includes(needle)).map((value) => ({ value, label: value }));
}

/**
 * Build the public slash-command menu shown by the viewer editor.
 * @param {SessionMenu} menu
 * @returns {{name:string,description?:string,argumentHint?:string,source:string,getArgumentCompletions?:(prefix:string)=>{value:string,label:string}[]}[]}
 */
export function sessionSlashCommands(menu) {
  const models = menu.models.map(modelValue);
  return [
    { name: "/model", description: menu.model === null ? "Select the session model" : `Model: ${modelValue(menu.model)}`, argumentHint: "<provider/id>", source: BUILTIN_SOURCE, getArgumentCompletions: (prefix) => completions(prefix, models) },
    { name: "/thinking", description: menu.thinkingLevel === null ? "Set the thinking level" : `Thinking: ${menu.thinkingLevel}`, argumentHint: "<level>", source: BUILTIN_SOURCE, getArgumentCompletions: (prefix) => completions(prefix, menu.thinkingLevels) },
    { name: "/compact", description: "Compact the conversation", argumentHint: "[instructions]", source: BUILTIN_SOURCE },
    ...menu.commands.filter((command) => !["/model", "/thinking", "/compact"].includes(command.name)),
  ];
}

/**
 * Resolve one submitted editor line into a prompt or an exact session command.
 * @param {string} text
 * @param {SessionMenu} menu
 * @returns {{kind:"prompt",text:string}|{kind:"session_command",payload:Record<string,any>}|{kind:"rejected",code:string,message:string}}
 */
export function parseSlashSubmission(text, menu) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "prompt", text: trimmed };
  const separator = trimmed.search(/\s/u);
  const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const argument = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (name === "/model") {
    if (argument.length === 0) return { kind: "rejected", code: "MODEL_REQUIRED", message: `Choose a model: ${menu.models.map(modelValue).join(", ") || "no models reported"}` };
    const selected = menu.models.find((model) => modelValue(model) === argument);
    if (selected === undefined) return { kind: "rejected", code: "UNKNOWN_MODEL", message: `Unknown model: ${argument}` };
    return { kind: "session_command", payload: { command: "set_model", model: { ...selected } } };
  }
  if (name === "/thinking") {
    if (argument.length === 0) return { kind: "rejected", code: "THINKING_LEVEL_REQUIRED", message: `Choose a thinking level: ${menu.thinkingLevels.join(", ") || "no levels reported"}` };
    if (!menu.thinkingLevels.includes(argument)) return { kind: "rejected", code: "UNKNOWN_THINKING_LEVEL", message: `Unknown thinking level: ${argument}` };
    return { kind: "session_command", payload: { command: "set_thinking_level", level: argument } };
  }
  if (name === "/compact") {
    return { kind: "session_command", payload: argument.length === 0 ? { command: "compact" } : { command: "compact", instructions: argument } };
  }
  return { kind: "prompt", text: trimmed };
}
