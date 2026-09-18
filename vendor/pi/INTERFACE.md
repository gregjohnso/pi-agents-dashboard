# vendor/pi interface, for the seam implementer

Read this before you write a Pi source patch or consume a built artifact. `vendor/pi/README.md` is the
maintenance procedure; this file is the contract.

**Nothing native ships yet.** The patch series is empty, so today's artifacts are baseline, unmodified
upstream Pi 0.84.3. A green build is not an A-G capability, and `build-manifest.json.capability` says so
in the artifact itself. The build is also a **hybrid** — pinned source plus one pinned release-generated
data input — which section 6 describes in full.

## 1. The pin

| Field | Value |
| --- | --- |
| repository | `https://github.com/earendil-works/pi.git` |
| commit | `bfb004d4418ff05c6f909eaaab856cbe75c1fde0` (npm `gitHead` of the published 0.84.3) |
| tree | `562b495c89525fbefb00795d77f34586b69e7068` |
| tag `v0.84.3` | `4e58f324fae8ebfa98a3d45181fb248072a2afac`, **not the pin** |
| upstream `package-lock.json` | sha256 `abd9982ce837df8e2775196cde3b5c5584c30e66b232c26b7c55aafd58ab2e1b` |
| license | MIT, Copyright (c) 2025 Mario Zechner |

Never substitute the tag for the commit. `prepare.mjs` fetches the commit as an object and fails on any
other identity or tree.

## 2. What you run

```bash
OUT=<disposable root outside the repository>/attempt-<unique>
node vendor/pi/prepare.mjs --output "$OUT/prepared"                       # fetch, verify, apply series
node vendor/pi/build.mjs --prepared "$OUT/prepared" --artifacts "$OUT/artifacts"
node vendor/pi/build.mjs --prepared "$OUT/prepared" --dry-run             # the plan, runs nothing
```

Both refuse an existing directory. Neither touches the repository, `node_modules`, `.pixi`, or any
installed Pi. Everything that fetches, installs, builds or packs runs on a Slurm worker.

## 3. What you get

`$OUT/prepared/`

| File | Contents |
| --- | --- |
| `source/` | the pinned monorepo with the series applied; a git working tree at the pinned commit, with every patched path in its index |
| `prepare-intent.json` | written before the fetch: the lock digest, the series and its digest |
| `provenance.json` | written once, only on success: resolved commit/tree, verified digests, packages, applied patches with digests, `patchedTreeHash`, `workingDiffSha256`, `stagedStatus`, `baseline`, `artifactLabel` |
| `applied.diff` | the exact `git diff` the series produced, added files included; empty for a baseline |
| `prepare-failure.json` | written instead of `provenance.json` when preparation refuses |
| `build-claim.json` | written by `build.mjs`, once: this tree has been built and will not be built again |

`$OUT/artifacts/`

| File | Contents |
| --- | --- |
| `build-manifest.json` | the whole build record; see below |
| `earendil-works-pi-*-0.84.3.tgz` | seven packed packages, each carrying the verified `LICENSE` |
| `generated-input-pi-ai-model-data.json` | the pinned generated input, its registry identity and per-file digests |
| `build-failure.json` | written instead of the manifest when the build refuses |

`build-manifest.json` fields a consumer relies on:

- `artifactFiles[]`: `package`, `version`, `file`, `bytes`, `sha256`, `licenseSha256`, `exports`, `bin`
- `bundledCli`: `bin` (`dist/bundle/cli.js`), `sha256`, `bytes`, `bundleFileCount`, `bundleDigest`
- `license`: the notice added to every package root, its digest, its byte count, the repository copy it was
  checked against, and which package roots received it
- `preparedState`: the commit, `patchedTreeHash`, working diff digest and stray-file list observed at build
  start; `preparedClaim`: the one-shot claim this build took on the prepared tree
- `baseline`, `artifactLabel`, `capability`, `reproducibility`, `buildKind`
- `plan[]`: every step in execution order, each marked `kind: "command"` or `kind: "file"`
- `commands[]`: every command, in order, with exit status and duration
- `generatedInputs[]`: id, kind, spec, registry URL and SRI, the digests actually observed on the download,
  and the archive-member-to-source mapping
- `resolved`, `series`, `applied`, `upstream`, `lock`

## 4. The package cohort

Seven packages are built and packed, in this order:

`packages/tui` → `packages/telemetry` → `packages/ai` (`build:offline`) → `packages/agent` →
`packages/protocol` → `packages/client` → `packages/coding-agent`

Pack set: telemetry, ai, agent-core, protocol, client, tui, coding-agent — the full internal runtime
cohort of coding-agent's `npm-shrinkwrap.json`. Install **all seven** together. Installing only
coding-agent and tui leaves its unbundled public exports resolving registry copies of the other five.

`packages/sqlite-node` and `packages/server` are deliberately out of scope: no packed package depends on
them. If your patch touches one, add it to `build.steps`/`build.pack` from the actual imports.

Upstream names, versions, `exports` (`.`, `./client`, `./rpc-entry`), `bin` (`pi`) and `files` are
preserved. These are `@earendil-works/pi-*@0.84.3`, not a renamed fork. One file is added that upstream's own
tarballs do not carry: the pinned MIT `LICENSE`, in every package root, because the notice is required and
upstream packs none. Its digest is verified inside each tarball and recorded per artifact.

## 5. Rules a patch must satisfy

1. Source only. `git diff` against the pinned tree, no `dist`, no bundle output, no generated file, no
   binary, no `node_modules`, no postinstall. A patch may add a file: `git add -N` it before taking the diff,
   and preparation stages it with `git apply --index` so it is tracked and covered by `patchedTreeHash`.
   Nothing may be left outside the index, and the build refuses a prepared tree that holds anything untracked
   or ignored.
2. The bundled CLI is rebuilt by the pipeline. Editing `dist` or an installed tree is never acceptable:
   `packages/coding-agent`'s `build` runs `build:unbundled` and then
   `scripts/build-coding-agent-bundle.mjs`, and the bundle inlines the whole cohort.
3. Ordered and exact. `patches/series` is the order; `git apply` runs with no fuzz, no `-3` and no skip.
   An already-applied or out-of-order patch fails the preparation.
4. Native interfaces only. Ledger, ownership policy, attachment policy and session management stay in
   pi-agents.
5. Unmanaged Pi behaviour stays unchanged unless a narrowly justified bug regression requires otherwise,
   and then the justification and its regression test ship with the patch.
6. A dependency change must regenerate upstream's own install locks in the same patch, or
   `build.checks` (`generate-coding-agent-shrinkwrap.mjs --check`,
   `generate-coding-agent-install-lock.mjs --check`) fails the build.
7. Each patch brings its own regression test, and the artifact label stops saying baseline.

## 6. One upstream constraint you will meet

`packages/ai/src/providers/data/**` is gitignored upstream and generated by `npm run generate-models`,
which fetches the live models.dev catalog. The pinned commit therefore does not build from source alone,
and today's live catalog no longer type checks against it (TS2353 in
`packages/ai/src/providers/cloudflare-ai-gateway.ts`: the pinned generated shard types expect
`openai-completions` models that the current catalog no longer lists).

`upstream-lock.json` pins that generated input to the published `@earendil-works/pi-ai@0.84.3` artifact
(registry integrity plus an aggregate content digest over all 40 files, including upstream's own
`.manifest.json`), and the build uses upstream's `build:offline` script. Do not "fix" this by running
`generate-models`: that reintroduces a live network dependency into the build and a nondeterministic type
surface. If a patch needs newer model data, pin the new data explicitly in the lock.

## 7. Not done here

- No root `package.json` / `package-lock.json` change, no dependency activation, no installed-tree change.
  `README.md` lists what must pass first.
- No publication, no registry push, no upstream contact.
- Byte reproducibility is not claimed from a single build. Compare two independent builds' artifact
  digests if you need that claim.
