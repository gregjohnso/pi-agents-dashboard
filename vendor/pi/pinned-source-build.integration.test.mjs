// The real pinned build, end to end, on a worker: prepare the locked upstream commit, build and pack the
// cohort with `vendor/pi/build.mjs`, then install the produced artifacts into a fresh consumer and smoke
// test the installed bundled CLI, the public exports and which TUI the installed coding-agent resolves.
//
// This case fetches from the network and takes minutes, so it is an `*.integration.test.mjs` (outside
// `npm run test:unit`) and it refuses to run anywhere but a Slurm worker: the milestone forbids builds
// and installs on the head node. Its output root is `PI_FOUNDATION_OUTPUT_ROOT`, or `TMPDIR`, which the
// repository's Slurm driver points at the case directory; either way it must be outside the repository,
// because a live upstream tree inside it would be collectable by the default Vitest suite.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { readJson, runTool } from "./fixture-repository.mjs";
import { run, sha256OfFile, writeJsonOnce } from "./provenance.mjs";

const VENDOR = path.dirname(new URL(import.meta.url).pathname);
const REPOSITORY = path.resolve(VENDOR, "../..");
const LOCK = path.join(VENDOR, "upstream-lock.json");
const PATCHES = path.join(VENDOR, "patches");
const ON_WORKER = Boolean(process.env.SLURM_JOB_ID);
const COHORT = [
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-protocol",
  "@earendil-works/pi-client",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-coding-agent",
];

let attempt;
let prepared;
let artifacts;
let consumer;
const evidence = { startedAt: new Date().toISOString(), slurmJobId: process.env.SLURM_JOB_ID ?? null };

beforeAll(() => {
  if (!ON_WORKER) return;
  const outputRoot = process.env.PI_FOUNDATION_OUTPUT_ROOT ?? process.env.TMPDIR ?? tmpdir();
  expect(path.isAbsolute(outputRoot)).toBe(true);
  // A live upstream tree inside the repository would be collectable by the default suite; refuse it.
  expect(realpathSync(outputRoot).startsWith(`${realpathSync(REPOSITORY)}${path.sep}`)).toBe(false);
  attempt = path.join(outputRoot, "pi-foundation", `attempt-${process.env.SLURM_JOB_ID}-${process.env.SLURM_ARRAY_TASK_ID ?? "0"}`);
  mkdirSync(attempt, { recursive: true });
  prepared = path.join(attempt, "prepared");
  artifacts = path.join(attempt, "artifacts");
  consumer = path.join(attempt, "consumer");
  evidence.attempt = attempt;
});

describe.skipIf(!ON_WORKER)("the pinned upstream build, on a worker", () => {
  test("prepares the locked commit, builds the cohort, and a fresh consumer resolves the produced TUI", { timeout: 660_000 }, () => {
    const preparation = runTool("prepare.mjs", ["--lock", LOCK, "--patches", PATCHES, "--output", prepared]);
    if (preparation.status !== 0) process.stdout.write(`${preparation.stdout}\n${preparation.stderr}\n`);
    expect(preparation.status).toBe(0);
    const provenance = readJson(path.join(prepared, "provenance.json"));
    const lock = readJson(LOCK);
    expect(provenance.resolved.commit).toBe(lock.upstream.commit);
    expect(provenance.resolved.treeHash).toBe(lock.upstream.treeHash);
    expect(provenance.baseline).toBe(provenance.applied.length === 0);
    evidence.preparation = { stdout: preparation.stdout, resolved: provenance.resolved, applied: provenance.applied };

    const built = runTool("build.mjs", ["--prepared", prepared, "--artifacts", artifacts, "--lock", LOCK]);
    if (built.status !== 0) process.stdout.write(`${built.stdout}\n${built.stderr}\n`);
    expect(built.status).toBe(0);
    const manifest = readJson(path.join(artifacts, "build-manifest.json"));
    evidence.build = {
      stdout: built.stdout,
      artifactFiles: manifest.artifactFiles,
      bundledCli: manifest.bundledCli,
      generatedInputs: manifest.generatedInputs,
      commands: manifest.commands.map((entry) => ({ label: entry.label, status: entry.status, seconds: entry.seconds })),
      capability: manifest.capability,
      reproducibility: manifest.reproducibility,
    };

    // Every packed package of the runtime cohort, with a real file behind every recorded digest, and the
    // required notice verified inside each tarball.
    expect(manifest.artifactFiles.map((entry) => entry.package).sort()).toEqual([...COHORT].sort());
    for (const artifact of manifest.artifactFiles) {
      expect(artifact.version).toBe("0.84.3");
      expect(sha256OfFile(path.join(artifacts, artifact.file))).toBe(artifact.sha256);
      expect(artifact.licenseSha256).toBe(lock.upstream.license.sha256);
    }
    expect(manifest.license.sha256).toBe(lock.upstream.license.sha256);
    expect(manifest.license.spdx).toBe("MIT");
    expect(manifest.license.repositoryCopy.sha256).toBe(lock.upstream.license.sha256);
    expect(manifest.license.addedTo.map((entry) => entry.target)).toEqual(lock.build.pack);
    // The prepared tree was verified complete and claimed exactly once.
    expect(manifest.preparedState.strayFiles).toEqual([]);
    expect(manifest.preparedState.patchedTreeHash).toBe(provenance.patchedTreeHash);
    expect(manifest.preparedClaim.artifacts).toBe(artifacts);
    // The bundled CLI is rebuilt, not reused: it is the entry point a dist-only patch would miss.
    expect(manifest.bundledCli.bin).toBe("dist/bundle/cli.js");
    expect(manifest.bundledCli.bundleFileCount).toBeGreaterThan(1);
    expect(manifest.commands.map((entry) => entry.label)).toContain("build:packages/coding-agent");
    expect(manifest.commands.map((entry) => entry.label)).toContain("check:scripts/generate-coding-agent-shrinkwrap.mjs");

    // The one build input that is not the pinned commit: a hybrid, verified before use, data only.
    expect(manifest.buildKind).toMatch(/^hybrid: pinned upstream source plus pinned release-generated data/);
    expect(manifest.reproducibility).not.toMatch(/byte reproducible/i);
    expect(manifest.generatedInputs.map((entry) => entry.id)).toEqual(["pi-ai-model-data"]);
    const [generated] = manifest.generatedInputs;
    expect(generated.kind).toBe("release-generated-data");
    expect(generated.registryTarball).toBe(lock.generatedInputs[0].registryTarball);
    expect(generated.registryIntegrity).toBe(lock.generatedInputs[0].registryIntegrity);
    expect(generated.downloaded.integrity).toBe(lock.generatedInputs[0].registryIntegrity);
    expect(generated.downloaded.sha256).toBe(lock.generatedInputs[0].tarballSha256);
    expect(generated.mapping).toEqual({
      archiveMemberDirectory: "package/dist/providers/data",
      sourceDirectory: "packages/ai/src/providers/data",
    });
    const generatedRecord = readJson(path.join(artifacts, "generated-input-pi-ai-model-data.json"));
    expect(Object.keys(generatedRecord.files)).toHaveLength(40);
    expect(Object.keys(generatedRecord.files).every((name) => name.endsWith(".json"))).toBe(true);
    expect(generatedRecord.upstreamManifest.structureHash).toBe(lock.generatedInputs[0].upstreamManifest.structureHash);
    // Nothing executable came from the published artifact: the hydrated directory holds data only, and the
    // packages and bundled CLI above were rebuilt from the pinned source.
    const hydrated = path.join(prepared, "source", generated.mapping.sourceDirectory);
    expect(readdirSync(hydrated).every((name) => name.endsWith(".json"))).toBe(true);
    expect(readdirSync(hydrated)).toHaveLength(40);
    evidence.generatedInput = { ...generated, files: Object.keys(generatedRecord.files) };

    installConsumer(manifest);

    const version = run("node", [path.join(consumer, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), "--version"], {
      cwd: consumer,
      env: consumerEnvironment(),
      allowNonZero: true,
    });
    evidence.cli = { status: version.status, stdout: version.stdout.trim(), stderr: version.stderr.trim() };
    expect(version.status).toBe(0);
    expect(version.stdout).toContain("0.84.3");

    const exportsProbe = runExportProbe();
    evidence.exports = { status: exportsProbe.status, stdout: exportsProbe.stdout.trim(), stderr: exportsProbe.stderr.trim() };
    if (exportsProbe.status !== 0) process.stdout.write(`${exportsProbe.stdout}\n${exportsProbe.stderr}\n`);
    expect(exportsProbe.status).toBe(0);
    const exported = JSON.parse(exportsProbe.stdout.trim().split("\n").pop());
    expect(exported.imported["."]).toBeGreaterThan(0);
    expect(exported.imported["./client"]).toBeGreaterThan(0);
    expect(exported.resolved["./rpc-entry"]).toContain("dist/bundle/rpc-entry.js");

    evidence.tuiResolution = checkTuiResolution(manifest);
    evidence.installedNotices = checkInstalledNotices(manifest, lock);
    writeJsonOnce(path.join(attempt, "integration-evidence.json"), { ...evidence, finishedAt: new Date().toISOString() });
  });
});

/**
 * The installed public exports, resolved the way a consumer resolves them. The probe is a real file in
 * the consumer directory so `import.meta.resolve` is anchored there; `require.resolve` cannot be used at
 * all, because upstream's `exports` map declares an `import` condition and no `require` condition.
 */
function runExportProbe() {
  const probe = path.join(consumer, "export-probe.mjs");
  writeFileSync(probe, EXPORT_PROBE);
  return run("node", [probe], { cwd: consumer, env: consumerEnvironment(), allowNonZero: true });
}

const EXPORT_PROBE = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const resolved = {};
const imported = {};
for (const specifier of [".", "./client", "./rpc-entry"]) {
  const url = import.meta.resolve("@earendil-works/pi-coding-agent" + specifier.slice(1));
  resolved[specifier] = fileURLToPath(url);
  if (!existsSync(resolved[specifier])) throw new Error("missing export target: " + resolved[specifier]);
}
// "./rpc-entry" is resolved but not imported: it is a server entry point that would take over stdio.
for (const specifier of [".", "./client"]) {
  imported[specifier] = Object.keys(await import(resolved[specifier])).length;
}
console.log(JSON.stringify({ resolved, imported }));
`;

function consumerEnvironment() {
  // No provider keys and no real model. HOME, the XDG roots and TMPDIR are already disposable per case,
  // so no user extension, session or state directory is reachable through configuration.
  return { ...process.env, NO_COLOR: "1", CI: "1" };
}

/**
 * A fresh consumer that installs only the produced tarballs. `overrides` pin every internal package to
 * its produced artifact, so npm cannot satisfy an internal `^0.84.3` range from the registry and leave a
 * second stock copy nested under coding-agent.
 */
function installConsumer(manifest) {
  mkdirSync(consumer, { recursive: true });
  const specs = Object.fromEntries(
    manifest.artifactFiles.map((entry) => [entry.package, `file:${path.join(artifacts, entry.file)}`]),
  );
  writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "pi-foundation-consumer", version: "0.0.0", private: true, dependencies: specs, overrides: specs }, null, 2)}\n`,
  );
  const install = run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: consumer,
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? path.join(attempt, "npm-cache") },
    allowNonZero: true,
  });
  evidence.consumerInstall = { status: install.status, stdout: install.stdout.trim().split("\n").slice(-10).join("\n"), stderr: install.stderr.trim().split("\n").slice(-20).join("\n") };
  expect(install.status).toBe(0);
}

/**
 * The required notice, as a consumer actually receives it: the exact installed bytes of `LICENSE` in every one
 * of the seven installed packages, compared against the pinned notice rather than against the manifest's own
 * claim about itself.
 */
function checkInstalledNotices(manifest, lock) {
  const pinned = readFileSync(path.join(prepared, "source", lock.upstream.license.path));
  const installed = {};
  for (const artifact of manifest.artifactFiles) {
    const file = path.join(consumer, "node_modules", artifact.package, "LICENSE");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file)).toEqual(pinned);
    installed[artifact.package] = { path: file, sha256: sha256OfFile(file), bytes: pinned.length };
  }
  expect(Object.keys(installed)).toHaveLength(COHORT.length);
  return { spdx: lock.upstream.license.spdx, pinnedSha256: sha256OfFile(path.join(prepared, "source", lock.upstream.license.path)), installed };
}

/**
 * Which TUI the installed coding-agent actually resolves. Matching version strings are not the check:
 * the resolved realpath must be the produced top-level artifact, and no second stock copy may be nested
 * under coding-agent's own `node_modules`.
 */
function checkTuiResolution(manifest) {
  const codingAgentDirectory = path.join(consumer, "node_modules/@earendil-works/pi-coding-agent");
  const fromCodingAgent = createRequire(path.join(codingAgentDirectory, "package.json"));
  const resolved = realpathSync(fromCodingAgent.resolve("@earendil-works/pi-tui/package.json"));
  const expected = realpathSync(path.join(consumer, "node_modules/@earendil-works/pi-tui/package.json"));
  const nested = path.join(codingAgentDirectory, "node_modules/@earendil-works/pi-tui");
  const nestedEntries = existsSync(path.join(codingAgentDirectory, "node_modules/@earendil-works"))
    ? readdirSync(path.join(codingAgentDirectory, "node_modules/@earendil-works"))
    : [];
  const tree = run("npm", ["ls", "--json", ...COHORT], { cwd: consumer, allowNonZero: true });
  const listed = JSON.parse(tree.stdout);
  const resolution = {
    resolvedFromCodingAgent: resolved,
    topLevel: expected,
    nestedStockCopyPresent: existsSync(nested),
    nestedInternalPackages: nestedEntries,
    installedFrom: Object.fromEntries(
      Object.entries(listed.dependencies ?? {}).map(([name, entry]) => [name, entry.resolved ?? entry.version]),
    ),
    npmLsStatus: tree.status,
  };

  expect(resolution.nestedStockCopyPresent).toBe(false);
  expect(resolved).toBe(expected);
  expect(sha256OfFile(resolved)).toBe(sha256OfFile(expected));
  for (const artifact of manifest.artifactFiles) {
    // Every installed cohort package came from this build's own tarball, not from the registry.
    expect(resolution.installedFrom[artifact.package]).toContain(artifact.file);
  }
  expect(readJson(expected).version).toBe("0.84.3");
  // The installed bundled CLI is byte-identical to the one this build produced.
  const installedCli = path.join(codingAgentDirectory, "dist/bundle/cli.js");
  expect(sha256OfFile(installedCli)).toBe(manifest.bundledCli.sha256);
  resolution.installedBundledCliSha256 = sha256OfFile(installedCli);
  return resolution;
}
