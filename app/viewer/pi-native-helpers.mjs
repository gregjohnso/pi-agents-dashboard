import { importPiModule, piModuleUrl } from "./pi-modules.mjs";

/**
 * The two callbacks Pi's alternate screen needs to finish a copy and a hyperlink click.
 *
 * Both are Pi's own. Neither is reachable by specifier: Pi 0.84.3 exports only `.`, `./rpc-entry`
 * and `./client`, and the root that does re-export `copyToClipboard` costs seconds to import. They
 * are reused rather than rewritten on purpose; `openBrowser` in particular opens a URL without ever
 * invoking a shell, which is what keeps a hyperlink out of a command line on Windows. The version is
 * pinned exactly and pi-native-helpers.test.mjs fails the moment a path or an export moves.
 */
export const PI_OPEN_BROWSER_MODULE = piModuleUrl("openBrowser");

export const PI_CLIPBOARD = await importPiModule("clipboard");

const { openBrowser } = await importPiModule("openBrowser");
const { copyToClipboard } = PI_CLIPBOARD;

/**
 * Pi's own clipboard and browser helpers, in the shape `TuiAltScreen` takes them. A caller may pass
 * its own; nothing else here opens a URL or writes the clipboard.
 * @param {{ copySelection?: (text: string) => Promise<boolean>, openUrl?: (url: string) => void }} [overrides]
 */
export function createNativeTuiHelpers({ copySelection = undefined, openUrl = undefined } = {}) {
  return {
    copySelection: copySelection ?? (async (/** @type {string} */ text) => {
      try { await copyToClipboard(text); return true; } catch { return false; }
    }),
    openUrl: openUrl ?? ((/** @type {string} */ url) => openBrowser(url)),
  };
}
