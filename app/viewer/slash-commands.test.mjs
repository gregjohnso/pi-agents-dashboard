import { expect, it } from "vitest";

import { SESSION_COLORS } from "../../shared/contracts.mjs";
import { parseSlashSubmission, sessionSlashCommands } from "./slash-commands.mjs";

/** @type {import("./slash-commands.mjs").SessionMenu} */
const menu = {
  commands: [{ name: "/review", source: "extension", description: "Review the diff" }, { name: "/skill:notebook", source: "skill" }],
  models: [{ provider: "anthropic", id: "claude-sonnet" }, { provider: "openai", id: "gpt-5" }],
  thinkingLevels: ["off", "high"],
  model: { provider: "anthropic", id: "claude-sonnet" },
  thinkingLevel: "high",
};

it("names commands without the leading slash Pi re-adds when applying a completion", () => {
  const commands = sessionSlashCommands(menu);
  expect(commands.map(({ name }) => name)).toEqual(["model", "thinking", "model-summary", "rename", "color", "compact", "stats", "tree", "export", "auto-compact", "auto-retry", "steering", "follow-up", "abort-retry", "new", "resume", "fork", "clone", "help", "review", "skill:notebook"]);
  expect(commands[2].getArgumentCompletions?.("")).toEqual([
    { value: "off", label: "off" },
    { value: "anthropic/claude-sonnet", label: "anthropic/claude-sonnet" },
    { value: "openai/gpt-5", label: "openai/gpt-5" },
  ]);
  expect(commands[0].description).toBe("Model: anthropic/claude-sonnet");
  expect(commands[0].getArgumentCompletions?.("open")).toEqual([{ value: "openai/gpt-5", label: "openai/gpt-5" }]);
  expect(commands[1].getArgumentCompletions?.("")).toEqual([{ value: "off", label: "off" }, { value: "high", label: "high" }]);
});

it("gives every built-in a description and an argument hint where it takes one", () => {
  const commands = sessionSlashCommands(menu);
  for (const command of commands.filter(({ source }) => source === "builtin")) {
    expect(command.description, command.name).toBeTruthy();
  }
  const byName = Object.fromEntries(commands.map((command) => [command.name, command]));
  expect(byName["auto-compact"].argumentHint).toBe("<on|off>");
  expect(byName["steering"].getArgumentCompletions?.("")).toEqual([{ value: "all", label: "all" }, { value: "one-at-a-time", label: "one-at-a-time" }]);
  expect(byName["auto-retry"].getArgumentCompletions?.("of")).toEqual([{ value: "off", label: "off" }]);
  expect(byName["export"].argumentHint).toBe("[path]");
  expect(byName["color"]).toMatchObject({ source: "builtin", argumentHint: "<color>" });
  const colors = byName["color"].getArgumentCompletions?.("").map((/** @type {{ value: string }} */ item) => item.value) ?? [];
  expect(colors).toContain("default");
  expect(colors).toEqual(expect.arrayContaining([...SESSION_COLORS]));
  expect(byName["color"].getArgumentCompletions?.("amb").map((/** @type {{ value: string }} */ item) => item.value)).toEqual(["amber"]);
});

it.each([
  ["session stats", "/stats", { kind: "session_query", payload: { query: "get_session_stats" } }],
  ["session tree", "/tree", { kind: "session_query", payload: { query: "get_tree" } }],
  ["default export", "/export", { kind: "session_query", payload: { query: "export_html" } }],
  ["export to a path", "/export /tmp/out.html", { kind: "session_query", payload: { query: "export_html", outputPath: "/tmp/out.html" } }],
  ["auto-compaction off", "/auto-compact off", { kind: "session_command", payload: { command: "set_auto_compaction", enabled: false } }],
  ["auto-retry on", "/auto-retry on", { kind: "session_command", payload: { command: "set_auto_retry", enabled: true } }],
  ["steering mode", "/steering one-at-a-time", { kind: "session_command", payload: { command: "set_steering_mode", mode: "one-at-a-time" } }],
  ["follow-up mode", "/follow-up all", { kind: "session_command", payload: { command: "set_follow_up_mode", mode: "all" } }],
  ["retry abort", "/abort-retry", { kind: "session_command", payload: { command: "abort_retry" } }],
  ["dashboard new session", "/new", { kind: "dashboard", action: "new_session" }],
  ["dashboard session list", "/resume", { kind: "dashboard", action: "session_list" }],
  ["viewer help", "/help", { kind: "help" }],
  ["plain text", "explain this", { kind: "prompt", text: "explain this" }],
  ["discovered command", "/review now", { kind: "prompt", text: "/review now" }],
  ["model selection", "/model openai/gpt-5", { kind: "session_command", payload: { command: "set_model", model: { provider: "openai", id: "gpt-5" } } }],
  ["thinking level", "/thinking off", { kind: "session_command", payload: { command: "set_thinking_level", level: "off" } }],
  ["summary model opt-in", "/model-summary openai/gpt-5", { kind: "settings", payload: { summaryModel: { provider: "openai", id: "gpt-5" } } }],
  ["summary opt-out", "/model-summary off", { kind: "settings", payload: { summaryModel: null } }],
  ["session rename", "/rename Coverage loader", { kind: "session_command", payload: { command: "set_session_name", name: "Coverage loader" } }],
  ["bare compaction", "/compact", { kind: "session_command", payload: { command: "compact" } }],
  ["guided compaction", "/compact keep decisions", { kind: "session_command", payload: { command: "compact", instructions: "keep decisions" } }],
  ["a palette color", "/color amber", { kind: "session_color", color: "amber" }],
  ["the default clearing word", "/color default", { kind: "session_color", color: null }],
])("resolves %s", (_label, text, expected) => {
  expect(parseSlashSubmission(text, menu)).toEqual(expected);
});

it("names the missing capability when refusing a rebind", () => {
  const refusal = parseSlashSubmission("/fork", menu);
  expect(refusal).toMatchObject({ kind: "rejected", code: "SESSION_REBIND_UNSUPPORTED" });
  expect(refusal.message).toMatch(/fork/i);
  expect(refusal.message).toMatch(/rebind|session file/i);
});

it.each([
  ["/fork", "SESSION_REBIND_UNSUPPORTED"],
  ["/clone", "SESSION_REBIND_UNSUPPORTED"],
  ["/auto-compact", "TOGGLE_REQUIRED"],
  ["/auto-compact maybe", "TOGGLE_REQUIRED"],
  ["/steering", "QUEUE_MODE_REQUIRED"],
  ["/follow-up sideways", "QUEUE_MODE_REQUIRED"],
  ["/model", "MODEL_REQUIRED"],
  ["/model invented/model", "UNKNOWN_MODEL"],
  ["/thinking", "THINKING_LEVEL_REQUIRED"],
  ["/thinking invented", "UNKNOWN_THINKING_LEVEL"],
  ["/model-summary", "SUMMARY_MODEL_REQUIRED"],
  ["/model-summary invented/model", "UNKNOWN_MODEL"],
  ["/rename", "SESSION_NAME_REQUIRED"],
  ["/color", "SESSION_COLOR_REQUIRED"],
  ["/color chartreuse", "UNKNOWN_SESSION_COLOR"],
])("rejects %s with its own code and without contacting the session", (text, code) => {
  expect(parseSlashSubmission(text, menu)).toMatchObject({ kind: "rejected", code });
});
