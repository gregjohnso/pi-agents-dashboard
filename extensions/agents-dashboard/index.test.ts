import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import manifest from "../../package.json";
import { openFrontendPersistence, registerAgentsDashboard } from "./index.js";

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

  it("fails closed for an arbitrary EditorComponent and restores the owned factory on shutdown", async () => {
    let sessionStart: ((event: unknown, ctx: any) => Promise<void>) | undefined;
    let sessionShutdown: ((event: unknown, ctx: any) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn(),
      on(name: string, handler: typeof sessionStart) {
        if (name === "session_start") sessionStart = handler;
        if (name === "session_shutdown") sessionShutdown = handler;
      },
    };
    const base = {
      getText: () => "",
      setText: vi.fn(),
      render: () => [""],
      invalidate: vi.fn(),
      handleInput: vi.fn(),
    };
    const previous = vi.fn(() => base);
    let current: unknown = previous;
    const setEditorComponent = vi.fn((factory) => { current = factory; });
    const notify = vi.fn();
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
    const ctx = {
      mode: "tui",
      ui: { getEditorComponent: () => current, setEditorComponent, notify },
    };
    await sessionStart?.({}, ctx);
    expect(setEditorComponent).toHaveBeenCalledOnce();
    const factory = setEditorComponent.mock.calls[0]?.[0] as (...args: unknown[]) => unknown;
    expect(factory({ requestRender: vi.fn() }, {}, {})).toBe(base);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("public CustomEditor"), "warning");
    await sessionShutdown?.({}, ctx);
    expect(setEditorComponent).toHaveBeenLastCalledWith(previous);
  });

  it("strictly validates every persisted section and writes an atomic private schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dashboard-persistence-"));
    try {
      const path = join(directory, "frontend-state.json");
      const opened = await openFrontendPersistence(path);
      await opened.persistence.save({
        schemaVersion: 1,
        clientId: opened.clientId,
        cursor: { daemonEpoch: "epoch", sequence: "9" },
        viewState: {
          query: {
            view: "all", search: "needle", taskStates: ["READY"], processStates: ["LIVE"], outcomes: ["NONE"],
            activityKinds: ["assistant_final"], projectPaths: ["/repo"], sort: { key: "activity", direction: "desc" }, groupBy: "cwd",
          },
          selectedSessionId: "selected",
        },
        launchDraft: {
          prompt: "prompt", cwd: "/repo", sourceSessionId: "source", isolationMode: "shared_directory",
          model: { provider: "provider", id: "model" }, thinkingLevel: "high", name: "name",
        },
      });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schemaVersion: 1, cursor: { sequence: "9" }, launchDraft: { isolationMode: "shared_directory" } });
      expect((await stat(path)).mode & 0o777).toBe(0o600);

      await writeFile(path, JSON.stringify({ schemaVersion: 1, clientId: "trusted", cursor: { daemonEpoch: "epoch", sequence: "-1" }, unexpected: true }));
      await expect(openFrontendPersistence(path)).rejects.toMatchObject({ code: "PERSISTENCE_INVALID" });
      await writeFile(path, JSON.stringify({ schemaVersion: 2, clientId: "trusted" }));
      await expect(openFrontendPersistence(path)).rejects.toMatchObject({ code: "PERSISTENCE_INVALID" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports typed persistence failure and does not open a dashboard with untrusted identity", async () => {
    let command: { handler(args: string, ctx: unknown): Promise<void> } | undefined;
    const notify = vi.fn();
    registerAgentsDashboard({
      registerCommand(_name: string, options: typeof command) { command = options; },
      on: vi.fn(),
    } as never, {
      checkCapabilities: async () => ({
        piVersion: "supported", globalPackage: true, rpcWorker: true, daemonOwnedStartup: true,
        nativeAttach: true, composableLeftGesture: true, fullscreenCustomUi: true, blockers: [],
      }),
      openDashboard: async () => { throw Object.assign(new Error("invalid frontend-state.json"), { code: "PERSISTENCE_INVALID" }); },
    });
    await command?.handler("", { mode: "tui", ui: { notify } } as never);
    expect(notify).toHaveBeenCalledWith("PERSISTENCE_INVALID: invalid frontend-state.json", "error");
  });
});
