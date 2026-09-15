import { expect, it, vi } from "vitest";

import { PI_OPEN_BROWSER_MODULE, createNativeTuiHelpers } from "./pi-native-helpers.mjs";

/**
 * The clipboard and hyperlink callbacks Pi's alternate screen calls.
 *
 * Operator-visible failure: a dragged selection that copies nothing, or a clicked link that opens
 * nothing, because this package handed `TuiAltScreen` no helpers at all.
 */

it("prefers the caller's own clipboard and opener", async () => {
  const copySelection = vi.fn(async () => true);
  const openUrl = vi.fn();
  const helpers = createNativeTuiHelpers({ copySelection, openUrl });

  await helpers.copySelection("selected text");
  helpers.openUrl("https://example.com");

  expect(copySelection).toHaveBeenCalledWith("selected text");
  expect(openUrl).toHaveBeenCalledWith("https://example.com");
});

it("falls back to Pi's own helpers", () => {
  const helpers = createNativeTuiHelpers();
  expect(typeof helpers.copySelection).toBe("function");
  expect(typeof helpers.openUrl).toBe("function");
});

// Canary: Pi 0.84.3 exports only ".", "./rpc-entry" and "./client", so its shell-free browser opener
// is reachable only next to the package's own entry point. When this fails Pi moved or renamed that
// module: follow it, or ask for an export. Never write a second opener here.
it("still finds Pi's own browser opener beside the package entry point", async () => {
  const module = await import(PI_OPEN_BROWSER_MODULE);
  expect(PI_OPEN_BROWSER_MODULE).toMatch(/utils\/open-browser\.js$/u);
  expect(typeof module.openBrowser).toBe("function");
});
