/**
 * The two consumer capabilities of `0006`, against the built cohort, through its public API only.
 *
 * Every case here drives an installed artifact named by `PI_NATIVE_ARTIFACTS_MANIFEST` or `PI_NATIVE_COHORT`,
 * never a checkout, so the same file records behavioral RED against the five-patch cohort and GREEN against
 * the six-patch one. Two capabilities are under test:
 *
 *   1. **An early public ingress target.** `subscribeNativeInputTarget`/`nativeInputTargetSnapshot` publish a
 *      narrow dispatch handle when `ProcessTerminal` is dispatch-ready, and the handle re-checks both the
 *      publication and the exact registered host object on every call. The real blocked-startup case is the
 *      bundled-CLI case at the end of this file: a `session_start` handler that never resolves, and a pre-TUI
 *      consumer that reaches labelled ingress anyway.
 *   2. **A physical presentation boundary.** An explicitly managed ordered presentation brackets the frame it
 *      produced with `dcs-pi-native-present-v1` markers on the terminal's own write path, and the cohort
 *      exports one bounded decoder for them. Without an ordering request not one marker byte is written.
 *
 * What no case here claims: that a client displayed anything. Every assertion stops at the bytes the terminal
 * object received, or at the bytes the pseudo-terminal carried. A marker is a boundary in a byte stream, not a
 * display acknowledgement, and gate 5 remains open.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import {
	decodeBothWays,
	importBuiltCapabilitiesIfSelected,
	MarkerRecordingTerminal,
} from "./fixtures/native-consumer-capabilities/built-capabilities.mjs";
import { newAttachmentNamespace } from "./fixtures/native-ingress/built-pipeline.mjs";
import { spawnPiUnderPty, startBootstrapHost } from "./fixtures/native-presentation/bootstrap-host.mjs";
import { resolveInstalledEntry, resolveInstalledPackageDirectory } from "./fixtures/native-presentation/recording-terminal.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const { selected, tui, codingAgent, manifest } = await importBuiltCapabilitiesIfSelected();
const describeCohort = selected ? describe : describe.skip;

const COHORT = process.env.PI_NATIVE_COHORT;
const REPOSITORY = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EARLY_PRELOAD = path.join(REPOSITORY, "test/fixtures/native-consumer-capabilities/early-ingress-preload.mjs");
const BLOCKING_EXTENSION = path.join(REPOSITORY, "test/fixtures/native-consumer-capabilities/blocking-extension.ts");

const harness = createRealProcessHarness("native-consumer-capabilities");

/** One profile for the whole file: the launch profile is fixed by the first registration in this process. */
const PROFILE = {
	profileId: "consumer-capabilities-lane",
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
};

function newHost() {
	return {
		profile: PROFILE,
		authorizeReturn: () => "native",
		beforeApplyTerminalResponse: async () => ({ apply: true }),
	};
}

const labelled = (text, attachmentId = "consumer-a", epoch = 1, generation = 1) => ({
	attachmentEpoch: { attachmentId, epoch },
	bytes: new Uint8Array(Buffer.from(text, "utf8")),
	binding: { generation },
});

/** Silence the real stdout for the lifetime of a case that starts a real `ProcessTerminal`. */
function captureStdout() {
	const written = [];
	const realWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk, ...rest) => {
		written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		if (typeof rest[rest.length - 1] === "function") rest[rest.length - 1]();
		return true;
	};
	return { written, restore: () => (process.stdout.write = realWrite) };
}

afterEach(() => harness.cleanup());

describeCohort("the built cohort publishes an input target a consumer can reach", () => {
	it("names the cohort under test", () => {
		expect(manifest.mode).toBe("patched");
		expect(manifest.tuiVersion).toBe("0.84.3");
	});

	it("reports API availability separately from producer availability", () => {
		// The capability is a pair of functions and a version, and a consumer must be able to tell "this build
		// has the API" from "something has published a target".
		expect(typeof tui.nativeInputTargetSnapshot).toBe("function");
		expect(typeof tui.subscribeNativeInputTarget).toBe("function");
		expect(tui.NATIVE_INPUT_TARGET_API_VERSION).toBe(1);
		const snapshot = tui.nativeInputTargetSnapshot();
		expect(snapshot.apiVersion).toBe(1);
		// Nothing has started a terminal in this process yet, so the producer is absent, not merely idle.
		expect(snapshot.producerVersion).toBeNull();
		expect(snapshot.target).toBeNull();
		expect(snapshot.reason).toBe("producer-absent");
	});

	it("publishes a dispatchable target for a started terminal and revokes it at stop", async () => {
		newAttachmentNamespace();
		const stdout = captureStdout();
		const registration = tui.registerNativeAttachmentHost(newHost());
		const terminal = new tui.ProcessTerminal();
		const delivered = [];
		try {
			terminal.start((data) => delivered.push(data), () => {});
			const published = tui.nativeInputTargetSnapshot();
			expect(published.producerVersion).toBe(1);
			expect(published.reason).toBeNull();
			expect(published.target).not.toBeNull();
			expect(published.publication.publicationId).toContain("native-input-target-");

			const admitted = await published.target.dispatchNativeInput(labelled("q"));
			expect(admitted.admitted).toBe(true);
			expect(delivered).toEqual(["q"]);

			terminal.stop();
			const revoked = tui.nativeInputTargetSnapshot();
			expect(revoked.target).toBeNull();
			expect(revoked.reason).toBe("revoked");
			expect(revoked.producerVersion).toBe(1);
			// The wrapper's refusal carries no invented `consumedThrough`: nothing was dispatched.
			expect(await published.target.dispatchNativeInput(labelled("r"))).toEqual({
				admitted: false,
				reason: "target-revoked",
			});
		} finally {
			registration.release();
			stdout.restore();
		}
	});

	it("refuses a handle whose host an older module copy moved, with no callback involved", async () => {
		newAttachmentNamespace();
		const stdout = captureStdout();
		const first = newHost();
		const registration = tui.registerNativeAttachmentHost(first);
		const terminal = new tui.ProcessTerminal();
		try {
			terminal.start(() => {}, () => {});
			const target = tui.nativeInputTargetSnapshot().target;
			expect(target).not.toBeNull();

			// Exactly what an older `registerNativeAttachmentHost` does in a mixed process: the shared host
			// moves, nothing rotates, nothing is notified. Reached through the documented process container,
			// which is the one field both copies share.
			const container = globalThis[Symbol.for("@earendil-works/pi-tui:native-attachment")];
			container.host = newHost();
			expect(tui.nativeInputTargetSnapshot().reason).toBe("host-replaced");
			expect(await target.dispatchNativeInput(labelled("s"))).toEqual({
				admitted: false,
				reason: "target-revoked",
			});
			container.host = undefined;
			expect(tui.nativeInputTargetSnapshot().reason).toBe("host-released");
			container.host = first;
			expect(tui.nativeInputTargetSnapshot().target).not.toBeNull();
		} finally {
			terminal.stop();
			registration.release();
			stdout.restore();
		}
	});

	it("rotates on a new registration, revokes on release, and republishes without a restart", async () => {
		newAttachmentNamespace();
		const stdout = captureStdout();
		const terminal = new tui.ProcessTerminal();
		const first = tui.registerNativeAttachmentHost(newHost());
		try {
			terminal.start(() => {}, () => {});
			const before = tui.nativeInputTargetSnapshot();
			const second = tui.registerNativeAttachmentHost(newHost());
			const rotated = tui.nativeInputTargetSnapshot();
			expect(rotated.publication.sequence).toBeGreaterThan(before.publication.sequence);
			expect(await before.target.dispatchNativeInput(labelled("t"))).toEqual({
				admitted: false,
				reason: "target-revoked",
			});
			expect((await rotated.target.dispatchNativeInput(labelled("t"))).admitted).toBe(true);

			second.release();
			expect(tui.nativeInputTargetSnapshot().reason).toBe("revoked");
			const third = tui.registerNativeAttachmentHost(newHost());
			const republished = tui.nativeInputTargetSnapshot();
			expect(republished.target).not.toBeNull();
			expect((await republished.target.dispatchNativeInput(labelled("t"))).admitted).toBe(true);
			third.release();
		} finally {
			terminal.stop();
			first.release();
			stdout.restore();
		}
	});

	it("keeps seam G exact: the drain closes the terminal, not the publication", async () => {
		newAttachmentNamespace();
		const stdout = captureStdout();
		const registration = tui.registerNativeAttachmentHost({ ...newHost(), childTerminalHandoff: { version: 1 } });
		const terminal = new tui.ProcessTerminal();
		try {
			terminal.start(() => {}, () => {});
			const target = tui.nativeInputTargetSnapshot().target;
			const lease = await terminal.drainNativeInput();
			const closed = await target.dispatchNativeInput(labelled("u"));
			// The named seam G refusal, from the terminal, with the bytes still the sender's.
			expect(closed).toMatchObject({ admitted: false, reason: "handoff-closed" });
			// Restore is `stop()` then `start()`, and the drain lease is still closed across it, so a call
			// through the new handle is refused for the same named reason until the lease reopens.
			terminal.stop();
			expect(tui.nativeInputTargetSnapshot().reason).toBe("revoked");
			terminal.start(() => {}, () => {});
			const restored = tui.nativeInputTargetSnapshot().target;
			expect(restored).not.toBe(target);
			expect(await restored.dispatchNativeInput(labelled("u"))).toMatchObject({
				admitted: false,
				reason: "handoff-closed",
			});
			lease.reopen();
			expect((await restored.dispatchNativeInput(labelled("u"))).admitted).toBe(true);
			expect(await target.dispatchNativeInput(labelled("u"))).toEqual({
				admitted: false,
				reason: "target-revoked",
			});
		} finally {
			terminal.stop();
			registration.release();
			stdout.restore();
		}
	});
});

describeCohort("the built cohort brackets an ordered presentation on the terminal's write path", () => {
	const renderers = ["TuiAltScreen", "TuiMainScreen"];

	it("exports the codec, its declared bounds and one bounded decoder", () => {
		expect(tui.NATIVE_PRESENT_MARKER_CODEC).toBe("dcs-pi-native-present-v1");
		expect(tui.NATIVE_PRESENT_ORDERING_VERSION).toBe(1);
		expect(tui.NATIVE_PRESENT_TOKEN_BYTES).toBe(32);
		expect(tui.NATIVE_PRESENT_TOKEN_LENGTH).toBe(43);
		expect(tui.NATIVE_PRESENT_MARKER_MAX_BYTES).toBe(128);
		expect(tui.NATIVE_PRESENT_FRESH_CHUNK_MAX).toBe(16384);
		const token = tui.mintNativePresentToken();
		expect(token).toHaveLength(43);
		expect(tui.isNativePresentToken(token)).toBe(true);
		expect(tui.isNativePresentToken(`${token}=`)).toBe(false);
		expect(tui.encodeNativePresentBegin(token).length).toBeLessThanOrEqual(128);
	});

	for (const name of renderers) {
		it(`${name} writes no marker byte for an ordinary presentation`, () => {
			const terminal = new MarkerRecordingTerminal();
			const renderer = new tui[name](terminal);
			renderer.addChild(new tui.Text("current ui", 0, 0));
			renderer.start();
			const before = terminal.writes.length;
			const outcome = renderer.presentNow({ requestId: "plain:1:1", coldTerminal: true });
			const emitted = terminal.since(before);
			renderer.stop();
			expect(outcome.presented).toBe(true);
			expect(emitted).not.toContain("pi-native-present");
			expect(outcome.receipt.ordering).toBeUndefined();
		});

		it(`${name} brackets the frame it produced, and the cohort's decoder recovers it either way`, () => {
			const token = tui.mintNativePresentToken();
			const terminal = new MarkerRecordingTerminal();
			const renderer = new tui[name](terminal);
			renderer.addChild(new tui.Text("current ui", 0, 0));
			renderer.start();
			const before = terminal.writes.length;
			const outcome = renderer.presentNow({
				requestId: "ordered:1:1",
				coldTerminal: true,
				ordering: { version: 1, token },
			});
			const emitted = terminal.since(before);
			renderer.stop();
			expect(outcome.presented).toBe(true);
			expect(outcome.receipt.ordering).toEqual({
				version: 1,
				token,
				markerCodec: "dcs-pi-native-present-v1",
			});
			// The cold reassertion and the frame are inside the interval; nothing else is.
			expect(terminal.reassertCalls).toBe(1);
			expect(emitted.startsWith(tui.encodeNativePresentBegin(token))).toBe(true);
			expect(emitted.endsWith(tui.encodeNativePresentEnd(token, outcome.receipt.frameId))).toBe(true);

			const decoded = decodeBothWays(tui, token, emitted);
			expect(decoded.summary(decoded.oneRead)[0]).toBe("begin");
			expect(decoded.summary(decoded.oneRead).at(-1)).toBe("end");
			// Segmented and coalesced reads agree, and the decoder never held more than its declared bound.
			expect(decoded.carried(decoded.segmented)).toBe(decoded.carried(decoded.oneRead));
			expect(decoded.maxRetained).toBeLessThanOrEqual(128);
			const ended = decoded.oneRead.at(-1);
			expect(ended.frameId).toBe(outcome.receipt.frameId);
			// The frame's own bytes, with the markers stripped: the boundary a host needs, and no more.
			expect(decoded.carried(decoded.oneRead).length).toBeGreaterThan(0);
			expect(decoded.carried(decoded.oneRead)).not.toContain("pi-native-present");
		});

		it(`${name} refuses an ordering it does not speak without writing a byte`, () => {
			const terminal = new MarkerRecordingTerminal();
			const renderer = new tui[name](terminal);
			renderer.addChild(new tui.Text("current ui", 0, 0));
			renderer.start();
			const before = terminal.writes.length;
			const unknown = renderer.presentNow({
				requestId: "unknown:1:1",
				coldTerminal: true,
				ordering: { version: 2, token: tui.mintNativePresentToken() },
			});
			const badToken = renderer.presentNow({
				requestId: "bad-token:1:1",
				coldTerminal: true,
				ordering: { version: 1, token: "not-a-token" },
			});
			const emitted = terminal.since(before);
			renderer.stop();
			expect(unknown).toEqual({ presented: false, reason: "unsupported-ordering" });
			expect(badToken).toEqual({ presented: false, reason: "unsupported-ordering" });
			expect(emitted).toBe("");
		});
	}

	it("keeps untrusted marker-like text byte-identical and refuses ambiguous armed markers", () => {
		const token = tui.mintNativePresentToken();
		const stale = tui.mintNativePresentToken();
		const frameId = "11111111-2222-4333-8444-555555555555";
		// An unarmed token, a stale token and a lookalike introducer are all reproduced exactly.
		const foreign = `${tui.encodeNativePresentBegin(stale)}text${tui.encodeNativePresentEnd(stale, frameId)}`;
		const untrusted = decodeBothWays(tui, token, foreign);
		expect(untrusted.carried(untrusted.oneRead)).toBe(foreign);
		expect(untrusted.summary(untrusted.oneRead)).toEqual(["bytes"]);

		// The armed token in the wrong shape or the wrong phase is refused, and its bytes are still reproduced.
		const malformed = `\x1bP=pi-native-present;1;E;${token};not-a-uuid\x1b\\`;
		const refusedShape = decodeBothWays(tui, token, malformed);
		expect(refusedShape.summary(refusedShape.oneRead)).toEqual(["refused"]);
		expect(refusedShape.carried(refusedShape.oneRead)).toBe(malformed);

		const strayEnd = decodeBothWays(tui, token, tui.encodeNativePresentEnd(token, frameId));
		expect(refusedReason(strayEnd.oneRead)).toBe("unexpected-end");

		const begin = tui.encodeNativePresentBegin(token);
		const duplicated = decodeBothWays(tui, token, `${begin}a${begin}b${tui.encodeNativePresentEnd(token, frameId)}`);
		expect(refusedReason(duplicated.oneRead)).toBe("duplicate-begin");

		const overlong = decodeBothWays(tui, token, `\x1bP=pi-native-present;1;B;${"A".repeat(400)}\x1b\\rest`);
		expect(refusedReason(overlong.oneRead)).toBe("overlong-candidate");
		expect(overlong.maxRetained).toBeLessThanOrEqual(128);
	});

	it("forwards a megabyte-scale interval without accumulating it", () => {
		const token = tui.mintNativePresentToken();
		const decoder = new tui.NativePresentMarkerDecoder();
		decoder.arm(token);
		decoder.decode(Buffer.from(tui.encodeNativePresentBegin(token), "latin1"));
		const chunk = Buffer.alloc(16 * 1024, 0x61);
		let forwarded = 0;
		for (let index = 0; index < 128; index += 1) {
			for (const event of decoder.decode(chunk)) if (event.kind === "bytes") forwarded += event.bytes.length;
			expect(decoder.retainedBytes()).toBeLessThanOrEqual(128);
		}
		expect(forwarded).toBe(128 * chunk.length);
	});
});

function refusedReason(events) {
	return events.find((event) => event.kind === "refused")?.reason;
}

describeCohort("bootstrap protocol selection in the built coding-agent", () => {
	it("exports protocol 2 as an explicit opt-in and declares its framing", () => {
		expect(codingAgent.NATIVE_BOOTSTRAP_PROTOCOL).toBe(1);
		expect(codingAgent.NATIVE_BOOTSTRAP_ORDERED_PROTOCOL).toBe(2);
		expect(codingAgent.NATIVE_BOOTSTRAP_PROTOCOL_ENV).toBe("PI_NATIVE_BOOTSTRAP_PROTOCOL");
		expect(codingAgent.NATIVE_BOOTSTRAP_ORDERED_PRESENTATION).toEqual({
			version: 1,
			markerCodec: "dcs-pi-native-present-v1",
			tokenBytes: 32,
			maxMarkerBytes: 128,
			freshChunkMax: 16384,
		});
	});
});

/**
 * The real bundled CLI, under a real pseudo-terminal, with a `session_start` handler that never resolves.
 *
 * This is the case both capabilities exist for, and nothing in it is simulated: a real extension blocks
 * startup, a real pre-TUI consumer reaches labelled ingress through the published target, and a real
 * protocol-2 host asks for one ordered presentation and reads the markers back off the pseudo-terminal.
 */
const cohortIt = (name, body) =>
	it(
		name,
		async (context) => {
			if (!COHORT) context.skip();
			await body();
		},
		240_000,
	);

function childEnvironment(overrides) {
	const environment = { ...process.env, ...overrides };
	for (const key of Object.keys(environment)) {
		if (/API_KEY|_TOKEN$|CREDENTIAL|SECRET|PASSWORD/i.test(key)) delete environment[key];
		else if (/^(AWS|ANTHROPIC|OPENAI|GOOGLE|AZURE|GEMINI|XAI)_/.test(key)) delete environment[key];
	}
	return environment;
}

async function events(file) {
	if (!existsSync(file)) return [];
	const raw = await readFile(file, "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

/**
 * Keep the pseudo-terminal evidence of a case, when a run names a directory for it.
 *
 * The harness removes its disposable state root, which is correct, and a reviewer still needs the transcript
 * and the two logs. Nothing is kept unless `PI_CONSUMER_EVIDENCE_DIR` names somewhere to keep it.
 */
async function keepEvidence(label, files) {
	const destination = process.env.PI_CONSUMER_EVIDENCE_DIR;
	if (!destination) return;
	await mkdir(path.join(destination, label), { recursive: true });
	for (const file of files) {
		if (existsSync(file)) await copyFile(file, path.join(destination, label, path.basename(file)));
	}
}

async function waitForEvents(file, predicate, label, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	let seen = [];
	while (Date.now() < deadline) {
		seen = await events(file);
		if (predicate(seen)) return seen;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`${label} never happened within ${timeoutMs}ms; events so far: ${JSON.stringify(seen)}`);
}

describe("the built cohort under a real pseudo-terminal", () => {
	cohortIt(
		"reaches labelled ingress through the published target while session_start blocks, and brackets one ordered presentation",
		async () => {
			const root = await harness.stateRoot("consumer-capabilities-");
			const agentDirectory = path.join(root, "agent");
			const extensions = path.join(agentDirectory, "extensions");
			const project = path.join(root, "project");
			const home = path.join(root, "home");
			for (const directory of [extensions, project, home]) await mkdir(directory, { recursive: true });
			await writeFile(path.join(extensions, "50-blocking.ts"), await readFile(BLOCKING_EXTENSION, "utf8"));

			// Kept outside the harness's disposable root when a run names an evidence directory, so a case that
			// times out still leaves what the consumer and the extension recorded.
			const kept = process.env.PI_CONSUMER_EVIDENCE_DIR
				? path.join(process.env.PI_CONSUMER_EVIDENCE_DIR, "blocked-startup-ordered-presentation")
				: root;
			await mkdir(kept, { recursive: true });
			const targetLog = path.join(kept, "input-target.jsonl");
			const blockingLog = path.join(kept, "blocking-extension.jsonl");
			await writeFile(targetLog, "");
			await writeFile(blockingLog, "");

			const codingAgentDirectory = resolveInstalledPackageDirectory(COHORT, "@earendil-works/pi-coding-agent");
			const tuiPackageRoot = resolveInstalledPackageDirectory(COHORT, "@earendil-works/pi-tui");
			const codingAgentEntry = resolveInstalledEntry(COHORT, "@earendil-works/pi-coding-agent");
			const cli = path.join(codingAgentDirectory, "dist/bundle/cli.js");
			expect(existsSync(cli), `the selected cohort has no bundled CLI at ${cli}`).toBe(true);

			const bootstrap = await startBootstrapHost();
			const transcriptPath = path.join(kept, "transcript");
			const pty = spawnPiUnderPty({
				command: `${process.execPath} --import ${EARLY_PRELOAD} ${cli} --tui-mode regular`,
				cwd: project,
				env: childEnvironment({
					HOME: home,
					PI_CODING_AGENT_DIR: agentDirectory,
					PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
					PI_NATIVE_BOOTSTRAP_SOCKET: bootstrap.socketPath,
					// The explicit ordered-presentation opt-in. Without it this launch is protocol 1.
					PI_NATIVE_BOOTSTRAP_PROTOCOL: "2",
					PI_OFFLINE: "1",
					PI_SKIP_VERSION_CHECK: "1",
					TERM: "xterm-256color",
					COLUMNS: "100",
					LINES: "30",
					PI_CONSUMER_TARGET_LOG: targetLog,
					PI_CONSUMER_TUI_PACKAGE: tuiPackageRoot,
					PI_CONSUMER_CODING_AGENT_ENTRY: codingAgentEntry,
					PI_BLOCKING_EXTENSION_LOG: blockingLog,
				}),
				transcriptPath,
			});
			const breadcrumb = (what) => console.error(`[consumer-capabilities] ${what} at ${Date.now()}`);
			breadcrumb("spawned");
			const identity = await inspectProcessIdentity(pty.child.pid);
			await harness.record("the bundled CLI under a pseudo-terminal with a blocked session_start", identity);
			breadcrumb("recorded the process identity");

			let exited;
			try {
				// The protocol-2 hello, with the framing this build declares.
				breadcrumb("awaiting the hello");
				const hello = await bootstrap.waitFor(
					(frame) => frame.type === "native-bootstrap",
					"the bootstrap hello",
					45_000,
				);
				expect(hello.protocol).toBe(2);
				expect(hello.orderedPresentation).toEqual({
					version: 1,
					markerCodec: "dcs-pi-native-present-v1",
					tokenBytes: 32,
					maxMarkerBytes: 128,
					freshChunkMax: 16384,
				});

				// The renderer is mounted, and the blocking handler has the extension turn forever.
				breadcrumb("awaiting native-mounted");
				await bootstrap.waitForPhase("native-mounted", 45_000);
				await waitForEvents(
					blockingLog,
					(seen) => seen.some((entry) => entry.event === "sessionStartBlocking"),
					"the extension's session_start blocking",
				);

				// Capability one: the pre-TUI consumer reached labelled ingress during that block.
				const observed = await waitForEvents(
					targetLog,
					(seen) => seen.some((entry) => entry.event === "dispatched" || entry.event === "dispatchFailed"),
					"the consumer's labelled dispatch",
				);
				const loaded = observed.find((entry) => entry.event === "loaded");
				expect(loaded.apiVersion, "the installed pi-tui publishes no input target").toBe(1);
				const dispatched = observed.find((entry) => entry.event === "dispatched");
				expect(dispatched, `the consumer never dispatched: ${JSON.stringify(observed)}`).toBeTruthy();
				expect(dispatched.admitted).toBe(true);
				expect(dispatched.consumedThrough).toBeGreaterThan(0);

				// The ordering the design requires: the publication is observed before `native-mounted`, and
				// before any extension callback could have run.
				const publication = observed.find((entry) => entry.event === "publication" && entry.hasTarget);
				const mounted = observed.find((entry) => entry.event === "readiness" && entry.phase === "native-mounted");
				expect(publication).toBeTruthy();
				expect(mounted).toBeTruthy();
				expect(publication.order).toBeLessThan(mounted.order);
				const blocked = (await events(blockingLog)).find((entry) => entry.event === "sessionStartBlocking");
				expect(blocked).toBeTruthy();
				expect((await events(blockingLog)).some((entry) => entry.event === "sessionStartReleased")).toBe(false);

				// Capability two: one explicitly managed ordered presentation, and its markers on the real
				// pseudo-terminal stream.
				const token = tui.mintNativePresentToken();
				breadcrumb("awaiting the ordered result");
				const marked = bootstrap.waitFor((frame) => frame.type === "presentation-result", "the ordered result");
				const before = pty.length();
				bootstrap.send({
					type: "present-ordered",
					protocol: 2,
					requestId: "ordered-pty-1",
					attachmentEpoch: { attachmentId: "ordered-client", epoch: 1 },
					geometryRevision: 1,
					coldTerminal: true,
					ordering: { version: 1, token, markerCodec: "dcs-pi-native-present-v1" },
				});
				const result = await marked;
				expect(result.protocol).toBe(2);
				expect(result.ordering).toEqual({ version: 1, token });
				expect(result.result.presented).toBe(true);
				const frameId = result.result.frame.frameId;
				expect(result.result.ordering).toEqual({
					version: 1,
					token,
					markerCodec: "dcs-pi-native-present-v1",
				});

				// Read the markers back off the pseudo-terminal the child actually wrote to. The terminal read
				// boundaries are whatever the kernel produced, which is the segmentation this codec has to
				// survive; the transcript file is the same bytes coalesced.
				await pty.waitUntil(
					(output) => output.includes(tui.encodeNativePresentEnd(token, frameId)),
					"the END marker on the pseudo-terminal",
				);
				const streamed = pty.since(before);
				const decoded = decodeBothWays(tui, token, streamed, 13);
				const framing = decoded.summary(decoded.oneRead).filter((kind) => kind !== "bytes");
				expect(framing).toEqual(["begin", "end"]);
				expect(decoded.oneRead.at(-1).kind === "end" ? decoded.oneRead.at(-1).frameId : null).toBe(frameId);
				expect(decoded.maxRetained).toBeLessThanOrEqual(128);
				// Same framing from the retained transcript, so the observation is not an artifact of this
				// process's own reads.
				const transcript = await readFile(transcriptPath, "latin1");
				const fromFile = decodeBothWays(tui, token, transcript, 4096);
				expect(fromFile.summary(fromFile.oneRead).filter((kind) => kind !== "bytes")).toEqual(["begin", "end"]);
				// The interval carries the frame and not the markers.
				expect(decoded.carried(decoded.oneRead)).not.toContain("pi-native-present");
				expect(decoded.carried(decoded.oneRead).length).toBeGreaterThan(0);
			} finally {
				pty.write("\x03");
				pty.write("\x03");
				pty.child.kill("SIGKILL");
				exited = await pty.exited();
				await keepEvidence("blocked-startup-ordered-presentation", [targetLog, blockingLog, transcriptPath]);
				await bootstrap.close();
			}
			expect(exited).toBeTruthy();
		},
	);

	cohortIt("writes no marker byte for a protocol-1 launch asking for an ordinary presentation", async () => {
		const root = await harness.stateRoot("consumer-default-silence-");
		const agentDirectory = path.join(root, "agent");
		const project = path.join(root, "project");
		const home = path.join(root, "home");
		for (const directory of [agentDirectory, project, home]) await mkdir(directory, { recursive: true });

		const codingAgentDirectory = resolveInstalledPackageDirectory(COHORT, "@earendil-works/pi-coding-agent");
		const cli = path.join(codingAgentDirectory, "dist/bundle/cli.js");
		const bootstrap = await startBootstrapHost();
		const transcriptPath = path.join(root, "transcript");
		const pty = spawnPiUnderPty({
			// No `PI_NATIVE_BOOTSTRAP_PROTOCOL`, no preload: the unchanged protocol-1 launch.
			command: `${process.execPath} ${cli} --tui-mode regular`,
			cwd: project,
			env: childEnvironment({
				HOME: home,
				PI_CODING_AGENT_DIR: agentDirectory,
				PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
				PI_NATIVE_BOOTSTRAP_SOCKET: bootstrap.socketPath,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				TERM: "xterm-256color",
				COLUMNS: "100",
				LINES: "30",
			}),
			transcriptPath,
		});
		const identity = await inspectProcessIdentity(pty.child.pid);
		await harness.record("the bundled CLI under a pseudo-terminal, protocol 1", identity);
		try {
			const hello = await bootstrap.waitFor((frame) => frame.type === "native-bootstrap", "the bootstrap hello");
			expect(hello.protocol).toBe(1);
			// The protocol-1 hello is byte-compatible with the reviewed one: the new field is simply absent.
			expect("orderedPresentation" in hello).toBe(false);
			await bootstrap.waitForPhase("native-mounted");
			const presented = bootstrap.waitFor((frame) => frame.type === "presentation-result", "the result");
			bootstrap.send({
				type: "present",
				protocol: 1,
				requestId: "plain-pty-1",
				attachmentEpoch: { attachmentId: "plain-client", epoch: 1 },
				geometryRevision: 1,
				coldTerminal: true,
			});
			const result = await presented;
			expect(result.result.presented).toBe(true);
			expect(result.result.ordering).toBeUndefined();
			expect("ordering" in result).toBe(false);
			// A protocol-2 command on a protocol-1 channel is refused by version, and still no marker is written.
			const refused = bootstrap.waitFor((frame) => frame.type === "error", "the refusal");
			bootstrap.send({
				type: "present-ordered",
				protocol: 2,
				requestId: "plain-pty-2",
				attachmentEpoch: { attachmentId: "plain-client", epoch: 1 },
				geometryRevision: 1,
				coldTerminal: true,
				ordering: { version: 1, token: tui.mintNativePresentToken() },
			});
			expect((await refused).error).toContain("unsupported protocol 2");
			expect(await readFile(transcriptPath, "latin1")).not.toContain("pi-native-present");
		} finally {
			pty.write("\x03");
			pty.write("\x03");
			pty.child.kill("SIGKILL");
			await pty.exited();
			await keepEvidence("protocol-1-default-silence", [transcriptPath]);
			await bootstrap.close();
		}
	});
});
