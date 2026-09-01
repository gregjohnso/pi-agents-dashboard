import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { signalProcessGroup, sleep, stopVerifiedProcessGroup } from "../runtime/process-signaler.mjs";

/**
 * A durable record of every real process a test run started, so a run that dies can still be reaped.
 *
 * A test that times out never reaches its own teardown, so anything it started outlives the run:
 * 47 daemons leaked in one evening, the oldest alive 38 hours, load reached 49, and three suites
 * were then misdiagnosed as load flakes when they were starved. The record therefore has to exist
 * on disk, written the instant the process does, rather than in the memory of the runner that died.
 *
 * Two rules make reaping safe on a machine that also runs the operator's own daemon and workers.
 * Nothing is signalled that is not named by a `process` entry some harness wrote, so a scan can
 * never mistake a neighbour for a leak. And every signal goes through `stopVerifiedProcessGroup`,
 * which re-reads PID, process-start identity and process-group ID immediately before it fires, so a
 * recorded PID that a later process now owns is refused rather than killed.
 *
 * An entry naming a process that is already gone is what a clean run looks like, not a fault.
 */

/** Where ledgers live. One file per harness, all under one directory so a whole run can be swept. */
export const LEDGER_DIRECTORY_VARIABLE = "PI_AGENTS_TEST_LEDGER_DIR";
/** Identifies the run that owns a ledger, so its own teardown reaps it whatever its writer is doing. */
export const LEDGER_RUN_VARIABLE = "PI_AGENTS_TEST_LEDGER_RUN";
export const DEFAULT_LEDGER_DIRECTORY = join(tmpdir(), "pi-agents-test-ledgers");

/**
 * Four seconds is the whole budget for one leaked process: SIGTERM, then SIGKILL two seconds later.
 * Hitting it is reported as `KILL_REQUESTED` rather than waited out, because a process still
 * matching its identity after SIGKILL is unkillable by this harness and the run must say so.
 */
export const REAP_STOP_POLICY = { gracefulMs: 2_000, terminateMs: 2_000 };

/** Dispositions that mean a leak existed and this sweep ended it. */
const REAPED_DISPOSITIONS = ["GRACEFUL", "TERMINATED", "KILLED"];
/** Dispositions that mean the entry named nothing this sweep may touch. Normal, and silent. */
const NOTHING_TO_DO_DISPOSITIONS = ["ALREADY_EXITED", "STALE_IDENTITY"];

/** @param {any} value */
function identity(value) {
  if (
    value === null || typeof value !== "object" ||
    !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
    !Number.isSafeInteger(value.processGroupId) || value.processGroupId <= 0 ||
    typeof value.startIdentity !== "string" || !/^\d+$/u.test(value.startIdentity)
  ) {
    throw new TypeError(`Process ledger identity is not an exact PID/start-identity/PGID triple: ${JSON.stringify(value)}`);
  }
  return { pid: value.pid, startIdentity: value.startIdentity, processGroupId: value.processGroupId };
}

/**
 * Open one harness's ledger and write the header that says who owns it.
 *
 * The owner is this process. A sweep uses it to tell a ledger whose run is over from one a
 * concurrently running suite is still appending to.
 *
 * @param {{ directory?: string, runId?: string, label: string, now?: () => string }} options
 */
export async function openProcessLedger({ directory = process.env[LEDGER_DIRECTORY_VARIABLE] ?? DEFAULT_LEDGER_DIRECTORY, runId = process.env[LEDGER_RUN_VARIABLE] ?? "unattributed", label, now = () => new Date().toISOString() }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${runId}.${process.pid}.${label.replace(/[^a-z0-9-]+/giu, "-")}.jsonl`);
  const owner = await inspectProcessIdentity(process.pid);
  await writeFile(path, `${JSON.stringify({ kind: "run", runId, owner, label, startedAt: now() })}\n`, { mode: 0o600 });
  return path;
}

/**
 * Record one live process before anything else happens to it.
 *
 * Call this as soon as the PID exists and its identity can be read, and always before the caller
 * does anything that could time out: the window between the spawn and this append is the only
 * window in which a hard kill still leaks.
 *
 * @param {string} path @param {string} label @param {{ pid: number, startIdentity: string, processGroupId: number }} process
 */
export async function recordProcess(path, label, process) {
  await appendFile(path, `${JSON.stringify({ kind: "process", label, identity: identity(process) })}\n`, { mode: 0o600 });
}

/**
 * Read one ledger, refusing to guess about anything in it.
 *
 * A final line with no terminating newline is an append the writer did not finish, which is what a
 * hard kill leaves; it names no complete identity and is reported rather than parsed. Any complete
 * line that does not parse is a defect in the format and throws, because a sweep that quietly skips
 * entries is a sweep that quietly stops reaping.
 *
 * @param {string} path
 * @param {{ warn?: (message: string) => void }} [options]
 */
export async function readProcessLedger(path, { warn = console.error } = {}) {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  const trailing = lines.pop();
  if (trailing !== "") warn(`process ledger ${path}: dropping an unterminated final entry, so its writer was killed mid-append`);
  /** @type {any} */
  let header;
  /** @type {{ label: string, identity: { pid: number, startIdentity: string, processGroupId: number } }[]} */
  const processes = [];
  for (const [index, line] of lines.entries()) {
    /** @type {any} */
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (cause) {
      throw new SyntaxError(`Process ledger ${path} line ${index + 1} is not JSON: ${line}`, { cause });
    }
    if (index === 0) {
      if (entry?.kind !== "run" || typeof entry.runId !== "string" || typeof entry.label !== "string") throw new TypeError(`Process ledger ${path} does not open with a run header`);
      header = { runId: entry.runId, owner: identity(entry.owner), label: entry.label };
      continue;
    }
    if (entry?.kind !== "process" || typeof entry.label !== "string") throw new TypeError(`Process ledger ${path} line ${index + 1} is not a process entry`);
    processes.push({ label: entry.label, identity: identity(entry.identity) });
  }
  if (header === undefined) throw new TypeError(`Process ledger ${path} is empty`);
  return { header, processes };
}

/**
 * Stop every process one ledger records, revalidating each identity immediately before the signal.
 *
 * Returns one result per entry. Nothing is reported here: the caller decides which dispositions are
 * worth a line, because a clean run reaches this with every entry already exited.
 *
 * @param {string} path
 * @param {{ inspect?: typeof inspectProcessIdentity, signal?: typeof signalProcessGroup, nap?: typeof sleep, stopPolicy?: { gracefulMs: number, terminateMs: number }, warn?: (message: string) => void }} [deps]
 */
export async function reapProcessLedger(path, { inspect = inspectProcessIdentity, signal = signalProcessGroup, nap = sleep, stopPolicy = REAP_STOP_POLICY, warn = console.error } = {}) {
  const { header, processes } = await readProcessLedger(path, { warn });
  /** @type {{ label: string, identity: any, disposition: string }[]} */
  const results = [];
  for (const entry of processes) {
    const stopped = await stopVerifiedProcessGroup(entry.identity, {
      inspect,
      // A recorded test process has no shutdown channel of its own, so SIGTERM is the graceful step.
      requestGraceful: async () => {},
      signalProcessGroup: signal,
      sleep: nap,
    }, stopPolicy);
    results.push({ label: `${header.label}: ${entry.label}`, identity: entry.identity, disposition: stopped.disposition });
  }
  return results;
}

/**
 * Sweep every ledger in a directory that no live run still owns, and this run's own ledgers besides.
 *
 * `runId` is what makes an end-of-run sweep safe while a second suite is running on the same box: a
 * ledger belonging to another run is touched only once its owning process is provably gone.
 *
 * @param {{ directory?: string, runId?: string, inspect?: typeof inspectProcessIdentity, signal?: typeof signalProcessGroup, nap?: typeof sleep, stopPolicy?: { gracefulMs: number, terminateMs: number }, warn?: (message: string) => void }} [options]
 */
export async function reapLedgerDirectory({ directory = process.env[LEDGER_DIRECTORY_VARIABLE] ?? DEFAULT_LEDGER_DIRECTORY, runId = process.env[LEDGER_RUN_VARIABLE], inspect = inspectProcessIdentity, signal = signalProcessGroup, nap = sleep, stopPolicy = REAP_STOP_POLICY, warn = console.error } = {}) {
  /** @type {string[]} */
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }
  /** @type {{ label: string, identity: any, disposition: string }[]} */
  const results = [];
  for (const name of names.filter((value) => value.endsWith(".jsonl")).sort()) {
    const path = join(directory, name);
    const { header } = await readProcessLedger(path, { warn });
    if (header.runId !== runId && await stillRunning(header.owner, inspect)) continue;
    results.push(...await reapProcessLedger(path, { inspect, signal, nap, stopPolicy, warn }));
    await rm(path, { force: true });
  }
  reportReapResults(results, warn);
  return results;
}

/**
 * Say what a sweep did, for everything except the two dispositions that mean it did nothing.
 *
 * An entry naming a process that already exited, or one whose PID a different process now owns, is
 * what a run that cleaned up after itself looks like. Everything else is either a leak this sweep
 * had to end or a process it could not end, and both have to reach the run's output.
 *
 * @param {{ label: string, identity: { pid: number }, disposition: string }[]} results
 * @param {(message: string) => void} warn
 */
export function reportReapResults(results, warn) {
  for (const result of results) {
    if (NOTHING_TO_DO_DISPOSITIONS.includes(result.disposition)) continue;
    const what = REAPED_DISPOSITIONS.includes(result.disposition) ? "reaped a leaked process" : "could not stop a recorded process";
    warn(`process ledger: ${what} ${result.identity.pid} (${result.label}) — ${result.disposition}`);
  }
}

/** @param {{ pid: number, startIdentity: string, processGroupId: number }} expected @param {typeof inspectProcessIdentity} inspect */
async function stillRunning(expected, inspect) {
  try {
    const actual = await inspect(expected.pid);
    return actual.pid === expected.pid && actual.startIdentity === expected.startIdentity && actual.processGroupId === expected.processGroupId;
  } catch {
    return false;
  }
}
