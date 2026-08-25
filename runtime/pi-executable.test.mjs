import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { assertPiExecutableIdentity, resolvePiExecutable } from "./pi-executable.mjs";

/** @type {string[]} */
const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function executableRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-executable-"));
  cleanup.push(root);
  for (const name of ["cli", "configured", "path-bin"]) {
    await writeFile(join(root, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
  await symlink(join(root, "path-bin"), join(root, "pi"));
  return root;
}

it("resolves CLI over configuration over PATH and records canonical file identity", async () => {
  const root = await executableRoot();
  const cli = await resolvePiExecutable({
    cliPath: join(root, "cli"),
    configuredPath: join(root, "configured"),
    pathEnv: root,
  });
  expect(cli.realpath).toBe(join(root, "cli"));
  expect(cli).toMatchObject({ device: expect.any(String), inode: expect.any(String), size: expect.any(Number), modifiedTimeNs: expect.any(String) });

  const configured = await resolvePiExecutable({ configuredPath: join(root, "configured"), pathEnv: root });
  expect(configured.realpath).toBe(join(root, "configured"));
  const fromPath = await resolvePiExecutable({ pathEnv: `${join(root, "missing")}${delimiter}${root}` });
  expect(fromPath.realpath).toBe(join(root, "path-bin"));
});

it("rejects non-files, non-executable files, and missing PATH candidates", async () => {
  const root = await executableRoot();
  const plain = join(root, "plain");
  await writeFile(plain, "not executable", { mode: 0o600 });
  await expect(resolvePiExecutable({ cliPath: root, pathEnv: "" })).rejects.toMatchObject({ code: "INVALID_PI_EXECUTABLE" });
  await expect(resolvePiExecutable({ cliPath: plain, pathEnv: "" })).rejects.toMatchObject({ code: "INVALID_PI_EXECUTABLE" });
  await expect(resolvePiExecutable({ pathEnv: join(root, "missing") })).rejects.toMatchObject({ code: "PI_EXECUTABLE_NOT_FOUND" });
});

it("refuses replacement and symlink retargeting after resolution", async () => {
  const root = await executableRoot();
  const link = join(root, "selected-pi");
  await symlink(join(root, "cli"), link);
  const identity = await resolvePiExecutable({ cliPath: link, pathEnv: "" });
  await rm(join(root, "cli"));
  await writeFile(join(root, "cli"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await expect(assertPiExecutableIdentity(identity)).rejects.toMatchObject({ code: "PI_EXECUTABLE_REPLACED" });

  await rm(link);
  await symlink(join(root, "configured"), link);
  await expect(resolvePiExecutable({ cliPath: link, pathEnv: "" })).resolves.toMatchObject({ realpath: join(root, "configured") });
  await chmod(join(root, "configured"), 0o600);
  await expect(resolvePiExecutable({ cliPath: link, pathEnv: "" })).rejects.toMatchObject({ code: "INVALID_PI_EXECUTABLE" });
});
