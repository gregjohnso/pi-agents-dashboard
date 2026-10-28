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
 *
 * The default is now the **seven**-patch cohort, whose build stage ran as Slurm job 3763110. Patch 0007 carries
 * the parsed sequence's `NativeInputProvenance` to the public input listener, which is what lets the demo's
 * return gesture know which attachment pressed it and refuse a sequence native framing assembled from two.
 * The six-patch cohort remains named and selectable, and its artifacts were neither rebuilt nor modified.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_MANIFEST =
  "/mnt/main0/home/gjohnson/projects/pi-agents-tool-error-summary/.superpowers/sdd/2026-09-17-native-attachment/integration-owner/real-native-list-demo/logs/cohort-3763110/final-artifacts-manifest.json";

/**
 * The reviewed six-patch cohort this demo defaulted to before the return gesture needed patch 0007.
 *
 * Still named, still selectable, and its artifacts are untouched: the seven-patch build wrote to a cache root
 * of its own. A session started against this manifest behaves exactly as it did, except that `f9` cannot be
 * attributed, because the public input listener in these bytes carries no provenance.
 */
export const SIX_PATCH_MANIFEST =
  "/mnt/main0/home/gjohnson/projects/pi-agents-tool-error-summary/.superpowers/sdd/2026-09-17-native-attachment/native-consumer-seams/marker-failure/qualification/final-3757199/final-artifacts-manifest.json";

/** The five-patch composition this demo defaulted to before the six-patch cohort was accepted. */
export const FIVE_PATCH_MANIFEST =
  "/mnt/main0/home/gjohnson/projects/pi-agents-tool-error-summary/.superpowers/sdd/2026-09-17-native-attachment/runtime-wave-1/canonical-composition/logs/final-artifacts-manifest.json";

/**
 * Patch 0006 had two different identities, and the seven-patch build resolved them.
 *
 * `builtIntoCohort` is the patch the SIX-patch cohort's bytes were produced from, so it still describes
 * anything selected through {@link SIX_PATCH_MANIFEST}. `currentInThisTree` is the patch file this repository
 * carries, a test-only overlay accepted on top of it; against the six-patch cohort it was never built, which
 * is why the two digests differ and why conflating them would have been a provenance lie.
 *
 * The seven-patch build (job 3763110) applied this tree's files, so `currentInThisTree` IS the sixth patch in
 * the current default cohort and its overlay now executes. The previously disclosed limitation - that the
 * overlay was requalified but never built - is therefore closed for the default, and remains true of the
 * six-patch cohort. Both digests are asserted against their real sources by the demo's own tests.
 */
export const CONSUMER_CAPABILITY_PATCH = {
  name: "0006-native-consumer-capabilities.patch",
  builtIntoCohort: {
    sha256: "63f186b735e440751777c70bfd564a0c5df8244ad1ad3bc6a1abef1ad60ea510",
    patchedTreeHash: "029408d6f4f4e397b621438a3f80b3fb034f99ab",
    note: "the bytes under the SIX-patch cohort's consumerRoot came from this patch",
  },
  currentInThisTree: {
    sha256: "37ddaec09df091fdf30ab3f8c10c32cfdf9820730f714323c6356b80907f548b",
    wouldProduceTreeHash: "746091b78ce7b505f0170c2cb8866fe786cbb25c",
    nature: "test-only overlay; not in the six-patch cohort, and built into the seven-patch cohort",
  },
};

/**
 * The patch that makes the demo's return gesture attributable, and the only reason a new cohort exists.
 *
 * It widens the public `TuiInputListener` with an optional second parameter and passes the parsed sequence's
 * `NativeInputProvenance`, which `handleTerminalInput` has held since patch 0002, at the single call site. A
 * one-argument listener is unaffected. Without it, an out-of-process host can learn the origin of a Return key
 * and of no other key, so a host-recognised gesture cannot tell a single-origin sequence from one native
 * framing assembled out of two attachments' bytes.
 */
export const INPUT_LISTENER_PROVENANCE_PATCH = {
  name: "0007-native-input-listener-provenance.patch",
  sha256: "fe59095c02f9f5e7e22f5db1637114bf61e51972b4021777496c977b51c80991",
  buildSlurmJobId: "3763110",
  patchedTreeHash: "f0eb2f2d68bd6bf04cc06289f47fe2f195812d10",
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
    // Stated rather than inferred from the cohort: patch 0006 ships protocol 2, and this demo opts out.
    bootstrapProtocolInUse: 1,
  };
}
