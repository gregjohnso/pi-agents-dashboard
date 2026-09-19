/**
 * Which installed Pi this demo runs, and how it is chosen.
 *
 * The demo never resolves `@earendil-works/pi-*` from ambient npm. It reads one manifest that names a
 * verified cohort — the consumer root a build installed, the bundled CLI inside it and the pi-tui package
 * root the pre-TUI caller imports — and refuses to start if any of those three is missing. The default
 * manifest is the qualified **six**-patch cohort (seams A, B/C/F, E, D, G, plus native consumer
 * capabilities), whose build stage ran as Slurm job 3757199; `--manifest` or `--cohort` override it.
 *
 * Two things in those bytes are present and inert here, and saying so is the point of this file:
 *
 * - Seam D's canonical admission changes nothing until a host registers the canonical trio on its
 *   `NativeSubmitHost`, and this demo registers no canonical host. Presence is not pre-spawn authority.
 * - Patch 0006's bootstrap protocol 2 is explicit opt-in. This demo's default remains protocol 1, so the
 *   published input target and the `dcs-pi-native-present-v1` codec ship in the cohort without running here.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_MANIFEST =
  "/mnt/main0/home/gjohnson/projects/pi-agents-tool-error-summary/.superpowers/sdd/2026-09-17-native-attachment/native-consumer-seams/marker-failure/qualification/final-3757199/final-artifacts-manifest.json";

/** The five-patch composition this demo defaulted to before the six-patch cohort was accepted. */
export const FIVE_PATCH_MANIFEST =
  "/mnt/main0/home/gjohnson/projects/pi-agents-tool-error-summary/.superpowers/sdd/2026-09-17-native-attachment/runtime-wave-1/canonical-composition/logs/final-artifacts-manifest.json";

/**
 * Patch 0006 has two different identities and both are true. Conflating them would be a provenance lie.
 *
 * `builtIntoCohort` is the patch the cohort's installed bytes were actually produced from, so it is what
 * describes anything that executes. `currentInThisTree` is the patch file this repository carries now: a
 * test-only overlay accepted on top of it, whose change is to the cleanup-write admission cases rather than to
 * any shipped behaviour. The overlay was never built into cohort 3757199 and its tree hash is therefore not
 * the tree hash of what runs.
 *
 * Both digests are asserted against their real sources by the demo's own tests, so neither is a bare claim.
 */
export const CONSUMER_CAPABILITY_PATCH = {
  name: "0006-native-consumer-capabilities.patch",
  builtIntoCohort: {
    sha256: "63f186b735e440751777c70bfd564a0c5df8244ad1ad3bc6a1abef1ad60ea510",
    patchedTreeHash: "029408d6f4f4e397b621438a3f80b3fb034f99ab",
    note: "the bytes under the cohort's consumerRoot came from this patch",
  },
  currentInThisTree: {
    sha256: "37ddaec09df091fdf30ab3f8c10c32cfdf9820730f714323c6356b80907f548b",
    wouldProduceTreeHash: "746091b78ce7b505f0170c2cb8866fe786cbb25c",
    nature: "test-only overlay, requalified but not built into cohort 3757199",
  },
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
    // The BUILT tree, which is what these bytes are. Not the tree the current source patch would produce.
    patchedTreeHash: manifest?.patchedTreeHash ?? null,
    upstreamCommit: manifest?.upstreamCommit ?? null,
    series: Array.isArray(manifest?.series) ? [...manifest.series] : [],
    appliedPatches: Array.isArray(manifest?.appliedPatches)
      ? manifest.appliedPatches.map((/** @type {any} */ entry) => ({ position: entry.position, name: entry.name, sha256: entry.sha256 }))
      : [],
    // Stated rather than inferred from the cohort: patch 0006 ships protocol 2, and this demo opts out.
    bootstrapProtocolInUse: 1,
  };
}
