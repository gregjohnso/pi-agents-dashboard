# vendor/pi: the pinned upstream Pi source lock

pi-agents needs a small number of native control points inside Pi. This directory is how the project owns
them without forking the repository or vendoring the upstream tree: an exact source pin, an ordered patch
series, and tooling that prepares, builds and packs the affected package cohort in a disposable output
directory.

Business logic stays in pi-agents. A patch here supplies a native interface and nothing else.

**Today the patch series is empty.** Artifacts built from this lock are baseline, unmodified upstream Pi
0.84.3 and advertise no new capability. `build-manifest.json` says so in its own `capability` field. Do
not read a working build as evidence of a native feature.

**This is a hybrid build, not a source-only reconstruction.** One input comes from a published upstream
release artifact rather than from the pinned commit: the generated model data in
`packages/ai/src/providers/data/**`, which is gitignored upstream and produced by a script that fetches the
live models.dev catalog. `upstream-lock.json` pins it by URL, subresource integrity, tarball digest and
size, an archive-member-to-source mapping and the complete selected file set with a digest per file, and
`allowedExtensions` restricts it to `.json` data. Executable code and the bundled CLI are always rebuilt
from the pinned source. `NOTICE.md` records the decision, and there is no live model-data fallback: a
mismatch aborts the build.

## What is here

| File | What it is |
| --- | --- |
| `upstream-lock.json` | the pin: repository, commit, tree hash, locked file digests, package cohort, pinned generated inputs, and the declared build/pack graph |
| `patches/series` | the ordered patch list; blank and `#` lines are comments |
| `patches/NNNN-*.patch` | one focused source diff each, applied in series order |
| `prepare.mjs` | fetch the pinned commit into a **new** directory, verify it, apply the series, write `provenance.json` |
| `build.mjs` | build and pack a prepared tree with upstream's own npm scripts, write `build-manifest.json` |
| `provenance.mjs` | shared digest, write-once, subprocess and lock/series parsing helpers |
| `fixture-repository.mjs`, `fixtures/**` | a real tiny git upstream and real patches, for the tests |
| `prepare.test.mjs`, `build.test.mjs` | the refusals and the positive paths, offline |
| `pinned-source-build.integration.test.mjs` | the real pinned build plus a fresh-consumer install, worker only |
| `NOTICE.md`, `LICENSE.upstream` | upstream provenance, license and the modification statement |
| `INTERFACE.md` | what a seam implementer consumes from here |

`prepare.mjs` and `build.mjs` use Node built-ins only, so preparation runs before any dependency exists.

## How to build

Both scripts refuse to reuse a directory, so every attempt is claimed fresh. **Put the output outside the
repository.** A live upstream tree inside it contains `*.test.ts` files that the repository's default
Vitest suite would collect.

```bash
OUT=/some/disposable/root/attempt-$(date +%s)          # outside the repository
node vendor/pi/prepare.mjs --output "$OUT/prepared"
node vendor/pi/build.mjs   --prepared "$OUT/prepared" --artifacts "$OUT/artifacts"
node vendor/pi/build.mjs   --prepared "$OUT/prepared" --dry-run    # the command plan, runs nothing
```

Everything that installs, builds or packs runs on a Slurm worker, never on the head node. The repository's
own driver does that; see "How to test" below.

`prepare.mjs` writes `prepare-intent.json` before it fetches, `provenance.json` once and only on success,
and `prepare-failure.json` when it refuses. `build.mjs` refuses any directory without a `provenance.json`,
re-verifies the commit, the complete patched state and the applied-diff digest, refuses any file outside the
index, claims the tree once by writing `build-claim.json` into it, and writes `build-manifest.json` once and
only on success. **A prepared tree is built once**: after a build it holds installed dependencies, hydrated
data, built `dist` and the added `LICENSE` files, so a second build would not be a build of the pinned
source. A failed attempt is never repaired in place: claim a new directory.

### The required notice

Upstream packs no per-package license file. The build copies the pinned root `LICENSE` into every packed
package root before packing (npm always packs a root `LICENSE`, whatever the package's `files` list says),
after checking its bytes against `upstream.license.sha256` in the lock and against the repository's own
`vendor/pi/LICENSE.upstream`. It is then read back out of each produced tarball and compared again, and the
digest is recorded per artifact in `build-manifest.json`. A tarball without the notice fails the build.

### What is verified, and what fails

- the fetched commit is the locked commit, fetched as an object, never as a branch or tag
- the fetched tree hash is the locked tree hash
- every `verifiedFiles` digest, including the upstream `package-lock.json` the install runs against
- every `packages[]` entry is the locked `name@version`
- the series applies in exact order, with `git apply --check --index` first and no fuzz, no `-3`, no skip; an
  already-applied, partially applicable or out-of-order patch fails
- `--index` stages what a patch adds, so an add-only patch is a real change and its new file is inside
  `patchedTreeHash`, `applied.diff` and `workingDiffSha256` instead of sitting untracked
- preparation ends with nothing outside the index: an untracked or ignored file at that point is source no
  digest would cover, and it fails
- a patch file present but not named by `series` is drift and fails
- when the build starts, the prepared tree still has the same commit, the same `patchedTreeHash`, the same
  working diff, **and** nothing outside its index. Injected source, a leftover `node_modules`, a stale `dist`
  or pre-hydrated generated data is refused before the first mutation
- the prepared tree is claimed once, before the first mutation, so a tree that has already been built (or
  whose build failed) is never built again
- every pinned release-generated input, before it is copied: the registry URL and integrity, the downloaded
  tarball's own integrity, size and digest, the exact selected file-name set, every per-file digest, the
  `.json`-only extension allowlist and the aggregate digest. A mismatch aborts; there is no fallback
- every build step, upstream check and pack exits zero; a missing script means the build graph moved
- the required notice is verified in the source tree, against the repository's own committed copy, and again
  inside every produced tarball

## How to test

```bash
cd <repository>
PY=.pixi/envs/default/bin/python
$PY test/slurm/submit_cases.py validate --manifest <your manifest>
$PY test/slurm/submit_cases.py submit   --manifest <your manifest> --execution-root <disposable root> --wait
$PY test/slurm/submit_cases.py collect  --batch-record <batch>/batch-record.json
```

`test/slurm/INTERFACE.md` documents that driver; it is not this directory's to change. Cases:

- `vendor/pi/prepare.test.mjs` and `vendor/pi/build.test.mjs` are offline and fixture-driven. They run in
  the default suite too.
- `vendor/pi/pinned-source-build.integration.test.mjs` fetches, builds, packs, installs into a fresh
  consumer and smoke-tests the installed CLI. It **skips unless `SLURM_JOB_ID` is set**, because this
  milestone forbids builds on the head node, and it writes into `PI_FOUNDATION_OUTPUT_ROOT` or `TMPDIR`
  (the driver points `TMPDIR` at the case directory) after asserting that root is outside the repository.
  It is an `*.integration.test.mjs`, so `npm run test:unit` excludes it.

## How a maintainer adds one focused source patch

1. Prepare the pinned tree in a fresh directory (above). Work in `$OUT/prepared/source`.
2. Make the smallest change that exposes the native control point. Keep unmanaged Pi behaviour
   unchanged. Business logic belongs in pi-agents, not here.
3. `cd $OUT/prepared/source && git diff > <repo>/vendor/pi/patches/0001-<short-description>.patch`.
   `git diff` output only: no `dist`, no generated file, no binary, no `node_modules`. A patch that adds a
   file is fine and is fully covered: `git add -N <new file>` before taking the diff so the addition is in
   it, and preparation applies the series with `--index` so the new file is tracked and digested.
4. Add the filename to `patches/series` in the position it must apply. Order is this file's order.
5. Add its regression test. A patch that changes a dependency must also regenerate upstream's install
   locks in the same patch, or `build.checks` fails.
6. Rebuild from a **new** output directory and rerun the cases above. A prepared tree is built once, so a
   rebuild always means a new `prepare.mjs` run. The build must rebuild the bundled
   CLI: `build-manifest.json.bundledCli.sha256` changes when the patch reaches it. Patching `dist` or a
   built bundle is never acceptable.
7. Update `NOTICE.md` (the modification statement) and drop the baseline label claim.

## How an upstream rebase is checked

1. Establish the new pin from npm, not from a tag: the `gitHead` of the published
   `@earendil-works/pi-coding-agent` version you are moving to. Record the tag's commit as well when it
   differs, as `upstream.observedTag`.
2. Update `upstream.commit`, then run `prepare.mjs`. It fails with the observed tree hash and the observed
   digest of every locked file; copy the observed values in only after reading what changed. Re-establish
   `upstream.license.sha256` too if the notice itself changed, and keep `vendor/pi/LICENSE.upstream` byte
   identical to it.
3. Re-establish `packages[]` versions, `generatedInputs[].registryIntegrity`, `fileCount` and
   `filesDigest` for the new version, and the `build.steps` order from the new root `package.json`.
4. Reapply the series. A rejected patch is a real conflict: rewrite that patch, never add fuzz.
5. Rebuild and rerun every case, including the consumer install.

## Before root dependency or lockfile activation

This foundation deliberately does not touch the repository's `package.json`, `package-lock.json` or any
installed tree. All of the following must pass, on a worker, before that changes:

1. `vendor/pi/prepare.test.mjs` and `vendor/pi/build.test.mjs` green.
2. `vendor/pi/pinned-source-build.integration.test.mjs` green, including the fresh consumer install, the
   installed bundled CLI version, the public exports and the TUI resolution check.
3. Two independent builds compared: equal artifact digests, or byte reproducibility explicitly not
   claimed. One build never establishes it.
4. The repository's own `typecheck` and `pack-check` cases green.
5. The seam implementer's own native regression tests green against the patched artifacts.
6. `NOTICE.md` describing the shipped modifications, and no baseline label left on patched artifacts.
