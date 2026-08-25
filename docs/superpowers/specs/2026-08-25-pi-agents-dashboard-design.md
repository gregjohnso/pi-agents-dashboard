# Pi Agents Dashboard Design

**Status:** Draft for joint review
**Date:** 2026-08-25
**Package:** `pi-agents-dashboard`

## Document responsibility

This file is the authoritative product contract. It owns goals, user-visible behavior, architecture, invariants, acceptance criteria, and unresolved product decisions. A product change starts here.

The [execution plan](2026-08-25-pi-agents-dashboard-execution-plan.md) owns implementation order, file boundaries, interfaces, test steps, and commands. The [task list](2026-08-25-pi-agents-dashboard-tasklist.md) tracks decision and task status. Neither companion document may change this file's requirements implicitly. If implementation evidence challenges a requirement, stop, revise this design with approval, then update the plan and task list.

## Summary

`pi-agents-dashboard` adds a global, Jobwatch-style dashboard for running and revisiting Pi sessions across working directories on one machine. `/agents` or Left on a clean, empty editor detaches the native Pi frontend from the current session and opens the dashboard. A second Left press is required only after editing the prompt or navigating editor history.

A shared per-user daemon owns agent execution and durable session state. Pi terminal processes and dashboards are native frontends attached to that daemon. Agents run concurrently in detached process groups and survive dashboard closure, frontend exit, SSH logout, and reconnection from another Pi terminal on the same machine. Closing the dashboard never stops an agent. A selected live agent stops only through an explicit, confirmed Ctrl+X action.

## Goals

1. Open the same machine-wide dashboard from any Pi session that loads the globally installed package, using `/agents` or Left on a clean, empty editor.
2. Keep active work running while dashboards and terminal frontends open, close, or disconnect.
3. Launch multiple independent Pi agents through one shared daemon.
4. Show live and saved Pi sessions across all working directories on the machine.
5. Attach the native Pi interface to a selected session with Enter or Right.
6. Resume an inactive saved session transparently when the user sends a new message.
7. Match the dense, keyboard-driven look and feel of `evolutionaryscale/projects/jobwatch`.
8. Recover useful state after dashboard, worker, frontend, or daemon crashes.
9. Install as a standard Pi package from npm or a local path, without requiring a globally installed companion binary.

## Non-goals

- Reimplement Pi's model loop, tool execution, provider support, or session format.
- Treat pi-subagents child transcripts as top-level user sessions by default.
- Depend on tmux for process lifetime or attachment.
- Write concurrently to one Pi session file from multiple processes.
- Support sessions or dashboards on another machine.
- Add a literal `pi agents` CLI subcommand; Pi extensions do not expose that API.

The package must not ship a weaker plugin-only mode that claims foreground work survives frontend death. Standard Pi-package operation requires a host startup hook that lets the installed extension select a daemon-owned backend before the model loop starts. A package-provided launcher may expose recovery and compatibility commands, but normal `/agents` use must not depend on a globally installed binary.

## User workflow

### Open and close

- `/agents` opens the dashboard from any Pi session that loads the globally configured package.
- Left opens the dashboard immediately when the main editor is clean and empty and its cursor is at the beginning.
- After prompt editing or editor-history navigation, the first Left press arms the gesture and a second Left within 500 ms opens the dashboard. Any other key cancels the armed gesture.
- Otherwise Left retains its normal cursor behavior.
- Opening the dashboard detaches the native frontend from the current session. It does not abort the current turn; streaming responses and tools continue in the daemon-owned backend.
- Ctrl+C or Escape from the dashboard list closes the agents UI and returns to the terminal.
- Left or Escape from an attached session detaches it and returns to the dashboard.
- Ctrl+C inside an attached session retains Pi's native interrupt behavior. It does not background the session or close the dashboard.
- Closing the agents UI never signals an agent process.

### Launch

- The dashboard contains a persistent `describe a task for a new session` composer.
- `n` or Tab focuses the composer. Enter launches the entered task in a detached background process.
- A new agent defaults to an isolated Git worktree based on the Pi session that opened the dashboard.
- The launch form can change working directory, isolation mode, model, thinking level, and display name. Defaults inherit from the originating Pi session where available.
- `Worktree` is the default isolation mode in a Git repository. `Shared directory` is available when the launch request explicitly asks to work in the current directory and the user confirms the concurrent-write warning.
- Outside a Git repository, the launch form uses the requested directory and warns before starting a second writable agent there.
- Each launch receives its own Pi session, as if the user were running `pi` from the terminal.

### Navigate and talk

- Up/Down move the selected row; PageUp/PageDown move by a page; Home/End jump to the first or last row.
- Enter or Right attaches the native Pi interface to the selected session. It does not expand row metadata.
- The attached view preserves Pi's transcript, editor, commands, extension UI, tool rendering, images, keybindings, and pending input requests.
- Sending text to a working agent queues a durable follow-up by default. A separate Steer action sends an interrupting steering message at Pi's next safe boundary.
- Sending text to an inactive saved session starts a new detached worker against the same session file, then delivers the prompt.
- Left or Escape detaches the attached session and returns to the dashboard. The selected agent continues running.
- `i` toggles a Jobwatch-style metadata panel for the selected row.

### Stop and delete

- Ctrl+X on a live agent opens a confirmation prompt to stop it.
- Stop sends a graceful abort/shutdown request, waits 5,000 ms, sends SIGTERM, waits another 5,000 ms, then sends SIGKILL if the process remains alive.
- Stop targets the selected process group only.
- After that agent becomes inactive, pressing Ctrl+X again opens a separate deletion confirmation. Ctrl+X on an already inactive session opens the deletion confirmation immediately.
- Deletion uses Pi's normal trash behavior when available rather than unlinking permanently.
- Deleting a session never deletes a worktree that contains uncommitted changes or unpushed commits. Worktree cleanup is a separate confirmed action.

## Interface design

The dashboard uses Pi TUI components and raw terminal rendering where needed. It does not import Textual, but follows Jobwatch's layout and interaction model.

### Visual language

- Pure black main background.
- Sky-blue title and information bars.
- Slightly elevated near-black summary and detail surfaces.
- Cyan session IDs and links.
- Green for working, amber for waiting or blocked, rose for failed, and muted gray for completed or inactive.
- Dark-gray full-row selection highlight.
- Rounded sky-blue borders around summary and detail panels.
- Dense single-line rows with fixed columns and truncation rather than wrapped table cells.

### List layout

```text
 pi agents
╭──────────────────────────────────────────────────────────────────────────╮
│ Working 3   Ready 2   Failed 1   Sessions 48   Processes 5              │
╰──────────────────────────────────────────────────────────────────────────╯
 [Live] 6/48 sessions | sort:age↓ | no filters
  ID        STATE    AGE     MODEL         PROJECT              ACTIVITY
▶ a31f92c1  WORKING  3m      gpt-5.6       evolutionaryscale    bash: pytest …
▶ 3b10ed87  READY    12m     claude-opus   es-notebooks         Which run …
▶ f21a7740  FAILED   1h      gpt-5.6       projects             provider 429 …

────────────────────────────────────────────────────────────────────────────
❯ describe a task for a new session
────────────────────────────────────────────────────────────────────────────
 ↑↓ nav  Enter/→ open  i info  n new  / search  v view  ^X stop/delete  ? help
```

### Columns

- **ID:** short stable session ID; cyan.
- **STATE:** task state used for filtering and color.
- **AGE:** time since the latest meaningful event.
- **MODEL:** active provider/model, truncated to the available width.
- **PROJECT:** working-directory basename, with the full path in details.
- **ACTIVITY:** current tool, blocked request, last assistant preview, or terminal error.

Task state, process state, outcome, and activity are separate. Task state answers what attention the session needs. Process state reports whether a process can execute work. Outcome records the latest successful result. Activity explains what the session is doing or last did. The default table keeps one dense STATE column and a liveness glyph; the metadata panel shows all four fields.

### Views and filters

- `v` cycles Live, Done, and All. Done contains successful sessions whose process state is SLEEPING or EXITED.
- `/` opens text search over name, path, model, task state, process state, outcome, and activity.
- `s` filters by state.
- `p` filters by project path.
- `c` clears filters.
- `t` toggles sort mode; numbered columns choose a sort key and repeat presses reverse direction.
- Ctrl+S toggles grouping by state or working directory, matching Claude's two useful dashboard organizations.
- `?` opens a centered two-column help panel modeled after Jobwatch.

### Attached session

Enter or Right replaces the dashboard list with Pi's native interactive session interface. The frontend attaches to the daemon-owned backend; it does not reconstruct a reduced transcript view and does not write the session JSONL file.

- The daemon replays persisted messages, live deltas, tool state, pending user-input requests, and extension UI requests.
- The frontend uses Pi's native transcript, editor, command handling, tool rendering, and extension surfaces.
- Per-session draft input and scroll position survive detachment where Pi exposes them.
- Input is delivered through the daemon's durable control protocol.
- The header shows session name, task state, process state, model, working directory, PID, and context usage when available.
- Left or Escape detaches and returns to the list. Ctrl+C keeps Pi's native interrupt behavior.
- Reattaching from another Pi terminal restores the same session without creating a second writer.

## Architecture

### Package layout

```text
pi-agents-dashboard/
├── package.json
├── pixi.toml
├── bin/
│   └── pi-agents-dashboard.mjs
├── extensions/
│   └── agents-dashboard/
│       ├── index.ts
│       ├── dashboard.ts
│       ├── native-session-bridge.ts
│       ├── registry-client.ts
│       ├── daemon-client.ts
│       ├── launcher.ts
│       ├── session-index.ts
│       ├── state.ts
│       └── *.test.ts
├── runtime/
│   ├── daemon.mjs
│   ├── worker.mjs
│   ├── frontend-client.mjs
│   └── rpc-client.mjs
└── docs/superpowers/specs/
```

The daemon and worker runtime are plain JavaScript so detached Node processes can execute them without a TypeScript loader. Pi-owned packages remain peer dependencies rather than bundled copies.

### Installation

The npm package is a self-contained Pi package. It declares its extension in `package.json` and supports the same installation paths as other Pi packages:

```bash
pi install npm:pi-agents-dashboard
pi install /absolute/path/to/pi-agents-dashboard
```

The npm-published package includes the extension, daemon, worker runtime, and optional CLI. The extension resolves runtime entrypoints relative to its own package root and starts or connects to the local daemon without relying on `pi-agents-dashboard` being on `PATH`.

`npm install -g pi-agents-dashboard` is also supported for users who want the standalone status and recovery CLI. Global npm installation alone does not register a Pi package; `pi-agents-dashboard install` registers its canonical package root through `pi install`. The package uses no npm lifecycle scripts and remains installable with `--ignore-scripts`.

Installation, daemon execution, workers, sockets, state, and tests remain local to the current machine. The first release supports the current Linux host and fails closed when daemon-owned startup or native attachment is unavailable. Tests run through Pixi and do not use SLURM.

### Global extension

Every Pi frontend that loads the package registers:

- `/agents`;
- Claude-style Left behavior for a clean empty editor and guarded double-Left after editing or history navigation;
- attachment and detachment handlers for the native Pi session interface;
- a client connection to the shared daemon;
- package-relative daemon discovery and local autostart;
- shutdown cleanup that releases only the frontend connection.

The extension must compose with an existing custom editor rather than replace its behavior. It intercepts only the defined empty-editor Left gesture. Frontend shutdown does not change worker ownership or session state.

### Registry

Runtime state lives beneath one machine-local, operating-system-user dashboard state directory rather than one effective Pi configuration root:

```text
<PER_USER_DASHBOARD_STATE_DIR>/
├── daemon/pid.json
├── daemon/control.sock
├── daemon/lifecycle.lock
├── sessions/<session-id>.json
├── queue/<session-id>.jsonl
├── runs/<run-id>/stdout.jsonl
├── runs/<run-id>/stderr.log
└── index/
```

Each session record identifies its effective Pi configuration root. The one daemon can therefore span multiple roots without mixing their worker configuration.

- Directories are mode `0700`; files and sockets are user-only.
- Registry updates use write-to-temp plus atomic rename.
- Each session record includes session ID/file, worker PID and process start identity, cwd, worktree and branch metadata, model, name, task state, process state, outcome, activity, timestamps, ownership type, and run paths.
- The daemon is the only registry writer. It holds a lifecycle lock while starting, restarting, or stopping.
- Heartbeats update while a worker is alive. A PID plus operating-system process start time prevents PID-reuse mistakes.
- Clients treat stale heartbeats as suspect and ask the daemon to verify liveness before showing a process as active.

### Shared daemon

One operating-system-user daemon owns all dashboard-managed session backends on the machine across every effective Pi configuration root. It starts before a daemon-backed Pi agent loop, exposes one user-only Unix control socket, and remains independent of terminal and dashboard lifetimes. Daemon state, journals, registry records, event cursors, and worker identity records are durable. After restart, the daemon recovers and reconciles surviving workers before accepting mutations.

The daemon:

1. serializes daemon start, restart, and stop with a lifecycle lock;
2. owns the session registry, durable command queues, and worker process groups;
3. starts and resumes Pi RPC workers with the selected session, cwd, isolation, model, thinking level, and name;
4. translates Pi RPC events into task state, process state, outcome, and activity;
5. acknowledges queued commands only after durable acceptance and records completion separately;
6. streams session events to any attached frontend and replays missed events after reconnection;
7. surfaces pending Pi and extension UI requests without auto-denying them when no frontend is attached;
8. verifies worker identity before sending a signal or transferring ownership.

The package must connect the visible Pi interface to the daemon-owned backend before the model loop starts. Package startup performs a compatibility check. A supported Pi host exposes the startup hook and native attachment adapter required by the standard installed extension. On an unsupported host, `/agents`, `pi-agents-dashboard run`, and `pi-agents-dashboard doctor` report the missing capability; they do not silently fall back to a local foreground loop while claiming that the turn survives frontend exit.

### Workers

The daemon starts each `runtime/worker.mjs` in a new process group with disconnected terminal streams and file-backed logs. The worker starts Pi in RPC mode and owns that session's stdin/stdout protocol. The daemon remains the only control endpoint visible to frontends.

A later reply to an inactive session asks the daemon to acquire ownership, start a new worker with `--session <path>`, and deliver the queued prompt. A settled worker is retained for 15 minutes (900,000 ms) before it exits or sleeps; task state remains READY while process state records LIVE, SLEEPING, or EXITED. Sessions remain available globally.

Workers use `setsid` or detached process groups, ignored stdin, and file-backed output so they survive shell and SSH teardown. The daemon reports a launch as accepted only after the worker acknowledges registry creation.

### Foreground sessions and native attachment

A daemon-backed Pi terminal is a frontend, not the owner of agent execution. Opening the dashboard detaches that frontend from the current backend. Enter or Right attaches the same native Pi interface to another backend.

Provider streams and tool executions continue in the daemon-owned worker while no frontend is attached. Exiting the frontend, closing the dashboard, losing SSH, or attaching from another Pi terminal does not migrate or restart that work. The worker remains the sole writer to its session file. At most one frontend may compose messages or answer pending requests for an attached session; additional attached frontends are read-only observers.

A Pi process started before package installation may appear as an imported saved session after it settles, but it cannot claim live-detachment guarantees. `/agents` identifies that limitation rather than presenting it as a fully managed live session. All new Pi sessions in a supported installation start with daemon ownership.

### Control protocol

The daemon control socket uses JSON Lines with client-generated request IDs and daemon-generated event sequence IDs. Supported operations are:

- `get_state`
- `attach`
- `detach`
- `prompt`
- `steer`
- `follow_up`
- `interrupt`
- `stop`
- `delete`
- `ui_response`
- `subscribe`
- `ack`

Prompt, follow-up, steer, stop, delete, and UI-response requests are durably journaled before acceptance is acknowledged. Repeated request IDs are idempotent. Reconnecting clients resume from their last acknowledged event sequence. The protocol records accepted, delivery-attempted, worker-acknowledged, and completed states separately. An accepted request remains recoverable after a daemon crash. If delivery is ambiguous, the daemon marks it `DELIVERY_UNKNOWN` and exposes explicit Retry at risk and Abandon actions. It never retries automatically.

The protocol is local-user only. The server validates message size, command shape, session identity, and peer ownership where the platform exposes peer credentials. Unknown commands fail closed.

### Session index

`SessionManager.listAll()` provides saved top-level sessions across working directories. The daemon merges these with its live registry by canonical session file and session ID, then serves one ordered snapshot to every dashboard client.

Internal subagent artifacts, copied transcript exports, and nested run transcripts are hidden from the default top-level list. They can be added later as an explicit child-session view.

The dashboard avoids rescanning every session file on every animation frame. It loads the index on open, watches the small registry directory for live updates, and refreshes saved-session metadata every 5,000 ms or on explicit refresh. All view has no completed-history time window: saved sessions remain visible until confirmed deletion, and active sessions follow the confirmed stop-then-delete lifecycle.

## State model

The registry tracks three independent dimensions.

Task state:

- **WORKING:** agent, compaction, retry, or tool execution is active.
- **WAITING:** a Pi or extension UI request needs a user response.
- **READY:** the latest turn settled and the session can accept another message.
- **FAILED:** the latest turn ended with a terminal error.
- **STOPPED:** the user explicitly stopped the latest run.

Process state:

- **LIVE:** a worker owns the session and can execute work.
- **SLEEPING:** the daemon owns the session, but no worker is consuming compute.
- **EXITED:** no process owns the saved session.
- **STALE:** registry ownership is inconsistent or a worker disappeared without clean shutdown.

Outcome:

- **NONE:** the latest turn has no successful result yet.
- **COMPLETED:** the latest turn settled successfully.
- **READY_FOR_REVIEW:** the latest turn produced a reviewable change or artifact.

A session can therefore be `READY + LIVE`, `READY + SLEEPING`, or `READY + EXITED` without inventing a separate DONE task state. Activity is updated from the most specific signal: blocking request, tool execution, streaming assistant text, final assistant preview, then process error.

## Concurrency and ownership

- The daemon is the single registry and lifecycle writer.
- Each live session has one worker process that writes its Pi session file.
- Registry ownership is acquired atomically before a worker opens a saved session for writing.
- Sending a message to an inactive session first journals the message, acquires ownership, starts the worker, waits for readiness, then delivers it.
- If another live owner appears, launch fails with a visible conflict instead of opening a second writer.
- Agent launches are independent and concurrent. The daemon does not serialize unrelated launches.
- Git-backed launches use separate worktrees by default.
- Multiple sessions may share one working directory only after the launch request explicitly selects Shared directory and the user confirms the concurrent-write warning. This does not relax single-writer ownership of each session file.
- `workers.maxLive` accepts `null` for unlimited workers or a positive integer cap. The first-release default is `null` (unlimited); zero, negative, and fractional values are invalid.

## Failure handling

- **Dashboard closes:** no worker action.
- **Pi frontend exits:** daemon-owned workers continue.
- **SSH disconnects:** daemon-owned workers continue; logs, queues, and registry remain.
- **Daemon crashes:** workers reconnect to the restarted daemon; it reconciles durable process identities, registry records, command acknowledgements, and event cursors before accepting mutations.
- **Worker crashes:** process identity becomes stale; the dashboard marks the process STALE and preserves logs and session data.
- **Pi child crashes:** the daemon records exit code and stderr, marks the task FAILED, and marks the process EXITED.
- **Socket disappears:** clients verify daemon PID and process-start identity, then reconnect or report daemon failure.
- **Session ownership conflict:** reject the second writer and show both owner records.
- **Malformed session file:** show the task as FAILED with a parse error; do not rewrite it.
- **Blocked extension UI request:** mark the task WAITING, retain the request while detached, and replay it after attachment.
- **Dashboard renderer error:** close the custom UI and notify the host frontend; never stop workers as cleanup for a rendering failure.
- **Worktree cleanup conflict:** retain any worktree with uncommitted changes or unpushed commits and show the exact reason cleanup was refused.

## Security

- Runtime directories, registry files, sockets, and logs are private to the user.
- Control messages never accept arbitrary executable paths or shell command strings.
- Worker launch arguments are passed as an argv array with `shell: false`.
- Working directories and session paths are canonicalized before ownership checks.
- Destructive Stop and Delete actions require confirmation and target one selected ID.
- The package never sends `kill` by username, process name, or broad pattern.
- Existing project trust and Pi configuration remain authoritative for each launched worker.
- Shared-directory mode requires an explicit per-launch confirmation when another writable session uses that directory.
- The daemon accepts local connections only from the same operating-system user. Cross-machine control is outside this design.

## Performance

- Rendering uses a virtualized visible-row cache modeled after Jobwatch's single-list renderer.
- Registry events invalidate only affected rows.
- Session transcript reads use stable entry IDs as cursors where possible.
- Live text deltas are coalesced before rendering to avoid repainting for every token.
- Every rendered line is ANSI-width checked and truncated to the terminal width.
- Timers and watchers are disposed when the dashboard closes or the extension shuts down.

## Testing

Development follows test-driven implementation. Tests live beside their source modules.

### Unit tests

- task-state, process-state, outcome, and activity transitions;
- single-Left behavior on a clean empty editor, guarded double-Left after editing or history navigation, and editor passthrough;
- registry atomic writes, stale detection, and PID-reuse checks;
- durable request journaling, idempotent request IDs, acknowledgements, and event replay;
- session-index filtering and live/saved merge behavior;
- ownership acquisition and conflict rejection;
- JSONL framing with split UTF-8 chunks and malformed records;
- row truncation, column sizing, selection, filtering, and sorting;
- Ctrl+X stop/delete sequencing, confirmation, escalation, and exact process-group targeting.

### Integration tests

- start two workers through one daemon and verify distinct process IDs and concurrent WORKING task states;
- close the dashboard and verify workers remain alive;
- terminate a Pi frontend and verify its daemon-owned worker remains alive;
- reconnect from another Pi terminal and attach the native interface to the same live session;
- resume a completed saved session and verify the same session ID and file are used;
- send durable follow-up and steer messages, crash the client or daemon at each acknowledgement boundary, and verify replay or an explicit `DELIVERY_UNKNOWN` state;
- simulate a blocking extension UI request, detach, reconnect, and answer it from the attached session;
- crash a worker and verify STALE or FAILED recovery without session corruption;
- verify one-writer enforcement under simultaneous resume attempts;
- launch two Git-backed agents and verify separate worktrees by default;
- select Shared directory, confirm the warning, and verify both sessions use the requested cwd;
- refuse worktree cleanup when uncommitted changes or unpushed commits exist.

### TUI tests

- snapshot representative Jobwatch-style screens at narrow and wide terminal widths;
- verify Enter/Right attaches the native session and Left/Escape returns to the dashboard;
- verify Ctrl+C closes the dashboard list without emitting stop or interrupt;
- verify Ctrl+C in an attached session forwards Pi's native interrupt without closing the agents UI;
- verify Ctrl+X stops a live selection and a later Ctrl+X deletes the inactive selection only after confirmation;
- verify navigation and composer focus do not consume each other's keys;
- run an end-to-end tmux harness that launches daemon-backed Pi, opens `/agents`, starts an agent, exits the frontend, reconnects from another cwd, and observes the same live run.

The package will include a Pixi environment and a `pixi run test` task for deterministic local verification. Unit, integration, package-installation, process-lifecycle, and tmux tests run locally; the test workflow does not submit SLURM jobs.

Package-installation tests cover local-path Pi installation, a packed npm tarball, global npm installation into a disposable prefix, package-relative runtime discovery without a global CLI, `pi install npm:pi-agents-dashboard` command construction, and `pi remove` cleanup without deleting dashboard state.

## Reviewed first-release configuration

Configuration is a complete, schema-versioned JSON document. Readers reject unknown keys, unsupported schema versions, non-positive or non-integer millisecond values, and invalid limits. Writers validate and serialize the complete document before replacing the prior file with a write-to-temp plus atomic rename.

| Field | Reviewed default |
|---|---:|
| `schemaVersion` | `1` |
| `workers.maxLive` | `null` (unlimited) |
| `workers.idleRetentionMs` | `900000` |
| `history.completedWindowHours` | `null` (all saved history) |
| `history.indexRefreshMs` | `5000` |
| `daemon.heartbeatMs` | `2000` |
| `daemon.staleAfterMs` | `10000` |
| `daemon.startTimeoutMs` | `15000` |
| `stop.gracefulMs` | `5000` |
| `stop.terminateMs` | `5000` |
