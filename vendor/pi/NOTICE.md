# Third-party notice: upstream Pi

`vendor/pi` does not contain upstream source. It contains an upstream **source lock**, an ordered
**patch series**, and the tooling that materialises the locked source in a disposable directory, builds
it and packs installable artifacts.

## Upstream

| | |
| --- | --- |
| Project | Pi |
| Repository | https://github.com/earendil-works/pi.git |
| Pinned commit | `bfb004d4418ff05c6f909eaaab856cbe75c1fde0` |
| Pin provenance | the npm `gitHead` of `@earendil-works/pi-coding-agent@0.84.3` and `@earendil-works/pi-tui@0.84.3` |
| Tag observed at the same version | `v0.84.3` = `4e58f324fae8ebfa98a3d45181fb248072a2afac`, **two commits behind the pin** |
| License | MIT, Copyright (c) 2025 Mario Zechner |
| Verbatim license | [`LICENSE.upstream`](LICENSE.upstream), sha256 `0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48` |

The tag is not the published source. `upstream-lock.json` records both values so that a maintainer never
substitutes the tag for the pin.

Package names, versions, `exports`, `bin` and `files` are preserved exactly: artifacts built here are
`@earendil-works/pi-*@0.84.3`, not a renamed fork.

The MIT license text ships with every packed artifact **because this pipeline puts it there.** Upstream's own
tarballs carry no license file: measured on the round-3 consumer, none of the seven installed packages held a
`LICENSE`. `build.mjs` therefore copies the pinned root `LICENSE`
(sha256 `0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48`, identical to
[`LICENSE.upstream`](LICENSE.upstream)) into every packed package root before packing, and reads it back out
of each produced tarball to confirm the bytes. That digest is recorded per artifact in `build-manifest.json`,
and a tarball without the notice fails the build. This is an addition to upstream's packaging, and it is the
only file this pipeline adds to an artifact.

Transitive dependency licenses are an npm packaging concern and are **not** asserted here: this notice
covers the pinned monorepo's own license only.

## Modifications

[`patches/series`](patches/series) applies **three** ordered source patches, in this order:

| Patch | Purpose | Regression test |
| --- | --- | --- |
| `0001-seam-a-native-submission-barrier.patch` | Seam A: an opt-in native submission barrier. A managed host registered through `setNativeSubmissionHost` (or `pi.setNativeSubmissionHost` from an extension) authorizes every native submission before Pi's first semantic mutation for it and consumes a one-use binding fence with that mutation. With no host registered every entry point behaves exactly as unmodified Pi does. | `packages/coding-agent/test/native-submission-barrier.test.ts` in the patch, and `test/native-submit-barrier.test.mjs` in this repository against the built artifact |
| `0002-native-ingress-return-profile.patch` | Seams B, C and F: labelled native ingress through `ProcessTerminal.dispatchNativeInput`, return-key authorization for a component that declares the key free, and a launch-fixed virtual terminal profile, all behind `registerNativeAttachmentHost`. With no host registered, input provenance is `null` and negotiation is unmanaged Pi's own. | `test/native-ingress.test.mjs` and `test/native-return.test.mjs` in this repository against the built artifact |
| `0003-native-presentation-readiness.patch` | Seam E: cold presentation (`presentTerminal`) and the readiness record (`onNativeReadiness`, `nativeReadinessSnapshot`) plus the core bootstrap sideband, all opt-in. Until a host presents or subscribes, every changed path behaves as unmodified 0.84.3 does. | `test/native-presentation.test.mjs` in this repository against the built artifact |

Artifacts produced from this lock are therefore **patched**, not baseline, and
`build-manifest.json.artifactLabel` says so. The delivered interface is **A, B, C, E and F only**: seams D
and G are not in this series and are not present in the artifacts. A green build is not evidence of any
other capability, and none of the composed seams is qualified for activation: seam D's public
binding-commit API, seam G's drain and arbitrary-child terminal parity remain unwritten.

Changed upstream paths: `packages/coding-agent/src/core/{native-submission,native-presentation,native-bootstrap}.ts`
and `packages/tui/src/{native-attachment,native-presentation}.ts` (added),
`packages/coding-agent/src/{index.ts,main.ts,core/agent-session.ts,core/extensions/{types,loader}.ts,modes/print-mode.ts,modes/interactive/interactive-mode.ts}`,
and `packages/tui/src/{index,terminal,tui,tui-alt-screen,tui-main-screen,stdin-buffer,editor-component,components/editor}.ts`.
No dependency, lockfile, generated file or `dist` output is touched, and the bundled CLI is rebuilt by the
pipeline. The patches do not commute; `INTERFACE.md` section 9 records the order, the digests and the
prepared-tree hash each position produces.

## Second upstream input: release-generated data

This build is a **hybrid**: pinned upstream source plus one pinned input taken from a published upstream
release artifact. It is not a source-only reconstruction of the release, and no byte reproducibility of
the published packages is claimed from it. `upstream-lock.json` carries the same statement in
`buildKind`, and every `build-manifest.json` repeats it.

| | |
| --- | --- |
| Why | `packages/ai/src/providers/data/**` is gitignored upstream (`.gitignore:11`) and generated by `npm run generate-models`, which fetches the live models.dev catalog. The pinned commit does not build from source alone, and a live fetch is both non-reproducible and currently red at this commit (TS2353 in `packages/ai/src/providers/cloudflare-ai-gateway.ts`). |
| Package | `@earendil-works/pi-ai@0.84.3`, the published artifact of the **same version** as the pinned source |
| URL | `https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.84.3.tgz` |
| Integrity (SRI) | `sha512-M0YUV8vNO3y2WwWSyY8ijKJV5W4gkSUixuvk+Z00ZBjsyMfsdXfITsHEwP1UIf09YRWXT6oGn0GlCamt+P32XQ==` |
| Tarball | sha256 `9c40af2f43950f8e94e7bbcd0c1b3548f000972da00c4fb9c0d0529d4d7d5431`, 774947 bytes |
| Archive member taken | `package/dist/providers/data` → `packages/ai/src/providers/data` |
| Selected set | exactly 40 `.json` files, including upstream's own `.manifest.json`; every name and sha256 is listed in `upstream-lock.json`, aggregate digest `b5fba11812faa856bd659e202cc80a435a5ae98271e0360ee1324942a2547c84` |
| Restriction | `allowedExtensions: [".json"]`. **Only generated data comes from the artifact.** No executable file, no other archive member and no other package is taken from it: every package, and the bundled CLI, is rebuilt from the pinned source. |
| License | MIT, Copyright (c) 2025 Mario Zechner, the same license as the pinned source. The data is upstream's own generated output, redistributed here only as a pinned build input. |
| Verification | `build.mjs` checks the registry URL and integrity, then the downloaded tarball's own SRI, size and sha256, then the exact file-name set, every per-file digest, the extension allowlist and the aggregate digest — all **before** a single file is copied into the source tree. Upstream's `scripts/check-model-data.ts` revalidates the data during the build. |
| No fallback | A mismatch at any step aborts the build. There is no live model-data fallback, no fuzzy match and no unverified copy. The build uses upstream's own `build:offline` script, which is why no build step reaches the network for a catalog. |

This substitutes a pinned copy of upstream's own generated data for a live network fetch; it changes no
source file and no behaviour.

When another patch is added, it is listed here with its purpose and its regression test.
