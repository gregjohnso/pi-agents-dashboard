import { expect, it } from "vitest";

import {
  admitClient,
  createLaunchFixedProfile,
  createResponseLedger,
  PROFILE_CAPABILITIES,
  PROFILE_COVERAGE_GAPS,
  profileModeInitialization,
  REQUIRED_CAPABILITIES,
  TerminalProfileError,
} from "./terminal-profile.mjs";

/** Every capability a full profile declares, so a case can turn exactly one of them off. */
const EVERY_CAPABILITY = {
  kittyKeyboard: true,
  kittyGraphics: true,
  mouse: true,
  bracketedPaste: true,
  synchronizedOutput: true,
  trueColor: true,
};

/** @param {Partial<typeof EVERY_CAPABILITY>} [overrides] */
function profile(overrides = {}) {
  return createLaunchFixedProfile({
    profileId: "task12-owner",
    term: "xterm-256color",
    capabilities: { ...EVERY_CAPABILITY, ...overrides },
    cellSize: null,
  });
}

/** @param {string} text */
function bytes(text) {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

it("freezes the launch profile it was handed, so mutating the caller's record moves nothing", () => {
  const capabilities = { ...EVERY_CAPABILITY };
  const fixed = createLaunchFixedProfile({ profileId: "task12-owner", term: "xterm-256color", capabilities, cellSize: { width: 9, height: 19 } });
  capabilities.mouse = false;
  expect(fixed.capabilities.mouse).toBe(true);
  expect(Object.isFrozen(fixed)).toBe(true);
  expect(Object.isFrozen(fixed.capabilities)).toBe(true);
  expect(fixed.cellSize).toEqual({ width: 9, height: 19 });
  expect(() => {
    /** @type {any} */ (fixed).profileId = "other";
  }).toThrow();
});

it("refuses a profile that would pass by disabling images, mouse or configured keys", () => {
  for (const capability of REQUIRED_CAPABILITIES) {
    let error;
    try {
      profile({ [capability]: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TerminalProfileError);
    expect(/** @type {TerminalProfileError} */ (error).code).toBe("PROFILE_FEATURE_DISABLED");
    expect(/** @type {TerminalProfileError} */ (error).message).toContain(capability);
  }
  expect(REQUIRED_CAPABILITIES).toEqual(expect.arrayContaining(["kittyGraphics", "kittyKeyboard", "mouse"]));
});

it("refuses a profile whose capability record is not exactly the declared set", () => {
  const { kittyGraphics: _dropped, ...missingOne } = EVERY_CAPABILITY;
  expect(() => createLaunchFixedProfile({ profileId: "p", term: "xterm", capabilities: /** @type {any} */ (missingOne), cellSize: null })).toThrow(TerminalProfileError);
  expect(() => createLaunchFixedProfile({ profileId: "p", term: "xterm", capabilities: /** @type {any} */ ({ ...EVERY_CAPABILITY, sixel: true }), cellSize: null })).toThrow(TerminalProfileError);
  expect(() => createLaunchFixedProfile({ profileId: "", term: "xterm", capabilities: EVERY_CAPABILITY, cellSize: null })).toThrow(TerminalProfileError);
  expect(() => createLaunchFixedProfile({ profileId: "p", term: "", capabilities: EVERY_CAPABILITY, cellSize: null })).toThrow(TerminalProfileError);
  expect(() => createLaunchFixedProfile({ profileId: "p", term: "xterm", capabilities: EVERY_CAPABILITY, cellSize: /** @type {any} */ ({ width: 0, height: 19 }) })).toThrow(TerminalProfileError);
  expect(PROFILE_CAPABILITIES).toHaveLength(6);
});

it("admits a client that declares every capability the profile declares", () => {
  expect(admitClient(profile(), { capabilities: { ...EVERY_CAPABILITY } })).toEqual({ admitted: true, missingCapabilities: [] });
});

it("admits a client that declares more than the profile does, because the profile still decides", () => {
  const fixed = profile({ kittyGraphics: true, synchronizedOutput: false });
  expect(admitClient(fixed, { capabilities: { ...EVERY_CAPABILITY } })).toEqual({ admitted: true, missingCapabilities: [] });
});

it("refuses a client by naming every capability it is missing, and never by dropping one from the profile", () => {
  const fixed = profile();
  const refusal = /** @type {{ admitted: false, missingCapabilities: string[], code: string }} */ (admitClient(fixed, { capabilities: { ...EVERY_CAPABILITY, kittyGraphics: false, mouse: false } }));
  expect(refusal.admitted).toBe(false);
  expect(refusal.missingCapabilities).toEqual(["kittyGraphics", "mouse"]);
  expect(refusal.code).toBe("NATIVE_ATTACHMENT_UNAVAILABLE");
  // The profile is unchanged by the refusal: nothing is negotiated down to make a client fit.
  expect(fixed.capabilities.kittyGraphics).toBe(true);
  expect(fixed.capabilities.mouse).toBe(true);
});

it("refuses an unreadable client declaration by naming the capabilities it never declared", () => {
  const fixed = profile();
  for (const declared of [null, undefined, "yes", { capabilities: null }, { capabilities: { kittyKeyboard: "true" } }]) {
    const refusal = /** @type {{ admitted: false, missingCapabilities: string[], code: string }} */ (admitClient(fixed, /** @type {any} */ (declared)));
    expect(refusal.admitted).toBe(false);
    expect(refusal.code).toBe("NATIVE_ATTACHMENT_UNAVAILABLE");
    expect(refusal.missingCapabilities).toEqual(PROFILE_CAPABILITIES.filter((name) => /** @type {any} */ (fixed.capabilities)[name]));
  }
});

it("writes only the client-owned modes the profile declares, and none of the renderer's", () => {
  const initialization = Buffer.from(profileModeInitialization(profile()));
  expect(initialization.toString("latin1")).toBe("\u001b[?2004h\u001b[?1002h\u001b[?1006h");
  // A profile with mouse reporting off cannot be launched, so the derivation is read from a profile-shaped
  // record: it must come from the declared capabilities and from nothing else.
  const withoutMouse = Buffer.from(profileModeInitialization(/** @type {any} */ ({ profileId: "p", term: "xterm", capabilities: { ...EVERY_CAPABILITY, mouse: false }, cellSize: null })));
  expect(withoutMouse.toString("latin1")).toBe("\u001b[?2004h");
  // Alt screen, autowrap, cursor visibility and the Kitty keyboard stack are the renderer's, re-emitted by
  // seam E's cold presentation. A host that emitted them here would be a second writer of Pi's own modes.
  for (const rendererOwned of ["?1049h", "?7l", "?25l", "=1;1u", ">1u"]) {
    expect(initialization.toString("latin1")).not.toContain(rendererOwned);
  }
});

it("never applies a terminal response, and counts a client's reply as a client reply", () => {
  const ledger = createResponseLedger();
  const decision = ledger.decide({ kind: "kitty-keyboard", requestEpoch: 1, attachmentEpoch: { attachmentId: "a", epoch: 1 }, raw: bytes("\u001b[?1u") });
  expect(decision).toEqual({ apply: false, reason: "client-reply" });
  expect(ledger.counts()).toEqual({ total: 1, clientReply: 1, staleRequestEpoch: 0, profileFixed: 0, unreadable: 0 });
});

it("counts a reply carrying an older request epoch than the newest one seen for that kind as stale", () => {
  const ledger = createResponseLedger();
  expect(ledger.decide({ kind: "da", requestEpoch: 4, attachmentEpoch: null, raw: bytes("\u001b[?62;c") })).toEqual({ apply: false, reason: "profile-fixed" });
  expect(ledger.highestRequestEpoch("da")).toBe(4);
  expect(ledger.decide({ kind: "da", requestEpoch: 3, attachmentEpoch: null, raw: bytes("\u001b[?62;c") })).toEqual({ apply: false, reason: "stale-request-epoch" });
  // Another kind keeps its own epoch line: a cell-size reply is not stale because a DA query came later.
  expect(ledger.decide({ kind: "cell-size", requestEpoch: 1, attachmentEpoch: null, raw: bytes("\u001b[6;19;9t") })).toEqual({ apply: false, reason: "profile-fixed" });
  expect(ledger.counts()).toEqual({ total: 3, clientReply: 0, staleRequestEpoch: 1, profileFixed: 2, unreadable: 0 });
});

it("counts an unreadable response record instead of guessing what it was", () => {
  const ledger = createResponseLedger();
  for (const response of [null, undefined, { kind: "da" }, { kind: "spoon", requestEpoch: 1, attachmentEpoch: null, raw: bytes("x") }, { kind: "da", requestEpoch: -1, attachmentEpoch: null, raw: bytes("x") }]) {
    expect(ledger.decide(/** @type {any} */ (response))).toEqual({ apply: false, reason: "unreadable" });
  }
  expect(ledger.counts().unreadable).toBe(5);
  expect(ledger.highestRequestEpoch("da")).toBe(0);
});

it("records the background-colour reply as coverage this profile does not enforce", () => {
  expect(PROFILE_COVERAGE_GAPS.map((gap) => gap.capability)).toEqual(["osc11-background-colour"]);
  const [gap] = PROFILE_COVERAGE_GAPS;
  expect(gap.covered).toBe(false);
  expect(gap.source).toContain("docs/native-input-interface.md");
  expect(Object.isFrozen(PROFILE_COVERAGE_GAPS)).toBe(true);
});
