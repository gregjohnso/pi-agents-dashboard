import { CombinedAutocompleteProvider, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { parseViewerEvent, parseViewerSnapshot } from "../../shared/viewer-contracts.mjs";
import { createPiComponentAdapters } from "./pi-component-adapters.mjs";
import { EMPTY_SESSION_MENU, parseSlashSubmission, sessionSlashCommands } from "./slash-commands.mjs";
import { CommandSelectionOverlay, PendingUiOverlay, renderActivityLine, renderSystemCard } from "./overlays.mjs";
import { ReturnGesture } from "./return-gesture.mjs";
import { TranscriptModel, applyViewerEvent, createTranscriptState } from "./transcript.mjs";

function fit(line, width) {
  const clipped = truncateToWidth(line.replace(/[\r\n\u2028\u2029]/gu, " "), Math.max(0, width), "");
  return visibleWidth(clipped) <= width ? clipped : "";
}

function isPageUp(data) { return matchesKey(data, Key.pageUp); }
function isPageDown(data) { return matchesKey(data, Key.pageDown); }

/** Own one standalone normalized Pi chat subscription and its composer role. */
export class ViewerController {
  constructor({ sessionId, client, editor, persistence, requestRender, onReturn, now = Date.now, adapters = undefined, cwd = process.cwd() }) {
    if (!sessionId || client === undefined || editor === undefined || persistence === undefined) throw new TypeError("sessionId, client, editor, and persistence are required");
    this.sessionId = sessionId;
    this.client = client;
    this.editor = editor;
    this.persistence = persistence;
    this.requestRender = requestRender ?? (() => {});
    this.onReturn = onReturn ?? (() => {});
    this.now = now;
    this.adapters = adapters ?? createPiComponentAdapters({ tui: editor.tui ?? { mode: "fullscreen", requestRender: () => this.requestRender(), setFocus() {} } });
    this.cwd = cwd;
    this.menu = EMPTY_SESSION_MENU;
    this.history = [];
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
      ? ` pi-dashboard · ${this.sessionId} · ${this.state.taskState}/${this.state.processState} · ${role} · ←/Esc list`
      : width >= 50
        ? ` ${this.sessionId} · ${this.state.taskState}/${this.state.processState} · ${role} · ← list`
        : ` ${this.state.taskState}/${this.state.processState} · ${role} · ← list`;
    const footerParts = [this.state.model === null ? "model:default" : `model:${this.state.model.provider}/${this.state.model.id}`, `thinking:${this.state.thinkingLevel ?? "default"}`, `connection:${this.state.processState}`];
    const footer = footerParts.join(" · ");
    const activity = renderActivityLine(this.state.activity, width, this.now());
    const editorLines = this.state.role === "composer" ? this.editor.render(width) : [" Read-only session · scroll and tool inspection only"];
    const inputLabel = this.inputMode === "steer" ? [" Steer at next supported boundary"] : this.steerStatus === undefined ? [] : [` Steer ${this.steerStatus}`];
    const selectedTool = this.transcript.selectedToolId === undefined ? undefined : this.state.tools.get(this.transcript.selectedToolId);
    const toolLine = selectedTool === undefined ? [] : [` tool:${selectedTool.name} ${selectedTool.state} ${this.transcript.expandedTools.has(selectedTool.id) ? "expanded" : "collapsed"}`];
    const errorLines = this.state.errors.slice(-1).flatMap((error) => renderSystemCard({ text: `${error.code}: ${error.message}`, level: "error" }, width));
    const fixed = 2 + activity.length + editorLines.length + inputLabel.length + toolLine.length + errorLines.length;
    const transcriptHeight = Math.max(0, height - fixed);
    let body = this.transcript.render(width, transcriptHeight);
    const activeOverlay = this.overlay ?? this.selection;
    if (activeOverlay !== undefined) {
      const overlayLines = activeOverlay.render(width).slice(0, transcriptHeight);
      const start = Math.max(0, body.length - overlayLines.length);
      body = [...body.slice(0, start), ...overlayLines];
    }
    const thinking = `${this.state.thinkingLevel ?? "default"}/${this.hideThinking ? "hidden" : "visible"}`;
    const statusFooter = footer.replace(`thinking:${this.state.thinkingLevel ?? "default"}`, `thinking:${thinking}`);
    const lines = [header, ...body, ...errorLines, ...activity, ...toolLine, ...inputLabel, ...editorLines, statusFooter].map((line) => fit(line, width));
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
    if (isPageUp(data) || (this.state.role === "observer" && matchesKey(data, Key.up))) { this.transcript.scrollBy(-1); this.requestRender(); return; }
    if (isPageDown(data) || (this.state.role === "observer" && matchesKey(data, Key.down))) { this.transcript.scrollBy(1); this.requestRender(); return; }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.historyUsed ||= this.history.length > 0;
      this.returnGesture.cancel();
      if (this.state.role === "composer") this.editor.handleInput(data);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
      const key = matchesKey(data, Key.left) ? "left" : "escape";
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
      };
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
      if (!this.openSelection(submission.code)) await this.recordError({ code: submission.code, message: submission.message, retryable: false });
      return;
    }
    if (submission.kind === "settings") {
      if (!await this.sendSettings(submission.payload)) return;
      await this.loadMenu();
    } else if (submission.kind === "session_command") {
      if (!await this.sendCommand("session_command", submission.payload)) return;
      await this.loadMenu();
    } else {
      const operation = this.state.working ? "follow_up" : "prompt";
      if (!await this.sendCommand(operation, { text: submission.text })) return;
    }
    this.history.push(prompt);
    this.editor.addToHistory?.(prompt);
    this.restoring = true; this.editor.setText(""); this.restoring = false;
    this.edited = false; this.historyUsed = false;
  }

  submitSteer(text) {
    if (this.state?.role !== "composer" || text.trim().length === 0) return Promise.resolve(false);
    return this.sendCommand("steer", { text: text.trim() });
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

  /** @param {Record<string, any>} payload */
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

  /** Offer one Pi selection list for a built-in command submitted without its argument. @param {string} code */
  openSelection(code) {
    const models = this.menu.models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}` }));
    const picker = code === "MODEL_REQUIRED"
      ? { title: "Select a model", items: models }
      : code === "THINKING_LEVEL_REQUIRED"
        ? { title: "Select a thinking level", items: this.menu.thinkingLevels.map((level) => ({ value: level, label: level })) }
        : code === "SUMMARY_MODEL_REQUIRED"
          ? { title: "Select a dashboard summary model", items: [{ value: "off", label: "off · disable summaries" }, ...models] }
          : undefined;
    if (picker === undefined || picker.items.length === 0) return false;
    const command = code === "MODEL_REQUIRED" ? "/model" : code === "THINKING_LEVEL_REQUIRED" ? "/thinking" : "/model-summary";
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
