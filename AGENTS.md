# AGENTS.md

Orientation for a coding agent working in `pi-dashboard`. Read this before touching the code. Every claim below points at a file you can check; when this file and the code disagree, the code wins and the drift note at the end should grow.

## 1. What this is, and what it is not

`pi-dashboard` is a machine-local terminal dashboard over Pi. It launches installed `pi` processes in remote procedure call (RPC) mode, supervises them, and renders its own session list and chat viewer. The launch is literally `pi --mode rpc --session <canonical-session-file>` ([runtime/installed-pi-worker.mjs:115](runtime/installed-pi-worker.mjs#L115)).

It is deliberately not a parallel agent runner or a coordinator. It does not reimplement Pi's model loop, tool execution, providers, or canonical session writer; it does not treat Pi's internal subagent transcripts as top-level sessions; it does not do cross-machine control; it does not depend on tmux for process lifetime; it does not add a `pi agents` subcommand (design non-goals, [docs/superpowers/specs/2026-08-25-pi-dashboard-design.md:52](docs/superpowers/specs/2026-08-25-pi-dashboard-design.md#L52)). Pi keeps owning the agent. This package owns process supervision, durable state, and a terminal user interface. Linux and one local user are the supported boundary.

Simplicity is a choice here. Prefer a smaller mechanism over a general one, and prefer an additive edit over a refactor that touches the daemon's ordering guarantees.

## 2. How to run it

All commands go through Pixi ([pixi.toml](pixi.toml)):

```bash
pixi run install          # npm install
pixi run start            # node ./bin/pi-dashboard.mjs
pixi run typecheck        # tsc --noEmit && tsc --project tsconfig.app.json
pixi run test             # vitest run (full suite)
pixi run test-unit        # excludes integration, acceptance, tmux suites
pixi run test-integration
pixi run test-acceptance
pixi run pack-check       # npm pack --dry-run --json
```

Focused runs use the raw vitest task: `pixi run vitest -- run app/mouse-input.test.mjs --testTimeout=20000`.

The executable surface is small ([cli/main.mjs](cli/main.mjs), [cli/session-commands.mjs:337](cli/session-commands.mjs#L337)):

```
pi-dashboard [--pi-bin /absolute/path/to/pi]
pi-dashboard daemon start|status|restart|recover|stop [--stop-workers --yes]
pi-dashboard session status <full-id>
pi-dashboard session stop|delete|cleanup <full-id> --revision <n> --yes
pi-dashboard session resolve-delivery <full-client-id> <full-request-id> retry_at_risk|abandon --yes
```

Add `--json` for machine-readable output. `daemon stop` refuses while workers are live unless you pass `--stop-workers --yes`; a plain stop never signals a Pi child.

Do not run any of these against the operator's live state. `~/.local/state/pi-dashboard` is production, and its daemon and Pi workers must never be started, stopped, or signaled from a task. Tests build a throwaway root with `mkdtemp` and pass it explicitly.

## 3. Architecture in one pass

Four processes, in order of ownership:

1. **Frontend** (`app/`). [bin/pi-dashboard.mjs](bin/pi-dashboard.mjs) calls [cli/main.mjs](cli/main.mjs), which calls `runDashboardApp` ([app/standalone.mjs](app/standalone.mjs)). That migrates legacy state if present, connects to or starts the daemon, and opens the list ([app/list/standalone-list.mjs:187](app/list/standalone-list.mjs#L187)). The list is the Jobwatch-style home screen plus a persistent launch composer; the viewer ([app/viewer/viewer-controller.mjs](app/viewer/viewer-controller.mjs)) is a full-screen chat for one session. Both render through `TuiAltScreen` from `@earendil-works/pi-tui`.
2. **Daemon** (`runtime/daemon.mjs`, about 1,500 lines, the heart of the system). One per user. It listens on a Unix socket, authenticates each connection with a shared token file, and speaks the strict version-1 request and response contract in [shared/contracts.mjs](shared/contracts.mjs) over JSON Lines. It owns the registry ([runtime/registry-store.mjs](runtime/registry-store.mjs)), the command journal, the event store, the viewer stores, attachment roles, and worker supervision ([runtime/worker-supervisor.mjs](runtime/worker-supervisor.mjs)). A restarted daemon reconciles all of that before admitting mutations ([runtime/reconciliation.mjs](runtime/reconciliation.mjs)).
3. **Supervisor** (`runtime/worker.mjs` plus `runtime/installed-pi-worker.mjs`). One detached process per run. It leads its own process group, owns the Pi child's stdin, stdout, and stderr, reports both process identities before the session file opens, and reconnects to a restarted daemon.
4. **Pi child**. The installed `pi` executable. [runtime/pi-rpc-adapter.mjs](runtime/pi-rpc-adapter.mjs) is the only code that speaks its RPC dialect: `prompt`, `follow_up`, `steer`, `abort`, `get_state`, the `set_*` session commands, and the read-only queries.

Executable discovery precedence is `--pi-bin` (absolute path), then the validated `pi.executable` config value, then `pi` on `PATH`. Before the first launch for a given executable identity a bounded, inference-free probe checks required capabilities ([runtime/pi-capability-probe.mjs](runtime/pi-capability-probe.mjs)); a missing one returns `UNSUPPORTED_PI_CAPABILITY` before any session writer starts.

### Where state lives

State root: `$PI_DASHBOARD_STATE_DIR`, else `${XDG_STATE_HOME:-$HOME/.local/state}/pi-dashboard` ([runtime/paths.mjs](runtime/paths.mjs)). Directories are mode 0700 and files mode 0600; the daemon refuses a symlinked or non-canonical root.

```
<state root>/
  dashboard.json                 validated config, schema version 2 (shared/config.mjs)
  frontend-state.json            one frontend's cursors and drafts
  daemon/                        pid.json, control.sock, control.token, epoch, lifecycle.lock,
                                 workers.json, settings.json, reconciliation.json,
                                 startup.log (the detached daemon's stderr, reported by `daemon start`)
  sessions/<sessionId>.json      one SessionRecord per session, the registry
  queue/commands.jsonl           durable command journal
  index/events.jsonl             frontend event stream
  index/viewer/<sha256(id)>.*    normalized viewer events, checkpoints, snapshot, acks
  runs/<hash>/                   worker.stdout.log, worker.stderr.log, worker-replay.jsonl,
                                 diagnostics/ (rotating raw RPC frames and Pi stderr)
```

Two things live outside that root. Canonical Pi session files stay wherever Pi's own `SessionManager` puts them ([runtime/launch-resolver.mjs:44](runtime/launch-resolver.mjs#L44)). Managed worktrees live under `<pi agent dir>/pi-dashboard/worktrees` ([isolation/launch-preflight.mjs:151](isolation/launch-preflight.mjs#L151)).

## 4. Invariants you must not break

Each of these is enforced in code today. Breaking one is a product change, not a refactor.

- **One composer, everyone else observes.** The daemon grants the `composer` role only when no other socket holds it ([runtime/daemon.mjs:856](runtime/daemon.mjs#L856)). Every durable mutation requires a composer claim on the requesting socket; an observer gets `OBSERVER_READ_ONLY` and a socket with no claim gets `ATTACHMENT_REQUIRED` ([runtime/daemon.mjs:1100](runtime/daemon.mjs#L1100)). Observers can follow, scroll, and inspect tools; the viewer has no transcript search. They cannot prompt, steer, interrupt, stop, or delete.
- **One worker per session, bound to one canonical session file.** Ownership is a lease with a random ID and a monotonic generation, acquired before the Pi child opens the file; a second owner fails with an ownership conflict, and a mismatched file fails with `CANONICAL_SESSION_MISMATCH` ([runtime/ownership.mjs:155](runtime/ownership.mjs#L155)). The worker re-checks after start: if Pi's `get_state` does not return the canonical path, the run aborts ([runtime/installed-pi-worker.mjs:148](runtime/installed-pi-worker.mjs#L148)).
- **Delete never unlinks a session file or removes a worktree.** The production runtime passes no trash seam, so Delete forgets the dashboard record and leaves Pi's session file and the worktree untouched ([runtime/daemon.mjs:1261](runtime/daemon.mjs#L1261)). Worktree removal is a separate, full-ID confirmed cleanup that refuses live ownership, dirty or untracked files, and unpushed or divergent commits ([isolation/cleanup.mjs:219](isolation/cleanup.mjs#L219)). Stop and Delete both bind an exact registry revision.
- **Locks and leases are reclaimed only from provably dead holders.** A worktree ownership lock is swept only when its directory predates this daemon's start and its recorded holder is gone ([isolation/lock-sweep.mjs:33](isolation/lock-sweep.mjs#L33)). Process identity means PID plus start identity plus process-group ID read from Linux `/proc` ([runtime/process-identity-linux.mjs](runtime/process-identity-linux.mjs)); anything unreadable, changed, or ambiguous raises `AMBIGUOUS_IDENTITY` and the operation fails closed rather than signaling. A lock whose record carries no complete holder identity is never swept, because age alone cannot tell a dead daemon's leftovers from a live holder writing an older format; clear such a lock by hand, with the daemon and its workers stopped, after reading the record to confirm no live holder. The sweep also rereads the lock directory's device and inode and the token bytes immediately before removal, so a lock replaced mid-sweep survives.
- **Frontends see normalized viewer snapshots, never raw RPC frames.** Worker frames are ingested inside the daemon by [runtime/viewer-normalizer.mjs](runtime/viewer-normalizer.mjs) and persisted by [runtime/viewer-store.mjs](runtime/viewer-store.mjs); clients receive only shapes that pass [shared/viewer-contracts.mjs](shared/viewer-contracts.mjs). Raw frames and Pi stderr can contain prompts and provider errors, so they stay in `runs/<hash>/diagnostics` under rotation (four 8 MiB RPC segments, one 8 MiB stderr file by default).
- **Public package-root Pi imports only.** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, no deep `dist/` or `src/` paths, no copied Pi source, no `InteractiveMode`, no in-process `AgentSession`. [test/public-pi-imports.test.mjs](test/public-pi-imports.test.mjs) pins this and also instantiates each imported component to catch a removed export.
- **The version-1 contract is frozen and strictly validated.** `parseClientRequest` and `parseDaemonResponse` reject a wrong version, an unknown operation, an unknown field, a non-plain object, and an out-of-range value ([shared/contracts.mjs](shared/contracts.mjs)). A new field is a contract change: edit the parser, the type comment, and `shared/contracts.test.mjs` together, and check every producer.
- **The daemon is the only registry writer**, and every mutation for one session runs under that session's lifecycle serialization.

## 5. Conventions

- Tests sit beside their source and end in `.test.mjs`: `runtime/worker.mjs` pairs with `runtime/worker.test.mjs`. This repo does not use the `_test` suffix. Cross-cutting suites live in `test/` as `*.integration.test.mjs` and `*.acceptance.test.mjs`; vitest picks up `**/*.test.{ts,mjs}` ([vitest.config.ts](vitest.config.ts)).
- Write the failing test first, watch it fail, then implement. Before committing, run your focused files, then the full suite, then `pixi run typecheck`.
- Tests use no live model inference. Bounded fake executables ([test/fixtures/fake-pi.mjs](test/fixtures/fake-pi.mjs)) and deterministic process inspectors ([runtime/test-fixtures.mjs](runtime/test-fixtures.mjs)) stand in for Pi and for `/proc`.
- The code is JavaScript with JSDoc types checked by TypeScript. `tsconfig.json` covers `bin/`, `isolation/`, `runtime/`, and `shared/` in strict mode, including their test files; `tsconfig.app.json` covers `app/` and `cli/` non-strict and excludes tests.
- Comments earn their place. Keep a measured number, a stated ordering constraint, or a specific trap. Delete anything that restates the code.
- Prefer small additive edits. The daemon's failpoint seams, journal stage transitions, and lock ordering encode recovery behavior that is cheap to break and expensive to re-verify.

## 6. Known traps

- **The wheel-input tap depends on pi-tui input ordering.** `TuiAltScreen.handleViewportInput` in pi-tui 0.84.3 parses wheel bytes and consumes them before any child dispatch, so a wheel event cannot reach a component. [app/mouse-input.mjs](app/mouse-input.mjs) therefore reads wheel reports ahead of the TUI and passes every other byte through untouched. Two canary tests at the end of [app/mouse-input.test.mjs](app/mouse-input.test.mjs) assert that pi-tui still has no component mouse seam; when they fail, pi-tui grew one and this module should be deleted rather than patched.
- **Escape cannot drain Pi's queued messages.** In the viewer, Escape interrupts a working session and a second Escape leaves ([app/viewer/viewer-controller.mjs:233](app/viewer/viewer-controller.mjs#L233)). It cannot clear the queue, because the RPC exposes no queue-clearing command: the adapter has `abort` and nothing else that touches queued steering or follow-ups ([runtime/pi-rpc-adapter.mjs:263](runtime/pi-rpc-adapter.mjs#L263)). The queued block the viewer draws is the frontend's own mirror of what it sent, cleared when the turn ends, not a read of Pi's queue.
- **Summaries are opt-in and cost tokens.** `settings.summaryModel` defaults to `null` ([runtime/summaries.mjs:34](runtime/summaries.mjs#L34)). When an operator sets one, the daemon spawns real `pi --print --no-session --no-tools` inference to write session names and one-line summaries. Never enable it in a test or a default, and never point it at the operator's configuration.
- **Nested submitit and live model inference are out of scope here.** This repository runs on the local machine through Pixi and vitest. There is no SLURM path, and no test may make a provider request.
- Anything that signals a process must revalidate identity immediately before the signal. The `stopVerifiedProcessGroup` path in [runtime/process-signaler.mjs](runtime/process-signaler.mjs) exists for this; do not call `process.kill` directly.

## 7. Known drift between docs and code

The design doc and README are older than parts of the code. Where they conflict, believe the code.

- The README says Delete "uses an approved public Pi trash capability" and returns `TRASH_CAPABILITY_UNAVAILABLE` when that capability is absent. No such error code exists anywhere in the source. The default runtime supplies no trash seam, so Delete simply removes the registry record ([runtime/daemon.mjs:1261](runtime/daemon.mjs#L1261)).
- The design doc's viewer return table gives Escape and Left the same two-key, 500 ms gesture ([docs/superpowers/specs/2026-08-25-pi-dashboard-design.md:109](docs/superpowers/specs/2026-08-25-pi-dashboard-design.md#L109)). In the code only Left uses that gesture. Escape interrupts a working session, and otherwise returns immediately because the draft is persisted ([app/viewer/viewer-controller.mjs:233](app/viewer/viewer-controller.mjs#L233)).
- `test/package.acceptance.test.mjs` fails inside a git worktree whose `node_modules` is a symlink to another checkout: `npm pack` then emits bundled-dependency entries outside `package/node_modules/`, which the tarball filter does not exclude. That failure is an artifact of the checkout layout, not of the package.
