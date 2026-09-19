import { afterEach, expect, it } from "vitest";

import { createAttachmentSet } from "./attachment-set.mjs";
import { classifyOwnerExit, createPtyHost, MISSING_HOST_CAPABILITIES, ORDERED_BOOTSTRAP_PROTOCOL, PtyHostError } from "./pty-host.mjs";
import { createLaunchFixedProfile } from "./terminal-profile.mjs";
import { acceptedMarkerApi, bootstrapChannel, publishedInputTargetRegistry, terminalOutputClient } from "../test/fixtures/native-host/consumer-doubles.mjs";

/**
 * The accepted native build this host consumes, when a cohort is selected.
 *
 * The marker framing must be the build the running Pi writes, so it is never resolved from this package's own
 * pinned dependency: the cases that consume it are selected by `PI_NATIVE_ARTIFACTS_MANIFEST` and skip without
 * one, exactly like the other cohort suites in this repository.
 */
const accepted = await acceptedMarkerApi();
const withCohort = accepted.selected;
/** @type {any} */
const markers = accepted.api;

/** Channels a case opened, closed after it whatever happened: a real socket outlives a failed expectation. */
/** @type {{ close: () => Promise<void> }[]} */
const openChannels = [];
afterEach(async () => {
  for (const channel of openChannels.splice(0)) await channel.close();
});

const OWNER_IDENTITY = { pid: 4242, startIdentity: "918273", processGroupId: 4242, sessionId: 4242 };
/** The three fields an exact birth identity is, and the whole of what a host retains from the owner record. */
const BIRTH_IDENTITY = { pid: OWNER_IDENTITY.pid, startIdentity: OWNER_IDENTITY.startIdentity, processGroupId: OWNER_IDENTITY.processGroupId };
const CAPABILITIES = { kittyKeyboard: true, kittyGraphics: true, mouse: true, bracketedPaste: true, synchronizedOutput: true, trueColor: true };
const PROFILE = createLaunchFixedProfile({ profileId: "task12-owner", term: "xterm-256color", capabilities: CAPABILITIES, cellSize: null });

/** @param {string} text */
function bytes(text) {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

/** A caller's attempt to mutate a record the host handed out. A frozen record refuses it, which is the point.
 * @param {() => void} mutate */
function mutateIfAllowed(mutate) {
  try {
    mutate();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
  }
}

/**
 * One client sink a case can configure to fail where a real transport does, recording every byte it accepted.
 *
 * `onDrainThrows` is a transport that cannot take a drain listener at all, and `writeReturnsFalse` is Node's
 * high-water mark, which means accepted. A case sets both, so an initialization written too early shows up as
 * a recorded byte run rather than as a throw that would hide the ordering.
 *
 * `onDrainRegistered` runs inside the transport's own `onDrain`, which is the other place this admission calls
 * out to the client, and `fireDrain` replays what the transport would do when its queue empties.
 *
 * @param {{ onDrainThrows?: boolean, writeReturnsFalse?: boolean, queued?: number, onWrite?: () => void, onDrainRegistered?: () => void }} [options]
 */
function probeSink({ onDrainThrows = false, writeReturnsFalse = false, queued = 0, onWrite, onDrainRegistered } = {}) {
  /** @type {Uint8Array[]} */
  const written = [];
  /** @type {(() => void)[]} */
  const listeners = [];
  return {
    written,
    text: () => Buffer.concat(written.map((chunk) => Buffer.from(chunk))).toString("latin1"),
    drainRegistrations: () => listeners.length,
    fireDrain: () => {
      for (const listener of listeners) listener();
    },
    sink: {
      /** @param {Uint8Array} payload */
      write(payload) {
        written.push(payload);
        if (onWrite !== undefined) onWrite();
        return writeReturnsFalse ? false : undefined;
      },
      queuedBytes: () => queued,
      /** @param {() => void} listener */
      onDrain(listener) {
        if (onDrainThrows) throw new Error("this transport cannot register a drain listener");
        listeners.push(listener);
        if (onDrainRegistered !== undefined) onDrainRegistered();
      },
    },
  };
}

/** A sink whose write throws, with the whole surface the attachment set requires. @param {string} message */
function failingSink(message) {
  return {
    /** @param {Uint8Array} _payload */
    write(_payload) {
      throw new Error(message);
    },
    queuedBytes: () => 0,
    onDrain: () => {},
  };
}

/**
 * One owner handle with the same surface `openOwnerPty` returns, and nothing else.
 *
 * `acceptPerWrite` is how many bytes one `write` accepts before it reports the terminal's input buffer full,
 * which is the exact shape `PtyMechanismError` carries: the accepted prefix is data on the error, so a case
 * can assert that the host queues only the suffix.
 *
 * `identity` is this handle's own mutable owner record, because the real mechanism returns a mutable one too:
 * a case can mutate it after construction and assert the host still uses the identity it was born with.
 *
 * @param {{ rawStatus?: number | null, acceptPerWrite?: number, foreground?: number | Error, identity?: any }} [options]
 */
function fakeOwner({ rawStatus = null, acceptPerWrite = Number.MAX_SAFE_INTEGER, foreground = OWNER_IDENTITY.processGroupId, identity = { ...OWNER_IDENTITY } } = {}) {
  /** @type {Uint8Array[]} */
  const writes = [];
  /** @type {{ cols: number, rows: number }[]} */
  const resizes = [];
  let closes = 0;
  let status = rawStatus;
  return {
    writes,
    resizes,
    identity,
    closeCount: () => closes,
    setRawStatus: (/** @type {number | null} */ next) => {
      status = next;
    },
    handle: {
      masterFd: -1,
      owner: identity,
      helper: null,
      /** @param {Uint8Array} payload */
      write(payload) {
        const accepted = Math.min(acceptPerWrite, payload.byteLength);
        writes.push(payload.slice(0, accepted));
        if (accepted < payload.byteLength) {
          const error = new Error(`the terminal accepted ${accepted} of ${payload.byteLength} bytes`);
          Object.assign(error, { name: "PtyMechanismError", code: "PTY_INPUT_BACKPRESSURE", bytesWritten: accepted, totalBytes: payload.byteLength });
          throw error;
        }
      },
      /** @param {number} cols @param {number} rows */
      resize(cols, rows) {
        resizes.push({ cols, rows });
      },
      reapIfExited: () => (status === null ? null : { status }),
      foregroundProcessGroup: () => {
        if (foreground instanceof Error) throw foreground;
        return foreground;
      },
      wait: () => new Promise(() => {}),
      close: async () => {
        closes += 1;
      },
    },
  };
}

/** A sink with the AttachmentSink surface, recording what it was handed. */
function fakeSink({ queued = 0 } = {}) {
  /** @type {Uint8Array[]} */
  const written = [];
  return {
    written,
    text: () => Buffer.concat(written.map((chunk) => Buffer.from(chunk))).toString("latin1"),
    sink: {
      /** @param {Uint8Array} payload */
      write(payload) {
        written.push(payload);
      },
      queuedBytes: () => queued,
      onDrain: () => {},
    },
  };
}

/** A dispatch target with seam B/G's public result shape, recording every labelled span in call order. */
function fakeInputTarget({ admit = true, hold = false } = {}) {
  /** @type {{ attachmentEpoch: { attachmentId: string, epoch: number }, bytes: Uint8Array, generation: number }[]} */
  const dispatched = [];
  /** @type {((value: any) => void)[]} */
  const holds = [];
  let consumedThrough = 0;
  return {
    dispatched,
    releaseAll() {
      for (const release of holds.splice(0)) release(undefined);
    },
    target: {
      /** @param {{ attachmentEpoch: { attachmentId: string, epoch: number }, bytes: Uint8Array, binding: { generation: number } }} input */
      dispatchNativeInput(input) {
        dispatched.push({ attachmentEpoch: input.attachmentEpoch, bytes: input.bytes, generation: input.binding.generation });
        if (admit) consumedThrough += input.bytes.byteLength;
        const result = admit ? { admitted: true, consumedThrough } : { admitted: false, consumedThrough, reason: "handoff-closed" };
        if (!hold) return Promise.resolve(result);
        return new Promise((resolve) => holds.push(() => resolve(result)));
      },
    },
  };
}

/** A presentation channel with seam E's sideband result shape. Every request is answered by the test. */
function fakePresentationChannel() {
  /** @type {{ request: any, settle: (result: any) => void, fail: (error: Error) => void }[]} */
  const requests = [];
  return {
    requests,
    channel: {
      /** @param {any} request */
      present(request) {
        return new Promise((resolve, reject) => {
          requests.push({ request, settle: resolve, fail: reject });
        });
      },
    },
  };
}

/** @param {any} [options] */
function host(options = {}) {
  const owner = fakeOwner(options.owner ?? {});
  const created = createPtyHost({
    owner: owner.handle,
    profile: PROFILE,
    queuedByteCap: 1024,
    cols: 100,
    rows: 30,
    inputTarget: options.inputTarget ?? null,
    presentation: options.presentation ?? null,
    inspectIdentity: options.inspectIdentity ?? (async () => ({ pid: OWNER_IDENTITY.pid, startIdentity: OWNER_IDENTITY.startIdentity, processGroupId: OWNER_IDENTITY.processGroupId })),
    signalProcessGroup: options.signalProcessGroup ?? (() => {}),
  });
  return { owner, host: created };
}

/** @param {any} created @param {string} attachmentId @param {any} [declared] */
function attach(created, attachmentId, declared = { capabilities: { ...CAPABILITIES } }) {
  const client = fakeSink();
  const result = /** @type {{ attached: true, epoch: import("../shared/native-contracts.mjs").AttachmentEpoch, geometry: any }} */ (created.attach({ attachmentId, sink: client.sink, declared }));
  return { client, result };
}

it("shares one geometry, advances the revision on a real change, and keeps it after every detach", () => {
  const { owner, host: created } = host();
  const first = attach(created, "a");
  const second = attach(created, "b");
  expect(created.geometry()).toEqual({ cols: 100, rows: 30, revision: 1 });

  const fromA = created.resize({ cols: 120, rows: 40, from: first.result.epoch });
  expect(fromA).toEqual({ cols: 120, rows: 40, revision: 2, changed: true });
  const fromB = created.resize({ cols: 90, rows: 25, from: second.result.epoch });
  expect(fromB).toEqual({ cols: 90, rows: 25, revision: 3, changed: true });
  // One winsize: the master is resized once per change and never per attachment.
  expect(owner.resizes).toEqual([{ cols: 120, rows: 40 }, { cols: 90, rows: 25 }]);

  expect(created.resize({ cols: 90, rows: 25, from: second.result.epoch })).toEqual({ cols: 90, rows: 25, revision: 3, changed: false });
  expect(owner.resizes).toHaveLength(2);

  created.detach(first.result.epoch, "test");
  created.detach(second.result.epoch, "test");
  expect(created.attachments()).toEqual([]);
  expect(created.geometry()).toEqual({ cols: 90, rows: 25, revision: 3 });
});

it("refuses a resize from a connection that is not a member, and leaves the one winsize alone", () => {
  const { owner, host: created } = host();
  const { result } = attach(created, "a");
  created.detach(result.epoch, "test");
  expect(() => created.resize({ cols: 10, rows: 10, from: result.epoch })).toThrow(PtyHostError);
  expect(owner.resizes).toEqual([]);
});

it("hands two attachments' labelled spans to the dispatch target in arrival order", async () => {
  const input = fakeInputTarget();
  const { host: created } = host({ inputTarget: input.target });
  const a = attach(created, "a");
  const b = attach(created, "b");

  const first = created.deliverInput({ epoch: a.result.epoch, bytes: bytes("one") });
  const second = created.deliverInput({ epoch: b.result.epoch, bytes: bytes("two") });
  const third = created.deliverInput({ epoch: a.result.epoch, bytes: bytes("three") });
  await Promise.all([first, second, third]);

  expect(input.dispatched.map((entry) => [entry.attachmentEpoch.attachmentId, Buffer.from(entry.bytes).toString("latin1")])).toEqual([
    ["a", "one"],
    ["b", "two"],
    ["a", "three"],
  ]);
  expect(await third).toMatchObject({ delivered: true, admitted: true, consumedThrough: 11 });
});

it("keeps a refused span with its sender, hands it out once, and never dispatches it again", async () => {
  const input = fakeInputTarget({ admit: false });
  const { owner, host: created } = host({ inputTarget: input.target });
  const a = attach(created, "a");

  const result = await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("held") });
  expect(result).toMatchObject({ delivered: false, admitted: false, reason: "handoff-closed" });
  expect(input.dispatched).toHaveLength(1);

  const refused = created.takeRefusedInput();
  expect(refused.map((span) => Buffer.from(span.bytes).toString("latin1"))).toEqual(["held"]);
  // Handed out once. A second drain returns nothing, because two deliveries of the same bytes is the one
  // failure the seam's accounting exists to prevent.
  expect(created.takeRefusedInput()).toEqual([]);
  expect(input.dispatched).toHaveLength(1);
  expect(owner.writes).toEqual([]);
});

it("counts an ambiguous dispatch answer as ambiguous, and never sends those bytes a second time", async () => {
  /** @type {any} */
  const vagueTarget = { dispatchNativeInput: () => Promise.resolve({ consumedThrough: 4 }) };
  const { host: created } = host({ inputTarget: vagueTarget });
  const a = attach(created, "a");
  const result = await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("hmm?") });
  expect(result).toMatchObject({ delivered: false, admitted: null, reason: "dispatch-answer-unreadable" });
  expect(created.takeRefusedInput()).toEqual([]);
});

it("refuses labelled input with the missing capability named when no supported dispatch target exists", async () => {
  const { owner, host: created } = host({ inputTarget: null });
  const a = attach(created, "a");
  const result = await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("x") });
  expect(result).toEqual({ delivered: false, admitted: null, reason: "labelled-ingress-unavailable", missingCapability: MISSING_HOST_CAPABILITIES.labelledIngress });
  // No unlabelled fallback: nothing this client typed reached the master.
  expect(owner.writes).toEqual([]);
  expect(created.capabilityReport().missing).toContain(MISSING_HOST_CAPABILITIES.labelledIngress);
});

it("refuses input from a connection that is not a member", async () => {
  const input = fakeInputTarget();
  const { host: created } = host({ inputTarget: input.target });
  const a = attach(created, "a");
  created.detach(a.result.epoch, "test");
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("x") })).toMatchObject({ delivered: false, reason: "not-attached" });
  expect(input.dispatched).toEqual([]);
});

it("keeps a slow client a member and input-eligible after it is marked resync-required", async () => {
  const input = fakeInputTarget();
  const { host: created } = host({ inputTarget: input.target });
  const slow = fakeSink({ queued: 4096 });
  const admitted = /** @type {{ attached: true, epoch: import("../shared/native-contracts.mjs").AttachmentEpoch }} */ (created.attach({ attachmentId: "slow", sink: slow.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  created.broadcastOwnerOutput(bytes("a burst"));
  expect(created.attachments()).toEqual([{ attachmentId: "slow", epoch: 1, state: "resync-required", inputEligible: true, drains: 0, awaitingPresentationNonce: false }]);
  expect(await created.deliverInput({ epoch: admitted.epoch, bytes: bytes("still typing") })).toMatchObject({ delivered: true });
});

it("writes the profile's client-owned modes to a new attachment before any owner output reaches it", () => {
  const { host: created } = host();
  const a = attach(created, "a");
  expect(a.client.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006h");
  created.broadcastOwnerOutput(bytes("frame"));
  expect(a.client.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006hframe");
});

it("refuses a client that cannot meet the profile by name, and leaves the owner running", () => {
  const { owner, host: created } = host();
  const refused = created.attach({ attachmentId: "old", sink: fakeSink().sink, declared: { capabilities: { ...CAPABILITIES, kittyGraphics: false } } });
  expect(refused).toEqual({ attached: false, code: "NATIVE_ATTACHMENT_UNAVAILABLE", missingCapabilities: ["kittyGraphics"] });
  expect(created.attachments()).toEqual([]);
  expect(owner.closeCount()).toBe(0);
  expect(created.ownerAttachmentUnavailable()).toBe(true);
  // The refusal never reopens negotiation: the profile keeps every capability it was launched with.
  expect(created.profile().capabilities).toEqual(CAPABILITIES);
});

it("does not stop the owner or close the master when the attachment set empties", () => {
  const signals = /** @type {string[]} */ ([]);
  const { owner, host: created } = host({ signalProcessGroup: (/** @type {number} */ pgid, /** @type {string} */ signal) => signals.push(`${pgid}:${signal}`) });
  const a = attach(created, "a");
  created.detach(a.result.epoch, "client left");
  expect(created.attachments()).toEqual([]);
  expect(signals).toEqual([]);
  expect(owner.closeCount()).toBe(0);
  expect(created.describeOwnerExit()).toEqual({ exited: false, cause: null, note: "a null cached wait status is not evidence of life" });
});

it("suspends presentation and labelled ingress on entering, and resumes both on the matching left", async () => {
  const input = fakeInputTarget();
  const presentation = fakePresentationChannel();
  const { host: created } = host({ inputTarget: input.target, presentation: presentation.channel });
  const a = attach(created, "a");

  expect(created.childTerminalPhase({ phase: "entering", childPhaseId: "p1", reason: "external-editor", drainedThrough: 12 })).toEqual({ accepted: true });
  expect(created.childPhase()).toEqual({ active: true, childPhaseId: "p1", reason: "external-editor", drainedThrough: 12 });
  expect(created.presentationSuspended()).toBe(true);
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("into the editor") })).toMatchObject({ delivered: false, reason: "child-owns-terminal", childPhaseId: "p1" });
  expect(input.dispatched).toEqual([]);
  expect(await created.presentTo(a.result.epoch)).toMatchObject({ presented: false, refusal: "child-owns-terminal" });
  expect(presentation.requests).toEqual([]);

  // A `left` for another phase is not this phase's: it resumes nothing.
  expect(created.childTerminalPhase({ phase: "left", childPhaseId: "p9", reason: "external-editor", outcome: "returned" })).toEqual({ accepted: false, reason: "unmatched-child-phase" });
  expect(created.presentationSuspended()).toBe(true);

  expect(created.childTerminalPhase({ phase: "left", childPhaseId: "p1", reason: "external-editor", outcome: "returned" })).toEqual({ accepted: true });
  expect(created.childPhase()).toBe(null);
  expect(created.presentationSuspended()).toBe(false);
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("back") })).toMatchObject({ delivered: true });
});

it("reads the foreground process group as corroboration only, and reports that it proves nothing", () => {
  const { host: created } = host();
  created.childTerminalPhase({ phase: "entering", childPhaseId: "p1", reason: "external-editor", drainedThrough: 0 });
  // Pi's own external editor inherits Pi's group, so the group is unchanged while seam G says a child owns
  // the terminal. The comparison is therefore never the detection.
  expect(created.corroborateForegroundProcessGroup()).toEqual({
    foregroundProcessGroup: OWNER_IDENTITY.processGroupId,
    sameAsOwnerGroup: true,
    proves: "nothing",
  });
  expect(created.childPhase()?.active).toBe(true);
});

it("reports an unreadable foreground group as unreadable rather than as an absent child", () => {
  const failure = new Error("the owner has no terminal");
  const { host: created } = host({ owner: { foreground: failure } });
  expect(created.corroborateForegroundProcessGroup()).toEqual({ foregroundProcessGroup: null, sameAsOwnerGroup: null, proves: "nothing" });
});

it("classifies a normal wait status as a native exit even when cleanup signalled afterwards", () => {
  expect(classifyOwnerExit({ reaped: { status: 0x0700 }, stopIntent: { signal: "SIGTERM", identity: OWNER_IDENTITY }, owner: OWNER_IDENTITY })).toEqual({
    exited: true,
    cause: "native-exit",
    code: 7,
    signal: null,
    attribution: null,
    note: "a normal wait status is a normal or native exit; it does not prove the owner exited spontaneously",
  });
});

it("labels a signalled exit matching a recorded intent for that exact identity as attribution, not proof", () => {
  const classified = classifyOwnerExit({ reaped: { status: 15 }, stopIntent: { signal: "SIGTERM", identity: OWNER_IDENTITY }, owner: OWNER_IDENTITY });
  expect(classified).toEqual({
    exited: true,
    cause: "attributed-stop",
    code: null,
    signal: "SIGTERM",
    attribution: { signal: "SIGTERM", identity: OWNER_IDENTITY, basis: "attribution to a recorded stop intent, not causal proof" },
    note: "the signal matches this owner's recorded stop intent; nothing here proves the intent caused the exit",
  });
});

it("calls an unexplained signal death, a mismatched intent and an unresolved ordering unknown", () => {
  expect(classifyOwnerExit({ reaped: { status: 9 }, stopIntent: null, owner: OWNER_IDENTITY }).cause).toBe("unknown");
  expect(classifyOwnerExit({ reaped: { status: 15 }, stopIntent: { signal: "SIGKILL", identity: OWNER_IDENTITY }, owner: OWNER_IDENTITY }).cause).toBe("unknown");
  expect(classifyOwnerExit({ reaped: { status: 15 }, stopIntent: { signal: "SIGTERM", identity: { ...OWNER_IDENTITY, startIdentity: "1" } }, owner: OWNER_IDENTITY }).cause).toBe("unknown");
  expect(classifyOwnerExit({ reaped: null, stopIntent: null, owner: OWNER_IDENTITY })).toEqual({ exited: false, cause: null, note: "a null cached wait status is not evidence of life" });
});

it("reaps before it signals, and sends nothing when a status was already published", async () => {
  const signals = /** @type {string[]} */ ([]);
  const { owner, host: created } = host({ signalProcessGroup: (/** @type {number} */ pgid, /** @type {string} */ signal) => signals.push(`${pgid}:${signal}`) });
  owner.setRawStatus(0x0000);
  const stopped = await created.stopOwner({ signal: "SIGTERM" });
  expect(signals).toEqual([]);
  expect(stopped).toEqual({ signalled: false, reason: "already-reaped", exit: classifyOwnerExit({ reaped: { status: 0 }, stopIntent: null, owner: OWNER_IDENTITY }) });
});

it("revalidates the recorded identity immediately before the signal and refuses a changed one", async () => {
  const signals = /** @type {string[]} */ ([]);
  const { host: created } = host({
    signalProcessGroup: (/** @type {number} */ pgid, /** @type {string} */ signal) => signals.push(`${pgid}:${signal}`),
    inspectIdentity: async () => ({ pid: OWNER_IDENTITY.pid, startIdentity: "99999999", processGroupId: OWNER_IDENTITY.processGroupId }),
  });
  expect(await created.stopOwner({ signal: "SIGTERM" })).toEqual({ signalled: false, reason: "identity-changed" });
  expect(signals).toEqual([]);
  expect(created.describeOwnerExit().cause).toBe(null);
});

it("records the stop intent it signalled, so a later signal death can be attributed to it", async () => {
  const signals = /** @type {string[]} */ ([]);
  const { owner, host: created } = host({ signalProcessGroup: (/** @type {number} */ pgid, /** @type {string} */ signal) => signals.push(`${pgid}:${signal}`) });
  expect(await created.stopOwner({ signal: "SIGTERM" })).toEqual({ signalled: true, intent: { signal: "SIGTERM", identity: BIRTH_IDENTITY } });
  expect(signals).toEqual([`${OWNER_IDENTITY.processGroupId}:SIGTERM`]);
  owner.setRawStatus(15);
  expect(created.describeOwnerExit().cause).toBe("attributed-stop");
});

it("refuses a plain profile that disables a required capability rather than admitting it past the factory", () => {
  const owner = fakeOwner();
  for (const capability of ["kittyGraphics", "kittyKeyboard", "mouse"]) {
    const plain = { profileId: "bypass", term: "xterm-256color", capabilities: { ...CAPABILITIES, [capability]: false }, cellSize: null };
    let error;
    try {
      createPtyHost({ owner: owner.handle, profile: /** @type {any} */ (plain), queuedByteCap: 1024, cols: 100, rows: 30 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PtyHostError);
    expect(/** @type {PtyHostError} */ (error).code).toBe("PTY_HOST_PROFILE_UNUSABLE");
  }
});

it("holds its own frozen profile, so mutating the caller's records moves neither admission nor the mode bytes", () => {
  const owner = fakeOwner();
  const capabilities = { ...CAPABILITIES };
  const cellSize = { width: 9, height: 19 };
  const created = createPtyHost({
    owner: owner.handle,
    profile: /** @type {any} */ ({ profileId: "task12-owner", term: "xterm-256color", capabilities, cellSize }),
    queuedByteCap: 1024,
    cols: 100,
    rows: 30,
  });
  capabilities.mouse = false;
  cellSize.width = 1;

  expect(created.profile().capabilities).toEqual(CAPABILITIES);
  expect(created.profile().cellSize).toEqual({ width: 9, height: 19 });
  expect(Object.isFrozen(created.profile())).toBe(true);
  expect(Object.isFrozen(created.profile().capabilities)).toBe(true);
  expect(Object.isFrozen(created.profile().cellSize)).toBe(true);
  // The mode bytes were derived with mouse reporting on, so admission must still require it of a client.
  expect(created.attach({ attachmentId: "no-mouse", sink: fakeSink().sink, declared: { capabilities: { ...CAPABILITIES, mouse: false } } })).toEqual({
    attached: false,
    code: "NATIVE_ATTACHMENT_UNAVAILABLE",
    missingCapabilities: ["mouse"],
  });
  expect(attach(created, "full").client.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006h");
});

it("admits no member at all when a new attachment's initialization write throws", () => {
  const { host: created } = host();
  expect(() => created.attach({ attachmentId: "ghost", sink: failingSink("the client socket is already gone"), declared: { capabilities: { ...CAPABILITIES } } })).toThrow(PtyHostError);
  expect(created.attachments()).toEqual([]);
  // Nothing was admitted, so no later broadcast reaches it and the epoch it never used is still available.
  expect(created.broadcastOwnerOutput(bytes("frame")).delivered).toEqual([]);
  const retried = attach(created, "ghost");
  expect(retried.result.epoch).toEqual({ attachmentId: "ghost", epoch: 1 });
  expect(retried.client.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006h");
});

it("keeps the old connection and its outstanding presentation when a replacement's initialization write throws", async () => {
  const presentation = fakePresentationChannel();
  const { host: created } = host({ presentation: presentation.channel });
  const first = attach(created, "a");
  const pending = created.presentTo(first.result.epoch);

  expect(() => created.attach({ attachmentId: "a", sink: failingSink("the replacement socket is already gone"), declared: { capabilities: { ...CAPABILITIES } } })).toThrow(PtyHostError);

  expect(created.attachments()).toEqual([{ attachmentId: "a", epoch: 1, state: "live", inputEligible: true, drains: 0, awaitingPresentationNonce: false }]);
  created.broadcastOwnerOutput(bytes("frame"));
  expect(first.client.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006hframe");

  // The request the surviving connection made is still its own, so it is answered rather than retired.
  presentation.requests[0].settle({
    presented: true,
    terminalOwner: "pi",
    presentationNonce: "frame-1",
    frame: { frameId: "frame-1", sequence: 1, columns: 100, rows: 30, byteLength: 512 },
    geometryRevision: 1,
    attachmentEpoch: first.result.epoch,
    cold: true,
  });
  expect(await pending).toMatchObject({ presented: true, presentationNonce: "frame-1", recoveryArmed: false });
  expect(created.presentationCounts()).toMatchObject({ requested: 1, presented: 1, retired: 0 });
});

it("takes a sink's false write as accepted backpressure, and writes the accepted initialization once", () => {
  const { host: created } = host();
  const written = /** @type {Uint8Array[]} */ ([]);
  const backpressured = {
    /** @param {Uint8Array} payload */
    write(payload) {
      written.push(payload);
      return false;
    },
    queuedBytes: () => 0,
    onDrain: () => {},
  };
  expect(created.attach({ attachmentId: "slow-socket", sink: backpressured, declared: { capabilities: { ...CAPABILITIES } } })).toEqual({
    attached: true,
    epoch: { attachmentId: "slow-socket", epoch: 1 },
    geometry: { cols: 100, rows: 30, revision: 1 },
  });
  expect(created.attachments()).toEqual([{ attachmentId: "slow-socket", epoch: 1, state: "live", inputEligible: true, drains: 0, awaitingPresentationNonce: false }]);
  expect(written.map((chunk) => Buffer.from(chunk).toString("latin1"))).toEqual(["\u001b[?2004h\u001b[?1002h\u001b[?1006h"]);
});

it("refuses a malformed attachment id before one byte reaches the candidate, and spends no epoch on it", () => {
  const { host: created } = host();
  // Every one of these is refused by the shared epoch contract rather than by this host's own opinion: an
  // empty id, an untrimmed id on either side, and an id past the bounded length.
  for (const attachmentId of ["", " a", "a ", "a".repeat(257)]) {
    const candidate = probeSink({ writeReturnsFalse: true });
    expect(() => created.attach({ attachmentId, sink: candidate.sink, declared: { capabilities: { ...CAPABILITIES } } })).toThrow();
    // A write that answers false is accepted, so ordering is the only thing that keeps these bytes unsent.
    expect(candidate.written).toEqual([]);
    expect(candidate.drainRegistrations()).toBe(0);
    expect(created.attachments()).toEqual([]);
  }
  // None of them spent an epoch, so the first well-formed admission is still epoch 1.
  expect(attach(created, "a").result.epoch).toEqual({ attachmentId: "a", epoch: 1 });
});

it("leaves a live connection and its outstanding presentation untouched when a malformed id is refused", async () => {
  const presentation = fakePresentationChannel();
  const { host: created } = host({ presentation: presentation.channel });
  const first = attach(created, "a");
  const pending = created.presentTo(first.result.epoch);

  // A malformed id can never be the id of an admitted connection, so this is the only replacement shape it
  // reaches: the refusal must leave the member that is there, and its request, exactly as they were.
  const candidate = probeSink({ writeReturnsFalse: true });
  expect(() => created.attach({ attachmentId: " a", sink: candidate.sink, declared: { capabilities: { ...CAPABILITIES } } })).toThrow();
  expect(candidate.written).toEqual([]);

  expect(created.attachments()).toEqual([{ attachmentId: "a", epoch: 1, state: "live", inputEligible: true, drains: 0, awaitingPresentationNonce: false }]);
  created.broadcastOwnerOutput(bytes("frame"));
  expect(first.client.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006hframe");
  presentation.requests[0].settle({
    presented: true,
    terminalOwner: "pi",
    presentationNonce: "frame-1",
    frame: { frameId: "frame-1", sequence: 1, columns: 100, rows: 30, byteLength: 512 },
    geometryRevision: 1,
    attachmentEpoch: first.result.epoch,
    cold: true,
  });
  expect(await pending).toMatchObject({ presented: true, presentationNonce: "frame-1" });
});

it("refuses a sink that cannot register a drain listener before it writes the initialization to it", () => {
  const { host: created } = host();
  const candidate = probeSink({ onDrainThrows: true, writeReturnsFalse: true });
  let error;
  try {
    created.attach({ attachmentId: "no-drain", sink: candidate.sink, declared: { capabilities: { ...CAPABILITIES } } });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PtyHostError);
  expect(/** @type {PtyHostError} */ (error).code).toBe("PTY_HOST_SINK_UNUSABLE");
  expect(candidate.written).toEqual([]);
  expect(created.attachments()).toEqual([]);
  // The refused attempt spent no epoch: a sink that could take a listener is admitted at epoch 1.
  expect(attach(created, "no-drain").result.epoch).toEqual({ attachmentId: "no-drain", epoch: 1 });
});

it("keeps the old connection, its epoch line and its request when a replacement cannot register a drain", async () => {
  const presentation = fakePresentationChannel();
  const { host: created } = host({ presentation: presentation.channel });
  const first = attach(created, "a");
  const pending = created.presentTo(first.result.epoch);

  const candidate = probeSink({ onDrainThrows: true, writeReturnsFalse: true });
  expect(() => created.attach({ attachmentId: "a", sink: candidate.sink, declared: { capabilities: { ...CAPABILITIES } } })).toThrow(PtyHostError);
  expect(candidate.written).toEqual([]);

  expect(created.attachments()).toEqual([{ attachmentId: "a", epoch: 1, state: "live", inputEligible: true, drains: 0, awaitingPresentationNonce: false }]);
  created.broadcastOwnerOutput(bytes("frame"));
  expect(first.client.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006hframe");
  presentation.requests[0].settle({
    presented: true,
    terminalOwner: "pi",
    presentationNonce: "frame-1",
    frame: { frameId: "frame-1", sequence: 1, columns: 100, rows: 30, byteLength: 512 },
    geometryRevision: 1,
    attachmentEpoch: first.result.epoch,
    cold: true,
  });
  expect(await pending).toMatchObject({ presented: true, presentationNonce: "frame-1" });

  // The failed replacement spent no epoch, so the connection that really replaces it is epoch 2.
  const replacement = probeSink();
  expect(created.attach({ attachmentId: "a", sink: replacement.sink, declared: { capabilities: { ...CAPABILITIES } } })).toMatchObject({
    attached: true,
    epoch: { attachmentId: "a", epoch: 2 },
  });
  expect(replacement.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006h");
});

it("does not overwrite a newer member admitted from inside its own initialization write", () => {
  const { host: created } = host();
  const inner = probeSink();
  let reentered = false;
  const candidate = probeSink({
    writeReturnsFalse: true,
    onWrite: () => {
      if (reentered) return;
      reentered = true;
      created.attach({ attachmentId: "a", sink: inner.sink, declared: { capabilities: { ...CAPABILITIES } } });
    },
  });

  let error;
  try {
    created.attach({ attachmentId: "a", sink: candidate.sink, declared: { capabilities: { ...CAPABILITIES } } });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PtyHostError);
  expect(/** @type {PtyHostError} */ (error).code).toBe("PTY_HOST_ATTACHMENT_SUPERSEDED");

  // The connection admitted from inside that write keeps the id, its epoch and its one initialization.
  expect(created.attachments()).toEqual([{ attachmentId: "a", epoch: 1, state: "live", inputEligible: true, drains: 0, awaitingPresentationNonce: false }]);
  expect(inner.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006h");
  // The candidate was written to exactly once and is nobody's member, so no broadcast reaches it.
  expect(candidate.written).toHaveLength(1);
  created.broadcastOwnerOutput(bytes("frame"));
  expect(candidate.written).toHaveLength(1);
  expect(inner.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006hframe");
});

it("writes nothing to a candidate already superseded from inside its own drain registration", () => {
  const { host: created } = host();
  const inner = probeSink();
  let reentered = false;
  // The other place admission calls out to the client: registering the drain listener. A transport that
  // admits the same id from there makes this candidate superseded before one byte has been written to it.
  const candidate = probeSink({
    writeReturnsFalse: true,
    onDrainRegistered: () => {
      if (reentered) return;
      reentered = true;
      created.attach({ attachmentId: "a", sink: inner.sink, declared: { capabilities: { ...CAPABILITIES } } });
    },
  });

  let error;
  try {
    created.attach({ attachmentId: "a", sink: candidate.sink, declared: { capabilities: { ...CAPABILITIES } } });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PtyHostError);
  expect(/** @type {PtyHostError} */ (error).code).toBe("PTY_HOST_ATTACHMENT_SUPERSEDED");
  // Supersession was knowable before the write, so the candidate holds no accepted bytes at all.
  expect(candidate.written).toEqual([]);

  // The connection admitted from inside that registration keeps the id, its epoch and its one initialization.
  expect(created.attachments()).toEqual([{ attachmentId: "a", epoch: 1, state: "live", inputEligible: true, drains: 0, awaitingPresentationNonce: false }]);
  expect(inner.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006h");
  created.broadcastOwnerOutput(bytes("frame"));
  expect(candidate.written).toEqual([]);
  expect(inner.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006hframe");

  // The refused candidate's listener was registered before it was refused, and it stays inert: the member
  // that holds the id counts none of its drains.
  expect(candidate.drainRegistrations()).toBe(1);
  candidate.fireDrain();
  expect(created.attachments()).toEqual([{ attachmentId: "a", epoch: 1, state: "live", inputEligible: true, drains: 0, awaitingPresentationNonce: false }]);
  inner.fireDrain();
  expect(created.attachments()[0].drains).toBe(1);
});

it("writes nothing to a replacement already superseded from inside its own drain registration", async () => {
  const presentation = fakePresentationChannel();
  const { host: created } = host({ presentation: presentation.channel });
  const first = attach(created, "a");
  const pending = created.presentTo(first.result.epoch);

  const inner = probeSink();
  let reentered = false;
  const candidate = probeSink({
    writeReturnsFalse: true,
    onDrainRegistered: () => {
      if (reentered) return;
      reentered = true;
      created.attach({ attachmentId: "a", sink: inner.sink, declared: { capabilities: { ...CAPABILITIES } } });
    },
  });

  let error;
  try {
    created.attach({ attachmentId: "a", sink: candidate.sink, declared: { capabilities: { ...CAPABILITIES } } });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PtyHostError);
  expect(/** @type {PtyHostError} */ (error).code).toBe("PTY_HOST_ATTACHMENT_SUPERSEDED");
  expect(candidate.written).toEqual([]);

  // The replacement admitted from inside the registration holds the id at the next epoch, and the refused
  // candidate is nobody: no broadcast and no drain of its own reaches the member.
  expect(created.attachments()).toEqual([{ attachmentId: "a", epoch: 2, state: "live", inputEligible: true, drains: 0, awaitingPresentationNonce: false }]);
  created.broadcastOwnerOutput(bytes("frame"));
  expect(candidate.written).toEqual([]);
  expect(inner.text()).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006hframe");
  candidate.fireDrain();
  expect(created.attachments()[0].drains).toBe(0);

  // The first connection's request was retired by the replacement that really took its id, and it is never
  // answered to whoever holds that id now.
  presentation.requests[0].settle({
    presented: true,
    terminalOwner: "pi",
    presentationNonce: "frame-1",
    frame: { frameId: "frame-1", sequence: 1, columns: 100, rows: 30, byteLength: 512 },
    geometryRevision: 1,
    attachmentEpoch: first.result.epoch,
    cold: true,
  });
  expect(await pending).toEqual({ presented: false, refusal: "attachment-retired", attachmentEpoch: first.result.epoch });
  expect(created.attachments()[0].awaitingPresentationNonce).toBe(false);

  // The refused candidate spent no epoch, so the next real replacement is epoch 3.
  const third = probeSink();
  expect(created.attach({ attachmentId: "a", sink: third.sink, declared: { capabilities: { ...CAPABILITIES } } })).toMatchObject({
    attached: true,
    epoch: { attachmentId: "a", epoch: 3 },
  });
});

it("refuses an owner handle whose birth identity is not an exact pid, start identity and process group", () => {
  for (const identity of [
    { pid: 0, startIdentity: "918273", processGroupId: 4242 },
    { pid: -1, startIdentity: "918273", processGroupId: 4242 },
    { pid: 4242, startIdentity: "", processGroupId: 4242 },
    { pid: 4242, startIdentity: "918273" },
    { pid: 4242, startIdentity: "918273", processGroupId: 0 },
    { pid: 4242, startIdentity: "918273", processGroupId: 1.5 },
  ]) {
    const owner = fakeOwner({ identity });
    let error;
    try {
      createPtyHost({ owner: owner.handle, profile: PROFILE, queuedByteCap: 1024, cols: 100, rows: 30 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PtyHostError);
    expect(/** @type {PtyHostError} */ (error).code).toBe("PTY_HOST_OWNER_UNUSABLE");
  }
});

it("signals the group it was born with after the owner handle's own identity record is mutated", async () => {
  const signals = /** @type {string[]} */ ([]);
  const inspected = /** @type {number[]} */ ([]);
  const owner = fakeOwner();
  const created = createPtyHost({
    owner: owner.handle,
    profile: PROFILE,
    queuedByteCap: 1024,
    cols: 100,
    rows: 30,
    inspectIdentity: async (/** @type {number} */ pid) => {
      inspected.push(pid);
      return { ...BIRTH_IDENTITY };
    },
    signalProcessGroup: (/** @type {number} */ pgid, /** @type {string} */ signal) => signals.push(`${pgid}:${signal}`),
  });
  // The mechanism hands out its own mutable owner record, so this needs no fixture trick to reach.
  owner.identity.pid = 1;
  owner.identity.processGroupId = 1;
  owner.identity.startIdentity = "0";

  expect(await created.stopOwner({ signal: "SIGTERM" })).toEqual({ signalled: true, intent: { signal: "SIGTERM", identity: BIRTH_IDENTITY } });
  expect(inspected).toEqual([BIRTH_IDENTITY.pid]);
  expect(signals).toEqual([`${BIRTH_IDENTITY.processGroupId}:SIGTERM`]);
});

it("freezes the stop intent it hands back, so a later mutation rewrites no attribution", async () => {
  const owner = fakeOwner();
  const created = createPtyHost({
    owner: owner.handle,
    profile: PROFILE,
    queuedByteCap: 1024,
    cols: 100,
    rows: 30,
    inspectIdentity: async () => ({ ...BIRTH_IDENTITY }),
    signalProcessGroup: () => {},
  });
  const stopped = /** @type {{ signalled: true, intent: { signal: string, identity: any } }} */ (await created.stopOwner({ signal: "SIGTERM" }));
  expect(Object.isFrozen(stopped.intent)).toBe(true);
  expect(Object.isFrozen(stopped.intent.identity)).toBe(true);

  mutateIfAllowed(() => {
    stopped.intent.signal = "SIGKILL";
  });
  mutateIfAllowed(() => {
    stopped.intent.identity.startIdentity = "0";
  });
  mutateIfAllowed(() => {
    owner.identity.startIdentity = "0";
  });

  owner.setRawStatus(15);
  const exit = /** @type {{ cause: string, signal: string | null, attribution: any }} */ (created.describeOwnerExit());
  expect(exit.cause).toBe("attributed-stop");
  expect(exit.signal).toBe("SIGTERM");
  expect(exit.attribution).toEqual({ signal: "SIGTERM", identity: BIRTH_IDENTITY, basis: "attribution to a recorded stop intent, not causal proof" });
});

it("reports a malformed attachment origin on a terminal response as unreadable provenance", () => {
  const { host: created } = host();
  expect(created.authorizeTerminalResponse({ kind: "kitty-keyboard", requestEpoch: 1, attachmentEpoch: { attachmentId: "", epoch: 0 }, raw: bytes("\u001b[?1u") })).toEqual({ apply: false, reason: "unreadable" });
  expect(created.responseCounts()).toEqual({ total: 1, clientReply: 0, staleRequestEpoch: 0, profileFixed: 0, unreadable: 1 });
});

it("queues only the suffix a full terminal refused, and never rewrites an accepted prefix", () => {
  const { owner, host: created } = host({ owner: { acceptPerWrite: 3 } });
  expect(created.writeToOwner(bytes("abcdefgh"))).toEqual({ accepted: 3, pending: 5 });
  expect(owner.writes.map((chunk) => Buffer.from(chunk).toString("latin1"))).toEqual(["abc"]);
  // A second span waits behind the first, so the master never sees them out of arrival order.
  expect(created.writeToOwner(bytes("ij"))).toEqual({ accepted: 0, pending: 7 });
  expect(owner.writes).toHaveLength(1);
  expect(created.flushOwnerWrites()).toEqual({ accepted: 3, pending: 4 });
  expect(created.flushOwnerWrites()).toEqual({ accepted: 4, pending: 0 });
  expect(owner.writes.map((chunk) => Buffer.from(chunk).toString("latin1"))).toEqual(["abc", "def", "gh", "ij"]);
});

it("delegates every terminal response to the launch-fixed profile ledger and applies none of them", () => {
  const { host: created } = host();
  expect(created.authorizeTerminalResponse({ kind: "kitty-keyboard", requestEpoch: 2, attachmentEpoch: { attachmentId: "a", epoch: 1 }, raw: bytes("\u001b[?1u") })).toEqual({ apply: false, reason: "client-reply" });
  expect(created.authorizeTerminalResponse({ kind: "da", requestEpoch: 5, attachmentEpoch: null, raw: bytes("\u001b[?62;c") })).toEqual({ apply: false, reason: "profile-fixed" });
  expect(created.authorizeTerminalResponse({ kind: "da", requestEpoch: 4, attachmentEpoch: null, raw: bytes("\u001b[?62;c") })).toEqual({ apply: false, reason: "stale-request-epoch" });
  expect(created.responseCounts()).toEqual({ total: 3, clientReply: 1, staleRequestEpoch: 1, profileFixed: 1, unreadable: 0 });
  expect(created.profile().capabilities).toEqual(CAPABILITIES);
});

it("passes a paste body that contains response-shaped bytes through as one unchanged input span", async () => {
  const input = fakeInputTarget();
  const { host: created } = host({ inputTarget: input.target });
  const a = attach(created, "a");
  const paste = bytes("\u001b[200~\u001b[?62;c\u001b[201~");
  await created.deliverInput({ epoch: a.result.epoch, bytes: paste });
  // One span, byte for byte, and no response decision: the host never scans input for replies.
  expect(input.dispatched).toHaveLength(1);
  expect(Buffer.from(input.dispatched[0].bytes).toString("latin1")).toBe("\u001b[200~\u001b[?62;c\u001b[201~");
  expect(created.responseCounts().total).toBe(0);
});

it("names the presentation delivery boundary as missing rather than arming nonce recovery", async () => {
  const presentation = fakePresentationChannel();
  const { host: created } = host({ presentation: presentation.channel });
  const a = attach(created, "a");
  const pending = created.presentTo(a.result.epoch);
  expect(presentation.requests[0].request).toEqual({ attachmentEpoch: a.result.epoch, geometryRevision: 1, coldTerminal: true });
  presentation.requests[0].settle({
    presented: true,
    terminalOwner: "pi",
    presentationNonce: "frame-1",
    frame: { frameId: "frame-1", sequence: 1, columns: 100, rows: 30, byteLength: 512 },
    geometryRevision: 1,
    attachmentEpoch: a.result.epoch,
    cold: true,
  });
  expect(await pending).toEqual({
    presented: true,
    presentationNonce: "frame-1",
    geometryRevision: 1,
    frame: { frameId: "frame-1", sequence: 1, columns: 100, rows: 30, byteLength: 512 },
    recoveryArmed: false,
    missingCapability: MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary,
  });
  // The nonce is never recorded against the attachment, so nothing a client echoes can clear resync.
  expect(created.attachments()[0].awaitingPresentationNonce).toBe(false);
  expect(created.acknowledgePresentation(a.result.epoch, "frame-1")).toEqual({
    cleared: false,
    reason: "presentation-delivery-boundary-unavailable",
    missingCapability: MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary,
  });
  expect(created.presentationCounts()).toEqual({ requested: 1, presented: 1, refused: 0, retired: 0, staleReceipt: 0, acknowledgementsRefused: 1 });
});

it("records a receipt built at another geometry as stale instead of treating it as current", async () => {
  const presentation = fakePresentationChannel();
  const { host: created } = host({ presentation: presentation.channel });
  const a = attach(created, "a");
  const pending = created.presentTo(a.result.epoch);
  created.resize({ cols: 120, rows: 40, from: a.result.epoch });
  presentation.requests[0].settle({
    presented: true,
    terminalOwner: "pi",
    presentationNonce: "frame-1",
    frame: { frameId: "frame-1", sequence: 1, columns: 100, rows: 30, byteLength: 512 },
    geometryRevision: 1,
    attachmentEpoch: a.result.epoch,
    cold: true,
  });
  const result = await pending;
  expect(result).toMatchObject({ presented: true, recoveryArmed: false, stale: true });
  expect(created.presentationCounts().staleReceipt).toBe(1);
});

it("retires a presentation outstanding when its attachment leaves, and never answers its replacement with it", async () => {
  const presentation = fakePresentationChannel();
  const { host: created } = host({ presentation: presentation.channel });
  const first = attach(created, "a");
  const pending = created.presentTo(first.result.epoch);
  created.detach(first.result.epoch, "client left");
  const second = attach(created, "a");
  expect(second.result.epoch).toEqual({ attachmentId: "a", epoch: 2 });

  presentation.requests[0].settle({
    presented: true,
    terminalOwner: "pi",
    presentationNonce: "frame-1",
    frame: { frameId: "frame-1", sequence: 1, columns: 100, rows: 30, byteLength: 512 },
    geometryRevision: 1,
    attachmentEpoch: first.result.epoch,
    cold: true,
  });
  expect(await pending).toEqual({ presented: false, refusal: "attachment-retired", attachmentEpoch: first.result.epoch });
  expect(created.presentationCounts()).toEqual({ requested: 1, presented: 0, refused: 0, retired: 1, staleReceipt: 0, acknowledgementsRefused: 0 });
  // The replacement was handed nothing: it has no outstanding request and no recorded nonce.
  expect(created.attachments()[0].awaitingPresentationNonce).toBe(false);
});

it("refuses a presentation for a connection that is not a member without asking Pi", async () => {
  const presentation = fakePresentationChannel();
  const { host: created } = host({ presentation: presentation.channel });
  const a = attach(created, "a");
  created.detach(a.result.epoch, "test");
  expect(await created.presentTo(a.result.epoch)).toEqual({ presented: false, refusal: "not-attached", attachmentEpoch: a.result.epoch });
  expect(presentation.requests).toEqual([]);
});

it("names the presentation channel as missing when the owner has none", async () => {
  const { host: created } = host({ presentation: null });
  const a = attach(created, "a");
  expect(await created.presentTo(a.result.epoch)).toEqual({
    presented: false,
    refusal: "presentation-channel-unavailable",
    attachmentEpoch: a.result.epoch,
  });
});

it("shows why a receipt alone cannot clear resync: the attachment set would accept an echo the screen has not seen", () => {
  // The counterexample, run against the real attachment set rather than described. Seam E's nonce names a
  // frame handed to `Terminal.write`; the host reads those bytes off a different channel from the sideband
  // the receipt arrives on. So a host that recorded the nonce when the receipt arrived would accept the
  // client's echo while its own read position is still behind the frame.
  const { host: created } = host();
  const slow = fakeSink({ queued: 4096 });
  const admitted = /** @type {{ attached: true, epoch: import("../shared/native-contracts.mjs").AttachmentEpoch }} */ (created.attach({ attachmentId: "slow", sink: slow.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  created.broadcastOwnerOutput(bytes("a burst"));
  expect(created.attachments()[0].state).toBe("resync-required");
  const readThroughAtReceipt = created.readThrough();

  const naive = createAttachmentSet({ queuedByteCap: 1024 });
  const naiveEpoch = naive.add(admitted.epoch, fakeSink({ queued: 4096 }).sink);
  naive.broadcast(bytes("a burst"));
  expect(naive.attachments()[0].state).toBe("resync-required");
  expect(naive.recordPresentationNonce(naiveEpoch, "frame-1")).toBe(true);
  expect(naive.acknowledgePresentation(naiveEpoch, "frame-1")).toBe(true);
  expect(naive.attachments()[0].state).toBe("live");

  // The host refuses that shortcut, and its own read position never moved for the presented frame.
  expect(created.readThrough()).toBe(readThroughAtReceipt);
  expect(created.attachments()[0].state).toBe("resync-required");
  expect(created.capabilityReport().missing).toContain(MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary);
});

it("reports the profile coverage it cannot enforce alongside the capabilities it is missing", () => {
  const { host: created } = host();
  const report = created.capabilityReport();
  expect(report.missing).toEqual([MISSING_HOST_CAPABILITIES.labelledIngress, MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary]);
  expect(report.coverageGaps.map((/** @type {any} */ gap) => gap.capability)).toEqual(["osc11-background-colour"]);
});

it("refuses an unusable construction rather than defaulting it", () => {
  const owner = fakeOwner();
  expect(() => createPtyHost({ owner: owner.handle, profile: PROFILE, queuedByteCap: 0, cols: 80, rows: 24 })).toThrow(PtyHostError);
  expect(() => createPtyHost({ owner: owner.handle, profile: PROFILE, queuedByteCap: 1024, cols: 0, rows: 24 })).toThrow(PtyHostError);
  expect(() => createPtyHost({ owner: /** @type {any} */ ({}), profile: PROFILE, queuedByteCap: 1024, cols: 80, rows: 24 })).toThrow(PtyHostError);
  expect(() => createPtyHost({ owner: owner.handle, profile: /** @type {any} */ ({ profileId: "x" }), queuedByteCap: 1024, cols: 80, rows: 24 })).toThrow(PtyHostError);
});

// ---------------------------------------------------------------------------------------------------------
// The accepted capability consumers.
//
// Process placement, which every case below depends on: the published input-target registry is PROCESS-LOCAL
// to Pi. Calling `nativeInputTargetSnapshot()` here, in the host process, reads this process's own empty
// container — which the first case proves against the accepted build rather than asserting from a document.
// So the host consumes the snapshot/subscription *shape* from whoever runs Pi-side, and four boundaries stay
// distinct: the bootstrap-2 control frames on a real socket, the marker framing decoded out of the PTY bytes,
// the fresh bytes handed to one client transport, and that client's own local `Writable` acceptance.
// ---------------------------------------------------------------------------------------------------------

/** One host wired to the consumer seams a case supplies. Everything else stays the accepted construction.
 * @param {{ registry?: any, channel?: any, presentMarkers?: any, owner?: any }} [options] */
function consumerHost({ registry = null, channel = null, presentMarkers = null, owner: ownerOptions = {} } = {}) {
  const owner = fakeOwner(ownerOptions);
  const created = createPtyHost({
    owner: owner.handle,
    profile: PROFILE,
    queuedByteCap: 1024,
    cols: 100,
    rows: 30,
    inputTargetRegistry: registry,
    presentation: channel,
    presentMarkers,
    inspectIdentity: async () => ({ ...BIRTH_IDENTITY }),
    signalProcessGroup: () => {},
  });
  return { owner, host: created };
}

/** Open a real bootstrap socket and close it after the case, whatever the case does. @param {any} [options] */
async function openChannel(options) {
  const opened = await bootstrapChannel(options);
  openChannels.push(opened);
  return opened;
}

/** The successful `presentation-result` frame Pi answers one `present-ordered` command with.
 * @param {any} command @param {{ frameId: string, nonce: string, columns?: number, rows?: number, geometryRevision?: number }} receipt */
function orderedResult(command, receipt) {
  const { frameId, nonce, columns = 100, rows = 30, geometryRevision = 1 } = receipt;
  return {
    type: "presentation-result",
    protocol: ORDERED_BOOTSTRAP_PROTOCOL,
    requestId: command.requestId,
    ordering: { version: command.ordering.version, token: command.ordering.token },
    result: {
      presented: true,
      terminalOwner: "pi",
      presentationNonce: nonce,
      frame: { frameId, sequence: 1, columns, rows, byteLength: 64 },
      geometryRevision,
      attachmentEpoch: command.attachmentEpoch,
      cold: true,
      coldReassertion: undefined,
      ordering: { version: command.ordering.version, token: command.ordering.token, markerCodec: markers?.NATIVE_PRESENT_MARKER_CODEC },
    },
  };
}

/** A renderer frame id has the shape the codec requires, so a case cannot pass with a placeholder. */
function frameId() {
  return "1f2e3d4c-5b6a-4798-8899-aabbccddeeff";
}

it("reads the real published registry in this process and finds no producer, because that registry is Pi's own", async () => {
  if (!withCohort) return;
  // The accepted build's own function, called from the host process. API availability is not producer
  // availability, and this is what makes the placement statement above a fact rather than a claim.
  const snapshot = markers.nativeInputTargetSnapshot();
  expect(snapshot.apiVersion).toBe(markers.NATIVE_INPUT_TARGET_API_VERSION);
  expect(snapshot.producerVersion).toBe(null);
  expect(snapshot.target).toBe(null);
  expect(snapshot.reason).toBe("producer-absent");

  const { owner, host: created } = consumerHost({ registry: { snapshot: () => markers.nativeInputTargetSnapshot(), subscribe: (/** @type {any} */ listener) => markers.subscribeNativeInputTarget(listener) } });
  const a = attach(created, "a");
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("x") })).toMatchObject({
    delivered: false,
    admitted: null,
    reason: "input-target-unavailable",
    targetReason: "producer-absent",
    producerVersion: null,
  });
  // No unlabelled fallback: nothing this client typed reached the master.
  expect(owner.writes).toEqual([]);
  expect(created.capabilityReport().inputTarget).toMatchObject({ route: "published-registry", apiVersion: 1, producerVersion: null, available: false, reason: "producer-absent" });
});

it("dispatches labelled input through a publication and keeps a revoked handle's bytes with their sender", async () => {
  const published = publishedInputTargetRegistry();
  const { owner, host: created } = consumerHost({ registry: published.registry });
  const a = attach(created, "a");

  // Before a producer publishes there is no target, and the refusal names the registry's own reason.
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("early") })).toMatchObject({ reason: "input-target-unavailable", targetReason: "producer-absent" });

  const publication = published.mountProducer();
  const admitted = /** @type {any} */ (await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("typed") }));
  expect(admitted).toMatchObject({ delivered: true, admitted: true, consumedThrough: 5 });
  expect(admitted.publication).toEqual(publication);
  expect(published.dispatched.map((entry) => Buffer.from(entry.bytes).toString("latin1"))).toEqual(["typed"]);

  // Synchronous revocation: the handle refuses itself, carries no consumedThrough, and the span stays the
  // sender's to deliver once.
  published.revoke();
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("after") })).toMatchObject({ reason: "input-target-unavailable", targetReason: "revoked" });
  expect(published.dispatched).toHaveLength(1);
  expect(owner.writes).toEqual([]);
});

it("names every registry state the published contract declares, and never infers support from the API version", async () => {
  const published = publishedInputTargetRegistry();
  const { host: created } = consumerHost({ registry: published.registry });
  const a = attach(created, "a");
  published.mountProducer();
  const registration = published.registerHost();

  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("one") })).toMatchObject({ delivered: true });
  const first = created.capabilityReport().inputTarget.publication.sequence;

  // Registration rotates the publication for a new host rather than restarting the renderer.
  published.replaceHost();
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("two") })).toMatchObject({ reason: "input-target-unavailable", targetReason: "host-replaced" });

  const second = published.registerHost();
  expect(created.capabilityReport().inputTarget.publication.sequence).toBeGreaterThan(first);
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("three") })).toMatchObject({ delivered: true });

  second.release();
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("four") })).toMatchObject({ reason: "input-target-unavailable", targetReason: "host-released" });
  registration.release();
});

it("refuses labelled input by seam G's own reason while a handoff has closed admission", async () => {
  const published = publishedInputTargetRegistry();
  published.mountProducer();
  const { host: created } = consumerHost({ registry: published.registry });
  const a = attach(created, "a");
  published.closeHandoff(true);

  const refused = await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("into the child") });
  expect(refused).toMatchObject({ delivered: false, admitted: false, reason: "handoff-closed" });
  // The drain closed the terminal's admission, not the publication: the bytes are still the sender's, handed
  // out exactly once.
  expect(created.takeRefusedInput().map((span) => Buffer.from(span.bytes).toString("latin1"))).toEqual(["into the child"]);
  expect(created.takeRefusedInput()).toEqual([]);

  published.closeHandoff(false);
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("back") })).toMatchObject({ delivered: true });
});

it("fails closed on a registry state this copy cannot interpret, instead of reporting no target", async () => {
  const published = publishedInputTargetRegistry({ unsupportedState: true });
  const { owner, host: created } = consumerHost({ registry: published.registry });
  const a = attach(created, "a");
  expect(await created.deliverInput({ epoch: a.result.epoch, bytes: bytes("x") })).toMatchObject({ reason: "input-target-unavailable", targetReason: "registry-unsupported" });
  expect(created.capabilityReport().inputTarget).toMatchObject({ reason: "registry-unsupported", available: false });
  expect(owner.writes).toEqual([]);
});

it("activates ordered presentation only against a protocol-2 hello that declares this build's own framing", async () => {
  if (!withCohort) return;
  const two = await openChannel({ protocol: 2 });
  const { host: active } = consumerHost({ channel: two.channel, presentMarkers: markers });
  expect(active.capabilityReport().orderedPresentation).toEqual({
    active: true,
    protocol: 2,
    version: markers.NATIVE_PRESENT_ORDERING_VERSION,
    markerCodec: markers.NATIVE_PRESENT_MARKER_CODEC,
    tokenBytes: markers.NATIVE_PRESENT_TOKEN_BYTES,
    maxMarkerBytes: markers.NATIVE_PRESENT_MARKER_MAX_BYTES,
    freshChunkMax: markers.NATIVE_PRESENT_FRESH_CHUNK_MAX,
  });
  expect(active.capabilityReport().missing).not.toContain(MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary);

  // An old Pi ignores the selector and sends its protocol-1 hello. That is compatible, not a failure, and not
  // one ordered command may be sent on it.
  const one = await openChannel({ protocol: 1 });
  const { host: compatible } = consumerHost({ channel: one.channel, presentMarkers: markers });
  expect(compatible.capabilityReport().orderedPresentation).toEqual({ active: false, reason: "bootstrap-protocol-1" });
  const a = attach(compatible, "a");
  expect(await compatible.presentOrderedTo(a.result.epoch)).toMatchObject({ presented: false, refusal: "ordered-presentation-unavailable", reason: "bootstrap-protocol-1" });
  expect(one.commands).toEqual([]);
  expect(compatible.acknowledgePresentation(a.result.epoch, "frame-1")).toMatchObject({ cleared: false, missingCapability: MISSING_HOST_CAPABILITIES.presentationDeliveryBoundary });

  // A hello whose declared bounds are not this build's is refused by the field that differs, never downgraded.
  const mismatched = await openChannel({ protocol: 2, orderedPresentation: { version: 1, markerCodec: markers.NATIVE_PRESENT_MARKER_CODEC, tokenBytes: 32, maxMarkerBytes: 128, freshChunkMax: 4096 } });
  const { host: refused } = consumerHost({ channel: mismatched.channel, presentMarkers: markers });
  expect(refused.capabilityReport().orderedPresentation).toEqual({ active: false, reason: "ordered-presentation-mismatch:freshChunkMax" });
});

it("clears resync only after a matching control result and the matching observed END, in either order", async () => {
  if (!withCohort) return;
  const nonce = "presentation-nonce-1";
  const identity = frameId();
  const channel = await openChannel({ protocol: 2, answer: (/** @type {any} */ command) => orderedResult(command, { frameId: identity, nonce }) });
  const { host: created } = consumerHost({ channel: channel.channel, presentMarkers: markers });

  const client = terminalOutputClient({ stall: true });
  const slow = /** @type {{ attached: true, epoch: any }} */ (created.attach({ attachmentId: "recovering", sink: client.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  const live = attach(created, "live");
  // A burst the client has not finished writing carries its own queue past the cap, which is what marks it
  // resync-required. It stays a member and stays input-eligible (G-A6).
  created.broadcastOwnerOutput(bytes("x".repeat(2048)));
  client.releaseWrites();
  expect(created.attachments().find((entry) => entry.attachmentId === "recovering")).toMatchObject({ state: "resync-required", inputEligible: true });
  const acceptedBeforeRecovery = client.acceptedBytes();

  const presented = /** @type {any} */ (await created.presentOrderedTo(slow.epoch));
  expect(presented).toMatchObject({ presented: true, recoveryArmed: true, acknowledgeable: false, presentationNonce: nonce });
  expect(channel.commands).toHaveLength(1);
  expect(channel.commands[0]).toMatchObject({ type: "present-ordered", protocol: 2, coldTerminal: true, ordering: { version: 1 } });
  expect(markers.isNativePresentToken(channel.commands[0].ordering.token)).toBe(true);

  // Control first, bytes second. Ordinary output before BEGIN still goes to the live member only.
  created.broadcastOwnerOutput(bytes("ordinary"));
  expect(client.acceptedBytes()).toBe(acceptedBeforeRecovery);
  expect(live.client.text()).toContain("ordinary");

  const token = presented.ordering.token;
  created.broadcastOwnerOutput(bytes(markers.encodeNativePresentBegin(token)));
  expect(created.recoveryState()).toMatchObject({ observedBegin: true, observedEnd: false, controlResult: true, acknowledgeable: false });
  // Early acknowledgement is refused: the frame boundary has not closed.
  expect(created.acknowledgePresentation(slow.epoch, nonce)).toMatchObject({ cleared: false, reason: "frame-boundary-not-observed" });

  created.broadcastOwnerOutput(bytes("FRESH-FRAME"));
  created.broadcastOwnerOutput(bytes(markers.encodeNativePresentEnd(token, identity)));
  expect(created.recoveryState()).toMatchObject({ observedEnd: true, acknowledgeable: true, freshBytes: 11 });
  // The fresh frame reached the recovering client's own terminal and nobody else's, and the markers themselves
  // are never forwarded.
  expect(client.acceptedText().endsWith("FRESH-FRAME")).toBe(true);
  expect(live.client.text()).not.toContain("FRESH-FRAME");
  expect(client.acceptedText()).not.toContain("pi-native-present");
  // Still nothing is live before the client acknowledges.
  expect(created.attachments().find((entry) => entry.attachmentId === "recovering")).toMatchObject({ state: "resync-required" });

  expect(client.acknowledgeable()).toBe(true);
  expect(created.acknowledgePresentation(slow.epoch, nonce)).toEqual({ cleared: true, reason: null });
  expect(created.attachments().find((entry) => entry.attachmentId === "recovering")).toMatchObject({ state: "live" });
  expect(created.recoveryState()).toBe(null);
  expect(created.recoveryCounts()).toMatchObject({ armed: 1, cleared: 1, failed: 0 });
});

it("accepts the byte half before the control half, and only then records the acknowledgement it expects", async () => {
  if (!withCohort) return;
  const nonce = "presentation-nonce-2";
  const identity = frameId();
  /** @type {((frame: any) => void)[]} */
  const held = [];
  const channel = await openChannel({
    protocol: 2,
    answer: (/** @type {any} */ command) => new Promise((resolve) => held.push(() => resolve(orderedResult(command, { frameId: identity, nonce })))),
  });
  const { host: created } = consumerHost({ channel: channel.channel, presentMarkers: markers });
  const client = terminalOutputClient({ stall: true });
  const slow = /** @type {{ attached: true, epoch: any }} */ (created.attach({ attachmentId: "recovering", sink: client.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  created.broadcastOwnerOutput(bytes("x".repeat(2048)));
  client.releaseWrites();

  const commandArrived = channel.nextCommand();
  const pending = created.presentOrderedTo(slow.epoch);
  const token = /** @type {any} */ (created.recoveryState()).token;
  await commandArrived;
  // The whole frame, including END, arrives before the control result. That is not success yet.
  created.broadcastOwnerOutput(bytes(`${markers.encodeNativePresentBegin(token)}FRESH${markers.encodeNativePresentEnd(token, identity)}`));
  expect(created.recoveryState()).toMatchObject({ observedEnd: true, controlResult: false, acknowledgeable: false });
  expect(created.acknowledgePresentation(slow.epoch, nonce)).toMatchObject({ cleared: false, reason: "control-result-outstanding" });

  for (const release of held.splice(0)) release(undefined);
  expect(await pending).toMatchObject({ presented: true, recoveryArmed: true, acknowledgeable: true });
  expect(created.acknowledgePresentation(slow.epoch, nonce)).toEqual({ cleared: true, reason: null });
  expect(client.acceptedText().endsWith("FRESH")).toBe(true);
});

it("leaves an observed END failed when the control half is negative, aborted or lost", async () => {
  if (!withCohort) return;
  const identity = frameId();
  // A negative result: a complete END was observed, and the attempt still failed.
  const negative = await openChannel({
    protocol: 2,
    answer: (/** @type {any} */ command) => ({ type: "presentation-result", protocol: 2, requestId: command.requestId, ordering: { version: 1, token: command.ordering.token }, result: { presented: false, terminalOwner: "pi", presentationNonce: null, refusal: "no-complete-frame-support", childAcknowledgement: "not-applicable" } }),
  });
  const { host: refusedHost } = consumerHost({ channel: negative.channel, presentMarkers: markers });
  const refusedClient = terminalOutputClient({ stall: true });
  const refusedMember = /** @type {{ attached: true, epoch: any }} */ (refusedHost.attach({ attachmentId: "recovering", sink: refusedClient.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  refusedHost.broadcastOwnerOutput(bytes("x".repeat(2048)));
  refusedClient.releaseWrites();
  expect(await refusedHost.presentOrderedTo(refusedMember.epoch)).toMatchObject({ presented: false, refusal: "no-complete-frame-support" });
  expect(refusedHost.recoveryState()).toBe(null);
  expect(refusedHost.acknowledgePresentation(refusedMember.epoch, "anything")).toMatchObject({ cleared: false, reason: "no-armed-recovery" });
  expect(refusedHost.attachments()[0]).toMatchObject({ state: "resync-required" });

  // An ABORT on the byte route after a successful control result: the attempt failed and no nonce survives it.
  const nonce = "presentation-nonce-3";
  const aborted = await openChannel({ protocol: 2, answer: (/** @type {any} */ command) => orderedResult(command, { frameId: identity, nonce }) });
  const { host: abortedHost } = consumerHost({ channel: aborted.channel, presentMarkers: markers });
  const abortedClient = terminalOutputClient({ stall: true });
  const abortedMember = /** @type {{ attached: true, epoch: any }} */ (abortedHost.attach({ attachmentId: "recovering", sink: abortedClient.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  abortedHost.broadcastOwnerOutput(bytes("x".repeat(2048)));
  abortedClient.releaseWrites();
  const armed = /** @type {any} */ (await abortedHost.presentOrderedTo(abortedMember.epoch));
  const token = armed.ordering.token;
  abortedHost.broadcastOwnerOutput(bytes(`${markers.encodeNativePresentBegin(token)}PART`));
  abortedHost.broadcastOwnerOutput(bytes(markers.encodeNativePresentAbort(token)));
  expect(abortedHost.recoveryState()).toBe(null);
  expect(abortedHost.acknowledgePresentation(abortedMember.epoch, nonce)).toMatchObject({ cleared: false, reason: "no-armed-recovery" });
  expect(abortedHost.attachments()[0]).toMatchObject({ state: "resync-required" });
  expect(abortedHost.recoveryCounts()).toMatchObject({ failed: 1, cleared: 0 });

  // A lost control transport is uncertain, not success.
  const lost = await openChannel({ protocol: 2, answer: () => undefined });
  const { host: lostHost } = consumerHost({ channel: lost.channel, presentMarkers: markers });
  const lostMember = attach(lostHost, "recovering");
  const pending = lostHost.presentOrderedTo(lostMember.result.epoch);
  await new Promise((resolve) => setImmediate(resolve));
  lost.loseTransport();
  await expect(pending).resolves.toMatchObject({ presented: false });
});

it("invalidates a proved attempt when ordinary output the member could not receive follows its END", async () => {
  if (!withCohort) return;
  const nonce = "presentation-nonce-4";
  const identity = frameId();
  const channel = await openChannel({ protocol: 2, answer: (/** @type {any} */ command) => orderedResult(command, { frameId: identity, nonce }) });
  const { host: created } = consumerHost({ channel: channel.channel, presentMarkers: markers });
  const client = terminalOutputClient({ stall: true });
  const slow = /** @type {{ attached: true, epoch: any }} */ (created.attach({ attachmentId: "recovering", sink: client.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  created.broadcastOwnerOutput(bytes("x".repeat(2048)));
  client.releaseWrites();
  const armed = /** @type {any} */ (await created.presentOrderedTo(slow.epoch));
  const token = armed.ordering.token;
  created.broadcastOwnerOutput(bytes(`${markers.encodeNativePresentBegin(token)}FRESH${markers.encodeNativePresentEnd(token, identity)}`));
  expect(created.recoveryState()).toMatchObject({ acknowledgeable: true });

  // Post-END ordinary output is skipped for a resync-required member, so its screen is behind again. The known
  // liveness cost of Task 11 stands: this attempt can no longer be acknowledged.
  created.broadcastOwnerOutput(bytes("later ordinary output"));
  expect(created.recoveryState()).toBe(null);
  expect(created.acknowledgePresentation(slow.epoch, nonce)).toMatchObject({ cleared: false, reason: "no-armed-recovery" });
  expect(created.attachments()[0]).toMatchObject({ state: "resync-required" });
  expect(created.recoveryCounts()).toMatchObject({ failed: 1, cleared: 0 });
});

it("refuses a second recovery while one is armed, and retires an armed attempt on detach or replacement", async () => {
  if (!withCohort) return;
  const nonce = "presentation-nonce-5";
  const identity = frameId();
  const channel = await openChannel({ protocol: 2, answer: (/** @type {any} */ command) => orderedResult(command, { frameId: identity, nonce }) });
  const { host: created } = consumerHost({ channel: channel.channel, presentMarkers: markers });
  const client = terminalOutputClient({ stall: true });
  const first = /** @type {{ attached: true, epoch: any }} */ (created.attach({ attachmentId: "recovering", sink: client.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  created.broadcastOwnerOutput(bytes("x".repeat(2048)));
  client.releaseWrites();
  const armed = /** @type {any} */ (await created.presentOrderedTo(first.epoch));
  expect(armed.recoveryArmed).toBe(true);

  // Bounded admission: an armed stream is never silently replaced.
  expect(await created.presentOrderedTo(first.epoch)).toMatchObject({ presented: false, refusal: "recovery-already-armed" });
  expect(created.recoveryState()).toMatchObject({ token: armed.ordering.token });
  expect(channel.commands).toHaveLength(1);

  // A replacement for the same id retires it: the new connection is never handed the old attempt's frame.
  const replacement = terminalOutputClient();
  created.attach({ attachmentId: "recovering", sink: replacement.sink, declared: { capabilities: { ...CAPABILITIES } } });
  expect(created.recoveryState()).toBe(null);
  expect(created.acknowledgePresentation(first.epoch, nonce)).toMatchObject({ cleared: false, reason: "no-armed-recovery" });
  // The retired attempt's framing is nobody's frame now: the replacement receives those bytes as ordinary
  // verbatim output, markers included, and no recovery is armed for it.
  const stale = `${markers.encodeNativePresentBegin(armed.ordering.token)}STALE`;
  created.broadcastOwnerOutput(bytes(stale));
  expect(replacement.acceptedText().endsWith(stale)).toBe(true);
  expect(created.recoveryState()).toBe(null);
});

it("hands a fresh frame to one client in bounded chunks, and keeps marker-like text verbatim for everyone else", async () => {
  if (!withCohort) return;
  const nonce = "presentation-nonce-6";
  const identity = frameId();
  const channel = await openChannel({ protocol: 2, answer: (/** @type {any} */ command) => orderedResult(command, { frameId: identity, nonce }) });
  const { host: created } = consumerHost({ channel: channel.channel, presentMarkers: markers });
  const client = terminalOutputClient({ highWaterMark: 16, stall: true });
  const slow = /** @type {{ attached: true, epoch: any }} */ (created.attach({ attachmentId: "recovering", sink: client.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  const live = attach(created, "live");
  created.broadcastOwnerOutput(bytes("x".repeat(2048)));
  client.releaseWrites();
  const liveBefore = live.client.text();
  const acceptedBeforeFrame = client.acceptedBytes();

  const armed = /** @type {any} */ (await created.presentOrderedTo(slow.epoch));
  const token = armed.ordering.token;
  const begin = markers.encodeNativePresentBegin(token);
  // Split BEGIN across two reads: where a read boundary fell is not part of the framing.
  created.broadcastOwnerOutput(bytes(begin.slice(0, 9)));
  created.broadcastOwnerOutput(bytes(begin.slice(9)));
  const frame = "F".repeat(markers.NATIVE_PRESENT_FRESH_CHUNK_MAX + 321);
  created.broadcastOwnerOutput(bytes(frame));
  created.broadcastOwnerOutput(bytes(markers.encodeNativePresentEnd(token, identity)));

  const state = /** @type {any} */ (created.recoveryState());
  expect(state).toMatchObject({ observedBegin: true, observedEnd: true, freshBytes: frame.length });
  // Bounded route: the frame was handed over in ceil(length / freshChunkMax) chunks, none of them larger.
  expect(state.freshChunks).toBe(Math.ceil(frame.length / markers.NATIVE_PRESENT_FRESH_CHUNK_MAX));
  expect(client.acceptedBytes() - acceptedBeforeFrame).toBe(frame.length);
  expect(created.acknowledgePresentation(slow.epoch, nonce)).toEqual({ cleared: true, reason: null });
  // The live member saw none of the fresh frame and no marker bytes at all.
  expect(live.client.text()).toBe(liveBefore);

  // Marker-like terminal text that is not this attempt's framing is ordinary output, byte for byte.
  const impostor = `${markers.encodeNativePresentBegin(markers.mintNativePresentToken())}plain`;
  created.broadcastOwnerOutput(bytes(impostor));
  expect(live.client.text()).toBe(`${liveBefore}${impostor}`);
});

it("refuses an acknowledgement whose nonce is not the one this attempt recorded", async () => {
  if (!withCohort) return;
  const nonce = "presentation-nonce-7";
  const identity = frameId();
  const channel = await openChannel({ protocol: 2, answer: (/** @type {any} */ command) => orderedResult(command, { frameId: identity, nonce }) });
  const { host: created } = consumerHost({ channel: channel.channel, presentMarkers: markers });
  const client = terminalOutputClient({ stall: true });
  const slow = /** @type {{ attached: true, epoch: any }} */ (created.attach({ attachmentId: "recovering", sink: client.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  created.broadcastOwnerOutput(bytes("x".repeat(2048)));
  client.releaseWrites();
  const armed = /** @type {any} */ (await created.presentOrderedTo(slow.epoch));
  created.broadcastOwnerOutput(bytes(`${markers.encodeNativePresentBegin(armed.ordering.token)}FRESH${markers.encodeNativePresentEnd(armed.ordering.token, identity)}`));

  expect(created.acknowledgePresentation(slow.epoch, "another-nonce")).toEqual({ cleared: false, reason: "acknowledgement-not-current" });
  expect(created.attachments()[0]).toMatchObject({ state: "resync-required" });
  // A stale epoch for the same id is refused as well: this attempt belongs to one exact connection.
  expect(created.acknowledgePresentation({ attachmentId: "recovering", epoch: slow.epoch.epoch + 1 }, nonce)).toMatchObject({ cleared: false, reason: "no-armed-recovery" });
});

it("refuses an ordered presentation for a frame receipt built at another geometry", async () => {
  if (!withCohort) return;
  const channel = await openChannel({ protocol: 2, answer: (/** @type {any} */ command) => orderedResult(command, { frameId: frameId(), nonce: "presentation-nonce-8", columns: 80, rows: 24 }) });
  const { host: created } = consumerHost({ channel: channel.channel, presentMarkers: markers });
  const client = terminalOutputClient({ stall: true });
  const slow = /** @type {{ attached: true, epoch: any }} */ (created.attach({ attachmentId: "recovering", sink: client.sink, declared: { capabilities: { ...CAPABILITIES } } }));
  created.broadcastOwnerOutput(bytes("x".repeat(2048)));
  client.releaseWrites();
  expect(await created.presentOrderedTo(slow.epoch)).toMatchObject({ presented: true, stale: true, recoveryArmed: false });
  expect(created.recoveryState()).toBe(null);
  expect(created.acknowledgePresentation(slow.epoch, "presentation-nonce-8")).toMatchObject({ cleared: false, reason: "no-armed-recovery" });
});
