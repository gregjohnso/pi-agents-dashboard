import { stripVTControlCharacters } from "node:util";
import { CombinedAutocompleteProvider, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { SESSION_COLORS } from "../../shared/contracts.mjs";
import { ClearQuitGesture } from "../clear-quit-gesture.mjs";
import { parseViewerEvent, parseViewerSnapshot } from "../../shared/viewer-contracts.mjs";
import { createPiComponentAdapters } from "./pi-component-adapters.mjs";
import { EMPTY_SESSION_MENU, parseSlashSubmission, sessionSlashCommands } from "./slash-commands.mjs";
import { CommandSelectionOverlay, PendingUiOverlay, TextPanelOverlay, renderStatusIndicator, renderSystemCard } from "./overlays.mjs";
import { ReturnGesture } from "./return-gesture.mjs";
import { TranscriptModel, applyViewerEvent, createTranscriptState } from "./transcript.mjs";

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

// One line per wheel notch leaves acceleration to the terminal and the OS, which already translate a
// trackpad swipe into a notch count.
const WHEEL_SCROLL_LINES = 1;

const PENDING_MESSAGE_ROWS = 3;
const MIN_TRANSCRIPT_ROWS = 3;

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

/** Render the widest prefix of Pi's key hints plus the dashboard's own return keys that fits. */
function renderKeyHints({ working }, width) {
  const segments = working
    ? ["Esc interrupt", "← list", "↑↓ scroll", "Alt+Enter follow-up", "Ctrl+T thinking", "Ctrl+O tools", "/ commands"]
    : ["Esc/← list", "↑↓ scroll", "Alt+Enter follow-up", "Ctrl+T thinking", "Ctrl+O tools", "/ commands"];
  for (let count = segments.length; count > 0; count -= 1) {
    const line = ` ${segments.slice(0, count).join(" · ")}`;
    if (visibleWidth(line) <= width) return line;
  }
  return "";
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
    this.adapters = adapters ?? createPiComponentAdapters({ tui: editor.tui ?? { mode: "fullscreen", requestRender: () => this.requestRender(), setFocus() {} } });
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
    this.editor.onSubmit = (text) => { void this.submitText(text, "prompt"); };
    // Pi's own follow-up action, bound to alt+enter by the keybindings this editor was built with.
    // Both keys reach the same submission path; only the operation they name differs.
    this.editor.onAction?.("app.message.followUp", () => { void this.submitText(this.editor.getText(), "follow_up"); });
    this.editor.onChange = () => { if (!this.restoring) this.edited = true; };
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

  render(width, height) {
    width = Math.max(0, Math.floor(width)); height = Math.max(0, Math.floor(height));
    if (height === 0) return [];
    if (this.state === undefined) return Array.from({ length: height }, () => fit("Loading viewer…", width));
    const header = width >= 70
      ? ` pi-agents · ${this.sessionId} · ${this.state.taskState}/${this.state.processState}`
      : width >= 50
        ? ` ${this.sessionId} · ${this.state.taskState}/${this.state.processState}`
        : ` ${this.state.taskState}/${this.state.processState}`;
    // A stopped stream cannot report a running turn: the spinner would be drawn from the last state
    // this viewer received, which is exactly the frozen-but-live-looking transcript this dock exists
    // to prevent.
    let status = renderStatusIndicator(this.state.activity, width, this.now(), { working: this.state.working && !this.streamStopped });
    const promptLines = this.editor.render(width);
    let editorLines = framePromptBox(promptLines, this.sessionColor, width, this.menu?.name);
    const selectedTool = this.transcript.selectedToolId === undefined ? undefined : this.state.tools.get(this.transcript.selectedToolId);
    const toolLine = selectedTool === undefined ? [] : [` tool:${selectedTool.name} ${selectedTool.state} ${this.transcript.expandedTools.has(selectedTool.id) ? "expanded" : "collapsed"}`];
    let errorLines = this.state.errors.slice(-1).flatMap((error) => renderSystemCard({ text: describeViewerError(error), level: "error" }, width));
    let pendingLines = this.renderPending();
    const connectionLines = [
      ...(this.daemonUnreachable ? [" Daemon unreachable · reconnecting…"] : this.streamStopped ? [" Transcript stopped · Esc to the list, then reopen this session"] : []),
      ...(this.thinkingLoading ? [" Thinking levels… · Esc cancels"] : []),
    ];
    let hints = renderKeyHints(this.state, width);
    const dockRows = () => 2 + (hints === "" ? 0 : 1) + status.length + editorLines.length + toolLine.length + errorLines.length + pendingLines.length + connectionLines.length;
    if (height - dockRows() < MIN_TRANSCRIPT_ROWS) {
      // Pi's dock gives up its own rows before the transcript loses any: spacers first, then the
      // prompt frame, then the hints. Only decoration goes; every dock line with content stays.
      status = status.slice(1); errorLines = errorLines.slice(1); pendingLines = pendingLines.slice(1);
      if (height - dockRows() < MIN_TRANSCRIPT_ROWS) editorLines = this.editor.render(width);
      if (height - dockRows() < MIN_TRANSCRIPT_ROWS) hints = "";
    }
    const transcriptHeight = Math.max(0, height - dockRows());
    let body = this.transcript.render(width, transcriptHeight);
    const activeOverlay = this.overlay ?? this.selection;
    if (activeOverlay !== undefined) {
      const overlayLines = activeOverlay.render(width).slice(0, transcriptHeight);
      const start = Math.max(0, body.length - overlayLines.length);
      body = [...body.slice(0, start), ...overlayLines];
    }
    const footer = renderModelFooter(this.state, this.hideThinking, width);
    const lines = [header, ...body, ...connectionLines, ...errorLines, ...pendingLines, ...status, ...toolLine, ...editorLines, footer, ...(hints === "" ? [] : [hints])].map((line) => fit(line, width));
    while (lines.length < height) lines.splice(1, 0, "");
    return lines.slice(0, height);
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
      // A dialog holds text of its own, so Ctrl+C interrupts and quits here but clears nothing.
      if (matchesKey(data, Key.ctrl("c"))) {
        this.pressCtrlC({ clearsEditor: false });
        return;
      }
      this.overlay.handleInput(data);
      this.requestRender();
      return;
    }
    if (this.thinkingLoading && matchesKey(data, Key.escape)) {
      this.cancelThinkingPicker();
      this.returnGesture.cancel();
      return;
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.returnGesture.cancel();
      void this.openThinkingPicker();
      return;
    }
    if (this.transcript.selectedToolId !== undefined) {
      if (matchesKey(data, Key.escape)) this.transcript.clearToolSelection();
      else if (matchesKey(data, Key.up)) this.transcript.selectNextTool(-1);
      else if (matchesKey(data, Key.down)) this.transcript.selectNextTool(1);
      else if (matchesKey(data, Key.ctrl("o")) || matchesKey(data, Key.enter)) this.transcript.toggleSelectedTool();
      else return;
      this.returnGesture.cancel();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("o"))) { this.transcript.selectNextTool(1); this.returnGesture.cancel(); this.requestRender(); return; }
    if (matchesKey(data, Key.home)) { this.transcript.scrollToStart(); this.returnGesture.cancel(); this.requestRender(); return; }
    if (matchesKey(data, Key.end)) { this.transcript.scrollToEnd(); this.returnGesture.cancel(); this.requestRender(); return; }
    if (matchesKey(data, Key.pageUp)) { this.transcript.scrollBy(-1); this.requestRender(); return; }
    if (matchesKey(data, Key.pageDown)) { this.transcript.scrollBy(1); this.requestRender(); return; }
    // Arrows scroll only when the editor has nothing to offer: no draft to move within and no prompt
    // history to recall. Either one hands them back to Pi's editor, which keeps history reachable and
    // keeps the Left double-press gesture honest about a dirty prompt.
    if ((matchesKey(data, Key.up) || matchesKey(data, Key.down)) && this.editor.getText().length === 0 && this.history.length === 0) {
      this.transcript.scrollBy(matchesKey(data, Key.up) ? -1 : 1);
      this.returnGesture.cancel();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.historyUsed ||= this.history.length > 0;
      this.returnGesture.cancel();
      this.editor.handleInput(data);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape) && this.state.working) {
      // Escape stops the running agent first; leaving the session needs a second Escape once it settles.
      this.returnGesture.cancel();
      void this.sendCommand("interrupt", {});
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      // The agent is settled: leave now. The draft is persisted, so no second press is needed.
      this.returnGesture.cancel();
      this.onReturn();
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
    if (matchesKey(data, Key.ctrl("c"))) {
      this.pressCtrlC({ clearsEditor: true });
      return;
    }
    this.editor.handleInput(data);
    this.requestRender();
  }

  /**
   * Pi's Ctrl+C: stop a running turn and empty the editor, and quit only when a second press lands
   * inside the window. The press that quits sends nothing, so leaving cannot interrupt twice.
   * @param {{ clearsEditor: boolean }} options
   */
  pressCtrlC({ clearsEditor }) {
    if (this.clearQuitGesture.press() === "quit") {
      this.onQuit();
      return;
    }
    if (this.state.working) void this.sendCommand("interrupt", {});
    if (clearsEditor) this.clearEditor();
    this.requestRender();
  }

  /** @param {{ button: string, column: number, row: number }} event */
  handleMouse(event) {
    if (this.closedState || this.state === undefined) return;
    if (event.button === "wheel_up") this.transcript.scrollBy(-WHEEL_SCROLL_LINES);
    else if (event.button === "wheel_down") this.transcript.scrollBy(WHEEL_SCROLL_LINES);
    else return;
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
   * Ctrl+T: choose what Pi thinks with, from the levels Pi reports for the model this session is on.
   *
   * The levels are read on every press rather than reused, because Pi answers them per model and a
   * session that changed model has a different set. Nothing here touches the composer, the
   * transcript, or the level the footer draws: only Pi's own confirmation moves that.
   */
  async openThinkingPicker() {
    if (this.state === undefined || this.thinkingLoading) return;
    const read = (this.thinkingRead ?? 0) + 1;
    this.thinkingRead = read;
    this.thinkingLoading = true;
    void this.requestRender();
    const loaded = await this.loadMenu();
    // Escape, a close, or a second press while this read was in flight owns the outcome now.
    if (this.thinkingRead !== read || this.closedState) return;
    this.thinkingLoading = false;
    const levels = this.menu.thinkingLevels ?? [];
    if (!loaded) { void this.requestRender(); return; }
    if (levels.length === 0) {
      await this.recordError({ code: "THINKING_LEVELS_UNAVAILABLE", message: "This session reported no thinking levels. Pi reports them per model, and a worker from an older release reports none at all; stop and reopen the session to refresh it.", retryable: false });
      return;
    }
    const current = this.menu.thinkingLevel ?? undefined;
    this.showSelection({
      title: "Select a thinking level",
      items: levels.map((level) => ({ value: level, label: level === current ? `${level} · current` : level })),
      selected: current,
      onChoice: (level) => { void this.sendCommand("session_command", { command: "set_thinking_level", level }); },
    });
  }

  /** Drop a thinking-level read the operator no longer wants, without sending anything. */
  cancelThinkingPicker() {
    this.thinkingRead = (this.thinkingRead ?? 0) + 1;
    this.thinkingLoading = false;
    void this.requestRender();
  }

  /**
   * Submit the composer as one session command or one line of text.
   *
   * `operation` is the key the operator pressed, not a reading of this session's state: `prompt` for
   * Enter and `follow_up` for Alt+Enter. The worker turns each into the streaming behavior Pi applies
   * if a run is already going, and Pi decides that in the same step it reads its own state.
   * @param {string} text @param {"prompt" | "follow_up"} operation
   */
  async submitText(text, operation = "prompt") {
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
      if (!await this.sendCommand(operation, { text: submission.text })) { this.dropPending(entry); this.recoverRefusedText(prompt); return; }
    }
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

  /** @param {string} title @param {string[]} rows */
  openTextPanel(title, rows) {
    this.overlay?.dispose();
    this.overlay = new TextPanelOverlay({
      title, rows,
      tui: this.editor.tui ?? { requestRender: () => this.requestRender(), setFocus() {} },
      returnFocus: this.editor,
      respond: () => {
        const resolved = this.overlay;
        this.overlay = undefined;
        resolved?.dispose();
        void this.requestRender();
      },
    });
    void this.requestRender();
  }

  helpRows() {
    return [
      ...sessionSlashCommands(this.menu)
        .filter((command) => command.source === "builtin")
        .map((command) => `/${command.name}${command.argumentHint === undefined ? "" : ` ${command.argumentHint}`}  ${command.description ?? ""}`.trim()),
      "",
      "Esc  interrupt a running turn, then return to the list",
      "←  return to the list",
      "↑↓  scroll the transcript while the prompt is empty, else recall prompt history",
      "Enter  send now, steering a run already going · Alt+Enter  queue a follow-up for after it",
      "Home/End  jump to the start or end · wheel scrolls",
      "Ctrl+T thinking level · Ctrl+O tools",
      "Ctrl+C  interrupt a running turn and clear the prompt; press again within 500 ms to quit",
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
      this.state = applyViewerEvent(this.state, event);
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

  /** Offer one Pi selection list for a built-in command submitted without its argument. @param {string} code @param {string} [submitted] */
  openSelection(code, submitted) {
    const picker = SELECTION_PICKERS[code];
    if (picker === undefined) return false;
    const command = picker.command ?? submitted;
    const items = picker.items(this.menu);
    if (command === undefined || items.length === 0) return false;
    this.showSelection({ title: picker.title(submitted), items, onChoice: (value) => { void this.submitText(`${command} ${value}`); } });
    // The submitted line is the command this picker completes, so it leaves the composer with it.
    this.restoring = true; this.editor.setText(""); this.restoring = false;
    this.edited = false;
    return true;
  }

  /**
   * Open one bounded Pi selection list over the transcript. Cancelling costs nothing: no request is
   * sent and the composer is left exactly as the operator had it.
   * @param {{ title: string, items: { value: string, label: string }[], selected?: string, onChoice: (value: string) => void }} options
   */
  showSelection({ title, items, selected, onChoice }) {
    this.selection?.dispose();
    this.selection = new CommandSelectionOverlay({
      title, items, selected,
      tui: this.editor.tui ?? { requestRender: () => this.requestRender(), setFocus() {} },
      returnFocus: this.editor,
      respond: (/** @type {string | undefined} */ value) => {
        const resolved = this.selection;
        this.selection = undefined;
        resolved?.dispose();
        if (value === undefined) { void this.requestRender(); return; }
        onChoice(value);
      },
    });
    void this.requestRender();
  }

  installOverlay() {
    const request = this.state?.pendingUi.find((candidate) => !this.respondedUi.has(candidate.id));
    if (request === undefined) { this.overlay?.dispose(); this.overlay = undefined; return; }
    if (this.overlay?.request.id === request.id) return;
    this.overlay?.dispose();
    this.overlay = new PendingUiOverlay({
      request,
      tui: this.editor.tui ?? { requestRender: () => this.requestRender(), setFocus() {} },
      returnFocus: this.editor,
      respond: (response) => {
        this.respondedUi.add(response.requestId);
        const resolved = this.overlay;
        this.overlay = undefined;
        resolved?.dispose();
        void this.sendCommand("ui_response", { uiRequestId: response.requestId, response: response.cancelled ? null : response.value });
      },
    });
  }

  persisted(cursor = this.state?.cursor) { return { sessionId: this.sessionId, cursor, draft: this.editor.getText(), history: [...this.history] }; }

  async close(options = {}) {
    if (this.closedState) return;
    this.closedState = true;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.watchConnection?.(); this.watchConnection = undefined;
    try {
      if (options.persist !== false) await this.persistence.save(this.persisted());
    } finally {
      this.overlay?.dispose();
      this.overlay = undefined;
      this.selection?.dispose();
      this.selection = undefined;
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
