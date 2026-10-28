/**
 * The manager entry point's own option resolution.
 *
 * SCOPE: dashboard METADATA saves by default under `~/.pi-agents`. Pi's native transcript storage is untouched by
 * this file and by these tests - Pi still chooses where its own session files go, from its own configuration.
 *
 * These cases exercise `resolveManagerOptions`, which is the resolution `main()` actually calls, so a default that
 * is never forwarded cannot pass them. The resolver takes `argv`, `cwd` and `homeDir` explicitly, which is what lets
 * every case below run against a DISPOSABLE home: enabling a default means a test that leaked the real home would
 * write real operator metadata, so no case here reads the ambient environment at all.
 *
 * Nothing here spawns Pi, launches an owner, or touches the operator's actual ~/.pi-agents.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveManagerOptions } from "./manager-demo.mjs";

/** A disposable private home; never the operator's. */
const PRIVATE_HOME = "/disposable/private-home";
const PRIVATE_SESSIONS = "/tmp/pi-sd-runtime";
const PRIVATE_PI_CONFIG = "/disposable/pi-config";

/** One resolution. `homeDir` and `cwd` are always explicit so no case can read the real environment. */
function resolve(argv, overrides = {}) {
  return resolveManagerOptions({ argv, cwd: "/repo/project", homeDir: PRIVATE_HOME, ...overrides });
}

describe("dashboard metadata saves by default", () => {
  it("selects <home>/.pi-agents when --state is omitted", () => {
    // The defect this pins: stateHome used to be undefined, so nothing was ever saved unless the operator
    // remembered a flag.
    expect(resolve([]).stateHome).toBe(path.join(PRIVATE_HOME, ".pi-agents"));
  });

  it("respects the caller's home rather than any ambient one", () => {
    expect(resolve([], { homeDir: "/another/home" }).stateHome).toBe(path.join("/another/home", ".pi-agents"));
  });

  it("reports that the default was used, so a caller can say so honestly", () => {
    expect(resolve([]).stateHomeIsDefault).toBe(true);
    expect(resolve(["--state", "/explicit/records"]).stateHomeIsDefault).toBe(false);
  });
});

describe("an explicit --state still overrides, exactly as before", () => {
  it("selects the given path", () => {
    expect(resolve(["--state", "/explicit/records"]).stateHome).toBe("/explicit/records");
  });

  it("resolves a relative path against the process, as the other flags do", () => {
    expect(path.isAbsolute(resolve(["--state", "relative/records"]).stateHome)).toBe(true);
  });

  it("refuses --state with no value instead of silently taking the default or a neighbouring flag", () => {
    // The parser this touches now has a default to fall back on, so a missing value could quietly become
    // ~/.pi-agents - or, worse, swallow the next flag as its path.
    expect(() => resolve(["--state"])).toThrow(/--state/u);
    expect(() => resolve(["--state", "--sessions", PRIVATE_SESSIONS])).toThrow(/--state/u);
  });
});

describe("the default is independent of the other homes", () => {
  it("does not follow --sessions, which stays the short runtime home", () => {
    const options = resolve(["--sessions", PRIVATE_SESSIONS]);
    expect(options.sessionsHome).toBe(PRIVATE_SESSIONS);
    expect(options.stateHome).toBe(path.join(PRIVATE_HOME, ".pi-agents"));
    expect(options.stateHome).not.toContain(PRIVATE_SESSIONS);
  });

  it("does not follow --pi-config, which stays fake-only Pi configuration", () => {
    const options = resolve(["--pi-config", PRIVATE_PI_CONFIG]);
    expect(options.piConfigHome).toBe(PRIVATE_PI_CONFIG);
    expect(options.stateHome).toBe(path.join(PRIVATE_HOME, ".pi-agents"));
    expect(options.stateHome).not.toContain(PRIVATE_PI_CONFIG);
  });

  it("keeps all three distinct when all three are given", () => {
    const options = resolve(["--sessions", PRIVATE_SESSIONS, "--pi-config", PRIVATE_PI_CONFIG, "--state", "/explicit/records"]);
    expect(options.sessionsHome).toBe(PRIVATE_SESSIONS);
    expect(options.piConfigHome).toBe(PRIVATE_PI_CONFIG);
    expect(options.stateHome).toBe("/explicit/records");
  });

  it("leaves --pi-config absent by default, so real mode gets no fixture configuration", () => {
    expect(resolve([]).piConfigHome).toBeUndefined();
  });

  it("leaves the unrelated flags alone", () => {
    expect(resolve([]).mode).toBe("fake");
    expect(resolve(["--real"]).mode).toBe("real");
    expect(resolve(["--cwd", "/somewhere/else"]).projectCwd).toBe("/somewhere/else");
    expect(resolve([]).projectCwd).toBe("/repo/project");
  });
});
