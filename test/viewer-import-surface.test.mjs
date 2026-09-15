import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const recorder = join(root, "test", "fixtures", "record-module-loads.mjs");

/**
 * What a viewer costs to open, read off the module graph the loader actually builds.
 *
 * Operator-visible failure: the first session opened took seconds because reaching four message and
 * editor components pulled Pi's root barrel, and with it `main.js`, every provider and every tool.
 *
 * Nothing here asserts a duration; it asserts which of Pi's files are loaded. It covers the nine
 * leaves these four entry points reach. The other two paths in `PI_MODULES`, `core/keybindings.js`
 * and `utils/open-browser.js`, have their own canaries in pi-keybindings.test.mjs and
 * pi-native-helpers.test.mjs.
 */

/** @type {string[]} */
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** Import one module in a fresh process and report every module URL the loader resolved. */
async function moduleGraphOf(target) {
  const directory = await mkdtemp(join(tmpdir(), "pi-agents-import-surface-"));
  directories.push(directory);
  const log = join(directory, "modules.log");
  const script = `import { register } from "node:module";
register(${JSON.stringify(pathToFileURL(recorder).href)});
await import(${JSON.stringify(pathToFileURL(join(root, target)).href)});`;
  const completed = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, PI_AGENTS_MODULE_LOG: log },
    maxBuffer: 16 * 1024 * 1024,
  });
  expect(completed.stderr).toBe("");
  return (await readFile(log, "utf8")).split("\n").filter(Boolean);
}

// Pi's own build, not the pi-tui copy nested under it: that one is small, shared, and required by
// every component this viewer draws with.
const PI = "pi-coding-agent/dist/";

it.each([
  ["app/viewer/pi-component-adapters.mjs", ["modes/interactive/components/assistant-message.js", "modes/interactive/components/user-message.js", "modes/interactive/components/tool-execution.js", "modes/interactive/components/custom-editor.js", "modes/interactive/theme/theme.js"]],
  ["app/viewer/overlays.mjs", ["modes/interactive/components/dynamic-border.js", "modes/interactive/components/extension-editor.js", "modes/interactive/theme/theme.js"]],
  ["app/viewer/viewer-controller.mjs", ["modes/interactive/components/keybinding-hints.js"]],
  ["app/viewer/pi-native-helpers.mjs", ["utils/clipboard.js"]],
])("reaches Pi's own leaves from %s without loading its root barrel", async (target, leaves) => {
  const graph = await moduleGraphOf(target);
  const pi = graph.filter((url) => url.includes(PI));

  for (const leaf of leaves) expect(pi.some((url) => url.endsWith(`/dist/${leaf}`))).toBe(true);
  expect(pi.length).toBeGreaterThan(0);
  // The barrel and what only the barrel drags in: the agent entry point, the SDK, every provider.
  expect(pi.filter((url) => url.endsWith("/dist/index.js"))).toEqual([]);
  expect(pi.filter((url) => url.endsWith("/dist/main.js"))).toEqual([]);
  expect(pi.filter((url) => url.endsWith("/dist/core/sdk.js"))).toEqual([]);
  expect(pi.filter((url) => url.endsWith("/dist/modes/interactive/components/index.js"))).toEqual([]);
}, 120_000);

/**
 * The classes reached through those leaves must be Pi's own, not a second definition that happens to
 * render the same. If a leaf ever stops being what the package root exports, this fails rather than
 * the viewer quietly drawing with something else.
 */
it("binds the very components Pi's own package root exports", async () => {
  const [barrel, adapters, overlays, controller, helpers] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("../app/viewer/pi-component-adapters.mjs"),
    import("../app/viewer/overlays.mjs"),
    import("../app/viewer/viewer-controller.mjs"),
    import("../app/viewer/pi-native-helpers.mjs"),
  ]);

  expect(adapters.PI_VIEWER_COMPONENTS.AssistantMessageComponent).toBe(barrel.AssistantMessageComponent);
  expect(adapters.PI_VIEWER_COMPONENTS.UserMessageComponent).toBe(barrel.UserMessageComponent);
  expect(adapters.PI_VIEWER_COMPONENTS.ToolExecutionComponent).toBe(barrel.ToolExecutionComponent);
  expect(adapters.PI_VIEWER_COMPONENTS.CustomEditor).toBe(barrel.CustomEditor);
  expect(adapters.PI_VIEWER_COMPONENTS.getMarkdownTheme).toBe(barrel.getMarkdownTheme);
  expect(adapters.PI_VIEWER_COMPONENTS.initTheme).toBe(barrel.initTheme);
  expect(overlays.PI_OVERLAY_COMPONENTS.DynamicBorder).toBe(barrel.DynamicBorder);
  expect(overlays.PI_OVERLAY_COMPONENTS.ExtensionEditorComponent).toBe(barrel.ExtensionEditorComponent);
  expect(overlays.PI_OVERLAY_COMPONENTS.getSelectListTheme).toBe(barrel.getSelectListTheme);
  expect(controller.PI_KEY_TEXT).toBe(barrel.keyText);
  expect(helpers.PI_CLIPBOARD.copyToClipboard).toBe(barrel.copyToClipboard);
}, 120_000);
