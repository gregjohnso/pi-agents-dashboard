import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { LEDGER_DIRECTORY_VARIABLE, LEDGER_RUN_VARIABLE, openProcessLedger, readProcessLedger, reapLedgerDirectory, recordProcess } from "./process-ledger.mjs";
import { setup, teardown } from "./reap-test-processes.mjs";

const SLEEPER = fileURLToPath(new URL("./fixtures/sleeper.mjs", import.meta.url));
const DEAD_PID = 0x7ffffffe;
/** @type {{ pid: number, startIdentity: string, processGroupId: number }[]} */
const spawned = [];
/** @type {string[]} */
const directories = [];
const ledgerEnvironment = { directory: process.env[LEDGER_DIRECTORY_VARIABLE], run: process.env[LEDGER_RUN_VARIABLE] };

afterEach(async () => {
  // Explicit teardown by PID, and only for identities this file spawned and verified, so a red
  // assertion above cannot leak one of these into the operator's process table.
  for (const identity of spawned.splice(0)) if (await matches(identity)) process.kill(-identity.processGroupId, "SIGKILL");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  restore(LEDGER_DIRECTORY_VARIABLE, ledgerEnvironment.directory);
  restore(LEDGER_RUN_VARIABLE, ledgerEnvironment.run);
});

/** @param {string} name @param {string | undefined} value */
function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Start one real detached process group and read back its exact identity. @param {string[]} extraArgv */
async function startSleeper(extraArgv = []) {
  const child = spawn(process.execPath, [SLEEPER, ...extraArgv], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
  const identity = await inspectProcessIdentity(/** @type {number} */ (child.pid));
  spawned.push(identity);
  return identity;
}

/** @param {{ pid: number, startIdentity: string, processGroupId: number }} identity */
async function matches(identity) {
  try {
    const actual = await inspectProcessIdentity(identity.pid);
    return actual.pid === identity.pid && actual.startIdentity === identity.startIdentity && actual.processGroupId === identity.processGroupId;
  } catch {
    return false;
  }
}

/** @param {{ pid: number, startIdentity: string, processGroupId: number }} identity */
async function goneWithin(identity, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!(await matches(identity))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Write the durable ledger by hand, so the format itself is what this pins. @param {any[]} entries */
async function ledgerFile(entries) {
  const directory = await mkdtemp(join(tmpdir(), "pi-agents-ledger-"));
  directories.push(directory);
  const path = join(directory, "written-by-hand.jsonl");
  await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
  process.env[LEDGER_DIRECTORY_VARIABLE] = directory;
  return path;
}

/** @param {string} runId @param {any} owner */
function runHeader(runId, owner) {
  return { kind: "run", runId, owner, label: "hand-written", startedAt: "2026-08-25T12:00:00.000Z" };
}

// Operator-visible failure: a test that times out never runs its own teardown, and the daemon it
// started outlives the run. 47 leaked in one evening, the oldest alive 38 hours, load reached 49,
// and three suites were misdiagnosed as load flakes when they were starved. A record written the
// instant the process exists is the only thing a hard-killed runner leaves behind.
it("reaps a process the run ledger records, and never one it does not", async () => {
  const recorded = await startSleeper();
  // A decoy whose command line is exactly what the previous ps scan matched on. Nothing recorded
  // it, so nothing may signal it: this is the protection the operator's own daemon relies on.
  const decoy = await startSleeper(["runtime/daemon.mjs", "--root", "/tmp/pi-agents-decoy/state"]);
  await ledgerFile([
    runHeader("run-under-test", await inspectProcessIdentity(process.pid)),
    { kind: "process", label: "leaked daemon", identity: recorded },
  ]);
  process.env[LEDGER_RUN_VARIABLE] = "run-under-test";

  await teardown();

  expect(await goneWithin(recorded)).toBe(true);
  expect(await matches(decoy)).toBe(true);
});

// A run that starts on a machine still holding a previous run's leak must clear it before its own
// suites compete with it for the box, not only after they have all finished.
it("reaps a previous run's ledger at the start of a run", async () => {
  const orphan = await startSleeper();
  await ledgerFile([
    runHeader("previous-run", { pid: DEAD_PID, startIdentity: "1", processGroupId: DEAD_PID }),
    { kind: "process", label: "leaked daemon", identity: orphan },
  ]);
  delete process.env[LEDGER_RUN_VARIABLE];

  await setup();

  expect(await goneWithin(orphan)).toBe(true);
});

// PID reuse is why the repository forbids a bare `process.kill`: the number in a ledger written
// minutes ago may name someone else's process by the time the reaper reads it.
it("refuses a recorded PID whose process-start identity no longer matches", async () => {
  const live = await startSleeper();
  await ledgerFile([
    runHeader("run-under-test", await inspectProcessIdentity(process.pid)),
    { kind: "process", label: "reused pid", identity: { ...live, startIdentity: String(BigInt(live.startIdentity) + 1n) } },
  ]);
  process.env[LEDGER_RUN_VARIABLE] = "run-under-test";

  await teardown();

  expect(await matches(live)).toBe(true);
});

// Two suites do run on this box at once. The previous reaper was opt-in because it could not tell a
// neighbour's daemon from a leak; skipping a ledger whose writer is alive is what replaces that flag.
it("leaves a concurrently running run's ledger and its processes alone", async () => {
  const neighbour = await startSleeper();
  const path = await ledgerFile([
    runHeader("another-run", await inspectProcessIdentity(process.pid)),
    { kind: "process", label: "neighbour daemon", identity: neighbour },
  ]);
  process.env[LEDGER_RUN_VARIABLE] = "run-under-test";

  await teardown();

  expect(await matches(neighbour)).toBe(true);
  await expect(readFile(path, "utf8")).resolves.toContain("neighbour daemon");
});

// A sweep that quietly skips a line it cannot read is a sweep that quietly stops reaping, which is
// worse than one that fails: the leak returns and nothing says so.
it("refuses a ledger it cannot read rather than sweeping part of it", async () => {
  const path = await ledgerFile([runHeader("run-under-test", await inspectProcessIdentity(process.pid))]);
  await writeFile(path, `${await readFile(path, "utf8")}{"kind":"process"\n`, { mode: 0o600 });

  await expect(readProcessLedger(path)).rejects.toThrow(/line 2 is not JSON/u);
});

// A hard kill can land between the write of a line and its newline. That last line names no
// complete identity, so it is reported and dropped; everything before it still reaps.
it("drops an unterminated final entry and says the writer was killed mid-append", async () => {
  const recorded = await startSleeper();
  const path = await ledgerFile([
    runHeader("run-under-test", await inspectProcessIdentity(process.pid)),
    { kind: "process", label: "leaked daemon", identity: recorded },
  ]);
  await writeFile(path, `${await readFile(path, "utf8")}{"kind":"process","label":"half`, { mode: 0o600 });
  /** @type {string[]} */
  const warnings = [];

  const ledger = await readProcessLedger(path, { warn: (message) => warnings.push(message) });

  expect(ledger.processes).toEqual([{ label: "leaked daemon", identity: recorded }]);
  expect(warnings).toEqual([expect.stringContaining("killed mid-append")]);
});
