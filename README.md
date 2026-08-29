# pi-agents

A machine-local standalone terminal dashboard for concurrent [Pi](https://github.com/badlogic/pi-mono) sessions.

## Install and start

Install the standalone executable globally, run it through npm, or install an absolute local checkout:

```bash
npm install -g pi-agents
pi-agents

npx pi-agents
npm install /absolute/path/to/pi-agents
```

The package has no npm lifecycle scripts and no Pi extension manifest. `pi install` is not supported. A global installation is sufficient; `pi-agents` resolves its runtime files relative to the installed package, not the current working directory.

Running `pi-agents` with no arguments connects to or starts the per-user daemon and opens the machine-wide session list. The process working directory becomes the default directory for a new launch. The app does not reopen the last viewer automatically.

Pi executable discovery uses this precedence:

1. `pi-agents --pi-bin /absolute/path/to/pi`
2. the validated `pi.executable` dashboard configuration
3. `pi` found on `PATH`

The override must be an absolute executable path. Discovery and launch use structured arguments with no shell command string.

## List, composer, and viewer

The list shows session **ID, State, Project, Activity, and Age**. Model remains searchable and appears in metadata, but is not a list column. Enter or Right opens the selected session. Left or Escape returns from a clean viewer editor; an edited editor or used history requires the same key again within 500 ms.

The persistent list composer starts a new session. Press `n` or Tab to focus it. A Git launch uses a managed worktree by default. Shared-directory mode requires the exact canonical directory and confirmation because another process may write there.

One frontend can hold the composer role for a session. That frontend can send prompts and follow-ups, steer, interrupt, and answer pending confirm/select/input/editor requests. Other frontends are observers: they can follow output, scroll, and inspect tools, but cannot mutate the session, Stop, or Delete it. Drafts and history remain scoped to the exact session.

Ctrl+C closes the list without signaling any run. In a viewer, Ctrl+C sends an interrupt and leaves the viewer open. Closing the app or frontend disconnects only that frontend; the daemon, supervisors, and Pi children continue.

## Recovery and process lifetime

The daemon persists registry records, command stages, normalized viewer events, frontend cursors, attachment roles, and exact supervisor/Pi-child identities. A restarted daemon reconciles that state before admitting mutations. Surviving supervisors reconnect and reauthenticate, and viewer replay resumes after the last acknowledged cursor. Ownership conflicts, changed process identities, or mismatched generations fail closed.

Administrative recovery commands are standalone:

```bash
pi-agents daemon status
pi-agents daemon restart
pi-agents daemon recover
pi-agents daemon stop
```

A normal daemon stop does not signal workers. Stopping the daemon and its workers together requires the explicit `pi-agents daemon stop --stop-workers --yes` form.

## Diagnostics and privacy

Raw Pi remote procedure call (RPC) frames and Pi stderr can contain prompts, tool arguments, or provider errors. They stay in local-user-only mode-`0700` directories and mode-`0600` files. Raw diagnostics are not included in viewer snapshots, normalized event replay, package output, or telemetry.

Per run, raw RPC diagnostics use four rotating 8 MiB segments, for a 32 MiB maximum. Pi stderr uses one rotating 8 MiB limit. Rotation retains a bounded truncation marker; an oversized record is replaced by bounded byte-count and hash metadata. Rotation does not truncate the normalized transcript or canonical Pi session file.

## State-root adoption

This product shipped as `pi-dashboard` before it was named `pi-agents`. On startup, if `~/.local/state/pi-agents` does not exist and `~/.local/state/pi-dashboard` does, the executable adopts the older root by renaming the directory itself, once, and reports the rename on stderr. Nothing is copied and nothing is deleted, so every session, the command journal, and every worker lease move together or not at all. Setting `PI_AGENTS_STATE_DIR` skips adoption entirely.

The rename waits while the older root still holds a live daemon or worker, because both hold their root as a plain string and would lose it mid-write. Until they stop, the run uses the older root and says so; it never runs against two roots at once. Restart once they have stopped and the rename happens then.

If both roots exist and the older one holds sessions, startup refuses and names both paths with their session counts. That is a split this program will not resolve for you: stop the daemon in each root, move the sessions you keep into `~/.local/state/pi-agents`, and remove the other root.

## Legacy-state migration

Legacy private state beneath `pi-agents-dashboard` roots, the scaffold name older still, migrates to `pi-agents` roots by copy rather than by rename. Migration converts reviewed schema-version-1 configuration to schema version 2 while retaining canonical session-file and managed-worktree paths.

Migration refuses a verified live legacy daemon or supervisor, unsafe ownership or modes, symlinks, malformed state, changed identities, and destination collisions. Staged files and the migration manifest are durably published before destination reconciliation. If migration is interrupted, the next start validates and resumes the same migration identity. A failure preserves the legacy source; successful reconciliation marks it migrated rather than deleting it.

## Stop, Delete, and cleanup

Ctrl+X opens Stop confirmation for a live session. Confirmation binds the full session ID, current revision, process state, ownership, and action. Stop requests graceful shutdown, waits 5,000 ms, sends TERM to the exact revalidated process group, waits 5,000 ms, and sends KILL only if that same identity remains. Completion requires observed terminal process state.

Ctrl+X offers Delete only for an inactive, unowned session and requires a new confirmation at its current revision. Delete uses an approved public Pi trash capability. When that capability is absent, it returns `TRASH_CAPABILITY_UNAVAILABLE`; it does not unlink the session file or remove a worktree.

Managed-worktree cleanup is a separate full-ID confirmed action. It refuses live ownership, dirty or untracked files, unpushed or divergent commits, replaced paths, and failed late identity checks.

Ambiguous Stop or Delete delivery remains `DELIVERY_UNKNOWN` until explicitly resolved with the original full client and request IDs:

```bash
pi-agents session resolve-delivery <full-client-id> <full-request-id> retry_at_risk|abandon --yes
```

## Pi compatibility boundary

Compatibility is capability-based, not a Pi version allowlist. A bounded no-inference probe checks public RPC mode, fatal UTF-8 JSON Lines framing, `get_state`, required command shapes, required live events, and canonical session resume. Missing required capabilities return `UNSUPPORTED_PI_CAPABILITY` before a session writer starts. Unknown optional events remain visible as bounded generic activity.

The dashboard UI imports only package-root exports from `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent`. It does not import private Pi modules, deep `dist/` paths, an in-process Pi session, native attachment, or a Pi fork. Linux and one local user/machine are the first-release boundary; browser access, cross-machine control, and production terminal multiplexers are outside scope.

## Development

Use Pixi for installation and focused verification:

```bash
pixi run install
pixi run typecheck
pixi run test-unit
pixi run test-integration
pixi run test-acceptance
pixi run pack-check
```
