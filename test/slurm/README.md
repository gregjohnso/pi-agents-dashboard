# `test/slurm` — the repository's SLURM execution substrate

Every check in this repository runs on a SLURM worker, never on the head node: unit tests, `typecheck`
and `pack:check` included. `submit_cases.py` is the only launcher, `cases.json` is the trusted case
manifest, and the invocation form is always
`env -u PIXI_PROJECT_MANIFEST pixi run --manifest-path <repo>/pixi.toml --frozen -- <command>`.

The contract this implements is *SLURM execution contract* in
[docs/superpowers/plans/2026-09-17-native-attachment.md](../../docs/superpowers/plans/2026-09-17-native-attachment.md).

## Use it

```bash
PY=.pixi/envs/default/bin/python          # the project environment's Python; it has submitit

# 1. parse-only validation. Exits nonzero before any job exists.
$PY test/slurm/submit_cases.py validate --manifest test/slurm/cases.json

# 2. one array, one task per case. Job ids are fsynced before anything waits.
$PY test/slurm/submit_cases.py submit --manifest test/slurm/cases.json \
    --execution-root <your disposable execution root> [--wait]

# 3. terminal accounting and four-part verdicts
$PY test/slurm/submit_cases.py collect --batch-record <batch>/batch-record.json

# 4. only after an interrupted submission: rebuild the job ids, or record the gap as unknown
$PY test/slurm/submit_cases.py reconcile --batch-directory <batch>
```

`collect` exits `0` only when every case's verdict is `PASSED`. `wait` blocks on the scheduler's own
`submitit.SlurmJob` handles once; there is no polling loop to write. `reconcile` exits `0` when the batch
is recorded or fully reconciled and `4` when the submission window is unknown; it never resubmits, and
`submit` refuses to run into an execution root that still holds an unreconciled gap.

Workers run `l40-reserved`, QoS `dev`, `timeout_min=15`, `cpus_per_task=4`, array parallelism
`min(cases, 8)`. Logs land in `<batch>/logs/`.

## The manifest is hand authored and parse-only

```json
{ "manifestVersion": 1, "name": "repository-suite", "description": "why these cases exist",
  "cases": [{ "id": "...", "kind": "test|typecheck|package", "command": ["..."], "...": "..." }] }
```

`name` and every `id` match `^[a-z0-9][a-z0-9-]{0,48}$`; ids are unique. The driver rebuilds each
command from the case's own fields and refuses any difference, so a manifest cannot smuggle a
different command past review. Nothing is discovered: no `vitest list`, no glob expansion, no test
enumeration.

| kind | fields | built command |
| --- | --- | --- |
| `test` | `config` (one of `vitest.config.ts`, `vitest.experiment.config.ts`), `file`; optional `testName`, `passWithNoTests` | `npx --no-install vitest run --config <config> <file> --no-cache [-t <testName>] [--passWithNoTests]` |
| `install` | `packages`, exact `name@version` pins | `npm install --prefix {caseDirectory}/install-root --no-audit --no-fund --save-exact --omit=dev <packages…>` |
| `typecheck` | `task: "typecheck"` | the Pixi task `typecheck` |
| `package` | `task: "pack-check"` | the Pixi task `pack-check` |

Paths are repository-relative, must exist and may not leave the repository. A non-test kind's `task`
must be in that kind's allowlist **and** defined in `pixi.toml`.

An `install` case has no install root to choose: the driver fixes the prefix to `{caseDirectory}/install-root`,
the only placeholder it resolves on the worker, so a manifest cannot install into the repository or
anywhere else. Pins are exact — a range fails validation — and the artifact rule then reads each
installed `package.json` and requires the exact version the case declared. The Pixi `install` task is
**not** used: it is `npm install` in the repository, which would rewrite the read-only `node_modules`.

`--no-cache` is not cosmetic. Vitest 4.1.9 resolves its cache to `<root>/node_modules/.vite` and a
plain run writes `results.json` there; this milestone's `node_modules` is read-only. Measured on worker
`3733749`: a plain run writes that file, `--no-cache` writes nothing at all, and a config-level
`cacheDir` also works but would make the experiment config differ from `vitest.config.ts` in more than
`include`. Only the runner's test-ordering cache is given up. Every case also fingerprints
`node_modules/.vite`, `node_modules/.package-lock.json`, `package.json`, `package-lock.json`,
`pixi.toml`, `pixi.lock`, the name and version of **every installed npm package** and **every conda
package** in `.pixi/envs/default`, before and after it runs, and **fails** if any of them changed.

Every command also runs with `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`,
`XDG_STATE_HOME`, `TMPDIR` and `npm_config_cache` **configured** to directories inside its own case
directory, so nothing routes to the operator's home, npm cache or `~/.local/state` by default. That is
configuration, not a filesystem sandbox: a command that hard-codes an absolute path is not stopped by
it, which is why the protected-path fingerprint above runs as well. The one shared read is pixi's package
cache (`PIXI_CACHE_DIR`), which it needs to activate the frozen environment; it is named in every result
as `sharedReadOnlyPaths` rather than left implicit.

## What a case must satisfy

A verdict is `PASSED` only with all four of: a terminal `sacct` state, exit code `0:0`,
`results/<id>.json`, and a cleanup record showing zero surviving registered identities. A missing
cleanup record is `unknown`, never a pass.

- A nonzero child return code prints the captured output and **raises**, so the task process exits
  nonzero and `sacct` records `FAILED`. Returning the return code in a dictionary would make every
  downstream scheduler assertion meaningless.
- **Zero collected tests fails a test case**, even with a zero exit status. An unreadable collection
  count is `null` and also fails: a run whose collection cannot be read has not shown that it ran
  anything.
- **Exactly one test file must run** for a test case. Vitest's positional argument is a filter, not a
  path, so a stray copy of a file anywhere under the repository — including a gitignored workspace —
  makes the same filter match two files, and the case then did not run what it declared. Measured on
  worker `3734175`, where a snapshot copy turned a one-file case into a two-file run.
- Non-test kinds have no test count. They are judged by their exit status and their own required
  artifact — `package` must produce parseable `npm pack --json` output that lists files, and `install`
  must have every declared pin present at that exact version under its own install root.
- `PI_AGENTS_TEST_LEDGER_DIR` points at `<case>/process-ledgers`, so the repository's own process
  ledger (`test/process-ledger.mjs`, swept by `test/reap-test-processes.mjs`) writes its reaping
  evidence into the case directory. A missing ledger directory is `UNKNOWN`; a leftover ledger file or
  a reported unstoppable process is a survivor and fails the case.
- The task also reaps and, only if still really running, SIGTERMs then SIGKILLs its **own** children,
  revalidating pid and start time immediately before every signal, with bounded waits. No name or user
  selector is ever used.

Evidence is write-once. A case directory is claimed exclusively, a replayed or requeued task claims
`<id>.attempt-N`, and `collect` reads **every** attempt record. More than one record is never a pass:
the scheduler reports one terminal state and it cannot be attributed to one of several runs, so the case
is reported as needing reconciliation with each attempt's own result named. Proved with a real Slurm
requeue (job `3734530`, `Restarts=1`): two records, both individually `PASSED`, verdict `FAILED`.

**One record is not automatically one run.** A requeue that lands after the case directory is claimed but
before any result is written leaves a single record, under the base `<id>.json` name, written by the
second run. A lone record is therefore judged from its own persisted identity — `attempt` and
`SLURM_RESTART_COUNT`, not the file name — and a nonzero restart count, a persisted attempt past the
first, or a name that disagrees with the record all fail the case pending reconciliation. Proved with a
real requeue (job `3734916`, `Restarts=1`, `COMPLETED 0:0`): one record named
`experiment-collection-probe.json` carrying `attempt: 2` and `slurmRestartCount: "1"`, verdict `FAILED`.

## An interrupted submission

`submit` fsyncs its intent (with `jobIds: null` and the validated cases) before the scheduler is
called, and fsyncs the batch record with the returned ids before anything waits. If the driver dies
between the two, the batch directory holds an intent and no record. `reconcile` closes that window:

- it rebuilds the ids from submitit's own `logs/*_submitted.pkl` names and from `sacct --name`, which
  works because the job name carries the batch id;
- as many ids as cases is `RECONCILED`, and the rebuilt `reconciled-batch-record.json` is what `wait`
  and `collect` then consume;
- anything else — no ids, or fewer ids than cases — is `UNKNOWN_SUBMISSION_GAP`, exits `4` and asks for
  an operator decision. Nothing is ever resubmitted, and `submit` refuses the whole execution root
  until a reconciliation *closes* the gap. Writing the UNKNOWN record does **not** close it: only
  `RECORDED` or `RECONCILED` does, and the guard reads the latest record by attempt number.

Proved with a real interrupted submission (job `3734496`): `submit` refused with exit `4`, reconcile
rebuilt the id from both sources, and `wait` and `collect` then ran from the reconciled record. The
UNKNOWN case is proved separately in `task-8/evidence/round-3/unknown-gap-and-duplicate-pins.txt`:
after an `UNKNOWN_SUBMISSION_GAP` record, `submit` still exits `4`.

## Install pins

An `install` case declares each package once. Two pins of one package (`x@1.0.0` and `x@2.0.0`) cannot
both be satisfied by one installed tree, so a repeated package name fails validation before submission,
and the artifact rule checks each pin against the installed version individually rather than accepting a
name that matched some declared pin.

## Expected-red probes

`*.experiment.mjs` files are collected only by `vitest.experiment.config.ts`, which differs from
`vitest.config.ts` in `include` alone. `vitest.config.ts` includes `**/*.test.{ts,mjs}`, so a
committed known-red `*.test.mjs` would break every later suite step; a probe therefore never carries
that name.

- `collection-probe.experiment.mjs` — the one probe that proves the split.
- `deliberate-failure.experiment.mjs` — a real failing assertion, used only by
  `acceptance-negative.json`.
- `acceptance-negative.json` — the driver's own acceptance manifest. **Both of its cases are expected
  to FAIL** (`collect` exits 1 by design): one proves failure propagation, the other proves that the
  default config collects no probe and that zero collected tests fail even at exit 0. It is never part
  of a suite step.
- `install-contained.json` — the install-kind acceptance: one exact pin into the case's own install
  root, verified by version.

**Keep copies of probes out of the repository tree.** A `*.experiment.mjs` or `*.test.mjs` file anywhere
under the repository is collectable, gitignored workspaces included, and it also widens any positional
filter that names a similar path. Snapshots belong in an archive (a `.tar`), not as loose files.

## Driver tests

`submit_cases_test.py` is stdlib `unittest`, not Vitest, and no Vitest config collects it. Run it on a
worker, from `test/slurm` so the driver is importable — the form proven by job `3733895`:

```bash
srun -c 4 -N 1 -p l40-reserved --qos=dev -J driver-unittests --chdir=test/slurm \
    --output=<out>/slurm-%j.out --error=<out>/slurm-%j.err \
    env -u PIXI_PROJECT_MANIFEST pixi run --manifest-path <repo>/pixi.toml --frozen -- \
    python -m unittest discover -s <repo>/test/slurm -p '*_test.py' -v
```
