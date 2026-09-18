/**
 * A test-only management extension for the coexistence case: seam A inside the real bundled CLI.
 *
 * `pi.setNativeSubmissionHost` is the supported public caller for a process launched as the bundled CLI, so
 * this extension is the only way seam A can be reached in that process without a private adapter. It is a
 * test caller, not product bootstrap.
 *
 * What it does, in `session_start`:
 *   1. registers a submission host that **refuses** every submission, so nothing is dispatched and no model
 *      call is reachable from this case,
 *   2. records what the same process already knows about the other two seams — seam E's readiness snapshot
 *      through `pi.nativeReadinessSnapshot()`, and seam B/C/F's registered attachment host through the
 *      installed pi-tui package the pre-TUI caller registered into,
 *   3. submits one native message through `pi.sendUserMessage`, which the barrier labels `extension-api`,
 *      and records the envelope its own host was asked to authorize.
 *
 * Inputs: `PI_COEXISTENCE_LOG` (JSONL output) and `PI_COEXISTENCE_TUI_PACKAGE` (installed pi-tui root).
 */

import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const logPath = process.env.PI_COEXISTENCE_LOG;
const tuiPackageRoot = process.env.PI_COEXISTENCE_TUI_PACKAGE;

function record(event) {
	appendFileSync(logPath, `${JSON.stringify({ ...event, pid: process.pid })}\n`);
}

/** The installed pi-tui instance, which is a different module instance from the one the bundle inlined. */
async function installedTui() {
	const require = createRequire(path.join(tuiPackageRoot, "package.json"));
	return import(`file://${require.resolve(tuiPackageRoot)}`);
}

export default function coexistence(pi) {
	if (!logPath || !tuiPackageRoot) throw new Error("PI_COEXISTENCE_LOG and PI_COEXISTENCE_TUI_PACKAGE are required");

	pi.on("session_start", async () => {
		const envelopes = [];
		pi.setNativeSubmissionHost({
			ownerRunId: "coexistence-owner-run",
			beforeNativeSubmit: async (envelope) => {
				envelopes.push(envelope);
				record({
					event: "beforeNativeSubmit",
					submissionId: envelope.submissionId,
					ownerRunId: envelope.ownerRunId,
					source: envelope.source,
					intent: envelope.intent,
					originalText: envelope.originalText,
					bindingGeneration: envelope.binding?.generation,
					hasCanonicalFile: typeof envelope.binding?.canonicalFile === "string",
				});
				// Refused on purpose: a refusal dispatches nothing, so this case reaches no model.
				return { authorized: false, code: "REFUSED", reason: "coexistence case refuses every submission" };
			},
			recordEffectivePayload: async (payload) => {
				record({ event: "recordEffectivePayload", submissionId: payload.submissionId });
				return { recorded: true };
			},
			nativeSubmitOutcome: (outcome) => {
				record({
					event: "nativeSubmitOutcome",
					submissionId: outcome.submissionId,
					appliedAs: outcome.appliedAs,
					reason: outcome.reason,
				});
			},
		});
		record({ event: "submissionHostRegistered", node: process.version });

		// Seam E, from the same process: the phases already recorded by the time an extension runs.
		const readiness = pi.nativeReadinessSnapshot();
		record({ event: "readinessSnapshot", phases: readiness.reached.map((entry) => entry.phase) });

		// Seam B/C/F, from the same process: the host the pre-TUI caller registered, read through the
		// installed package's public API rather than any private field of the bundle.
		const tui = await installedTui();
		const attachmentHost = tui.getNativeAttachmentHost();
		record({
			event: "attachmentHostVisible",
			registered: attachmentHost !== undefined,
			profileColumns: tui.getVirtualTerminalProfile()?.columns ?? null,
		});

		pi.sendUserMessage("coexistence probe: this submission must be refused");
		record({ event: "submissionAttempted", envelopes: envelopes.length });
	});
}
