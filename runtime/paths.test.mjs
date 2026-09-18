import { expect, it } from "vitest";

import { resolveDashboardRoots } from "./paths.mjs";

it.each([
  [
    "XDG_STATE_HOME for daemon endpoints, ignoring unsupported runtime overrides",
    { HOME: "/home/user", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run/user/1", PI_AGENTS_RUNTIME_DIR: "/unsupported" },
    { legacyStateRoot: "/state/pi-agents-dashboard", destinationStateRoot: "/state/pi-agents", legacyRuntimeRoot: "/state/pi-agents-dashboard", destinationRuntimeRoot: "/state/pi-agents" },
  ],
])("uses %s", (_label, env, expected) => {
  expect(resolveDashboardRoots(env)).toEqual(expected);
});
