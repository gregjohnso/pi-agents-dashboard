import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ReadStream } from "node:tty";

import { afterEach, expect, it } from "vitest";

import { MISSING_HOST_CAPABILITIES, createPtyHost } from "../runtime/pty-host.mjs";
import { openOwnerPty } from "../runtime/pty-mechanism.mjs";
import { createLaunchFixedProfile } from "../runtime/terminal-profile.mjs";
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
