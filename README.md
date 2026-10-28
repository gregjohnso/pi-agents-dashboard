# pi-agents

`pi-agents` is a native terminal dashboard for Pi sessions. It starts persistent native Pi owners, keeps them running when the dashboard closes, and hands the terminal to Pi when a session opens. Pi still owns the agent, tools, model configuration, extensions, authentication, and transcripts.

## Open the installed native app

This private candidate is qualified only for Linux x86-64 with glibc. It is not a public distribution. Its installed release carries the pinned Node 22.23.2 runtime, patched Pi 0.84.3 cohort, native PTY artifact, and third-party notices.

Run `pi-agents` from the project directory. Bare invocation uses real mode, preserves that directory as the project cwd, stores dashboard metadata under `~/.pi-agents`, and uses `/tmp/pi-save-default-<uid>` for short-lived owner sockets. Pi continues to resolve its own normal configuration and transcript storage.

```bash
pi-agents
```

Use `--cwd`, `--state`, or `--sessions` for explicit overrides. `--fake --pi-config <private-dir>` is the deterministic no-provider fixture mode used by isolated validation. Legacy daemon and administrative verbs are not accepted by this native entry point.

## Launch, open, and stop sessions from the list

The list uses these columns. Narrow terminals hide columns from right to left.

- **Name** is the chosen session name, a name derived from the first prompt, or the first 8 characters of the session ID.
- **State** is the dashboard state, such as `WORKING`, `WAITING`, `READY`, `FAILED`, or `STOPPED`.
- **Activity** is the latest summary or current Pi activity.
- **Model** is the model Pi reported for that session. It is empty until Pi says which model it is running, and never shows what a launch asked for.
- **Age** is the time since the session was created.

Type anywhere to compose a prompt in the box at the bottom. The box wraps and grows as you type, and the list shrinks to make room. Left and Right move the prompt cursor while the box contains text. Press Enter with prompt text to launch a session. Worktree isolation is the default; when the directory is not inside a Git repository with a commit, the session runs in that directory instead. A directory another live session is already working in asks you to type its exact path first. Press Enter or Right with an empty prompt to open the selected session.

Use Up and Down to select a row. Page Up, Page Down, Home, and End move farther. The mouse wheel moves the selection. One click selects a row, and a second click opens it.

Ctrl+V selects a filter or display setting; Ctrl+T cycles its values. The selected setting appears below the prompt once either key is used. Clear filters, summary refresh, and session metadata are available through the same pair.

Press Ctrl+X twice within 500 ms to stop a live session. The first tap only shows a hint; it does not stop Pi. Changing selection or pressing another key cancels that first tap. The row updates when its exit is confirmed, without waiting for the rest of the list to refresh. Clearing a stopped entry requires a separate Ctrl+X double-tap within 500 ms. Clearing hides that owner's entry persistently; it does not delete Pi's session file, worktree, runtime directory, or saved owner metadata.

Press `?` with an empty prompt for the full key reference. Ctrl+C clears the prompt; a second Ctrl+C within 500 ms closes the dashboard without stopping sessions.

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

Native owners generate a session name and short dashboard description after two user requests finish. The next completed request refreshes an automatic title or retries a failed attempt, with at most two attempts per owner generation. They use an available Haiku model from Pi's existing registry and authentication, with a 10-second request bound and no fallback to the main model. This costs tokens when Haiku is available. Failures leave the existing name and record the model, stop reason, and validation failure without storing the response text. Fake mode uses only its deterministic label fixture.

An explicit launch `/name` stands. Dashboard `/rename <name>` changes the selected session through Pi's public name API; inside native Pi, `/name <name>` is Pi's built-in command. Both take priority over a pending generated title. Descriptions are saved dashboard metadata tied to the confirmed Pi session, not transcript entries or changing tool activity.

## Use the viewer like Pi

The viewer shows the normalized Pi transcript and uses Pi's editor components. Enter starts a prompt when Pi is idle or steers it at the next tool boundary when Pi is working. Alt+Enter queues a follow-up until the run finishes. Submitted text is listed as pending until it appears in the transcript.

Pi owns the slash prefix in the viewer. The viewer passes unknown slash-prefixed text to Pi as a prompt and offers Pi's discovered commands alongside dashboard commands. Run `/help` there for the viewer's current commands and keys.

Pi also owns the transcript itself. The viewer is one of Pi's own full-screen layouts, so Page Up, Page Down, Home, End and the mouse wheel move the transcript, Ctrl+Shift+F searches all of it rather than the part on screen, dragging selects text and copies it on release, and clicking a link opens it. The prompt, status and footer stay put while the transcript moves. New output keeps following the bottom until you scroll up, and End follows it again. The arrows stay with the prompt: they move its cursor and recall prompt history.

Press Ctrl+L to pick this session's model from the models its worker reported, the same picker a bare `/model` opens. Escape closes it and changes nothing, and either way your prompt is left exactly as you typed it, cursor included. Press Shift+Tab to move this session to the next thinking level Pi reports for its current model; the level next to the model in the footer is the one Pi confirmed, never the one that was asked for. Press Ctrl+T to hide or show thinking blocks in this transcript, and Ctrl+O to expand or collapse every tool's output. Neither asks the session for anything.

Press Escape while a turn is working to interrupt it. After the turn settles, press Escape again to return to the list. When Pi is idle, Escape returns immediately. Closing the dashboard does not stop Pi.

Two of Pi's own interactive features are not available here, because its RPC exposes no command for them: clearing the queue of messages waiting behind a running turn, and editing those queued messages. What the viewer lists as pending is its own record of what it sent, not a read of Pi's queue.

## Command boundary

This installed entry point opens the native dashboard only. It does not adopt an older state root and does not dispatch the previous daemon administration commands. Unsupported or conflicting arguments are refused before the dashboard, Pi configuration, or an owner is contacted.

## Storage and lifetime

Dashboard metadata under `~/.pi-agents` records owner and Pi session identities and the transcript path Pi reported. It does not contain a copied transcript. Pi chooses transcript storage from its own configuration. The short runtime root contains sockets and owner-local runtime files; changing `--sessions` selects a different runtime namespace. Cleared entries are tracked by version-1, owner-identity-scoped markers under the metadata home's `forgotten/` directory, separate from the manager's saved record.

Closing the dashboard does not stop owners. Opening and returning from a session preserves the same owner and its unsubmitted Pi draft. Returning restores cached rows and input before refreshing session status in the background. New owners answer list-status requests without diagnostic histories; oversized detailed status replies fall back to the same compact form. A release-specific owner keeps using the code and pinned dependencies from the release that started it.

## Platform and notices

The committed PTY artifact is private Linux x86-64 glibc qualification only. Its notice and inventory ship at `vendor/pty/THIRD-PARTY-NOTICES.md` and `vendor/pty/third-party-inventory.json`. The packaged Pi cohort remains subject to its own licenses and notices; this installation is not a public redistribution approval.
