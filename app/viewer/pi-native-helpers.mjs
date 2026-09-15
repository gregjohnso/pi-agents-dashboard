import { copyToClipboard } from "@earendil-works/pi-coding-agent";

/**
 * The two callbacks Pi's alternate screen needs to finish a copy and a hyperlink click.
 *
 * `copyToClipboard` is exported from Pi's package root. `openBrowser` is not, and Pi 0.84.3 exports
 * only `.`, `./rpc-entry` and `./client`, so it has no package-name specifier. It is reused rather
 * than rewritten on purpose: it opens a URL without ever invoking a shell, which is what keeps a
 * hyperlink out of a command line on Windows. Writing a second opener here would mean owning that
 * decision again, badly. The version is pinned exactly and pi-native-helpers.test.mjs fails the
 * moment the path or the export moves.
 */
const PI_ENTRY = import.meta.resolve("@earendil-works/pi-coding-agent");

export const PI_OPEN_BROWSER_MODULE = new URL("./utils/open-browser.js", PI_ENTRY).href;

const { openBrowser } = await import(PI_OPEN_BROWSER_MODULE);

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
