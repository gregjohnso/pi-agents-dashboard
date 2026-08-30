# Development

How to build, test, and change `pi-agents`. For what the tool does, read [README.md](../README.md). For how it is put together, read [architecture.md](architecture.md).

## Commands

All commands go through Pixi ([pixi.toml](../pixi.toml)):

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

Focused runs use the raw vitest task:

```bash
pixi run vitest -- run app/mouse-input.test.mjs --testTimeout=20000
```

The suite is 901 tests across 90 files. A full run takes about 3 minutes on an unloaded machine and can take twice that under load.

## Tests

Tests sit beside their source and end in `.test.mjs`: `runtime/worker.mjs` pairs with `runtime/worker.test.mjs`. Cross-cutting suites live in `test/` as `*.integration.test.mjs` and `*.acceptance.test.mjs`. Vitest collects `**/*.test.{ts,mjs}` ([vitest.config.ts](../vitest.config.ts)).

Write the failing test first and watch it fail for the right reason. Every test must name an operator-visible failure it catches; a test that cannot name one should be deleted rather than kept.

No test may run model inference or make a provider request. Bounded fake executables ([test/fixtures/fake-pi.mjs](../test/fixtures/fake-pi.mjs)) and deterministic process inspectors ([runtime/test-fixtures.mjs](../runtime/test-fixtures.mjs)) stand in for Pi and for `/proc`.

Every test builds its own state root with `mkdtemp` and passes it explicitly. A test that starts a daemon is responsible for stopping it.

Real-process acceptance suites are timing sensitive. On a loaded shared machine they fail as timeouts; rerun a suspicious failure in isolation with a longer `--testTimeout` before believing it.

## Measurements

`perf/` holds measurements, not tests. They spawn real processes, and the cold-launch driver runs real model inference, so no collected test file imports one and `pixi run test` never executes one. Neither `tsconfig.json` nor `tsconfig.app.json` covers `perf/`.

[perf/transition-latency.mjs](../perf/transition-latency.mjs) times the list-to-viewer transition under a real pseudo-terminal, using the fake Pi.

[perf/cold-launch.mjs](../perf/cold-launch.mjs) takes one cold-launch sample against the installed Pi: journal acceptance, worker spawn, Pi child spawn, readiness persistence, and the first viewer snapshot read after the row already shows persisted readiness, plus worker and Pi resident set size after 60 idle seconds. It spends provider tokens and refuses to start outside a SLURM allocation. [perf/cold_launch_launcher.py](../perf/cold_launch_launcher.py) submits 30 independent samples as one `map_array` on `l40-reserved`, then reduces them:

```bash
pixi run measure-cold-launch --out <directory>
```

Every sample builds its own state root, its own Pi agent directory holding only symbolic links to credentials and the model catalog, and its own disposable Git repository, then removes all three.

Four of the five instants need no product change. Journal acceptance comes from the command journal's `acceptedAt`. The worker and Pi child spawn instants come from the Linux process start ticks already stored in the session record's ownership and runtime identities, converted through the boot instant; each sample re-derives its own start the same way and records the residual, which measured about 100 ms and is mostly Node's own startup. The first usable snapshot comes from the measuring client's clock. Only readiness persistence has no durable trace, because the row's `updatedAt` moves on as soon as the first turn starts; [runtime/launch-trace.mjs](../runtime/launch-trace.mjs) supplies it and writes nothing at all unless `PI_AGENTS_LAUNCH_TRACE` names a destination.

The result of the first run is recorded in [cold-launch-measurement.md](cold-launch-measurement.md).

Samples run at most six at a time. Thirty concurrent samples made `pi --help` exceed the daemon's 5 s capability-probe timeout on a shared network filesystem, and 28 of 30 launches failed with `PI_PROBE_TIMEOUT`.

## Code

The code is JavaScript with JSDoc types checked by TypeScript. `tsconfig.json` covers `bin/`, `isolation/`, `runtime/`, and `shared/` in strict mode, including their test files. `tsconfig.app.json` covers `app/` and `cli/` non-strict and excludes tests.

Comments earn their place. Keep a measured number, a stated ordering constraint, or a specific trap. Delete anything that restates the code.

Prefer small additive edits. The daemon's failpoint seams, journal stage transitions, and lock ordering encode recovery behavior that is cheap to break and expensive to re-verify.

## Constraints that are not visible in the code

**The wheel-input tap depends on pi-tui input ordering.** `TuiAltScreen.handleViewportInput` in pi-tui 0.84.3 parses wheel bytes and consumes them before any child dispatch, so a wheel event cannot reach a component. [app/mouse-input.mjs](../app/mouse-input.mjs) reads wheel reports ahead of the TUI and passes every other byte through untouched. Two canary tests at the end of [app/mouse-input.test.mjs](../app/mouse-input.test.mjs) assert that pi-tui still has no component mouse seam. When they fail, pi-tui grew one and this module should be deleted rather than patched.

**`/cwd` completion is pi-tui's file completion, and it lists synchronously.** [app/list/path-completion.mjs](../app/list/path-completion.mjs) calls `CombinedAutocompleteProvider` from the pi-tui 0.84.3 package root. Two things about it are invisible at the call site. It reads a line beginning with `/` as a slash command, so the typed path is completed as a line of its own and only the rewrite in `applyCompletion` sees the whole `/cwd` line. Its file listing is `readdirSync`, so the `AbortSignal` it accepts cancels nothing on that path: [`DashboardController.scheduleCwdCompletion`](../app/list/dashboard.mjs) keeps the listing off the keystroke with a 60 ms debounce and drops a result the operator has already typed past. A canary in [app/list/path-completion.test.mjs](../app/list/path-completion.test.mjs) asserts the provider is still exported from the package root.

**Escape cannot drain Pi's queued messages.** The RPC exposes no queue-clearing command; the adapter has `abort` and nothing else ([runtime/pi-rpc-adapter.mjs](../runtime/pi-rpc-adapter.mjs)). The queued block the viewer draws is the frontend's own mirror of what it sent, not a read of Pi's queue.

**Summaries are opt-in and cost tokens.** `settings.summaryModel` defaults to `null` ([runtime/summaries.mjs](../runtime/summaries.mjs)). Setting it makes the daemon spawn real `pi --print --no-session --no-tools` inference to write names and one-line summaries. Never enable it in a test or a default.

**A frontend that falls behind resynchronizes; it does not fail.** Overflow drops the backlog and yields one `resynchronize` marker; the list refetches `get_state` and continues from the position that snapshot covers. Do not raise the queue bound instead. Correctness lives in the resync path, not in the constant.

**Anything that signals a process must revalidate identity immediately before the signal.** Use `stopVerifiedProcessGroup` ([runtime/process-signaler.mjs](../runtime/process-signaler.mjs)). Never call `process.kill` directly.

**Renaming anything that crosses a process boundary is an outage, not a refactor.** A running daemon holds old code in memory while spawning workers from new code on disk, so a renamed environment variable, frame type, or path is read by one side and not the other until the daemon restarts. Version the contract, or accept both names for a release.

**`test/package.acceptance.test.mjs` fails in a worktree whose `node_modules` is a symlink.** `npm pack` then emits bundled-dependency entries outside `package/node_modules/`, which the tarball filter does not exclude. That is a checkout-layout artifact, not a packaging defect.
