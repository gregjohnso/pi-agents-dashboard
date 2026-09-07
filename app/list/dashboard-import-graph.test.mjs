import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

/**
 * The list must draw without loading Pi's package.
 *
 * Measured 2026-09-06: importing `@earendil-works/pi-coding-agent` costs 2.83 s, and the list pulled
 * it through one string helper, so every `pi-agents` spent about 4 s before drawing a row. A timing
 * assertion would be flaky on a shared machine; the module graph is the same fact stated exactly.
 */

const LIST_ENTRY = fileURLToPath(new URL("./dashboard.mjs", import.meta.url));
const APP_ENTRY = fileURLToPath(new URL("../standalone.mjs", import.meta.url));
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Packages `entry` loads before it runs, following static relative imports only.
 *
 * A dynamic `import()` is deliberately not followed: deferring Pi's package to the moment a session
 * is opened is exactly the fix this pins, so counting it here would forbid the remedy.
 */
async function staticPackages(entry) {
  const seen = new Set();
  const packages = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = /** @type {string} */ (pending.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*?from\s*["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier));
      else packages.add(specifier);
    }
  }
  return packages;
}

it("draws the list without pulling Pi's package into the module graph", async () => {
  const packages = await staticPackages(LIST_ENTRY);

  expect(packages).not.toContain(PI_PACKAGE);
  // The list still needs the terminal library; this is about Pi's bundle, not about being dependency-free.
  expect(packages).toContain("@earendil-works/pi-tui");
});

it("starts the app without loading Pi's package before a session is opened", async () => {
  expect(await staticPackages(APP_ENTRY)).not.toContain(PI_PACKAGE);
});
