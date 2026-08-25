# Pi Agents Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained Pi package, installable from npm or a local path, whose machine-local daemon owns concurrent Pi sessions, whose native Pi frontend can detach and reattach without stopping work, and whose Jobwatch-style TUI exposes launch, navigation, conversation, stop, delete, and recovery workflows.

**Architecture:** One daemon owns registry, command journals, event cursors, worker process groups, and session-file writer leases. Pi RPC workers remain detached from terminal lifetimes; the global extension is a frontend that renders the dashboard and attaches Pi's native interactive surface through a host capability adapter. Pure state, protocol, rendering, isolation, and recovery modules are developed against fakes while the native host seam is proven or added upstream.

**Tech Stack:** Node.js 22.19+, TypeScript 5.9, plain ESM JavaScript for detached runtime entrypoints, Vitest, Pi 0.84.3 public package/RPC/session/TUI APIs, Unix sockets, POSIX process groups, Git worktrees, Pixi.

**Spec:** `docs/superpowers/specs/2026-08-25-pi-agents-dashboard-design.md`

## Document responsibility

This file is the authoritative implementation guide. It owns file boundaries, shared interfaces, dependency order, parallel lanes, test-driven steps, commands, and milestone gates. It implements the design without redefining product behavior.

The [design spec](2026-08-25-pi-agents-dashboard-design.md) controls product requirements and open decisions. The [task list](2026-08-25-pi-agents-dashboard-tasklist.md) records execution status. Global constraints below are copied here so each implementation task is self-contained; the design wins if wording diverges. Implementation discoveries that change behavior return to the design for approval before this plan changes.

## Global Constraints

- The dashboard covers Pi sessions on the current machine only.
- `/agents` and the Left gesture must be available from every supported Pi session that loads the installed package.
- Canonical installation is `pi install npm:pi-agents-dashboard`; local development uses `pi install /absolute/path/to/pi-agents-dashboard`.
- The Pi-installed package is self-contained and starts its package-relative local runtime without a global CLI on `PATH`.
- `npm install -g pi-agents-dashboard` is optional and provides CLI access; `pi-agents-dashboard install` registers that canonical package root with Pi.
- npm lifecycle scripts are not required; installation works with `--ignore-scripts`.
- A clean empty editor opens the dashboard with one Left; editing or history navigation requires a second Left within 500 ms.
- Ctrl+C closes the dashboard list but interrupts an attached native Pi session; Left or Escape detaches an attached session.
- Ctrl+X on a live session confirms Stop; a later Ctrl+X on the inactive session confirms Delete.
- Closing a dashboard, frontend, renderer, shell, or SSH connection must not signal a worker.
- One shared daemon is the only registry and lifecycle writer; one worker is the only writer for each Pi session file.
- Git launches use isolated worktrees by default. Shared writable directories require an explicit request and confirmation.
- Task state, process state, outcome, and activity remain separate data dimensions.
- The package must fail closed when daemon-owned startup or native attachment is unavailable. It must not substitute a reduced transcript renderer.
- Runtime state lives under the effective Pi configuration directory and is private to the current operating-system user.
- Detached runtime entrypoints are plain `.mjs`; extension source is TypeScript; tests live beside source except system harness fixtures.
- Use TDD for every behavior change. Run commands through Pixi after Task 1 creates the environment.
- Tests use fake providers and bounded local processes. Do not make real model requests or run model inference on the login node.
- All tests run locally through Pixi. Do not submit tests through SLURM or submitit.
- Do not depend on tmux for production lifetime. tmux is allowed only in the end-to-end test harness.
- Do not resolve product decisions silently. Task 3 records explicit approved values before protocol and configuration freeze.

## Current Feasibility Finding

Pi 0.84.3 can install an npm or local-path Pi package, open extension UI, list sessions, and run detached RPC workers. Its public extension API does not replace the local `AgentSessionRuntime` before the model loop starts. `InteractiveMode` accepts a local runtime and exposes no public remote attach/detach adapter. The experimental `PiClient` and `RemoteSession` client packages are present, but no server implementation is packaged and they do not expose Pi's native interactive frontend.

Task 2 is therefore a release gate. Tasks that use pure contracts and fake host adapters may continue in parallel, but Task 14 and release acceptance remain blocked until Pi exposes the startup and native-attachment hooks required by a normally installed package. The optional CLI cannot substitute for that host support.

## Execution Strategy and Parallel Lanes

1. Task 1 establishes the committed scaffold. No managed worktree fanout is possible before that commit.
2. Tasks 2 and 3 run in parallel after Task 1. Task 2 proves host capability; Task 3 records product and protocol decisions.
3. Task 4 freezes shared contracts after Task 3. It is the merge gate for parallel implementation.
4. After Task 4, run these in isolated worktrees:
   - Lane A: Task 5, pure state and session index.
   - Lane B: Task 6, runtime safety primitives.
   - Lane C: Task 12, pure TUI layout and virtual rows, after Task 5 publishes row-model contracts.
5. After Task 6, run Tasks 7, 8, and 9 concurrently in separate worktrees. They own registry, journal, and isolation files respectively.
6. Task 10 integrates Tasks 7 and 8 into workers. Task 11 then integrates workers into the daemon and CLI.
7. Task 13 integrates the pure dashboard with the daemon client. Task 14 integrates the native host adapter only after Task 2 passes on a supported Pi host.
8. Task 15 adds destructive workflows and cleanup. Task 16 runs parallel security, performance, packaging, and user-flow validation, then one writer applies accepted findings.
9. Each task is committed independently. Integrate parallel task branches serially in dependency order, run `pixi run test` after each integration, and resolve shared-contract conflicts in the parent rather than in worker branches.

## File and Responsibility Map

```text
pi-agents-dashboard/
├── package.json                         # npm package, Pi manifest, scripts, peer dependencies
├── package-lock.json                    # deterministic npm resolution
├── pixi.toml                            # Node/Git environment and verification tasks
├── pixi.lock
├── tsconfig.json                        # TypeScript plus checkJs for runtime modules
├── vitest.config.ts
├── README.md                            # installation, support boundary, operation, recovery
├── LICENSE
├── bin/
│   └── pi-agents-dashboard.mjs          # public CLI entrypoint
├── cli/
│   ├── main.mjs                         # argv parser and exit-code mapping
│   ├── main.test.mjs
│   ├── daemon-commands.mjs              # start/status/restart/recover/stop
│   ├── daemon-commands.test.mjs
│   ├── package-commands.mjs             # register/remove global npm package root with Pi
│   ├── package-commands.test.mjs
│   ├── session-commands.mjs             # status/stop/delete/log lookup
│   └── session-commands.test.mjs
├── shared/
│   ├── contracts.ts                     # wire, session, launch, state, and error types
│   ├── contracts.test.ts
│   ├── config.ts                        # validated global policy and approved defaults
│   └── config.test.ts
├── runtime/
│   ├── daemon.mjs                       # daemon composition root
│   ├── daemon.integration.test.mjs
│   ├── control-server.mjs               # authenticated Unix socket protocol
│   ├── control-server.test.mjs
│   ├── daemon-lifecycle.mjs              # singleton start/restart/stop
│   ├── daemon-lifecycle.test.mjs
│   ├── worker.mjs                       # detached worker entry and reconnect loop
│   ├── worker-supervisor.mjs            # spawn/readiness/cap/exit observation
│   ├── worker-supervisor.test.mjs
│   ├── pi-rpc-adapter.mjs               # narrow Pi RPC boundary
│   ├── pi-rpc-adapter.test.mjs
│   ├── registry-store.mjs                # atomic session records
│   ├── registry-store.test.mjs
│   ├── ownership.mjs                    # canonical session-file writer leases
│   ├── ownership.test.mjs
│   ├── session-coordinator.mjs           # per-session lifecycle serialization
│   ├── session-coordinator.test.mjs
│   ├── command-journal.mjs               # durable request state machine
│   ├── command-journal.test.mjs
│   ├── event-store.mjs                   # persisted event stream and cursor replay
│   ├── event-store.test.mjs
│   ├── reconciliation.mjs                # daemon restart and worker replay
│   ├── reconciliation.failure.test.mjs
│   ├── state-reducer.mjs                 # normalized RPC event to registry state
│   ├── state-reducer.test.mjs
│   ├── jsonl.mjs                         # bounded incremental UTF-8/LF framing
│   ├── jsonl.test.mjs
│   ├── atomic-file.mjs                   # write/fsync/rename/directory-fsync
│   ├── atomic-file.test.mjs
│   ├── paths.mjs                         # runtime and canonical session paths
│   ├── paths.test.mjs
│   ├── permissions.mjs                   # owner/mode/symlink checks
│   ├── permissions.test.mjs
│   ├── lifecycle-lock.mjs                # token-bearing singleton lock
│   ├── lifecycle-lock.test.mjs
│   ├── process-identity-linux.mjs         # PID/start ticks/PGID inspection
│   ├── process-identity-linux.test.mjs
│   ├── process-signaler.mjs               # verified graceful/TERM/KILL escalation
│   ├── process-signaler.test.mjs
│   └── test-fixtures.mjs                  # fake clock/fs/process/Pi RPC/failpoints
├── isolation/
│   ├── launch-preflight.mjs              # canonical cwd, warnings, trust, isolation request
│   ├── launch-preflight.test.mjs
│   ├── worktree.mjs                      # creation and metadata
│   ├── worktree.test.mjs
│   ├── shared-directory.mjs              # exact-path confirmation
│   ├── shared-directory.test.mjs
│   ├── cleanup.mjs                       # guarded worktree cleanup
│   └── cleanup.test.mjs
├── extensions/agents-dashboard/
│   ├── index.ts                          # extension registration and disposal
│   ├── compatibility.ts                  # host capability probe
│   ├── compatibility.test.ts
│   ├── daemon-client.ts                  # reconnecting typed client
│   ├── daemon-client.test.ts
│   ├── dashboard-types.ts                # UI/backend facade
│   ├── dashboard-state.ts                # pure reducer/selectors
│   ├── dashboard-state.test.ts
│   ├── dashboard-layout.ts               # width-safe Jobwatch-style rendering
│   ├── dashboard-layout.test.ts
│   ├── dashboard-theme.ts                # semantic palette
│   ├── virtual-session-list.ts            # virtual rows and cache
│   ├── virtual-session-list.test.ts
│   ├── launch-composer.ts                # composer and full launch form
│   ├── launch-composer.test.ts
│   ├── dashboard-overlays.ts             # metadata/help/warning/confirmations
│   ├── dashboard-overlays.test.ts
│   ├── key-gesture.ts                    # single/double Left state machine
│   ├── key-gesture.test.ts
│   ├── dashboard.ts                      # TUI controller and disposal
│   ├── dashboard.test.ts
│   ├── native-session-bridge.ts           # supported host attach/detach adapter only
│   └── native-session-bridge.contract.test.ts
└── test/
    ├── fixtures/                         # temporary sessions, Git repositories, fake provider
    ├── package.integration.test.mjs
    ├── lifecycle.integration.test.mjs
    └── dashboard.tmux.test.mjs
```

## Shared Interfaces

Task 4 owns these names. Later tasks may extend payload fields only through a reviewed contract change.

```ts
export type TaskState = "WORKING" | "WAITING" | "READY" | "FAILED" | "STOPPED";
export type ProcessState = "LIVE" | "SLEEPING" | "EXITED" | "STALE";
export type Outcome = "NONE" | "COMPLETED" | "READY_FOR_REVIEW";

export interface ProcessIdentity {
  pid: number;
  startIdentity: string;
  processGroupId: number;
}

export interface SessionRecord {
  schemaVersion: 1;
  revision: number;
  sessionId: string;
  sessionFile: string;
  canonicalSessionFile: string;
  cwd: string;
  name?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  taskState: TaskState;
  processState: ProcessState;
  outcome: Outcome;
  activity: { kind: string; summary: string; updatedAt: string };
  ownership?: WorkerOwnership;
  isolation?: IsolationRecord;
  latestRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export type CommandStage =
  | "ACCEPTED"
  | "DELIVERY_ATTEMPTED"
  | "WORKER_ACKNOWLEDGED"
  | "COMPLETED"
  | "DELIVERY_UNKNOWN"
  | "FAILED";

export interface EventCursor {
  daemonEpoch: string;
  sequence: string;
}
```

## Milestone 0: Repository and Feasibility

### Task 1: Scaffold the Package and Verification Harness

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `pixi.toml`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `README.md`
- Create: `LICENSE`
- Create: `bin/pi-agents-dashboard.mjs`
- Create: `extensions/agents-dashboard/index.ts`
- Create: `extensions/agents-dashboard/index.test.ts`

**Interfaces:**
- Produces a self-contained npm and Pi package.
- Produces optional npm binary `pi-agents-dashboard`.
- Produces Pi package manifest `pi.extensions = ["./extensions/agents-dashboard/index.ts"]`.
- Produces package-relative runtime discovery that does not depend on a global CLI.
- Produces Pixi tasks `install`, `typecheck`, `test-unit`, `test-integration`, `test`, and `pack-check`.

- [ ] **Step 1: Bootstrap Pixi and the test runner**

Create `pixi.toml` with Node `>=22.19,<23` and Git. Create a minimal private `package.json` containing only `type: "module"` and the pinned TypeScript, Vitest, Pi 0.84.3, and Node type development dependencies. Run `pixi run npm install` to create `package-lock.json`. This bootstrap has no Pi manifest or executable yet.

- [ ] **Step 2: Write the failing package-discovery test**

```ts
import manifest from "../../package.json";

it("ships one self-contained Pi extension and optional executable", () => {
  expect(manifest.bin).toEqual({ "pi-agents-dashboard": "./bin/pi-agents-dashboard.mjs" });
  expect(manifest.pi.extensions).toEqual(["./extensions/agents-dashboard/index.ts"]);
  expect(manifest.files).toEqual(expect.arrayContaining(["extensions", "runtime", "shared", "isolation"]));
  expect(manifest.engines.node).toBe(">=22.19.0");
});
```

- [ ] **Step 3: Run the test to verify the package contract fails**

Run: `pixi run vitest run extensions/agents-dashboard/index.test.ts`

Expected: FAIL because the bootstrap manifest has no `bin`, `files`, `pi`, or `engines` fields.

- [ ] **Step 4: Add the complete deterministic scaffold**

```json
{
  "name": "pi-agents-dashboard",
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=22.19.0" },
  "bin": { "pi-agents-dashboard": "./bin/pi-agents-dashboard.mjs" },
  "files": ["bin", "cli", "extensions", "runtime", "shared", "isolation", "README.md", "LICENSE"],
  "pi": { "extensions": ["./extensions/agents-dashboard/index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run --exclude '**/*.integration.test.*' --exclude '**/*.tmux.test.*'",
    "test:integration": "vitest run '**/*.integration.test.*'",
    "pack:check": "npm pack --dry-run --json"
  }
}
```

Use Pi `0.84.3`, TypeScript `5.9.3`, Vitest `4.1.9`, and Node types `22.19.19` as development dependencies. Configure `allowJs` and `checkJs` for `.mjs` runtime modules.

- [ ] **Step 5: Refresh the lockfile and run scaffold checks**

Run: `pixi run npm install && pixi run typecheck && pixi run test-unit && pixi run pack-check`

Expected: all commands exit 0. At this scaffold stage, the dry-run package contains the existing `bin/` and `extensions/` sources plus package metadata. The manifest already allowlists later `runtime/`, `shared/`, and `isolation/` sources. Runtime state, logs, sockets, sessions, and worktrees are absent.

- [ ] **Step 6: Create the initial commit**

```bash
pixi run git add package.json package-lock.json pixi.toml pixi.lock tsconfig.json vitest.config.ts README.md LICENSE bin extensions docs
pixi run git commit -m "chore: scaffold pi agents dashboard"
```

### Task 2: Prove the Pi Host Capability Seam

**Files:**
- Create: `extensions/agents-dashboard/compatibility.ts`
- Create: `extensions/agents-dashboard/compatibility.test.ts`
- Create: `test/host-capability.integration.test.mjs`
- Create: `docs/superpowers/specs/2026-08-25-pi-agents-dashboard-host-seam.md`

**Interfaces:**
- Produces `checkHostCapabilities(): Promise<HostCapabilityReport>`.
- Produces a release gate consumed by standard Pi-package startup, the optional CLI, Task 14, and `doctor`.

```ts
export interface HostCapabilityReport {
  piVersion: string;
  globalPackage: boolean;
  rpcWorker: boolean;
  daemonOwnedStartup: boolean;
  nativeAttach: boolean;
  composableLeftGesture: boolean;
  fullscreenCustomUi: boolean;
  blockers: readonly string[];
}
```

- [ ] **Step 1: Write capability tests against public exports**

```ts
it("reports unsupported rather than degrading on stock Pi 0.84.3", async () => {
  const report = await checkHostCapabilities();
  expect(report.globalPackage).toBe(true);
  expect(report.rpcWorker).toBe(true);
  expect(report.daemonOwnedStartup).toBe(false);
  expect(report.nativeAttach).toBe(false);
  expect(report.blockers.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the tests and capture the baseline failure**

Run: `pixi run vitest run extensions/agents-dashboard/compatibility.test.ts test/host-capability.integration.test.mjs`

Expected before implementation: FAIL because no capability probe exists.

- [ ] **Step 3: Implement feature probes without private imports**

Probe package exports, RPC entry availability, extension APIs, and the supported native backend adapter symbol. Do not import `dist/modes/interactive/*` or mutate private fields. Record the inspected Pi version and exact missing capabilities in the host-seam document.

- [ ] **Step 4: Add the decisive installed-package/native-attach integration fixture**

Install the package into a disposable Pi configuration, then start a fake daemon backend before frontend construction. Attempt native attach through public APIs, detach, and reattach without creating a second session writer or requiring a global CLI. On stock Pi 0.84.3, assert a typed unsupported result. On a future supported host, assert unchanged worker identity and native transcript/editor/tool surfaces.

- [ ] **Step 5: Run the gate**

Run: `pixi run vitest run extensions/agents-dashboard/compatibility.test.ts test/host-capability.integration.test.mjs`

Expected: tests pass by reporting stock Pi 0.84.3 unsupported. Release remains blocked until the same suite passes with `daemonOwnedStartup` and `nativeAttach` true on a supported host.

- [ ] **Step 6: Commit the evidence**

```bash
pixi run git add extensions/agents-dashboard/compatibility.* test/host-capability.integration.test.mjs docs/superpowers/specs/2026-08-25-pi-agents-dashboard-host-seam.md
pixi run git commit -m "test: define pi host compatibility gate"
```

### Task 3: Resolve Product and Protocol Decisions

**Files:**
- Modify: `docs/superpowers/specs/2026-08-25-pi-agents-dashboard-design.md`
- Create: `shared/config.ts`
- Create: `shared/config.test.ts`

**Interfaces:**
- Consumes approved decisions O1-O7 from the design spec's Open decisions section.
- Produces the matching validated configuration and protocol defaults.

- [ ] **Step 1: Present design decisions O1-O7 to the user**

Use the options and product language from the design spec. Record each approved outcome there before changing configuration or protocol code. Do not create a second decision record in this plan.

- [ ] **Step 2: Update the design spec with approved values and remove the resolved questions**

Do not encode defaults before approval. Preserve the design's no-degraded-frontend and one-writer rules.

- [ ] **Step 3: Write failing configuration tests using the approved values**

```ts
it("loads the reviewed first-release defaults", () => {
  expect(loadDashboardConfig({})).toEqual(REVIEWED_DEFAULT_CONFIG);
});

it("rejects unknown keys and invalid limits", () => {
  expect(() => loadDashboardConfig({ workers: { maxLive: 0 } })).toThrow();
  expect(() => loadDashboardConfig({ unexpected: true })).toThrow();
});
```

`REVIEWED_DEFAULT_CONFIG` contains the exact values added to the spec, not environment-dependent guesses.

- [ ] **Step 4: Implement strict config parsing and atomic serialization contract**

```ts
export interface DashboardConfig {
  schemaVersion: 1;
  workers: { maxLive: number | null; idleRetentionMs: number };
  history: { completedWindowHours: number | null; indexRefreshMs: number };
  daemon: { heartbeatMs: number; staleAfterMs: number; startTimeoutMs: number };
  stop: { gracefulMs: number; terminateMs: number };
}
```

- [ ] **Step 5: Run and commit**

Run: `pixi run vitest run shared/config.test.ts && pixi run test`

```bash
pixi run git add shared/config.* docs/superpowers/specs/2026-08-25-pi-agents-dashboard-design.md
pixi run git commit -m "docs: resolve dashboard release policies"
```

## Milestone 1: Shared Contracts and Pure Logic

### Task 4: Freeze Shared Contracts and JSONL Framing

**Files:**
- Create: `shared/contracts.ts`
- Create: `shared/contracts.test.ts`
- Create: `runtime/jsonl.mjs`
- Create: `runtime/jsonl.test.mjs`

**Interfaces:**
- Produces `ClientRequest`, `DaemonResponse`, `PersistedEvent`, `SessionRecord`, `LaunchRequest`, `CommandStatus`, `DashboardError`, and incremental JSONL encoder/decoder.
- Consumes the decisions recorded in Task 3.

- [ ] **Step 1: Write schema and framing tests**

```ts
it("decodes split UTF-8 and coalesced LF records", () => {
  const decoder = createJsonlDecoder({ maxBytes: 1024 });
  expect(decoder.push(Buffer.from('{"op":"get_'))).toEqual([]);
  expect(decoder.push(Buffer.from('state"}\n{"op":"ack"}\n'))).toHaveLength(2);
});

it("rejects unknown operations and oversized records", () => {
  expect(parseClientRequest({ version: 1, op: "shell", requestId: "r" })).toThrow();
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pixi run vitest run shared/contracts.test.ts runtime/jsonl.test.mjs`

Expected: FAIL because the schemas and decoder do not exist.

- [ ] **Step 3: Implement exact discriminated unions**

The request union must include `get_state`, `launch`, `attach`, `detach`, `prompt`, `steer`, `follow_up`, `interrupt`, `stop`, `delete`, `ui_response`, `subscribe`, `ack`, and the approved `DELIVERY_UNKNOWN` resolution operation. Every request carries protocol version, client ID, request ID, and exact structured payload. Unknown operations and unknown destructive fields fail closed.

- [ ] **Step 4: Implement bounded incremental framing**

Use `TextDecoder` in fatal streaming mode, LF framing, optional trailing CR, and a byte limit enforced before JSON parsing. Return typed framing errors; never execute a partially parsed message.

- [ ] **Step 5: Run contract checks and commit**

Run: `pixi run typecheck && pixi run vitest run shared/contracts.test.ts runtime/jsonl.test.mjs`

```bash
pixi run git add shared runtime/jsonl.*
pixi run git commit -m "feat: define dashboard protocol contracts"
```

### Task 5: Implement State Reduction and Session Indexing

**Files:**
- Create: `runtime/state-reducer.mjs`
- Create: `runtime/state-reducer.test.mjs`
- Create: `extensions/agents-dashboard/dashboard-state.ts`
- Create: `extensions/agents-dashboard/dashboard-state.test.ts`
- Create: `extensions/agents-dashboard/session-index.ts`
- Create: `extensions/agents-dashboard/session-index.test.ts`

**Interfaces:**
- Consumes `SessionRecord`, state enums, and saved Pi `SessionInfo` records.
- Produces `reduceSessionState`, `selectDashboardSessions`, `mergeSessionIndex`, and deterministic counts.

- [ ] **Step 1: Write table-driven state tests**

```ts
it.each([
  ["WORKER_READY", "READY", "LIVE", "NONE"],
  ["TURN_STARTED", "WORKING", "LIVE", "NONE"],
  ["TURN_COMPLETED", "READY", "LIVE", "COMPLETED"],
  ["WORKER_SLEEPING", "READY", "SLEEPING", "COMPLETED"],
  ["USER_STOPPED", "STOPPED", "EXITED", "NONE"],
])("maps %s independently", (event, taskState, processState, outcome) => {
  expect(reduceSessionState(baseRecord, { type: event, at: now })).toMatchObject({ taskState, processState, outcome });
});
```

Add activity precedence, frontend-detach no-op, crash, stale identity, and `READY + LIVE/SLEEPING/EXITED` cases.

- [ ] **Step 2: Write index and selector tests**

Cover canonical session-file aliases, duplicate IDs, malformed saved sessions, top-level filtering, Live/Done/All membership, search across every specified field, stable sorting, grouping, and history policy injection.

- [ ] **Step 3: Run the tests and verify failure**

Run: `pixi run vitest run runtime/state-reducer.test.mjs extensions/agents-dashboard/dashboard-state.test.ts extensions/agents-dashboard/session-index.test.ts`

- [ ] **Step 4: Implement pure reducers and selectors**

```ts
export function mergeSessionIndex(
  saved: readonly SessionInfo[],
  live: readonly SessionRecord[],
): readonly SessionRecord[];

export function selectDashboardSessions(
  sessions: readonly SessionRecord[],
  query: DashboardQuery,
): readonly SessionRecord[];
```

No filesystem watchers, TUI imports, timers, or daemon writes belong in these modules.

- [ ] **Step 5: Run and commit**

Run: `pixi run typecheck && pixi run vitest run runtime/state-reducer.test.mjs extensions/agents-dashboard/dashboard-state.test.ts extensions/agents-dashboard/session-index.test.ts`

```bash
pixi run git add runtime/state-reducer.* extensions/agents-dashboard/dashboard-state.* extensions/agents-dashboard/session-index.*
pixi run git commit -m "feat: add session state and index logic"
```

### Task 6: Implement Runtime Safety Primitives

**Files:**
- Create: `runtime/paths.mjs`
- Create: `runtime/paths.test.mjs`
- Create: `runtime/permissions.mjs`
- Create: `runtime/permissions.test.mjs`
- Create: `runtime/atomic-file.mjs`
- Create: `runtime/atomic-file.test.mjs`
- Create: `runtime/lifecycle-lock.mjs`
- Create: `runtime/lifecycle-lock.test.mjs`
- Create: `runtime/process-identity-linux.mjs`
- Create: `runtime/process-identity-linux.test.mjs`
- Create: `runtime/process-signaler.mjs`
- Create: `runtime/process-signaler.test.mjs`
- Create: `runtime/test-fixtures.mjs`

**Interfaces:**
- Produces canonical runtime paths, private artifact creation, atomic JSON publication, token-bearing lifecycle locks, PID/start/PGID inspection, and verified process-group signaling.

- [ ] **Step 1: Write hostile-filesystem and atomic-write tests**

Cover symlinked roots, wrong owner/mode, same-directory temp files, failures before and after rename, torn writes, directory fsync errors, and socket-path length refusal.

- [ ] **Step 2: Write PID reuse and exact-signal tests**

```js
it("refuses escalation after process identity changes", async () => {
  inspector.setSequence([recordedIdentity, reusedIdentity]);
  const result = await stopVerifiedProcessGroup(ownership, deps);
  expect(result.disposition).toBe("STALE_IDENTITY");
  expect(signaler.calls).toEqual([]);
});
```

Also keep an unrelated sentinel process group alive in integration tests.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `pixi run vitest run runtime/paths.test.mjs runtime/permissions.test.mjs runtime/atomic-file.test.mjs runtime/lifecycle-lock.test.mjs runtime/process-identity-linux.test.mjs runtime/process-signaler.test.mjs`

- [ ] **Step 4: Implement the injected primitives**

```js
export async function atomicWriteJson(path, value, fsOps) {}
export async function acquireLifecycleLock(path, owner, fsOps) {}
export async function inspectProcessIdentity(pid, procFs) {}
export async function stopVerifiedProcessGroup(ownership, deps, policy) {}
```

Set `umask(0o077)`. Directories are `0700`; files are `0600`; the control socket is chmod `0600`. Revalidate identity before each graceful, TERM, and KILL boundary.

- [ ] **Step 5: Run and commit**

Run: `pixi run typecheck && pixi run vitest run runtime/{paths,permissions,atomic-file,lifecycle-lock,process-identity-linux,process-signaler}.test.mjs`

```bash
pixi run git add runtime
pixi run git commit -m "feat: add secure runtime primitives"
```

## Milestone 2: Durable Daemon Foundations

### Task 7: Implement Registry, Ownership, and Per-Session Serialization

**Files:**
- Create: `runtime/registry-store.mjs`
- Create: `runtime/registry-store.test.mjs`
- Create: `runtime/ownership.mjs`
- Create: `runtime/ownership.test.mjs`
- Create: `runtime/session-coordinator.mjs`
- Create: `runtime/session-coordinator.test.mjs`

**Interfaces:**
- Consumes Task 4 contracts and Task 6 atomic/path/process primitives.
- Produces `RegistryStore`, `OwnershipManager`, and `SessionCoordinator`.

- [ ] **Step 1: Write atomic registry and revision tests**

Test create, compare-and-swap update, canonical-file uniqueness, corrupted JSON refusal, heartbeat updates, imported records, and atomic recovery.

- [ ] **Step 2: Write concurrent ownership tests**

```js
it("permits one writer under simultaneous resume", async () => {
  const [a, b] = await Promise.allSettled([
    ownership.acquire(sessionId, canonicalFile, "run-a"),
    ownership.acquire(sessionId, canonicalFile, "run-b"),
  ]);
  expect([a, b].filter(x => x.status === "fulfilled")).toHaveLength(1);
});
```

The test uses only subsecond in-memory coordination. Material process integration remains in Task 10.

- [ ] **Step 3: Run and verify failure**

Run: `pixi run vitest run runtime/registry-store.test.mjs runtime/ownership.test.mjs runtime/session-coordinator.test.mjs`

- [ ] **Step 4: Implement registry and leases**

```js
export class RegistryStore {
  async list() {}
  async get(sessionId) {}
  async create(record) {}
  async update(sessionId, expectedRevision, update) {}
}

export class OwnershipManager {
  async acquire(sessionId, canonicalSessionFile, runId) {}
  async bindProcesses(sessionId, leaseId, worker, piChild) {}
  async release(sessionId, leaseId) {}
}
```

A lease generation and random lease ID prevent stale worker hello and stale release. The keyed coordinator removes idle locks and does not serialize unrelated session IDs.

- [ ] **Step 5: Run and commit**

Run: `pixi run typecheck && pixi run vitest run runtime/registry-store.test.mjs runtime/ownership.test.mjs runtime/session-coordinator.test.mjs`

```bash
pixi run git add runtime/registry-store.* runtime/ownership.* runtime/session-coordinator.*
pixi run git commit -m "feat: enforce single session ownership"
```

### Task 8: Implement Durable Commands, Events, and Frontend Protocol

**Files:**
- Create: `runtime/command-journal.mjs`
- Create: `runtime/command-journal.test.mjs`
- Create: `runtime/event-store.mjs`
- Create: `runtime/event-store.test.mjs`
- Create: `runtime/control-server.mjs`
- Create: `runtime/control-server.test.mjs`
- Create: `extensions/agents-dashboard/daemon-client.ts`
- Create: `extensions/agents-dashboard/daemon-client.test.ts`

**Interfaces:**
- Consumes Task 4 schemas and Task 6 persistence/framing.
- Produces durable command status, persisted event cursors, authenticated socket handling, and reconnecting frontend requests.

- [ ] **Step 1: Write journal boundary tests with deterministic failpoints**

Crash before sync, after sync before response, after delivery attempt, after worker acknowledgement, and after event persistence before broadcast. Assert duplicate request IDs return the same status; a changed payload with the same ID returns `IDEMPOTENCY_CONFLICT`.

- [ ] **Step 2: Write event replay and socket validation tests**

Cover cursor replay strictly after the acknowledged sequence, daemon epoch mismatch, slow-subscriber bounds, wrong token, wrong protocol version, malformed/oversized records, unknown operations, and frontend disconnect without worker action.

- [ ] **Step 3: Run and verify failure**

Run: `pixi run vitest run runtime/command-journal.test.mjs runtime/event-store.test.mjs runtime/control-server.test.mjs extensions/agents-dashboard/daemon-client.test.ts`

- [ ] **Step 4: Implement persist-before-ack and persist-before-publish**

```ts
export interface CommandJournal {
  accept(command: DurableCommand): Promise<CommandStatus>;
  transition(key: RequestKey, allowed: readonly CommandStage[], next: CommandStage): Promise<CommandStatus>;
  get(key: RequestKey): Promise<CommandStatus | undefined>;
}

export interface DaemonClient {
  connect(): Promise<void>;
  request(request: ClientRequest): Promise<DaemonResponse>;
  subscribe(after?: EventCursor): AsyncIterable<PersistedEvent>;
  close(): Promise<void>;
}
```

A delivery attempt with no durable worker acknowledgement becomes `DELIVERY_UNKNOWN`. Only the explicit approved resolution operation may change it.

- [ ] **Step 5: Run and commit**

Run: `pixi run typecheck && pixi run vitest run runtime/command-journal.test.mjs runtime/event-store.test.mjs runtime/control-server.test.mjs extensions/agents-dashboard/daemon-client.test.ts`

```bash
pixi run git add runtime/command-journal.* runtime/event-store.* runtime/control-server.* extensions/agents-dashboard/daemon-client.*
pixi run git commit -m "feat: add durable daemon protocol"
```

### Task 9: Implement Worktree and Shared-Directory Isolation

**Files:**
- Create: `isolation/launch-preflight.mjs`
- Create: `isolation/launch-preflight.test.mjs`
- Create: `isolation/worktree.mjs`
- Create: `isolation/worktree.test.mjs`
- Create: `isolation/shared-directory.mjs`
- Create: `isolation/shared-directory.test.mjs`
- Create: `isolation/cleanup.mjs`
- Create: `isolation/cleanup.test.mjs`

**Interfaces:**
- Consumes `LaunchRequest` and canonical path helpers.
- Produces `LaunchPreflight`, `IsolationRecord`, `createWorktree`, `confirmSharedDirectory`, and `cleanupOwnedWorktree`.

- [ ] **Step 1: Create fixture-repository tests**

Cover branch, subdirectory cwd, detached HEAD, unborn HEAD, dirty source, branch/path collision, canonical aliases, and repositories with a local bare remote. Each test creates its own temporary repository.

- [ ] **Step 2: Write shared-directory confirmation tests**

```js
it("binds confirmation to the exact canonical cwd and current owners", async () => {
  const warning = await preflight({ isolation: "shared", cwd: aliasPath });
  await expect(confirmSharedDirectory({ ...warning, confirmedCanonicalCwd: otherPath })).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
});
```

- [ ] **Step 3: Write cleanup refusal tests**

Refuse live ownership, dirty files, untracked files, unpushed commits, missing upstream with changed HEAD, divergent history, identity mismatch, and non-dashboard-owned worktrees. A clean worktree still at its base commit may be removed without an upstream.

- [ ] **Step 4: Run and verify failure**

Run: `pixi run vitest run isolation/*.test.mjs`

- [ ] **Step 5: Implement argv-only Git operations**

Use `git -C <repo> worktree add -b <branch> <path> <baseCommit>` with `shell: false`. Derive worker cwd by preserving the source subdirectory. Never infer shared mode from failed worktree creation. Never substitute recursive deletion for `git worktree remove`.

- [ ] **Step 6: Run and commit**

Run: `pixi run typecheck && pixi run vitest run isolation/*.test.mjs`

```bash
pixi run git add isolation
pixi run git commit -m "feat: isolate agent working directories"
```

## Milestone 3: Workers, Daemon Recovery, and CLI

### Task 10: Implement Pi RPC Workers and Process Supervision

**Files:**
- Create: `runtime/pi-rpc-adapter.mjs`
- Create: `runtime/pi-rpc-adapter.test.mjs`
- Create: `runtime/worker.mjs`
- Create: `runtime/worker-supervisor.mjs`
- Create: `runtime/worker-supervisor.test.mjs`
- Create: `runtime/worker.integration.test.mjs`

**Interfaces:**
- Consumes ownership leases, command journal, state reducer, and Pi RPC public operations.
- Produces `PiRpcAdapter`, `WorkerHello`, worker replay records, and `WorkerSupervisor`.

- [ ] **Step 1: Write fake-RPC delivery-boundary tests**

Assert worker records `RECEIVED`, then `RPC_WRITE_STARTED`, then writes to Pi, then records `RPC_ACKNOWLEDGED`. Socket loss must not stop the worker or Pi child. Malformed Pi output must retain stderr and mark failure without rewriting the session.

- [ ] **Step 2: Write process-group and readiness tests**

Start two bounded fake workers concurrently and verify distinct PIDs and PGIDs. Launch acceptance must wait for worker hello and registry creation. Exiting the transient test frontend must leave workers alive. Cleanup uses recorded PIDs only.

- [ ] **Step 3: Run and verify failure**

Run: `pixi run vitest run runtime/pi-rpc-adapter.test.mjs runtime/worker-supervisor.test.mjs runtime/worker.integration.test.mjs`

- [ ] **Step 4: Implement the narrow Pi RPC adapter**

```js
export class PiRpcAdapter {
  static async start({ cwd, sessionFile, model, thinkingLevel, name, env }) {}
  async prompt(text) {}
  async steer(text) {}
  async followUp(text) {}
  async abort() {}
  async getState() {}
  onEvent(listener) {}
}
```

Use `@earendil-works/pi-coding-agent/rpc-entry` or the documented CLI RPC entry with structured argv. The worker owns the Pi child pipes and reconnects to a restarted daemon with bounded backoff. The daemon is not required to stay alive for the Pi child to continue.

- [ ] **Step 5: Implement admission and verified stop hooks**

`WorkerSupervisor.launch` atomically checks the approved cap, acquires ownership before the session file opens, spawns with `detached: true`, `shell: false`, and file-backed logs, and reports ready only after authenticated hello.

- [ ] **Step 6: Run and commit**

Run: `pixi run typecheck && pixi run vitest run runtime/pi-rpc-adapter.test.mjs runtime/worker-supervisor.test.mjs runtime/worker.integration.test.mjs`

```bash
pixi run git add runtime/pi-rpc-adapter.* runtime/worker.mjs runtime/worker-supervisor.* runtime/worker.integration.test.mjs
pixi run git commit -m "feat: supervise detached pi workers"
```

### Task 11: Assemble Daemon Lifecycle, Reconciliation, and Recovery CLI

**Files:**
- Create: `runtime/reconciliation.mjs`
- Create: `runtime/reconciliation.failure.test.mjs`
- Create: `runtime/daemon-lifecycle.mjs`
- Create: `runtime/daemon-lifecycle.test.mjs`
- Create: `runtime/daemon.mjs`
- Create: `runtime/daemon.integration.test.mjs`
- Create: `cli/main.mjs`
- Create: `cli/main.test.mjs`
- Create: `cli/daemon-commands.mjs`
- Create: `cli/daemon-commands.test.mjs`
- Create: `cli/package-commands.mjs`
- Create: `cli/package-commands.test.mjs`
- Modify: `bin/pi-agents-dashboard.mjs`

**Interfaces:**
- Consumes Tasks 7, 8, and 10.
- Produces one authenticated daemon, recovery mode, worker reconciliation, CLI commands `daemon start|status|restart|recover|stop`, `doctor`, and optional global npm registration commands `install|uninstall`.

- [ ] **Step 1: Write singleton and stale-socket tests**

Concurrent starts yield one verified daemon. A stale socket is replaced only after PID/start identity mismatch. A live but unreachable daemon is reported unhealthy and is not unlinked automatically.

- [ ] **Step 2: Write restart reconciliation tests**

```js
it("reconciles workers and commands before admitting mutation", async () => {
  await crashDaemonAt("DELIVERY_ATTEMPTED");
  const restarted = await startDaemon();
  await expect(restarted.prompt(sessionId, "next")).rejects.toMatchObject({ code: "RECOVERING" });
  await restarted.waitUntilReady();
  expect(await restarted.commandStatus(requestId)).toMatchObject({ stage: "DELIVERY_UNKNOWN" });
});
```

Cover alive matching worker, dead worker, PID reuse, accepted-only delivery, received-only safe redelivery, worker-acknowledged no-redelivery, event replay, and a second crash during reconciliation.

- [ ] **Step 3: Run and verify failure**

Run: `pixi run vitest run runtime/reconciliation.failure.test.mjs runtime/daemon-lifecycle.test.mjs runtime/daemon.integration.test.mjs cli/*.test.mjs`

- [ ] **Step 4: Implement lifecycle and composition**

The daemon binds the private socket, publishes PID/start identity and daemon epoch atomically, enters `RECONCILING`, reconstructs journals and workers, then enters `READY`. Read-only status may include `recovering: true`; mutating operations return `RECOVERING` until complete.

- [ ] **Step 5: Implement package registration, CLI exit codes, and JSON output**

`pi-agents-dashboard install` resolves its canonical package root from `import.meta.url` and invokes `pi install <root>` with `shell: false`. `uninstall` invokes `pi remove <root>` and does not stop workers or delete state. Use 0 for healthy success, 1 for safe refusal/unhealthy state, 2 for syntax/config errors, 3 for absent daemon, 4 for unsupported host capability, and 5 for ownership/process identity conflicts. `--json` prints one JSON object; no command accepts prefix IDs for destructive actions.

- [ ] **Step 6: Run and commit**

Run: `pixi run typecheck && pixi run vitest run runtime/reconciliation.failure.test.mjs runtime/daemon-lifecycle.test.mjs runtime/daemon.integration.test.mjs cli/*.test.mjs`

```bash
pixi run git add runtime/reconciliation.* runtime/daemon* cli bin/pi-agents-dashboard.mjs
pixi run git commit -m "feat: add daemon recovery lifecycle"
```

## Milestone 4: Dashboard and Native Attachment

### Task 12: Implement Responsive Dashboard Rendering and Virtual Rows

**Files:**
- Create: `extensions/agents-dashboard/dashboard-types.ts`
- Create: `extensions/agents-dashboard/dashboard-layout.ts`
- Create: `extensions/agents-dashboard/dashboard-layout.test.ts`
- Create: `extensions/agents-dashboard/dashboard-theme.ts`
- Create: `extensions/agents-dashboard/virtual-session-list.ts`
- Create: `extensions/agents-dashboard/virtual-session-list.test.ts`

**Interfaces:**
- Consumes Task 5 selectors and `SessionRecord`.
- Produces `DashboardLayout`, width-safe row renderers, `VirtualRow`, and `VirtualSessionList`.

- [ ] **Step 1: Write responsive snapshot tests**

Fixtures include WORKING, WAITING, READY, FAILED, STOPPED, STALE, completed, long paths, long model names, Unicode, and no activity. Snapshot widths are 160, 120, 80, 55, and 40 columns. Every rendered line also asserts `visibleWidth(line) <= width`.

- [ ] **Step 2: Write virtual-list operation tests**

Ten thousand fixture sessions must render only the viewport slice. Group headers consume virtual rows but remain unselectable. Selection is stable by session ID across reorder; one changed session invalidates one cache entry.

- [ ] **Step 3: Run and verify failure**

Run: `pixi run vitest run extensions/agents-dashboard/dashboard-layout.test.ts extensions/agents-dashboard/virtual-session-list.test.ts`

- [ ] **Step 4: Implement Jobwatch-style layout**

```ts
export interface DashboardLayout {
  width: number;
  height: number;
  density: "full" | "compact" | "minimal";
  listTop: number;
  listHeight: number;
  columns: readonly { key: SortKey; width: number }[];
}
```

Use a black background, sky-blue information surfaces, semantic green/amber/rose/gray states, dense one-line rows, ANSI-aware truncation, and breakpoints from the design. Do not create one TUI component per session row.

- [ ] **Step 5: Run and commit**

Run: `pixi run typecheck && pixi run vitest run extensions/agents-dashboard/dashboard-layout.test.ts extensions/agents-dashboard/virtual-session-list.test.ts`

```bash
pixi run git add extensions/agents-dashboard/dashboard-types.ts extensions/agents-dashboard/dashboard-layout.* extensions/agents-dashboard/dashboard-theme.ts extensions/agents-dashboard/virtual-session-list.*
pixi run git commit -m "feat: render virtual agents dashboard"
```

### Task 13: Implement Dashboard Interaction, Composer, Overlays, and Global Gesture

**Files:**
- Create: `extensions/agents-dashboard/launch-composer.ts`
- Create: `extensions/agents-dashboard/launch-composer.test.ts`
- Create: `extensions/agents-dashboard/dashboard-overlays.ts`
- Create: `extensions/agents-dashboard/dashboard-overlays.test.ts`
- Create: `extensions/agents-dashboard/key-gesture.ts`
- Create: `extensions/agents-dashboard/key-gesture.test.ts`
- Create: `extensions/agents-dashboard/dashboard.ts`
- Create: `extensions/agents-dashboard/dashboard.test.ts`
- Modify: `extensions/agents-dashboard/index.ts`

**Interfaces:**
- Consumes daemon client, Task 12 renderer, Task 5 selectors, and host capability report.
- Produces `/agents`, the clean/armed Left gesture, dashboard controller, launch form, metadata/help, and confirmation surfaces.

- [x] **Step 1: Write fake-clock gesture tests**

```ts
it("opens once when clean and twice within 500 ms after editing", () => {
  expect(reduceLeftGesture(clean, leftAtStart(0))).toMatchObject({ openDashboard: true });
  const dirty = reduceLeftGesture(clean, { type: "editorChanged" }).state;
  const armed = reduceLeftGesture(dirty, leftAtStart(100));
  expect(armed.openDashboard).toBe(false);
  expect(reduceLeftGesture(armed.state, leftAtStart(599))).toMatchObject({ openDashboard: true });
});
```

Cover whitespace, cursor not at start, modified Left, non-main focus, type then erase, history navigation, 501 ms expiry, other-key cancellation, repeat/release, successful-submit reset, and existing editor pass-through.

- [x] **Step 2: Write input-context and launch tests**

List Ctrl+C/Escape closes only the frontend. Composer Ctrl+C preserves the draft and returns list focus. Blank Enter does not launch. Shared-directory warnings require exact-path confirmation. Search, state/project filters, grouping, sort, metadata, and help retain selection by ID.

- [x] **Step 3: Run and verify failure**

Run: `pixi run vitest run extensions/agents-dashboard/key-gesture.test.ts extensions/agents-dashboard/launch-composer.test.ts extensions/agents-dashboard/dashboard-overlays.test.ts extensions/agents-dashboard/dashboard.test.ts`

- [x] **Step 4: Implement typed UI coordination**

```ts
export interface DashboardBackend {
  getSnapshot(signal?: AbortSignal): Promise<DashboardSnapshot>;
  subscribe(after: string | undefined, listener: (snapshot: DashboardSnapshot) => void): () => void;
  preflightLaunch(draft: LaunchDraft, signal?: AbortSignal): Promise<LaunchPreflight>;
  launch(request: LaunchRequest, signal?: AbortSignal): Promise<{ sessionId: string }>;
  stop(sessionId: string, requestId: string, signal?: AbortSignal): Promise<void>;
  delete(sessionId: string, requestId: string, signal?: AbortSignal): Promise<void>;
}
```

`dashboard.ts` owns subscriptions, focus, rendering, and disposal. Overlays return typed results and never signal workers directly. Render failure closes the custom UI and reports an error without calling abort, stop, or delete.

- [x] **Step 5: Register `/agents` and the host gesture adapter**

Use only public extension APIs. If the composable editor hook is absent, `/agents` still reports the host incompatibility and the exact remediation; it must not replace another custom editor silently.

- [x] **Step 6: Run and commit**

Run: `pixi run typecheck && pixi run vitest run extensions/agents-dashboard/{key-gesture,launch-composer,dashboard-overlays,dashboard}.test.ts`

```bash
pixi run git add extensions/agents-dashboard
pixi run git commit -m "feat: add dashboard interaction workflow"
```

### Task 14: Integrate Native Pi Attachment and Conversation Controls

**Blocked by:** Task 2 must report `daemonOwnedStartup: true` and `nativeAttach: true` on the selected supported Pi host.

**Files:**
- Create: `extensions/agents-dashboard/native-session-bridge.ts`
- Create: `extensions/agents-dashboard/native-session-bridge.contract.test.ts`
- Create: `test/native-attachment.integration.test.mjs`
- Modify: `extensions/agents-dashboard/dashboard.ts`
- Modify: `extensions/agents-dashboard/compatibility.ts`

**Interfaces:**
- Consumes the supported Pi native backend adapter, daemon attachment stream, and durable control operations.
- Produces `NativeSessionBridge.attach` and native detach results.

- [ ] **Step 1: Write the host-independent bridge contract tests**

```ts
export interface NativeSessionBridge {
  capability(): HostCapabilityReport;
  attach(request: {
    sessionId: string;
    selectedRevision: number;
    draft?: string;
    scrollAnchorEntryId?: string;
  }): Promise<NativeAttachment>;
}
```

Assert ordered transcript/event replay, Ctrl+C forwarding, Escape/clean-empty Left detach, draft/scroll round-trip where exposed, pending UI requests, backend loss, and disposal without stop.

- [ ] **Step 2: Write the real supported-host integration test**

Start one daemon-owned worker with a fake provider. Attach Pi's native interface, verify transcript, editor, commands, tool rendering, images, model/thinking controls, keybindings, and extension UI. Detach and reattach from a second frontend. Assert the worker PID, process start identity, session ID, and session file remain unchanged.

- [ ] **Step 3: Run and verify the gate**

Run: `pixi run vitest run extensions/agents-dashboard/native-session-bridge.contract.test.ts test/native-attachment.integration.test.mjs`

Expected on stock Pi 0.84.3: the compatibility precondition fails with exit code 4 and no fallback UI. Expected on the supported host: tests reach the native surface and pass.

- [ ] **Step 4: Implement the native adapter using only the approved host API**

Prompt while idle uses durable `prompt`; prompt while working defaults to `follow_up`; explicit Steer uses `steer`; Ctrl+C uses native `interrupt`; UI responses use `ui_response`. Reattaching an inactive saved session asks the daemon to acquire ownership and resume the same session file.

- [ ] **Step 5: Run and commit**

Run: `pixi run typecheck && pixi run vitest run extensions/agents-dashboard/native-session-bridge.contract.test.ts test/native-attachment.integration.test.mjs`

```bash
pixi run git add extensions/agents-dashboard/native-session-bridge* extensions/agents-dashboard/dashboard.ts extensions/agents-dashboard/compatibility.ts test/native-attachment.integration.test.mjs
pixi run git commit -m "feat: attach native pi sessions"
```

## Milestone 5: Destructive Actions, Acceptance, and Release

### Task 15: Complete Stop, Delete, Trash, and Worktree Cleanup Workflows

**Files:**
- Create: `cli/session-commands.mjs`
- Create: `cli/session-commands.test.mjs`
- Modify: `runtime/process-signaler.mjs`
- Modify: `runtime/control-server.mjs`
- Modify: `isolation/cleanup.mjs`
- Modify: `extensions/agents-dashboard/dashboard-overlays.ts`
- Create: `test/destructive-actions.integration.test.mjs`

**Interfaces:**
- Consumes verified process identity, durable command IDs, Pi session trash behavior, and cleanup refusal codes.
- Produces confirmed stop/delete and separate worktree cleanup in TUI and CLI.

- [ ] **Step 1: Write the Ctrl+X state-machine tests**

Live Ctrl+X opens Stop. Cancellation sends nothing. Confirmation captures session ID and revision. Repeated Ctrl+X while submitting sends nothing. A successful stop leaves the row selected. A later Ctrl+X opens Delete. An initially inactive row opens Delete directly. A live-to-inactive transition never converts an open Stop confirmation into Delete.

- [ ] **Step 2: Write process escalation integration tests**

Use one target fake process group and one sentinel group. Verify graceful request, configured wait, TERM, reinspection, configured wait, KILL, and no signal to the sentinel. Replace process identity between TERM and KILL and assert KILL is refused.

- [ ] **Step 3: Write delete and cleanup tests**

Delete rejects live sessions, uses Pi's normal trash behavior when available, and never touches the worktree. Cleanup remains a separate full-ID confirmed command and preserves dirty or unpushed work.

- [ ] **Step 4: Run and verify failure**

Run: `pixi run vitest run cli/session-commands.test.mjs extensions/agents-dashboard/dashboard-overlays.test.ts test/destructive-actions.integration.test.mjs isolation/cleanup.test.mjs runtime/process-signaler.test.mjs`

- [ ] **Step 5: Implement the workflows and stable errors**

Use idempotent full session IDs and structured refusal codes. No CLI or TUI path may signal by username, process name, prefix ID, or broad pattern. Daemon stop without `--stop-workers --yes` refuses while workers are live.

- [ ] **Step 6: Run and commit**

Run: `pixi run typecheck && pixi run vitest run cli/session-commands.test.mjs extensions/agents-dashboard/dashboard-overlays.test.ts test/destructive-actions.integration.test.mjs isolation/cleanup.test.mjs runtime/process-signaler.test.mjs`

```bash
pixi run git add cli/session-commands.* runtime/process-signaler.mjs runtime/control-server.mjs isolation/cleanup.mjs extensions/agents-dashboard/dashboard-overlays.ts test/destructive-actions.integration.test.mjs
pixi run git commit -m "feat: add safe stop and delete actions"
```

### Task 16: Run System Acceptance, Hardening, and Package Validation

**Files:**
- Create: `test/package.integration.test.mjs`
- Create: `test/lifecycle.integration.test.mjs`
- Create: `test/dashboard.tmux.test.mjs`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `pixi.toml`

**Interfaces:**
- Consumes the complete package.
- Produces release evidence for installation, survival, recovery, native attachment, security, performance, and cleanup.

- [ ] **Step 1: Write the packed-install test**

Run `npm pack`, then test four local installation paths with disposable npm prefixes and `PI_CODING_AGENT_DIR` values: `pi install /absolute/package/path`, unpacking the npm tarball and installing its absolute local path with Pi, `npm install -g <tarball> --ignore-scripts` followed by `pi-agents-dashboard install`, and package-relative extension startup with no global CLI on `PATH`. Verify `pi list`, `/agents`, executable permissions, and package contents. `pi remove` and `pi-agents-dashboard uninstall` remove package registration without deleting sessions, logs, registry, or worktrees. Validate construction of `pi install npm:pi-agents-dashboard@<version>` without contacting the registry; the published-package smoke test runs only after an npm release exists.

- [ ] **Step 2: Write the lifecycle and reconnect journey**

Use a fake provider and temporary Git repository. Launch two agents and verify distinct process identities and concurrent WORKING states. Close the dashboard and frontend during an active deterministic tool. Restart the daemon. Reconnect from another cwd. Attach natively and observe a later event from the same worker identity. Answer one pending extension UI request exactly once.

- [ ] **Step 3: Write tmux key and resize scenarios**

Cover `/agents`, clean single-Left, edited/history double-Left at 500 ms, Enter/Right attach, Left/Escape detach, context-sensitive Ctrl+C, Ctrl+X stop then delete, composer, filters, grouping, and widths `160x40`, `120x32`, `80x24`, `55x16`, and `40x10`.

- [ ] **Step 4: Add deterministic security and performance assertions**

Assert owner/modes, wrong token, protocol/version mismatch, unknown/oversized commands, path traversal, symlink substitution, argv injection, exact-group signaling, bounded subscriber buffers, visible-row operation count, affected-row invalidation, delta coalescing, bounded index refresh, and complete timer/watcher/subscription disposal.

- [ ] **Step 5: Run parallel review lanes**

Launch fresh read-only reviewers for:

1. daemon/protocol correctness and crash recovery;
2. process, filesystem, socket, and worktree security;
3. TUI behavior, responsive rendering, and native session parity;
4. tests, npm/Pi packaging, local installation paths, and support documentation.

The parent groups evidence-backed findings. One writer applies accepted fixes. Re-run only affected focused suites, then the full gate.

- [ ] **Step 6: Run the release gate**

Run:

```bash
pixi run typecheck
pixi run test-unit
pixi run test-integration
pixi run test
pixi run pack-check
```

Expected: all commands exit 0. The host capability report must show daemon-owned startup and native attachment supported. No release may be described as complete while those fields are false.

- [ ] **Step 7: Inspect artifacts and commit**

Inspect the packed file list, rendered snapshots, lifecycle logs, final Git diff, and `git status`. Confirm runtime state, tokens, logs, sockets, and worktrees are absent from the package.

```bash
pixi run git add test README.md package.json package-lock.json pixi.toml pixi.lock
pixi run git commit -m "test: verify dashboard system lifecycle"
```

## Milestone Exit Criteria

### Milestone 0

- The repository has a committed deterministic scaffold.
- The host capability report distinguishes supported features from blockers.
- The seven decision items in Task 3 are approved and recorded.

### Milestone 1

- Shared types and wire operations compile from runtime and extension code.
- State dimensions remain independent under table-driven tests.
- JSONL framing handles split UTF-8, malformed records, unknown operations, and bounds.

### Milestone 2

- Registry writes are atomic and one canonical session file has at most one owner.
- Accepted commands and published events are durable.
- Worktree and shared-directory behavior is explicit and test-covered.

### Milestone 3

- Two workers run concurrently with distinct process groups.
- Frontend and daemon loss do not stop workers.
- Restart reconciliation finishes before mutating command admission.
- Ambiguous delivery is visible and is not retried automatically.

### Milestone 4

- `/agents` and the Left gesture match the specified editor state machine.
- The Jobwatch-style dashboard is width-safe, virtualized, and keyboard complete.
- Enter/Right uses Pi's native interface, not a reduced transcript proxy.
- Reattachment preserves the same worker and session writer.

### Milestone 5

- Ctrl+X Stop/Delete behavior is confirmed, idempotent, and exact-targeted.
- Worktree cleanup refuses dirty or unpushed work.
- Installation, activation, reconnect, recovery, security, performance, and package gates pass.

## Validation Commands

```bash
pixi install
pixi run typecheck
pixi run test-unit
pixi run test-integration
pixi run test
pixi run pack-check
```

Focused commands:

```bash
pixi run vitest run runtime/command-journal.test.mjs
pixi run vitest run runtime/reconciliation.failure.test.mjs
pixi run vitest run runtime/process-signaler.test.mjs
pixi run vitest run isolation/*.test.mjs
pixi run vitest run extensions/agents-dashboard/key-gesture.test.ts
pixi run vitest run extensions/agents-dashboard/dashboard.test.ts
pixi run vitest run test/native-attachment.integration.test.mjs
pixi run vitest run test/dashboard.tmux.test.mjs
```

## Execution Stop Rules

- Stop after Task 2 if implementation starts depending on Pi private modules or a reduced transcript renderer.
- Stop before Task 4 until Task 3 decisions are approved and written into the spec.
- Stop any worker launch if the canonical session file already has a live owner.
- Stop destructive action implementation if process identity cannot be revalidated before each signal.
- Stop release work if native attachment, daemon-owned startup, standard Pi-package installation, package-relative runtime discovery, or supported-host capability remains false.
- Ask the user before changing product behavior, release scope, default retention, worker limits, cross-config daemon scope, or attachment arbitration.
