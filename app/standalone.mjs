import { access } from "node:fs/promises";

import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";

import { resolveDashboardRoots } from "../runtime/paths.mjs";
import { initializeRuntimePermissions } from "../runtime/permissions.mjs";
import { inspectRuntimeActivity } from "../runtime/runtime-activity.mjs";
import { migrateLegacyState } from "../runtime/state-migration.mjs";
import { createStandaloneList } from "./list/standalone-list.mjs";
import { createPiEditor } from "./viewer/pi-component-adapters.mjs";
import { ViewerController } from "./viewer/viewer-controller.mjs";

const { runDaemonCommand } = await import(new URL("../cli/daemon-commands.mjs", import.meta.url).href);
const { loadCliClientIdentity } = await import(new URL("../cli/session-commands.mjs", import.meta.url).href);

/** @param {string} path */
async function exists(path) { try { await access(path); return true; } catch { return false; } }

/** Create a public-component full-screen viewer around the normalized client seam. */
export function createStandaloneViewer({ sessionId, client, persistence, onReturn, terminal = new ProcessTerminal(), now }) {
  const tui = new TuiAltScreen(terminal);
  const editor = createPiEditor({ tui });
  const controller = new ViewerController({ sessionId, client, editor, persistence, onReturn, now, requestRender: () => tui.renderNow() });
  tui.addChild({
    render(width) { return controller.render(width, terminal.rows ?? 24); },
    handleInput(data) { controller.handleInput(data); tui.requestRender(); },
    invalidate() {},
  });
  tui.setFocus(editor);
  let closing;
  return {
    closed: controller.closed,
    async open() { await controller.open(); tui.start(); },
    close() { closing ??= (async () => { await controller.close(); tui.stop(); })(); return closing; },
  };
}

/** Start the standalone list without binding its lifetime to daemon or worker lifetime. */
export async function runDashboardApp({
  cwd, piBin, env, stdin, stdout, stderr,
  initialize = async () => { initializeRuntimePermissions(); },
  migrate,
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
        const started = await runDaemonCommand("start", { root });
        if (started.code !== 0) throw Object.assign(new Error(started.error?.message ?? "Destination reconciliation failed"), { code: started.error?.code ?? "RECONCILIATION_FAILED" });
      },
    });
  }
  const frontend = connectOrStart === undefined
    ? await defaultConnectOrStart({ root: roots.destinationStateRoot, piBin, env })
    : await connectOrStart({ root: roots.destinationStateRoot, piBin, env });
  const listOptions = { cwd, piBin, env, stdin, stdout, stderr, frontend };
  const list = openList === undefined
    ? await createStandaloneList(listOptions)
    : await openList(listOptions);
  try { await list.closed; } finally { await list.close(); await frontend.close(); }
}

/** @param {{root:string,piBin?:string,env:NodeJS.ProcessEnv}} options */
async function defaultConnectOrStart(options) {
  const started = await runDaemonCommand("start", { root: options.root, piBin: options.piBin, env: options.env });
  if (started.code !== 0) throw Object.assign(new Error(started.error?.message ?? "Daemon did not start"), { code: started.error?.code ?? "DAEMON_START_FAILED" });
  const clientId = await loadCliClientIdentity({ root: options.root });
  return { root: options.root, clientId, piBin: options.piBin, async close() {} };
}
