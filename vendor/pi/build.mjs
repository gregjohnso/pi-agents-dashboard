#!/usr/bin/env node
// Build and pack the pinned Pi package cohort from a directory that `prepare.mjs` already prepared.
// Upstream's own npm scripts do the building; this file only verifies, orders, hashes and records.
//
//   node vendor/pi/build.mjs --prepared <prepare output> --artifacts <new directory> [--dry-run]
//
// Fail-closed by construction: the prepared tree must carry a `provenance.json` whose commit, complete
// patched state and applied-diff digest still hold and which holds nothing outside its own index, the tree
// is claimed once so a built tree is never rebuilt, every pinned generated input must match its locked
// digest, every build step and check must exit zero, the required notice must be verified inside every
// tarball, and `build-manifest.json` is written once, last, and only on success. Nothing selects a version,
// resolves `latest` or mutates anything outside `--artifacts` and the prepared tree.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ProvenanceError,
  digestOfFileSet,
  loadLock,
  parseArguments,
  run,
  sha256Of,
  sha256OfFile,
  sha512IntegrityOfFile,
  strayEntries,
  writeJsonOnce,
} from "./provenance.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);

/**
 * The exact steps this build will run, in execution order, derived from the lock and nothing else.
 * `kind: "command"` steps appear again in the manifest's `commands` with their exit status; `kind: "file"`
 * steps are the pipeline's own packaging writes, which run no command and are recorded in their own field.
 */
export function buildPlan(lock) {
  const steps = [];
  // Generated inputs are fetched and verified before the install, which is the order the build runs in:
  // the install compiles against them.
  for (const input of lock.generatedInputs ?? []) {
    steps.push({ label: `registry:${input.id}`, kind: "command", argv: ["npm", "view", `${input.package}@${input.version}`, "dist", "--json"], cwd: "." });
    steps.push({ label: `download:${input.id}`, kind: "command", argv: ["npm", "pack", `${input.package}@${input.version}`], cwd: "." });
  }
  steps.push({ label: "install", kind: "command", argv: lock.build.install, cwd: "." });
  for (const step of lock.build.steps) {
    steps.push({ label: `build:${step.package}`, kind: "command", argv: ["npm", "--prefix", step.package, "run", step.script], cwd: "." });
  }
  for (const check of lock.build.checks ?? []) {
    steps.push({ label: `check:${check[1]}`, kind: "command", argv: check, cwd: "." });
  }
  steps.push({
    label: "license",
    kind: "file",
    detail: `copy the verified ${lock.upstream.license.path} into ${lock.build.pack.length} package root(s) as ` +
      `LICENSE before packing; npm always packs a root LICENSE`,
  });
  for (const target of lock.build.pack) {
    steps.push({ label: `pack:${target}`, kind: "command", argv: ["npm", "pack", "--pack-destination", "{artifacts}", `./${target}`], cwd: "." });
  }
  return steps;
}

export function build({ prepared, artifacts, lockFile, dryRun = false }) {
  const provenanceFile = path.join(prepared, "provenance.json");
  if (!existsSync(provenanceFile)) {
    throw new ProvenanceError(
      `${prepared} carries no provenance.json. Only a directory prepared by prepare.mjs can be built; a failed ` +
        `preparation leaves prepare-failure.json instead and is never built.`,
    );
  }
  const provenance = JSON.parse(readFileSync(provenanceFile, "utf8"));
  const { lock, sha256: lockSha256 } = loadLock(lockFile);
  if (provenance.lock.sha256 !== lockSha256) {
    throw new ProvenanceError(
      `the prepared tree was prepared from a different lock\n  prepared with: ${provenance.lock.sha256}\n  this lock:     ${lockSha256}`,
    );
  }
  const source = provenance.source;
  if (!existsSync(source)) throw new ProvenanceError(`prepared source is missing: ${source}`);

  const plan = buildPlan(lock);
  if (dryRun) return { dryRun: true, prepared, source, plan, baseline: provenance.baseline };

  try {
    mkdirSync(artifacts, { recursive: false });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new ProvenanceError(
        `${artifacts} already exists. Claim a new artifact directory; an earlier build's artifacts are never overwritten.`,
      );
    }
    throw error;
  }

  const manifest = {
    tool: "vendor/pi/build.mjs",
    startedAt: new Date().toISOString(),
    host: hostname(),
    slurmJobId: process.env.SLURM_JOB_ID ?? null,
    slurmArrayTaskId: process.env.SLURM_ARRAY_TASK_ID ?? null,
    node: process.version,
    prepared,
    source,
    artifacts,
    lock: { file: lockFile, sha256: lockSha256 },
    buildKind: lock.buildKind ?? "pinned source only",
    upstream: provenance.lock.upstream,
    resolved: provenance.resolved,
    series: provenance.series,
    applied: provenance.applied,
    baseline: provenance.baseline,
    artifactLabel: provenance.artifactLabel,
    capability: provenance.baseline
      ? "none: baseline upstream artifacts. These packages carry no pi-agents native interface and prove no A-G capability."
      : "see the applied patch series; each patch carries its own regression test.",
    plan: plan.map((step) => ({ label: step.label, kind: step.kind, argv: step.argv ?? null, detail: step.detail ?? null })),
    commands: [],
  };
  const remember = (label, result) => {
    manifest.commands.push({
      label,
      command: [result.command, ...result.args],
      cwd: result.cwd,
      status: result.status,
      seconds: result.seconds,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
    });
    return result;
  };

  try {
    // Read-only verification first: a bogus invocation must not burn the prepared tree's one claim.
    manifest.preparedState = verifyPreparedState({ source, provenance, remember });
    // The one-shot claim, taken before the first mutation. Hydration, install and the license copy all
    // write into the prepared tree, so a tree that has been built once can never be built again: a second
    // build would compile against leftover node_modules, generated data or a stale dist.
    manifest.preparedClaim = claimPreparedTree({ prepared, artifacts, provenance });
    manifest.npm = run("npm", ["--version"], { cwd: source }).stdout.trim();
    manifest.generatedInputs = (lock.generatedInputs ?? []).map((input) =>
      hydrateGeneratedInput({ input, source, artifacts, remember }),
    );

    remember("install", run(lock.build.install[0], lock.build.install.slice(1), { cwd: source }));
    for (const step of lock.build.steps) {
      requireScript({ source, step });
      remember(`build:${step.package}`, run("npm", ["--prefix", step.package, "run", step.script], { cwd: source }));
    }
    for (const check of lock.build.checks ?? []) {
      remember(`check:${check[1]}`, run(check[0], check.slice(1), { cwd: source }));
    }

    manifest.license = includeLicense({ source, lock });
    manifest.artifactFiles = lock.build.pack.map((target) =>
      packOne({ source, artifacts, target, license: manifest.license, remember }),
    );
    manifest.bundledCli = describeBundledCli({ source, lock });
    manifest.finishedAt = new Date().toISOString();
    manifest.reproducibility =
      "built from pinned inputs: the pinned upstream commit plus any pinned release-generated data listed in " +
      "generatedInputs. This is not a source-only reconstruction of the published release. Byte reproducibility " +
      "is not claimed from this build; compare the artifact digests of two independent builds to assess it.";

    writeJsonOnce(path.join(artifacts, "build-manifest.json"), manifest);
    return manifest;
  } catch (error) {
    manifest.failedAt = new Date().toISOString();
    manifest.error = String(error?.message ?? error);
    writeJsonOnce(path.join(artifacts, "build-failure.json"), manifest);
    throw error;
  }
}

function tail(text, lines = 20) {
  const parts = String(text ?? "").trimEnd().split("\n");
  return parts.slice(-lines).join("\n");
}

/**
 * The prepared tree is still exactly the tree that was prepared: same commit, same complete patched state
 * from the index, same working diff, and nothing outside that index. The last check is what keeps injected
 * source, a leftover `node_modules`, a stale `dist` or pre-hydrated generated data out of a build, and it
 * runs before the first mutation, while those paths would still be untracked or ignored.
 */
function verifyPreparedState({ source, provenance, remember }) {
  const head = remember("verify:commit", run("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  if (head !== provenance.resolved.commit) {
    throw new ProvenanceError(`prepared source is at ${head}, not the prepared ${provenance.resolved.commit}`);
  }
  if (typeof provenance.patchedTreeHash !== "string") {
    throw new ProvenanceError(
      "the prepared tree records no patchedTreeHash; it was prepared by an older prepare.mjs that could not " +
        "describe an added file. Prepare a new tree.",
    );
  }
  // `write-tree` reads the index and writes tree objects into `.git`; it changes no source file.
  const tree = remember("verify:tree", run("git", ["write-tree"], { cwd: source })).stdout.trim();
  if (tree !== provenance.patchedTreeHash) {
    throw new ProvenanceError(
      `the prepared tree changed after preparation\n  prepared: ${provenance.patchedTreeHash}\n  observed: ${tree}`,
    );
  }
  const diff = remember("verify:diff", run("git", ["diff", "--no-color", "--full-index", "HEAD"], { cwd: source }));
  const observed = sha256Of(diff.stdout);
  if (observed !== provenance.workingDiffSha256) {
    throw new ProvenanceError(
      `the prepared tree changed after preparation\n  prepared: ${provenance.workingDiffSha256}\n  observed: ${observed}`,
    );
  }
  const status = remember(
    "verify:status",
    run("git", ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], { cwd: source }),
  );
  const stray = strayEntries(status.stdout);
  if (stray.length > 0) {
    throw new ProvenanceError(
      `the prepared tree holds ${stray.length} file(s) outside the index, which no recorded digest covers. ` +
        `Untracked or ignored source, a leftover node_modules, a stale dist or pre-hydrated generated data is ` +
        `never built:\n  ${stray.slice(0, 20).join("\n  ")}`,
    );
  }
  return { commit: head, patchedTreeHash: tree, workingDiffSha256: observed, strayFiles: stray };
}

/**
 * Claim the prepared tree exactly once. The record is written with `wx` inside the prepared directory, so a
 * second build of the same tree fails here whether the first one succeeded or failed.
 */
function claimPreparedTree({ prepared, artifacts, provenance }) {
  const claimFile = path.join(prepared, "build-claim.json");
  const claim = {
    claimedAt: new Date().toISOString(),
    claimedBy: "vendor/pi/build.mjs",
    artifacts,
    host: hostname(),
    slurmJobId: process.env.SLURM_JOB_ID ?? null,
    pid: process.pid,
    commit: provenance.resolved.commit,
    patchedTreeHash: provenance.patchedTreeHash,
  };
  try {
    writeJsonOnce(claimFile, claim);
  } catch (error) {
    if (error.code === "EEXIST") {
      const earlier = JSON.parse(readFileSync(claimFile, "utf8"));
      throw new ProvenanceError(
        `${prepared} was already claimed by a build at ${earlier.claimedAt} for ${earlier.artifacts}. A prepared ` +
          `tree is built once: after a build it holds installed dependencies, hydrated data and built dist, so a ` +
          `second build would not be a build of the pinned source. Prepare a new tree.`,
      );
    }
    throw error;
  }
  return { file: claimFile, ...claim };
}

function requireScript({ source, step }) {
  const manifestFile = path.join(source, step.package, "package.json");
  if (!existsSync(manifestFile)) throw new ProvenanceError(`build step names no package: ${step.package}`);
  const scripts = JSON.parse(readFileSync(manifestFile, "utf8")).scripts ?? {};
  if (!scripts[step.script]) {
    throw new ProvenanceError(`${step.package} defines no script ${step.script}; the pinned build graph moved`);
  }
}

/**
 * Materialise one pinned release-generated build input from the published artifact of the same version.
 * This is the one input that does not come from the pinned commit, so it is verified before it is used and
 * there is no fallback: the registry URL and integrity, the downloaded tarball's own integrity, size and
 * digest, the exact selected file set, every per-file digest and the extension allowlist must all match the
 * lock. Only generated data may arrive this way; executable code and the bundled CLI are rebuilt from source.
 */
function hydrateGeneratedInput({ input, source, artifacts, remember }) {
  const spec = `${input.package}@${input.version}`;
  const published = JSON.parse(
    remember(`registry:${input.id}`, run("npm", ["view", spec, "dist", "--json"], { cwd: source })).stdout,
  );
  if (published.tarball !== input.registryTarball) {
    throw new ProvenanceError(
      `${spec} registry tarball changed\n  locked:   ${input.registryTarball}\n  observed: ${published.tarball}`,
    );
  }
  if (published.integrity !== input.registryIntegrity) {
    throw new ProvenanceError(
      `${spec} registry integrity changed\n  locked:   ${input.registryIntegrity}\n  observed: ${published.integrity}`,
    );
  }

  const scratch = mkdtempSync(path.join(tmpdir(), `pi-generated-input-${input.id}-`));
  remember(`download:${input.id}`, run("npm", ["pack", spec, "--pack-destination", scratch], { cwd: scratch }));
  const tarballs = readdirSync(scratch).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new ProvenanceError(`${spec} produced ${tarballs.length} tarballs, expected 1`);
  const tarball = path.join(scratch, tarballs[0]);

  // The downloaded bytes, against the locked subresource integrity, size and digest. Checked here, before
  // the archive is opened.
  const observed = {
    integrity: sha512IntegrityOfFile(tarball),
    sha256: sha256OfFile(tarball),
    bytes: statSync(tarball).size,
  };
  if (observed.integrity !== input.registryIntegrity) {
    throw new ProvenanceError(
      `${spec} tarball integrity mismatch\n  locked:   ${input.registryIntegrity}\n  observed: ${observed.integrity}`,
    );
  }
  if (observed.sha256 !== input.tarballSha256 || observed.bytes !== input.tarballBytes) {
    throw new ProvenanceError(
      `${spec} tarball bytes mismatch\n  locked:   ${input.tarballSha256} (${input.tarballBytes} bytes)\n` +
        `  observed: ${observed.sha256} (${observed.bytes} bytes)`,
    );
  }

  run("tar", ["-xzf", tarball, "-C", scratch, input.archiveMemberDirectory], { cwd: scratch });
  const from = path.join(scratch, input.archiveMemberDirectory);
  const names = readdirSync(from).sort();
  const locked = Object.keys(input.files).sort();
  const unexpected = names.filter((name) => !locked.includes(name));
  const missing = locked.filter((name) => !names.includes(name));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new ProvenanceError(
      `${spec} ${input.archiveMemberDirectory} file set changed\n  unexpected: ${unexpected.join(", ") || "none"}\n` +
        `  missing:    ${missing.join(", ") || "none"}`,
    );
  }
  for (const name of names) {
    if (!statSync(path.join(from, name)).isFile()) throw new ProvenanceError(`${name} is not a regular file`);
    if (!input.allowedExtensions.some((extension) => name.endsWith(extension))) {
      throw new ProvenanceError(`${name} is outside allowedExtensions; a published artifact may supply data only`);
    }
    const digest = sha256OfFile(path.join(from, name));
    if (digest !== input.files[name]) {
      throw new ProvenanceError(`${name} digest mismatch\n  locked:   ${input.files[name]}\n  observed: ${digest}`);
    }
  }
  const { digest, listing } = digestOfFileSet(from, names);
  if (digest !== input.filesDigest) {
    throw new ProvenanceError(
      `${spec} ${input.archiveMemberDirectory} content digest mismatch\n  locked:   ${input.filesDigest}\n  observed: ${digest}`,
    );
  }

  const to = path.join(source, input.sourceDirectory);
  mkdirSync(to, { recursive: true });
  for (const name of names) copyFileSync(path.join(from, name), path.join(to, name));
  // The whole decision travels with the artifacts: URL, integrity, mapping, licence and every file digest.
  writeJsonOnce(path.join(artifacts, `generated-input-${input.id}.json`), {
    id: input.id,
    kind: input.kind ?? "release-generated-data",
    reason: input.reason,
    buildKindNote: input.buildKindNote ?? null,
    noFallback: input.noFallback ?? null,
    license: input.license ?? null,
    spec,
    registryTarball: published.tarball,
    registryIntegrity: published.integrity,
    registryShasum: published.shasum ?? null,
    downloaded: { file: path.basename(tarball), ...observed },
    mapping: { archiveMemberDirectory: input.archiveMemberDirectory, sourceDirectory: input.sourceDirectory },
    allowedExtensions: input.allowedExtensions,
    fileCount: names.length,
    filesDigest: digest,
    files: Object.fromEntries(names.map((name) => [name, input.files[name]])),
    listing: listing.trimEnd().split("\n"),
    upstreamManifest: input.upstreamManifest ?? null,
  });
  return {
    id: input.id,
    kind: input.kind ?? "release-generated-data",
    spec,
    registryTarball: published.tarball,
    registryIntegrity: published.integrity,
    downloaded: observed,
    mapping: { archiveMemberDirectory: input.archiveMemberDirectory, sourceDirectory: input.sourceDirectory },
    fileCount: names.length,
    filesDigest: digest,
  };
}

/**
 * Put the required notice in every artifact. Upstream ships no per-package license file, so the pinned root
 * license is copied into each packed package root as `LICENSE`; npm always packs a root LICENSE regardless of
 * the package's `files` list, which is what makes this reach the tarball. The bytes are verified against the
 * lock, and against the repository's own committed copy, before anything is written.
 */
function includeLicense({ source, lock }) {
  const declared = lock.upstream.license;
  const licenseFile = path.join(source, declared.path);
  if (!existsSync(licenseFile)) {
    throw new ProvenanceError(`the pinned tree has no ${declared.path}; the required notice cannot be packed`);
  }
  const sha256 = sha256OfFile(licenseFile);
  if (sha256 !== declared.sha256) {
    throw new ProvenanceError(
      `${declared.path} is not the locked notice\n  locked:   ${declared.sha256}\n  observed: ${sha256}`,
    );
  }
  let repositoryCopy = null;
  if (declared.copy) {
    const copyFile = path.join(HERE, declared.copy);
    if (!existsSync(copyFile)) throw new ProvenanceError(`vendor/pi/${declared.copy} is missing`);
    const copySha256 = sha256OfFile(copyFile);
    if (copySha256 !== sha256) {
      throw new ProvenanceError(
        `vendor/pi/${declared.copy} is not the pinned notice\n  pinned: ${sha256}\n  copy:   ${copySha256}`,
      );
    }
    repositoryCopy = { path: `vendor/pi/${declared.copy}`, sha256: copySha256 };
  }

  const addedTo = [];
  for (const target of lock.build.pack) {
    const destination = path.join(source, target, "LICENSE");
    if (existsSync(destination)) {
      // Upstream shipping its own package license would be a provenance question, not something to overwrite.
      const existing = sha256OfFile(destination);
      if (existing !== sha256) {
        throw new ProvenanceError(
          `${target}/LICENSE already exists with different bytes (${existing}); refusing to replace an ` +
            `upstream notice. Resolve the licence provenance before packing.`,
        );
      }
      addedTo.push({ target, action: "already present" });
      continue;
    }
    copyFileSync(licenseFile, destination);
    addedTo.push({ target, action: "copied" });
  }
  return {
    spdx: declared.spdx,
    holder: declared.holder,
    sourcePath: declared.path,
    sha256,
    bytes: statSync(licenseFile).size,
    packedAs: "LICENSE",
    repositoryCopy,
    addedTo,
    note:
      "Upstream packs no per-package license file, so this pipeline adds the pinned root notice to every packed " +
      "package root. Its digest is verified in the source tree and again inside each produced tarball.",
  };
}

function packOne({ source, artifacts, target, license, remember }) {
  const result = remember(
    `pack:${target}`,
    run("npm", ["pack", "--pack-destination", artifacts, `./${target}`], { cwd: source }),
  );
  const name = result.stdout.trim().split("\n").pop().trim();
  const file = path.join(artifacts, name);
  if (!existsSync(file)) throw new ProvenanceError(`npm pack reported ${name} but ${file} does not exist`);
  const declared = JSON.parse(readFileSync(path.join(source, target, "package.json"), "utf8"));
  return {
    package: declared.name,
    version: declared.version,
    sourcePath: target,
    file: name,
    bytes: statSync(file).size,
    sha256: sha256OfFile(file),
    licenseSha256: verifyPackedLicense({ file, license }),
    exports: declared.exports ?? null,
    bin: declared.bin ?? null,
  };
}

/** The notice is read back out of the produced tarball, so its presence is measured rather than assumed. */
function verifyPackedLicense({ file, license }) {
  const member = `package/${license.packedAs}`;
  const scratch = mkdtempSync(path.join(tmpdir(), "pi-packed-license-"));
  const extract = run("tar", ["-xzf", file, "-C", scratch, member], { cwd: scratch, allowNonZero: true });
  const extracted = path.join(scratch, member);
  if (extract.status !== 0 || !existsSync(extracted)) {
    throw new ProvenanceError(
      `${path.basename(file)} does not contain ${member}; the required notice is missing from the artifact\n${extract.stderr}`,
    );
  }
  const sha256 = sha256OfFile(extracted);
  if (sha256 !== license.sha256) {
    throw new ProvenanceError(
      `${path.basename(file)} ${member} is not the pinned notice\n  pinned:   ${license.sha256}\n  observed: ${sha256}`,
    );
  }
  return sha256;
}

/**
 * The bundled CLI is the entry point a dist-only patch would miss, so its rebuilt identity is recorded
 * explicitly rather than assumed from a successful build.
 */
function describeBundledCli({ source, lock }) {
  const codingAgent = lock.packages.find((entry) => entry.name === "@earendil-works/pi-coding-agent");
  if (!codingAgent) return null;
  const manifest = JSON.parse(readFileSync(path.join(source, codingAgent.path, "package.json"), "utf8"));
  const relative = manifest.bin?.pi;
  if (!relative) throw new ProvenanceError("the pinned coding-agent declares no `pi` bin; the build graph moved");
  const file = path.join(source, codingAgent.path, relative);
  if (!existsSync(file)) throw new ProvenanceError(`the bundled CLI was not built: ${file}`);
  const bundleDirectory = path.dirname(file);
  const files = readdirSync(bundleDirectory).sort();
  return {
    bin: relative,
    sha256: sha256OfFile(file),
    bytes: statSync(file).size,
    bundleFileCount: files.length,
    bundleDigest: digestOfFileSet(bundleDirectory, files.filter((name) => statSync(path.join(bundleDirectory, name)).isFile())).digest,
  };
}

function main(argv) {
  const parsed = parseArguments(argv, { flags: ["prepared", "artifacts", "lock"], booleans: ["dry-run"] });
  if (!parsed.prepared) throw new ProvenanceError("--prepared <prepare output directory> is required");
  const dryRun = parsed["dry-run"] === true;
  if (!dryRun && !parsed.artifacts) throw new ProvenanceError("--artifacts <new directory> is required");
  const result = build({
    prepared: path.resolve(parsed.prepared),
    artifacts: parsed.artifacts ? path.resolve(parsed.artifacts) : null,
    lockFile: path.resolve(parsed.lock ?? path.join(HERE, "upstream-lock.json")),
    dryRun,
  });
  if (dryRun) {
    process.stdout.write(
      `${result.plan.map((step) => `${step.label}: ${step.argv ? step.argv.join(" ") : step.detail}`).join("\n")}\n`,
    );
    return;
  }
  const digests = result.artifactFiles.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n");
  const cli = result.bundledCli ? `bundled cli ${result.bundledCli.bin} sha256 ${result.bundledCli.sha256}\n` : "";
  const notice = `notice ${result.license.spdx} sha256 ${result.license.sha256} in ${result.artifactFiles.length} artifact(s)\n`;
  process.stdout.write(`${digests}\n${cli}${notice}${result.artifactLabel}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(HERE, "build.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`build failed: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}
