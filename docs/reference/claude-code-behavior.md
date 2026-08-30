# Claude Code background-session behavior

This reference specifies the background-session behavior found in Claude Code 2.1.251, build `37534ac596d80cefb02d272f036adba4ba055d2c`. Every detail is version-specific. An equivalent implementation should not assume that another release behaves the same way. [O]

Evidence labels apply to every paragraph and table row. [O]

- **[O] Observed:** read directly from process arguments or state on this machine without changing or signaling it.
- **[B] Build:** derived from strings, schemas, or control flow in the installed executable.
- **[I] Unverified inference:** a conclusion from [O] or [B] that was not exercised end to end.

## Each session has one PTY host and one agent

The process tree has three roles. A client such as `claude agents` starts or connects to one daemon. The daemon owns the roster, control socket, list state, attachments, spare pool, adoption, and replacement policy. Each live session has a separate pseudo-terminal (PTY) host. The host owns the PTY, the raw-output tail, terminal size, client liveness, and the child agent process. The agent owns the native interface, conversation reload, structured state, repaint, and agent-aware detach. [O][B]

The observed daemon command was: [O]

```text
claude daemon run \
  --json-path <config-home>/daemon.json \
  --log-file <config-home>/daemon.log \
  --origin transient \
  --spawned-by <json>
```

`--json-path` names daemon configuration, `--log-file` names its diagnostic log, `--origin` records how it was started, and `--spawned-by` records the launching client's label, directory, and PID. The lock also records the executable target and any process wrapper used for later restarts. [O]

The observed unclaimed spare had this shape: [O]

```text
daemon
  claude bg-pty-host --bg-pty-host <pty-socket> 200 50 -- \
    <versioned-claude-binary> --bg-spare <claim-socket>
      claude bg-spare --bg-spare <claim-socket>
```

`--bg-pty-host` puts the outer process in PTY-host mode. The following socket is its server endpoint. `200 50` is the initial column and row count. Arguments after `--` launch the child. `--bg-spare` makes that child wait for a claim envelope on the claim socket. A claim supplies the session ID, working directory, launch flags, environment, launch mode, and terminal size. The claimed spare becomes one session, and the daemon starts a replacement spare. [O][B]

The roster's `pid` identifies the PTY host. `replPid` identifies the agent inside its PTY. Both have process-start values because a PID alone can be reused. The host creates `Bun.Terminal`, launches the agent with `TERM=xterm-256color`, and forwards PTY bytes and JSON control frames. [O][B]

### Persistent and runtime layout

The observed persistent layout was: [O]

```text
<config-home>/
  daemon.lock
  daemon.json
  daemon.log
  daemon/
    control.key
    roster.json
    attach-journal/
    dispatch/
  jobs/<short-id>/state.json
  projects/<encoded-project>/<session-id>.jsonl
```

| Entry | Purpose | Evidence |
| --- | --- | --- |
| `daemon.lock` | Daemon PID and process-start identity, release, executable target, start metadata, configuration path, log path, and wrapper. | [O] |
| `daemon.json` | Daemon configuration selected by `--json-path`. | [O][B] |
| `daemon.log` | Daemon diagnostics and restart or adoption history. | [O] |
| `daemon/control.key` | Secret required for mutating control operations such as attach input. It is not copied into the roster. | [O][B] |
| `daemon/roster.json` | Durable adoption records for PTY hosts and their agent children. | [O][B] |
| `daemon/attach-journal/` | Short-lived attach telemetry records. Clean completion removes a record. A record does not grant input ownership or journal commands. | [O][B] |
| `daemon/dispatch/` | Durable launch inbox. Accepted records are consumed; rejected records may move under `dispatch/rejected/`. | [O][B] |
| `jobs/<short-id>/state.json` | Durable structured row state published by the agent. | [O][B] |
| project session JSONL | Durable conversation records used by the agent when it resumes and repaints. It is not a terminal recording. | [O][B] |

On Linux, the runtime root is `/tmp/cc-daemon-<uid>/<16-hex-instance>/`. The instance directory is private to the user. The observed entries and build-defined per-session names are: [O][B]

```text
control.sock
pty/<short-id>.sock
rv/<short-id>.sock
spare/<nonce>.pty.sock
spare/<nonce>.claim.sock
spare/<nonce>.pty.sock.err
```

| Entry | Purpose | Evidence |
| --- | --- | --- |
| `control.sock` | Newline-delimited JSON control protocol used by list, attach, resize, reply, stop, respawn, and subscription clients. | [O][B] |
| `pty/<short-id>.sock` | Framed raw-byte and JSON-control connection to a claimed PTY host. A claimed spare can retain its `spare/<nonce>.pty.sock` path instead. | [O][B] |
| `rv/<short-id>.sock` | Authenticated rendezvous channel between the daemon and the agent for state, reply, repaint, readiness, detach, heartbeat, completion, and shutdown. | [O][B] |
| `spare/<nonce>.pty.sock` | PTY-host endpoint for a prestarted spare. | [O][B] |
| `spare/<nonce>.claim.sock` | One-time claim endpoint for the spare agent. It disappears after a successful claim. | [O][B] |
| `spare/<nonce>.pty.sock.err` | PTY-host startup diagnostics. Empty files are valid. | [O][B] |
| `pty-pids/` and sidecar files | Windows-oriented PID and exit sidecars defined by the build. They were not present in the Linux runtime inspected here. | [B] |

**Adopt:** one independently adoptable worker per session. Keep our worker and Pi process because Pi cannot provide Claude Code's PTY repaint, readiness, and detach channels. **Measure now:** add a commit that records 30 cold launches, per-stage latency, machine load, and worker plus Pi resident memory after 60 idle seconds; use the result to decide whether to adopt one authenticated spare. See the [architecture plan](../architecture-plan.md#change-13-measure-whether-one-prewarmed-spare-earns-its-resident-cost). [O][B]

## The roster is an adoption record

The roster root and worker entry are strict version-1 records. Unknown worker fields are retained during a rewrite, which permits a newer writer to add data without an older reader discarding it. [B]

| Field | Type | Meaning | Equivalent record |
| --- | --- | --- | --- |
| `proto` | integer | Roster protocol version. The observed value was `1`. | Required. Use an independent protocol version. [O][B] |
| `supervisorPid` | integer | PID of the daemon that last wrote the roster. | Diagnostic only. [O][B] |
| `updatedAt` | integer | Last roster write time in Unix milliseconds. | Useful for diagnosis. [O][B] |
| `workers` | object keyed by 8-hex short ID | One adoption record per PTY host. | Required, keyed by stable session identity rather than display text. [O][B] |
| `pid` | integer | PTY-host PID. | Required for the worker process. [O][B] |
| `procStart` | string, optional in parser | Operating-system process-start identity paired with `pid`. | Required. Refuse identity-sensitive actions when absent. [O][B] |
| `sessionId` | string | Full conversation session ID. | Required. [O][B] |
| `rendezvousSock` | path string | Agent side-channel socket. | Required for the structured worker route. [O][B] |
| `ptySock` | path string, optional | PTY-host socket. Older records can lack it. | Specific to a PTY design. [O][B] |
| `messagingSock` | path string, optional | Additional messaging endpoint accepted by the parser. It was absent from the live record. | Agent-specific. [B] |
| `cliVersion` | string, optional | Release of the worker code, separate from `proto` and daemon release. It decides equal, stale, or newer status only after adoption. | Required as worker release metadata. [O][B] |
| `startedAt` | integer | Host start time in Unix milliseconds. | Useful, but not a substitute for process-start identity. [O][B] |
| `attempt` | integer | Spawn or respawn attempt number. | Useful for diagnosis. [O][B] |
| `cwd` | path string | Session working directory. | Required if launch or resume depends on it. [O][B] |
| `worktreePath` | path string, optional | Isolated worktree path. It was absent from the inspected worker. | Required only for isolated sessions. [B] |
| `dispatch` | object | Capped launch envelope retained for resume or respawn. | Keep only inputs needed to restart safely. [O][B] |
| `pendingRespawn` | literal `"upgrade"`, optional | Replacement was in progress when the roster was written. | Required if replacement must survive daemon restart. [B] |
| `decModes` | integer array, optional | Active DEC terminal modes needed to restore an attached terminal. | PTY-specific. [O][B] |
| `firedInteractiveMarks` | array, maximum 2 | First unique `content_paint` and `prompt_idle` marks, including optional message counts. | Adapt only for a native repaint protocol. [O][B] |
| `rvAuth` | string, optional | Rendezvous authentication token. | Required secret for an equivalent socket. [O][B] |
| `ptyAuth` | string, optional | Token that authorizes input on the PTY socket. | PTY-specific. [O][B] |
| `replPid` | integer, optional | Agent PID inside the PTY host. | Required if the supervised child has separate identity. [O][B] |
| `replProcStart` | string, optional | Process-start identity paired with `replPid`. | Required with the child PID. [O][B] |

The observed `dispatch` object contained `proto`, `short`, `nonce`, `sessionId`, `createdAt`, `source`, `cwd`, `launch`, `env`, `isolation`, `respawnFlags`, `agent`, `seed`, `cols`, and `rows`. `launch` contained `mode`, `sessionId`, `transcriptPath`, `fork`, `flagArgs`, and `restoresTranscript`. `seed` contained `intent` and `name`. The daemon removes sensitive or oversized values before placing dispatch data in the roster. [O][B]

An equivalent record needs protocol, stable session ID, worker PID and process-start identity, child identity when separate, authenticated route data, release, launch identity, and replacement state. Terminal modes, repaint marks, PTY authentication, Claude launch flags, and transcript paths are specific to this agent and viewer. [I, unverified]

**Adopt:** exact process identity, authenticated route data, and a release field separate from protocol compatibility. Persist only Pi launch data needed for recovery. **Divergence kept:** omit terminal and Claude-specific fields because Pi cannot publish or consume them. See [Changes 5.1 and 5.4](../architecture-plan.md#change-5-commands-work-on-every-session-and-stop-uses-its-graceful-route). [O][B]

### Startup readiness has no handoff messages

Claude Code does not hand a worker from launch IPC to its durable sockets. The daemon creates the PTY and rendezvous socket paths before spawn and connects to both directly. On the PTY socket, the host sends framed control `"hello"`, its retained output tail, and framed control `"live"`. The daemon's rendezvous connector sets its internal `workerReady` Boolean when that connection opens. There is no `"ready"` frame, handoff request, or handoff acknowledgement in this path. [B]

`"hello"` and `"live"` are not names for our `connect_socket` or transport switch. Claude Code's `"hello"` reports the child PID and host version after connection, making it the equivalent of our existing `worker_hello` identity handshake. Rename that handshake to `hello`. Claude Code's `"live"` marks the boundary between the retained PTY tail and new terminal bytes, so reusing it for a launch-IPC command would assign Claude Code's name to different behavior. Our `connect_socket`, `handoff_to_socket`, and `socket_handoff_complete` messages therefore remain project-specific. The equivalent readiness mark changes from `socket_ready` to `workerReady`. Pi requires an explicit handoff because the current worker starts with launch IPC and later adopts one RPC socket. [B]

The build also makes a weaker readiness claim than this plan. Fresh launch sets `workerReady` from the rendezvous connection callback rather than from a named authentication-success acknowledgement. Roster adoption sets `workerReady` before reconnecting the saved PTY and rendezvous sockets. Authentication failures are reported later as `"auth-required"`, `"auth-rejected"`, or `"reply-rejected"`. Our sequence deliberately requires authenticated adoption before persisting readiness and disconnecting launch IPC; the observed path does not suggest moving or removing one of our steps. [B]

The attach control protocol calls its connection-scoped identifier `attachId`, not `connectionId`. Both the `"attach"` and `"resize"` operations accept `attachId`, and the daemon keys its in-memory attacher map with that value. Use `attachId` for the dashboard process's socket-scoped identity while retaining `clientId` and `requestId` for durable command recovery. [B]

## Attach becomes usable after a native repaint

The control client opens `control.sock` and sends one newline-terminated object. The attach request is `{proto: 1, op: "attach", short, auth, cols, rows, attachId, caps, holdingFrame}`. `auth` is the control key. `attachId` distinguishes this connection. `caps` can report readiness-mark support, terminal and multiplexer details, Secure Shell use, color level, theme, hyperlink and synchronized-output support, and related rendering capabilities. Dimensions are bounded from 1 through 10,000. [B]

The path from start to a usable screen is: [B]

1. The daemon validates protocol, control-key authentication, worker presence, and worker lifecycle state. It selects an optional temporary frame reconstructed from the conversation file only while the worker is booting. [B]
2. The daemon replies with `{ok, op: "attach", imarkNonce, decModes, via, booting, tempo, state, cached, stale, workerCliVersion}`. `imarkNonce` is present when the agent and client support readiness marks. [B]
3. Independently, daemon adoption of the PTY socket receives framed control `hello`, then the host's raw-output tail, then framed control `live`. `hello` carries the child PID and host release. New PTY bytes follow after `live`. [B]
4. The daemon asks the agent for `{type: "repaint"}` on the rendezvous socket. If dimensions changed, it resizes first and sends `SIGWINCH` on Linux. For an unchanged size, it can briefly toggle one column if no `repaint-done` arrives, forcing a redraw. [B]
5. The agent redraws its native interface from its conversation and current UI state. It then sends `{type: "repaint-done"}` on the rendezvous socket. [B]
6. During attach, the daemon buffers repaint output until it sees an alternate-screen or clear-screen boundary. The buffer is capped at 65,536 bytes. After the boundary or cap, bytes pass through to the client. A boot-only cached frame is replaced by the real repaint. [B]
7. The agent emits `{type: "interactive-mark", kind: "content_paint", ...}` and later `kind: "prompt_idle"`. `content_paint` can include nonnegative `msgsLoaded`, `msgsInJsonl`, and `msgsRenderedAtFirstPaint`, each bounded at 1,000,000,000. The daemon stores at most the first two unique marks and delivers them to a capable attacher with its nonce. [O][B]
8. The client considers the native screen painted at `content_paint` and the editor ready at `prompt_idle`. The client then renders live PTY output and sends input on the same attachment. [B]

The PTY protocol uses a 5-byte header: a 4-byte big-endian payload length and a 1-byte kind. Kind `0` is terminal bytes. Kind `1` is JSON control. Frames larger than 1,048,576 bytes are rejected. Control messages include `hello`, `live`, `ping`, `pong`, `auth`, `auth-required`, `resize`, `kill`, and `exit`. [B]

The PTY host retains exactly 262,144 bytes of recent raw output in memory. Every new daemon connection receives `hello`, that tail, and `live`, in that order. The daemon also keeps a bounded recent-output ring for `logs` and `subscribe`; a normal subscription asks for 200 chunks. Neither ring is durable viewer history. [B]

**Adopt now:** authenticated `attach`, explicit readiness, and a `logs` command that returns a bounded 256 KiB diagnostic tail. Read that tail from the existing per-run log instead of adding a duplicate memory ring. **Divergence kept:** keep the structured viewer and do not treat raw output as canonical history because Pi cannot provide native repaint and readiness channels. See [Changes 11 and 12](../architecture-plan.md#change-11-logs-exposes-the-error-already-on-disk) and the [deferred PTY viewer decision](../architecture-plan.md#claude-code-evidence-changes-access-diagnostics-naming-and-the-upgrade-path). [B]

## Detach closes one attachment, not the session

Closing an attach client removes only that socket entry. The daemon, PTY host, agent, structured state, and conversation continue. A later client repeats attach and receives a fresh native repaint. [O][B]

Ctrl+Z is an unconditional transport detach. Left-arrow return is agent-aware: the agent decides when Left means return to the list, sends `detach-request` over rendezvous, and the daemon routes the marker to the most recent input attacher or broadcasts it when requested. **[I, unverified]** The precise editor condition for Left-arrow detach was not established. [B]

A daemon exit starts the PTY host's orphan watchdog on Linux. Every 2,000 ms, the host checks whether its parent PID changed and whether any PTY client remains. Thirty consecutive orphan checks trigger `SIGTERM` to the agent, followed by `SIGKILL` after 5,000 ms if it remains. A replacement daemon therefore has 60 seconds to reconnect before termination begins. Any PTY client resets the orphan count. [B]

The host pings connected PTY clients. After the first pong, it sends a ping every 60 seconds and disconnects after 3 missed replies. It also disconnects a client with more than 1 MiB queued for writing. Losing one client does not stop the agent while another daemon connection remains. [B]

Resume reads the roster, verifies PID plus process-start identity, reconnects to the PTY and rendezvous sockets with their tokens, restores terminal modes and readiness marks, and asks the agent to repaint. If the host has gone, replacement can use the retained dispatch and durable conversation state. [B]

**Adopt:** attachment lifetime is connection-scoped and later attach starts from current state. **Divergence kept:** our workers survive daemon absence indefinitely because a 60-second orphan timeout can terminate the operator's running work. **Divergence kept:** host-level Left interception remains deferred because Pi cannot emit the context-aware detach request. See [Change 8 and the PTY viewer deferral](../architecture-plan.md#change-8-every-client-can-write-and-frontend-state-stays-local). [B]

## Release changes adopt workers before replacing them

Daemon release, worker release, and protocol compatibility are independent facts. The daemon lock records its release and launch target. The roster records each worker's `cliVersion`. Both protocols use integer `proto: 1`. [O][B]

When the executable changes under a running daemon, the sequence is: [O][B]

1. Detect that the current executable target and selected binary target differ. Record both paths, then start the replacement daemon from the new target. [O][B]
2. The new daemon reads `roster.json`. For each protocol-compatible entry, verify the PTY-host PID and process-start identity before using either socket. A missing or reused process identity is not adopted. [B]
3. Authenticate the PTY and rendezvous sockets. Old entries missing authentication data are re-keyed or respawned rather than trusted. [B]
4. Adopt the live worker first. Only then compare `cliVersion` with the new daemon release. List startup does not fail merely because an adopted worker is old. [O][B]
5. Equal release remains current. An older worker is marked stale. A newer worker remains live and gets a downgrade-refusal diagnostic instead of automatic replacement. [B]
6. A busy stale worker continues unchanged. Structured idle or settled state can open an automatic replacement boundary. `respawn <id>` is the explicit trigger. Replacement work is bounded to 3 concurrent upgrade respawns by default. [B]
7. Before replacement, write `pendingRespawn: "upgrade"`. If the daemon restarts during that transition, the next daemon resumes the replacement after adoption. [B]
8. Replacement uses the retained dispatch and durable conversation to start current worker code. If the old host vanished while the daemon was down, the same data can recreate it. [B]

The live daemon log showed adoption from release 2.1.246 through the referenced build without replacing active workers. **[I, unverified]** No isolated downgrade or busy-worker replacement test was run for this reference; those branches come from build structure. [O][B]

An equivalent implementation should serialize replacement per session, revalidate worker and child identities at the boundary, and use structured idle state only. It should leave newer or busy code running when automatic replacement is unsafe. [I, unverified]

**Adopt:** identity-first adoption, stale marking, idle or explicit replacement, and downgrade refusal. Keep our durable command stages across replacement because dropping them would hide failed or ambiguous delivery. Do not require every live worker to match the daemon release before list startup. See [Changes 5.4 and 5.5](../architecture-plan.md#commit-54-feat-adopt-compatible-workers-across-upgrades). [O][B]

## Linux clients share one editor and one terminal size

The daemon stores attachments in an in-memory map. Every Linux attacher receives the same output. Every authenticated attacher can write bytes to the same PTY, and byte chunks are applied in arrival order. `lastInputAttacher` only routes a later agent detach request. It is not a writer lease. [B]

All clients also share one PTY size. A resize from any client changes the agent's terminal. When one disconnects, the daemon selects a retained attacher's dimensions and resizes again. Per-client scroll position and local terminal rendering can differ, but editor contents, agent state, output, and PTY dimensions are shared. [B]

Windows instead removes existing attachers when a new one opens the session, using `EKICKED`. This is a platform branch, not Linux writer ownership. [B]

Shared typing is Claude Code's observed behavior. This project now adopts it. Any authenticated attached client may submit structured commands, and the daemon orders and journals them per session. [O][B]

**Adopt now:** any number of read-write clients and connection-scoped attachment state. Delete composer and observer roles, role grants and releases, takeover, `session_access_changed`, claim recovery, and `SESSION_IN_USE`. Keep per-client rendering instead of shared resize because the current viewer has no shared PTY to resize. See [Change 8](../architecture-plan.md#change-8-every-client-can-write-and-frontend-state-stays-local). [B]

## Structured state and terminal rendering remain separate

Rows come from `jobs/<short-id>/state.json` plus live rendezvous patches. The inspected records included identity, working directory, session and resume IDs, `cliVersion`, `state`, `tempo`, `detail`, `inFlight`, `needs`, `suggestedReply`, `output`, links, display metadata, transcript path, and update timestamps. Process liveness, job state, and activity are separate facts. [O][B]

A rendezvous update is `{type: "state", patch: <partial-job-state>}`. The daemon merges the patch into its worker record, persists the resulting job state, and emits `{type: "state", patch}` to subscribers. Patchable state includes `state`, `detail`, `tempo`, `inFlight`, wake and fan-out data, budget and token counts, `needs_you`, `needs`, question blocks, `suggestedReply`, output, structured result, links, queued prompt, identity and display metadata, isolation, permissions, and transcript scan metadata. [B]

`tempo` is one of `active`, `idle`, or `blocked`. `inFlight` carries `tasks`, `queued`, `kinds`, optional `drainableMonitors`, and optional wake metadata. The list treats `tempo === "active"` as active. It separately considers queued work, non-drainable tasks, and `session_cron` when deciding whether work remains in flight. A settled state overrides ordinary activity. [B]

Terminal bytes are rendering only. The bounded PTY tail supports reconnect and diagnostics. The conversation JSONL supplies durable logical history for the agent's own resume and repaint. Neither source determines row activity. [O][B]

**Adopt:** rows use structured worker state and current snapshots. Map only facts Pi publishes because Pi cannot publish Claude Code's private state schema. Do not derive activity from terminal output, the canonical conversation file, or requested launch values because inference can display false state and hide a worker failure. See [the structured-state invariant and Change 6](../architecture-plan.md#execution-rules-and-invariants). [O][B]

## Operator commands use Claude Code's verbs

Claude Code exposes `agents`, `attach`, `logs`, `stop`, and `rm`. These names separate listing, viewing, diagnostics, process shutdown, and record removal. [B]

**Adopt now:** name the list entry point `agents`; name direct session opening `attach`; add `logs`; rename `session stop` to `stop`; and rename `session delete` to `rm`. Delete the old `session status`, `session stop`, and `session delete` parser branches rather than retaining aliases. Keep `session cleanup` and `session resolve-delivery` as recovery commands because they represent work that Claude Code's command set does not perform. See [Changes 11 and 12](../architecture-plan.md#change-11-logs-exposes-the-error-already-on-disk). [B]

## Sources

- Installed Claude Code executable for the version named above.
- Read-only process arguments and process-start data under `/proc`.
- Read-only `daemon.lock`, `daemon/roster.json`, daemon runtime directory, job state records, one project conversation JSONL, and daemon log.
- [Claude Code session-model investigation](../claude-code-session-model.md).
