#!/usr/bin/env node
// Materialise the pinned upstream Pi source in a new output directory and apply the ordered patch
// series. Nothing here builds, installs or packs: preparation is separated from the build so a source
// identity failure can never be mistaken for a build failure.
//
//   node vendor/pi/prepare.mjs --output <new directory> [--lock <file>] [--patches <directory>]
//
// Fail-closed by construction: the output directory must not exist, the commit and tree must be the
// locked ones, every locked file digest must match, the series must apply in its exact order with no
// fuzz and no three-way fallback, the patched state is recorded from the index so an added file is
// covered too, nothing may remain outside that index, and `provenance.json` is written once, last, and
// only on success.

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ProvenanceError,
  loadLock,
  parseArguments,
  readSeries,
  run,
  sha256Of,
  sha256OfFile,
  strayEntries,
  writeFileOnce,
  writeJsonOnce,
} from "./provenance.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);

export function prepare({ output, lockFile, patchesDirectory }) {
  const { lock, sha256: lockSha256 } = loadLock(lockFile);
  const series = readSeries(patchesDirectory);
  const baseline = series.names.length === 0;

  // The claim. `mkdirSync` without `recursive` fails on an existing directory, so a reused output
  // directory is refused here, before anything is fetched and before any earlier record is at risk.
  try {
    mkdirSync(output, { recursive: false });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new ProvenanceError(
        `${output} already exists. Claim a new output directory; an earlier attempt is never reused or overwritten.`,
      );
    }
    if (error.code === "ENOENT") {
      throw new ProvenanceError(`${path.dirname(output)} does not exist; create the parent output root first.`);
    }
    throw error;
  }

  const source = path.join(output, "source");
  const record = {
    tool: "vendor/pi/prepare.mjs",
    startedAt: new Date().toISOString(),
    host: hostname(),
    slurmJobId: process.env.SLURM_JOB_ID ?? null,
    node: process.version,
    output,
    source,
    lock: { file: lockFile, sha256: lockSha256, upstream: lock.upstream },
    series: { file: series.seriesFile, sha256: series.sha256, names: series.names, patches: series.patches },
    baseline,
    commands: [],
  };
  const remember = (result) => {
    record.commands.push({
      command: [result.command, ...result.args],
      cwd: result.cwd,
      status: result.status,
      seconds: result.seconds,
    });
    return result;
  };

  try {
    // Intent before action, so an interrupted preparation leaves a readable claim rather than a bare
    // directory of unknown origin.
    writeJsonOnce(path.join(output, "prepare-intent.json"), {
      startedAt: record.startedAt,
      output,
      lock: record.lock,
      series: record.series,
      baseline,
    });

    mkdirSync(source);
    const git = (...args) => remember(run("git", args, { cwd: source }));
    git("init", "--quiet", "--initial-branch", "pinned");
    git("remote", "add", "origin", lock.upstream.repository);
    // Fetch the exact object, never a branch or tag: a moving ref cannot be a pin. Depth 1 keeps this
    // to the pinned commit alone.
    git("fetch", "--depth", "1", "--no-tags", "origin", lock.upstream.commit);
    git("checkout", "--quiet", "--detach", "FETCH_HEAD");

    const head = git("rev-parse", "HEAD").stdout.trim();
    if (head !== lock.upstream.commit) {
      throw new ProvenanceError(`fetched commit ${head} is not the locked ${lock.upstream.commit}`);
    }
    const tree = git("rev-parse", "HEAD^{tree}").stdout.trim();
    if (tree !== lock.upstream.treeHash) {
      throw new ProvenanceError(
        `fetched tree ${tree} is not the locked ${lock.upstream.treeHash}; the commit resolved but its content did not`,
      );
    }
    record.resolved = { commit: head, treeHash: tree };

    record.verifiedFiles = lock.verifiedFiles.map((entry) => {
      const file = path.join(source, entry.path);
      if (!existsSync(file)) throw new ProvenanceError(`locked file is missing from the pinned tree: ${entry.path}`);
      const observed = sha256OfFile(file);
      if (observed !== entry.sha256) {
        throw new ProvenanceError(
          `checksum mismatch for ${entry.path}\n  locked:   ${entry.sha256}\n  observed: ${observed}`,
        );
      }
      return { path: entry.path, sha256: observed };
    });

    record.packages = lock.packages.map((entry) => {
      const manifest = path.join(source, entry.path, "package.json");
      if (!existsSync(manifest)) throw new ProvenanceError(`locked package has no package.json: ${entry.path}`);
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name !== entry.name || parsed.version !== entry.version) {
        throw new ProvenanceError(
          `${entry.path} is ${parsed.name}@${parsed.version}, not the locked ${entry.name}@${entry.version}`,
        );
      }
      return { path: entry.path, name: parsed.name, version: parsed.version };
    });

    record.applied = applySeries({ source, patchesDirectory, series, remember });

    // The complete patched state, from the index rather than from the working tree alone. `git apply --index`
    // stages every added, modified and deleted path, so `write-tree` covers an add-only patch that a
    // tracked-file diff of the working tree would report as no change at all.
    const patchedTreeHash = git("write-tree").stdout.trim();
    const diff = git("diff", "--no-color", "--full-index", "HEAD");
    writeFileOnce(path.join(output, "applied.diff"), diff.stdout);
    const workingDiffSha256 = sha256Of(diff.stdout);

    // Nothing may sit outside the index when preparation ends: an untracked or ignored file here would be
    // source that no digest covers. `--index` is what makes this reachable, and this is what makes
    // `patchedTreeHash` a complete description of the prepared tree.
    const status = git("status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching");
    const stray = strayEntries(status.stdout);
    if (stray.length > 0) {
      throw new ProvenanceError(
        `the prepared tree holds ${stray.length} file(s) outside the index, which no digest would cover:\n` +
          `  ${stray.join("\n  ")}`,
      );
    }

    const changed = patchedTreeHash !== tree;
    if (baseline && changed) {
      throw new ProvenanceError("the series is empty but the prepared tree differs from the pinned commit");
    }
    if (!baseline && !changed) {
      throw new ProvenanceError("the series applied but the prepared tree is unchanged");
    }
    record.patchedTreeHash = patchedTreeHash;
    record.workingDiffSha256 = workingDiffSha256;
    record.stagedStatus = status.stdout.split("\n").filter((line) => line.trim() !== "");
    record.artifactLabel = baseline
      ? "baseline: unmodified upstream Pi at the pinned commit. No pi-agents source patch is applied and no new native capability is present."
      : `patched: ${series.names.length} ordered pi-agents source patch(es) applied to the pinned commit.`;
    record.finishedAt = new Date().toISOString();

    // Written once and last: a directory holding provenance.json is a prepared tree, and nothing else is.
    writeJsonOnce(path.join(output, "provenance.json"), record);
    return record;
  } catch (error) {
    record.failedAt = new Date().toISOString();
    record.error = String(error?.message ?? error);
    writeJsonOnce(path.join(output, "prepare-failure.json"), record);
    throw error;
  }
}

function applySeries({ source, patchesDirectory, series, remember }) {
  const applied = [];
  for (const [index, name] of series.names.entries()) {
    const patch = path.join(patchesDirectory, name);
    const position = `${index + 1}/${series.names.length}`;
    // `--check` first, then apply, both with `--index`. No `-3`, no `--reject`, no fuzz: `git apply`
    // refuses a patch that does not apply exactly, and an already-applied or partially applied patch is
    // exactly that case. `--index` also stages what the patch adds, so a new file is tracked from the
    // moment it appears rather than sitting untracked and undigested.
    const check = run("git", ["apply", "--check", "--index", "--whitespace=error", patch], {
      cwd: source,
      allowNonZero: true,
    });
    remember(check);
    if (check.status !== 0) {
      throw new ProvenanceError(
        `patch ${position} ${name} does not apply to the pinned tree in this order. No fuzz, no three-way ` +
          `merge and no skip is attempted.\n--- git apply --check ---\n${check.stderr}${check.stdout}`,
      );
    }
    remember(run("git", ["apply", "--index", "--whitespace=error", patch], { cwd: source }));
    applied.push({ position: index + 1, name, sha256: series.patches[index].sha256 });
  }
  return applied;
}

function main(argv) {
  const parsed = parseArguments(argv, { flags: ["output", "lock", "patches"] });
  if (!parsed.output) throw new ProvenanceError("--output <new directory> is required");
  const record = prepare({
    output: path.resolve(parsed.output),
    lockFile: path.resolve(parsed.lock ?? path.join(HERE, "upstream-lock.json")),
    patchesDirectory: path.resolve(parsed.patches ?? path.join(HERE, "patches")),
  });
  process.stdout.write(
    `prepared ${record.resolved.commit} in ${record.source}\n` +
      `patches applied: ${record.applied.length}\n${record.artifactLabel}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(HERE, "prepare.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`prepare failed: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}
