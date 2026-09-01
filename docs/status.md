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

## Two open questions that are not defects

**Test doubles that cannot fail the way production fails.** A fake `request` hid a broken `daemon stop --stop-workers` behind a fully green suite. A fake server that accepted every viewer subscription hid a viewer that froze on a real refusal. A fixture Pi that emitted a help banner where a version belonged reinforced the bug it should have caught. The pattern is a double that only models success. The fix is per-site and costs real-process test time on a machine whose load already swings between 2 and 38, so it is a judgment call rather than a sweep.

**Durable-format collapses proposed by review, none executed.** Fold `runtime.piVersion` into `runtime.capabilities.reportedVersion`; retire the separate viewer checkpoint log; derive `commandCanonical` instead of storing it; drop `registryRevision` and `runtime` from viewer snapshots. Each removes real bytes and real code. Each is also read after a crash by code that must not guess, so a collapse that makes a half-written file ambiguous is not a simplification.

## Housekeeping

- Files on the operator's state root that no code names and nothing removes: `index/events.jsonl`, `daemon/attachment-results.jsonl`, `daemon/event-acks.json`, `index/viewer/*.acks.json`, `frontend-state.json`.
- The state root is still `~/.local/state/pi-dashboard`. It is renamed to `pi-agents` in place on the first start with no live daemon and no live worker, so it stays until every session is stopped once.

## Verification already done

Gates 0 through 4 pass. Gate 0 and 1 by hand on the live daemon; 2, 3 and 4 on temporary roots with disposable sessions, evidence recorded per item.

Gate 4 was widened before it ran, because as specified it never broke a live viewer's socket nor let events accumulate past the daemon's subscriber bound, and so could not have caught the silent viewer freeze it was meant to protect against. It found the viewer file-handle leak that killed the daemon on Node 24 and later. **A gate aimed at the failure you already fixed is not a gate.**

## Next: adopt Claude Code's process shape

Wanted, and the reason to want it: it deletes subsystems rather than tidying them. An architecture review costed a from-scratch redesign at 24 to 35 percent smaller than today's 17,691 production lines and said half is unreachable under our own constraints. The four changes below are the part of that reduction Claude Code's shipped design already validates, so each one is a deletion with a working precedent rather than a bet. Read `docs/reference/claude-code-behavior.md` before starting any of them.

Order matters: 1 is independent, 2 depends on 1, 3 and 4 are independent of both.

**1. The live tail belongs to the worker, not the daemon.** Claude Code's PTY host keeps a 256 KiB output tail and replays it on attach as `hello`, tail, `live`. Durability is Claude's own transcript file; there is no second durable transcript. Move our bounded live buffer into the worker and let the viewer rebuild completed history from Pi's canonical session file, which `runtime/reconciliation.mjs` already reads and normalizes. This answers the question the review left open: partial streaming text need not be lost across a daemon restart, because the process holding it never restarts. Removes the durable viewer event, checkpoint and snapshot formats, their contracts, their recovery paths and their subscriber-bound refusal machinery. Estimated 800 to 1,500 lines. Keep the normalizer: it merges canonical messages with live deltas, tool progress, UI requests and model state, and nothing else does that.

**2. Delete the daemon-wide command journal; the worker's durable inbox is the acceptance boundary.** Claude Code has no equivalent: its `attach-journal/` was empty and its roster carries only a capped `dispatch` envelope for resume and respawn. We keep the worker replay log around the Pi write, which is what actually protects operator text, and delete the daemon stage machine, its recovery CLI surface, and `session resolve-delivery`. Estimated 700 to 1,200 lines. Two things to settle first, in writing: a crash matrix for fsync-complete-reply-lost, write-started, and Pi-acknowledged-reply-lost; and whether losing queryable acceptance for launch and destructive commands is acceptable when the daemon dies between mutation and response. Note the docs have overstated this: the journal never provided exactly-once delivery, because Pi exposes no idempotency key, and a post-write crash correctly records `DELIVERY_UNKNOWN`.

**3. Invert the worker socket.** Their workers listen; the daemon creates the socket paths before spawn and connects to them. Ours connect outbound to the daemon's listener, which makes the daemon the thing that must exist first and must be replaced carefully. Inverting it makes a daemon replacement a reconnect rather than an adoption negotiation. This is a protocol change across a process boundary, so it needs a version rule and it cannot ship in the same release as anything else here.

**4. Make the daemon exit when the last client disconnects.** Claude Code's daemon runs on demand and exits when idle, with `--keep-workers` leaving detached sessions running; service install is disabled in the version installed here. We already have an idle-exit interval driven by `PI_AGENTS_IDLE_EXIT_MS`; the change is to make on-demand the default and stop treating a resident daemon as the normal state. Small in lines, large in what can go wrong while nobody is watching.

Not adopted, deliberately: their PTY hosting and terminal-byte rendering. `docs/tmux-prototype-report.md` records why — killing the host kills every hosted session, terminal writes cannot prove Pi accepted text, and structured Stop and honest row state are both lost.
