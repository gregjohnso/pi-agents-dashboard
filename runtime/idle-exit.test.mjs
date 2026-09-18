import { describe, expect, it, vi } from "vitest";

import { DEFAULT_IDLE_EXIT_MS, createIdleExit, resolveIdleExitMs } from "./idle-exit.mjs";

describe("daemon idle exit", () => {
  /** @param {Record<string, any>} overrides @returns {any} */
  const options = (overrides) => ({ idleMs: 1_000, now: () => 0, onIdle: () => {}, hold: () => undefined, ...overrides });

  it("exits exactly once, and only after the full idle window", () => {
    let clock = 0;
    const exit = vi.fn();
    const idle = createIdleExit(options({ now: () => clock, onIdle: exit }));
    idle.check();
    clock = 999;
    idle.check();
    expect(exit).not.toHaveBeenCalled();
    clock = 1_000;
    idle.check();
    idle.check();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("never exits while a hold stands, and starts the window over when the last one clears", () => {
    let clock = 0;
    /** @type {string | undefined} */
    let reason = "clients";
    const exit = vi.fn();
    const idle = createIdleExit(options({ now: () => clock, onIdle: exit, hold: () => reason }));
    clock = 5_000;
    idle.check();
    expect(exit).not.toHaveBeenCalled();

    reason = "commands";
    clock = 10_000;
    idle.check();
    expect(exit).not.toHaveBeenCalled();

    // The window restarts from the moment the daemon last had work, not from daemon start.
    reason = undefined;
    clock = 10_500;
    idle.check();
    expect(exit).not.toHaveBeenCalled();
    clock = 11_000;
    idle.check();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("refuses an idle window it cannot read rather than staying resident on it", () => {
    expect(() => resolveIdleExitMs({ env: { PI_AGENTS_IDLE_EXIT_MS: "soon" } })).toThrow(/idle exit window/iu);
    expect(() => resolveIdleExitMs({ argv: ["--idle-exit-ms", "-1"] })).toThrow(/idle exit window/iu);
  });
});
