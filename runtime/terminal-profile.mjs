/**
 * The launch-fixed virtual terminal profile one owner runs under, and what the host decides from it.
 *
 * Pi negotiates its terminal capabilities once, at startup. A client that attaches later missed that
 * exchange entirely, so the profile is fixed by the owner at launch and no attaching client can move it.
 * That is the recorded **G-A7** policy, and three facts decide the shape of this module:
 *
 * **A profile that passes by turning a feature off is a failed profile, not a passing one.** Images, mouse
 * reporting and the operator's configured keys are the product. `REQUIRED_CAPABILITIES` is therefore a
 * refusal at construction rather than a warning at attach time: a launch that declared `kittyGraphics: false`
 * would admit every client and lose the feature silently.
 *
 * **A client is refused by the name of what it is missing.** `admitClient` answers with every capability the
 * profile declares and the client did not, so the operator is told which capability to fix rather than that
 * attachment is unavailable. The owner keeps running through that refusal; nothing here stops or signals it.
 *
 * **Nothing here applies a terminal response.** `createResponseLedger` is the decision the host hands to
 * seam F's `beforeApplyTerminalResponse`, and it always refuses. Two separate reasons:
 *
 * - a reply that arrived from a client attachment is a late client answering a query it never saw, and
 * - a reply that arrived as ordinary local input still cannot be applied, because this host has no supported
 *   way to *answer* Pi's startup queries from the profile: Pi writes them to the terminal and the only way
 *   the host could recognise one is by parsing the owner's output, which is the substitute parser this design
 *   forbids. So Pi keeps whatever it negotiated and the profile is what the host itself obeys.
 *
 * **Boundary.** `PROFILE_COVERAGE_GAPS` names what this is therefore not: `OSC 11` background-colour replies
 * are excluded from seam F's hook altogether, so no decision here reaches them. Partial query filtering is
 * not complete profile enforcement, and this module says so rather than implying otherwise.
 */

/** @typedef {{ kittyKeyboard: boolean, kittyGraphics: boolean, mouse: boolean, bracketedPaste: boolean, synchronizedOutput: boolean, trueColor: boolean }} ProfileCapabilities */
/** @typedef {{ profileId: string, term: string, capabilities: ProfileCapabilities, cellSize: { width: number, height: number } | null }} VirtualTerminalProfile */
/** @typedef {"da" | "kitty-keyboard" | "cell-size" | "other"} TerminalResponseKind */
/** @typedef {{ kind: TerminalResponseKind, requestEpoch: number, attachmentEpoch: { attachmentId: string, epoch: number } | null, raw: Uint8Array }} TerminalResponseApplication */
/** @typedef {"client-reply" | "stale-request-epoch" | "profile-fixed" | "unreadable"} ResponseRefusalReason */

/** Every capability a profile declares, in the order a refusal names them. Seam F's own six, no more. */
export const PROFILE_CAPABILITIES = Object.freeze(["kittyKeyboard", "kittyGraphics", "mouse", "bracketedPaste", "synchronizedOutput", "trueColor"]);

/**
 * The three a profile may never declare false: images, the operator's configured keys, and mouse reporting.
 *
 * Named separately from the other three because they are the ones a passing profile could be bought with.
 * `bracketedPaste`, `synchronizedOutput` and `trueColor` are declared and obeyed, not required: a terminal
 * without true colour renders the product, and one without images or configured keys does not.
 */
export const REQUIRED_CAPABILITIES = Object.freeze(["kittyGraphics", "kittyKeyboard", "mouse"]);

/** The response kinds seam F classifies and hands to a decision. */
const RESPONSE_KINDS = Object.freeze(["da", "kitty-keyboard", "cell-size", "other"]);

/**
 * Profile coverage this host does not enforce, each with where that is stated.
 *
 * One entry today. It exists so a caller reports the gap rather than reading complete enforcement into a
 * partial hook; a row that depends on this being empty stays open.
 */
export const PROFILE_COVERAGE_GAPS = Object.freeze([
  Object.freeze({
    capability: "osc11-background-colour",
    covered: false,
    why: "seam F's beforeApplyTerminalResponse does not classify OSC 11 replies, so no host decision reaches them",
    source: "docs/native-input-interface.md, response and return rules",
  }),
]);

/** Modes a client's own terminal must have set for the profile to hold, by the capability that asks for them. */
const CLIENT_OWNED_MODES = Object.freeze({
  bracketedPaste: "\u001b[?2004h",
  mouse: "\u001b[?1002h\u001b[?1006h",
});

/** A refused profile, or a request this module cannot answer. Never a warning and never a default. */
export class TerminalProfileError extends Error {
  /** @param {string} message @param {{ code?: string, cause?: unknown }} [options] */
  constructor(message, { code = "TERMINAL_PROFILE", cause } = {}) {
    super(message, { cause });
    this.name = "TerminalProfileError";
    this.code = code;
  }
}

/** @param {unknown} value @param {string} name */
function requireIdentifier(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > 256) {
    throw new TerminalProfileError(`${name} must be a bounded non-empty identifier`, { code: "PROFILE_INVALID" });
  }
  return value;
}

/** @param {unknown} declared @returns {ProfileCapabilities} */
function requireCapabilities(declared) {
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    throw new TerminalProfileError("A profile declares a capability record", { code: "PROFILE_INVALID" });
  }
  const record = /** @type {Record<string, unknown>} */ (declared);
  const unknown = Object.keys(record).find((key) => !PROFILE_CAPABILITIES.includes(key));
  if (unknown !== undefined) {
    throw new TerminalProfileError(`A profile declares no capability named ${unknown}`, { code: "PROFILE_INVALID" });
  }
  /** @type {Record<string, boolean>} */
  const capabilities = {};
  for (const name of PROFILE_CAPABILITIES) {
    if (typeof record[name] !== "boolean") {
      throw new TerminalProfileError(`A profile must declare ${name} as a boolean`, { code: "PROFILE_INVALID" });
    }
    capabilities[name] = /** @type {boolean} */ (record[name]);
  }
  for (const name of REQUIRED_CAPABILITIES) {
    if (!capabilities[name]) {
      throw new TerminalProfileError(
        `A profile that declares ${name} false would pass a client by losing that feature, so it is refused`,
        { code: "PROFILE_FEATURE_DISABLED" },
      );
    }
  }
  return /** @type {ProfileCapabilities} */ (capabilities);
}

/** @param {unknown} cellSize */
function requireCellSize(cellSize) {
  if (cellSize === null || cellSize === undefined) return null;
  const record = /** @type {Record<string, unknown>} */ (cellSize);
  if (typeof cellSize !== "object" || Array.isArray(cellSize) || Object.keys(record).some((key) => !["width", "height"].includes(key))) {
    throw new TerminalProfileError("A profile cell size is a width and a height, or null", { code: "PROFILE_INVALID" });
  }
  for (const name of ["width", "height"]) {
    const value = record[name];
    if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) {
      throw new TerminalProfileError(`A profile cell ${name} must be a positive safe integer`, { code: "PROFILE_INVALID" });
    }
  }
  return Object.freeze({ width: /** @type {number} */ (record.width), height: /** @type {number} */ (record.height) });
}

/**
 * Fix one profile for the whole life of one owner.
 *
 * The returned record is frozen and copied out of the caller's objects, so the profile a host registered and
 * the profile it keeps answering with cannot drift apart by a later mutation.
 *
 * @param {{ profileId: string, term: string, capabilities: ProfileCapabilities, cellSize?: { width: number, height: number } | null }} options
 * @returns {VirtualTerminalProfile}
 */
export function createLaunchFixedProfile({ profileId, term, capabilities, cellSize = null }) {
  return Object.freeze({
    profileId: requireIdentifier(profileId, "profileId"),
    term: requireIdentifier(term, "term"),
    capabilities: Object.freeze(requireCapabilities(capabilities)),
    cellSize: requireCellSize(cellSize),
  });
}

/** @param {VirtualTerminalProfile} profile */
function requireProfile(profile) {
  if (typeof profile !== "object" || profile === null || typeof profile.profileId !== "string" || typeof profile.capabilities !== "object" || profile.capabilities === null) {
    throw new TerminalProfileError("A launch-fixed profile is required", { code: "PROFILE_INVALID" });
  }
  for (const name of PROFILE_CAPABILITIES) {
    if (typeof profile.capabilities[/** @type {keyof ProfileCapabilities} */ (name)] !== "boolean") {
      throw new TerminalProfileError(`A launch-fixed profile must declare ${name}`, { code: "PROFILE_INVALID" });
    }
  }
  return profile;
}

/**
 * Decide whether one client may attach to an owner running this profile.
 *
 * A client must declare every capability the profile declares. It may declare more — the profile still
 * decides what Pi believes — and it is never refused for that. A refusal names every capability it is
 * missing, which is what **G-A7** requires; it is never answered by dropping one from the profile.
 *
 * An unreadable declaration is a refusal rather than a throw: it came from a client. Every capability the
 * profile requires is then named, because the client declared none of them.
 *
 * @param {VirtualTerminalProfile} profile
 * @param {{ capabilities?: Partial<ProfileCapabilities> }} declared
 * @returns {{ admitted: true, missingCapabilities: [] } | { admitted: false, missingCapabilities: string[], code: string }}
 */
export function admitClient(profile, declared) {
  const fixed = requireProfile(profile);
  const required = PROFILE_CAPABILITIES.filter((name) => fixed.capabilities[/** @type {keyof ProfileCapabilities} */ (name)]);
  const record = typeof declared === "object" && declared !== null ? /** @type {Record<string, unknown>} */ (declared.capabilities) : undefined;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { admitted: false, missingCapabilities: required, code: "NATIVE_ATTACHMENT_UNAVAILABLE" };
  }
  const missingCapabilities = required.filter((name) => record[name] !== true);
  if (missingCapabilities.length > 0) {
    return { admitted: false, missingCapabilities, code: "NATIVE_ATTACHMENT_UNAVAILABLE" };
  }
  return { admitted: true, missingCapabilities: [] };
}

/**
 * The modes a newly attached client's own terminal needs, derived from the profile and nothing else.
 *
 * Only client-owned modes are here. Alt-screen entry, autowrap, cursor visibility, synchronized-output
 * framing and the Kitty keyboard stack belong to Pi's renderer and terminal, which re-emit them on a cold
 * presentation (seam E). A host that wrote those would be a second writer of Pi's own modes, and a second
 * push of the Kitty keyboard stack would leave every terminal that received the first one unbalanced.
 *
 * @param {VirtualTerminalProfile} profile
 * @returns {Uint8Array}
 */
export function profileModeInitialization(profile) {
  const fixed = requireProfile(profile);
  let modes = "";
  for (const [capability, sequence] of Object.entries(CLIENT_OWNED_MODES)) {
    if (fixed.capabilities[/** @type {keyof ProfileCapabilities} */ (capability)]) modes += sequence;
  }
  return new Uint8Array(Buffer.from(modes, "latin1"));
}

/** @param {unknown} response @returns {TerminalResponseApplication | null} */
function readResponse(response) {
  if (typeof response !== "object" || response === null) return null;
  const record = /** @type {Record<string, unknown>} */ (response);
  if (typeof record.kind !== "string" || !RESPONSE_KINDS.includes(record.kind)) return null;
  if (!Number.isSafeInteger(record.requestEpoch) || /** @type {number} */ (record.requestEpoch) < 0) return null;
  if (!(record.raw instanceof Uint8Array)) return null;
  const origin = record.attachmentEpoch;
  if (origin !== null) {
    if (typeof origin !== "object" || origin === null) return null;
    const epoch = /** @type {Record<string, unknown>} */ (origin);
    if (typeof epoch.attachmentId !== "string" || !Number.isSafeInteger(epoch.epoch)) return null;
  }
  return /** @type {TerminalResponseApplication} */ (response);
}

/**
 * The host's terminal-response decision, and the count of every refusal by reason.
 *
 * Nothing is applied and nothing is parsed: a decision is made from the classified record seam F hands over,
 * which is why a response-shaped byte run inside a paste body never reaches this ledger at all — Pi decided
 * it was text. The highest request epoch seen per kind is the only state, and it is what makes a reply to a
 * superseded query distinguishable from a reply to the current one.
 */
export function createResponseLedger() {
  /** @type {Map<string, number>} */
  const highest = new Map();
  const counts = { total: 0, clientReply: 0, staleRequestEpoch: 0, profileFixed: 0, unreadable: 0 };

  /** @param {ResponseRefusalReason} reason @returns {{ apply: false, reason: ResponseRefusalReason }} */
  const refuse = (reason) => {
    counts.total += 1;
    if (reason === "client-reply") counts.clientReply += 1;
    else if (reason === "stale-request-epoch") counts.staleRequestEpoch += 1;
    else if (reason === "profile-fixed") counts.profileFixed += 1;
    else counts.unreadable += 1;
    return { apply: false, reason };
  };

  return Object.freeze({
    /**
     * Refuse one classified response, by the first reason that describes it.
     *
     * @param {unknown} response
     * @returns {{ apply: false, reason: ResponseRefusalReason }}
     */
    decide(response) {
      const readable = readResponse(response);
      if (readable === null) return refuse("unreadable");
      if (readable.attachmentEpoch !== null) return refuse("client-reply");
      const seen = highest.get(readable.kind) ?? 0;
      if (readable.requestEpoch < seen) return refuse("stale-request-epoch");
      highest.set(readable.kind, readable.requestEpoch);
      return refuse("profile-fixed");
    },

    /** The newest request epoch seen for one response kind, or 0 when none has been. @param {string} kind */
    highestRequestEpoch(kind) {
      return highest.get(kind) ?? 0;
    },

    counts() {
      return { ...counts };
    },
  });
}
