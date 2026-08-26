import { expect, it } from "vitest";

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
  expect(commands.map(({ name }) => name)).toEqual(["model", "thinking", "model-summary", "rename", "compact", "review", "skill:notebook"]);
  expect(commands[2].getArgumentCompletions?.("")).toEqual([
    { value: "off", label: "off" },
    { value: "anthropic/claude-sonnet", label: "anthropic/claude-sonnet" },
    { value: "openai/gpt-5", label: "openai/gpt-5" },
  ]);
  expect(commands[0].description).toBe("Model: anthropic/claude-sonnet");
  expect(commands[0].getArgumentCompletions?.("open")).toEqual([{ value: "openai/gpt-5", label: "openai/gpt-5" }]);
  expect(commands[1].getArgumentCompletions?.("")).toEqual([{ value: "off", label: "off" }, { value: "high", label: "high" }]);
});

it.each([
  ["plain text", "explain this", { kind: "prompt", text: "explain this" }],
  ["discovered command", "/review now", { kind: "prompt", text: "/review now" }],
  ["model selection", "/model openai/gpt-5", { kind: "session_command", payload: { command: "set_model", model: { provider: "openai", id: "gpt-5" } } }],
  ["thinking level", "/thinking off", { kind: "session_command", payload: { command: "set_thinking_level", level: "off" } }],
  ["summary model opt-in", "/model-summary openai/gpt-5", { kind: "settings", payload: { summaryModel: { provider: "openai", id: "gpt-5" } } }],
  ["summary opt-out", "/model-summary off", { kind: "settings", payload: { summaryModel: null } }],
  ["session rename", "/rename Coverage loader", { kind: "session_command", payload: { command: "set_session_name", name: "Coverage loader" } }],
  ["bare compaction", "/compact", { kind: "session_command", payload: { command: "compact" } }],
  ["guided compaction", "/compact keep decisions", { kind: "session_command", payload: { command: "compact", instructions: "keep decisions" } }],
])("resolves %s", (_label, text, expected) => {
  expect(parseSlashSubmission(text, menu)).toEqual(expected);
});

it.each([
  ["/model", "MODEL_REQUIRED"],
  ["/model invented/model", "UNKNOWN_MODEL"],
  ["/thinking", "THINKING_LEVEL_REQUIRED"],
  ["/thinking invented", "UNKNOWN_THINKING_LEVEL"],
  ["/model-summary", "SUMMARY_MODEL_REQUIRED"],
  ["/model-summary invented/model", "UNKNOWN_MODEL"],
  ["/rename", "SESSION_NAME_REQUIRED"],
])("rejects %s without contacting the session", (text, code) => {
  expect(parseSlashSubmission(text, menu)).toMatchObject({ kind: "rejected", code });
});
