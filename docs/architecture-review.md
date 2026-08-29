# Architecture review

The first change should give every live worker one daemon transport. The second should replace the list event log with invalidation plus snapshot reads. Together they remove two failure-prone dual paths and an estimated 700 to 1,200 production lines. The daemon, worker process, ownership lease, and process identity checks should remain.

The three proposed diagnoses are mostly right. Claim (a) has two distinct failure mechanisms, not one. Claim (b) is right about the excess machinery and the observed startup crash, but the 3 ms snapshot cost is not measured in this repository. Claim (c) identifies a real data-model error, though two durable configuration objects would add state that the product does not need.

## Findings on the three claims

### (a) One worker has two delivery paths, and they do not implement the same operations

**Verdict: confirm the architectural claim; correct the detailed mechanism.**

A newly launched worker sends Pi frames, lifecycle events, commands, and replies through Node child-process inter-process communication (IPC). `sendWorkerMessage` prefers IPC while `runtimeProcess.connected` is true, and the control-socket reconnect loop starts only from the IPC `disconnect` handler ([runtime/installed-pi-worker.mjs:65](../runtime/installed-pi-worker.mjs#L65), [runtime/installed-pi-worker.mjs:166](../runtime/installed-pi-worker.mjs#L166), [runtime/installed-pi-worker.mjs:169](../runtime/installed-pi-worker.mjs#L169)). The daemon records launch handles separately from recovered socket routes ([runtime/daemon.mjs:631](../runtime/daemon.mjs#L631)). It then branches between those stores for commands and queries ([runtime/daemon.mjs:685](../runtime/daemon.mjs#L685), [runtime/daemon.mjs:1190](../runtime/daemon.mjs#L1190)).

The reported failures divide into three groups:

1. `/stats`, `/tree`, and `/export` need a parameterized `session_query`. `askWorker` refuses parameterized requests over the launch handle and waits for a socket route that a normally launched worker does not create ([runtime/daemon.mjs:691](../runtime/daemon.mjs#L691), [runtime/daemon.mjs:1174](../runtime/daemon.mjs#L1174)). These commands fail because the route is absent.
2. `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up` can reach the launch handle. The launch-handle projection keeps `model`, `level`, `name`, and `instructions`, but drops `enabled` and `mode` ([runtime/worker-supervisor.mjs:661](../runtime/worker-supervisor.mjs#L661)). The socket projection includes both fields ([runtime/daemon.mjs:256](../runtime/daemon.mjs#L256)). The worker then rejects the incomplete launch-channel request ([runtime/worker.mjs:65](../runtime/worker.mjs#L65)). These commands fail because two payload projections differ, not because every lookup returns no route.
3. Stop validates durable worker metadata but sends the graceful shutdown only through `lockedRoute?.connection` ([runtime/daemon.mjs:1231](../runtime/daemon.mjs#L1231), [runtime/daemon.mjs:1243](../runtime/daemon.mjs#L1243)). For a current-daemon launch, that route is absent. The no-op optional call means Stop waits through the graceful window before escalating. The 5 second default is defined in the supervisor, while the daemon receives its own stop policy ([runtime/worker-supervisor.mjs:20](../runtime/worker-supervisor.mjs#L20), [runtime/daemon.mjs:591](../runtime/daemon.mjs#L591)).

The proposed direction is right. The worker should establish the control-socket connection during startup, authenticate, and publish its identity there. IPC should carry only spawn authentication and process binding. The daemon should not expose the session as ready until the socket route exists. It can then disconnect IPC and use one command projection, one reply tracker, one frame path, and one graceful-stop path.

One adjustment matters. The worker cannot close IPC immediately after its first hello because the supervisor uses IPC to verify the worker, bind the Pi child, and authorize startup ([runtime/worker-supervisor.mjs:480](../runtime/worker-supervisor.mjs#L480), [runtime/worker-supervisor.mjs:498](../runtime/worker-supervisor.mjs#L498), [runtime/worker-supervisor.mjs:522](../runtime/worker-supervisor.mjs#L522)). Close it only after the supervisor has bound the verified Pi identity and the daemon has adopted the socket route.

### (b) The list uses transcript-grade delivery for replaceable state

**Verdict: confirm, with one unverified number.**

The list persists the frontend cursor in `frontend-state.json`, persists per-client acknowledgements again in `daemon/event-acks.json`, appends every list event to `index/events.jsonl`, replays from a cursor, bounds both daemon and client queues, coalesces superseded session events, and resynchronizes from a snapshot after overflow ([app/list/frontend-state.mjs:2](../app/list/frontend-state.mjs#L2), [runtime/daemon.mjs:108](../runtime/daemon.mjs#L108), [runtime/event-store.mjs:43](../runtime/event-store.mjs#L43), [app/daemon-client.mjs:114](../app/daemon-client.mjs#L114), [app/list/dashboard.mjs:106](../app/list/dashboard.mjs#L106)). Every successfully processed event also waits for a host render, a durable frontend save, and a daemon acknowledgement ([app/list/dashboard.mjs:1271](../app/list/dashboard.mjs#L1271), [app/list/dashboard.mjs:1369](../app/list/dashboard.mjs#L1369)).

The failure is documented in acceptance tests: a stale or absent cursor replayed the full log, overflowed the bounded queue, crashed the dashboard on every start, and could leave a permanently stale row ([test/dashboard-resync.acceptance.test.mjs:154](../test/dashboard-resync.acceptance.test.mjs#L154), [test/dashboard-resync.acceptance.test.mjs:176](../test/dashboard-resync.acceptance.test.mjs#L176)). The current resynchronization code repairs that failure, but it is repair machinery for a replay requirement the list does not have.

The source supports a measured cost of about 70 ms for each frontend-state save on a network home ([app/list/dashboard.mjs:1279](../app/list/dashboard.mjs#L1279)). It does not contain a measurement for the claimed 3 ms snapshot read. **Unverified:** the list snapshot costs about 3 ms for a few dozen rows. The recommendation does not depend on that exact figure. A registry scan is already the authoritative `get_state` implementation ([runtime/daemon.mjs:1032](../runtime/daemon.mjs#L1032)).

Use snapshot plus invalidation for the list. On connection, fetch `get_state`. On any session mutation or completed Delete, send a payload-free `list_changed` notification. Coalesce notifications while one snapshot request is in flight, then fetch once more if a change arrived during the read. Do not persist a list cursor, replay list changes, acknowledge notifications, or retain a list event log.

Keep ordering for the viewer. Transcript deltas are not replaceable by a small registry read, and the controller applies them in sequence before rendering and acknowledging ([app/viewer/viewer-controller.mjs:607](../app/viewer/viewer-controller.mjs#L607)).

### (c) The session model field changes meaning during launch

**Verdict: confirm the bug; simplify the proposed storage model.**

The launch resolver copies the requested model and thinking level into the new `SessionRecord` before Pi starts ([runtime/launch-resolver.mjs:140](../runtime/launch-resolver.mjs#L140), [runtime/launch-resolver.mjs:164](../runtime/launch-resolver.mjs#L164)). If launch fails before Pi is ready, the failure update changes lifecycle fields but leaves those configuration fields intact ([runtime/daemon.mjs:1143](../runtime/daemon.mjs#L1143)). The list therefore displays a requested model as though Pi confirmed it.

The daemon already treats Pi as authority after a socket route appears. It calls `get_state` and overwrites `model` and `thinkingLevel` from Pi's response ([runtime/daemon.mjs:714](../runtime/daemon.mjs#L714), [runtime/daemon.mjs:738](../runtime/daemon.mjs#L738)). This correction does not run for a normal current-daemon launch because of claim (a).

Do not add `requestedConfiguration` and `confirmedConfiguration` to every durable session unless the interface needs to display both. The command journal already retains the exact launch request ([runtime/command-journal.mjs:152](../runtime/command-journal.mjs#L152)). Keep requested values in that request and in the worker startup arguments. Leave `SessionRecord.model` and `thinkingLevel` absent until Pi's initial `get_state` response confirms them. Include that state in the worker-ready exchange, or query it through the single socket route before marking the worker ready. This gives each durable field one meaning and removes the false display without duplicating configuration.

## Ranked changes

Estimates below are net production and test lines removed after replacement code. They are ranges, not counts from an implementation diff.

### 1. Give every worker one control-socket route

**Harm removed.** Current-daemon sessions gain the same query, settings, frame, reconnect, and graceful-stop behavior as adopted sessions. This addresses all failures in claim (a), including the full graceful wait before Stop escalation.

**Delete or unify.** Remove `sessionHandles`, the route-versus-handle branches in `askWorker` and durable command delivery, the handle command projection, launch-channel pending replies, duplicate frame buffering, and the special statement that a parameterized ask must wait for reconnect ([runtime/daemon.mjs:631](../runtime/daemon.mjs#L631), [runtime/daemon.mjs:685](../runtime/daemon.mjs#L685), [runtime/worker-supervisor.mjs:603](../runtime/worker-supervisor.mjs#L603)). Keep the verified startup handshake, then transfer all ongoing traffic to `RecoveredWorkerRouter`.

**Estimated reduction.** 350 to 600 lines, including dual-path tests.

**Risk.** Startup ordering can strand a verified worker between IPC binding and socket adoption. A daemon restart during this handoff can also expose duplicate routes. The existing route generation and identity checks should remain the authority ([runtime/reconciliation.mjs:145](../runtime/reconciliation.mjs#L145), [runtime/reconciliation.mjs:209](../runtime/reconciliation.mjs#L209)).

**Verification.** Add one integration matrix that launches through the real supervisor and runs every worker operation before any daemon restart: prompt, follow-up, steer, interrupt, UI response, menu, each settings command, each query, and Stop. Assert one socket route exists, IPC is closed after handoff, each request reaches Pi once, and graceful Stop returns before the configured window. Repeat after daemon restart against the same worker. Inject failures before Pi bind, after Pi bind, before route adoption, and after route adoption.

### 2. Replace list replay with coalesced invalidation and snapshots

**Harm removed.** A stale or missing cursor can no longer crash startup, flood the client, or preserve a stale row. List correctness no longer depends on render speed, two acknowledgement stores, or an ever-growing historical log.

**Delete or unify.** Remove list use of `createEventStore`, `createCursorStore`, persisted list cursors, `ack`, event replay, client list queues, cursor comparison, resynchronization markers, and cursor-save scheduling. Keep `frontend-state.json` for view state and the launch draft only. Replace session and completed-Delete publication with one coalescing invalidation signal.

**Estimated reduction.** 350 to 600 lines. `runtime/event-store.mjs` is 173 lines by itself. More deletion is in the daemon client, list backend, controller, contracts, and tests.

**Risk.** A notification can arrive between a snapshot read and subscription setup. Avoid that race with a subscription generation or a dirty bit set before the read. If any notification arrives while reading, refetch once after the read. Reconnect must always begin with a snapshot.

**Verification.** Use a deterministic race test for changes before subscribe, during snapshot read, after snapshot response, and during reconnect. Burst at least 10,000 invalidations and assert snapshot reads remain coalesced, the final rows match the registry, no queue grows with burst size, and no cursor files or list event log are created. Measure snapshot latency separately rather than relying on the unverified 3 ms figure.

### 3. Make attachments connection-scoped and non-durable

**Harm removed.** Attachment churn currently fills the list event log even though the list ignores attachment events. The acceptance fixture uses thousands of those events to reproduce startup overflow ([test/dashboard-resync.acceptance.test.mjs:69](../test/dashboard-resync.acceptance.test.mjs#L69)). Durable attachment recovery also adds startup failure modes for state that cannot survive its socket.

**Delete or unify.** Keep the in-memory map that grants at most one composer. Remove `attachment-results.jsonl`, `AttachmentResultStore`, command-journal transitions for attach and detach, attachment events, attachment recovery reconciliation, and the failpoint state machine ([runtime/attachment-result-store.mjs:64](../runtime/attachment-result-store.mjs#L64), [runtime/daemon.mjs:881](../runtime/daemon.mjs#L881), [runtime/daemon.mjs:1436](../runtime/daemon.mjs#L1436)). Socket close already releases claims ([runtime/daemon.mjs:969](../runtime/daemon.mjs#L969)). A retried attach on the same socket can be idempotent from the current in-memory claim.

**Estimated reduction.** 250 to 450 lines.

**Risk.** Two frontends can race for composer after reconnect. Preserve the per-session lifecycle lock around grant and release. A lost attach response may make the frontend retry, so repeated attach from the same authenticated socket must return the current role.

**Verification.** Race two sockets for composer, reconnect both, close the winner during grant, and rapidly leave and reopen one viewer. Assert exactly one composer, eventual release on socket close, no durable attachment artifacts, and no attachment-driven list refresh.

This change and list invalidation share the deletion of attachment events. Design them together even if implementation uses separate commits.

### 4. Persist only Pi-confirmed runtime configuration

**Harm removed.** Failed launches no longer display a model or thinking level that never ran. Successful rows get their values at readiness rather than after a daemon restart.

**Delete or unify.** Stop copying requested runtime values into the prepared `SessionRecord`. Reuse the initial Pi state already fetched by the worker ([runtime/installed-pi-worker.mjs:135](../runtime/installed-pi-worker.mjs#L135)). Apply its model and thinking level during the ready transition. Remove the reconnect-only correction as a special case and use the same state reconciliation for every route.

**Estimated reduction.** 20 to 60 lines. This is primarily a semantic correction, not a large deletion.

**Risk.** Pi may omit one field from `get_state`. Absence must remain unknown rather than falling back to the requested value. Reopening an inactive legacy session may still have old mixed-meaning fields until a migration or next confirmed run.

**Verification.** Cover no-model default selection, accepted requested model, Pi substitution, invalid requested model, failure before Pi spawn, failure after Pi spawn but before ready, and daemon restart. Assert the list shows a value only when the test Pi returned it.

### 5. Remove durable viewer acknowledgements, but keep ordered viewer events

**Harm removed.** A corrupt per-session `.acks.json` can block viewer-store recovery even though production code never reads `acknowledged(clientId)` to compact or delete events ([runtime/viewer-store.mjs:159](../runtime/viewer-store.mjs#L159), [runtime/viewer-store.mjs:292](../runtime/viewer-store.mjs#L292)). The acknowledgement is stored but has no retention consequence.

**Delete or unify.** Remove viewer acknowledgement files, `ack_viewer`, and server-side acknowledgement persistence. Let the reconnecting frontend advance its in-memory resume cursor only after it processes and persists the event. Keep the viewer cursor, ordered event store, bounded queue, snapshot, and resubscription behavior.

**Estimated reduction.** 100 to 180 lines.

**Risk.** A reconnect between rendering and local cursor advancement can replay one event. Stable viewer event IDs and idempotent transcript application must continue to handle that case. If future compaction needs consumer watermarks, this decision would need review.

**Verification.** Disconnect before processing, after processing, and after local cursor advancement. Assert no event is skipped, a duplicate stable event does not duplicate transcript content, and no `.acks.json` file exists.

### 6. Remove the unused production trash transaction

**Harm removed.** The production daemon has no trash callback, so Delete only removes the dashboard record and leaves Pi's canonical file and worktree intact ([runtime/daemon.mjs:1338](../runtime/daemon.mjs#L1338)). The optional trash path still carries a prepared-result store, full-record fingerprints, file identity checks, crash phases, and reconciliation branches. That code can fail startup or maintenance despite implementing no shipped behavior.

**Delete or unify.** Remove `trashSessionFile`, the delete-result store, `PREPARED` and `TRASHED` phases, and the optional transaction after the production forget-only branch. Keep revision, inactive-state, attachment, worker metadata, and route checks before registry removal.

**Estimated reduction.** 200 to 400 lines.

**Risk.** This closes an unshipped extension seam. If deleting canonical Pi files becomes a product requirement, it would need a new explicit command with separate wording and recovery design. It should not hide behind dashboard Delete.

**Verification.** Test Delete against inactive, live, attached, stale-metadata, revision-changed, and concurrently relaunched sessions. In every successful case, assert only the registry record disappears and both the canonical file and worktree remain.

## Complexity that should remain

### The daemon and worker processes are required by Pi's lifetime

The worker owns Pi's stdin, and Pi's remote procedure call process exits when that pipe closes. Moving ownership into the terminal frontend would make sessions die when the frontend exits. The daemon also provides one writer for registry and command state. Keep both process roles. A smaller daemon is the target, not a daemonless design.

### Process identity, leases, and signaling checks are verbose for a reason

PID reuse makes a PID-only stop unsafe. The code compares PID, start identity, and process group before signaling, checks again at signaling boundaries, and retains ownership when identity is ambiguous ([runtime/process-signaler.mjs:66](../runtime/process-signaler.mjs#L66), [runtime/reconciliation.mjs:429](../runtime/reconciliation.mjs#L429)). Keep this machinery. Simplifying transport should make it easier to see, not weaken it.

### The command journal is required for Pi-mutating writes

A socket or process can fail after bytes reach Pi but before the dashboard receives an acknowledgement. The daemon journal records acceptance and cross-process delivery state ([runtime/command-journal.mjs:13](../runtime/command-journal.mjs#L13)). The worker replay store records the narrower Pi stdin boundary ([runtime/worker.mjs:172](../runtime/worker.mjs#L172)). These are duplicate-looking records at different uncertainty boundaries. Keep both for prompt, follow-up, steer, interrupt, UI response, and settings changes.

Narrow the worker replay store to mutating operations. `get_state`, menu discovery, and session queries are read-only but currently enter the same durable replay path ([runtime/worker.mjs:12](../runtime/worker.mjs#L12), [runtime/worker.mjs:232](../runtime/worker.mjs#L232)). Dispatching reads without durable replay is a low-risk follow-up, with an estimated 30 to 80 lines removed. It does not rank above the six changes because it has not caused an operator-visible failure in the evidence reviewed.

### Viewer normalization and ordered delivery are required, but not every persistence layer is

Pi history is the canonical transcript, but live frames include partial assistant output, tool state, UI requests, and lifecycle state that a small registry snapshot cannot replace. Keep one normalizer and an ordered per-session stream. The normalizer already has the single mapping responsibility for viewer shapes ([runtime/viewer-normalizer.mjs:135](../runtime/viewer-normalizer.mjs#L135)). Reassess snapshot-per-frame and checkpoint costs only after measuring them. Do not replace the viewer with list-style invalidation.

### Per-session serialization is required

Different sessions should proceed independently, while one session's launch, route adoption, stop, delete, attachment grant, and registry update need a consistent order. `SessionCoordinator` and the registry lifecycle scope provide that boundary ([runtime/registry-store.mjs:257](../runtime/registry-store.mjs#L257), [runtime/reconciliation.mjs:140](../runtime/reconciliation.mjs#L140)). Keep the concept even if transport unification removes several callers.

## Other observations

1. **The daemon is too large because policy and transport share one 1,592-line module.** Splitting the file would improve navigation but remove no failure mechanism, so it is not a priority. First delete dual paths and durable attachment state. A later extraction should follow remaining responsibilities, not preserve current branches as new modules.
2. **The same canonical serializer appears in several stores.** Consolidating it would save few lines and risks changing durable fingerprints. Leave it until the stores using it are removed. Deletion is safer than a shared abstraction over formats with different compatibility rules.
3. **State migration is large but may still protect existing installations.** `runtime/state-migration.mjs` is 342 lines. Removing it requires evidence that no supported root remains on the old schema. This review found no code evidence for that product decision, so removal is not recommended now.
4. **Launch and Delete result stores compensate for journal results that contain status but not operation results.** Removing the trash transaction removes the Delete store. The launch result store remains necessary for exact replay of a completed launch unless the command journal stores the terminal `sessionId`. Folding the small launch result into the journal could remove another file and 40 to 80 lines, but it changes the journal schema and ranks below current failures.
5. **Capability probing is intentionally defensive.** A running daemon can spawn workers from newer code on disk, and installed Pi versions vary. The executable identity and capability checks add code but reject incompatible launches before ownership becomes ambiguous ([runtime/worker-supervisor.mjs:379](../runtime/worker-supervisor.mjs#L379), [runtime/pi-capability-probe.mjs:160](../runtime/pi-capability-probe.mjs#L160)). Keep them.

## Sequence

1. **Unify worker transport first.** It removes current command failures and creates one ready boundary. It also gives claim (c) a reliable place to persist Pi-confirmed state.
2. **Apply confirmed configuration semantics next.** This is a small change on the new ready handshake and should stay in the same rollout or immediately follow it.
3. **Design list invalidation and ephemeral attachments together.** Both delete attachment events from the list path. Implement them as separate commits with one shared protocol decision.
4. **Remove durable viewer acknowledgements independently.** This can run in parallel with step 3 after the worker transport contract settles because it touches viewer subscription contracts and the shared daemon client.
5. **Remove the trash transaction independently.** This can run in parallel with steps 1 through 4. It touches destructive-action recovery, not worker transport or list delivery.
6. **Narrow durable worker replay to mutations last.** The unified transport makes read and write dispatch easier to separate, and the higher-harm changes provide better evidence about the final command boundary.

Do not combine these into one rewrite. The safest checkpoints are one worker route, one list consistency model, one attachment lifetime, and one meaning for each session field. Each checkpoint should leave the full suite passing before the next deletion.
