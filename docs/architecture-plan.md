# Architecture implementation plan

After these 19 commits:

- Commands work the same on a newly launched session and after a daemon restart. Graceful Stop no longer waits through its timeout solely because a route is absent.
- Several terminals may open one session. Exactly one may type; the others remain read-only and can explicitly claim composer after it becomes vacant.
- Several dashboards keep independent drafts and selections. A stale list cursor cannot crash dashboard startup.
- A session row shows a model only after Pi confirms that model.
- Delete continues to forget only the dashboard row. It preserves the canonical Pi file and worktree.
- The daemon and workers continue running when terminal clients exit.

Approve the work as 19 green commits in one release, with five operator-machine gates protecting the live daemon and two live sessions. Estimated effort is 7.5 to 11.5 engineer-days, up from the previous 6.5 to 10 engineer-days. This is an estimate, not measured work. It includes tests, gates, and documentation. It excludes review time and maintenance-window waits.

The resulting process model is one daemon per state root, many terminal clients, one worker per live Pi session, and at most one composer connection per session. Any number of observers may open a session read-only.

## The operator settled all eight decisions

| # | Decision | Settled answer |
|---|---|---|
| 1 | Model admission validation | Validate in the daemon after journal acceptance and before launch resolution. The frontend picker remains an early check. Daemon validation covers command-line, stale frontend, and direct protocol clients. |
| 2 | Refused launch artifacts | A known admission refusal leaves a terminal `FAILED` journal result and no session record, Pi file, worktree, worker, or list row. Its status-line message remains until the operator's next keystroke or action. A failure after preparation keeps the failed row because side effects and cleanup evidence exist. |
| 3 | Unavailable model catalog | Record the diagnostic and let Pi decide. `MODEL_CATALOG_FAILED` remains distinct from `MODEL_UNKNOWN`. |
| 4 | Unused trash seam | Remove it. Delete continues to forget only the dashboard record. Any future command that deletes Pi files needs separate wording and recovery. |
| 5 | List protocol rollout | Ship only `subscribe_list_changes`. Restart the daemon and every dashboard together. Do not add an old-daemon fallback or a special refusal for old `subscribe`; mixed releases are unsupported. |
| 6 | Retired durable files | Stop opening obsolete files. Leave them on disk during rollout, but add no parser, corrupt-file branch, migration test, or explicit ignore path. Once no production code names them, they are ignored at zero code cost. On the operator's machine on 2026-08-29, they are `index/events.jsonl` at 18 MB, `daemon/attachment-results.jsonl` at 679 KB, 14 `index/viewer/*.acks.json` files, and `daemon/event-acks.json` at 512 bytes. |
| 7 | Legacy trash transactions | Remove every reference to `daemon/delete-results.json`. Do not parse, validate, migrate, delete, or test old contents. The file was absent on the operator's machine on 2026-08-29, and production never supplied a trash callback. |
| 8 | Worker socket handoff | Bind Pi identity, authenticate and adopt the socket, persist readiness, send `handoff_to_socket`, receive its acknowledgement, then disconnect inter-process communication (IPC). Socket adoption by exact process identity is the normal daemon-start path, not a migration fallback. |

## Settled feature scope

1. Support several terminals and dashboards. Composer and observer roles are connection-scoped; add the missing read-only viewer.
2. Delete `/stats`, `/tree`, `/export`, `session_query`, and its payload shape from every layer.
3. Delete `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up`, including commands, projections, adapter methods, and tests.
4. Keep worktree isolation, ownership locks, sweeps, and cleanup.
5. Keep `/model`. Delete `/thinking`, its picker, `set_thinking_level`, and requested thinking level from dashboard launch.
6. Keep summaries opt-in. Summary model settings remain dashboard settings, not Pi settings passthrough.

Keep one composer and read-only observers. Claude Code's [shared typing](reference/claude-code-behavior.md#linux-clients-share-one-editor-and-one-terminal-size) was considered and rejected because these clients send structured commands with durable delivery stages rather than raw terminal bytes.

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
- Session rows use [structured worker state](reference/claude-code-behavior.md#structured-state-and-terminal-rendering-remain-separate) only. Terminal bytes and the canonical JSONL never determine working state.
- A daemon upgrade [adopts compatible live workers before judging their release version](reference/claude-code-behavior.md#release-changes-adopt-workers-before-replacing-them). Stale workers continue until an idle replacement boundary or explicit operator action, and an older daemon never replaces a newer worker automatically.
- One session has at most one composer connection and any number of observers.
- Socket loss releases a composer claim but does not cancel an accepted command.
- Worktree creation, locks, sweeps, cleanup, and opt-in summaries remain unchanged.

## Sequence and concurrent work

| Step | Required serial path | What becomes true | Gate after step |
|---:|---|---|---|
| 1 | Baseline inspection | The live daemon and both sessions have an exact, recorded starting identity. | Gate 0 |
| 2 | Changes 1 through 3 | Broken and Pi-owned controls no longer appear; `/model` and observed thinking remain. | |
| 3 | Change 4 | A second or third terminal opens an occupied session read-only instead of showing `SESSION_IN_USE`. | |
| 4 | Changes 5.1 through 5.5 | Commands, frames, replies, reconnect, and graceful Stop use one adopted route. A new daemon starts with compatible live workers, marks old worker code stale, and replaces it only at a safe boundary. | |
| 5 | Change 6 | A row never shows an unconfirmed requested model. | |
| 6 | Changes 7.1 through 7.3 | Dashboard startup reads current rows instead of replaying history; one required snapshot cursor closes subscribe races. | |
| 7 | Changes 8.1 and 8.2 | Three dashboards keep independent state, see writer departure, and produce exactly one composer after a race. | |
| 8 | Changes 9 and 10 | Obsolete acknowledgement and trash recovery code is gone; Delete remains forget-only. | Gates 1 through 4 |

Work may proceed independently only as follows:

- Trash removal may start after Gate 0. It shares `runtime/daemon.mjs`, so merge it only after the serial branch is current.
- Viewer acknowledgement removal may be prepared after the list contract is fixed. It shares `app/daemon-client.mjs` and `shared/contracts.mjs` with list invalidation.
- Three-client fixture design may proceed during feature deletion. Production attachment changes wait for list invalidation because attachment recovery currently emits list events.

Protocol rules apply throughout:

- Worker readiness, socket adoption, and IPC handoff are one decision.
- `subscribe_list_changes` ships without old `subscribe` support or a new-frontend fallback. The operator restarts the daemon and every dashboard together.
- [Exact-identity socket adoption](reference/claude-code-behavior.md#the-roster-is-an-adoption-record) is the normal daemon-start path. Release skew is evaluated only after compatible live workers are adopted.
- A live dashboard gets a process-scoped connection ID. Durable command recovery may retain the stable installation ID and request ID.
- `session_access_changed` carries `sessionId`, the receiving connection's role, `writerPresent`, and an in-memory generation. It carries no peer client ID.
- Observers explicitly request composer after a vacancy. The per-session lock decides races. Accepted commands continue after disconnect.

## Claude Code evidence changes the upgrade path, not the viewer contract

Adopt these findings in priority order:

1. Adopt [socket authentication and exact process identity](reference/claude-code-behavior.md#the-roster-is-an-adoption-record) now. Changes 5.1 through 5.3 already make authenticated socket adoption the normal daemon-start path and the readiness boundary. The gates verify PID plus process-start identity, so this needs no duplicate commit.
2. Use [structured row state](reference/claude-code-behavior.md#structured-state-and-terminal-rendering-remain-separate) only. The invariant above bars terminal-byte and canonical JSONL inference. Change 5.5 may use only structured idle state when replacing a stale worker.
3. Handle [release skew through adoption](reference/claude-code-behavior.md#release-changes-adopt-workers-before-replacing-them) now. Changes 5.4 and 5.5 adopt compatible live workers before release comparison, mark old worker code stale, replace it at idle or by explicit action, and refuse automatic downgrade. This preserves live work across an upgrade; it does not support old releases after restart.
4. Defer an [owned pseudo-terminal (PTY) viewer](reference/claude-code-behavior.md#attach-becomes-usable-after-a-native-repaint). Reconsider it when Pi exposes structured state, command, repaint, and detach channels. Acceptance requires structured row state, durable command stages, authenticated Stop, one writer, late-attach repaint, and daemon-independent worker lifetime. Agent-aware detach is part of that viewer, not a host-level key binding.
5. Defer a [256 KiB in-memory diagnostic tail](reference/claude-code-behavior.md#attach-becomes-usable-after-a-native-repaint). Existing run logs and rotating diagnostics already capture failures, and no `logs` command is in scope. Add a commit only when measured startup diagnosis needs recent output through a `logs` command. Acceptance requires a strict 256 KiB bound, process-local lifetime, secrets review, and no use as canonical viewer history.
6. Defer [prewarmed spares](reference/claude-code-behavior.md#each-session-has-one-pty-host-and-one-agent). Trigger reconsideration with measured Pi launch latency and resident memory. Acceptance requires a measured launch improvement that justifies resident memory, a bounded spare count, authenticated claiming, stale-version replacement, and cleanup tests.

The implementable behavior is in the [Claude Code behavioral reference](reference/claude-code-behavior.md). The investigation and source list remain in [Claude Code session model](claude-code-session-model.md).

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

**Estimate:** 5 commits, 4 to 6 engineer-days, net deletion of 200 to 400 lines after changes 1 through 3.

### Commit 5.1: `refactor: specify worker socket handoff`

- **Tests:** Add `keeps IPC until the daemon adopts the authenticated socket route` in `runtime/worker-supervisor.test.mjs`; daemon-start adoption cases in `runtime/worker.integration.test.mjs`; and wrong run, lease, generation, token, and process identity cases in `runtime/reconciliation.failure.test.mjs`.
- **Implementation:** Add internal version 1 `connect_socket`, `socket_ready`, `handoff_to_socket`, and `socket_handoff_complete` messages in `runtime/installed-pi-worker.mjs`, `runtime/worker-supervisor.mjs`, and `runtime/worker.mjs`. Make authenticated socket adoption the normal startup and restart path. Keep route generation and exact identity authoritative in `runtime/reconciliation.mjs`. Keep IPC open until the daemon acknowledges the adopted route.
- **Stop:** Temporary-root tests reach one authenticated route on initial daemon start and restart.

### Commit 5.2: `refactor: move worker traffic to the socket`

- **Tests:** Invert fresh-launch delivery in `runtime/daemon.integration.test.mjs` to require the adopted socket. Cover prompt, follow-up message, steer, interrupt, UI response, model, compact, rename, menu, initial state, frames, and Stop. Send frames before, during, and after handoff; stable source IDs occur once and in order.
- **Implementation:** Route ongoing frames, events, commands, replies, `askWorker`, activation, and frame ingestion through `RecoveredWorkerRouter`. Remove ongoing payload projection and reply handling from the launch handle.
- **Stop:** Every operation passes before and after simulated daemon restart. IPC remains open pending final acknowledgement.

### Commit 5.3: `refactor: make socket adoption the ready boundary`

- **Tests:** Require Pi bind plus socket adoption in `runtime/worker-supervisor.test.mjs`. Inject failure before and after Pi bind and before and after route adoption. Add `graceful Stop uses the current launch socket before escalation` in `test/destructive-actions.integration.test.mjs`. Assert `sessionHandles` and launch delivery handles are absent after readiness.
- **Implementation:** Register bound identity, request connection, verify the route, persist readiness, complete handoff, then disconnect IPC. Route graceful shutdown through the locked socket and stop policy. Delete `sessionHandles`, route-versus-handle branches, launch-channel pending replies, and duplicate buffering.
- **Risk:** IPC disconnect may look like worker exit; a daemon crash during handoff may strand the worker.
- **Stop:** Every injected window converges to one route or a terminal failed launch, and Gate 1 passes.

### Commit 5.4: `feat: adopt compatible workers across upgrades`

- **Tests:** Start a new daemon against compatible live workers with older, equal, and newer release metadata. Require exact PID plus process-start identity and route authentication before startup becomes ready. Older workers remain live and become `STALE`; equal workers remain current; incompatible protocol versions remain unavailable without signaling their processes.
- **Implementation:** Persist the dashboard release and worker protocol beside each worker identity. During ordinary daemon startup, adopt every protocol-compatible route first, then compare release versions. Expose stale code as worker metadata without refusing daemon or list startup. Do not add dual protocol parsers.
- **Stop:** Gate 1 keeps both original worker identities and reports their release status after the new daemon starts.

### Commit 5.5: `feat: replace stale workers at a safe boundary`

- **Tests:** Keep a busy stale worker unchanged. Replace a stale worker only after structured state reports idle or an explicit operator command requests replacement. Preserve the canonical Pi session and command-journal stages. Refuse an automatic replacement when the worker release is newer than the daemon.
- **Implementation:** Add one serialized replacement operation under the session lifecycle and ownership checks. Schedule it from structured idle state or the explicit administrative command. Revalidate worker and Pi identity at the replacement boundary. Record downgrade refusal as diagnostics and leave the newer worker running.
- **Risk:** A false idle fact could interrupt work. Only structured worker state may open the automatic boundary.
- **Stop:** Busy workers survive upgrades, idle stale workers replace once, explicit replacement uses the same guarded path, and automatic downgrade never signals the worker.

## Change 6: rows show only models that Pi confirmed

**Outcome:** A failed launch never displays a requested model that Pi did not run. The row remains unset until Pi confirms its model at readiness.

**Estimate:** 1 commit, 0.5 to 1 engineer-day.

### Commit 6: `fix: record only Pi-confirmed session model`

- **Tests:** In `runtime/launch-resolver.test.mjs`, keep requested model in worker arguments but not the prepared record. In `runtime/daemon.integration.test.mjs`, cover default selection, accepted request, Pi substitution, omitted model, failure before and after spawn, and restart. Cover catalog-listed, known absent, unavailable catalog, and no requested model. Assert `MODEL_CATALOG_FAILED` remains distinct from `MODEL_UNKNOWN`. A known admission refusal leaves a terminal `FAILED` journal result but no session record, Pi file, worktree, worker, or row. Its status-line message remains until the next keystroke or action. A failure after preparation retains its `FAILED` row.
- **Implementation:** Validate model admission in the daemon after journal acceptance and before launch resolution. Stop copying requested model into the prepared record. Carry normalized initial Pi state through socket readiness and apply the confirmed model in the same lifecycle write. Absence remains unknown. A catalog failure records `MODEL_CATALOG_FAILED` and lets Pi decide. Keep Pi-reported thinking display-only. Keep a refusal on the status line until the operator's next keystroke or action; do not clear it on a timer.
- **Stop:** One ready revision contains the Pi-confirmed model; every failure window leaves it absent; Gate 2 passes.

## Change 7: stale list history cannot crash dashboard startup

**Outcome:** The dashboard starts from current registry state instead of replaying thousands of old list records. Burst updates converge to current rows without a queue that grows with the burst. The daemon and dashboards upgrade together.

**Estimate:** 3 commits in 1 release, 1 to 2 engineer-days, net deletion of 350 to 600 lines.

### Commit 7.1: `feat: add race-safe list invalidation`

- **Tests:** In `app/list/dashboard.test.mjs`, cover changes before subscribe, during snapshot, after response, and during reconnect. Replace replay and acknowledgement assertions with final snapshot state. Send 10,000 invalidations and require bounded pending work and at most three reads for one burst plus one change during a read.
- **Implementation:** Add `subscribe_list_changes` and payload-free `list_changed` to `shared/contracts.mjs`. Make the snapshot coverage `cursor` required in every successful `get_state` response. Subscribe, mark dirty, read `get_state`, and refetch once after an in-read notification. Coalesce notifications.
- **Stop:** Every race converges and burst work stays bounded.

### Commit 7.2: `refactor: publish list invalidations only`

- **Tests:** Require `list_changed` after each durable session mutation and completed Delete. Reject `subscribe` as an unknown operation through the ordinary strict contract. New roots omit `index/events.jsonl` and `daemon/event-acks.json`.
- **Implementation:** Replace list events with an in-memory broadcaster in `runtime/daemon.mjs` and `runtime/reconciliation.mjs`. Remove `subscribe` from the contract and do not replay retired events. Add no fallback or special old-protocol response.
- **Stop:** Write, notification, and snapshot order is deterministic. Production contains one list subscription protocol.

### Commit 7.3: `refactor: remove list cursor persistence`

- **Tests:** Replace cursor-save tests with view-state and draft tests. Require the `get_state` coverage cursor and remove `runtime/event-store.test.mjs` only after production callers are gone.
- **Implementation:** Remove list cursor saves, acknowledgements, replay queues, resynchronization markers, and cursor comparison. Delete `runtime/event-store.mjs`. Keep the required snapshot coverage cursor in memory for the subscribe/read race. Remove all production references to `index/events.jsonl` and `daemon/event-acks.json`; the retired files then have no effect without an ignore branch.
- **Stop:** New frontend state omits a persisted cursor, every `get_state` result includes its coverage cursor, and no list event store or retired path opens.

## Change 8: three dashboards keep independent state and exactly one writer

**Outcome:** Three dashboards do not overwrite one another's drafts or selections. On one session, exactly one can type; both observers learn when that writer leaves and may race for one new composer grant. Claims live with their sockets, so obsolete attachment state cannot block startup.

**Estimate:** 2 commits, 1.5 to 2 engineer-days, net deletion of 200 to 400 lines.

### Commit 8.1: `feat: notify viewers when session access changes`

- **Tests:** Add three dashboards with one writer and two observers. Kill the writer, race both observers, and require one winner. Cover writer close during grant, repeated claim, all-client reconnect, and disappearance mid-command. The command completes or becomes `DELIVERY_UNKNOWN`; observers get `writerPresent: false`, remain observers, and mutate only after explicit acquisition.
- **Implementation:** Send connection-scoped `session_access_changed` with role, `writerPresent`, and generation. Grant and release under the per-session lock. Socket close releases and notifies. Add explicit composer acquisition; never auto-promote.
- **Stop:** Repeated races always produce one writer, and notifications expose no stable peer identity.

### Commit 8.2: `refactor: remove durable attachments and isolate frontend state`

- **Tests:** Replace durable ordering tests with per-session lock tests. Open three dashboards, change each draft and selection, close in different orders, and require independent state. Restarting the daemon clears claims while workers retain exact identity.
- **Implementation:** Remove `AttachmentResultStore`, attach/detach journal transitions, attachment list events, failpoints, and recovery. Delete `runtime/attachment-result-store.mjs` and every production reference to `daemon/attachment-results.jsonl`. Generate a process-scoped frontend connection ID at startup. Keep view state and launch drafts in that process; process death may lose an unsubmitted draft. Retain stable installation identity only for durable command recovery.
- **Stop:** No attachment artifact is created or reconciled; three dashboards retain independent state; Gate 3 passes.

## Change 9: obsolete acknowledgement files cannot block recovery

**Outcome:** Viewer acknowledgement files no longer participate in recovery. Ordered viewer events, snapshots, queues, stable IDs, and resume behavior remain.

**Estimate:** 2 commits, 0.5 to 1 engineer-day, net deletion of 100 to 180 lines.

### Commit 9.1: `refactor: keep viewer resume state in the frontend`

- **Tests:** In `app/viewer/viewer-controller.test.mjs`, disconnect before processing, after processing, and after local cursor advancement. A repeated stable event ID must not duplicate transcript content.
- **Implementation:** Remove frontend `ack_viewer` calls. Advance the in-memory cursor only after successful application. Keep ordered events, snapshots, bounded queues, and stable IDs.
- **Stop:** No item is skipped or duplicated in all three windows.

### Commit 9.2: `refactor: retire viewer acknowledgement files`

- **Tests:** Corrupt event, checkpoint, or snapshot state still fails. Remove acknowledgement contract and file-format tests after production callers are gone.
- **Implementation:** Remove acknowledgement loading and methods from `runtime/viewer-store.mjs`. Remove `ack_viewer` from the contract. Stop creating acknowledgement paths and remove every production reference to `index/viewer/*.acks.json`; retired files then have no effect without an ignore branch.
- **Stop:** No `.acks.json` path or `ack_viewer` operation remains, and Gate 4 transcript checks pass.

## Change 10: Delete remains forget-only without unused recovery

**Outcome:** Delete still removes only the dashboard row and preserves the Pi file and worktree. The obsolete `daemon/delete-results.json` format disappears with its unused recovery code.

**Estimate:** 2 commits, 0.5 to 1 engineer-day, net deletion of 200 to 400 lines.

### Commit 10.1: `refactor: make Delete forget-only`

- **Tests:** In `test/destructive-actions.integration.test.mjs`, cover inactive, live, attached, stale metadata, changed revision, and concurrent relaunch. Every success preserves the canonical Pi file and worktree.
- **Implementation:** Remove `trashSessionFile`. Keep revision, inactive state, attachment, ownership, launch, metadata, route, exact process identity, and per-session lock checks before registry removal.
- **Stop:** Successful Delete changes only registry and journal artifacts. Any filesystem call using the canonical session path fails the test.

### Commit 10.2: `refactor: retire trash recovery`

- **Tests:** Remove delete-result transaction tests after the production callers are gone. Keep forget-only lifecycle and revision tests.
- **Implementation:** Remove the delete-result store, transaction phases, destructive failpoints, file fingerprints, reconciliation, legacy guard, and every production reference to `daemon/delete-results.json`.
- **Stop:** No production or test code names `daemon/delete-results.json`. Gate 4 Delete checks pass.

The guard and compatibility parser are intentionally absent. On 2026-08-29, `daemon/delete-results.json` was absent on the operator's machine. Production never supplied a trash callback, so no shipped code path could have created a nonempty transaction.

## Withdrawn change: replay narrowing

Do not implement the earlier replay-narrowing proposal. It is separate from active commits 7.1 and 7.2 above. Deleting `session_query` removes three proposed read subtypes. Initial state and menu discovery have no documented failure. A direct-read dispatcher would add a second worker path immediately after change 5 removes one. Reconsider only with a measured replay cost or concrete recovery failure.

## Operator gates protect live sessions, not old releases

Tests use a temporary state root. These gates never write state files directly, signal workers, or run a second daemon against production.

### Gate 0: read-only preflight

Record the installed commit and daemon version; daemon PID, start identity, epoch, and recovery state; both live session IDs; worker and Pi identities; route generations; and the retired files. The 2026-08-29 baseline is `index/events.jsonl` at 18 MB, `daemon/attachment-results.jsonl` at 679 KB, 14 `index/viewer/*.acks.json` files, `daemon/event-acks.json` at 512 bytes, and no `daemon/delete-results.json`. Read one list and viewer snapshot through the public client.

Stop if identity is ambiguous, recovery is not `READY`, or a live session lacks exact worker and Pi identity.

### Gate 1: worker adoption and coordinated client restart

Install the single release, exit every dashboard, then restart only the daemon through the normal command. Start new dashboards after daemon readiness. Verify each dashboard reads a `get_state` response with the required coverage cursor, shows the current snapshot, and receives later invalidations. Do not run mixed frontend and daemon releases.

Verify both original workers retain PID, start identity, process group, run ID, lease generation, and one route. Confirm the new daemon adopts them before release comparison, marks older compatible worker code stale without refusing startup, and does not replace a busy worker. Launch one disposable session and verify IPC closes only after Pi identity is bound, the socket is adopted, readiness is persisted, handoff is sent, and its acknowledgement arrives. Exercise idle and explicit stale replacement only on disposable sessions. Run every remaining operation and graceful Stop only on disposable work.

Stop on original worker identity change, zero or two routes, duplicate delivery, lost frame, startup refusal caused only by stale compatible worker code, automatic downgrade, a new dashboard that does not converge, or escalation after successful graceful shutdown.

### Gate 2: confirmed model

Launch disposable default, valid named, substituted, and invalid model cases. Verify no row shows a model before Pi reports it. Verify a known admission refusal writes a terminal `FAILED` journal result but creates no session record, Pi file, worktree, worker, or row. Confirm its status-line message survives timers and remains until the next keystroke or action. Verify a failure after preparation keeps its `FAILED` row, catalog failure lets Pi decide, `MODEL_CATALOG_FAILED` stays distinct from `MODEL_UNKNOWN`, and daemon restart retains workers and confirmed values.

### Gate 3: three dashboards and list convergence

Open three new dashboards. Verify independent drafts and selections, final rows matching `get_state`, 100 or more state changes converging without queue growth, one writer and two observers on one session, read-only observer behavior, writer terminal kill releasing the claim, notification to both observers, and exactly one winner when both claim.

Restart the daemon. Verify claims clear, workers retain identity, and no production code opens obsolete list or attachment paths.

### Gate 4: final viewer and Delete behavior

With both original workers live, force frontend reconnect during viewer events and verify no missing or duplicate transcript item. Verify no production code opens a viewer acknowledgement path. Delete one disposable inactive session and verify its Pi file and worktree remain.

Stop on transcript loss, a retired path opening, path deletion, or worker loss.

## Upgrade policy protects live work without backward compatibility

The release supports one frontend protocol, one daemon protocol, and current durable formats. The operator restarts every dashboard and the daemon together. The plan removes the old-daemon list fallback, special handling for old `subscribe`, the `ack_viewer` no-op, optional `get_state.cursor`, legacy frontend cursor loading, retired-file parsers and corrupt-file branches, and rollback checks against the previous release. It also removes dual route branches once socket adoption is ready.

Retired files remain on disk because leaving an unreferenced path alone costs no production code. No implementation or test parses, validates, migrates, deletes, or explicitly ignores `index/events.jsonl`, `daemon/event-acks.json`, `daemon/attachment-results.jsonl`, `index/viewer/*.acks.json`, or `daemon/delete-results.json`.

One mixed-release case remains by design. A new daemon adopts protocol-compatible live workers by authenticated socket and exact process identity, then marks old code stale. It keeps a busy stale worker alive until structured state reports idle or the operator explicitly requests replacement. This exception protects unsaved live work. It is not support for starting old workers, old frontends, old protocols, or old on-disk formats. Automatic downgrade is refused.

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
| `runtime/state-migration.mjs` and test | 7, 8, 9, 10 | Delete retired-format branches; do not add replacement parsers |
| `docs/architecture.md`, `docs/development.md` | all | Update serially after production commits |

## Exclusions

- Keep the daemon, workers, leases, process identity and process-group checks, signaling revalidation, worktree isolation, locks, sweeps, and cleanup.
- Keep summaries opt-in and do not call a summary provider in tests.
- Keep ordered viewer events; list invalidation does not replace them.
- Do not add local-socket heartbeats, auto-promotion, or cancellation of accepted commands on disconnect.
- Do not compact, rewrite, delete, parse, or migrate retired historical state files.
- Keep state migration separate for current formats; do not fold launch results into the journal or change its schema.
- Do not add a second worker read dispatcher.
- Do not infer row activity from terminal output or the canonical Pi JSONL.
- Do not add old frontend, protocol, durable-format, or rollback support. The only release-skew path adopts compatible live workers to protect current work.
- Do not claim the unmeasured 3 ms list snapshot latency. Measure it at Gate 3 before making a performance claim.
