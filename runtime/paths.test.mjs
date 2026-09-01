import { expect, it } from "vitest";

import { resolveDashboardRoots } from "./paths.mjs";

it.each([
  [
    "XDG_STATE_HOME for daemon endpoints, ignoring unsupported runtime overrides",
    { HOME: "/home/user", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run/user/1", PI_AGENTS_RUNTIME_DIR: "/unsupported" },
    { legacyStateRoot: "/state/pi-agents-dashboard", destinationStateRoot: "/state/pi-agents", legacyRuntimeRoot: "/state/pi-agents-dashboard", destinationRuntimeRoot: "/state/pi-agents" },
  ],
  [
    "an explicit destination override kept separate from the legacy root",
    { HOME: "/home/user", PI_AGENTS_STATE_DIR: "/custom/new" },
    { legacyStateRoot: "/home/user/.local/state/pi-agents-dashboard", destinationStateRoot: "/custom/new", legacyRuntimeRoot: "/home/user/.local/state/pi-agents-dashboard", destinationRuntimeRoot: "/custom/new" },
  ],
])("uses %s", (_label, env, expected) => {
  expect(resolveDashboardRoots(env)).toEqual(expected);
});

it("resolves roots and nothing else, because every artifact path is joined at its use site", async () => {
  expect(Object.keys(await import("./paths.mjs")).sort()).toEqual(["resolveDashboardRoots"]);
});
