import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";

import { createDaemonClient } from "../daemon-client.mjs";
import { DashboardController, createDaemonDashboardBackend } from "./dashboard.mjs";

/** @param {any} state */
function validateFrontendState(state) {
  const allowed = ["schemaVersion", "clientId", "cursor", "viewState", "launchDraft"];
  if (typeof state !== "object" || state === null || Array.isArray(state) || Object.keys(state).some((key) => !allowed.includes(key)) || state.schemaVersion !== 1 || typeof state.clientId !== "string" || state.clientId.length === 0 || typeof state.viewState !== "object" || state.viewState === null || typeof state.launchDraft !== "object" || state.launchDraft === null) throw Object.assign(new Error("Frontend state is malformed"), { code: "FRONTEND_STATE_CORRUPT" });
  if (state.cursor !== undefined && (typeof state.cursor !== "object" || state.cursor === null || Object.keys(state.cursor).some((key) => !["daemonEpoch", "sequence"].includes(key)) || typeof state.cursor.daemonEpoch !== "string" || !/^(0|[1-9]\d*)$/u.test(state.cursor.sequence))) throw Object.assign(new Error("Frontend cursor is malformed"), { code: "FRONTEND_STATE_CORRUPT" });
  return state;
}

/** Create private fsync-backed frontend cursor persistence. @param {string} path @param {string} clientId @param {{fsOps?:any,failpoint?:(stage:string)=>unknown|Promise<unknown>}} [options] */
export function createFrontendPersistence(path, clientId, options = {}) {
  const fsOps = options.fsOps ?? fs;
  const failpoint = options.failpoint ?? (() => {});
  return {
    async load() {
      let handle;
      try { handle = await fsOps.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined; throw Object.assign(new Error("Frontend state is unsafe", { cause: error }), { code: "FRONTEND_STATE_UNSAFE" }); }
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.isSymbolicLink?.() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw Object.assign(new Error("Frontend state is unsafe"), { code: "FRONTEND_STATE_UNSAFE" });
        const state = validateFrontendState(JSON.parse(await handle.readFile("utf8")));
        return state;
      } catch (error) {
        if (error?.code === "FRONTEND_STATE_UNSAFE" || error?.code === "FRONTEND_STATE_CORRUPT") throw error;
        throw Object.assign(new Error("Frontend state is corrupt", { cause: error }), { code: "FRONTEND_STATE_CORRUPT" });
      } finally { await handle.close(); }
    },
    async save(state) {
      validateFrontendState(state);
      if (state.clientId !== clientId) throw Object.assign(new Error("Frontend client identity changed"), { code: "FRONTEND_STATE_IDENTITY_MISMATCH" });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await fsOps.open(temporary, "wx", 0o600);
        try { await handle.chmod(0o600); await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); } finally { await handle.close(); }
        await failpoint("after_file_sync");
        await fsOps.rename(temporary, path);
        await failpoint("after_rename");
        const directory = await fsOps.open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
        await failpoint("after_directory_sync");
      } finally { await fsOps.rm(temporary, { force: true }); }
    },
  };
}

/** Open the relocated list using only package-root TUI exports. @param {any} options */
export async function createStandaloneList({ cwd, frontend, openViewer = async () => {} }) {
  const token = (await fs.readFile(join(frontend.root, "daemon", "control.token"), "utf8")).trim();
  const client = createDaemonClient({ socketPath: join(frontend.root, "daemon", "control.sock"), token, maxBytes: 1024 * 1024, clientId: frontend.clientId });
  const backend = createDaemonDashboardBackend({
    client, clientId: frontend.clientId,
    preflight: async (draft) => ({ canonicalCwd: await fs.realpath(draft.cwd), isolationMode: draft.isolationMode, ownerSessionIds: [] }),
  });
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const controller = new DashboardController({
    backend, persistence: createFrontendPersistence(join(frontend.root, "frontend-state.json"), frontend.clientId), openViewer,
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
