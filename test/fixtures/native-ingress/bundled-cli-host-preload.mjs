/**
 * Test-only pre-TUI caller for the installed bundled CLI.
 *
 * The bundled CLI inlines `@earendil-works/pi-tui`, so this module deliberately imports the *installed*
 * package instead: it is a second pi-tui module instance in the same process. Registration is one host
 * per process, kept in the versioned process-wide container, so a host registered here is the host the
 * bundle's own inlined instance consults. That cross-instance property is exactly what this caller
 * exercises, and it is the reason the seam's state cannot live in one module instance's scope.
 *
 * Loaded with `node --import`, so it runs before the CLI's entry module and therefore before Pi writes
 * any startup capability query. It is a test caller, not product bootstrap: the owner's real bootstrap
 * is named in INTERFACE.md section 11.
 *
 * Inputs, all required except the decision:
 *   PI_NATIVE_HOST_LOG          JSONL file this caller appends its observations to
 *   PI_NATIVE_HOST_TUI_PACKAGE  installed @earendil-works/pi-tui package root
 *   PI_NATIVE_HOST_DECISION     "apply" (authorize) or anything else (refuse)
 *
 * Nothing is written to stdout or stderr: those are the CLI's terminal.
 */

import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const logPath = process.env.PI_NATIVE_HOST_LOG;
const packageRoot = process.env.PI_NATIVE_HOST_TUI_PACKAGE;
const decision = process.env.PI_NATIVE_HOST_DECISION === "apply";

function record(event) {
	appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

if (!logPath || !packageRoot) {
	throw new Error("PI_NATIVE_HOST_LOG and PI_NATIVE_HOST_TUI_PACKAGE are required");
}

const require = createRequire(path.join(packageRoot, "package.json"));
const entry = require.resolve(packageRoot);
const tui = await import(`file://${entry}`);

record({
	event: "preload",
	node: process.version,
	pid: process.pid,
	installedTuiEntry: entry,
	hasSeam: typeof tui.registerNativeAttachmentHost === "function",
});

if (typeof tui.registerNativeAttachmentHost !== "function") {
	throw new Error("the installed @earendil-works/pi-tui exposes no registerNativeAttachmentHost");
}

const registration = tui.registerNativeAttachmentHost({
	profile: {
		profileId: "bundled-cli-pre-tui-caller",
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
	authorizeReturn: (request) => {
		record({ event: "authorizeReturn", sequenceId: request.sequenceId, origin: request.origin });
		return "native";
	},
	beforeApplyTerminalResponse: (response) => {
		record({
			event: "beforeApplyTerminalResponse",
			kind: response.kind,
			requestEpoch: response.requestEpoch,
			attachmentEpoch: response.attachmentEpoch,
			raw: Buffer.from(response.raw).toString("utf8"),
			apply: decision,
		});
		return Promise.resolve({ apply: decision });
	},
});

record({
	event: "registered",
	decision: decision ? "apply" : "refuse",
	profile: tui.getVirtualTerminalProfile()?.profileId ?? null,
	hostVisibleFromInstalledInstance: tui.getNativeAttachmentHost() !== undefined,
});

process.on("exit", () => {
	registration.release();
});
