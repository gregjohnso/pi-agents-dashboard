// Test-only fixture builder: a real, tiny git upstream and a real lock/series pointing at it, so the
// vendor/pi tests exercise the actual fetch, verify and apply logic instead of inspecting strings.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run, sha256Of, sha256OfFile } from "./provenance.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const FIXTURES = path.join(HERE, "fixtures");

/**
 * A one-commit git repository holding `fixtures/upstream`, served over the local file transport.
 * `uploadpack.allowAnySHA1InWant` is what lets a client fetch an exact object rather than a ref, which
 * is how `prepare.mjs` pins; GitHub allows it by default and a local repository does not.
 */
export function createFixtureUpstream(root) {
  const repository = path.join(root, "upstream.git");
  mkdirSync(repository, { recursive: true });
  cpSync(path.join(FIXTURES, "upstream"), repository, { recursive: true });
  const environment = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (...args) => run("git", args, { cwd: repository, env: environment }).stdout.trim();
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  git("add", "-A");
  git("commit", "--quiet", "-m", "fixture upstream");
  return {
    repository,
    commit: git("rev-parse", "HEAD"),
    treeHash: git("rev-parse", "HEAD^{tree}"),
    packageJsonSha256: sha256OfFile(path.join(repository, "package.json")),
    licenseSha256: sha256OfFile(path.join(repository, "LICENSE")),
  };
}

/** A lock for the fixture upstream. `overrides` are merged in, so a test can corrupt exactly one field. */
export function writeFixtureLock(file, upstream, overrides = {}) {
  const { upstream: upstreamOverrides, ...rest } = overrides;
  const lock = {
    schemaVersion: 1,
    upstream: {
      repository: upstream.repository,
      commit: upstream.commit,
      treeHash: upstream.treeHash,
      license: {
        spdx: "MIT",
        holder: "Fixture holder",
        path: "LICENSE",
        sha256: upstream.licenseSha256,
        packedAs: "LICENSE",
      },
      ...upstreamOverrides,
    },
    verifiedFiles: [
      { path: "package.json", sha256: upstream.packageJsonSha256 },
      { path: "LICENSE", sha256: upstream.licenseSha256 },
    ],
    packages: [{ path: "packages/widget", name: "@pi-foundation-fixture/widget", version: "1.2.3" }],
    build: {
      install: ["npm", "--version"],
      steps: [{ package: "packages/widget", script: "build" }],
      pack: ["packages/widget"],
    },
    ...rest,
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  return { file, lock, sha256: sha256Of(readFileSync(file)) };
}

/** A patches directory holding exactly the named fixture patches, in the given order. */
export function writeFixtureSeries(directory, names, { includeUnlisted = [] } = {}) {
  mkdirSync(directory, { recursive: true });
  for (const name of [...names, ...includeUnlisted]) {
    cpSync(path.join(FIXTURES, "patches", name), path.join(directory, name));
  }
  writeFileSync(path.join(directory, "series"), `${["# fixture series", ...names].join("\n")}\n`);
  return directory;
}

/** Run one of the vendor/pi entry points as the operator would, and report its exit status. */
export function runTool(tool, args, { env } = {}) {
  return run("node", [path.join(HERE, tool), ...args], { allowNonZero: true, env });
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
