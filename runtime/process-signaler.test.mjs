import { expect, it } from "vitest";

import { loadDashboardConfig } from "../shared/config.mjs";
import { stopVerifiedProcessGroup } from "./process-signaler.mjs";
import {
  createFakeSignaler,
  createFakeSleep,
  createSequenceInspector,
} from "./test-fixtures.mjs";

const ownership = { pid: 321, processGroupId: 654, startIdentity: "987654321" };
const reusedIdentity = { pid: 321, processGroupId: 654, startIdentity: "987654999" };
const policy = loadDashboardConfig({
  stop: { gracefulMs: 123, terminateMs: 456 },
}).stop;

/** @param {unknown[]} inspections @param {any} [options] */
function dependencies(inspections, options = {}) {
  const inspector = createSequenceInspector(inspections);
  const signaler = options.signaler ?? createFakeSignaler();
  const sleeper = options.sleeper ?? createFakeSleep();
  return {
    deps: {
      inspect: inspector.inspect,
      requestGraceful: signaler.requestGraceful,
      signalProcessGroup: signaler.signalProcessGroup,
      sleep: sleeper.sleep,
      abortSignal: options.abortSignal,
    },
    inspector,
    signaler,
    sleeper,
  };
}

it("refuses escalation before any action when process identity changes", async () => {
  const { deps, signaler } = dependencies([ownership, reusedIdentity]);

  const result = await stopVerifiedProcessGroup(ownership, deps, policy);

  expect(result.disposition).toBe("STALE_IDENTITY");
  expect(signaler.calls).toEqual([]);
});

it("uses approved waits and signals only the exact recorded process group", async () => {
  const aliveGroups = new Set([ownership.processGroupId, 777]);
  const signaler = createFakeSignaler(aliveGroups);
  const exited = Object.assign(new Error("gone"), { code: "ESRCH" });
  const { deps, sleeper } = dependencies(
    [ownership, ownership, ownership, ownership, exited],
    { signaler },
  );

  await expect(stopVerifiedProcessGroup(ownership, deps, policy)).resolves.toEqual({
    disposition: "KILLED",
  });

  expect(signaler.calls).toEqual([
    { type: "graceful", ownership },
    { type: "signal", pgid: ownership.processGroupId, signal: "SIGTERM" },
    { type: "signal", pgid: ownership.processGroupId, signal: "SIGKILL" },
  ]);
  expect(sleeper.calls).toEqual([123, 456]);
  expect(aliveGroups.has(ownership.processGroupId)).toBe(false);
  expect(aliveGroups.has(777)).toBe(true);
});

it("reports KILL as requested, not observed, while the exact identity remains visible", async () => {
  const { deps, signaler } = dependencies([ownership, ownership, ownership, ownership, ownership]);

  await expect(stopVerifiedProcessGroup(ownership, deps, policy)).resolves.toEqual({
    disposition: "KILL_REQUESTED",
  });
  expect(signaler.calls.at(-1)).toEqual({ type: "signal", pgid: ownership.processGroupId, signal: "SIGKILL" });
});

it("revalidates after TERM and reports ambiguous delivery when the PID was reused", async () => {
  const { deps, signaler } = dependencies([ownership, ownership, ownership, reusedIdentity]);

  await expect(stopVerifiedProcessGroup(ownership, deps, policy)).resolves.toEqual({
    disposition: "STALE_IDENTITY",
    signaled: true,
  });
  expect(signaler.calls).toEqual([
    { type: "graceful", ownership },
    { type: "signal", pgid: ownership.processGroupId, signal: "SIGTERM" },
  ]);
});

it("stops at graceful and TERM cancellation boundaries without later signals", async () => {
  const afterGrace = new AbortController();
  const graceSleeper = createFakeSleep([() => afterGrace.abort()]);
  const graceful = dependencies([ownership, ownership], {
    sleeper: graceSleeper,
    abortSignal: afterGrace.signal,
  });

  await expect(stopVerifiedProcessGroup(ownership, graceful.deps, policy)).resolves.toEqual({
    disposition: "CANCELLED",
  });
  expect(graceful.signaler.calls).toEqual([{ type: "graceful", ownership }]);

  const afterTerm = new AbortController();
  const termSleeper = createFakeSleep([undefined, () => afterTerm.abort()]);
  const terminating = dependencies([ownership, ownership, ownership], {
    sleeper: termSleeper,
    abortSignal: afterTerm.signal,
  });

  await expect(stopVerifiedProcessGroup(ownership, terminating.deps, policy)).resolves.toEqual({
    disposition: "CANCELLED",
    signaled: true,
  });
  expect(terminating.signaler.calls).toEqual([
    { type: "graceful", ownership },
    { type: "signal", pgid: ownership.processGroupId, signal: "SIGTERM" },
  ]);
});

it("fails closed on ambiguous inspection without signaling", async () => {
  const ambiguous = Object.assign(new Error("malformed proc stat"), {
    code: "AMBIGUOUS_IDENTITY",
  });
  const { deps, signaler } = dependencies([ambiguous]);

  await expect(stopVerifiedProcessGroup(ownership, deps, policy)).resolves.toEqual({
    disposition: "AMBIGUOUS_IDENTITY",
  });
  expect(signaler.calls).toEqual([]);
});

it("reports an already-exited process without signaling", async () => {
  const exited = Object.assign(new Error("gone"), { code: "ENOENT" });
  const { deps, signaler } = dependencies([exited]);

  await expect(stopVerifiedProcessGroup(ownership, deps, policy)).resolves.toEqual({
    disposition: "ALREADY_EXITED",
  });
  expect(signaler.calls).toEqual([]);
});

it("requires timing policy from the reviewed configuration", async () => {
  const { deps } = dependencies([ownership]);
  await expect(stopVerifiedProcessGroup(ownership, deps)).rejects.toThrow(/timing policy/i);
  await expect(
    stopVerifiedProcessGroup(ownership, deps, { gracefulMs: 0, terminateMs: 456 }),
  ).rejects.toThrow(/gracefulMs/i);
});
