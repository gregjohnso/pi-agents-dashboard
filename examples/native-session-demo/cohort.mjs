/**
 * Which installed Pi this demo runs, and how it is chosen.
 *
 * The demo never resolves `@earendil-works/pi-*` from ambient npm. It reads one manifest that names a
 * verified cohort — the consumer root a build installed, the bundled CLI inside it and the pi-tui package
 * root the pre-TUI caller imports — and refuses to start if any of those three is missing. The default
 * manifest is the qualified five-patch composition (seams A, B/C/F, E, D, G), whose build stage ran as Slurm
 * job 3753895; `--manifest` or `--cohort` override it.
 *
 * Seam D's canonical admission is present in those bytes and inert here: it changes nothing until a host
 * registers the canonical trio on its `NativeSubmitHost`, and this demo registers no canonical host.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_MANIFEST =
  "/mnt/main0/home/gjohnson/projects/pi-agents-tool-error-summary/.superpowers/sdd/2026-09-17-native-attachment/runtime-wave-1/canonical-composition/logs/final-artifacts-manifest.json";

const CODING_AGENT = "node_modules/@earendil-works/pi-coding-agent";
const TUI = "node_modules/@earendil-works/pi-tui";

/**
 * @param {{ manifestPath?: string, cohortRoot?: string }} selection
 * @returns {{ consumerRoot: string, bundledCli: string, tuiPackageRoot: string, manifestPath: string | null, buildSlurmJobId: string | null, patchedTreeHash: string | null }}
 */
export function resolveCohort({ manifestPath, cohortRoot } = {}) {
  let consumerRoot = cohortRoot;
  let manifest = null;
  let usedManifest = null;
  if (!consumerRoot) {
    usedManifest = manifestPath ?? DEFAULT_MANIFEST;
    if (!existsSync(usedManifest)) {
      throw new Error(`No cohort manifest at ${usedManifest}; pass --manifest <file> or --cohort <consumer root>`);
    }
    manifest = JSON.parse(readFileSync(usedManifest, "utf8"));
    consumerRoot = manifest.consumerRoot;
    if (typeof consumerRoot !== "string" || consumerRoot === "") {
      throw new Error(`${usedManifest} names no consumerRoot`);
    }
  }
  const bundledCli = path.join(consumerRoot, CODING_AGENT, "dist/bundle/cli.js");
  const tuiPackageRoot = path.join(consumerRoot, TUI);
  for (const required of [consumerRoot, bundledCli, tuiPackageRoot]) {
    if (!existsSync(required)) throw new Error(`The selected cohort is incomplete: ${required} does not exist`);
  }
  if (manifest && typeof manifest.bundledCliPath === "string" && path.resolve(manifest.bundledCliPath) !== path.resolve(bundledCli)) {
    throw new Error(`${usedManifest} names bundled CLI ${manifest.bundledCliPath}, which is not ${bundledCli}`);
  }
  return {
    consumerRoot,
    bundledCli,
    tuiPackageRoot,
    manifestPath: usedManifest,
    buildSlurmJobId: manifest?.buildSlurmJobId ?? null,
    patchedTreeHash: manifest?.patchedTreeHash ?? null,
  };
}
