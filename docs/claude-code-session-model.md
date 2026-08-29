# Claude Code's session model changes the pseudo-terminal decision, not the dashboard's correctness rules

Claude Code 2.1.251 is evidence that a daemon-supervised pseudo-terminal (PTY) can preserve a native agent interface across terminal exits and daemon upgrades. It does this by controlling both sides of the design: the PTY host and the agent running inside it exchange private state, repaint, readiness, and detach messages. That is the part to copy if Pi can expose an equivalent side channel.

It is not evidence for putting interactive Pi under tmux today. Claude Code avoids the tmux prototype's main failures because it owns the PTY host, has a structured channel beside terminal bytes, and implements return-to-list inside Claude Code. It does not ask a generic multiplexer to infer agent state or reserve Left unconditionally.

Four findings matter most:

1. Claude Code hosts each session in a separate PTY process and adopts that process after daemon restart. The PTY host keeps 256 KiB of raw output in memory and gives every newly connected supervisor that byte tail.
2. A late interactive attacher does not receive a durable terminal scrollback. Claude Code requests a native repaint. The agent reconstructs its interface from the durable conversation JSONL, then marks `content_paint` and `prompt_idle` over a private rendezvous channel.
3. On Linux, several attached clients can all type. There is no writer lease or takeover. Input bytes from every client enter the same PTY. This contradicts our one-writer user experience, but it does not make shared typing safe for a dashboard that sends structured Pi commands.
4. List state comes from a structured per-job state record and live state patches from the agent, not from terminal scraping or JSONL tailing. This supports our decision to derive rows from daemon events and current snapshots.

The current 17-commit plan should stay intact. The architecture should gain one explicit future option: replace the reconstructed viewer with an owned PTY host only after Pi offers the state, command, repaint, and detach side channel that Claude Code has.

## Evidence and confidence

This report uses three evidence classes:

- **Confirmed from the installed bundle:** code and protocol shapes extracted from the 2.1.251 executable with targeted string searches.
- **Confirmed from live read-only state:** `daemon.lock`, `daemon/roster.json`, four job state records, one session JSONL's record shapes, process command lines, and `claude agents --json`.
- **Documented by the command line:** `claude --help` and help for `agents`, `attach`, `logs`, `stop`, and `rm`.

No background session was started. No live process was signaled. No file under `~/.claude`, `~/.local/share/claude`, or `~/.local/state` was changed.

Behavior marked **unverified** is inferred from code without an isolated end-to-end terminal test.

## One PTY host owns one Claude process

The established facts are correct, with one qualification about daemon survival.

The live process tree has these roles:

```text
daemon
  bg-pty-host --bg-pty-host <pty.sock> 200 50 -- claude --bg-spare <claim.sock>
    bg-spare
```

After a spare is claimed, the inner `bg-spare` process becomes the Claude session. The roster then keys the worker by its eight-character short ID and stores `pid`, `procStart`, `sessionId`, `rendezvousSock`, `ptySock`, `cliVersion`, `replPid`, and `replProcStart`. The live record also contains authenticated socket tokens, launch data, terminal modes, and two interactive readiness marks.

`bg-pty-host` creates `Bun.Terminal({cols, rows})`, starts the inner process attached to it, and listens on the PTY Unix socket. The `200 50` arguments are the initial terminal width and height. They are defaults, not buffer dimensions. An attacher later sends its own dimensions, and the daemon resizes the one shared PTY.

A spare is a prestarted PTY host and Claude process waiting on a claim socket. Dispatch claims it with the session ID, working directory, flags, environment, initial size, and launch mode. The daemon immediately starts another spare. This removes much of process and runtime startup from the user's launch path. It does not provide a pool of interchangeable running sessions. A claimed spare becomes one session.

### The survival boundary is a 60-second adoption window

Closing or killing an attaching terminal only closes that terminal's daemon connection. The daemon remains connected to the PTY host, so the agent continues. Closing the terminal emulator has the same result.

A daemon exit is different. On Linux, the PTY host checks every 2,000 ms whether its parent PID changed and whether any client remains on its PTY socket. After 30 consecutive checks, it sends the child `SIGTERM`, then `SIGKILL` after 5,000 ms if needed. The grace period is therefore 60 seconds.

A replacement daemon reads the roster, validates PID plus process-start identity, reconnects to `ptySock`, reconnects to the rendezvous socket, and adopts the session. Adoption resets the orphan counter because a PTY client is present. The live daemon log confirms successful self-restarts from 2.1.246 through 2.1.251 while background workers continued.

Claude Code therefore survives a normal daemon restart, including an upgrade, but not an indefinitely absent daemon. Our workers currently survive daemon absence without a 60-second limit. That stronger property remains worth keeping.

The PTY host also has per-client liveness checks. It sends a ping every 60 seconds after the first pong and disconnects a client after three missed replies. A slow client with more than 1 MiB pending output is also disconnected. Neither condition stops the child while another supervisor connection remains.

## Attach combines a raw byte protocol with an application repaint

The PTY socket protocol uses a five-byte frame header:

```text
uint32be payload_length
uint8    kind              # 0 = terminal bytes, 1 = JSON control
payload
```

The maximum accepted frame is 1 MiB. Control frames include `hello`, `live`, `ping`, `pong`, `auth`, `auth-required`, `resize`, `kill`, and `exit`. The PTY host authenticates input-capable clients with a per-worker token.

The PTY host retains the last 262,144 bytes of raw output in memory. On each PTY socket connection it sends `hello`, replays that byte ring, sends `live`, and then streams new bytes. The daemon keeps another roughly 256 KiB ring, trimming after it crosses 1.25 times that size. `claude logs <id>` and the daemon's `subscribe` operation use this recent output. The normal subscription snapshot defaults to the last 200 output chunks, not 200 lines.

That raw tail is not the late attacher's user-facing history. Interactive attach follows a different sequence:

1. The client sends a versioned `attach` request with the short ID, control-key authentication, dimensions, a random attach ID, and terminal capabilities.
2. The daemon replies with current terminal modes, worker version, state, tempo, cache status, and an optional interactive-mark nonce.
3. The daemon asks the agent to repaint over the private rendezvous socket.
4. It buffers repaint bytes until it sees the alternate-screen or clear-screen boundary. The attach buffer is capped at 65,536 bytes before it starts passing data through.
5. The client renders the native Claude interface and then follows the live PTY byte stream.

While a worker is still booting, the daemon may render a temporary screen from the conversation JSONL. Once the real worker redraws, that cached frame is replaced.

### A late attacher gets a reconstructed interface, not terminal scrollback

The durable history is the conversation JSONL. The inspected live session had 12,551 records and 3,040 messages reported at first paint. Its JSONL contains user and assistant messages, attachments, queue operations, settings, file history, names, and other conversation records. It is not a durable screen recording.

The agent emits two private readiness marks:

- `content_paint`, optionally with messages loaded, messages in JSONL, and messages rendered at first paint
- `prompt_idle`

The daemon stores at most the first two marks in the roster and replays them to a capable attacher. They measure whether the native interface is usable. They are not transcript events.

The practical result is better than tmux scrollback for this application. Claude Code reloads its logical transcript, renders the full native interface, and repaints the current screen. A late user can navigate the transcript through Claude Code itself. The PTY layer retains only 256 KiB of raw recovery data and no durable scrollback.

**Unverified:** the exact transcript truncation policy presented by the interactive UI after very large compactions. The live readiness mark proves that 3,040 messages were loaded and rendered for the inspected session, but it does not define a universal upper bound.

## Linux allows shared typing

Claude Code 2.1.251 does not implement one writer plus observers for local background sessions on Linux.

The daemon stores attachers in a map. Every attacher receives output. Every attacher's input handler writes bytes into the same PTY. `lastInputAttacher` records who most recently typed so an agent-originated detach request can be routed back to that client. It is not a write lock.

There is no writer claim, read-only role, takeover request, or last-writer-wins ownership record. If two Linux clients type concurrently, their byte chunks are accepted in arrival order and can interleave at the editor. Both clients see the common output. A resize from either client changes the shared PTY dimensions. When one disconnects, the daemon resizes to the most recently retained attacher's dimensions.

Windows is different. A new attach explicitly kicks existing attachers with `EKICKED: Session opened in another window`. This is a platform workaround, not the Linux ownership model.

The attach journal does not record writer identity or typing. It holds one short-lived JSON file per attach gesture for telemetry recovery. Fields include gesture ID, surface, PID plus process-start identity, start time, attempt, whether readiness marks were expected, whether the daemon booted, attach latency, and message counts. Clean completion deletes the entry. Stale entries are converted into attach-outcome telemetry after 15 minutes for a live PID or 24 hours without one.

Our one-writer rule remains the better default. Claude Code can tolerate shared typing because the attached programs are all clients of the same terminal editor, and the agent itself understands its input state. Our frontend sends structured mutations that should have one explicit owner. Shared typing would also conflict with the accepted-command recovery contract. Claude Code proves that shared input is possible, not that it is desirable.

## List state comes from the agent's state channel

`claude agents` does not infer working state from the conversation JSONL or PTY output.

Each job has a durable `~/.claude/jobs/<short>/state.json`. The inspected records contain:

- `state`, such as `blocked` or `done`
- `tempo`, such as `active`, `blocked`, or `idle`
- `inFlight.tasks`, `inFlight.queued`, `inFlight.kinds`, and `inFlight.drainableMonitors`
- `detail`, `needs`, `suggestedReply`, and final `output`
- identity, working directory, session ID, worker version, and transcript path

The running agent sends structured `state` patches over its rendezvous socket. The daemon applies them to its in-memory worker record and broadcasts state patches to list subscribers. It also persists the job state record. The roster is for process adoption and carries only the daemon's current worker projection.

The bundle's activity classifier treats a row as active when `tempo === "active"`. It separately reports in-flight work when queued work is positive, non-drainable tasks are positive, or a `session_cron` kind is present. Settled state overrides ordinary activity. The exact display label then comes from this structured state, not from the last JSONL message.

The live `claude agents --json` output showed three durable `blocked` rows and one live PID whose durable state was `done` and status was `idle`. This confirms that process liveness, job state, and activity are separate facts.

This strongly supports our snapshot plus daemon-invalidation plan. It also strengthens one detail: Pi should publish explicit activity and waiting facts to the worker if its RPC events do not already cover them. File tailing remains too weak.

## Dispatch and attach journals are narrower than our command journal

The dispatch directory is an inbox for new background-session launch envelopes. A dispatch record includes protocol version, short ID, nonce, session ID, creation time, source, working directory, launch mode and arguments, environment, isolation data, agent, seed metadata, and initial terminal size.

The daemon watches the directory, validates files, rejects symlinks, rejects records larger than 256 KiB, rejects stale records older than 24 hours, and consumes a valid record by deleting it after dispatch. Invalid records move to `dispatch/rejected` with a diagnostic. An `await-ack` control operation and nonce connect the producer's request to daemon acceptance.

This resembles durable launch admission, not a general command journal. It has no accepted, delivered, acknowledged, failed, or ambiguous stages for prompts typed after launch.

The attach journal is only an attach-telemetry beacon, as described above. It does not record command delivery.

Interactive input is ordinary PTY bytes. A list-side `reply` first tries a structured rendezvous `reply` when the agent reports blocked state. Otherwise it writes bracketed-paste bytes followed 10 ms later by carriage return. If a client dies midway through typing, already written bytes stay in the editor and unwritten bytes are lost. If it dies after carriage return, the agent may have accepted the command. There is no durable ambiguity record and no automatic replay.

Claude Code's failure text makes the policy explicit when the PTY host dies: terminal output is gone and the command is not run again. This chooses at-most-once behavior by refusing to guess. It does not provide our delivery evidence.

Our command journal is therefore not overengineering for Pi RPC. It records a property Claude Code does not offer for terminal input.

## Moving between list, session, and shell uses agent-aware detach

`claude agents` opens a full-screen list. Enter opens the selected background session. The attached view is the full native Claude interface, including transcript, editor, tool UI, dialogs, colors, mouse modes, and terminal title behavior.

The documented return keys are:

- Left returns from a session to the agent list.
- Ctrl+Z drops from the session to the shell.
- The background session continues in both cases.

The attach transport always recognizes Ctrl+Z. Left is different from the tmux prototype. Claude Code itself emits a private detach control sequence over the terminal stream and the outer process remounts the list. This lets the application decide when Left means "back" rather than forcing a multiplexer to swallow every Left byte. The bundle includes a `repl_back` path and a measured internal marker named `bg-leftarrow-mounted`.

**Unverified:** the exact editor condition under which Claude Code treats Left as return-to-list. The implementation is inside the agent UI, but the help text alone does not specify whether the prompt must be empty or the cursor must be at its left boundary.

This is the decisive difference from our tmux binding. We could not reserve Left outside Pi without breaking cursor movement. Claude Code can interpret it inside its own editor and emit an out-of-band detach request.

## Version skew is adopted first and replaced safely

Claude Code separates daemon version, worker version, and protocol compatibility.

The daemon lock stores its version and launch target. Each roster entry stores `cliVersion`. Every attach response also reports the worker version and whether it is stale. The control protocol and durable roster carry `proto: 1` independently of the release string.

When the `claude` binary target changes, the daemon logs the old and new paths, self-restarts on the new binary, reads the roster, verifies each PTY host by PID plus process-start identity, and adopts it. The live log shows this sequence for four upgrades. A daemon upgrade does not require all workers to restart at the same moment.

Stale workers continue running. The daemon may prewarm and respawn idle stale workers, with a default burst concurrency of three. `claude respawn <id>` provides an explicit replacement path. A worker newer than the daemon is not automatically downgraded. The daemon records a downgrade refusal instead.

A worker marked `pendingRespawn: "upgrade"` can be resumed by the new daemon after adoption. If the old worker has vanished, the new daemon may recreate it from the dispatch and durable conversation state. An old roster missing new authentication fields triggers re-key or respawn rather than blind use.

The rule to copy is:

1. Start the new daemon version.
2. Adopt compatible live workers by exact process identity.
3. Mark their code version as stale without refusing normal list startup.
4. Replace stale workers only at a safe idle boundary or through an explicit operator action.
5. Refuse automatic downgrade.

This is better than requiring a frontend, daemon, and every worker to have one release string before any launch can work.

## Protocol and durable state are separate

Claude Code uses several protocols rather than one global schema:

| Boundary | Versioning and authentication | Durable recovery data |
| --- | --- | --- |
| Client to daemon control socket | Integer `proto`, currently 1; peer UID; control key for mutations and attach | Daemon lock, dispatch envelope, job state |
| Daemon roster | `proto: 1`; per-worker release in `cliVersion` | `roster.json` |
| Daemon to PTY host | Five-byte framing; host release in `hello`; per-worker PTY token | No durable byte log; 256 KiB in-memory tail |
| Daemon to agent rendezvous socket | Typed messages for heartbeat, state, reply, repaint, readiness marks, detach, and shutdown; per-worker token | Job state, conversation JSONL, selected readiness marks in roster |
| Conversation | Record-level `version` fields in JSONL | Project session JSONL |
| Attach gesture | Shape-checked JSON beacon, PID plus process-start identity | Short-lived attach-journal entry |

Our contracts are stricter at the dashboard boundary. We version frontend requests, daemon events, worker IPC, and normalized viewer events. Claude Code's design supports that separation. It also shows that a PTY byte stream should remain an unversioned rendering transport while commands and state use typed side channels.

Claude Code has no durable ordered list event log comparable to ours. It reads current job records, seeds the list, and receives current updates. That supports retiring our list replay log in favor of invalidation plus snapshot. Its durable conversation JSONL is closer to Pi's canonical session file than to our registry or viewer projection.

## Effect on the 17 commits

| Commit | Finding | Effect on our plan |
| --- | --- | --- |
| 1. Remove dashboard session queries | Supports | Claude Code leaves agent-specific inspection in the native agent interface. A dashboard should not duplicate unsupported Pi queries. |
| 2. Remove Pi settings passthrough | Supports | Claude Code's agent owns its settings and UI. The list owns supervision metadata. |
| 3. Make thinking display-only | Supports | Observed agent state and dashboard launch policy are separate. Do not offer controls Pi does not stably expose. |
| 4. Open occupied sessions read-only | Suggests a different option, but keep | Claude Code allows shared typing on Linux. Our structured mutation path has stronger delivery and ownership requirements, so one composer plus observers remains safer. |
| 5.1. Specify worker socket handoff | Strongly supports | Claude Code adopts authenticated PTY and rendezvous sockets by exact PID plus process-start identity. It keeps release and route metadata in the roster. |
| 5.2. Move worker traffic to the socket | Strongly supports | Ongoing state, replies, repaint, shutdown, and readiness use the adopted rendezvous socket rather than launch IPC. |
| 5.3. Make socket adoption the ready boundary | Strongly supports | Claude Code distinguishes process spawn, PTY connection, agent readiness, content paint, and idle prompt. Readiness is not merely child existence. |
| 6. Record only Pi-confirmed model | Supports | Claude Code rows use agent-published job state. Requested launch flags are not treated as observed runtime facts. |
| 7.1. Add race-safe list invalidation | Supports | The list starts from current durable job state and live patches. It does not rebuild rows by replaying the conversation. |
| 7.2. Publish list invalidations only | Supports | Claude Code has no durable detailed list event log. Current state is authoritative. |
| 7.3. Remove list cursor persistence | Supports | No equivalent list cursor appears in the daemon roster or job state. |
| 8.1. Notify viewers when access changes | Contradicts Claude Code, but keep | Claude Code has no writer role on Linux. Our explicit one-writer contract needs notifications because we choose stricter ownership. |
| 8.2. Remove durable attachments and isolate frontend state | Supports | Claude Code's attachers are in-memory socket entries. Its attach journal is telemetry, not ownership. Claims should die with connections. |
| 9.1. Keep viewer resume state in the frontend | Supports under the current RPC viewer | Claude Code avoids viewer acknowledgements by repainting native UI from the agent's durable conversation. Until we own a PTY path, frontend cursor plus stable event IDs remains appropriate. |
| 9.2. Retire viewer acknowledgement files | Supports | Claude Code has no per-viewer durable acknowledgement store. Its recovery source is conversation state plus repaint. |
| 10.1. Make Delete forget-only | Product-specific; keep | `claude rm` may remove a safe worktree and background job state, while `stop` preserves the conversation. Pi's canonical file and managed worktree have different ownership, so Claude Code is not a reason to broaden Delete. |
| 10.2. Retire trash recovery | Supports our narrower Delete | Claude Code performs its own safe worktree checks. Our forget-only operation needs no unused filesystem transaction. |

## Effect on the eight settled decisions

| Decision | Claude Code evidence | Effect |
| --- | --- | --- |
| 1. Validate model admission in the daemon | Launch dispatch is validated and acknowledged by the daemon before spawn. | Supports centralized admission. |
| 2. Known refusal leaves no session artifacts | Invalid or stale dispatch files are rejected before a worker is created. | Supports separating admission refusal from post-preparation failure. |
| 3. Catalog failure lets Pi decide | Claude Code distinguishes requested launch configuration from observed agent state. | Supports preserving an explicit unknown diagnostic instead of inventing runtime state. |
| 4. Remove the unused trash seam | Claude Code has explicit `stop` and `rm` semantics rather than one ambiguous delete hook. | Supports one narrow operation per meaning. |
| 5. Ship one list protocol and require frontend restart | Claude Code handles skew more smoothly through an integer protocol plus self-restarting daemon and worker adoption. | Suggests something better: keep the explicit refusal, but add a visible restart path rather than accepting an empty list as the user experience. |
| 6. Ignore obsolete durable files in place | The daemon tolerates and reconciles bounded old roster and attach records. | Supports conservative retention and bounded parsing. |
| 7. Ignore legacy trash transactions | No direct analogue. | Neutral. Our production history remains the deciding evidence. |
| 8. Authenticate socket adoption before dropping IPC | PTY and rendezvous sockets use per-worker tokens, and adoption validates process identity before normal service. | Strongly supports the handoff order. |

## The tmux rejection was right, but a general PTY rejection would be wrong

The tmux prototype rejected a specific architecture: native interactive Pi under a generic tmux server with no structured Pi side channel. Claude Code does not contradict that result.

Claude Code removes four tmux weaknesses:

1. One PTY host contains one session, so one host failure does not stop every agent.
2. The agent publishes state, readiness, repaint completion, detach requests, and shutdown status over a private rendezvous socket.
3. The application handles return-to-list itself. A transport-level binding does not swallow every Left key.
4. The daemon authenticates and adopts each PTY host by PID plus process-start identity and per-worker tokens.

It retains two costs we measured: attached clients share one terminal size, and terminal input has no durable acknowledgement. It also accepts shared typing on Linux.

If "reject pseudo-terminal hosting" means that no owned PTY architecture is worth considering, Claude Code disproves it. If it means that our current Pi integration should not discard RPC and run today's interactive Pi under tmux, the decision remains correct.

The missing prerequisite is inside Pi. An owned PTY viewer becomes credible when interactive Pi can provide, beside terminal bytes:

- structured lifecycle and row state
- authenticated prompt, interrupt, model, UI-response, and shutdown operations
- repaint and readiness marks
- a context-aware detach action
- exact session identity and canonical transcript location

Without those, PTY hosting would still lose our command journal, structured Stop, and honest list state.

## What to copy, in priority order

1. **Adopt by socket and exact process identity.** Keep PID plus process-start identity, authenticate every worker route, and make adoption a normal daemon-start path.
2. **Separate rendering from state.** Whether the viewer stays RPC or later becomes PTY-based, rows should use structured agent state. Never infer working state from terminal bytes or the canonical JSONL.
3. **Use application repaint for late attach.** If Pi gains an owned PTY mode, request a full native repaint and wait for explicit content-painted and prompt-idle marks. Do not present raw byte replay as a usable screen.
4. **Handle release skew through adoption.** Restart the daemon on the new version, adopt compatible workers, mark stale workers, replace them at idle or explicitly, and refuse downgrade.
5. **Keep a small bounded diagnostic tail.** A 256 KiB in-memory raw output ring is useful for startup failures and `logs`. It should not become canonical viewer history.
6. **Prewarm only after measurement.** Claude Code's spare removes startup work, but it keeps a full Claude process resident. Measure Pi launch latency and memory before copying this.
7. **Make detach agent-aware.** A native viewer should ask Pi to detach at a safe editor boundary. The host should retain a separate unconditional escape such as Ctrl+Z.

## What not to copy

- **Do not copy shared typing.** Keep one composer and any number of observers unless the product explicitly adds collaborative terminal semantics.
- **Do not replace the command journal with PTY writes.** Claude Code cannot distinguish partial input, submitted input, and accepted work after a client failure.
- **Do not copy the 60-second daemon dependency.** Our detached worker can survive indefinitely and reconnect. That is stronger than Claude Code's orphan watchdog.
- **Do not make one client resize everyone's reconstructed viewer.** The current normalized viewer can render per terminal. An owned PTY would reintroduce shared-size behavior and needs an explicit product choice.
- **Do not copy the agent's private state schema wholesale.** `tempo`, `inFlight`, `needs`, and `suggestedReply` exist because Claude Code controls the agent. Map only facts Pi publishes.
- **Do not copy `rm` semantics into Delete.** Claude Code owns its worktree cleanup policy. Our dashboard does not own Pi's canonical session file.
- **Do not add prewarmed spares before the architecture needs them.** They add memory use, claim authentication, stale-version replacement, and cleanup paths.

## Recommendation

Ship the 17 commits as planned. Add a follow-up design investigation, not an implementation commit, for an owned PTY viewer backed by a Pi side channel. The acceptance bar should be explicit: it must preserve structured row state, durable command stages, authenticated Stop, one writer, late-attach repaint, and daemon-independent worker lifetime.

Until Pi can meet that bar, keep RPC mode and the reconstructed viewer. Claude Code proves that native session rendering is compatible with a supervised dashboard. It also proves that the native agent must participate in the protocol.

## Sources

- Claude Code 2.1.251 executable, `/mnt/main0/home/gjohnson/.local/share/claude/versions/2.1.251`, build SHA `37534ac596d80cefb02d272f036adba4ba055d2c`.
- Claude Code command help from `claude --help`, `claude agents --help`, `claude attach --help`, `claude logs --help`, `claude stop --help`, and `claude rm --help`.
- Read-only live state in `~/.claude/daemon.lock`, `~/.claude/daemon/roster.json`, `~/.claude/daemon/attach-journal`, `~/.claude/daemon/dispatch`, `~/.claude/jobs/*/state.json`, and one named project session JSONL.
- Read-only process command lines and `~/.claude/daemon.log`.
- [Architecture](architecture.md).
- [Architecture implementation plan](architecture-plan.md).
- [Tmux prototype report](tmux-prototype-report.md).
