# pi-dashboard task list

**Plan:** `docs/superpowers/specs/2026-08-25-pi-dashboard-execution-plan.md`
**Spec:** `docs/superpowers/specs/2026-08-25-pi-dashboard-design.md`
**Status:** T17-T20 are integrated and reviewed; T21 is the final acceptance gate.
**Integrated baseline:** `5a36be230521610f2445f8947c4c92760e874872`

## Document responsibility

This file tracks owners, dependencies, deliverables, and gate status. The [design](2026-08-25-pi-dashboard-design.md) owns product behavior. The [execution plan](2026-08-25-pi-dashboard-execution-plan.md) owns files, interfaces, exact steps, and commands.

## Tracking rules

- Check a task only after its focused commands, `pixi run test`, and fresh task review pass on the integrated branch.
- Mutation-capable parallel lanes use separate Git worktrees with one writer each.
- Merge parallel branches serially in dependency order and run the full suite after each merge.
- Review lanes are read-only. Accepted final findings go to one fix writer.
- Tests use bounded fake installed Pi executables and make no model request.
- Run tests through Pixi, not SLURM or submitit.
- Do not publish npm in T17-T21.
- Rename the private remote and primary checkout only after T21 acceptance. Canonical Pi session files and managed worktrees retain their paths.

## Historical baseline

- [x] **T01 Scaffold package and verification harness**
- [x] **T02 Record the historical Pi host-capability finding**
- [x] **T03 Resolve product and protocol defaults**
- [x] **T04 Freeze durable command contracts and JSONL framing**
- [x] **T05 Implement state reduction and session indexing**
- [x] **T06 Implement runtime safety primitives**
- [x] **T07 Implement registry, ownership, and per-session serialization**
- [x] **T08 Implement durable commands, events, and frontend protocol**
- [x] **T09 Implement worktree and shared-directory isolation**
- [x] **T10 Implement the supervisor and Pi RPC worker foundation**
- [x] **T11 Assemble daemon lifecycle, reconciliation, and recovery CLI**
- [x] **T12 Implement responsive list rendering and virtual rows**
- [x] **T13 Implement list interaction, composer, overlays, and durable frontend persistence**
- [x] **T14 Superseded by T20 standalone viewer**
- [x] **T15 Complete Stop, Delete, trash-capability refusal, and worktree cleanup**
- [x] **T16 Superseded by T21 standalone acceptance**

The historical extension shell and host-attachment gate are not release prerequisites. T17 removes those shipped surfaces while preserving reusable list, daemon, durability, isolation, and destructive-workflow behavior.

## Dependency graph

```text
integrated baseline
       |
      T17
     /   \
   T18   T20
    |      |
   T19     |
     \    /
       T21
```

- T17 is serial.
- T18 and T20 may run concurrently from the reviewed T17 commit because their file ownership is disjoint.
- T19 starts after T18 and may run while T20 finishes.
- T21 starts after reviewed T19 and T20 commits are integrated.

## Standalone milestones

### Milestone 6: Foundation

- [x] **T17 Rename the product, migrate state, and start the standalone list**
  - Owner: Foundation lane, one writer.
  - Depends on: integrated baseline.
  - Claimed files: package/lock, bin, CLI naming, config/contracts, paths/migration, daemon composer authorization, `app/list/**`, standalone shell.
  - Deliverables:
    - package and executable named `pi-dashboard`;
    - no package extension entry point or package registration CLI;
    - public Pi UI packages installed as standalone runtime dependencies;
    - schema 2 configuration and frozen viewer contracts;
    - locked, staged, fsynced, atomic migration that preserves legacy source, sessions, and worktrees;
    - relocated Jobwatch list opened by empty argv;
    - daemon enforcement of composer-only mutations.
  - Focused gate:

    ```bash
    pixi run typecheck
    pixi run vitest run test/package-metadata.test.mjs cli/main.test.mjs app/standalone.test.mjs app/app-controller.test.mjs
    pixi run vitest run shared/config.test.ts shared/contracts.test.ts shared/viewer-contracts.test.ts runtime/paths.test.mjs runtime/state-migration.test.mjs test/migration.integration.test.mjs
    pixi run vitest run runtime/control-server.test.mjs runtime/daemon.integration.test.mjs app/list/*.test.mjs
    pixi run test
    pixi run pack-check
    ```

  - Review gate: package/root rename, migration publication/recovery, path preservation, and composer authorization have no critical or important finding.

### Milestone 7: Installed Pi and normalized protocol

- [x] **T18 Launch and supervise the installed Pi executable**
  - Owner: Process lane, one writer in an isolated worktree from T17.
  - Depends on: T17.
  - Can run in parallel with: T20.
  - Claimed files: executable discovery/probe, diagnostics, RPC adapter, worker, worker supervisor, ownership/registry runtime identity, fake installed Pi process tests.
  - Deliverables:
    - discovery precedence `--pi-bin`, config, `PATH`;
    - no-inference capability probe cached by executable realpath plus file identity;
    - structured `pi --mode rpc --session <canonical-session-file>` launch with `shell: false`;
    - distinct supervisor and Pi-child PID/start/process-group identities;
    - ownership before child session-file open and `get_state` before readiness;
    - durable raw-frame forwarding and reconnect without child signaling;
    - four 8 MiB RPC segments and one 8 MiB stderr bound;
    - old runs retain executable A while new runs use executable B.
  - Focused gate:

    ```bash
    pixi run typecheck
    pixi run vitest run runtime/pi-executable.test.mjs runtime/pi-capability-probe.test.mjs runtime/rotating-diagnostics.test.mjs
    pixi run vitest run runtime/pi-rpc-adapter.test.mjs runtime/worker-supervisor.test.mjs runtime/worker.integration.test.mjs
    pixi run vitest run runtime/ownership.test.mjs runtime/registry-store.test.mjs test/installed-pi.integration.test.mjs test/mixed-pi-versions.integration.test.mjs
    pixi run test
    ```

  - Review gate: no executable identity time-of-check/time-of-use gap, inference during probe, same-process child identity, unbounded diagnostics, or process-lifetime regression.

- [x] **T19 Normalize canonical history and live frames into viewer snapshots/events**
  - Owner: Normalization lane, one writer in an isolated worktree from merged T18.
  - Depends on: T18.
  - Can run in parallel with: remaining T20 work.
  - Claimed files: session history reader, viewer normalizer/store, event-store adaptation, daemon/control-server viewer integration, viewer client methods, recovery tests.
  - Deliverables:
    - all viewer payload kinds and activity phases from the T17 contract;
    - deterministic IDs, Pi ID preservation, history/live deduplication, assistant/tool continuity;
    - pending UI, model/thinking/activity, placeholders, typed malformed-required errors, bounded unknown events;
    - persisted-before-broadcast viewer events and process/render/persist/ACK client order;
    - per-session cursors, daemon epoch refresh, snapshot plus replay recovery;
    - no raw diagnostics in viewer responses and no canonical session rewrite.
  - Focused gate:

    ```bash
    pixi run typecheck
    pixi run vitest run runtime/session-history.test.mjs runtime/viewer-normalizer.test.mjs runtime/viewer-store.test.mjs
    pixi run vitest run runtime/event-store.test.mjs runtime/control-server.test.mjs runtime/daemon.integration.test.mjs runtime/reconciliation.failure.test.mjs
    pixi run vitest run app/daemon-client.test.mjs test/viewer-recovery.integration.test.mjs
    pixi run test
    ```

  - Review gate: stable identity/deduplication, cursor ordering, crash recovery, required/optional compatibility, and privacy have no critical or important finding.

### Milestone 8: Interactive viewer

- [x] **T20 Build the full-screen Pi-style chat viewer**
  - Owner: Viewer UI lane, one writer in an isolated worktree from T17.
  - Depends on: T17 viewer contracts.
  - Can run in parallel with: T18 and, after T18 merges, T19.
  - Claimed files: `app/viewer/**`, app controller, list-to-viewer boundary, list columns/snapshots.
  - Deliverables:
    - public package-root Pi imports only;
    - Pi user/assistant/tool components, markdown, thinking treatment, `CustomEditor`, keybindings, viewport, overlays, and theme tokens;
    - user/assistant streaming chat, tool states, thinking, activity, lifecycle cards, pending UI, placeholders, model/thinking status;
    - one composer and observer UI restrictions;
    - idle prompt, working follow-up, explicit steer, interrupt, and UI response;
    - per-session drafts/history and process/render/persist/ACK ordering;
    - Enter/Right replaces list with viewer; exact Left/Escape 500 ms return table;
    - list columns ID, State, Project, Activity, Age with no Model column;
    - width-safe virtualized list/chat at five required terminal sizes.
  - Focused gate:

    ```bash
    pixi run typecheck
    pixi run vitest run app/viewer/*.test.mjs test/public-pi-imports.test.mjs
    pixi run vitest run app/app-controller.test.mjs app/standalone.test.mjs app/list/*.test.mjs
    pixi run test
    ```

  - Review gate: public Pi reuse, input context, role restrictions, gesture table, virtualization, disposal, and column order have no critical or important finding.

### Milestone 9: Acceptance

- [x] **T21 Prove standalone package, migration, lifecycle, security, and terminal acceptance**
  - Owner: Acceptance integration writer; parallel read-only reviewers; one final fix writer.
  - Depends on: reviewed and integrated T19 and T20.
  - Claimed files: acceptance tests/fixtures, package scripts, Pixi tasks, typecheck coverage, README, accepted focused fixes.
  - Deliverables:
    - local path, global tarball, offline npx, and package-relative startup journeys;
    - clean packed file list and no npm lifecycle scripts;
    - migration failure/restart matrix and one reconciled destination daemon;
    - two live Pi children across app closure and daemon restart;
    - mixed executable versions and normalized replay;
    - exact Stop escalation, sentinel survival, trash-unavailable refusal, and worktree preservation;
    - five terminal-size journeys for list/viewer/input/destructive behavior;
    - six independent read-only reviews and one scoped fix/re-review;
    - release evidence without npm publication.
  - Focused gate:

    ```bash
    pixi run vitest run test/package.acceptance.test.mjs
    pixi run vitest run test/lifecycle.acceptance.test.mjs test/mixed-pi-versions.integration.test.mjs test/migration.integration.test.mjs
    pixi run vitest run test/terminal.acceptance.test.mjs
    pixi run vitest run test/destructive-actions.integration.test.mjs runtime/process-signaler.test.mjs isolation/cleanup.test.mjs
    ```

  - Full gate:

    ```bash
    pixi install --locked
    pixi run typecheck
    pixi run test-unit
    pixi run test-integration
    pixi run test-acceptance
    pixi run test
    pixi run pack-check
    ```

  - Review gate: all evidence-backed findings are fixed or explicitly dispositioned; no release criterion remains unverified.

## T21 parallel read-only reviews

- [x] **R1 Package and migration:** package identity/content, schema conversion, lock/publication order, source/path preservation.
- [x] **R2 Executable and protocol:** discovery, identity recheck, no-inference probe, exact argv, process/reconnect identity.
- [x] **R3 Normalization and diagnostics:** history/live deduplication, cursors/crash order, privacy, 32/8 MiB bounds.
- [x] **R4 TUI and public Pi UI:** Jobwatch columns, chat behavior, key contexts, five dimensions, public imports, disposal.
- [x] **R5 Lifetime and destructive safety:** app/daemon loss, mixed versions, ownership, exact signals, trash, cleanup.
- [x] **R6 Delivery and documentation:** scripts, install journeys, packed exclusions, README and evidence completeness.
- [x] Parent dispositions every finding.
- [x] One writer applies all accepted fixes.
- [x] One scoped re-review validates the fix range.

## Release tracking

- [x] Standalone design approved.
- [x] Diagnostic limits approved: four 8 MiB RPC segments and one 8 MiB stderr limit.
- [x] Historical T14 and T16 release direction superseded.
- [x] T17 complete and reviewed.
- [x] T18 complete and reviewed.
- [x] T19 complete and reviewed.
- [x] T20 complete and reviewed.
- [x] T21 complete and reviewed.
- [x] R1-R6 have no undispositioned finding.
- [x] Packed output exposes only `pi-dashboard` and excludes private/runtime/development artifacts.
- [x] Required capability failure starts no canonical writer.
- [x] App and daemon closure leave verified runs alive.
- [x] Migration preserves legacy source, canonical Pi session files, and worktrees.
- [x] Stop/Delete/cleanup preserve exact identity and scope.
- [x] Full release gate exits 0 on a clean checkout.
- [ ] Private repository remote and primary checkout renamed after acceptance.
- [x] npm remains unpublished until separate release approval.

## Backlog

- [ ] List: `Ctrl+X` stops the selected session; a second `Ctrl+X` within 500 ms clears it. Same-key double-press window as the viewer's return gesture, no confirmation overlay for the stop, and the clear still refuses when the session is live or another frontend is attached.

## Work in progress (2026-08-27)

Branch `standalone-dashboard`, last commit `1be3bd6`, 862 tests and typecheck green. Daemon is running an older build; restart it to pick up everything below.

Landed since the last daemon restart:
- Delete works in production. Without a Pi trash seam it now forgets the dashboard record and leaves the session file and worktree untouched (`43951e7`).
- Attach no longer resurrects a dead session; only the viewer sets `activate: true` (`43951e7`).
- Delete reclaims worker leases whose process is provably gone (`32abf80`).
- Daemon start sweeps worktree ownership locks left by dead daemons (`63a5a25`).
- One derived state per row, Jobwatch-colored; header counts the same states (`8f30cb6`, `f6a05fc`).
- List shows NAME/STATE/ACTIVITY/AGE, no ID column; selected row's cwd on the context line; composer has a closing rule (`f6a05fc`).
- Summary pass writes a session name as well as a summary; `/rename` marks a name operator-owned (`f6a05fc`).
- Destructive confirmations survive summary/name revision churn and cancel only when the session changes what it admits (`1be3bd6`).

Open, in order:
- [ ] Standard Pi commands (`/new`, `/resume`, `/stats`, `/tree`, `/export`, auto-compact/auto-retry/steering toggles) wired to Pi's own RPC implementations. `new_session`/`switch_session`/`fork`/`clone` rebind the running Pi to a different session file, so the daemon must follow the rebind (registry, viewer store, broadcast) or refuse honestly — never silently rebind.
- [ ] `/color <name>`: dashboard-owned session color, set through a daemon op (works on dead sessions), tinting the viewer prompt bar and the NAME cell.
- [ ] Arrow-key transcript scrolling, Jobwatch style, with follow-the-tail, new-activity marker and Home/End, plus a documented rule for sharing Up/Down with Pi's prompt history.
- [ ] Two-finger/wheel scrolling. Root cause found: the mounted host component forwards only `handleInput`, so wheel events never reach either surface and `DashboardController.handleMouse` is currently dead code.
- [ ] `Ctrl+X` stops a session; a second `Ctrl+X` within 500 ms clears it.
- [ ] Fast-forward `master` (55 commits behind) so a fresh clone is not stale.
- [ ] CLI destructive commands time out before the stop policy completes, reporting failure for a stop that succeeded.

Three subagents for the first three items died when their runner process disappeared; their worktrees produced no commits. Relaunch from a clean tree.
