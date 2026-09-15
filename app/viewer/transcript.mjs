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

/**
 * The complete chronological transcript as one Pi component.
 *
 * Nothing here clips, scrolls or follows: `render` is the whole document, and the `ScrollView` it is
 * mounted in owns the viewport, the follow state and every key and gesture that moves them.
 */
export class TranscriptModel {
  constructor({ state, adapters }) {
    this.state = state;
    this.adapters = adapters;
    this.width = 80;
    this.hideThinking = false;
    // Pi expands or collapses every tool at once rather than one under a cursor.
    this.toolsExpanded = false;
    // Keyed by item identity, so a replaced item (a streaming answer) drops its entry on its own.
    this.renderedBlocks = new WeakMap();
  }
  update(state) { this.state = state; }
  setThinkingHidden(hidden) { this.hideThinking = hidden; }
  setToolsExpanded(expanded) { this.toolsExpanded = expanded; }
  /** Pi's component contract: the render cache is keyed by item, width and options, so this is a no-op. */
  invalidate() {}
  /** Rendered lines of one item, reused until the item, its tool, or the render options change. */
  blockLines(item, index) {
    const tool = item.kind === "tool" ? this.state.tools.get(item.toolId) : undefined;
    if (item.kind === "tool" && tool === undefined) return [];
    const signature = `${this.width}|${this.hideThinking ? 1 : 0}|${this.toolsExpanded ? 1 : 0}|${this.state.model?.provider ?? ""}/${this.state.model?.id ?? ""}`;
    const cached = this.renderedBlocks.get(item);
    let lines = cached?.signature === signature && cached.tool === tool ? cached.lines : undefined;
    if (lines === undefined) {
      const renderedItem = item.kind === "tool" ? { ...item, tool } : item;
      const component = this.adapters.component(renderedItem, { streaming: renderedItem.streaming, hideThinking: this.hideThinking, provider: this.state.model?.provider, model: this.state.model?.id });
      if (item.kind === "tool") component.setExpanded?.(this.toolsExpanded);
      lines = component.render(this.width).map((line) => fit(line, this.width));
      this.renderedBlocks.set(item, { signature, tool, lines });
    }
    // Pi opens every user turn but the first with a spacer above the message box.
    return item.kind === "user_message" && index > 0 ? ["", ...lines] : lines;
  }
  render(width = this.width) {
    this.width = Math.max(0, Math.floor(width));
    if (this.width === 0) return [];
    return this.state.items.flatMap((item, index) => this.blockLines(item, index));
  }
}
