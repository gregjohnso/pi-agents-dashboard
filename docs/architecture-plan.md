# Architecture implementation plan

After these 20 commits:

- Commands work the same on a newly launched session and after a daemon restart. Graceful Stop no longer waits through its timeout solely because a route is absent.
- Every attached client may read and write the same session. The daemon serializes and journals accepted commands.
- Several dashboards keep independent drafts and selections. A stale list cursor cannot crash dashboard startup.
- `agents`, `attach`, `logs`, `stop`, and `rm` match Claude Code's operator-facing verbs.
- A session row shows a model only after Pi confirms that model.
- `rm` forgets only the dashboard row. It preserves the canonical Pi file and worktree.
- The daemon and workers continue running when terminal clients exit or the daemon is absent.

Approve the work as 20 green commits in one release, with five operator-machine gates protecting the live daemon and two live sessions. The old plan had 19 commits and estimated 7.5 to 11.5 engineer-days. This revision removes two access-control commits and adds three commits for diagnostics, command names, and launch measurement. The new estimate is 7.5 to 12 engineer-days. This is an estimate, not measured work. It includes tests, gates, and documentation. It excludes review time and maintenance-window waits.

The resulting process model is one daemon per state root, many read-write terminal clients, and one worker per live Pi session. The daemon orders commands per session and records their delivery stages.

## The operator settled all eight decisions

| # | Decision | Settled answer |
|---|---|---|
| 1 | Model admission validation | Validate in the daemon after journal acceptance and before launch resolution. The frontend picker remains an early check. Daemon validation covers command-line, stale frontend, and direct protocol clients. |
| 2 | Refused launch artifacts | A known admission refusal leaves a terminal `FAILED` journal result and no session record, Pi file, worktree, worker, or list row. Its status-line message remains until the operator's next keystroke or action. A failure after preparation keeps the failed row because side effects and cleanup evidence exist. |
| 3 | Unavailable model catalog | Record the diagnostic and let Pi decide. `MODEL_CATALOG_FAILED` remains distinct from `MODEL_UNKNOWN`. |
| 4 | Unused trash seam | Remove it. `rm` continues to forget only the dashboard record. Any future command that deletes Pi files needs separate wording and recovery. |
| 5 | List protocol rollout | Ship only `subscribe_list_changes`. Restart the daemon and every dashboard together. Do not add an old-daemon fallback or a special refusal for old `subscribe`; mixed releases are unsupported. |
| 6 | Retired durable files | Stop opening obsolete files. Leave them on disk during rollout, but add no parser, corrupt-file branch, migration test, or explicit ignore path. Once no production code names them, they are ignored at zero code cost. On the operator's machine on 2026-08-29, they are `index/events.jsonl` at 18 MB, `daemon/attachment-results.jsonl` at 679 KB, 14 `index/viewer/*.acks.json` files, and `daemon/event-acks.json` at 512 bytes. |
| 7 | Legacy trash transactions | Remove every reference to `daemon/delete-results.json`. Do not parse, validate, migrate, delete, or test old contents. The file was absent on the operator's machine on 2026-08-29, and production never supplied a trash callback. |
| 8 | Worker socket handoff | Bind Pi identity, authenticate and adopt the socket, persist readiness, send `handoff_to_socket`, receive its acknowledgement, then disconnect inter-process communication (IPC). Socket adoption by exact process identity is the normal daemon-start path, not a migration fallback. |

## Settled feature scope

1. Support several read-write terminals and dashboards. Delete composer and observer roles, grants, releases, and `SESSION_IN_USE`.
2. Delete `/stats`, `/tree`, `/export`, `session_query`, and its payload shape from every layer.
3. Delete `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up`, including commands, projections, adapter methods, and tests.
4. Keep worktree isolation, ownership locks, sweeps, and cleanup.
5. Keep `/model`. Delete `/thinking`, its picker, `set_thinking_level`, and requested thinking level from dashboard launch.
6. Keep summaries opt-in. Summary model settings remain dashboard settings, not Pi settings passthrough.

7. Any client may write. Approved by the operator on 2026-08-29, replacing his earlier choice of one composer with read-only observers. This adopts Claude Code's [shared typing](reference/claude-code-behavior.md#linux-clients-share-one-editor-and-one-terminal-size). The daemon already serializes each session's work and journals every accepted command, so a second client adds ordered commands rather than untracked terminal-byte interleaving. Delete roles, grants, releases, takeover races, access-change notifications, recovery for claims, and `SESSION_IN_USE`.

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
- Every attached client may issue mutations. The per-session coordinator orders them, and journal acceptance is the durable boundary.
- Socket loss does not cancel an accepted command.
- Worktree creation, locks, sweeps, cleanup, and opt-in summaries remain unchanged.

## Sequence and concurrent work

| Step | Required serial path | What becomes true | Gate after step |
|---:|---|---|---|
| 1 | Baseline inspection | The live daemon and both sessions have an exact, recorded starting identity. | Gate 0 |
| 2 | Changes 1 through 3 | Broken and Pi-owned controls no longer appear; `/model` and observed thinking remain. | |
| 3 | Changes 5.1 through 5.5 | Commands, frames, replies, reconnect, and graceful Stop use one adopted route. A new daemon starts with compatible live workers, marks old worker code stale, and replaces it only at a safe boundary. | |
| 4 | Change 6 | A row never shows an unconfirmed requested model. | |
| 5 | Changes 7.1 through 7.3 | Dashboard startup reads current rows instead of replaying history; one required snapshot cursor closes subscribe races. | |
| 6 | Change 8 | Three dashboards keep independent local state, and every attached client can submit ordered, journaled commands. | |
| 7 | Changes 9 through 12 | Obsolete acknowledgement and trash recovery code is gone; diagnostics and command names match Claude Code; `rm` remains forget-only. | |
| 8 | Change 13 | Cold-launch latency, launch-stage timing, and resident memory are measured before a spare is implemented. | Gates 1 through 4 |

Work may proceed independently only as follows:

- Trash removal may start after Gate 0. It shares `runtime/daemon.mjs`, so merge it only after the serial branch is current.
- Viewer acknowledgement removal may be prepared after the list contract is fixed. It shares `app/daemon-client.mjs` and `shared/contracts.mjs` with list invalidation.
- Three-client fixture design may proceed during feature deletion. Production viewer changes wait for list invalidation because attachment recovery currently emits list events.

Protocol rules apply throughout:

- Worker readiness, socket adoption, and IPC handoff are one decision.
- `subscribe_list_changes` ships without old `subscribe` support or a new-frontend fallback. The operator restarts the daemon and every dashboard together.
- [Exact-identity socket adoption](reference/claude-code-behavior.md#the-roster-is-an-adoption-record) is the normal daemon-start path. Release skew is evaluated only after compatible live workers are adopted.
- A live dashboard gets a process-scoped connection ID. Durable command recovery retains the stable installation ID and request ID.
- `attach` authenticates the client and subscribes it to current viewer state. It grants no role. Any attached client may submit a command.
- The per-session coordinator orders concurrent commands. Accepted commands continue after disconnect.

## Claude Code evidence changes access, diagnostics, naming, and the upgrade path

Adopt these findings in priority order:

1. Adopt [socket authentication and exact process identity](reference/claude-code-behavior.md#the-roster-is-an-adoption-record) now. Changes 5.1 through 5.3 already make authenticated socket adoption the normal daemon-start path and the readiness boundary. The gates verify PID plus process-start identity, so this needs no duplicate commit.
2. Use [structured row state](reference/claude-code-behavior.md#structured-state-and-terminal-rendering-remain-separate) only. The invariant above bars terminal-byte and canonical JSONL inference. Change 5.5 may use only structured idle state when replacing a stale worker.
3. Handle [release skew through adoption](reference/claude-code-behavior.md#release-changes-adopt-workers-before-replacing-them) now. Changes 5.4 and 5.5 adopt compatible live workers before release comparison, mark old worker code stale, replace it at idle or by explicit action, and refuse automatic downgrade. This preserves live work across an upgrade; it does not support old releases after restart.
4. Adopt [shared typing](reference/claude-code-behavior.md#linux-clients-share-one-editor-and-one-terminal-size) now. Delete Change 4 and Change 8.1. Change 8 keeps only frontend-state isolation and removal of durable attachment recovery. Structured commands are safer than Claude Code's terminal bytes because the daemon serializes and journals them.
5. Adopt a `logs` command now. It reads a bounded 256 KiB tail from the existing per-run log, so startup failures expose the underlying Pi diagnostic without adding a second in-memory buffer. The tail is diagnostic output, not viewer history.
6. Adopt Claude Code's verbs now. Rename the dashboard's session list entry point to `agents`, session opening to `attach`, `session stop` to `stop`, and `session delete` to `rm`. Keep `session cleanup` and `session resolve-delivery` as advanced recovery commands because Claude Code has no equivalent operation.
7. Measure prewarmed spares now. Change 13 records 30 cold launches from journal acceptance to Pi readiness and first usable viewer snapshot, with per-stage timings, machine load, and the worker plus Pi resident set size after 60 idle seconds. The result decides whether the next plan revision adds one authenticated spare. This replaces an indefinite deferral with a measured decision.
8. Defer an [owned pseudo-terminal (PTY) viewer](reference/claude-code-behavior.md#attach-becomes-usable-after-a-native-repaint). Pi cannot currently provide the structured repaint, readiness, and context-aware detach channels it requires. Reconsider it when Pi exposes those channels. Acceptance requires structured row state, durable command stages, authenticated Stop, late-attach repaint, and daemon-independent worker lifetime.

The remaining divergences each meet the hard-reason bar:

- Keep Pi under the worker's remote procedure call (RPC) route instead of a PTY host because Pi cannot supply the repaint, readiness, and detach channels required for a usable native attachment.
- Keep the durable command journal and delivery stages because terminal writes cannot represent accepted, delivered, failed, or ambiguous delivery, and dropping those facts would hide failures.
- Keep workers alive during indefinite daemon absence because Claude Code's 60-second orphan timeout can terminate the operator's running work.
- Keep structured row state and map only facts Pi publishes because Pi cannot publish Claude's private schema, while terminal or file inference can show false activity and hide failure.
- Keep `rm` forget-only because copying Claude Code's deletion semantics could remove the canonical Pi session or managed worktree and lose operator work.
- Keep the PTY viewer, native repaint, shared terminal size, and agent-aware detach deferred because Pi cannot expose the channels those behaviors require.

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

## Change 8: every client can write and frontend state stays local

**Outcome:** Three dashboards do not overwrite one another's drafts or selections. Every attached client may submit commands to one session. The daemon orders those commands through the existing per-session coordinator and records each accepted mutation in the command journal.

**Estimate:** 1 commit, 0.5 to 1 engineer-day, net deletion of 250 to 500 lines.

### Commit 8: `refactor: remove session access roles`

- **Tests:** Open three dashboards on one session, submit commands concurrently, and require the daemon to accept and journal them in one order. Change each dashboard's draft and selection, then close them in different orders and require independent local state. Restart the daemon while workers retain exact identity. Assert no role, claim, grant, release, takeover, access-change event, `SESSION_IN_USE`, or attachment artifact remains.
- **Implementation:** Remove composer and observer from viewer snapshots, contracts, controllers, status text, and command authorization. Remove `session_access_changed`, explicit composer acquisition, and release-on-close handling. Remove `AttachmentResultStore`, attach and detach journal transitions, attachment list events, failpoints, and recovery. Delete `runtime/attachment-result-store.mjs` and every production reference to `daemon/attachment-results.jsonl`. Keep authenticated viewer subscriptions and the per-session command coordinator. Generate a process-scoped frontend connection ID at startup. Keep view state and launch drafts in that process; process death may lose an unsubmitted draft. Retain stable installation identity only for durable command recovery.
- **Stop:** Three dashboards submit ordered, journaled commands to one session; no access role or durable attachment artifact exists; Gate 3 passes.

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

## Change 10: `rm` remains forget-only without unused recovery

**Outcome:** `rm` removes only the dashboard row and preserves the Pi file and worktree. The obsolete `daemon/delete-results.json` format disappears with its unused recovery code.

**Estimate:** 2 commits, 0.5 to 1 engineer-day, net deletion of 200 to 400 lines.

### Commit 10.1: `refactor: make rm forget-only`

- **Tests:** In `test/destructive-actions.integration.test.mjs`, cover inactive, live, stale metadata, changed revision, and concurrent relaunch. Every success preserves the canonical Pi file and worktree.
- **Implementation:** Remove `trashSessionFile`. Keep revision, inactive state, ownership, launch, metadata, route, exact process identity, and per-session lock checks before registry removal.
- **Stop:** Successful `rm` changes only registry and journal artifacts. Any filesystem call using the canonical session path fails the test.

### Commit 10.2: `refactor: retire trash recovery`

- **Tests:** Remove delete-result transaction tests after the production callers are gone. Keep forget-only lifecycle and revision tests.
- **Implementation:** Remove the delete-result store, transaction phases, destructive failpoints, file fingerprints, reconciliation, legacy guard, and every production reference to `daemon/delete-results.json`.
- **Stop:** No production or test code names `daemon/delete-results.json`. Gate 4 `rm` checks pass.

The guard and compatibility parser are intentionally absent. On 2026-08-29, `daemon/delete-results.json` was absent on the operator's machine. Production never supplied a trash callback, so no shipped code path could have created a nonempty transaction.

## Change 11: `logs` exposes the error already on disk

**Outcome:** An operator can read the recent daemon or session run log after a startup failure. `WORKER_PROCESS_EXITED` no longer leaves the underlying Pi diagnostic accessible only by finding a file manually.

**Estimate:** 1 commit, 0.5 engineer-day.

### Commit 11: `feat: add bounded logs command`

- **Tests:** Cover daemon and exact session IDs, missing logs, a file shorter than the bound, a file longer than 256 KiB, partial UTF-8 at the read boundary, symlinks, replacement during read, and output containing the Pi error that preceded `worker_hello` failure.
- **Implementation:** Add `pi-agents logs [<full-session-id>]`. Read at most the final 262,144 bytes from the existing daemon startup log or per-run worker log with the same ownership, no-follow, and file-identity checks used for private state. Do not add an in-memory ring or treat logs as viewer history.
- **Stop:** The command prints the latest complete UTF-8 diagnostic tail and cannot read outside owned log paths.

## Change 12: operator commands use Claude Code's verbs

**Outcome:** `agents`, `attach`, `logs`, `stop`, and `rm` have the same meanings an operator already knows from Claude Code.

**Estimate:** 1 commit, 0.5 to 1 engineer-day.

### Commit 12: `feat: adopt background-session command names`

- **Tests:** Require `pi-agents agents`, `pi-agents attach <full-id>`, `pi-agents stop <full-id> --revision <n> --yes`, and `pi-agents rm <full-id> --revision <n> --yes`. Assert the old `session status`, `session stop`, and `session delete` forms return ordinary syntax errors. Keep exact IDs, revision guards, confirmation, pending-request recovery, and JSON output.
- **Implementation:** Name the list entry point `agents`; expose direct viewer opening as `attach`; move `session stop` to `stop`; rename `session delete` to `rm`. Delete the three old parser branches and help text. Keep `session cleanup` and `session resolve-delivery` under the recovery namespace because they have no Claude Code equivalent.
- **Stop:** Help and protocol adapters use one spelling for each operator action, and no compatibility aliases remain.

## Change 13: measure whether one prewarmed spare earns its resident cost

**Outcome:** The next spare decision uses measured launch latency and memory instead of an indefinite deferral.

**Estimate:** 1 commit, 0.5 engineer-day.

### Commit 13: `test: measure cold session launch`

- **Tests:** The measurement driver gives each sample a temporary state root and disposable repository. A fixed no-op prompt records every required timestamp, and a missing stage fails that sample.
- **Implementation:** Add an opt-in measurement driver that submits 30 independent cold-launch tasks through a SLURM `map_array` and emits raw samples plus median and 95th percentile after they complete. Each task measures journal acceptance to worker spawn, `worker_hello`, Pi bind, authenticated socket adoption, ready persistence, and first usable viewer snapshot. Record machine load and the worker plus Pi resident set size after 60 idle seconds. Do not run samples in the normal suite, on a login node, or on the operator's live root.
- **Decision:** If process and Pi startup dominate the measured path, revise the plan to adopt one authenticated spare per daemon and use the idle resident set size as its explicit cost. If they do not dominate, keep cold launch and cite these results. No conclusion is claimed before the measurement runs.
- **Stop:** One JSON result contains 30 complete samples, stage distributions, load, and idle resident memory from a disposable root.

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

Open three new dashboards. Verify independent drafts and selections, final rows matching `get_state`, and 100 or more state changes converging without queue growth. Open one session in all three dashboards, submit concurrent prompts, and verify one journal order, one delivery per accepted request, and no role or `SESSION_IN_USE` response.

Restart the daemon. Verify workers retain identity and no production code opens obsolete list or attachment paths.

### Gate 4: final viewer, logs, commands, and `rm` behavior

With both original workers live, force frontend reconnect during viewer events and verify no missing or duplicate transcript item. Verify no production code opens a viewer acknowledgement path. On disposable sessions, exercise `agents`, `attach`, `logs`, `stop`, and `rm`. Confirm `logs` exposes an injected pre-hello Pi diagnostic and `rm` preserves the Pi file and worktree.

Stop on transcript loss, a retired path opening, path deletion, or worker loss.

## Upgrade policy protects live work without backward compatibility

The release supports one frontend protocol, one daemon protocol, and current durable formats. The operator restarts every dashboard and the daemon together. The plan removes the old-daemon list fallback, special handling for old `subscribe`, the `ack_viewer` no-op, optional `get_state.cursor`, legacy frontend cursor loading, retired-file parsers and corrupt-file branches, and rollback checks against the previous release. It also removes dual route branches once socket adoption is ready.

Retired files remain on disk because leaving an unreferenced path alone costs no production code. No implementation or test parses, validates, migrates, deletes, or explicitly ignores `index/events.jsonl`, `daemon/event-acks.json`, `daemon/attachment-results.jsonl`, `index/viewer/*.acks.json`, or `daemon/delete-results.json`.

One mixed-release case remains by design. A new daemon adopts protocol-compatible live workers by authenticated socket and exact process identity, then marks old code stale. It keeps a busy stale worker alive until structured state reports idle or the operator explicitly requests replacement. This exception protects unsaved live work. It is not support for starting old workers, old frontends, old protocols, or old on-disk formats. Automatic downgrade is refused.

## File collisions

| Files | Changes | Merge rule |
|---|---|---|
| `runtime/daemon.mjs`, `runtime/daemon.integration.test.mjs` | 1, 2, 5, 6, 7, 8, 9, 10, 11, 12 | Serial; rebase after each change |
| `shared/contracts.mjs`, `shared/contracts.test.mjs` | 1, 2, 3, 7, 8, 9, 11, 12 | Feature deletion, list, role deletion, acknowledgements, logs, command names |
| `app/viewer/viewer-controller.mjs` and test | 1, 2, 3, 8, 9, 12 | Serial; remove role checks before command renaming |
| `app/viewer/slash-commands.mjs` and test | 1, 2, 3 | Listed order; do not combine commits during conflict resolution |
| `app/list/standalone-list.mjs` and test | 1, 7, 8, 12 | Queries, list protocol, role deletion, command names |
| `app/daemon-client.mjs` and test | 7, 8, 9, 11 | List protocol, role deletion, acknowledgements, logs |
| `cli/main.mjs`, `cli/session-commands.mjs` and tests | 8, 11, 12 | Remove composer acquisition, add logs, rename commands |
| `runtime/worker.mjs` and tests | 1, 2, 3, 5, 13 | Feature deletions, transport, launch measurements |
| `runtime/worker-supervisor.mjs` and tests | 2, 3, 5, 6, 13 | Feature deletions, handoff, confirmed model, launch measurements |
| `runtime/state-migration.mjs` and test | 7, 8, 9, 10 | Delete retired-format branches; do not add replacement parsers |
| `docs/architecture.md`, `docs/development.md` | all | Update serially after production commits |

## Exclusions

- Keep the daemon, workers, leases, process identity and process-group checks, signaling revalidation, worktree isolation, locks, sweeps, and cleanup.
- Keep summaries opt-in and do not call a summary provider in tests.
- Keep ordered viewer events; list invalidation does not replace them.
- Do not add local-socket heartbeats or cancellation of accepted commands on disconnect.
- Do not compact, rewrite, delete, parse, or migrate retired historical state files.
- Keep state migration separate for current formats; do not fold launch results into the journal or change its schema.
- Do not add a second worker read dispatcher.
- Do not infer row activity from terminal output or the canonical Pi JSONL.
- Do not add old frontend, protocol, durable-format, or rollback support. The only release-skew path adopts compatible live workers to protect current work.
- Do not claim the unmeasured 3 ms list snapshot latency. Measure it at Gate 3 before making a performance claim.
