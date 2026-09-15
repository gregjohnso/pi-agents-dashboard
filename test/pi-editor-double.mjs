import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPiKeybindings, installPiKeybindings } from "../app/viewer/pi-keybindings.mjs";

/**
 * Pi's `CustomEditor` action layer, reduced to what the viewer uses and resolving keys through Pi's
 * own keybindings manager.
 *
 * The dispatch order is Pi's: `app.interrupt` before anything else and only when no completion
 * popup is open, `app.exit` only on an empty editor, then every other registered action, then
 * editing. A double that invented its own order would hide exactly the precedence bugs these tests
 * exist to catch, so the surfaces that need the real thing use `createPiEditor` instead.
 */

// No test may read the operator's own ~/.pi/agent/keybindings.json, so the double loads a directory
// that holds nothing; a test that wants user bindings passes its own manager.
const NO_USER_BINDINGS = join(tmpdir(), "pi-agents-default-keybindings");

/**
 * Pi's defaults, installed the way `createPiEditor` installs them, because the key hints and every
 * pi-tui list read the global manager rather than one handed in.
 */
export function defaultTestKeybindings() {
  return installPiKeybindings(createPiKeybindings(NO_USER_BINDINGS));
}

/** @param {{ keybindings?: any, addToHistory?: (entry: string) => void, tui?: any }} [options] */
export function createPiEditorDouble({ keybindings = defaultTestKeybindings(), addToHistory = () => {}, tui = undefined } = {}) {
  let text = "";
  return {
    focused: false,
    disableSubmit: false,
    keybindings,
    // Pi's editor carries the TUI it was built with, which is where a viewer finds its overlay stack
    // and its layout root.
    tui,
    /** @type {Record<string, () => void>} */
    actions: {},
    /** @type {any} */
    autocompleteProvider: undefined,
    /** @type {((text: string) => void) | undefined} */
    onSubmit: undefined,
    /** @type {((text: string) => void) | undefined} */
    onChange: undefined,
    /** @type {(() => void) | undefined} */
    onEscape: undefined,
    /** @type {(() => void) | undefined} */
    onCtrlD: undefined,
    onAction(/** @type {string} */ action, /** @type {() => void} */ handler) { this.actions[action] = handler; },
    setAutocompleteProvider(/** @type {any} */ provider) { this.autocompleteProvider = provider; },
    setText(/** @type {string} */ value) { text = value; this.onChange?.(value); },
    getText() { return text; },
    isShowingAutocomplete() { return false; },
    addToHistory,
    handleInput(/** @type {string} */ data) {
      if (keybindings.matches(data, "app.interrupt") && !this.isShowingAutocomplete()) {
        (this.onEscape ?? this.actions["app.interrupt"])?.();
        return;
      }
      if (keybindings.matches(data, "app.exit") && text.length === 0) {
        (this.onCtrlD ?? this.actions["app.exit"])?.();
        return;
      }
      for (const [action, handler] of Object.entries(this.actions)) {
        if (action !== "app.interrupt" && action !== "app.exit" && keybindings.matches(data, action)) { handler(); return; }
      }
      if (keybindings.matches(data, "tui.input.submit")) { this.onSubmit?.(text); return; }
      if (data.length === 1 && data >= " ") { text += data; this.onChange?.(text); }
    },
    render: (/** @type {number} */ _width) => [`> ${text}`],
  };
}
