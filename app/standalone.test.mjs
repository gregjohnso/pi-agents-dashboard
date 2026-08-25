import { expect, it, vi } from "vitest";

import { inspectLegacyRuntimeActivity, runDashboardApp } from "./standalone.mjs";

it("initializes, migrates, connects, and opens the standalone list in order", async () => {
  const order = [];
  const closeFrontend = vi.fn(async () => { order.push("close_frontend"); });
  const signalProcess = vi.fn();
  const openViewer = vi.fn();
  await runDashboardApp({
    cwd: "/repo",
    piBin: "/opt/pi",
    env: { HOME: "/home/user", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run/user/1" },
    stdin: {}, stdout: {}, stderr: {},
    initialize: async () => { order.push("permissions"); },
    migrate: async (roots) => { order.push("migration"); expect(roots).toMatchObject({ legacyStateRoot: "/state/pi-agents-dashboard", legacyRuntimeRoot: "/state/pi-agents-dashboard", destinationStateRoot: "/state/pi-dashboard", destinationRuntimeRoot: "/state/pi-dashboard" }); },
    connectOrStart: async (options) => { order.push("daemon"); expect(options.piBin).toBe("/opt/pi"); return { close: closeFrontend }; },
    openList: async (options) => { order.push("list"); expect(options.cwd).toBe("/repo"); expect(options.openViewer).toBe(openViewer); return { close: async () => { order.push("close_list"); } }; },
    openViewer,
    signalProcess,
  });
  expect(order).toEqual(["permissions", "migration", "daemon", "list", "close_list", "close_frontend"]);
  expect(signalProcess).not.toHaveBeenCalled();
});

it("reports only verified active legacy supervisor identities", async () => {
  const worker = { pid: 42, startIdentity: "420", processGroupId: 42 };
  const readFile = vi.fn(async () => JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "session", runId: "run", leaseId: "lease", generation: 1, identity: worker, piChildIdentity: worker }] }));
  await expect(inspectLegacyRuntimeActivity({
    legacyStateRoot: "/state/pi-agents-dashboard", legacyRuntimeRoot: "/run/pi-agents-dashboard",
    exists: async () => true, inspectEndpoint: async () => ({ status: "ABSENT" }), inspect: async () => worker, readFile,
  })).resolves.toEqual({ activeDaemon: false, activeSupervisors: [worker] });
});

it("resolves app modules relative to the package rather than startup cwd", () => {
  expect(new URL("./list/dashboard.mjs", new URL("./standalone.mjs", import.meta.url)).pathname).toContain("/app/list/dashboard.mjs");
});
