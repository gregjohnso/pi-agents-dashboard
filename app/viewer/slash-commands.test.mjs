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

it.each([
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

it.each(["/stats", "/tree", "/export", "/export /tmp/out.html"])("has no session query behind %s", (text) => {
  expect(parseSlashSubmission(text, menu)).toEqual({ kind: "prompt", text });
});

it("offers no session query in the viewer command menu", () => {
  const names = new Set(sessionSlashCommands(menu).map((command) => command.name));
  for (const name of ["stats", "tree", "export"]) expect(names.has(name), name).toBe(false);
});

it.each(["/auto-compact on", "/auto-retry off", "/steering all", "/follow-up one-at-a-time"])("sends %s to Pi as a prompt instead of a settings passthrough", (text) => {
  expect(parseSlashSubmission(text, menu)).toEqual({ kind: "prompt", text });
});

it("offers no Pi settings passthrough in the viewer command menu", () => {
  const names = new Set(sessionSlashCommands(menu).map((command) => command.name));
  for (const name of ["auto-compact", "auto-retry", "steering", "follow-up"]) expect(names.has(name), name).toBe(false);
});

// Pi's auto-retry defaults to on and a retry lives between agent_end and agent_settled, where `abort`
// has no current operation to cancel. This is the only control that stops a retry storm without
// stopping the session, so it outlives the settings commands removed alongside it.
it("keeps the retry brake after the settings passthrough is gone", () => {
  expect(parseSlashSubmission("/abort-retry", menu)).toEqual({ kind: "session_command", payload: { command: "abort_retry" } });
  expect(sessionSlashCommands(menu).find((command) => command.name === "abort-retry")?.description).toMatch(/without stopping the session/i);
});
