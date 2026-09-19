/**
 * The one deterministic OSC11 probe this lane is authorized to run, against an existing installed cohort.
 *
 * The question is narrow: does a terminal response consumed by the public background-colour query reach a
 * managed host's `beforeApplyTerminalResponse` hook first? The probe answers it with public callers only —
 * `ProcessTerminal`, a public native renderer, `TUI.queryTerminalBackgroundColor` and labelled
 * `dispatchNativeInput` — and asserts nothing about themes, profiles or product behaviour.
 *
 * `VirtualTerminalProfile` has no background-colour field, so a result here is **not** evidence that the
 * frozen launch profile moved. It is evidence about one caller-visible Promise and one hook that was or was
 * not called. Nothing else may be read into it.
 *
 *   node osc11-probe.mjs --consumer <installed consumer root> --output <json file>
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function argument(name) {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1 || index + 1 >= process.argv.length) throw new Error(`--${name} <value> is required`);
	return process.argv[index + 1];
}

function installedPackageRoot(consumerRoot, packageName) {
	let directory = path.resolve(consumerRoot);
	for (;;) {
		const candidate = path.join(directory, "node_modules", packageName);
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
		const parent = path.dirname(directory);
		if (parent === directory) throw new Error(`${packageName} is not installed under ${consumerRoot}`);
		directory = parent;
	}
}

const consumer = argument("consumer");
const output = argument("output");
const tuiRoot = installedPackageRoot(consumer, "@earendil-works/pi-tui");
const manifest = JSON.parse(readFileSync(path.join(tuiRoot, "package.json"), "utf8"));
const entry = manifest.exports?.["."]?.import ?? manifest.module ?? manifest.main;
const tui = await import(pathToFileURL(path.join(tuiRoot, entry)).href);

const observation = {
	probe: "osc11-background-query",
	consumer,
	tuiPackageRoot: tuiRoot,
	tuiVersion: manifest.version,
	node: process.version,
	hookCalls: [],
	queryResult: undefined,
	queryError: undefined,
	dispatch: undefined,
	profileHasBackgroundField: undefined,
	note:
		"The observable is the Promise returned by the public TUI background-colour query, and whether the " +
		"managed host's beforeApplyTerminalResponse hook was called before it resolved. No profile mutation " +
		"claim and no theme or product claim follows from it.",
};

// Silence the renderer's own output: the probe is about a Promise and a hook, not about bytes.
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;

let registration;
let terminal;
let renderer;
try {
	registration = tui.registerNativeAttachmentHost({
		profile: {
			profileId: "osc11-probe",
			term: "xterm-256color",
			capabilities: {
				kittyKeyboard: true,
				kittyGraphics: false,
				mouse: true,
				bracketedPaste: true,
				synchronizedOutput: true,
				trueColor: true,
			},
			cellSize: null,
		},
		authorizeReturn: () => "native",
		// Records every classified response it is asked about, and refuses all of them.
		beforeApplyTerminalResponse: async (response) => {
			observation.hookCalls.push({
				kind: response.kind,
				requestEpoch: response.requestEpoch,
				attachmentEpoch: response.attachmentEpoch,
				raw: Buffer.from(response.raw).toString("latin1"),
			});
			return { apply: false };
		},
	});
	observation.profileHasBackgroundField = Object.keys(tui.getVirtualTerminalProfile() ?? {}).includes("background");

	terminal = new tui.ProcessTerminal();
	renderer = new tui.TuiAltScreen(terminal);
	renderer.start();

	const query = renderer.queryTerminalBackgroundColor({ timeoutMs: 2000 });
	// The reply arrives as an authenticated client's labelled bytes, through the public seam B entry point.
	observation.dispatch = await terminal.dispatchNativeInput({
		attachmentEpoch: { attachmentId: "osc11-client", epoch: 1 },
		bytes: new Uint8Array(Buffer.from("\x1b]11;rgb:ffff/0000/0000\x07", "latin1")),
		binding: { generation: 1 },
	});
	try {
		observation.queryResult = await query;
	} catch (error) {
		observation.queryError = String(error?.message ?? error);
	}
} catch (error) {
	observation.probeError = String(error?.message ?? error);
} finally {
	try {
		renderer?.stop();
	} catch {}
	try {
		terminal?.stop();
	} catch {}
	registration?.release();
	process.stdout.write = realWrite;
}

observation.hookCalledBeforeResult = observation.hookCalls.length > 0;
writeFileSync(output, `${JSON.stringify(observation, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ queryResult: observation.queryResult, hookCalls: observation.hookCalls.length })}\n`);
