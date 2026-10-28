/**
 * Which installed Pi this demo runs, and how it is chosen.
 *
 * The demo never resolves `@earendil-works/pi-*` from ambient npm. It reads one manifest that names a
 * verified cohort — the consumer root a build installed, the bundled CLI inside it and the pi-tui package
 * root the pre-TUI caller imports — and refuses to start if any of those three is missing. `--manifest` or
 * `--cohort` override the default.
 *
 * The default is the Pi 1.4.0 cohort built by Slurm job 4189339 from `vendor/pi`: four patches (0002 ingress,
 * return and terminal-response authorization; 0003 presentation and readiness; 0005 child terminal handoff;
 * 0007 input-listener provenance). The 0.84.3 series' 0001, 0004 and 0006 are not carried, because nothing this
 * demo runs activated them; `vendor/pi/patches/series` records why.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_MANIFEST = "/mnt/main0/home/gjohnson/projects/pi-agents-pi14-work/cohort-4189339/cohort-manifest.json";

/** What the default cohort was built from, so a test can check the manifest against it rather than trust it. */
export const DEFAULT_COHORT = {
  piVersion: "1.4.0",
  upstreamCommit: "4a080252f06caf63a525d7873c5d94d3c23887e0",
  buildSlurmJobId: "4189339",
  patchedTreeHash: "b0c4f259cb287cecadbeecf1dc49aac56682462b",
};

const CODING_AGENT = "node_modules/@earendil-works/pi-coding-agent";
const TUI = "node_modules/@earendil-works/pi-tui";

/**
 * @param {{ manifestPath?: string, cohortRoot?: string }} selection
 * @returns {{ consumerRoot: string, bundledCli: string, tuiPackageRoot: string, manifestPath: string | null,
 *   buildSlurmJobId: string | null, patchedTreeHash: string | null, upstreamCommit: string | null,
 *   series: string[], appliedPatches: { position: number, name: string, sha256: string }[],
 *   bootstrapProtocolInUse: number }}
 */
export function resolveCohort({ manifestPath, cohortRoot } = {}) {
  let consumerRoot = cohortRoot;
  let manifest = null;
  let usedManifest = null;
  if (!consumerRoot) {
    usedManifest = path.resolve(manifestPath ?? DEFAULT_MANIFEST);
    if (!existsSync(usedManifest)) {
      throw new Error(`No cohort manifest at ${usedManifest}; pass --manifest <file> or --cohort <consumer root>`);
    }
    manifest = JSON.parse(readFileSync(usedManifest, "utf8"));
    consumerRoot = manifest.consumerRoot;
    if (typeof consumerRoot !== "string" || consumerRoot === "") {
      throw new Error(`${usedManifest} names no consumerRoot`);
    }
    if (!path.isAbsolute(consumerRoot)) consumerRoot = path.resolve(path.dirname(usedManifest), consumerRoot);
  }
  const bundledCli = path.join(consumerRoot, CODING_AGENT, "dist/bundle/cli.js");
  const tuiPackageRoot = path.join(consumerRoot, TUI);
  for (const required of [consumerRoot, bundledCli, tuiPackageRoot]) {
    if (!existsSync(required)) throw new Error(`The selected cohort is incomplete: ${required} does not exist`);
  }
  if (manifest && typeof manifest.bundledCliPath === "string") {
    const declaredCli = path.isAbsolute(manifest.bundledCliPath)
      ? path.resolve(manifest.bundledCliPath)
      : path.resolve(path.dirname(usedManifest), manifest.bundledCliPath);
    if (declaredCli !== path.resolve(bundledCli)) {
      throw new Error(`${usedManifest} names bundled CLI ${manifest.bundledCliPath}, which is not ${bundledCli}`);
    }
  }
  if (manifest && typeof manifest.tuiPackageRoot === "string") {
    const declaredTui = path.isAbsolute(manifest.tuiPackageRoot)
      ? path.resolve(manifest.tuiPackageRoot)
      : path.resolve(path.dirname(usedManifest), manifest.tuiPackageRoot);
    if (declaredTui !== path.resolve(tuiPackageRoot)) {
      throw new Error(`${usedManifest} names Pi TUI ${manifest.tuiPackageRoot}, which is not ${tuiPackageRoot}`);
    }
  }
  if (manifest && typeof manifest.bundledCliSha256 === "string") {
    const actual = createHash("sha256").update(readFileSync(bundledCli)).digest("hex");
    if (actual !== manifest.bundledCliSha256) {
      throw new Error(`${usedManifest} bundled CLI digest mismatch: expected ${manifest.bundledCliSha256}, received ${actual}`);
    }
  }
  return {
    consumerRoot,
    bundledCli,
    tuiPackageRoot,
    manifestPath: usedManifest,
    buildSlurmJobId: manifest?.buildSlurmJobId ?? null,
    // The BUILT tree, which is what these bytes are. Not the tree the current source patch would produce.
    patchedTreeHash: manifest?.patchedTreeHash ?? null,
    upstreamCommit: manifest?.upstreamCommit ?? null,
    series: Array.isArray(manifest?.series) ? [...manifest.series] : [],
    appliedPatches: Array.isArray(manifest?.appliedPatches)
      ? manifest.appliedPatches.map((/** @type {any} */ entry) => ({ position: entry.position, name: entry.name, sha256: entry.sha256 }))
      : [],
    // The only bootstrap protocol this demo speaks.
    bootstrapProtocolInUse: 1,
  };
}
