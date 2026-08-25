import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

it("ships only the standalone executable", () => {
  expect(manifest.name).toBe("pi-dashboard");
  expect(manifest.bin).toEqual({ "pi-dashboard": "./bin/pi-dashboard.mjs" });
  expect(manifest.pi).toBeUndefined();
  expect(manifest.scripts.preinstall).toBeUndefined();
  expect(manifest.scripts.postinstall).toBeUndefined();
  expect(manifest.files).toContain("app");
  expect(manifest.files).not.toContain("extensions");
  expect(manifest.dependencies).toMatchObject({
    "@earendil-works/pi-coding-agent": "0.84.3",
    "@earendil-works/pi-tui": "0.84.3",
  });
});

it("contains no shipped Pi extension or package registration command", async () => {
  await expect(readFile(new URL("../extensions/agents-dashboard/index.ts", import.meta.url))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(new URL("../cli/package-commands.mjs", import.meta.url))).rejects.toMatchObject({ code: "ENOENT" });
});
