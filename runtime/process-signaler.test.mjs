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
  const signaler = createFakeSignaler();
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

it.each([
  ["the recorded identity was replaced before any action", [ownership, reusedIdentity], "STALE_IDENTITY"],
  ["liveness is ambiguous", [Object.assign(new Error("malformed proc stat"), { code: "AMBIGUOUS_IDENTITY" })], "AMBIGUOUS_IDENTITY"],
  ["the process already exited", [Object.assign(new Error("gone"), { code: "ENOENT" })], "ALREADY_EXITED"],
])("signals nothing and reports %s", async (_label, inspections, disposition) => {
  const { deps, signaler } = dependencies(inspections);

  await expect(stopVerifiedProcessGroup(ownership, deps, policy)).resolves.toEqual({ disposition });
  expect(signaler.calls).toEqual([]);
});

it.each([
  ["the reviewed release defaults", loadDashboardConfig({}).stop, 5_000, 5_000],
  ["a configured stop policy", policy, 123, 456],
])("escalates graceful, TERM, then KILL on the recorded group using %s", async (_label, timing, gracefulMs, terminateMs) => {
  /** @type {string[]} */
  const order = [];
  let inspections = 0;
  const exited = Object.assign(new Error("gone"), { code: "ESRCH" });

  const result = await stopVerifiedProcessGroup(ownership, {
    async inspect(pid) { order.push(`inspect:${pid}:${++inspections}`); if (inspections === 5) throw exited; return ownership; },
    async requestGraceful() { order.push("graceful"); },
    async signalProcessGroup(pgid, signal) { order.push(`signal:${pgid}:${signal}`); },
    async sleep(ms) { order.push(`sleep:${ms}`); },
  }, timing);

  expect(result).toEqual({ disposition: "KILLED" });
  expect(order).toEqual([
    "inspect:321:1", "inspect:321:2", "graceful", `sleep:${gracefulMs}`,
    "inspect:321:3", "signal:654:SIGTERM", `sleep:${terminateMs}`,
    "inspect:321:4", "signal:654:SIGKILL", "inspect:321:5",
  ]);
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

it("requires timing policy from the reviewed configuration", async () => {
  const { deps } = dependencies([ownership]);
  await expect(stopVerifiedProcessGroup(ownership, deps)).rejects.toThrow(/timing policy/i);
  await expect(
    stopVerifiedProcessGroup(ownership, deps, { gracefulMs: 0, terminateMs: 456 }),
  ).rejects.toThrow(/gracefulMs/i);
});
