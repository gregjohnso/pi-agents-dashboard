import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { checkHostCapabilities, type HostCapabilityReport } from "./compatibility.js";
import { createDaemonClient } from "./daemon-client.js";
import {
  DashboardController,
  createDaemonDashboardBackend,
  type DashboardPersistence,
  type PersistedDashboardState,
} from "./dashboard.js";
import { DashboardGestureEditor } from "./key-gesture.js";

const UNSUPPORTED_REMEDIATION = "UNSUPPORTED_HOST: run `pi-agents-dashboard doctor`; upgrade Pi to a version exposing the documented daemon-owned startup, native attachment, composable editor, and fullscreen custom UI APIs.";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

interface AgentsDashboardDependencies {
  checkCapabilities(): Promise<HostCapabilityReport>;
  openDashboard(ctx: ExtensionContext, report: HostCapabilityReport): Promise<void>;
}

function unsupported(report: HostCapabilityReport): boolean {
  return report.blockers.length > 0
    || !report.daemonOwnedStartup
    || !report.nativeAttach
    || !report.fullscreenCustomUi;
}

async function reportUnsupported(ctx: ExtensionContext, report: HostCapabilityReport): Promise<void> {
  const blockers = report.blockers.length === 0 ? "Required host capabilities are unavailable." : report.blockers.join(" ");
  ctx.ui.notify(`${UNSUPPORTED_REMEDIATION} ${blockers}`, "error");
}

function runtimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  return resolve(env.PI_AGENTS_DASHBOARD_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-agents-dashboard"));
}

function persistenceError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code: "PERSISTENCE_INVALID" });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw persistenceError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw persistenceError(`${path}.${unknown} is not supported`);
}

function text(value: unknown, path: string, { empty = false, max = 4096 } = {}): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw persistenceError(`${path} must be ${empty ? "a" : "a non-empty"} string of at most ${max} characters`);
  }
  return value;
}

function optionalTextArray(value: unknown, path: string, allowed?: readonly string[]): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 1024) throw persistenceError(`${path} must be a non-empty bounded array`);
  const result = value.map((entry, index) => text(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length || (allowed !== undefined && result.some((entry) => !allowed.includes(entry)))) throw persistenceError(`${path} contains an invalid or duplicate value`);
  return result;
}

function parsePersistedState(value: unknown): PersistedDashboardState {
  const state = record(value, "frontend state");
  exactKeys(state, ["schemaVersion", "clientId", "cursor", "viewState", "launchDraft"], "frontend state");
  if (state.schemaVersion !== 1) throw persistenceError("frontend state.schemaVersion must equal 1");
  const clientId = text(state.clientId, "frontend state.clientId", { max: 256 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(clientId)) throw persistenceError("frontend state.clientId contains invalid identity characters");
  const parsed: PersistedDashboardState = { schemaVersion: 1, clientId };
  if (state.cursor !== undefined) {
    const cursor = record(state.cursor, "frontend state.cursor");
    exactKeys(cursor, ["daemonEpoch", "sequence"], "frontend state.cursor");
    const sequence = text(cursor.sequence, "frontend state.cursor.sequence", { max: 128 });
    if (!/^(0|[1-9]\d*)$/u.test(sequence)) throw persistenceError("frontend state.cursor.sequence must be a canonical unsigned integer");
    parsed.cursor = { daemonEpoch: text(cursor.daemonEpoch, "frontend state.cursor.daemonEpoch", { max: 256 }), sequence };
  }
  if (state.viewState !== undefined) {
    const view = record(state.viewState, "frontend state.viewState");
    exactKeys(view, ["query", "selectedSessionId"], "frontend state.viewState");
    const query = record(view.query, "frontend state.viewState.query");
    exactKeys(query, ["view", "search", "taskStates", "processStates", "outcomes", "activityKinds", "projectPaths", "sort", "groupBy"], "frontend state.viewState.query");
    if (!["live", "done", "all"].includes(String(query.view))) throw persistenceError("frontend state.viewState.query.view is invalid");
    const parsedQuery: NonNullable<PersistedDashboardState["viewState"]>["query"] = { view: query.view as "live" | "done" | "all" };
    if (query.search !== undefined) parsedQuery.search = text(query.search, "frontend state.viewState.query.search", { empty: true });
    parsedQuery.taskStates = optionalTextArray(query.taskStates, "frontend state.viewState.query.taskStates", ["WORKING", "WAITING", "READY", "FAILED", "STOPPED"]) as typeof parsedQuery.taskStates;
    parsedQuery.processStates = optionalTextArray(query.processStates, "frontend state.viewState.query.processStates", ["LIVE", "SLEEPING", "EXITED", "STALE"]) as typeof parsedQuery.processStates;
    parsedQuery.outcomes = optionalTextArray(query.outcomes, "frontend state.viewState.query.outcomes", ["NONE", "COMPLETED", "READY_FOR_REVIEW"]) as typeof parsedQuery.outcomes;
    parsedQuery.activityKinds = optionalTextArray(query.activityKinds, "frontend state.viewState.query.activityKinds");
    parsedQuery.projectPaths = optionalTextArray(query.projectPaths, "frontend state.viewState.query.projectPaths");
    if (query.sort !== undefined) {
      const sort = record(query.sort, "frontend state.viewState.query.sort");
      exactKeys(sort, ["key", "direction"], "frontend state.viewState.query.sort");
      if (!["age", "id", "state", "model", "project", "activity"].includes(String(sort.key)) || !["asc", "desc"].includes(String(sort.direction))) throw persistenceError("frontend state.viewState.query.sort is invalid");
      parsedQuery.sort = { key: sort.key as NonNullable<typeof parsedQuery.sort>["key"], direction: sort.direction as NonNullable<typeof parsedQuery.sort>["direction"] };
    }
    if (query.groupBy !== undefined) {
      if (!["taskState", "cwd"].includes(String(query.groupBy))) throw persistenceError("frontend state.viewState.query.groupBy is invalid");
      parsedQuery.groupBy = query.groupBy as NonNullable<typeof parsedQuery.groupBy>;
    }
    parsed.viewState = { query: parsedQuery };
    if (view.selectedSessionId !== undefined) parsed.viewState.selectedSessionId = text(view.selectedSessionId, "frontend state.viewState.selectedSessionId", { max: 256 });
  }
  if (state.launchDraft !== undefined) {
    const draft = record(state.launchDraft, "frontend state.launchDraft");
    exactKeys(draft, ["prompt", "cwd", "isolationMode", "model", "thinkingLevel", "name"], "frontend state.launchDraft");
    const model = record(draft.model, "frontend state.launchDraft.model");
    exactKeys(model, ["provider", "id"], "frontend state.launchDraft.model");
    if (!["worktree", "shared_directory"].includes(String(draft.isolationMode))) throw persistenceError("frontend state.launchDraft.isolationMode is invalid");
    parsed.launchDraft = {
      prompt: text(draft.prompt, "frontend state.launchDraft.prompt", { empty: true, max: 100_000 }),
      cwd: text(draft.cwd, "frontend state.launchDraft.cwd"),
      isolationMode: draft.isolationMode as "worktree" | "shared_directory",
      model: { provider: text(model.provider, "frontend state.launchDraft.model.provider", { max: 256 }), id: text(model.id, "frontend state.launchDraft.model.id", { max: 256 }) },
      thinkingLevel: text(draft.thinkingLevel, "frontend state.launchDraft.thinkingLevel", { max: 256 }),
      name: text(draft.name, "frontend state.launchDraft.name", { max: 1024 }),
    };
  }
  return parsed;
}

/** Open strict, atomic frontend persistence without trusting malformed identity or cursor state. */
export async function openFrontendPersistence(path: string): Promise<{ clientId: string; persistence: DashboardPersistence }> {
  let loaded: PersistedDashboardState | undefined;
  try {
    loaded = parsePersistedState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if ((error as { code?: string }).code === "PERSISTENCE_INVALID") throw error;
      throw persistenceError(`Could not trust ${path}`, error);
    }
  }
  const clientId = loaded?.clientId ?? randomUUID();
  const persistence: DashboardPersistence = {
    async load() { return loaded; },
    async save(state) {
      const validated = parsePersistedState(state);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(validated)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
        loaded = validated;
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
  };
  if (loaded === undefined) await persistence.save({ schemaVersion: 1, clientId });
  return { clientId, persistence };
}

async function openDashboardWithPublicUi(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("UNSUPPORTED_HOST: /agents requires Pi interactive TUI mode.", "error");
    return;
  }
  const root = runtimeRoot();
  const { clientId, persistence } = await openFrontendPersistence(join(root, "frontend-state.json"));
  const token = (await readFile(join(root, "daemon", "control.token"), "utf8")).trim();
  const client = createDaemonClient({
    socketPath: join(root, "daemon", "control.sock"),
    token,
    maxBytes: 1024 * 1024,
    clientId,
  });
  const sourceSessionId = ctx.sessionManager.getSessionId();
  const backend = createDaemonDashboardBackend({
    client,
    clientId,
    preflight: async (draft) => ({
      canonicalCwd: await realpath(draft.cwd),
      isolationMode: draft.isolationMode,
      ownerSessionIds: [],
    }),
  });
  try {
    await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
      const dashboard = new DashboardController({
        backend,
        persistence,
        nativeAttach: {
          async attach() {
            return { kind: "unsupported", error: { code: "UNSUPPORTED_HOST", message: "Native Pi attachment is reserved for Task 14 and unavailable on this host." } };
          },
          async detach() {
            return { kind: "unsupported", error: { code: "UNSUPPORTED_HOST", message: "Native Pi detachment is reserved for Task 14 and unavailable on this host." } };
          },
        },
        clientId,
        sourceSessionId,
        launchDefaults: {
          cwd: ctx.cwd,
          model: ctx.model === undefined ? { provider: "unavailable", id: "unavailable" } : { provider: ctx.model.provider, id: ctx.model.id },
          thinkingLevel: ctx.thinkingLevel ?? "off",
          name: "new agent",
        },
        requestRender: () => tui.requestRender(),
        onClose: () => done(undefined),
      });
      void dashboard.open().then(() => tui.requestRender());
      return {
        render: (width) => dashboard.render(width, tui.terminal.rows),
        handleInput(data) {
          const mouse = /^\x1b\[<0;(\d+);(\d+)M$/u.exec(data);
          if (mouse !== null) dashboard.handleMouse({ row: Number(mouse[2]) - 1, column: Number(mouse[1]) - 1, button: "left" });
          else dashboard.handleInput(data);
          tui.requestRender();
        },
        invalidate() {},
        dispose() { return dashboard.close(); },
      };
    });
  } finally {
    await client.close();
  }
}

/** Register `/agents` and the public composable editor adapter. */
export function registerAgentsDashboard(
  pi: ExtensionAPI,
  dependencies: AgentsDashboardDependencies = {
    checkCapabilities: checkHostCapabilities,
    openDashboard: openDashboardWithPublicUi,
  },
): void {
  const activate = async (ctx: ExtensionContext) => {
    try {
      const report = await dependencies.checkCapabilities();
      if (unsupported(report)) {
        await reportUnsupported(ctx, report);
        return;
      }
      await dependencies.openDashboard(ctx, report);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      ctx.ui.notify(`${typed.code ?? "DASHBOARD_OPEN_FAILED"}: ${typed.message ?? "Dashboard could not open"}`, "error");
    }
  };

  pi.registerCommand("agents", {
    description: "Open the machine-wide agents dashboard",
    handler: async (_args, ctx) => activate(ctx),
  });

  const installations = new Map<ExtensionContext["ui"], { previous: EditorFactory | undefined; wrapper: EditorFactory; editors: Set<DashboardGestureEditor> }>();

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const priorInstallation = installations.get(ctx.ui);
    if (priorInstallation !== undefined) {
      installations.delete(ctx.ui);
      for (const editor of priorInstallation.editors) editor.dispose();
      priorInstallation.editors.clear();
      if (ctx.ui.getEditorComponent() === priorInstallation.wrapper) ctx.ui.setEditorComponent(priorInstallation.previous);
    }
    const report = await dependencies.checkCapabilities();
    if (!report.composableLeftGesture) return;
    const previous = ctx.ui.getEditorComponent();
    const editors = new Set<DashboardGestureEditor>();
    const wrapper: EditorFactory = (tui, theme, keybindings) => {
      const base = previous?.(tui, theme, keybindings)
        ?? new CustomEditor(tui, theme, keybindings);
      if (!(base instanceof CustomEditor)) {
        ctx.ui.notify("UNSUPPORTED_HOST: Left gesture disabled because the existing editor is not a public CustomEditor; use /agents or compose with Pi's documented CustomEditor.", "warning");
        return base;
      }
      const editor = new DashboardGestureEditor(base, () => { void activate(ctx); });
      editors.add(editor);
      return editor;
    };
    installations.set(ctx.ui, { previous, wrapper, editors });
    ctx.ui.setEditorComponent(wrapper);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const installation = installations.get(ctx.ui);
    if (installation === undefined) return;
    installations.delete(ctx.ui);
    for (const editor of installation.editors) editor.dispose();
    installation.editors.clear();
    if (ctx.ui.getEditorComponent() === installation.wrapper) ctx.ui.setEditorComponent(installation.previous);
  });
}

export default function agentsDashboard(pi: ExtensionAPI): void {
  registerAgentsDashboard(pi);
}
