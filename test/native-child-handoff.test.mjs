/**
 * Seam G against the built native pipeline: the ordered drain and the recognized external-editor bracket.
 *
 * Every case drives the built cohort's public API — real bytes through the built `ProcessTerminal`, the real
 * registration path, and the real bracket from the built coding-agent package — so a failure here states
 * something about behavior rather than about a symbol's existence.
 *
 * What these cases do not claim: gate 5. Arbitrary or unannounced children, same-process-group children,
 * late attachment to a non-redrawing child, and actual Kitty visual parity are all still unproved, and a
 * synchronous phase listener returning is never evidence that an out-of-process host changed its route.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attachment,
	bytes,
	dispatch,
	newAttachmentNamespace,
	startCapturingTerminal,
} from "./fixtures/native-ingress/built-pipeline.mjs";
import {
	deferred,
	drainableTerminalDouble,
	importBuiltHandoffIfSelected,
	recordingSite,
	retainingSender,
} from "./fixtures/native-child-handoff/built-handoff.mjs";

const { selected, tui, codingAgent, manifest } = await importBuiltHandoffIfSelected();
// No cohort selected means the default repository suite is running; these cases need a built artifact.
const describeCohort = selected ? describe : describe.skip;

/** One profile for the whole file: the launch profile is fixed by the first registration in this process. */
const PROFILE = {
	profileId: "child-handoff-lane-profile",
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

let registration;
let unsubscribes = [];
let harness;

function registerHost({ optIn = { version: 1 }, beforeApplyTerminalResponse } = {}) {
	const host = {
		profile: PROFILE,
		authorizeReturn: () => "native",
		beforeApplyTerminalResponse: beforeApplyTerminalResponse ?? (async () => ({ apply: true })),
	};
	// `null` is a host that declares no opt-in at all, which is every host built before seam G.
	if (optIn !== null) host.childTerminalHandoff = optIn;
	registration = tui.registerNativeAttachmentHost(host);
	return host;
}

function recordPhases() {
	const phases = [];
	unsubscribes.push(tui.onChildTerminalPhase((phase) => phases.push(phase)));
	return phases;
}

/** Restart the real terminal the way `TUI.start()` does, keeping the case's capture of forwarded input. */
function restartCapture() {
	harness.terminal.start((data, provenance) => harness.delivered.push({ data, provenance }), () => {});
}

beforeEach(() => {
	newAttachmentNamespace();
});

afterEach(() => {
	for (const unsubscribe of unsubscribes) unsubscribe();
	unsubscribes = [];
	registration?.release();
	registration = undefined;
	harness?.stop();
	harness = undefined;
});

describeCohort(`seam G child handoff against the ${manifest.mode} cohort`, () => {
	it("registers the versioned opt-in explicitly: an existing B/C/F host is not opted in", () => {
		registerHost({ optIn: null });
		expect(tui.isChildTerminalHandoffActive()).toBe(false);
		registration.release();

		registerHost({ optIn: { version: tui.SUPPORTED_CHILD_TERMINAL_HANDOFF_VERSION } });
		expect(tui.isChildTerminalHandoffActive()).toBe(true);
		registration.release();
		expect(tui.isChildTerminalHandoffActive()).toBe(false);
	});

	it("refuses a handoff version it does not speak, and leaves the registry alone", () => {
		const existing = registerHost({ optIn: null });
		expect(() =>
			tui.registerNativeAttachmentHost({
				profile: PROFILE,
				authorizeReturn: () => "native",
				beforeApplyTerminalResponse: async () => ({ apply: true }),
				childTerminalHandoff: { version: 99 },
			}),
		).toThrow(/version 99.*speaks version 1/s);
		expect(tui.getNativeAttachmentHost()).toBe(existing);
		expect(tui.isChildTerminalHandoffActive()).toBe(false);
	});

	it("closes admission at one barrier: bytes dispatched before it are counted, bytes after are not", async () => {
		registerHost();
		harness = startCapturingTerminal(tui);
		const client = attachment("client-a");

		expect(await dispatch(harness.terminal, client, "a")).toEqual({ admitted: true, consumedThrough: 1 });
		const lease = await harness.terminal.drainNativeInput();
		expect(lease.drainedThrough).toBe(1);

		const rejected = await dispatch(harness.terminal, client, "b");
		expect(rejected).toEqual({ admitted: false, consumedThrough: 1, reason: "handoff-closed" });
		expect(harness.delivered.map((entry) => entry.data)).toEqual(["a"]);

		lease.reopen();
		expect(await dispatch(harness.terminal, client, "c")).toEqual({ admitted: true, consumedThrough: 2 });
		expect(harness.delivered.map((entry) => entry.data)).toEqual(["a", "c"]);
	});

	it("counts admitted labelled bytes only, per dispatch, and never a flush or local stdin", async () => {
		registerHost();
		harness = startCapturingTerminal(tui);
		const client = attachment("client-a");
		const other = attachment("client-b");

		harness.feedStdin("x");
		const first = dispatch(harness.terminal, client, "yz");
		const second = dispatch(harness.terminal, other, "w");
		expect(await first).toEqual({ admitted: true, consumedThrough: 2 });
		expect(await second).toEqual({ admitted: true, consumedThrough: 3 });

		const stale = await harness.terminal.dispatchNativeInput({
			attachmentEpoch: other,
			bytes: bytes("q"),
			binding: { generation: 0 },
		});
		expect(stale).toEqual({ admitted: false, consumedThrough: 3, reason: "stale-binding" });

		const superseded = await dispatch(harness.terminal, { ...other, epoch: other.epoch - 1 }, "q");
		expect(superseded).toEqual({ admitted: false, consumedThrough: 3, reason: "superseded-attachment" });

		// The drain flushes the holds and counts none of it: `drainedThrough` is the barrier snapshot.
		const lease = await harness.terminal.drainNativeInput();
		expect(lease.drainedThrough).toBe(3);
		lease.reopen();
	});

	it("forces the incomplete UTF-8 hold instead of waiting for the rest of the codepoint", async () => {
		registerHost();
		harness = startCapturingTerminal(tui);
		const client = attachment("client-a");

		await dispatch(harness.terminal, client, new Uint8Array([0xe2, 0x9c]));
		expect(harness.delivered).toEqual([]);

		const lease = await harness.terminal.drainNativeInput();
		// The truncated character is replaced, attributed to the client that actually sent it, and not dropped
		// or silently completed by somebody else's byte.
		expect(harness.delivered.map((entry) => entry.data).join("")).toContain("\ufffd");
		expect(harness.delivered[0].provenance.origin).toEqual(client);
		lease.reopen();
	});

	it("forces the sequence hold and then the response fragment hold it populates", async () => {
		registerHost();
		harness = startCapturingTerminal(tui);
		const client = attachment("client-a");

		// StdinBuffer holds this for 50 ms as an incomplete sequence; once released it classifies as a split
		// response prefix, which the terminal then holds for 150 ms. Both windows are forced, in that order.
		await dispatch(harness.terminal, client, "\x1b[?5");
		expect(harness.delivered).toEqual([]);

		const startedAt = Date.now();
		const lease = await harness.terminal.drainNativeInput();
		const elapsed = Date.now() - startedAt;

		// Delivered as ordinary input by the time the drain resolved: the fragment hold cannot have been waited
		// out, and had it been forced before the sequence hold it would still be holding this prefix.
		expect(harness.delivered.map((entry) => entry.data)).toEqual(["\x1b[?5"]);
		expect(harness.delivered[0].provenance).toMatchObject({ origin: client, bindingGeneration: 1 });
		expect(elapsed).toBeLessThan(150);
		lease.reopen();
	});

	it("resolves only after a pending response authorization settles", async () => {
		const decision = deferred();
		registerHost({ beforeApplyTerminalResponse: () => decision.promise });
		harness = startCapturingTerminal(tui);
		const client = attachment("client-a");

		const dispatched = dispatch(harness.terminal, client, "\x1b[?5u");
		const drain = harness.terminal.drainNativeInput();
		let resolved = false;
		void drain.then(() => {
			resolved = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(resolved).toBe(false);

		decision.settle({ apply: true });
		const lease = await drain;
		await dispatched;
		expect(resolved).toBe(true);
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		lease.reopen();
	});

	it("does not deadlock when the drain is started by the key currently being dispatched", async () => {
		registerHost();
		const drains = [];
		harness = startCapturingTerminal(tui, { start: false });
		harness.terminal.start(
			(data) => {
				// Exactly what a key handler does: it starts the child entry and returns, void, at once.
				if (data === "e") drains.push(harness.terminal.drainNativeInput());
			},
			() => {},
		);

		const dispatched = await dispatch(harness.terminal, attachment("client-a"), "e");
		expect(dispatched).toEqual({ admitted: true, consumedThrough: 1 });
		expect(drains).toHaveLength(1);
		const lease = await Promise.race([
			drains[0],
			new Promise((_, reject) => setTimeout(() => reject(new Error("the drain never resolved")), 2000)),
		]);
		expect(lease.drainedThrough).toBe(1);
		lease.reopen();
	});

	it("leases the closed gate: one active drain, and only that lease reopens it", async () => {
		registerHost();
		harness = startCapturingTerminal(tui);
		const client = attachment("client-a");

		const lease = await harness.terminal.drainNativeInput();
		await expect(harness.terminal.drainNativeInput()).rejects.toMatchObject({
			code: "NATIVE_INPUT_DRAIN_ACTIVE",
		});
		expect((await dispatch(harness.terminal, client, "a")).reason).toBe("handoff-closed");

		lease.reopen();
		lease.reopen(); // idempotent
		expect((await dispatch(harness.terminal, client, "a")).admitted).toBe(true);

		const second = await harness.terminal.drainNativeInput();
		lease.reopen(); // stale: it must not reopen the gate the second drain closed
		expect((await dispatch(harness.terminal, client, "b")).reason).toBe("handoff-closed");
		second.reopen();
	});

	it("refuses to drain a terminal that was never started", async () => {
		registerHost();
		const terminal = new tui.ProcessTerminal();
		await expect(terminal.drainNativeInput()).rejects.toMatchObject({ code: "NATIVE_INPUT_NOT_STARTED" });
	});

	it("brackets the recognized external editor with one entering/left pair around the real drain", async () => {
		registerHost();
		const phases = recordPhases();
		harness = startCapturingTerminal(tui);
		const client = attachment("client-a");
		await dispatch(harness.terminal, client, "a");

		const duringChild = [];
		const { site, order, applied, editorText } = recordingSite({
			terminal: harness.terminal,
			// The renderer operations Pi really performs: `TUI.stop()` stops this terminal and `TUI.start()`
			// builds it a new `StdinBuffer`, so the child sees the production state and not a recorded string.
			onStop: () => harness.terminal.stop(),
			onRestore: () => restartCapture(),
			child: async () => {
				// The stop really happened: local stdin reaches nothing while the child owns the terminal.
				harness.feedStdin("z");
				duringChild.push(await dispatch(harness.terminal, client, "b"));
				return { status: "complete", content: "edited" };
			},
		});
		const report = await codingAgent.bracketRecognizedChildTerminal(site);

		expect(report).toMatchObject({ entered: true, managed: true, outcome: "returned" });
		expect(order).toEqual(["release", "stop", "child", "applyResult", "restore", "reclaim"]);
		expect(applied).toEqual([{ status: "complete", content: "edited" }]);
		expect(editorText).toEqual(["edited"]);
		expect(duringChild[0]).toEqual({ admitted: false, consumedThrough: 1, reason: "handoff-closed" });
		expect(phases).toEqual([
			{ phase: "entering", childPhaseId: report.childPhaseId, reason: "external-editor", drainedThrough: 1 },
			{ phase: "left", childPhaseId: report.childPhaseId, reason: "external-editor", outcome: "returned" },
		]);
		// Admission reopened last, so the host may dispatch again, and nothing the child's window refused or
		// local stdin produced entered Pi.
		expect((await dispatch(harness.terminal, client, "c")).admitted).toBe(true);
		expect(harness.delivered.map((entry) => entry.data)).toEqual(["a", "c"]);
	});

	it("announces a resolved editor failure as failed and applies none of its content", async () => {
		registerHost();
		const phases = recordPhases();
		harness = startCapturingTerminal(tui);
		const client = attachment("client-a");
		await dispatch(harness.terminal, client, "a");

		// `editInExternalEditor` *resolves* this for a spawn error, a signal and a nonzero exit alike: it does
		// not reject, so a bracket that called every resolved child a return would announce all three wrongly.
		const { site, order, applied, editorText } = recordingSite({
			terminal: harness.terminal,
			onStop: () => harness.terminal.stop(),
			onRestore: () => restartCapture(),
			child: async () => ({ status: "failed" }),
		});
		const report = await codingAgent.bracketRecognizedChildTerminal(site);

		expect(report).toMatchObject({ entered: true, managed: true, outcome: "failed" });
		expect(order).toEqual(["release", "stop", "child", "applyResult", "restore", "reclaim"]);
		expect(applied).toEqual([{ status: "failed" }]);
		expect(editorText).toEqual([]);
		expect(phases.map((phase) => [phase.phase, phase.outcome])).toEqual([
			["entering", undefined],
			["left", "failed"],
		]);
		expect((await dispatch(harness.terminal, client, "c")).admitted).toBe(true);
	});

	it("answers the closed gate while the real child owns the stopped terminal, and the sender keeps its bytes", async () => {
		registerHost();
		harness = startCapturingTerminal(tui);
		const client = attachment("client-a");
		await dispatch(harness.terminal, client, "a");

		const sender = retainingSender({ terminal: harness.terminal, origin: client });
		/** The child's own input route. Only the host writes here, and only what Pi refused. */
		const childRoute = [];
		let observedInsideChild;
		let observedAfterReopen;
		let duplicateDrain;
		const { site } = recordingSite({
			terminal: harness.terminal,
			onStop: () => harness.terminal.stop(),
			onRestore: () => restartCapture(),
			child: async () => {
				observedInsideChild = await sender.send("b");
				// Dispatched now, observed only after the bracket reopened admission: a host that reads its own
				// verdicts late must still be told these bytes never entered Pi.
				observedAfterReopen = sender.send("d");
				duplicateDrain = await harness.terminal.drainNativeInput().then(
					() => "a second drain resolved",
					(error) => error,
				);
				return { status: "complete", content: "edited" };
			},
		});
		const report = await codingAgent.bracketRecognizedChildTerminal(site);

		expect(report).toMatchObject({ entered: true, managed: true, outcome: "returned" });
		expect(observedInsideChild).toEqual({ admitted: false, consumedThrough: 1, reason: "handoff-closed" });
		// The stopped terminal is a closed gate, not an unstarted one: the drain code stays the drain code.
		expect(duplicateDrain).toMatchObject({ code: "NATIVE_INPUT_DRAIN_ACTIVE" });
		expect(await observedAfterReopen).toEqual({ admitted: false, consumedThrough: 1, reason: "handoff-closed" });

		// Refused bytes reached no Pi queue and no counter, and the host delivers each exactly once to the
		// child's own route: a second delivery attempt has nothing left to send.
		sender.deliverRetainedTo(childRoute);
		sender.deliverRetainedTo(childRoute);
		expect(childRoute).toEqual(["b", "d"]);
		expect(sender.retained).toEqual([]);
		expect(await dispatch(harness.terminal, client, "c")).toEqual({ admitted: true, consumedThrough: 2 });
		expect(harness.delivered.map((entry) => entry.data)).toEqual(["a", "c"]);
	});

	it("reports failed and reopens admission when the child rejects or restoration throws", async () => {
		registerHost();
		const phases = recordPhases();
		const order = [];
		const double = drainableTerminalDouble(order);

		const rejecting = recordingSite({
			terminal: double.terminal,
			child: async () => {
				throw new Error("editor failed");
			},
		});
		await expect(codingAgent.bracketRecognizedChildTerminal(rejecting.site)).rejects.toThrow("editor failed");
		expect(rejecting.order).toEqual(["release", "stop", "child", "restore", "reclaim"]);
		expect(phases.map((phase) => [phase.phase, phase.outcome])).toEqual([
			["entering", undefined],
			["left", "failed"],
		]);
		expect(double.admission).toBe("open");

		phases.length = 0;
		const failingRestore = recordingSite({ terminal: double.terminal, restoreThrows: true });
		await expect(codingAgent.bracketRecognizedChildTerminal(failingRestore.site)).rejects.toThrow(
			"restore failed",
		);
		// A return Pi could not restore itself from is never advertised as a clean return.
		expect(phases.map((phase) => [phase.phase, phase.outcome])).toEqual([
			["entering", undefined],
			["left", "failed"],
		]);
		expect(double.admission).toBe("open");
	});

	it("survives a throwing listener and refuses a duplicate entry", async () => {
		registerHost();
		const seen = [];
		unsubscribes.push(
			tui.onChildTerminalPhase(() => {
				throw new Error("listener failed");
			}),
		);
		unsubscribes.push(tui.onChildTerminalPhase((phase) => seen.push(phase.phase)));
		const order = [];
		const double = drainableTerminalDouble(order);

		const first = recordingSite({ terminal: double.terminal });
		const report = await codingAgent.bracketRecognizedChildTerminal(first.site);
		expect(report).toMatchObject({ entered: true, managed: true, drainedThrough: 7 });
		expect(seen).toEqual(["entering", "left"]);
		expect(first.order).toEqual(["release", "stop", "child", "applyResult", "restore", "reclaim"]);
		expect(order).toEqual(["drain", "reopen"]);

		seen.length = 0;
		const duplicate = recordingSite({ terminal: double.terminal, released: true });
		expect(await codingAgent.bracketRecognizedChildTerminal(duplicate.site)).toEqual({
			entered: false,
			refusal: "already-released",
		});
		expect(duplicate.order).toEqual([]);
		expect(seen).toEqual([]);
	});

	it("keeps Pi's pinned external-editor path with no host and with a host that never opted in", async () => {
		const phases = recordPhases();
		for (const optIn of [null, "no-host"]) {
			if (optIn !== "no-host") registerHost({ optIn });
			const order = [];
			const double = drainableTerminalDouble(order);
			const { site, order: siteOrder, applied } = recordingSite({ terminal: double.terminal });
			expect(await codingAgent.bracketRecognizedChildTerminal(site)).toEqual({ entered: true, managed: false });
			expect(site.isReleased()).toBe(false);
			// Pi's pinned order, reclaim before restore, with no drain, no lease and no announcement.
			expect(siteOrder).toEqual(["release", "stop", "child", "applyResult", "reclaim", "restore"]);
			expect(order).toEqual([]);
			expect(applied).toEqual([{ status: "complete", content: "edited" }]);
			registration?.release();
			registration = undefined;
		}
		expect(phases).toEqual([]);
	});
});
