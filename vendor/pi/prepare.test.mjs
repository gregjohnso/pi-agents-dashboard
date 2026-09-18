// Preparation of the pinned upstream source: every refusal this foundation depends on, exercised
// against a real fixture git upstream and real `git apply` runs.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createFixtureUpstream, readJson, runTool, writeFixtureLock, writeFixtureSeries } from "./fixture-repository.mjs";

let root;
let upstream;
let counter = 0;

// sha256 of the empty string: the working diff of a baseline preparation.
const EMPTY_DIFF_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const nextOutput = (label) => path.join(root, "outputs", `${label}-${(counter += 1)}`);

function prepare({ lock, patches, output }) {
  return runTool("prepare.mjs", ["--lock", lock, "--patches", patches, "--output", output]);
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "vendor-pi-prepare-"));
  mkdirSync(path.join(root, "outputs"));
  upstream = createFixtureUpstream(root);
});

afterAll(() => {
  // The fixture tree is disposable, but never silently: its path is reported so a failed run is readable.
  if (process.env.VENDOR_PI_KEEP_FIXTURES) process.stdout.write(`fixture root kept at ${root}\n`);
});

describe("prepare.mjs, positive paths", () => {
  test("an empty series prepares the pinned commit and labels the result baseline", () => {
    const lock = writeFixtureLock(path.join(root, "locks/baseline.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/baseline"), []);
    const output = nextOutput("baseline");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(0);
    const provenance = readJson(path.join(output, "provenance.json"));
    expect(provenance.resolved).toEqual({ commit: upstream.commit, treeHash: upstream.treeHash });
    expect(provenance.applied).toEqual([]);
    expect(provenance.baseline).toBe(true);
    expect(provenance.artifactLabel).toMatch(/^baseline: unmodified upstream/);
    expect(readFileSync(path.join(output, "applied.diff"), "utf8")).toBe("");
    // A baseline's complete patched state is the pinned tree itself, and nothing sits outside the index.
    expect(provenance.patchedTreeHash).toBe(upstream.treeHash);
    expect(provenance.workingDiffSha256).toBe(EMPTY_DIFF_SHA256);
    expect(provenance.stagedStatus).toEqual([]);
    expect(provenance.packages).toEqual([
      { path: "packages/widget", name: "@pi-foundation-fixture/widget", version: "1.2.3" },
    ]);
  });

  test("an ordered series applies each patch exactly once and records its digest", () => {
    const lock = writeFixtureLock(path.join(root, "locks/patched.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/patched"), [
      "0001-add-native-marker.patch",
      "0002-upgrade-native-marker.patch",
    ]);
    const output = nextOutput("patched");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(0);
    const provenance = readJson(path.join(output, "provenance.json"));
    expect(provenance.baseline).toBe(false);
    expect(provenance.applied.map((entry) => [entry.position, entry.name])).toEqual([
      [1, "0001-add-native-marker.patch"],
      [2, "0002-upgrade-native-marker.patch"],
    ]);
    expect(provenance.applied[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const applied = readFileSync(path.join(output, "source/packages/widget/src/index.mjs"), "utf8");
    expect(applied.match(/nativeMarker/g)).toHaveLength(1);
    expect(applied).toContain('"pi-agents native marker v2"');
    expect(provenance.workingDiffSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path.join(output, "applied.diff"), "utf8")).toContain("nativeMarker");
  });

  test("an add-only patch is applied, tracked and recorded, not reported as no change", () => {
    const lock = writeFixtureLock(path.join(root, "locks/added.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/added"), ["0006-add-native-seam-file.patch"]);
    const output = nextOutput("added");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(0);
    const provenance = readJson(path.join(output, "provenance.json"));
    expect(provenance.baseline).toBe(false);
    expect(provenance.applied.map((entry) => entry.name)).toEqual(["0006-add-native-seam-file.patch"]);
    // The added file exists, is inside the recorded state, and is not left outside the index.
    expect(readFileSync(path.join(output, "source/packages/widget/src/native-seam.mjs"), "utf8")).toContain("nativeSeam");
    expect(provenance.patchedTreeHash).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.patchedTreeHash).not.toBe(upstream.treeHash);
    expect(readFileSync(path.join(output, "applied.diff"), "utf8")).toContain("packages/widget/src/native-seam.mjs");
    expect(provenance.workingDiffSha256).not.toBe(EMPTY_DIFF_SHA256);
    expect(provenance.stagedStatus).toEqual(["A  packages/widget/src/native-seam.mjs"]);
  });

  test("a mixed patch records both the added file and the modified file", () => {
    const lock = writeFixtureLock(path.join(root, "locks/mixed.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/mixed"), ["0007-mixed-add-and-modify.patch"]);
    const output = nextOutput("mixed");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(0);
    const provenance = readJson(path.join(output, "provenance.json"));
    const diff = readFileSync(path.join(output, "applied.diff"), "utf8");
    expect(diff).toContain("packages/widget/src/native-seam.mjs");
    expect(diff).toContain("widget with a seam");
    expect(provenance.stagedStatus.sort()).toEqual([
      "A  packages/widget/src/native-seam.mjs",
      "M  packages/widget/src/index.mjs",
    ]);
    expect(provenance.patchedTreeHash).not.toBe(upstream.treeHash);
  });
});

describe("prepare.mjs, refusals", () => {
  test("a commit the upstream does not have fails and writes no provenance", () => {
    const lock = writeFixtureLock(path.join(root, "locks/wrong-commit.json"), upstream, {
      upstream: { commit: "0".repeat(40) },
    }).file;
    const patches = writeFixtureSeries(path.join(root, "series/wrong-commit"), []);
    const output = nextOutput("wrong-commit");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(1);
    expect(existsSync(path.join(output, "provenance.json"))).toBe(false);
    expect(readJson(path.join(output, "prepare-failure.json")).error).toMatch(/git fetch|exited/);
  });

  test("a tree hash that does not match the fetched commit fails", () => {
    const lock = writeFixtureLock(path.join(root, "locks/wrong-tree.json"), upstream, {
      upstream: { treeHash: "1".repeat(40) },
    }).file;
    const patches = writeFixtureSeries(path.join(root, "series/wrong-tree"), []);
    const output = nextOutput("wrong-tree");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/fetched tree .* is not the locked/);
    expect(existsSync(path.join(output, "provenance.json"))).toBe(false);
  });

  test("a locked file checksum that does not match fails with both digests", () => {
    const lock = writeFixtureLock(path.join(root, "locks/wrong-digest.json"), upstream, {
      verifiedFiles: [{ path: "package.json", sha256: "a".repeat(64) }],
    }).file;
    const patches = writeFixtureSeries(path.join(root, "series/wrong-digest"), []);
    const output = nextOutput("wrong-digest");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/checksum mismatch for package\.json/);
    expect(readJson(path.join(output, "prepare-failure.json")).error).toContain("a".repeat(64));
  });

  test("a patch whose context is not in the pinned tree is refused, not fuzzed", () => {
    const lock = writeFixtureLock(path.join(root, "locks/mismatch.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/mismatch"), ["0003-unmatched-context.patch"]);
    const output = nextOutput("mismatch");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not apply to the pinned tree in this order/);
    expect(result.stderr).toMatch(/No fuzz, no three-way merge and no skip/);
    expect(existsSync(path.join(output, "provenance.json"))).toBe(false);
    expect(readFileSync(path.join(output, "source/packages/widget/src/index.mjs"), "utf8")).toContain("stock widget");
  });

  test("the wrong order fails: a patch that needs its predecessor cannot go first", () => {
    const lock = writeFixtureLock(path.join(root, "locks/order.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/order"), [
      "0002-upgrade-native-marker.patch",
      "0001-add-native-marker.patch",
    ]);
    const output = nextOutput("order");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/patch 1\/2 0002-upgrade-native-marker\.patch does not apply/);
    expect(existsSync(path.join(output, "provenance.json"))).toBe(false);
  });

  test("an already-applied patch fails instead of being skipped", () => {
    const lock = writeFixtureLock(path.join(root, "locks/already.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/already"), [
      "0001-add-native-marker.patch",
      "0004-duplicate-native-marker.patch",
    ]);
    const output = nextOutput("already");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/patch 2\/2 0004-duplicate-native-marker\.patch does not apply/);
    expect(existsSync(path.join(output, "provenance.json"))).toBe(false);
    // The first patch stays applied in the failed attempt's tree, which is why the tree is never built.
    expect(readFileSync(path.join(output, "source/packages/widget/src/index.mjs"), "utf8")).toContain("nativeMarker");
  });

  test("a patch with one unmatched hunk applies none of its files", () => {
    const lock = writeFixtureLock(path.join(root, "locks/partial.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/partial"), ["0005-two-files-one-unmatched.patch"]);
    const output = nextOutput("partial");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(1);
    const source = path.join(output, "source");
    expect(readFileSync(path.join(source, "packages/widget/src/index.mjs"), "utf8")).toContain("stock widget");
    expect(readFileSync(path.join(source, "README.md"), "utf8")).not.toContain("appended line");
    expect(existsSync(path.join(output, "provenance.json"))).toBe(false);
  });

  test("the same patch twice in one series is refused before anything is fetched", () => {
    const lock = writeFixtureLock(path.join(root, "locks/repeat.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/repeat"), [
      "0001-add-native-marker.patch",
      "0001-add-native-marker.patch",
    ]);
    const output = nextOutput("repeat");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/a patch may appear once/);
    expect(existsSync(output)).toBe(false);
  });

  test("a patch file the series does not name is drift, not an extra", () => {
    const lock = writeFixtureLock(path.join(root, "locks/drift.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/drift"), [], {
      includeUnlisted: ["0001-add-native-marker.patch"],
    });
    const output = nextOutput("drift");

    const result = prepare({ lock, patches, output });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/patches present but not in the series: 0001-add-native-marker\.patch/);
  });

  test("a lock with the wrong schema version is refused", () => {
    const lock = writeFixtureLock(path.join(root, "locks/schema.json"), upstream, { schemaVersion: 99 }).file;
    const patches = writeFixtureSeries(path.join(root, "series/schema"), []);

    const result = prepare({ lock, patches, output: nextOutput("schema") });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/schemaVersion must be 1, not 99/);
  });

  test("a reused output directory is refused and the earlier attempt's records are untouched", () => {
    const lock = writeFixtureLock(path.join(root, "locks/reuse.json"), upstream).file;
    const patches = writeFixtureSeries(path.join(root, "series/reuse"), ["0001-add-native-marker.patch"]);
    const output = nextOutput("reuse");

    const first = prepare({ lock, patches, output });
    expect(first.status).toBe(0);
    const provenanceFile = path.join(output, "provenance.json");
    const before = { bytes: readFileSync(provenanceFile), mtimeMs: statSync(provenanceFile).mtimeMs };

    const second = prepare({ lock, patches, output });

    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/already exists\. Claim a new output directory/);
    expect(readFileSync(provenanceFile)).toEqual(before.bytes);
    expect(statSync(provenanceFile).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(path.join(output, "prepare-failure.json"))).toBe(false);
  });
});
