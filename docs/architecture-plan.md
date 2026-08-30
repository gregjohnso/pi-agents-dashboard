# Architecture implementation plan

After these 19 commits:

- Commands work the same on a newly launched session and after a daemon restart. Graceful Stop no longer waits through its timeout solely because a route is absent.
- Every attached client may read and write the same session. The daemon serializes and journals accepted commands.
- Several dashboards keep independent drafts and selections. A stale list cursor cannot crash dashboard startup.
- `agents`, `attach`, `logs`, `stop`, `rm`, and `respawn` match Claude Code's operator-facing verbs.
- A session row shows a model only after Pi confirms that model.
- `rm` forgets only the dashboard row. It preserves the canonical Pi file and worktree.
- The daemon and workers continue running when terminal clients exit or the daemon is absent.

Approve the work as 19 green commits in one release, with five operator-machine gates protecting the live daemon and two live sessions. The estimate is 7.5 to 12.5 engineer-days. This is not measured work. It includes tests, gates, and documentation but excludes review time and maintenance-window waits.

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
| 8 | One worker socket from startup | The worker connects to the control socket at startup. The daemon authenticates the per-run token, verifies the worker PID, process-start identity, and process group against the process it spawned, adopts that exact route, verifies and records Pi identity, then persists `workerReady: true`. Launch inter-process communication (IPC) is removed. Socket adoption by exact process identity is the normal daemon-start path, not a migration fallback. The operator approved the Claude Code naming sweep on 2026-08-29. |

## Settled feature scope

1. Support several read-write terminals and dashboards. Delete composer and observer roles, grants, releases, and `SESSION_IN_USE`.
2. Delete `/stats`, `/tree`, `/export`, `session_query`, and its payload shape from every layer.
3. Delete `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up`, including commands, projections, adapter methods, and tests.
4. Keep worktree isolation, ownership locks, sweeps, and cleanup.
5. Keep `/model`. Delete `/thinking`, its picker, `set_thinking_level`, and requested thinking level from dashboard launch.
6. Keep summaries opt-in. Summary model settings remain dashboard settings, not Pi settings passthrough.
7. Any client may write. This adopts Claude Code's [shared typing](reference/claude-code-behavior.md#linux-clients-share-one-editor-and-one-terminal-size). The daemon serializes each session's work and journals every accepted command, so a second client adds ordered commands rather than untracked terminal-byte interleaving. Delete roles, grants, releases, takeover races, access-change notifications, recovery for claims, and `SESSION_IN_USE`.

## Execution rules and invariants

Write each named failing test first and observe it fail for the behavior named in the test, not because the fixture, operation, or import is missing. Save the focused failing command and failure message in the commit notes. When a commit deletes an old test, add and run its replacement assertion before deleting it. Add implementation in the same commit. Run focused tests, `pixi run test`, and `pixi run typecheck` before each commit. The current suite count is 788; the count is a target, not a pass condition.

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
- A daemon upgrade [adopts compatible live workers before judging their release version](reference/claude-code-behavior.md#release-changes-adopt-workers-before-replacing-them). Stale or unknown workers continue until an idle replacement boundary or guarded `respawn`, and an older daemon never replaces a newer worker automatically.
- Every attached client may issue mutations. The per-session coordinator orders them, and journal acceptance is the durable boundary.
- Socket loss does not cancel an accepted command.
- Worktree creation, locks, sweeps, cleanup, and opt-in summaries remain unchanged.

## A commit and a gate have mechanical completion rules

A commit is green only when its named focused tests pass, `pixi run test` passes, `pixi run typecheck` passes, its Stop condition is demonstrated, and the tree contains only that commit's production, test, and directly related documentation changes. Record the commands and results before creating the commit. Do not combine adjacent commits to resolve a shared-file conflict.

The Stop line is an assertion, not a summary. Check source-removal assertions with a repository search limited to production and active tests. Check runtime assertions with the named test. A removed test, a help-text snapshot, or a successful import does not by itself satisfy a runtime Stop.

If a focused test fails for a different reason, repair the fixture or narrow the test before implementation. If the full suite or typecheck fails, do not commit. If an operator gate fails, stop the release, save public-client output and daemon diagnostics, leave the two original workers untouched, and diagnose on a copied or temporary root. Do not roll back the daemon, replace a worker, edit production state, or signal a process as an improvised recovery step. Repeat the failed gate only after a new green commit explains the failure.

The first implementation day starts with Gate 0 and a collision check against the file table at the end of this plan. Create one branch for the serial path. Parallel preparation may produce patches, but the serial branch owner rebases and reruns the full checks after each merge.

## Sequence and concurrent work

| Step | Required serial path | What becomes true | Gate after step |
|---:|---|---|---|
| 1 | Baseline inspection | The live daemon and both sessions have an exact, recorded starting identity. | Gate 0 |
| 2 | Changes 1 through 3 | Broken and Pi-owned controls no longer appear; `/model` and observed thinking remain. | |
| 3 | Changes 5.1 through 5.4 | Commands, frames, replies, reconnect, and graceful Stop use one adopted route. A new daemon starts with compatible live workers, marks old worker code stale, and replaces it only at a safe boundary. | |
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

- Worker readiness and socket adoption are one decision. Authenticated adoption precedes persisted readiness.
- `subscribe_list_changes` ships without old `subscribe` support or a new-frontend fallback. The operator restarts the daemon and every dashboard together.
- [Exact-identity socket adoption](reference/claude-code-behavior.md#the-roster-is-an-adoption-record) is the normal daemon-start path. Release skew is evaluated only after compatible live workers are adopted.
- A live dashboard sends a process-scoped `attachId` in the authenticated socket handshake. Durable request envelopes retain stable installation `clientId` plus `requestId`. The daemon binds attachments and subscriptions to the socket and `attachId`, but keys journal recovery only by `clientId` and `requestId`.
- `attach` authenticates the client and subscribes it to current viewer state. It grants no role. Any attached client may submit a command.
- The per-session coordinator orders concurrent commands. Accepted commands continue after disconnect.

## Claude Code evidence changes access, diagnostics, naming, and the upgrade path

Adopt these findings in priority order:

1. Adopt [socket authentication and exact process identity](reference/claude-code-behavior.md#the-roster-is-an-adoption-record) now. Changes 5.1 and 5.2 make authenticated socket adoption the normal daemon-start path and the readiness boundary. The gates verify PID plus process-start identity, so this needs no duplicate commit.
2. Use [structured row state](reference/claude-code-behavior.md#structured-state-and-terminal-rendering-remain-separate) only. The invariant above bars terminal-byte and canonical JSONL inference. Change 5.4 may use only structured idle state when replacing a stale worker.
3. Handle [release skew through adoption](reference/claude-code-behavior.md#release-changes-adopt-workers-before-replacing-them) now. Changes 5.3 and 5.4 adopt compatible live workers before release comparison, mark old worker code stale, replace it at idle or by explicit action, and refuse automatic downgrade. This preserves live work across an upgrade; it does not support old releases after restart.
4. Adopt [shared typing](reference/claude-code-behavior.md#linux-clients-share-one-editor-and-one-terminal-size) now. Change 8 removes access roles and durable attachment recovery. Structured commands remain serialized and journaled by the daemon.
5. Adopt a `logs` command now. It reads a combined 256 KiB tail from the existing worker stderr log and newest Pi stderr segment, so startup failures expose the underlying Pi diagnostic without adding a second in-memory buffer. The tail is diagnostic output, not viewer history.
6. Adopt Claude Code's verbs now. Rename the dashboard's session list entry point to `agents`, session opening to `attach`, `session stop` to `stop`, and `session delete` to `rm`. Use `respawn` for explicit stale-worker replacement. Keep `session cleanup` and `session resolve-delivery` as advanced recovery commands because Claude Code has no equivalent operation.
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

- **Tests:** In `app/viewer/slash-commands.test.mjs`, assert all three commands are absent. In `shared/contracts.test.mjs`, reject `session_query`. In `runtime/daemon.integration.test.mjs`, add the rejection before removing the existing delivery case. In `runtime/pi-rpc-adapter.test.mjs`, replace the dispatcher and adapter query cases with assertions that only retained operations remain; make those assertions fail before deleting production support.
- **Implementation:** Remove query parsing and panels from `app/viewer/slash-commands.mjs` and `app/viewer/viewer-controller.mjs`; `query` from `createDaemonViewerClient` in `app/list/standalone-list.mjs`; `session_query` and `SESSION_QUERIES` from `shared/contracts.mjs`; the daemon branch in `runtime/daemon.mjs`; `runSessionQuery` in `runtime/worker.mjs`; and dashboard-only methods in `runtime/pi-rpc-adapter.mjs`.
- **Risk:** An adapter method may still support capability probing or another command. Focused imports and typecheck must identify that use.
- **Stop:** No production `session_query`, `get_session_stats`, `get_tree`, or `export_html` remains.

## Change 2: Pi-owned settings disappear from the dashboard

**Outcome:** Operators no longer see `/auto-compact`, `/auto-retry`, `/steering`, or `/follow-up`. Removing their dashboard passthrough also removes the `enabled` and `mode` projection mismatch.

**Estimate:** 1 commit, 0.5 engineer-day, net deletion of 100 to 180 lines.

### Commit 2: `feat: remove Pi settings passthrough`

- **Tests:** In `app/viewer/slash-commands.test.mjs`, assert `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up` are absent. Reject their four `session_command` variants in `shared/contracts.test.mjs`. In `runtime/daemon.integration.test.mjs`, reject each variant before removing the current delivery expectations. In `runtime/pi-rpc-adapter.test.mjs`, assert the worker dispatcher and Pi adapter expose none of them.
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

**Outcome:** Commands, frames, replies, reconnect, and graceful Stop use one authenticated control-socket route on a new launch and after daemon restart. Launch inter-process communication (IPC) is removed. A fresh launch can therefore receive graceful Stop immediately instead of waiting through the escalation timeout.

**Estimate:** 4 commits, 4 to 6 engineer-days, net deletion of 150 to 400 production lines after changes 1 through 3. The estimate includes rewriting the worker transport tests in the IPC-removal commit.

The socket-startup spike at commit `9a8e685` validated the design. Five fake-Pi launches produced one adopted route per session, and every launch omitted `"ipc"` from stdio and `NODE_CHANNEL_FD` from the worker environment. With a forced 400 ms PID-publication delay, early hellos waited 186 ms and 226 ms before identity verification and binding. Unforced hellos waited 0 ms. A forged hello with the control token but without the per-run launch token was rejected and its connection was destroyed. One installed-Pi launch completed in 1387 ms, produced one route, and wrote its prompt to Pi's canonical session file.

Graceful Stop fell from a median of 5035 ms across five runs at a 1-minute load average of 2.74 to 32 ms across five runs at a 1-minute load average of 2.44. The before path exhausted the 5-second graceful window because no route existed. The socket route delivered shutdown immediately in the after path.

The socket changes one identity guarantee. IPC identifies the spawned peer through the kernel. The socket authenticates a per-run secret and verifies the claimed PID, process-start identity, and process group through `/proc`. This is equivalent only under the project's existing same-uid trust model, because another process with the operator's uid can read the secret. This is an accepted tradeoff, not implementation work.

Three risks remain. Daemon-restart reconnect after a socket-only launch needs an integration test. Viewer frame ordering across the adoption boundary is buffered but needs a boundary-ordering test. The same-uid identity tradeoff remains as stated above.

### Commit 5.1: `refactor: connect workers through one socket`

- **Tests:** In `runtime/worker-supervisor.test.mjs`, add `authenticates and adopts the startup socket before activation`, `holds an early startup socket until the spawned PID is registered`, and `rejects a startup socket without the per-run token`. In `runtime/worker.integration.test.mjs`, add initial-start and `reconnects after daemon restart from a socket-only launch`. In `runtime/reconciliation.failure.test.mjs`, add wrong run, lease, generation, token, worker PID, process-start identity, and process-group cases. Rewrite all IPC-driven cases in these three files against the socket fixture before deleting IPC assertions. The spike broke 26 of their 41 tests because those tests pin the current transport; they must be rewritten, not deleted, in this commit.
- **Implementation:** Add startup reservations and exact identity checks in `runtime/worker-admission.mjs`. In `runtime/worker-supervisor.mjs`, remove launch IPC, use `stdio: ["ignore", stdout, stderr]`, allocate the per-run token, and reserve the run and lease before spawn. Add `child.pid` to the reservation immediately after spawn. An earlier hello waits on that reservation; it is not rejected. In `runtime/installed-pi-worker.mjs`, open the control socket before startup authorization and send `hello` with the per-run token, run and lease identity, and claimed process identity. In `runtime/daemon.mjs`, verify the PID, process-start identity, and process group through `/proc` before binding the connection. `activate`, `pi_child`, `child_bound`, and `worker_ready` use that socket. `activate` authorizes Pi startup only after the worker connection is bound. After `pi_child`, verify and persist the Pi identity and complete private worker metadata before `worker_ready`. In `runtime/reconciliation.mjs`, run registration and adoption inside the launch's lifecycle-lock context through `SessionCoordinator.runNested`; ordinary callers retain the same serialization. Adopt the route before persisting `workerReady: true`. Rename current `worker_hello` to `hello`. Keep route generation and exact identity authoritative. A live version-1 socket route may supply missing `proto` to its existing adoption record only after socket authentication and exact identity checks. In `runtime/launch-resolver.mjs`, allocate the run-directory hash before constructing the prepared `SessionRecord`; persist root-relative `runHash` beside `latestRunId`. Never put the token or an absolute state-root path in the session record. Also persist optional `cliVersion` in private worker metadata.
- **Stop:** Temporary-root tests reach exactly one authenticated route on initial daemon start and after restart, including when hello precedes PID publication. Launch stdio has no `"ipc"` entry, and the worker environment has no `NODE_CHANNEL_FD`. A prepared row has `latestRunId` and `runHash` before spawn, contains no token or absolute state-root path, and resolves its diagnostics beneath the current root after that root is renamed. All IPC-driven cases in the three named worker test files use socket fixtures, and all 41 tests pass.

### Commit 5.2: `refactor: move all worker traffic to the route`

- **Tests:** In `runtime/daemon.integration.test.mjs`, require prompt, follow-up message, steer, interrupt, user-interface response, model, compact, rename, menu, initial state, frames, and Stop to use the adopted socket before and after persisted readiness and after reconnect. Add `orders viewer frames across startup route adoption` and send frames before binding, during adoption, and after adoption; require each stable source ID once and in order. Inject failure before and after worker adoption, Pi bind, metadata registration, and readiness persistence. Cover the initial prompt outside the lifecycle lock and require the launch journal to remain incomplete until prompt delivery completes. In `test/destructive-actions.integration.test.mjs`, add `graceful Stop accepts a route cleared by shutdown` and `graceful Stop refuses a replaced route`. These tests must fail today because fresh-launch traffic uses `sessionHandles` and the launch IPC channel until the later socket connection.
- **Implementation:** In `runtime/daemon.mjs` and `runtime/worker-supervisor.mjs`, route frames, events, commands, replies, `askWorker`, startup control, activation, and frame ingestion through `RecoveredWorkerRouter`. Route generation rejects late traffic from a superseded connection. Buffer viewer frames that arrive before adoption, then ingest them through the adopted route in source order. In `runtime/daemon.mjs`, move initial-prompt delivery outside `runSessionLifecycle`, because its socket reply re-enters the lifecycle lock through `router.runCurrent`. Keep the launch journal short of `COMPLETED` until that prompt completes; a prompt failure retains the prepared session and records the launch request's terminal delivery result. In `runtime/reconciliation.mjs`, correct `runSession(...).forget()` to refuse a route that was replaced during the action and to accept a route already cleared by the worker's graceful exit. Delete `sessionHandles`, route-versus-handle branches, launch-channel pending replies, and ongoing payload projection from the launch handle. A route loss during startup follows the same reconnect and exact-adoption path as a later loss.
- **Stop:** Every operation passes before persisted readiness and after simulated daemon restart. Frames cross adoption once and in source order. The initial prompt completes outside the lifecycle lock before the launch journal completes. Graceful Stop completes over the current route without `STOP_FAILED`; an already cleared route is accepted, while a replacement route is refused. Production has one worker transport, no `"ipc"` stdio entry, and no launch delivery handle.

### Commit 5.3: `feat: adopt compatible workers across upgrades`

- **Tests:** In `runtime/daemon.integration.test.mjs` and `runtime/reconciliation.failure.test.mjs`, start a new daemon against compatible live workers with older, equal, newer, and absent release metadata. In `shared/contracts.test.mjs`, require the public release and route fields. Require exact PID plus process-start identity and route authentication before startup becomes ready. These tests must fail today because release status, public route generation, and adoption-before-version comparison do not exist. Older and unknown workers remain live and become `STALE`; equal workers remain current; incompatible protocol versions remain unavailable without signaling their processes. A newer worker remains live and is marked `NEWER`, not stale.
- **Implementation:** In `runtime/reconciliation.mjs`, `runtime/daemon.mjs`, and `runtime/state-migration.mjs`, persist package semantic version as optional `cliVersion` and worker protocol as integer `proto` beside each worker identity. Absence of `cliVersion` means `UNKNOWN`, which follows the stale replacement path but is never treated as a downgrade. During ordinary daemon startup, adopt every protocol-compatible route first, then compare semantic release versions. Persist the current `routeGeneration` after successful adoption. In `shared/contracts.mjs`, expose `workerCliVersion`, `stale`, and `routeGeneration` in the read-only `agents --json` row so Gate 1 does not inspect daemon memory or infer adoption from process state. Keep an internal `UNKNOWN` or `NEWER` diagnostic when a Boolean cannot express the reason. Do not add dual socket protocol parsers.
- **Why optional is not old-format support:** The current live workers have no release field in `daemon/workers.json`. The daemon tolerates that absent optional fact only after authenticating the live socket and verifying exact process identity. It does not parse retired files, start old workers, or accept an old socket protocol.
- **Stop:** Gate 1 keeps both original worker identities and reports their release status after the new daemon starts. A worker with absent release metadata is adopted as `UNKNOWN` and is not signaled.

### Commit 5.4: `feat: replace stale workers at a safe boundary`

- **Tests:** In `runtime/daemon.integration.test.mjs` and `test/destructive-actions.integration.test.mjs`, keep a busy stale or unknown worker unchanged. Replace it only after structured state reports `taskState: READY`, with no blocking user-interface request, or after a successful `pi-agents respawn <full-id> --revision <n> --yes` request at that same idle boundary. In `cli/session-commands.test.mjs`, cover the full identifier, revision, and confirmation contract. These tests must fail today because stale classification and `respawn` do not exist. `respawn` refuses `WORKING` and `WAITING` sessions without signaling them. Preserve the canonical Pi session and command-journal stages. Refuse an automatic or explicit replacement when the worker release is newer than the daemon.
- **Implementation:** In `runtime/daemon.mjs`, add one serialized replacement operation under the session lifecycle and ownership checks, bounded to three concurrent upgrade respawns across sessions. Before replacement, persist `pendingRespawn: "upgrade"`; daemon restart resumes that guarded operation only after adoption. Schedule it from the normalized `agent_settled` state that produces `taskState: READY`, or from the top-level `respawn` command in `cli/main.mjs` and `cli/session-commands.mjs`. Revalidate the revision, worker and Pi identity, route, `cliVersion`, and idle state at the replacement boundary. Record busy and downgrade refusals as diagnostics and leave the worker running. `respawn` follows the existing destructive-command convention: full identifier, exact revision, and `--yes`.
- **Risk:** A false idle fact could interrupt work. Only normalized Pi events and the structured row state may open the boundary; terminal bytes and session-file contents may not.
- **Stop:** Busy workers survive upgrades, idle stale or unknown workers replace once, `respawn` uses the same guarded path, and neither automatic nor explicit downgrade signals the worker.

## Change 6: rows show only models that Pi confirmed

**Outcome:** A failed launch never displays a requested model that Pi did not run. The row remains unset until Pi confirms its model at readiness.

**Estimate:** 1 commit, 0.5 to 1 engineer-day.

### Commit 6: `fix: record only Pi-confirmed session model`

- **Tests:** In `runtime/launch-resolver.test.mjs`, keep requested model in worker arguments but not the prepared record. In `runtime/daemon.integration.test.mjs`, cover default selection, accepted request, Pi substitution, omitted model, failure before and after spawn, and restart. Cover catalog-listed, known absent, unavailable catalog, and no requested model. Assert `MODEL_CATALOG_FAILED` remains distinct from `MODEL_UNKNOWN`. A known admission refusal leaves a terminal `FAILED` journal result but no session record, Pi file, worktree, worker, list event, or row. Test the refusal before calling `resolveLaunchRequest`; otherwise the test cannot detect accidental preparation. Its status-line message remains through timer callbacks and clears on the next simulated keystroke or action. A failure after preparation retains its `FAILED` row.
- **Implementation:** Validate model admission in the daemon after journal acceptance and before launch resolution. Stop copying requested model into the prepared record. Carry normalized initial Pi state through socket readiness and apply the confirmed model in the same lifecycle write. Absence remains unknown. A catalog failure records `MODEL_CATALOG_FAILED` and lets Pi decide. Keep Pi-reported thinking display-only. Keep a refusal on the status line until the operator's next keystroke or action; do not clear it on a timer.
- **Stop:** One ready revision contains the Pi-confirmed model; every failure window leaves it absent; Gate 2 passes.

## Change 7: stale list history cannot crash dashboard startup

**Outcome:** The dashboard starts from current registry state instead of replaying thousands of old list records. Burst updates converge to current rows without a queue that grows with the burst. The daemon and dashboards upgrade together.

**Estimate:** 3 commits in 1 release, 1 to 2 engineer-days, net deletion of 350 to 600 lines.

### Commit 7.1: `feat: add race-safe list invalidation`

- **Tests:** In `app/list/dashboard.test.mjs`, cover changes before subscribe, during snapshot, after response, and during reconnect. Replace replay and acknowledgement assertions with final snapshot state. Send 10,000 invalidations and require bounded pending work and at most three reads for one burst plus one change during a read.
- **Implementation:** Add `subscribe_list_changes` and payload-free `list_changed` to `shared/contracts.mjs`. Make the snapshot coverage `cursor` required in every successful `get_state` response, including test doubles. On open and reconnect, subscribe first, set one dirty Boolean, read `get_state`, and refetch once if a notification arrived during the read. While a read is active, any number of notifications only sets that Boolean. No invalidation queue is permitted.
- **Stop:** The before-subscribe, during-read, after-read, and reconnect races converge. A burst of 10,000 notifications plus one notification during a read performs at most three `get_state` reads and retains at most one dirty flag.

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

- **Tests:** Open three dashboard processes on one session, assert three handshake `attachId` values and one stable request `clientId`, submit commands concurrently, and require the daemon to accept and journal them in one order. Change each dashboard's draft and selection, then close them in different orders and require independent local state. Restart the daemon while workers retain exact identity. Assert no role, claim, grant, release, takeover, access-change event, `SESSION_IN_USE`, shared `frontend-state.json` write, or attachment artifact remains.
- **Implementation:** Remove composer and observer from viewer snapshots, contracts, controllers, status text, and command authorization. Remove `session_access_changed`, explicit composer acquisition, and release-on-close handling. Remove `AttachmentResultStore`, attach and detach journal transitions, attachment list events, failpoints, and recovery. Delete `runtime/attachment-result-store.mjs` and every production reference to `daemon/attachment-results.jsonl`. Keep authenticated viewer subscriptions and the per-session command coordinator. Generate `attachId` at dashboard startup and add it to the socket authentication frame; bind connection-scoped state to that value and the socket. Keep stable installation `clientId` in each durable request envelope. Do not reuse `cli/client-id` as `attachId`. Keep each dashboard's selection, view state, and launch draft in its own process memory, and stop reading or writing the shared `frontend-state.json`. Process death may lose an unsubmitted draft.
- **Stop:** Three dashboard processes submit ordered, journaled commands to one session and retain different drafts and selections until each process exits. No access role, shared frontend-state writer, or durable attachment artifact exists; Gate 3 passes.

## Change 9: obsolete acknowledgement files cannot block recovery

**Outcome:** Viewer acknowledgement files no longer participate in recovery. Ordered viewer events, snapshots, queues, stable IDs, and resume behavior remain.

**Estimate:** 2 commits, 0.5 to 1 engineer-day, net deletion of 100 to 180 lines.

### Commit 9.1: `refactor: keep viewer resume state in the frontend`

- **Tests:** In `app/viewer/viewer-controller.test.mjs`, disconnect before processing, after processing, and after local cursor advancement. Spy on the client and require zero `ack_viewer` calls. Reconnect from each retained in-memory cursor and require a repeated stable event ID not to duplicate transcript content. The test must fail if cursor advancement happens before successful application.
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

- **Tests:** In `test/destructive-actions.integration.test.mjs`, cover inactive, live, stale metadata, changed revision, and concurrent relaunch. Every success preserves the canonical Pi file and worktree. Inject filesystem spies that fail on `rename`, `unlink`, `rm`, or any other mutation beneath either path; reads used to verify identity remain allowed.
- **Implementation:** Remove `trashSessionFile`. Keep revision, inactive state, ownership, launch, metadata, route, exact process identity, and per-session lock checks before registry removal.
- **Stop:** Successful `rm` changes only registry and journal artifacts. Any mutating filesystem call beneath the canonical session or worktree path fails the test.

### Commit 10.2: `refactor: retire trash recovery`

- **Tests:** Remove delete-result transaction tests after the production callers are gone. Keep forget-only lifecycle and revision tests.
- **Implementation:** Remove the delete-result store, transaction phases, destructive failpoints, file fingerprints, reconciliation, legacy guard, and every production reference to `daemon/delete-results.json`.
- **Stop:** No production or test code names `daemon/delete-results.json`. Gate 4 `rm` checks pass.

The guard and compatibility parser are intentionally absent. On 2026-08-29, `daemon/delete-results.json` was absent on the operator's machine. Production never supplied a trash callback, so no shipped code path could have created a nonempty transaction.

## Change 11: `logs` exposes the error already on disk

**Outcome:** An operator can read the recent daemon or session run log after a startup failure. `WORKER_PROCESS_EXITED` no longer leaves the underlying Pi diagnostic accessible only by finding a file manually.

**Estimate:** 1 commit, 0.5 engineer-day.

### Commit 11: `feat: add bounded logs command`

- **Tests:** Cover daemon and exact session IDs, missing logs, files shorter and longer than the bound, partial UTF-8 at a read boundary, symlinks, replacement during read, a renamed temporary state root, and Pi output followed by a pre-ready `WORKER_PROCESS_EXITED`. The last case must resolve from the prepared `SessionRecord`; worker metadata does not exist before ready. The renamed-root case must fail if the record stores an absolute run path.
- **Implementation:** Add `pi-agents logs [<full-session-id>]`. With no ID, read `daemon/startup.log`. With an ID, resolve `SessionRecord.runHash` beneath `<current-root>/runs`, then read `worker.stderr.log` and the newest `diagnostics/stderr.*.jsonl` segment. Print the full path of each source before its content. Read the newest Pi stderr tail first, up to 262,144 bytes, then use any remaining budget for worker stderr; emit only complete UTF-8 content. Open with no-follow, require owned regular files, compare device and inode before and after each read, and reject a path that escapes the current root. The record stores only the run hash, never an absolute path, so an in-place state-root rename does not break logs. Do not add an in-memory ring or treat logs as viewer history.
- **Why pre-ready lookup is required:** The observed failure was `WORKER_PROCESS_EXITED` before readiness, while Pi's complaint remained in `runs/<hash>/diagnostics/stderr.*.jsonl`. A lookup that depends on adopted worker metadata misses this failure.
- **Stop:** The command prints source paths and the latest complete UTF-8 diagnostic tail, works before worker readiness and after a root rename, and cannot read outside owned log paths.

## Change 12: operator commands use Claude Code's verbs

**Outcome:** `agents`, `attach`, `logs`, `stop`, `rm`, and `respawn` use Claude Code's operator-facing verbs.

**Estimate:** 1 commit, 0.5 to 1 engineer-day.

### Commit 12: `feat: adopt background-session command names`

- **Tests:** Require `pi-agents agents`, `pi-agents attach <full-id>`, `pi-agents logs [<full-id>]`, `pi-agents stop <full-id> --revision <n> --yes`, `pi-agents rm <full-id> --revision <n> --yes`, and `pi-agents respawn <full-id> --revision <n> --yes`. Assert the old `session status`, `session stop`, and `session delete` forms return ordinary syntax errors. Keep exact IDs, revision guards, confirmation, pending-request recovery, and JSON output.
- **Implementation:** Name the list entry point `agents`; expose direct viewer opening as `attach`; move `session stop` to `stop`; rename `session delete` to `rm`; and expose the guarded stale-worker replacement from Change 5.4 as `respawn`. Delete the three old parser branches and help text. Keep `session cleanup` and `session resolve-delivery` under the recovery namespace because they have no Claude Code equivalent.
- **Stop:** Help and protocol adapters use one spelling for each operator action, and no compatibility aliases remain.

## Change 13: measure whether one prewarmed spare earns its resident cost

**Outcome:** The next spare decision uses measured launch latency and memory instead of an indefinite deferral.

**Estimate:** 1 commit, 0.5 engineer-day.

### Commit 13: `test: measure cold session launch`

- **Checks:** The opt-in measurement driver gives each sample a temporary state root and disposable repository. A fixed prompt records every required timestamp; a missing stage fails that sample. This is not a test, is not imported by vitest, and never runs under `pixi run test`.
- **Implementation:** Add a JavaScript sample driver and a Python submitit launcher. Add Python and submitit to `pixi.toml`; do not add a shell loop or submit one job at a time. The launcher submits 30 independent one-sample tasks through one SLURM `map_array`, uses `l40-reserved` with `mid` quality of service, sets the partition timeout explicitly, and writes submitit stdout and stderr under the measurement output directory. Each task uses the installed Pi and a fixed recorded model, performs real provider inference, waits 60 idle seconds for memory measurement, cleans up its disposable root, and emits one raw JSON sample without credentials. A first usable viewer snapshot is the first successful `get_viewer_snapshot` whose row revision includes persisted readiness. The reducer emits median and 95th percentile for journal acceptance to worker spawn, `hello`, Pi bind, authenticated socket adoption, ready persistence, and that snapshot. Record Pi version, provider and model, machine load, SLURM job and array-task IDs, and worker plus Pi resident set size. Do not run samples in vitest, on a login node, or on the operator's live root.
- **Decision:** Process and Pi startup dominate only if spawn-through-ready exceeds 50 percent of acceptance-to-first-usable-snapshot at both the median and 95th percentile. Propose one authenticated spare only if that condition holds and the measured median spawn-through-ready time, the maximum available saving, is at least 1 second. State the per-spare idle resident memory as its cost. Otherwise keep cold launch and cite the result.
- **Stop:** One JSON result contains 30 complete samples, stage distributions, Pi and model identity, load, SLURM task IDs, and idle resident memory from disposable roots. The result states pass or fail for both the 50 percent dominance threshold and the 1-second median-saving threshold.

## Operator gates protect live sessions, not old releases

Tests and failure injection use temporary state roots. Gate 0 and the adoption portion of Gate 1 are the only steps that inspect or restart the production daemon. Gates 2 through 4 use disposable sessions for mutations; their failpoints, malformed files, burst load, invalid model substitution, and injected Pi failures run on a temporary root. No gate writes a production state file directly, starts a second daemon against production, or signals an original worker.

Run production gates only in an approved maintenance window with both original session IDs and identities already recorded. Store each gate's commands, JSON responses, timestamps, and pass or fail result outside the state root in one release evidence directory. A gate passes only when every listed verification is recorded. On failure, follow the failure rule above; do not continue to the next gate.

### Gate 0: read-only preflight

Use the installed CLI's JSON status output, package metadata, and executable identity to record the installed package version and commit; daemon PID, process-start identity, epoch, and recovery state; both live session IDs; worker and Pi identities; and the retired-file names and sizes. Gate 0 cannot record a route generation because the current public contract does not expose one; Gate 1 establishes the first public route-generation baseline after Change 5.3. The 2026-08-29 comparison values are `index/events.jsonl` at 18 MB, `daemon/attachment-results.jsonl` at 679 KB, 14 `index/viewer/*.acks.json` files, `daemon/event-acks.json` at 512 bytes, and no `daemon/delete-results.json`. Through an authenticated public client, issue only `get_state` and `get_viewer_snapshot` for each original session. Save the responses. Do not attach, acknowledge, or subscribe in this gate.

Pass only if the daemon reports `READY`, every identity contains PID plus process-start identity, and both snapshots parse. Stop on an ambiguous identity, any recovery state other than `READY`, a missing worker or Pi identity, or a request that would require a mutation.

### Gate 1: worker adoption and coordinated client restart

Install the single release, exit every dashboard, then restart only the production daemon through the normal command. Start new dashboards after daemon readiness. Verify each dashboard reads a `get_state` response with the required coverage cursor and shows the current snapshot. Do not cause a production mutation merely to test invalidation, and do not run mixed frontend and daemon releases.

Verify both original workers retain PID, process-start identity, process group, run ID, lease generation, and one route. Confirm the new daemon adopts them before release comparison. Baseline records may acquire `proto: 1` from their authenticated live route and may report absent `cliVersion` as unknown and stale. Neither case may refuse startup or signal a worker. Confirm the daemon does not replace a busy worker. On a temporary root, launch one disposable session and verify a dashboard receives later invalidations. Verify the worker starts without IPC; `hello`, `activate`, `pi_child`, `child_bound`, and `worker_ready` use the socket; worker metadata registration precedes `worker_ready`; and authenticated adoption precedes `workerReady: true` and persisted session readiness. Exercise idle and explicit stale replacement only there. Run every remaining operation and graceful Stop only on temporary-root sessions.

Pass only if the saved before and after process identities match exactly, each original `agents --json` row has one positive `routeGeneration`, every new dashboard converges, and the temporary-root startup trace has each required stage once in order. Stop on original worker identity change, a missing or changing route generation without a recorded reconnect, duplicate delivery, lost frame, startup refusal caused only by compatible or unknown worker code, automatic downgrade, dashboard nonconvergence, any IPC frame, or escalation after successful graceful shutdown.

### Gate 2: confirmed model

On a temporary root, launch default, valid named, substituted, invalid, and catalog-failure cases. Verify no row shows a model before Pi reports it. Verify a known admission refusal writes a terminal `FAILED` journal result but creates no session record, Pi file, worktree, worker, list event, or row. Confirm its status-line message survives timer callbacks and remains until the next keystroke or action. Verify an injected failure after preparation keeps its `FAILED` row, catalog failure lets Pi decide, `MODEL_CATALOG_FAILED` stays distinct from `MODEL_UNKNOWN`, and daemon restart retains workers and confirmed values.

Pass only if every case leaves the stated artifacts and one journal terminal state. Do not run model substitution or failure injection against the production daemon.

### Gate 3: three dashboards and list convergence

Open three production dashboards only to verify that they converge on the unchanged original rows and keep independent unsubmitted drafts and selections. Do not open an original session or submit a command to it. Perform the mutation checks on a temporary root: create one disposable session, open it in three dashboards, submit concurrent prompts, and verify one journal order, one delivery per accepted request, and no role or `SESSION_IN_USE` response. Drive 100 or more disposable state changes and compare the final rows with a fresh `get_state` snapshot. The focused 10,000-notification test, not production observation, proves the one-dirty-flag and three-read bound.

Restart the temporary daemon and verify workers retain identity and no production code opens obsolete list or attachment paths. Pass only if all three local states differ as entered, final rows equal the snapshot, journal order is total, delivery IDs are unique, and retired-path open spies remain unused.

### Gate 4: final viewer, logs, commands, and `rm` behavior

With both original workers live, force only a frontend reconnect during viewer events and verify no missing or duplicate transcript item; do not issue a session command. Use open spies on a temporary root to verify no production code opens a viewer acknowledgement path. On temporary-root sessions, exercise `agents`, `attach`, `logs`, `stop`, `rm`, and `respawn`. Confirm `logs` exposes an injected pre-ready Pi diagnostic and prints its source paths. Confirm `rm` preserves the Pi file and worktree.

Pass only if transcript source IDs before and after reconnect are equal and unique, all command exit codes and JSON results match their contracts, retired-path spies remain unused, and file identities before and after `rm` match. Stop on transcript loss, a retired path opening, path deletion, original-worker loss, or any command that targets an original session.

## Upgrade policy protects live work without backward compatibility

The release supports one frontend protocol, one daemon protocol, and current durable formats. The operator restarts every dashboard and the daemon together. The plan removes the old-daemon list fallback, special handling for old `subscribe`, the `ack_viewer` no-op, optional `get_state.cursor`, legacy frontend cursor loading, retired-file parsers and corrupt-file branches, and rollback checks against the previous release. It also removes dual route branches once socket adoption is ready.

Retired files remain on disk because leaving an unreferenced path alone costs no production code. No implementation or test parses, validates, migrates, deletes, or explicitly ignores `index/events.jsonl`, `daemon/event-acks.json`, `daemon/attachment-results.jsonl`, `index/viewer/*.acks.json`, or `daemon/delete-results.json`.

One mixed-release case remains by design. A new daemon adopts protocol-compatible live workers by authenticated socket and exact process identity, then compares optional `cliVersion`. An absent `cliVersion` means unknown and follows the stale replacement policy; it is not permission to start old code. The daemon keeps a busy stale or unknown worker alive until structured state reports idle or the operator runs guarded `respawn`. This exception protects unsaved live work. It is not support for starting old workers, old frontends, old protocols, or retired on-disk formats. Automatic downgrade is refused.

## File collisions

| Files | Changes | Merge rule |
|---|---|---|
| `runtime/daemon.mjs`, `runtime/daemon.integration.test.mjs` | 1, 2, 5, 6, 7, 8, 9, 10, 12 | Serial; rebase after each change |
| `shared/contracts.mjs`, `shared/contracts.test.mjs` | 1, 2, 3, 5, 7, 8, 9, 12 | Feature deletion, `runHash`, list, connection identity, acknowledgements, command names |
| `runtime/reconciliation.mjs` and failure test | 5, 7, 8, 9, 10 | Worker adoption metadata, list events, roles, acknowledgements, delete recovery |
| `runtime/installed-pi-worker.mjs`, `runtime/worker.mjs` and tests | 1, 2, 3, 5, 13 | Feature deletions, socket transport, launch measurements |
| `runtime/worker-admission.mjs` | 5 | Startup reservation, per-run authentication, exact identity checks, pre-adoption frame buffer |
| `runtime/worker-supervisor.mjs` and tests | 2, 3, 5, 6, 13 | Feature deletions, socket startup, run identity, confirmed model, launch measurements |
| `runtime/launch-resolver.mjs` and test | 3, 5, 6 | Thinking removal, prepared run identity, confirmed model |
| `app/viewer/viewer-controller.mjs` and test | 1, 2, 3, 8, 9, 12 | Serial; remove role checks before command renaming |
| `app/viewer/slash-commands.mjs` and test | 1, 2, 3 | Listed order; do not combine commits during conflict resolution |
| `app/list/dashboard.mjs`, `app/list/standalone-list.mjs` and tests | 1, 3, 6, 7, 8, 12 | Queries, launch fields, status lifetime, list protocol, local state, command names |
| `app/daemon-client.mjs` and test | 7, 8, 9 | List protocol, connection identity, acknowledgements |
| `app/standalone.mjs`, `app/list/frontend-state.mjs` and tests | 7, 8 | Remove cursor persistence, then shared frontend persistence |
| `cli/main.mjs`, `cli/session-commands.mjs` and tests | 5, 8, 11, 12 | Add respawn, remove composer acquisition, add logs, rename commands |
| `runtime/state-migration.mjs` and test | 5, 7, 8, 9, 10 | Accept current `runHash`; delete retired-format branches; do not add replacement parsers |
| `pixi.toml`, `perf/` | 13 | Add the opt-in submitit measurement only after production stages exist |
| `docs/architecture.md`, `docs/development.md` | all | Update serially after production commits |

## Exclusions

- Keep the daemon, workers, leases, process identity and process-group checks, signaling revalidation, worktree isolation, locks, sweeps, and cleanup.
- Keep summaries opt-in. Automated tests must not call a summary provider or any other model provider. Change 13 is an opt-in SLURM measurement, not a test.
- Keep ordered viewer events; list invalidation does not replace them.
- Do not add local-socket heartbeats or cancellation of accepted commands on disconnect.
- Do not compact, rewrite, delete, parse, or migrate retired historical state files.
- Keep state migration separate for current formats; do not fold launch results into the journal or change its schema.
- Do not add a second worker read dispatcher.
- Do not infer row activity from terminal output or the canonical Pi JSONL.
- Do not add old frontend, protocol, durable-format, or rollback support. The only release-skew path adopts compatible live workers to protect current work.
- Do not claim the unmeasured 3 ms list snapshot latency. Measure it at Gate 3 before making a performance claim.
