import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";

import { createDaemonClient } from "../daemon-client.mjs";
import { createWheelInputTap } from "../mouse-input.mjs";
import { createPiEditor } from "../viewer/pi-component-adapters.mjs";
import { ViewerController } from "../viewer/viewer-controller.mjs";
import { DashboardController, createDaemonDashboardBackend } from "./dashboard.mjs";

/** Adapt one daemon client to the viewer controller's ordered public-v1 seam. */
export function createDaemonViewerClient({ client, clientId }) {
  const request = async (op, payload) => {
    const response = await client.request({ version: 1, clientId, requestId: randomUUID(), op, payload });
    if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    if (response.result?.kind === "command" && response.result.status.stage === "FAILED") throw Object.assign(new Error(response.result.status.error?.message ?? "Viewer command failed"), response.result.status.error);
    return response.result;
  };
  /** @type {Map<string, Promise<unknown>>} */
  const detaching = new Map();
  return {
    async attach(sessionId) {
      // A fast reopen can outrun its own detach, and the two would then race on this connection's
      // record of the session. Ordering them per session is enough; another session never waits here.
      await detaching.get(sessionId)?.catch(() => {});
      const attached = await request("attach", { sessionId, activate: true });
      if (attached?.kind !== "attached") throw Object.assign(new Error("Daemon returned the wrong attachment result"), { code: "INVALID_RESPONSE", retryable: false });
      return attached;
    },
    detach(sessionId) {
      const tracked = request("detach", { sessionId }).finally(() => { if (detaching.get(sessionId) === tracked) detaching.delete(sessionId); });
      detaching.set(sessionId, tracked);
      return tracked;
    },
    async menu(sessionId) {
      const result = await request("get_session_commands", { sessionId });
      if (result?.kind !== "session_commands") throw Object.assign(new Error("Daemon returned the wrong session command menu"), { code: "INVALID_RESPONSE" });
      const settings = await request("get_settings", {}).catch(() => undefined);
      const state = await request("get_state", {}).catch(() => undefined);
      const record = state?.kind === "state" ? state.sessions.find((/** @type {any} */ session) => session.sessionId === sessionId) : undefined;
      return {
        ...result,
        summaryModel: settings?.kind === "settings" ? settings.summaryModel : null,
        color: record?.color ?? null,
        name: record?.name,
        ...(record === undefined ? {} : { registryRevision: record.revision }),
      };
    },
    /** @param {string} sessionId @param {string | null} color */
    async setSessionColor(sessionId, color) {
      return client.setSessionColor(sessionId, color);
    },
    /** @param {Record<string, any>} payload */
    async setSettings(payload) {
      const result = await request("set_settings", payload);
      if (result?.kind !== "settings") throw Object.assign(new Error("Daemon returned the wrong settings result"), { code: "INVALID_RESPONSE" });
      return result;
    },
    /**
     * Open one subscription and hand back the snapshot it continues. The caller reads `events` only
     * after it has built its transcript from that snapshot; anything the daemon published in between
     * is already queued inside the client.
     * @param {string} sessionId
     */
    async subscribe(sessionId) {
      const subscription = client.subscribeViewer(sessionId);
      const iterator = subscription[Symbol.asyncIterator]();
      let snapshot;
      try {
        snapshot = await subscription.established;
      } catch (error) {
        await iterator.return?.();
        throw error;
      }
      return { snapshot, events: iterator, unsubscribe: () => { void iterator.return?.(); } };
    },
    command(operation, payload) { return request(operation, payload); },
    onConnectionChange(listener) { return client.onConnectionChange?.(listener); },
  };
}

/** Run one list-to-viewer transition and restore the list after any failure. @param {any} options */
/** Opt-in stage timing for a viewer transition, so latency can be measured where the operator sits. */
function markTransition(stage, startedAt) {
  const path = process.env.PI_AGENTS_UI_TIMING;
  if (path === undefined || path === "") return;
  try { appendFileSync(path, `${new Date().toISOString()} ${stage} ${Math.round(performance.now() - startedAt)}ms\n`); } catch {}
}

export async function runViewerTransition({ sessionId, viewerClient, controller, createViewer, activateViewer, activateList, restoreListFocus, onRestoreClosed, shouldRestore }) {
  const startedAt = performance.now();
  let attached = false;
  let restoreList = false;
  let viewer;
  let failure;
  try {
    await viewerClient.attach(sessionId);
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
    if (attached) void viewerClient.detach(sessionId).catch(() => {});
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
 * Mount and focus the single input router used by the standalone list/viewer host.
 *
 * `terminal` must be the tap from createWheelInputTap; pi-tui consumes wheel bytes itself, so
 * without it the host never sees a wheel event. @param {any} options
 */
export function mountStandaloneHost({ tui, getActive, getHeight, terminal }) {
  const resolveHeight = getHeight ?? (() => tui.terminal.rows ?? 24);
  const component = {
    focused: false,
    render(width) { return getActive().render(width, resolveHeight()); },
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
  };
}

/** Open the relocated list and real viewer in one package-root TUI. @param {any} options */
export async function createStandaloneList({ cwd, frontend }) {
  const token = (await fs.readFile(join(frontend.root, "daemon", "control.token"), "utf8")).trim();
  const client = createDaemonClient({ socketPath: join(frontend.root, "daemon", "control.sock"), token, maxBytes: 1024 * 1024, clientId: frontend.clientId, attachId: frontend.attachId });
  const backend = createDaemonDashboardBackend({
    client, clientId: frontend.clientId,
    preflight: async (draft) => {
      const canonicalCwd = await fs.realpath(draft.cwd);
      if (draft.isolationMode !== "shared_directory") return { canonicalCwd, isolationMode: draft.isolationMode, ownerSessionIds: [] };
      const state = await client.request({ version: 1, clientId: frontend.clientId, requestId: randomUUID(), op: "get_state", payload: {} });
      if (!state.ok || state.result?.kind !== "state") throw Object.assign(new Error(state.error?.message ?? "Daemon state is unavailable"), state.error ?? { code: "INVALID_RESPONSE" });
      const ownerSessionIds = state.result.sessions
        .filter((record) => record.ownership !== undefined && (record.isolation?.mode === "shared_directory" ? record.isolation.canonicalCwd : record.cwd) === canonicalCwd)
        .map((record) => record.sessionId)
        .sort();
      return { canonicalCwd, isolationMode: draft.isolationMode, ownerSessionIds };
    },
  });
  const terminal = createWheelInputTap(new ProcessTerminal());
  const tui = new TuiAltScreen(terminal);
  const viewerClient = createDaemonViewerClient({ client, clientId: frontend.clientId });
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
    await runViewerTransition({
      sessionId, viewerClient, controller,
      createViewer() {
        const editor = createPiEditor({ tui });
        let viewer;
        viewer = new ViewerController({
          sessionId, client: viewerClient, editor, cwd,
          persistence: { async load() { return viewerState.get(sessionId); }, async save(value) { viewerState.set(sessionId, structuredClone(value)); } },
          requestRender: () => tui.requestRender(), onReturn: () => { void viewer.close(); },
          onDashboardAction: (/** @type {string} */ action) => {
            pendingDashboardAction = action;
            void viewer.close();
          },
        });
        return viewer;
      },
      activateViewer(viewer) { activeViewer = viewer; active = viewer; standaloneHost.focus(); },
      activateList() {
        activeViewer = undefined;
        active = controller;
        if (pendingDashboardAction === "new_session") controller.focusComposer();
        pendingDashboardAction = undefined;
      },
      restoreListFocus() { standaloneHost.focus(); },
      onRestoreClosed() { tui.stop(); resolveClosed(); },
      shouldRestore() { return closing === undefined; },
    });
    switching = false;
  };
  const controller = new DashboardController({
    backend, openViewer: openRealViewer,
    clientId: frontend.clientId, sourceSessionId: `dashboard-${frontend.clientId}`,
    launchDefaults: { cwd }, requestRender: () => tui.requestRender(),
    onClose: () => { if (!switching && activeViewer === undefined) { tui.stop(); resolveClosed(); } },
  });
  active = controller;
  standaloneHost = mountStandaloneHost({ tui, getActive: () => active, terminal });
  await controller.open();
  startStandaloneTui(tui);
  let closing;
  return {
    closed,
    close() {
      closing ??= (async () => { await activeViewer?.close(); await controller.close(); tui.stop(); await client.close(); resolveClosed(); })();
      return closing;
    },
  };
}
