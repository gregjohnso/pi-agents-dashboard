import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-agents-package-acceptance-"));
const runtimeBin = dirname(process.execPath);
const npm = join(runtimeBin, "npm");
const npx = join(runtimeBin, "npx");
await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
afterAll(async () => rm(temporaryRoot, { recursive: true, force: true }));

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { cwd: options.cwd ?? repository, env: options.env ?? process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, shell: false });
}

async function journey(name) {
  const root = join(temporaryRoot, name);
  const home = join(root, "home");
  const cache = join(root, "cache");
  const cwd = join(root, "unrelated", "cwd");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const minimalBin = join(root, "bin");
  await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(cache, { recursive: true, mode: 0o700 }), mkdir(cwd, { recursive: true, mode: 0o700 }), mkdir(minimalBin, { recursive: true, mode: 0o700 })]);
  await Promise.all([symlink(process.execPath, join(minimalBin, "node")), symlink("/bin/sh", join(minimalBin, "sh"))]);
  return {
    root, cache, cwd, prefix, state,
    env: {
      HOME: home,
      PATH: minimalBin,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_RUNTIME_DIR: join(home, ".runtime"),
      XDG_STATE_HOME: state,
      npm_config_audit: "false",
      npm_config_cache: cache,
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_prefix: prefix,
      npm_config_update_notifier: "false",
    },
  };
}

const packed = JSON.parse((await run(npm, ["pack", "--json", "--pack-destination", temporaryRoot])).stdout);
if (packed.length !== 1) throw new Error(`Expected one package tarball, received ${packed.length}`);
const tarball = join(temporaryRoot, packed[0].filename);

it("ships one allowlisted standalone tarball without lifecycle, private, or development artifacts", async () => {
  const listing = (await run("tar", ["-tf", tarball])).stdout.trim().split("\n");
  const productFiles = listing.filter((path) => !path.startsWith("package/node_modules/"));
  expect(packed[0]).toMatchObject({ name: "pi-agents", version: "0.0.0" });
  expect(listing).toContain("package/bin/pi-agents.mjs");
  expect(listing).toContain("package/README.md");
  expect(productFiles.some((path) => /(?:^|\/)(?:test|tests|__snapshots__)(?:\/|$)|\.test\.|\.integration\.test\.|runtime\/test-fixtures\.mjs$/u.test(path))).toBe(false);
  expect(productFiles.some((path) => /(?:^|\/)(?:\.superpowers|\.vscode|\.cache|diagnostics|sessions|worktrees)(?:\/|$)/u.test(path))).toBe(false);
  expect(productFiles.some((path) => /(?:^|\/)(?:extensions|ui)(?:\/|$)/u.test(path))).toBe(false);
  expect(productFiles.some((path) => /(?:pixi|tsconfig|vitest\.config|package-lock)\b/u.test(path))).toBe(false);
  expect(listing.some((path) => /(?:^|\/)(?:\.env(?:\.|$)|credentials?|control\.token|\.git|worker\.(?:stdout|stderr)\.log)(?:\/|$)/u.test(path))).toBe(false);
  expect(listing.some((path) => /package\/node_modules\/(?:typescript|vitest|@types\/node)(?:\/|$)/u.test(path))).toBe(false);

  const manifestText = (await run("tar", ["-xOf", tarball, "package/package.json"])).stdout;
  const manifest = JSON.parse(manifestText);
  expect(manifest.bin).toEqual({ "pi-agents": "./bin/pi-agents.mjs" });
  expect(manifest.pi).toBeUndefined();
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"]) {
    expect(manifest.scripts?.[lifecycle]).toBeUndefined();
  }
});

it("starts package-relative code from a local install, a global install, and offline npx", async () => {
  const [local, global, offlineNpx] = await Promise.all([journey("local"), journey("global"), journey("npx")]);
  const [localResult, globalResult, npxResult] = await Promise.all([
    (async () => {
      await run(npm, ["install", "--prefix", local.prefix, "--ignore-scripts", repository], local);
      return run(join(local.prefix, "node_modules", ".bin", "pi-agents"), ["--help"], local);
    })(),
    (async () => {
      await run(npm, ["install", "--global", "--prefix", global.prefix, "--ignore-scripts", tarball], global);
      return run(join(global.prefix, "bin", "pi-agents"), ["--help"], global);
    })(),
    run(npx, ["--yes", "--offline", "--cache", offlineNpx.cache, "--package", tarball, "pi-agents", "--help"], offlineNpx),
  ]);
  expect(localResult.stdout).toContain("Usage: pi-agents");
  expect(globalResult.stdout).toContain("With no arguments");
  expect(npxResult.stdout).toContain("pi-agents attach <full-session-id>");
  await Promise.all([local, global, offlineNpx].map(({ state }) => expect(access(state)).rejects.toMatchObject({ code: "ENOENT" })));
}, 120_000);
