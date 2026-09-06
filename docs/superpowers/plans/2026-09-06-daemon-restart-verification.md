# Daemon Restart Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pi-agents daemon restart` prove it replaced the daemon, so a stale process cannot keep serving launches behind a success message.

**Architecture:** `runDaemonCommand("restart")` already stops then starts, but its `start` leg returns `{ kind: "daemon_started", alreadyRunning: true }` when it finds a healthy daemon, and the CLI prints only the kind. An operator therefore cannot distinguish "a new daemon is serving" from "the old one still is". Restart compares the published process identity before and after, refuses when it did not change, and the CLI prints the identity either way. A real-process test then pins that a restarted daemon still serves a launch.

**Tech Stack:** Node 22+ ESM, vitest, existing fixtures `runtime/test-fixtures.mjs`, `test/real-process-harness.mjs`, `test/fixtures/fake-pi.mjs`.

**Spec:** This document. It comes from a production failure on 2026-09-06: daemon PID 3997071 (started 2026-09-05T17:18:54Z) kept serving after `daemon restart` reported `daemon_started`; every launch against it spent the worker's full 15,000 ms startup deadline and failed with `WORKER_STARTUP_DEADLINE`, and the shipped fix `47bb152` was never loaded.

## Global Constraints

- Run every test through SLURM: `l40-reserved`, `--qos=dev`. Never on the login node.
- Unset `PIXI_PROJECT_MANIFEST` in every test command so the worktree under test is the one measured.
- Do not change the worker socket protocol, the process-identity checks, or `DEFAULT_STOP_POLICY`.
- Result objects are contracts: add fields, never rename or remove `kind`, `alreadyRunning`, `root`, `publication`.
- Exit codes keep their meanings: `0` success, `1` failure, `5` identity or ownership conflict.
- One behavior per test, named for the operator-visible outcome.

## File Structure

- `cli/daemon-commands.mjs` — owns `runDaemonCommand`. Task 1 adds the replacement check to the `restart` branch only.
- `cli/daemon-commands.test.mjs` — unit tests for that decision, using injected `inspectEndpoint` / `inspect` / `spawnDaemon`.
- `cli/main.mjs` — renders results for humans. Task 2 prints the daemon identity.
- `cli/main.test.mjs` — asserts printed text.
- `test/daemon-restart.acceptance.test.mjs` — new. Task 3 runs a real daemon and a real launch across a restart.

---

### Task 1: Restart refuses to report success when the daemon was not replaced

**Files:**
- Modify: `cli/daemon-commands.mjs` (the `if (command === "restart")` branch, currently the last branch before `INVALID_DAEMON_COMMAND`)
- Test: `cli/daemon-commands.test.mjs`

**Interfaces:**
- Consumes: `runDaemonCommand(command, options)`; `options.inspectEndpoint` resolving `{ status, daemonState, publication }`; `publication` carrying `{ pid, startIdentity, processGroupId, tokenPath }`.
- Produces: restart resolves `{ code: 0, result: { kind: "daemon_restarted", root, publication, replacedPublication } }` on success, and `{ code: 5, error: { code: "DAEMON_NOT_REPLACED", message } }` when the published identity after start equals the one before. `replacedPublication` is the pre-restart publication, or `null` when none was running.

- [ ] **Step 1: Write the failing test**

Add to `cli/daemon-commands.test.mjs`:

```javascript
// A restart that finds the endpoint absent, then loses the race to a daemon that publishes itself
// again, used to return the start leg's `alreadyRunning` success. That is how a process from the
// previous day kept serving every launch while the operator read "daemon_started".
it("refuses when restart did not replace the running daemon", async () => {
  const root = await stateRoot();
  const old = { pid: 4242, startIdentity: "111222333", processGroupId: 4242, tokenPath: join(root, "daemon", "control.token") };
  let inspections = 0;
  /** @type {string[][]} */
  const spawned = [];

  const result = await runDaemonCommand("restart", {
    root,
    timeoutMs: 200,
    stopPolicy: { gracefulMs: 1, terminateMs: 1 },
    inspect: async () => old,
    // Absent for restart's own look, healthy again by the time start re-reads it.
    inspectEndpoint: async () => {
      inspections += 1;
      return inspections === 1
        ? { status: "ABSENT", canCleanup: false }
        : { status: "HEALTHY", daemonState: "READY", publication: old };
    },
    spawnDaemon: (/** @type {string} */ _file, /** @type {string[]} */ argv) => { spawned.push(argv); return { once() {} }; },
  });

  expect(result).toMatchObject({ code: 5, error: { code: "DAEMON_NOT_REPLACED" } });
  expect(result.error.message).toContain(String(old.pid));
  expect(spawned).toEqual([]);
});

it("reports the identity it replaced when restart starts a new daemon", async () => {
  const root = await stateRoot();
  const old = { pid: 4242, startIdentity: "111222333", processGroupId: 4242, tokenPath: join(root, "daemon", "control.token") };
  /** @type {Map<number, any>} */
  const live = new Map([[old.pid, old]]);
  /** @type {any} */
  let publication = old;

  const result = await runDaemonCommand("restart", {
    root,
    timeoutMs: 200,
    stopPolicy: { gracefulMs: 1, terminateMs: 1 },
    request: async () => ({ kind: "state", sessions: [] }),
    inspect: async (/** @type {number} */ pid) => {
      const identity = live.get(pid);
      if (identity === undefined) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      return identity;
    },
    inspectEndpoint: async () => publication === undefined ? { status: "ABSENT", canCleanup: false } : { status: "HEALTHY", daemonState: "READY", publication },
    requestGraceful: async () => { live.delete(old.pid); publication = undefined; },
    signalProcessGroup: () => {},
    spawnDaemon: () => {
      const pid = 5001;
      live.set(pid, { pid, startIdentity: "999888777", processGroupId: pid });
      publication = { pid, startIdentity: "999888777", processGroupId: pid, tokenPath: old.tokenPath };
      return { once() {} };
    },
  });

  expect(result).toMatchObject({
    code: 0,
    result: { kind: "daemon_restarted", publication: { pid: 5001 }, replacedPublication: { pid: 4242 } },
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /mnt/main0/home/gjohnson/projects/pi-agents-input-cursor
env -u PIXI_PROJECT_MANIFEST srun -c 4 --mem 16G -p l40-reserved --qos=dev \
  --output=/tmp/restart-red-%j.out --error=/tmp/restart-red-%j.err \
  pixi run npm test -- cli/daemon-commands.test.mjs
```

Expected: both fail. The first returns `{ code: 0, result: { kind: "daemon_started", alreadyRunning: true } }`; the second returns `kind: "daemon_started"` with no `replacedPublication`.

- [ ] **Step 3: Write the implementation**

Replace the `restart` branch in `cli/daemon-commands.mjs` with:

```javascript
  if (command === "restart") {
    const current = await inspectEndpoint(common);
    const replaced = current.status === "HEALTHY" ? current.publication : undefined;
    if (current.status === "HEALTHY") {
      const stopped = await runDaemonCommand("stop", { ...options, root, allowLiveWorkers: true });
      if (stopped.code !== 0) return stopped;
    } else if (current.status !== "ABSENT") return { code: current.status === "CONFLICT" ? 5 : 1, error: { code: "RESTART_REFUSED", message: "Daemon endpoint requires explicit recovery" } };
    const started = await runDaemonCommand("start", { ...options, root });
    if (started.code !== 0) return started;
    // `start` succeeds against a daemon that was already healthy, which is how a process this
    // restart meant to replace keeps serving every later launch under a success message.
    const publication = started.result.publication;
    if (started.result.alreadyRunning === true) {
      return { code: 5, error: { code: "DAEMON_NOT_REPLACED", message: `Daemon ${publication?.pid} is still serving this root; restart did not replace it` } };
    }
    return { code: 0, result: { kind: "daemon_restarted", root, publication, replacedPublication: replaced ?? null } };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /mnt/main0/home/gjohnson/projects/pi-agents-input-cursor
env -u PIXI_PROJECT_MANIFEST srun -c 4 --mem 16G -p l40-reserved --qos=dev \
  --output=/tmp/restart-green-%j.out --error=/tmp/restart-green-%j.err \
  pixi run npm test -- cli/daemon-commands.test.mjs
```

Expected: PASS, including the existing `leaves exactly one daemon when restart cannot prove the old one is gone`.

- [ ] **Step 5: Commit**

```bash
git add cli/daemon-commands.mjs cli/daemon-commands.test.mjs
git commit -m "daemon: refuse a restart that did not replace the daemon"
```

---

### Task 2: The CLI prints which daemon is serving

**Files:**
- Modify: `cli/main.mjs` (the human-readable result renderer)
- Test: `cli/main.test.mjs`

**Interfaces:**
- Consumes: `{ kind: "daemon_restarted", publication, replacedPublication }` and `{ kind: "daemon_started", alreadyRunning, publication }` from Task 1.
- Produces: no new exports. Standard output for a restart reads `daemon_restarted pid=<new> replaced=<old>`, and for a start that found one running, `daemon_started pid=<pid> already_running`.

- [ ] **Step 1: Write the failing test**

Add to `cli/main.test.mjs`:

```javascript
// "daemon_started" alone cannot distinguish a new process from the one it was meant to replace, so
// a deploy that verified the word instead of the identity shipped nothing.
it("names the daemon identity a restart installed and the one it replaced", async () => {
  const io = capture();
  const code = await runCli(["daemon", "restart"], {
    cwd: "/repo",
    io: io.io,
    runDaemonCommand: async () => ({
      code: 0,
      result: { kind: "daemon_restarted", root: "/state", publication: { pid: 5001 }, replacedPublication: { pid: 4242 } },
    }),
  });

  expect(code).toBe(0);
  expect(io.stdout.join("")).toContain("daemon_restarted pid=5001 replaced=4242");
});

it("says a start found a daemon already running rather than reporting a bare success", async () => {
  const io = capture();
  const code = await runCli(["daemon", "start"], {
    cwd: "/repo",
    io: io.io,
    runDaemonCommand: async () => ({
      code: 0,
      result: { kind: "daemon_started", alreadyRunning: true, root: "/state", publication: { pid: 4242 } },
    }),
  });

  expect(code).toBe(0);
  expect(io.stdout.join("")).toContain("daemon_started pid=4242 already_running");
});
```

`capture()` and `runCli` already exist at the top of `cli/main.test.mjs`; `deps.runDaemonCommand` is the injection point `cli/main.mjs:74` already reads.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /mnt/main0/home/gjohnson/projects/pi-agents-input-cursor
env -u PIXI_PROJECT_MANIFEST srun -c 4 --mem 16G -p l40-reserved --qos=dev \
  --output=/tmp/main-red-%j.out --error=/tmp/main-red-%j.err \
  pixi run npm test -- cli/main.test.mjs
```

Expected: FAIL, printed text is the bare `kind`.

- [ ] **Step 3: Write the implementation**

`cli/main.mjs:44` currently writes `payload.kind ?? "ok"` for a successful non-JSON result. Give that line the identity, leaving the JSON branch untouched:

```javascript
/** A daemon result names the process now serving the root: "restarted" is otherwise unverifiable. */
function describeSuccess(payload) {
  const kind = payload.kind ?? "ok";
  if (payload.publication?.pid === undefined) return kind;
  const detail = payload.replacedPublication?.pid !== undefined
    ? ` replaced=${payload.replacedPublication.pid}`
    : payload.alreadyRunning === true ? " already_running" : "";
  return `${kind} pid=${payload.publication.pid}${detail}`;
}
```

Then at `cli/main.mjs:44` replace `payload.kind ?? "ok"` with `describeSuccess(payload)`. `--json` keeps writing the whole payload.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /mnt/main0/home/gjohnson/projects/pi-agents-input-cursor
env -u PIXI_PROJECT_MANIFEST srun -c 4 --mem 16G -p l40-reserved --qos=dev \
  --output=/tmp/main-green-%j.out --error=/tmp/main-green-%j.err \
  pixi run npm test -- cli/main.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/main.mjs cli/main.test.mjs
git commit -m "cli: print the daemon identity a start or restart installed"
```

---

### Task 3: A restarted daemon still serves a launch

**Files:**
- Create: `test/daemon-restart.acceptance.test.mjs`
- Test: the same file

**Interfaces:**
- Consumes: `createRealProcessHarness` from `test/real-process-harness.mjs`, `test/fixtures/fake-pi.mjs`, `runDaemonCommand` from `cli/daemon-commands.mjs`, `createDaemonClient` from `app/daemon-client.mjs`.
- Produces: no exports.

- [ ] **Step 1: Write the failing test**

Reuse `test/lifecycle.acceptance.test.mjs`'s setup: `createRealProcessHarness("daemon-restart-acceptance")`, the `fakePiSource` read from `test/fixtures/fake-pi.mjs`, its `setupRoot(prefix)` helper (which returns the state root and the fake Pi executable path), and its `afterEach` that closes runtimes and calls `harness.cleanup()`. Copy those into the new file rather than exporting them, matching how the acceptance tests already stand alone. Then:

```javascript
// The failure this pins: a daemon that keeps serving after a restart answers launches with nothing,
// and the worker spends its whole startup deadline before dying with WORKER_STARTUP_DEADLINE.
it("serves a launch after the daemon is restarted", async () => {
  const { root, piExecutable } = await setupRoot("daemon-restart");
  expect((await runDaemonCommand("start", { root, piBin: piExecutable })).code).toBe(0);

  const first = await runDaemonCommand("status", { root });
  expect(first).toMatchObject({ code: 0, result: { status: "HEALTHY" } });
  const before = first.result.publication.pid;

  const restarted = await runDaemonCommand("restart", { root, piBin: piExecutable });
  expect(restarted).toMatchObject({ code: 0, result: { kind: "daemon_restarted" } });
  expect(restarted.result.publication.pid).not.toBe(before);

  const client = createDaemonClient({ socketPath: join(root, "daemon", "control.sock"), clientId: "restart-acceptance" });
  const launched = await client.launch({
    prompt: "after restart",
    cwd: root,
    sourceSessionId: "acceptance",
    isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: [] },
  });

  expect(launched).toMatchObject({ kind: "launched" });
  await expect.poll(async () => (await client.getState()).sessions.at(-1)?.processState, { timeout: 30_000 })
    .toBe("LIVE");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /mnt/main0/home/gjohnson/projects/pi-agents-input-cursor
env -u PIXI_PROJECT_MANIFEST srun -c 4 --mem 16G -p l40-reserved --qos=dev \
  --output=/tmp/restart-acc-red-%j.out --error=/tmp/restart-acc-red-%j.err \
  pixi run npm test -- test/daemon-restart.acceptance.test.mjs
```

Expected: FAIL on `kind: "daemon_restarted"` if Task 1 is not yet merged, otherwise PASS. If it passes on the first run, the test is not yet pinning anything: revert Task 1's implementation locally, confirm it fails, then restore.

- [ ] **Step 3: No new implementation**

This task adds coverage only. If the launch does not reach `LIVE` against a freshly restarted daemon, stop and report it: that is a second production defect, not a test bug, and it needs its own plan.

- [ ] **Step 4: Run the full suite**

```bash
cd /mnt/main0/home/gjohnson/projects/pi-agents-input-cursor
env -u PIXI_PROJECT_MANIFEST srun -c 4 --mem 16G -p l40-reserved --qos=dev \
  --output=/tmp/full-%j.out --error=/tmp/full-%j.err \
  pixi run test
```

Expected: PASS, count at least the 1,043 currently passing plus the tests added here.

- [ ] **Step 5: Commit**

```bash
git add test/daemon-restart.acceptance.test.mjs
git commit -m "test: pin that a restarted daemon still serves a launch"
```

---

## Deploy check

After these merge, a deploy is verified by identity, not by a word:

```bash
before=$(python3 -c "import json;print(json.load(open('$STATE/daemon/pid.json'))['pid'])")
pi-agents daemon restart --json | python3 -c "import json,sys;r=json.load(sys.stdin);print(r['kind'], r['publication']['pid'])"
after=$(python3 -c "import json;print(json.load(open('$STATE/daemon/pid.json'))['pid'])")
[ "$before" != "$after" ] || { echo "daemon not replaced"; exit 1; }
```

## Out of scope

- Why the stale daemon stopped answering worker sockets. Diagnose that separately against the live root; this plan makes the condition visible, not impossible.
- The 15,000 ms worker startup deadline. It is correct to bound the wait; the defect is that nothing reported why it elapsed.
