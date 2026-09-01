# Status

What is left, what is known broken, and what is waiting on a decision. Read `docs/architecture.md` for the design and `docs/architecture-plan.md` for how the current shape was arrived at.

Update this file when work lands. It deliberately carries no test count and no commit hashes: both are one command away and wrong the moment anyone commits.

## Waiting on the operator

- `package.json` has no `"private": true`, and `README.md` tells the reader to `npm install -g pi-agents`, a package that is not published and is not intended to be. Either publish it or say plainly that a local checkout is the only install.

## Known defects

None of these lose work or corrupt state. Each was found by the change that reported it, and each is reproducible.

| Defect | Where | What the operator sees |
|---|---|---|
| `PROCESS_EXIT_PROOF_MS` is 2 s with no option | `cli/daemon-commands.mjs` | A daemon the kernel takes longer to reap turns a correct stop into exit code 5 `DAEMON_STILL_RUNNING`. |
| `CRASH_REPORT_TIMEOUT_MS` is 1 s | `runtime/installed-pi-worker.mjs` | Under load a crashing worker loses its own explanation, which is the one moment that explanation matters. |
| `PENDING_LOCK_TIMEOUT_MS` unreachable at two call sites | `cli/session-commands.mjs` | Same shape as the probe timeout already fixed: a default no caller can raise. |
| `runViewerTransition` fires `detach` without awaiting it | `app/viewer` | A fast reopen-then-delete races its own detach. |
| `migrateLegacyState` refuses any root that ever opened a viewer | `runtime/state-migration.mjs` | Pre-existing. It means that path cannot succeed on the operator's machine today. |
| The destination daemon `migrateLegacyState` starts has no spawn seam | `runtime/state-migration.mjs` | `test/migration.integration.test.mjs` cannot record it until it publishes, so a test timing out inside `runDashboardApp` still leaks one daemon. Every other real-process suite records at the spawn. |

## Two open questions that are not defects

**Test doubles that cannot fail the way production fails.** A fake `request` hid a broken `daemon stop --stop-workers` behind a fully green suite. A fake server that accepted every viewer subscription hid a viewer that froze on a real refusal. A fixture Pi that emitted a help banner where a version belonged reinforced the bug it should have caught. The pattern is a double that only models success. The fix is per-site and costs real-process test time on a machine whose load already swings between 2 and 38, so it is a judgment call rather than a sweep.

**Durable-format collapses proposed by review, none executed.** Fold `runtime.piVersion` into `runtime.capabilities.reportedVersion`; derive `commandCanonical` instead of storing it; drop `registryRevision` and `runtime` from viewer snapshots. Each removes real bytes and real code. Each is also read after a crash by code that must not guess, so a collapse that makes a half-written file ambiguous is not a simplification. The viewer checkpoint log this list also named is gone: the whole durable viewer format went with item 1 below.

## Housekeeping

- Files on the operator's state root that no code names and nothing removes: everything under `index/` (`index/events.jsonl`, `index/viewer/*`), `daemon/attachment-results.jsonl`, `daemon/event-acks.json`, `frontend-state.json`. The `index/viewer` files joined this list when the live tail moved into the worker; they are left where they are, with no parser, no migration and no ignore branch.
- The state root is still `~/.local/state/pi-dashboard`. It is renamed to `pi-agents` in place on the first start with no live daemon and no live worker, so it stays until every session is stopped once.

## Verification already done

Gates 0 through 4 pass. Gate 0 and 1 by hand on the live daemon; 2, 3 and 4 on temporary roots with disposable sessions, evidence recorded per item.

Gate 4 was widened before it ran, because as specified it never broke a live viewer's socket nor let events accumulate past the daemon's subscriber bound, and so could not have caught the silent viewer freeze it was meant to protect against. It found the viewer file-handle leak that killed the daemon on Node 24 and later. **A gate aimed at the failure you already fixed is not a gate.**

## Next: adopt Claude Code's process shape

Wanted, and the reason to want it: it deletes subsystems rather than tidying them. An architecture review costed a from-scratch redesign at 24 to 35 percent smaller than today's 17,691 production lines and said half is unreachable under our own constraints. The four changes below are the part of that reduction Claude Code's shipped design already validates, so each one is a deletion with a working precedent rather than a bet. Read `docs/reference/claude-code-behavior.md` before starting any of them.

Order matters: 1 is done, 2 depends on it and is next, 3 and 4 are independent of both.

**1. The live tail belongs to the worker, not the daemon. Done.** The worker keeps 262,144 bytes of the Pi frames it produced and replays them as one `pi_tail` frame on every connection after its launch; the daemon rebuilds that session's viewer state from Pi's canonical file plus that tail and tells every subscriber to resynchronize. `subscribe_viewer` now answers with the snapshot it continues, both taken under one frame lock, so nothing can fall between them; `get_viewer_snapshot` and the viewer resume cursor are gone, which is client protocol 4. The durable viewer event, checkpoint and snapshot formats went with them, along with their contracts, their recovery paths, and the normalizer's restore, checkpoint and durable-event surface. A daemon restart now keeps partial streaming text, which the durable store could never do: it was absent for exactly the frames that mattered.

The 800-to-1,500-line estimate was wrong, and the shape of the error is worth keeping. It deleted 544 production lines and added 521: the durable store was only 288 lines, and its replacement is not free — 129 lines of live stream, 74 of worker tail, and the rebuild and subscribe-seam changes inside `runtime/reconciliation.mjs`. Net 23 production lines removed, with 171 test lines added. What actually left is a durable format nothing may misread after a crash, its recovery path, and a resume protocol; count this one in concepts, not lines. Items 2 to 4 were costed the same way, so read their line estimates as upper bounds on gross deletion, not on net.

**2. Delete the daemon-wide command journal; the worker's durable inbox is the acceptance boundary.** Claude Code has no equivalent: its `attach-journal/` was empty and its roster carries only a capped `dispatch` envelope for resume and respawn. We keep the worker replay log around the Pi write, which is what actually protects operator text, and delete the daemon stage machine, its recovery CLI surface, and `session resolve-delivery`. Estimated 700 to 1,200 lines. Two things to settle first, in writing: a crash matrix for fsync-complete-reply-lost, write-started, and Pi-acknowledged-reply-lost; and whether losing queryable acceptance for launch and destructive commands is acceptable when the daemon dies between mutation and response. Note the docs have overstated this: the journal never provided exactly-once delivery, because Pi exposes no idempotency key, and a post-write crash correctly records `DELIVERY_UNKNOWN`.

**3. Invert the worker socket.** Their workers listen; the daemon creates the socket paths before spawn and connects to them. Ours connect outbound to the daemon's listener, which makes the daemon the thing that must exist first and must be replaced carefully. Inverting it makes a daemon replacement a reconnect rather than an adoption negotiation. This is a protocol change across a process boundary, so it needs a version rule and it cannot ship in the same release as anything else here.

**4. Make the daemon exit when the last client disconnects.** Claude Code's daemon runs on demand and exits when idle, with `--keep-workers` leaving detached sessions running; service install is disabled in the version installed here. We already have an idle-exit interval driven by `PI_AGENTS_IDLE_EXIT_MS`; the change is to make on-demand the default and stop treating a resident daemon as the normal state. Small in lines, large in what can go wrong while nobody is watching.

Not adopted, deliberately: their PTY hosting and terminal-byte rendering. `docs/tmux-prototype-report.md` records why — killing the host kills every hosted session, terminal writes cannot prove Pi accepted text, and structured Stop and honest row state are both lost.

## Cleanup queue, from four read-only reviews

Ordered by concepts removed, not lines. Every item was verified against the code by the review that proposed it; where a review argued against a change, that verdict is recorded too.

**Delete `runtime/control-server.mjs`, 148 lines.** A second socket-server implementation whose only consumer is its own test; production uses the private one inside `daemon.mjs`. Port its malformed-frame and socket-mode coverage to the surviving server first, then delete. Verified by search.

**Split transport out of `runtime/daemon.mjs` into `runtime/daemon-server.mjs`.** Socket lifecycle, authentication, role selection, the frontend protocol gate, JSONL framing, per-socket ordering, worker reply correlation, subscription lifetimes, bounded queues, shutdown draining. About 250 lines move out of a 1,549-line file that every commit in this release had to touch, which made it the serialization point for all parallel work. Do not split the rest of the request handler into one file per operation: its first half is a dispatch table, but its second half is a transaction coordinator and distributing that would add imports without removing concepts.

**Split `runtime/reconciliation.mjs`, 887 lines**, which currently holds three unrelated things: the worker router, the viewer subsystem, and the startup repair procedure.

**Collapse the frontend's three daemon API layers into one.** A reader today must hold `createDaemonClient`, `createDaemonDashboardBackend` inside `dashboard.mjs`, and `createDaemonViewerClient` inside `standalone-list.mjs`. Highest concept reduction in the frontend, modest line reduction.

**Consolidate `app/list/` around three responsibilities.** Query projection, display-state derivation, row virtualization and responsive layout are four files that one interaction crosses; merging them into a session table is mostly movement, but reading one keystroke stops being a tour.

**Delegate more of the list to public Pi and pi-tui exports.** The viewer already uses Pi's `CustomEditor` and gets wrapping and history free; the list hand-rolls an append-only composer because pi-tui's `Editor` claims Ctrl chords the list needs. Generic overlays and autocomplete are still candidates. Package-root exports only.

**Reorganize the CLI around one client.** `cli/session-commands.mjs` is 874 lines and partly reimplements what `app/daemon-client.mjs` already does against the same socket with the same envelopes. One client with two front ends is smaller. Medium reorganization, not a dramatic reduction.

**Contracts stay as they are.** A review costed replacing 422 hand-written lines with a declarative table and concluded the win is not real: these validators run on every frame across a process boundary, and their messages name the exact offending field, which was load-bearing while debugging this release. 422 lines is what strictness costs.

**Consolidate duplicated test layers.** Controller-level repetitions of behavior already owned by focused units; four candidates measured at 45 to 150 lines each. Keep the real-process suites that catch what a unit test cannot, and say which failure each one catches.

**Close the remaining doubles that cannot fail the way production fails.** Three defects shipped behind a fully green suite because a fake only modelled success: a fake `request` hid a broken `daemon stop --stop-workers`, a fake server that accepted every viewer subscription hid a frozen viewer, and a fixture Pi emitting a help banner reinforced the bug it should have caught. The remaining sites are listed in the test review. This is per-site work and it costs real-process time, so it is a judgment call rather than a sweep.

**`runtime/daemon.integration.test.mjs` is nearly 2,000 lines** and tests every extracted concern through one seam, which reinforces `daemon.mjs` as the only place a change can land. Split it alongside the production split, not before.
