/**
 * A deterministic ordered-interval producer, run under the same real pseudo-terminal as Pi.
 *
 * Why this exists. Pi's own `presentNow` runs the whole armed interval in **one synchronous call**, so nothing
 * in that process can write between BEGIN and END, and no reader can ask for a split at a chosen byte. That
 * makes two properties the design requires unobservable against the renderer alone: a marker actually split
 * across a real received read boundary, and out-of-band bytes actually landing inside the interval. Waiting for
 * a lucky boundary is not a proof, and a sleep is not coordination.
 *
 * So this fixture is the producer for those two properties. It is not a second implementation of anything: the
 * markers are encoded by the **installed cohort's own codec**, the bytes go through the same real PTY the
 * renderer writes to, and the reader is the same installed decoder. What it adds is control:
 *
 *   - every marker is written in two `process.stdout.write` calls, and the second half is written only after
 *     the reader confirms over the handshake socket that it received the first. The split is therefore caused
 *     by a confirmed reader gap, not by luck.
 *   - the in-interval sentinel is written by a **child process** that inherits this PTY, so those bytes come
 *     from outside any `Terminal.write` body, and it too is released and confirmed step by step.
 *
 * Nothing here reads a Pi private field, parses a VT stream or invents a production flush callback. The
 * handshake is a disposable test channel; Pi is not told it exists.
 *
 * Inputs: `PI_ORDERED_PROBE_HANDSHAKE` (unix socket path), `PI_ORDERED_PROBE_TUI` (installed pi-tui root),
 * `PI_ORDERED_PROBE_FRAME_ID` (the 36-character id to put in END), `PI_ORDERED_PROBE_MARKER` (the 43-character
 * armed token; deliberately not named `*_TOKEN`, because the suites' own credential scrubber strips that suffix
 * out of every child environment).
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const handshakePath = process.env.PI_ORDERED_PROBE_HANDSHAKE;
const tuiRoot = process.env.PI_ORDERED_PROBE_TUI;
const frameId = process.env.PI_ORDERED_PROBE_FRAME_ID;
const token = process.env.PI_ORDERED_PROBE_MARKER;
if (!handshakePath || !tuiRoot || !frameId || !token) {
	throw new Error("PI_ORDERED_PROBE_{HANDSHAKE,TUI,FRAME_ID,MARKER} are all required");
}

const require = createRequire(path.join(tuiRoot, "package.json"));
const tui = await import(`file://${require.resolve(tuiRoot)}`);

/** The in-interval sentinel, written by a child that inherits this PTY. Fixed text, so order is checkable. */
export const SENTINEL_LINES = ["<<sentinel-1>>", "<<sentinel-2>>", "<<sentinel-3>>"];

const handshake = net.connect(handshakePath);
handshake.setEncoding("utf8");
await new Promise((resolve, reject) => {
	handshake.once("connect", resolve);
	handshake.once("error", reject);
});

let buffered = "";
const releases = [];
const waiters = [];
handshake.on("data", (chunk) => {
	buffered += chunk;
	let newline = buffered.indexOf("\n");
	while (newline !== -1) {
		const line = buffered.slice(0, newline).trim();
		buffered = buffered.slice(newline + 1);
		if (line) {
			releases.push(line);
			for (const waiter of [...waiters]) {
				if (waiter.word === line) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve();
				}
			}
		}
		newline = buffered.indexOf("\n");
	}
});

/** Block until the reader releases this step. No timer, no sleep: the reader decides when it has the bytes. */
function awaitRelease(word) {
	if (releases.includes(word)) return Promise.resolve();
	return new Promise((resolve) => waiters.push({ word, resolve }));
}

function tell(word) {
	handshake.write(`${word}\n`);
}

/** One `write`, drained before the next step, so a step boundary is a real boundary in this process too. */
function emit(text) {
	return new Promise((resolve) => {
		if (process.stdout.write(text)) resolve();
		else process.stdout.once("drain", resolve);
	});
}

/**
 * Write one marker in two halves with a confirmed reader gap between them.
 *
 * `at` is chosen inside the marker's own body, so the first half cannot be mistaken for a complete marker and
 * the decoder has to hold a partial candidate across a real read boundary.
 */
async function emitSplitMarker(name, marker, at) {
	await emit(marker.slice(0, at));
	tell(`${name}-first-half`);
	await awaitRelease(`${name}-second-half`);
	await emit(marker.slice(at));
	tell(`${name}-complete`);
}

const begin = tui.encodeNativePresentBegin(token);
const end = tui.encodeNativePresentEnd(token, frameId);

// A child that inherits this PTY. Its stdout is the same terminal, so its bytes are out-of-band for the
// interval: nothing in a `Terminal.write` body produced them.
const sentinelChild = spawn(
	process.execPath,
	[
		"-e",
		"let index = 0;" +
			"process.stdin.setEncoding('utf8');" +
			"let held = '';" +
			"process.stdin.on('data', (chunk) => {" +
			"  held += chunk;" +
			"  let newline = held.indexOf('\\n');" +
			"  while (newline !== -1) {" +
			"    const line = held.slice(0, newline).trim();" +
			"    held = held.slice(newline + 1);" +
			"    if (line === 'quit') process.exit(0);" +
			"    if (line) { index += 1; process.stdout.write(line); }" +
			"    newline = held.indexOf('\\n');" +
			"  }" +
			"});",
	],
	{ stdio: ["pipe", "inherit", "inherit"] },
);

await awaitRelease("start");

// BEGIN, split across a confirmed reader gap.
await emitSplitMarker("begin", begin, 24);

// Interval content, in labelled pieces so the reader can prove decoder progress before the interval completes.
await emit("[payload-a]");
tell("payload-a");
await awaitRelease("sentinel-1");

// The in-interval, out-of-band sentinel: a different process writing to the same PTY, one line per release.
for (const [index, line] of SENTINEL_LINES.entries()) {
	sentinelChild.stdin.write(`${line}\n`);
	tell(`sentinel-${index + 1}-written`);
	await awaitRelease(`sentinel-${index + 1}-seen`);
}

await emit("[payload-b]");
tell("payload-b");
await awaitRelease("end");

// END, split the same way.
await emitSplitMarker("end", end, 30);

sentinelChild.stdin.write("quit\n");
tell("done");
await awaitRelease("exit");
handshake.end();
process.exit(0);
