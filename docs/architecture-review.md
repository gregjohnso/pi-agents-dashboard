# Architecture review

Delete the unused dashboard features first, then give every live worker one daemon transport and replace list replay with invalidation plus snapshot reads. The reduced product removes both known command-shape failures before transport work starts. The daemon, worker process, ownership lease, process identity checks, worktree isolation, and opt-in summaries should remain.

The three proposed diagnoses are mostly right. Claim (a) has two distinct failure mechanisms, not one. Claim (b) is right about the excess machinery and the observed startup crash, but the 3 ms snapshot cost is not measured in this repository. Claim (c) identifies a real data-model error, though two durable configuration objects would add state that the product does not need.

## The daemon pattern supports many clients, but this implementation still assumes one frontend

The intended process shape matches tmux, the Emacs daemon, a language server, and the Docker client and daemon. One server owns shared state. Short-lived clients connect over a versioned local protocol. A per-session process owns each long-lived Pi child. One connection may write a session while other connections observe it. The server, not a terminal, decides ownership and survives terminal loss.

That comparison supports the daemon and worker split. It does not support the current amount of durable client bookkeeping. Attachment claims, list acknowledgements, viewer acknowledgements, and one shared `frontend-state.json` all describe client state that either dies with a socket or can be rebuilt from an authoritative snapshot. Established client-server designs keep durable server state about sessions and commands. They keep connection leases and screen state in memory or in files private to one client instance.

The current frontend identity is also too broad for several terminals. Every dashboard loads the same CLI client ID and reads and replaces the same `frontend-state.json` ([app/standalone.mjs:75](../app/standalone.mjs#L75), [app/list/standalone-list.mjs:221](../app/list/standalone-list.mjs#L221)). Two dashboards can overwrite each other's selected row, launch draft, and cursor. The shared ID also makes request ownership harder to explain, even though attachment arbitration happens by socket. Removing the list cursor and viewer acknowledgements reduces the damage, but the remaining view state and draft still need a per-frontend home. A process-scoped connection ID should identify a live dashboard. A separate stable installation ID may remain for command recovery where durability requires it. Those two identities should not be one field.

### Six untested client cases define the missing contract

1. **Three dashboards open.** All three should receive list invalidations. Two may open the same session as observers while one socket holds composer. Their drafts and selected rows must not overwrite one another. Current tests cover two attachment requests in places, but no acceptance test mounts three complete dashboards against one daemon.
2. **The writer terminal is killed.** Unix socket close should release the connection-scoped composer claim under the per-session lock. An accepted command continues through the command journal because terminal death does not prove that Pi missed it. Observers should receive a writer-availability notification. A stopped process whose socket remains open still owns composer; adding a heartbeat to override a live local socket would create another failure detector without evidence that it is needed.
3. **Two clients race for one session.** The per-session lock should grant exactly one composer. The loser should open the viewer as an observer rather than fail with `SESSION_IN_USE`. A repeated claim from the winning socket should return composer. A repeated claim from another socket should return observer.
4. **One client runs an old build.** The daemon needs an explicit compatibility refusal at the first incompatible operation. The current client cannot surface a refused `subscribe`: it sends an untracked request and discards the response ([app/daemon-client.mjs:112](../app/daemon-client.mjs#L112), [app/daemon-client.mjs:242](../app/daemon-client.mjs#L242)). No daemon response can add behavior to that running process. Use a two-release bridge. The bridge client tracks the subscription response and displays `Dashboard protocol changed. Exit and restart pi-agents.` on `CLIENT_RESTART_REQUIRED`; its daemon still serves bounded old replay. Only the following release removes replay and refuses old `subscribe`. This removes the synchronized manual-close step. A pre-bridge frontend can keep using the bridge daemon until it is restarted naturally.
5. **A client disappears mid-command.** Socket loss must not cancel a command after journal acceptance. The daemon should finish delivery or record `DELIVERY_UNKNOWN`. A reconnect with the same durable request identity can inspect the result. Ephemeral viewer actions use fresh request IDs today, so the new writer may need to infer completion from the transcript or session state. Destructive CLI commands already persist pending request identity and should retain that stronger rule.
6. **The writer changes.** The daemon currently records attachment events for the list, which ignores them, but does not give an open observer a useful viewer-level ownership transition. Attached viewers need a connection-scoped `session_access_changed` notification with their own role, whether a writer is present, and an in-memory generation. Do not expose another client's stable ID. Do not promote an observer automatically. Explicit acquisition after a vacancy keeps races server-arbitrated and makes the operator's writer choice visible.

The read-only viewer is already mostly implemented. Viewer snapshots carry `composer` or `observer`, and observer input paths reject mutations ([app/viewer/viewer-controller.mjs:160](../app/viewer/viewer-controller.mjs#L160), [app/viewer/viewer-controller.mjs:256](../app/viewer/viewer-controller.mjs#L256)). The standalone adapter throws when the daemon grants observer ([app/list/standalone-list.mjs:69](../app/list/standalone-list.mjs#L69)). Accepting the granted role removes that contradiction. The remaining work is status, explicit acquisition, and role-change notification.

### The reduced feature set changes the ranking

Deleting `/stats`, `/tree`, and `/export` removes the entire parameterized `session_query` operation. Deleting `/auto-compact`, `/auto-retry`, `/steering`, and `/follow-up` removes the second settings projection and its `enabled` and `mode` mismatch. Deleting `/thinking` and its picker removes `set_thinking_level` and requested thinking level from launch. These deletions should land first because they remove failing callers before transport changes.

The one-worker-route change still earns its startup risk, but its scope shrinks. It no longer repairs dashboard queries or settings passthrough. It still removes split frame delivery, duplicate reply tracking, current-launch versus recovered-worker behavior, and the missing graceful Stop route. Its estimated reduction falls from 350 to 600 lines to 250 to 450 lines after feature deletion. The operation matrix becomes prompt, follow-up message, steer, interrupt, user-interface response, model, compact, rename, menu, initial state, frames, and Stop.

The confirmed-configuration change also shrinks. Only `model` remains a dashboard-selected runtime value. Pi-reported thinking level may remain visible as observed state, but the launch request and dashboard picker no longer write it. Model admission and Pi-confirmed model persistence remain useful.

Replay narrowing no longer earns a separate change. Removing `session_query` deletes three of its four proposed read subtypes. Only `get_state` and `get_session_commands` remain, and neither caused the reported failure. A new direct-read dispatcher would add a second dispatch path just after transport unification removes one. Withdraw changes 7.1 and 7.2. Reconsider replay only with measured write cost or a concrete recovery failure.

The feature deletions expose one additional simplification. Remove retired operations from the frontend, shared contract, daemon, worker dispatcher, Pi adapter, and tests in the same commit for each feature group. Do not leave generic `session_query`, generic settings payloads, or hidden adapter methods as extension seams. A smaller explicit operation set makes old-build refusal and command durability easier to audit.

The revised order is feature deletion, read-only opening, one worker route, Pi-confirmed model, list invalidation, connection-scoped attachments with access notifications, viewer acknowledgement removal, and trash removal. List invalidation still precedes attachment-store deletion because current attachment recovery publishes list events. Trash removal remains independent after the baseline gate.

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

Do not add `requestedConfiguration` and `confirmedConfiguration` to every durable session unless the interface needs to display both. The command journal already retains the exact launch request ([runtime/command-journal.mjs:152](../runtime/command-journal.mjs#L152)). Keep the requested model in that request and in the worker startup arguments. Remove requested thinking level from the dashboard launch contract. Leave `SessionRecord.model` absent until Pi's initial `get_state` response confirms it. Pi-reported thinking level may remain observed state. Include initial state in the worker-ready exchange, or query it through the single socket route before marking the worker ready. This gives each durable field one meaning without duplicating configuration.

## Analysis of the remaining changes

The order in this section reflects the original review. The revised order is in the sequence section below. Estimates are net production and test lines removed after replacement code. They are ranges, not counts from an implementation diff.

### 1. Give every worker one control-socket route

**Harm removed.** Current-daemon sessions gain the same frame, reply, reconnect, and graceful-stop behavior as adopted sessions. Feature deletion removes the query and settings failures before this change. The route change still removes the full graceful wait before Stop escalation.

**Delete or unify.** Remove `sessionHandles`, the route-versus-handle branches in `askWorker` and durable command delivery, the handle command projection, launch-channel pending replies, duplicate frame buffering, and the special statement that a parameterized ask must wait for reconnect ([runtime/daemon.mjs:631](../runtime/daemon.mjs#L631), [runtime/daemon.mjs:685](../runtime/daemon.mjs#L685), [runtime/worker-supervisor.mjs:603](../runtime/worker-supervisor.mjs#L603)). Keep the verified startup handshake, then transfer all ongoing traffic to `RecoveredWorkerRouter`.

**Estimated reduction after feature deletion.** 250 to 450 lines, including dual-path tests.

**Risk.** Startup ordering can strand a verified worker between IPC binding and socket adoption. A daemon restart during this handoff can also expose duplicate routes. The existing route generation and identity checks should remain the authority ([runtime/reconciliation.mjs:145](../runtime/reconciliation.mjs#L145), [runtime/reconciliation.mjs:209](../runtime/reconciliation.mjs#L209)).

**Verification.** Add one integration matrix that launches through the real supervisor and runs every remaining worker operation before any daemon restart: prompt, follow-up message, steer, interrupt, user-interface response, model, compact, rename, menu, initial state, frames, and Stop. Assert one socket route exists, IPC is closed after handoff, each request reaches Pi once, and graceful Stop returns before the configured window. Repeat after daemon restart against the same worker. Inject failures before Pi bind, after Pi bind, before route adoption, and after route adoption.

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

### 4. Persist only Pi-confirmed model state

**Harm removed.** Failed launches no longer display a model that never ran. Successful rows get the model at readiness rather than after a daemon restart.

**Delete or unify.** Stop copying the requested model into the prepared `SessionRecord`. Reuse the initial Pi state already fetched by the worker ([runtime/installed-pi-worker.mjs:135](../runtime/installed-pi-worker.mjs#L135)). Apply its model during the ready transition. Keep Pi-reported thinking level as observed state, but remove dashboard selection and mutation.

**Estimated reduction.** 20 to 60 lines. This is primarily a semantic correction, not a large deletion.

**Risk.** Pi may omit the model from `get_state`. Absence must remain unknown rather than falling back to the requested value. An inactive legacy session may retain an old mixed-meaning model until its next confirmed run.

**Verification.** Cover no-model default selection, accepted requested model, Pi substitution, invalid requested model, failure before Pi spawn, failure after Pi spawn but before ready, and daemon restart. Assert the list shows a model only when test Pi returned it.

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

A socket or process can fail after bytes reach Pi but before the dashboard receives an acknowledgement. The daemon journal records acceptance and cross-process delivery state ([runtime/command-journal.mjs:13](../runtime/command-journal.mjs#L13)). The worker replay store records the narrower Pi stdin boundary ([runtime/worker.mjs:172](../runtime/worker.mjs#L172)). These are duplicate-looking records at different uncertainty boundaries. Keep both for prompt, follow-up messages, steer, interrupt, user-interface response, model changes, compact, and rename.

Do not add a separate direct-read dispatcher now. Removing `session_query` leaves initial state and menu discovery as the remaining reads. They have no documented operator-visible failure, and a second dispatcher would weaken the single-path goal. This withdraws the earlier replay-narrowing proposal.

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

1. **Delete the unused features.** Remove `session_query`, Pi settings passthrough, and dashboard thinking control from every layer.
2. **Open observers read-only.** Accept the daemon's observer grant instead of returning `SESSION_IN_USE`.
3. **Unify worker transport.** The smaller operation set still needs one frame, reply, reconnect, and Stop route.
4. **Apply confirmed model semantics.** Use the new ready handshake for the one remaining dashboard-selected runtime value.
5. **Replace list replay with invalidation.** Add explicit old-client refusal rather than replay compatibility in the new daemon.
6. **Make attachments connection-scoped and notify viewers of access changes.** Remove their durable store after list events are gone.
7. **Remove durable viewer acknowledgements and the trash transaction independently.** Both retain their rollback files in place.

Do not implement replay narrowing. The deleted operations remove most proposed callers, and the remaining reads do not justify another dispatch path.

Do not combine these into one rewrite. The safest checkpoints are one worker route, one list consistency model, one attachment lifetime, and one meaning for each session field. Each checkpoint should leave the full suite passing before the next deletion.
