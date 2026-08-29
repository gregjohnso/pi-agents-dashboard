# Architecture implementation plan

After these 18 commits:

- Commands work the same on a newly launched session and after a daemon restart. Graceful Stop no longer waits through its timeout solely because a route is absent.
- Several terminals may open one session. Exactly one may type; the others remain read-only and can explicitly claim composer after it becomes vacant.
- Several dashboards keep independent drafts and selections. A stale list cursor cannot crash dashboard startup.
- A session row shows a model only after Pi confirms that model.
- Delete continues to forget only the dashboard row. It preserves the canonical Pi file and worktree.
- The daemon and workers continue running when terminal clients exit.

Approve the work as 18 green commits with five operator-machine gates protecting the live daemon and two live sessions. Estimated effort is 7 to 11 engineer-days. This is an estimate, not measured work. It includes tests, compatibility paths, gates, and documentation. It excludes review time and maintenance-window waits.

The resulting process model is one daemon per state root, many terminal clients, one worker per live Pi session, and at most one composer connection per session. Any number of observers may open a session read-only.

## Approval decisions

| # | Decision | Recommendation or settled answer |
|---|---|---|
| 1 | Model admission validation | Recommended. Validate in the daemon after journal acceptance and before launch resolution. The frontend picker remains an early check; daemon validation covers command-line, stale frontend, and direct protocol clients. |
| 2 | Refused launch artifacts | Recommended. A known admission refusal leaves a terminal `FAILED` journal result and no session record, Pi file, worktree, worker, or list row. A failure after preparation keeps the failed row because side effects and cleanup evidence exist. |
| 3 | Unavailable model catalog | Recommended. Record the diagnostic and let Pi decide. `MODEL_CATALOG_FAILED` differs from `MODEL_UNKNOWN`. |
| 4 | Unused trash seam | Recommended. Remove it. Delete continues to forget only the dashboard record. Any future command that deletes Pi files needs separate wording and recovery. |
| 5 | List protocol compatibility | Settled as a two-release transition. The current frontend discards the `subscribe` response, so a new daemon cannot make that process show a refusal. First ship a bridge client that tracks the response and displays `Dashboard protocol changed. Exit and restart pi-agents.` on `CLIENT_RESTART_REQUIRED`; its daemon retains bounded old replay. In the following release, send `subscribe_list_changes` and reject old `subscribe`. A pre-bridge frontend keeps working against the bridge daemon until it restarts naturally. |
| 6 | Retired durable files | Recommended. Ignore valid obsolete list, attachment, and viewer acknowledgement files in place. A corrupt retired file does not block startup. Do not delete files during rollout. |
| 7 | Legacy trash transactions | Recommended. Ignore an absent or empty `delete-results.json`. Stop startup with `UNSUPPORTED_LEGACY_DELETE_TRANSACTION` for any nonempty entry. |
| 8 | Worker IPC handoff | Recommended. Bind Pi identity, authenticate and adopt the socket, persist readiness, send `handoff_to_socket`, receive its acknowledgement, then disconnect inter-process communication (IPC). Without those messages, a new worker retains IPC for an older daemon still in memory. |

Decisions 1 through 4 and 6 through 8 need operator approval before their commits begin. Decision 5 is settled.

## Settled feature scope

1. Support several terminals and dashboards. Composer and observer roles are connection-scoped; add the missing read-only viewer.
2. Delete `/stats`, `/tree`, `/export`, `session_query`, and its payload shape from every layer.
3. Delete `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up`, including commands, projections, adapter methods, and tests.
4. Keep worktree isolation, ownership locks, sweeps, and cleanup.
5. Keep `/model`. Delete `/thinking`, its picker, `set_thinking_level`, and requested thinking level from dashboard launch.
6. Keep summaries opt-in. Summary model settings remain dashboard settings, not Pi settings passthrough.

## Execution rules and invariants

Write each named failing test first and observe the intended failure. Add implementation in the same commit. Run focused tests, the full 788-test suite, and `pixi run typecheck` before each commit. Counts are targets, not promises.

Use only temporary state roots in tests. Never write to the production root under `~/.local/state`, its neighboring root, or start, stop, or signal its daemon or workers outside the gates. Measure before making performance claims and report machine load because it ranges from 5 to 30.

Every commit preserves these invariants:

- The daemon alone writes session records.
- Ownership is released only after the worker and Pi child are provably gone.
- Delete forgets dashboard state only. It does not remove a canonical Pi file or worktree.
- Pi lifecycle event mapping has one home.
- A revision guard covers every fact used by a destructive operation.
- Background work stays outside operator locks.
- Every process boundary has a versioned contract.
- One session has at most one composer connection and any number of observers.
- Socket loss releases a composer claim but does not cancel an accepted command.
- Worktree creation, locks, sweeps, cleanup, and opt-in summaries remain unchanged.

## Sequence and concurrent work

| Step | Required serial path | What becomes true | Gate after step |
|---:|---|---|---|
| 1 | Baseline inspection | The live daemon and both sessions have an exact, recorded starting identity. | Gate 0 |
| 2 | Changes 1 through 3 | Broken and Pi-owned controls no longer appear; `/model` and observed thinking remain. | |
| 3 | Change 4 | A second or third terminal opens an occupied session read-only instead of showing `SESSION_IN_USE`. | |
| 4 | Changes 5.1 through 5.3 | Commands, frames, replies, reconnect, and graceful Stop use the same route before and after daemon restart. | Gate 1 |
| 5 | Change 6 | A row never shows an unconfirmed requested model. | Gate 2 |
| 6 | Changes 7.0 through 7.3, with bridge deployment before 7.2 | Dashboard startup reads current rows instead of replaying history; old clients receive the restart instruction. | |
| 7 | Changes 8.1 and 8.2 | Three dashboards keep independent state, see writer departure, and produce exactly one composer after a race. | Gate 3 |
| 8 | Changes 9 and 10 | Obsolete acknowledgement files cannot block startup; Delete remains forget-only; retained files support rollback. | Gate 4 |

Work may proceed independently only as follows:

- Trash removal may start after Gate 0. It shares `runtime/daemon.mjs`, so merge it only after the serial branch is current.
- Viewer acknowledgement removal may be prepared after the list contract is fixed. It shares `app/daemon-client.mjs` and `shared/contracts.mjs` with list invalidation.
- Three-client fixture design may proceed during feature deletion. Production attachment changes wait for list invalidation because attachment recovery currently emits list events.

Protocol rules apply throughout:

- Worker readiness, socket adoption, and IPC handoff are one decision.
- `subscribe_list_changes`, tracked legacy refusal, and `CLIENT_RESTART_REQUIRED` are one compatibility decision. Ship the bridge client while the daemon still supports old replay.
- A live dashboard gets a process-scoped connection ID. Durable command recovery may retain the stable installation ID and request ID.
- `session_access_changed` carries `sessionId`, the receiving connection's role, `writerPresent`, and an in-memory generation. It carries no peer client ID.
- Observers explicitly request composer after a vacancy. The per-session lock decides races. Accepted commands continue after disconnect.

## Change 1: broken session queries disappear

**Outcome:** Operators no longer see `/stats`, `/tree`, or `/export`, which fail on newly launched workers. The commit removes their generic request path from every layer.

**Estimate:** 1 commit, 0.5 engineer-day, net deletion of 120 to 220 lines.

### Commit 1: `feat: remove dashboard session queries`

- **Tests:** In `app/viewer/slash-commands.test.mjs`, assert all three commands are absent. In `shared/contracts.test.mjs`, reject `session_query`. Remove query execution cases from `runtime/worker.test.mjs` only after those tests fail as intended.
- **Implementation:** Remove query parsing and panels from `app/viewer/slash-commands.mjs` and `app/viewer/viewer-controller.mjs`; `query` from `createDaemonViewerClient` in `app/list/standalone-list.mjs`; `session_query` and `SESSION_QUERIES` from `shared/contracts.mjs`; the daemon branch in `runtime/daemon.mjs`; `runSessionQuery` in `runtime/worker.mjs`; and dashboard-only methods in `runtime/pi-rpc-adapter.mjs`.
- **Risk:** An adapter method may still support capability probing or another command. Focused imports and typecheck must identify that use.
- **Stop:** No production `session_query`, `get_session_stats`, `get_tree`, or `export_html` remains.

## Change 2: Pi-owned settings disappear from the dashboard

**Outcome:** Operators no longer see `/auto-compact`, `/auto-retry`, `/steering`, or `/follow-up`. Removing their dashboard passthrough also removes the `enabled` and `mode` projection mismatch.

**Estimate:** 1 commit, 0.5 engineer-day, net deletion of 100 to 180 lines.

### Commit 2: `feat: remove Pi settings passthrough`

- **Tests:** In `app/viewer/slash-commands.test.mjs`, assert `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up` are absent. Reject their four `session_command` variants in `shared/contracts.test.mjs`. In `runtime/worker.test.mjs`, assert no worker operation maps them to Pi.
- **Implementation:** Remove command definitions and handlers from `app/viewer/slash-commands.mjs` and `app/viewer/viewer-controller.mjs`; variants from `shared/contracts.mjs`; projections from `runtime/daemon.mjs` and `runtime/worker-supervisor.mjs`; and dispatch and adapter methods from `runtime/worker.mjs` and `runtime/pi-rpc-adapter.mjs`. Keep `get_settings` and `set_settings` for summary configuration.
- **Stop:** No production command name remains, and unchanged summary opt-in tests pass.

## Change 3: thinking is display-only

**Outcome:** `/thinking` and its picker disappear, while `/model` remains. Pi-reported thinking still appears as observed state.

**Estimate:** 1 commit, 0.5 to 1 engineer-day, net deletion of 80 to 160 lines.

### Commit 3: `feat: remove dashboard thinking control`

- **Tests:** In `app/viewer/slash-commands.test.mjs`, remove `/thinking` while retaining `/model`. In `app/list/dashboard.test.mjs`, require model but no thinking selection in the draft and picker. In `shared/contracts.test.mjs`, reject launch `thinkingLevel` and `set_thinking_level`. Retain viewer tests for Pi-reported `thinking_state`.
- **Implementation:** Remove the picker and command from `app/viewer/slash-commands.mjs`, `app/viewer/overlays.mjs`, and `app/viewer/viewer-controller.mjs`; launch draft handling from `app/list/launch-composer.mjs` and `app/list/dashboard.mjs`; and requested thinking from `shared/contracts.mjs`, `runtime/launch-resolver.mjs`, `runtime/worker-supervisor.mjs`, and startup arguments. Keep normalized Pi events and optional observed `SessionRecord.thinkingLevel`.
- **Stop:** No dashboard request selects thinking; `/model` and observed thinking tests pass.

## Change 4: occupied sessions open read-only

**Outcome:** A second or third terminal opens the same session read-only instead of showing `SESSION_IN_USE`. One composer can mutate; observers can scroll and inspect tools.

**Estimate:** 1 commit, 0.5 engineer-day.

### Commit 4: `feat: open occupied sessions read-only`

- **Tests:** Invert `rejects an observer attachment` in `app/list/standalone-list.test.mjs` to `opens an observer attachment read-only`. Add one composer and two observers. Observers may scroll and inspect tools but cannot prompt, interrupt, answer UI, rename, recolor, or delete. Extend the existing observer input matrix for every remaining mutation.
- **Implementation:** Return either granted role from `createDaemonViewerClient.attach` in `app/list/standalone-list.mjs`. Carry it through opening until the authoritative viewer snapshot. Render `Read-only session` and writer occupancy as status, not error. Default to no mutation until composer is confirmed.
- **Stop:** Three clients open one session, exactly one mutates, and valid observers never see `SESSION_IN_USE`.

## Change 5: commands work on every session and Stop uses its graceful route

**Outcome:** Commands, frames, replies, reconnect, and graceful Stop behave the same on a newly launched session and after daemon restart. Stop no longer waits through the graceful timeout solely because the current launch lacks a route. The worker adopts one authenticated daemon socket before readiness, then releases startup IPC.

**Estimate:** 3 commits, 2.5 to 4 engineer-days, net deletion of 250 to 450 lines after changes 1 through 3.

### Commit 5.1: `refactor: specify worker socket handoff`

- **Tests:** Add `keeps IPC until the daemon adopts the authenticated socket route` in `runtime/worker-supervisor.test.mjs`; `new workers retain IPC when an old daemon never requests handoff` in `runtime/worker.integration.test.mjs`; and wrong run, lease, generation, token, and process identity cases in `runtime/reconciliation.failure.test.mjs`.
- **Implementation:** Add internal version 1 `connect_socket`, `socket_ready`, `handoff_to_socket`, and `socket_handoff_complete` messages in `runtime/installed-pi-worker.mjs`, `runtime/worker-supervisor.mjs`, and `runtime/worker.mjs`. Keep route generation and exact identity authoritative in `runtime/reconciliation.mjs`. Keep IPC open unless the daemon requests handoff.
- **Stop:** Temporary-root tests reach one authenticated route; the old-daemon fixture retains IPC.

### Commit 5.2: `refactor: move worker traffic to the socket`

- **Tests:** Invert fresh-launch delivery in `runtime/daemon.integration.test.mjs` to require the adopted socket. Cover prompt, follow-up message, steer, interrupt, UI response, model, compact, rename, menu, initial state, frames, and Stop. Send frames before, during, and after handoff; stable source IDs occur once and in order.
- **Implementation:** Route ongoing frames, events, commands, replies, `askWorker`, activation, and frame ingestion through `RecoveredWorkerRouter`. Remove ongoing payload projection and reply handling from the launch handle.
- **Stop:** Every operation passes before and after simulated daemon restart. IPC remains open pending final acknowledgement.

### Commit 5.3: `refactor: make socket adoption the ready boundary`

- **Tests:** Require Pi bind plus socket adoption in `runtime/worker-supervisor.test.mjs`. Inject failure before and after Pi bind and before and after route adoption. Add `graceful Stop uses the current launch socket before escalation` in `test/destructive-actions.integration.test.mjs`. Assert `sessionHandles` and launch delivery handles are absent after readiness.
- **Implementation:** Register bound identity, request connection, verify the route, persist readiness, complete handoff, then disconnect IPC. Route graceful shutdown through the locked socket and stop policy. Delete `sessionHandles`, route-versus-handle branches, launch-channel pending replies, and duplicate buffering.
- **Risk:** IPC disconnect may look like worker exit; a daemon crash during handoff may strand the worker.
- **Stop:** Every injected window converges to one route or a terminal failed launch, and Gate 1 passes.

## Change 6: rows show only models that Pi confirmed

**Outcome:** A failed launch never displays a requested model that Pi did not run. The row remains unset until Pi confirms its model at readiness.

**Estimate:** 1 commit, 0.5 to 1 engineer-day.

### Commit 6: `fix: record only Pi-confirmed session model`

- **Tests:** In `runtime/launch-resolver.test.mjs`, keep requested model in worker arguments but not the prepared record. In `runtime/daemon.integration.test.mjs`, cover default selection, accepted request, Pi substitution, omitted model, failure before and after spawn, and restart. If decisions 1 through 3 are approved, cover catalog-listed, known absent, unavailable catalog, and no requested model.
- **Implementation:** Stop copying requested model into the prepared record. Carry normalized initial Pi state through socket readiness and apply confirmed model in the same lifecycle write. Absence remains unknown. Keep Pi-reported thinking display-only.
- **Stop:** One ready revision contains the Pi-confirmed model; every failure window leaves it absent; Gate 2 passes.

## Change 7: stale list history cannot crash dashboard startup

**Outcome:** The dashboard starts from current registry state instead of replaying thousands of old list records. Burst updates converge to current rows without a queue that grows with the burst. A two-release bridge gives old frontends an explicit restart instruction before replay is removed.

**Estimate:** 4 commits across 2 releases, 1.5 to 2.5 engineer-days, net deletion of 350 to 600 lines.

### Commit 7.0: `feat: surface list protocol refusal`

- **Tests:** In `app/daemon-client.test.mjs`, track subscription requests and route `CLIENT_RESTART_REQUIRED` plus the daemon's exact message to the subscriber error path. Add a bridge test where old replay still serves a pre-bridge client. The bridge client stops retrying and renders the instruction once.
- **Implementation:** Track internal `subscribe` request ID and response in `app/daemon-client.mjs`. Propagate refusal to `DashboardController` as terminal. Keep old event storage and replay in the bridge daemon. Deploy this commit before replay removal.
- **Stop:** A bridge frontend displays the instruction while a pre-bridge frontend still works against the bridge daemon.

### Commit 7.1: `feat: add race-safe list invalidation`

- **Tests:** In `app/list/dashboard.test.mjs`, cover changes before subscribe, during snapshot, after response, and during reconnect. Replace replay and acknowledgement assertions with final snapshot state. Send 10,000 invalidations and require bounded pending work and at most three reads for one burst plus one change during a read.
- **Implementation:** Add `subscribe_list_changes` and payload-free `list_changed` to `shared/contracts.mjs`. Subscribe, mark dirty, read `get_state`, and refetch once after an in-read notification. Coalesce notifications. On old-daemon `UNKNOWN_OPERATION`, use tracked old subscription and treat detailed events as invalidations.
- **Stop:** Every race converges and burst work stays bounded.

### Commit 7.2: `refactor: publish list invalidations only`

- **Tests:** Require `list_changed` after each durable session mutation and completed Delete. A tracked old `subscribe` receives `CLIENT_RESTART_REQUIRED` with the exact instruction. The bridge frontend displays it once and stops retrying. New roots omit `index/events.jsonl` and `daemon/event-acks.json`.
- **Implementation:** Replace list events with an in-memory broadcaster in `runtime/daemon.mjs` and `runtime/reconciliation.mjs`. Reject old `subscribe`; do not replay retired events. Keep new-frontend fallback only against an old daemon.
- **Stop:** Write, notification, and snapshot order is deterministic; an old frontend displays one instruction and exits its loop.

### Commit 7.3: `refactor: remove list cursor persistence`

- **Tests:** Replace cursor-save tests with cursor-free view-state and draft tests. Load and discard a legacy cursor. Remove `runtime/event-store.test.mjs` only after production callers are gone.
- **Implementation:** Remove list cursor saves, acknowledgements, replay queues, resynchronization markers, and cursor comparison. Delete `runtime/event-store.mjs`. Ignore a legacy cursor in `app/list/frontend-state.mjs` and obsolete event files during migration and recovery.
- **Stop:** New state omits cursor, legacy state loads, and no list event store opens.

## Change 8: three dashboards keep independent state and exactly one writer

**Outcome:** Three dashboards do not overwrite one another's drafts or selections. On one session, exactly one can type; both observers learn when that writer leaves and may race for one new composer grant. Claims live with their sockets, so obsolete attachment state cannot block startup.

**Estimate:** 2 commits, 1.5 to 2 engineer-days, net deletion of 200 to 400 lines.

### Commit 8.1: `feat: notify viewers when session access changes`

- **Tests:** Add three dashboards with one writer and two observers. Kill the writer, race both observers, and require one winner. Cover writer close during grant, repeated claim, all-client reconnect, and disappearance mid-command. The command completes or becomes `DELIVERY_UNKNOWN`; observers get `writerPresent: false`, remain observers, and mutate only after explicit acquisition.
- **Implementation:** Send connection-scoped `session_access_changed` with role, `writerPresent`, and generation. Grant and release under the per-session lock. Socket close releases and notifies. Add explicit composer acquisition; never auto-promote.
- **Stop:** Repeated races always produce one writer, and notifications expose no stable peer identity.

### Commit 8.2: `refactor: remove durable attachments and isolate frontend state`

- **Tests:** Replace durable ordering tests with per-session lock tests. Ignore corrupt obsolete `daemon/attachment-results.jsonl`. Open three dashboards, change each draft and selection, close in different orders, and require independent state. Restarting the daemon clears claims while workers retain exact identity.
- **Implementation:** Remove `AttachmentResultStore`, attach/detach journal transitions, attachment list events, failpoints, and recovery. Delete `runtime/attachment-result-store.mjs` and ignore its old file. Generate a process-scoped frontend connection ID at startup. Keep view state and launch drafts in that process; process death may lose an unsubmitted draft. Retain stable installation identity only for durable command recovery.
- **Stop:** No attachment artifact is created or reconciled; three dashboards retain independent state; Gate 3 passes.

## Change 9: obsolete acknowledgement files cannot block recovery

**Outcome:** A corrupt `.acks.json` no longer blocks recovery. This is otherwise an internal deletion: acknowledgements do not control retention, while ordered viewer events, snapshots, queues, stable IDs, and resume behavior remain.

**Estimate:** 2 commits, 0.5 to 1 engineer-day, net deletion of 100 to 180 lines.

### Commit 9.1: `refactor: keep viewer resume state in the frontend`

- **Tests:** In `app/viewer/viewer-controller.test.mjs`, disconnect before processing, after processing, and after local cursor advancement. A repeated stable event ID must not duplicate transcript content.
- **Implementation:** Remove frontend `ack_viewer` calls. Advance the in-memory cursor only after successful application. Keep ordered events, snapshots, bounded queues, and stable IDs.
- **Stop:** No item is skipped or duplicated in all three windows.

### Commit 9.2: `refactor: retire viewer acknowledgement files`

- **Tests:** Corrupt event, checkpoint, or snapshot state still fails; corrupt `.acks.json` is ignored. An old frontend's `ack_viewer` gets a no-op response and writes nothing.
- **Implementation:** Remove acknowledgement loading and methods from `runtime/viewer-store.mjs`. Keep `ack_viewer` as a no-op for one compatibility release. Stop creating acknowledgement paths and ignore old files.
- **Stop:** No `.acks.json` changes, and Gate 4 transcript checks pass.

## Change 10: Delete remains forget-only without unused recovery failures

**Outcome:** Delete still removes only the dashboard row and preserves the Pi file and worktree. Missing or empty legacy transaction state cannot fail startup; a nonempty legacy transaction still stops startup for explicit resolution.

**Estimate:** 2 commits, 0.5 to 1.5 engineer-days, net deletion of 200 to 400 lines.

### Commit 10.1: `refactor: make Delete forget-only`

- **Tests:** In `test/destructive-actions.integration.test.mjs`, cover inactive, live, attached, stale metadata, changed revision, and concurrent relaunch. Every success preserves the canonical Pi file and worktree.
- **Implementation:** Remove `trashSessionFile`. Keep revision, inactive state, attachment, ownership, launch, metadata, route, exact process identity, and per-session lock checks before registry removal.
- **Stop:** Successful Delete changes only registry and journal artifacts. Any filesystem call using the canonical session path fails the test.

### Commit 10.2: `refactor: retire trash recovery`

- **Tests:** Start with absent, empty, and nonempty old delete-result files. The first two start; the third fails with `UNSUPPORTED_LEGACY_DELETE_TRANSACTION` before mutation.
- **Implementation:** Remove the delete-result store, transaction phases, destructive failpoints, file fingerprints, and reconciliation. Retain the old file and add the nonempty guard.
- **Stop:** Gate 0 found no production entry; temporary-root migration tests and Gate 4 Delete checks pass.

## Withdrawn change: replay narrowing

Do not implement the earlier replay-narrowing proposal. It is separate from active commits 7.1 and 7.2 above. Deleting `session_query` removes three proposed read subtypes. Initial state and menu discovery have no documented failure. A direct-read dispatcher would add a second worker path immediately after change 5 removes one. Reconsider only with a measured replay cost or concrete recovery failure.

## Operator-machine gates

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

## Compatibility and rollback

| Change | Boundary | Mixed-version behavior | Operator action | Rollback |
|---|---|---|---|---|
| 1 to 3 | Frontend, daemon, worker requests | Old clients may send removed operations and receive `FEATURE_REMOVED`; new clients do not advertise them | Restart a stale frontend when it shows a removed command | Revert; no migration |
| 4 and 8 | Connection roles | Old frontend rejects observer; new frontend opens it. Claims die with sockets | None for worker lifetime | Restart daemon to clear claims |
| 5 | Worker IPC and socket | New worker retains IPC with old daemon. Existing workers reconnect by socket | Restart daemon at Gate 1, never workers | Restart old daemon |
| 6 | Session field meaning | Schema remains version 1; fields remain optional | Use disposable launches | Safe; new values have stronger provenance |
| 7 | List protocol | Bridge tracks refusal while retaining old replay. Following release uses `subscribe_list_changes` and refuses tracked old `subscribe` | Restart after the instruction appears; no close-before-daemon-restart sequence | Restart old daemon and read registry snapshot |
| 9 | Viewer acknowledgement | New daemon answers old acknowledgement as a no-op for one release | None | Safe; old files remain |
| 10 | Delete result file | Empty old store is accepted; nonempty store blocks startup | Resolve with old release before rollout | Safe; file remains |

No change automatically deletes an obsolete durable file. This preserves rollback and avoids an implicit migration.

## File collisions

| Files | Changes | Merge rule |
|---|---|---|
| `runtime/daemon.mjs`, `runtime/daemon.integration.test.mjs` | 1, 2, 5, 6, 7, 8, 9, 10 | Serial; rebase after each change |
| `shared/contracts.mjs`, `shared/contracts.test.mjs` | 1, 2, 3, 7, 8, 9 | Feature deletion, list, access, acknowledgements |
| `app/viewer/viewer-controller.mjs` and test | 1, 2, 3, 4, 8, 9 | Serial; update observer mutation matrix after each deletion |
| `app/viewer/slash-commands.mjs` and test | 1, 2, 3 | Listed order; do not combine commits during conflict resolution |
| `app/list/standalone-list.mjs` and test | 1, 4, 7, 8 | Queries, observer opening, list protocol, identities |
| `app/daemon-client.mjs` and test | 7, 8, 9 | List protocol, access, acknowledgements |
| `runtime/worker.mjs` and tests | 1, 2, 3, 5 | Feature deletions before transport |
| `runtime/worker-supervisor.mjs` and tests | 2, 3, 5, 6 | Feature deletions, handoff, confirmed model |
| `runtime/state-migration.mjs` and test | 7, 8, 9, 10 | One compatibility pass after each retired artifact |
| `docs/architecture.md`, `docs/development.md` | all | Update serially after production commits |

## Exclusions

- Keep the daemon, workers, leases, process identity and process-group checks, signaling revalidation, worktree isolation, locks, sweeps, and cleanup.
- Keep summaries opt-in and do not call a summary provider in tests.
- Keep ordered viewer events; list invalidation does not replace them.
- Do not add local-socket heartbeats, auto-promotion, or cancellation of accepted commands on disconnect.
- Do not compact, rewrite, or delete historical state files.
- Keep state migration separate; do not fold launch results into the journal or change its schema.
- Do not add a second worker read dispatcher.
- Do not claim the unmeasured 3 ms list snapshot latency. Measure it at Gate 3 before making a performance claim.
