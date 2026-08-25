import { expect, it } from "vitest";

import manifest from "../../package.json";

it("ships one self-contained Pi extension and optional executable", () => {
  expect(manifest.bin).toEqual({ "pi-agents-dashboard": "./bin/pi-agents-dashboard.mjs" });
  expect(manifest.pi.extensions).toEqual(["./extensions/agents-dashboard/index.ts"]);
  expect(manifest.files).toEqual(expect.arrayContaining(["extensions", "runtime", "shared", "isolation"]));
  expect(manifest.engines.node).toBe(">=22.19.0");
});
