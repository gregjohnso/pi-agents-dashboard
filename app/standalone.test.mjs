import { expect, it, vi } from "vitest";

import { runDashboardApp } from "./standalone.mjs";

it("initializes, migrates, connects, and opens the standalone list in order", async () => {
  const order = [];
  const closeFrontend = vi.fn(async () => { order.push("close_frontend"); });
  const signalProcess = vi.fn();
  // The daemon starts before the interface opens, so its own slow-start reporting has nowhere to go
  // unless this terminal's error stream reaches it.
  const stderr = {};
  await runDashboardApp({
    cwd: "/repo",
    piBin: "/opt/pi",
    env: { HOME: "/home/user", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run/user/1" },
    stdin: {}, stdout: {}, stderr,
    initialize: async () => { order.push("permissions"); },
    migrate: async (roots) => { order.push("migration"); expect(roots).toMatchObject({ legacyStateRoot: "/state/pi-agents-dashboard", legacyRuntimeRoot: "/state/pi-agents-dashboard", destinationStateRoot: "/state/pi-agents", destinationRuntimeRoot: "/state/pi-agents" }); },
    connectOrStart: async (options) => { order.push("daemon"); expect(options.piBin).toBe("/opt/pi"); expect(options.stderr).toBe(stderr); return { close: closeFrontend }; },
    openList: async (options) => {
      order.push("list");
      expect(options.cwd).toBe("/repo");
      expect(options).not.toHaveProperty("openViewer");
      return { close: async () => { order.push("close_list"); } };
    },
    signalProcess,
  });
  expect(order).toEqual(["permissions", "migration", "daemon", "list", "close_list", "close_frontend"]);
  expect(signalProcess).not.toHaveBeenCalled();
});

