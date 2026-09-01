// Sample validation and reduction for perf/cold-launch.mjs. Pure: no processes, no filesystem, no
// clock. Kept apart from the driver so the suite can pin the decision rule without launching Pi.

/** The only launch stage runtime/launch-trace.mjs records; every other instant is already durable. */
export const LAUNCH_TRACE_STAGES = ["ready_persisted"];

/**
 * Every instant one sample must carry, in launch order.
 *
 * `launchRequestedAt` and `firstUsableSnapshotAt` come from the measuring client's own clock, the
 * two spawn instants from Linux process start ticks in the session record, and `readyPersistedAt`
 * from the launch trace.
 */
export const SAMPLE_TIMESTAMPS = [
  "launchRequestedAt",
  "workerSpawnedAt",
  "piChildSpawnedAt",
  "readyPersistedAt",
  "firstUsableSnapshotAt",
];

/** Spawn through ready must be more than this fraction of request through first usable snapshot. */
export const DOMINANCE_THRESHOLD = 0.5;

/** A spare can save at most the median spawn-through-ready time; below this it is not worth its residency. */
export const MINIMUM_MEDIAN_SAVING_MS = 1_000;

/** @param {string} code @param {string} message */
function sampleError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** @param {number[]} sorted @param {number} fraction */
function quantile(sorted, fraction) {
  // Nearest rank on the sorted samples: no interpolation, so every reported value is one measured launch.
  const rank = Math.ceil(fraction * sorted.length);
  return /** @type {number} */ (sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]);
}

/** The middle measured value, taking the upper of the two middles on an even count. @param {number[]} values */
export function median(values) {
  return quantile([...values].sort((left, right) => left - right), 0.5);
}

/** The 95th percentile by nearest rank. @param {number[]} values */
export function percentile95(values) {
  return quantile([...values].sort((left, right) => left - right), 0.95);
}

/**
 * Validate one sample's stage instants and derive every interval the decision rule reads.
 *
 * @param {Record<string, unknown>} timestamps epoch milliseconds, one per entry of SAMPLE_TIMESTAMPS
 * @throws when a stage is missing (`MISSING_STAGE`) or the stages did not happen in launch order (`STAGE_ORDER`)
 */
export function sampleIntervals(timestamps) {
  if (typeof timestamps !== "object" || timestamps === null) throw sampleError("MISSING_STAGE", "A sample requires every launch stage");
  for (const name of SAMPLE_TIMESTAMPS) {
    if (!Number.isSafeInteger(timestamps[name])) throw sampleError("MISSING_STAGE", `Sample is missing launch stage ${name}`);
  }
  const at = /** @type {(name: string) => number} */ ((name) => /** @type {number} */ (timestamps[name]));
  for (let index = 1; index < SAMPLE_TIMESTAMPS.length; index += 1) {
    const previous = /** @type {string} */ (SAMPLE_TIMESTAMPS[index - 1]);
    const current = /** @type {string} */ (SAMPLE_TIMESTAMPS[index]);
    if (at(current) < at(previous)) throw sampleError("STAGE_ORDER", `Sample stage ${current} precedes ${previous}`);
  }
  return {
    launchRequestedToWorkerSpawnMs: at("workerSpawnedAt") - at("launchRequestedAt"),
    workerSpawnToPiChildSpawnMs: at("piChildSpawnedAt") - at("workerSpawnedAt"),
    piChildSpawnToReadyPersistedMs: at("readyPersistedAt") - at("piChildSpawnedAt"),
    readyPersistedToFirstUsableSnapshotMs: at("firstUsableSnapshotAt") - at("readyPersistedAt"),
    // The maximum a prewarmed spare could remove from a launch.
    spawnThroughReadyMs: at("readyPersistedAt") - at("workerSpawnedAt"),
    // The whole latency an operator waits, which the saving must dominate.
    requestToFirstUsableSnapshotMs: at("firstUsableSnapshotAt") - at("launchRequestedAt"),
  };
}

/** The interval names, in the order sampleIntervals derives them. */
export const SAMPLE_INTERVALS = Object.keys(sampleIntervals(Object.fromEntries(SAMPLE_TIMESTAMPS.map((name) => [name, 0]))));

/**
 * Reduce complete samples into per-interval distributions and the spare decision.
 *
 * @param {{ intervals: Record<string, number> }[]} samples
 */
export function reduceSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) throw sampleError("NO_SAMPLES", "Reduction requires at least one complete sample");
  /** @type {Record<string, { medianMs: number, p95Ms: number, minMs: number, maxMs: number }>} */
  const intervals = {};
  for (const name of SAMPLE_INTERVALS) {
    const values = samples.map((sample) => sample.intervals[name]);
    if (values.some((value) => !Number.isFinite(value))) throw sampleError("MISSING_STAGE", `Samples are missing interval ${name}`);
    const sorted = [.../** @type {number[]} */ (values)].sort((left, right) => left - right);
    intervals[name] = {
      medianMs: quantile(sorted, 0.5),
      p95Ms: quantile(sorted, 0.95),
      minMs: /** @type {number} */ (sorted[0]),
      maxMs: /** @type {number} */ (sorted[sorted.length - 1]),
    };
  }

  const saving = /** @type {{ medianMs: number, p95Ms: number }} */ (intervals.spawnThroughReadyMs);
  const total = /** @type {{ medianMs: number, p95Ms: number }} */ (intervals.requestToFirstUsableSnapshotMs);
  const dominanceMedian = saving.medianMs / total.medianMs;
  const dominanceP95 = saving.p95Ms / total.p95Ms;
  // The per-launch ratio, reported because "dominates at the median" also reads as the median of the
  // per-launch shares. The gate uses the ratio of the two distributions' quantiles.
  const perSampleShare = samples.map((sample) => /** @type {number} */ (sample.intervals.spawnThroughReadyMs) / /** @type {number} */ (sample.intervals.requestToFirstUsableSnapshotMs));
  const dominanceHolds = dominanceMedian > DOMINANCE_THRESHOLD && dominanceP95 > DOMINANCE_THRESHOLD;
  const savingHolds = saving.medianMs >= MINIMUM_MEDIAN_SAVING_MS;

  return {
    n: samples.length,
    intervals,
    decision: {
      dominanceThreshold: DOMINANCE_THRESHOLD,
      minimumMedianSavingMs: MINIMUM_MEDIAN_SAVING_MS,
      dominanceMedian,
      dominanceP95,
      perSampleShareMedian: median(perSampleShare),
      perSampleShareP95: percentile95(perSampleShare),
      medianSavingMs: saving.medianMs,
      dominanceHolds,
      savingHolds,
      proposeSpare: dominanceHolds && savingHolds,
    },
  };
}
