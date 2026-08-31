# pi-agents

`pi-agents` is a terminal dashboard for installed [Pi](https://github.com/badlogic/pi-mono) sessions. It launches real `pi --mode rpc` processes, keeps them running when the dashboard closes, and opens a viewer that reads like Pi itself. It is a small dashboard over Pi. Pi still runs the agent, tools, models, and session files.

## Install and open the session list

You need Node.js 22.19 or newer and an installed `pi` executable.

```bash
npm install -g pi-agents
pi-agents
```

To install a local checkout instead, run `npm install -g /absolute/path/to/pi-agents`. The executable is `pi-agents`. If your shell cannot find it, the global npm prefix is not on your `PATH`; link it somewhere that is, for example `ln -s "$(npm prefix -g)/bin/pi-agents" ~/.local/bin/pi-agents`. With no arguments, it starts or connects to the per-user daemon and opens the session list. New sessions start from the directory where you ran the command.

If `pi` is not on `PATH`, pass its absolute path:

```bash
pi-agents --pi-bin /absolute/path/to/pi
```

## Launch, open, and stop sessions from the list

The list uses these columns. Narrow terminals hide columns from right to left.

- **Name** is the chosen session name, a name derived from the first prompt, or the first 8 characters of the session ID.
- **State** is the dashboard state, such as `WORKING`, `WAITING`, `READY`, `FAILED`, or `STOPPED`.
- **Activity** is the latest summary or current Pi activity.
- **Model** is Pi's current model ID.
- **Age** is the time since the session was created.

Type anywhere to compose a prompt in the box at the bottom. Press Enter with prompt text to launch a session. Worktree isolation is the default, so the current directory must be inside a Git repository with a commit. Press Enter with an empty prompt to open the selected session.

Use Up and Down to select a row. Page Up, Page Down, Home, and End move farther. The mouse wheel moves the selection. One click selects a row, and a second click opens it.

Press Ctrl+X on a live session, then confirm to stop its worker and Pi process. After Stop completes, press Ctrl+X again within 500 ms and confirm to clear the dashboard record. For an already stopped session, press Ctrl+X twice within 500 ms, then confirm. Clearing a record does not delete Pi's session file or remove a worktree.

Press `?` with an empty prompt for the full key reference. Ctrl+C closes the dashboard without stopping sessions.

## Configure the next launch with list commands

A slash command in the list changes the next launch only. It does not change a running session.

| Command | Next-launch setting |
| --- | --- |
| `/model [provider/id]` | Model. Omit the value to open a picker. |
| `/cwd <path>` | Working directory. Tab completes directories as a shell would. |
| `/isolation [worktree\|shared]` | Managed Git worktree or the shared directory. Omit the value to open a picker. |
| `/name [text]` | Session name. An empty value lets the agent name it. |
| `/help` | Dashboard keys and commands. |

Shared-directory launches ask you to type the exact canonical path before launch.

## Use the viewer like Pi

The viewer shows the normalized Pi transcript and uses Pi's editor components. Type a prompt and press Enter. If Pi is working, a submitted prompt becomes a follow-up.

Pi owns the slash prefix in the viewer. The viewer passes unknown slash-prefixed text to Pi as a prompt and offers Pi's discovered commands alongside dashboard commands. Run `/help` there for the viewer's current commands and keys.

Press Escape while a turn is working to interrupt it. After the turn settles, press Escape again to return to the list. When Pi is idle, Escape returns immediately. Closing the dashboard does not stop Pi.

## Run commands without opening the list

The operator-facing commands use the same verbs as Claude Code's background sessions.

| Command | What it does |
| --- | --- |
| `pi-agents agents` | Opens the session list. Same as `pi-agents` with no arguments. |
| `pi-agents agents --json` | Prints every session row as one JSON object and exits. It reads only and does not start the daemon. |
| `pi-agents attach <full-session-id>` | Opens one session's viewer directly. Returning ends the attachment, not the session. |
| `pi-agents logs [<full-session-id>]` | Prints a combined 256 KiB tail of that session's newest Pi stderr segment and its worker stderr, newest Pi output first. With no ID it prints the daemon's startup log. Each source's full path precedes its content, so a truncated tail says where to read further. |
| `pi-agents stop <full-session-id> --revision <n> --yes` | Stops that session's worker and its Pi process. |
| `pi-agents rm <full-session-id> --revision <n> --yes` | Forgets the dashboard record. It does not delete Pi's session file or remove a worktree. |
| `pi-agents respawn <full-session-id> --revision <n> --yes` | Restarts that session's worker on the installed release. It refuses while the session is working or waiting on you, rather than interrupting the turn. |

An upgraded daemon adopts your running sessions rather than refusing them, and restarts a worker left on older code by itself once Pi settles that session. `respawn` is how you ask for that restart at a moment you choose. A worker newer than the daemon is never downgraded.

Session IDs are exact; a prefix does not match. `--revision <n>` is the `revision` in `pi-agents agents --json`, and the command refuses when the row changed underneath it.

`logs` works before a session's worker is ready, which is when a launch is most likely to have failed. It resolves the run directory from the record's own root-relative run hash, so it keeps working after the state root is renamed, and it refuses any source that is not a regular file the operator owns.

Two recovery commands have no Claude Code equivalent and stay under `session`:

- `pi-agents session cleanup <full-session-id> --revision <n> --yes` removes a stopped session's managed worktree.
- `pi-agents session resolve-delivery <full-client-id> <full-request-id> retry_at_risk|abandon --yes` settles a `stop`, `rm`, or `respawn` whose delivery the daemon left ambiguous.

Add `--json` to any command for one machine-readable object on standard output.

## Upgrading

Restart the daemon and every open dashboard after upgrading:

```bash
pi-agents daemon restart
```

A running daemon holds the code it loaded at startup while it spawns workers from the code now on disk. If the two disagree, launches fail with `WORKER_PROCESS_EXITED` until the daemon restarts. Live sessions survive a daemon restart; their workers reconnect.

## Troubleshooting

- **`pi` cannot be found or executed:** put the installed executable on `PATH`, or start with `pi-agents --pi-bin /absolute/path/to/pi`. The override must be absolute.
- **`NOT_GIT_REPOSITORY` or `UNBORN_HEAD`:** the default worktree launch needs a Git repository with at least one commit. Use `/cwd` to select one, or use `/isolation shared` and confirm the exact path.
- **`UNSUPPORTED_PI_CAPABILITY`:** the installed Pi does not provide an RPC command or event required by this dashboard. Use a compatible Pi executable.
- **`STATE_ROOTS_SPLIT`:** two state roots both hold sessions. Stop the daemon in each, move the sessions you keep into one root, and remove the other. `pi-agents` will not merge them.
- **A start message says a live daemon or worker still holds the state root:** the directory cannot be renamed while sessions are running. The dashboard uses the existing root and renames it on the first start after those sessions stop.
- **`DAEMON_STILL_RUNNING`:** the daemon released its endpoint but its process still matches the identity that was published, so `stop` and `restart` refuse instead of leaving a second daemon on the same state root. Find that process by the PID in the message and end it, then run `pi-agents daemon start`.
- **`WORKER_PROCESS_EXITED` right after an upgrade:** the daemon is running older code than the workers it spawns. Run `pi-agents daemon restart`.
- **`DAEMON_FROM_EARLIER_RELEASE`:** the running daemon predates this release's authentication frame and refuses it. Run `pi-agents daemon restart`; it stops and starts the daemon without stopping a session, and the workers reconnect to the new one.
- **An empty session list right after an upgrade:** the dashboard predates the current protocol. Quit it and start it again.
- **The daemon does not start:** the error includes captured startup output when available. The same output is stored at `${PI_AGENTS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/pi-agents}/daemon/startup.log`.
