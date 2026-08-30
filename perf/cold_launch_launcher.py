"""Submit the cold-launch measurement as one SLURM array, then reduce its samples.

Each task runs `perf/cold-launch.mjs` once: one temporary state root, one disposable Pi agent
directory, one disposable Git repository, one real Pi launch, sixty idle seconds, one raw JSON
sample. Samples are independent, so they go out as a single `map_array`, never a loop of jobs.

Usage:
    pixi run python perf/cold_launch_launcher.py --out <directory> [--samples 30]
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import submitit

REPOSITORY = Path(__file__).resolve().parent.parent
DRIVER = REPOSITORY / "perf" / "cold-launch.mjs"
REDUCER = REPOSITORY / "perf" / "cold-launch-reduce.mjs"


def run_one_sample(index: int, out_directory: str, provider: str, model: str, prompt: str, idle_ms: int) -> str:
    """Run one sample on the compute node and return the path it wrote."""
    sample_path = Path(out_directory) / f"sample-{index:03d}.json"
    scratch = Path(os.environ.get("TMPDIR", "/tmp"))
    completed = subprocess.run(
        [
            "node", str(DRIVER),
            "--out", str(sample_path),
            "--base", str(scratch),
            "--provider", provider,
            "--model", model,
            "--prompt", prompt,
            "--idle-ms", str(idle_ms),
        ],
        cwd=str(REPOSITORY),
        capture_output=True,
        text=True,
        check=False,
    )
    sys.stdout.write(completed.stdout)
    sys.stderr.write(completed.stderr)
    return str(sample_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="measurement output directory")
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--provider", default="anthropic")
    parser.add_argument("--model", default="claude-haiku-4-5")
    parser.add_argument("--prompt", default="Reply with the single word: ok")
    parser.add_argument("--idle-ms", type=int, default=60_000)
    parser.add_argument("--partition", default="l40-reserved")
    parser.add_argument("--qos", default="mid")
    # submitit defaults timeout_min to 5 and kills the task silently; one sample is idle for 60 s of
    # its ~2 min, so 30 min is a safe explicit upper bound well inside the partition's own limit.
    parser.add_argument("--timeout-min", type=int, default=30)
    # Concurrency, not array size: 30 samples at once made `pi --help` exceed the daemon's 5 s
    # capability-probe timeout on a shared filesystem and failed 28 of 30 launches.
    parser.add_argument("--array-parallelism", type=int, default=6)
    # One sample runs a daemon, a worker, and a Pi child. 4 CPUs and 16 GB carried the smoke sample
    # on cw-us-e4a2-l40-202-011 at load 11.
    parser.add_argument("--cpus", type=int, default=4)
    parser.add_argument("--mem", default="16G")
    arguments = parser.parse_args()

    out_directory = Path(arguments.out).resolve()
    out_directory.mkdir(parents=True, exist_ok=True)
    executor = submitit.AutoExecutor(folder=str(out_directory / "submitit_logs"))
    executor.update_parameters(
        name="pi-agents-cold-launch",
        slurm_partition=arguments.partition,
        slurm_qos=arguments.qos,
        slurm_array_parallelism=arguments.array_parallelism,
        slurm_cpus_per_task=arguments.cpus,
        slurm_mem=arguments.mem,
        timeout_min=arguments.timeout_min,
    )
    jobs = executor.map_array(
        run_one_sample,
        range(arguments.samples),
        [str(out_directory)] * arguments.samples,
        [arguments.provider] * arguments.samples,
        [arguments.model] * arguments.samples,
        [arguments.prompt] * arguments.samples,
        [arguments.idle_ms] * arguments.samples,
    )
    array_job_id = jobs[0].job_id.split("_")[0]
    print(json.dumps({"arrayJobId": array_job_id, "tasks": len(jobs), "out": str(out_directory)}))

    for job in jobs:
        try:
            job.result()
        except Exception as failure:  # a failed sample must not hide the samples that succeeded
            print(f"sample {job.job_id} failed: {failure}", file=sys.stderr)

    reduced = subprocess.run(
        ["node", str(REDUCER), "--samples", str(out_directory), "--out", str(out_directory / "cold-launch-result.json"), "--array-job-id", array_job_id],
        cwd=str(REPOSITORY),
        capture_output=True,
        text=True,
        check=False,
    )
    sys.stdout.write(reduced.stdout)
    sys.stderr.write(reduced.stderr)
    return reduced.returncode


if __name__ == "__main__":
    raise SystemExit(main())
