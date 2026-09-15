import { stripVTControlCharacters } from "node:util";
import { CombinedAutocompleteProvider, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { SESSION_COLORS } from "../../shared/contracts.mjs";
import { ClearQuitGesture } from "../clear-quit-gesture.mjs";
import { createSpinnerClock } from "../spinner.mjs";
import { parseViewerEvent, parseViewerSnapshot } from "../../shared/viewer-contracts.mjs";
import { createPiComponentAdapters } from "./pi-component-adapters.mjs";
import { EMPTY_SESSION_MENU, parseSlashSubmission, sessionSlashCommands } from "./slash-commands.mjs";
import { CommandSelectionOverlay, PendingUiOverlay, TextPanelOverlay, renderStatusIndicator, renderSystemCard } from "./overlays.mjs";
import { ReturnGesture } from "./return-gesture.mjs";
import { TranscriptModel, applyViewerEvent, createTranscriptState } from "./transcript.mjs";
import { LinesComponent, createViewerLayout } from "./viewer-layout.mjs";
import { importPiModule } from "./pi-modules.mjs";

/** Pi's own key-hint formatter, which is what makes every hint read the operator's own bindings. */
export const { keyText: PI_KEY_TEXT } = await importPiModule("keybindingHints");
const keyText = PI_KEY_TEXT;

function fit(line, width) {
  const clipped = truncateToWidth(line.replace(/[\r\n\u2028\u2029]/gu, " "), Math.max(0, width), "");
  return visibleWidth(clipped) <= width ? clipped : "";
}

const COLOR_CODES = { sky: "\x1b[38;2;125;211;252m", cyan: "\x1b[38;2;125;211;252m", green: "\x1b[38;2;110;231;183m", amber: "\x1b[38;2;252;211;77m", rose: "\x1b[38;2;253;164;175m", gray: "\x1b[38;2;136;136;136m" };

const BORDER_DEFAULT = "\x1b[38;2;136;136;136m";

/**
 * Show the operator's session color and name on the prompt without recoloring what they type.
 *
 * Pi's editor draws its own border, so paint those lines rather than adding more: adding rules put
 * four horizontal lines on screen instead of two. The session name rides the top rule, right-aligned,
 * so a viewer always says which session the keystrokes go to.
 * @param {string[]} lines @param {string | undefined} color @param {number} width @param {string} [name]
 */
function framePromptBox(lines, color, width, name) {
  if (width <= 0) return lines;
  const code = (color === undefined ? undefined : COLOR_CODES[color]) ?? BORDER_DEFAULT;
  const isBorder = (line) => /^[\u2500\u250c\u2510\u2514\u2518\u256d\u256e\u256f\u2570\s]+$/u.test(stripVTControlCharacters(line)) && stripVTControlCharacters(line).trim() !== "";
  const labelled = (line) => {
    const bare = stripVTControlCharacters(line);
    const label = (name ?? "").trim();
    if (label === "" || bare.length < label.length + 6) return bare;
    return `${"─".repeat(bare.length - label.length - 3)} ${truncateToWidth(label, bare.length - 6, "…")} ─`;
  };
  const framed = lines.some(isBorder);
  if (framed) {
    let top = true;
    return lines.map((line) => {
      if (!isBorder(line)) return line;
      const painted = `${code}${top ? labelled(line) : stripVTControlCharacters(line)}\x1b[0m`;
      top = false;
      return painted;
    });
  }
  const bare = "─".repeat(width);
  return [`${code}${labelled(bare)}\x1b[0m`, ...lines, `${code}${bare}\x1b[0m`];
}

const PENDING_MESSAGE_ROWS = 3;

// Pi draws a dialog over its own transcript rather than inside it, and a dialog that captures focus
// is what keeps the viewport keys out of it.
const OVERLAY_OPTIONS = { anchor: "center", width: "80%", minWidth: 24, maxHeight: "70%" };

/** The text blocks of one normalized user message, joined the way a submission was sent. @param {any} item */
function userMessageText(item) {
  return item.content.filter((/** @type {any} */ part) => part.type === "text").map((/** @type {any} */ part) => part.text).join("\n");
}

/**
 * Every refusal Pi writes crosses the daemon under one transport code, so printing that code puts a
 * protocol token in front of the sentence that tells the operator what happened and what to do about
 * it. Dashboard codes stay: each names the part of this system that failed, and nothing else does.
 * @param {{ code: string, message: string }} error
 */
function describeViewerError(error) {
  return error.code === "RPC_COMMAND_FAILED" ? `Pi refused this command: ${error.message}` : `${error.code}: ${error.message}`;
}

/** Lay out Pi's footer: sourced viewer status on the left, the model and its thinking level right-aligned. */
function renderModelFooter({ model, thinkingLevel }, hideThinking, width) {
  if (width <= 0) return "";
  const left = hideThinking ? " Thinking blocks: hidden" : "";
  const leftWidth = visibleWidth(left);
  if (leftWidth >= width) return truncateToWidth(left, width, "");
  const thinking = thinkingLevel === null || thinkingLevel === undefined ? "" : thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`;
  const bare = `${model === null ? "no-model" : model.id}${thinking}`;
  const withProvider = model === null ? bare : `(${model.provider}) ${bare}`;
  const right = leftWidth + 2 + visibleWidth(withProvider) <= width ? withProvider : bare;
  const fitted = leftWidth + 2 + visibleWidth(right) <= width ? right : truncateToWidth(right, width - leftWidth - 2, "");
  return left + " ".repeat(Math.max(0, width - leftWidth - visibleWidth(fitted))) + fitted;
}

/**
 * Render the widest prefix of Pi's key hints plus the dashboard's own return keys that fits.
 *
 * Every key comes from Pi's own `keyText`, so an operator who rebound one is shown what he bound
 * rather than the default this package once hard-coded.
 */
function renderKeyHints({ working }, width) {
  const shared = [`${keyText("tui.altScreen.pageUp")}/${keyText("tui.altScreen.pageDown")} scroll`, `${keyText("app.message.followUp")} follow-up`, `${keyText("app.tools.expand")} tools`, `${keyText("app.thinking.toggle")} thinking`, `${keyText("app.thinking.cycle")} level`, "/ commands"];
  const segments = working
    ? [`${keyText("app.interrupt")} interrupt`, "← list", ...shared]
    : [`${keyText("app.interrupt")}/← list`, ...shared];
  for (let count = segments.length; count > 0; count -= 1) {
    const line = ` ${segments.slice(0, count).join(" · ")}`;
    if (visibleWidth(line) <= width) return line;
  }
  return "";
}

/** Whether two normalized model states name the same model, counting absent and null as one. */
function sameModel(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return (left ?? null) === (right ?? null);
  return left.provider === right.provider && left.id === right.id;
}

/** @param {{ models: { provider: string, id: string }[] }} menu */
function modelItems(menu) {
  return menu.models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}` }));
}

/**
 * One Pi selection list per rejection code a bare built-in command can raise.
 * @type {Record<string, { command?: string, title: (submitted?: string) => string, items: (menu: any) => { value: string, label: string }[] }>}
 */
const SELECTION_PICKERS = {
  MODEL_REQUIRED: { command: "/model", title: () => "Select a model", items: modelItems },
  SUMMARY_MODEL_REQUIRED: { command: "/model-summary", title: () => "Select a dashboard summary model", items: (menu) => [{ value: "off", label: "off · disable summaries" }, ...modelItems(menu)] },
  SESSION_COLOR_REQUIRED: { command: "/color", title: () => "Select a session color", items: () => [{ value: "default", label: "default · no tint" }, ...SESSION_COLORS.map((color) => ({ value: color, label: color }))] },
};

/** Own one standalone normalized Pi chat subscription and the input that writes to it. */
export class ViewerController {
  constructor({ sessionId, client, editor, persistence, requestRender, onReturn, onQuit = undefined, onDashboardAction = undefined, now = Date.now, adapters = undefined, cwd = process.cwd() }) {
    if (!sessionId || client === undefined || editor === undefined || persistence === undefined) throw new TypeError("sessionId, client, editor, and persistence are required");
    this.sessionId = sessionId;
    this.client = client;
    this.editor = editor;
    this.persistence = persistence;
    this.requestRender = requestRender ?? (() => {});
    this.onReturn = onReturn ?? (() => {});
    // Quitting ends the frontend that hosts this viewer. An attachment is the whole frontend, so its
    // quit and its return are the same thing; a dashboard's list is not, and it passes its own.
    this.onQuit = onQuit ?? this.onReturn;
    this.onDashboardAction = onDashboardAction;
    this.now = now;
    // Pi's own TUI when this viewer is hosted in one. The stand-in keeps the component seams usable
    // for a caller that renders no screen; it owns no viewport, because Pi's `ScrollView` does.
    this.tui = editor.tui ?? { mode: "fullscreen", requestRender: () => this.requestRender(), setFocus() {} };
    this.adapters = adapters ?? createPiComponentAdapters({ tui: this.tui });
    this.cwd = cwd;
    this.menu = EMPTY_SESSION_MENU;
    this.history = [];
    /** Submissions this viewer has sent and not yet seen in the transcript. @type {{ text: string, priorMatches: number }[]} */
    this.pending = [];
    this.respondedUi = new Set();
    this.hideThinking = false;
    this.daemonUnreachable = false;
    this.streamStopped = false;
    this.streamReloaded = false;
    this.edited = false;
    this.historyUsed = false;
    this.closedState = true;
    this.returnGesture = new ReturnGesture({ now: () => this.now(), onReturn: () => this.onReturn() });
    this.clearQuitGesture = new ClearQuitGesture({ now: () => this.now() });
    // The same clock the list runs, for the same reason: the spinner frame and the elapsed counter
    // are both read off the clock at paint time, and a thinking model publishes nothing to paint on.
    this.animation = createSpinnerClock({ requestRender: () => this.requestRender() });
    // Pi's keys belong to Pi's editor: it owns the action layer, resolves every one of them through
    // the operator's own keybindings, and defers the ones a completion popup needs. Reading keys here
    // would ignore his configuration and take Escape away from the popup.
    this.editor.onSubmit = (text) => { void this.submitText(text, "prompt"); };
    this.editor.onEscape = () => this.pressInterrupt();
    this.editor.onCtrlD = () => this.onQuit();
    this.editor.onAction?.("app.clear", () => this.pressClear());
    this.editor.onAction?.("app.thinking.toggle", () => this.toggleThinkingBlocks());
    this.editor.onAction?.("app.thinking.cycle", () => { void this.cycleThinkingLevel(); });
    this.editor.onAction?.("app.tools.expand", () => this.toggleToolOutput());
    // Pi's own model selector key. It opens the picker `/model` opens, which is the one this session
    // builds from the models its worker reported; nothing here cycles models on its own.
    this.editor.onAction?.("app.model.select", () => { this.returnGesture.cancel(); this.openModelPicker(); });
    // Pi's own follow-up action, bound to alt+enter by the keybindings this editor was built with.
    // Both keys reach the same submission path; only the operation they name differs.
    this.editor.onAction?.("app.message.followUp", () => { void this.submitText(this.editor.getText(), "follow_up"); });
    this.editor.onChange = () => { if (!this.restoring) this.edited = true; };
    this.installLayout();
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  async open() {
    if (!this.closedState) return;
    this.closedState = false;
    // A quit armed before this viewer was put away cannot travel into the viewer it comes back as.
    this.clearQuitGesture.cancel();
    try {
      const persisted = await this.persistence.load(this.sessionId);
      this.restoring = true;
      if (persisted?.sessionId === this.sessionId) {
        this.history = [...(persisted.history ?? [])];
        for (const entry of this.history) this.editor.addToHistory?.(entry);
        this.editor.setText(persisted.draft ?? "");
        this.edited = (persisted.draft ?? "").length > 0;
      } else {
        this.editor.setText("");
        this.edited = false;
      }
      this.restoring = false;
      // One call opens the subscription and answers with the snapshot it continues, so no event can
      // fall between the two. Events published while this transcript is being built wait in the
      // subscription's own queue until the pump below reads them.
      const subscription = await this.client.subscribeViewer(this.sessionId);
      this.state = createTranscriptState(parseViewerSnapshot(subscription.snapshot));
      this.editor.focused = true;
      this.transcript = new TranscriptModel({ state: this.state, adapters: this.adapters });
      this.installOverlay();
      this.consume(subscription);
      this.watchConnection = this.client.onConnectionChange((status) => this.onConnection(status));
      await this.requestRender();
      // The menu is a round trip to this session's worker and Pi. Nothing the first frame draws needs
      // it, so it loads behind the open: a worker that answers slowly, or not at all, can no longer
      // hold the operator inside the list-to-viewer transition.
      this.menuLoaded = this.loadMenu().then(() => this.requestRender()).catch((error) => this.fail(error));
    } catch (error) {
      this.openError = error;
      await this.close({ persist: false });
      throw error;
    }
  }

  /**
   * Read one subscription's events until it ends. A subscription that stops for a reason of its own,
   * rather than because this viewer closed it, reaches `streamFailed`, which answers with one rebuild.
   * @param {{ events: AsyncIterator<any>, unsubscribe: () => void }} subscription
   */
  consume(subscription) {
    if (this.closedState) {
      subscription.unsubscribe();
      return;
    }
    let active = true;
    this.unsubscribe = () => { active = false; subscription.unsubscribe(); };
    void (async () => {
      try {
        while (active) {
          const next = await subscription.events.next();
          if (next.done || !active) return;
          await this.processEvent(next.value);
        }
      } catch (error) {
        if (active) await this.streamFailed(error);
      }
    })();
  }

  /**
   * Compose this viewer as one Pi layout: a fixed header, the whole transcript inside Pi's primary
   * scroll view, and a fixed dock. Nothing here is clipped to a viewport, because the scroll view
   * and the host's terminal height decide what is on screen.
   */
  installLayout() {
    const layout = createViewerLayout({
      header: new LinesComponent((width) => this.renderHeader(width)),
      document: new LinesComponent((width) => this.transcript?.render(width) ?? []),
      notices: new LinesComponent((width) => this.renderNotices(width)),
      status: new LinesComponent((width) => this.renderStatus(width)),
      editor: new LinesComponent((width) => this.renderEditor(width)),
      footer: new LinesComponent((width) => this.renderFooter(width)),
    });
    this.layoutRoot = layout.root;
    this.viewport = layout.viewport;
  }

  renderHeader(width) {
    if (this.state === undefined) return [fit("Loading viewer…", width)];
    const header = width >= 70
      ? ` pi-agents · ${this.sessionId} · ${this.state.taskState}/${this.state.processState}`
      : width >= 50
        ? ` ${this.sessionId} · ${this.state.taskState}/${this.state.processState}`
        : ` ${this.state.taskState}/${this.state.processState}`;
    return [fit(header, width)];
  }

  /** Connection state, the newest refusal, and what this viewer has sent and not yet seen. */
  renderNotices(width) {
    if (this.state === undefined) return [];
    const connection = this.daemonUnreachable ? [" Daemon unreachable · reconnecting…"] : this.streamStopped ? [" Transcript stopped · Esc to the list, then reopen this session"] : [];
    const errors = this.state.errors.slice(-1).flatMap((error) => renderSystemCard({ text: describeViewerError(error), level: "error" }, width));
    return [...connection, ...errors, ...this.renderPending()].map((line) => fit(line, width));
  }

  /**
   * A stopped stream cannot report a running turn: the spinner would be drawn from the last state
   * this viewer received, which is exactly the frozen-but-live-looking transcript this dock exists
   * to prevent.
   */
  renderStatus(width) {
    if (this.state === undefined) return [];
    const working = this.state.working && !this.streamStopped;
    // Armed from the paint, the way the list arms its own: the state that starts a turn is the state
    // that draws the first frame of it. A settled turn, a stopped stream and a closed viewer each
    // stop it here or in `close`, so nothing repaints a session the operator is no longer watching.
    this.animation.sync(working && !this.closedState);
    return renderStatusIndicator(this.state.activity, width, this.now(), { working }).map((line) => fit(line, width));
  }

  /** Pi's editor inside this session's frame. Its lines are left alone: they carry the cursor marker. */
  renderEditor(width) {
    return framePromptBox(this.editor.render(width), this.sessionColor, width, this.menu?.name);
  }

  renderFooter(width) {
    if (this.state === undefined) return [];
    const hints = renderKeyHints(this.state, width);
    return [renderModelFooter(this.state, this.hideThinking, width), ...(hints === "" ? [] : [hints])].map((line) => fit(line, width));
  }

  handleInput(data) {
    if (this.closedState || this.state === undefined) return;
    if (this.overlay === undefined && this.selection !== undefined) {
      this.returnGesture.cancel();
      this.selection.handleInput(data);
      this.requestRender();
      return;
    }
    if (this.overlay !== undefined) {
      this.returnGesture.cancel();
      this.overlay.handleInput(data);
      this.requestRender();
      return;
    }
    // Pi's alternate screen reads the viewport keys off the terminal before any focused component
    // sees them, so nothing here scrolls: PageUp/PageDown, Home/End, the wheel and search all reach
    // the scroll view this viewer's transcript lives in.
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.historyUsed ||= this.history.length > 0;
      this.returnGesture.cancel();
      this.editor.handleInput(data);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (this.editor.getText().length > 0) {
        this.returnGesture.cancel();
        this.editor.handleInput(data);
        this.requestRender();
        return;
      }
      const key = "left";
      const clean = !this.edited && !this.historyUsed;
      const result = this.returnGesture.handle(key, { clean, overlayCaptured: false });
      if (result === "armed") this.editor.handleInput(data);
      this.requestRender();
      return;
    }
    this.returnGesture.cancelForInput("other");
    this.editor.handleInput(data);
    this.requestRender();
  }

  /**
   * Pi's `app.interrupt`, which is Escape: stop a running turn, and leave the session once it is
   * settled. Pi's editor calls this only when no completion popup is open, so Escape still closes
   * the popup first. The draft is persisted, so leaving needs no second press.
   */
  pressInterrupt() {
    this.returnGesture.cancel();
    if (this.state?.working) {
      void this.sendCommand("interrupt", {});
      this.requestRender();
      return;
    }
    this.onReturn();
  }

  /**
   * Pi's `app.clear`, which is Ctrl+C: empty the composer, and quit when a second press lands inside
   * the window. It interrupts nothing, because Escape is Pi's interrupt: a press that only meant to
   * abandon a half-typed line must not stop the turn that is running.
   */
  pressClear() {
    this.returnGesture.cancel();
    if (this.clearQuitGesture.press() === "quit") {
      this.onQuit();
      return;
    }
    this.clearEditor();
  }

  /** Pi's `app.thinking.toggle`: show or hide thinking blocks in this transcript. No session sees it. */
  toggleThinkingBlocks() {
    this.returnGesture.cancel();
    this.hideThinking = !this.hideThinking;
    this.transcript.setThinkingHidden(this.hideThinking);
    this.requestRender();
  }

  /**
   * Pi's `app.model.select`: the picker a bare `/model` opens, on the key Pi binds it to.
   *
   * The composer is the operator's, not this picker's: he pressed a key, he did not submit a line.
   * So nothing here writes to the editor at all, which is what keeps his draft and his cursor where
   * he left them through the open, a cancel, and the round trip a chosen model costs.
   */
  openModelPicker() {
    if (this.openSelection("MODEL_REQUIRED", undefined, { composer: "keep" })) return;
    void this.recordError({ code: "MODEL_REQUIRED", message: "This session reported no models. Stop and reopen the session to refresh them.", retryable: false });
  }

  /** Pi's `app.tools.expand`: expand or collapse every tool's output at once. No session sees it. */
  toggleToolOutput() {
    this.returnGesture.cancel();
    this.transcript.setToolsExpanded(!this.transcript.toolsExpanded);
    this.requestRender();
  }

  /** Load and install the session's discovered slash-command menu. @returns {Promise<boolean>} whether it loaded */
  async loadMenu() {
    try {
      const menu = await this.client.sessionMenu(this.sessionId);
      this.menu = {
        commands: Array.isArray(menu?.commands) ? menu.commands : [],
        models: Array.isArray(menu?.models) ? menu.models : [],
        model: menu?.model ?? null,
        color: menu?.color ?? null,
        name: typeof menu?.name === "string" ? menu.name : undefined,
        // A daemon or worker that reports neither leaves this session with no level to pick.
        thinkingLevels: Array.isArray(menu?.thinkingLevels) ? menu.thinkingLevels : [],
        thinkingLevel: menu?.thinkingLevel ?? null,
      };
      // The colour is stored on the session record, so adopt it on every open, not only when /color runs.
      this.sessionColor = this.menu.color ?? undefined;
      this.editor.setAutocompleteProvider?.(new CombinedAutocompleteProvider(/** @type {any} */ (sessionSlashCommands(this.menu)), this.cwd));
      return true;
    } catch (error) {
      this.menu = EMPTY_SESSION_MENU;
      const code = /** @type {any} */ (error)?.code;
      await this.recordError(code === "UNSUPPORTED_WORKER_OPERATION"
        ? { code: "SESSION_COMMANDS_UNAVAILABLE", message: "This session's worker predates slash commands. Stop and reopen the session to refresh them.", retryable: false }
        : { code: code ?? "SESSION_COMMANDS_UNAVAILABLE", message: error instanceof Error ? error.message : "Session commands are unavailable", retryable: false });
      this.editor.setAutocompleteProvider?.(new CombinedAutocompleteProvider(/** @type {any} */ (sessionSlashCommands(this.menu)), this.cwd));
      return false;
    }
  }

  /**
   * Pi's `app.thinking.cycle`, which is Shift+Tab: move to the next thinking level Pi reported for
   * the model this session is on.
   *
   * The level this counts from is the one last asked for while Pi has not confirmed it yet, so two
   * quick presses move two steps rather than sending the same level twice; a refusal drops that
   * memory, so the press after it counts from what Pi last confirmed. Nothing here moves the footer:
   * only Pi's own confirmation does.
   */
  async cycleThinkingLevel() {
    if (this.state === undefined) return;
    // Pi reports the levels in the session menu, which is a worker round trip that starts behind the
    // open and is normally still in flight when the first frame is drawn. A press that read the menu
    // now would find it empty and tell the operator his session reported no levels at all, so it
    // waits for the read already running rather than starting one of its own.
    await this.menuLoaded;
    if (this.closedState || this.state === undefined) return;
    const levels = this.menu.thinkingLevels ?? [];
    if (levels.length === 0) {
      await this.recordError({ code: "THINKING_LEVELS_UNAVAILABLE", message: "This session reported no thinking levels. Pi reports them per model, and a worker from an older release reports none at all; stop and reopen the session to refresh it.", retryable: false });
      return;
    }
    const current = this.requestedThinkingLevel ?? this.state.thinkingLevel ?? this.menu.thinkingLevel;
    const level = levels[(levels.indexOf(/** @type {any} */ (current)) + 1) % levels.length];
    this.requestedThinkingLevel = level;
    // One request at a time, in press order: two levels racing would leave the session on whichever
    // Pi happened to apply last.
    this.thinkingCycle = (this.thinkingCycle ?? Promise.resolve(true)).then(() => this.sendCommand("session_command", { command: "set_thinking_level", level }));
    if (!await this.thinkingCycle && this.requestedThinkingLevel === level) this.requestedThinkingLevel = undefined;
  }

  /**
   * Submit the composer as one session command or one line of text.
   *
   * `operation` is the key the operator pressed, not a reading of this session's state: `prompt` for
   * Enter and `follow_up` for Alt+Enter. The worker turns each into the streaming behavior Pi applies
   * if a run is already going, and Pi decides that in the same step it reads its own state.
   * `fromComposer` is false for text this viewer built from a key-opened picker rather than from the
   * operator's own line: it is not his to record in prompt history, and the composer it never came
   * from must be left exactly as he has it, including whatever he typed while the command was away.
   * @param {string} text @param {"prompt" | "follow_up"} operation @param {{ fromComposer?: boolean }} [options]
   */
  async submitText(text, operation = "prompt", { fromComposer = true } = {}) {
    const prompt = text.trim();
    if (this.state === undefined || prompt.length === 0) return;
    const submission = parseSlashSubmission(prompt, this.menu);
    if (submission.kind === "rejected") {
      const bare = /^\/\S+$/u.test(prompt) ? prompt : undefined;
      if (!this.openSelection(submission.code, bare)) await this.recordError({ code: submission.code, message: submission.message, retryable: false });
      return;
    }
    if (submission.kind === "help") {
      this.openTextPanel("Viewer help", this.helpRows());
      this.clearEditor();
      return;
    }
    if (submission.kind === "dashboard") {
      this.clearEditor();
      if (typeof this.onDashboardAction !== "function") {
        await this.recordError({ code: "DASHBOARD_ACTION_UNAVAILABLE", message: "This frontend cannot open the dashboard from the viewer", retryable: false });
        return;
      }
      this.onDashboardAction(submission.action);
      return;
    }
    if (submission.kind === "session_color") {
      if (!await this.sendSessionColor(submission.color)) return;
      await this.loadMenu();
    } else if (submission.kind === "settings") {
      if (!await this.sendSettings(submission.payload)) return;
      await this.loadMenu();
    } else if (submission.kind === "session_command") {
      if (!await this.sendCommand("session_command", submission.payload)) return;
      await this.loadMenu();
    } else {
      const entry = this.notePending(submission.text);
      if (!await this.sendCommand(operation, { text: submission.text })) { this.dropPending(entry); if (fromComposer) this.recoverRefusedText(prompt); return; }
    }
    if (!fromComposer) return;
    this.history.push(prompt);
    this.editor.addToHistory?.(prompt);
    this.restoring = true; this.editor.setText(""); this.restoring = false;
    this.edited = false; this.historyUsed = false;
  }

  /**
   * Draw one accepted submission before the transcript carries it, and draw it now rather than after
   * the round trip: the operator has to see that his text was taken.
   *
   * A normalized `user_message` carries no submission identity, so its text is the only tie back to
   * what this viewer sent. Pi matches its own queues the same way. `priorMatches` records how many
   * transcript user messages already carried this text, so a line the operator sent an hour ago
   * cannot clear the identical line he just sent.
   *
   * Text starting with `/` gets no row at all: Pi expands a submitted slash before it becomes a
   * message, so it can reach the transcript changed or, as an extension command, never reach it.
   * @param {string} text
   */
  notePending(text) {
    if (text.startsWith("/")) return undefined;
    const entry = { text, priorMatches: (this.state?.items ?? []).filter((item) => item.kind === "user_message" && userMessageText(item) === text).length };
    this.pending.push(entry);
    void this.requestRender();
    return entry;
  }

  /** Take one submission out of the pending block: Pi refused it, so nothing is outstanding. @param {any} [entry] */
  dropPending(entry) {
    if (entry === undefined) return;
    this.pending = this.pending.filter((candidate) => candidate !== entry);
  }

  /**
   * Drop each pending submission the transcript now carries. Pi publishes the user message when it
   * starts the turn holding that text, whether it began immediately or waited in a queue, so that is
   * the one thing that clears a row: no turn boundary and no cached working flag do, because neither
   * says anything about text Pi has not shown yet.
   */
  syncPending() {
    if (this.pending.length === 0) return;
    /** @type {Map<string, number>} */
    const landed = new Map();
    for (const item of this.state?.items ?? []) {
      if (item.kind !== "user_message") continue;
      const text = userMessageText(item);
      landed.set(text, (landed.get(text) ?? 0) + 1);
    }
    /** @type {Map<string, number>} */
    const seen = new Map();
    this.pending = this.pending.filter((entry) => {
      const count = landed.get(entry.text) ?? 0;
      const index = seen.get(entry.text) ?? 0;
      seen.set(entry.text, index + 1);
      // A snapshot window that no longer reaches the older identical message would strand this row.
      entry.priorMatches = Math.min(entry.priorMatches, count);
      return count < entry.priorMatches + index + 1;
    });
  }

  /** Draw what this viewer has sent and not yet seen, in submission order, above the status indicator. */
  renderPending() {
    if (this.pending.length === 0) return [];
    const shown = this.pending.slice(0, PENDING_MESSAGE_ROWS).map((entry) => ` Pending: ${entry.text}`);
    const remaining = this.pending.length - shown.length;
    return ["", ...shown, ...(remaining > 0 ? [` … ${remaining} more pending`] : [])];
  }

  async sendCommand(operation, payload) {
    const request = { sessionId: this.sessionId, ...payload };
    try {
      await this.client.command(operation, request);
      return true;
    } catch (error) {
      const typed = /** @type {any} */ (error);
      await this.recordError({ code: typed?.code ?? "VIEWER_COMMAND_FAILED", message: error instanceof Error ? error.message : "Viewer command failed", retryable: typed?.retryable === true });
      return false;
    }
  }

  /**
   * Put back text the session refused. Pi's editor empties itself before it calls `onSubmit`, so by
   * the time a refusal arrives the operator's line is already off the screen and this is the only
   * copy of it left.
   *
   * A composer he has typed into since is never overwritten: that line goes to prompt history, where
   * Up recalls it, because replacing newer text is worse than losing the refusal's place. Nothing is
   * resent; the operator decides whether to send it again.
   * @param {string} text
   */
  recoverRefusedText(text) {
    if (this.editor.getText().trim().length === 0) {
      this.restoring = true; this.editor.setText(text); this.restoring = false;
      this.edited = true;
    } else {
      this.history.push(text);
      this.editor.addToHistory?.(text);
    }
    void this.requestRender();
  }

  /** Clear the composer after a command that never becomes a transcript message. */
  clearEditor() {
    this.restoring = true;
    this.editor.setText("");
    this.restoring = false;
    this.edited = false;
    this.requestRender();
  }

  /**
   * Put one overlay in front of the transcript through Pi's own overlay stack, which is what keeps
   * the viewport keys and search out of a dialog that is waiting for an answer.
   * @param {any} overlay
   */
  presentOverlay(overlay) {
    const handle = this.tui.showOverlay?.(overlay, OVERLAY_OPTIONS);
    void this.requestRender();
    return handle;
  }

  /** @param {any} overlay @param {any} handle */
  dismissOverlay(overlay, handle) {
    overlay?.dispose();
    handle?.hide();
  }

  /** @param {string} title @param {string[]} rows */
  openTextPanel(title, rows) {
    this.dismissOverlay(this.overlay, this.overlayHandle);
    this.overlay = new TextPanelOverlay({
      title, rows,
      tui: this.tui,
      returnFocus: this.editor,
      respond: () => {
        const resolved = this.overlay;
        const handle = this.overlayHandle;
        this.overlay = undefined;
        this.overlayHandle = undefined;
        this.dismissOverlay(resolved, handle);
        void this.requestRender();
      },
    });
    this.overlayHandle = this.presentOverlay(this.overlay);
  }

  helpRows() {
    return [
      ...sessionSlashCommands(this.menu)
        .filter((command) => command.source === "builtin")
        .map((command) => `/${command.name}${command.argumentHint === undefined ? "" : ` ${command.argumentHint}`}  ${command.description ?? ""}`.trim()),
      "",
      `${keyText("app.interrupt")}  interrupt a running turn, then return to the list`,
      "←  return to the list",
      "↑↓  recall prompt history",
      `Enter  send now, steering a run already going · ${keyText("app.message.followUp")}  queue a follow-up for after it`,
      `${keyText("tui.altScreen.pageUp")}/${keyText("tui.altScreen.pageDown")}  scroll · ${keyText("tui.altScreen.top")}/${keyText("tui.altScreen.bottom")}  start or end · wheel scrolls · ${keyText("tui.altScreen.search")}  search the transcript`,
      "drag  select and copy · click  open a link",
      `${keyText("app.thinking.toggle")}  hide or show thinking blocks · ${keyText("app.thinking.cycle")}  next thinking level`,
      `${keyText("app.tools.expand")}  expand or collapse every tool's output`,
      `${keyText("app.clear")}  clear the prompt; press again within 500 ms to quit · ${keyText("app.exit")}  quit from an empty prompt`,
    ];
  }

  /** Apply the dashboard's session color. Registry metadata only: no Pi worker is involved. @param {string | null} color */
  async sendSessionColor(color) {
    try {
      const result = await this.client.setSessionColor(this.sessionId, color);
      this.sessionColor = result?.color ?? undefined;
      this.clearEditor();
      return true;
    } catch (error) {
      const typed = /** @type {any} */ (error);
      await this.recordError({ code: typed?.code ?? "SESSION_COLOR_FAILED", message: error instanceof Error ? error.message : "Session color update failed", retryable: false });
      return false;
    }
  }

  async sendSettings(payload) {
    try {
      await this.client.setSettings(payload);
      return true;
    } catch (error) {
      const typed = /** @type {any} */ (error);
      await this.recordError({ code: typed?.code ?? "SETTINGS_FAILED", message: error instanceof Error ? error.message : "Dashboard settings update failed", retryable: false });
      return false;
    }
  }

  /** @param {{code:string,message:string,retryable:boolean}} error */
  async recordError(error) {
    if (this.state !== undefined) {
      this.state = { ...this.state, errors: [...this.state.errors, error].slice(-100) };
      this.transcript?.update(this.state);
    }
    await this.requestRender();
  }

  /** @param {{ connected: boolean }} status */
  async onConnection(status) {
    if (this.closedState) return;
    this.daemonUnreachable = !status.connected;
    if (status.connected) await this.resynchronize();
    else await this.requestRender();
  }

  /**
   * Rebuild against a daemon that just came back. A restarted daemon knows nothing of this
   * connection and issues a new epoch, so this viewer's attachment and cursor both died with the old
   * process: attach again, then resubscribe from a fresh snapshot.
   *
   * The applied event IDs cross into the rebuilt state. Their effects are already in the snapshot,
   * and the resumed subscription can hand the last event over again, which only a stable event ID
   * absorbs: a placeholder or an unrecognized Pi event has no other identity to replace on.
   */
  async resynchronize() {
    // One rebuild at a time: a refused subscription and a returning daemon can each ask for one, and
    // two in flight would leave two live subscriptions with only the newer one owned here.
    this.rebuilding ??= this.rebuild().finally(() => { this.rebuilding = undefined; });
    return this.rebuilding;
  }

  /** Rebuild this transcript from a fresh snapshot and resubscribe from that snapshot's cursor. */
  async rebuild() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    let attachError;
    try { await this.client.attach(this.sessionId); } catch (error) { attachError = error; }
    try {
      const subscription = await this.client.subscribeViewer(this.sessionId);
      const applied = this.state?.eventIds ?? [];
      this.state = createTranscriptState(parseViewerSnapshot(subscription.snapshot));
      for (const eventId of applied) this.state.eventIds.add(eventId);
      // A message that landed while this viewer was not subscribed is in this snapshot rather than in
      // an event. Its pending row has to go now or nothing else will move it.
      this.syncPending();
      this.transcript.update(this.state);
      this.installOverlay();
      this.consume(subscription);
      this.streamStopped = false;
    } catch (error) {
      // No subscription survived the rebuild, so this transcript is not being updated any more.
      this.streamStopped = true;
      const typed = /** @type {any} */ (error);
      await this.recordError({ code: typed?.code ?? "VIEWER_RESYNC_FAILED", message: error instanceof Error ? error.message : "This session could not be reloaded after the daemon restarted", retryable: true });
    }
    if (attachError !== undefined) {
      const typed = /** @type {any} */ (attachError);
      await this.recordError({ code: typed?.code ?? "SESSION_REATTACH_FAILED", message: attachError instanceof Error ? attachError.message : "This session could not be reopened after the daemon restarted", retryable: false });
    }
    await this.requestRender();
  }

  async processEvent(value) {
    if (this.closedState) throw Object.assign(new Error("Viewer is closed"), { code: "VIEWER_CLOSED" });
    try {
      const event = parseViewerEvent(value);
      if (event.sessionId !== this.sessionId) throw Object.assign(new Error("Viewer event session mismatch"), { code: "VIEWER_SESSION_MISMATCH" });
      const previousModel = this.state.model;
      this.state = applyViewerEvent(this.state, event);
      // Pi confirmed the level this viewer asked for, so the next cycle counts from Pi's own state.
      if (this.requestedThinkingLevel !== undefined && this.state.thinkingLevel === this.requestedThinkingLevel) this.requestedThinkingLevel = undefined;
      // Pi reports thinking levels per model, so a model that actually changed makes the ones held
      // here stale, and the level this viewer is still waiting on with it. Reading them again behind
      // the event keeps a cycle from sending a level this model has no use for.
      //
      // Only a change reloads. Reading the menu is itself a Pi `get_state`, and the normalizer
      // republishes every `get_state` response as another `model_state` carrying the same model, so
      // reloading on each one is a request loop between this viewer and Pi that never settles: one
      // acceptance run logged 11,732 Pi commands for a single session.
      if (event.payload.kind === "model_state" && !sameModel(previousModel, this.state.model)) {
        this.requestedThinkingLevel = undefined;
        this.menuLoaded = this.loadMenu().then(() => this.requestRender()).catch((error) => this.fail(error));
      }
      // An event is the only proof this viewer has that its subscription is live, so it is also what
      // restores the one reload a later refusal may spend.
      this.streamStopped = false;
      this.streamReloaded = false;
      this.syncPending();
      this.transcript.update(this.state);
      this.installOverlay();
      await this.requestRender();
      await this.persistence.save(this.persisted(event.cursor));
    } catch (error) {
      await this.close({ persist: false });
      throw error;
    }
  }

  /**
   * Offer one Pi selection list for a built-in command submitted without its argument.
   *
   * `composer: "keep"` is for a picker a key opened rather than a submitted line: the choice is not
   * the operator's own text, so it goes neither into his prompt history nor over his draft.
   * @param {string} code @param {string} [submitted] @param {{ composer?: "clear" | "keep" }} [options]
   */
  openSelection(code, submitted, { composer = "clear" } = {}) {
    const picker = SELECTION_PICKERS[code];
    if (picker === undefined) return false;
    const command = picker.command ?? submitted;
    const items = picker.items(this.menu);
    if (command === undefined || items.length === 0) return false;
    this.showSelection({ title: picker.title(submitted), items, onChoice: (value) => { void this.submitText(`${command} ${value}`, "prompt", { fromComposer: composer === "clear" }); } });
    if (composer === "clear") {
      // The submitted line is the command this picker completes, so it leaves the composer with it.
      this.restoring = true; this.editor.setText(""); this.restoring = false;
      this.edited = false;
    }
    return true;
  }

  /**
   * Open one bounded Pi selection list over the transcript. Cancelling costs nothing: no request is
   * sent and the composer is left exactly as the operator had it.
   * @param {{ title: string, items: { value: string, label: string }[], selected?: string, onChoice: (value: string) => void }} options
   */
  showSelection({ title, items, selected, onChoice }) {
    this.dismissOverlay(this.selection, this.selectionHandle);
    this.selection = new CommandSelectionOverlay({
      title, items, selected,
      tui: this.tui,
      returnFocus: this.editor,
      respond: (/** @type {string | undefined} */ value) => {
        const resolved = this.selection;
        const handle = this.selectionHandle;
        this.selection = undefined;
        this.selectionHandle = undefined;
        this.dismissOverlay(resolved, handle);
        if (value === undefined) { void this.requestRender(); return; }
        onChoice(value);
      },
    });
    this.selectionHandle = this.presentOverlay(this.selection);
  }

  installOverlay() {
    const request = this.state?.pendingUi.find((candidate) => !this.respondedUi.has(candidate.id));
    if (request === undefined) {
      this.dismissOverlay(this.overlay, this.overlayHandle);
      this.overlay = undefined;
      this.overlayHandle = undefined;
      return;
    }
    if (this.overlay?.request?.id === request.id) return;
    this.dismissOverlay(this.overlay, this.overlayHandle);
    this.overlay = new PendingUiOverlay({
      request,
      tui: this.tui,
      returnFocus: this.editor,
      respond: (response) => {
        this.respondedUi.add(response.requestId);
        const resolved = this.overlay;
        const handle = this.overlayHandle;
        this.overlay = undefined;
        this.overlayHandle = undefined;
        this.dismissOverlay(resolved, handle);
        void this.sendCommand("ui_response", { uiRequestId: response.requestId, response: response.cancelled ? null : response.value });
      },
    });
    this.overlayHandle = this.presentOverlay(this.overlay);
  }

  persisted(cursor = this.state?.cursor) { return { sessionId: this.sessionId, cursor, draft: this.editor.getText(), history: [...this.history] }; }

  async close(options = {}) {
    if (this.closedState) return;
    this.closedState = true;
    this.animation.stop();
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.watchConnection?.(); this.watchConnection = undefined;
    try {
      if (options.persist !== false) await this.persistence.save(this.persisted());
    } finally {
      this.dismissOverlay(this.overlay, this.overlayHandle);
      this.overlay = undefined;
      this.overlayHandle = undefined;
      this.dismissOverlay(this.selection, this.selectionHandle);
      this.selection = undefined;
      this.selectionHandle = undefined;
      this.resolveClosed?.();
    }
  }

  /**
   * The event stream this viewer reads stopped: its bounded queue overflowed, the daemon rebuilt this
   * session from canonical history and its worker's tail, or the connection went away. A refusal used
   * to reach nothing at all, so the transcript stopped while the dock kept drawing the last state
   * this viewer had received.
   *
   * Every one of those is recoverable the same way, and it is the only recovery there is now that
   * nothing replays: one reload from a fresh snapshot, the way the list refetches. A second refusal
   * with no event in between is not reloaded again, because retrying a refusal is a request loop
   * rather than a recovery.
   */
  async streamFailed(error) {
    if (this.closedState) return;
    if (!this.streamReloaded) {
      this.streamReloaded = true;
      await this.resynchronize();
      return;
    }
    this.streamStopped = true;
    const typed = /** @type {any} */ (error);
    await this.recordError({ code: typed?.code ?? "VIEWER_STREAM_FAILED", message: error instanceof Error ? error.message : "This session stopped receiving updates", retryable: false });
  }

  async fail(error) { this.error = error; await this.close({ persist: false }); }
}
