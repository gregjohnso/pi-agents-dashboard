// Reduce the raw cold-launch samples into one result: per-stage distributions, the identities the
// numbers depend on, and pass or fail for both spare thresholds.
//
// Usage: node perf/cold-launch-reduce.mjs --samples <directory> [--out <file>] [--array-job-id id]
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { reduceSamples, sampleIntervals } from "./cold-launch-sample.mjs";

const args = process.argv.slice(2);
const option = (/** @type {string} */ name, /** @type {string} */ fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : String(args[index + 1]);
};
const SAMPLES = option("samples", "");
const OUT = option("out", "");
const ARRAY_JOB_ID = option("array-job-id", "");

async function main() {
  if (SAMPLES === "") throw new Error("--samples <directory> is required");
  const names = (await readdir(SAMPLES)).filter((name) => /^sample-\d+\.json$/u.test(name)).sort();
  const raw = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(SAMPLES, name), "utf8"))));
  const complete = [];
  const incomplete = [];
  for (const sample of raw) {
    try {
      if (sample.ok !== true) throw new Error(sample.error ?? "sample did not complete");
      complete.push({ ...sample, intervals: sampleIntervals(sample.timestamps) });
    } catch (error) {
      incomplete.push({ file: names[raw.indexOf(sample)], reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const reduced = reduceSamples(complete);
  const residency = complete.map((sample) => sample.residency.totalResidentKib).filter((value) => typeof value === "number");
  const result = {
    ...reduced,
    requested: raw.length,
    incomplete,
    residentKib: residency.length === 0 ? null : {
      idleMs: complete[0]?.residency.idleMs ?? null,
      medianTotal: [...residency].sort((left, right) => left - right)[Math.floor(residency.length / 2)],
      minTotal: Math.min(...residency),
      maxTotal: Math.max(...residency),
      medianWorker: median(complete.map((sample) => sample.residency.workerResidentKib)),
      medianPiChild: median(complete.map((sample) => sample.residency.piChildResidentKib)),
    },
    pi: complete[0]?.pi ?? null,
    confirmedModels: [...new Set(complete.map((sample) => JSON.stringify(sample.session.confirmedModel)))].map((value) => JSON.parse(value)),
    slurm: { arrayJobId: ARRAY_JOB_ID === "" ? null : ARRAY_JOB_ID, taskIds: complete.map((sample) => sample.slurm.arrayTaskId), jobIds: complete.map((sample) => sample.slurm.jobId) },
    machine: { hosts: [...new Set(complete.map((sample) => sample.machine.host))], loadavgBefore: complete.map((sample) => sample.machine.loadavgBefore), loadavgAfter: complete.map((sample) => sample.machine.loadavgAfter) },
    samples: complete,
  };

  const text = `${JSON.stringify(result, undefined, 2)}\n`;
  if (OUT === "") process.stdout.write(text);
  else await writeFile(OUT, text);
  process.stderr.write(`${result.n}/${result.requested} complete; dominance median ${result.decision.dominanceMedian.toFixed(3)} p95 ${result.decision.dominanceP95.toFixed(3)}; median saving ${result.decision.medianSavingMs} ms; propose spare: ${result.decision.proposeSpare}\n`);
}

/** @param {(number | null)[]} values */
function median(values) {
  const present = /** @type {number[]} */ (values.filter((value) => typeof value === "number")).sort((left, right) => left - right);
  return present.length === 0 ? null : present[Math.floor(present.length / 2)];
}

await main();
