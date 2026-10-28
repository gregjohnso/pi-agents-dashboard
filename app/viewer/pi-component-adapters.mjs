import {
  truncateToWidth, visibleWidth,
} from "@earendil-works/pi-tui";

import { createPiKeybindings, installPiKeybindings } from "./pi-keybindings.mjs";
import { importPiModule } from "./pi-modules.mjs";

/**
 * Pi's own message, tool and editor components, reached one file at a time.
 *
 * Its package root re-exports these from the same files, so these are the same classes; what the
 * root adds is Pi's agent entry point, its SDK and every provider, none of which a transcript draws
 * with. The identity is pinned in test/viewer-import-surface.test.mjs.
 */
export const PI_VIEWER_COMPONENTS = {
  ...await importPiModule("assistantMessage"),
  ...await importPiModule("userMessage"),
  ...await importPiModule("toolExecution"),
  ...await importPiModule("customEditor"),
  ...await importPiModule("theme"),
};
const { AssistantMessageComponent, CustomEditor, ToolExecutionComponent, UserMessageComponent, getMarkdownTheme, initTheme } = PI_VIEWER_COMPONENTS;
// Pi 1.4.0 no longer attaches its built-in tool renderers inside ToolExecutionComponent; callers pass them, as Pi does.
const { withBuiltInRenderers } = await importPiModule("toolRenderers");

initTheme(undefined, false);

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
    api: "pi-agents-normalized",
    provider: options.provider ?? "pi-agents",
    model: options.model ?? "normalized-viewer",
    usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
    stopReason: options.streaming ? "pending" : "stop",
    timestamp: 0,
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

/**
 * Create Pi's public CustomEditor on Pi's own keybindings and a width-safe theme.
 *
 * Installing the manager is what makes the operator's `keybindings.json` reach anything at all: Pi's
 * editor and every pi-tui list resolve their keys from a global manager rather than one passed in.
 * @param {{ tui: any, agentDir?: string }} options
 */
export function createPiEditor({ tui, agentDir = undefined }) {
  const plain = (text) => text;
  tui.terminal ??= { rows: 24, columns: 80 };
  const keybindings = installPiKeybindings(createPiKeybindings(agentDir));
  const editor = new CustomEditor(tui, {
    borderColor: plain,
    selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
  }, /** @type {any} */ (keybindings), { paddingX: 1 });
  return editor;
}

/** Adapt normalized viewer records to pinned public Pi message and tool components. */
export function createPiComponentAdapters({ tui, cwd = process.cwd() }) {
  const markdownTheme = getMarkdownTheme();
  return {
    user(item) {
      return new UserMessageComponent(textContent(item.content), markdownTheme, 1);
    },
    assistant(item, options = {}) {
      const component = new AssistantMessageComponent(undefined, options.hideThinking ?? false, markdownTheme, PI_HIDDEN_THINKING_LABEL, 1);
      component.updateContent(/** @type {any} */ (adaptAssistantMessage(item, options)), options.streaming ?? false);
      return component;
    },
    tool(tool) {
      const component = new ToolExecutionComponent(tool.name, tool.id, tool.arguments, { showImages: false }, withBuiltInRenderers(tool.name, undefined), tui, cwd);
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
