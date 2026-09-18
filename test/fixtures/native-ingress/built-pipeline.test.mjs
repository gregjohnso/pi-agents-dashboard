/**
 * The cohort-selection contract of `built-pipeline.mjs`: `PI_NATIVE_ARTIFACTS_MANIFEST` is the only way to
 * name a built cohort, and there is no path it guesses.
 *
 * These cases need no build. They import throwaway copies of the helper, so a manifest planted beside a copy
 * is a stale manifest on disk next to the helper without touching the repository's own fixture directory.
 * They state the four outcomes: an absent variable is "unselected" even with such a manifest present, and an
 * empty, missing or malformed selection fails instead of skipping or falling back.
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HELPER = path.join(path.dirname(new URL(import.meta.url).pathname), "built-pipeline.mjs");
const LEGACY_NAME = "artifacts-manifest.json";
const VALID_MANIFEST = { mode: "patched", tuiPackageRoot: "/nonexistent/cohort/pi-tui", tuiVersion: "0.84.3" };

const priorSelection = process.env.PI_NATIVE_ARTIFACTS_MANIFEST;
let roots = [];

/** A copy of the helper in a throwaway directory, so the helper's own directory is never the repository's. */
async function helperCopy() {
	const root = mkdtempSync(path.join(tmpdir(), "built-pipeline-selection-"));
	roots.push(root);
	const copy = path.join(root, "built-pipeline.mjs");
	copyFileSync(HELPER, copy);
	return { root, helper: await import(`file://${copy}`) };
}

afterEach(() => {
	if (priorSelection === undefined) delete process.env.PI_NATIVE_ARTIFACTS_MANIFEST;
	else process.env.PI_NATIVE_ARTIFACTS_MANIFEST = priorSelection;
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots = [];
});

describe("the built cohort is selected only by PI_NATIVE_ARTIFACTS_MANIFEST", () => {
	it("stays unselected with the variable unset, even beside a leftover manifest", async () => {
		const { root, helper } = await helperCopy();
		writeFileSync(path.join(root, LEGACY_NAME), JSON.stringify(VALID_MANIFEST));
		delete process.env.PI_NATIVE_ARTIFACTS_MANIFEST;
		expect(helper.artifactsManifestSelected()).toBe(false);
		const attempted = await helper.importBuiltTuiIfSelected();
		expect(attempted.selected).toBe(false);
		expect(attempted.manifest).toEqual({ mode: "unselected" });
		expect(() => helper.artifactsManifestPath()).toThrow(/PI_NATIVE_ARTIFACTS_MANIFEST/);
	});

	it("fails rather than skipping when the selection is empty", async () => {
		const { helper } = await helperCopy();
		process.env.PI_NATIVE_ARTIFACTS_MANIFEST = "";
		expect(helper.artifactsManifestSelected()).toBe(true);
		await expect(helper.importBuiltTuiIfSelected()).rejects.toThrow(/PI_NATIVE_ARTIFACTS_MANIFEST/);
	});

	it("fails clearly, naming the path, when the selected manifest is missing", async () => {
		const { root, helper } = await helperCopy();
		const missing = path.join(root, "absent-manifest.json");
		process.env.PI_NATIVE_ARTIFACTS_MANIFEST = missing;
		expect(helper.artifactsManifestSelected()).toBe(true);
		await expect(helper.importBuiltTuiIfSelected()).rejects.toThrow(missing);
	});

	it("fails clearly when the selected manifest is malformed", async () => {
		const { root, helper } = await helperCopy();
		const malformed = path.join(root, "malformed-manifest.json");
		writeFileSync(malformed, "{ not json");
		process.env.PI_NATIVE_ARTIFACTS_MANIFEST = malformed;
		expect(helper.artifactsManifestSelected()).toBe(true);
		await expect(helper.importBuiltTuiIfSelected()).rejects.toThrow();
	});

	it("reads the manifest the variable names, not the one beside the helper", async () => {
		const { root, helper } = await helperCopy();
		writeFileSync(path.join(root, LEGACY_NAME), JSON.stringify({ ...VALID_MANIFEST, tuiVersion: "leftover" }));
		const selected = path.join(root, "explicit-manifest.json");
		writeFileSync(selected, JSON.stringify(VALID_MANIFEST));
		process.env.PI_NATIVE_ARTIFACTS_MANIFEST = selected;
		expect(helper.artifactsManifestSelected()).toBe(true);
		expect(helper.artifactsManifestPath()).toBe(selected);
		expect(helper.loadArtifactsManifest().tuiVersion).toBe("0.84.3");
	});
});
