# pi-dashboard design

**Status:** Draft for written review
**Date:** 2026-08-25
**Package and executable:** `pi-dashboard`

## Document responsibility

This file is the authoritative product contract. It owns user-visible behavior, architecture, invariants, configuration, and acceptance criteria. The execution plan owns implementation order, file boundaries, and commands. The task list tracks status.

This revision supersedes native Pi attachment and the blocked native-attachment task. The execution plan will replace that work with the standalone implementation sequence after this design is approved.

## `pi-dashboard` is the canonical standalone app

**Decision:** Build a standalone, Jobwatch-style terminal app that launches installed Pi processes in remote procedure call (RPC) mode and renders its own interactive session viewer.

**Canonical command:**

```bash
pi-dashboard
```

**Current state:** The daemon, durable control protocol, registry, process supervision, dashboard list, and destructive workflows exist under the former `pi-agents-dashboard` name. Native attachment is not part of the replacement design.

**Next implementation:** Rename the product, add the standalone shell and migration, launch the installed `pi --mode rpc` executable, normalize viewer data, build the interactive viewer, and run standalone acceptance.

### Terms

- **App:** the standalone `pi-dashboard` terminal user interface (TUI).
- **List:** the Jobwatch-style home screen that shows sessions and launches work.
- **Viewer:** the full-screen interactive view for one session.
- **Daemon:** the per-user background process that owns durable state and process supervision.
- **Supervisor:** the small package process that owns one Pi child's RPC pipes and reconnects to the daemon.
- **Pi child:** the installed `pi` executable running with `--mode rpc`.
- **Session:** durable Pi conversation data and dashboard metadata.
- **Run:** one active Pi child execution for a session.

## First-release scope

### Goals

1. Open a machine-wide dashboard by running `pi-dashboard` from any working directory.
2. Launch concurrent sessions through the installed `pi --mode rpc` executable.
3. Keep runs alive after the app, terminal, or secure shell (SSH) connection closes.
4. Show live and saved sessions across working directories in one dense list.
5. Open a full-screen interactive viewer with transcript, composition, tools, pending responses, and session controls.
6. Recover registry, commands, normalized viewer events, process identities, and cursor state after a daemon restart.
7. Install as a normal npm executable from a registry or local path.
8. Detect required Pi capabilities without pinning support to a Pi version string.
9. Migrate prior `pi-agents-dashboard` state without creating a second daemon or session writer.

### Non-goals

- Reimplement Pi's model loop, tool execution, provider support, or canonical session writer.
- Import private Pi modules or deep `dist/` paths.
- Match Pi's native `InteractiveMode` or extension surfaces.
- Render image or file contents in the first standalone release.
- Depend on tmux for production process lifetime.
- Support cross-machine dashboards or control.
- Treat internal subagent transcripts as top-level sessions by default.
- Add a `pi agents` subcommand.
- Add custom trash retention or purge behavior without an approved public Pi trash capability.

## The list and viewer form one Jobwatch-style workflow

### Startup and exit

Running `pi-dashboard` connects to or starts the per-user daemon, performs state migration when needed, and opens the list. It does not restore the last viewer automatically.

Closing the app disconnects only that frontend. It does not stop the daemon or signal a supervisor or Pi child.

### Launch

The list contains a persistent `describe a task for a new session` composer. `n` or Tab focuses it. Enter submits a launch request.

Standalone launch defaults are:

- working directory: the directory where `pi-dashboard` started;
- isolation: a managed Git worktree when the directory is in a Git repository;
- model and thinking level: omitted unless the user selects them, allowing the installed Pi defaults to apply;
- display name: optional;
- Pi configuration: derived by the daemon from the selected executable, environment, and working directory. Clients cannot supply a trusted Pi configuration root.

Shared-directory mode requires the exact canonical directory and confirmation of concurrent writes. Outside a Git repository, launching another writable session in the same directory requires the same warning and confirmation.

The daemon acquires session ownership before the Pi child can open the canonical session file.

### Navigate the list

- Up and Down move the selection.
- PageUp and PageDown move by a page.
- Home and End jump to the first or last row.
- Enter or Right opens the selected session in the viewer.
- `/` edits search over name, path, model, state, outcome, and activity.
- `v` cycles Live, Done, and All.
- State, process, outcome, activity, project, sort, and grouping controls are accessible from the keyboard and shown in the help panel.
- `i` toggles metadata for the selected row.
- `?` opens help.
- Ctrl+X starts the confirmed Stop or Delete workflow for the selected revision.

Selection is stored by canonical session ID. Inserts, removals, filtering, sorting, and terminal resize do not silently move the action target to another session.

### Open and return from the viewer

Enter or Right replaces the list with the full-screen viewer.

The return gesture is:

| Viewer editor state | Left | Escape |
|---|---|---|
| Clean, empty, no history navigation | Return to the list | Return to the list |
| Edited or history navigation used | Preserve editor behavior and arm Left for 500 ms | Preserve editor behavior and arm Escape for 500 ms |
| Same key pressed again within 500 ms | Return to the list | Return to the list |
| Different input or timeout | Cancel the armed gesture | Cancel the armed gesture |

The second key must match the first. Focused overlays consume Escape before the viewer return gesture. Ctrl+C in the viewer sends an interrupt command to the selected session. Ctrl+C in the list closes the app without signaling a run.

### The viewer is fully interactive

The viewer uses public `pi-tui` primitives and a public editor component. Its layout and session controller belong to `pi-dashboard`.

| Surface | First-release behavior |
|---|---|
| Transcript | Render normalized user, assistant, system, and activity entries with stable IDs. Stream assistant deltas into the current entry. |
| Composer | Send `prompt` while idle and `follow_up` while working. Preserve a per-session draft and history. |
| Steer | Send an explicit `steer` command at Pi's next supported boundary. |
| Interrupt | Ctrl+C sends `interrupt` and leaves the viewer open. |
| Tools | Show tool name, state, bounded arguments, streaming activity, result, error, and duration. Calls and results are collapsible. |
| Pending UI | Render supported confirm, select, input, and editor requests as focused overlays. Send `ui_response` through the daemon. |
| Model status | Show provider, model, and changes reported by Pi. |
| Thinking status | Show the active thinking level and changes reported by Pi. |
| Images and files | Preserve normalized metadata and render a placeholder with safe path, media type, dimensions, or size when present. |
| Unknown Pi events | Render a bounded generic activity entry and retain the raw frame only in diagnostics. |

At most one frontend holds the composer role for a session. Other frontends can observe, search, scroll, and inspect tools. They cannot submit text, steer, interrupt, answer pending requests, stop, or delete.

### Stop, delete, and cleanup

Ctrl+X on a live session opens Stop confirmation. Confirmation is bound to session ID, revision, process state, ownership, and action. Stop requests graceful shutdown, waits 5,000 ms, requests termination, waits 5,000 ms, then requests kill if the exact process group remains. A request completes only after terminal process state is observed.

Ctrl+X on an inactive, unowned session opens Delete confirmation. Delete requires the confirmed revision and uses Pi's public trash behavior when available. Without that capability it returns `TRASH_CAPABILITY_UNAVAILABLE`. Delete never unlinks a session file directly and never removes a worktree.

Worktree cleanup is a separate full-ID confirmed action. It refuses live ownership, dirty changes, unpushed commits, replaced paths, or failed identity checks.

Ambiguous Stop or Delete delivery becomes `DELIVERY_UNKNOWN`. Only explicit `retry_at_risk` or `abandon` resolution can change that command state.

## The visual design follows Jobwatch

### Visual language

- Pure black main background.
- Sky-blue title and information bars.
- Near-black summary and detail surfaces.
- Cyan session IDs and links.
- Green for working, amber for waiting, rose for failed, and muted gray for inactive.
- Dark-gray full-row selection.
- Rounded sky-blue borders around summary and detail panels.
- Dense single-line rows with fixed columns and truncation.

### List layout

```text
 pi-dashboard
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

The list shows ID, task state, age, model, project, and activity. A liveness glyph distinguishes process state. The metadata panel shows task state, process state, outcome, activity, full working directory, process identities, isolation, and run paths.

### Viewer layout

The viewer has a one-line session header, a virtualized transcript, focused overlays, an editor, and a compact status footer. The header shows name, task state, process state, model, thinking level, working directory, and composer role. Tool blocks default to collapsed after completion and remain expanded while active or failed.

Rendering truncates every line to terminal width. Narrow layouts hide optional columns before clipping required state or selection information.

## One daemon owns state and supervised Pi RPC children

### Process flow

1. The app sends a launch or resume request to the daemon.
2. The daemon journals acceptance, selects the configured Pi executable, acquires ownership, and starts a detached supervisor process group.
3. The supervisor reports its process ID (PID), process start identity, process-group ID, lease ID, and generation before any session file opens.
4. After the daemon durably binds ownership, it activates the supervisor.
5. The supervisor launches the installed executable with structured arguments equivalent to `pi --mode rpc --session <canonical-session-file>`. It uses `shell: false`, ignored terminal input, owned RPC pipes, and file-backed diagnostics.
6. The supervisor reports the Pi child's PID, start identity, and process-group membership. The daemon validates and records both identities.
7. RPC readiness and normalized state must succeed before the launch is reported ready.

The supervisor remains the process-group leader and owns the Pi child's standard input, standard output, and standard error. It reconnects to a restarted daemon with bounded backoff. This wrapper lets the Pi child survive daemon transport loss while preserving bind-before-open ordering.

New runs use the currently configured Pi executable. Existing runs keep the executable and process identities they started with. A session record stores executable realpath, reported Pi version, detected capabilities, RPC adapter version, supervisor identity, and Pi-child identity.

### Executable discovery and capability detection

Discovery precedence is:

1. `--pi-bin <path>` for the current app invocation;
2. validated dashboard configuration;
3. `pi` resolved from `PATH`.

The daemon canonicalizes the executable path and rejects non-files, non-executable files, symlinks that escape approved resolution, and paths changed between validation and spawn.

Support depends on capabilities, not a Pi version allowlist. Before the first launch for an executable identity, a bounded probe verifies:

- the executable accepts `--mode rpc`;
- RPC output uses fatal UTF-8 JSON Lines framing;
- `get_state` returns the required state shape without a model request;
- prompt, follow-up, steer, interrupt, and supported UI-response command shapes are advertised or accepted by the public RPC contract;
- required live events can be normalized;
- session resume accepts the canonical session path.

The probe performs no model inference. Its result is cached by executable realpath plus file identity and invalidated when that identity changes.

A missing required capability returns `UNSUPPORTED_PI_CAPABILITY` with the missing capability names. Optional image or file rendering capabilities do not block launch because the first release uses placeholders.

### Daemon and frontend lifetimes

The per-user daemon spans working directories and Pi configuration directories. It owns the registry, command journal, normalized event stores, frontend cursors, attachment roles, process supervision, and lifecycle locks.

App closure, terminal closure, and SSH loss close only frontend transport. Daemon stop closes frontend and supervisor transports but does not signal Pi process groups unless the user explicitly requests `--stop-workers --yes`.

After restart, the daemon reconciles durable state and exact process identities before accepting mutations. Surviving supervisors reconnect and reauthenticate. Ownership conflicts, ambiguous identities, or mismatched generations fail closed.

## A normalized viewer protocol isolates the app from Pi event changes

The viewer never consumes raw Pi RPC frames directly. The daemon adapter combines canonical session history with live RPC events and emits a separately versioned viewer contract.

### Snapshot

A viewer snapshot contains:

- protocol version, session ID, registry revision, daemon epoch, and latest sequence cursor;
- executable, Pi version, adapter version, and capability report;
- task state, process state, outcome, activity, model, and thinking state;
- normalized transcript items in stable order;
- active and completed tool records;
- pending UI requests;
- composer or observer role;
- image and file placeholder metadata;
- recoverable compatibility or parse errors.

### Events

Each event has viewer protocol version, session ID, stable event ID, sequence cursor, timestamp, and one payload from this first-release set:

- `user_message`
- `assistant_delta`
- `assistant_message`
- `system_message`
- `tool_started`
- `tool_updated`
- `tool_finished`
- `turn_state`
- `pending_ui_request`
- `ui_resolved`
- `model_state`
- `thinking_state`
- `activity`
- `image_placeholder`
- `file_placeholder`
- `unknown_pi_event`

The daemon persists a normalized event before broadcasting it. A frontend processes and renders the event, persists its cursor, then acknowledges it. Reconnect requests events after the last acknowledged cursor. Cursor epoch mismatch requests a fresh snapshot. Duplicate stable event IDs are idempotent.

Historical session entries and live RPC events pass through one adapter. Stable Pi entry IDs are retained when present. Otherwise the adapter creates a deterministic ID from session identity, entry position, event kind, and bounded canonical content. History/live overlap is deduplicated before publication.

### Raw diagnostics stay bounded

Raw Pi RPC diagnostics are not viewer state and are not replayed to normal frontends.

Per run, raw RPC diagnostics use four rotating 8 MiB segments, for a 32 MiB maximum. Pi stderr uses one rotating 8 MiB limit. Rotation removes the oldest complete segment and writes a truncation marker containing removed byte and record counts. A single record larger than its segment limit is replaced by a bounded metadata record with its original byte count and hash.

Diagnostic files are mode `0600` beneath mode `0700` directories. They may contain prompts, tool arguments, or provider errors and are available only to the local user through explicit diagnostic commands. The normalized transcript and canonical Pi session file are not truncated by diagnostic rotation.

## Durable commands remain separate from viewer events

The daemon control socket uses strict JSON Lines envelopes with protocol version, stable client ID, request ID, operation, and exact payload. Existing operations remain:

- state and subscription: `get_state`, `subscribe`, `ack`;
- lifecycle: `launch`, `attach`, `detach`, `stop`, `delete`;
- session control: `prompt`, `follow_up`, `steer`, `interrupt`, `ui_response`;
- ambiguity: `resolve_delivery`.

Viewer snapshot and event operations are added as a separate versioned read contract rather than exposing raw Pi events.

Prompt, follow-up, steer, interrupt, UI response, Stop, and Delete are journaled before their first irreversible delivery. Stop and Delete require the confirmed session revision. Repeated client and request IDs are idempotent. Conflicting payload reuse fails closed.

Command stages remain independent:

| Stage | Meaning |
|---|---|
| `ACCEPTED` | The exact request is durable. |
| `DELIVERY_ATTEMPTED` | Irreversible delivery may have started. |
| `WORKER_ACKNOWLEDGED` | The supervisor or Pi child returned an explicit acknowledgement. |
| `COMPLETED` | The terminal result is durable. |
| `FAILED` | A terminal refusal or error is durable. |
| `DELIVERY_UNKNOWN` | Delivery may have occurred and requires explicit resolution. |

No timeout or reconnect automatically changes `DELIVERY_UNKNOWN`. Resolution targets the original client and request IDs with `retry_at_risk` or `abandon`.

The socket, token, framing limits, peer checks, persist-before-response rule, and monotonic frontend cursor rules remain private to the local user.

## State and ownership remain independent

### State dimensions

Task state:

- `WORKING`: agent, compaction, retry, or tool work is active.
- `WAITING`: a supported pending UI request needs a response.
- `READY`: the latest turn settled and another message can be sent.
- `FAILED`: the latest turn ended with a terminal error.
- `STOPPED`: the user explicitly stopped the latest run.

Process state:

- `LIVE`: a supervisor and Pi child own the session and can execute.
- `SLEEPING`: the daemon owns the session but no Pi child consumes compute.
- `EXITED`: no process owns the saved session.
- `STALE`: ownership and observed process identity disagree.

Outcome:

- `NONE`: no successful result is recorded for the latest turn.
- `COMPLETED`: the latest turn settled successfully.
- `READY_FOR_REVIEW`: the latest turn produced a reviewable change or artifact.

Activity records the most specific current signal: pending request, tool execution, assistant streaming, final assistant preview, process error, or compatibility error.

Completed sessions remain `READY`; process state distinguishes `LIVE`, `SLEEPING`, and `EXITED`.

### One writer owns each session

The daemon is the only registry writer. Every live session has one ownership lease with random lease ID and monotonic generation. Ownership is acquired before the Pi child opens the session file. Supervisor and Pi-child identities include PID, process start identity, and process-group ID.

Launch, resume, event mutation, Stop, Delete, and cleanup use the same per-session lifecycle serialization and the documented worktree-lock order. A second live owner fails with an ownership conflict. Independent sessions launch concurrently.

Git launches use isolated worktrees by default. Shared-directory mode does not relax session-file ownership. Cleanup requires authoritative late ownership reads and refuses dirty or unpushed work.

## Existing state migrates to `pi-dashboard`

Legacy state may exist beneath per-user runtime and state roots named `pi-agents-dashboard`. The new roots use `pi-dashboard`.

Migration follows this sequence:

1. Acquire migration locks for legacy and new roots in canonical path order.
2. Inspect legacy daemon PID, process start identity, socket, and lifecycle lock.
3. Refuse migration while a verified legacy daemon or mutable legacy supervisor is active. Report the exact blocking identities.
4. Validate legacy schema, owner, modes, canonical paths, registry records, journals, cursors, tokens, and file identities.
5. Refuse a non-empty destination unless it contains the same completed migration identity.
6. Stage migrated metadata and configuration under the new private root. Session files and worktrees retain their canonical paths and are not renamed.
7. Fsync staged files and directories, then atomically publish a migration manifest naming source identity, destination identity, schema conversion, and completion state.
8. Start and reconcile the new daemon before marking the new root canonical.
9. Preserve the legacy source until new-state validation and reconciliation complete. Mark it migrated rather than deleting it automatically.

An interrupted migration restarts from the manifest. PREPARED or staged work is validated before reuse. Identity mismatch, destination collision, malformed legacy data, or failed reconciliation leaves the legacy source unchanged and reports a typed migration error.

Legacy configuration schema version 1 converts to `pi-dashboard` schema version 2. Existing worker limits, timing values, history policy, and isolation records retain their reviewed values.

## Failures preserve recoverable state

| Failure | Behavior |
|---|---|
| App closes or terminal disconnects | Frontend transport closes. Daemon, supervisors, and Pi children continue. |
| Daemon crashes | Supervisors keep Pi RPC pipes open and reconnect. The daemon reconciles journals, cursors, registry records, and both process identities before mutations. |
| Supervisor crashes | The Pi child's process group is revalidated. The session becomes STALE unless terminal state is observed. |
| Pi child exits | Exit code and stderr are retained. Process state becomes EXITED after exact observation. Task state changes only from the recorded run result. |
| Pi RPC frame is malformed | That session's adapter closes the RPC stream, retains bounded diagnostics, and reports a typed protocol error. The daemon continues serving other sessions. |
| Required capability is missing | Launch fails with the missing capability names and no session writer starts. |
| Optional event is unknown | The adapter emits `unknown_pi_event`; other viewer state continues. |
| Viewer render or persistence fails | The frontend closes that viewer subscription and does not acknowledge the failed event. No process is signaled. |
| Ownership conflicts | The second mutation fails and both owner records remain available for diagnosis. |
| Session history is malformed | The viewer shows a parse error and the daemon does not rewrite the canonical session file. |
| Pending UI request has no frontend | The request remains WAITING and replays after a composer attaches. |
| Stop or Delete delivery is ambiguous | The command remains `DELIVERY_UNKNOWN` until explicit resolution. |
| Worktree cleanup conflicts | The worktree remains and the exact refusal is shown. |
| Diagnostic rotation occurs | Old raw segments are removed and a truncation marker is retained. Normalized and canonical history remain. |

## Security and locality

- Runtime and state directories are mode `0700`; tokens, registry files, journals, diagnostics, and logs are mode `0600`.
- Unix sockets accept only the same local user. Peer credentials are checked where the platform exposes them.
- The daemon accepts structured arguments and approved executable paths. It does not accept shell command strings.
- Every child spawn uses an argv array and `shell: false`.
- Working directories, executable paths, session files, and worktrees are canonicalized before ownership checks.
- Stop and Delete require exact full IDs, revisions, and confirmation.
- Signals target one verified process group. No command signals by username, process name, prefix, or pattern.
- Shared-directory mode requires per-launch confirmation.
- Raw diagnostics are local-user data and are not included in ordinary viewer snapshots, events, package output, or telemetry.
- Cross-machine control and browser access are outside this design.

## Performance remains bounded

- The list and transcript render only visible rows and blocks.
- Registry and normalized events invalidate affected sessions or transcript items.
- Assistant deltas are coalesced before repaint while preserving durable final entries.
- Every rendered line is ANSI-width checked and truncated to terminal width.
- Snapshot construction reads stable session entries incrementally and deduplicates history/live overlap.
- Raw RPC and stderr diagnostics use the approved rotating limits.
- Timers, watchers, render barriers, subscriptions, and editor wrappers are disposed on app or viewer close.

## Installation

Canonical installation is:

```bash
npm install -g pi-dashboard
pi-dashboard
```

Also supported:

```bash
npx pi-dashboard
pi-dashboard --pi-bin /absolute/path/to/pi
npm install /absolute/path/to/pi-dashboard
```

The package uses no npm lifecycle scripts and remains installable with `--ignore-scripts`. A global installation is sufficient because the standalone executable is canonical.

`pi install` is not a supported installation path. The package contains no Pi extension entry point.

The repository, package metadata, executable, visible UI, documentation, and new state roots use `pi-dashboard`. The private repository and local project directory are renamed during implementation. No npm publication occurs until standalone acceptance is approved.

## First-release configuration is explicit

Configuration uses schema version 2. Readers reject unknown keys, unsupported versions, invalid limits, and non-positive or non-integer timing values. Migration converts reviewed version 1 values before publication.

| Field | Default |
|---|---:|
| `schemaVersion` | `2` |
| `pi.executable` | `null` (discover from `PATH`) |
| `workers.maxLive` | `null` (unlimited) |
| `workers.idleRetentionMs` | `900000` |
| `history.completedWindowHours` | `null` (all saved history) |
| `history.indexRefreshMs` | `5000` |
| `daemon.heartbeatMs` | `2000` |
| `daemon.staleAfterMs` | `10000` |
| `daemon.startTimeoutMs` | `15000` |
| `stop.gracefulMs` | `5000` |
| `stop.terminateMs` | `5000` |
| `diagnostics.rpcSegmentBytes` | `8388608` |
| `diagnostics.rpcSegments` | `4` |
| `diagnostics.stderrBytes` | `8388608` |

Command protocol version and normalized viewer protocol version are independent of configuration schema version.

## Acceptance criteria prove the standalone workflow

### Unit acceptance

- Capability probes classify required, optional, unknown, and malformed Pi RPC behavior without model calls.
- Normalization fixtures cover every first-release viewer event, history/live deduplication, stable IDs, cursor replay, and unknown events.
- Raw RPC and stderr rotation enforce 32 MiB and 8 MiB limits with truncation markers.
- List and transcript virtualization preserve session and item selection over updates and resize.
- Viewer input covers prompt, follow-up, steer, interrupt, pending UI responses, composer arbitration, and the 500 ms return gesture.
- Task state, process state, outcome, and activity remain independent.
- Command journals preserve idempotency and explicit `DELIVERY_UNKNOWN` resolution.
- Migration validates locks, identities, permissions, collisions, interrupted stages, and idempotent restart.
- Stop, Delete, and cleanup retain exact confirmation and identity checks.

### Integration acceptance

- A fake installed executable receives exact structured `--mode rpc` launch arguments and exposes bounded RPC fixtures.
- Two Pi children run concurrently with distinct supervisor, child, and process-group identities.
- Closing the app leaves both runs alive. Restarting the daemon reconnects both supervisors and resumes normalized event delivery.
- New runs use an updated Pi executable identity while existing runs continue under the prior identity.
- Required capability failure starts no writer. Unknown optional events become generic activity.
- Snapshot plus replay reconstructs transcript, tools, pending UI requests, model state, and thinking state after frontend and daemon crashes.
- Prompt, follow-up, steer, interrupt, and UI response preserve acknowledgement boundaries and ambiguity semantics.
- Session resume reuses the canonical session ID and file with one writer.
- Worktree and shared-directory rules remain unchanged.
- State migration refuses a live legacy daemon, survives interruption, preserves legacy source on failure, and publishes one reconciled new daemon.

### Terminal acceptance

- Snapshot tests cover the Jobwatch-style list and viewer at `160x40`, `120x32`, `80x24`, `55x16`, and `40x10`.
- Enter and Right open the viewer. Left and Escape follow the clean and 500 ms dirty/history return table.
- Ctrl+C closes the list and interrupts a viewed session.
- Search, filters, sorting, grouping, metadata, composer focus, tool expansion, overlays, and observer restrictions remain keyboard accessible.
- Image and file events render placeholders with safe metadata.
- Ctrl+X stops a live selection and later offers Delete only after terminal state and confirmation.

### Package acceptance

- Packed and local-path npm installs expose `pi-dashboard` without lifecycle scripts.
- `npx pi-dashboard` and a disposable global npm prefix resolve package-relative runtime files.
- Package contents exclude private state, diagnostics, worktrees, sessions, `.superpowers`, `.vscode`, and development caches.
- The app locates the configured or `PATH` Pi executable without importing private Pi modules.
- Native attachment, a Pi fork, and a Pi version allowlist are absent from release gates.
