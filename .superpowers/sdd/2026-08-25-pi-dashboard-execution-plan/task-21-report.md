# Task 21 report — standalone acceptance

## Status

Implemented the integrated standalone acceptance harness. No npm publication, Pi registration, repository rename, provider/model request, or stock-Pi inference was performed.

## Package contents

One canonical npm tarball is built per package acceptance run. Project-owned contents are allowlisted to production `.mjs` files beneath `app`, `bin`, `cli`, `runtime`, `shared`, and `isolation`, plus `README.md`, `LICENSE`, and `package.json`. Project tests, snapshots, fixtures, TypeScript/Pixi/Vitest files, `.superpowers`, `.vscode`, caches, private state, diagnostics, sessions, worktrees, the former UI directory, and extension manifests are absent.

The two production Pi UI dependencies are bundled so local/global/npx acceptance remains host-independent and offline. Root devDependencies are not bundled. Dependency-owned metadata is audited separately from project-owned files; every install uses `--ignore-scripts` and an offline isolated cache.

| Tarball evidence | Result |
|---|---|
| Compressed bytes | Built and consumed by acceptance; numeric value was not retained in the concise Vitest summary |
| Unpacked bytes | Built and consumed by acceptance; numeric value was not retained in the concise Vitest summary |
| Listed files | Entire tar listing audited by acceptance; numeric value was not retained in the concise Vitest summary |
| Bundled dependency records | Production dependency tree bundled; root TypeScript, Vitest, and `@types/node` devDependencies excluded |
| Local absolute-path install | unrelated cwd, `--help`, exit 0 |
| Global tarball install | disposable prefix, unrelated cwd, `--help`, exit 0 |
| Cached npx | `--offline`, isolated cache, unrelated cwd, `--help`, exit 0 |

## Migration failpoint matrix

| Boundary | Preserves legacy source | Same-identity restart |
|---|---:|---:|
| `staging_start` | yes | completes |
| `after_staged_file_fsync` | yes | completes |
| `before_manifest_rename` | yes | completes |
| `after_manifest_publication` | yes | completes |
| `before_reconciliation_completion` | yes | completes |
| `after_reconciliation` | yes | completes |

A verified live legacy daemon or supervisor refuses before staging with exact identity details. Unsafe modes, symlinks, malformed artifacts, changed migration identity, destination collision, and changed published output fail closed. A matching reconciled migration is idempotent. Canonical session and worktree paths remain unchanged.

## Fake-Pi argv and probe evidence

| Boundary | Evidence |
|---|---|
| Discovery/probe A | one `--help`; bounded `--mode rpc --session <temporary>`; reported `A` |
| Discovery/probe B | executable atomically replaced; new file identity; reported `B` |
| Required commands | `get_state`, prompt, follow-up, steer, abort, UI response classified without a valid prompt |
| Inference during probe | every pre-launch probe log has `providerInvocation:false` |
| Installed launch | exact argv begins `--mode rpc --session <canonical-session-file>`; optional flags remain argv entries |
| Spawn safety | executable/worker spawns use argv arrays and `shell:false` |
| Missing capability | missing `steer` returns `UNSUPPORTED_PI_CAPABILITY`; no ownership, canonical file, or run directory |

Later valid prompts target only bounded fake Pi processes and emit deterministic `message_end` frames. They do not contact a provider.

## Process identity and reconnect table

| Run | Before frontend close | After daemon close | After daemon restart |
|---|---|---|---|
| `run-one` / session `one` | distinct supervisor and Pi-child PIDs; supervisor is process-group leader; version A | both exact identities inspect alive | same lease/run/canonical file; worker reauthenticates; later frame persists/replays |
| `run-two` / session `two` | distinct supervisor and Pi-child PIDs; supervisor is process-group leader; version B | both exact identities inspect alive | same lease/run/canonical file; worker reauthenticates; later frame persists/replays |

The four process IDs are distinct. Frontend close and normal daemon close send no Stop/Delete action. Recovered viewer subscriptions replay each later assistant event from the cursor captured before restart.

## Mixed executable versions

| Record | Executable path | File identity | Pi version | Adapter |
|---|---|---|---|---:|
| Existing `run-one` | configured canonical path | A identity retained | A | 1 |
| New `run-two` | same configured canonical path | replacement B identity | B | 1 |

Restart reconciliation preserves both records and exact process identities. Capability support is identity-based, not version-allowlisted.

## Diagnostics

| Diagnostic | Mode | Segment policy | Maximum |
|---|---:|---|---:|
| Raw RPC | `0600` beneath `0700` run directory | four rotating 8 MiB segments | 32 MiB |
| Pi stderr | `0600` beneath `0700` run directory | one rotating segment | 8 MiB |

Rotation retains removed byte/record counts. Oversized records retain only bounded metadata with original byte count and SHA-256 hash. Raw diagnostics do not enter normalized snapshots/events, package output, or telemetry.

## Terminal dimensions and journeys

| Dimensions | List | Viewer |
|---|---|---|
| `160x40`, `120x32`, `80x24`, `55x16`, `40x10` | bounded snapshots; ID/State/Project/Activity/Age order where width permits; no Model column | bounded Pi-style snapshots with chat, thinking, five tool states, lifecycle, pending UI, error, active state, placeholders, composer |

Deterministic controller journeys cover Enter/Right open, list Ctrl+C close, viewer Ctrl+C interrupt, search/filter/sort/group, metadata/help, composer focus, transcript search, tool selection/expansion, prompt/follow-up/steer, all pending UI control paths through existing tests plus confirm in acceptance, observer refusal, clean return, 500 ms dirty/history return, and Stop-then-later-Delete confirmation.

## Public import audit

The shipped UI uses only package-root imports from `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent`. Acceptance excludes deep `dist/`/`src/` imports, `InteractiveMode`, `AgentSession`, native attachment, extension entry points, and a Pi version allowlist.

## Destructive and cleanup sentinel

Stop journals before delivery, requests graceful shutdown, waits 5,000 ms, sends TERM only to the exact revalidated process group, waits 5,000 ms, and requests KILL only if the same identity remains. Sentinel groups `777` and `9202` remain untouched in deterministic signal/destructive tests. Delete without the public trash seam returns `TRASH_CAPABILITY_UNAVAILABLE` and preserves both session and worktree paths. Cleanup retains late ownership, marker, repository, branch, HEAD, dirty/untracked, and push-state checks.

## Residual unverified items

- No npm publication or public-registry installation was performed.
- No live provider/model request or stock-Pi inference acceptance was performed.
- Stock Pi behavior beyond the pinned public package contracts and bounded fake installed executable remains unverified.
- The private repository remote and primary checkout rename remains the post-acceptance gate; canonical Pi session files and managed worktrees must not be renamed.
- Bundling the production Pi UI dependency tree makes the tarball larger in exchange for deterministic offline installation. The tarball was built and audited, but exact byte/file counts were not retained in the concise final Vitest output.
