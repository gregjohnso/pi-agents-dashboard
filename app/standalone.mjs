import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";

import { ProcessTerminal } from "@earendil-works/pi-tui";

import { resolveDashboardRoots } from "../runtime/paths.mjs";
import { initializeRuntimePermissions } from "../runtime/permissions.mjs";
import { inspectRuntimeActivity } from "../runtime/runtime-activity.mjs";
import { migrateLegacyState } from "../runtime/state-migration.mjs";
import { createHostTui, createStandaloneList, mountStandaloneHost } from "./list/standalone-list.mjs";

const { runDaemonCommand } = await import(new URL("../cli/daemon-commands.mjs", import.meta.url).href);
const { loadCliClientIdentity } = await import(new URL("../cli/session-commands.mjs", import.meta.url).href);

/** @param {string} path */
async function exists(path) { try { await access(path); return true; } catch { return false; } }
/** @param {any} options */
async function defaultStartDaemon(options) { return runDaemonCommand("start", options); }

/**
 * Create a public-component full-screen viewer around the normalized client seam.
 *
 * Pi's components arrive here rather than at module load: importing Pi's package costs seconds, and
 * the list has to draw before anyone asks for a viewer.
 */
export async function createStandaloneViewer({ sessionId, client, persistence, onReturn, terminal = new ProcessTerminal(), now, copySelection = undefined, openUrl = undefined }) {
  const [{ createPiEditor }, { ViewerController }] = await Promise.all([
    import("./viewer/pi-component-adapters.mjs"),
    import("./viewer/viewer-controller.mjs"),
  ]);
  const tui = createHostTui(terminal, { copySelection, openUrl });
  const editor = createPiEditor({ tui });
  const controller = new ViewerController({ sessionId, client, editor, persistence, onReturn, now, requestRender: () => tui.renderNow() });
  // The router holds focus, not Pi's editor: the viewer owns Escape, Ctrl+T and the return gesture,
  // and hands the editor the keys that type. Focusing the editor here sent every key straight to it,
  // so an attached operator could neither leave the session nor reach any viewer key. Pi's own
  // viewport keys never reach either: its alternate screen reads them off the terminal first.
  const host = mountStandaloneHost({ tui, getActive: () => controller, getHeight: () => terminal.rows ?? 24 });
  host.setLayout(controller.layoutRoot);
  let closing;
  return {
    closed: controller.closed,
    async open() { await controller.open(); tui.start(); },
    close() { closing ??= (async () => { await controller.close(); tui.stop({ preserveScreen: true }); })(); return closing; },
  };
}

/** Start the standalone list without binding its lifetime to daemon or worker lifetime. */
export async function runDashboardApp({
  cwd, piBin, env, stdin, stdout, stderr,
  initialize = async () => { initializeRuntimePermissions(); },
  migrate,
  startDaemon = defaultStartDaemon,
  connectOrStart,
  openList,
}) {
  const roots = resolveDashboardRoots(env);
  await initialize();
  if (migrate !== undefined) await migrate(roots);
  else if (await exists(roots.legacyStateRoot)) {
    await migrateLegacyState({
      legacyRoot: roots.legacyStateRoot, destinationRoot: roots.destinationStateRoot, expectedUserId: process.getuid(),
      inspectLegacyRuntime: () => inspectRuntimeActivity({ stateRoot: roots.legacyStateRoot, runtimeRoot: roots.legacyRuntimeRoot }),
      reconcileDestination: async ({ root }) => {
        const started = await startDaemon({ root });
        if (started.code !== 0) throw Object.assign(new Error(started.error?.message ?? "Destination reconciliation failed"), { code: started.error?.code ?? "RECONCILIATION_FAILED" });
      },
    });
  }
  // The daemon start runs before the interface exists, so its own slow-start reporting needs this
  // terminal's error stream: a hung start would otherwise leave the operator a blank screen.
  const frontend = connectOrStart === undefined
    ? await defaultConnectOrStart({ root: roots.destinationStateRoot, piBin, env, stderr, startDaemon })
    : await connectOrStart({ root: roots.destinationStateRoot, piBin, env, stderr });
  const listOptions = { cwd, piBin, env, stdin, stdout, stderr, frontend };
  const list = openList === undefined
    ? await createStandaloneList(listOptions)
    : await openList(listOptions);
  try { await list.closed; } finally { await list.close(); await frontend.close(); }
}

/** @param {{root:string,piBin?:string,env:NodeJS.ProcessEnv,stderr?:NodeJS.WritableStream,startDaemon:(options:any)=>Promise<any>}} options */
async function defaultConnectOrStart(options) {
  const started = await options.startDaemon({ root: options.root, piBin: options.piBin, env: options.env, stderr: options.stderr });
  if (started.code !== 0) throw Object.assign(new Error(started.error?.message ?? "Daemon did not start"), { code: started.error?.code ?? "DAEMON_START_FAILED" });
  const clientId = await loadCliClientIdentity({ root: options.root });
  // `clientId` is this installation and survives every restart, because it and the request ID are
  // the identity a worker's replay log keys a command by. `attachId` is this dashboard process and
  // dies with it, which is what lets three dashboards of one installation hold their own
  // connection state.
  return { root: options.root, clientId, attachId: randomUUID(), piBin: options.piBin, async close() {} };
}
