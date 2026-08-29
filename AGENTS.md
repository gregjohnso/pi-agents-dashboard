# AGENTS.md

Orientation for a coding agent working in `pi-agents`. Read this first, then read the document your task points at. When this file and the code disagree, the code wins.

## What this codebase is for

`pi-agents` lets one person keep several Pi sessions running at once and see, at a glance, which ones need them.

Pi runs one agent in one terminal, and that agent stops existing when the terminal closes. This package launches installed `pi` processes in remote procedure call (RPC) mode, keeps them alive independently of any terminal, and renders a session list plus a chat viewer over them. The purpose is supervision and visibility: which sessions are working, which are waiting, which failed, and what each one is doing.

Everything else belongs to Pi. This package does not implement a model loop, tool execution, providers, or the canonical session writer, and it does not become a second agent runner. It owns process supervision, durable dashboard state, and a terminal interface. Linux, one local user.

Simplicity is a requirement, not a preference. Prefer the smaller mechanism, prefer an additive edit, and be suspicious of any change that makes this more than a dashboard over Pi.

## Where to read next

- **[README.md](README.md)** — what the tool does and how to use it. Read this before changing anything an operator touches.
- **[docs/architecture.md](docs/architecture.md)** — the three process roles, how a launch travels, how events travel back, what is on disk, the directory map, and the invariants a change must not break. Read this before changing the daemon, a worker, or the contracts.
- **[docs/superpowers/specs/](docs/superpowers/specs/)** — the original design, plan, and task list. Historical. Parts describe behavior that changed; believe the code.

## How to run it

All commands go through Pixi ([pixi.toml](pixi.toml)):

```bash
pixi run install          # npm install
pixi run start            # node ./bin/pi-agents.mjs
pixi run typecheck        # tsc --noEmit && tsc --project tsconfig.app.json
pixi run test             # vitest run (full suite)
pixi run test-unit        # excludes integration, acceptance, tmux suites
pixi run test-integration
pixi run test-acceptance
pixi run pack-check       # npm pack --dry-run --json
```

Focused runs use the raw vitest task: `pixi run vitest -- run app/mouse-input.test.mjs --testTimeout=20000`.

Write the failing test first, watch it fail, then implement. Before committing, run your focused files, then the full suite, then `pixi run typecheck`. Tests sit beside their source as `*.test.mjs`; cross-cutting suites live in `test/`. No test may make a provider request or run model inference.

**Never touch the operator's live state.** `~/.local/state/pi-agents` and any older root beside it are production. Do not write to them, and never start, stop, or signal their daemon or Pi workers from a task. Build a throwaway root with `mkdtemp` and pass it explicitly.

## Known traps

Each of these cost real debugging time. They are not derivable from the code.

- **The wheel-input tap depends on pi-tui input ordering.** `TuiAltScreen.handleViewportInput` in pi-tui 0.84.3 parses wheel bytes and consumes them before any child dispatch, so a wheel event cannot reach a component. [app/mouse-input.mjs](app/mouse-input.mjs) reads wheel reports ahead of the TUI and passes every other byte through untouched. Two canary tests at the end of [app/mouse-input.test.mjs](app/mouse-input.test.mjs) assert pi-tui still has no component mouse seam; when they fail, pi-tui grew one and this module should be deleted rather than patched.
- **Escape cannot drain Pi's queued messages.** The RPC exposes no queue-clearing command; the adapter has `abort` and nothing else ([runtime/pi-rpc-adapter.mjs](runtime/pi-rpc-adapter.mjs)). The queued block the viewer draws is the frontend's own mirror of what it sent, not a read of Pi's queue.
- **Summaries are opt-in and cost tokens.** `settings.summaryModel` defaults to `null` ([runtime/summaries.mjs](runtime/summaries.mjs)). Setting it makes the daemon spawn real `pi --print --no-session --no-tools` inference. Never enable it in a test or a default.
- **A frontend that falls behind resynchronizes; it does not fail.** Overflow drops the backlog and yields one `resynchronize` marker; the list refetches `get_state` and continues from the position that snapshot covers. Do not raise the queue bound instead: correctness lives in the resync path, not in the constant.
- **Anything that signals a process must revalidate identity immediately before the signal.** Use `stopVerifiedProcessGroup` ([runtime/process-signaler.mjs](runtime/process-signaler.mjs)); never call `process.kill` directly.
- **Renaming anything that crosses a process boundary is an outage, not a refactor.** A running daemon holds old code while spawning workers from new code on disk. Renaming the worker token environment variable this way broke every launch until the daemon restarted. Version the contract or keep both names for a release.
- **`test/package.acceptance.test.mjs` fails in a worktree whose `node_modules` is a symlink.** `npm pack` then emits bundled-dependency entries outside `package/node_modules/`. That is a checkout-layout artifact, not a packaging defect.
