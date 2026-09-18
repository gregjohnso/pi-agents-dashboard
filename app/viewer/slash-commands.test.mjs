import { expect, it } from "vitest";

import { parseSlashSubmission, sessionSlashCommands } from "./slash-commands.mjs";

/** @type {import("./slash-commands.mjs").SessionMenu} */
const menu = {
  commands: [{ name: "/review", source: "extension", description: "Review the diff" }, { name: "/skill:notebook", source: "skill" }],
  models: [{ provider: "anthropic", id: "claude-sonnet" }, { provider: "openai", id: "gpt-5" }],
  model: { provider: "anthropic", id: "claude-sonnet" },
};

it.each([
  ["plain text", "explain this", { kind: "prompt", text: "explain this" }],
  ["discovered command", "/review now", { kind: "prompt", text: "/review now" }],
  ["session rename", "/rename Coverage loader", { kind: "session_command", payload: { command: "set_session_name", name: "Coverage loader" } }],
])("resolves %s", (_label, text, expected) => {
  expect(parseSlashSubmission(text, menu)).toEqual(expected);
});

it.each([
  ["/rename", "SESSION_NAME_REQUIRED"],
  ["/model invented/model", "UNKNOWN_MODEL"],
])("rejects %s with its own code and without contacting the session", (text, code) => {
  expect(parseSlashSubmission(text, menu)).toMatchObject({ kind: "rejected", code });
});

it.each(["/export /tmp/out.html"])("has no session query behind %s", (text) => {
  expect(parseSlashSubmission(text, menu)).toEqual({ kind: "prompt", text });
});

it.each(["/auto-compact on"])("sends %s to Pi as a prompt instead of a settings passthrough", (text) => {
  expect(parseSlashSubmission(text, menu)).toEqual({ kind: "prompt", text });
});

it("offers no Pi settings passthrough in the viewer command menu", () => {
  const names = new Set(sessionSlashCommands(menu).map((command) => command.name));
  for (const name of ["auto-compact", "auto-retry", "steering", "follow-up"]) expect(names.has(name), name).toBe(false);
});

it.each(["/thinking max"])("sends %s to Pi as a prompt instead of a thinking command", (text) => {
  expect(parseSlashSubmission(text, menu)).toEqual({ kind: "prompt", text });
});

// Pi's auto-retry defaults to on and a retry lives between agent_end and agent_settled, where `abort`
// has no current operation to cancel. This is the only control that stops a retry storm without
// stopping the session, so it outlives the settings commands removed alongside it.
it("keeps the retry brake after the settings passthrough is gone", () => {
  expect(parseSlashSubmission("/abort-retry", menu)).toEqual({ kind: "session_command", payload: { command: "abort_retry" } });
  expect(sessionSlashCommands(menu).find((command) => command.name === "abort-retry")?.description).toMatch(/without stopping the session/i);
});
