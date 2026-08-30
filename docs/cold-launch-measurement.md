# Cold-launch measurement, 2026-08-30

**Keep cold launch. Do not build a prewarmed spare.** Both thresholds fail, and neither is close.

A spare can remove at most the time between spawning a worker and persisting its readiness. That is 914 ms at the median, which is 5.6 percent of the 16.4 s an operator waits from journal acceptance to a usable viewer snapshot. The rule required more than 50 percent at both the median and the 95th percentile, and at least 1 s of median saving. The measured share is 5.6 percent at the median and 5.7 percent at the 95th percentile, and the median saving is 86 ms short of a second. Each spare would hold about 171 MiB resident while idle.

Launch latency is dominated by preparation, not by process or Pi startup: 15.4 s of the 16.4 s median is journal acceptance through worker spawn, which covers worktree creation, Pi session materialization, executable resolution, and the Pi capability probe. A spare removes none of it. That is where a future latency change belongs.

## What was measured

30 complete samples, one cold launch each, taken with [perf/cold-launch.mjs](../perf/cold-launch.mjs) and submitted by [perf/cold_launch_launcher.py](../perf/cold_launch_launcher.py).

| | |
|---|---|
| Pi | 0.84.3, `~/.local/bin/pi` |
| Model | `anthropic` / `claude-haiku-4-5`, confirmed by Pi on all 30 rows |
| Prompt | `Reply with the single word: ok` |
| Node | v22.23.2 |
| SLURM | array `3482168` tasks 6–29, array `3482199` tasks 0–5, partition `l40-reserved`, quality of service `mid`, 6 concurrent |
| Hosts | `cw-us-e4a2-l40-202-011`, `cw-us-e4a2-l40-202-157` |
| One-minute load | 10.54 to 12.69 before each sample, 11.54 to 15.74 after |
| Raw result | `~/cold-launch-out/run3/cold-launch-result.json`, 30 samples with every timestamp |

## Stage distributions, milliseconds

| Interval | Median | p95 | Min | Max |
|---|---:|---:|---:|---:|
| journal acceptance → worker spawn | 15422 | 15929 | 14782 | 15988 |
| worker spawn → Pi child spawn | 140 | 170 | 120 | 180 |
| Pi child spawn → readiness persisted | 767 | 806 | 719 | 808 |
| readiness persisted → first usable snapshot | 36 | 41 | 33 | 41 |
| **spawn through ready** (the available saving) | **914** | **967** | 849 | 978 |
| **acceptance through first usable snapshot** | **16354** | **16891** | 15687 | 16901 |

Resident set after 60 idle seconds: 175396 KiB total at the median, 53020 KiB worker plus 122436 KiB Pi child, ranging 163616 to 180076 KiB.

## Decision

| Condition | Required | Measured | Holds |
|---|---|---|---|
| Spawn-through-ready share at the median | > 0.50 | 0.056 | no |
| Spawn-through-ready share at p95 | > 0.50 | 0.057 | no |
| Median saving | ≥ 1000 ms | 914 ms | no |

The per-launch share, reported because the rule can also be read that way, gives the same answer: 0.056 at the median and 0.060 at the 95th percentile.

## What the numbers do and do not carry

The two spawn instants are derived from Linux process start ticks recorded in the session record, converted through the boot instant. Each sample re-derived its own start the same way and recorded the residual: −45 ms to −122 ms, which is mostly Node's own startup between fork and the first JavaScript instruction. That error is two orders of magnitude below the 1 s threshold and cannot change the decision.

Reading the row before the snapshot costs one extra round trip, so acceptance through first usable snapshot is biased slightly high. That bias makes the spare look worse, and it is 36 ms against 16354 ms.

Six of the first thirty tasks failed with `PI_PROBE_TIMEOUT` on cold nodes and were rerun as array `3482199`; the 24 that succeeded first time and the 6 reruns fall in the same band. Thirty concurrent samples failed 28 of 30 the same way, which is why the launcher caps concurrency at 6.
