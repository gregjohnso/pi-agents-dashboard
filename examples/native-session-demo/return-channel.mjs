/**
 * How "leave this terminal, keep the session running" travels from a keystroke to the manager.
 *
 * Three facts have to meet, and they live in three different places:
 *
 *   - the **gesture** is Pi's own. `pi.registerShortcut` is public extension API, and the bundled editor
 *     consults extension shortcuts *first* in `CustomEditor.handleInput`, ahead of every built-in keybinding
 *     and ahead of inserting text. So nothing here parses a key, competes with the editor, or touches the
 *     operator's draft: Pi recognises the shortcut and calls a handler.
 *   - the **origin** is Pi's too, and that is the whole point of this file. It is the parsed sequence's
 *     `NativeInputProvenance`, taken from the public input listener, not anything this demo infers.
 *   - the **channel** is the pre-TUI caller's: it already holds the authenticated socket to the manager.
 *
 * The extension and the pre-TUI caller are two module instances in one process by construction, so they meet
 * on one registered symbol, the same way `tui-handover.mjs` shares the public TUI. This is the demo's own
 * container. Nothing in it reads a private field, decodes an escape sequence or infers state from output.
 *
 * ## Why the provenance has to come from Pi
 *
 * An earlier version of this file tracked raw dispatch spans in a FIFO and attributed a gesture to the oldest
 * outstanding one. That was wrong twice, and both are now regression cases:
 *
 *   - `dispatchNativeInput` calls `releaseTurn()` in a `finally`, which runs *before* its returned promise
 *     settles. A second dispatch's turn therefore begins before the first span's retirement callback runs, so
 *     a gesture from B was attributed to A.
 *   - native framing assembles one sequence from bytes that may have arrived in different spans. A supplying
 *     `ESC [ 2 0` and B supplying `~` produces one F9 whose bytes came from two attachments. No raw-span
 *     bookkeeping can name that sequence's origin, because it does not have one.
 *
 * Pi already computes the answer: `handleTerminalInput` holds the sequence's provenance, including
 * `mixedOrigin` and `mixedBindingGeneration`. Patch 0007 passes it to the public input listener, so this file
 * reads it rather than reconstructing it. There is no fallback to span tracking: without provenance the
 * gesture refuses.
 */

const CONTAINER = Symbol.for("pi-agents:native-session-demo/return-channel");
const VERSION = 2;

/**
 * The key this demo asks Pi to recognise for "return to the list".
 *
 * A function key on purpose. Pi's built-in keybindings bind no `f1`-`f12` (see the bundled
 * `docs/keybindings.md`), so this claims nothing the editor or the application already owns, and Pi itself
 * skips an extension shortcut that collides with a protected built-in. A function key also needs no modifier
 * disambiguation: `ctrl+shift+<letter>` collapses onto the unshifted control byte in terminals without the
 * Kitty keyboard protocol, which would make the gesture ambiguous with a key that is bound.
 */
export const RETURN_SHORTCUT = "f9";

/** @returns {{ version: number, request: ((origin: { attachmentId: string, epoch: number }) => unknown) | undefined, provenance: any, provenanceSequenceId: string | null }} */
function container() {
  const existing = /** @type {any} */ (globalThis)[CONTAINER];
  if (existing === undefined) {
    const created = { version: VERSION, request: undefined, provenance: undefined, provenanceSequenceId: null };
    /** @type {any} */ (globalThis)[CONTAINER] = created;
    return created;
  }
  if (existing.version !== VERSION) {
    throw new Error(`The native-session-demo return channel is version ${existing.version}, and this copy speaks ${VERSION}`);
  }
  return existing;
}

/**
 * Publish the pre-TUI caller's sender. The pre-TUI caller is the only publisher, and a reconnect replaces a
 * channel whose socket has gone rather than leaving gestures answered through a dead one.
 *
 * @param {(origin: { attachmentId: string, epoch: number }) => unknown} request
 */
export function provideReturnRequest(request) {
  container().request = request;
}

/**
 * Record the provenance of the sequence Pi is about to deliver, and clear it when there is none.
 *
 * Called from the public input listener, which runs once per parsed sequence immediately before the focused
 * component sees it. Anything already held is replaced, so a handler can never read a previous sequence's
 * provenance: a listener call with no provenance clears it outright.
 *
 * @param {any} provenance
 */
export function noteInputProvenance(provenance) {
  const state = container();
  if (provenance === undefined || provenance === null) {
    state.provenance = undefined;
    state.provenanceSequenceId = null;
    return;
  }
  state.provenance = provenance;
  state.provenanceSequenceId = typeof provenance.sequenceId === "string" ? provenance.sequenceId : null;
}

/** Forget the held provenance. Used once a gesture has consumed it, so it is never read twice. */
export function clearInputProvenance() {
  const state = container();
  state.provenance = undefined;
  state.provenanceSequenceId = null;
}

/** The provenance of the sequence currently being delivered, or `undefined`. */
export function currentInputProvenance() {
  return container().provenance;
}

/**
 * Decide whether one provenance may detach one terminal, and say why when it may not.
 *
 * Every refusal is named, and no refusal falls back to something broader. In particular there is no
 * "detach whoever is attached" path.
 *
 * @param {any} provenance
 */
export function attributeReturn(provenance) {
  if (provenance === undefined || provenance === null) {
    return { ok: false, reason: "Pi delivered no provenance for this key, so there is no terminal to detach" };
  }
  // Ordinary local stdin on the owner's own terminal: a real key, but not one an attachment sent.
  if (provenance.origin === undefined || provenance.origin === null) {
    return { ok: false, reason: "this key did not arrive from an attachment, so there is no terminal to detach" };
  }
  // Native framing assembled this sequence from more than one attachment's bytes. It has no single origin,
  // and detaching either contributor would be detaching someone who did not ask.
  if (provenance.mixedOrigin === true) {
    return { ok: false, reason: "this key was assembled from more than one attachment's bytes, so it detaches nobody" };
  }
  // Bytes dispatched under a superseded binding generation helped form it, so the current generation's host
  // must not act on it. The same rule seam C applies to a Return.
  if (provenance.mixedBindingGeneration === true) {
    return { ok: false, reason: "this key was assembled across two binding generations, so it detaches nobody" };
  }
  const { attachmentId, epoch } = provenance.origin;
  if (typeof attachmentId !== "string" || attachmentId === "" || !Number.isInteger(epoch)) {
    return { ok: false, reason: `this key's origin is not a usable attachment epoch: ${JSON.stringify(provenance.origin)}` };
  }
  return { ok: true, origin: { attachmentId, epoch } };
}

/**
 * The shortcut handler's whole job: ask the manager to detach the terminal this gesture came from.
 *
 * The provenance is consumed, not merely read: it is cleared whatever the outcome, so a later gesture that
 * arrives without provenance of its own cannot inherit this one's.
 */
export function requestReturn() {
  const state = container();
  const provenance = state.provenance;
  const attribution = attributeReturn(provenance);
  clearInputProvenance();
  if (!attribution.ok) return { requested: false, reason: attribution.reason };
  if (typeof state.request !== "function") {
    return { requested: false, reason: "no manager channel is published in this process" };
  }
  state.request(attribution.origin);
  return { requested: true, origin: attribution.origin, sequenceId: typeof provenance.sequenceId === "string" ? provenance.sequenceId : null };
}
