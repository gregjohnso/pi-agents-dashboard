import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const HERE = new URL(".", import.meta.url);
const inventory = JSON.parse(readFileSync(new URL("third-party-inventory.json", HERE), "utf8"));
const notices = readFileSync(new URL("THIRD-PARTY-NOTICES.md", HERE), "utf8");

/** @param {string} text */
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

it("inventories every crate the shipped artifact is built from, against the committed lockfile", () => {
  expect(inventory.generatedFrom.cargoLockSha256).toBe(sha256(readFileSync(new URL("Cargo.lock", HERE), "utf8")));
  expect(inventory.crates.length).toBeGreaterThan(0);
  for (const crate of inventory.crates) {
    expect(crate.role, `${crate.name} ${crate.version}`).toMatch(/^(?:compiled into the artifact|ran in the compiler only)$/u);
    expect(crate.declaredLicense, `${crate.name} ${crate.version}`).toBeTruthy();
  }
});

it("holds a licence text for every inventoried crate, or names the missing one as a release blocker", () => {
  const blocked = new Set(inventory.gaps.map((/** @type {any} */ gap) => gap.subject));
  for (const crate of inventory.crates) {
    if (crate.noticeTexts.length > 0) continue;
    expect(blocked, `${crate.name} ${crate.version} has no notice text and no recorded gap`).toContain(`${crate.name} ${crate.version}`);
  }
  // The one gap that is known and unresolved: upstream publishes no MIT text anywhere. It stays a release
  // blocker in the record rather than being closed by a copyright line nobody upstream ever wrote.
  const upstream = inventory.gaps.find((/** @type {any} */ gap) => gap.subject === "@replit/ruspty@3.7.1");
  expect(upstream.impact).toContain("RELEASE BLOCKER");
  expect(upstream.checkedSources.length).toBeGreaterThan(3);
  expect(inventory.upstream.noticeText).toBe(null);
});

it("reproduces in the notices file every licence text digest the inventory claims", () => {
  const digests = [...inventory.crates, ...inventory.toolchain].flatMap((/** @type {any} */ entry) => entry.noticeTexts.map((/** @type {any} */ text) => text.sha256));
  expect(digests.length).toBeGreaterThan(0);
  for (const digest of new Set(digests)) expect(notices).toContain(digest);
  // Verbatim, not summarised: the texts the notices file quotes are the bytes the digests name.
  const quoted = notices.split(/^```$/mu).filter((_, index) => index % 2 === 1);
  expect(new Set(quoted.map((text) => sha256(`${text.trim()}\n`))).size).toBe(quoted.length);
});

it("records the Rust standard library as shipped code and the C library as a run-time link only", () => {
  const [standardLibrary, systemLibraries] = inventory.toolchain;
  expect(standardLibrary.contribution).toContain("compiled into the artifact");
  expect(standardLibrary.noticeTexts.length).toBe(3);
  expect(systemLibraries.contribution).toContain("dynamically linked");
});
