import { expect, it } from "vitest";

import { parseSlashSubmission } from "./slash-commands.mjs";

/** @type {import("./slash-commands.mjs").SessionMenu} */
const menu = {
  commands: [{ name: "/review", source: "extension", description: "Review the diff" }, { name: "/skill:notebook", source: "skill" }],
  models: [{ provider: "anthropic", id: "claude-sonnet" }, { provider: "openai", id: "gpt-5" }],
  thinkingLevels: ["off", "high"],
  model: { provider: "anthropic", id: "claude-sonnet" },
  thinkingLevel: "high",
};

it.each([
  ["session tree", "/tree", { kind: "session_query", payload: { query: "get_tree" } }],
  ["default export", "/export", { kind: "session_query", payload: { query: "export_html" } }],
  ["export to a path", "/export /tmp/out.html", { kind: "session_query", payload: { query: "export_html", outputPath: "/tmp/out.html" } }],
  ["auto-retry on", "/auto-retry on", { kind: "session_command", payload: { command: "set_auto_retry", enabled: true } }],
  ["follow-up mode", "/follow-up all", { kind: "session_command", payload: { command: "set_follow_up_mode", mode: "all" } }],
  ["retry abort", "/abort-retry", { kind: "session_command", payload: { command: "abort_retry" } }],
  ["plain text", "explain this", { kind: "prompt", text: "explain this" }],
  ["discovered command", "/review now", { kind: "prompt", text: "/review now" }],
  ["thinking level", "/thinking off", { kind: "session_command", payload: { command: "set_thinking_level", level: "off" } }],
  ["summary model opt-in", "/model-summary openai/gpt-5", { kind: "settings", payload: { summaryModel: { provider: "openai", id: "gpt-5" } } }],
  ["summary opt-out", "/model-summary off", { kind: "settings", payload: { summaryModel: null } }],
  ["session rename", "/rename Coverage loader", { kind: "session_command", payload: { command: "set_session_name", name: "Coverage loader" } }],
  ["bare compaction", "/compact", { kind: "session_command", payload: { command: "compact" } }],
  ["guided compaction", "/compact keep decisions", { kind: "session_command", payload: { command: "compact", instructions: "keep decisions" } }],
  ["the default clearing word", "/color default", { kind: "session_color", color: null }],
])("resolves %s", (_label, text, expected) => {
  expect(parseSlashSubmission(text, menu)).toEqual(expected);
});

it.each([
  ["/fork", "SESSION_REBIND_UNSUPPORTED"],
  ["/rename", "SESSION_NAME_REQUIRED"],
  ["/model invented/model", "UNKNOWN_MODEL"],
  ["/color chartreuse", "UNKNOWN_SESSION_COLOR"],
])("rejects %s with its own code and without contacting the session", (text, code) => {
  expect(parseSlashSubmission(text, menu)).toMatchObject({ kind: "rejected", code });
});
