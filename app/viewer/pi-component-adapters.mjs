import {
  AssistantMessageComponent, CustomEditor, ToolExecutionComponent, UserMessageComponent,
  getMarkdownTheme, initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager, TUI_KEYBINDINGS, truncateToWidth, visibleWidth,
} from "@earendil-works/pi-tui";

initTheme(undefined, false);

const APP_KEYBINDINGS = {
  "app.clipboard.pasteImage": { defaultKeys: [], description: "Paste image" },
  "app.interrupt": { defaultKeys: "ctrl+c", description: "Interrupt" },
  "app.exit": { defaultKeys: "ctrl+d", description: "Exit" },
  "app.editor.external": { defaultKeys: "ctrl+g", description: "Open external editor" },
};

const PI_HIDDEN_THINKING_LABEL = "Thinking...";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function boundedLines(lines, width) {
  return lines.map((line) => visibleWidth(line) <= width ? line : truncateToWidth(line, width, ""));
}

function textContent(content) {
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "thinking") return part.text;
    return `[${part.type}: ${part.attachmentId}]`;
  }).join("\n");
}

/** Adapt normalized content to every required public AssistantMessage field. */
export function adaptAssistantMessage(item, options = {}) {
  return {
    role: "assistant",
    content: item.content.map((part) => part.type === "thinking"
      ? { type: "thinking", thinking: part.text }
      : part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "text", text: `[${part.type}: ${part.attachmentId}]` }),
    api: options.api ?? "pi-dashboard-normalized",
    provider: options.provider ?? "pi-dashboard",
    model: options.model ?? "normalized-viewer",
    usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
    stopReason: options.stopReason ?? (options.streaming ? "pending" : "stop"),
    timestamp: options.timestamp ?? 0,
  };
}

function toolResult(tool) {
  const content = tool.error === undefined
    ? (tool.result ?? []).map((part) => part.type === "text" || part.type === "thinking"
      ? { type: "text", text: part.text }
      : { type: "text", text: `[${part.type}: ${part.attachmentId}]` })
    : [{ type: "text", text: tool.error }];
  return { content, isError: tool.state === "failed" };
}

/** Create package-root Pi/TUI keybindings for public editors and overlays. */
export function createPiKeybindings() {
  return new KeybindingsManager(/** @type {any} */ ({ ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS }));
}

/** Create Pi's public CustomEditor with package-root keybindings and a width-safe theme. */
export function createPiEditor({ tui }) {
  const plain = (text) => text;
  tui.terminal ??= { rows: 24, columns: 80 };
  const keybindings = createPiKeybindings();
  const editor = new CustomEditor(tui, {
    borderColor: plain,
    selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
  }, /** @type {any} */ (keybindings), { paddingX: 1 });
  return editor;
}

/** Adapt normalized viewer records to pinned public Pi message and tool components. */
export function createPiComponentAdapters({ tui, cwd = process.cwd(), hideThinking = false }) {
  const markdownTheme = getMarkdownTheme();
  return {
    user(item) {
      return new UserMessageComponent(textContent(item.content), markdownTheme, 1);
    },
    assistant(item, options = {}) {
      const component = new AssistantMessageComponent(undefined, options.hideThinking ?? hideThinking, markdownTheme, PI_HIDDEN_THINKING_LABEL, 1);
      component.updateContent(/** @type {any} */ (adaptAssistantMessage(item, options)), options.streaming ?? false);
      return component;
    },
    tool(tool) {
      const component = new ToolExecutionComponent(tool.name, tool.id, tool.arguments, { showImages: false }, undefined, tui, cwd);
      component.setArgsComplete();
      if (tool.state !== "pending") component.markExecutionStarted();
      if (tool.state === "streaming") component.updateResult(toolResult(tool), true);
      if (tool.state === "completed" || tool.state === "failed") component.updateResult(toolResult(tool), false);
      component.setExpanded(false);
      return component;
    },
    component(item, options = {}) {
      if (item.kind === "user_message") return this.user(item);
      if (item.kind === "assistant_message") return this.assistant(item, options);
      if (item.kind === "tool") return this.tool(item.tool);
      return {
        invalidate() {},
        render(width) {
          const label = item.kind === "system_message" ? `${item.level === "error" ? "Error: " : item.level === "warning" ? "Warning: " : ""}${item.text}`
            : item.kind === "unknown_pi_event" ? `Activity (${item.piType}): ${item.summary}`
              : `${item.kind === "image_placeholder" ? "Image" : "File"}: ${item.attachment.path ?? item.attachment.id}${item.attachment.mediaType ? ` (${item.attachment.mediaType})` : ""}${item.attachment.size !== undefined ? ` ${item.attachment.size} bytes` : ""}`;
          return ["", ...boundedLines([` ${label}`], width)];
        },
      };
    },
  };
}
