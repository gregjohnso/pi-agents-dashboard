# Architecture implementation plan

Implement the seven changes as 17 green commits, with five operator-machine gates. The required order is worker transport, confirmed launch configuration, list invalidation with ephemeral attachments, viewer acknowledgements, trash removal, then replay narrowing. Trash removal can proceed in parallel after the first baseline gate. Viewer acknowledgement work can proceed after the list protocol is fixed.

The target remains one frontend, one daemon, and one worker per live Pi session. This plan does not remove process identity checks, ownership leases, the command journal, ordered viewer events, or per-session serialization.

Estimated implementation size: 8 to 14 engineer-days. This is an estimate, not measured work. The range includes tests, compatibility paths, five operator-machine gates, and documentation updates. It excludes review time and any wait for an operator maintenance window.

One conclusion from the review changes here. `export_html` is not read-only in the operational sense because it writes a caller-selected file ([runtime/worker.mjs:115](../runtime/worker.mjs#L115)). It must stay on the durable replay path. The final change narrows replay only for `get_state`, `get_session_commands`, `get_session_stats`, and `get_tree`.

## Decisions required before implementation

Approve or change each recommendation before the first commit. These choices define process contracts and failure artifacts.

1. **Where should launch admission validate a selected model?** Recommendation: validate in the daemon immediately after journal acceptance and before launch resolution. The frontend picker remains an early usability check, not an authority. Daemon validation covers CLI clients, stale frontends, and direct protocol clients. The cost is one catalog read on launches that name a model. The catalog already caches its result ([runtime/pi-model-catalog.mjs:25](../runtime/pi-model-catalog.mjs#L25)).
2. **What should a refused launch leave behind?** Recommendation: leave a terminal `FAILED` command-journal result and no session record, Pi session file, worktree, worker, or list row. This applies to known admission failures such as an installed Pi catalog that does not contain the selected model. A failure after launch preparation still leaves the current failed session row because its identity and cleanup evidence already exist ([runtime/daemon.mjs:1138](../runtime/daemon.mjs#L1138)). The tradeoff is two visible failure forms, divided at the first side effect.
3. **Should launch proceed when the model catalog is unavailable?** Recommendation: yes. Record the catalog failure for diagnostics, then let Pi accept or refuse the requested model. This preserves local providers and installations whose catalog command is temporarily unavailable. The tradeoff is that a bad model can fail after creating a session record and worktree. `MODEL_CATALOG_FAILED` must not be treated as `MODEL_UNKNOWN`.
4. **May the unused trash seam be removed?** Recommendation: yes. Production Delete already forgets only the dashboard record ([runtime/daemon.mjs:1338](../runtime/daemon.mjs#L1338)). Removing the seam closes an unshipped extension point. A future command that deletes Pi files would need separate wording, authorization, and crash recovery.
5. **What is the list protocol compatibility rule?** Recommendation: add `list_changed` to version 1 as an additive notification and make the new frontend accept both old detailed events and the new notification. Any old event becomes an invalidation. The new daemon does not support old cursor replay after its restart. Operators must close an old frontend before restarting into the new daemon. This permits new code on disk to connect to an old daemon while live workers continue.
6. **When may startup ignore retired durable files?** Recommendation: ignore valid obsolete list, attachment, and viewer acknowledgement files in place. Do not delete them during rollout. A corrupt retired file must not block startup. The cost is stale disk usage until a later explicit cleanup command.
7. **How should legacy trash transactions be handled?** Recommendation: an empty old `delete-results.json` is ignored. Any nonempty entry stops startup with `UNSUPPORTED_LEGACY_DELETE_TRANSACTION`. Do not infer whether an extension callback completed. The operator can run the old release to resolve it or reject the trash-removal change. Production should have no such entry because it has no trash callback, but that is unverified until the preflight gate.
8. **When should inter-process communication close during worker startup?** Recommendation: after Pi identity is bound, the supervisor returns a bound but not dashboard-ready handle. The daemon registers that identity with the router, sends authenticated `connect_socket` over inter-process communication (IPC), and waits for route adoption. It then persists readiness, sends `handoff_to_socket`, and waits for acknowledgement over the socket before disconnecting IPC. Without those messages, the worker retains IPC. This keeps a new worker compatible with an older daemon still in memory.

## Every commit follows the same test rule

Write the named test first and run it to observe the intended failure. Add the implementation in the same commit, then run focused tests, the full 788-test suite, and `pixi run typecheck`. Commit only after all checks pass. A tests-only red commit is not permitted because every listed commit must leave the branch green.

Test counts below are targets, not promises. Prefer one table-driven test over several tests when it pins the same operator-visible failure.

## Sequence and parallel work

### Required serial path

1. Establish the baseline and operator preflight gate.
2. Land changes 1.1 through 1.4 for one worker transport.
3. Pass the worker handoff gate on the operator machine.
4. Land changes 4.1 and 4.2 for confirmed launch configuration. These use the new socket-ready boundary.
5. Decide the list protocol once, then land 2.1 through 2.3 and 3.1 through 3.2. List invalidation lands before durable attachment deletion because current attachment recovery publishes list events.
6. Pass the list and attachment gate.
7. Land change 5, then change 7.
8. Pass the final restart gate.

### Work that can run concurrently

- Change 6, trash removal, can run beside changes 1 through 5 after the baseline gate. It has no worker or list protocol dependency.
- Change 5, viewer acknowledgements, can be prepared beside changes 2 and 3 after `list_changed` has been specified. It shares daemon request parsing and `app/daemon-client.mjs`, so it must use a separate worktree and merge after list changes.
- Test fixture design for changes 2 and 3 can proceed together. Their production commits remain serial.
- Documentation updates for a completed change can proceed in parallel only in a separate worktree. `docs/architecture.md` is otherwise a collision point.

### Protocol decisions made once

- Worker `ready`, socket adoption, and IPC handoff are one protocol decision shared by changes 1 and 4.
- `list_changed`, old-event fallback, and the absence of list acknowledgements are one protocol decision shared by changes 2 and 3.
- Frontend cursor ownership is separate for the list and viewer. Removing list cursors does not authorize removing viewer cursors.
- `session_query` needs an explicit operation classification shared by changes 1 and 7. `get_session_stats` and `get_tree` are read-only. `export_html` has a filesystem side effect and remains durable.

### Files that collide in one checkout

| File | Changes that touch it | Merge rule |
|---|---|---|
| `runtime/daemon.mjs` | 1, 2, 3, 4, 5, 6 | Serial merges only. Rebase each worker after the prior change. |
| `runtime/daemon.integration.test.mjs` | 1, 2, 3, 4, 5 | Serial merges only. Split new helpers into focused fixtures if conflicts become repetitive. |
| `shared/contracts.mjs` and `shared/contracts.test.mjs` | 2, 5 | Decide notification and acknowledgement compatibility first. Merge 2 before 5. |
| `app/daemon-client.mjs` and `app/daemon-client.test.mjs` | 2, 5 | Merge 2 before 5. Do not assign both to concurrent workers in one checkout. |
| `runtime/reconciliation.mjs` | 1, 2, 3 | Merge 1, then 2, then 3. |
| `runtime/state-migration.mjs` and its test | 2, 3, 5, 6, 7 | One final compatibility pass after each durable artifact retires. |
| `runtime/worker.mjs` and its tests | 1, 7 | Change 1 first. |
| `runtime/installed-pi-worker.mjs` and its integration tests | 1, 4 | Change 1 first, then add confirmed state to the established handshake. |
| `docs/architecture.md` and `docs/development.md` | all changes | Update once per completed change or in one final serial documentation commit. |

## Risk gates on the operator machine

Tests use a temporary state root. These gates are the only steps that inspect behavior on the operator's real machine. They must not write directly to state files, signal workers, or run a second daemon against the production root.

### Gate 0: read-only preflight before implementation

Record, without mutation:

- the installed commit and daemon version;
- daemon PID, start identity, epoch, and published state;
- the two live session IDs, worker and Pi child identities, and route generations;
- whether `daemon/delete-results.json` exists and whether it has any entries;
- sizes of `index/events.jsonl`, `daemon/event-acks.json`, `daemon/attachment-results.jsonl`, and viewer `.acks.json` files;
- one successful list snapshot and one successful viewer snapshot through the existing public client.

Stop if process identities are ambiguous, daemon recovery is not `READY`, a trash transaction is nonempty, or either live session lacks exact worker and Pi child identity. Do not begin implementation against an unexplained production state.

### Gate 1: worker transport handoff after change 1

Use an approved daemon restart window. Close the frontend, restart only the daemon through the normal operator command, and do not signal either worker. Verify:

- both existing workers reconnect and retain the same worker PID, Pi child PID, start identity, process group, run ID, and lease generation;
- each session has exactly one authenticated socket route;
- a newly launched disposable session closes IPC only after socket adoption;
- `/stats`, `/tree`, `/export`, `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up` each return without a reconnect;
- Stop on the disposable session returns before the configured graceful window and does not escalate when graceful shutdown succeeds;
- each test command reaches Pi once, using fake or disposable work only, never either valuable live session.

Stop and roll back if either existing Pi child exits, an identity changes, a session gains zero or two routes, any command is duplicated, or daemon restart cannot re-adopt both workers. Keep the old daemon binary available until this gate passes.

### Gate 2: confirmed launch configuration after change 4

Launch disposable sessions for a default model, a catalog-listed model, and a deliberately invalid model. Verify that:

- no row shows a model before Pi reports it;
- each ready row shows Pi's returned model and thinking level;
- a known invalid model is refused before a session file or worktree appears;
- a simulated catalog failure still lets Pi decide the launch;
- daemon restart preserves both live sessions and the confirmed values.

Stop if a requested value appears as confirmed, a refusal leaves launch artifacts, or either original live session changes process identity.

### Gate 3: list and attachment behavior after changes 2 and 3

Close the old frontend before restarting the daemon. Open two new frontends and verify:

- initial rows match `get_state`;
- 100 or more disposable state changes converge to the final snapshot without a growing client queue;
- one frontend gets composer and the other observer;
- closing the composer socket releases the role, and the observer can acquire it;
- daemon restart drops both old attachment claims and re-adopts both live workers;
- no new bytes appear in `index/events.jsonl`, `daemon/event-acks.json`, or `daemon/attachment-results.jsonl`;
- the existing obsolete files, including a deliberately copied corrupt obsolete file in a temporary-root rehearsal, do not block startup.

Stop if a row remains stale after the final invalidation, both frontends become composer, a reconnect restores a stale claim, any retired store grows, or either live worker is lost.

### Gate 4: final compatibility and rollback gate

After changes 5 through 7, restart the daemon once with both original workers attached. Verify:

- both workers retain exact identities and routes;
- a viewer opened before a forced frontend reconnect resumes with no missing or duplicated transcript item;
- no viewer `.acks.json` file is created or changed;
- Delete of a disposable inactive session removes only its registry record and leaves its canonical Pi file and worktree;
- read-only queries create no worker replay records, while prompt, settings changes, and `export_html` still do;
- rollback to the previous release can read all remaining durable state.

Stop if transcript content is skipped or duplicated, Delete removes an owned path, a mutating operation bypasses replay, restart loses a worker, or the prior release cannot reopen the root.

## Change 1: give every live worker one daemon socket route

**Operator-visible change.** Today, a newly launched session can fail `/stats`, `/tree`, and `/export`; settings commands can lose `enabled` or `mode`; Stop can wait through the graceful timeout before escalation. Afterwards, the same operations use the authenticated control socket before and after daemon restart. Stop sends graceful shutdown immediately through that route.

**Estimate:** 4 commits, 3 to 5 engineer-days, and a net reduction of 350 to 600 production and test lines.

### Commit 1.1: specify the additive handoff protocol

Tests first:

- Add a contract matrix in `runtime/worker-supervisor.test.mjs` named `keeps IPC until the daemon adopts the authenticated socket route`. It pins a launch that appears ready but has no usable query or Stop route.
- Add `new workers retain IPC when an old daemon never requests handoff` in `runtime/worker.integration.test.mjs`. It pins upgrade code on disk breaking an older daemon in memory.
- Add connector authentication and duplicate-route cases in `runtime/reconciliation.failure.test.mjs`. They pin a worker being adopted under the wrong run, lease, generation, token, or process identity.

Implementation:

- Extend worker startup messages in `runtime/installed-pi-worker.mjs:58-188`, `runtime/worker-supervisor.mjs:480-542`, and the connector in `runtime/worker.mjs`.
- Add authenticated `connect_socket`, `socket_ready`, `handoff_to_socket`, and `socket_handoff_complete` shapes. Keep these internal worker protocol version 1 additions. Reject unknown identity or generation.
- In `RecoveredWorkerRouter.adopt` and `runSession` in `runtime/reconciliation.mjs:140-218`, make route generation and exact identity the authority. A duplicate connection for the same generation replaces nothing until the current connection is proved closed.
- Keep IPC open if the daemon never sends `handoff_to_socket`.

What could break and evidence:

- A worker can wait forever between Pi bind and route adoption. Evidence is a launch stuck in `STARTING` with exact live identities and no route.
- An older daemon can lose a new worker if IPC closes without handoff. Evidence is `WORKER_UNAVAILABLE` before daemon restart.
- A duplicate route can ingest a frame twice. Evidence is two viewer events with one stable source ID or two command replies for one request ID.

Stopping point: focused protocol tests pass; a temporary-root launch can register its bound identity, adopt one socket route, and retain open IPC; an old-daemon fixture retains IPC without attempting a startup socket.

Undo: revert the commit. It is fully reversible before later commits because the old launch channel remains intact.

### Commit 1.2: move frames, events, asks, and replies to the socket

Tests first:

- Replace `reaches a freshly launched worker over its launch channel before any socket reconnect` in `runtime/daemon.integration.test.mjs:491` with `reaches a freshly launched worker over its adopted socket before IPC handoff`. This existing test must be inverted because launch-channel delivery becomes wrong.
- Extend `serves read-only session queries and session toggles from the owning worker` at [runtime/daemon.integration.test.mjs:549](../runtime/daemon.integration.test.mjs#L549) to launch through the real supervisor before any daemon restart. It pins `/stats`, `/tree`, `/export`, and settings failures.
- Add one table covering prompt, follow-up, steer, interrupt, user-interface response, menu, all settings commands, and all queries. Assert one delivery and complete fields.
- Add a frame-order test that sends frames before, during, and after handoff. It pins missing or duplicated transcript output.

Implementation:

- Change `runInstalledPiWorker` in `runtime/installed-pi-worker.mjs:116-185` so it retains startup frames until `connect_socket`, then sends all ongoing frames, events, commands, and replies through the adopted socket.
- Change `askWorker`, `sendWorkerCommand`, `activateWorker`, and frame ingestion in `runtime/daemon.mjs:632-812` to use `RecoveredWorkerRouter` only after readiness.
- Remove the launch-handle payload projection in `WorkerSupervisor.#createHandle` at [runtime/worker-supervisor.mjs:603](../runtime/worker-supervisor.mjs#L603). Keep only startup identity and handoff controls on the handle.
- Use `sessionCommandPayload` in `runtime/daemon.mjs` as the single settings projection, including `enabled` and `mode`.

What could break and evidence:

- Frames can be lost at handoff. The source-ID sequence has a gap and the final viewer snapshot differs from fake Pi history.
- A settings payload can still diverge. The worker returns `INVALID_SESSION_COMMAND` for a contract-valid command.
- A reply can resolve on both transports. The reply tracker sees an unknown duplicate ID.

Stopping point: every worker operation passes before and after a simulated daemon restart; frame order is identical across handoff; IPC remains open.

Undo: revert 1.2 while retaining 1.1 compatibility. Fully reversible before 1.3.

### Commit 1.3: make socket adoption part of readiness and close IPC

Tests first:

- Change `creates and binds the registry before activation and reports ready after authenticated hello` at [runtime/worker-supervisor.test.mjs:239](../runtime/worker-supervisor.test.mjs#L239) so readiness requires Pi bind plus socket adoption. The old readiness assertion must be inverted.
- Add failure injection before Pi bind, after Pi bind, before route adoption, and after route adoption in `runtime/worker-supervisor.test.mjs` and `runtime/daemon.integration.test.mjs`.
- Add `graceful Stop uses the current launch socket before escalation` in `test/destructive-actions.integration.test.mjs`. It pins the full graceful wait the operator sees today.
- Extend `reconnects two surviving fake workers through the concrete connector after daemon restart` at [runtime/daemon.integration.test.mjs:1067](../runtime/daemon.integration.test.mjs#L1067) to cover a daemon crash during handoff.

Implementation:

- Change `WorkerSupervisor.#launch` at [runtime/worker-supervisor.mjs:521](../runtime/worker-supervisor.mjs#L521) to return a bound handle after authenticated worker readiness and initial Pi state, but before writing the dashboard `WORKER_READY` event.
- Change `createDaemonRuntime.activateWorker` at [runtime/daemon.mjs:698](../runtime/daemon.mjs#L698) to call `router.register(handle)`, send `connect_socket` through the handle, wait for `router.route(sessionId)` with the exact run, lease, generation, and identities, then call a new `handle.markReady(initialState)` under the session lifecycle lock.
- Have `createDaemonRuntime` send `handoff_to_socket` only after the ready record and exact route both exist.
- On `socket_handoff_complete`, call the child-process disconnect method and remove launch-channel listeners and pending reply state.
- Route graceful shutdown through `lockedRoute.connection` in `runtime/daemon.mjs:1231-1243` and use the daemon's configured stop window.

What could break and evidence:

- Closing IPC can trigger terminal reconciliation even while the worker lives. Evidence is a `FAILED` or `EXITED` row with exact live worker and Pi identities.
- A daemon crash can strand a worker that has neither usable IPC nor reconnect. Evidence is a live worker absent from `workers.json` and router state after restart.

Stopping point: the four injected handoff windows each converge to one route or a terminal failed launch; graceful Stop completes before escalation in the success case; full suite passes.

Undo: revert 1.3 and restore IPC as ongoing transport. Once deployed, rollback is safe because workers retain the reconnect code and an old daemon accepts their socket route after restart.

### Commit 1.4: delete the dual route

Tests first:

- Add structural assertions in `runtime/daemon.integration.test.mjs` that one launched session has one router entry and no launch delivery handle.
- Remove dual-path unit cases from `runtime/worker-supervisor.test.mjs` only after their socket equivalents pass.

Implementation:

- Remove `sessionHandles` and route-versus-handle branches from `runtime/daemon.mjs:631-699` and `runtime/daemon.mjs:1190-1207`.
- Remove command delivery, pending replies, frame buffering, and ongoing event listeners from `WorkerSupervisor.#createHandle` in `runtime/worker-supervisor.mjs:603-690`.
- Keep startup authentication, process binding, ownership release, and terminal reconciliation.
- Update `docs/architecture.md` and `docs/development.md` to state the handoff and compatibility rule.

What could break and evidence: a hidden caller still requests `handle.deliver`, `handle.request`, or `handle.onFrame`. Typecheck, focused grep, or a failing test names the caller.

Stopping point: no production reference to `sessionHandles`, launch-channel delivery, or launch-channel frame listeners remains; Gate 1 passes.

Undo: revert all change 1 commits together. After shipment, rollback requires a daemon restart but does not require stopping workers. New workers keep the old-daemon fallback until at least one release after this change.

## Change 2: replace list replay with coalesced invalidation and snapshots

**Operator-visible change.** Today, stale or missing list cursors can replay thousands of records, overflow queues, crash startup, or retain a stale row. Afterwards, opening or reconnecting always reads current state. Any change requests another snapshot, and bursts coalesce.

**Estimate:** 3 commits, 2 to 3 engineer-days, and a net reduction of 350 to 600 lines.

### Commit 2.1: add `list_changed` and make the frontend snapshot loop race-safe

Tests first:

- Add deterministic cases to `app/list/dashboard.test.mjs` for mutation before subscribe, during the first snapshot, after the response, and during reconnect. Each pins a stale or missing row.
- Replace `processes replay once, acknowledges only successful events, and resumes from the acknowledged cursor` at [app/list/dashboard.test.mjs:1160](../app/list/dashboard.test.mjs#L1160) with `coalesces invalidations and refetches after a change during the read`. The replay assertion must be inverted.
- Replace `serializes concurrent events through distinct rendered states and acknowledgements` at [app/list/dashboard.test.mjs:591](../app/list/dashboard.test.mjs#L591) with a final-state assertion. Intermediate rendered states are no longer required.
- Keep `starts and lists its sessions with a persisted cursor thousands of events behind` at [test/dashboard-resync.acceptance.test.mjs:156](../test/dashboard-resync.acceptance.test.mjs#L156), but invert its fixture. The old cursor must be ignored and no historical events should be generated.

Implementation:

- Add payload-free `list_changed` parsing in `shared/contracts.mjs:425-432` and contract tests.
- In `createDaemonDashboardBackend` at [app/list/dashboard.mjs:43](../app/list/dashboard.mjs#L43), subscribe first, mark dirty, read `get_state`, and refetch if an invalidation arrives during the read. Coalesce while one read is active.
- In `DashboardController.open`, `trackEvent`, and `processEvent` at [app/list/dashboard.mjs:400](../app/list/dashboard.mjs#L400), apply complete snapshots and render only the latest completed read.
- In `createDaemonClient` at [app/daemon-client.mjs:108](../app/daemon-client.mjs#L108), accept old `session_changed`, `command_changed`, and `attachment_changed` events as invalidations when connected to an older daemon. Do not acknowledge them.

What could break and evidence:

- Subscribe-after-read can miss a mutation. The deterministic test ends with a registry row absent from the list.
- Refetch scheduling can loop. Snapshot count continues increasing after mutation stops.
- Slow reads can grow work with burst size. A 10,000-notification test performs more than three reads for one uninterrupted burst plus one change during a read.

Stopping point: all four race windows converge; a 10,000-notification burst has a bounded notification slot and final rows equal the registry.

Undo: revert 2.1. Fully reversible because the daemon still has the old event store.

### Commit 2.2: publish invalidations instead of durable list events

Tests first:

- Add daemon tests that every session mutation and completed Delete emits `list_changed` after the durable registry or journal change.
- Change `publishes failed recovery status` at [runtime/daemon.integration.test.mjs:839](../runtime/daemon.integration.test.mjs#L839) and repaired-session assertions to expect one invalidation, not replayable session events.
- Add a temporary-root acceptance test asserting no `index/events.jsonl` or `daemon/event-acks.json` is created.

Implementation:

- Replace `publishSession` and completed-Delete publication in `runtime/daemon.mjs:662-667` with a coalescing in-memory invalidation broadcaster.
- Remove list `createEventStore` use from `runtime/reconciliation.mjs:408-460`. Reconciliation returns repaired sessions and broadcasts one invalidation after durable repair.
- Remove `subscribe` cursor and `ack` handling from `runtime/daemon.mjs:1073-1081`; keep the additive old-daemon fallback only in the new client.
- Update request and response contracts in `shared/contracts.mjs`. Do not alter viewer contracts.

What could break and evidence:

- A mutation can commit without notification. The registry revision advances while a connected list remains unchanged after its next idle turn.
- Notification can precede durable state. The frontend refetches and sees the old revision with no later invalidation.

Stopping point: each mutation orders durable write, notification, snapshot; no new list event or acknowledgement file appears; full suite passes.

Undo: revert 2.2 and restart the daemon. Existing old files remain available. Do not roll back only the frontend because an old frontend cannot consume `list_changed`.

### Commit 2.3: remove list cursor persistence and replay code

Tests first:

- Replace `coalesces cursor saves across a burst of events and flushes on close` at [app/list/dashboard.test.mjs:385](../app/list/dashboard.test.mjs#L385) with `persists view state and launch draft without a cursor`. The cursor-save assertion must be inverted.
- Replace cursor restoration cases at [app/list/dashboard.test.mjs:543](../app/list/dashboard.test.mjs#L543), [app/list/dashboard.test.mjs:555](../app/list/dashboard.test.mjs#L555), [app/list/dashboard.test.mjs:565](../app/list/dashboard.test.mjs#L565), and [app/list/dashboard.test.mjs:576](../app/list/dashboard.test.mjs#L576) with one legacy-cursor acceptance test and one new-state omission test.
- Delete `runtime/event-store.test.mjs` only after all list callers are gone.

Implementation:

- Remove cursor fields and save scheduling from `DashboardController` at [app/list/dashboard.mjs:324](../app/list/dashboard.mjs#L324) and [app/list/dashboard.mjs:1348](../app/list/dashboard.mjs#L1348).
- Make `validateFrontendState` in `app/list/frontend-state.mjs` accept and discard a legacy `cursor`, while new writes omit it.
- Remove list replay queues, resynchronization markers, cursor comparison, and list acknowledgement code from `app/daemon-client.mjs`.
- Delete `runtime/event-store.mjs` and remove list event validation from `runtime/state-migration.mjs`. Obsolete files are ignored in place.
- Update architecture and development documentation.

What could break and evidence: frontend-state validation can reject an existing state file. Evidence is `FRONTEND_STATE_CORRUPT` on first start after upgrade.

Stopping point: new frontend state contains client ID, view state, and launch draft only; legacy cursor state loads; Gate 3 list checks pass.

Undo: revert all change 2 commits and restart the daemon. Reversible while obsolete event files remain. Events produced during the invalidation-only interval cannot be reconstructed, but rollback starts from an authoritative registry snapshot, so list correctness does not depend on them.

## Change 3: make attachment roles connection-scoped and non-durable

**Operator-visible change.** Today, short-lived composer and observer changes write durable records and list events. Corruption in those records can block daemon startup even though a role cannot survive its socket. Afterwards, one live socket owns composer, socket close releases it, and restart begins with no claims.

**Estimate:** 2 commits, 1 to 2 engineer-days, and a net reduction of 250 to 450 lines.

### Commit 3.1: define in-memory idempotence and races

Tests first:

- Replace `arbitrates one composer per session and persists release before observer takeover` at [runtime/daemon.integration.test.mjs:617](../runtime/daemon.integration.test.mjs#L617) with an in-memory race test. The durable-order assertion must be inverted.
- Replace `serializes disconnect behind an attach whose durable append is in flight` at [runtime/daemon.integration.test.mjs:654](../runtime/daemon.integration.test.mjs#L654) with `serializes disconnect and grant under the session lock`.
- Add cases for two racing sockets, repeated attach on one socket after a lost response, winner close during grant, reconnect of both sockets, and rapid leave/reopen. Each pins dual composers or a stuck observer.
- Replace recovery tests at [runtime/daemon.integration.test.mjs:756](../runtime/daemon.integration.test.mjs#L756) and [runtime/daemon.integration.test.mjs:791](../runtime/daemon.integration.test.mjs#L791) with restart-clears-claims tests.

Implementation:

- Simplify `arbitrateAttachment`, `releaseConnectionAttachments`, and socket-close handling in `runtime/daemon.mjs:840-969`.
- Keep the per-session lifecycle lock around grant and release.
- Return the current role for repeated attach from the same authenticated socket. Detach of an absent claim is idempotent.
- Emit no list invalidation for role churn. Viewer snapshots still derive the role from the current socket claim.

What could break and evidence:

- Two sockets can both receive composer. Evidence is two successful composer responses for one session generation.
- Socket close can race after grant and leave a claim. Evidence is a later socket remaining observer after the winner has closed.

Stopping point: the race matrix passes under repeated runs; attachment changes produce no list notification.

Undo: revert 3.1 before deleting the result store. Fully reversible.

### Commit 3.2: delete attachment durability and recovery

Tests first:

- Add a startup test with a corrupt obsolete `daemon/attachment-results.jsonl`; startup must ignore it.
- Add an artifact test asserting new roots never create that file.
- Remove `runtime/attachment-result-store.test.mjs` after callers are gone.

Implementation:

- Remove `AttachmentResultStore`, attach and detach journal transitions, attachment event production, and attachment recovery from `runtime/daemon.mjs:1434-1441`.
- Delete `runtime/attachment-result-store.mjs`.
- Remove its validator from `runtime/state-migration.mjs:73-77`. Preserve old files in place during upgrade.
- Remove `attachment_changed` from the active list contract after the new frontend has old-daemon fallback parsing isolated as a legacy shape.
- Update architecture documentation.

What could break and evidence: command-journal recovery can still classify old attach and detach entries as redeliverable. Evidence is a claim appearing during startup before a socket requests it. Recovery must skip historical attachment operations.

Stopping point: no durable attachment artifact is opened, created, appended, or reconciled; Gate 3 passes.

Undo: revert change 3 and restart the daemon. Existing roles are lost on any daemon restart either way. Once shipped, rollback is safe because old files remain, but an old daemon must not infer current roles from stale entries. Clear role state through a normal daemon restart, not file edits.

## Change 4: persist only Pi-confirmed runtime configuration

**Operator-visible change.** Today, a failed launch can display the requested model and thinking level as if Pi ran them. A successful current-daemon launch may not correct the row until reconnect. Afterwards, fields stay absent until the startup `get_state` response confirms them, and known invalid models are refused before preparation.

**Estimate:** 2 commits, 1 engineer-day, and a net reduction of 20 to 60 lines excluding admission tests.

### Commit 4.1: validate model admission in the daemon

Tests first:

- Add daemon tests for a catalog-listed model, a known absent model, catalog failure, and no requested model.
- Invert `accepts anything when the catalog is unavailable, so an offline daemon cannot block a launch` at [app/list/list-commands.test.mjs:143](../app/list/list-commands.test.mjs#L143) only in authority, not outcome. The frontend still accepts the draft, while the daemon owns final admission.
- Add artifact assertions. A known refusal leaves only a failed journal result. It creates no registry row, Pi session, worktree, worker, or launch-result entry.

Implementation:

- In the `launch` branch at [runtime/daemon.mjs:1088](../runtime/daemon.mjs#L1088), validate a named model after journal acceptance and host checks but before `DELIVERY_ATTEMPTED` and `resolveLaunchRequest`.
- Use `createModelCatalog` as the authority. Treat a successful catalog response without the model as `MODEL_UNKNOWN`. Treat `MODEL_CATALOG_FAILED` as unavailable and proceed.
- Keep `parseListCommand` checks in `app/list/list-commands.mjs:94-114` as an advisory early refusal when a catalog is already loaded.

What could break and evidence:

- A provider omitted from a partial catalog can be refused incorrectly. Evidence is Pi accepting a model that daemon admission rejects. The approved unavailable-versus-absent rule must be observable in diagnostics.
- Validation after preparation can leave artifacts. Any new session file or worktree on known refusal is a failure.

Stopping point: all four admission cases have exact journal stages and artifact assertions; no process starts for known refusal.

Undo: revert 4.1. Fully reversible. Failed journal records remain valid under old code.

### Commit 4.2: write configuration from initial Pi state

Tests first:

- In `runtime/launch-resolver.test.mjs`, invert the cases at [runtime/launch-resolver.test.mjs:141](../runtime/launch-resolver.test.mjs#L141) and [runtime/launch-resolver.test.mjs:165](../runtime/launch-resolver.test.mjs#L165) that expect requested model or thinking level in `sessionRecord`. Assert they remain only in worker launch arguments.
- Extend `records the model Pi actually selected so the list can show it` at [runtime/daemon.integration.test.mjs:1268](../runtime/daemon.integration.test.mjs#L1268) to cover default selection, accepted request, Pi substitution, omitted field, failure before Pi spawn, failure after spawn before ready, and daemon restart.
- Add a failed-launch list assertion. The operator sees no model or thinking value unless fake Pi returned it.

Implementation:

- Stop copying request values into `SessionRecord` in `runtime/launch-resolver.mjs:164-165`.
- Add normalized `initialState` to the socket-ready exchange in `runtime/installed-pi-worker.mjs:135-167`.
- Apply model and thinking level in the same lifecycle write that records worker readiness in `runtime/worker-supervisor.mjs:530-589`, or in a daemon lifecycle write before readiness becomes visible. Do not publish an intermediate ready row.
- Reuse `recordSessionModel` in `runtime/daemon.mjs:742-759` for reconnect reconciliation. Absence from Pi remains absence and never falls back to the request.

What could break and evidence:

- The list can briefly show READY without confirmed values. Evidence is two visible ready revisions where the first lacks values Pi returned at startup.
- A legacy inactive row retains old mixed-meaning values. This is accepted until that session next has confirmed state. Do not rewrite inactive records without Pi evidence.

Stopping point: one ready transition includes Pi-confirmed values; every failure window leaves values absent; Gate 2 passes.

Undo: revert 4.2. The schema does not change, so rollback is possible. Values written by the new code are Pi-confirmed and remain valid under old code.

## Change 5: remove durable viewer acknowledgements but retain ordered viewer events

**Operator-visible change.** Today, a corrupt viewer `.acks.json` can block recovery even though acknowledgements do not compact or delete events. Afterwards, recovery ignores that file. Reconnect resumes from the frontend's locally persisted cursor, and stable event IDs make replay idempotent.

**Estimate:** 2 commits, 1 engineer-day, and a net reduction of 100 to 180 lines.

### Commit 5.1: stop frontend acknowledgements and prove replay idempotence

Tests first:

- Replace `gets viewer snapshots, subscribes by session cursor, and acknowledges only after consumer processing` at [app/daemon-client.test.mjs:233](../app/daemon-client.test.mjs#L233) with local-cursor advancement after processing and persistence. The `ack_viewer` expectation must be inverted.
- Add disconnect cases before processing, after processing, and after local cursor persistence in `app/viewer/viewer-controller.test.mjs`.
- Assert a replayed stable event ID does not duplicate transcript content.

Implementation:

- Remove `ackViewer` calls from `ViewerController.processEvent` at [app/viewer/viewer-controller.mjs:607](../app/viewer/viewer-controller.mjs#L607).
- Advance and save the local viewer cursor only after event application succeeds.
- Remove viewer acknowledgement tracking from `app/daemon-client.mjs:168-171` and `app/daemon-client.mjs:433-434`.

What could break and evidence: a disconnect between render and save can replay an event. Transcript item count increasing for a repeated stable event ID is a failure.

Stopping point: all three disconnect windows have no skipped content and no duplicate transcript item; old daemon compatibility still works because it does not require an acknowledgement to stream.

Undo: revert 5.1. Fully reversible.

### Commit 5.2: remove server persistence and retain a no-op compatibility response

Tests first:

- Invert `durably acknowledges one client's cursor without advancing other clients` at [runtime/viewer-store.test.mjs:116](../runtime/viewer-store.test.mjs#L116). Assert no acknowledgement API or file.
- Change `fails daemon reconciliation closed when durable viewer state is corrupt` at [test/viewer-recovery.integration.test.mjs:38](../test/viewer-recovery.integration.test.mjs#L38) so corrupt event, checkpoint, or snapshot state still fails, but corrupt `.acks.json` is ignored.
- Add a compatibility test that an old frontend's `ack_viewer` receives its cursor unchanged and causes no write.

Implementation:

- Remove acknowledgement loading and methods from `runtime/viewer-store.mjs:159-170` and `runtime/viewer-store.mjs:292-304`.
- Keep `ack_viewer` parsing and return `viewer_acknowledged` unchanged in `runtime/daemon.mjs:1067-1071` for one compatibility release, but perform no persistence. Mark it deprecated in the contract comment.
- Stop creating viewer acknowledgement paths in viewer-store location construction.
- Ignore old `.acks.json` files in migration and recovery.

What could break and evidence: removing the wrong cursor can skip viewer events. Any change to viewer event cursors, snapshots, bounded subscription, or replay ordering is out of scope and a review failure.

Stopping point: ordered viewer-store tests remain unchanged except acknowledgement cases; no new `.acks.json` write occurs; Gate 4 viewer checks pass.

Undo: revert 5.2. Old acknowledgement files remain. Once shipped, rollback is safe because acknowledgements have no retention effect. Remove the no-op protocol operation only in a later major contract change.

## Change 6: remove the unused trash transaction

**Operator-visible change.** Today, production Delete forgets a row and keeps the Pi file and worktree, but unused transaction code can still fail startup or maintenance. Afterwards, Delete has one behavior: it removes an inactive dashboard record and leaves owned paths untouched.

**Estimate:** 2 commits, 1 to 2 engineer-days, and a net reduction of 200 to 400 lines.

### Commit 6.1: make forget-only Delete the only behavior

Tests first:

- Keep and extend `forgets a session without a trash capability and preserves session and worktree paths` at [test/destructive-actions.integration.test.mjs:209](../test/destructive-actions.integration.test.mjs#L209).
- Rewrite `refuses observer, live, and symlink-replaced Delete targets without invoking trash` at [test/destructive-actions.integration.test.mjs:174](../test/destructive-actions.integration.test.mjs#L174). Keep observer, live, attachment, route, and revision refusals. Remove symlink and trash callback expectations because Delete no longer opens the canonical file.
- Add inactive, live, attached, stale-metadata, revision-changed, and concurrently relaunched cases. Every success preserves the canonical file and worktree.

Implementation:

- Remove the `trashSessionFile` option and validation from `createDaemonRuntime` at [runtime/daemon.mjs:594](../runtime/daemon.mjs#L594).
- Reduce the Delete branch at [runtime/daemon.mjs:1275](../runtime/daemon.mjs#L1275) to revision, inactive-state, attachment, ownership, launch, metadata, and route checks followed by registry removal and journal completion.
- Keep exact process identity checks and per-session locking. Do not inspect, unlink, rename, or trash the canonical Pi file.

What could break and evidence:

- Simplification can weaken a live-session guard. Evidence is successful Delete while ownership, live process state, route, launch, or another attachment exists.
- Delete can touch a path. Any filesystem call using `canonicalSessionFile` in the production Delete path is a failure.

Stopping point: the safety matrix passes and successful Delete changes only registry and journal artifacts.

Undo: revert 6.1 before 6.2. Fully reversible.

### Commit 6.2: remove trash recovery and retire its durable file

Tests first:

- Remove or replace PREPARED and TRASHED tests at [test/destructive-actions.integration.test.mjs:232](../test/destructive-actions.integration.test.mjs#L232), [test/destructive-actions.integration.test.mjs:278](../test/destructive-actions.integration.test.mjs#L278), [test/destructive-actions.integration.test.mjs:357](../test/destructive-actions.integration.test.mjs#L357), [test/destructive-actions.integration.test.mjs:387](../test/destructive-actions.integration.test.mjs#L387), and [test/destructive-actions.integration.test.mjs:449](../test/destructive-actions.integration.test.mjs#L449).
- Add startup cases for absent file, empty old file, and nonempty old file. The first two start. The third fails with `UNSUPPORTED_LEGACY_DELETE_TRANSACTION` before mutation.

Implementation:

- Remove `createDeleteResultStore`, PREPARED and TRASHED phases, destructive failpoints, file fingerprinting, and trash reconciliation from `runtime/daemon.mjs:188-245` and `runtime/daemon.mjs:1288-1378`.
- Remove delete-result validation from `runtime/state-migration.mjs:49-52` and add the explicit nonempty legacy guard at daemon startup.
- Do not delete `daemon/delete-results.json` automatically.
- Update architecture documentation to make forget-only behavior unconditional.

What could break and evidence: a historical nonempty transaction can be ignored and produce an unexplained row or file. Startup proceeding with a nonempty store is a failure.

Stopping point: Gate 0 found no production entries; temporary-root migration cases pass; Gate 4 Delete check passes.

Undo: revert change 6. After shipment, rollback remains possible because the old file is retained. A Delete completed under new code has no trash phase, which old code already handles through its no-callback production branch.

## Change 7: bypass durable worker replay only for side-effect-free reads

**Operator-visible change.** This change removes no reported failure. Afterwards, opening menus and running `/stats` or `/tree` avoids replay writes and replay-store corruption exposure. Pi-mutating commands and `/export` keep their current delivery-unknown behavior.

**Estimate:** 2 commits, 0.5 to 1 engineer-day, and a net reduction of 20 to 60 lines. This is lower than the review's 30 to 80 line estimate because `export_html` stays durable.

### Commit 7.1: classify worker operations and dispatch reads without replay

Tests first:

- Add a table to `runtime/worker.test.mjs` or the existing worker dispatcher test file for `get_state`, `get_session_commands`, `get_session_stats`, `get_tree`, `export_html`, prompts, interrupts, user-interface responses, and every settings command.
- Assert the first four create zero replay records.
- Assert `export_html` and every mutation still produce `RECEIVED`, `RPC_WRITE_STARTED`, and terminal replay stages.
- Add disconnect tests. A failed read can be retried normally. A failed mutation remains `DELIVERY_UNKNOWN` unless explicitly retried at risk.

Implementation:

- Split `WORKER_OPERATIONS` in `runtime/worker.mjs:12` into side-effect-free reads and replayed operations.
- Add a direct serialized read dispatcher beside `createWorkerCommandDispatcher` at [runtime/worker.mjs:176](../runtime/worker.mjs#L176). It still validates operation shape and bounds output.
- Dispatch `session_query` by subtype. `get_session_stats` and `get_tree` use the read path. `export_html` uses replay.
- Keep one per-worker serial tail unless evidence proves concurrent Pi reads are safe. This plan does not introduce Pi RPC concurrency.

What could break and evidence:

- A mutating setting can be misclassified. Evidence is a Pi write with no replay record.
- A read can overtake a prior mutation. Evidence is `get_state` returning pre-mutation state after the mutation response. Shared serialization must preserve call order.

Stopping point: the classification table covers every worker operation and session-query subtype; ordering tests pass.

Undo: revert 7.1. Fully reversible because the durable replay format does not change.

### Commit 7.2: make old replay records compatible and document the boundary

Tests first:

- Open a replay file containing historical read records and assert startup accepts it.
- Restart after a historical read record stopped at `RPC_WRITE_STARTED`. It may be marked `DELIVERY_UNKNOWN` for compatibility, but a new read with a new request ID bypasses replay.
- Assert no schema or parser change rejects old records.

Implementation:

- Keep `validateWorkerReplayRecord` backward compatible in `runtime/worker-replay-contract.mjs`.
- Do not rewrite or delete old replay files.
- Update `runtime/state-migration.mjs` only if a prior validator assumes every supported operation still writes new records. Acceptance of old records must remain.
- Update architecture and development documentation with the exact classification and `export_html` exception.

What could break and evidence: a daemon restart can fail on a valid old read record. `WORKER_REPLAY_CORRUPT` on the compatibility fixture is a failure.

Stopping point: old and new replay fixtures open; Gate 4 replay checks pass; full suite and typecheck pass.

Undo: revert change 7 at any time. No durable migration is needed.

## Migration and process compatibility by change

| Change | Durable or process boundary | Upgrade with running daemon and live sessions | Required operator action | Rollback after shipment |
|---|---|---|---|---|
| 1. Worker transport | Worker IPC and control socket | Yes, if the additive fallback remains. A new worker keeps IPC with an old daemon. Existing workers reconnect by socket after daemon restart. | Close frontend, restart daemon at Gate 1, verify exact identities. Do not stop workers. | Restart old daemon. New workers retain old-daemon IPC behavior for one release. |
| 2. List invalidation | Frontend-daemon protocol; retired event and cursor files | Live workers are unaffected. A new frontend can consume old daemon events as invalidations. An old frontend cannot consume the new daemon notification. | Close old frontend before daemon restart. Leave obsolete files in place. | Restart old daemon and use a registry snapshot. Events during the new interval are not needed for list correctness. |
| 3. Attachments | Frontend socket state; retired result file | Claims cannot survive daemon restart by definition. Live workers are unaffected. | Reattach viewers after restart. Do not expect composer ownership to persist. | Restart daemon to clear claims. Old files remain but must not be treated as current. |
| 4. Confirmed configuration | Session record semantics; startup handshake | Yes. Record schema stays version 1 and fields remain optional. | Restart daemon after change 1, then use disposable launches at Gate 2. | Safe. New values have stronger provenance than old values. |
| 5. Viewer acknowledgements | Viewer request contract; retired `.acks.json` | Yes. New frontend works with an old daemon. New daemon answers old `ack_viewer` as a no-op for one release. | Restart frontend and daemon at Gate 4. Leave old files in place. | Safe because acknowledgements never controlled retention. |
| 6. Trash removal | Daemon option and delete-result file | Yes only when the old result store is absent or empty. Live workers are unaffected. | Verify at Gate 0. Stop rollout on any nonempty transaction. | Safe. Retained old file and unchanged journal format permit rollback. |
| 7. Replay narrowing | Worker replay behavior, not format | Yes. Existing workers run old behavior until restarted; both behaviors are safe. | No worker restart is required. Verify new disposable worker at Gate 4. | Safe. Old records remain valid. |

No change automatically deletes an obsolete durable file. This keeps rollback possible and avoids turning cleanup into an unreviewed migration. A later administrative cleanup can remove files only after the rollback window closes.

## What this plan does not do

- It does not remove the daemon, worker processes, ownership leases, process start identity, process-group checks, or exact signaling revalidation.
- It does not move Pi ownership into the frontend or make sessions depend on a terminal.
- It does not replace viewer ordered delivery with list-style invalidation.
- It does not remove viewer snapshots, event cursors, stable event IDs, bounded queues, normalization, or recovery checkpoints.
- It does not remove the daemon command journal or worker replay for prompts, steering, follow-up, interrupt, user-interface responses, settings changes, session commands, or `export_html`.
- It does not compact, rewrite, or delete historical state files.
- It does not remove `runtime/state-migration.mjs`; supported old roots still need validation and adoption.
- It does not fold launch results into the command journal or change that journal's schema.
- It does not split the 1,592-line daemon solely for navigation. Deletions land first; later extraction can follow the remaining responsibilities.
- It does not consolidate canonical serializers or alter durable fingerprints.
- It does not change summary inference, enable summaries by default, or make provider requests in tests.
- It does not add concurrent Pi RPC calls. Read bypass remains serialized with mutations.
- It does not add canonical Pi file deletion or worktree cleanup to Delete.
- It does not claim the unmeasured 3 ms list snapshot latency. Measure snapshot latency at Gate 3 and record machine load before any performance claim.

## Approval and execution record

Before work starts, record the operator's answers to decisions 1 through 8 and the Gate 0 evidence in the implementation issue. Approve, reject, or reorder at the change level. Do not split the commits that define one compatibility transition unless the revised sequence still leaves old daemon memory, new code on disk, and live workers interoperable.
