/**
 * How the pre-TUI caller and the Pi extension in the same process find each other.
 *
 * They are two module instances by construction: the pre-TUI caller is loaded with `node --import`, before
 * the bundled CLI's entry module exists, and the extension is loaded by Pi and resolves
 * `@earendil-works/pi-coding-agent` to the bundle's own inlined copy. Neither can import the other's
 * bindings, so the one fact they have to share — the public `TUI` the extension's widget factory is handed —
 * lives on one registered symbol on the process.
 *
 * This is the demo's own container, not Pi's. It holds a public object Pi gave an extension, so nothing here
 * inspects a private field, decodes a key or infers state from rendered output.
 */

const CONTAINER = Symbol.for("pi-agents:native-session-demo/tui-handover");
const VERSION = 1;

/** @returns {{ version: number, tui: any, waiters: ((tui: any) => void)[] }} */
function container() {
  const existing = /** @type {any} */ (globalThis)[CONTAINER];
  if (existing === undefined) {
    const created = { version: VERSION, tui: undefined, waiters: [] };
    /** @type {any} */ (globalThis)[CONTAINER] = created;
    return created;
  }
  if (existing.version !== VERSION) {
    throw new Error(`The native-session-demo handover container is version ${existing.version}, and this copy speaks ${VERSION}`);
  }
  return existing;
}

/**
 * Publish the public TUI Pi handed a widget factory. The first one wins: a later render must not swap the
 * terminal the ingress caller is already dispatching into.
 *
 * @param {any} tui
 */
export function provideTui(tui) {
  const state = container();
  if (state.tui !== undefined) return;
  state.tui = tui;
  const waiters = state.waiters.splice(0);
  for (const waiter of waiters) waiter(tui);
}

/** Resolves with the public TUI, whether it was published before or after this call. */
export function awaitTui() {
  const state = container();
  if (state.tui !== undefined) return Promise.resolve(state.tui);
  return new Promise((resolve) => state.waiters.push(resolve));
}
