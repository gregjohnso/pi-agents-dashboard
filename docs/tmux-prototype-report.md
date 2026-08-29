# Tmux prototype report

## Recommendation: reject tmux as the session host

Do not replace the current remote procedure call (RPC) worker and viewer with native interactive Pi under tmux. Native rendering worked, and switching was under 0.66 ms in 60 measured transitions. The design still loses three current properties: durable command delivery, structured control, and an honest row state. It also reserves Left inside Pi, so Pi's editor cannot move the cursor left.

Tmux remains useful as evidence that a native viewer is technically possible. It is not a viewer-only substitution because changing Pi from RPC mode to interactive mode also changes supervision, commands, state, and multi-client behavior. Keeping the current launcher and list does not preserve those properties by itself.

## Prototype scope

The prototype is in `/tmp/pi-tmux-prototype`. Its run directory was created with `mktemp -d` and contains an isolated Pi config directory, session directory, and working directory. It used tmux 3.6a with the private socket `pi-agents-proto` and a private config. It did not load `~/.tmux.conf` or attach to another tmux server.

The prototype had two sessions:

- `dashboard` ran a 50 ms JSONL polling list.
- `agent-1` ran interactive Pi 0.84.3 with its own session directory and an explicit test extension.

The final private tmux server was killed. `tmux -L pi-agents-proto list-sessions` then returned `no server running`. No SLURM prototype job remained in `squeue`.

## Switching is fast and preserves the pane

A pseudo-terminal client alternated from the dashboard to Pi with Enter, then back with Left, 30 times. Latency was measured from writing the key to receiving a screen marker from the destination.

| Transition | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: |
| Dashboard to Pi | 0.412 ms | 0.450 ms | 0.579 ms |
| Pi to dashboard | 0.365 ms | 0.419 ms | 0.650 ms |

The text `state-marker-731` remained in Pi's editor before and after a switch. Tmux also retained the pane and its history while no client was attached.

These figures measure tmux and a local pseudo-terminal on this host. They do not include a terminal emulator's drawing time.

## Left is not available to Pi's editor

The root key table used conditional bindings:

```tmux
bind-key -T root Enter if-shell -F '#{==:#{session_name},dashboard}' 'switch-client -t agent-1' 'send-keys Enter'
bind-key -T root Right if-shell -F '#{==:#{session_name},dashboard}' 'switch-client -t agent-1' 'send-keys Right'
bind-key -T root Left if-shell -F '#{==:#{session_name},agent-1}' 'switch-client -t dashboard' 'send-keys Left'
```

Enter and Right open the selected session from the dashboard without reaching its pane. In Pi, the conditional binding passes Enter and Right through with no prefix and no extra keystroke. Left returns to the dashboard without reaching Pi.

That last behavior breaks normal editing. The operator cannot use Left to move through a Pi prompt. A different return key, a prefix, or a mode would be required. Any of those choices changes the requested user experience. Tmux can trap all three navigation actions, but reserving Left has a direct product cost.

The prototype hard-coded one selected session. A product implementation would need the dashboard to update a tmux option or binding target when selection changes. **Estimate:** that routing is small, about tens of lines, but it adds shared state between the list and tmux.

## Different client sizes share one pane size

Two pseudo-terminal clients used 80 by 20 and 140 by 45 cells. With a plain session, the pane changed from 80 by 20 to 140 by 45 when the large client attached. Resizing the first client to 82 by 22 changed the shared pane to 82 by 22.

Grouped sessions created with `new-session -t` behaved the same. The pane changed from 80 by 20 to 140 by 45 when the second grouped client attached. Resizing the first grouped client to 83 by 23 changed the shared pane to 83 by 23.

The operator sees the layout chosen by the client that most recently caused a resize. A smaller client gets a viewport onto a larger pane. A larger client gets unused space around a smaller pane. Pi redraws for the new shared size, so one terminal can disrupt the other terminal's layout. Grouped sessions provide separate session names and current-window selection, but linked windows still contain the same pane and pseudo-terminal size.

## Attach shows the current screen and bounded terminal history

A new client attaches at the current bottom of the pane. It sees the current screen immediately, including editor contents and extension UI. It can enter tmux copy mode to inspect retained terminal output.

Tmux's default `history-limit` is 2,000 lines, which the private config kept. A plain pane printed 2,600 numbered lines at 80 by 24 cells. Capture returned the last 2,000 content lines, from line 601 through line 2600. Tmux reported 1,977 history lines plus the 24-line visible screen.

This is terminal history, not Pi's canonical transcript. Cursor movement and redraws do not create one retained logical line per transcript line. In regular Pi mode, current screen state survived. **Unverified:** how much of a long native Pi transcript remains navigable after many full-screen redraws. Fullscreen Pi uses the alternate screen, which makes tmux's screen model more important than line history.

## JSONL state is too weak for one honest state per row

The proposed mapping matched the entries observed in a real Pi 0.84.3 tool turn:

| Last message | Content kinds | Mapped state | Detection after entry timestamp |
| --- | --- | --- | ---: |
| user | text | WORKING | 568.7 ms |
| assistant | text, toolCall | WORKING | 6.7 ms |
| toolResult | text | WORKING | 6.0 ms |
| assistant | text | READY | 6.1 ms |

A second real turn used no tools and a 50 ms dashboard poll. The user and final assistant entries became visible in the same poll. The user entry was detected 778.2 ms after its timestamp. The final assistant entry was detected 24.2 ms after its timestamp. During the 754 ms between their timestamps, the file did not give the dashboard an observable WORKING state. The reply produced 75 words despite a request for 80.

The first tool probe similarly exposed the user and tool-call entries together after 568.7 ms. Once Pi was appending intermediate entries, the detector updated in 6.0 to 6.7 ms with a 10 ms poll.

These two measurements used real `pi --print` sessions on a SLURM worker with isolated session directories. An attempted interactive measurement did not submit the prompt through the nested test pseudo-terminal, so it produced no session entries and was cancelled. **Unverified:** interactive Pi may flush the user entry earlier than `--print`. The measured print-mode result still shows that entry timestamps do not define when a tailer can observe an entry.

The mapping also cannot distinguish these cases from the canonical file alone:

- model output streaming before the final assistant entry is appended
- a slow or hung provider after a user entry
- Pi waiting for an extension dialog or other interactive input that does not append a message
- queued input and delivery ambiguity
- an interrupt requested but not yet reflected in a terminal message

A dead pane gives a reliable EXITED state. The four-role mapping is reasonable after an append, but file tailing is not a complete lifecycle signal. It cannot support the current `WAITING`, durable delivery, or one honest live state per row.

## Native Pi components render natively

The agent pane was Pi's interactive terminal interface, not a dashboard reconstruction.

- An explicit extension called `ctx.ui.setWidget` and `ctx.ui.setFooter`. Captured output contained `PROTOTYPE WIDGET: native Pi extension UI` and `PROTOTYPE FOOTER`.
- Captured output contained Pi's 24-bit RGB terminal sequences, so Pi's theme rendering passed through tmux.
- Typing `/` opened Pi's own slash menu. The captured menu included Pi's `model` command.
- Pi's editor state survived switching away and back.

Mouse behavior depends on Pi's terminal mode. Regular mode reported `alternate_on=0` and `mouse_any_flag=0`. Tmux's default WheelUp binding enters copy mode in that state, so the wheel does not reach Pi. Fullscreen Pi reported `alternate_on=1` and `mouse_any_flag=1`; tmux then forwards wheel events with `send-keys -M`. The mode flags and tmux routing were measured. **Unverified:** an end-to-end physical mouse gesture inside a Pi widget was not measured.

## Tmux owns lifetime correctly until its server dies

The isolated lifetime probe produced these results:

| Action | Agent result |
| --- | --- |
| Kill the dashboard session | agent session remained alive |
| Kill the attached tmux client process | agent session remained alive |
| Close the client's pseudo-terminal, modeling terminal closure | agent session remained alive |
| Kill the private tmux server | session disappeared and the Pi pane process died |

The Pi pane process had PID 195887 in this disposable run. It was dead 0.5 seconds after `kill-server`. This makes tmux the process owner whose failure boundary contains every hosted session. A daemon restart can be harmless, but a tmux server restart cannot adopt the old pseudo-terminals.

Structured Stop becomes harder. Sending Ctrl+C or a slash command is synthesized terminal input and depends on current editor or overlay state. Killing a tmux pane is forceful. The current worker can ask Pi to abort or shut down, wait for a reply, and revalidate the exact process identity before signaling. Native interactive Pi exposes no equivalent acknowledgement channel in this prototype.

## Read-only attach supports watchers but not product ownership

One normal client and one `attach -r` client watched the same pane. Input from the read-only client was ignored. Input from the writer reached the pane once. Both clients saw `ACK:writer-input`. Tmux reported one client with `readonly=0` and one with `readonly=1`.

This covers one writer plus passive watchers at the terminal input layer. It does not cover the dashboard's ownership contract:

- A process with access to the private socket can run `tmux send-keys`, which bypasses an attached client's read-only flag.
- Read-only status is a client flag, not a durable command or session lease.
- Tmux does not publish the current product's accepted, delivered, acknowledged, failed, and ambiguous command stages.
- Client resize still acts on the shared pane. **Unverified:** whether every read-only client resize path can change the pane under all terminal and tmux option combinations.

The private socket therefore needs operating-system permissions and a single trusted controller if it is used in a product. Tmux read-only attach alone is not authorization for command delivery.

## Tmux does not replace only the viewer

The current viewer is coupled to RPC mode because the same channel provides prompts, interrupts, extension UI responses, model changes, frames, and lifecycle events. Interactive Pi provides the native terminal but removes that structured channel. Running a second Pi process against the same canonical session file would add concurrent writers and was not tested.

If this direction were adopted, these parts could be deleted:

- the custom transcript, tool, footer, widget, editor, overlay, and Pi slash-menu rendering in `app/viewer/`
- viewer frame normalization in `runtime/viewer-normalizer.mjs`
- normalized viewer event snapshots, replay, and acknowledgements in the viewer store
- most RPC-to-viewer frame handling

These parts would remain:

- the launcher, list, worktree isolation, cleanup, and dashboard metadata
- a daemon or controller for the tmux server and session-name mapping
- process identity, ownership, reconciliation, and safe signaling around tmux and each pane
- list snapshots and multi-client invalidation
- model admission and Pi-confirmed metadata if the list still displays them
- stop, delete, and launch revision guards

These parts become harder or lose current behavior:

- The command journal cannot prove delivery from terminal bytes. A successful write to tmux does not prove that Pi's editor accepted or submitted the command.
- Durable delivery states disappear unless a new acknowledgement protocol is added above the terminal.
- Structured Stop becomes keystroke synthesis or process termination.
- The list cannot derive `WAITING`, active streaming, queued input, delivery ambiguity, or interrupt progress from JSONL.
- One writer plus observers exists only at tmux's client-input layer. Dashboard composer ownership and socket-level mutation still need a controller.
- Two terminal sizes cannot get independent layouts from one pane.
- Left navigation breaks Pi's editor.
- A tmux server failure stops every hosted Pi session at once.

## Effect on the 18-commit plan

If tmux were adopted despite this recommendation, the plan would not collapse to a viewer deletion.

| Planned changes | Effect under tmux hosting |
| --- | --- |
| Commits 1 to 3, remove dashboard queries and settings controls | Most viewer command deletion becomes automatic because Pi owns its slash menu. Launch-time model policy and any list controls still need explicit decisions. |
| Commit 4, open observers read-only | Tmux `attach -r` supplies terminal observation, but not dashboard role notification, mutation authorization, or safe writer transfer. The commit changes rather than disappears. |
| Commits 5.1 to 5.3, one worker socket route | The RPC route work is replaced by tmux server and pane supervision. Exact identity, adoption, reconciliation, and graceful stop remain, with fewer structured signals. |
| Commit 6, Pi-confirmed model | Still needed if Model remains a list column. JSONL or terminal scraping is weaker than the current initial RPC state. |
| Commits 7.0 to 7.3, list invalidation | Still needed. Tmux does not distribute dashboard registry snapshots or compatibility errors. |
| Commits 8.1 and 8.2, connection-scoped access and frontend state | Frontend-state isolation remains. Tmux replaces only pane input suppression, not dashboard composer claims or socket-level commands. |
| Commits 9.1 and 9.2, viewer acknowledgements | Deleted with the normalized viewer store. Tmux owns screen state and history. |
| Commits 10.1 and 10.2, forget-only Delete and trash retirement | Unchanged. Tmux does not define Pi file or worktree deletion semantics. |

The feature-deletion, list, frontend-state, confirmed-model, and Delete work remains. Worker handoff and viewer acknowledgement work is replaced, not simply removed. **Estimate:** fewer than half of the 18 commits disappear outright. A new tmux supervision, authorization, resize, key-routing, state, and stop plan would replace them. No implementation estimate is justified from this prototype.

## Decision

Reject the tmux-hosted architecture. It answers the rendering problem and makes session switching fast, but it moves correctness out of structured contracts and into terminal state. The current viewer remains the safer place to preserve the command journal, durable delivery stages, structured Stop, and honest list state.

## Sources

- Prototype files and logs under `/tmp/pi-tmux-prototype/run.UDaSJ9`.
- [Architecture](architecture.md).
- [Architecture implementation plan](architecture-plan.md).
- [Pi server investigation](pi-server-investigation.md).
- Installed Pi 0.84.3 tmux documentation at `/mnt/main0/home/gjohnson/.pixi/envs/nodejs/lib/node_modules/@earendil-works/pi-coding-agent/docs/tmux.md`.
