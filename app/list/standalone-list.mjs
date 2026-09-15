import { appendFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";

import { createDaemonClient } from "../daemon-client.mjs";
import { createWheelInputTap } from "../mouse-input.mjs";
import { DashboardController } from "./dashboard.mjs";

/** Run one list-to-viewer transition and restore the list after any failure. @param {any} options */
/** Opt-in stage timing for a viewer transition, so latency can be measured where the operator sits. */
function markTransition(stage, startedAt) {
  const path = process.env.PI_AGENTS_UI_TIMING;
  if (path === undefined || path === "") return;
  try { appendFileSync(path, `${new Date().toISOString()} ${stage} ${Math.round(performance.now() - startedAt)}ms\n`); } catch {}
}

export async function runViewerTransition({ sessionId, client, controller, createViewer, activateViewer, activateList, restoreListFocus, onRestoreClosed, shouldRestore }) {
  const startedAt = performance.now();
  let attached = false;
  let restoreList = false;
  let viewer;
  let failure;
  try {
    await client.attach(sessionId);
    markTransition("attached", startedAt);
    attached = true;
    restoreList = true;
    await controller.close();
    markTransition("list-closed", startedAt);
    viewer = createViewer();
    activateViewer(viewer);
    // Leaving the viewer must not wait for a request its open is still making: the viewer's own close
    // ends this transition. A failed open closes the viewer too, and records why on `openError`, so the
    // rejection is read from there rather than awaited here.
    const opened = viewer.open();
    opened.catch(() => {});
    await Promise.race([opened, viewer.closed]);
    markTransition("viewer-open", startedAt);
    await viewer.closed;
    markTransition("viewer-closed", startedAt);
    if (viewer.openError !== undefined) throw viewer.openError;
  } catch (error) {
    failure = error;
  } finally {
    await viewer?.close().catch(() => {});
    // Detaching is cleanup, not a precondition for drawing the list. The client keeps the promise so
    // a later attach for this session still waits behind it; the operator does not.
    if (attached) void client.detach(sessionId).catch(() => {});
    if (restoreList && shouldRestore()) { await controller.open(); markTransition("list-reopened", startedAt); }
    if (shouldRestore()) {
      if (controller.closed) onRestoreClosed?.();
      else {
        activateList();
        restoreListFocus();
      }
    }
  }
  // A refused attach is the operator's answer to a keypress, so it belongs on the list's status line.
  // Dropping it made Enter and Right look like dead keys.
  if (failure !== undefined && shouldRestore()) controller.setError?.(failure, "VIEWER_OPEN_FAILED");
  return failure === undefined ? { kind: "returned" } : { kind: "failed", error: failure };
}

/** Start the alternate-screen TUI and restore terminal state after partial startup. @param {any} tui */
export function startStandaloneTui(tui) {
  try {
    tui.start();
  } catch (error) {
    try {
      tui.stop({ preserveScreen: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "TUI startup and terminal restoration failed");
    }
    throw error;
  }
}

/**
 * The one alternate screen a frontend paints, with Pi's own clipboard and browser behind it.
 *
 * `TuiAltScreen` takes these callbacks at construction and nowhere else, and this screen is built
 * before the list's first paint, while importing Pi's package still costs seconds. So the callbacks
 * are the seam and the helpers load behind them: nothing is imported until the operator's first copy
 * or first hyperlink click, and by then a viewer has already loaded Pi.
 *
 * @param {any} terminal
 * @param {{ copySelection?: (text: string) => Promise<boolean>, openUrl?: (url: string) => void, loadHelpers?: () => Promise<any> }} [options]
 */
export function createHostTui(terminal, { copySelection = undefined, openUrl = undefined, loadHelpers = () => import("../viewer/pi-native-helpers.mjs") } = {}) {
  /** @type {Promise<{ copySelection: (text: string) => Promise<boolean>, openUrl: (url: string) => void }> | undefined} */
  let ready;
  // A failed import is not remembered as a failure: the next copy tries again rather than leaving the
  // clipboard dead for the rest of the session.
  const helpers = () => (ready ??= loadHelpers().then((module) => module.createNativeTuiHelpers({ copySelection, openUrl })).catch((error) => { ready = undefined; throw error; }));
  return new TuiAltScreen(terminal, false, undefined, {
    // pi-tui calls this with `void` and awaits it inside, so a rejection here is an unhandled
    // rejection that ends the frontend over a failed copy. Answering false is what it asks for: it
    // flashes "Copy failed" and the operator's session stays up.
    copySelection: async (/** @type {string} */ text) => {
      try { return await (await helpers()).copySelection(text); } catch { return false; }
    },
    // Pi's own opener answers nothing: a launch that fails is best-effort, and the URL is on screen.
    openUrl: (/** @type {string} */ url) => { void helpers().then((resolved) => resolved.openUrl(url)).catch(() => {}); },
  });
}

/**
 * Mount and focus the single input router used by the standalone list/viewer host.
 *
 * The list draws itself full-screen through this component. A viewer draws itself as one of Pi's
 * own layouts instead, so `setLayout` hands Pi the layout root and keeps the router focused: Pi's
 * `setLayoutRoot` moves no focus of its own.
 *
 * `terminal` must be the tap from createWheelInputTap. It exists for the list, which is not a Pi
 * layout and so never receives the wheel events pi-tui keeps for its own scroll views; while a
 * viewer is up the tap stands down and every mouse byte reaches Pi unchanged. @param {any} options
 */
export function mountStandaloneHost({ tui, getActive, getHeight, terminal }) {
  const resolveHeight = getHeight ?? (() => tui.terminal.rows ?? 24);
  const component = {
    focused: false,
    render(width) { const active = getActive(); return active.render === undefined ? [] : active.render(width, resolveHeight()); },
    handleInput(data) { getActive().handleInput(data); tui.requestRender(); },
    handleMouse(event) { getActive().handleMouse?.(event); tui.requestRender(); },
    invalidate() {},
  };
  tui.addChild(component);
  tui.setFocus(component);
  terminal?.onWheel?.((/** @type {any} */ event) => component.handleMouse(event));
  return {
    component,
    focus() { tui.setFocus(component); },
    /** @param {any} layoutRoot Pi layout to show, or undefined to hand the screen back to the list. */
    setLayout(layoutRoot) {
      tui.setLayoutRoot?.(layoutRoot);
      terminal?.setWheelCapture?.(layoutRoot === undefined);
      tui.setFocus(component);
    },
  };
}

/**
 * One frontend shutdown, however it is reached: the operator quitting from the list or from a
 * hosted viewer, and an outer `close`, all run this once. @param {any} options
 */
export function createHostShutdown({ currentViewer, controller, tui, client, resolveClosed }) {
  /** @type {Promise<void> | undefined} */
  let closing;
  return {
    get started() { return closing !== undefined; },
    run() {
      // Pi's own fullscreen shutdown: leave the alternate screen without repainting the whole
      // document over the operator's scrollback.
      closing ??= (async () => { await currentViewer()?.close(); await controller.close(); tui.stop({ preserveScreen: true }); await client.close(); resolveClosed(); })();
      return closing;
    },
  };
}

/** Open the relocated list and real viewer in one package-root TUI. @param {any} options */
export async function createStandaloneList({ cwd, frontend, terminal: hostTerminal = new ProcessTerminal(), copySelection = undefined, openUrl = undefined }) {
  const token = (await fs.readFile(join(frontend.root, "daemon", "control.token"), "utf8")).trim();
  const client = createDaemonClient({ socketPath: join(frontend.root, "daemon", "control.sock"), token, maxBytes: 1024 * 1024, clientId: frontend.clientId, attachId: frontend.attachId });
  const terminal = createWheelInputTap(hostTerminal);
  const tui = createHostTui(terminal, { copySelection, openUrl });
  const viewerState = new Map();
  let resolveClosed;
  let switching = false;
  let activeViewer;
  let active;
  /** @type {string | undefined} */
  let pendingDashboardAction;
  let standaloneHost;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const openRealViewer = async (sessionId) => {
    if (switching || activeViewer !== undefined) return;
    switching = true;
    // Pi's components load on the first session opened, not before the list is drawn: importing Pi's
    // package costs seconds, and every launch and every key in the list happens without it.
    const [{ createPiEditor }, { ViewerController }] = await Promise.all([
      import("../viewer/pi-component-adapters.mjs"),
      import("../viewer/viewer-controller.mjs"),
    ]);
    await runViewerTransition({
      sessionId, client, controller,
      createViewer() {
        const editor = createPiEditor({ tui });
        let viewer;
        viewer = new ViewerController({
          sessionId, client, editor, cwd,
          persistence: { async load() { return viewerState.get(sessionId); }, async save(value) { viewerState.set(sessionId, structuredClone(value)); } },
          requestRender: () => tui.requestRender(), onReturn: () => { void viewer.close(); },
          // Returning hands the list back; quitting ends this whole frontend, list included.
          onQuit: () => { void shutdown.run(); },
          onDashboardAction: (/** @type {string} */ action) => {
            pendingDashboardAction = action;
            void viewer.close();
          },
        });
        return viewer;
      },
      activateViewer(viewer) { activeViewer = viewer; active = viewer; standaloneHost.setLayout(viewer.layoutRoot); },
      activateList() {
        activeViewer = undefined;
        active = controller;
        standaloneHost.setLayout(undefined);
        if (pendingDashboardAction === "new_session") controller.focusComposer();
        pendingDashboardAction = undefined;
      },
      restoreListFocus() { standaloneHost.setLayout(undefined); },
      onRestoreClosed() { tui.stop({ preserveScreen: true }); resolveClosed(); },
      shouldRestore() { return !shutdown.started; },
    });
    switching = false;
  };
  const controller = new DashboardController({
    client, openViewer: openRealViewer,
    clientId: frontend.clientId, sourceSessionId: `dashboard-${frontend.clientId}`,
    launchDefaults: { cwd }, requestRender: () => tui.requestRender(),
    onClose: () => { if (!switching && activeViewer === undefined) { tui.stop({ preserveScreen: true }); resolveClosed(); } },
  });
  const shutdown = createHostShutdown({ currentViewer: () => activeViewer, controller, tui, client, resolveClosed: () => resolveClosed() });
  active = controller;
  standaloneHost = mountStandaloneHost({ tui, getActive: () => active, terminal });
  await controller.open();
  startStandaloneTui(tui);
  return {
    closed,
    close() { return shutdown.run(); },
  };
}
