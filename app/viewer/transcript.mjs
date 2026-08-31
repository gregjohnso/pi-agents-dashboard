import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function cloneItems(items) { return items.map((item) => structuredClone(item)); }
function toolItem(tool) { return { kind: "tool", itemId: `tool:${tool.id}`, toolId: tool.id }; }

/** Build mutable-view state from one literal normalized snapshot. */
export function createTranscriptState(snapshot) {
  const tools = new Map((snapshot.tools ?? []).map((tool) => [tool.id, structuredClone(tool)]));
  const items = cloneItems(snapshot.items ?? []);
  for (const tool of tools.values()) if (!items.some((item) => item.toolId === tool.id)) items.push(toolItem(tool));
  return {
    items, tools, pendingUi: cloneItems(snapshot.pendingUi ?? []), errors: cloneItems(snapshot.errors ?? []),
    activity: structuredClone(snapshot.activity), taskState: snapshot.taskState,
    processState: snapshot.processState, outcome: snapshot.outcome, model: snapshot.model === null ? null : structuredClone(snapshot.model),
    thinkingLevel: snapshot.thinkingLevel, working: snapshot.taskState === "WORKING", eventIds: new Set(), cursor: snapshot.cursor,
  };
}

function replaceItem(items, item, append = true) {
  const index = items.findIndex((candidate) => candidate.itemId === item.itemId);
  if (index < 0) return append ? [...items, item] : items;
  const next = [...items]; next[index] = item; return next;
}

/** Apply one frozen version-1 viewer event idempotently. */
export function applyViewerEvent(state, event) {
  if (state.eventIds.has(event.eventId)) return state;
  const next = { ...state, items: [...state.items], tools: new Map(state.tools), pendingUi: [...state.pendingUi], errors: [...state.errors], eventIds: new Set(state.eventIds), cursor: event.cursor };
  next.eventIds.add(event.eventId);
  const payload = event.payload;
  switch (payload.kind) {
    case "user_message": case "assistant_message": case "system_message":
      next.items = replaceItem(next.items, structuredClone(payload)); break;
    case "image_placeholder": case "file_placeholder": case "unknown_pi_event":
      next.items.push(structuredClone(payload)); break;
    case "assistant_delta": {
      const current = next.items.find((item) => item.itemId === payload.itemId);
      const prior = current?.kind === "assistant_message" ? current.content : [];
      const last = prior.at(-1);
      const content = last?.type === "text"
        ? [...prior.slice(0, -1), { type: "text", text: last.text + payload.delta }]
        : [...prior, { type: "text", text: payload.delta }];
      next.items = replaceItem(next.items, { kind: "assistant_message", itemId: payload.itemId, content, streaming: true });
      break;
    }
    case "tool_started": case "tool_updated": case "tool_finished":
      next.tools.set(payload.tool.id, structuredClone(payload.tool));
      if (!next.items.some((item) => item.toolId === payload.tool.id)) next.items.push(toolItem(payload.tool));
      break;
    case "turn_state": next.working = payload.working; break;
    case "pending_ui_request":
      if (!next.pendingUi.some((request) => request.id === payload.request.id)) next.pendingUi.push(structuredClone(payload.request));
      break;
    case "ui_resolved": next.pendingUi = next.pendingUi.filter((request) => request.id !== payload.requestId); break;
    case "model_state": next.model = payload.provider === null || payload.model === null ? null : { provider: payload.provider, id: payload.model }; break;
    case "thinking_state": next.thinkingLevel = payload.level; break;
    case "activity": next.activity = structuredClone(payload); break;
  }
  return next;
}

function fit(line, width) {
  const clipped = truncateToWidth(line, Math.max(0, width), "");
  return visibleWidth(clipped) <= width ? clipped : "";
}

/** Block-virtualized chronological transcript with paused follow and activity marker state. */
export class TranscriptModel {
  constructor({ state, adapters }) {
    this.state = state;
    this.adapters = adapters;
    this.width = 80;
    this.height = 20;
    /** Rendered lines hidden below the bottom of the viewport; 0 is the tail. */
    this.linesFromEnd = 0;
    this.following = true;
    this.newActivity = false;
    this.hideThinking = false;
    this.selectedToolId = undefined;
    this.expandedTools = new Set();
    // Keyed by item identity, so a replaced item (a streaming answer) drops its entry on its own.
    this.renderedBlocks = new WeakMap();
    this.anchor = undefined;
  }
  setViewport(width, height) { this.width = Math.max(0, Math.floor(width)); this.height = Math.max(0, Math.floor(height)); }
  update(state) {
    const grew = state.items.length > this.state.items.length;
    this.state = state;
    if (grew && !this.following) this.newActivity = true;
    if (this.following) this.linesFromEnd = 0;
  }
  setThinkingHidden(hidden) { this.hideThinking = hidden; }
  selectNextTool(direction = 1) {
    const toolIds = this.state.items.filter((item) => item.kind === "tool").map((item) => item.toolId);
    if (toolIds.length === 0) { this.selectedToolId = undefined; return undefined; }
    const current = toolIds.indexOf(this.selectedToolId);
    const index = current < 0 ? (direction > 0 ? 0 : toolIds.length - 1) : (current + direction + toolIds.length) % toolIds.length;
    this.selectedToolId = toolIds[index];
    const itemIndex = this.state.items.findIndex((item) => item.kind === "tool" && item.toolId === this.selectedToolId);
    this.following = false;
    this.anchor = undefined;
    this.linesFromEnd = this.linesBelow(itemIndex);
    return this.selectedToolId;
  }
  toggleSelectedTool() { if (this.selectedToolId !== undefined) this.toggleTool(this.selectedToolId); }
  clearToolSelection() { this.selectedToolId = undefined; }
  scrollBy(lines) {
    const step = Math.trunc(lines);
    this.anchor = undefined;
    if (step < 0) {
      this.following = false;
      this.linesFromEnd = this.clampToOldestLine(this.linesFromEnd - step);
    } else {
      this.linesFromEnd = Math.max(0, this.linesFromEnd - step);
      if (this.linesFromEnd === 0) { this.following = true; this.newActivity = false; }
    }
  }
  scrollToEnd() { this.linesFromEnd = 0; this.following = true; this.newActivity = false; this.anchor = undefined; }
  scrollToStart() {
    this.anchor = undefined;
    this.linesFromEnd = this.clampToOldestLine(Number.MAX_SAFE_INTEGER);
    this.following = false;
  }
  toggleTool(toolId) {
    if (this.expandedTools.has(toolId)) this.expandedTools.delete(toolId); else this.expandedTools.add(toolId);
  }
  /** Rendered lines of one item, reused until the item, its tool, or the render options change. */
  blockLines(item, index) {
    const tool = item.kind === "tool" ? this.state.tools.get(item.toolId) : undefined;
    if (item.kind === "tool" && tool === undefined) return [];
    const signature = `${this.width}|${this.hideThinking ? 1 : 0}|${this.expandedTools.has(item.toolId) ? 1 : 0}|${this.state.model?.provider ?? ""}/${this.state.model?.id ?? ""}`;
    const cached = this.renderedBlocks.get(item);
    let lines = cached?.signature === signature && cached.tool === tool ? cached.lines : undefined;
    if (lines === undefined) {
      const renderedItem = item.kind === "tool" ? { ...item, tool } : item;
      const component = this.adapters.component(renderedItem, { streaming: renderedItem.streaming, hideThinking: this.hideThinking, provider: this.state.model?.provider, model: this.state.model?.id });
      if (item.kind === "tool") component.setExpanded?.(this.expandedTools.has(item.toolId));
      lines = component.render(this.width).map((line) => fit(line, this.width));
      this.renderedBlocks.set(item, { signature, tool, lines });
    }
    const markers = [];
    // Pi opens every user turn but the first with a spacer above the message box.
    if (item.kind === "user_message" && index > 0) markers.push("");
    if (item.kind === "tool" && item.toolId === this.selectedToolId) markers.push(fit("› selected tool", this.width));
    return markers.length === 0 ? lines : [...markers, ...lines];
  }
  /** The newest rendered lines, stopping once `count` of them exist or the transcript runs out. */
  tailLines(count) {
    const blocks = [];
    let lines = 0;
    let index = this.state.items.length - 1;
    for (; index >= 0 && lines < count; index -= 1) {
      const block = this.blockLines(this.state.items[index], index);
      blocks.push(block);
      lines += block.length;
    }
    return { lines: blocks.reverse().flat(), exhausted: index < 0 };
  }
  /** Rendered lines below one item, which is where that item sits at the bottom of the viewport. */
  linesBelow(index) {
    let lines = 0;
    for (let below = index + 1; below < this.state.items.length; below += 1) lines += this.blockLines(this.state.items[below], below).length;
    return lines;
  }
  /**
   * Bind a paused viewport to the item its bottom edge sits in, counted from that item's top, so
   * output appended below it (a streaming answer growing) does not drag the reader down the page.
   */
  captureAnchor() {
    let below = 0;
    for (let index = this.state.items.length - 1; index >= 0; index -= 1) {
      const length = this.blockLines(this.state.items[index], index).length;
      if (below + length > this.linesFromEnd || index === 0) return { index, item: this.state.items[index], above: below + length - this.linesFromEnd };
      below += length;
    }
    return undefined;
  }
  /** @param {{ index: number, item: any, above: number }} anchor */
  offsetFromAnchor(anchor) {
    const index = this.state.items[anchor.index] === anchor.item ? anchor.index : this.state.items.indexOf(anchor.item);
    if (index < 0) return this.linesFromEnd;
    return Math.max(0, this.linesBelow(index) + this.blockLines(this.state.items[index], index).length - anchor.above);
  }
  /** Never scroll past the oldest line: the top stop keeps a full viewport, never an empty one. */
  clampToOldestLine(candidate) {
    const rows = Math.max(0, this.height - (this.newActivity ? 1 : 0));
    const { lines, exhausted } = this.tailLines(candidate + rows);
    return exhausted ? Math.min(candidate, Math.max(0, lines.length - rows)) : candidate;
  }
  render(width = this.width, height = this.height) {
    this.setViewport(width, height);
    if (height === 0 || width === 0) return [];
    const markerRows = this.newActivity ? 1 : 0;
    const rows = Math.max(0, height - markerRows);
    if (!this.following && this.anchor !== undefined) this.linesFromEnd = this.offsetFromAnchor(this.anchor);
    const { lines, exhausted } = this.tailLines(this.linesFromEnd + rows);
    if (exhausted) this.linesFromEnd = Math.min(this.linesFromEnd, Math.max(0, lines.length - rows));
    const end = lines.length - this.linesFromEnd;
    const visible = lines.slice(Math.max(0, end - rows), end);
    this.anchor = this.following ? undefined : this.captureAnchor();
    while (visible.length < rows) visible.unshift("");
    if (this.newActivity) visible.push(fit("↓ new activity", width));
    return visible.slice(-height);
  }
}
