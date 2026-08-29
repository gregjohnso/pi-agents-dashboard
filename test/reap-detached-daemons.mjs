import { execFileSync } from "node:child_process";

/**
 * Reap dashboard daemons a test run left behind.
 *
 * Acceptance and migration tests start detached daemons on `mkdtemp` roots. A test that fails, times
 * out, or is interrupted skips its own teardown, and the daemon then outlives both the test and its
 * state directory: one such process survived 16 hours and 600 MB of them accumulated in a day.
 * Only daemons started after this run began and rooted under the system temporary directory are
 * touched, so a developer's real daemon and any concurrently running suite are left alone.
 */
const TEMPORARY_ROOT = /--root (\/tmp\/[^\s]+)/u;

/** @param {string} listing @param {number} maxAgeSeconds */
export function detachedDaemonsToReap(listing, maxAgeSeconds) {
  const reaped = [];
  for (const line of listing.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    const pid = Number(fields[0]);
    const ageSeconds = Number(fields[1]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ageSeconds)) continue;
    if (!line.includes("runtime/daemon.mjs")) continue;
    const root = TEMPORARY_ROOT.exec(line)?.[1];
    if (root === undefined || ageSeconds > maxAgeSeconds) continue;
    reaped.push({ pid, root });
  }
  return reaped;
}

export function setup() {
  process.env.VITEST_RUN_STARTED_SECONDS = String(Math.floor(Date.now() / 1000));
}

export function teardown() {
  // Off unless asked for: several suites can run concurrently on one machine, and a reaper that
  // cannot tell whose daemon it is would kill a neighbour's mid-run.
  if (process.env.PI_AGENTS_REAP_TEST_DAEMONS !== "1") return;
  const startedAt = Number(process.env.VITEST_RUN_STARTED_SECONDS ?? 0);
  const maxAge = startedAt > 0 ? Math.ceil(Date.now() / 1000) - startedAt + 60 : 3_600;
  let listing = "";
  try {
    listing = execFileSync("ps", ["-eo", "pid,etimes,args"], { encoding: "utf8" });
  } catch {
    return;
  }
  for (const { pid } of detachedDaemonsToReap(listing, maxAge)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
}
