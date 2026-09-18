/**
 * Seam C against the built native pipeline: return authorization inside the ordered native input turn.
 *
 * Every case routes a real Enter through the built `TuiMainScreen` dispatch path, after real focus and
 * overlay resolution, so a failure is a statement about where the decision sits — not about a symbol.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attachment,
	dispatch,
	importBuiltTuiIfSelected,
	newAttachmentNamespace,
	startCapturingTerminal,
} from "./fixtures/native-ingress/built-pipeline.mjs";

const { selected, tui, manifest, packageVersion } = await importBuiltTuiIfSelected();
// No cohort selected means the default repository suite is running; these cases need a built artifact.
const describeCohort = selected ? describe : describe.skip;

const RETURN_PROFILE = {
	profileId: "return-lane-profile",
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

/** A component that behaves like a custom editor: it records what it was given. */
function recordingEditor({ declaresReturnKey } = {}) {
	const component = {
		received: [],
		focused: false,
		render() {
			return [""];
		},
		invalidate() {},
		handleInput(data) {
			component.received.push(data);
		},
	};
	if (declaresReturnKey) component.declaresReturnKey = declaresReturnKey;
	return component;
}

let active;

beforeEach(() => {
	newAttachmentNamespace();
});

afterEach(() => {
	active?.registration?.release();
	active?.harness?.stop();
	try {
		active?.screen?.stop();
	} catch {
		// A screen that never started has nothing to stop.
	}
	active = undefined;
});

function mount({ component, authorizeReturn }) {
	expect(typeof tui.registerNativeAttachmentHost).toBe("function");
	const calls = [];
	const registration = tui.registerNativeAttachmentHost({
		profile: RETURN_PROFILE,
		authorizeReturn(request) {
			calls.push(request);
			return authorizeReturn ? authorizeReturn(request) : "native";
		},
		beforeApplyTerminalResponse: () => Promise.resolve({ apply: false }),
	});
	const harness = startCapturingTerminal(tui, { start: false });
	const screen = new tui.TuiMainScreen(harness.terminal);
	screen.addChild(component);
	// The Tui installs the terminal's input handler, so the ordered input turn is the real one.
	screen.start();
	screen.setFocus(component);
	active = { registration, harness, screen, calls };
	return { calls, harness, screen };
}

describeCohort(`built pi-tui ${packageVersion} return authorization (${manifest.mode})`, () => {
	/**
	 * Seam C's precondition, stated with API that exists in both builds: the return key must reach the
	 * focused component through the real ordered input turn, and it must arrive with the provenance a
	 * decision would be made from. Against the unpatched build the Enter is delivered and the provenance
	 * is absent, so there is nothing a host could decide on.
	 */
	it("attests the Node runtime running these cases", () => {
		const major = Number(process.version.replace(/^v/, "").split(".")[0]);
		console.log(`native-return test child process.version=${process.version}`);
		expect(major, `expected Node 22.x in the test child, got ${process.version}`).toBe(22);
	});

	it("delivers Enter through the real input turn to the focused component", () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const harness = startCapturingTerminal(tui, { start: false });
		const screen = new tui.TuiMainScreen(harness.terminal);
		screen.addChild(editor);
		screen.start();
		screen.setFocus(editor);
		active = { harness, screen };

		harness.feedStdin("\r");

		// This guard proves every later case reaches the real focused-component dispatch, not a stub.
		expect(editor.received, "Enter must reach the focused component").toEqual(["\r"]);
	});

	// c1-authorize-in-turn
	it("consults the host synchronously in the input turn for a free return key", async () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const { calls, harness } = mount({ component: editor });

		await dispatch(harness.terminal, attachment("client-a", 4), "\r");

		expect(
			calls.length,
			`authorizeReturn was never consulted although the Enter reached the pipeline; ` +
				`editor received ${JSON.stringify(editor.received)}`,
		).toBe(1);
		expect(calls[0].origin).toEqual(attachment("client-a", 4));
		expect(calls[0].mixedOrigin).toBe(false);
		expect(typeof calls[0].sequenceId).toBe("string");
		expect(calls[0].binding).toEqual({ generation: 1 });
		// 'native' was returned, so the key is still delivered.
		expect(editor.received).toEqual(["\r"]);
	});

	// c2-custom-default-owns
	it("delivers Enter and never asks the host when the component declares nothing", async () => {
		const editor = recordingEditor();
		const { calls, harness } = mount({ component: editor });

		await dispatch(harness.terminal, attachment("client-a"), "\r");

		expect(editor.received).toEqual(["\r"]);
		expect(
			calls,
			"an unknown or custom component owns the key by default; the host is not consulted",
		).toHaveLength(0);
	});

	// c3-mixed-origin-no-return
	it("never lets a mixed-origin return authorize a detach", async () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const { calls, harness } = mount({
			component: editor,
			authorizeReturn: (request) => ({ detachOrigin: request.origin }),
		});

		// Kitty CSI-u Enter assembled from two attachments: the final byte is client-b's.
		await dispatch(harness.terminal, attachment("client-a"), "\x1b[13");
		await dispatch(harness.terminal, attachment("client-b"), "u");

		expect(
			calls,
			"a sequence whose bytes came from more than one attachment can never authorize a return (G-A8)",
		).toHaveLength(0);
		expect(editor.received).toEqual(["\x1b[13u"]);
	});

	// c6-return-across-binding-generations: stale-generation bytes must not take part in a current
	// generation's detach decision, even when native framing assembles them into one key.
	it("never lets a return framed across two binding generations authorize a detach", async () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const { calls, harness } = mount({
			component: editor,
			authorizeReturn: (request) => ({ detachOrigin: request.origin }),
		});

		// One attachment, one epoch: `ESC[13` arrives on generation 1 and `u` completes it on generation 2.
		const a = attachment("client-a", 1);
		await dispatch(harness.terminal, a, "\x1b[13", 1);
		await dispatch(harness.terminal, a, "u", 2);

		expect(
			calls,
			"a return whose framing spans two binding generations can never authorize a detach",
		).toHaveLength(0);
		expect(editor.received, "the key is delivered natively instead").toEqual(["\x1b[13u"]);
	});

	// c6-single-generation-return: the ordinary case still reaches the decision, carrying the generation
	// its own bytes were dispatched under.
	it("carries the dispatching generation into a single-generation return decision", async () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const { calls, harness } = mount({ component: editor });

		await dispatch(harness.terminal, attachment("client-a", 2), "\x1b[13u", 6);

		expect(calls).toHaveLength(1);
		expect(calls[0].binding).toEqual({ generation: 6 });
		expect(calls[0].origin).toEqual(attachment("client-a", 2));
		expect(editor.received).toEqual(["\x1b[13u"]);
	});

	// c5-detach-names-origin
	it("honours a detach decision that names exactly the dispatching attachment epoch", async () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const detached = [];
		const { calls, harness } = mount({
			component: editor,
			authorizeReturn: (request) => {
				detached.push(request.origin);
				return { detachOrigin: request.origin };
			},
		});

		await dispatch(harness.terminal, attachment("client-b", 9), "\r");

		expect(calls).toHaveLength(1);
		expect(detached).toEqual([attachment("client-b", 9)]);
		expect(
			editor.received,
			"the host claimed the key, so the editor must not also receive it",
		).toEqual([]);
	});

	// c5-detach-must-name-the-origin: another attachment's identity must not steal this key
	it("delivers natively when the host names an attachment other than the originating one", async () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const { calls, harness } = mount({
			component: editor,
			authorizeReturn: () => ({ detachOrigin: attachment("someone-else", 1) }),
		});

		await dispatch(harness.terminal, attachment("client-b", 9), "\r");

		expect(calls).toHaveLength(1);
		expect(
			editor.received,
			"one client's keystroke can never be used to detach a different attachment",
		).toEqual(["\r"]);
	});

	// c5-detach-epoch-must-match
	it("delivers natively when the host names the right attachment at the wrong epoch", async () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const { calls, harness } = mount({
			component: editor,
			authorizeReturn: (request) => ({
				detachOrigin: { attachmentId: request.origin.attachmentId, epoch: request.origin.epoch + 1 },
			}),
		});

		await dispatch(harness.terminal, attachment("client-b", 9), "\r");

		expect(calls).toHaveLength(1);
		expect(editor.received, "an epoch mismatch is not this gesture's attachment").toEqual(["\r"]);
	});

	// c-malformed-authorization: anything unrecognised is native delivery, never suppression
	it("delivers natively for malformed, empty or missing authorization results", async () => {
		for (const result of [undefined, null, {}, { detachOrigin: null }, "detach", 42]) {
			const editor = recordingEditor({ declaresReturnKey: () => "free" });
			const { calls, harness } = mount({ component: editor, authorizeReturn: () => result });

			await dispatch(harness.terminal, attachment("client-a", 1), "\r");

			expect(calls).toHaveLength(1);
			expect(
				editor.received,
				`a host returning ${JSON.stringify(result) ?? String(result)} must not suppress the key`,
			).toEqual(["\r"]);
			active.registration.release();
			active.harness.stop();
			active.screen.stop();
			active = undefined;
		}
	});

	// c-throwing-authorization: a failed decision never escapes the input turn or steals the key
	it("delivers natively and does not throw when the host authorization throws", async () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const { calls, harness } = mount({
			component: editor,
			authorizeReturn: () => {
				throw new Error("host authorization failed");
			},
		});

		await expect(dispatch(harness.terminal, attachment("client-a", 1), "\r")).resolves.toBeDefined();

		expect(calls).toHaveLength(1);
		expect(editor.received, "a failed authorization refuses the detach and delivers").toEqual(["\r"]);
	});

	// c4-left-untouched
	it("never routes Left through the return gate", async () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const { calls, harness } = mount({
			component: editor,
			authorizeReturn: () => ({ detachOrigin: attachment("client-a", 1) }),
		});

		await dispatch(harness.terminal, attachment("client-a"), "\x1b[D");

		expect(calls, "Left is not a return key and must never reach the decision").toHaveLength(0);
		expect(editor.received).toEqual(["\x1b[D"]);
	});

	// c1 supporting: focus is resolved before the decision
	it("decides against the focus that the input turn resolved, not an earlier snapshot", async () => {
		const first = recordingEditor({ declaresReturnKey: () => "free" });
		const second = recordingEditor({ declaresReturnKey: () => "owns" });
		const { calls, harness, screen } = mount({ component: first });
		screen.addChild(second);
		screen.setFocus(second);

		await dispatch(harness.terminal, attachment("client-a"), "\r");

		expect(second.received).toEqual(["\r"]);
		expect(first.received).toEqual([]);
		expect(calls, "the newly focused component owns the key, so no decision is asked").toHaveLength(0);
	});

	// u1 supporting: unmanaged return behaviour
	it("delivers Enter unchanged when no host is registered", async () => {
		const editor = recordingEditor({ declaresReturnKey: () => "free" });
		const harness = startCapturingTerminal(tui, { start: false });
		const screen = new tui.TuiMainScreen(harness.terminal);
		screen.addChild(editor);
		screen.start();
		screen.setFocus(editor);
		active = { harness, screen };

		expect(tui.getNativeAttachmentHost()).toBeUndefined();
		await dispatch(harness.terminal, attachment("client-a"), "\r");
		expect(editor.received).toEqual(["\r"]);
	});
});
