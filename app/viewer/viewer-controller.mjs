import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { parseViewerEvent, parseViewerSnapshot } from "../../shared/viewer-contracts.mjs";
import { createPiComponentAdapters } from "./pi-component-adapters.mjs";
import { PendingUiOverlay, renderActivityLine, renderSystemCard } from "./overlays.mjs";
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
  constructor({ sessionId, client, editor, persistence, requestRender, onReturn, now = Date.now, adapters = undefined }) {
    if (!sessionId || client === undefined || editor === undefined || persistence === undefined) throw new TypeError("sessionId, client, editor, and persistence are required");
    this.sessionId = sessionId;
    this.client = client;
    this.editor = editor;
    this.persistence = persistence;
    this.requestRender = requestRender ?? (() => {});
    this.onReturn = onReturn ?? (() => {});
    this.now = now;
    this.adapters = adapters ?? createPiComponentAdapters({ tui: editor.tui ?? { mode: "fullscreen", requestRender: () => this.requestRender(), setFocus() {} } });
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
      this.state = createTranscriptState(snapshot);
      this.editor.disableSubmit = snapshot.role !== "composer";
      this.editor.focused = snapshot.role === "composer";
      this.transcript = new TranscriptModel({ state: this.state, adapters: this.adapters });
      this.installOverlay();
      const unsubscribe = await this.client.subscribe(this.sessionId, snapshot.cursor, (event) => this.processEvent(event), (error) => this.fail(error));
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
    const editorLines = this.state.role === "composer" ? this.editor.render(width) : [" Observer mode · scroll/search/tool inspection only"];
    const inputLabel = this.inputMode === "steer" ? [" Steer at next supported boundary"] : this.steerStatus === undefined ? [] : [` Steer ${this.steerStatus}`];
    const searchLine = this.search === undefined ? [] : [` Search: ${this.search.query} [${this.search.matches.length === 0 ? 0 : this.search.matchIndex + 1}/${this.search.matches.length}]`];
    const selectedTool = this.transcript.selectedToolId === undefined ? undefined : this.state.tools.get(this.transcript.selectedToolId);
    const toolLine = selectedTool === undefined ? [] : [` tool:${selectedTool.name} ${selectedTool.state} ${this.transcript.expandedTools.has(selectedTool.id) ? "expanded" : "collapsed"}`];
    const errorLines = this.state.errors.slice(-1).flatMap((error) => renderSystemCard({ text: `${error.code}: ${error.message}`, level: "error" }, width));
    const fixed = 2 + activity.length + editorLines.length + inputLabel.length + searchLine.length + toolLine.length + errorLines.length;
    const transcriptHeight = Math.max(0, height - fixed);
    let body = this.transcript.render(width, transcriptHeight);
    if (this.overlay !== undefined) {
      const overlayLines = this.overlay.render(width).slice(0, transcriptHeight);
      const start = Math.max(0, body.length - overlayLines.length);
      body = [...body.slice(0, start), ...overlayLines];
    }
    const thinking = `${this.state.thinkingLevel ?? "default"}/${this.hideThinking ? "hidden" : "visible"}`;
    const statusFooter = footer.replace(`thinking:${this.state.thinkingLevel ?? "default"}`, `thinking:${thinking}`);
    const lines = [header, ...body, ...errorLines, ...activity, ...searchLine, ...toolLine, ...inputLabel, ...editorLines, statusFooter].map((line) => fit(line, width));
    while (lines.length < height) lines.splice(1, 0, "");
    return lines.slice(0, height);
  }

  handleInput(data) {
    if (this.closedState || this.state === undefined) return;
    if (this.overlay !== undefined) {
      this.returnGesture.cancel();
      this.overlay.handleInput(data);
      this.requestRender();
      return;
    }
    if (this.search !== undefined) { this.handleSearchInput(data); return; }
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
    if (data === "/") { this.search = { query: "", matches: [], matchIndex: -1 }; this.returnGesture.cancel(); this.requestRender(); return; }
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

  handleSearchInput(data) {
    if (matchesKey(data, Key.escape)) {
      this.transcript.setSearch("");
      this.search = undefined;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("n")) || matchesKey(data, Key.ctrl("p"))) {
      this.search.matchIndex = this.transcript.nextSearch(matchesKey(data, Key.ctrl("p")) ? -1 : 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace)) this.search.query = this.search.query.slice(0, -1);
    else {
      const printable = decodeKittyPrintable(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
      if (printable === undefined) return;
      this.search.query += printable;
    }
    this.search.matches = this.transcript.setSearch(this.search.query);
    this.search.matchIndex = this.search.matches.length === 0 ? -1 : 0;
    this.requestRender();
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
        await this.submitSteer(steer);
        this.steerStatus = "queued";
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
    const operation = this.state.working ? "follow_up" : "prompt";
    await this.sendCommand(operation, { text: prompt });
    this.history.push(prompt);
    this.editor.addToHistory?.(prompt);
    this.restoring = true; this.editor.setText(""); this.restoring = false;
    this.edited = false; this.historyUsed = false;
  }

  submitSteer(text) {
    if (this.state?.role !== "composer" || text.trim().length === 0) return Promise.resolve();
    return this.sendCommand("steer", { text: text.trim() });
  }

  async sendCommand(operation, payload) {
    const request = { sessionId: this.sessionId, ...payload };
    if (typeof this.client.command === "function") await this.client.command(operation, request);
    else await this.client.request(operation, request);
  }

  async processEvent(value) {
    if (this.closedState) throw Object.assign(new Error("Viewer is closed"), { code: "VIEWER_CLOSED" });
    try {
      const event = parseViewerEvent(value);
      if (event.sessionId !== this.sessionId) throw Object.assign(new Error("Viewer event session mismatch"), { code: "VIEWER_SESSION_MISMATCH" });
      this.state = applyViewerEvent(this.state, event);
      this.transcript.update(this.state);
      if (this.search !== undefined) {
        this.search.matches = [...this.transcript.searchMatches];
        this.search.matchIndex = this.search.matches.indexOf(this.transcript.selectedSearchItemId);
      }
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
        this.overlay = undefined;
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
      this.resolveClosed?.();
    }
  }

  async fail(error) { this.error = error; await this.close({ persist: false }); }
}
