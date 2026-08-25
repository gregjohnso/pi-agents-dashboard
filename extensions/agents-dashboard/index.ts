import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
  parseKey,
  type EditorComponent,
} from "@earendil-works/pi-tui";

import { checkHostCapabilities, type HostCapabilityReport } from "./compatibility.js";
import { createDaemonClient } from "./daemon-client.js";
import {
  DashboardController,
  createDaemonDashboardBackend,
  type DashboardPersistence,
  type PersistedDashboardState,
} from "./dashboard.js";
import { reduceLeftGesture, createLeftGestureState, type LeftGestureState } from "./key-gesture.js";

const UNSUPPORTED_REMEDIATION = "UNSUPPORTED_HOST: run `pi-agents-dashboard doctor`; upgrade Pi to a version exposing the documented daemon-owned startup, native attachment, composable editor, and fullscreen custom UI APIs.";

interface AgentsDashboardDependencies {
  checkCapabilities(): Promise<HostCapabilityReport>;
  openDashboard(ctx: ExtensionContext, report: HostCapabilityReport): Promise<void>;
}

interface CursorEditor extends EditorComponent {
  getCursor?(): { line: number; col: number };
  focused?: boolean;
}

class GestureEditor implements EditorComponent {
  private readonly base: CursorEditor;
  private readonly openDashboard: () => void;
  private gesture: LeftGestureState;
  private submitHandler?: (text: string) => void;
  private changeHandler?: (text: string) => void;

  constructor(base: CursorEditor, openDashboard: () => void) {
    this.base = base;
    this.openDashboard = openDashboard;
    this.gesture = base.getText().length === 0
      ? createLeftGestureState()
      : reduceLeftGesture(createLeftGestureState(), { type: "editorChanged", text: base.getText() }).state;
    const priorSubmit = base.onSubmit;
    const priorChange = base.onChange;
    base.onSubmit = (text) => {
      this.gesture = reduceLeftGesture(this.gesture, { type: "submitted" }).state;
      priorSubmit?.(text);
      this.submitHandler?.(text);
    };
    base.onChange = (text) => {
      this.gesture = reduceLeftGesture(this.gesture, { type: "editorChanged", text }).state;
      priorChange?.(text);
      this.changeHandler?.(text);
    };
  }

  get onSubmit(): ((text: string) => void) | undefined { return this.submitHandler; }
  set onSubmit(handler: ((text: string) => void) | undefined) { this.submitHandler = handler; }
  get onChange(): ((text: string) => void) | undefined { return this.changeHandler; }
  set onChange(handler: ((text: string) => void) | undefined) { this.changeHandler = handler; }
  get borderColor() { return this.base.borderColor; }
  set borderColor(value) { this.base.borderColor = value; }
  get focused(): boolean { return this.base.focused ?? false; }
  set focused(value: boolean) { this.base.focused = value; }

  getText(): string { return this.base.getText(); }
  setText(text: string): void { this.base.setText(text); }
  render(width: number): string[] { return this.base.render(width); }
  invalidate(): void { this.base.invalidate(); }
  addToHistory(text: string): void { this.base.addToHistory?.(text); }
  insertTextAtCursor(text: string): void { this.base.insertTextAtCursor?.(text); }
  getExpandedText(): string { return this.base.getExpandedText?.() ?? this.base.getText(); }
  setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void { this.base.setAutocompleteProvider?.(provider); }
  setPaddingX(padding: number): void { this.base.setPaddingX?.(padding); }
  setAutocompleteMaxVisible(maxVisible: number): void { this.base.setAutocompleteMaxVisible?.(maxVisible); }

  handleInput(data: string): void {
    const parsed = parseKey(data) ?? "unknown";
    const cursor = this.base.getCursor?.();
    const result = reduceLeftGesture(this.gesture, {
      type: "key",
      key: matchesKey(data, Key.left) ? "left" : parsed,
      at: Date.now(),
      editorText: this.base.getText(),
      cursorAtStart: cursor?.line === 0 && cursor.col === 0,
      mainEditorFocused: this.focused,
      modified: parsed !== "left",
      phase: isKeyRelease(data) ? "release" : isKeyRepeat(data) ? "repeat" : "press",
    });
    this.gesture = result.state;
    if (result.openDashboard) {
      this.openDashboard();
      return;
    }
    if (!result.passThrough) return;

    const before = this.base.getText();
    const historyCandidate = matchesKey(data, Key.up) || matchesKey(data, Key.down);
    this.base.handleInput(data);
    if (historyCandidate && this.base.getText() !== before) {
      this.gesture = reduceLeftGesture(this.gesture, { type: "historyNavigated" }).state;
    }
  }
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

async function filePersistence(path: string): Promise<{ clientId: string; persistence: DashboardPersistence }> {
  let loaded: PersistedDashboardState | undefined;
  try {
    loaded = JSON.parse(await readFile(path, "utf8")) as PersistedDashboardState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const clientId = typeof loaded?.clientId === "string" && loaded.clientId.length > 0 ? loaded.clientId : randomUUID();
  const persistence: DashboardPersistence = {
    async load() { return loaded ?? { clientId }; },
    async save(state) {
      loaded = state;
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    },
  };
  if (loaded === undefined) await persistence.save({ clientId });
  return { clientId, persistence };
}

async function openDashboardWithPublicUi(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("UNSUPPORTED_HOST: /agents requires Pi interactive TUI mode.", "error");
    return;
  }
  const root = runtimeRoot();
  const { clientId, persistence } = await filePersistence(join(root, "frontend-state.json"));
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
        dispose() { void dashboard.close(); },
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
    const report = await dependencies.checkCapabilities();
    if (unsupported(report)) {
      await reportUnsupported(ctx, report);
      return;
    }
    await dependencies.openDashboard(ctx, report);
  };

  pi.registerCommand("agents", {
    description: "Open the machine-wide agents dashboard",
    handler: async (_args, ctx) => activate(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const report = await dependencies.checkCapabilities();
    if (!report.composableLeftGesture) return;
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const base = previous?.(tui, theme, keybindings)
        ?? new CustomEditor(tui, theme, keybindings);
      const cursorEditor = base as CursorEditor;
      if (typeof cursorEditor.getCursor !== "function") {
        ctx.ui.notify("UNSUPPORTED_HOST: Left gesture disabled because the existing custom editor does not expose public cursor state; use /agents or install a composable Editor-compatible component.", "warning");
      }
      return new GestureEditor(cursorEditor, () => { void activate(ctx); });
    });
  });
}

export default function agentsDashboard(pi: ExtensionAPI): void {
  registerAgentsDashboard(pi);
}
