# Architecture implementation plan

Delete the unused dashboard features first, then make multi-client behavior explicit. Implement the remaining architecture work as 18 green commits with five operator-machine gates. The estimated effort is 7 to 11 engineer-days. This is an estimate, not measured work. It includes tests, compatibility paths, the five gates, and documentation. It excludes review time and waits for a maintenance window.

The target is one daemon for a state root, many terminal clients, one worker per live Pi session, and at most one writer per session. A writer is a connection-scoped role. Any number of observers may open the session read-only. The daemon and workers outlive terminal clients.

## Eight implementation decisions

The original eight decisions remain here. Decision 5 is settled by this revision. The others retain their prior recommendation and still need operator approval before their commit begins.

1. **Model admission validation. Recommended.** Validate a selected model in the daemon after journal acceptance and before launch resolution. The frontend picker is an early check only. Daemon validation covers command-line interface clients, stale frontends, and direct protocol clients.
2. **Refused launch artifacts. Recommended.** A known admission refusal leaves a terminal `FAILED` journal result and no session record, Pi session file, worktree, worker, or list row. A failure after preparation keeps the failed row because side effects and cleanup evidence exist.
3. **Unavailable model catalog. Recommended.** Record the diagnostic and let Pi decide. `MODEL_CATALOG_FAILED` is different from `MODEL_UNKNOWN`.
4. **Unused trash seam. Recommended.** Remove it. Production Delete already forgets only the dashboard record. A future command that deletes Pi files would need separate wording and recovery.
5. **List protocol compatibility. Settled as a two-release transition.** The current frontend sends `subscribe` as an untracked request and discards its response, so a new daemon cannot make that already-running process display a refusal. First ship a bridge client that tracks the subscription response and displays `Dashboard protocol changed. Exit and restart pi-agents.` on `CLIENT_RESTART_REQUIRED`; the bridge daemon retains bounded old replay. In the following release, the new frontend sends `subscribe_list_changes` and the daemon rejects old `subscribe` with `CLIENT_RESTART_REQUIRED`. This removes the synchronized manual-close step. A pre-bridge frontend keeps working against the bridge daemon until it restarts naturally.
6. **Retired durable files. Recommended.** Ignore valid obsolete list, attachment, and viewer acknowledgement files in place. A corrupt retired file does not block startup. Do not delete files during rollout.
7. **Legacy trash transactions. Recommended.** Ignore an absent or empty `delete-results.json`. Stop startup with `UNSUPPORTED_LEGACY_DELETE_TRANSACTION` for any nonempty entry.
8. **Worker inter-process communication handoff. Recommended.** Keep inter-process communication (IPC) through Pi identity binding and authenticated socket adoption. Persist readiness, send `handoff_to_socket`, receive its socket acknowledgement, then disconnect IPC. Without those messages, a new worker retains IPC for an older daemon still in memory.

## Six feature decisions are settled

1. Several terminal windows and dashboards are a first-class use case. Keep composer and observer roles, make them connection-scoped, and add the missing read-only viewer.
2. Delete `/stats`, `/tree`, and `/export`. Remove the `session_query` operation and payload shape from every layer.
3. Delete `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up`. Pi owns these settings. Remove their commands, projections, adapter methods, and tests.
4. Keep worktree isolation, ownership locks, sweeps, and cleanup.
5. Keep `/model`. Delete `/thinking`, its picker, `set_thinking_level`, and requested thinking level from dashboard launch.
6. Keep summaries opt-in. Summary model settings remain dashboard settings and are not Pi settings passthrough.

## Invariants that every commit preserves

- The daemon is the only writer of session records.
- Ownership is released only after the worker and Pi child are provably gone.
- Delete forgets dashboard state only. It does not remove a canonical Pi file or worktree.
- Pi lifecycle event mapping has one home.
- A revision guard covers every fact used by a destructive operation.
- Background work stays outside operator locks.
- Every process boundary has a versioned contract.
- One session has at most one composer connection and any number of observers.
- Socket loss releases a composer claim but does not cancel an accepted command.
- Worktree creation, locks, sweeps, and cleanup remain unchanged.
- Summaries remain disabled until the operator opts in.

## Every commit starts with the failing test

Write the named test first and observe the stated failure. Add implementation in the same commit. Run focused tests, the full 788-test suite, and `pixi run typecheck`. Every commit stays green. Test counts are targets, not promises.

## Sequence and parallel work

### Required serial path

1. Run Gate 0.
2. Land changes 1 through 3, the feature deletions.
3. Land change 4, read-only opening, before changing attachment durability.
4. Land changes 5.1 through 5.3, one worker route, then pass Gate 1.
5. Land change 6, Pi-confirmed model semantics, then pass Gate 2.
6. Land changes 7.0 through 7.3 for the two-release list transition. Deploy the bridge behavior before 7.2 removes replay.
7. Land changes 8.1 and 8.2 for connection-scoped access and per-frontend state, then pass Gate 3.
8. Land changes 9 and 10, then pass Gate 4.

### Work that may proceed independently

- Trash removal may proceed after Gate 0. It shares `runtime/daemon.mjs`, so merge it only after the serial branch is current.
- Viewer acknowledgement removal may be prepared after the list contract is fixed. It shares `app/daemon-client.mjs` and `shared/contracts.mjs` with list invalidation.
- Test fixture design for three clients may proceed while feature deletions land. Production attachment changes wait for list invalidation because current attachment recovery emits list events.

### Protocol decisions made once

- Worker readiness, socket adoption, and IPC handoff are one decision.
- `subscribe_list_changes`, tracked legacy subscription refusal, and `CLIENT_RESTART_REQUIRED` are one list compatibility decision. The bridge client must ship while the daemon still supports old replay.
- Connection identity and durable request identity are separate. A live dashboard gets a process-scoped connection ID. Durable command recovery may retain the stable installation ID and request ID.
- Access notifications are connection-scoped. `session_access_changed` carries `sessionId`, the receiving connection's role, `writerPresent`, and an in-memory generation. It carries no other client ID.
- An observer is never promoted automatically. It explicitly asks for composer after a vacancy. The per-session lock decides races.
- Accepted commands continue after client disconnect. Disconnect only releases the role.

## Change 1: delete dashboard session queries

**Operator-visible failure removed.** `/stats`, `/tree`, and `/export` currently fail on newly launched workers. The dashboard no longer offers them.

**Estimate:** 1 commit, 0.5 engineer-day, net deletion of 120 to 220 lines.

### Commit 1: `feat: remove dashboard session queries`

Tests first:

- In `app/viewer/slash-commands.test.mjs`, assert `/stats`, `/tree`, and `/export` are absent. This pins stale commands remaining visible.
- In `shared/contracts.test.mjs`, assert `session_query` is rejected. This pins a hidden generic request seam.
- In `runtime/worker.test.mjs`, remove query execution cases only after the rejection tests fail for the intended reason.

Implementation:

- Remove query parsing and panels from `app/viewer/slash-commands.mjs` and `app/viewer/viewer-controller.mjs`.
- Remove `query` from `createDaemonViewerClient` in `app/list/standalone-list.mjs`.
- Remove `session_query` and `SESSION_QUERIES` from `shared/contracts.mjs`.
- Remove the daemon branch in `runtime/daemon.mjs`, `runSessionQuery` in `runtime/worker.mjs`, and dashboard-only Pi adapter methods in `runtime/pi-rpc-adapter.mjs`.

What could break: deleting an adapter method still used by capability probing or another command. Evidence is a focused import failure or typecheck error.

Stopping point: grep finds no production `session_query`, `get_session_stats`, `get_tree`, or `export_html`; focused tests, full suite, and typecheck pass.

Rollback: revert this commit. No durable format changes.

## Change 2: delete Pi settings passthrough

**Operator-visible failure removed.** The dashboard no longer offers four settings that Pi owns, so the `enabled` and `mode` projection mismatch disappears.

**Estimate:** 1 commit, 0.5 engineer-day, net deletion of 100 to 180 lines.

### Commit 2: `feat: remove Pi settings passthrough`

Tests first:

- In `app/viewer/slash-commands.test.mjs`, assert `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up` are absent.
- In `shared/contracts.test.mjs`, assert their four `session_command` variants are rejected.
- In `runtime/worker.test.mjs`, assert no worker operation maps these commands to Pi.

Implementation:

- Remove command definitions and viewer handlers from `app/viewer/slash-commands.mjs` and `app/viewer/viewer-controller.mjs`.
- Remove four command variants from `shared/contracts.mjs`.
- Remove both payload projections from `runtime/daemon.mjs` and `runtime/worker-supervisor.mjs`.
- Remove worker dispatch and adapter methods from `runtime/worker.mjs` and `runtime/pi-rpc-adapter.mjs`.
- Keep `get_settings` and `set_settings` for opt-in summary configuration.

What could break: summary settings can be removed by an overly broad edit. The summary opt-in tests must stay unchanged and pass.

Stopping point: grep finds no production command names; summary settings tests still pass.

Rollback: revert this commit. No durable format changes.

## Change 3: delete dashboard thinking control

**Operator-visible change.** `/thinking` and its picker disappear. Pi may still report a thinking level for display, but the dashboard does not select or mutate it.

**Estimate:** 1 commit, 0.5 to 1 engineer-day, net deletion of 80 to 160 lines.

### Commit 3: `feat: remove dashboard thinking control`

Tests first:

- In `app/viewer/slash-commands.test.mjs`, assert `/thinking` is absent while `/model` remains.
- In `app/list/dashboard.test.mjs`, assert the launch draft and picker contain model but no thinking selection.
- In `shared/contracts.test.mjs`, reject launch `thinkingLevel` and `set_thinking_level`.
- In viewer tests, retain Pi-reported `thinking_state` rendering. This pins the distinction between control and observation.

Implementation:

- Remove the picker and command from `app/viewer/slash-commands.mjs`, `app/viewer/overlays.mjs`, and `app/viewer/viewer-controller.mjs`.
- Remove launch draft handling from `app/list/launch-composer.mjs` and `app/list/dashboard.mjs`.
- Remove requested thinking level from `shared/contracts.mjs`, `runtime/launch-resolver.mjs`, `runtime/worker-supervisor.mjs`, and startup arguments.
- Keep normalized Pi thinking events and optional observed `SessionRecord.thinkingLevel`.

What could break: model selection and Pi-reported thinking display share menu data. Tests must show `/model` still opens and observed thinking still renders.

Stopping point: no dashboard request can select thinking; `/model` and observed state tests pass.

Rollback: revert this commit. Existing optional record fields remain readable.

## Change 4: open a granted observer read-only

**Operator-visible failure removed.** A second terminal currently receives observer from the daemon and then shows `SESSION_IN_USE`. It will open the same session read-only.

**Estimate:** 1 commit, 0.5 engineer-day.

### Commit 4: `feat: open occupied sessions read-only`

Tests first:

- Replace `rejects an observer attachment` in `app/list/standalone-list.test.mjs` with `opens an observer attachment read-only`.
- Add a terminal acceptance case with one composer and two observers. Assert observers can scroll and inspect tools but cannot prompt, interrupt, answer UI, rename, recolor, or delete.
- Keep the existing viewer observer input matrix and extend it for every remaining mutation.

Implementation:

- Make `createDaemonViewerClient.attach` return either granted role in `app/list/standalone-list.mjs`.
- Pass the granted role through the opening path until the authoritative viewer snapshot arrives.
- Render `Read-only session` and writer occupancy without treating observer as an error.

What could break: a viewer may briefly enable its editor before the snapshot. Construction and first render must default to no mutation until composer is confirmed.

Stopping point: three complete clients can open one session, exactly one can mutate, and no `SESSION_IN_USE` appears for a valid observer grant.

Rollback: revert this commit. No protocol or durable changes.

## Change 5: give every live worker one daemon socket route

**Operator-visible failure removed.** Stop on a current-daemon launch can wait through the graceful timeout because its socket route is absent. Frames, replies, and reconnect behavior also differ before and after daemon restart.

**Estimate:** 3 commits, 2.5 to 4 engineer-days, net deletion of 250 to 450 lines after changes 1 through 3.

### Commit 5.1: `refactor: specify worker socket handoff`

Tests first:

- Add `keeps IPC until the daemon adopts the authenticated socket route` in `runtime/worker-supervisor.test.mjs`.
- Add `new workers retain IPC when an old daemon never requests handoff` in `runtime/worker.integration.test.mjs`.
- Add wrong run, lease, generation, token, and process identity cases in `runtime/reconciliation.failure.test.mjs`.

Implementation:

- Add internal version 1 `connect_socket`, `socket_ready`, `handoff_to_socket`, and `socket_handoff_complete` messages in `runtime/installed-pi-worker.mjs`, `runtime/worker-supervisor.mjs`, and `runtime/worker.mjs`.
- Keep route generation and exact identity authoritative in `runtime/reconciliation.mjs`.
- Keep IPC open if an older daemon never requests handoff.

What could break: a worker can wait between Pi bind and route adoption, or a duplicate route can ingest a frame twice.

Stopping point: temporary-root tests reach one authenticated route and retain IPC; the old-daemon fixture retains IPC.

Rollback: revert 5.1 before later transport commits.

### Commit 5.2: `refactor: move worker traffic to the socket`

Tests first:

- Invert the fresh-launch delivery test in `runtime/daemon.integration.test.mjs` so it requires the adopted socket.
- Add a remaining-operation matrix for prompt, follow-up message, steer, interrupt, UI response, model, compact, rename, menu, initial state, frames, and Stop.
- Add frames before, during, and after handoff. Assert stable source IDs occur once and in order.

Implementation:

- Send all ongoing frames, events, commands, and replies through the adopted socket.
- Make `askWorker`, command delivery, activation, and frame ingestion use `RecoveredWorkerRouter` after readiness.
- Remove ongoing payload projection and reply handling from the launch handle.

What could break: a frame can be lost or duplicated during handoff, or a reply can resolve on both transports.

Stopping point: every remaining operation passes before and after simulated daemon restart; IPC remains open pending final acknowledgement.

Rollback: revert 5.2 while keeping the additive 5.1 protocol.

### Commit 5.3: `refactor: make socket adoption the ready boundary`

Tests first:

- Require Pi bind plus socket adoption in `runtime/worker-supervisor.test.mjs`.
- Inject failure before Pi bind, after Pi bind, before route adoption, and after route adoption.
- Add `graceful Stop uses the current launch socket before escalation` in `test/destructive-actions.integration.test.mjs`.
- Add structural assertions that `sessionHandles` and launch delivery handles are absent after readiness.

Implementation:

- Register the bound identity, request socket connection, verify the exact route, persist readiness, complete handoff, then disconnect IPC.
- Route graceful shutdown through the exact locked socket and daemon stop policy.
- Delete `sessionHandles`, route-versus-handle branches, launch-channel pending replies, and duplicate frame buffering.

What could break: IPC disconnect may be mistaken for worker exit, or daemon crash during handoff may strand the worker.

Stopping point: all injected windows converge to one route or a terminal failed launch; Gate 1 passes.

Rollback: revert all change 5 commits and restart the daemon. Workers retain old-daemon IPC behavior for one release.

## Change 6: persist only Pi-confirmed model state

**Operator-visible failure removed.** A failed launch can display a requested model that Pi never ran. The row will remain unset until Pi confirms its model.

**Estimate:** 1 commit, 0.5 to 1 engineer-day.

### Commit 6: `fix: record only Pi-confirmed session model`

Tests first:

- In `runtime/launch-resolver.test.mjs`, assert requested model remains in worker arguments but not the prepared record.
- In `runtime/daemon.integration.test.mjs`, cover default selection, accepted request, Pi substitution, omitted model, failure before spawn, failure after spawn, and daemon restart.
- Add daemon admission cases for catalog-listed, known absent, unavailable catalog, and no requested model if decisions 1 through 3 are approved.

Implementation:

- Stop copying requested model into the prepared record.
- Carry normalized initial Pi state through the socket-ready exchange.
- Apply confirmed model in the same lifecycle write as readiness. Absence stays unknown.
- Keep Pi-reported thinking level as observed state only.

What could break: READY may be visible before the confirmed model, or a partial catalog may reject a valid provider.

Stopping point: one ready revision includes Pi-confirmed model; every failure window leaves it absent; Gate 2 passes.

Rollback: revert this commit. Schema version stays unchanged.

## Change 7: replace list replay with invalidation and snapshots

**Operator-visible failure removed.** A stale cursor can replay thousands of list records, overflow the client, and crash startup. The list will always start from current registry state.

**Estimate:** 4 commits across 2 releases, 1.5 to 2.5 engineer-days, net deletion of 350 to 600 lines.

### Commit 7.0: `feat: surface list protocol refusal`

Tests first:

- In `app/daemon-client.test.mjs`, assert a subscription request is tracked and a `CLIENT_RESTART_REQUIRED` response reaches the subscriber error path with the daemon's exact message.
- Add a bridge compatibility test in which the daemon still serves old replay to a pre-bridge client.
- Assert the bridge client stops retrying after refusal and renders the restart instruction once.

Implementation:

- Track the internal `subscribe` request ID and response in `app/daemon-client.mjs`.
- Propagate a refusal to `DashboardController` as a terminal subscription error.
- Keep the old event store and replay behavior in the bridge daemon. This commit must deploy before replay removal.

What could break: turning an internal subscription into a tracked request can leak pending entries across reconnect. Close and reconnect tests must return the pending count to zero.

Stopping point: a bridge frontend displays the exact instruction, while a pre-bridge frontend still works against the bridge daemon.

Rollback: revert 7.0. No durable change.

### Commit 7.1: `feat: add race-safe list invalidation`

Tests first:

- Add deterministic changes before subscribe, during snapshot, after response, and during reconnect in `app/list/dashboard.test.mjs`.
- Replace replay and acknowledgement assertions with final snapshot state.
- Send 10,000 invalidations and assert bounded pending work and at most three reads for one uninterrupted burst plus one change during a read.

Implementation:

- Add `subscribe_list_changes` and payload-free `list_changed` to `shared/contracts.mjs`.
- Subscribe, mark dirty, read `get_state`, and refetch once when a notification arrives during the read.
- Coalesce notifications while a read is active.
- On `UNKNOWN_OPERATION` from an old daemon, fall back to the tracked old subscription and treat detailed events as invalidations.

What could break: subscribe-after-read can miss a mutation, or dirty scheduling can loop.

Stopping point: all race windows converge and burst work stays bounded.

Rollback: revert 7.1. The daemon still supports old events.

### Commit 7.2: `refactor: publish list invalidations only`

Tests first:

- Assert each session mutation and completed Delete emits `list_changed` after durable state changes.
- Add a compatibility test in which tracked old `subscribe` receives `CLIENT_RESTART_REQUIRED` with the exact restart instruction.
- Assert the bridge frontend surfaces that error and stops retrying. The pre-bridge client case was covered by commit 7.0 and the bridge release.
- Assert new roots do not create `index/events.jsonl` or `daemon/event-acks.json`.

Implementation:

- Replace list event publication with an in-memory invalidation broadcaster in `runtime/daemon.mjs` and `runtime/reconciliation.mjs`.
- Reject old `subscribe` explicitly. Do not replay retired events.
- Keep new frontend fallback only for a new frontend connected to an old daemon.

What could break: notification may precede the registry write, or an old client may retry forever.

Stopping point: write, notification, and snapshot order is deterministic; an old frontend displays the instruction once and exits its subscription loop.

Rollback: restart the old daemon and use an authoritative registry snapshot. List correctness does not require events produced during the new interval.

### Commit 7.3: `refactor: remove list cursor persistence`

Tests first:

- Replace cursor-save tests with view-state and draft tests that omit a cursor.
- Load legacy state with a cursor and discard it.
- Remove `runtime/event-store.test.mjs` only after all production callers are gone.

Implementation:

- Remove list cursor saves, acknowledgements, replay queues, resynchronization markers, and cursor comparison.
- Delete `runtime/event-store.mjs`.
- Accept and ignore a legacy cursor in `app/list/frontend-state.mjs`.
- Ignore obsolete event files in migration and recovery.

What could break: first start after upgrade can reject an existing frontend state file.

Stopping point: new state omits cursor, legacy state loads, and no list event store is opened.

Rollback: revert all change 7 commits and restart the daemon. Leave obsolete files in place.

## Change 8: make client state and access connection-scoped

**Operator-visible failure removed.** Several dashboards currently overwrite one shared `frontend-state.json`, observers are not told when the writer leaves, and attachment durability can block startup for state that died with its socket.

**Estimate:** 2 commits, 1.5 to 2 engineer-days, net deletion of 200 to 400 lines.

### Commit 8.1: `feat: notify viewers when session access changes`

Tests first:

- Add a three-dashboard acceptance matrix: one writer, two observers, writer killed, two observers race to claim, exactly one wins.
- Add writer close during grant, repeated claim on one socket, reconnect of all clients, and client disappearance mid-command.
- Assert the accepted command completes or becomes `DELIVERY_UNKNOWN`; socket loss never cancels it.
- Assert observers receive `writerPresent: false`, remain observers, and mutate only after explicit successful acquisition.

Implementation:

- Add connection-scoped `session_access_changed` notifications with role, `writerPresent`, and access generation.
- Keep grant and release under the per-session lock.
- On socket close, release the claim and notify attached viewers.
- Add an explicit viewer action to acquire composer when vacant. Do not auto-promote.

What could break: two sockets can receive composer, a closed socket can leave a claim, or a notification can expose another client ID.

Stopping point: the repeated race matrix always has one writer; role notifications contain no stable peer identity.

Rollback: revert 8.1 before deleting attachment durability.

### Commit 8.2: `refactor: remove durable attachments and isolate frontend state`

Tests first:

- Replace durable attachment ordering tests with per-session lock tests.
- Start with a corrupt obsolete `daemon/attachment-results.jsonl` and assert startup ignores it.
- Open three dashboards, change each draft and selection, close them in different orders, and assert no dashboard overwrites another live dashboard's state.
- Assert a daemon restart clears all claims while workers retain exact identity.

Implementation:

- Remove `AttachmentResultStore`, attach and detach journal transitions, attachment list events, failpoints, and recovery.
- Delete `runtime/attachment-result-store.mjs` and ignore its old file.
- Generate a process-scoped frontend connection ID at dashboard startup. Retire shared frontend persistence and keep view state and launch drafts in that process. Losing an unsubmitted draft on process death is the explicit cost of removing ambiguous cross-window ownership.
- Keep the stable installation identity only where durable command recovery requires it.

What could break: historical attachment journal entries can reappear as claims, and an unsubmitted draft no longer survives process death. The concurrency rule takes priority because there is no stable window identity that can own the shared draft.

Stopping point: no attachment artifact is created or reconciled; three live dashboards have independent state; Gate 3 passes.

Rollback: restore change 8 and restart the daemon. Old files remain but must not be treated as current claims.

## Change 9: remove durable viewer acknowledgements

**Operator-visible failure removed.** A corrupt `.acks.json` can block recovery although acknowledgements do not control retention.

**Estimate:** 2 commits, 0.5 to 1 engineer-day, net deletion of 100 to 180 lines.

### Commit 9.1: `refactor: keep viewer resume state in the frontend`

Tests first:

- Disconnect before processing, after processing, and after local cursor advancement in `app/viewer/viewer-controller.test.mjs`.
- Assert a repeated stable event ID does not duplicate transcript content.

Implementation:

- Remove frontend `ack_viewer` calls.
- Advance the in-memory viewer cursor only after successful event application.
- Keep ordered events, snapshots, bounded queues, and stable IDs.

What could break: reconnect between render and cursor advancement can replay an item.

Stopping point: no item is skipped or duplicated in all three windows.

Rollback: revert 9.1.

### Commit 9.2: `refactor: retire viewer acknowledgement files`

Tests first:

- Assert corrupt event, checkpoint, or snapshot state still fails, while corrupt `.acks.json` is ignored.
- Assert an old frontend's `ack_viewer` receives a no-op compatibility response and writes nothing.

Implementation:

- Remove acknowledgement loading and methods from `runtime/viewer-store.mjs`.
- Keep `ack_viewer` as a no-op for one compatibility release.
- Stop creating acknowledgement paths and ignore old files.

What could break: removing the wrong cursor could skip viewer events. Event cursors and replay ordering are out of scope.

Stopping point: no `.acks.json` changes and Gate 4 transcript checks pass.

Rollback: revert change 9. Old files remain and have no retention effect.

## Change 10: remove the unused trash transaction

**Operator-visible failure removed.** Unused transaction code can fail startup even though production Delete only forgets a row.

**Estimate:** 2 commits, 0.5 to 1.5 engineer-days, net deletion of 200 to 400 lines.

### Commit 10.1: `refactor: make Delete forget-only`

Tests first:

- Cover inactive, live, attached, stale metadata, changed revision, and concurrent relaunch in `test/destructive-actions.integration.test.mjs`.
- Assert every success preserves the canonical Pi file and worktree.

Implementation:

- Remove `trashSessionFile` and reduce Delete to revision, inactive state, attachment, ownership, launch, metadata, and route checks before registry removal.
- Keep exact process identity checks and per-session locking.

What could break: simplification can weaken a live-session guard. Any filesystem call using the canonical session path is a failure.

Stopping point: successful Delete changes only registry and journal artifacts.

Rollback: revert 10.1 before 10.2.

### Commit 10.2: `refactor: retire trash recovery`

Tests first:

- Start with absent, empty, and nonempty old delete-result files. The first two start. The third fails with `UNSUPPORTED_LEGACY_DELETE_TRANSACTION` before mutation.

Implementation:

- Remove delete-result store, transaction phases, destructive failpoints, file fingerprints, and reconciliation.
- Keep the old file in place and add the explicit nonempty guard.

What could break: an unresolved historical transaction can be ignored. Startup with a nonempty store is a test failure.

Stopping point: Gate 0 found no production entry; temporary-root migration tests and Gate 4 Delete checks pass.

Rollback: revert change 10. The retained old file and unchanged journal permit rollback.

## Withdrawn change: replay narrowing

Do not implement the old changes 7.1 and 7.2. Deleting `session_query` removes three proposed read subtypes. Initial state and menu discovery have no documented failure. A direct-read dispatcher would add a second worker path immediately after change 5 removes one. Reconsider only with a measured replay cost or a concrete recovery failure.

## Risk gates on the operator machine

Tests use a temporary state root. These gates never write state files directly, signal workers, or run a second daemon against production.

### Gate 0: read-only preflight

Record the installed commit and daemon version; daemon PID, start identity, epoch, and recovery state; both live session IDs; worker and Pi identities; route generations; old durable file sizes; and whether `delete-results.json` has entries. Read one list and viewer snapshot through the public client.

Stop if identity is ambiguous, recovery is not `READY`, a trash transaction is nonempty, or a live session lacks exact worker and Pi identity.

### Gate 1: worker handoff

During the bridge release, restart only the daemon through the normal command and leave all terminal clients open. Pre-bridge frontends must continue on bounded old replay without a crash loop. A bridge frontend must surface `CLIENT_RESTART_REQUIRED` exactly when tested against a rehearsal daemon that refuses old `subscribe`.

During the replay-removal release, verify the frontends used for the gate have crossed the bridge. Restart the daemon normally. Any remaining bridge frontend must display `Dashboard protocol changed. Exit and restart pi-agents.` and stop retrying. No synchronized close-before-restart step is required.

Verify both workers retain PID, start identity, process group, run ID, lease generation, and one route. Launch one disposable session and verify IPC closes only after socket adoption. Run every remaining operation and graceful Stop only on disposable work.

Stop on worker identity change, zero or two routes, duplicate delivery, lost frame, or escalation after successful graceful shutdown.

### Gate 2: confirmed model

Launch disposable default, valid named, substituted, and invalid model cases. Verify no row shows a model before Pi reports it, refusal leaves no launch artifacts, catalog failure lets Pi decide, and daemon restart retains workers and confirmed values.

### Gate 3: three dashboards and list convergence

Open three new dashboards. Verify independent drafts and selections, final rows matching `get_state`, 100 or more state changes converging without queue growth, one writer and two observers on one session, read-only observer behavior, writer terminal kill releasing the claim, notification to both observers, and exactly one winner when both claim.

Restart the daemon. Verify claims clear, workers retain identity, and obsolete list and attachment files do not grow or block startup.

### Gate 4: final compatibility and rollback

With both original workers live, force frontend reconnect during viewer events and verify no missing or duplicate transcript item. Verify no viewer acknowledgement file changes. Delete one disposable inactive session and verify its Pi file and worktree remain. Roll back to the previous release and verify it can read all retained durable state.

Stop on transcript loss, path deletion, worker loss, or rollback failure.

## Compatibility and rollback rules

| Change | Boundary | Mixed-version behavior | Operator action | Rollback |
|---|---|---|---|---|
| 1 to 3 | Frontend, daemon, worker requests | Old clients may send removed operations and receive `FEATURE_REMOVED`; new clients do not advertise them | Restart a stale frontend when it shows a removed command | Revert; no migration |
| 4 and 8 | Connection roles | Old frontend still rejects observer; new frontend opens it. Claims die with sockets | None for worker lifetime | Restart daemon to clear claims |
| 5 | Worker IPC and socket | New worker retains IPC with old daemon. Existing workers reconnect by socket | Restart daemon at Gate 1, never workers | Restart old daemon |
| 6 | Session field meaning | Schema remains version 1 and fields remain optional | Use disposable launches | Safe; new values have stronger provenance |
| 7 | List protocol | Bridge release tracks refusal while retaining old replay. Following release uses `subscribe_list_changes` and refuses tracked old `subscribe` | Restart after the instruction appears; no close-before-daemon-restart sequence | Restart old daemon and read registry snapshot |
| 9 | Viewer acknowledgement | New daemon answers old acknowledgement as a no-op for one release | None | Safe; old files remain |
| 10 | Delete result file | Empty old store is accepted; nonempty store blocks startup | Resolve with old release before rollout | Safe; file remains |

No change deletes an obsolete durable file automatically. This preserves rollback and avoids an implicit migration.

## Explicit file collisions

| Files | Changes | Merge rule |
|---|---|---|
| `runtime/daemon.mjs`, `runtime/daemon.integration.test.mjs` | 1, 2, 5, 6, 7, 8, 9, 10 | Serial merges only. Rebase after each change. |
| `shared/contracts.mjs`, `shared/contracts.test.mjs` | 1, 2, 3, 7, 8, 9 | Merge feature deletions first, then list, access, acknowledgements. |
| `app/viewer/viewer-controller.mjs` and test | 1, 2, 3, 4, 8, 9 | Serial. Keep observer mutation matrix current after each deletion. |
| `app/viewer/slash-commands.mjs` and test | 1, 2, 3 | Merge in listed order or combine conflict resolution without combining commits. |
| `app/list/standalone-list.mjs` and test | 1, 4, 7, 8 | Queries, observer opening, list protocol, then identities. |
| `app/daemon-client.mjs` and test | 7, 8, 9 | List protocol first, then access, then acknowledgements. |
| `runtime/worker.mjs` and tests | 1, 2, 3, 5 | Feature deletions before transport. |
| `runtime/worker-supervisor.mjs` and tests | 2, 3, 5, 6 | Feature deletions, handoff, confirmed model. |
| `runtime/state-migration.mjs` and test | 7, 8, 9, 10 | One compatibility pass after each retired artifact. |
| `docs/architecture.md`, `docs/development.md` | all | Update serially after production commits. |

## What this plan does not do

- It does not remove the daemon, workers, leases, process identity checks, process-group checks, or signaling revalidation.
- It does not remove worktree isolation, locks, sweeps, or cleanup.
- It does not make summaries default-on or call a summary provider in tests.
- It does not replace ordered viewer events with list invalidation.
- It does not add a heartbeat for local client sockets or auto-promote observers.
- It does not cancel accepted commands when a client disconnects.
- It does not compact, rewrite, or delete historical state files.
- It does not remove state migration, fold launch results into the journal, or change journal schema.
- It does not add a second worker dispatcher for reads.
- It does not claim the unmeasured 3 ms list snapshot latency. Measure it at Gate 3 before making a performance claim.
