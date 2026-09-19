/**
 * The early public-ingress consumer, loaded into the real bundled CLI's own process with `node --import`.
 *
 * This is the case the published input target exists for. Pi's own ingress object is `ProcessTerminal`, and
 * before `0006` the only published route to it ran through an extension's `session_start` handler. An
 * arbitrary extension can block that handler forever, and a management extension queued behind it never
 * registers, so a host had no route at all. Here the blocking handler is real — see `blocking-extension.ts` —
 * and this consumer still reaches labelled ingress.
 *
 * Everything it uses is the installed packages' public API: `subscribeNativeInputTarget` and
 * `nativeInputTargetSnapshot` from the installed `@earendil-works/pi-tui`, and `onNativeReadiness` from the
 * installed `@earendil-works/pi-coding-agent`. No private field is read and no production code is injected.
 * `--import` runs before the CLI's main entry, so this copy subscribes before the renderer exists.
 *
 * Every observation is appended to `PI_CONSUMER_TARGET_LOG` as one JSON line with its own `order`, so the case
 * asserts a sequence rather than a snapshot: the publication must land after the terminal is dispatch-ready,
 * before `native-mounted`, and before any extension callback ran.
 *
 * Inputs: `PI_CONSUMER_TARGET_LOG`, `PI_CONSUMER_TUI_PACKAGE` (installed package root) and
 * `PI_CONSUMER_CODING_AGENT_ENTRY` (the installed package's declared ESM entry, as a `file:` URL).
 */

import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const logPath = process.env.PI_CONSUMER_TARGET_LOG;
const tuiPackageRoot = process.env.PI_CONSUMER_TUI_PACKAGE;
const codingAgentEntry = process.env.PI_CONSUMER_CODING_AGENT_ENTRY;
/**
 * The draft this consumer types through the published target.
 *
 * Unique and printable, and supplied by the case rather than invented here, so the case can look for these
 * exact characters in a later native frame instead of trusting an admission receipt.
 */
const draft = process.env.PI_CONSUMER_DRAFT ?? "PI-DRAFT-FALLBACK";

let order = 0;

function record(event) {
	order += 1;
	appendFileSync(logPath, `${JSON.stringify({ order, pid: process.pid, ...event })}\n`);
}

if (!logPath || !tuiPackageRoot || !codingAgentEntry) {
	throw new Error("PI_CONSUMER_TARGET_LOG, PI_CONSUMER_TUI_PACKAGE and PI_CONSUMER_CODING_AGENT_ENTRY are required");
}

const require = createRequire(path.join(tuiPackageRoot, "package.json"));
const tui = await import(`file://${require.resolve(tuiPackageRoot)}`);
// Already a `file:` URL: `resolveInstalledEntry` resolves the package's declared ESM entry and returns its href.
const codingAgent = await import(codingAgentEntry);

record({
	event: "loaded",
	node: process.version,
	apiVersion: tui.NATIVE_INPUT_TARGET_API_VERSION ?? null,
	hasSubscribe: typeof tui.subscribeNativeInputTarget === "function",
	hasSnapshot: typeof tui.nativeInputTargetSnapshot === "function",
});

if (typeof tui.subscribeNativeInputTarget !== "function") {
	// The five-patch cohort has no published target at all. Recorded, not thrown: the case's own assertion
	// names the missing capability, and the CLI still starts so the rest of the observation is comparable.
	record({ event: "unavailable", reason: "the installed pi-tui publishes no native input target" });
} else {
	// A host must not infer support from the exported API version; the producer is reported separately.
	const first = tui.nativeInputTargetSnapshot();
	record({
		event: "beforeMount",
		producerVersion: first.producerVersion,
		reason: first.reason,
		hasTarget: first.target !== null,
	});

	codingAgent.onNativeReadiness((readiness) => {
		record({ event: "readiness", phase: readiness.phase, sequence: readiness.sequence });
	});

	let dispatched = false;
	const { snapshot } = tui.subscribeNativeInputTarget((next) => {
		record({
			event: "publication",
			publicationId: next.publication?.publicationId ?? null,
			sequence: next.publication?.sequence ?? null,
			producerVersion: next.producerVersion,
			reason: next.reason,
			hasTarget: next.target !== null,
		});
		if (!next.target || dispatched) return;
		dispatched = true;
		// Off the notification turn: a consumer must not re-enter Pi's own startup path. The bytes are a unique
		// printable draft, labelled with this consumer's own attachment epoch and binding generation, so a later
		// native frame either carries it or does not — `admitted: true` alone is an admission receipt, not an
		// observation that the draft reached the editor.
		setImmediate(async () => {
			try {
				const host = tui.registerNativeAttachmentHost({
					profile: {
						profileId: "early-ingress-consumer",
						term: process.env.TERM ?? "xterm-256color",
						// Every capability enabled, including Kitty graphics. A positive qualification must not
						// weaken a feature to make its own profile pass: the cold reassertion's image-cache
						// invalidation only means anything when graphics are on.
						capabilities: {
							kittyKeyboard: true,
							kittyGraphics: true,
							mouse: true,
							bracketedPaste: true,
							synchronizedOutput: true,
							trueColor: true,
						},
						cellSize: { width: 8, height: 16 },
					},
					authorizeReturn: () => "native",
					beforeApplyTerminalResponse: async () => ({ apply: true }),
				});
				record({
					event: "hostRegistered",
					registered: typeof host?.release === "function",
					profile: tui.getVirtualTerminalProfile()?.profileId ?? null,
					kittyGraphics: tui.getVirtualTerminalProfile()?.capabilities?.kittyGraphics ?? null,
				});
				// Registering rotates the publication, so the current snapshot is read again rather than the
				// handle captured before it.
				const current = tui.nativeInputTargetSnapshot();
				const result = await current.target.dispatchNativeInput({
					attachmentEpoch: { attachmentId: "early-consumer", epoch: 1 },
					bytes: new Uint8Array(Buffer.from(draft, "utf8")),
					binding: { generation: 1 },
				});
				record({
					event: "dispatched",
					publicationId: current.publication?.publicationId ?? null,
					draft,
					draftBytes: Buffer.byteLength(draft, "utf8"),
					admitted: result.admitted === true,
					reason: result.reason ?? null,
					consumedThrough: result.consumedThrough ?? null,
				});
			} catch (error) {
				record({ event: "dispatchFailed", error: String(error?.message ?? error) });
			}
		});
	});
	record({ event: "subscribed", hasTarget: snapshot.target !== null, reason: snapshot.reason });
}
