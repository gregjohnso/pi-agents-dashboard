import { access } from "node:fs/promises";

import { inspectDaemonEndpoint } from "../runtime/daemon-lifecycle.mjs";
import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { resolveDashboardRoots } from "../runtime/paths.mjs";
import { initializeRuntimePermissions } from "../runtime/permissions.mjs";
import { migrateLegacyState } from "../runtime/state-migration.mjs";
import { createStandaloneList } from "./list/standalone-list.mjs";

const { runDaemonCommand } = await import(new URL("../cli/daemon-commands.mjs", import.meta.url).href);
const { loadCliClientIdentity } = await import(new URL("../cli/session-commands.mjs", import.meta.url).href);

/** @param {string} path */
async function exists(path) { try { await access(path); return true; } catch { return false; } }

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
      inspectLegacyRuntime: async () => {
        if (!await exists(roots.legacyRuntimeRoot)) return { activeDaemon: false, activeSupervisors: [] };
        const endpoint = await inspectDaemonEndpoint({ root: roots.legacyRuntimeRoot, inspect: inspectProcessIdentity });
        return { activeDaemon: endpoint.status === "HEALTHY" ? endpoint.publication : false, activeSupervisors: [] };
      },
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
    ? await createStandaloneList({ cwd, piBin, env, stdin, stdout, stderr, frontend })
    : await openList({ cwd, piBin, env, stdin, stdout, stderr, frontend });
  try { await list.closed; } finally { await list.close(); await frontend.close(); }
}

/** @param {{root:string,piBin?:string,env:NodeJS.ProcessEnv}} options */
async function defaultConnectOrStart(options) {
  const started = await runDaemonCommand("start", { root: options.root, env: options.env });
  if (started.code !== 0) throw Object.assign(new Error(started.error?.message ?? "Daemon did not start"), { code: started.error?.code ?? "DAEMON_START_FAILED" });
  const clientId = await loadCliClientIdentity({ root: options.root });
  return { root: options.root, clientId, piBin: options.piBin, async close() {} };
}
