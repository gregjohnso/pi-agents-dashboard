# Task 21 report — standalone acceptance

## Status

Implemented the integrated standalone acceptance harness. No npm publication, Pi registration, repository rename, provider/model request, or stock-Pi inference was performed.

## Package contents

One canonical npm tarball is built per package acceptance run. Project-owned contents are allowlisted to production `.mjs` files beneath `app`, `bin`, `cli`, `runtime`, `shared`, and `isolation`, plus `README.md`, `LICENSE`, and `package.json`. Project tests, snapshots, fixtures, TypeScript/Pixi/Vitest files, `.superpowers`, `.vscode`, caches, private state, diagnostics, sessions, worktrees, the former UI directory, and extension manifests are absent.

The two production Pi UI dependencies are bundled so local/global/npx acceptance remains host-independent and offline. Root devDependencies are not bundled. Dependency-owned metadata is audited separately from project-owned files; every install uses `--ignore-scripts` and an offline isolated cache.

| Tarball evidence | Result |
|---|---|
| Compressed bytes | `22,643,288` |
| Unpacked bytes | `103,956,852` |
| Listed files | `12,761` |
| Bundled dependency records | `4`; production dependency tree bundled; root TypeScript, Vitest, and `@types/node` devDependencies excluded |
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

## Final release gate

Executed once on the clean integrated branch after all six review lanes, accepted fixes, and scoped re-review:

| Command | Result |
|---|---|
| `pixi install --locked` | passed |
| `pixi run typecheck` | passed |
| `pixi run test-unit` | 56 files, 600 tests passed |
| `pixi run test-integration` | 7 files, 78 tests passed |
| `pixi run test-acceptance` | 3 files, 12 tests passed |
| `pixi run test` | 66 files, 690 tests passed |
| `pixi run pack-check` | passed; 12,761 entries audited |
| `git diff --check` | passed |
| `git status --short` | clean |

Six parallel read-only reviews reported 15 accepted findings. The same fix writer resolved them in `1fe6127`; scoped review found one remaining installed-viewer blocker and one recovery issue. The same writer resolved both in `3cc54e0`, and the final scoped review returned `GATE: PASS` with no critical or important finding.

## Residual unverified items

- No npm publication or public-registry installation was performed.
- No live provider/model request or stock-Pi inference acceptance was performed.
- Stock Pi behavior beyond the pinned public package contracts and bounded fake installed executable remains unverified.
- The private repository remote and primary checkout rename remains the post-acceptance gate; canonical Pi session files and managed worktrees must not be renamed.
- Bundling the production Pi UI dependency tree makes the tarball 22,643,288 compressed bytes in exchange for deterministic offline installation.

## Accepted-finding fix round

All 15 accepted findings were addressed without changing public viewer protocol version 1, canonical session/worktree paths, public package-root Pi imports, or destructive confirmation identities.

| Finding | Resolution |
|---:|---|
| 1 | Local, global, and npx journeys now have distinct temporary roots, HOME, prefix, cache, unrelated cwd, state roots, and minimal per-journey PATH containing only `node` and `sh`. |
| 2 | Migration integration now runs the production migration path, starts a real bounded destination daemon, verifies a second start returns the same PID as `alreadyRunning`, then stops it. |
| 3 | Worker readiness validates `get_state.sessionFile` equals the canonical accepted session file; mismatch exits and releases ownership. |
| 4 | The identity-and-adapter-version capability cache executes literal documented required live-event fixtures through the selected normalizer and records/refuses `required_live_events` without asking Pi to emit them or sending a valid prompt. |
| 5 | The worker opens the validated executable inode with `O_NOFOLLOW` and executes the inherited handle through `/proc/self/fd/3`; atomic pathname replacement after binding still executes the original inode. |
| 6 | Fingerprint overlap suppression now permits distinct stable canonical IDs while still suppressing history/live overlap and exact duplicate IDs. |
| 7 | Installed viewer startup subscribes from cursor zero on the snapshot epoch, reduces ordered v1 events through the snapshot cursor, reconciles authoritative snapshot state, and continues live on the same subscription. |
| 8 | Each v1 assistant delta is followed by an authoritative v1 `assistant_message` partial carrying exact thinking/text block continuity; no frozen field changed. |
| 9 | Broadcast subscribers use an ordered queue bounded by bytes and records; writes advance only after callback and `drain`, and overflow closes the slow socket. |
| 10 | Default installed list startup constructs the daemon-backed viewer, attaches through the same client, and swaps list/viewer controllers behind one `TuiAltScreen`. |
| 11 | Ctrl+C on a working composer routes interrupt before a pending overlay handles input; observer and non-working restrictions remain. |
| 12 | Resolved, replaced, and closed overlays call `dispose` and restore focus exactly once. |
| 13 | `STALE_IDENTITY` is a failed unresolved Stop, or `DELIVERY_UNKNOWN` after prior signaling; only exact terminal evidence clears ownership. |
| 14 | Signaler regression pins every inspect, graceful request, 5,000 ms wait, TERM, second wait, KILL, and terminal inspect in exact order. |
| 15 | Package metrics are retained in `/tmp/pi-dashboard-task-21-package-evidence.json` by acceptance and copied above; command and test counts follow. |

### Fix-round command and test evidence

| Command | Result |
|---|---|
| Executable/probe/normalizer/viewer/list focused gate | initial: 4 files and 60 tests passed; one list test parse failure; corrected list rerun: 1 file and 4 tests passed |
| Daemon/destructive/signaler/migration/installed focused gate | initial: 4 files and 75 tests passed; one installed-state expectation failed; corrected selected rerun: 1 passed, 4 skipped |
| Normalizer/store/reconciliation/recovery/standalone/viewer gate | 7 files, 73 tests passed |
| Package acceptance | initial: 1 passed, 1 failed because minimal PATH lacked `sh`; corrected selected rerun: 1 passed, 1 skipped |
| Typecheck | initial strict-check run exposed new regression JSDoc gaps; correction run passed both TypeScript projects |
| Final acceptance | initial run: 8 passed, 4 deterministic-age snapshot failures; focused terminal correction: 8 passed; fresh acceptance: 3 files, 12 tests passed in 68.01 seconds |
| `git diff --check` | passed |

No full suite, complete release gate, SLURM job, real inference, publication, Pi registration, or repository rename ran in this fix round.

## Final installed-viewer wiring correction

Normal `runDashboardApp` startup no longer accepts or forwards an `openViewer` override. `createStandaloneList` always binds Dashboard Enter/Right activation to its daemon-backed viewer client and replaces the active list controller behind the existing `TuiAltScreen`.

The transition now attaches before closing the list. Attach failure leaves the existing list open. After attachment, viewer construction or run failure closes any constructed viewer, detaches the composer, clears viewer focus, restores the list as the active controller, and reopens its daemon subscription unless the app itself is closing. The failure path sends no worker command or process signal.

Focused validation: `pixi run vitest run app/standalone.test.mjs app/list/standalone-list.test.mjs test/terminal.acceptance.test.mjs` passed 3 files and 19 tests. The single requested `pixi run typecheck` passed both TypeScript projects. The parent retains the complete release gate and required independent review.
