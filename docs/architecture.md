# Architecture

`pi-agents` has three dashboard process roles: one frontend, one daemon for a state root, and one worker for each live session. Each worker starts a separate installed `pi` child. The daemon owns durable dashboard state. Pi owns the agent and its canonical session file.

## Process roles separate the interface, state, and Pi lifetime

### The frontend handles terminal input and rendering

[`bin/pi-agents.mjs`](../bin/pi-agents.mjs) selects one state root before loading the command-line interface. With no command, [`runDashboardApp`](../app/standalone.mjs) connects to or starts the daemon and opens [`createStandaloneList`](../app/list/standalone-list.mjs).

The frontend renders the list and viewer. It sends version 1 requests over the daemon's Unix socket. It does not write session records or talk to Pi's remote procedure call (RPC) stream directly. Closing the frontend closes that socket and terminal interface only.

### The daemon is the single state writer

[`createDaemonRuntime`](../runtime/daemon.mjs) owns the session registry, command journal, ordered list event log, normalized viewer stores, attachment roles, and worker routes. It authenticates local socket connections with `daemon/control.token` and reconciles durable state before accepting mutations.

All session-record writes run in this process through [`RegistryStore`](../runtime/registry-store.mjs). Per-session lifecycle operations use [`runSessionLifecycle`](../runtime/registry-store.mjs), which serializes changes for one session without serializing unrelated sessions.

### A worker keeps one Pi process alive

[`WorkerSupervisor`](../runtime/worker-supervisor.mjs) starts one detached [`runtime/worker.mjs`](../runtime/worker.mjs) process for a session. [`runInstalledPiWorker`](../runtime/installed-pi-worker.mjs) then starts the installed executable with arguments built by [`piRpcArgv`](../runtime/pi-rpc-adapter.mjs):

```text
pi --mode rpc --session <canonical-session-file>
```

The worker owns Pi's stdin, stdout, and stderr pipes. Pi treats the RPC stdin pipe as its lifetime. If the process holding that pipe disappears, the pipe closes and Pi exits. A live parent is therefore required for every session. The worker persists command delivery around writes to Pi, forwards commands and Pi frames or events, and reconnects to a restarted daemon.

The daemon may exit without stopping a worker. The worker remains Pi's parent and reconnects through [`maintainDaemonConnection`](../runtime/worker.mjs). Closing the frontend or restarting the daemon therefore does not make Pi depend on a terminal or daemon socket.

## A launch moves through five boundaries

1. [`DashboardController.submitComposer`](../app/list/dashboard.mjs) treats a nonempty, non-slash line as a launch. The frontend canonicalizes the working directory and asks for exact confirmation when shared-directory isolation is selected.
2. [`createDaemonDashboardBackend.launch`](../app/list/dashboard.mjs) sends a version 1 `launch` request. The daemon records its delivery stage in `queue/commands.jsonl` before starting work.
3. [`createLaunchResolver`](../runtime/launch-resolver.mjs) repeats trusted isolation checks in the daemon. It creates a managed worktree or confirms the shared directory, asks Pi's public `SessionManager` for a canonical session file, and creates the initial `SessionRecord`.
4. [`WorkerSupervisor.launch`](../runtime/worker-supervisor.mjs) resolves and probes the Pi executable, acquires the ownership lease, reserves the run by its per-run token, starts the detached worker, and verifies the worker and Pi process identities. The worker connects to the control socket at startup and sends `hello`; the daemon holds that connection until the spawned PID is known, then binds it only if the claimed PID, process start identity, and process group match the process it spawned. `activate`, `pi_child`, `child_bound`, and `worker_ready` all travel on that one socket. The worker opens Pi in RPC mode and checks `get_state` against the canonical session path, and reports the model that state named in its `worker_ready` frame.
5. The supervisor registers both process identities, adopts the startup connection as the session's route, and only then persists readiness. That same write records the model Pi reported. A row shows a model only after Pi names one: the requested model reaches Pi through the worker's arguments and never the record, so a launch that fails before Pi runs shows no model at all. The daemon delivers the launch prompt over that route as the first durable `prompt` command, outside the session lifecycle lock, because the worker's reply re-enters that lock. The list replaces its temporary `STARTING` row with the session record received from the event stream.

A failure before a child owns the session marks the prepared record `FAILED`. Delivery that cannot be proved remains `DELIVERY_UNKNOWN`; the daemon does not guess whether Pi received it.

## A worker behind the daemon's release is replaced only at an idle boundary

A daemon adopts every protocol-compatible live worker before it compares releases, so an upgrade never refuses a running session. A worker whose recorded `cliVersion` is behind the daemon's, or absent, is then replaced by [`replaceStaleWorker`](../runtime/daemon.mjs), which runs once, serialized under the session lifecycle lock, from one of two boundaries:

- Pi settling the run. [`sessionEventForPiEvent`](../runtime/session-event-mapping.mjs) maps `agent_settled` to `TURN_COMPLETED`, and the row it reduces to opens the boundary. Only that reduced record decides: [`idleForRespawn`](../runtime/daemon.mjs) requires `taskState: READY`, `processState: LIVE`, and no blocking user-interface request. Terminal bytes and the canonical Pi session file may never open it, and `WAITING` is Pi blocked on a person rather than an idle session.
- `pi-agents respawn <full-session-id> --revision <n> --yes`, which takes the same full identifier, exact revision, and explicit confirmation as `stop` and `rm`. It refuses a session that is not idle rather than interrupting a running turn.

At the boundary the operation re-reads every fact it rests on: the revision, the adopted route, both recorded process identities, the release, and the idle state. A worker newer than the daemon is never downgraded: the automatic boundary passes over it, and an explicit `respawn` refuses it. Every refusal the guarded operation reaches is recorded as a daemon diagnostic and leaves the worker running.

Before anything is signalled, the run's private metadata gains `pendingRespawn: "upgrade"`, so a daemon that dies mid-replacement resumes the guarded operation after it has adopted that worker again. The replacement then stops the worker through the same exact-identity boundary Stop uses, forgets the run, and launches a new one. Automatic replacements are bounded to three in flight across sessions, so one upgrade does not restart every idle session at once.

See [`docs/reference/claude-code-behavior.md`](reference/claude-code-behavior.md#release-changes-adopt-workers-before-replacing-them).

## Events are ordered, cursor-based, and snapshot-first

The daemon publishes each session or command change through [`createEventStore`](../runtime/event-store.mjs). It appends the version 1 event to `index/events.jsonl`, syncs it, assigns the next sequence in the current daemon epoch, and then broadcasts it. A cursor is the pair `daemonEpoch` and `sequence`.

Both screens read a snapshot before subscribing:

- [`DashboardController.open`](../app/list/dashboard.mjs) calls `get_state`, adopts the cursor covered by that snapshot, then subscribes after it.
- [`ViewerController.open`](../app/viewer/viewer-controller.mjs) calls `get_viewer_snapshot`, builds the transcript from that snapshot, then subscribes after its per-session cursor.

Consumers process an event before acknowledging its cursor. The frontend persists its list cursor and launch draft. It retains viewer drafts in memory while the app runs. Viewer acknowledgements are durable in the per-session viewer store.

List subscriptions are bounded. If the frontend falls behind, [`createDaemonClient`](../app/daemon-client.mjs) drops the queued backlog and emits one `resynchronize` marker. [`createDaemonDashboardBackend`](../app/list/dashboard.mjs) then fetches a new state snapshot and resumes after the newest cursor covered by that snapshot. Falling behind is a request to resynchronize, not a terminal stream error.

Viewer data has a separate ordered store per session. [`createViewerNormalizer`](../runtime/viewer-normalizer.mjs) converts Pi frames into the version 1 shapes in [`shared/viewer-contracts.mjs`](../shared/viewer-contracts.mjs). Frontends never receive raw Pi RPC frames.

## Durable state is grouped by purpose

[`resolveDashboardRoots`](../runtime/paths.mjs) selects `$PI_AGENTS_STATE_DIR`, or `${XDG_STATE_HOME:-$HOME/.local/state}/pi-agents`. The main contents are:

```text
<state root>/
  dashboard.json
  frontend-state.json
  daemon/
  sessions/
  queue/
  index/
  runs/
```

- `dashboard.json` is the optional schema version 2 configuration.
- `frontend-state.json` stores the frontend client identity, list cursor, view state, and launch draft.
- `daemon/` stores daemon identity and coordination data. This includes `pid.json`, `control.sock`, `control.token`, `epoch`, `lifecycle.lock`, worker routes in `workers.json`, summary settings, event acknowledgements, request result stores, the latest `reconciliation.json`, and `startup.log`. Daemon diagnostics, including a refused worker replacement, are one JSON line each on the daemon's stderr, which `daemon/startup.log` captures. `workers.json` is a mode-0600 owned file because it holds each run's private socket token. A run is written there before its worker is spawned and both process identities are absent until the launch binds them. The token is never rotated during adoption, so a replacement daemon authenticates the same live run; a respawn mints a new one, and terminal reconciliation removes the whole entry. Each entry also records the worker socket protocol as integer `proto`, the release the worker was spawned from as optional `cliVersion`, and the `routeGeneration` of its last successful adoption. A record written before those fields existed carries none of them; an authenticated live version-1 route supplies `proto`, and an absent `cliVersion` means the release is unknown. An entry gains `pendingRespawn: "upgrade"` before the daemon signals a replacement, and loses it with the entry when that run ends.
- `sessions/<sessionId>.json` is the daemon-owned registry. Each version 1 record contains immutable session identity, revision, display state, isolation, ownership, and verified runtime identity when available.
- `queue/commands.jsonl` is the durable command journal. It records acceptance, delivery attempts, acknowledgements, failures, and ambiguous delivery.
- `index/events.jsonl` is the ordered list event log. `index/viewer/<sha256(sessionId)>.*` holds normalized viewer events, recovery checkpoints, the latest snapshot, and client acknowledgements.
- `runs/<hash>/` holds one worker's stdout, stderr, durable Pi-delivery replay log, and rotating raw RPC and Pi stderr diagnostics. The session record keeps that directory name as root-relative `runHash`, so a renamed state root still resolves its own diagnostics.

Two owned paths are outside the state root. Canonical Pi session files remain in the location chosen by Pi's `SessionManager`. Managed worktrees live under Pi's agent directory at `pi-agents/worktrees`.

## Changes must preserve these invariants

- **The daemon is the only writer of session records.** Frontends and workers send versioned messages. Registry creation, updates, and removal stay in the daemon through [`RegistryStore`](../runtime/registry-store.mjs).
- **One daemon owns a state root, and a replacement waits for proof.** `daemon stop`, and the stop half of `daemon restart`, report success only after the published PID, process start identity, and process group stop matching in [`waitForProcessExit`](../cli/daemon-commands.mjs). An absent `daemon/pid.json` is not that proof, because the daemon removes it as the last step of its own shutdown and can still be running afterwards. `daemon start` with no explicit root resolves it through [`adoptRenamedStateRoot`](../runtime/state-root-adoption.mjs), so every start path adopts, defers, or refuses rather than opening an empty root beside existing sessions.
- **Ownership outlives uncertainty.** Release ownership only after both the supervisor and its Pi child are provably gone. PID alone is insufficient. [`WorkerSupervisor`](../runtime/worker-supervisor.mjs) compares PID, process start identity, and process-group ID, and retains the lease when a child identity is live or ambiguous.
- **Delete only forgets dashboard state.** The production daemon has no trash callback. Delete removes the inactive `SessionRecord`; it does not unlink the canonical Pi session file or remove a worktree. Worktree cleanup remains a separate operation in [`isolation/cleanup.mjs`](../isolation/cleanup.mjs).
- **Pi lifecycle event mapping has one home.** [`sessionEventForPiEvent`](../runtime/session-event-mapping.mjs) is the only mapping from Pi RPC events to dashboard session-state events. Viewer frame normalization is the separate read model in [`runtime/viewer-normalizer.mjs`](../runtime/viewer-normalizer.mjs).
- **A revision guard covers the facts an operation uses.** Stop rechecks the exact ownership and process identity at the signaling boundary. Delete rechecks inactive state and record identity. The frontend may retry after unrelated display metadata changes only while the requested destructive action is still the same. Adopting a worker is not a session change, so `workerCliVersion`, `stale`, and `routeGeneration` are added to a row when `get_state` reads it ([`withWorkerAdoption`](../runtime/daemon.mjs)) rather than written to the record: a revision invalidated by every daemon restart would teach the operator to retry past the guard.
- **Background work stays outside operator locks.** Summary inference runs before the short lifecycle write section in [`refreshSummaries`](../runtime/daemon.mjs). Viewer frame ingestion uses the separate frame coordinator in [`RecoveredWorkerRouter.runFrame`](../runtime/reconciliation.mjs). Do not hold a lifecycle or route lock across work that an operator keystroke does not depend on.
- **A failure is scoped to what it can be attributed to.** A response frame [`createDaemonClient`](../app/daemon-client.mjs) cannot parse rejects that one request with `MALFORMED_RESPONSE` and keeps the connection, because destroying it made the reconnect resend the request that provoked the frame. Authentication failure, a transport error, and an unparseable frame that belongs to no request stay fatal.
- **Waiting for another process is bounded, and expiry is ambiguous.** [`PiRpcAdapter`](../runtime/pi-rpc-adapter.mjs) expires one unanswered Pi command after 120 seconds with `RPC_TIMEOUT` and stays usable; the daemon expires one unanswered worker request after 300 seconds. Both leave the command `DELIVERY_UNKNOWN`, never `FAILED`, because the bytes may already have reached Pi.
- **Every process boundary is a versioned contract.** Frontend requests, daemon responses, and list events use [`shared/contracts.mjs`](../shared/contracts.mjs). Viewer snapshots and events use [`shared/viewer-contracts.mjs`](../shared/viewer-contracts.mjs). Worker socket frames and replay records also carry version 1. Change parsers, producers, consumers, and contract tests together.

## Directory map

- `app/list/` contains list state, input, layout, overlays, launch composition, and daemon adaptation. Start with [`app/list/dashboard.mjs`](../app/list/dashboard.mjs).
- `app/viewer/` contains the Pi-style transcript, editor control, overlays, and viewer slash handling. Start with [`app/viewer/viewer-controller.mjs`](../app/viewer/viewer-controller.mjs).
- `app/daemon-client.mjs` owns reconnecting socket transport and subscription queues. `app/standalone.mjs` and `app/list/standalone-list.mjs` assemble the terminal application.
- `runtime/` contains the daemon, registry, journals, recovery, worker supervision, Pi RPC adapter, normalization, and durable stores. Start with [`runtime/daemon.mjs`](../runtime/daemon.mjs).
- `shared/` contains strict contracts shared across process boundaries.
- `isolation/` contains launch preflight, managed worktrees, ownership locks, and explicit cleanup.
- `cli/` contains the operator verbs `agents`, `attach`, `stop`, `rm`, and `respawn`, plus administrative daemon and session-recovery commands. `bin/` contains the installed executable entry point.
- `test/` contains cross-module integration and terminal acceptance tests. Unit tests sit beside their source as `*.test.mjs`.
