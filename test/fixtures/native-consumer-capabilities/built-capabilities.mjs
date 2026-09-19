/**
 * Resolve the built consumer-capability surface these cases drive.
 *
 * Both halves of `0006` are in the cohort: the published input target and the presentation codec are
 * `@earendil-works/pi-tui`, and bootstrap protocol 2 is `@earendil-works/pi-coding-agent`. The tui half is
 * reached through the ingress lane's existing loader, so there is one manifest rule for the whole repository,
 * and this module adds the coding-agent half through that package's own declared entry point.
 *
 * Nothing here imports from a checkout. A case that cannot find the capability in the selected cohort reports
 * exactly that, which is what makes the same file usable as behavioral RED against the five-patch cohort.
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

export async function importBuiltCapabilitiesIfSelected() {
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

/**
 * A `Terminal` that records every byte the renderer hands it, and nothing else.
 *
 * The presentation boundary these cases are about is exactly this handoff, so the double keeps it visible.
 * Recorded bytes are not proof that a client displayed anything, and no case here says they are.
 *
 * Two injectable failures, both of them real implementations a renderer does not own:
 * `reassertThrows` makes `reassertNegotiatedModes()` throw, which is the terminal-side failure that must still
 * close an ordered interval; `refuseAbort` makes the ABORT marker's own write throw, which is the case where
 * there is nothing left to close the interval with.
 */
export class MarkerRecordingTerminal {
	constructor(columns = 100, rows = 30, { reassertThrows = false, refuseAbort = false } = {}) {
		this._columns = columns;
		this._rows = rows;
		this.writes = [];
		this.reassertCalls = 0;
		this.abortAttempts = 0;
		this.negotiatedKittyFlags = 7;
		this.reassertThrows = reassertThrows;
		this.refuseAbort = refuseAbort;
	}

	start(onInput, onResize) {
		this.onInput = onInput;
		this.onResize = onResize;
		this.write("\x1b[?2004h");
	}

	stop() {
		this.onInput = undefined;
		this.onResize = undefined;
	}

	async drainInput() {}

	write(data) {
		if (this.refuseAbort && typeof data === "string" && data.includes(";A;")) {
			this.abortAttempts += 1;
			throw new Error("the output channel refused the ABORT marker");
		}
		this.writes.push(data);
	}

	since(index) {
		return this.writes.slice(index).join("");
	}

	get columns() {
		return this._columns;
	}

	get rows() {
		return this._rows;
	}

	get kittyProtocolActive() {
		return true;
	}

	reassertNegotiatedModes() {
		this.reassertCalls += 1;
		if (this.reassertThrows) throw new Error("reassertNegotiatedModes failed");
		this.write("\x1b[?2004h\x1b[=7;1u");
		return {
			reemitted: ["bracketed-paste", "kitty-keyboard-flags"],
			kittyKeyboard: { flags: 7, reemitted: true, mechanism: "set-flags" },
			modifyOtherKeys: false,
			title: undefined,
			progress: false,
		};
	}

	moveBy() {}
	hideCursor() {
		this.write("\x1b[?25l");
	}
	showCursor() {
		this.write("\x1b[?25h");
	}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	clearProgress() {}
}

/**
 * Decode one byte string twice: coalesced in a single read, and re-sliced at a fixed stride.
 *
 * **Supplementary only, and synthetic.** The stride is this file's choice, not a boundary any stream produced,
 * so this helper can show that the decoder's framing does not depend on where a caller cuts a buffer. It is not
 * and never was evidence about a real stream: the live raw-chunk observer in `live-raw-decoder.mjs` is the only
 * thing that feeds the decoder actual arriving reads. An earlier receipt described this helper's output as
 * "kernel-sized reads"; that was wrong, and this comment is the correction.
 *
 * The stride is explicit rather than random so a failure is reproducible.
 */
export function decodeBothWays(tui, token, raw, stride = 7) {
	const coalesced = new tui.NativePresentMarkerDecoder();
	coalesced.arm(token);
	const oneRead = [...coalesced.decode(Buffer.from(raw, "latin1")), ...coalesced.flush()];

	const segmented = new tui.NativePresentMarkerDecoder();
	segmented.arm(token);
	const buffer = Buffer.from(raw, "latin1");
	const events = [];
	let maxRetained = 0;
	for (let offset = 0; offset < buffer.length; offset += stride) {
		events.push(...segmented.decode(buffer.subarray(offset, offset + stride)));
		maxRetained = Math.max(maxRetained, segmented.retainedBytes());
	}
	events.push(...segmented.flush());
	return {
		oneRead,
		/** Re-sliced by this helper at `stride`. Synthetic: no stream produced these boundaries. */
		resliced: events,
		segmented: events,
		maxRetained,
		summary: (list) => list.map((event) => event.kind),
		carried: (list) =>
			list
				.filter((event) => event.kind === "bytes" || event.kind === "refused")
				.map((event) => Buffer.from(event.bytes).toString("latin1"))
				.join(""),
	};
}
