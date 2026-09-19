/**
 * A live raw-chunk decoder observer: the installed decoder, fed the exact reads as they arrive.
 *
 * The correction this replaces decoded a completed UTF-8 concatenation and re-sliced it at an artificial
 * stride. That proves the decoder can parse a string; it proves nothing about arriving bytes. This observer is
 * driven from the relay's raw stdout `data` events while the process is still running, so:
 *
 *   - the decoder sees exactly the chunk boundaries the relay produced, never a boundary this file chose;
 *   - every event is stamped with the chunk index it came from, so "the decoder made progress before the
 *     interval completed" is a recorded fact (`begin` came out of an earlier chunk than `end`) rather than an
 *     inference from a finished string;
 *   - `retainedBytes()` is sampled after every chunk, so the bound is observed continuously rather than once.
 *
 * It holds no copy of the interval. Only the decoder's own bounded retention, the carried in-interval bytes a
 * case asked to keep, and fixed-size counters live here.
 */

/**
 * @param {object} tui the installed `@earendil-works/pi-tui` module
 * @param {object} options
 * @param {number} [options.carryLimit] how many in-interval bytes to keep for content assertions, 0 for none
 */
export function liveRawDecoder(tui, { carryLimit = 64 * 1024 } = {}) {
	const decoder = new tui.NativePresentMarkerDecoder();
	const events = [];
	const chunks = [];
	const samples = [];
	let chunkIndex = -1;
	let maxRetained = 0;
	let carried = Buffer.alloc(0);
	let carriedTruncated = false;
	let armedToken;
	const waiters = [];

	const settle = () => {
		for (const waiter of [...waiters]) {
			if (waiter.predicate(state())) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(state());
			}
		}
	};

	/** Everything a case can wait on, recomputed per arriving read. Events alone cannot express "a read arrived". */
	const state = () => ({
		events,
		chunkCount: chunks.length,
		retained: decoder.retainedBytes(),
		maxRetained,
		phase: decoder.phase,
		carried: carried.toString("latin1"),
	});

	return {
		/** Arm before the producer writes BEGIN; the decoder reproduces everything else verbatim anyway. */
		arm(token) {
			armedToken = token;
			decoder.arm(token);
		},
		/** Wire this straight to `spawnPiUnderPty({ onRawStdout })`. */
		onRawStdout(chunk) {
			chunkIndex += 1;
			chunks.push(chunk.length);
			const produced = decoder.decode(chunk);
			for (const event of produced) {
				const stamped = { kind: event.kind, chunkIndex, phase: decoder.phase };
				if (event.kind === "end") {
					stamped.frameId = event.frameId;
					stamped.token = event.token;
				}
				if (event.kind === "begin" || event.kind === "abort") stamped.token = event.token;
				if (event.kind === "refused") stamped.reason = event.reason;
				if (event.kind === "bytes" || event.kind === "refused") stamped.byteLength = event.bytes.length;
				events.push(stamped);
				// Only bytes the decoder reported inside an open interval are content of this frame.
				const inInterval = event.kind === "bytes" && decoder.phase === "open";
				if (inInterval && carryLimit > 0) {
					if (carried.length >= carryLimit) carriedTruncated = true;
					else carried = Buffer.concat([carried, Buffer.from(event.bytes)]).subarray(0, carryLimit);
				}
			}
			maxRetained = Math.max(maxRetained, decoder.retainedBytes());
			samples.push({ chunkIndex, chunkBytes: chunk.length, retained: decoder.retainedBytes(), phase: decoder.phase });
			settle();
		},
		/**
		 * Resolve from an arriving read, never from a timer: this is the deterministic coordination point.
		 *
		 * The predicate is given the decoder's whole observable state, because "a read arrived and the decoder is
		 * holding a partial candidate" is not expressible as an event — a partial marker emits nothing.
		 */
		waitForState(predicate, label, timeoutMs = 45_000) {
			if (predicate(state())) return Promise.resolve(state());
			return new Promise((resolve, reject) => {
				const waiter = { predicate, resolve };
				waiters.push(waiter);
				const timer = setTimeout(() => {
					const index = waiters.indexOf(waiter);
					if (index !== -1) waiters.splice(index, 1);
					const seen = state();
					reject(
						new Error(
							`the live decoder never reached ${label} within ${timeoutMs}ms; chunks ${seen.chunkCount}, ` +
								`retained ${seen.retained}, phase ${seen.phase}, events ` +
								`${JSON.stringify(seen.events.map((event) => event.kind))}`,
						),
					);
				}, timeoutMs);
				waiter.resolve = (value) => {
					clearTimeout(timer);
					resolve(value);
				};
			});
		},
		waitForEvent(predicate, label, timeoutMs) {
			return this.waitForState((seen) => predicate(seen.events), label, timeoutMs);
		},
		waitForKind(kind, label = kind, timeoutMs) {
			return this.waitForEvent((seen) => seen.some((event) => event.kind === kind), label, timeoutMs);
		},
		events: () => events,
		framing: () => events.filter((event) => event.kind !== "bytes").map((event) => event.kind),
		first: (kind) => events.find((event) => event.kind === kind),
		carried: () => carried.toString("latin1"),
		observation: () => ({
			armedToken: armedToken === undefined ? null : `${armedToken.slice(0, 4)}…(43 chars)`,
			chunkCount: chunks.length,
			chunkBytes: chunks,
			maxRetainedBytes: maxRetained,
			decoderMaxRetainedBound: tui.NativePresentMarkerDecoder.MAX_RETAINED_BYTES,
			retentionSamples: samples,
			events,
			carriedBytes: carried.length,
			carriedTruncated,
			layer: "the `script` relay's stdout pipe reads, raw Buffers, in arrival order",
		}),
	};
}

/**
 * One disposable handshake listener, for a fixture that must not guess when the reader has caught up.
 *
 * This is a test coordination channel and nothing else: no production code learns it exists, no protocol frame
 * is invented, and nothing in Pi is asked to flush. A fixture connects, sends one newline-terminated word per
 * step, and waits for the reader's reply before writing the next bytes to the terminal. That is what makes a
 * split marker deterministic instead of a lucky boundary.
 */
export async function fixtureHandshake() {
	const net = await import("node:net");
	const { mkdtemp, rm } = await import("node:fs/promises");
	const path = await import("node:path");
	const directory = await mkdtemp("/tmp/pi-native-handshake-");
	const socketPath = path.join(directory, "h");
	const received = [];
	const waiters = [];
	const queued = [];
	let peer;
	let buffered = "";
	let connected;
	const connection = new Promise((resolve) => {
		connected = resolve;
	});
	const server = net.createServer({ allowHalfOpen: true }, (connection) => {
		peer = connection;
		connection.setEncoding("utf8");
		connection.on("error", () => {});
		// Anything a case released before the fixture connected is delivered now, in order, so a case never has
		// to wait on a connection it cannot observe.
		for (const word of queued.splice(0)) connection.write(`${word}\n`);
		connected();
		connection.on("data", (chunk) => {
			buffered += chunk;
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line) {
					received.push(line);
					for (const waiter of [...waiters]) {
						if (waiter.word === line) {
							waiters.splice(waiters.indexOf(waiter), 1);
							waiter.resolve(line);
						}
					}
				}
				newline = buffered.indexOf("\n");
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return {
		socketPath,
		received,
		/** Resolves when the fixture has connected. Waiting on this is never required, but it is observable. */
		connected: () => connection,
		waitFor(word, timeoutMs = 45_000) {
			if (received.includes(word)) return Promise.resolve(word);
			return new Promise((resolve, reject) => {
				const waiter = { word, resolve };
				waiters.push(waiter);
				const timer = setTimeout(() => {
					const index = waiters.indexOf(waiter);
					if (index !== -1) waiters.splice(index, 1);
					reject(new Error(`the fixture never sent "${word}" within ${timeoutMs}ms; got ${JSON.stringify(received)}`));
				}, timeoutMs);
				waiter.resolve = (value) => {
					clearTimeout(timer);
					resolve(value);
				};
			});
		},
		/** Release the fixture's next step. The fixture is blocked on this line, so nothing races. */
		release(word) {
			if (!peer) {
				queued.push(word);
				return;
			}
			peer.write(`${word}\n`);
		},
		async close() {
			peer?.destroy();
			await new Promise((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}
