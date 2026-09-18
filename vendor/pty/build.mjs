#!/usr/bin/env node
// Build the one native PTY artifact this package ships, from the pinned and patched upstream source.
//
//   node vendor/pty/build.mjs [--work <new directory>]
//
// This runs on a build worker, never on an operator's machine: it needs a Rust toolchain and the
// network. The product ships the built artifact, so installing pi-agents runs no compiler, no
// download and no install script at all.
//
// Fail-closed by construction: the tarball must match the locked integrity and digest, the three
// files the patch touches must match their locked pre-patch digests, the patch must apply with no
// fuzz, and `build-manifest.json` is written last and only on success.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import process from "node:process";

import { ProvenanceError, parseArguments, run, sha256OfFile, sha512IntegrityOfFile } from "../pi/provenance.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);

/** @param {{ work?: string }} options */
export function build({ work } = {}) {
  const lock = JSON.parse(readFileSync(path.join(HERE, "upstream-lock.json"), "utf8"));
  const { upstream, verifiedFiles, patches, build: plan } = lock;

  for (const patch of patches) {
    const file = path.join(HERE, patch.path);
    const actual = sha256OfFile(file);
    if (actual !== patch.sha256) throw new ProvenanceError(`${patch.path} is ${actual}, the lock says ${patch.sha256}`);
  }

  const workRoot = work ?? mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "pi-agents-pty-build-"));
  mkdirSync(workRoot, { recursive: true });
  const source = path.join(workRoot, "source");
  mkdirSync(source);

  // The pin is the tarball, fetched by exact version and then verified twice. `npm pack` is only the
  // fetch: nothing in the downloaded package is executed, and its own scripts never run.
  const packed = JSON.parse(run("npm", ["pack", `${upstream.package}@${upstream.version}`, "--json", "--pack-destination", workRoot], { cwd: workRoot }).stdout);
  if (packed.length !== 1) throw new ProvenanceError(`npm pack returned ${packed.length} tarballs`);
  const tarball = path.join(workRoot, packed[0].filename);
  const integrity = sha512IntegrityOfFile(tarball);
  const tarballSha256 = sha256OfFile(tarball);
  if (integrity !== upstream.integrity) throw new ProvenanceError(`tarball integrity is ${integrity}, the lock says ${upstream.integrity}`);
  if (tarballSha256 !== upstream.sha256) throw new ProvenanceError(`tarball sha256 is ${tarballSha256}, the lock says ${upstream.sha256}`);

  run("tar", ["-xzf", tarball, "-C", source, "--strip-components=1"]);
  for (const entry of verifiedFiles) {
    const actual = sha256OfFile(path.join(source, entry.path));
    if (actual !== entry.sha256) throw new ProvenanceError(`upstream ${entry.path} is ${actual}, the lock says ${entry.sha256}`);
  }

  // No fuzz and no three-way fallback: a patch that no longer matches its pinned source is a source
  // identity failure, and silently adapting it is how a vendored change becomes unreviewable.
  for (const patch of patches) {
    run("git", ["apply", "-p1", "--whitespace=nowarn", path.join(HERE, patch.path)], { cwd: source });
  }

  const committedCargoLock = path.join(HERE, "Cargo.lock");
  const locked = existsSync(committedCargoLock);
  if (locked) copyFileSync(committedCargoLock, path.join(source, "Cargo.lock"));

  // The toolchain is its own pixi environment, so an inherited manifest from the caller's shell cannot
  // silently build against the application's environment instead.
  const toolchainManifest = path.join(HERE, "pixi.toml");
  const toolchainEnv = { ...process.env, CARGO_TERM_COLOR: "never" };
  delete toolchainEnv.PIXI_PROJECT_MANIFEST;
  if (!existsSync(path.join(HERE, "pixi.lock"))) run("pixi", ["install", "--manifest-path", toolchainManifest], { env: toolchainEnv });
  const cargo = (args) => run("pixi", ["run", "--manifest-path", toolchainManifest, "--frozen", "--", ...args], { cwd: source, env: toolchainEnv });
  const built = cargo(["cargo", "build", "--release", ...(locked ? ["--locked"] : [])]);
  const rustVersions = { cargo: cargo(["cargo", "--version"]).stdout.trim(), rustc: cargo(["rustc", "--version"]).stdout.trim() };

  // The resolved dependency set is part of the artifact's identity, so the first build contributes the
  // lockfile that every later build is then held to.
  if (!locked) copyFileSync(path.join(source, "Cargo.lock"), committedCargoLock);

  const artifact = path.join(HERE, plan.artifact);
  copyFileSync(path.join(source, plan.cargoArtifact), artifact);
  const manifest = {
    schemaVersion: 1,
    artifact: plan.artifact,
    sha256: sha256OfFile(artifact),
    byteLength: statSync(artifact).size,
    upstream: { package: upstream.package, version: upstream.version, sha256: upstream.sha256 },
    patches: patches.map((patch) => ({ path: patch.path, sha256: patch.sha256 })),
    platform: { ...plan.platform, nodeApiVersion: 4 },
    toolchain: { ...rustVersions, cargoLockSha256: sha256OfFile(committedCargoLock), glibc: run("getconf", ["GNU_LIBC_VERSION"]).stdout.trim() },
    linkedLibraries: run("ldd", [artifact]).stdout.trim().split("\n").map((line) => line.trim().split(" ")[0]).sort(),
    builtOn: { host: hostname(), node: process.version },
    buildSeconds: built.seconds,
  };
  writeFileSync(path.join(HERE, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { workRoot, artifact, manifest };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const options = parseArguments(process.argv.slice(2), { flags: ["work"] });
  const { artifact, manifest, workRoot } = build(options);
  process.stdout.write(`${JSON.stringify({ artifact, manifest, workRoot }, null, 2)}\n`);
}
