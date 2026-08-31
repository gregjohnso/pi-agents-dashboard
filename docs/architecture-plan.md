# Architecture implementation plan

**Status on 2026-08-31: all 19 planned commits are merged and pushed on `standalone-dashboard`, plus 7 commits this plan did not anticipate. The suite is 968 tests across 89 files, green under `pixi run test` with no flags, typecheck clean. What remains is Gates 2, 3 and 4, two packaging decisions, and the defect list at the end of this file. Every change below is done unless the section says otherwise.**

The seven unplanned commits each fixed something a planned commit broke or exposed, and they are the reason the count is 26 rather than 19: the launch refusal that ate the operator's typed prompt, Pi's version stored as its help banner, real timeouts so `pixi run test` is a gate again, an unreachable liveness-probe timeout, the daemon child a timed-out start used to orphan, reaching a daemon from the previous release, and a refused viewer resubscription that froze the transcript in silence.

Two of those came from failures the operator hit himself, and two more from an external review that read the files rather than the diff. The pattern worth carrying forward: **every fire-and-forget send across a process boundary eventually becomes a silent freeze.** It happened in the list path, was fixed there by Change 7, and survived twenty lines away in the viewer path until someone read the file.

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

## What remains

Nothing in the commit sequence. Three gates, two decisions, and a defect list.

**Gates.** Gate 2 (confirmed model), Gate 3 (three dashboards and list convergence) and Gate 4 (viewer, logs, commands, `rm`) are specified below and unrun. Gate 4's viewer section is written against the wrong failure: an external review on 2026-08-31 found a refused viewer resubscription froze the transcript silently, and Gate 4 as specified would not have caught it, because it never breaks a live viewer's socket nor lets events accumulate past the daemon's subscriber bound. Widen it before running it. Gates 0 and 1 passed. All three remaining gates run on temporary roots; none may touch the operator's live sessions.

**Two packaging decisions, one line each.** `package.json` carries no `"private": true` although this tool is not published, and `README.md` still says `npm install -g pi-agents`, which names a package nobody can install. Both have been flagged repeatedly and left alone, because publishing intent is the operator's call.

**Defects found and not fixed.** None blocks the release; all were found by the commit that reported them.

| Defect | Where | Cost |
|---|---|---|
| A worker replaced across a release change is invisible | list UI | The row stays READY and a prompt appears to hang for about two minutes. The operator hit this on 2026-08-31 and read it as the session being broken. |
| `daemon start` prints nothing for up to 90 s | `cli/main.mjs` writes its result only after the command returns | On a real hang the terminal is dead long enough to Ctrl-C and destroy the diagnosis the 90 s deadline exists to produce. |
| `PROCESS_EXIT_PROOF_MS` is 2 s with no option | `cli/daemon-commands.mjs:22` | A daemon the kernel takes longer to reap turns a correct stop into exit code 5. |
| `CRASH_REPORT_TIMEOUT_MS` is 1 s | `runtime/installed-pi-worker.mjs:15` | Under load a crashing worker loses its own explanation. |
| `PENDING_LOCK_TIMEOUT_MS` unreachable at two call sites | `cli/session-commands.mjs:481,528` | Same class as the probe timeout that was fixed. |
| `runViewerTransition` fires `detach` without awaiting it | viewer | A fast reopen-then-delete still races its own detach. |
| `migrateLegacyState` refuses any root that ever opened a viewer | `runtime/state-migration.mjs` | Pre-existing; it means that path cannot succeed on the operator's machine today. |
| Test doubles that cannot fail the way production fails | `cli/daemon-commands.test.mjs`, `app/list/dashboard.test.mjs`, `cli/session-commands.test.mjs` | This class hid a `daemon stop --stop-workers` regression behind a fully green suite. |
| `docs/development.md` states 901 tests | documentation | The tree has 957. |

**Inert files on the operator's root**, named by no code and removed by nothing: `index/events.jsonl` (18 MB), `daemon/attachment-results.jsonl` (697 KB), `daemon/event-acks.json`, 15 `index/viewer/*.acks.json`, and `frontend-state.json`. They also block the deferred `pi-dashboard` to `pi-agents` rename, which needs a moment with no live daemon or worker.

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

- **Executed production files (7):** `app/list/standalone-list.mjs`, `app/viewer/slash-commands.mjs`, `app/viewer/viewer-controller.mjs`, `runtime/daemon.mjs`, `runtime/pi-rpc-adapter.mjs`, `runtime/worker.mjs`, and `shared/contracts.mjs`.
- **Executed tests (5):** `app/viewer/slash-commands.test.mjs`, `app/viewer/viewer-controller.test.mjs`, `runtime/daemon.integration.test.mjs`, `runtime/pi-rpc-adapter.test.mjs`, and `shared/contracts.test.mjs`.
- **Risk:** An adapter method may still support capability probing or another command. Focused imports and typecheck must identify that use.
- **Stop:** No production `session_query`, `get_session_stats`, `get_tree`, or `export_html` remains.

## Change 2: Pi-owned settings disappear from the dashboard

**Outcome:** Operators no longer see `/auto-compact`, `/auto-retry`, `/steering`, or `/follow-up`. `SESSION_COMMANDS` now contains `set_model`, `compact`, `set_session_name`, and `abort_retry`. `/abort-retry` remains because it retries an interrupted Pi turn, not Pi's removed automatic-retry setting. Removing the four dashboard passthroughs also removes the `enabled` and `mode` projection mismatch.

**Estimate:** 1 commit, 0.5 engineer-day, net deletion of 100 to 180 lines.

### Commit 2: `feat: remove Pi settings passthrough`

- **Executed production files (8):** `app/viewer/slash-commands.mjs`, `app/viewer/viewer-controller.mjs`, `runtime/daemon.mjs`, `runtime/pi-rpc-adapter.mjs`, `runtime/session-command-projection.mjs`, `runtime/worker-supervisor.mjs`, `runtime/worker.mjs`, and `shared/contracts.mjs`.
- **Executed tests (6):** `app/viewer/slash-commands.test.mjs`, `app/viewer/viewer-controller.test.mjs`, `runtime/daemon.integration.test.mjs`, `runtime/pi-rpc-adapter.test.mjs`, `runtime/worker-supervisor.test.mjs`, and `shared/contracts.test.mjs`. The retained `/abort-retry` test records the deliberate exception: `SESSION_COMMANDS` is `set_model`, `compact`, `set_session_name`, and `abort_retry`. `runtime/session-command-projection.mjs` is the single projection shared by both delivery paths; later payload changes must use `sessionCommandPayload` rather than rebuilding it.
- **Stop:** No production command name remains, and unchanged summary opt-in tests pass.

## Change 3: thinking is display-only

**Outcome:** `/thinking` and its picker disappear, while `/model` remains. Pi-reported thinking still appears as observed state.

**Estimate:** 1 commit, 0.5 to 1 engineer-day, net deletion of 80 to 160 lines.

### Commit 3: `feat: remove dashboard thinking control`

- **Executed production and documentation files (15):** `README.md`, `app/list/dashboard-overlays.mjs`, `app/list/dashboard.mjs`, `app/list/launch-composer.mjs`, `app/list/list-commands.mjs`, `app/viewer/slash-commands.mjs`, `app/viewer/viewer-controller.mjs`, `runtime/daemon.mjs`, `runtime/installed-pi-worker.mjs`, `runtime/launch-resolver.mjs`, `runtime/pi-rpc-adapter.mjs`, `runtime/session-command-projection.mjs`, `runtime/worker-supervisor.mjs`, `runtime/worker.mjs`, and `shared/contracts.mjs`.
- **Executed tests and snapshots (16):** `app/list/dashboard-overlays.test.mjs`, `app/list/dashboard.test.mjs`, `app/list/launch-composer.test.mjs`, `app/list/list-commands.test.mjs`, `app/list/standalone-list-focus.test.mjs`, `app/viewer/slash-commands.test.mjs`, `app/viewer/viewer-controller.test.mjs`, `runtime/daemon.integration.test.mjs`, `runtime/launch-resolver.test.mjs`, `runtime/pi-rpc-adapter.test.mjs`, `shared/contracts.test.mjs`, `test/dashboard-resync.acceptance.test.mjs`, `test/installed-pi.integration.test.mjs`, `test/spinner-chain.integration.test.mjs`, `test/terminal.acceptance.test.mjs`, and `test/__snapshots__/terminal.acceptance.test.mjs.snap`. Pi restores thinking from its canonical session file on resume, as verified in `docs/session-format.md` and `dist/core/sdk.js`; launch and relaunch therefore pass no thinking level. Observed `thinking_state` and `SessionRecord.thinkingLevel` remain display-only.
- **Stop:** No dashboard request selects thinking; `/model` and observed thinking tests pass.

## Change 5: commands work on every session and Stop uses its graceful route

**Outcome:** Commands, frames, replies, reconnect, and graceful Stop use one authenticated control-socket route on a new launch and after daemon restart. Launch inter-process communication (IPC) is removed. A fresh launch can therefore receive graceful Stop immediately instead of waiting through the escalation timeout.

**Estimate:** 4 commits, 4 to 6 engineer-days, net deletion of 150 to 400 production lines after changes 1 through 3. The estimate includes rewriting the worker transport tests in the IPC-removal commit.

The socket-startup spike at commit `9a8e685` validated the design. Five fake-Pi launches produced one adopted route per session, and every launch omitted `"ipc"` from stdio and `NODE_CHANNEL_FD` from the worker environment. With a forced 400 ms PID-publication delay, early hellos waited 186 ms and 226 ms before identity verification and binding. Unforced hellos waited 0 ms. A forged hello with the control token but without the per-run launch token was rejected and its connection was destroyed. One installed-Pi launch completed in 1387 ms, produced one route, and wrote its prompt to Pi's canonical session file.

Graceful Stop fell from a median of 5035 ms across five runs at a 1-minute load average of 2.74 to 32 ms across five runs at a 1-minute load average of 2.44. The before path exhausted the 5-second graceful window because no route existed. The socket route delivered shutdown immediately in the after path.

The socket changes one identity guarantee. IPC identifies the spawned peer through the kernel. The socket authenticates a per-run secret and verifies the claimed PID, process-start identity, and process group through `/proc`. This is equivalent only under the project's existing same-uid trust model, because another process with the operator's uid can read the secret. This is an accepted tradeoff, not implementation work.

The per-run token is durable private worker metadata. Generate it before spawn and persist it in `daemon/workers.json`, an owned regular file with mode 0600, before accepting the startup connection. Keep it out of the public session record, process arguments, diagnostics, and logs. A replacement daemon reads the same token and can authenticate a reconnecting live worker. Adoption does not rotate it. Reconciliation removes the worker entry, including its token, after exact identity checks prove the worker and Pi child have exited. Respawn creates a new run and token only after the old process group is gone. This matches Claude Code's persisted per-worker socket tokens. The earlier instruction not to persist the token was wrong.

A reader of the state root can copy the control token and every worker token. A worker token can impersonate that run if the attacker can also satisfy or race the claimed process identity checks. This adds worker-frame forgery to access already granted by the readable control token. The marginal risk is accepted under the one-local-user trust model, and mode 0600 excludes other users under ordinary file permissions.

Three risks remain. Daemon-restart reconnect after a socket-only launch needs an integration test. Viewer frame ordering across the adoption boundary is buffered but needs a boundary-ordering test. The same-uid identity tradeoff remains as stated above.

### Commit 5.1: `refactor: connect workers through one socket`

- **Verified production files (11):** `runtime/worker-supervisor.mjs` owns `fork(...stdio: [..., "ipc"])`, `worker_hello`, launch-channel `activate`/`pi_child`/`child_bound`/`worker_ready`, token creation, and `workers.json` writes; `runtime/installed-pi-worker.mjs` requires `process.send`, emits those IPC frames, and must become the startup socket client; `runtime/daemon.mjs` authenticates worker sockets and binds `RecoveredWorkerRouter`; `runtime/reconciliation.mjs` owns route registration, exact-identity checks, metadata adoption, and terminal metadata removal; `runtime/launch-resolver.mjs` constructs the prepared record and run identity; `runtime/ownership.mjs` validates the ownership written during launch; `runtime/test-fixtures.mjs` supplies the shared launch fixture; `shared/contracts.mjs` defines and validates `SessionRecord`, so it must admit root-relative `runHash`; `runtime/registry-store.mjs` has the independent persisted-record allowlist and validator; `runtime/state-migration.mjs` validates current `daemon/workers.json` and session records; `runtime/runtime-activity.mjs` reads `daemon/workers.json` and must tolerate the private token and release fields. The old plan's worker-admission path does not exist; put startup reservations in the existing router/admission code instead of naming a nonexistent file.
- **Verified tests (16):** Rewrite the IPC fixtures and assertions in `runtime/worker-supervisor.test.mjs`, `runtime/worker.integration.test.mjs`, `runtime/reconciliation.failure.test.mjs`, and `runtime/daemon.integration.test.mjs`. Update `runtime/launch-resolver.test.mjs` and `runtime/launch-trace.test.mjs` for the pre-spawn run identity, `shared/contracts.test.mjs` and `runtime/registry-store.test.mjs` for the record field, `runtime/state-migration.test.mjs` and `runtime/runtime-activity.test.mjs` for current worker metadata, and `test/state-root-adoption.integration.test.mjs`, `test/spinner-chain.integration.test.mjs`, `test/destructive-actions.integration.test.mjs`, `test/installed-pi.integration.test.mjs`, `test/mixed-pi-versions.integration.test.mjs`, and `test/lifecycle.acceptance.test.mjs` for their launch, metadata, and startup fixtures. None of these are deletion-only tests.

- **Tests:** In `runtime/worker-supervisor.test.mjs`, add `authenticates and adopts the startup socket before activation`, `holds an early startup socket until the spawned PID is registered`, and `rejects a startup socket without the per-run token`. In `runtime/worker.integration.test.mjs`, add initial-start, `reconnects after daemon restart from a socket-only launch`, `retains the run token across adoption`, and `issues a new token only for a new run`. In `runtime/reconciliation.failure.test.mjs`, add wrong run, lease, generation, token, worker PID, process-start identity, and process-group cases. Require a live worker's token to remain in mode-0600 `daemon/workers.json` across reconciliation, and require terminal reconciliation to remove the whole entry. Search captured worker stderr, rotating diagnostics, and daemon diagnostics for the test token and require zero matches. Rewrite all IPC-driven cases in these three files against the socket fixture before deleting IPC assertions. The spike broke 26 of their 42 tests because those tests pin the current transport; they must be rewritten, not deleted, in this commit. A launch's first adopted route is generation 2 because `register` mints generation 1 before `adopt`; tests must read `router.route(...).routeGeneration` rather than pinning a generation number.
- **Implementation:** Add startup reservations and exact identity checks to `RecoveredWorkerRouter` in `runtime/reconciliation.mjs`; no separate worker-admission module exists. In `runtime/worker-supervisor.mjs`, remove launch IPC, use `stdio: ["ignore", stdout, stderr]`, allocate the per-run token, and persist it with the reserved run and lease in mode-0600 `daemon/workers.json` before spawn. Add `child.pid` to the reservation immediately after spawn. An earlier hello waits on that reservation; it is not rejected. In `runtime/installed-pi-worker.mjs`, open the control socket before startup authorization and send `hello` with the per-run token, run and lease identity, and claimed process identity. In `runtime/daemon.mjs`, verify the PID, process-start identity, and process group through `/proc` before binding the connection. `activate`, `pi_child`, `child_bound`, and `worker_ready` use that socket. `activate` authorizes Pi startup only after the worker connection is bound. After `pi_child`, verify and persist the Pi identity and complete private worker metadata before `worker_ready`. In `runtime/reconciliation.mjs`, run registration and adoption inside the launch's lifecycle-lock context through `SessionCoordinator.runNested`; ordinary callers retain the same serialization. Reuse the persisted token during daemon-start reconciliation and adoption. Remove the worker entry after terminal reconciliation, and create a new token for respawn rather than rotating one during adoption. Adopt the route before persisting `workerReady: true`. Rename current `worker_hello` to `hello`. Keep route generation and exact identity authoritative. A live version-1 socket route may supply missing `proto` to its existing adoption record only after socket authentication and exact identity checks. In `runtime/launch-resolver.mjs`, allocate the run-directory hash before constructing the prepared `SessionRecord`; persist root-relative `runHash` beside `latestRunId`. Never put the token or an absolute state-root path in the session record. Also persist optional `cliVersion` in private worker metadata.
- **Stop:** Temporary-root tests reach exactly one authenticated route on initial daemon start and after restart, including when hello precedes PID publication. The same token authenticates a surviving run after restart, a respawned run gets a different token, and terminal reconciliation removes the old token with its worker entry. `daemon/workers.json` is an owned mode-0600 regular file. The test token appears in no captured worker stderr, rotating diagnostic, or daemon diagnostic. Launch stdio has no `"ipc"` entry, and the worker environment has no `NODE_CHANNEL_FD`. A prepared row has `latestRunId` and `runHash` before spawn, contains no token or absolute state-root path, and resolves its diagnostics beneath the current root after that root is renamed. All IPC-driven cases in the three named worker test files use socket fixtures, and all 42 tests pass.

### Commit 5.2: `refactor: move all worker traffic to the route`

- **Executed production deletion (2 files):** `runtime/daemon.mjs` deleted the unreachable `sessionHandles` map, route-versus-handle branches, launch-handle bookkeeping, and stale-handle relaunch check. `runtime/worker-supervisor.mjs` deleted its empty launch handle. `runtime/session-command-projection.mjs` remained the one projection used by the route path and did not change.
- **Executed tests (2 files):** `runtime/daemon.integration.test.mjs` pins relaunch after a launched worker dies and frame ordering across startup adoption. `runtime/worker.integration.test.mjs` pins replacement-daemon adoption from the persisted run token. The cleared-versus-replaced `forget()` cases already exist in `runtime/reconciliation.failure.test.mjs`; its correction landed in Commit 5.1, so neither the implementation nor those tests belong to this commit.

- **Tests:** This commit is a deletion, not a transport migration. Fresh-launch traffic already used the route after Commit 5.1, so the old rationale that route tests must fail against launch IPC is stale. The new tests protect the behavior exposed by deleting the unreachable second path: a dead launched worker must relaunch, buffered viewer frames must cross adoption once and in source order, and a replacement daemon must adopt a live socket-only worker from `daemon/workers.json`.
- **Implementation:** Delete `sessionHandles`, route-versus-handle delivery, launch-handle pending replies and bookkeeping, the stale-handle relaunch shortcut, the supervisor's empty `terminal()` method, and the payload-projection import used only by the deleted handle arm. Do not repeat the `runSession(...).forget()` correction from Commit 5.1.
- **Stop:** Every operation passes before persisted readiness and after simulated daemon restart. Frames cross adoption once and in source order. The initial prompt completes outside the lifecycle lock before the launch journal completes. Graceful Stop completes over the current route without `STOP_FAILED`; an already cleared route is accepted, while a replacement route is refused. Production has one worker transport, no `"ipc"` stdio entry, and no launch delivery handle.

### Commit 5.3: `feat: adopt compatible workers across upgrades`

- **Verified production files (5):** `runtime/reconciliation.mjs` reads, adopts, and persists private worker metadata and route generations; `runtime/daemon.mjs` projects adopted-worker status onto rows at read time; `runtime/state-migration.mjs` validates current worker metadata; `runtime/runtime-activity.mjs` holds a fourth independent `daemon/workers.json` allowlist; `shared/contracts.mjs` defines and validates the public row projections `workerCliVersion`, `stale`, and `routeGeneration`. `runtime/registry-store.mjs` does not change because these fields are not persisted record fields.
- **Verified tests (6):** Invert the release-blind expectations in `runtime/daemon.integration.test.mjs` and `runtime/reconciliation.failure.test.mjs`. Update `shared/contracts.test.mjs` and `runtime/state-migration.test.mjs` for optional release metadata and public route fields. Update the hand-written metadata fixtures in `test/state-root-adoption.integration.test.mjs` and `test/spinner-chain.integration.test.mjs`. The `UNKNOWN` release case belongs in a fixture whose live worker can be adopted: `test/state-root-adoption.integration.test.mjs` uses a dead PID and never adopts its worker, so it cannot test `UNKNOWN`.

- **Tests:** In `runtime/daemon.integration.test.mjs` and `runtime/reconciliation.failure.test.mjs`, start a new daemon against compatible live workers with older, equal, newer, and absent release metadata. In `shared/contracts.test.mjs`, require the public release and route fields. Require exact PID plus process-start identity and route authentication before startup becomes ready. These tests must fail today because release status, public route generation, and adoption-before-version comparison do not exist. Older and unknown workers remain live and become `STALE`; equal workers remain current; incompatible protocol versions remain unavailable without signaling their processes. A newer worker remains live and is marked `NEWER`, not stale. A launch's first adopted route is generation 2 because `register` mints a generation before `adopt`, so assertions must read `router.route(...).routeGeneration` rather than pinning a number.
- **Implementation:** In `runtime/reconciliation.mjs`, `runtime/daemon.mjs`, `runtime/state-migration.mjs`, and `runtime/runtime-activity.mjs`, persist package semantic version as optional `cliVersion` and worker protocol as integer `proto` beside each private worker identity. Absence of `cliVersion` means `UNKNOWN`, which follows the stale replacement path but is never treated as a downgrade. During ordinary daemon startup, adopt every protocol-compatible route first, then compare semantic release versions. Persist the current private worker `routeGeneration` after successful adoption. In `shared/contracts.mjs`, admit `workerCliVersion`, `stale`, and `routeGeneration` in the read-only `agents --json` row so Gate 1 does not inspect daemon memory or infer adoption from process state. `runtime/daemon.mjs` projects all three fields from router state when serving `get_state`; it never writes them to the session record. Persisting them would bump the row revision on every adoption and make an exact-revision Stop or respawn fail after every daemon restart. Do not add dual socket protocol parsers.
- **Why optional is not old-format support:** The current live workers have no release field in `daemon/workers.json`. The daemon tolerates that absent optional fact only after authenticating the live socket and verifying exact process identity. It does not parse retired files, start old workers, or accept an old socket protocol.
- **Stop:** Gate 1 keeps both original worker identities and reports their release status after the new daemon starts. A worker with absent release metadata is adopted as `UNKNOWN` and is not signaled.

### Commit 5.4: `feat: replace stale workers at a safe boundary`

- **Verified production files (5):** `runtime/daemon.mjs` owns normalized `agent_settled` state, session lifecycle checks, process signaling, and replacement scheduling; `cli/main.mjs` routes top-level verbs; `cli/session-commands.mjs` parses destructive commands, persists pending requests, applies revision and confirmation checks, and currently claims composer access; `shared/contracts.mjs` must admit `respawn` command status and its payload; `runtime/state-migration.mjs` validates pending CLI action names.
- **Verified tests (6):** Add or invert replacement cases in `runtime/daemon.integration.test.mjs`, `runtime/reconciliation.failure.test.mjs`, and `test/destructive-actions.integration.test.mjs`. Update `cli/main.test.mjs` and `cli/session-commands.test.mjs` for top-level `respawn`, and `runtime/state-migration.test.mjs` for pending `respawn` state. These are behavior rewrites except the migration fixture update.

- **Tests:** In `runtime/daemon.integration.test.mjs` and `test/destructive-actions.integration.test.mjs`, keep a busy stale or unknown worker unchanged. Replace it only after structured state reports `taskState: READY`, with no blocking user-interface request, or after a successful `pi-agents respawn <full-id> --revision <n> --yes` request at that same idle boundary. In `cli/session-commands.test.mjs`, cover the full identifier, revision, and confirmation contract. These tests must fail today because stale classification and `respawn` do not exist. `respawn` refuses `WORKING` and `WAITING` sessions without signaling them. Preserve the canonical Pi session and command-journal stages. Refuse an automatic or explicit replacement when the worker release is newer than the daemon.
- **Implementation:** In `runtime/daemon.mjs`, add one serialized replacement operation under the session lifecycle and ownership checks, bounded to three concurrent upgrade respawns across sessions. Before replacement, persist `pendingRespawn: "upgrade"`; daemon restart resumes that guarded operation only after adoption. Schedule it from the normalized `agent_settled` state that produces `taskState: READY`, or from the top-level `respawn` command in `cli/main.mjs` and `cli/session-commands.mjs`. Read the four-valued classification from `router.releaseStatus(sessionId)`, which returns `CURRENT`, `STALE`, `NEWER`, or `UNKNOWN`. Revalidate the revision, worker and Pi identity, route, release status, and idle state at the replacement boundary. Record busy and downgrade refusals as diagnostics and leave the worker running. `respawn` follows the existing destructive-command convention: full identifier, exact revision, and `--yes`.
- **Risk:** A false idle fact could interrupt work. Only normalized Pi events and the structured row state may open the boundary; terminal bytes and session-file contents may not.
- **Stop:** Busy workers survive upgrades, idle stale or unknown workers replace once, `respawn` uses the same guarded path, and neither automatic nor explicit downgrade signals the worker.

## Change 6: rows show only models that Pi confirmed

**Outcome:** A failed launch never displays a requested model that Pi did not run. The row remains unset until Pi confirms its model at readiness.

**Estimate:** 1 commit, 0.5 to 1 engineer-day.

### Commit 6: `fix: record only Pi-confirmed session model`

- **Verified production files (3):** `runtime/launch-resolver.mjs` copies `payload.model` into both the prepared `SessionRecord` and supervisor request; retain only the latter. `runtime/daemon.mjs` owns journal acceptance, `modelCatalog.models()`, launch resolution, socket `get_state`, and `record_model`, so admission and confirmed-model persistence belong there. `app/list/dashboard.mjs` clears launch failures during later timer-driven state changes and must retain a refusal until input or action.
- **Verified tests (3):** Invert the prepared-record assertion in `runtime/launch-resolver.test.mjs`; rewrite the launch/admission and readiness matrix in `runtime/daemon.integration.test.mjs`; update `app/list/dashboard.test.mjs` for refusal lifetime. `runtime/pi-model-catalog.test.mjs` tests catalog parsing only and needs no change.

- **Tests:** In `runtime/launch-resolver.test.mjs`, keep requested model in worker arguments but not the prepared record. In `runtime/daemon.integration.test.mjs`, cover default selection, accepted request, Pi substitution, omitted model, failure before and after spawn, and restart. Cover catalog-listed, known absent, unavailable catalog, and no requested model. Assert `MODEL_CATALOG_FAILED` remains distinct from `MODEL_UNKNOWN`. A known admission refusal leaves a terminal `FAILED` journal result but no session record, Pi file, worktree, worker, list event, or row. Test the refusal before calling `resolveLaunchRequest`; otherwise the test cannot detect accidental preparation. Its status-line message remains through timer callbacks and clears on the next simulated keystroke or action. A failure after preparation retains its `FAILED` row.
- **Implementation:** Validate model admission in the daemon after journal acceptance and before launch resolution. Stop copying requested model into the prepared record. Carry normalized initial Pi state through socket readiness and apply the confirmed model in the same lifecycle write. Absence remains unknown. A catalog failure records `MODEL_CATALOG_FAILED` and lets Pi decide. Keep Pi-reported thinking display-only. Keep a refusal on the status line until the operator's next keystroke or action; do not clear it on a timer.
- **Stop:** One ready revision contains the Pi-confirmed model; every failure window leaves it absent; Gate 2 passes.

## Change 7: stale list history cannot crash dashboard startup

**Outcome:** The dashboard starts from current registry state instead of replaying thousands of old list records. Burst updates converge to current rows without a queue that grows with the burst. The daemon and dashboards upgrade together.

**Estimate:** 3 commits in 1 release, 1 to 2 engineer-days, net deletion of 350 to 600 lines.

### Commit 7.1: `feat: add race-safe list invalidation`

- **Verified production files (3):** `shared/contracts.mjs` defines `subscribe`, `ack`, event cursors, persisted list events, and optional `get_state.cursor`; `app/daemon-client.mjs` reconnects list subscriptions and maintains a replay queue; `app/list/dashboard.mjs` adapts replay into snapshots, acknowledgements, resynchronization, and persisted cursor updates.
- **Verified tests (4):** Rewrite replay tests in `app/daemon-client.test.mjs` and `app/list/dashboard.test.mjs` around subscribe-first invalidation and bounded dirty state. Update `shared/contracts.test.mjs` for required coverage cursors and the new frames. Rewrite `test/dashboard-resync.acceptance.test.mjs` to assert final snapshots rather than event replay.

- **Tests:** In `app/list/dashboard.test.mjs`, cover changes before subscribe, during snapshot, after response, and during reconnect. Replace replay and acknowledgement assertions with final snapshot state. Send 10,000 invalidations and require bounded pending work and at most three reads for one burst plus one change during a read.
- **Implementation:** Add `subscribe_list_changes` and payload-free `list_changed` to `shared/contracts.mjs`. Make the snapshot coverage `cursor` required in every successful `get_state` response, including test doubles. On open and reconnect, subscribe first, set one dirty Boolean, read `get_state`, and refetch once if a notification arrived during the read. While a read is active, any number of notifications only sets that Boolean. No invalidation queue is permitted.
- **Stop:** The before-subscribe, during-read, after-read, and reconnect races converge. A burst of 10,000 notifications plus one notification during a read performs at most three `get_state` reads and retains at most one dirty flag.

### Commit 7.2: `refactor: publish list invalidations only`

- **Verified production files (4):** `runtime/daemon.mjs` creates the cursor store, handles `subscribe`/`ack`, appends and broadcasts list events, and publishes every mutation; `runtime/reconciliation.mjs` creates `EventStore` and appends repair events; `shared/contracts.mjs` parses the old operations and persisted event shapes; `app/daemon-client.mjs` still sends `subscribe` on reconnect and must send only `subscribe_list_changes` after Change 7.1.
- **Verified tests (6):** Rewrite `runtime/daemon.integration.test.mjs`, `runtime/reconciliation.failure.test.mjs`, and `test/dashboard-resync.acceptance.test.mjs` for payload-free invalidation after durable mutations. Invert old `subscribe` cases in `shared/contracts.test.mjs`. Update `app/daemon-client.test.mjs` to pin the final operation name and reconnect behavior, and replace the persisted `command_changed` protocol canary in `cli/session-commands.test.mjs` with `list_changed`.

- **Tests:** Require `list_changed` after each durable session mutation and completed Delete. Reject `subscribe` as an unknown operation through the ordinary strict contract. New roots omit `index/events.jsonl` and `daemon/event-acks.json`.
- **Implementation:** Replace list events with an in-memory broadcaster in `runtime/daemon.mjs` and `runtime/reconciliation.mjs`. Remove `subscribe` from the contract and do not replay retired events. Add no fallback or special old-protocol response.
- **Stop:** Write, notification, and snapshot order is deterministic. Production contains one list subscription protocol.

### Commit 7.3: `refactor: remove list cursor persistence`

- **Verified production files (7):** Delete `runtime/event-store.mjs`. Remove its import, creation, replay, append, and close calls from `runtime/reconciliation.mjs`; remove `createCursorStore`, `daemon/event-acks.json`, event cursor responses, and acknowledgements from `runtime/daemon.mjs`; remove list cursor state and saves from `app/list/dashboard.mjs`; remove cursor validation from `app/list/frontend-state.mjs`; remove cursor persistence plumbing from `app/list/standalone-list.mjs`; remove retired-path validators from `runtime/state-migration.mjs`. The required `get_state` coverage cursor remains in memory and is not the retired replay cursor.
- **Verified tests (7):** Delete `runtime/event-store.test.mjs` only after callers are gone. Rewrite cursor-save cases in `app/list/dashboard.test.mjs`; update `app/list/standalone-list.test.mjs`, `runtime/daemon.integration.test.mjs`, `runtime/reconciliation.failure.test.mjs`, `runtime/state-migration.test.mjs`, and `test/dashboard-resync.acceptance.test.mjs` for no retired path and no persisted frontend cursor.

- **Tests:** Replace cursor-save tests with view-state and draft tests. Require the `get_state` coverage cursor and remove `runtime/event-store.test.mjs` only after production callers are gone.
- **Implementation:** Remove list cursor saves, acknowledgements, replay queues, resynchronization markers, and cursor comparison. Delete `runtime/event-store.mjs`. Keep the required snapshot coverage cursor in memory for the subscribe/read race. Remove all production references to `index/events.jsonl` and `daemon/event-acks.json`; the retired files then have no effect without an ignore branch.
- **Stop:** New frontend state omits a persisted cursor, every `get_state` result includes its coverage cursor, and no list event store or retired path opens.

## Change 8: every client can write and frontend state stays local

**Outcome:** Three dashboards do not overwrite one another's drafts or selections. Every attached client may submit commands to one session. The daemon orders those commands through the existing per-session coordinator and records each accepted mutation in the command journal.

**Estimate:** 1 commit, 0.5 to 1 engineer-day, net deletion of 250 to 500 lines.

### Commit 8: `refactor: remove session access roles`

- **Verified production files (18):** Delete `runtime/attachment-result-store.mjs` and `app/list/frontend-state.mjs`. `runtime/daemon.mjs` owns attachment claims, role authorization, attach/detach recovery, attachment events, and socket authentication; `runtime/reconciliation.mjs` stores viewer roles and reconstructs role-bearing snapshots; `runtime/command-journal.mjs` has attachment reconciliation; `runtime/state-migration.mjs` validates attachment results and shared frontend state; `shared/contracts.mjs` defines attachment roles, attach/detach operations, role-bearing events, and responses; `shared/viewer-contracts.mjs` requires snapshot `role`; `runtime/viewer-normalizer.mjs` emits `role` in each snapshot; `runtime/viewer-store.mjs` validates and persists those snapshots; `app/daemon-client.mjs` sends the socket authentication frame and must carry process-scoped `attachId`; `app/standalone.mjs` currently supplies only stable `clientId`; `app/list/standalone-list.mjs` claims/releases composer and writes shared state; `app/list/dashboard.mjs` claims composer for destructive actions and persists drafts/selections; `app/viewer/viewer-controller.mjs` gates editing, commands, hints, and reconnect on role; `app/viewer/transcript.mjs` copies role into local state; `cli/session-commands.mjs` and `cli/daemon-commands.mjs` claim and release composer around mutations.
- **Verified tests (23 plus 2 snapshots):** Delete `runtime/attachment-result-store.test.mjs`. Rewrite role and attachment behavior in `runtime/daemon.integration.test.mjs`, `runtime/reconciliation.failure.test.mjs`, `runtime/command-journal.test.mjs`, `shared/contracts.test.mjs`, `shared/viewer-contracts.test.mjs`, `runtime/viewer-normalizer.test.mjs`, `runtime/viewer-store.test.mjs`, `app/daemon-client.test.mjs`, `app/list/standalone-list.test.mjs`, `app/list/dashboard.test.mjs`, `app/viewer/viewer-controller.test.mjs`, `app/viewer/transcript.test.mjs`, `cli/session-commands.test.mjs`, `cli/daemon-commands.test.mjs`, `test/dashboard-resync.acceptance.test.mjs`, `test/destructive-actions.integration.test.mjs`, `test/lifecycle.acceptance.test.mjs`, `test/viewer-recovery.integration.test.mjs`, `test/terminal.acceptance.test.mjs`, and `test/terminal-pty.acceptance.test.mjs`. Update `runtime/state-migration.test.mjs` and `app/standalone.test.mjs` for removed shared files and generated `attachId`. Update `app/viewer/__snapshots__/viewer-controller.test.mjs.snap` and `test/__snapshots__/terminal.acceptance.test.mjs.snap` to remove role text. Tests for independent drafts and three concurrent writers replace, rather than weaken, the deleted one-composer tests.

- **Tests:** Open three dashboard processes on one session, assert three handshake `attachId` values and one stable request `clientId`, submit commands concurrently, and require the daemon to accept and journal them in one order. Change each dashboard's draft and selection, then close them in different orders and require independent local state. Restart the daemon while workers retain exact identity. Assert no role, claim, grant, release, takeover, access-change event, `SESSION_IN_USE`, shared `frontend-state.json` write, or attachment artifact remains.
- **Implementation:** Remove composer and observer from viewer snapshots, contracts, controllers, status text, and command authorization. Remove `session_access_changed`, explicit composer acquisition, and release-on-close handling. Remove `AttachmentResultStore`, attach and detach journal transitions, attachment list events, failpoints, and recovery. Delete `runtime/attachment-result-store.mjs` and every production reference to `daemon/attachment-results.jsonl`. Keep authenticated viewer subscriptions and the per-session command coordinator. Generate `attachId` at dashboard startup and add it to the socket authentication frame; bind connection-scoped state to that value and the socket. Keep stable installation `clientId` in each durable request envelope. Do not reuse `cli/client-id` as `attachId`. Keep each dashboard's selection, view state, and launch draft in its own process memory, and stop reading or writing the shared `frontend-state.json`. Process death may lose an unsubmitted draft.
- **Stop:** Three dashboard processes submit ordered, journaled commands to one session and retain different drafts and selections until each process exits. No access role, shared frontend-state writer, or durable attachment artifact exists; Gate 3 passes.

## Change 9: obsolete acknowledgement files cannot block recovery

**Outcome:** Viewer acknowledgement files no longer participate in recovery. Ordered viewer events, snapshots, queues, stable IDs, and resume behavior remain.

**Estimate:** 2 commits, 0.5 to 1 engineer-day, net deletion of 100 to 180 lines.

### Commit 9.1: `refactor: keep viewer resume state in the frontend`

- **Verified production files (2):** `app/viewer/viewer-controller.mjs` persists the applied cursor and then calls `client.ack`; remove that call while retaining post-application cursor advancement. `app/list/standalone-list.mjs` implements `client.ack` by calling `ackViewer`; remove the adapter method.
- **Verified tests (3):** Invert acknowledgement expectations and add the three disconnect windows in `app/viewer/viewer-controller.test.mjs`; update `app/list/standalone-list.test.mjs` to expose no acknowledgement method; rewrite `test/viewer-recovery.integration.test.mjs` to resume from the frontend cursor without `ackViewer`. `app/daemon-client.test.mjs` remains for Change 9.2 because the low-level operation still exists after this commit.

- **Tests:** In `app/viewer/viewer-controller.test.mjs`, disconnect before processing, after processing, and after local cursor advancement. Spy on the client and require zero `ack_viewer` calls. Reconnect from each retained in-memory cursor and require a repeated stable event ID not to duplicate transcript content. The test must fail if cursor advancement happens before successful application.
- **Implementation:** Remove frontend `ack_viewer` calls. Advance the in-memory cursor only after successful application. Keep ordered events, snapshots, bounded queues, and stable IDs.
- **Stop:** No item is skipped or duplicated in all three windows.

### Commit 9.2: `refactor: retire viewer acknowledgement files`

- **Verified production files (4):** `runtime/viewer-store.mjs` creates `.acks.json`, loads acknowledgements, and exposes `acknowledge`; `runtime/daemon.mjs` handles `ack_viewer`; `shared/contracts.mjs` parses that operation and response; `app/daemon-client.mjs` tracks acknowledgement responses and exposes `ackViewer`. Neither `runtime/state-migration.mjs` nor `runtime/paths.mjs` names viewer acknowledgement files.
- **Verified tests (5):** Delete only the acknowledgement-specific cases in `runtime/viewer-store.test.mjs` while retaining corruption tests for events, checkpoints, and snapshots. Invert/remove operation cases in `runtime/daemon.integration.test.mjs`, `shared/contracts.test.mjs`, and `app/daemon-client.test.mjs`. Rewrite `test/viewer-recovery.integration.test.mjs` for zero acknowledgement calls and opens. `runtime/state-migration.test.mjs` has no viewer-acknowledgement fixture, and `runtime/control-server.test.mjs` mentions only generic acknowledgements; neither changes.

- **Tests:** Corrupt event, checkpoint, or snapshot state still fails. Remove acknowledgement contract and file-format tests after production callers are gone.
- **Implementation:** Remove acknowledgement loading and methods from `runtime/viewer-store.mjs`. Remove `ack_viewer` from the contract. Stop creating acknowledgement paths and remove every production reference to `index/viewer/*.acks.json`; retired files then have no effect without an ignore branch.
- **Stop:** No `.acks.json` path or `ack_viewer` operation remains, and Gate 4 transcript checks pass.

## Change 10: `rm` remains forget-only without unused recovery

**Outcome:** `rm` removes only the dashboard row and preserves the Pi file and worktree. The obsolete `daemon/delete-results.json` format disappears with its unused recovery code.

**Estimate:** 2 commits, 0.5 to 1 engineer-day, net deletion of 200 to 400 lines.

### Commit 10.1: `refactor: make rm forget-only`

- **Verified production files (1):** `runtime/daemon.mjs` is the only production file containing the optional `trashSessionFile` seam and its call. Keep its revision, inactivity, ownership, launch, route, process-identity, and lifecycle-lock checks, then remove the filesystem mutation branch.
- **Verified tests (1):** Rewrite the trash-oriented matrix in `test/destructive-actions.integration.test.mjs` as forget-only path-mutation canaries covering inactive, live, stale, changed-revision, and concurrent-relaunch cases. No other active test calls `trashSessionFile`.

- **Tests:** In `test/destructive-actions.integration.test.mjs`, cover inactive, live, stale metadata, changed revision, and concurrent relaunch. Every success preserves the canonical Pi file and worktree. Inject filesystem spies that fail on `rename`, `unlink`, `rm`, or any other mutation beneath either path; reads used to verify identity remain allowed.
- **Implementation:** Remove `trashSessionFile`. Keep revision, inactive state, ownership, launch, metadata, route, exact process identity, and per-session lock checks before registry removal.
- **Stop:** Successful `rm` changes only registry and journal artifacts. Any mutating filesystem call beneath the canonical session or worktree path fails the test.

### Commit 10.2: `refactor: retire trash recovery`

- **Verified production files (2):** `runtime/daemon.mjs` contains `createDeleteResultStore`, transaction phases, fingerprints, recovery branches, failpoints, open, and close calls. `runtime/state-migration.mjs` contains the only separate validator for `daemon/delete-results.json`. There is no standalone delete-result-store module to delete.
- **Verified tests (2):** Delete the transaction and reconciliation cases from `test/destructive-actions.integration.test.mjs` after Change 10.1's forget-only tests pass. Remove the retired-format fixture from `runtime/state-migration.test.mjs`. Keep lifecycle, revision, and path-preservation assertions.

- **Tests:** Remove delete-result transaction tests after the production callers are gone. Keep forget-only lifecycle and revision tests.
- **Implementation:** Remove the delete-result store, transaction phases, destructive failpoints, file fingerprints, reconciliation, legacy guard, and every production reference to `daemon/delete-results.json`.
- **Stop:** No production or test code names `daemon/delete-results.json`. Gate 4 `rm` checks pass.

The guard and compatibility parser are intentionally absent. On 2026-08-29, `daemon/delete-results.json` was absent on the operator's machine. Production never supplied a trash callback, so no shipped code path could have created a nonempty transaction.

## Change 11: `logs` exposes the error already on disk

**Outcome:** An operator can read the recent daemon or session run log after a startup failure. `WORKER_PROCESS_EXITED` no longer leaves the underlying Pi diagnostic accessible only by finding a file manually.

**Estimate:** 1 commit, 0.5 engineer-day.

### Commit 11: `feat: add bounded logs command`

- **Verified production files (2):** `cli/main.mjs` owns top-level routing and help. `cli/session-commands.mjs` owns exact-ID parsing, root resolution, safe no-follow file helpers, and command result formatting. The reader consumes, but does not change, the paths established by `runtime/worker-supervisor.mjs` and `runtime/rotating-diagnostics.mjs`. `SessionRecord.runHash` is already added in Change 5.1, so neither `runtime/launch-resolver.mjs` nor the contracts need another schema change here.
- **Verified tests (3):** Add command routing and syntax cases to `cli/main.test.mjs`; add the bounded reader, exact-ID lookup, renamed-root, and pre-ready matrix to `cli/session-commands.test.mjs`; update `test/package.acceptance.test.mjs` for installed help. `cli/daemon-commands.test.mjs` already pins `daemon/startup.log` creation and needs no change.

- **Tests:** Cover daemon and exact session IDs, missing logs, files shorter and longer than the bound, partial UTF-8 at a read boundary, symlinks, replacement during read, a renamed temporary state root, and Pi output followed by a pre-ready `WORKER_PROCESS_EXITED`. The last case must resolve from the prepared `SessionRecord`; worker metadata does not exist before ready. The renamed-root case must fail if the record stores an absolute run path.
- **Implementation:** Add `pi-agents logs [<full-session-id>]`. With no ID, read `daemon/startup.log`. With an ID, resolve `SessionRecord.runHash` beneath `<current-root>/runs`, then read `worker.stderr.log` and the newest `diagnostics/stderr.*.jsonl` segment. Print the full path of each source before its content. Read the newest Pi stderr tail first, up to 262,144 bytes, then use any remaining budget for worker stderr; emit only complete UTF-8 content. Open with no-follow, require owned regular files, compare device and inode before and after each read, and reject a path that escapes the current root. The record stores only the run hash, never an absolute path, so an in-place state-root rename does not break logs. Do not add an in-memory ring or treat logs as viewer history.
- **Why pre-ready lookup is required:** The observed failure was `WORKER_PROCESS_EXITED` before readiness, while Pi's complaint remained in `runs/<hash>/diagnostics/stderr.*.jsonl`. A lookup that depends on adopted worker metadata misses this failure.
- **Stop:** The command prints source paths and the latest complete UTF-8 diagnostic tail, works before worker readiness and after a root rename, and cannot read outside owned log paths.

## Change 12: operator commands use Claude Code's verbs

**Outcome:** `agents`, `attach`, `logs`, `stop`, `rm`, and `respawn` use Claude Code's operator-facing verbs.

**Estimate:** 1 commit, 0.5 to 1 engineer-day.

### Commit 12: `feat: adopt background-session command names`

- **Verified production files (5):** `cli/main.mjs` owns the top-level parser and help text; `cli/session-commands.mjs` parses `session status`, `session stop`, and `session delete`, validates pending action names, and formats recovery guidance; `runtime/state-migration.mjs` validates persisted pending actions and must use the renamed destructive operations; `app/standalone.mjs` is the dashboard entry point and must pass an exact initial session; `app/list/standalone-list.mjs` owns `openRealViewer` and must open that initial session for `attach` without changing normal list startup.
- **Verified tests (6):** Rewrite `cli/main.test.mjs` and `cli/session-commands.test.mjs` for `agents`, `attach`, `logs`, `stop`, `rm`, and `respawn`, including ordinary syntax errors for old forms. Update `runtime/state-migration.test.mjs` for pending action names and `test/package.acceptance.test.mjs` for installed help. Update `app/standalone.test.mjs` and `app/list/standalone-list.test.mjs` for direct initial attachment. `test/terminal-pty.acceptance.test.mjs` invokes only `daemon stop` and needs no change.

- **Tests:** Require `pi-agents agents`, `pi-agents attach <full-id>`, `pi-agents logs [<full-id>]`, `pi-agents stop <full-id> --revision <n> --yes`, `pi-agents rm <full-id> --revision <n> --yes`, and `pi-agents respawn <full-id> --revision <n> --yes`. Assert the old `session status`, `session stop`, and `session delete` forms return ordinary syntax errors. Keep exact IDs, revision guards, confirmation, pending-request recovery, and JSON output.
- **Implementation:** Name the list entry point `agents`; expose direct viewer opening as `attach`; move `session stop` to `stop`; rename `session delete` to `rm`; and expose the guarded stale-worker replacement from Change 5.4 as `respawn`. Delete the three old parser branches and help text. Keep `session cleanup` and `session resolve-delivery` under the recovery namespace because they have no Claude Code equivalent.
- **Stop:** Help and protocol adapters use one spelling for each operator action, and no compatibility aliases remain.

## Change 13: measure whether one prewarmed spare earns its resident cost

**Outcome:** The next spare decision uses measured launch latency and memory instead of an indefinite deferral.

**Estimate:** 1 commit, 0.5 engineer-day.

### Commit 13: `test: measure cold session launch`

- **Verified production/config files (4):** Add `perf/cold-launch-sample.mjs` as the one-sample driver and `perf/submit-cold-launch.py` as the submitit launcher; update `pixi.toml` with Python and submitit; update the generated `pixi.lock`. Existing `perf/transition-latency.mjs` measures terminal rendering transitions and has no cold-launch stage reference, so it does not change.
- **Verified tests and snapshots (0):** No current test, fixture, canary, or snapshot names cold-launch stages, submitit, or a spare. The new driver remains outside Vitest discovery, as the approved check requires.

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

## How to use the remaining file lists

The lists for every remaining commit are starting points, not inventories. Every implementer must search the repository for the changed seam before editing, add every relevant production and test file the search finds, and exclude listed files that have no relevant reference. The completed Changes 1 through 3 demonstrated both errors. Already completed before Change 5: `runtime/session-command-projection.mjs` owns the shared projection, thinking launch and relaunch arguments are gone, and `SESSION_COMMANDS` is `set_model`, `compact`, `set_session_name`, and `abort_retry`.

## File collisions

| Files | Changes | Merge rule |
|---|---|---|
| `runtime/daemon.mjs`, `runtime/daemon.integration.test.mjs` | 5.1-5.4, 6, 7.2-7.3, 8, 9.2, 10.1-10.2 | Serial; this is the highest-collision seam |
| `runtime/reconciliation.mjs`, `runtime/reconciliation.failure.test.mjs` | 5.1-5.3, 7.2-7.3, 8 | Rebase after each transport, list, and access change |
| `runtime/worker-supervisor.mjs`, `runtime/worker-supervisor.test.mjs` | 5.1-5.2 | Rewrite IPC fixtures before removing the launch handle |
| `runtime/installed-pi-worker.mjs`, `runtime/worker.integration.test.mjs` | 5.1 | Socket startup and reconnect only; thinking launch work is already done |
| `runtime/launch-resolver.mjs`, `runtime/launch-resolver.test.mjs` | 5.1, 6 | Add `runHash`, then remove requested model from the prepared row |
| `shared/contracts.mjs`, `shared/contracts.test.mjs` | 5.1, 5.3-5.4, 7.1-7.2, 8, 9.2 | Record fields, list protocol, connection identity, roles, and acknowledgements |
| `shared/viewer-contracts.mjs`, `runtime/viewer-normalizer.mjs`, and tests | 8 | Remove the viewer snapshot role at every producer and validator |
| `runtime/registry-store.mjs`, `runtime/registry-store.test.mjs` | 5.1 | Keep its independent persisted-record allowlist synchronized with the `runHash` record field; adopted-worker row projections are not persisted here |
| `runtime/runtime-activity.mjs`, `runtime/runtime-activity.test.mjs` | 5.1, 5.3 | Keep the independent `daemon/workers.json` allowlist synchronized with private worker metadata |
| `runtime/state-migration.mjs`, `runtime/state-migration.test.mjs` | 5.1, 5.3-5.4, 7.3, 8, 9.2, 10.2, 12 | Current worker/CLI formats plus deletion of retired-path validators |
| `app/daemon-client.mjs`, `app/daemon-client.test.mjs` | 7.1-7.2, 8, 9.2 | List invalidation, `attachId`, then viewer acknowledgement removal |
| `app/list/dashboard.mjs`, `app/list/dashboard.test.mjs` | 6, 7.1, 7.3, 8 | Status lifetime, invalidation, cursor removal, and local state |
| `app/list/standalone-list.mjs`, `app/list/standalone-list.test.mjs` | 7.3, 8, 9.1, 12 | Remove shared list state and roles, remove the viewer acknowledgement adapter, then add direct attachment |
| `app/standalone.mjs`, `app/standalone.test.mjs` | 8, 12 | Generate process attachment identity, then pass the direct-attach target |
| `app/list/frontend-state.mjs` and its callers/tests | 7.3, 8 | Remove cursor first; delete shared frontend persistence with roles |
| `app/viewer/viewer-controller.mjs`, test, and snapshot | 8, 9.1 | Remove role gating before changing local viewer resume |
| `runtime/viewer-store.mjs`, `runtime/viewer-store.test.mjs` | 8, 9.2 | Remove snapshot roles, then retire acknowledgement files while retaining corruption tests |
| `runtime/event-store.mjs`, `runtime/event-store.test.mjs` | 7.3 | Delete only after invalidation is live |
| `runtime/attachment-result-store.mjs`, test | 8 | Delete with role and attachment recovery |
| `cli/main.mjs`, `cli/main.test.mjs` | 5.4, 11, 12 | Add `respawn`, add `logs`, then rename all top-level verbs |
| `cli/session-commands.mjs`, test | 5.4, 8, 11, 12 | Respawn, role removal, logs, and verb migration |
| `cli/daemon-commands.mjs`, test | 8 | Remove composer claims; its startup-log fixture remains unchanged in Change 11 |
| `test/destructive-actions.integration.test.mjs` | 5.1-5.2, 5.4, 8, 10.1-10.2 | Transport/roles first, then replace trash recovery with forget-only canaries |
| `test/dashboard-resync.acceptance.test.mjs` | 7.1-7.3, 8 | Rewrite replay assertions before removing roles |
| `test/viewer-recovery.integration.test.mjs` | 8, 9.1-9.2 | Remove roles, then frontend and durable acknowledgements |
| `test/__snapshots__/terminal.acceptance.test.mjs.snap` | 8 | Remove role labels; thinking-control snapshot changes are already done |
| `pixi.toml`, `pixi.lock`, `perf/cold-launch-sample.mjs`, `perf/submit-cold-launch.py` | 13 | Add only the opt-in measurement |
| `docs/architecture.md`, `docs/development.md` | 5-13 | Update serially after production commits |

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
