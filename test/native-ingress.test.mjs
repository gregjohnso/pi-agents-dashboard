/**
 * Seam B and seam F against the built native pipeline: labelled ingress and response authorization.
 *
 * Every case drives real bytes through the built `ProcessTerminal`/`StdinBuffer` path, so a failure here
 * is a statement about native parsing and dispatch, not about a missing import.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attachment,
	bytes,
	decodeWithOrigins,
	decodeWithStockBuffer,
	dispatch,
	dispatchRaw,
	importBuiltTuiIfSelected,
	loadArtifactsManifest,
	newAttachmentNamespace,
	startCapturingTerminal,
} from "./fixtures/native-ingress/built-pipeline.mjs";

const { selected, tui, manifest, packageVersion } = await importBuiltTuiIfSelected();
// No cohort selected means the default repository suite is running; these cases need a built artifact.
const describeCohort = selected ? describe : describe.skip;

let harness;

beforeEach(() => {
	newAttachmentNamespace();
});

afterEach(() => {
	harness?.stop();
	harness = undefined;
});

function profile(profileId) {
	return {
		profileId,
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
}

function registerHost(overrides = {}) {
	expect(typeof tui.registerNativeAttachmentHost).toBe("function");
	const calls = { responses: [], returns: [] };
	const registration = tui.registerNativeAttachmentHost({
		profile: overrides.profile ?? profile("input-lane-profile"),
		authorizeReturn(request) {
			calls.returns.push(request);
			return overrides.authorizeReturn ? overrides.authorizeReturn(request) : "native";
		},
		beforeApplyTerminalResponse(response) {
			calls.responses.push(response);
			return overrides.beforeApplyTerminalResponse
				? overrides.beforeApplyTerminalResponse(response)
				: Promise.resolve({ apply: true });
		},
	});
	return { calls, registration };
}

/**
 * These cases use only API that exists in both the baseline and the patched build, so each one reaches
 * real native parsing and then asserts the provenance the seam is supposed to carry. They are the
 * behavioral RED for seam B: against the unpatched pinned build the sequences parse correctly and the
 * attribution is simply absent.
 */
describeCohort(`native parsing carries provenance (${manifest.mode})`, () => {
	// b1-same-origin-fragments, reached through public StdinBuffer parsing
	it("reports the origin of a sequence reassembled from two fragments of one attachment", () => {
		const a = attachment("client-a", 3);
		const { sequences } = decodeWithOrigins(tui, [
			{ chunk: "\x1b[", origin: a, generation: 4 },
			{ chunk: "A", origin: a, generation: 4 },
		]);

		// Parsing first: this proves the case reached the real decoder, not a missing export.
		expect(sequences.map((entry) => entry.sequence)).toEqual(["\x1b[A"]);
		expect(
			sequences[0].attribution,
			"the parsed Up sequence must arrive with the attachment and generation that supplied its bytes",
		).toEqual({
			origin: attachment("client-a", 3),
			mixedOrigin: false,
			bindingGeneration: 4,
			mixedBindingGeneration: false,
		});
	});

	// b7-generation-framing: a sequence framed across a generation change is attribution-mixed, not
	// silently relabelled as wholly current-generation input.
	it("marks a sequence whose native framing spans two binding generations", () => {
		const a = attachment("client-a", 1);
		const { sequences } = decodeWithOrigins(tui, [
			{ chunk: "\x1b[13", origin: a, generation: 1 },
			{ chunk: "u", origin: a, generation: 2 },
		]);

		expect(sequences.map((entry) => entry.sequence)).toEqual(["\x1b[13u"]);
		expect(
			sequences[0].attribution,
			"stale-generation bytes must stay visible in the attribution of the sequence they framed",
		).toEqual({
			origin: attachment("client-a", 1),
			mixedOrigin: false,
			bindingGeneration: 2,
			mixedBindingGeneration: true,
		});
	});

	// b2-mixed-origin-final-byte, reached through public StdinBuffer parsing
	it("marks a sequence assembled from two attachments and attributes it to the final byte", () => {
		const { sequences } = decodeWithOrigins(tui, [
			{ chunk: "\x1b[", origin: attachment("client-a") },
			{ chunk: "B", origin: attachment("client-b") },
			{ chunk: "D", origin: attachment("client-a") },
		]);

		// M0 Task 3 measured this exact stream as Down then D, never Left. Same decoder, same result.
		expect(sequences.map((entry) => entry.sequence)).toEqual(["\x1b[B", "D"]);
		expect(sequences[0].attribution).toEqual({
			origin: attachment("client-b", 1),
			mixedOrigin: true,
			bindingGeneration: 1,
			mixedBindingGeneration: false,
		});
		expect(sequences[1].attribution).toEqual({
			origin: attachment("client-a", 1),
			mixedOrigin: false,
			bindingGeneration: 1,
			mixedBindingGeneration: false,
		});
	});

	// b4-paste-boundary, reached through public StdinBuffer parsing
	it("keeps an interrupted paste one body and reports it as mixed origin", () => {
		const { pastes, sequences } = decodeWithOrigins(tui, [
			{ chunk: "\x1b[200~body-start-", origin: attachment("client-a") },
			{ chunk: "Z", origin: attachment("client-b") },
			{ chunk: "body-end\x1b[201~", origin: attachment("client-a") },
		]);

		expect(sequences).toEqual([]);
		expect(pastes.map((entry) => entry.content)).toEqual(["body-start-Zbody-end"]);
		expect(pastes[0].attribution).toEqual({
			origin: attachment("client-a", 1),
			mixedOrigin: true,
			bindingGeneration: 1,
			mixedBindingGeneration: false,
		});
	});

	// b-precondition: a locally typed sequence still reaches dispatch carrying a provenance record
	it("forwards local stdin sequences with a provenance record and no attachment origin", () => {
		harness = startCapturingTerminal(tui);
		harness.feedStdin("k");

		const typed = harness.delivered.filter((entry) => entry.data === "k");
		expect(typed, "the locally typed key must still reach the input handler").toHaveLength(1);
		expect(
			typed[0].provenance,
			"every delivered sequence carries a provenance record; local stdin simply has no attachment",
		).toMatchObject({
			origin: null,
			mixedOrigin: false,
			bindingGeneration: 0,
			mixedBindingGeneration: false,
		});
		expect(typeof typed[0].provenance.sequenceId).toBe("string");
	});
});

describeCohort(`built pi-tui ${packageVersion} (${manifest.mode})`, () => {
	it("names the artifact it is driving, and the Node runtime running the case", () => {
		const loaded = loadArtifactsManifest();
		expect(loaded.tuiVersion).toBe("0.84.3");
		expect(packageVersion).toBe("0.84.3");
		// P2: attest the test child's own runtime, not only the build's.
		const major = Number(process.version.replace(/^v/, "").split(".")[0]);
		console.log(`native-ingress test child process.version=${process.version}`);
		expect(major, `expected Node 22.x in the test child, got ${process.version}`).toBe(22);
	});

	// b1-same-origin-fragments
	it("carries single-attachment provenance through a fragmented sequence", async () => {
		harness = startCapturingTerminal(tui);
		const a = attachment("client-a", 3);
		await dispatch(harness.terminal, a, "\x1b[");
		await dispatch(harness.terminal, a, "A");

		const arrows = harness.delivered.filter((entry) => entry.data === "\x1b[A");
		expect(
			arrows.length,
			`expected the two fragments to reassemble into one Up sequence; delivered ${JSON.stringify(
				harness.delivered.map((e) => e.data),
			)}`,
		).toBe(1);
		expect(arrows[0].provenance).toMatchObject({ mixedOrigin: false });
		expect(arrows[0].provenance.origin).toEqual(attachment("client-a", 3));
		expect(typeof arrows[0].provenance.sequenceId).toBe("string");
	});

	// b2-mixed-origin-final-byte
	it("attributes an assembled multi-origin sequence to its final byte and marks it mixed", async () => {
		harness = startCapturingTerminal(tui);
		const a = attachment("client-a");
		const b = attachment("client-b");
		await dispatch(harness.terminal, a, "\x1b[");
		await dispatch(harness.terminal, b, "B");
		await dispatch(harness.terminal, a, "D");

		// M0 Task 3 measured this stream as Down then D, never Left. Confirm against the same build.
		const stock = decodeWithStockBuffer(tui, ["\x1b[", "B", "D"]);
		expect(stock.sequences).toEqual(["\x1b[B", "D"]);
		expect(harness.delivered.map((entry) => entry.data)).toEqual(["\x1b[B", "D"]);

		const down = harness.delivered[0];
		expect(down.provenance.origin).toEqual(attachment("client-b", 1));
		expect(down.provenance.mixedOrigin).toBe(true);

		const trailing = harness.delivered[1];
		expect(trailing.provenance.origin).toEqual(attachment("client-a", 1));
		expect(trailing.provenance.mixedOrigin).toBe(false);
	});

	// b3-split-utf8
	it("decodes a codepoint split across two dispatches once, attributed to the final byte", async () => {
		harness = startCapturingTerminal(tui);
		const a = attachment("client-a");
		const euro = Buffer.from("€", "utf8"); // 3 bytes
		await dispatchRaw(harness.terminal, a, new Uint8Array(euro.subarray(0, 2)));
		await dispatchRaw(harness.terminal, a, new Uint8Array(euro.subarray(2)));

		expect(harness.delivered.map((entry) => entry.data).join("")).toBe("€");
		expect(harness.delivered).toHaveLength(1);
		expect(harness.delivered[0].provenance.origin).toEqual(attachment("client-a", 1));
		expect(harness.delivered[0].provenance.mixedOrigin).toBe(false);
	});

	// b3-interleaved-incomplete-codepoint: global byte order must survive an incomplete codepoint
	it("keeps global order and never completes one client's codepoint with another's byte", async () => {
		harness = startCapturingTerminal(tui);
		const a = attachment("client-a");
		const b = attachment("client-b");
		const euro = Buffer.from("\u20ac", "utf8");

		// A starts a 3-byte codepoint, B sends a complete key, then A finishes it.
		await dispatchRaw(harness.terminal, a, new Uint8Array(euro.subarray(0, 2)));
		await dispatch(harness.terminal, b, "x");
		await dispatchRaw(harness.terminal, a, new Uint8Array(euro.subarray(2)));

		const delivered = harness.delivered.map((entry) => entry.data);
		expect(
			delivered,
			"A's truncated character is replaced in place; B's key stays behind it, never in front of it",
		).toEqual(["\ufffd", "x", "\ufffd"]);

		// Each character is attributed to the client that actually sent its bytes, and none is mixed:
		// splicing A's partial codepoint together with B's byte would have made B's own key unable to
		// authorize a return.
		expect(harness.delivered[0].provenance.origin).toEqual(a);
		expect(harness.delivered[0].provenance.mixedOrigin).toBe(false);
		expect(harness.delivered[1].provenance.origin).toEqual(b);
		expect(harness.delivered[1].provenance.mixedOrigin).toBe(false);
		expect(harness.delivered[2].provenance.origin).toEqual(a);
		expect(harness.delivered[2].provenance.mixedOrigin).toBe(false);
	});

	// b3-epoch-transition: incomplete bytes are flushed at an epoch change, never carried into it
	it("flushes incomplete bytes at an epoch change instead of completing them in the new epoch", async () => {
		harness = startCapturingTerminal(tui);
		const euro = Buffer.from("\u20ac", "utf8");
		const first = attachment("client-a", 1);
		const second = attachment("client-a", 2);

		await dispatchRaw(harness.terminal, first, new Uint8Array(euro.subarray(0, 2)));
		await dispatchRaw(harness.terminal, second, new Uint8Array(euro.subarray(2)));

		expect(
			harness.delivered.map((entry) => entry.data),
			"a reconnect is a new epoch, so the old epoch's partial character is replaced, not completed",
		).toEqual(["\ufffd", "\ufffd"]);
		expect(harness.delivered[0].provenance.origin).toEqual(first);
		expect(harness.delivered[0].provenance.mixedOrigin).toBe(false);
		expect(harness.delivered[1].provenance.origin).toEqual(second);
		expect(harness.delivered[1].provenance.mixedOrigin).toBe(false);
	});

	// b6-superseded-epoch: an old epoch admits nothing once a newer one has been seen
	it("admits nothing from a superseded attachment epoch", async () => {
		harness = startCapturingTerminal(tui);
		const current = await dispatch(harness.terminal, attachment("client-super", 5), "n");
		const stale = await dispatch(harness.terminal, attachment("client-super", 4), "OLD");

		expect(current.consumedThrough).toBe(1);
		expect(stale.consumedThrough).toBe(1);
		expect(harness.delivered.map((entry) => entry.data)).toEqual(["n"]);
	});

	// b4-paste-boundary
	it("keeps an interrupted bracketed paste one gesture and marks it mixed origin", async () => {
		harness = startCapturingTerminal(tui);
		const a = attachment("client-a");
		const b = attachment("client-b");
		await dispatch(harness.terminal, a, "\x1b[200~body-start-");
		await dispatch(harness.terminal, b, "Z");
		await dispatch(harness.terminal, a, "body-end\x1b[201~");

		const pastes = harness.delivered.filter((entry) => entry.data.startsWith("\x1b[200~"));
		expect(
			pastes.map((entry) => entry.data),
			"the paste body must stay one gesture even when another attachment typed into it",
		).toEqual(["\x1b[200~body-start-Zbody-end\x1b[201~"]);
		expect(pastes[0].provenance.mixedOrigin).toBe(true);
		expect(pastes[0].provenance.origin).toEqual(attachment("client-a", 1));
	});

	// b5-ordered-consumed-through
	it("resolves dispatches in order with a monotonic consumed-through", async () => {
		harness = startCapturingTerminal(tui);
		const a = attachment("client-a");
		const first = await dispatch(harness.terminal, a, "xy");
		const second = await dispatch(harness.terminal, a, "z");

		expect(first.unavailable, "the built artifact exposes no dispatchNativeInput").toBeUndefined();
		expect(first.consumedThrough).toBe(2);
		expect(second.consumedThrough).toBe(3);
		expect(harness.delivered.map((entry) => entry.data)).toEqual(["x", "y", "z"]);
	});

	// b5-per-dispatch-boundary: an earlier dispatch reports its own boundary, never a later dispatch's
	// bytes that are still queued behind a pending decision.
	it("reports each dispatch's own consumed-through when dispatches overlap", async () => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const { registration } = registerHost({ beforeApplyTerminalResponse: () => gate });
		try {
			harness = startCapturingTerminal(tui);
			const a = attachment("client-a");
			// The first dispatch is a device-attributes reply, so it is still awaiting authorization when
			// the second dispatch is admitted behind it.
			const reply = dispatch(harness.terminal, a, "\x1b[?62;c");
			await new Promise((resolve) => setImmediate(resolve));
			const typed = dispatch(harness.terminal, a, "xy");
			await new Promise((resolve) => setImmediate(resolve));
			release({ apply: false });

			expect((await reply).consumedThrough, "7 bytes were accepted when this dispatch was admitted").toBe(
				7,
			);
			expect((await typed).consumedThrough).toBe(9);
			expect(harness.delivered.map((entry) => entry.data)).toEqual(["x", "y"]);
		} finally {
			registration.release();
		}
	});

	// b7-generation-provenance: provenance names the generation of the bytes, not the terminal's current
	// generation, and a sequence framed across a generation change says so.
	it("attributes a sequence framed across a generation change to its own spans", async () => {
		harness = startCapturingTerminal(tui);
		const a = attachment("client-a", 1);
		await dispatch(harness.terminal, a, "\x1b[13", 1);
		await dispatch(harness.terminal, a, "u", 2);

		const returns = harness.delivered.filter((entry) => entry.data === "\x1b[13u");
		expect(
			returns.length,
			`the two fragments must still reassemble; delivered ${JSON.stringify(
				harness.delivered.map((entry) => entry.data),
			)}`,
		).toBe(1);
		expect(returns[0].provenance.origin).toEqual(a);
		expect(returns[0].provenance.mixedOrigin).toBe(false);
		expect(returns[0].provenance.bindingGeneration).toBe(2);
		expect(
			returns[0].provenance.mixedBindingGeneration,
			"generation-1 bytes framed this sequence, so it cannot be presented as wholly generation 2",
		).toBe(true);
	});

	// b7-single-generation: the ordinary case still reports the generation its bytes arrived on
	it("reports the dispatching generation for a sequence framed in one generation", async () => {
		harness = startCapturingTerminal(tui);
		await dispatch(harness.terminal, attachment("client-a", 1), "\x1b[13u", 5);

		const returns = harness.delivered.filter((entry) => entry.data === "\x1b[13u");
		expect(returns).toHaveLength(1);
		expect(returns[0].provenance.bindingGeneration).toBe(5);
		expect(returns[0].provenance.mixedBindingGeneration).toBe(false);
	});

	// b6-stale-binding
	it("admits nothing on a stale binding generation", async () => {
		harness = startCapturingTerminal(tui);
		const a = attachment("client-a");
		const current = await dispatch(harness.terminal, a, "q", 7);
		const stale = await dispatch(harness.terminal, a, "IGNORED", 6);

		expect(current.consumedThrough).toBe(1);
		expect(stale.consumedThrough).toBe(1);
		expect(harness.delivered.map((entry) => entry.data)).toEqual(["q"]);
	});

	// f2-authorize-before-effect
	it("does not move capability state until the host authorizes a device-attributes reply", async () => {
		let releaseDecision;
		const gate = new Promise((resolve) => {
			releaseDecision = resolve;
		});
		const { calls, registration } = registerHost({
			beforeApplyTerminalResponse: () => gate,
		});
		try {
			harness = startCapturingTerminal(tui);
			const b = attachment("client-b", 2);
			const dispatched = dispatch(harness.terminal, b, "\x1b[?62;c");
			await new Promise((resolve) => setImmediate(resolve));

			expect(
				harness.written.join("").includes("\x1b[>4;2m"),
				"modifyOtherKeys must not be enabled while authorization is still pending",
			).toBe(false);
			expect(calls.responses).toHaveLength(1);
			expect(calls.responses[0].kind).toBe("da");
			expect(calls.responses[0].attachmentEpoch).toEqual(attachment("client-b", 2));
			expect(Buffer.from(calls.responses[0].raw).toString("utf8")).toBe("\x1b[?62;c");

			releaseDecision({ apply: true });
			await dispatched;
			expect(harness.written.join("").includes("\x1b[>4;2m")).toBe(true);
			expect(harness.terminal.modifyOtherKeysActive).toBe(true);
		} finally {
			registration.release();
		}
	});

	// f4-authorization-refused
	it("changes no capability state when the host refuses or throws", async () => {
		const refusing = registerHost({ beforeApplyTerminalResponse: () => Promise.resolve({ apply: false }) });
		try {
			harness = startCapturingTerminal(tui);
			await dispatch(harness.terminal, attachment("client-b", 2), "\x1b[?62;c");
			expect(harness.written.join("").includes("\x1b[>4;2m")).toBe(false);
			expect(harness.terminal.modifyOtherKeysActive).toBe(false);
			expect(harness.terminal.kittyProtocolActive).toBe(false);
			harness.stop();
			harness = undefined;
		} finally {
			refusing.registration.release();
		}

		const throwing = registerHost({
			beforeApplyTerminalResponse: () => Promise.reject(new Error("host failed")),
		});
		try {
			harness = startCapturingTerminal(tui);
			await dispatch(harness.terminal, attachment("client-b", 2), "\x1b[?1u");
			expect(harness.written.join("").includes("\x1b[>4;2m")).toBe(false);
			expect(harness.terminal.kittyProtocolActive).toBe(false);
		} finally {
			throwing.registration.release();
		}
	});

	// f1-reply-looking-paste
	it("does not classify reply-shaped bytes inside a paste body as a reply", async () => {
		const { calls, registration } = registerHost();
		try {
			harness = startCapturingTerminal(tui);
			const a = attachment("client-a");
			await dispatch(harness.terminal, a, "\x1b[200~before-\x1b[?62;c-after\x1b[201~");

			expect(
				calls.responses,
				"paste context must survive: a reply-shaped run inside a paste body is text",
			).toHaveLength(0);
			expect(harness.written.join("").includes("\x1b[>4;2m")).toBe(false);
			const pastes = harness.delivered.filter((entry) => entry.data.startsWith("\x1b[200~"));
			expect(pastes).toHaveLength(1);
			expect(pastes[0].data).toContain("\x1b[?62;c");
		} finally {
			registration.release();
		}
	});

	// f5-split-and-coalesced
	it("classifies a coalesced reply and a reply split across dispatches once each", async () => {
		const { calls, registration } = registerHost();
		try {
			harness = startCapturingTerminal(tui);
			const b = attachment("client-b", 2);
			await dispatch(harness.terminal, b, "\x1b[?62;c");
			expect(calls.responses).toHaveLength(1);

			await dispatch(harness.terminal, b, "\x1b[?62;");
			await dispatch(harness.terminal, b, "c");
			expect(
				calls.responses.length,
				"the split reply must be reassembled and authorized exactly once more",
			).toBe(2);
			expect(calls.responses[1].kind).toBe("da");
			expect(
				Buffer.from(calls.responses[1].raw).toString("utf8"),
				"raw must be the complete classified response, not only the fragment that completed it",
			).toBe("\x1b[?62;c");
		} finally {
			registration.release();
		}
	});

	// f5-split-across-attachments: a reassembled reply carries the origins of all its bytes
	it("authorizes a reply split across two attachments with its combined attribution", async () => {
		const { calls, registration } = registerHost();
		try {
			harness = startCapturingTerminal(tui);
			await dispatch(harness.terminal, attachment("client-a", 1), "\x1b[?62;");
			await dispatch(harness.terminal, attachment("client-b", 7), "c");

			expect(calls.responses).toHaveLength(1);
			expect(Buffer.from(calls.responses[0].raw).toString("utf8")).toBe("\x1b[?62;c");
			expect(
				calls.responses[0].attachmentEpoch,
				"the attachment that completed the reply is the one named",
			).toEqual(attachment("client-b", 7));
		} finally {
			registration.release();
		}
	});

	// f5-500ms-fallback: a widely split reply is text, and it keeps the origin it arrived with
	it("forwards a widely split reply prefix as input with the origin it arrived with", async () => {
		const { calls, registration } = registerHost();
		try {
			harness = startCapturingTerminal(tui);
			const a = attachment("client-a", 4);
			await dispatch(harness.terminal, a, "\x1b[?62;");
			// Nothing completes it. StdinBuffer's own 50 ms sequence timeout emits the partial CSI, the
			// negotiation accumulator holds it as a prefix, and its 150 ms window then gives up. This is
			// M0's wide-split branch, where the printable run reaches the editor as text.
			await new Promise((resolve) => setTimeout(resolve, 400));

			expect(calls.responses, "an incomplete prefix is not a classified response").toHaveLength(0);
			expect(harness.written.join("").includes("\x1b[>4;2m")).toBe(false);
			const flushed = harness.delivered.filter((entry) => entry.data === "\x1b[?62;");
			expect(
				flushed,
				`the prefix must reach the editor as text; delivered ${JSON.stringify(
					harness.delivered.map((entry) => entry.data),
				)}`,
			).toHaveLength(1);
			expect(
				flushed[0].provenance.origin,
				"flushing a held prefix as input must not relabel it as local stdin",
			).toEqual(a);
		} finally {
			registration.release();
		}
	}, 15000);

	// f3-epoch-changed-while-awaiting
	it("applies nothing when the request epoch moves while the host is deciding", async () => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const { calls, registration } = registerHost({ beforeApplyTerminalResponse: () => gate });
		try {
			harness = startCapturingTerminal(tui);
			const dispatched = dispatch(harness.terminal, attachment("client-b", 2), "\x1b[?62;c");
			await new Promise((resolve) => setImmediate(resolve));
			expect(calls.responses).toHaveLength(1);
			expect(calls.responses[0].requestEpoch).toBe(1);

			// Restarting reissues the startup query, so the epoch the host was handed is now stale.
			harness.terminal.stop();
			harness.terminal.start(
				(data, provenance) => harness.delivered.push({ data, provenance }),
				() => {},
			);
			release({ apply: true });
			await dispatched;

			expect(
				harness.terminal.modifyOtherKeysActive,
				"an authorization for a superseded query must change no capability state",
			).toBe(false);
		} finally {
			registration.release();
		}
	});

	// f3-superseded-attachment-while-awaiting
	it("applies nothing when the answering attachment is superseded while the host decides", async () => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const { calls, registration } = registerHost({ beforeApplyTerminalResponse: () => gate });
		try {
			harness = startCapturingTerminal(tui);
			const dispatched = dispatch(harness.terminal, attachment("client-c", 1), "\x1b[?62;c");
			await new Promise((resolve) => setImmediate(resolve));
			expect(calls.responses).toHaveLength(1);

			// The same client reconnects at a newer epoch. The reconnect is deliberately NOT awaited here:
			// awaiting it would serialize it behind the pending decision, and then the only thing that could
			// refuse the response is the 1000 ms bound. Admission has to make the reconnect visible to an
			// authorization that is already awaiting.
			const started = Date.now();
			const reconnected = dispatch(harness.terminal, attachment("client-c", 2), "q");
			await new Promise((resolve) => setImmediate(resolve));
			// The host says yes. The superseded attachment epoch is what refuses it.
			release({ apply: true });
			await dispatched;
			const elapsed = Date.now() - started;

			expect(
				elapsed,
				`the refusal must come from the epoch, not the 1000 ms bound; took ${elapsed}ms`,
			).toBeLessThan(500);
			expect(harness.written.join("").includes("\x1b[>4;2m")).toBe(false);
			expect(harness.terminal.modifyOtherKeysActive).toBe(false);
			await reconnected;
			expect(harness.delivered.map((entry) => entry.data)).toContain("q");
		} finally {
			registration.release();
		}
	});

	// f3-timeout: a never-settling decision is a refusal, and it does not hold the drain open forever
	it("refuses a response whose authorization never settles, and still resolves the dispatch", async () => {
		const { calls, registration } = registerHost({
			beforeApplyTerminalResponse: () => new Promise(() => {}),
		});
		try {
			harness = startCapturingTerminal(tui);
			const started = Date.now();
			const result = await dispatch(harness.terminal, attachment("client-b", 2), "\x1b[?62;c");
			const elapsed = Date.now() - started;

			expect(calls.responses).toHaveLength(1);
			expect(result.consumedThrough).toBe(7);
			expect(elapsed, `the bounded wait must expire and refuse; took ${elapsed}ms`).toBeGreaterThanOrEqual(
				900,
			);
			expect(harness.written.join("").includes("\x1b[>4;2m")).toBe(false);
			expect(harness.terminal.modifyOtherKeysActive).toBe(false);
		} finally {
			registration.release();
		}
	}, 15000);

	// f3-cell-size-bounded-and-revalidated
	it("routes a cell-size report through the same bounded, tracked authorization", async () => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const { calls, registration } = registerHost({ beforeApplyTerminalResponse: () => gate });
		let screen;
		try {
			harness = startCapturingTerminal(tui, { start: false });
			screen = new tui.TuiMainScreen(harness.terminal);
			screen.start();

			const dispatched = dispatch(harness.terminal, attachment("client-b", 3), "\x1b[6;20;10t");
			await new Promise((resolve) => setImmediate(resolve));

			const cellSize = calls.responses.filter((response) => response.kind === "cell-size");
			expect(cellSize, "a cell-size report must be authorized like every other response").toHaveLength(1);
			expect(cellSize[0].attachmentEpoch).toEqual(attachment("client-b", 3));
			expect(Buffer.from(cellSize[0].raw).toString("utf8")).toBe("\x1b[6;20;10t");

			let settled = false;
			void dispatched.then(() => {
				settled = true;
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(
				settled,
				"the dispatch must not resolve while a cell-size authorization is still pending",
			).toBe(false);

			release({ apply: false });
			await dispatched;
		} finally {
			registration.release();
			try {
				screen?.stop();
			} catch {
				// A screen that never started has nothing to stop.
			}
		}
	});

	// f7-profile-launch-fixed
	it("fixes the virtual terminal profile at launch and refuses a replacement", () => {
		// The registry is process-wide and launch-fixed, so the profile in force is whichever one was
		// registered first in this process. That is the property under test.
		const first = registerHost();
		try {
			const fixed = tui.getVirtualTerminalProfile();
			expect(fixed.profileId).toBe("input-lane-profile");
			expect(Object.isFrozen(fixed)).toBe(true);
			expect(() => registerHost({ profile: profile("attaching-client-downgrade") })).toThrow(
				/fixed at launch/,
			);
			expect(tui.getVirtualTerminalProfile().profileId).toBe("input-lane-profile");
		} finally {
			first.registration.release();
		}
		// The profile survives release: a detaching host does not reopen the negotiation.
		expect(tui.getVirtualTerminalProfile().profileId).toBe("input-lane-profile");
		expect(tui.getNativeAttachmentHost()).toBeUndefined();
	});

	// f8-process-wide-registry: the registry is one versioned container per process, reachable by every
	// pi-tui module instance in it, and the internal helpers stay internal.
	it("keeps the registry in one versioned process-wide container and exports no state mutators", () => {
		const first = registerHost();
		try {
			const descriptor = Object.getOwnPropertyDescriptor(
				globalThis,
				Symbol.for("@earendil-works/pi-tui:native-attachment"),
			);
			expect(
				descriptor,
				"a bundled Pi inlines pi-tui, so the registry cannot live in one module instance's scope",
			).toBeDefined();
			expect(descriptor.enumerable).toBe(false);
			expect(descriptor.writable).toBe(false);
			expect(descriptor.value.version).toBe(1);
			expect(descriptor.value.host).toBe(tui.getNativeAttachmentHost());
		} finally {
			first.registration.release();
		}

		// Callers use the exported functions; the epoch high-water mark is not a public mutator.
		expect(tui.noteAttachmentEpoch).toBeUndefined();
		expect(tui.isSupersededAttachmentEpoch).toBeUndefined();
		for (const name of [
			"registerNativeAttachmentHost",
			"getNativeAttachmentHost",
			"getVirtualTerminalProfile",
			"declaresReturnKey",
			"authorizeTerminalResponse",
			"settleTerminalResponseAuthorizations",
		]) {
			expect(typeof tui[name], `${name} must be public seam surface`).toBe("function");
		}
	});

	// u1-unmanaged-compatibility
	it("leaves unmanaged negotiation, typing and paste unchanged with no host registered", async () => {
		expect(tui.getNativeAttachmentHost()).toBeUndefined();
		harness = startCapturingTerminal(tui);
		const a = attachment("client-a");
		await dispatch(harness.terminal, a, "\x1b[?62;c");
		expect(
			harness.written.join("").includes("\x1b[>4;2m"),
			"unmanaged Pi applies the reply immediately, exactly as the pinned baseline does",
		).toBe(true);

		const stock = decodeWithStockBuffer(tui, ["hi\x1b[200~p\x1b[201~"]);
		expect(stock.sequences).toEqual(["h", "i"]);
		expect(stock.pastes).toEqual(["p"]);
	});

	// b-boundary: bytes are Uint8Array in, never a string
	it("accepts only byte spans, so no host-side decoding decision is smuggled in", async () => {
		harness = startCapturingTerminal(tui);
		const result = await dispatchRaw(harness.terminal, attachment("client-a"), bytes("ok"));
		expect(result.consumedThrough).toBe(2);
		expect(harness.delivered.map((entry) => entry.data)).toEqual(["o", "k"]);
	});
});
