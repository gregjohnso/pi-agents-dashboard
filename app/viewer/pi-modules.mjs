/**
 * The one place this package resolves a module inside Pi's own build.
 *
 * Pi 0.84.3 exports `.`, `./rpc-entry` and `./client` and nothing else, so anything it does not
 * re-export from its package root has no specifier at all and must be resolved beside that root.
 * Every deep path this package uses is listed in `PI_MODULES`, and `test/public-pi-imports.test.mjs`
 * fails when one appears anywhere else.
 *
 * Reaching leaves rather than the root is measured: a fresh process spends 4.6-5.4 s on Pi's root
 * barrel against ~1.2 s on the components this viewer draws with. The classes are the same objects
 * either way; `test/viewer-import-surface.test.mjs` pins both the identity and the barrel's absence.
 */
export const PI_ENTRY = import.meta.resolve("@earendil-works/pi-coding-agent");

/** Every Pi module this package reaches without a package-name specifier. */
export const PI_MODULES = {
  assistantMessage: "./modes/interactive/components/assistant-message.js",
  userMessage: "./modes/interactive/components/user-message.js",
  toolExecution: "./modes/interactive/components/tool-execution.js",
  customEditor: "./modes/interactive/components/custom-editor.js",
  dynamicBorder: "./modes/interactive/components/dynamic-border.js",
  extensionEditor: "./modes/interactive/components/extension-editor.js",
  keybindingHints: "./modes/interactive/components/keybinding-hints.js",
  theme: "./modes/interactive/theme/theme.js",
  keybindings: "./core/keybindings.js",
  clipboard: "./utils/clipboard.js",
  openBrowser: "./utils/open-browser.js",
};

/** The URL one of those modules resolves to. @param {keyof PI_MODULES | string} module */
export function piModuleUrl(module) {
  return new URL(PI_MODULES[module] ?? module, PI_ENTRY).href;
}

/** Load one of Pi's own modules. Node keys its cache by URL, so importers naming the same one share it. @param {string} module */
export function importPiModule(module) {
  return import(piModuleUrl(module));
}
