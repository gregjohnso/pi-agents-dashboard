import { describe, expect, it, vi } from "vitest";

import manifest from "../../package.json";
import { registerAgentsDashboard } from "./index.js";

it("ships one self-contained Pi extension and optional executable", () => {
  expect(manifest.bin).toEqual({ "pi-agents-dashboard": "./bin/pi-agents-dashboard.mjs" });
  expect(manifest.pi.extensions).toEqual(["./extensions/agents-dashboard/index.ts"]);
  expect(manifest.files).toEqual(expect.arrayContaining(["extensions", "runtime", "shared", "isolation"]));
  expect(manifest.engines.node).toBe(">=22.19.0");
});

describe("agents extension registration", () => {
  it("registers global /agents and reports exact unsupported-host remediation", async () => {
    let command: { handler(args: string, ctx: unknown): Promise<void> } | undefined;
    const pi = {
      registerCommand(name: string, options: typeof command) {
        expect(name).toBe("agents");
        command = options;
      },
      on: vi.fn(),
    };
    const notify = vi.fn();
    registerAgentsDashboard(pi as never, {
      checkCapabilities: async () => ({
        piVersion: "0.84.3",
        globalPackage: true,
        rpcWorker: true,
        daemonOwnedStartup: false,
        nativeAttach: false,
        composableLeftGesture: true,
        fullscreenCustomUi: true,
        blockers: ["missing native attach"],
      }),
      openDashboard: vi.fn(),
    });
    await command?.handler("", { mode: "tui", ui: { notify } } as never);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("UNSUPPORTED_HOST"), "error");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("pi-agents-dashboard doctor"), "error");
  });

  it("installs a composable gesture wrapper without replacing the existing editor silently", async () => {
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn(),
      on(name: string, handler: typeof sessionStart) {
        if (name === "session_start") sessionStart = handler;
      },
    };
    const previous = vi.fn(() => ({
      getText: () => "",
      setText: vi.fn(),
      render: () => [""],
      invalidate: vi.fn(),
      handleInput: vi.fn(),
      getCursor: () => ({ line: 0, col: 0 }),
    }));
    const setEditorComponent = vi.fn();
    registerAgentsDashboard(pi as never, {
      checkCapabilities: async () => ({
        piVersion: "supported",
        globalPackage: true,
        rpcWorker: true,
        daemonOwnedStartup: true,
        nativeAttach: true,
        composableLeftGesture: true,
        fullscreenCustomUi: true,
        blockers: [],
      }),
      openDashboard: vi.fn(),
    });
    await sessionStart?.({}, {
      mode: "tui",
      ui: { getEditorComponent: () => previous, setEditorComponent, notify: vi.fn() },
    });
    expect(setEditorComponent).toHaveBeenCalledOnce();
    const factory = setEditorComponent.mock.calls[0]?.[0] as (...args: unknown[]) => unknown;
    factory({ requestRender: vi.fn() }, {}, {});
    expect(previous).toHaveBeenCalledOnce();
  });
});
