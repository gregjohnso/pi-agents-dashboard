import { CombinedAutocompleteProvider, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { SESSION_COLORS } from "../../shared/contracts.mjs";
import { parseViewerEvent, parseViewerSnapshot } from "../../shared/viewer-contracts.mjs";
import { createPiComponentAdapters } from "./pi-component-adapters.mjs";
import { EMPTY_SESSION_MENU, parseSlashSubmission, sessionSlashCommands } from "./slash-commands.mjs";

const QUERY_TITLES = { get_session_stats: "Session stats", get_tree: "Session tree", export_html: "Session export" };
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
 * Frame the prompt so the operator's session color is visible without recoloring what they type.
 * The border carries the color; the editor's own lines are passed through untouched.
 * @param {string[]} lines @param {string | undefined} color @param {number} width
 */
function framePromptBox(lines, color, width) {
  const inner = Math.max(0, width - 2);
  const code = (color === undefined ? undefined : COLOR_CODES[color]) ?? BORDER_DEFAULT;
  const edge = (glyph) => `${code}${glyph}\x1b[0m`;
  const rule = (left, right) => `${code}${left}${"─".repeat(inner)}${right}\x1b[0m`;
  if (inner === 0) return lines;
  const padded = lines.map((line) => {
    const clipped = truncateToWidth(line, inner, "");
    return `${edge("│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${edge("│")}`;
  });
  return [rule("╭", "╮"), ...padded, rule("╰", "╯")];
}

function isPageUp(data) { return matchesKey(data, Key.pageUp); }
function isPageDown(data) { return matchesKey(data, Key.pageDown); }
function isHome(data) { return matchesKey(data, Key.home); }
function isEnd(data) { return matchesKey(data, Key.end); }

/** Lines moved per wheel notch, matching Jobwatch's three-line step. */
// One line per wheel notch leaves acceleration to the terminal and the OS, which already
// translate a trackpad swipe into a notch count.
const WHEEL_SCROLL_LINES = 1;

const QUEUED_MESSAGE_ROWS = 3;
const MIN_TRANSCRIPT_ROWS = 3;

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
function renderKeyHints({ role, working }, width) {
  const segments = role !== "composer"
    ? ["Esc/← list", "↑↓ scroll", "Ctrl+T thinking", "Ctrl+O tools"]
    : working
      ? ["Esc interrupt", "← list", "↑↓ scroll", "Ctrl+S steer", "Ctrl+T thinking", "Ctrl+O tools", "/ commands"]
      : ["Esc/← list", "↑↓ scroll", "Ctrl+S steer", "Ctrl+T thinking", "Ctrl+O tools", "/ commands"];
  for (let count = segments.length; count > 0; count -= 1) {
    const line = ` ${segments.slice(0, count).join(" · ")}`;
    if (visibleWidth(line) <= width) return line;
  }
  return "";
}

/** Own one standalone normalized Pi chat subscription and its composer role. */
export class ViewerController {
  constructor({ sessionId, client, editor, persistence, requestRender, onReturn, onDashboardAction = undefined, now = Date.now, adapters = undefined, cwd = process.cwd() }) {
    if (!sessionId || client === undefined || editor === undefined || persistence === undefined) throw new TypeError("sessionId, client, editor, and persistence are required");
    this.sessionId = sessionId;
    this.client = client;
    this.editor = editor;
    this.persistence = persistence;
    this.requestRender = requestRender ?? (() => {});
    this.onReturn = onReturn ?? (() => {});
    this.onDashboardAction = onDashboardAction;
    this.now = now;
    this.adapters = adapters ?? createPiComponentAdapters({ tui: editor.tui ?? { mode: "fullscreen", requestRender: () => this.requestRender(), setFocus() {} } });
    this.cwd = cwd;
    this.menu = EMPTY_SESSION_MENU;
    this.history = [];
    this.queued = [];
    this.respondedUi = new Set();
    this.inputMode = "prompt";
    this.hideThinking = false;
    this.edited = false;
    this.historyUsed = false;
    this.closedState = true;
    this.returnGesture = new ReturnGesture({ now: () => this.now(), onReturn: () => this.onReturn() });
    this.editor.onSubmit = (text) => { void this.submitEditor(text); };
    this.editor.onChange = () => { if (!this.restoring) this.edited = true; };
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  async open() {
    if (!this.closedState) return;
    this.closedState = false;
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
      const snapshot = parseViewerSnapshot(await this.client.getSnapshot(this.sessionId));
      const replayFromOrigin = this.client.replayFromOrigin === true && snapshot.cursor.sequence !== "0";
      this.replaySnapshot = replayFromOrigin ? snapshot : undefined;
      const initial = replayFromOrigin ? { ...snapshot, cursor: { ...snapshot.cursor, sequence: "0" }, items: [], tools: [], pendingUi: [], errors: [] } : snapshot;
      this.state = createTranscriptState(initial);
      this.editor.disableSubmit = snapshot.role !== "composer";
      this.editor.focused = snapshot.role === "composer";
      this.transcript = new TranscriptModel({ state: this.state, adapters: this.adapters });
      this.installOverlay();
      await this.loadMenu();
      const unsubscribe = await this.client.subscribe(this.sessionId, initial.cursor, (event) => this.processEvent(event), (error) => this.fail(error));
      if (this.closedState) unsubscribe?.(); else this.unsubscribe = unsubscribe;
      await this.requestRender();
    } catch (error) {
      await this.close({ persist: false });
      throw error;
    }
  }

  render(width, height) {
    width = Math.max(0, Math.floor(width)); height = Math.max(0, Math.floor(height));
    if (height === 0) return [];
    if (this.state === undefined) return Array.from({ length: height }, () => fit("Loading viewer…", width));
    const role = this.state.role.toUpperCase();
    const header = width >= 70
      ? ` pi-dashboard · ${this.sessionId} · ${this.state.taskState}/${this.state.processState} · ${role}`
      : width >= 50
        ? ` ${this.sessionId} · ${this.state.taskState}/${this.state.processState} · ${role}`
        : ` ${this.state.taskState}/${this.state.processState} · ${role}`;
    let status = renderStatusIndicator(this.state.activity, width, this.now(), { working: this.state.working });
    const promptLines = this.state.role === "composer" ? this.editor.render(Math.max(1, width - 2)) : [" Read-only session · scroll and tool inspection only"];
    let editorLines = framePromptBox(promptLines, this.sessionColor, width);
    const inputLabel = this.inputMode === "steer" ? [" Steer at next supported boundary"] : this.steerStatus === undefined ? [] : [` Steer ${this.steerStatus}`];
    const selectedTool = this.transcript.selectedToolId === undefined ? undefined : this.state.tools.get(this.transcript.selectedToolId);
    const toolLine = selectedTool === undefined ? [] : [` tool:${selectedTool.name} ${selectedTool.state} ${this.transcript.expandedTools.has(selectedTool.id) ? "expanded" : "collapsed"}`];
    let errorLines = this.state.errors.slice(-1).flatMap((error) => renderSystemCard({ text: `${error.code}: ${error.message}`, level: "error" }, width));
    let queuedLines = this.renderQueued();
    let hints = renderKeyHints(this.state, width);
    const dockRows = () => 2 + (hints === "" ? 0 : 1) + status.length + editorLines.length + inputLabel.length + toolLine.length + errorLines.length + queuedLines.length;
    if (height - dockRows() < MIN_TRANSCRIPT_ROWS) {
      // Pi's dock shrinks its own spacers, then its hints, before the transcript loses rows.
      status = status.slice(1); errorLines = errorLines.slice(1); queuedLines = queuedLines.slice(1);
      // The prompt frame is decoration, so it goes before the hints and before transcript rows.
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
    const lines = [header, ...body, ...errorLines, ...queuedLines, ...status, ...toolLine, ...inputLabel, ...editorLines, footer, ...(hints === "" ? [] : [hints])].map((line) => fit(line, width));
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
      if (matchesKey(data, Key.ctrl("c")) && this.state.role === "composer" && this.state.working) {
        void this.sendCommand("interrupt", {});
        return;
      }
      this.overlay.handleInput(data);
      this.requestRender();
      return;
    }
    if (this.inputMode === "steer") {
      this.returnGesture.cancel();
      if (matchesKey(data, Key.escape)) this.finishSteer(); else this.editor.handleInput(data);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("s"))) { this.beginSteer(); return; }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.hideThinking = !this.hideThinking;
      this.transcript.setThinkingHidden(this.hideThinking);
      this.returnGesture.cancel();
      this.requestRender();
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
    if (isHome(data)) { this.transcript.scrollToStart(); this.returnGesture.cancel(); this.requestRender(); return; }
    if (isEnd(data)) { this.transcript.scrollToEnd(); this.returnGesture.cancel(); this.requestRender(); return; }
    if (isPageUp(data) || (this.state.role === "observer" && matchesKey(data, Key.up))) { this.transcript.scrollBy(-1); this.requestRender(); return; }
    if (isPageDown(data) || (this.state.role === "observer" && matchesKey(data, Key.down))) { this.transcript.scrollBy(1); this.requestRender(); return; }
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
      if (this.state.role === "composer") this.editor.handleInput(data);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape) && this.state.role === "composer" && this.state.working) {
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
      const key = "left";
      const clean = this.editor.getText().length === 0 && !this.edited && !this.historyUsed;
      const result = this.returnGesture.handle(key, { clean, overlayCaptured: false });
      if (result === "armed") this.editor.handleInput(data);
      this.requestRender();
      return;
    }
    this.returnGesture.cancelForInput("other");
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.state.role === "composer") void this.sendCommand("interrupt", {});
      return;
    }
    if (this.state.role !== "composer") return;
    this.editor.handleInput(data);
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

  /** Load and install the session's discovered slash-command menu. */
  async loadMenu() {
    if (typeof this.client.menu !== "function") return;
    try {
      const menu = await this.client.menu(this.sessionId);
      this.menu = {
        commands: Array.isArray(menu?.commands) ? menu.commands : [],
        models: Array.isArray(menu?.models) ? menu.models : [],
        thinkingLevels: Array.isArray(menu?.thinkingLevels) ? menu.thinkingLevels : [],
        model: menu?.model ?? null,
        thinkingLevel: menu?.thinkingLevel ?? null,
        color: menu?.color ?? null,
      };
      // The colour is stored on the session record, so adopt it on every open, not only when /color runs.
      this.sessionColor = this.menu.color ?? undefined;
      if (Number.isSafeInteger(menu?.registryRevision)) this.registryRevision = menu.registryRevision;
    } catch (error) {
      this.menu = EMPTY_SESSION_MENU;
      const code = /** @type {any} */ (error)?.code;
      await this.recordError(code === "UNSUPPORTED_WORKER_OPERATION"
        ? { code: "SESSION_COMMANDS_UNAVAILABLE", message: "This session's worker predates slash commands. Stop and reopen the session to refresh them.", retryable: false }
        : { code: code ?? "SESSION_COMMANDS_UNAVAILABLE", message: error instanceof Error ? error.message : "Session commands are unavailable", retryable: false });
    }
    this.editor.setAutocompleteProvider?.(new CombinedAutocompleteProvider(/** @type {any} */ (sessionSlashCommands(this.menu)), this.cwd));
  }

  beginSteer() {
    if (this.state?.role !== "composer") return;
    this.steerRestore = this.editor.getText();
    this.steerStatus = "composing";
    this.inputMode = "steer";
    this.restoring = true; this.editor.setText(""); this.restoring = false;
    this.returnGesture.cancel();
    this.requestRender();
  }

  finishSteer() {
    const restore = this.steerRestore ?? "";
    this.inputMode = "prompt";
    this.steerRestore = undefined;
    if (this.steerStatus === "composing") this.steerStatus = undefined;
    this.restoring = true; this.editor.setText(restore); this.restoring = false;
  }

  async submitEditor(text) {
    if (this.inputMode === "steer") {
      const steer = text.trim();
      if (steer.length === 0) return;
      this.steerStatus = "sending";
      try {
        this.steerStatus = await this.submitSteer(steer) ? "queued" : "failed";
      } catch (error) {
        this.steerStatus = "failed";
        throw error;
      } finally {
        this.finishSteer();
        this.requestRender();
      }
      return;
    }
    await this.submitText(text);
  }

  async submitText(text) {
    const prompt = text.trim();
    if (this.state?.role !== "composer" || prompt.length === 0) return;
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
    if (submission.kind === "session_query") {
      const rows = await this.runQuery(submission.payload);
      if (rows !== undefined) this.openTextPanel(QUERY_TITLES[submission.payload.query] ?? "Session", rows);
      this.clearEditor();
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
      const operation = this.state.working ? "follow_up" : "prompt";
      if (!await this.sendCommand(operation, { text: submission.text })) return;
      if (operation === "follow_up") this.queued.push({ mode: "follow_up", text: submission.text });
    }
    this.history.push(prompt);
    this.editor.addToHistory?.(prompt);
    this.restoring = true; this.editor.setText(""); this.restoring = false;
    this.edited = false; this.historyUsed = false;
  }

  async submitSteer(text) {
    const steer = text.trim();
    if (this.state?.role !== "composer" || steer.length === 0) return false;
    const sent = await this.sendCommand("steer", { text: steer });
    if (sent) this.queued.push({ mode: "steer", text: steer });
    return sent;
  }

  /** Drop queued messages once the session has turned them into user turns or ended the turn that held them. */
  syncQueued() {
    if (this.queued.length === 0) return;
    if (this.state?.working !== true) { this.queued = []; return; }
    const submitted = new Set(this.state.items.filter((item) => item.kind === "user_message").map((item) => item.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")));
    this.queued = this.queued.filter((entry) => !submitted.has(entry.text));
  }

  /** Render Pi's queued block, steering before follow-ups, directly above the status indicator. */
  renderQueued() {
    if (this.queued.length === 0) return [];
    const ordered = [...this.queued.filter((entry) => entry.mode === "steer"), ...this.queued.filter((entry) => entry.mode === "follow_up")];
    const shown = ordered.slice(0, QUEUED_MESSAGE_ROWS).map((entry) => ` ${entry.mode === "steer" ? "Steering" : "Follow-up"}: ${entry.text}`);
    const remaining = ordered.length - shown.length;
    return ["", ...shown, ...(remaining > 0 ? [` … ${remaining} more queued`] : [])];
  }

  async sendCommand(operation, payload) {
    const request = { sessionId: this.sessionId, ...payload };
    try {
      if (typeof this.client.command === "function") await this.client.command(operation, request);
      else await this.client.request(operation, request);
      return true;
    } catch (error) {
      const typed = /** @type {any} */ (error);
      await this.recordError({ code: typed?.code ?? "VIEWER_COMMAND_FAILED", message: error instanceof Error ? error.message : "Viewer command failed", retryable: typed?.retryable === true });
      return false;
    }
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
      "Home/End  jump to the start or end · wheel scrolls",
      "Ctrl+S steer · Ctrl+T thinking · Ctrl+O tools · Ctrl+C interrupt",
    ];
  }

  /** @param {Record<string, any>} payload */
  async runQuery(payload) {
    if (typeof this.client.query !== "function") {
      await this.recordError({ code: "SESSION_QUERY_UNAVAILABLE", message: "This frontend cannot run session queries", retryable: false });
      return undefined;
    }
    try {
      const result = await this.client.query(this.sessionId, payload);
      return Array.isArray(result?.rows) ? result.rows : [];
    } catch (error) {
      const typed = /** @type {any} */ (error);
      await this.recordError({ code: typed?.code ?? "SESSION_QUERY_FAILED", message: error instanceof Error ? error.message : "Session query failed", retryable: typed?.retryable === true });
      return undefined;
    }
  }

  /** Apply the dashboard's session color. Registry metadata only: no Pi worker is involved. @param {string | null} color */
  async sendSessionColor(color) {
    if (typeof this.client.setSessionColor !== "function") {
      await this.recordError({ code: "SESSION_COLOR_UNAVAILABLE", message: "This frontend cannot change a session color", retryable: false });
      return false;
    }
    try {
      const result = await this.client.setSessionColor(this.sessionId, color);
      if (Number.isSafeInteger(result?.revision)) this.registryRevision = result.revision;
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
    if (typeof this.client.setSettings !== "function") {
      await this.recordError({ code: "SETTINGS_UNAVAILABLE", message: "This frontend cannot change dashboard settings", retryable: false });
      return false;
    }
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

  async processEvent(value) {
    if (this.closedState) throw Object.assign(new Error("Viewer is closed"), { code: "VIEWER_CLOSED" });
    try {
      const event = parseViewerEvent(value);
      if (event.sessionId !== this.sessionId) throw Object.assign(new Error("Viewer event session mismatch"), { code: "VIEWER_SESSION_MISMATCH" });
      this.state = applyViewerEvent(this.state, event);
      if (this.replaySnapshot !== undefined && BigInt(event.cursor.sequence) >= BigInt(this.replaySnapshot.cursor.sequence)) {
        const authoritative = this.replaySnapshot;
        this.replaySnapshot = undefined;
        const seenItems = new Set(this.state.items.map((item) => item.itemId ?? item.attachment?.id));
        for (const item of authoritative.items) if (!seenItems.has(item.itemId ?? item.attachment?.id)) this.state.items.push(structuredClone(item));
        for (const tool of authoritative.tools) if (!this.state.tools.has(tool.id)) this.state.tools.set(tool.id, structuredClone(tool));
        this.state = { ...this.state, role: authoritative.role, taskState: authoritative.taskState, processState: authoritative.processState, outcome: authoritative.outcome, model: authoritative.model, thinkingLevel: authoritative.thinkingLevel, activity: authoritative.activity, pendingUi: structuredClone(authoritative.pendingUi), errors: structuredClone(authoritative.errors) };
      }
      this.syncQueued();
      this.transcript.update(this.state);
      this.editor.disableSubmit = this.state.role !== "composer";
      this.installOverlay();
      await this.requestRender();
      await this.persistence.save(this.persisted(event.cursor));
      await this.client.ack(this.sessionId, event.cursor);
    } catch (error) {
      await this.close({ persist: false });
      throw error;
    }
  }

  /** Offer one Pi selection list for a built-in command submitted without its argument. @param {string} code @param {string} [submitted] */
  openSelection(code, submitted) {
    const models = this.menu.models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}` }));
    const picker = code === "MODEL_REQUIRED"
      ? { title: "Select a model", items: models }
      : code === "THINKING_LEVEL_REQUIRED"
        ? { title: "Select a thinking level", items: this.menu.thinkingLevels.map((level) => ({ value: level, label: level })) }
        : code === "SUMMARY_MODEL_REQUIRED"
          ? { title: "Select a dashboard summary model", items: [{ value: "off", label: "off · disable summaries" }, ...models] }
          : code === "SESSION_COLOR_REQUIRED"
            ? { title: "Select a session color", items: [{ value: "default", label: "default · no tint" }, ...SESSION_COLORS.map((color) => ({ value: color, label: color }))] }
            : code === "QUEUE_MODE_REQUIRED"
              ? { title: `Select a ${submitted === "/steering" ? "steering" : "follow-up"} delivery mode`, items: [{ value: "all", label: "all · deliver every queued message" }, { value: "one-at-a-time", label: "one-at-a-time · deliver one per turn" }] }
              : code === "TOGGLE_REQUIRED"
                ? { title: `Turn ${submitted === "/auto-retry" ? "automatic retry" : "automatic compaction"} on or off`, items: [{ value: "on", label: "on" }, { value: "off", label: "off" }] }
                : undefined;
    if (picker === undefined || picker.items.length === 0) return false;
    const command = code === "MODEL_REQUIRED" ? "/model"
      : code === "THINKING_LEVEL_REQUIRED" ? "/thinking"
        : code === "SESSION_COLOR_REQUIRED" ? "/color"
          : code === "QUEUE_MODE_REQUIRED" || code === "TOGGLE_REQUIRED" ? submitted
            : "/model-summary";
    if (command === undefined) return false;
    this.selection?.dispose();
    this.selection = new CommandSelectionOverlay({
      title: picker.title, items: picker.items,
      tui: this.editor.tui ?? { requestRender: () => this.requestRender(), setFocus() {} },
      returnFocus: this.editor,
      respond: (/** @type {string | undefined} */ value) => {
        const resolved = this.selection;
        this.selection = undefined;
        resolved?.dispose();
        if (value === undefined) { void this.requestRender(); return; }
        void this.submitText(`${command} ${value}`);
      },
    });
    this.restoring = true; this.editor.setText(""); this.restoring = false;
    this.edited = false;
    void this.requestRender();
    return true;
  }

  installOverlay() {
    const request = this.state?.pendingUi.find((candidate) => !this.respondedUi.has(candidate.id));
    if (request === undefined || this.state.role !== "composer") { this.overlay?.dispose(); this.overlay = undefined; return; }
    if (this.overlay?.request.id === request.id) return;
    this.overlay?.dispose();
    this.overlay = new PendingUiOverlay({
      request,
      tui: this.editor.tui ?? { requestRender: () => this.requestRender(), setFocus() {} },
      returnFocus: this.editor,
      respond: (response) => {
        if (this.state?.role !== "composer") return;
        this.respondedUi.add(response.requestId);
        const resolved = this.overlay;
        this.overlay = undefined;
        resolved?.dispose();
        void this.sendCommand("ui_response", { uiRequestId: response.requestId, response: response.cancelled ? null : response.value });
      },
    });
  }

  persisted(cursor = this.state?.cursor) { return { sessionId: this.sessionId, cursor, draft: this.inputMode === "steer" ? this.steerRestore ?? "" : this.editor.getText(), history: [...this.history] }; }

  async close(options = {}) {
    if (this.closedState) return;
    this.closedState = true;
    this.unsubscribe?.(); this.unsubscribe = undefined;
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

  async fail(error) { this.error = error; await this.close({ persist: false }); }
}
