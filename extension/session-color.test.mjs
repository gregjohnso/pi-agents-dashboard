import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll as after, it as test } from "vitest";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const AGENT = process.env.PI_COLOR_TEST_AGENT_ROOT ?? new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url).pathname;
// Loaded as the operator's global copy outside a session that bundles it, so it registers.
delete process.env.PI_AGENTS_BUNDLES_SESSION_COLOR;
const { CustomEditor, InteractiveMode, discoverAndLoadExtensions, initTheme } = await import(pathToFileURL(`${AGENT}/dist/index.js`));
const { KeybindingsManager } = await import(pathToFileURL(`${AGENT}/dist/core/keybindings.js`));
const require = createRequire(`${AGENT}/dist/index.js`);
const { Container } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
const { DashboardGestureEditor } = await import("../app/list/key-gesture.mjs");
const ROOT = await mkdtemp(path.join(tmpdir(), "pi-color-test-"));
const loaded = await discoverAndLoadExtensions([new URL("./session-color.ts", import.meta.url).pathname], ROOT, ROOT);
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
/** What the extension saved into its session, through Pi's own appendEntry. */
const appended = [];
loaded.runtime.appendEntry = (customType, data) => { appended.push({ customType, data }); };
const identity = (text) => text;
const editorTheme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
after(() => rm(ROOT, { recursive: true, force: true }));

async function fixture({ gesture = true, brokenRender = false, branch = [] } = {}) {
  initTheme("dark");
  let returns = 0;
  let interrupted = 0;
  let shortcuts = 0;
  let original;
  const ui = {
    terminal: { rows: 30, columns: 80 },
    requestRender() {},
    setFocus(editor) { editor.focused = true; },
  };
  const keys = new KeybindingsManager({});
  const defaultEditor = new CustomEditor(ui, editorTheme, keys);
  defaultEditor.onEscape = () => { interrupted++; };
  defaultEditor.onExtensionShortcut = (data) => { if (data === "\x1b[20~") { shortcuts++; return true; } return false; };
  const mode = { ui, keybindings: keys, defaultEditor, editor: defaultEditor, editorContainer: new Container(), disposeActiveSelector() {} };
  const install = (factory) => InteractiveMode.prototype.setCustomEditorComponent.call(mode, factory);
  if (gesture) {
    install((tui, theme, keybindings) => {
      const base = new CustomEditor(tui, theme, keybindings);
      original = new DashboardGestureEditor(base, () => { returns++; });
      original.extraCapability = () => "retained";
      original.commitSubmittedDraft = () => "committed";
      if (brokenRender) original.render = () => { throw new Error("fixture render failure"); };
      return original;
    });
  }
  const notifications = [];
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getBranch: () => branch }, ui: {
    theme: { getColorMode: () => "truecolor" },
    getEditorComponent: () => mode.editorComponentFactory,
    setEditorComponent: install,
    notify: (...args) => notifications.push(args),
    select: async () => undefined,
  } };
  mode.editor.setText("unsent draft");
  for (const handler of extension.handlers.get("session_start")) await handler({}, ctx);
  const command = (args) => extension.commands.get("color").handler(args, ctx);
  return { mode, ctx, command, notifications, original: () => original, returns: () => returns, interrupted: () => interrupted, shortcuts: () => shortcuts };
}

test("double Left still returns to the agents list with the draft intact", async () => {
  const f = await fixture();
  const editor = f.mode.editor;
  editor.handleInput("\x01");
  editor.handleInput("\x1b[D");
  assert.equal(f.returns(), 0);
  editor.handleInput("\x1b[D");
  assert.equal(f.returns(), 1);
  assert.equal(editor.getText(), "unsent draft");
  assert.equal(editor, f.original());
  assert.equal(editor.extraCapability(), "retained");
  assert.equal(editor.commitSubmittedDraft(), "committed");
});

test("color and reset preserve double Left, F9 and interruption", async () => {
  const f = await fixture();
  const editor = f.mode.editor;
  const normal = editor.borderColor;
  const before = editor.render(70).map(stripVTControlCharacters);
  await f.command("red");
  const colored = editor.render(70);
  assert.match(colored[0], /\x1b\[38;(2|5);/u);
  assert.deepEqual(colored.map(stripVTControlCharacters), before);
  assert.equal(editor.borderColor, normal);
  editor.handleInput("\x1b[20~");
  editor.handleInput("\x1b");
  assert.equal(f.shortcuts(), 1);
  assert.equal(f.interrupted(), 1);
  editor.handleInput("\x01");
  editor.handleInput("\x1b[D");
  editor.handleInput("\x1b[D");
  assert.equal(f.returns(), 1);
  const afterNavigation = editor.render(70).map(stripVTControlCharacters);
  await f.command("default");
  assert.deepEqual(editor.render(70).map(stripVTControlCharacters), afterNavigation);
  assert.equal(editor.getText(), "unsent draft");
});

test("restores the border callback even if a custom editor cannot render", async () => {
  const f = await fixture({ brokenRender: true });
  const editor = f.mode.editor;
  const normal = editor.borderColor;
  await f.command("blue");
  assert.throws(() => editor.render(70), /fixture render failure/u);
  assert.equal(editor.borderColor, normal);
});

test("standalone Pi still gets a colorable editor when no custom editor exists", async () => {
  const f = await fixture({ gesture: false });
  assert.equal(f.mode.editor.getText(), "unsent draft");
  await f.command("green");
  assert.match(f.mode.editor.render(70)[0], /\x1b\[38;(2|5);/u);
  f.mode.editor.handleInput("\x1b[20~");
  assert.equal(f.shortcuts(), 1);
});

test("saves a chosen color with the session", async () => {
  const f = await fixture();
  await f.command("blue");
  assert.deepEqual(appended.at(-1), { customType: "session-color", data: { color: "blue" } });
  await f.command("default");
  assert.deepEqual(appended.at(-1), { customType: "session-color", data: { color: "default" } });
});

test("restores the color saved in the session when it starts again, without saving it twice", async () => {
  const saved = appended.length;
  const f = await fixture({ branch: [
    { type: "custom", customType: "session-color", data: { color: "red" } },
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "custom", customType: "session-color", data: { color: "purple" } },
  ] });
  assert.match(f.mode.editor.render(70)[0], /\x1b\[38;5;141m/u);
  assert.equal(appended.length, saved);
});

test("a global copy steps aside in a session that bundles it, so /color is registered once", async () => {
  process.env.PI_AGENTS_BUNDLES_SESSION_COLOR = "1";
  try {
    const { default: sessionColorExtension } = await import("./session-color.ts");
    const registered = [];
    const pi = { on() {}, events: { on() {}, emit() {} }, registerCommand: (name) => registered.push(name), appendEntry() {} };
    sessionColorExtension(pi);
    assert.deepEqual(registered, []);
    sessionColorExtension(pi, { bundled: true });
    assert.deepEqual(registered, ["color"]);
  } finally {
    delete process.env.PI_AGENTS_BUNDLES_SESSION_COLOR;
  }
});
