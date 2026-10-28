/**
 * `/new` and `/resume` in the dashboard composer.
 *
 * The operator reported "I can't /new, i can't /resume" in this demo. Reproducing it against the actual launcher
 * showed both commands work perfectly INSIDE an attached Pi - the session identity changes, the same Pi process
 * stays alive, and typing works afterwards (`session-switch-flow.mjs`). What does not work is typing them into the
 * dashboard's own composer, which answered:
 *
 *     UNKNOWN_LIST_COMMAND: Unknown command: /new. Known: /model /cwd /isolation /name /rename /help
 *
 * That is true and useless. These are Pi's own session commands; the list has no business implementing them, and
 * an operator reading that line has no way to know they exist one keypress away. So the refusal is made
 * actionable, and NOTHING about manager semantics changes: the list still does not create or resume sessions.
 */

import { describe, expect, it } from "vitest";

import { EMPTY_DRAFT_CHOICES, LIST_COMMANDS, LIST_COMMAND_MENU, parseListCommand } from "./list-commands.mjs";
import { createHelpOverlay } from "./dashboard-overlays.mjs";

const parse = (text) => parseListCommand(text, EMPTY_DRAFT_CHOICES);

describe("Pi's own session commands are refused with somewhere to go", () => {
  for (const command of ["/new", "/resume"]) {
    it(`tells the operator where ${command} actually works`, () => {
      const parsed = parse(command);
      expect(parsed.kind).toBe("rejected");
      expect(parsed.code).toBe("PI_SESSION_COMMAND");
      // It names the command as Pi's, and says how to reach it.
      expect(parsed.message).toMatch(new RegExp(`${command}`, "u"));
      expect(parsed.message).toMatch(/inside a session|in the session/iu);
      // The actionable part: the gesture that opens one.
      expect(parsed.message).toMatch(/Enter|→|Right/u);
      // And it must not pretend the list can do it.
      expect(parsed.message).not.toMatch(/unknown command/iu);
    });
  }

  it("still answers a command it genuinely does not know with the generic refusal", () => {
    for (const unknown of ["/res", "/newer", "/nope", "/resumes"]) {
      expect(parse(unknown)).toMatchObject({ kind: "rejected", code: "UNKNOWN_LIST_COMMAND" });
    }
  });

  it("treats an argument as the same mistake, because the operator still meant Pi's command", () => {
    expect(parse("/resume 2026-09-20T19-09-31")).toMatchObject({ kind: "rejected", code: "PI_SESSION_COMMAND" });
  });

  it("adds no manager semantics: the composer's own command set is unchanged", () => {
    expect(LIST_COMMANDS).toEqual(["/model", "/cwd", "/isolation", "/name", "/rename", "/help"]);
    expect(LIST_COMMAND_MENU.map((entry) => entry.name)).not.toContain("/new");
    expect(LIST_COMMAND_MENU.map((entry) => entry.name)).not.toContain("/resume");
    // The commands that do work are untouched.
    expect(parse("/name later")).toEqual({ kind: "set_name", name: "later" });
    expect(parse("/rename now")).toEqual({ kind: "rename_session", name: "now" });
    expect(parse("/help")).toEqual({ kind: "help" });
  });

  it("omits Pi-only session commands from the dashboard help", () => {
    const help = createHelpOverlay();
    const line = help.bindings.find((binding) => /\/new|\/resume/u.test(binding.keys) || /\/new|\/resume/u.test(binding.action));
    expect(line).toBeUndefined();
  });
});
