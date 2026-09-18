// Shared, fail-closed helpers for the pinned Pi source lock: digests, write-once records, subprocesses
// and lock/series parsing. Node built-ins only, so preparation runs before any dependency is installed.

import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const LOCK_SCHEMA_VERSION = 1;
const HEX40 = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const PATCH_NAME = /^\d{4}-[a-z0-9][a-z0-9-]*\.patch$/;

/** A refused input or a refused state. Never a warning: every one of these aborts. */
export class ProvenanceError extends Error {}

export function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha512IntegrityOfFile(file) {
  return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
}

export function sha256OfFile(file) {
  return sha256Of(readFileSync(file));
}

/**
 * One digest over an ordered set of files: `<sha256>  <relative name>` lines, sorted by name.
 * A digest of the listing rather than of a tarball, because a re-packed tarball is not byte stable
 * while its contents are.
 */
export function digestOfFileSet(directory, names) {
  const listing = [...names].sort()
    .map((name) => `${sha256OfFile(path.join(directory, name))}  ${name}\n`)
    .join("");
  return { digest: sha256Of(listing), listing };
}

function fsyncDirectory(directory) {
  const handle = openSync(directory, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/**
 * Write a file a later run cannot overwrite: `wx` fails on an existing name, so a reused output
 * directory keeps the earlier attempt's evidence and this one reports the collision instead.
 */
export function writeFileOnce(file, text) {
  const handle = openSync(file, "wx");
  try {
    writeFileSync(handle, text);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  fsyncDirectory(path.dirname(file));
  return file;
}

export function writeJsonOnce(file, payload) {
  return writeFileOnce(file, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Run a command, capture both streams, and raise on any nonzero exit. No shell, ever. */
export function run(command, args, { cwd, env, allowNonZero = false } = {}) {
  const started = Date.now();
  let status = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(command, args, {
      cwd,
      env: env ?? process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    status = typeof error.status === "number" ? error.status : 1;
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? String(error.message ?? "");
    if (!allowNonZero) {
      throw new ProvenanceError(
        `${command} ${args.join(" ")} exited ${status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }
  }
  return { command, args, cwd: cwd ?? process.cwd(), status, stdout, stderr, seconds: (Date.now() - started) / 1000 };
}

function requireString(value, where) {
  if (typeof value !== "string" || value === "") throw new ProvenanceError(`${where} must be a non-empty string`);
  return value;
}

function requireMatch(value, pattern, where) {
  requireString(value, where);
  if (!pattern.test(value)) throw new ProvenanceError(`${where} must match ${pattern}: ${value}`);
  return value;
}

/**
 * Parse and validate the upstream lock. Every field a later step trusts is checked here, so an
 * incomplete or hand-edited lock fails before a network call, an install or a build.
 */
export function loadLock(file) {
  const bytes = readFileSync(file);
  const lock = JSON.parse(bytes.toString("utf8"));
  if (lock.schemaVersion !== LOCK_SCHEMA_VERSION) {
    throw new ProvenanceError(`${file}: schemaVersion must be ${LOCK_SCHEMA_VERSION}, not ${lock.schemaVersion}`);
  }
  requireString(lock.upstream?.repository, "upstream.repository");
  requireMatch(lock.upstream?.commit, HEX40, "upstream.commit");
  requireMatch(lock.upstream?.treeHash, HEX40, "upstream.treeHash");
  validateLicense(lock);
  if (!Array.isArray(lock.verifiedFiles) || lock.verifiedFiles.length === 0) {
    throw new ProvenanceError("verifiedFiles must list at least one file with its sha256");
  }
  for (const [index, entry] of lock.verifiedFiles.entries()) {
    requireString(entry?.path, `verifiedFiles[${index}].path`);
    requireMatch(entry?.sha256, SHA256_HEX, `verifiedFiles[${index}].sha256`);
  }
  if (!Array.isArray(lock.packages) || lock.packages.length === 0) {
    throw new ProvenanceError("packages must list at least one workspace package");
  }
  for (const [index, entry] of lock.packages.entries()) {
    requireString(entry?.path, `packages[${index}].path`);
    requireString(entry?.name, `packages[${index}].name`);
    requireMatch(entry?.version, EXACT_VERSION, `packages[${index}].version`);
  }
  validateBuildPlan(lock);
  validateGeneratedInputs(lock);
  return { lock, sha256: sha256Of(bytes) };
}

/**
 * The license notice every packed artifact must carry. It is declared here, not inferred, because upstream
 * ships no per-package license file and the build has to add the pinned root notice to each tarball.
 */
function validateLicense(lock) {
  const license = lock.upstream?.license;
  if (!license || typeof license !== "object") {
    throw new ProvenanceError("upstream.license must declare the notice that ships with every artifact");
  }
  requireString(license.spdx, "upstream.license.spdx");
  requireString(license.holder, "upstream.license.holder");
  requireString(license.path, "upstream.license.path");
  requireMatch(license.sha256, SHA256_HEX, "upstream.license.sha256");
  if (license.copy !== undefined) requireString(license.copy, "upstream.license.copy");
  const declared = (lock.verifiedFiles ?? []).find((entry) => entry?.path === license.path);
  if (declared && declared.sha256 !== license.sha256) {
    throw new ProvenanceError(
      `upstream.license.sha256 disagrees with verifiedFiles for ${license.path}\n` +
        `  license:       ${license.sha256}\n  verifiedFiles: ${declared.sha256}`,
    );
  }
}

function validateBuildPlan(lock) {
  const build = lock.build;
  if (!build || typeof build !== "object") throw new ProvenanceError("build must be an object");
  if (!Array.isArray(build.install) || build.install[0] !== "npm") {
    throw new ProvenanceError("build.install must be an npm argument vector");
  }
  if (!Array.isArray(build.steps) || build.steps.length === 0) {
    throw new ProvenanceError("build.steps must list at least one workspace build step");
  }
  for (const [index, step] of build.steps.entries()) {
    requireString(step?.package, `build.steps[${index}].package`);
    requireString(step?.script, `build.steps[${index}].script`);
  }
  const checks = build.checks ?? [];
  if (!Array.isArray(checks)) throw new ProvenanceError("build.checks must be an array when present");
  for (const [index, check] of checks.entries()) {
    if (!Array.isArray(check) || check.length === 0 || !check.every((part) => typeof part === "string")) {
      throw new ProvenanceError(`build.checks[${index}] must be a non-empty argument vector of strings`);
    }
    if (check[0] !== "node") throw new ProvenanceError(`build.checks[${index}] must run node, not ${check[0]}`);
  }
  if (!Array.isArray(build.pack) || build.pack.length === 0) {
    throw new ProvenanceError("build.pack must list at least one package to pack");
  }
  for (const [index, entry] of build.pack.entries()) requireString(entry, `build.pack[${index}]`);
}

const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;
const REGISTRY_TARBALL = /^https:\/\/registry\.npmjs\.org\/.+\.tgz$/;

function validateGeneratedInputs(lock) {
  const inputs = lock.generatedInputs ?? [];
  if (!Array.isArray(inputs)) throw new ProvenanceError("generatedInputs must be an array when present");
  for (const [index, input] of inputs.entries()) {
    const where = `generatedInputs[${index}]`;
    requireString(input?.id, `${where}.id`);
    requireString(input?.reason, `${where}.reason`);
    requireString(input?.package, `${where}.package`);
    requireMatch(input?.version, EXACT_VERSION, `${where}.version`);
    // The published artifact is identified three ways: its registry URL, its subresource integrity and a
    // plain digest of the same bytes. All three are checked against the registry and the download before
    // one file is copied, because this is the only build input that does not come from the pinned commit.
    requireMatch(input?.registryTarball, REGISTRY_TARBALL, `${where}.registryTarball`);
    requireMatch(input?.registryIntegrity, SHA512_SRI, `${where}.registryIntegrity`);
    requireMatch(input?.tarballSha256, SHA256_HEX, `${where}.tarballSha256`);
    if (!Number.isInteger(input?.tarballBytes) || input.tarballBytes <= 0) {
      throw new ProvenanceError(`${where}.tarballBytes must be a positive integer`);
    }
    requireString(input?.archiveMemberDirectory, `${where}.archiveMemberDirectory`);
    requireString(input?.sourceDirectory, `${where}.sourceDirectory`);
    if (!Array.isArray(input?.allowedExtensions) || input.allowedExtensions.length === 0
        || !input.allowedExtensions.every((extension) => typeof extension === "string" && extension.startsWith("."))) {
      throw new ProvenanceError(`${where}.allowedExtensions must list at least one ".ext" string`);
    }
    requireMatch(input?.filesDigest, SHA256_HEX, `${where}.filesDigest`);
    if (!Number.isInteger(input?.fileCount) || input.fileCount <= 0) {
      throw new ProvenanceError(`${where}.fileCount must be a positive integer`);
    }
    // The complete selected file set, by name and digest. An aggregate digest alone would not say which
    // files were selected, and this build input is redistributed data rather than pinned source.
    const files = input?.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      throw new ProvenanceError(`${where}.files must be an object of file name to sha256`);
    }
    const names = Object.keys(files);
    if (names.length !== input.fileCount) {
      throw new ProvenanceError(`${where}.files lists ${names.length} files but fileCount is ${input.fileCount}`);
    }
    for (const name of names) {
      if (name.includes("/") || name === "..") throw new ProvenanceError(`${where}.files name is not flat: ${name}`);
      requireMatch(files[name], SHA256_HEX, `${where}.files["${name}"]`);
      if (!input.allowedExtensions.some((extension) => name.endsWith(extension))) {
        throw new ProvenanceError(
          `${where}.files["${name}"] is outside allowedExtensions ${input.allowedExtensions.join(", ")}: only ` +
            `generated data may come from a published artifact, never executable code`,
        );
      }
    }
  }
  return inputs;
}

/**
 * The ordered patch series. Order is the file's order, blank and `#` lines are comments, and the
 * directory may hold no patch the series does not name: an unlisted patch is drift, not an extra.
 */
export function readSeries(patchesDirectory) {
  const seriesFile = path.join(patchesDirectory, "series");
  const bytes = readFileSync(seriesFile);
  const names = bytes.toString("utf8").split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  for (const name of names) {
    if (!PATCH_NAME.test(name)) {
      throw new ProvenanceError(`${seriesFile}: ${name} must match ${PATCH_NAME} (ordered, no path components)`);
    }
  }
  const repeated = [...new Set(names.filter((name) => names.filter((other) => other === name).length > 1))];
  if (repeated.length > 0) {
    throw new ProvenanceError(`${seriesFile}: a patch may appear once; repeated: ${repeated.join(", ")}`);
  }
  const present = readdirSync(patchesDirectory).filter((name) => name.endsWith(".patch")).sort();
  const unlisted = present.filter((name) => !names.includes(name));
  if (unlisted.length > 0) {
    throw new ProvenanceError(`${seriesFile}: patches present but not in the series: ${unlisted.join(", ")}`);
  }
  const missing = names.filter((name) => !present.includes(name));
  if (missing.length > 0) {
    throw new ProvenanceError(`${seriesFile}: series names missing patches: ${missing.join(", ")}`);
  }
  return {
    seriesFile,
    names,
    sha256: sha256Of(bytes),
    patches: names.map((name) => ({ name, sha256: sha256OfFile(path.join(patchesDirectory, name)) })),
  };
}

/**
 * The entries of `git status --porcelain` that sit outside the index: untracked (`??`) and ignored (`!!`).
 * These are the paths no tree hash and no diff would cover, which is why both entry points refuse them.
 */
export function strayEntries(statusOutput) {
  return String(statusOutput ?? "")
    .split("\n")
    .filter((line) => line.startsWith("?? ") || line.startsWith("!! "))
    .map((line) => line.trim());
}

/** Parse `--flag value` arguments into an object. An unknown or valueless flag is a defect. */
export function parseArguments(argv, { flags = [], booleans = [] }) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new ProvenanceError(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (booleans.includes(name)) {
      parsed[name] = true;
      continue;
    }
    if (!flags.includes(name)) throw new ProvenanceError(`unknown flag: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new ProvenanceError(`${token} needs a value`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}
