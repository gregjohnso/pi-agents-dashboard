import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReadStream } from "node:tty";

import { afterEach, expect, it } from "vitest";

import { MISSING_HOST_CAPABILITIES, createPtyHost } from "../runtime/pty-host.mjs";
import { openOwnerPty } from "../runtime/pty-mechanism.mjs";
import { createLaunchFixedProfile } from "../runtime/terminal-profile.mjs";
import { acceptedMarkerApi } from "./fixtures/native-host/consumer-doubles.mjs";
import { attachedClient, bootstrapListener, disposablePiRoot, ownerLaunch, recordFixtureNote, relayedInputTargetRegistry, waitForLogRecord } from "./fixtures/native-host/real-pi-owner.mjs";
import { openProcessLedger, reapProcessLedger, recordProcess, reportReapResults } from "./process-ledger.mjs";

/**
 * Two attachments with different declared capabilities and sizes on one real owner pseudo-terminal.
 *
 * The owner here is a shell, not Pi. That is deliberate and it is a stated limit: everything these cases
 * assert — one shared winsize a real child reads, one ordered byte stream both clients receive whole, a
 * refusal that names the capability a client is missing, an owner that outlives an empty attachment set, and
 * the corrected exit cause — is true of any child on a real pts and needs no agent. The rows that need Pi
 * itself, its rendering and its labelled ingress, are the rows this host cannot reach yet: the last case
 * asserts the host reports those capabilities as missing instead of claiming them.
 */

const LEDGER_LABEL = "heterogeneous-clients";
const OWNER_ENV = { PATH: "/usr/bin:/bin", TERM: "xterm-256color" };
const START = { cols: 100, rows: 30 };
const RESIZED = { cols: 120, rows: 40 };
const CAPABILITIES = { kittyKeyboard: true, kittyGraphics: true, mouse: true, bracketedPaste: true, synchronizedOutput: true, trueColor: true };
/** The launch-fixed profile. Both clients meet it; neither can change it. */
const PROFILE = createLaunchFixedProfile({ profileId: "task12-acceptance", term: "xterm-256color", capabilities: CAPABILITIES, cellSize: null });
/** One line of `stty size`, a newline to unblock the read, then a second report and a normal exit code. */
const OWNER_SCRIPT = "stty size; printf 'READY\\n'; read first; stty size; printf 'DONE\\n'; exit 7";

/** @type {string | undefined} */
let ledgerPath;
/** @type {(() => void)[]} */
let releases = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  if (ledgerPath === undefined) return;
  reportReapResults(await reapProcessLedger(ledgerPath), console.error);
  await rm(ledgerPath, { force: true });
  ledgerPath = undefined;
});

/** One recording client, with the sink surface the attachment set and the host write to. */
function client() {
  /** @type {Buffer[]} */
  const chunks = [];
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    sink: {
      /** @param {Uint8Array} payload */
      write(payload) {
        chunks.push(Buffer.from(payload));
      },
      queuedBytes: () => 0,
      onDrain: () => {},
    },
  };
}

/** Open one real owner on a real pts, relay its output into the host, and record it for reaping. */
async function openHost() {
  const handle = await openOwnerPty({ command: "/bin/sh", args: ["-c", OWNER_SCRIPT], env: OWNER_ENV, cwd: tmpdir(), cols: START.cols, rows: START.rows });
  // Recorded before anything is asserted: a case that times out never reaches its own teardown.
  ledgerPath ??= await openProcessLedger({ label: LEDGER_LABEL });
  await recordProcess(ledgerPath, `${LEDGER_LABEL} owner shell`, handle.owner);
  const host = createPtyHost({ owner: handle, profile: PROFILE, queuedByteCap: 1024 * 1024, cols: START.cols, rows: START.rows });
  // The stream owns the master descriptor's lifetime from here, which is why the host never closes it.
  const output = new ReadStream(handle.masterFd);
  output.on("error", () => {});
  output.on("data", (chunk) => host.broadcastOwnerOutput(new Uint8Array(Buffer.from(chunk))));
  releases.push(() => output.destroy());
  return { handle, host };
}

/** @param {() => string} read @param {string} marker */
function waitFor(read, marker) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = setInterval(() => {
      if (read().includes(marker)) {
        clearInterval(poll);
        resolve(read());
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`the owner never wrote ${JSON.stringify(marker)}; it wrote ${JSON.stringify(read())}`));
      }
    }, 20);
  });
}

it("gives two differently declared clients one geometry a real child reads, and one ordered byte stream neither corrupts", async () => {
  const { handle, host } = await openHost();
  const wide = client();
  const narrow = client();
  // Different declarations and different sizes. The profile is the owner's, so neither client's request
  // changes it and neither is refused for asking.
  const first = host.attach({ attachmentId: "wide", sink: wide.sink, declared: { capabilities: { ...CAPABILITIES }, requestedCols: 200, requestedRows: 60 } });
  const second = host.attach({ attachmentId: "narrow", sink: narrow.sink, declared: { capabilities: { ...CAPABILITIES, synchronizedOutput: true }, requestedCols: 60, requestedRows: 20 } });
  expect([first.attached, second.attached]).toEqual([true, true]);
  expect(host.geometry()).toEqual({ ...START, revision: 1 });

  await waitFor(() => wide.text(), "READY");
  expect(wide.text()).toContain(`${START.rows} ${START.cols}`);

  const resized = host.resize({ cols: RESIZED.cols, rows: RESIZED.rows, from: second.epoch });
  expect(resized).toEqual({ ...RESIZED, revision: 2, changed: true });
  // Unblock the shell's `read`, so its second `stty size` reports what the child itself observes.
  expect(host.writeToOwner(new Uint8Array([0x0a]))).toEqual({ accepted: 1, pending: 0 });
  await waitFor(() => wide.text(), "DONE");

  // One winsize, read by the real child through its own terminal.
  expect(wide.text()).toContain(`${RESIZED.rows} ${RESIZED.cols}`);
  // Both clients hold the same bytes in the same order: the fan-out copies nothing and reorders nothing.
  const initialization = "\u001b[?2004h\u001b[?1002h\u001b[?1006h";
  expect(wide.text().startsWith(initialization)).toBe(true);
  expect(narrow.text().startsWith(initialization)).toBe(true);
  expect(narrow.text().slice(initialization.length)).toBe(wide.text().slice(initialization.length));

  const exit = await handle.wait();
  expect(exit).toMatchObject({ code: 7, signal: null });
  // The geometry the attachments shared is still the host's after both of them leave.
  host.detach(first.epoch, "test");
  host.detach(second.epoch, "test");
  expect(host.attachments()).toEqual([]);
  expect(host.geometry()).toEqual({ ...RESIZED, revision: 2 });
}, 60_000);

it("keeps a real owner alive with nothing attached, refuses an underdeclared client by name, and reads its own exit as native", async () => {
  const { handle, host } = await openHost();
  const refused = host.attach({ attachmentId: "old-frontend", sink: client().sink, declared: { capabilities: { ...CAPABILITIES, kittyGraphics: false, mouse: false } } });
  expect(refused).toEqual({ attached: false, code: "NATIVE_ATTACHMENT_UNAVAILABLE", missingCapabilities: ["kittyGraphics", "mouse"] });
  expect(host.attachments()).toEqual([]);
  expect(host.ownerAttachmentUnavailable()).toBe(true);

  // Nothing is attached and nothing was signalled, so the owner is still there to be typed at.
  const watcher = client();
  const admitted = host.attach({ attachmentId: "watcher", sink: watcher.sink, declared: { capabilities: { ...CAPABILITIES } } });
  expect(admitted.attached).toBe(true);
  await waitFor(() => watcher.text(), "READY");
  expect(host.describeOwnerExit()).toEqual({ exited: false, cause: null, note: "a null cached wait status is not evidence of life" });

  host.writeToOwner(new Uint8Array([0x0a]));
  const exit = await handle.wait();
  expect(exit).toMatchObject({ code: 7, signal: null });
  // Cleanup after the fact: the stop reaps first, so it sends nothing and the exit stays the owner's own.
  const stopped = await host.stopOwner({ signal: "SIGTERM" });
  expect(stopped).toMatchObject({ signalled: false, reason: "already-reaped" });
  expect(host.describeOwnerExit()).toMatchObject({ exited: true, cause: "native-exit", code: 7 });
}, 60_000);

it("reports the capabilities it does not have instead of claiming the rows that need them", async () => {
  const { host } = await openHost();
  const watcher = client();
  const admitted = host.attach({ attachmentId: "watcher", sink: watcher.sink, declared: { capabilities: { ...CAPABILITIES } } });

  // No supported pre-extension dispatch target exists, so labelled input is refused by name rather than
  // written to the master unlabelled.
  expect(await host.deliverInput({ epoch: admitted.epoch, bytes: new Uint8Array([0x78]) })).toEqual({
    delivered: false,
    admitted: null,
    reason: "labelled-ingress-unavailable",
    missingCapability: MISSING_HOST_CAPABILITIES.labelledIngress,
  });
  // No verified delivery boundary exists between a presentation receipt and this host's own reads, so a
  // client's echo of a nonce clears nothing.
  expect(host.acknowledgePresentation(admitted.epoch, "frame-1")).toMatchObject({
    cleared: false,
    missingCapability: MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary,
  });
  expect(host.capabilityReport().missing).toEqual([MISSING_HOST_CAPABILITIES.labelledIngress, MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary]);
  expect(host.capabilityReport().coverageGaps.map((/** @type {any} */ gap) => gap.capability)).toEqual(["osc11-background-colour"]);

  host.writeToOwner(new Uint8Array([0x0a]));
}, 60_000);

// ---------------------------------------------------------------------------------------------------------
// Real Pi, through this host, on a pseudo-terminal this process owns.
//
// The cases above use a shell on purpose and say so. These use the accepted cohort's own bundled CLI: the
// publication, the dispatch, the attachment-host registration, the protocol-2 bootstrap hello, the ordered
// presentation and every decoded byte are Pi's own. What is fixture, and named as fixture, is the transport
// that carries one dispatch call between this process and Pi's — the published registry is process-local, so a
// versioned test relay runs inside Pi and forwards it. That relay is qualification infrastructure and not the
// product transport the integration owner will build.
//
// Proof levels are kept apart deliberately. A draft found in Pi's own rendered output is an observation about
// bytes Pi's renderer produced. It is not a claim about pixels, image protocols or a terminal emulator's
// capabilities, and no case here makes one.
// ---------------------------------------------------------------------------------------------------------

const REAL_PI_PROFILE = {
  profileId: "host-real-pi-qualification",
  term: "xterm-256color",
  capabilities: { ...CAPABILITIES },
  cellSize: { width: 8, height: 16 },
};

/** The accepted cohort, or an unselected marker. Nothing here guesses a path. */
async function selectedCohort() {
  const accepted = await acceptedMarkerApi();
  if (!accepted.selected) return { selected: false };
  const consumerRoot = accepted.manifest.consumerRoot;
  const codingAgentRoot = path.join(consumerRoot, "node_modules/@earendil-works/pi-coding-agent");
  return {
    selected: true,
    markers: accepted.api,
    manifestPath: path.resolve(String(process.env.PI_NATIVE_ARTIFACTS_MANIFEST)),
    cohort: {
      consumerRoot,
      tuiPackageRoot: accepted.manifest.tuiPackageRoot,
      bundledCli: path.join(codingAgentRoot, "dist/bundle/cli.js"),
      codingAgentEntry: `file://${path.join(codingAgentRoot, "dist/index.js")}`,
    },
  };
}

/**
 * One real Pi owner wired to this host, with every transport created before the launch.
 *
 * The master descriptor is read here and handed straight to `broadcastOwnerOutput`, so each decoded chunk is an
 * arriving PTY `Buffer` while Pi is still running: nothing is captured, completed or replayed.
 */
async function openRealPiHost({ markers, cohort, queuedByteCap = 1 << 20, cols = 100, rows = 30 }) {
  const owned = await disposablePiRoot();
  const relay = await relayedInputTargetRegistry(owned.relaySocket);
  const bootstrap = await bootstrapListener(owned.bootstrapSocket);
  const launch = ownerLaunch({ cohort, owned, profile: REAL_PI_PROFILE, cols, rows });
  const handle = await openOwnerPty(launch);
  ledgerPath ??= await openProcessLedger({ label: LEDGER_LABEL });
  await recordProcess(ledgerPath, "host real-pi owner", handle.owner);

  // Observed sequencing requirement of the accepted source, not a defect: `createPtyHost` validates the
  // bootstrap hello once, at construction, so the host is built after Pi has really connected and sent it. Pi
  // connects out during `main()`, before the renderer mounts, and the master's own buffer holds whatever it
  // wrote first — nothing is replayed, the reader simply starts here.
  const hello = await bootstrap.waitFor((frame) => frame.type === "native-bootstrap", "Pi's bootstrap hello");

  const host = createPtyHost({
    owner: handle,
    profile: REAL_PI_PROFILE,
    queuedByteCap,
    cols,
    rows,
    inputTargetRegistry: relay.registry,
    presentation: bootstrap.channel,
    presentMarkers: markers,
  });

  /** Every arriving read, in order, for bounded secondary evidence only: routing never reads this. */
  const reads = [];
  let readBytes = 0;
  const observers = [];
  const output = new ReadStream(handle.masterFd);
  output.on("error", () => {});
  output.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    readBytes += buffer.byteLength;
    if (reads.length < 512) reads.push(buffer.byteLength);
    // The host decodes the arriving bytes; the observers only get told a read happened, so a waiter resolves
    // from a real terminal read rather than from a timer.
    host.broadcastOwnerOutput(new Uint8Array(buffer));
    for (const observer of [...observers]) observer();
  });
  releases.push(() => output.destroy());

  /** Resolve when `check()` holds, re-evaluated on each arriving read. No sleep and no poll. */
  const waitForRead = (check, label, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const settle = () => {
        if (!check()) return;
        const at = observers.indexOf(settle);
        if (at !== -1) observers.splice(at, 1);
        clearTimeout(timer);
        resolve(undefined);
      };
      const timer = setTimeout(() => {
        const at = observers.indexOf(settle);
        if (at !== -1) observers.splice(at, 1);
        reject(new Error(`${label} never happened within ${timeoutMs}ms after ${readBytes} bytes`));
      }, timeoutMs);
      observers.push(settle);
      settle();
    });

  return {
    owned,
    relay,
    bootstrap,
    handle,
    host,
    hello,
    waitForRead,
    readCount: () => reads.length,
    readBytes: () => readBytes,
    async close() {
      output.destroy();
      await bootstrap.close();
      await relay.close();
      await owned.remove();
    },
  };
}

it("dispatches this host's labelled input into a real Pi through its published target while session_start is blocked, and finds the draft in Pi's own rendered output", async () => {
  const selected = await selectedCohort();
  if (!selected.selected) return;
  const running = await openRealPiHost(selected);
  try {
    const draft = `HOST-DRAFT-${process.pid}-7Q4`;
    const watcher = attachedClient();
    const admitted = /** @type {any} */ (running.host.attach({ attachmentId: "watcher", sink: watcher.sink, declared: { capabilities: { ...CAPABILITIES } } }));
    expect(admitted.attached).toBe(true);

    // A real publication from a started ProcessTerminal, relayed with its own facts.
    const published = await running.relay.waitFor((frame) => frame.type === "publication" && frame.hasTarget === true, "a published input target");
    expect(published.apiVersion).toBe(1);
    expect(published.producerVersion).toBe(1);
    expect(published.publication.publicationId).toEqual(expect.any(String));
    expect(running.host.capabilityReport().inputTarget).toMatchObject({ route: "published-registry", available: true, producerVersion: 1, reason: null });
    expect(running.host.capabilityReport().missing).not.toContain(MISSING_HOST_CAPABILITIES.labelledIngress);

    // The blocked startup handler is established BEFORE the host dispatches, from the handler's own record.
    await waitForLogRecord(running.owned.extensionLog, "sessionStartBlocking", "the blocked session_start handler");

    // The host's own call, carrying its own attachment epoch and binding generation, answered by Pi's real
    // dispatchNativeInput.
    const delivered = /** @type {any} */ (await running.host.deliverInput({ epoch: admitted.epoch, bytes: new Uint8Array(Buffer.from(draft, "utf8")), bindingGeneration: 1 }));
    expect(delivered).toMatchObject({ delivered: true, admitted: true });
    expect(delivered.consumedThrough).toBeGreaterThanOrEqual(Buffer.byteLength(draft, "utf8"));
    expect(delivered.publication.publicationId).toBe(published.publication.publicationId);

    // An admission receipt is not a rendered draft. This waits for Pi's own editor output to carry the exact
    // characters, on the bytes this host read off the master.
    await running.waitForRead(() => watcher.text().includes(draft), `the draft ${draft} in Pi's rendered output`);
    expect(watcher.text()).toContain(draft);

    // The blocked handler was real for the whole case, and it never released.
    const extensionLog = await readFile(running.owned.extensionLog, "utf8");
    expect(extensionLog).toContain("providerRegisteredAtLoad");
    expect(extensionLog).toContain("sessionStartBlocking");
    expect(extensionLog).not.toContain("sessionStartReleased");

    // The attachment host was registered before the renderer's startup queries, not from a publication
    // callback, and it declared every capability including images.
    const relayLog = await readFile(running.owned.relayLog, "utf8");
    const registration = relayLog
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === "hostRegistered");
    expect(registration).toMatchObject({ beforeStartup: true, profileId: REAL_PI_PROFILE.profileId, kittyGraphics: true, kittyKeyboard: true, mouse: true });
    console.log(`OBSERVED early-ingress: ${JSON.stringify({ publication: published.publication, consumedThrough: delivered.consumedThrough, draft, draftInRenderedOutput: watcher.text().includes(draft), readBytes: running.readBytes(), registration })}`);
  } finally {
    await running.close();
  }
}, 180_000);

it("arms recovery from a real Pi-rendered ordered presentation and clears it only on the client's own local admission", async () => {
  const selected = await selectedCohort();
  if (!selected.selected) return;
  const markers = selected.markers;
  // A small budget, so Pi's own startup output really carries a stalled client past the cap.
  const running = await openRealPiHost({ ...selected, queuedByteCap: 4096 });
  try {
    const recovering = attachedClient({ stall: true, highWaterMark: 512 });
    const live = attachedClient();
    const target = /** @type {any} */ (running.host.attach({ attachmentId: "recovering", sink: recovering.sink, declared: { capabilities: { ...CAPABILITIES } } }));
    const watcher = /** @type {any} */ (running.host.attach({ attachmentId: "live", sink: live.sink, declared: { capabilities: { ...CAPABILITIES } } }));

    // Pi's real protocol-2 hello, validated by the host before it sends anything.
    const hello = running.hello;
    expect(hello.protocol).toBe(2);
    expect(hello.orderedPresentation).toMatchObject({ version: 1, markerCodec: markers.NATIVE_PRESENT_MARKER_CODEC, maxMarkerBytes: 128, freshChunkMax: 16384 });
    expect(running.host.capabilityReport().orderedPresentation).toMatchObject({ active: true, protocol: 2 });

    // Pi's own output carries the stalled client past the cap, which is what makes it a recovery target.
    await running.waitForRead(
      () => (running.host.attachments().find((entry) => entry.attachmentId === "recovering")?.state ?? "live") === "resync-required",
      "the stalled client falling behind on Pi's own output",
    );
    recovering.releaseWrites();
    await running.waitForRead(() => recovering.queuedBytes() === 0, "the recovering client's queue draining");
    const acceptedBeforeFrame = recovering.acceptedBytes();
    const liveBeforeFrame = live.acceptedBytes();

    // One ordered presentation, performed by Pi's renderer, decoded from arriving reads while Pi runs.
    const presented = /** @type {any} */ (await running.host.presentOrderedTo(target.epoch));
    expect(presented).toMatchObject({ presented: true, recoveryArmed: true });
    expect(markers.isNativePresentToken(presented.ordering.token)).toBe(true);
    expect(markers.isNativePresentFrameId(presented.frame.frameId)).toBe(true);
    expect(typeof presented.presentationNonce).toBe("string");

    await running.waitForRead(() => {
      const state = /** @type {any} */ (running.host.recoveryState());
      return state !== null && state.observedBegin === true && state.observedEnd === true;
    }, "Pi's own BEGIN and END on the arriving reads");
    const proved = /** @type {any} */ (running.host.recoveryState());
    expect(proved).toMatchObject({ token: presented.ordering.token, observedBegin: true, observedEnd: true, controlResult: true, acknowledgeable: true });
    expect(proved.freshBytes).toBeGreaterThan(0);

    // The fresh frame reached the recovering client's own terminal, and no marker byte was forwarded to anyone.
    expect(recovering.acceptedBytes()).toBeGreaterThan(acceptedBeforeFrame);
    expect(recovering.latin1()).not.toContain("pi-native-present");
    expect(live.latin1()).not.toContain("pi-native-present");

    // Local admission comes first and is not the acknowledgement: the member is still held back until the
    // client says its own terminal output took those bytes in order.
    expect(recovering.locallyAdmitted()).toBe(true);
    expect(running.host.attachments().find((entry) => entry.attachmentId === "recovering")).toMatchObject({ state: "resync-required" });
    // A stale nonce and a stale epoch are both refused before the real one is accepted.
    expect(running.host.acknowledgePresentation(target.epoch, "not-this-nonce")).toMatchObject({ cleared: false });
    expect(running.host.acknowledgePresentation({ attachmentId: "recovering", epoch: target.epoch.epoch + 1 }, presented.presentationNonce)).toMatchObject({ cleared: false, reason: "no-armed-recovery" });
    expect(running.host.acknowledgePresentation(target.epoch, presented.presentationNonce)).toEqual({ cleared: true, reason: null });
    expect(running.host.attachments().find((entry) => entry.attachmentId === "recovering")).toMatchObject({ state: "live" });

    // The live member kept receiving Pi's output throughout, on the one route it has.
    expect(live.acceptedBytes()).toBeGreaterThan(liveBeforeFrame);
    expect(watcher.attached).toBe(true);

    // Bounded secondary evidence only: the arriving reads were many, and routing never read this record.
    expect(running.readCount()).toBeGreaterThan(1);
    console.log(`OBSERVED ordered-presentation: ${JSON.stringify({ hello: { protocol: hello.protocol, orderedPresentation: hello.orderedPresentation }, token: presented.ordering.token, frameId: presented.frame.frameId, nonce: presented.presentationNonce, freshBytes: proved.freshBytes, freshChunks: proved.freshChunks, recoveringAccepted: recovering.acceptedBytes() - acceptedBeforeFrame, liveAccepted: live.acceptedBytes() - liveBeforeFrame, reads: running.readCount() })}`);
  } finally {
    await running.close();
  }
}, 180_000);

it("records exactly what Pi's own response hook classified for a kitty-keyboard and an OSC 11 reply", async () => {
  const selected = await selectedCohort();
  if (!selected.selected) return;
  const running = await openRealPiHost(selected);
  try {
    const watcher = attachedClient();
    running.host.attach({ attachmentId: "watcher", sink: watcher.sink, declared: { capabilities: { ...CAPABILITIES } } });
    await running.relay.waitFor((frame) => frame.type === "publication" && frame.hasTarget === true, "a published input target");

    // Two replies a real terminal would send, written to the master this host owns so Pi reads them as its own
    // terminal input: a Kitty keyboard reply, which seam F classifies, and an OSC 11 background-colour reply,
    // which the profile declares as uncovered.
    running.host.writeToOwner(new Uint8Array(Buffer.from("\u001b[?1u", "latin1")));
    running.host.writeToOwner(new Uint8Array(Buffer.from("\u001b]11;rgb:1c1c/1c1c/1c1c\u001b\\", "latin1")));

    // Give both replies the same opportunity: wait for Pi to produce more output after they were written, then
    // read the hook's own record once. This is the smallest public-state probe available — the relay's
    // `beforeApplyTerminalResponse` is the seam F hook itself, not a private field and not a paint inference.
    const bytesBefore = running.readBytes();
    await running.waitForRead(() => running.readBytes() > bytesBefore, "Pi's output after the terminal replies", 30_000);
    const entries = (await readFile(running.owned.relayLog, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const responses = entries.filter((entry) => entry.event === "terminalResponse");
    const kinds = responses.map((entry) => entry.kind);

    // The result is asserted in the shape it actually has, and the two shapes mean different things.
    if (kinds.length === 0) {
      // No positive control fired: nothing at all was classified in this window. This run therefore proves only
      // that no OSC 11 reply reached the hook — it does NOT establish that the hook was live and excluded one.
      // Recorded as inconclusive for that discrimination rather than dressed up as a negative result.
      expect(responses).toEqual([]);
    } else {
      // The hook is live, and it still classified no background-colour reply: that is the discriminating fact.
      expect(kinds).not.toContain("osc11");
      expect(kinds).not.toContain("background-colour");
    }
    // Either way the host keeps naming the gap rather than claiming coverage, and the profile applies nothing.
    expect(running.host.capabilityReport().coverageGaps.map((/** @type {any} */ gap) => gap.capability)).toEqual(["osc11-background-colour"]);
    await recordFixtureNote(running.owned.relayLog, { event: "osc11ProbeObserved", kinds, responseCount: responses.length });
    console.log(`OBSERVED osc11-probe: ${JSON.stringify({ classifiedKinds: kinds, responseCount: responses.length, readBytes: running.readBytes(), hookLive: kinds.length > 0 })}`);
    const finalEntries = (await readFile(running.owned.relayLog, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    expect(finalEntries.some((line) => line.includes("osc11ProbeObserved"))).toBe(true);
  } finally {
    await running.close();
  }
}, 180_000);
