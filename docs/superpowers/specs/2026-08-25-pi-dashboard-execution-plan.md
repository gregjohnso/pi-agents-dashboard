# pi-dashboard standalone implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the integrated dashboard foundation into the standalone `pi-dashboard` npm executable, launch installed Pi processes through RPC, normalize their saved and live data, render a Pi-style interactive chat viewer, and prove lifecycle and package acceptance.

**Architecture:** One per-user daemon owns the registry, durable commands, normalized viewer events, attachment roles, and exact process identities. A detached supervisor owns each installed `pi --mode rpc --session <session-file>` child's pipes and reconnects to the daemon; the standalone app owns the terminal, Jobwatch-style list, and Pi-style viewer. The app consumes a versioned normalized viewer protocol and never reads raw Pi frames or session JSONL directly.

**Tech stack:** Node.js 22.19+, plain ESM `.mjs` runtime and app modules checked by TypeScript 5.9, Vitest 4.1.9, public package-root exports from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, Unix sockets, POSIX process groups, Git worktrees, npm, and Pixi.

**Spec:** `docs/superpowers/specs/2026-08-25-pi-dashboard-design.md`

## Document responsibility

This file owns implementation order, files, shared interfaces, parallel lanes, test-first steps, commands, and milestone gates. The [design](2026-08-25-pi-dashboard-design.md) controls product behavior. The [task list](2026-08-25-pi-dashboard-tasklist.md) records execution status. A conflict is resolved in favor of the design.

## Integrated baseline

Commit `5a36be230521610f2445f8947c4c92760e874872` contains the independently reviewed implementation through T13 and T15. Later commits revise documentation only.

| Task | Baseline status | Reused result |
|---|---|---|
| T01-T04 | Complete | Package harness, configuration, strict command contracts, bounded JSONL. |
| T05-T09 | Complete | State/index logic, runtime safety, registry/ownership, durable protocol, isolation. |
| T10-T11 | Complete | Supervisor foundation, worker replay, daemon lifecycle, recovery, CLI. |
| T12-T13 | Complete | Virtualized Jobwatch list, interactions, composer, overlays, frontend persistence. |
| T14 | Superseded | The standalone viewer in T20 replaces the blocked host-attachment direction. |
| T15 | Complete | Revision-bound Stop/Delete, exact signaling, trash capability refusal, cleanup. |
| T16 | Superseded | T21 owns standalone acceptance and release attestation. |

Historical extension and host-capability code is migration input, not release architecture. T17 removes it from the shipped package.

## Global constraints

- The canonical package, executable, user-visible name, new runtime root, repository name, and documentation name are `pi-dashboard`.
- The product is a standalone terminal app. The npm package contains no Pi extension entry point, and `pi install` is unsupported.
- Empty argv opens the Jobwatch-style list. `--pi-bin <absolute-path>` overrides configuration; configuration overrides `PATH` discovery.
- The daemon derives trusted Pi configuration and runtime paths. Clients cannot provide a trusted configuration root.
- The supervisor launches structured argv equivalent to `pi --mode rpc --session <canonical-session-file>` with `shell: false` only after durable ownership binding.
- The supervisor owns RPC pipes, diagnostics, leases, and child identity. App or daemon transport closure does not signal a supervisor or Pi child.
- One daemon writes registry and lifecycle state. One supervisor/Pi-child pair writes each canonical Pi session file.
- Every run records Pi executable realpath and file identity, reported Pi version, detected capabilities, RPC adapter version, normalized protocol version, supervisor identity, and Pi-child identity.
- Capability support is feature-based. Probes make no model request and do not start a canonical session writer.
- Frontends consume normalized viewer snapshots/events, never raw Pi frames or raw session JSONL.
- Unknown optional Pi events become bounded generic activity. Missing required capabilities return `UNSUPPORTED_PI_CAPABILITY` with missing capability names.
- Raw RPC diagnostics use four rotating 8 MiB segments, 32 MiB total. Pi stderr uses one rotating 8 MiB limit. Canonical and normalized history is not truncated by diagnostic rotation.
- Exactly one socket/client is composer for a session. Observers and unattached clients cannot prompt, follow up, steer, interrupt, answer UI requests, stop, or delete.
- Durable command ordering and explicit `DELIVERY_UNKNOWN` resolution remain unchanged.
- Git worktrees remain the default. Shared directories require exact canonical-path confirmation. Delete and worktree cleanup remain separate.
- Stop and Delete require full IDs and revisions. Signals target one revalidated process group. Delete uses only an approved public trash seam.
- State migration locks both roots, refuses live legacy mutation, preserves the source through reconciliation, and does not rename canonical Pi session files or worktrees.
- Runtime/state directories are `0700`; tokens, registry, journals, logs, and diagnostics are `0600`.
- The app uses public package-root Pi UI exports. Deep `dist/` imports, private `InteractiveMode`, and in-process `AgentSession` objects are prohibited.
- The list columns are ID, State, Project, Activity, Age in that order. Model is absent from the list and remains available in search and metadata.
- The viewer uses Pi's public chat, tool, editor, theme, keybinding, viewport, and overlay components wherever their public input contracts fit.
- A clean empty viewer editor returns on one Left or Escape. Edited/history state requires the same key a second time within 500 ms.
- Images and file metadata are preserved and rendered as safe placeholders in the first release.
- Linux is the first supported platform. Cross-machine control, a browser UI, and production terminal multiplexers are outside scope.
- Completed saved sessions remain until explicit confirmed deletion. No custom purge policy is added.
- Tests use fake installed Pi executables and bounded local processes. Tests perform no model inference.
- Use TDD for each behavior change: write the behavioral test, run it to see the expected failure, implement minimally, then rerun focused and dependency tests.
- Run commands through Pixi. Do not use SLURM, submitit, or a production tmux dependency.
- No npm publication occurs in T17-T21.
- Repository remote and primary checkout rename occurs only after T21 acceptance. That rename does not rename canonical Pi session files or managed worktrees.

## Dependency graph and merge order

```text
integrated baseline
       |
      T17  package/contracts/migration/app shell
     /   \
   T18   T20  installed Pi runtime and standalone UI use disjoint owners
    |      |
   T19     |  normalized runtime can proceed while T20 finishes
     \    /
       T21  integrated acceptance, reviews, one fix writer
```

Exact dependencies:

- T17 depends on the integrated baseline.
- T18 depends on T17.
- T19 depends on T18.
- T20 depends on T17 and consumes the viewer contracts frozen there.
- T21 depends on T19 and T20.

Merge T17 first. Then merge T18 and T20 serially in either order after both reviews are clean because their claimed files do not overlap. Merge T19 after T18. Resolve only integration wiring in T19's daemon/control-server owner. Run `pixi run test` after each merge. T21 starts from the integrated result.

## Lane board

| Lane | Task | Claimed files/contracts | Isolation | Authority | Next gate | Why independent |
|---|---|---|---|---|---|---|
| Foundation | T17 | package/lock, bin, CLI naming, config, contracts, paths, migration, `app/list/**`, composer authorization | dedicated worktree | sole writer | focused T17 tests, full suite, fresh review | Serial contract and relocation gate. |
| Process | T18 | `runtime/pi-executable*`, `pi-capability-probe*`, `rotating-diagnostics*`, `pi-rpc-adapter*`, `worker*` | dedicated worktree from T17 | sole writer | process suites, full suite, fresh review | Does not edit `app/**` or daemon viewer integration. |
| Viewer UI | T20 | `app/viewer/**`, `app/app-controller*`, list-to-viewer navigation tests/snapshots | dedicated worktree from T17 | sole writer | UI suites, full suite, fresh review | Uses frozen fake viewer protocol; does not edit worker/runtime normalization. |
| Normalization | T19 | `runtime/session-history*`, `viewer-normalizer*`, `viewer-store*`, daemon/control-server viewer integration | dedicated worktree from merged T18 | sole writer | protocol suites, full suite, fresh review | Consumes T18 raw-frame seam; does not edit `app/**`. |
| Acceptance | T21 | acceptance fixtures/tests, package scripts, README release docs | integrated worktree | sole writer | six read-only reviews, one fix writer, full release gate | Runs only after production lanes merge. |

No two mutation-capable lanes share a worktree. Read-only reviewers may inspect the same integrated commit. Review findings return to the lane owner until its task gate is clean.

## File and responsibility map

```text
pi-dashboard/
├── package.json                         # standalone package metadata and scripts
├── package-lock.json                    # deterministic runtime/UI dependencies
├── pixi.toml                            # typecheck, focused, integration, acceptance gates
├── tsconfig.json                        # checkJs for app, bin, cli, runtime, isolation, shared
├── README.md                            # standalone install, operation, recovery, support
├── bin/
│   └── pi-dashboard.mjs                 # package-relative executable
├── app/
│   ├── standalone.mjs                   # terminal and daemon composition root
│   ├── standalone.test.mjs
│   ├── app-controller.mjs               # list/viewer replacement and disposal
│   ├── app-controller.test.mjs
│   ├── daemon-client.mjs                # reconnecting typed frontend client
│   ├── daemon-client.test.mjs
│   ├── list/                            # relocated Jobwatch state/layout/list/composer/overlays
│   └── viewer/
│       ├── viewer-controller.mjs        # normalized chat state and input routing
│       ├── viewer-controller.test.mjs
│       ├── pi-component-adapters.mjs    # package-root Pi component adapters
│       ├── pi-component-adapters.test.mjs
│       ├── transcript.mjs               # virtual chat blocks and follow mode
│       ├── transcript.test.mjs
│       ├── overlays.mjs                 # pending UI and viewer dialogs
│       ├── overlays.test.mjs
│       ├── return-gesture.mjs            # clean/armed 500 ms gesture
│       └── return-gesture.test.mjs
├── cli/
│   ├── main.mjs                         # empty-argv app start and maintenance commands
│   ├── main.test.mjs
│   ├── daemon-commands.mjs
│   └── session-commands.mjs
├── shared/
│   ├── contracts.ts                     # command/session/process/config contracts
│   ├── contracts.test.ts
│   ├── viewer-contracts.ts              # independently versioned viewer protocol
│   ├── viewer-contracts.test.ts
│   ├── config.ts                        # schema 2 defaults and schema 1 conversion
│   └── config.test.ts
├── runtime/
│   ├── paths.mjs                        # canonical new and legacy roots
│   ├── state-migration.mjs              # locked staged atomic migration
│   ├── state-migration.test.mjs
│   ├── pi-executable.mjs                # discovery, canonical identity, TOCTOU recheck
│   ├── pi-executable.test.mjs
│   ├── pi-capability-probe.mjs           # no-inference feature probe and cache
│   ├── pi-capability-probe.test.mjs
│   ├── rotating-diagnostics.mjs          # 32 MiB RPC and 8 MiB stderr bounds
│   ├── rotating-diagnostics.test.mjs
│   ├── pi-rpc-adapter.mjs               # strict RPC commands, responses, raw frame events
│   ├── worker.mjs                        # detached supervisor process and reconnect loop
│   ├── worker-supervisor.mjs             # admission, activation, exact identities
│   ├── session-history.mjs               # canonical Pi history reader without mutation
│   ├── session-history.test.mjs
│   ├── viewer-normalizer.mjs             # history/live mapping and deduplication
│   ├── viewer-normalizer.test.mjs
│   ├── viewer-store.mjs                  # persisted viewer cursors and replay
│   ├── viewer-store.test.mjs
│   ├── control-server.mjs                # command plus viewer read protocol
│   └── daemon.mjs                        # reconciliation and integration
├── isolation/                            # existing worktree/shared/cleanup safety
└── test/
    ├── fixtures/fake-pi.mjs              # executable RPC fixture, no provider call
    ├── package.acceptance.test.mjs
    ├── migration.integration.test.mjs
    ├── installed-pi.integration.test.mjs
    ├── lifecycle.acceptance.test.mjs
    ├── mixed-pi-versions.integration.test.mjs
    └── terminal.acceptance.test.mjs
```

## Shared interfaces frozen by T17

```ts
export interface DashboardConfig {
  schemaVersion: 2;
  pi: { executable: string | null };
  workers: { maxLive: number | null; idleRetentionMs: number };
  history: { completedWindowHours: number | null; indexRefreshMs: number };
  daemon: { heartbeatMs: number; staleAfterMs: number; startTimeoutMs: number };
  stop: { gracefulMs: number; terminateMs: number };
  diagnostics: { rpcSegmentBytes: 8_388_608; rpcSegments: 4; stderrBytes: 8_388_608 };
}

export interface MigrationManifest {
  schemaVersion: 1;
  migrationId: string;
  sourceIdentity: string;
  destinationIdentity: string;
  state: "PREPARED" | "PUBLISHED" | "RECONCILED";
  configFrom: 1;
  configTo: 2;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutableIdentity {
  realpath: string;
  device: string;
  inode: string;
  size: number;
  modifiedTimeNs: string;
}

export interface PiCapabilityReport {
  executable: ExecutableIdentity;
  reportedVersion: string | null;
  rpcMode: boolean;
  jsonl: boolean;
  commands: readonly ("get_state" | "prompt" | "follow_up" | "steer" | "abort" | "extension_ui_response")[];
  events: readonly string[];
  missingRequired: readonly string[];
}

export interface RunRuntimeIdentity {
  executable: ExecutableIdentity;
  piVersion: string | null;
  capabilities: PiCapabilityReport;
  rpcAdapterVersion: 1;
  viewerProtocolVersion: 1;
  supervisor: ProcessIdentity;
  piChild: ProcessIdentity;
}

export type ViewerActivityPhase =
  | "idle"
  | "thinking"
  | "assistant_streaming"
  | "tool_pending"
  | "tool_running"
  | "tool_streaming"
  | "compacting"
  | "retrying"
  | "waiting"
  | "interrupting"
  | "stopping"
  | "error";

export interface ViewerCursor {
  daemonEpoch: string;
  sessionId: string;
  sequence: string;
}

export interface ViewerEvent<T extends ViewerPayload = ViewerPayload> {
  version: 1;
  sessionId: string;
  eventId: string;
  cursor: ViewerCursor;
  timestamp: string;
  payload: T;
}

export type ViewerPayload =
  | { kind: "user_message"; itemId: string; content: readonly ViewerContent[] }
  | { kind: "assistant_delta"; itemId: string; delta: string }
  | { kind: "assistant_message"; itemId: string; content: readonly ViewerContent[] }
  | { kind: "system_message"; itemId: string; text: string; level: "info" | "warning" | "error" }
  | { kind: "tool_started" | "tool_updated" | "tool_finished"; tool: ViewerTool }
  | { kind: "turn_state"; working: boolean }
  | { kind: "pending_ui_request"; request: ViewerUiRequest }
  | { kind: "ui_resolved"; requestId: string }
  | { kind: "model_state"; provider: string | null; model: string | null }
  | { kind: "thinking_state"; level: string | null }
  | { kind: "activity"; phase: ViewerActivityPhase; label: string; detail?: string; startedAt: string; toolCallId?: string; retryAt?: string }
  | { kind: "image_placeholder" | "file_placeholder"; attachment: ViewerAttachment }
  | { kind: "unknown_pi_event"; piType: string; summary: string };

export type ViewerContent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "image" | "file"; attachmentId: string };

export interface ViewerAttachment {
  id: string;
  path?: string;
  mediaType?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface ViewerTool {
  id: string;
  name: string;
  state: "pending" | "running" | "streaming" | "completed" | "failed";
  arguments: unknown;
  result?: readonly ViewerContent[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface ViewerUiRequest {
  id: string;
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  options?: readonly string[];
  initialValue?: string;
}

export type ViewerItem = Extract<ViewerPayload, {
  kind: "user_message" | "assistant_message" | "system_message" | "image_placeholder" | "file_placeholder" | "unknown_pi_event";
}>;

export interface ViewerSnapshot {
  version: 1;
  sessionId: string;
  registryRevision: number;
  cursor: ViewerCursor;
  runtime: RunRuntimeIdentity | null;
  role: "composer" | "observer";
  taskState: TaskState;
  processState: ProcessState;
  outcome: Outcome;
  activity: Extract<ViewerPayload, { kind: "activity" }>;
  model: { provider: string; id: string } | null;
  thinkingLevel: string | null;
  items: readonly ViewerItem[];
  tools: readonly ViewerTool[];
  pendingUi: readonly ViewerUiRequest[];
  errors: readonly DashboardError[];
}

export interface ViewerSubscription {
  snapshot(sessionId: string): Promise<ViewerSnapshot>;
  subscribe(sessionId: string, after?: ViewerCursor): AsyncIterable<ViewerEvent>;
  ack(cursor: ViewerCursor): Promise<void>;
}
```

T17 also extends `SessionRecord` with optional `runtime?: RunRuntimeIdentity` during migration. T18 makes it required for live runs. Command protocol version 1 and viewer protocol version 1 remain independent.

## Milestone 6: Standalone foundation

### Task 17: Rename the product, migrate state, and start the standalone list

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `pixi.toml`
- Modify: `tsconfig.json`
- Modify: `README.md`
- Rename: `bin/pi-agents-dashboard.mjs` to `bin/pi-dashboard.mjs`
- Modify: `cli/main.mjs`
- Modify: `cli/main.test.mjs`
- Modify: `cli/daemon-commands.mjs`
- Modify: `cli/daemon-commands.test.mjs`
- Modify: `cli/session-commands.mjs`
- Modify: `cli/session-commands.test.mjs`
- Delete: `cli/package-commands.mjs`
- Delete: `cli/package-commands.test.mjs`
- Modify: `shared/contracts.ts`
- Modify: `shared/contracts.test.ts`
- Modify: `shared/config.ts`
- Modify: `shared/config.test.ts`
- Create: `shared/viewer-contracts.ts`
- Create: `shared/viewer-contracts.test.ts`
- Modify: `runtime/paths.mjs`
- Modify: `runtime/paths.test.mjs`
- Create: `runtime/state-migration.mjs`
- Create: `runtime/state-migration.test.mjs`
- Modify: `runtime/control-server.mjs`
- Modify: `runtime/control-server.test.mjs`
- Modify: `runtime/daemon.mjs`
- Modify: `runtime/daemon.integration.test.mjs`
- Move and convert: the current extension daemon client to `app/daemon-client.mjs`
- Move and convert: the current reusable list/state/layout/virtual/composer/overlay modules and tests to `app/list/`
- Create: `app/standalone.mjs`
- Create: `app/standalone.test.mjs`
- Create: `app/app-controller.mjs`
- Create: `app/app-controller.test.mjs`
- Delete: remaining `extensions/` directory
- Create: `test/package-metadata.test.mjs`
- Create: `test/migration.integration.test.mjs`

**Consumes:** integrated T01-T13/T15 foundation and the design's approved schema 2 defaults.

**Produces:** canonical package and binary names, package-root UI dependencies, viewer contracts, schema 2 parsing, atomic legacy migration, server-side composer authorization, and a standalone app shell that opens the relocated list.

```js
export async function runDashboardApp({ cwd, piBin, env, stdin, stdout, stderr }) {}

export async function migrateLegacyState({
  legacyRoot,
  destinationRoot,
  expectedUserId,
  inspectLegacyRuntime,
  reconcileDestination,
  fsOps,
  failpoint,
}) {}
```

- [ ] **Step 1: Write package and standalone startup tests**

Add behavioral assertions:

```js
it("ships only the standalone executable", () => {
  expect(manifest.name).toBe("pi-dashboard");
  expect(manifest.bin).toEqual({ "pi-dashboard": "./bin/pi-dashboard.mjs" });
  expect(manifest.pi).toBeUndefined();
  expect(manifest.scripts.preinstall).toBeUndefined();
  expect(manifest.scripts.postinstall).toBeUndefined();
  expect(manifest.files).toContain("app");
  expect(manifest.files).not.toContain("extensions");
});

it("opens the list from empty argv and preserves startup cwd", async () => {
  await runCli([], deps);
  expect(deps.openApp).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
});
```

Test `--pi-bin` syntax, package-relative app resolution from an unrelated cwd, frontend closure without daemon/process signaling, and removal of package registration commands.

- [ ] **Step 2: Run the startup tests and verify the expected failure**

Run:

```bash
pixi run vitest run test/package-metadata.test.mjs cli/main.test.mjs app/standalone.test.mjs
```

Expected: FAIL because the old package/bin manifest and extension startup still exist and `app/standalone.mjs` is absent.

- [ ] **Step 3: Write schema and migration tests**

Cover schema 2 exact defaults and unknown-key rejection. Use failpoints for staging start, after staged file fsync, before manifest rename, after manifest publication, before reconciliation completion, and after reconciliation. Cover:

- canonical lock order for legacy and destination roots;
- verified live legacy daemon/supervisor refusal;
- wrong owner, mode, symlink, malformed schema, identity mismatch, and destination collision;
- idempotent recovery of matching staged/completed migration identity;
- source preservation on every failure;
- unchanged canonical session and worktree paths;
- schema 1 worker limits, timings, history, and isolation values preserved in schema 2;
- publication order: file fsync, directory fsync, atomic manifest rename, destination reconciliation, canonical marker.

- [ ] **Step 4: Run migration tests and verify the expected failure**

Run:

```bash
pixi run vitest run shared/config.test.ts runtime/paths.test.mjs runtime/state-migration.test.mjs test/migration.integration.test.mjs
```

Expected: FAIL because schema 2, dual-root paths, and migration functions are absent.

- [ ] **Step 5: Write contract and composer authorization tests**

Test the exact interfaces above, strict unknown-field rejection, viewer cursor/session binding, and every payload variant. Extend daemon tests so only the socket holding the composer role can invoke `prompt`, `follow_up`, `steer`, `interrupt`, `ui_response`, Stop, or Delete; observers and unattached sockets receive `OBSERVER_READ_ONLY` or `ATTACHMENT_REQUIRED` before journaling or delivery.

- [ ] **Step 6: Run contract/authorization tests and verify the expected failure**

Run:

```bash
pixi run vitest run shared/contracts.test.ts shared/viewer-contracts.test.ts runtime/control-server.test.mjs runtime/daemon.integration.test.mjs
```

Expected: FAIL because viewer contracts and complete composer authorization are absent.

- [ ] **Step 7: Implement the minimal standalone foundation**

Apply the full package/bin/UI/state rename. Pin `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at `0.84.3` as runtime dependencies and refresh the lockfile with `pixi run npm install`. Remove the package extension manifest and package registration CLI. Convert relocated app code to package-executable `.mjs` modules with JSDoc/checkJs types. Empty argv initializes private permissions, runs migration, connects to or starts the daemon, and opens the list.

Implement schema 2 with the exact design defaults. Derive the legacy state/runtime roots named `pi-agents-dashboard` and the destination roots named `pi-dashboard` from the same per-user XDG locations. Migration stages only dashboard metadata/configuration, never canonical Pi sessions or worktrees. Publish a mode-`0600` manifest under mode-`0700` roots and preserve the legacy source after success.

Freeze viewer contracts and enforce composer role on the daemon before command acceptance. Replace the list's obsolete session-open dependency with an injected `openViewer(sessionId)` boundary owned by `app-controller.mjs`; T20 supplies its implementation.

- [ ] **Step 8: Run focused, dependency, and full gates**

Run:

```bash
pixi run typecheck
pixi run vitest run test/package-metadata.test.mjs cli/main.test.mjs app/standalone.test.mjs app/app-controller.test.mjs
pixi run vitest run shared/config.test.ts shared/contracts.test.ts shared/viewer-contracts.test.ts runtime/paths.test.mjs runtime/state-migration.test.mjs test/migration.integration.test.mjs
pixi run vitest run runtime/control-server.test.mjs runtime/daemon.integration.test.mjs app/list/*.test.mjs
pixi run test
pixi run pack-check
```

Expected: all commands exit 0; packed output has `pi-dashboard`, `app/`, no extension manifest, and no private state.

- [ ] **Step 9: Commit T17**

```bash
pixi run git add -A
pixi run git commit -m "feat: establish standalone pi dashboard"
```

## Milestone 7: Installed Pi process and normalized data

### Task 18: Launch and supervise the installed Pi executable

**Files:**
- Create: `runtime/pi-executable.mjs`
- Create: `runtime/pi-executable.test.mjs`
- Create: `runtime/pi-capability-probe.mjs`
- Create: `runtime/pi-capability-probe.test.mjs`
- Create: `runtime/rotating-diagnostics.mjs`
- Create: `runtime/rotating-diagnostics.test.mjs`
- Modify: `runtime/pi-rpc-adapter.mjs`
- Modify: `runtime/pi-rpc-adapter.test.mjs`
- Modify: `runtime/worker.mjs`
- Modify: `runtime/worker-supervisor.mjs`
- Modify: `runtime/worker-supervisor.test.mjs`
- Modify: `runtime/worker.integration.test.mjs`
- Modify: `runtime/ownership.mjs`
- Modify: `runtime/ownership.test.mjs`
- Modify: `runtime/registry-store.mjs`
- Modify: `runtime/registry-store.test.mjs`
- Create: `test/fixtures/fake-pi.mjs`
- Create: `test/installed-pi.integration.test.mjs`
- Create: `test/mixed-pi-versions.integration.test.mjs`

**Consumes:** T17 executable/runtime contracts, ownership leases, durable worker replay, process identity, and schema 2 diagnostic limits.

**Produces:** `resolvePiExecutable`, `probePiCapabilities`, a real installed Pi child with distinct identity, raw-frame forwarding, bounded diagnostics, mixed-version records, and durable supervisor reconnect.

```js
export async function resolvePiExecutable({ cliPath, configuredPath, pathEnv, fsOps }) {}
export async function probePiCapabilities({ executable, spawnImpl, cache, timeoutMs }) {}

export class PiRpcAdapter {
  static connect({ input, output, diagnostics, maxRecordBytes }) {}
  prompt(text) {}
  followUp(text) {}
  steer(text) {}
  abort() {}
  uiResponse(response) {}
  getState() {}
  onFrame(listener) {}
}
```

- [ ] **Step 1: Write executable discovery and no-inference probe tests**

Cover precedence `--pi-bin` over config over `PATH`, canonical realpath/file/executable checks, symlink and replacement refusal, and cache key `(realpath, device, inode, size, modifiedTimeNs)`.

The fake executable logs every command. The probe may use `--help`, start RPC against a temporary non-canonical session, send `get_state`, and send deliberately incomplete command envelopes to distinguish recognized validation errors for `prompt`, `follow_up`, `steer`, and `extension_ui_response`; it may send idle `abort`. Assert the log contains no valid prompt, no provider invocation, and no canonical session path.

- [ ] **Step 2: Run discovery/probe tests and verify the expected failure**

Run:

```bash
pixi run vitest run runtime/pi-executable.test.mjs runtime/pi-capability-probe.test.mjs
```

Expected: FAIL because executable discovery and capability probing are absent.

- [ ] **Step 3: Write diagnostic rotation tests**

Use injected small limits to test segment rollover, oldest complete segment removal, truncation byte/record counts, oversized single-record metadata with SHA-256, crash-safe reopen, and `0700/0600` modes. Add one default-size case asserting RPC bytes do not exceed `33_554_432` and stderr bytes do not exceed `8_388_608`.

- [ ] **Step 4: Run diagnostic tests and verify the expected failure**

Run:

```bash
pixi run vitest run runtime/rotating-diagnostics.test.mjs
```

Expected: FAIL because file-backed rotating diagnostics are absent.

- [ ] **Step 5: Write exact process and argv tests**

The fake installed executable records argv and emits bounded JSONL. Assert a default launch receives exactly:

```text
<canonical-pi-realpath> --mode rpc --session <canonical-session-file>
```

Optional model, thinking, and name flags appear only when selected. Assert `shell: false`, supervisor PID differs from child PID, supervisor PGID equals supervisor PID, child PGID equals supervisor PGID, and ownership binds both identities before readiness.

Cover required capability refusal before ownership/session writer creation, executable replacement between probe and spawn, malformed RPC, child exit, inherited daemon channel loss, bounded reconnect, two concurrent runs, and version A remaining live when new launches use version B.

- [ ] **Step 6: Run process tests and verify the expected failure**

Run:

```bash
pixi run vitest run runtime/pi-rpc-adapter.test.mjs runtime/worker-supervisor.test.mjs runtime/worker.integration.test.mjs test/installed-pi.integration.test.mjs test/mixed-pi-versions.integration.test.mjs
```

Expected: FAIL because the current worker imports a package RPC entry in-process and reports one identity for supervisor and child.

- [ ] **Step 7: Implement the minimal installed-process boundary**

Resolve and probe the executable before canonical ownership. Revalidate its file identity immediately before spawn. The detached supervisor remains process-group leader, then spawns the installed executable after activation with owned stdin/stdout/stderr pipes. Connect `PiRpcAdapter` to those pipes, persist raw RPC/stderr through the rotating writers, forward complete structured frames to the daemon transport, and require `get_state` before `worker_ready`.

The handshake reports distinct supervisor and Pi-child identities. Registry ownership and run metadata persist both plus executable/capability/adapter/protocol identity. Existing runs keep their recorded executable. Reconnect never closes child pipes or signals the process group.

- [ ] **Step 8: Run focused, dependency, and full gates**

Run:

```bash
pixi run typecheck
pixi run vitest run runtime/pi-executable.test.mjs runtime/pi-capability-probe.test.mjs runtime/rotating-diagnostics.test.mjs
pixi run vitest run runtime/pi-rpc-adapter.test.mjs runtime/worker-supervisor.test.mjs runtime/worker.integration.test.mjs
pixi run vitest run runtime/ownership.test.mjs runtime/registry-store.test.mjs test/installed-pi.integration.test.mjs test/mixed-pi-versions.integration.test.mjs
pixi run test
```

Expected: all commands exit 0 with no real provider call.

- [ ] **Step 9: Commit T18**

```bash
pixi run git add runtime test/fixtures/fake-pi.mjs test/installed-pi.integration.test.mjs test/mixed-pi-versions.integration.test.mjs
pixi run git commit -m "feat: launch installed pi rpc processes"
```

### Task 19: Normalize history and live RPC into the viewer protocol

**Files:**
- Create: `runtime/session-history.mjs`
- Create: `runtime/session-history.test.mjs`
- Create: `runtime/viewer-normalizer.mjs`
- Create: `runtime/viewer-normalizer.test.mjs`
- Create: `runtime/viewer-store.mjs`
- Create: `runtime/viewer-store.test.mjs`
- Modify: `runtime/event-store.mjs`
- Modify: `runtime/event-store.test.mjs`
- Modify: `runtime/control-server.mjs`
- Modify: `runtime/control-server.test.mjs`
- Modify: `runtime/daemon.mjs`
- Modify: `runtime/daemon.integration.test.mjs`
- Modify: `runtime/reconciliation.mjs`
- Modify: `runtime/reconciliation.failure.test.mjs`
- Modify: `app/daemon-client.mjs`
- Modify: `app/daemon-client.test.mjs`
- Create: `test/viewer-recovery.integration.test.mjs`

**Consumes:** T17 viewer contracts and T18 complete raw frame/executable identity seam.

**Produces:** canonical history reader, deterministic history/live normalizer, persisted per-session viewer store, snapshot/replay protocol, viewer client methods, and restart reconstruction.

```js
export function createViewerNormalizer({ sessionId, protocolVersion, now }) {
  return {
    consumeHistory(entry, position) {},
    consumeFrame(frame) {},
    snapshot(runtimeState) {},
  };
}

export interface ViewerDaemonClient {
  getViewerSnapshot(sessionId: string): Promise<ViewerSnapshot>;
  subscribeViewer(sessionId: string, after?: ViewerCursor): AsyncIterable<ViewerEvent>;
  ackViewer(cursor: ViewerCursor): Promise<void>;
}
```

- [ ] **Step 1: Write canonical history safety tests**

Use literal session JSONL fixtures for user, assistant text/thinking/tool calls, tool results, custom/system entries, images, files, malformed lines, and unsupported entries. Assert the reader preserves source bytes, never rewrites the canonical file, reports bounded parse errors, and returns stable positions and source IDs.

- [ ] **Step 2: Run history tests and verify the expected failure**

Run:

```bash
pixi run vitest run runtime/session-history.test.mjs
```

Expected: FAIL because no normalized history reader exists.

- [ ] **Step 3: Write table-driven normalization tests**

Cover all payload kinds frozen in T17 and every activity phase. Hand-derived fixtures assert:

- Pi entry IDs remain unchanged when present;
- fallback IDs are deterministic from session ID, position/type, and bounded canonical content;
- history/live overlap emits one stable item;
- assistant deltas update one item and final content is idempotent;
- tool start/update/finish share one tool ID;
- pending UI survives without a frontend and resolves once;
- model/thinking/activity state replaces the prior active state;
- image/file metadata becomes placeholders;
- unknown optional events become `unknown_pi_event` with bounded summaries;
- malformed required shapes return typed compatibility errors.

- [ ] **Step 4: Run normalizer tests and verify the expected failure**

Run:

```bash
pixi run vitest run runtime/viewer-normalizer.test.mjs
```

Expected: FAIL because the normalizer is absent.

- [ ] **Step 5: Write viewer persistence, protocol, and crash tests**

Test persist-before-broadcast, duplicate event IDs, replay strictly after acknowledged cursor, cursor/session mismatch, daemon epoch mismatch requiring snapshot, slow-subscriber bounds, and frontend process/render/persist/ack ordering. Crash at event append, after sync before broadcast, after broadcast before ACK, during snapshot publication, and during daemon reconciliation.

Add strict operations `get_viewer_snapshot`, `subscribe_viewer`, and `ack_viewer`; viewer responses never include raw diagnostics. Test snapshot plus replay reconstructs chat, tools, pending UI, model, thinking, active activity, runtime identity, and errors.

- [ ] **Step 6: Run persistence/integration tests and verify the expected failure**

Run:

```bash
pixi run vitest run runtime/viewer-store.test.mjs runtime/event-store.test.mjs runtime/control-server.test.mjs runtime/reconciliation.failure.test.mjs app/daemon-client.test.mjs test/viewer-recovery.integration.test.mjs
```

Expected: FAIL because viewer storage and socket operations are absent.

- [ ] **Step 7: Implement the minimal normalization pipeline**

Read canonical history incrementally, then feed historical entries and T18 raw frames through one normalizer. Persist normalized events before broadcast. Build snapshots from the durable store plus registry/runtime state. Keep viewer cursors independent from command/event cursors and bind them to one session and daemon epoch.

Integrate the daemon as the sole normalizer/store writer. On restart, reconcile registry, supervisors, command journals, viewer stores, and cursor epochs before mutations. Implement client snapshot/subscribe/ack methods. Unknown optional data stays bounded; missing required data is typed and session-scoped.

- [ ] **Step 8: Run focused, dependency, and full gates**

Run:

```bash
pixi run typecheck
pixi run vitest run runtime/session-history.test.mjs runtime/viewer-normalizer.test.mjs runtime/viewer-store.test.mjs
pixi run vitest run runtime/event-store.test.mjs runtime/control-server.test.mjs runtime/daemon.integration.test.mjs runtime/reconciliation.failure.test.mjs
pixi run vitest run app/daemon-client.test.mjs test/viewer-recovery.integration.test.mjs
pixi run test
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit T19**

```bash
pixi run git add runtime app/daemon-client.mjs app/daemon-client.test.mjs test/viewer-recovery.integration.test.mjs
pixi run git commit -m "feat: add normalized viewer protocol"
```

## Milestone 8: Standalone Pi-style viewer

### Task 20: Build the full-screen interactive chat viewer

**Files:**
- Create: `app/viewer/pi-component-adapters.mjs`
- Create: `app/viewer/pi-component-adapters.test.mjs`
- Create: `app/viewer/transcript.mjs`
- Create: `app/viewer/transcript.test.mjs`
- Create: `app/viewer/overlays.mjs`
- Create: `app/viewer/overlays.test.mjs`
- Create: `app/viewer/return-gesture.mjs`
- Create: `app/viewer/return-gesture.test.mjs`
- Create: `app/viewer/viewer-controller.mjs`
- Create: `app/viewer/viewer-controller.test.mjs`
- Modify: `app/app-controller.mjs`
- Modify: `app/app-controller.test.mjs`
- Modify: `app/standalone.mjs`
- Modify: `app/standalone.test.mjs`
- Modify: `app/list/dashboard-layout.mjs`
- Modify: `app/list/dashboard-layout.test.mjs`
- Modify: `app/list/__snapshots__/dashboard-layout.test.mjs.snap`
- Modify: `app/list/dashboard.mjs`
- Modify: `app/list/dashboard.test.mjs`
- Create: `test/public-pi-imports.test.mjs`

**Consumes:** T17 viewer contracts, relocated list/app shell, daemon client boundary, and public package-root Pi UI exports. During parallel work it uses literal fake viewer snapshots/events; T19 supplies the real backend.

**Produces:** list-to-viewer navigation, Pi-style chat components, transcript virtualization, activity/status, pending overlays, composer/observer behavior, and exact return/input gestures.

```js
export class ViewerController {
  constructor({ sessionId, client, editor, persistence, requestRender, onReturn }) {}
  open() {}
  render(width, height) {}
  handleInput(data) {}
  close() {}
}
```

- [ ] **Step 1: Write public import and component adapter tests**

Import only from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`. Instantiate `UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`, `CustomEditor`, `TuiAltScreen`, `ScrollView`, `SelectList`, `SettingsList`, `Input`, `DynamicBorder`, `Markdown`, and theme/keybinding helpers with normalized literal fixtures.

Audit shipped app source and fail on deep package paths, private interactive controllers, or an in-process agent session. Every rendered line must satisfy `visibleWidth(line) <= width`.

- [ ] **Step 2: Run component tests and verify the expected failure**

Run:

```bash
pixi run vitest run app/viewer/pi-component-adapters.test.mjs test/public-pi-imports.test.mjs
```

Expected: FAIL because viewer adapters are absent.

- [ ] **Step 3: Write transcript and chat-state tests**

Cover user/assistant cards, streaming markdown, hidden and visible thinking, tool pending/running/streaming/completed/failed states, retry, compaction, reconnect, system errors, unknown events, active status, placeholders, model/thinking changes, paused follow mode, new-activity marker, tool expansion, and visible-block-only rendering.

- [ ] **Step 4: Run transcript tests and verify the expected failure**

Run:

```bash
pixi run vitest run app/viewer/transcript.test.mjs app/viewer/overlays.test.mjs
```

Expected: FAIL because transcript and viewer overlays are absent.

- [ ] **Step 5: Write input, role, and navigation tests**

Test idle Enter sends durable `prompt`; working Enter sends `follow_up`; explicit action sends `steer`; Ctrl+C sends `interrupt`; pending confirm/select/input/editor sends one `ui_response`. Observer mode disables every mutation while preserving scroll, search, and tool inspection. Per-session drafts/history do not leak across sessions.

Use a fake clock for the exact return table: clean empty Left or Escape returns once; edited/history state arms the pressed key; only the same key within 500 ms returns; a different key, overlay capture, or timeout cancels. Enter/Right from the list replaces it with the viewer and returning restores selected session ID and list scroll.

- [ ] **Step 6: Run input/navigation tests and verify the expected failure**

Run:

```bash
pixi run vitest run app/viewer/return-gesture.test.mjs app/viewer/viewer-controller.test.mjs app/app-controller.test.mjs app/standalone.test.mjs
```

Expected: FAIL because the viewer controller and app replacement flow are absent.

- [ ] **Step 7: Write list column and terminal-size tests**

Add a non-snapshot assertion:

```js
expect(layout.columns.map(({ key }) => key)).toEqual(["id", "state", "project", "activity", "age"]);
expect(renderColumnHeader(layout)).not.toContain("MODEL");
```

Snapshot list and viewer fixtures at `160x40`, `120x32`, `80x24`, `55x16`, and `40x10`. Selection remains stable by canonical ID through updates, filters, sort, resize, and list/viewer replacement.

- [ ] **Step 8: Run layout tests and verify the expected failure**

Run:

```bash
pixi run vitest run app/list/dashboard-layout.test.mjs app/list/dashboard.test.mjs app/viewer/viewer-controller.test.mjs
```

Expected: FAIL because the wide list still includes Model and places Age before Project/Activity.

- [ ] **Step 9: Implement the minimal public-component viewer**

Adapt normalized records to the pinned public component types without replacing their rendering/input behavior. Compose lifecycle/pending surfaces from public primitives only when no high-level public component fits. Use `TuiAltScreen` plus a virtual transcript, Pi theme tokens, native component spacing, `CustomEditor`, Pi keybindings, IME focus propagation, focused overlays, working indicator, and compact dashboard header/footer.

The app controller owns list/viewer replacement and disposal. Viewer event order is process, render, persist cursor, ACK. Render/persistence failure closes only the viewer subscription and signals no process. Enforce role restrictions in the UI in addition to T17 daemon authorization.

- [ ] **Step 10: Run focused, dependency, and full gates**

Run:

```bash
pixi run typecheck
pixi run vitest run app/viewer/*.test.mjs test/public-pi-imports.test.mjs
pixi run vitest run app/app-controller.test.mjs app/standalone.test.mjs app/list/*.test.mjs
pixi run test
```

Expected: all commands exit 0.

- [ ] **Step 11: Commit T20**

```bash
pixi run git add app test/public-pi-imports.test.mjs
pixi run git commit -m "feat: add standalone pi chat viewer"
```

## Milestone 9: Standalone acceptance

### Task 21: Prove package, migration, lifecycle, security, and terminal acceptance

**Files:**
- Create: `test/package.acceptance.test.mjs`
- Create: `test/lifecycle.acceptance.test.mjs`
- Create: `test/terminal.acceptance.test.mjs`
- Modify: `test/migration.integration.test.mjs`
- Modify: `test/installed-pi.integration.test.mjs`
- Modify: `test/mixed-pi-versions.integration.test.mjs`
- Modify: `test/destructive-actions.integration.test.mjs`
- Modify: `runtime/process-signaler.test.mjs`
- Modify: `isolation/cleanup.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `pixi.toml`
- Modify: `pixi.lock`
- Modify: `tsconfig.json`
- Modify: `README.md`

**Consumes:** integrated T17-T20 and the complete design acceptance criteria.

**Produces:** package/lifecycle/terminal acceptance harnesses, six read-only review reports, one accepted-finding fix commit, full release evidence, and post-acceptance repository-rename instructions. It does not publish npm.

- [ ] **Step 1: Write packed/local/global/npx acceptance tests**

Create one tarball with structured process spawning and isolated `HOME`, npm prefix, npm cache, cwd, and `PATH`. Exercise:

```text
npm install --prefix <tmp>/local --ignore-scripts <absolute-repository-path>
<tmp>/local/node_modules/.bin/pi-dashboard --help
npm install --global --prefix <tmp>/global --ignore-scripts <tarball>
<tmp>/global/bin/pi-dashboard --help
npx --yes --offline --cache <tmp>/cache --package <tarball> pi-dashboard --help
```

Assert package-relative startup from an unrelated cwd, no lifecycle scripts, and no private state, diagnostics, sessions, worktrees, `.superpowers`, `.vscode`, caches, legacy UI directories, or package extension manifest. Legacy product strings are allowed only in migration code/fixtures. Do not contact a registry.

- [ ] **Step 2: Run package acceptance and verify the expected failure**

Run:

```bash
pixi run vitest run test/package.acceptance.test.mjs
```

Expected: FAIL until standalone scripts, packed contents, and README commands are complete.

- [ ] **Step 3: Write lifecycle, recovery, and mixed-version acceptance tests**

Launch two fake installed Pi children concurrently. Close the app and frontend and assert both exact identities remain alive with no signals. Restart only the daemon, wait for both supervisors to reauthenticate, emit later RPC events, and reconstruct normalized replay from prior cursors.

Replace executable A with B. Existing run records/processes retain A identity/version/capabilities/adapter; a new run records B. Restart and reconcile both. Resume keeps canonical session ID/file and one writer. Required capability refusal starts no writer. Unknown optional events remain visible as generic activity.

- [ ] **Step 4: Write migration and destructive acceptance tests**

Cover a verified live legacy daemon, interrupted migration stages, matching completed migration, destination collision, source preservation, unchanged canonical session/worktree paths, and one reconciled destination daemon.

Reuse the destructive suite and assert confirmation binds ID, revision, process state, ownership, and action. Pin graceful request, 5,000 ms wait, TERM, identity reinspection, 5,000 ms wait, and KILL. Keep a sentinel group alive. Delete without the public trash seam returns `TRASH_CAPABILITY_UNAVAILABLE` and does not unlink session/worktree paths. App close, render failure, and reconnect invoke no Stop/Delete action.

- [ ] **Step 5: Write terminal acceptance tests**

Drive the standalone controller at all five design dimensions. Pin list and chat frames, ID/State/Project/Activity/Age columns, Enter/Right open, Left/Escape return table, context-sensitive Ctrl+C, search/filter/sort/group/metadata/help, tool expansion, pending overlays, observer restrictions, and Stop-then-Delete.

- [ ] **Step 6: Run lifecycle/terminal/destructive tests and verify the expected failure**

Run:

```bash
pixi run vitest run test/lifecycle.acceptance.test.mjs test/mixed-pi-versions.integration.test.mjs test/migration.integration.test.mjs
pixi run vitest run test/terminal.acceptance.test.mjs
pixi run vitest run test/destructive-actions.integration.test.mjs runtime/process-signaler.test.mjs isolation/cleanup.test.mjs
```

Expected: FAIL until the integrated T17-T20 paths satisfy complete acceptance.

- [ ] **Step 7: Add deterministic acceptance scripts and documentation**

Add `test:acceptance` and Pixi `test-acceptance`. Exclude acceptance files from unit tests, include `app/**/*.mjs` and `cli/**/*.mjs` in checkJs/typecheck, and document standalone install, `--pi-bin`, daemon recovery, observer/composer behavior, diagnostics privacy/limits, migration refusal/recovery, Stop/Delete/cleanup, and support boundaries.

- [ ] **Step 8: Run parallel read-only review lanes**

Dispatch six fresh reviewers against the same integrated commit:

1. Package and migration: rename completeness, schema conversion, lock/publication order, package contents.
2. Executable and protocol: discovery/TOCTOU, no-inference probe, structured launch, identities, reconnect.
3. Normalization and diagnostics: history/live dedup, crash ordering, cursors, 32/8 MiB bounds, privacy.
4. TUI and public Pi UI: list columns, chat parity, input contexts, sizes, root imports, disposal.
5. Lifetime and destructive safety: survival, ownership, mixed versions, exact signals, trash, cleanup.
6. Delivery and documentation: scripts, install journeys, README accuracy, release evidence.

Reviewers are read-only and write evidence-backed findings. The parent dispositions findings. One separate writer applies all accepted fixes; then one scoped re-review checks only that fix range.

- [ ] **Step 9: Run the complete release gate**

Run:

```bash
pixi install --locked
pixi run typecheck
pixi run test-unit
pixi run test-integration
pixi run test-acceptance
pixi run test
pixi run pack-check
```

Expected: all commands exit 0 on a clean checkout. Inspect the packed file list, migration failpoint matrix, fake-Pi probe/argv log, process identity table before/after reconnect, mixed-version records, diagnostic size/mode table, five terminal snapshots, import audit, and sentinel result.

- [ ] **Step 10: Commit T21 evidence and accepted fixes**

```bash
pixi run git add test runtime/process-signaler.test.mjs isolation/cleanup.test.mjs package.json package-lock.json pixi.toml pixi.lock tsconfig.json README.md
pixi run git commit -m "test: attest standalone pi dashboard"
```

- [ ] **Step 11: Record the post-acceptance repository rename gate**

After T21 is accepted, rename the private repository remote and primary checkout to `pi-dashboard`. Do not rename canonical Pi session files or managed worktrees. Do not publish npm as part of this step.

## Review protocol

Each implementation task uses one fresh implementer and one fresh task reviewer. A task is complete only when its focused commands and `pixi run test` pass on its branch and the reviewer approves spec compliance and code quality. Critical or important findings return to the same writer with a failing regression test where applicable. Parallel task branches merge serially according to the dependency graph, with a full suite after each merge.

## Final validation commands

```bash
pixi install --locked
pixi run typecheck
pixi run test-unit
pixi run test-integration
pixi run test-acceptance
pixi run test
pixi run pack-check
```

## Execution stop rules

- Stop a migration before mutation if a verified legacy daemon/supervisor is active, destination identity conflicts, modes/owners/symlinks are unsafe, or the source is malformed.
- Stop a launch before ownership if executable identity changes, required RPC capabilities are missing, or the probe would need model inference.
- Stop worker readiness if supervisor/child identity, process-group membership, lease, generation, executable identity, or `get_state` differs from the accepted launch.
- Stop viewer mutation when the socket is observer or unattached.
- Stop destructive action when ID, revision, ownership, action, or process identity differs from confirmation.
- Stop release attestation if any required test/review finding is undispositioned, a packed artifact contains private state, or the product depends on a private Pi import.
- Ask for approval before changing product behavior, configuration defaults, diagnostic limits, migration retention, process lifetime, isolation, trash scope, or attachment arbitration.
