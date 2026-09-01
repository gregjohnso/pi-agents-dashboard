import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { inspectProcessIdentity } from "../runtime/process-identity-linux.mjs";
import { readProcessLedger } from "./process-ledger.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

const harness = createRealProcessHarness("real-process-harness");
afterEach(() => harness.cleanup());

/** @param {{ pid: number, startIdentity: string, processGroupId: number }} identity */
async function matches(identity) {
  try {
    const actual = await inspectProcessIdentity(identity.pid);
    return actual.pid === identity.pid && actual.startIdentity === identity.startIdentity && actual.processGroupId === identity.processGroupId;
  } catch {
    return false;
  }
}

// Operator-visible failure: this is the exact leak that cost 47 daemons in one evening. The start
// command's own deadline expires, its detached child publishes itself seconds later, and the row
// the test was about is long gone. The record has to be on disk while the start is still waiting,
// because a runner killed during that wait writes nothing afterwards.
it("records a daemon child on disk while the start command is still waiting for it", async () => {
  const root = await harness.stateRoot("real-process-harness-", ["daemon", "sessions", "queue", "runs", "index"]);

  // 200 ms is far below a cold start, so the command gives up on a child that is still starting.
  const started = await harness.daemon("start", { root, timeoutMs: 200 });

  expect(started).toMatchObject({ code: 1, error: { code: "DAEMON_START_FAILED" } });
  const ledger = await readProcessLedger(harness.ledgerPath());
  expect(ledger.processes).toEqual([{ label: expect.stringContaining("daemon child"), identity: expect.objectContaining({ pid: expect.any(Number) }) }]);
  // The command abandons its own child, so by now the recorded entry names a process that is gone.
  // That is the normal case for a ledger entry, and reaping it must not be treated as a failure.
  expect(await matches(ledger.processes[0].identity)).toBe(false);
});

it("stops the daemon it started and leaves an empty ledger behind", async () => {
  const root = await harness.stateRoot("real-process-harness-", ["daemon", "sessions", "queue", "runs", "index"]);
  const started = await harness.daemon("start", { root, timeoutMs: 45_000 });
  expect(started).toMatchObject({ code: 0, result: { kind: "daemon_started" } });
  const publication = started.result.publication;
  const path = harness.ledgerPath();

  await harness.cleanup();

  expect(await matches(publication)).toBe(false);
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, "daemon", "pid.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}, 120_000);

it("removes the state roots it created", async () => {
  const root = await harness.stateRoot("real-process-harness-", ["sessions"]);

  await harness.cleanup();

  await expect(readFile(join(root, "sessions"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  // A second cleanup is what a suite whose afterEach already ran does; it must not throw.
  await harness.cleanup();
  await rm(root, { recursive: true, force: true });
});
