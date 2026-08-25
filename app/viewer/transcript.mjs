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
    activity: structuredClone(snapshot.activity), role: snapshot.role, taskState: snapshot.taskState,
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
    this.distanceFromEnd = 0;
    this.following = true;
    this.newActivity = false;
    this.expandedTools = new Set([...state.tools.values()].filter((tool) => ["running", "streaming", "failed"].includes(tool.state)).map((tool) => tool.id));
  }
  setViewport(width, height) { this.width = Math.max(0, Math.floor(width)); this.height = Math.max(0, Math.floor(height)); }
  update(state) {
    const grew = state.items.length > this.state.items.length;
    this.state = state;
    if (grew && !this.following) this.newActivity = true;
    if (this.following) this.distanceFromEnd = 0;
  }
  scrollBy(lines) {
    if (lines < 0) {
      this.following = false;
      this.distanceFromEnd = Math.min(this.state.items.length, this.distanceFromEnd + Math.abs(Math.trunc(lines)));
    } else {
      this.distanceFromEnd = Math.max(0, this.distanceFromEnd - Math.trunc(lines));
      if (this.distanceFromEnd === 0) { this.following = true; this.newActivity = false; }
    }
  }
  scrollToEnd() { this.distanceFromEnd = 0; this.following = true; this.newActivity = false; }
  toggleTool(toolId) {
    if (this.expandedTools.has(toolId)) this.expandedTools.delete(toolId); else this.expandedTools.add(toolId);
  }
  render(width = this.width, height = this.height) {
    this.setViewport(width, height);
    if (height === 0 || width === 0) return [];
    const markerRows = this.newActivity ? 1 : 0;
    const blockCount = Math.max(0, height - markerRows);
    const end = Math.max(0, this.state.items.length - this.distanceFromEnd);
    const visible = this.state.items.slice(Math.max(0, end - blockCount), end);
    let lines = [];
    for (let index = visible.length - 1; index >= 0 && lines.length < height - markerRows; index -= 1) {
      const item = visible[index];
      const renderedItem = item.kind === "tool" ? { ...item, tool: this.state.tools.get(item.toolId) } : item;
      if (renderedItem.kind === "tool" && renderedItem.tool === undefined) continue;
      const component = this.adapters.component(renderedItem, { streaming: renderedItem.streaming, thinkingLevel: this.state.thinkingLevel });
      if (renderedItem.kind === "tool") component.setExpanded?.(this.expandedTools.has(renderedItem.toolId));
      lines = [...component.render(width).map((line) => fit(line, width)), ...lines];
    }
    lines = lines.slice(-(height - markerRows));
    while (lines.length < height - markerRows) lines.unshift("");
    if (this.newActivity) lines.push(fit("↓ new activity", width));
    return lines.slice(-height);
  }
}
