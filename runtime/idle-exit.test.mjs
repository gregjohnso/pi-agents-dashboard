import { describe, expect, it, vi } from "vitest";

import { createIdleExit } from "./idle-exit.mjs";

describe("daemon idle exit", () => {
  /** @param {Record<string, any>} overrides @returns {any} */
  const options = (overrides) => ({ idleMs: 1_000, now: () => 0, onIdle: () => {}, frontends: () => 0, workers: () => 0, ...overrides });

  it("exits once nothing has needed the daemon for the idle window", () => {
    let clock = 0;
    const exit = vi.fn();
    const idle = createIdleExit(options({ now: () => clock, onIdle: exit, frontends: () => 0, workers: () => 0 }));
    idle.check();
    clock = 999;
    idle.check();
    expect(exit).not.toHaveBeenCalled();
    clock = 1_000;
    idle.check();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("never exits while a frontend is attached or a worker is alive", () => {
    let clock = 0;
    let frontends = 1;
    let workers = 0;
    const exit = vi.fn();
    const idle = createIdleExit(options({ now: () => clock, onIdle: exit, frontends: () => frontends, workers: () => workers }));
    clock = 5_000;
    idle.check();
    expect(exit).not.toHaveBeenCalled();

    frontends = 0;
    workers = 1;
    clock = 10_000;
    idle.check();
    expect(exit).not.toHaveBeenCalled();

    // The idle window restarts from the moment the daemon last had work, not from daemon start.
    workers = 0;
    clock = 10_500;
    idle.check();
    expect(exit).not.toHaveBeenCalled();
    clock = 11_000;
    idle.check();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits at most once", () => {
    let clock = 0;
    const exit = vi.fn();
    const idle = createIdleExit(options({ now: () => clock, onIdle: exit, frontends: () => 0, workers: () => 0 }));
    clock = 5_000;
    idle.check();
    idle.check();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("stays alive when idle exit is disabled", () => {
    const exit = vi.fn();
    const idle = createIdleExit(options({ idleMs: 0, now: () => 9_000, onIdle: exit, frontends: () => 0, workers: () => 0 }));
    idle.check();
    expect(exit).not.toHaveBeenCalled();
  });
});
