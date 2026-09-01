import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { DEFAULT_LEDGER_DIRECTORY, LEDGER_DIRECTORY_VARIABLE, LEDGER_RUN_VARIABLE, reapLedgerDirectory } from "./process-ledger.mjs";

/**
 * Reap the real processes a test run leaves behind, at both ends of the run.
 *
 * At the start, because a run that begins on a box still carrying the last run's leak competes with
 * it for the machine rather than inheriting a clean one. At the end, because a suite that timed out
 * skipped its own teardown minutes ago and nothing else will ever come back for it.
 *
 * Both sweeps read `test/process-ledger.mjs`, so both signal only processes a harness recorded, and
 * both revalidate each identity immediately before the signal. A ledger another run still owns is
 * left alone: two suites do run on this box at once, and the previous reaper was opt-in precisely
 * because it could not tell them apart.
 */

/** @returns {Promise<void>} */
export async function setup() {
  const directory = process.env[LEDGER_DIRECTORY_VARIABLE] ?? DEFAULT_LEDGER_DIRECTORY;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  process.env[LEDGER_DIRECTORY_VARIABLE] = directory;
  process.env[LEDGER_RUN_VARIABLE] = randomUUID();
  await reapLedgerDirectory({ directory, runId: process.env[LEDGER_RUN_VARIABLE] });
}

/** @returns {Promise<void>} */
export async function teardown() {
  await reapLedgerDirectory();
}
