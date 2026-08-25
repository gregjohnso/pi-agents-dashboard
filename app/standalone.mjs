import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";

import { inspectDaemonEndpoint } from "../runtime/daemon-lifecycle.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { resolveDashboardRoots } from "../runtime/paths.mjs";
import { initializeRuntimePermissions } from "../runtime/permissions.mjs";
import { migrateLegacyState } from "../runtime/state-migration.mjs";
import { createStandaloneList } from "./list/standalone-list.mjs";
import { createPiEditor } from "./viewer/pi-component-adapters.mjs";
import { ViewerController } from "./viewer/viewer-controller.mjs";

const { runDaemonCommand } = await import(new URL("../cli/daemon-commands.mjs", import.meta.url).href);
const { loadCliClientIdentity } = await import(new URL("../cli/session-commands.mjs", import.meta.url).href);

/** @param {string} path */
async function exists(path) { try { await access(path); return true; } catch { return false; } }

/** Inspect exact legacy daemon and supervisor identities without treating stale metadata as live. */
export async function inspectLegacyRuntimeActivity({ legacyStateRoot, legacyRuntimeRoot, exists: pathExists = exists, inspectEndpoint = inspectDaemonEndpoint, inspect = inspectProcessIdentity, readFile: read = readFile }) {
  let activeDaemon = false;
  if (await pathExists(legacyRuntimeRoot)) {
    const endpoint = await inspectEndpoint({ root: legacyRuntimeRoot, inspect });
    if (endpoint.status === "HEALTHY") activeDaemon = endpoint.publication;
  }
  let value;
  try { value = JSON.parse(await read(join(legacyStateRoot, "daemon", "workers.json"), "utf8")); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return { activeDaemon, activeSupervisors: [] }; throw error; }
  if (value?.schemaVersion !== 1 || !Array.isArray(value.workers) || Object.keys(value).some((key) => !["schemaVersion", "workers"].includes(key))) throw new TypeError("Legacy worker metadata is invalid");
  const activeSupervisors = [];
  for (const worker of value.workers) {
    const identity = worker?.identity;
    const allowed = ["sessionId", "runId", "leaseId", "generation", "identity", "piChildIdentity", "token"];
    if (typeof worker !== "object" || worker === null || Object.keys(worker).some((key) => !allowed.includes(key)) || [worker.sessionId, worker.runId, worker.leaseId].some((entry) => typeof entry !== "string" || entry.length === 0) || !Number.isSafeInteger(worker.generation) || worker.generation <= 0 || !validProcessIdentity(identity) || !validProcessIdentity(worker.piChildIdentity)) throw new TypeError("Legacy worker metadata record is invalid");
    try { const actual = await inspect(identity.pid); if (sameProcessIdentity(actual, identity)) activeSupervisors.push(identity); }
    catch (error) { if (!["ENOENT", "ESRCH"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) throw error; }
  }
  return { activeDaemon, activeSupervisors };
}

/** @param {any} value */
function validProcessIdentity(value) { return Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value.startIdentity === "string" && value.startIdentity.length > 0 && Number.isSafeInteger(value.processGroupId) && value.processGroupId > 0; }
/** @param {any} left @param {any} right */
function sameProcessIdentity(left, right) { return left?.pid === right.pid && left?.startIdentity === right.startIdentity && left?.processGroupId === right.processGroupId; }

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
  openViewer,
}) {
  const roots = resolveDashboardRoots(env);
  await initialize();
  if (migrate !== undefined) await migrate(roots);
  else if (await exists(roots.legacyStateRoot)) {
    await migrateLegacyState({
      legacyRoot: roots.legacyStateRoot, destinationRoot: roots.destinationStateRoot, expectedUserId: process.getuid(),
      inspectLegacyRuntime: () => inspectLegacyRuntimeActivity({ legacyStateRoot: roots.legacyStateRoot, legacyRuntimeRoot: roots.legacyRuntimeRoot }),
      reconcileDestination: async ({ root }) => {
        const started = await runDaemonCommand("start", { root });
        if (started.code !== 0) throw Object.assign(new Error(started.error?.message ?? "Destination reconciliation failed"), { code: started.error?.code ?? "RECONCILIATION_FAILED" });
      },
    });
  }
  const frontend = connectOrStart === undefined
    ? await defaultConnectOrStart({ root: roots.destinationStateRoot, piBin, env })
    : await connectOrStart({ root: roots.destinationStateRoot, piBin, env });
  const list = openList === undefined
    ? await createStandaloneList({ cwd, piBin, env, stdin, stdout, stderr, frontend, openViewer })
    : await openList({ cwd, piBin, env, stdin, stdout, stderr, frontend, openViewer });
  try { await list.closed; } finally { await list.close(); await frontend.close(); }
}

/** @param {{root:string,piBin?:string,env:NodeJS.ProcessEnv}} options */
async function defaultConnectOrStart(options) {
  const started = await runDaemonCommand("start", { root: options.root, env: options.env });
  if (started.code !== 0) throw Object.assign(new Error(started.error?.message ?? "Daemon did not start"), { code: started.error?.code ?? "DAEMON_START_FAILED" });
  const clientId = await loadCliClientIdentity({ root: options.root });
  return { root: options.root, clientId, piBin: options.piBin, async close() {} };
}
