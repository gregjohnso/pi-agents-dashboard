import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { packageRoot, runPackageCommand } from "./package-commands.mjs";

it("discovers the canonical package root relative to the installed CLI module", async () => {
  const expected = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await expect(packageRoot()).resolves.toBe(expected);
});

it.each([["install", "install"], ["uninstall", "remove"]])("uses structured package-relative pi %s registration", async (command, piOperation) => {
  const calls = [];
  const result = await runPackageCommand(command, {
    spawn: async (file, argv, options) => {
      calls.push({ file, argv, options });
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  expect(result.code).toBe(0);
  expect(calls).toEqual([{ file: "pi", argv: [piOperation, await packageRoot()], options: { shell: false } }]);
});
