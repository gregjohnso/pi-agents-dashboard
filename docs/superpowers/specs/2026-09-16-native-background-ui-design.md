# Native monitor and subagent UI

## Decision

Adopt the existing Pi extension UI inside both pi-agents viewer entry points. Native components render in the owning Pi process; pi-agents transports their output and routes input back to that owner. Do not reconstruct a second subagent manager or copy the native renderers into this repository.

The user approved this two-project approach on 2026-09-16 and explicitly added native Ctrl+O expand/collapse behavior. This document records the design for review before implementation.

## Scope and ownership

- `pi-agents` owns widget transport, bounded retained presentation state, viewer layout, focus handoff, and its existing return-to-list gesture.
- `pi-subagents` owns the native progress widgets, FleetView, fleet inspector, key handling within those components, authoritative run state, and all run controls.
- `pi-monitor` continues producing its existing status, widget lines, notifications, and slash-command responses. Do not change its execution or refresh semantics.
- Pi continues owning models, tool execution, canonical sessions, the editor, transcript scrolling, and terminal components.
- This change includes hosted list-to-viewer entry and direct `pi-agents attach`. Both use the same RPC-backed implementation.

No changes to the unresolved rendering defects, launch regressions, model selection, accepted queues, or background-work execution policy belong in this feature.

## Source findings

The current pi-agents normalizer drops `setWidget` and `setStatus` frames. It also collapses `notify` text into one activity line, so monitor command output loses line breaks. Its strict viewer schema has no extension-widget state. The worker retains only a bounded recent RPC tail; a widget's last update can leave that tail before the next attachment or daemon restart.

Pi 0.84.3 RPC already carries string-array widgets, status entries, notifications, and registered extension commands. It does not carry component factories or implement `ctx.ui.custom()` and raw terminal input. Registered extension commands execute without a model turn. An unknown slash command can instead become model input, so an adapter must not probe an unknown command by submitting it.

pi-monitor already uses the supported string-array widget and status APIs. Its `/monitors`, `/monitor-stop`, `/monitor-tail`, and `/monitor-clean` commands use notifications, not custom TUI components. Its native widget updates on start, stop, and exit; this feature does not invent a separate age ticker. Frontend detach does not shut down Pi and therefore does not invoke monitor shutdown cleanup.

pi-subagents publishes a documented `PI_SUBAGENT_ASYNC_JSON` snapshot in RPC mode. That is structured data, not text to scrape, but it lacks the full native renderer inputs and excludes foreground runs. `SubagentFleetStatus` and `SubagentFleetComponent` depend on owner-local state. Their existing renderers and action handlers are the reuse targets. The extension's event-bus RPC is in-process and is not directly callable from a separate frontend.

## Proposed architecture

### 1. Carry native extension presentation

Extend the existing normalized viewer read model with keyed status entries and widgets. Keep placement (`aboveEditor` or `belowEditor`), the native text/lines, and clear operations. Repeated updates replace the value for that key; they never create transcript cards or change session task state.

Mount widgets in Pi's existing `VStack` dock and status area. Keep the real editor, primary transcript `ScrollView`, footer, selection, links, and search. Do not add another viewport or terminal renderer. Use native text components for ordinary extension lines so width handling remains with Pi.

Preserve multiline notifications as bounded presentation content. Ordinary transient notifications stay transient; do not convert every progress notification into a permanent transcript message. A multiline monitor command response must remain readable rather than becoming a flattened activity label.

Do not load a second monitor extension instance into the frontend. The existing command discovery and slash forwarding remain the route to monitor controls. Do not hard-code a second list of monitor commands when Pi already advertises them.

### 2. Add an owner-side native subagent view adapter

Add a narrow RPC UI adapter inside pi-subagents. It instantiates the existing native progress/FleetView/inspector components against the current session's authoritative state and existing action handlers. It does not start a new executor, reconstruct `SubagentState` from the reduced async snapshot, or create a second artifact poller.

The adapter provides the native components with view-local dimensions, focus/expansion state, and a render request callback. It calls their existing component render methods and sends the resulting lines through the existing extension-widget RPC mechanism. This is component output transport, not terminal-byte capture or a pseudo-terminal.

Include active inline subagent call/result panels, not only FleetView. The adapter reuses the registered native tool's `renderCall`/`renderResult` through Pi's `ToolExecutionComponent`, using actual owner-side tool arguments, partial results, and final results. Correlate their rendered output by the original tool-call ID so the frontend can replace that tool's generic presentation without adding a duplicate card. Keep this a bounded presentation cache; do not create another tool execution state machine or reconstruct private `Details` from the reduced async snapshot. Historical cards outside the retained native presentation window keep the existing generic Pi tool component.

Keep the current `subagent-async` JSON and `subagent-inspect` protocols unchanged for other consumers. Publish the new remote-view envelopes under a separate, versioned namespace. Machine-protocol widget payloads must never be drawn as literal JSON.

Reuse the native component's existing controls, confirmations, and receipts. Stop, steer, follow-up, inspection, and any other exposed native action execute in the owning Pi process. The host does not implement these actions by signaling processes, reading private run artifacts, or invoking another model.

### 3. Give each attachment its own view

Each open viewer gets an opaque view ID and generation, bound to the Pi session and worker/run identity that advertised support. That identity is a routing fence, not a replacement for the existing socket authentication.

A view owns only UI objects: inline panel state, inspector state, dimensions, selection, expansion, input ordering, and disposal callbacks. Execution state and controls remain shared in the owning extension. Opening an inspector in one frontend must not hide another frontend's panels or alter its selected child.

Audit native process-global presentation flags, including `fleetInspectorOpen` and widget layout caches. Separate only the view-local presentation state needed by this adapter; do not clone the execution state or broadly refactor the extension. Where an existing renderer reads `process.stdout` dimensions, add explicit view dimensions with the existing local-TUI behavior as the default. Do not temporarily mutate process-global terminal dimensions to render a remote view.

Closing a viewer disposes that view's UI objects and timers only. Lost connections and crashed frontends must not leave an unbounded set of remote views: use a bounded view registry with expiring UI leases. Lease expiry may dispose a view, never a monitor, subagent, Pi process, worker, or accepted command.

### 4. Version and correlate the adapter protocol

Use a versioned registered extension command for UI requests and versioned structured widget envelopes for replies/frames. Requests cover opening, updating dimensions/editor focus metadata/expansion, delivering input, and closing a view. Carry a request ID, view ID, generation, and input sequence where applicable. Frames carry the view identity, monotonically increasing revision, native lines, focus destination, and correlated response/error information.

Discover support through Pi's advertised commands before opening a view. Bind subsequent requests to the same owner identity. If the command is absent, the owner changes, or a version is unsupported, fail the UI operation visibly before it can become ordinary model input. Do not blindly submit a reserved slash command to an unverified owner.

UI input is ordered per view. A late reply or frame from a closed generation is ignored. Do not automatically resend input or control actions after an ambiguous delivery. Reconnect opens a fresh view and obtains fresh presentation state; it does not replay the prior view's key history.

The adapter sends only the editor focus/emptiness metadata needed for native panel routing. It must not copy an unsent editor draft into the owning Pi process merely to open or navigate a panel.

The frontend/daemon viewer contract is strict. Update its producer, parser, reducer, and tests together, and increment `CLIENT_PROTOCOL` from 6 to 7 for the incompatible viewer shape. Retain the existing control handshake so an older daemon remains administratively reachable. Do not rename worker socket frames or bump worker socket protocol 2 for this feature.

### 5. Retain current presentation, not its history

The worker keeps bounded latest-value-per-key extension presentation alongside its existing recent transcript tail. The current widget/status values must survive transcript-tail turnover and daemon absence while that worker remains alive. Clears are part of the retained-state semantics: replay must not resurrect an old widget or status entry.

Replay uses existing Pi-frame envelopes. Rebuilding a normalizer from the canonical transcript, retained presentation, and recent tail must yield the newest presentation state without duplicating transcript content. Preserve the snapshot/subscription atomicity already provided by the frame coordinator.

Reuse the existing frame, tail, and snapshot byte bounds rather than raising them. Count complete encoded envelopes, including nested JSON escaping. Bound key counts, view counts, dimensions, notification content, and input queues. An over-limit presentation is reported as incomplete or unavailable; it must not silently display an older value as current, break ordinary text delivery, or grow memory with run duration.

Retained presentation is not an execution ledger. Do not infer task state, liveness, completion, or permission to replace a worker from widget lines, widget presence, elapsed ages, or panel contents.

## Ctrl+O and focus

Ctrl+O uses Pi's existing `app.tools.expand` action, including the operator's configured binding. In the main viewer, propagate its expansion state to the native tool/progress surfaces that implement expand/collapse. Apply it to the native async progress renderer rather than creating a dashboard-only collapse control.

When a fleet inspector has focus, its native key handler owns the key. Ctrl+O there must not also toggle the transcript behind it. Preserve the inspector's own configured bindings and confirmation behavior. Closing the inspector restores the previous editor draft, cursor, transcript position, and focus.

The dashboard's clean-Left/safe-double-Left return gesture remains reserved. Do not introduce a competing return shortcut or silently replace that gesture with FleetView navigation. Otherwise, reuse native panel activation and navigation. Native components that do not implement expansion, such as the monitor's plain status widget, do not gain invented maximize/minimize behavior.

This is expand/collapse of content, not operating-system window maximization.

## Compatibility and rollout

Older extension instances remain usable for ordinary sessions. If native subagent UI support is absent, show that limitation without attempting a model call, displaying protocol JSON, or starting a second extension instance. Existing monitor string widgets can still be displayed when available.

Do not change the package release number or trigger automatic worker replacement during development. Tests use updated disposable workers. Existing workers may lack the new presentation retention behavior; that limitation must be explicit when evaluating a later deployment.

Deployment is separate approval. An idle parent model does not prove that its monitors or subagents are finished. Do not use the existing model-idle upgrade path as permission to restart a Pi process with background work. No installed extension edits, daemon restarts, worker respawns, pushes, or releases are part of implementing this design.

## Validation contract

Every behavior starts with an operator-visible regression observed failing before production code changes. Use actual native components and the real worker/daemon/viewer event path. A fixture that merely echoes a fabricated final screen does not satisfy this contract.

The focused coverage must include:

1. Monitor status and widget appear, update by key, clear, and retain native placement in both viewer entry points.
2. Multiline monitor command output remains readable; discovery and command dispatch do not call a provider.
3. Native subagent progress updates during a quiet parent turn without typing or reopening.
4. Foreground and async work appear through the corresponding native surfaces, not only the reduced async status snapshot.
5. Ctrl+O collapses and expands active inline subagent call/result panels and native expandable progress surfaces, respects custom bindings, and does not double-handle input across inspector/viewer focus. Assert the actual registered native renderers ran, not just that the generic tool text became longer.
6. Inspector selection, scrolling, native confirmation, and supported controls reach the exact owner and preserve its receipts. No replacement stop/steer implementation is introduced.
7. Two viewers with different dimensions and selections do not change each other's presentation state.
8. Resize and panel expansion preserve the editor draft/cursor and transcript follow/scroll state without overlapping rows.
9. Returning to the list, closing the frontend, losing its connection, and expiring its UI lease leave background work and worker/Pi identities intact.
10. Reattach and daemon restart after enough output to overflow the recent tail recover the latest widget/status values, including clears.
11. Old owners, unsupported versions, malformed/oversized frames, stale generations, duplicate replies, reordered input, and ambiguous delivery fail within the UI boundary without replaying controls or sending a fallback model prompt.
12. First list paint remains ahead of expensive Pi/extension imports. The frontend must not load the extension's executor or Pi's root provider barrel to display native remote lines.

All executable checks run on SLURM using `l40-reserved`, QoS `dev`, explicit log locations, and `env -u PIXI_PROJECT_MANIFEST pixi run`. Independent checks use a Submitit array. Tests use disposable roots and isolated Pi configuration, no provider requests, and the existing process ledger for spawned test processes. Source inspection and Git operations remain local.

After focused RED/GREEN cycles: independent correctness/ownership review, native UI/input review, full pi-agents test/typecheck/package gates, and the affected pi-subagents unit/integration suites. Inspect actual exits, logs, terminal output, and exact source trees. A passing test count alone is not evidence that the native UI was exercised.

## Implementation boundaries and stop conditions

Reuse the current clean pi-agents linked worktree on `feat/native-background-ui`. Use a separate managed pi-subagents worktree based on `071fb76ae17cf3daae2c33f65e0e4bb8326f6a08`; leave the installed checkout's existing `package-lock.json` modification untouched. Opus is the sole implementation writer per worktree; the parent owns integration and acceptance.

The work divides into independently reviewable increments: generic native presentation transport/recovery, owner-side native view adapter, frontend input/layout integration, and cross-boundary acceptance. No increment is considered the completed feature without the full acceptance contract above.

Stop and ask before replacing a native component, expanding into Pi core or pi-monitor changes, weakening owner/command validation, changing worker execution or upgrade policy, inventing a native keybinding, or exceeding the existing transport bounds. If the current RPC cannot satisfy a stated safety boundary, report the missing interface rather than silently relaxing the requirement.

## Sources

- pi-agents: `runtime/viewer-normalizer.mjs`, `runtime/worker-live-tail.mjs`, `runtime/viewer-stream.mjs`, `shared/viewer-contracts.mjs`, `app/viewer/pi-component-adapters.mjs`, `app/viewer/viewer-layout.mjs`, `app/viewer/viewer-controller.mjs`.
- Pi 0.84.3: `docs/rpc.md`, `dist/modes/rpc/rpc-mode.js`, `examples/extensions/rpc-demo.ts`.
- pi-subagents: `docs/observability.md`, `docs/extension-api.md`, `src/tui/render.ts`, `src/tui/fleet-status.ts`, `src/tui/fleet.ts`, `src/extension/rpc.ts`, `src/runs/background/async-status-snapshot.ts`.
- pi-monitor 0.1.1: `extensions/monitor/index.ts` and `README.md`.
- Scope: https://github.com/gregjohnso/pi-dashboard/issues/15.
