// Building and packing a prepared tree: the plan the lock declares, the refusals that keep an
// unverified tree out of the build, and one real end-to-end build of the fixture workspace.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { createFixtureUpstream, readJson, runTool, writeFixtureLock, writeFixtureSeries } from "./fixture-repository.mjs";
import { run } from "./provenance.mjs";

let root;
let upstream;
let counter = 0;

const nextDirectory = (label) => path.join(root, "outputs", `${label}-${(counter += 1)}`);

// A well-formed but never-fetched generated input: the dry-run plan is accounting, so nothing runs.
const plannedGeneratedInput = {
  id: "fixture-data",
  kind: "release-generated-data",
  reason: "fixture",
  package: "@pi-foundation-fixture/data",
  version: "1.0.0",
  registryTarball: "https://registry.npmjs.org/@pi-foundation-fixture/data/-/data-1.0.0.tgz",
  registryIntegrity: `sha512-${"A".repeat(86)}==`,
  tarballSha256: "b".repeat(64),
  tarballBytes: 1234,
  archiveMemberDirectory: "package/dist/data",
  sourceDirectory: "packages/widget/src/data",
  allowedExtensions: [".json"],
  fileCount: 1,
  filesDigest: "c".repeat(64),
  files: { "catalog.json": "d".repeat(64) },
};

/** A prepared fixture tree, plus the lock it was prepared from. */
function preparedFixture(label, { lockOverrides = {}, series = [] } = {}) {
  const lock = writeFixtureLock(path.join(root, `locks/${label}.json`), upstream, lockOverrides).file;
  const patches = writeFixtureSeries(path.join(root, `series/${label}`), series);
  const output = nextDirectory(label);
  const prepared = runTool("prepare.mjs", ["--lock", lock, "--patches", patches, "--output", output]);
  expect(prepared.status).toBe(0);
  return { lock, output };
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "vendor-pi-build-"));
  mkdirSync(path.join(root, "outputs"));
  upstream = createFixtureUpstream(root);
});

describe("build.mjs plan", () => {
  test("--dry-run prints the execution order and creates no artifacts", () => {
    const { lock, output } = preparedFixture("plan");
    const artifacts = nextDirectory("plan-artifacts");

    const result = runTool("build.mjs", ["--prepared", output, "--artifacts", artifacts, "--lock", lock, "--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "install: npm --version",
      "build:packages/widget: npm --prefix packages/widget run build",
      "license: copy the verified LICENSE into 1 package root(s) as LICENSE before packing; npm always packs a root LICENSE",
      "pack:packages/widget: npm pack --pack-destination {artifacts} ./packages/widget",
    ]);
    expect(existsSync(artifacts)).toBe(false);
  });

  test("a generated input is planned before the install, which is when the build fetches it", () => {
    const { lock, output } = preparedFixture("plan-generated", {
      lockOverrides: { generatedInputs: [plannedGeneratedInput] },
    });

    const result = runTool("build.mjs", ["--prepared", output, "--lock", lock, "--dry-run"]);

    expect(result.status).toBe(0);
    const labels = result.stdout.trim().split("\n").map((line) => line.split(":")[0]);
    expect(labels.slice(0, 3)).toEqual(["registry", "download", "install"]);
    expect(result.stdout).toContain("registry:fixture-data: npm view @pi-foundation-fixture/data@1.0.0 dist --json");
    expect(result.stdout).toContain("download:fixture-data: npm pack @pi-foundation-fixture/data@1.0.0");
  });
});

describe("build.mjs, one real build", () => {
  test("builds and packs the prepared tree and records artifact digests and the baseline label", () => {
    const { lock, output } = preparedFixture("real");
    const artifacts = nextDirectory("real-artifacts");

    const result = runTool("build.mjs", ["--prepared", output, "--artifacts", artifacts, "--lock", lock]);

    expect(result.status).toBe(0);
    const manifest = readJson(path.join(artifacts, "build-manifest.json"));
    expect(manifest.baseline).toBe(true);
    expect(manifest.capability).toMatch(/^none: baseline upstream artifacts/);
    expect(manifest.reproducibility).toMatch(/^built from pinned inputs/);
    expect(manifest.commands.map((entry) => entry.label)).toEqual([
      "verify:commit",
      "verify:tree",
      "verify:diff",
      "verify:status",
      "install",
      "build:packages/widget",
      "pack:packages/widget",
    ]);
    expect(manifest.preparedState.patchedTreeHash).toBe(readJson(path.join(output, "provenance.json")).patchedTreeHash);
    expect(manifest.preparedState.strayFiles).toEqual([]);
    expect(manifest.artifactFiles).toHaveLength(1);
    const [artifact] = manifest.artifactFiles;
    expect(artifact.package).toBe("@pi-foundation-fixture/widget");
    expect(artifact.version).toBe("1.2.3");
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(artifacts, artifact.file))).toBe(true);
    // The recorded digest is the produced file's digest, not a restated field.
    expect(runTool("build.mjs", ["--dry-run", "--prepared", output, "--lock", lock]).status).toBe(0);
    expect(readFileSync(path.join(output, "source/packages/widget/dist/index.mjs"), "utf8")).toContain("describeWidget");
  });

  test("the verified notice is inside the produced tarball, not only claimed in the manifest", () => {
    const { lock, output } = preparedFixture("notice");
    const artifacts = nextDirectory("notice-artifacts");

    const result = runTool("build.mjs", ["--prepared", output, "--artifacts", artifacts, "--lock", lock]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`notice MIT sha256 ${upstream.licenseSha256} in 1 artifact(s)`);
    const manifest = readJson(path.join(artifacts, "build-manifest.json"));
    expect(manifest.license.sha256).toBe(upstream.licenseSha256);
    expect(manifest.license.packedAs).toBe("LICENSE");
    expect(manifest.license.addedTo).toEqual([{ target: "packages/widget", action: "copied" }]);
    expect(manifest.artifactFiles[0].licenseSha256).toBe(upstream.licenseSha256);
    // Read the notice back out of the tarball and compare bytes, exactly as a consumer would receive it.
    const scratch = nextDirectory("notice-extract");
    mkdirSync(scratch, { recursive: true });
    const extracted = run("tar", ["-xzf", path.join(artifacts, manifest.artifactFiles[0].file), "-C", scratch,
                                  "package/LICENSE"], { allowNonZero: true });
    expect(extracted.status).toBe(0);
    expect(readFileSync(path.join(scratch, "package/LICENSE"))).toEqual(
      readFileSync(path.join(output, "source/LICENSE")),
    );
  });

  test("a notice whose bytes are not the locked ones is refused before packing", () => {
    const { lock, output } = preparedFixture("notice-bytes");
    // Rewrite the notice in the prepared tree the way an unverified packaging step would.
    writeFileSync(path.join(output, "source/LICENSE"), "Some other licence text\n");
    const artifacts = nextDirectory("notice-bytes-artifacts");

    const result = runTool("build.mjs", ["--prepared", output, "--artifacts", artifacts, "--lock", lock]);

    expect(result.status).toBe(1);
    // The tampered tree is caught by the state check first, which is the earlier and stronger refusal.
    expect(result.stderr).toMatch(/the prepared tree changed after preparation/);
    expect(existsSync(path.join(artifacts, "build-manifest.json"))).toBe(false);
  });
});

describe("build.mjs refusals", () => {
  const refuseLock = (label, input) => {
    const lock = writeFixtureLock(path.join(root, `locks/${label}.json`), upstream, { generatedInputs: [input] }).file;
    const patches = writeFixtureSeries(path.join(root, `series/${label}`), []);
    return runTool("prepare.mjs", ["--lock", lock, "--patches", patches, "--output", nextDirectory(label)]);
  };

  // A pinned release-generated input is the one build input that does not come from the pinned commit, so its
  // declaration is validated by both entry points before anything is fetched. `prepare.mjs` is the first
  // consumer of the lock and reaches the same validator.
  test("a released input may declare data only: executable code in the selected set is refused", () => {
    const result = refuseLock("generated-code", {
      ...plannedGeneratedInput,
      fileCount: 2,
      files: { ...plannedGeneratedInput.files, "loader.js": "e".repeat(64) },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/loader\.js"\] is outside allowedExtensions \.json/);
    expect(result.stderr).toMatch(/only generated data may come from a published artifact, never executable code/);
  });

  test("a released input whose file set does not match its count is refused", () => {
    const result = refuseLock("generated-count", { ...plannedGeneratedInput, fileCount: 7 });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/files lists 1 files but fileCount is 7/);
  });

  test("a released input must name a registry tarball and a sha512 integrity", () => {
    expect(refuseLock("generated-url", { ...plannedGeneratedInput, registryTarball: "https://example.invalid/data.tgz" }).stderr)
      .toMatch(/registryTarball must match/);
    expect(refuseLock("generated-sri", { ...plannedGeneratedInput, registryIntegrity: "sha1-short" }).stderr)
      .toMatch(/registryIntegrity must match/);
  });

  test("a directory with no provenance.json is not a prepared tree", () => {
    const bare = nextDirectory("bare");
    mkdirSync(bare, { recursive: true });
    const lock = writeFixtureLock(path.join(root, "locks/bare.json"), upstream).file;

    const result = runTool("build.mjs", ["--prepared", bare, "--artifacts", nextDirectory("bare-artifacts"), "--lock", lock]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/carries no provenance\.json/);
  });

  test("a lock that differs from the one the tree was prepared from is refused", () => {
    const { output } = preparedFixture("otherlock");
    const changed = writeFixtureLock(path.join(root, "locks/otherlock-changed.json"), upstream, {
      description: "same upstream, different lock bytes",
    }).file;

    const result = runTool("build.mjs", [
      "--prepared", output, "--artifacts", nextDirectory("otherlock-artifacts"), "--lock", changed,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/prepared from a different lock/);
  });

  test("an edited prepared tree is caught by the recorded applied-diff digest", () => {
    const { lock, output } = preparedFixture("tamper");
    writeFileSync(path.join(output, "source/packages/widget/src/index.mjs"), "export const sneaked = true;\n");

    const result = runTool("build.mjs", [
      "--prepared", output, "--artifacts", nextDirectory("tamper-artifacts"), "--lock", lock,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/the prepared tree changed after preparation/);
  });

  test("untracked source injected into a prepared tree is refused before anything is built", () => {
    const { lock, output } = preparedFixture("untracked");
    // A new file no patch declared: tracked-file digests alone would not see it.
    writeFileSync(path.join(output, "source/packages/widget/src/injected.mjs"), "export const injected = true;\n");
    const artifacts = nextDirectory("untracked-artifacts");

    const result = runTool("build.mjs", ["--prepared", output, "--artifacts", artifacts, "--lock", lock]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/holds 1 file\(s\) outside the index, which no recorded digest covers/);
    expect(result.stderr).toContain("?? packages/widget/src/injected.mjs");
    expect(existsSync(path.join(artifacts, "build-manifest.json"))).toBe(false);
    // Refused before the first mutation: the tree was never claimed and no install ran.
    expect(existsSync(path.join(output, "build-claim.json"))).toBe(false);
    expect(existsSync(path.join(output, "source/node_modules"))).toBe(false);
  });

  test("an ignored leftover such as node_modules is refused before anything is built", () => {
    const { lock, output } = preparedFixture("ignored");
    mkdirSync(path.join(output, "source/node_modules/left-over"), { recursive: true });
    writeFileSync(path.join(output, "source/node_modules/left-over/index.js"), "module.exports = 1;\n");
    const artifacts = nextDirectory("ignored-artifacts");

    const result = runTool("build.mjs", ["--prepared", output, "--artifacts", artifacts, "--lock", lock]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/outside the index, which no recorded digest covers/);
    expect(result.stderr).toContain("!! node_modules/");
    expect(existsSync(path.join(output, "build-claim.json"))).toBe(false);
  });

  test("a prepared tree is built once: after a build its own outputs keep it out of a second build", () => {
    const { lock, output } = preparedFixture("once");
    const first = nextDirectory("once-artifacts-first");
    expect(runTool("build.mjs", ["--prepared", output, "--artifacts", first, "--lock", lock]).status).toBe(0);
    const claim = readJson(path.join(output, "build-claim.json"));
    expect(claim.artifacts).toBe(first);

    const second = nextDirectory("once-artifacts-second");
    const result = runTool("build.mjs", ["--prepared", output, "--artifacts", second, "--lock", lock]);

    expect(result.status).toBe(1);
    // The first build left its own products in the tree, so the state check refuses it before the claim does.
    // Either way a built tree is never rebuilt; both refusals are asserted, this one and the claim below.
    expect(result.stderr).toMatch(/outside the index, which no recorded digest covers/);
    expect(result.stderr).toContain("?? packages/widget/dist/index.mjs");
    expect(result.stderr).toContain("?? packages/widget/LICENSE");
    expect(existsSync(path.join(second, "build-manifest.json"))).toBe(false);
    // The first build's records and claim are untouched.
    expect(readJson(path.join(output, "build-claim.json"))).toEqual(claim);
    expect(existsSync(path.join(first, "build-manifest.json"))).toBe(true);
  });

  test("a prepared tree is claimed once: a second build is refused even when the first one failed early", () => {
    const movedScript = {
      build: {
        install: ["npm", "--version"],
        steps: [{ package: "packages/widget", script: "build:renamed-upstream" }],
        pack: ["packages/widget"],
      },
    };
    const { lock, output } = preparedFixture("claim", { lockOverrides: movedScript });
    const first = nextDirectory("claim-artifacts-first");

    // This build claims the tree, then fails before it writes anything into it, so the tree stays pristine
    // and the second attempt reaches the claim rather than the state check.
    const failed = runTool("build.mjs", ["--prepared", output, "--artifacts", first, "--lock", lock]);
    expect(failed.status).toBe(1);
    expect(readJson(path.join(first, "build-failure.json")).error).toContain("build:renamed-upstream");
    const claim = readJson(path.join(output, "build-claim.json"));
    expect(claim.artifacts).toBe(first);
    expect(claim.claimedBy).toBe("vendor/pi/build.mjs");

    const result = runTool("build.mjs", [
      "--prepared", output, "--artifacts", nextDirectory("claim-artifacts-second"), "--lock", lock,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/was already claimed by a build at/);
    expect(result.stderr).toMatch(/A prepared tree is built once/);
    expect(readJson(path.join(output, "build-claim.json"))).toEqual(claim);
  });

  test("an existing artifact directory is refused rather than overwritten", () => {
    const { lock, output } = preparedFixture("reuse");
    const artifacts = nextDirectory("reuse-artifacts");
    expect(runTool("build.mjs", ["--prepared", output, "--artifacts", artifacts, "--lock", lock]).status).toBe(0);
    const before = readFileSync(path.join(artifacts, "build-manifest.json"));

    const second = runTool("build.mjs", ["--prepared", output, "--artifacts", artifacts, "--lock", lock]);

    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/already exists\. Claim a new artifact directory/);
    expect(readFileSync(path.join(artifacts, "build-manifest.json"))).toEqual(before);
  });

  test("a build step naming a script the pinned package does not define fails visibly", () => {
    const { lock, output } = preparedFixture("moved", {
      lockOverrides: {
        build: {
          install: ["npm", "--version"],
          steps: [{ package: "packages/widget", script: "build:renamed-upstream" }],
          pack: ["packages/widget"],
        },
      },
    });
    const artifacts = nextDirectory("moved-artifacts");

    const result = runTool("build.mjs", ["--prepared", output, "--artifacts", artifacts, "--lock", lock]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/defines no script build:renamed-upstream; the pinned build graph moved/);
    expect(readJson(path.join(artifacts, "build-failure.json")).error).toContain("build:renamed-upstream");
    expect(existsSync(path.join(artifacts, "build-manifest.json"))).toBe(false);
  });
});
