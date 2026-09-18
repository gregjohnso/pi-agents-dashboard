/**
 * Resolve the built child-handoff surface these tests drive.
 *
 * Seam G spans both packages of the cohort: the drain and the phase registry are `@earendil-works/pi-tui`,
 * and the recognized external-editor bracket is `@earendil-works/pi-coding-agent`. The tui half is reached
 * through the ingress lane's existing helpers, so there is one manifest loader and one selection rule; this
 * module adds the coding-agent half, resolved through that package's own declared public entry point so the
 * cases import exactly what a consumer imports.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	artifactsManifestSelected,
	importBuiltTuiIfSelected,
	loadArtifactsManifest,
} from "../native-ingress/built-pipeline.mjs";

/** The installed package root inside the cohort's consumer, hoisted or nested under coding-agent. */
function installedPackageRoot(consumerRoot, packageName) {
	const candidates = [
		path.join(consumerRoot, "node_modules", packageName),
		path.join(consumerRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules", packageName),
	];
	const found = candidates.find((candidate) => existsSync(path.join(candidate, "package.json")));
	if (!found) throw new Error(`${packageName} is not installed under ${consumerRoot}`);
	return found;
}

/**
 * Import the built cohort's tui and coding-agent public entry points, or report that no cohort is selected.
 *
 * The same rule the ingress and presentation suites follow: no selection skips, because these cases cannot
 * be run against a checkout, and a selected cohort that is missing or malformed fails loudly.
 */
export async function importBuiltHandoffIfSelected() {
	if (!artifactsManifestSelected()) {
		return { selected: false, tui: undefined, codingAgent: undefined, manifest: { mode: "unselected" } };
	}
	const { tui, manifest, packageVersion } = await importBuiltTuiIfSelected();
	const root = installedPackageRoot(manifest.consumerRoot, "@earendil-works/pi-coding-agent");
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const entry = pkg.exports?.["."]?.import ?? pkg.main;
	if (!entry) throw new Error(`${root} declares no public entry point`);
	const codingAgent = await import(pathToFileURL(path.join(root, entry)).href);
	return { selected: true, tui, codingAgent, manifest, packageVersion, codingAgentVersion: pkg.version };
}

export { loadArtifactsManifest };

/** One deferred, for a host decision a case settles by hand instead of waiting for a timer. */
export function deferred() {
	let settle;
	const promise = new Promise((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

/**
 * A recognized-handoff site whose every operation is recorded in order, with injectable failures.
 *
 * `terminal` is supplied by the case: a real `ProcessTerminal` when the point is that admission really
 * closes and reopens, and a recording double when the point is a failure the real terminal cannot be asked
 * to produce.
 */
export function recordingSite({ terminal, child, restoreThrows = false, released = false } = {}) {
	const order = [];
	const applied = [];
	let isReleased = released;
	return {
		order,
		applied,
		site: {
			terminal,
			isReleased: () => isReleased,
			release: () => {
				isReleased = true;
				order.push("release");
			},
			reclaim: () => {
				isReleased = false;
				order.push("reclaim");
			},
			stop: () => order.push("stop"),
			restore: () => {
				order.push("restore");
				if (restoreThrows) throw new Error("restore failed");
			},
			runChild: async () => {
				order.push("child");
				return child ? await child() : { status: "complete", content: "edited" };
			},
			applyResult: (result) => {
				order.push("applyResult");
				applied.push(result);
			},
		},
	};
}

/** A terminal double that only has to be drainable, for the failure cases a real terminal cannot produce. */
export function drainableTerminalDouble(order) {
	let admission = "open";
	let current;
	return {
		get admission() {
			return admission;
		},
		terminal: {
			start() {},
			stop() {},
			write() {},
			async drainNativeInput() {
				order.push("drain");
				admission = "draining";
				const lease = {
					drainedThrough: 7,
					reopen() {
						if (current !== lease) return;
						current = undefined;
						order.push("reopen");
						admission = "open";
					},
				};
				current = lease;
				return lease;
			},
		},
	};
}
