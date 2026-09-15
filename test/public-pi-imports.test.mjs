import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AssistantMessageComponent, CustomEditor, DynamicBorder,
  ToolExecutionComponent, UserMessageComponent, getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider, Input, KeybindingsManager, Markdown, ScrollView, SelectList, SettingsList, TuiAltScreen, visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

it("resolves and instantiates approved high-level viewer components from package roots", () => {
  for (const exported of [AssistantMessageComponent, CombinedAutocompleteProvider, CustomEditor, DynamicBorder, KeybindingsManager, ToolExecutionComponent, UserMessageComponent, getMarkdownTheme, Input, Markdown, ScrollView, SelectList, SettingsList, TuiAltScreen, visibleWidth]) expect(exported).toBeDefined();
  const plain = (text) => text;
  const selectTheme = { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain };
  const markdownTheme = { heading: plain, link: plain, linkUrl: plain, code: plain, codeBlock: plain, codeBlockBorder: plain, quote: plain, quoteBorder: plain, hr: plain, listBullet: plain, bold: plain, italic: plain, strikethrough: plain, underline: plain };
  const input = new Input();
  const markdown = new Markdown("fixture", 0, 0, markdownTheme);
  const scroll = new ScrollView(markdown, { follow: "end" });
  const select = new SelectList([{ value: "a", label: "A" }], 3, selectTheme);
  const settings = new SettingsList([{ id: "x", label: "X", currentValue: "on", values: ["on", "off"] }], 3, { label: plain, value: plain, description: plain, cursor: ">", hint: plain }, () => {}, () => {});
  const border = new DynamicBorder(plain);
  const terminal = { columns: 80, rows: 24, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  const altScreen = new TuiAltScreen(terminal);
  for (const component of [input, markdown, scroll, select, settings, border, altScreen]) expect(component.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
});

// Pi 0.84.3 exports only ".", "./rpc-entry" and "./client". Everything this package reaches past
// that is listed in one module and resolved in one place, so the private surface is one file to read
// and one file to fix when Pi moves something. Reusing Pi's own components beats restating them, and
// reaching them one file at a time beats its package root, which costs seconds to import.
it("keeps every deep Pi path in the one module that resolves them", async () => {
  const source = await readFile(resolve(root, "app/viewer/pi-modules.mjs"), "utf8");
  expect(source.match(/"\.\/[^"]+\.js"/gu)).toEqual([
    '"./modes/interactive/components/assistant-message.js"',
    '"./modes/interactive/components/user-message.js"',
    '"./modes/interactive/components/tool-execution.js"',
    '"./modes/interactive/components/custom-editor.js"',
    '"./modes/interactive/components/dynamic-border.js"',
    '"./modes/interactive/components/extension-editor.js"',
    '"./modes/interactive/components/keybinding-hints.js"',
    '"./modes/interactive/theme/theme.js"',
    '"./core/keybindings.js"',
    '"./utils/clipboard.js"',
    '"./utils/open-browser.js"',
  ]);
  expect(source).not.toMatch(/@earendil-works\/pi-(?:tui|coding-agent)\/(?:dist|src)\//u);
  // One resolution, from the package's own entry point, for all of them.
  expect(source.match(/import\.meta\.resolve\(/gu)).toHaveLength(1);
  expect(source.match(/new URL\(/gu)).toHaveLength(1);
});

it.each(["app/viewer/pi-keybindings.mjs", "app/viewer/pi-native-helpers.mjs"])("resolves %s through that module rather than its own path", async (path) => {
  const source = await readFile(resolve(root, path), "utf8");
  expect(source).toMatch(/from "\.\/pi-modules\.mjs"/u);
  expect(source.match(/new URL\("\.\/[^"]+"/gu)).toBeNull();
  expect(source).not.toMatch(/@earendil-works\/pi-(?:tui|coding-agent)\/(?:dist|src)\//u);
});

it("ships no private Pi controller, in-process session, or deep Pi import", async () => {
  const paths = [
    "app/viewer/pi-component-adapters.mjs", "app/viewer/transcript.mjs", "app/viewer/overlays.mjs",
    "app/viewer/return-gesture.mjs", "app/viewer/viewer-controller.mjs", "app/viewer/viewer-layout.mjs", "app/standalone.mjs",
    "app/list/path-completion.mjs", "app/list/dashboard.mjs", "app/list/standalone-list.mjs",
    "app/viewer/pi-modules.mjs",
  ];
  const source = (await Promise.all(paths.map(async (path) => [path, await readFile(resolve(root, path), "utf8")])));
  for (const [path, text] of source) {
    expect(text, relative(root, path)).not.toMatch(/@earendil-works\/pi-(?:tui|coding-agent)\/(?:dist|src)\//u);
    expect(text).not.toMatch(/\b(?:InteractiveMode|AgentSession)\b/u);
  }
});
