import { expect, it } from "vitest";

import { DOMINANCE_THRESHOLD, MINIMUM_MEDIAN_SAVING_MS, reduceSamples, sampleIntervals } from "./cold-launch-sample.mjs";

/** One complete set of stage instants, in epoch milliseconds. @param {Partial<Record<string, number>>} [overrides] */
function timestamps(overrides = {}) {
  return {
    launchRequestedAt: 1_000,
    workerSpawnedAt: 1_100,
    piChildSpawnedAt: 1_500,
    readyPersistedAt: 2_600,
    firstUsableSnapshotAt: 2_800,
    ...overrides,
  };
}

/** Build one reducible sample from stage instants. @param {Record<string, number>} stageInstants */
function sample(stageInstants) {
  return { timestamps: stageInstants, intervals: sampleIntervals(stageInstants) };
}

/** @param {() => unknown} action */
function thrownBy(action) {
  try {
    action();
  } catch (error) {
    return /** @type {any} */ (error);
  }
  return undefined;
}

it("fails a sample that is missing one launch stage, naming that stage", () => {
  const partial = timestamps();
  delete (/** @type {Record<string, unknown>} */ (partial)).piChildSpawnedAt;
  const failure = thrownBy(() => sampleIntervals(partial));
  expect(failure?.code).toBe("MISSING_STAGE");
  expect(failure?.message).toMatch(/piChildSpawnedAt/u);
});

it("fails a sample whose stages did not happen in launch order", () => {
  expect(thrownBy(() => sampleIntervals(timestamps({ piChildSpawnedAt: 1_050 })))?.code).toBe("STAGE_ORDER");
});

it("derives both decision intervals plus every per-stage interval", () => {
  expect(sampleIntervals(timestamps())).toEqual({
    launchRequestedToWorkerSpawnMs: 100,
    workerSpawnToPiChildSpawnMs: 400,
    piChildSpawnToReadyPersistedMs: 1_100,
    readyPersistedToFirstUsableSnapshotMs: 200,
    spawnThroughReadyMs: 1_500,
    requestToFirstUsableSnapshotMs: 1_800,
  });
});

it("emits a median and a 95th percentile for every interval", () => {
  const reduced = reduceSamples([1_000, 1_400, 1_800, 2_200, 2_600].map((ready) => sample(timestamps({
    readyPersistedAt: ready + 1_600,
    firstUsableSnapshotAt: ready + 1_800,
  }))));
  expect(reduced.n).toBe(5);
  expect(reduced.intervals.spawnThroughReadyMs).toMatchObject({ medianMs: 2_300, p95Ms: 3_100, minMs: 1_500, maxMs: 3_100 });
  expect(Object.keys(reduced.intervals)).toEqual([
    "launchRequestedToWorkerSpawnMs",
    "workerSpawnToPiChildSpawnMs",
    "piChildSpawnToReadyPersistedMs",
    "readyPersistedToFirstUsableSnapshotMs",
    "spawnThroughReadyMs",
    "requestToFirstUsableSnapshotMs",
  ]);
});

it("proposes a spare only when spawn-through-ready dominates at median and p95 and saves at least a second", () => {
  // Spawn through ready is 4.5 s of a 5 s launch: dominant everywhere and worth more than a second.
  const dominant = reduceSamples([0, 100, 200].map((jitter) => sample(timestamps({
    readyPersistedAt: 5_600 + jitter,
    firstUsableSnapshotAt: 6_000 + jitter,
  }))));
  expect(dominant.decision).toMatchObject({ dominanceHolds: true, savingHolds: true, proposeSpare: true });
  expect(dominant.decision.dominanceThreshold).toBe(DOMINANCE_THRESHOLD);
  expect(dominant.decision.minimumMedianSavingMs).toBe(MINIMUM_MEDIAN_SAVING_MS);

  // Spawn through ready is 1.5 s of a 5 s launch: worth more than a second, but Pi startup does not dominate.
  const notDominant = reduceSamples([0, 100, 200].map((jitter) => sample(timestamps({
    readyPersistedAt: 2_600,
    firstUsableSnapshotAt: 6_000 + jitter,
  }))));
  expect(notDominant.decision).toMatchObject({ dominanceHolds: false, savingHolds: true, proposeSpare: false });

  // Spawn through ready is 90 percent of a 200 ms launch: dominant, but saves far less than a second.
  const tooSmall = reduceSamples([0, 10, 20].map((jitter) => sample({
    launchRequestedAt: 1_000,
    workerSpawnedAt: 1_010,
    piChildSpawnedAt: 1_040,
    readyPersistedAt: 1_190 + jitter,
    firstUsableSnapshotAt: 1_200 + jitter,
  })));
  expect(tooSmall.decision).toMatchObject({ dominanceHolds: true, savingHolds: false, proposeSpare: false });
});
