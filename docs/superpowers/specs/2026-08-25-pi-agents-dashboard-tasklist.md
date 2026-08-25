# Pi Agents Dashboard Task List

**Plan:** `docs/superpowers/specs/2026-08-25-pi-agents-dashboard-execution-plan.md`
**Spec:** `docs/superpowers/specs/2026-08-25-pi-agents-dashboard-design.md`
**Status:** Not started
**Release gate:** Stock Pi 0.84.3 lacks the public daemon-owned startup and native attachment seam required by the spec.

## Document responsibility

This file is the execution tracker. It owns checkbox state, owners, dependencies, deliverables, and gate results. It does not define product behavior or implementation contracts.

Use the [design spec](2026-08-25-pi-agents-dashboard-design.md) for requirements and decisions. Use the [execution plan](2026-08-25-pi-agents-dashboard-execution-plan.md) for files, interfaces, steps, and commands. A checked box records that its linked plan gate passed; it does not override either source document.

## Tracking Rules

- Check a task only after its focused tests and `pixi run test` pass on the integrated branch.
- Parallel code-writing tasks use separate Git worktrees after Task 1 creates the first commit.
- Merge parallel branches serially in dependency order.
- One writer owns each worktree. Review and validation lanes are read-only.
- Do not mark Task 14 or Task 16 complete while the host capability report says `daemonOwnedStartup: false` or `nativeAttach: false`.
- Run all unit, integration, process, package, and tmux tests locally through Pixi. Do not use SLURM or submitit.

## Decision Gate

- [x] **O1 Worker cap** is resolved in the design spec.
- [x] **O2 Completed history** is resolved in the design spec.
- [x] **O3 Idle retention** is resolved in the design spec.
- [x] **O4 Daemon scope** is resolved in the design spec.
- [x] **O5 Ambiguous delivery** is resolved in the design spec.
- [x] **O6 Attachment arbitration** is resolved in the design spec.
- [x] **O7 Platform support** is resolved in the design spec.
- [x] Task 3 configuration and protocol fixtures match the approved design decisions.

## Dependency Graph

```text
T01 scaffold
 ├─ T02 host capability spike ───────────────────────────────┐
 └─ T03 decision gate ─ T04 contracts/framing ─┬─ T05 state/index ─ T12 renderer ─┐
                                               ├─ T06 safety ─┬─ T07 registry ─┐   │
                                               │             ├─ T08 journal ───┼─ T10 workers ─ T11 daemon ─ T13 dashboard ─┐
                                               │             └─ T09 isolation │                                          │
                                               └───────────────────────────────┘                                          ├─ T14 native attach
T09 + T11 + T13 ────────────────────────────────────────────────────────────────────────────────────────────────────────────┴─ T15 destructive actions
T02 + T14 + T15 ────────────────────────────────────────────────────────────────────────────────────────────────────────────── T16 acceptance
```

## Milestone 0: Scaffold and Feasibility

- [x] **T01 Scaffold package and verification harness**
  - Owner: one writer in the root checkout.
  - Depends on: none.
  - Deliverables: self-contained npm/Pi manifest, package-relative runtime discovery, optional CLI stub, Pixi, TypeScript, Vitest, extension stub, README, license, first commit.
  - Gate: `pixi run typecheck && pixi run test-unit && pixi run pack-check`.

- [x] **T02 Prove Pi host capability seam**
  - Owner: isolated writer after T01.
  - Depends on: T01.
  - Can run in parallel with: T03.
  - Deliverables: feature probe, supported/unsupported integration fixture, host-seam evidence document.
  - Gate: stock Pi 0.84.3 fails closed; a supported host proves normal Pi-package startup, daemon ownership, native attachment, and package-relative runtime discovery without private imports or a global CLI.

- [x] **T03 Resolve product and protocol decisions**
  - Owner: parent plus user approval.
  - Depends on: T01.
  - Can run in parallel with: T02.
  - Deliverables: O1-O7 resolved in the design spec; strict config parser and tests.
  - Gate: no unresolved release default or protocol arbitration remains before T04.

## Milestone 1: Contracts and Pure Logic

- [x] **T04 Freeze shared contracts and JSONL framing**
  - Owner: one contract writer.
  - Depends on: T03.
  - Deliverables: session, launch, ownership, command, event, error, cursor, and config types; strict bounded JSONL codec.
  - Gate: split UTF-8, coalesced frames, malformed input, unknown operation, and size-limit tests pass.

- [x] **T05 Implement state reduction and session indexing**
  - Owner: isolated Lane A.
  - Depends on: T04.
  - Can run in parallel with: T06.
  - Deliverables: independent task/process/outcome/activity reducer; live/saved merge; search/filter/sort/group selectors.
  - Gate: table-driven state matrix and canonical merge tests pass.

- [x] **T06 Implement runtime safety primitives**
  - Owner: isolated Lane B.
  - Depends on: T04.
  - Can run in parallel with: T05.
  - Deliverables: paths, permissions, atomic file, lifecycle lock, Linux PID/start/PGID identity, verified signal escalation.
  - Gate: hostile-filesystem, PID-reuse, exact-target, and atomic-failure tests pass.

## Milestone 2: Durable Foundations

- [x] **T07 Implement registry, ownership, and per-session serialization**
  - Owner: isolated Lane C.
  - Depends on: T04, T06.
  - Can run in parallel with: T08, T09, T12.
  - Deliverables: atomic registry, compare-and-swap revisions, canonical writer leases, keyed coordinator.
  - Gate: simultaneous resume yields one owner and one visible conflict.

- [x] **T08 Implement durable commands, events, and frontend protocol**
  - Owner: isolated Lane D.
  - Depends on: T04, T06.
  - Can run in parallel with: T07, T09, T12.
  - Deliverables: command journal, event store, authenticated socket server, reconnecting daemon client.
  - Gate: failpoints at every acknowledgement boundary produce replay or explicit `DELIVERY_UNKNOWN`.

- [x] **T09 Implement worktree and shared-directory isolation**
  - Owner: isolated Lane E.
  - Depends on: T04, T06.
  - Can run in parallel with: T07, T08, T12.
  - Deliverables: launch preflight, worktree creation, exact-path shared confirmation, guarded cleanup.
  - Gate: repository fixture matrix and every cleanup refusal code pass.

## Milestone 3: Workers and Daemon

- [x] **T10 Implement Pi RPC workers and process supervision**
  - Owner: one integration writer.
  - Depends on: T07, T08.
  - Deliverables: narrow RPC adapter, worker entrypoint, durable worker boundaries, process supervisor, cap accounting.
  - Gate: two workers have distinct PIDs/PGIDs; frontend and daemon loss do not stop them; readiness precedes acceptance.

- [x] **T11 Assemble daemon lifecycle, reconciliation, and recovery CLI**
  - Owner: one integration writer.
  - Depends on: T07, T08, T10.
  - Deliverables: singleton daemon, recovery admission gate, restart reconciliation, `doctor`, daemon CLI, and optional global npm `install|uninstall` registration commands.
  - Gate: restart reconciles worker identity, ownership, journals, and cursors before mutation admission.

## Milestone 4: Dashboard and Native Attachment

- [x] **T12 Implement responsive rendering and virtual rows**
  - Owner: isolated Lane F.
  - Depends on: T05.
  - Can run in parallel with: T07, T08, T09, T10, T11.
  - Deliverables: Jobwatch palette, responsive columns, virtual list, row cache, width-safe snapshots.
  - Gate: 10,000 rows render only the viewport; snapshots pass at 160, 120, 80, 55, and 40 columns.

- [ ] **T13 Implement interaction, composer, overlays, `/agents`, and Left gesture**
  - Owner: one UI integration writer.
  - Depends on: T08, T11, T12.
  - Deliverables: dashboard controller, launch form, metadata/help, search/filter/sort/group controls, global command, gesture adapter.
  - Gate: fake-clock Left matrix, context-sensitive Ctrl+C, launch confirmation, and renderer-disposal tests pass.

- [ ] **T14 Integrate native Pi attachment and conversation controls**
  - Owner: one host integration writer.
  - Depends on: T02 supported-host gate, T11, T13.
  - Blocked while: `daemonOwnedStartup` or `nativeAttach` is false.
  - Deliverables: native bridge, prompt/follow-up/steer/interrupt/UI-response routing, cross-terminal attachment.
  - Gate: native transcript/editor/commands/tools/images/extensions work with unchanged worker/session identity across detach and reattach.

## Milestone 5: Safety and Acceptance

- [ ] **T15 Complete Stop, Delete, trash, and worktree cleanup**
  - Owner: one destructive-workflow writer.
  - Depends on: T09, T11, T13.
  - Can run in parallel with: T14 after shared UI/backend contracts stabilize.
  - Deliverables: Ctrl+X stop/delete state machine, exact process-group escalation, Pi trash adapter, separate cleanup CLI.
  - Gate: cancellation and identity races signal nothing; sentinel process remains alive; dirty/unpushed work remains intact.

- [ ] **T16 Run system acceptance, hardening, and package validation**
  - Owner: parent orchestrator; parallel read-only review lanes; one fix writer.
  - Depends on: T02 supported-host gate, T14, T15.
  - Deliverables: packed-install test, lifecycle/reconnect harness, tmux key/resize scenarios, security/performance checks, release documentation.
  - Gate: `pixi run typecheck && pixi run test-unit && pixi run test-integration && pixi run test && pixi run pack-check`.

## Parallel Review Lanes for T16

- [ ] **R1 Daemon and recovery review:** ownership, durability, ordering, crash boundaries, reconnection.
- [ ] **R2 Security review:** socket permissions/token, paths/symlinks, process identity/signaling, worktree cleanup.
- [ ] **R3 TUI review:** Jobwatch parity, keyboard context, native attachment, responsive rendering, disposal.
- [ ] **R4 Delivery review:** tests, npm/Pi installation, local-path installation, optional global CLI registration, updates, compatibility failure, README accuracy.
- [ ] Parent classifies findings as blockers, fixes worth doing now, or deferred notes.
- [ ] One writer applies accepted fixes.
- [ ] Focused suites and the full gate pass after fixes.

## Release tracking

- [ ] Design decisions O1-O7 are resolved and Task 3 fixtures match them.
- [ ] Tasks T01-T16 are complete on the integrated branch.
- [ ] Review lanes R1-R4 have no undispositioned findings.
- [ ] The host capability report confirms daemon-owned startup and native attachment.
- [ ] The execution plan's Task 16 package, lifecycle, security, performance, and TUI gates pass.
- [ ] `pixi run typecheck && pixi run test-unit && pixi run test-integration && pixi run test && pixi run pack-check` exits 0 on a clean checkout.
