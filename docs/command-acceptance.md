# Command acceptance and what a crash costs

The owning worker's durable replay log is the acceptance boundary for the operator's text. There is
no daemon-side command journal. This file says, for every crash point, what the operator sees, what
the system guarantees, and how he recovers.

## What acceptance means

A worker owns one Pi process and one append-only, fsync-backed log at
`runs/<runHash>/worker-replay.jsonl`. Every command it takes is written there before it reaches Pi
and after Pi answers:

| Stage | Written when | Carries |
|---|---|---|
| `RECEIVED` | before anything is sent to Pi | the operator's text |
| `RPC_WRITE_STARTED` | immediately before the Pi write | the operator's text |
| `RPC_ACKNOWLEDGED` | after Pi answers | Pi's result |
| `DELIVERY_UNKNOWN` | the write started and no answer can be attributed | the text and the cause |
| `FAILED` | Pi refused it, acknowledged | the error |

Each stage is one `write` plus one `fsync` before the next step runs. **Acceptance is the fsync of
`RECEIVED`**: from that instant the operator's text is on disk, under his own private run directory,
whatever happens to the daemon, the worker, or Pi. Acceptance is a durable record of what he typed
and nothing more; it is not a promise the text will reach Pi. Row F below is the case that proves
it: a replacement worker opens a new run directory and reads no earlier run's log, so a `RECEIVED`
record whose worker died before the Pi write is never redelivered by anything.

Nothing rotates, truncates or removes that log. It is per run: one file per `runs/<runHash>/`, which
lives as long as the state root does, holding roughly one line per command stage — the operator's
text plus about 150 bytes of envelope, written up to three times per text-bearing command. Deleting
a session forgets its registry record and never touches `runs/`, so an operator who wants his
prompts gone removes the run directory himself. This is not new exposure or new growth; it is the
same text moving out of one unbounded daemon-wide `queue/commands.jsonl` into the private run
directory of the worker that owns it.
The daemon records nothing durable about a command. It routes the command to the session's adopted
worker, waits for that worker's reply, and answers the frontend with it. A command that cannot be
attributed is answered `ok: false` with code `DELIVERY_UNKNOWN`; there is no stage to query
afterwards and no `session resolve-delivery` to settle.

## This was never exactly-once, and the deleted journal never made it so

Documentation in this repository called the command journal exactly-once delivery. It was not, and
no stage machine could have made it so: **Pi exposes no idempotency key**. A crash after the bytes
are written and before Pi's answer is read is genuinely ambiguous, and recording `DELIVERY_UNKNOWN`
is the correct outcome rather than a defect. What the journal actually provided was a queryable
record of that ambiguity in a second place. What survives — the worker replay log — provides:

- the operator's text, durable before any Pi write;
- refusal of a second Pi write for a request identity already recorded as acknowledged;
- refusal of a silent retry for a request identity recorded as ambiguous;
- an honest `DELIVERY_UNKNOWN` when nothing can be attributed.

It does not provide, and never did: exactly-once delivery, or a promise that a resubmission the
operator chooses to make cannot reach Pi twice.

## The crash matrix

"Text lost" means the operator's typed characters exist in no durable place and on no screen.
"Twice" means one action can be applied to Pi or to durable state more than once.

| # | Crash point | What the operator sees | Text lost | Twice | Recovery |
|---|---|---|---|---|---|
| A | Worker's `RPC_ACKNOWLEDGED` fsync completed; the reply to the daemon is lost (socket died, daemon died, or the 300 s bound expired) | The command reports `DELIVERY_UNKNOWN`. The viewer keeps his text in the composer and records the error line. The turn then appears in the transcript, because Pi has the text. | No. Pi holds it and Pi's canonical session file is the transcript of record. | No, unless he chooses to resubmit. A resubmission carrying the same `clientId`/`requestId` is answered from the recorded `RPC_ACKNOWLEDGED` without a second Pi write. Nothing retries on its own. | None needed. Read the transcript; the turn is there. |
| B | `RPC_WRITE_STARTED` was fsynced and the worker died before Pi answered | `DELIVERY_UNKNOWN`. Text still in the composer. The row goes `EXITED` when the supervisor or startup reconciliation observes the dead worker. | No. The fsynced record carries it, and it is still on his screen. | Only by his own resubmission, and then genuinely: Pi may already have applied it. No component decides this for him. A same-identity retry is refused; a fresh submission is a deliberate second delivery. | Read the transcript. If no turn started, resubmit. |
| C | Pi acknowledged but the worker's reply is lost | Same as A or B. If the `RPC_ACKNOWLEDGED` fsync completed this is row A. If the worker died before that fsync, the newest durable record is `RPC_WRITE_STARTED`, which is row B — and Pi has the text regardless. | No | As A/B | As A/B |
| D | Daemon dead between accepting a launch and answering it | The launch request fails on a closed connection; the frontend hands the typed prompt back to the composer. The placeholder `STARTING` row is retired. On the next start, a prepared record with no owner is reduced to `LAUNCH_ABANDONED`, so the row says the launch failed rather than sitting at `STARTING`. | No. The prompt returns to the composer, and no partial session claims to hold it. | Not to the same session, but the operator can end up paying twice. If the daemon died *after* the worker was spawned, that session is alive and already running his prompt while the same prompt sits back in his composer; reissuing then leaves two sessions doing the same work, with two token bills. | Read the list before reissuing. If a session for that prompt is already running, keep it. If two are, `rm` the one you do not want; `rm` forgets the record only, so stop it first. |
| E | Daemon dead between a destructive mutation and its response (`stop` after signalling, `delete` after the record is removed, `respawn` after the worker is signalled) | `DELIVERY_UNKNOWN`: exit code 1 from the command line, one error line in the dashboard. | Not applicable; no operator text is in flight. | No. The mutation advanced the row's revision before the response, so a reissue with the old revision is refused with `REVISION_CONFLICT`; `delete` reissued reports `SESSION_NOT_FOUND`; `stop` and `respawn` re-verify PID, process-start identity and process group at the signalling boundary, so nothing is signalled that is not still the recorded process. | Read the row (`pi-agents agents`, or the list). Its revision and its `taskState`/`processState` are the record of what happened, and they are written before the response, so they are never behind it. |
| F | Worker dead after accepting text and before writing to Pi (`RECEIVED` fsynced, no `RPC_WRITE_STARTED`) | `DELIVERY_UNKNOWN`. Text still in the composer. Pi died with the worker, because the worker holds its RPC stdin pipe. | No. It is on his screen and in `runs/<runHash>/worker-replay.jsonl`. | No. Nothing was written to Pi. There is deliberately no automatic redelivery: a replacement worker gets a new run directory and reads no earlier run's log. | Reopen the session, which starts a worker, and resubmit. |

**No row loses the operator's text.**

## What queryable acceptance is deliberately given up

Losing the daemon journal loses one thing: after a daemon death mid-flight, no durable record answers
"was my launch, stop, delete or respawn accepted?" That is accepted deliberately, because those
commands are not guarded by a stage record:

- **Launch** is guarded by the registry. Either a session record exists or it does not; a prepared
  record nobody owns is reduced to `LAUNCH_ABANDONED` at startup, and a reissue is a distinct new
  session the operator can see and remove.
- **Stop, delete and respawn** are guarded by the exact registry revision and by observed terminal
  process state, both re-read at the boundary that acts. A reissue is safe: it either finds the
  revision it was given and acts once, or is refused.

The client-side records that existed only to give the journal a stable retry identity go with it:
`daemon/launch-results.json` and `cli/pending/*.json`. Nothing reads a stable request identity for a
destructive command any more, because the revision guard is what makes a reissue safe.

## What must not change without revisiting this file

- The `RECEIVED` fsync precedes any Pi write, and it carries the text. Reordering it, or dropping the
  text from it, moves the acceptance boundary and makes row B and row F lose the operator's text.
- A request identity recorded `RPC_ACKNOWLEDGED` is never written to Pi again.
- A request identity recorded `DELIVERY_UNKNOWN` is never silently retried.
- An unattributable outcome is reported as `DELIVERY_UNKNOWN`, never as success and never as a clean
  failure, because the bytes may already have reached Pi.
