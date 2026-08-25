import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";

import { createDaemonClient } from "../daemon-client.mjs";
import { DashboardController, createDaemonDashboardBackend } from "./dashboard.mjs";

/** @param {string} path @param {string} clientId */
function persistence(path, clientId) {
  return {
    async load() {
      try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined; throw error; }
    },
    async save(state) {
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
    },
  };
}

/** Open the relocated list using only package-root TUI exports. @param {any} options */
export async function createStandaloneList({ cwd, frontend, openViewer = async () => {} }) {
  const token = (await readFile(join(frontend.root, "daemon", "control.token"), "utf8")).trim();
  const client = createDaemonClient({ socketPath: join(frontend.root, "daemon", "control.sock"), token, maxBytes: 1024 * 1024, clientId: frontend.clientId });
  const backend = createDaemonDashboardBackend({
    client, clientId: frontend.clientId,
    preflight: async (draft) => ({ canonicalCwd: await realpath(draft.cwd), isolationMode: draft.isolationMode, ownerSessionIds: [] }),
  });
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const controller = new DashboardController({
    backend, persistence: persistence(join(frontend.root, "frontend-state.json"), frontend.clientId), openViewer,
    clientId: frontend.clientId, sourceSessionId: `dashboard-${frontend.clientId}`,
    launchDefaults: { cwd }, requestRender: () => tui.requestRender(),
    onClose: () => { tui.stop(); resolveClosed(); },
  });
  tui.addChild({
    render(width) { return controller.render(width, process.stdout.rows ?? 24); },
    handleInput(data) { controller.handleInput(data); tui.requestRender(); },
    invalidate() {},
  });
  await controller.open();
  tui.start();
  let closing;
  return {
    closed,
    close() {
      closing ??= (async () => { await controller.close(); tui.stop(); await client.close(); resolveClosed(); })();
      return closing;
    },
  };
}
