import { expect, it, vi } from "vitest";

import { runDashboardApp } from "./standalone.mjs";

it("initializes, migrates, connects, and opens the standalone list in order", async () => {
  const order = [];
  const closeFrontend = vi.fn(async () => { order.push("close_frontend"); });
  const signalProcess = vi.fn();
  await runDashboardApp({
    cwd: "/repo",
    piBin: "/opt/pi",
    env: { HOME: "/home/user", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run/user/1" },
    stdin: {}, stdout: {}, stderr: {},
    initialize: async () => { order.push("permissions"); },
    migrate: async (roots) => { order.push("migration"); expect(roots.destinationStateRoot).toBe("/state/pi-dashboard"); },
    connectOrStart: async (options) => { order.push("daemon"); expect(options.piBin).toBe("/opt/pi"); return { close: closeFrontend }; },
    openList: async (options) => { order.push("list"); expect(options.cwd).toBe("/repo"); return { close: async () => { order.push("close_list"); } }; },
    signalProcess,
  });
  expect(order).toEqual(["permissions", "migration", "daemon", "list", "close_list", "close_frontend"]);
  expect(signalProcess).not.toHaveBeenCalled();
});

it("resolves app modules relative to the package rather than startup cwd", () => {
  expect(new URL("./list/dashboard.mjs", new URL("./standalone.mjs", import.meta.url)).pathname).toContain("/app/list/dashboard.mjs");
});
