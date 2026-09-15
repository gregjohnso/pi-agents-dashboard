import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { setKeybindings as setOwnKeybindings } from "@earendil-works/pi-tui";

import { PI_ENTRY, importPiModule, piModuleUrl } from "./pi-modules.mjs";

/**
 * Pi's own keybinding table, user configuration loader and legacy-name migrations, reused rather
 * than restated.
 *
 * Pi 0.84.3 exports only `.`, `./rpc-entry` and `./client`, so `core/keybindings.js` has no
 * package-name specifier. Resolving it beside the package's own entry point is deliberate: the
 * alternative is a second copy of Pi's sixty-entry table and its migration map, which drifts from
 * the keys Pi documents without anything failing. The version is pinned exactly, and
 * pi-keybindings.test.mjs fails the moment the path or the exports move.
 */
export const PI_KEYBINDINGS_MODULE = piModuleUrl("keybindings");

/**
 * Pi ships its own copy of pi-tui under its package, so `getKeybindings()` inside Pi's components
 * reads a different singleton than the one this package's own components read. One manager has to be
 * installed in both, or the editor keeps pi-tui's defaults while the overlays follow the operator.
 */
export const PI_TUI_MODULE = pathToFileURL(createRequire(PI_ENTRY).resolve("@earendil-works/pi-tui")).href;

const { KeybindingsManager } = await importPiModule("keybindings");
const { setKeybindings: setPiKeybindings } = await import(PI_TUI_MODULE);

/**
 * Pi's full table with the operator's `keybindings.json` applied.
 * @param {string} [agentDir] Pi agent directory to read; Pi's own default when omitted.
 */
export function createPiKeybindings(agentDir = undefined) {
  return agentDir === undefined ? KeybindingsManager.create() : KeybindingsManager.create(agentDir);
}

/**
 * Hand every pi-tui component the manager it resolves its keys from. pi-tui's `Editor`, `Input`,
 * `SelectList` and `SettingsList` each read the global manager rather than one passed in, so without
 * this the operator's cursor, delete, history and selection bindings are ignored.
 * @param {any} keybindings
 */
export function installPiKeybindings(keybindings) {
  setOwnKeybindings(keybindings);
  setPiKeybindings(keybindings);
  return keybindings;
}
