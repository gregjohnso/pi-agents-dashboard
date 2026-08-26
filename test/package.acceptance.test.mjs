import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-dashboard-package-acceptance-"));
const home = join(temporaryRoot, "home");
const cache = join(temporaryRoot, "cache");
const unrelatedCwd = join(temporaryRoot, "unrelated", "cwd");
const stateRoot = join(temporaryRoot, "state");
await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(cache, { recursive: true, mode: 0o700 }), mkdir(unrelatedCwd, { recursive: true, mode: 0o700 })]);
afterAll(async () => rm(temporaryRoot, { recursive: true, force: true }));

const isolatedEnv = {
  ...process.env,
  HOME: home,
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_RUNTIME_DIR: join(home, ".runtime"),
  XDG_STATE_HOME: stateRoot,
  npm_config_audit: "false",
  npm_config_cache: cache,
  npm_config_fund: "false",
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
};

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { cwd: options.cwd ?? repository, env: { ...isolatedEnv, ...options.env }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, shell: false });
}

const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", temporaryRoot])).stdout);
if (packed.length !== 1) throw new Error(`Expected one package tarball, received ${packed.length}`);
const tarball = join(temporaryRoot, packed[0].filename);

it("ships one allowlisted standalone tarball without lifecycle, private, or development artifacts", async () => {
  const listing = (await run("tar", ["-tf", tarball])).stdout.trim().split("\n");
  const productFiles = listing.filter((path) => !path.startsWith("package/node_modules/"));
  expect(packed[0]).toMatchObject({ name: "pi-dashboard", version: "0.0.0" });
  expect(listing).toContain("package/bin/pi-dashboard.mjs");
  expect(listing).toContain("package/README.md");
  expect(productFiles.some((path) => /(?:^|\/)(?:test|tests|__snapshots__)(?:\/|$)|\.test\.|\.integration\.test\.|runtime\/test-fixtures\.mjs$/u.test(path))).toBe(false);
  expect(productFiles.some((path) => /(?:^|\/)(?:\.superpowers|\.vscode|\.cache|diagnostics|sessions|worktrees)(?:\/|$)/u.test(path))).toBe(false);
  expect(productFiles.some((path) => /(?:^|\/)(?:extensions|ui)(?:\/|$)/u.test(path))).toBe(false);
  expect(productFiles.some((path) => /(?:pixi|tsconfig|vitest\.config|package-lock)\b/u.test(path))).toBe(false);
  expect(listing.some((path) => /(?:^|\/)(?:\.env(?:\.|$)|credentials?|control\.token|\.git|worker\.(?:stdout|stderr)\.log)(?:\/|$)/u.test(path))).toBe(false);
  expect(listing.some((path) => /package\/node_modules\/(?:typescript|vitest|@types\/node)(?:\/|$)/u.test(path))).toBe(false);
  console.info(JSON.stringify({ kind: "package-acceptance", tarballBytes: packed[0].size, unpackedBytes: packed[0].unpackedSize, listedFiles: listing.length, bundledDependencies: packed[0].bundled?.length ?? 0 }));

  const manifestText = (await run("tar", ["-xOf", tarball, "package/package.json"])).stdout;
  const manifest = JSON.parse(manifestText);
  expect(manifest.bin).toEqual({ "pi-dashboard": "./bin/pi-dashboard.mjs" });
  expect(manifest.pi).toBeUndefined();
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"]) {
    expect(manifest.scripts?.[lifecycle]).toBeUndefined();
  }
});

it("starts package-relative code from unrelated cwd after local-path, global-tarball, and cached offline npx installs", async () => {
  const localPrefix = join(temporaryRoot, "local");
  await run("npm", ["install", "--prefix", localPrefix, "--ignore-scripts", repository]);
  const localHelp = await run(join(localPrefix, "node_modules", ".bin", "pi-dashboard"), ["--help"], { cwd: unrelatedCwd });
  expect(localHelp.stdout).toContain("Usage: pi-dashboard");

  const globalPrefix = join(temporaryRoot, "global");
  await run("npm", ["install", "--global", "--prefix", globalPrefix, "--ignore-scripts", tarball]);
  const globalHelp = await run(join(globalPrefix, "bin", "pi-dashboard"), ["--help"], { cwd: unrelatedCwd });
  expect(globalHelp.stdout).toContain("With no arguments");

  const npxHelp = await run("npx", ["--yes", "--offline", "--cache", cache, "--package", tarball, "pi-dashboard", "--help"], { cwd: unrelatedCwd });
  expect(npxHelp.stdout).toContain("pi-dashboard session <command>");
  await expect(access(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
}, 120_000);
