/**
 * Resolve the built native pipeline these tests drive, and drive it.
 *
 * The tests never import pi-tui from a checkout: they import the package root named by an artifacts
 * manifest, which `write-artifacts-manifest.mjs` produces from a build's own `build-manifest.json` and the
 * consumer that build installed. One immutable artifact therefore feeds every case here, and the same files
 * can be pointed at the unpatched pinned 0.84.3 install to record behavioral RED against the real native
 * pipeline.
 *
 * `PI_NATIVE_ARTIFACTS_MANIFEST` names that manifest, and nothing else does. There is no path these cases
 * guess, because a manifest holds absolute paths into one machine's disposable build output: a leftover copy
 * would point every later run at a stale build. Without the variable these cases say which manifest they
 * need instead of silently driving whatever was left behind, and with an unusable one they fail rather than
 * skip.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The manifest this run drives. There is no default path: an unset or empty selection throws. */
export function artifactsManifestPath() {
	const selected = process.env.PI_NATIVE_ARTIFACTS_MANIFEST;
	if (selected === undefined || selected.trim().length === 0) {
		throw new Error(
			"PI_NATIVE_ARTIFACTS_MANIFEST names the artifacts manifest these cases drive, and it is unset or " +
				"empty. There is no default: build the cohort, write a manifest with " +
				"test/fixtures/native-ingress/write-artifacts-manifest.mjs, and name it.",
		);
	}
	return path.resolve(selected);
}

export function loadArtifactsManifest() {
	const manifestPath = artifactsManifestPath();
	let raw;
	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch (error) {
		throw new Error(
			`${manifestPath} is missing. These cases drive a built artifact, not the checkout. Build the cohort, ` +
				`write a manifest with test/fixtures/native-ingress/write-artifacts-manifest.mjs, and name it in ` +
				`PI_NATIVE_ARTIFACTS_MANIFEST. Underlying error: ${error.message}`,
		);
	}
	const manifest = JSON.parse(raw);
	for (const field of ["mode", "tuiPackageRoot", "tuiVersion"]) {
		if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
			throw new Error(`${manifestPath} is missing a usable "${field}"`);
		}
	}
	if (manifest.mode !== "patched" && manifest.mode !== "baseline") {
		throw new Error(`${manifestPath} mode must be "patched" or "baseline", not ${manifest.mode}`);
	}
	return manifest;
}

/** Import the built package's public entry point, exactly as a consumer would. */
export async function importBuiltTui() {
	const manifest = loadArtifactsManifest();
	const require = createRequire(path.join(manifest.tuiPackageRoot, "package.json"));
	const pkg = JSON.parse(readFileSync(path.join(manifest.tuiPackageRoot, "package.json"), "utf8"));
	const entry = require.resolve(manifest.tuiPackageRoot);
	const tui = await import(`file://${entry}`);
	return { tui, manifest, packageVersion: pkg.version };
}

/** True when this run names a cohort at all. Only an absent variable counts as no selection. */
export function artifactsManifestSelected() {
	return process.env.PI_NATIVE_ARTIFACTS_MANIFEST !== undefined;
}

/**
 * The built cohort, or an unselected marker.
 *
 * The default repository suite runs with no cohort selected, and these cases cannot be run against a
 * checkout, so they skip rather than fail — the same rule the seam A and seam E suites follow. A selected
 * cohort still fails loudly when it is missing or malformed: only the absence of any selection skips.
 */
export async function importBuiltTuiIfSelected() {
	if (!artifactsManifestSelected()) {
		return { selected: false, tui: undefined, manifest: { mode: "unselected" }, packageVersion: "unselected" };
	}
	return { selected: true, ...(await importBuiltTui()) };
}

/**
 * A terminal driven only through the public seam-B entry point.
 *
 * `ProcessTerminal` owns real stdin, so the harness starts it, captures every sequence the terminal
 * forwards with its provenance, and silences output by replacing `process.stdout.write` for the
 * lifetime of the case. Nothing reaches into a private field.
 */
export function startCapturingTerminal(tui, { start = true } = {}) {
	const terminal = new tui.ProcessTerminal();
	const delivered = [];
	const written = [];
	const realWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk, ...rest) => {
		written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		if (typeof rest[rest.length - 1] === "function") rest[rest.length - 1]();
		return true;
	};
	// A Tui claims the terminal's input handler itself, so a case that mounts one must not claim it here.
	if (start) {
		terminal.start(
			(data, provenance) => {
				delivered.push({ data, provenance });
			},
			() => {},
		);
	}
	return {
		terminal,
		delivered,
		written,
		/**
		 * Feed bytes the way a real local terminal does, through the stdin listener the started terminal
		 * installed. This reaches native parsing and dispatch in every build, patched or not, so a case
		 * built on it states something about behavior rather than about a symbol's existence.
		 */
		feedStdin(text) {
			process.stdin.emit("data", text);
		},
		stop() {
			try {
				terminal.stop();
			} finally {
				process.stdout.write = realWrite;
			}
		},
	};
}

export function bytes(text) {
	return new Uint8Array(Buffer.from(text, "utf8"));
}

let caseNamespace = 0;

/**
 * Start a fresh attachment-identity namespace. An epoch strictly increases per `attachmentId` for the
 * whole owner launch and is never reused, so two cases that both used `client-a` at epoch 1 would have
 * the second one correctly refused as superseded. Each case therefore gets its own id suffix.
 */
export function newAttachmentNamespace() {
	caseNamespace += 1;
}

export function attachment(attachmentId, epoch = 1) {
	return { attachmentId: `${attachmentId}#${caseNamespace}`, epoch };
}

/** Dispatch one labelled span, or explain that the built artifact has no seam-B entry point at all. */
export async function dispatch(terminal, attachmentEpoch, text, generation = 1) {
	if (typeof terminal.dispatchNativeInput !== "function") {
		return { unavailable: true, consumedThrough: null };
	}
	return terminal.dispatchNativeInput({
		attachmentEpoch,
		bytes: text instanceof Uint8Array ? text : bytes(text),
		binding: { generation },
	});
}

export async function dispatchRaw(terminal, attachmentEpoch, byteArray, generation = 1) {
	if (typeof terminal.dispatchNativeInput !== "function") {
		return { unavailable: true, consumedThrough: null };
	}
	return terminal.dispatchNativeInput({ attachmentEpoch, bytes: byteArray, binding: { generation } });
}

/**
 * Drive `StdinBuffer` with per-chunk origins and capture whatever attribution it reports.
 *
 * `StdinBuffer` is public API in both the baseline and the patched build, and its extra `process`
 * arguments are ignored by the baseline. A case built on this therefore always reaches real native
 * parsing: it asserts the parsed sequences first, then the attribution alongside them.
 *
 * Each chunk may name a `generation`, the binding generation the bytes were dispatched under, so a case
 * can state what happens when one sequence is framed across a generation change.
 */
export function decodeWithOrigins(tui, labelledChunks) {
	const buffer = new tui.StdinBuffer({ escapeTimeout: 10 });
	const sequences = [];
	const pastes = [];
	buffer.on("data", (sequence, attribution) => sequences.push({ sequence, attribution }));
	buffer.on("paste", (content, attribution) => pastes.push({ content, attribution }));
	for (const { chunk, origin, generation = 1 } of labelledChunks) buffer.process(chunk, origin, generation);
	buffer.destroy();
	return { sequences, pastes };
}

/**
 * Feed the same bytes the way unmanaged Pi does, so a case can compare managed behavior with the stock
 * path in the same built artifact. `StdinBuffer` is public API in both baseline and patched builds.
 */
export function decodeWithStockBuffer(tui, chunks) {
	const buffer = new tui.StdinBuffer({ escapeTimeout: 10 });
	const sequences = [];
	const pastes = [];
	buffer.on("data", (sequence) => sequences.push(sequence));
	buffer.on("paste", (content) => pastes.push(content));
	for (const chunk of chunks) buffer.process(chunk);
	buffer.destroy();
	return { sequences, pastes };
}
