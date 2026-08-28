import { expect, it } from "vitest";

import { loadDashboardConfig } from "../shared/config.mjs";
import { EXIT_POLL_INTERVAL_MS, stopVerifiedProcessGroup } from "./process-signaler.mjs";
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
/** One poll per stop window, so a sequence inspector covers each boundary exactly once. */
const singlePoll = { gracefulMs: EXIT_POLL_INTERVAL_MS, terminateMs: EXIT_POLL_INTERVAL_MS };

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
  ["the reviewed release defaults", loadDashboardConfig({}).stop],
  ["a configured stop policy", policy],
])("escalates graceful, TERM, then KILL on the recorded group using %s", async (_label, timing) => {
  /** @type {string[]} */
  const order = [];
  let killed = false;
  const exited = Object.assign(new Error("gone"), { code: "ESRCH" });
  /** @param {string} from @param {string} to */
  const sleptBetween = (from, to) => order.slice(order.indexOf(from) + 1, order.indexOf(to))
    .filter((entry) => entry.startsWith("sleep:"))
    .reduce((total, entry) => total + Number(entry.slice("sleep:".length)), 0);

  const result = await stopVerifiedProcessGroup(ownership, {
    async inspect(pid) { order.push(`inspect:${pid}`); if (killed) throw exited; return ownership; },
    async requestGraceful() { order.push("graceful"); },
    async signalProcessGroup(pgid, signal) { order.push(`signal:${pgid}:${signal}`); killed = signal === "SIGKILL"; },
    async sleep(ms) { order.push(`sleep:${ms}`); },
  }, timing);

  expect(result).toEqual({ disposition: "KILLED" });
  expect(order.filter((entry) => entry.startsWith("graceful") || entry.startsWith("signal:"))).toEqual([
    "graceful", "signal:654:SIGTERM", "signal:654:SIGKILL",
  ]);
  for (const action of ["graceful", "signal:654:SIGTERM", "signal:654:SIGKILL"]) {
    expect(order[order.indexOf(action) - 1]).toBe("inspect:321");
  }
  expect(sleptBetween("graceful", "signal:654:SIGTERM")).toBe(timing.gracefulMs);
  expect(sleptBetween("signal:654:SIGTERM", "signal:654:SIGKILL")).toBe(timing.terminateMs);
});

it("escalates as soon as a graceful exit is observed instead of waiting out the window", async () => {
  const timing = loadDashboardConfig({}).stop;
  /** @type {number[]} */
  const slept = [];
  let inspections = 0;
  const { calls, requestGraceful, signalProcessGroup } = createFakeSignaler();

  const result = await stopVerifiedProcessGroup(ownership, {
    async inspect() { inspections += 1; if (inspections <= 3) return ownership; throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    requestGraceful,
    signalProcessGroup,
    async sleep(ms) { slept.push(ms); },
  }, timing);

  expect(result).toEqual({ disposition: "GRACEFUL" });
  expect(calls).toEqual([{ type: "graceful", ownership }]);
  expect(slept.reduce((total, ms) => total + ms, 0)).toBeLessThan(timing.gracefulMs);
});

it("reports KILL as requested, not observed, while the exact identity remains visible", async () => {
  const { deps, signaler } = dependencies([ownership, ownership, ownership, ownership, ownership]);

  await expect(stopVerifiedProcessGroup(ownership, deps, singlePoll)).resolves.toEqual({
    disposition: "KILL_REQUESTED",
  });
  expect(signaler.calls.at(-1)).toEqual({ type: "signal", pgid: ownership.processGroupId, signal: "SIGKILL" });
});

it("revalidates after TERM and reports ambiguous delivery when the PID was reused", async () => {
  const { deps, signaler } = dependencies([ownership, ownership, ownership, reusedIdentity]);

  await expect(stopVerifiedProcessGroup(ownership, deps, singlePoll)).resolves.toEqual({
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

  await expect(stopVerifiedProcessGroup(ownership, terminating.deps, { ...singlePoll, terminateMs: 456 })).resolves.toEqual({
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
