#!/usr/bin/env python3
"""Manifest-driven SLURM driver for this repository's checks. Parse-only on the head node.

Cases are hand authored in `test/slurm/cases.json`, one entry per independently reviewable case. This
driver parses trusted manifests and never discovers work: no `vitest list`, no glob expansion, no test
enumeration and no runner interrogation anywhere, least of all on the head node. Every manifest
command is rebuilt from the case's own fields and compared with the declared command, so a manifest
cannot smuggle a different command past review.

Order of obligations, which is also the order of this file:

1. Validate the manifest: required fields, unique ids, approved kinds, approved configs, approved
   Pixi tasks that really exist in `pixi.toml`, repository-relative paths that really exist, and a
   declared command equal to the built command. Any problem exits nonzero before a job exists.
2. Claim an immutable batch directory and fsync a submission-intent record naming the case ids and the
   manifest digest, while no job id exists yet.
3. Submit one `map_array`, one task per case, then persist the returned job ids and fsync the batch
   record and its parent directory before any consumer waits.
4. Each task runs its declared command through `env -u PIXI_PROJECT_MANIFEST pixi run` with the
   repository manifest, a frozen environment and the repository as its working directory, capturing
   the complete stdout and stderr.
5. Each task writes `results/<id>.json` with the return code and the complete output, fsynced and
   linked into place write-once.
6. A nonzero return code prints the captured output and raises, so the task process exits nonzero and
   `sacct` records FAILED. A test case that collected zero tests fails the same way, as does one whose
   positional filter ran more than the single file it declared; non-test kinds are judged by their exit
   status and their own required artifact instead of a test count.
7. A verdict needs all four: a terminal `sacct` state, exit code `0:0`, the result file, and a cleanup
   record showing zero surviving registered identities. A missing cleanup record is `unknown`, never a
   pass. More than one attempt record for a case is never a pass either: the scheduler reports one
   terminal state and it cannot be attributed to one of several runs.
8. `reconcile` closes an interrupted submission window: it rebuilds job ids from submitit's own
   artifacts and from `sacct`, or records the gap as unknown. It never resubmits, and `submit` refuses
   to run into an execution root that still holds an unreconciled gap.

Every command runs with `HOME`, the XDG roots and `TMPDIR` **configured** to disposable paths inside its
own case directory, so nothing routes to the operator's home, npm cache or `~/.local/state` by default.
That is configuration, not a filesystem sandbox: a command that hard-codes an absolute path is not
stopped by it. The one shared read is pixi's package cache, named in every result.

Nothing here runs a test, a build, an install or a typecheck on the head node: submission, validation,
reconciliation and `collect` read and write JSON and talk to Slurm, and every declared command runs on a
worker.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import tomllib
import uuid
from pathlib import Path

import cloudpickle
import submitit

REPOSITORY = Path(__file__).resolve().parents[2]
SLURM_DIRECTORY = REPOSITORY / "test/slurm"
DEFAULT_MANIFEST = SLURM_DIRECTORY / "cases.json"
PIXI_MANIFEST = REPOSITORY / "pixi.toml"

IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9-]{0,48}$")
# An exact npm pin, optionally scoped. A range is not a pin and is refused.
PACKAGE_PIN = re.compile(r"^(@[a-z0-9~-][a-z0-9._~-]*/)?[a-z0-9~-][a-z0-9._~-]*@\d+\.\d+\.\d+$")
PLACEHOLDER = re.compile(r"\{([a-zA-Z]+)\}")
# The only two Vitest configs a case may name. `vitest.experiment.config.ts` differs from
# `vitest.config.ts` in `include` alone, so an expected-red `*.experiment.mjs` probe is collectable
# explicitly and invisible to every default suite step.
APPROVED_CONFIGS = ("vitest.config.ts", "vitest.experiment.config.ts")
# Non-test task kinds name an exact approved Pixi task rather than pretending to be a Vitest case.
KIND_TASKS = {"typecheck": ("typecheck",), "package": ("pack-check",)}
# `install` is not a Pixi task: the repository's `install` task is `npm install` in the repository,
# which would rewrite the read-only `node_modules` this milestone runs against. An install case instead
# installs exact pins into a prefix the driver fixes to this attempt's own case directory, so the
# manifest has no install root to choose and nothing to smuggle.
INSTALL_ROOT_PLACEHOLDER = "{caseDirectory}/install-root"
KINDS = ("test", "install", *KIND_TASKS)

SLURM_PARTITION = "l40-reserved"
SLURM_QOS = "dev"
SLURM_TIMEOUT_MINUTES = 15
SLURM_CPUS_PER_TASK = 4
# Concurrency cap, independent of array size: the array is one task per case, and this only limits how
# many of them run at once on a shared cluster.
SLURM_MAX_CONCURRENT_TASKS = 8
# Inside the 15 minute Slurm timeout, so a hung command is recorded by this driver rather than killed
# with no result record.
TASK_TIMEOUT_SECONDS = 13 * 60

# Paths a case reads and may not write. Vitest resolves its cache to `<root>/node_modules/.vite` and a
# plain run writes `results.json` there (measured on worker 3733749_0), which is why every test command
# carries `--no-cache` and why this check exists to catch any other writer.
PROTECTED_PATHS = ("node_modules/.vite", "node_modules/.package-lock.json", "package.json",
                   "package-lock.json", "pixi.toml", "pixi.lock")
# Package names and versions supplement the exact-content checks above; they do not detect
# changed package contents.
NPM_DEPENDENCY_IDENTITY = "node_modules (installed package identity)"
PIXI_ENVIRONMENT_IDENTITY = ".pixi/envs/default (conda package identity)"

# Where the repository's own process ledger writes, so its reaping evidence lands in the case
# directory instead of a shared temporary directory. `test/reap-test-processes.mjs` reads this.
LEDGER_DIRECTORY_VARIABLE = "PI_AGENTS_TEST_LEDGER_DIR"
# Redirect environment-based home/cache paths into this case. This is configuration, not a
# filesystem sandbox; commands can still access other paths directly.
DISPOSABLE_ROOTS = (("HOME", "home"), ("XDG_CONFIG_HOME", "config"), ("XDG_CACHE_HOME", "cache"),
                    ("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state"), ("TMPDIR", "tmp"),
                    ("npm_config_cache", "npm-cache"))
# The one shared path a case still reads: pixi needs its package cache to activate the frozen
# environment, and a disposable HOME would otherwise point it at an empty cache and invite a download.
# Recorded in every result as a read-only dependency rather than left as an unstated default.
SHARED_PIXI_CACHE = Path(os.environ.get("PIXI_CACHE_DIR", str(Path.home() / ".cache/rattler")))

CHILD_TERM_GRACE_SECONDS = 5.0
CHILD_KILL_GRACE_SECONDS = 5.0
CHILD_REAP_INTERVAL_SECONDS = 0.05

TERMINAL_STATES = ("COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL",
                   "PREEMPTED", "BOOT_FAIL", "DEADLINE")


class ManifestError(ValueError):
    """A manifest problem. Raised before submission, never after."""


class UnreconciledSubmissionGap(RuntimeError):
    """An execution root holds a batch that was submitted but never recorded. Reconcile before resubmit."""


# --- durability ---------------------------------------------------------------
def fsync_directory(directory: Path) -> None:
    handle = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(handle)
    finally:
        os.close(handle)


def write_json_durable(path: Path, payload: dict) -> Path:
    """Write, fsync, link into place, then fsync the parent, in that order. Write-once.

    A consumer that finds this file finds all of it, and finds it because the parent directory entry is
    on disk too. `os.link` rather than `os.replace` is what makes the record write-once: a requeued or
    replayed Slurm task cannot overwrite an earlier attempt's evidence, it raises `FileExistsError` and
    the caller allocates a new attempt name instead.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    with open(temporary, "w") as handle:
        json.dump(payload, handle, indent=2, default=str)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.link(temporary, path)
    finally:
        os.unlink(temporary)
    fsync_directory(path.parent)
    return path


def write_json_durable_attempt(path: Path, payload: dict) -> Path:
    """Write-once, but never lose a record: a taken name becomes `<name>.attempt-N.json`."""
    path = Path(path)
    for attempt in range(1, 51):
        candidate = path if attempt == 1 else path.with_name(f"{path.stem}.attempt-{attempt}{path.suffix}")
        try:
            return write_json_durable(candidate, payload)
        except FileExistsError:
            continue
    raise RuntimeError(f"{path}: 50 attempt records already exist")


def digest_of(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# --- manifest -----------------------------------------------------------------
def load_manifest(path: Path) -> dict:
    manifest = json.loads(Path(path).read_text())
    if not isinstance(manifest, dict):
        raise ManifestError(f"{path}: a manifest is a JSON object")
    return manifest


def pixi_tasks() -> tuple[str, ...]:
    """The task names `pixi.toml` really defines, read as data rather than assumed."""
    return tuple(tomllib.loads(PIXI_MANIFEST.read_text()).get("tasks", {}))


def repository_path(where: str, field: str, declared: str) -> Path:
    """A repository-relative path that exists and stays inside the repository once resolved."""
    if not isinstance(declared, str) or not declared:
        raise ManifestError(f"{where}: {field} must be a repository-relative path")
    if Path(declared).is_absolute():
        raise ManifestError(f"{where}: {field} must be repository-relative, not {declared}")
    if ".." in Path(declared).parts:
        raise ManifestError(f"{where}: {field} may not contain a parent traversal: {declared}")
    resolved = (REPOSITORY / declared).resolve()
    if REPOSITORY.resolve() not in resolved.parents:
        raise ManifestError(f"{where}: {field} leaves the repository: {declared} resolves to {resolved}")
    if not resolved.is_file():
        raise ManifestError(f"{where}: {field} names no existing file: {declared}")
    return resolved


def build_command(case: dict) -> list[str]:
    """The command this driver runs for a case. Compared against the declared one before submission.

    A test command carries `--no-cache` because Vitest 4.1.9 otherwise writes
    `node_modules/.vite/vitest/<hash>/results.json` below its root, and this milestone's `node_modules`
    is read-only. Measured on worker 3733749: a plain run writes that file, `--no-cache` writes nothing
    at all, and only the runner's test-ordering cache is given up.
    """
    if case["kind"] == "test":
        command = ["npx", "--no-install", "vitest", "run", "--config", case["config"], case["file"],
                   "--no-cache"]
        if case.get("testName"):
            command += ["-t", case["testName"]]
        if case.get("passWithNoTests"):
            # Declared only by a driver self-test that must reach the zero-collected rule with a zero
            # exit status. A real case never sets it.
            command += ["--passWithNoTests"]
        return command
    if case["kind"] == "install":
        # The prefix is the driver's, not the manifest's. `--prefix` plus a working directory equal to
        # that prefix is what npm 10 needs to resolve its own tree; `--omit=dev` and the exact pins keep
        # the installed set to what the case declared.
        return ["npm", "install", "--prefix", INSTALL_ROOT_PLACEHOLDER, "--no-audit", "--no-fund",
                "--save-exact", "--omit=dev", *case["packages"]]
    return [case["task"]]


def resolve_command(template: list[str], context: dict) -> list[str]:
    """Substitute the per-attempt placeholders on the worker; an unresolved one is a defect, not a path."""
    resolved = [PLACEHOLDER.sub(lambda match: str(context[match.group(1)]), part) for part in template]
    unresolved = [part for part in resolved if PLACEHOLDER.search(part)]
    if unresolved:
        raise RuntimeError(f"unresolved placeholders in {unresolved}")
    return resolved


def working_directory_for(case: dict, case_directory: Path) -> Path:
    """Where a case's command runs: the repository, except an install, which runs inside its own root.

    npm 10 resolves its dependency tree from the current directory and fails with
    `Cannot read properties of null (reading 'edgesOut')` when `--prefix` points somewhere unrelated to
    it, so an install case runs in the prefix the driver fixed for it.
    """
    if case["kind"] == "install":
        root = Path(case_directory) / "install-root"
        root.mkdir(parents=True, exist_ok=True)
        return root
    return REPOSITORY


def wrap_for_project_environment(command: list[str]) -> list[str]:
    """The one supported invocation form: the feature manifest, frozen, with no ambient manifest.

    `--` ends pixi's own flag parsing, so a command carrying `--config` or `--no-cache` reaches the
    child rather than pixi. Pixi still resolves a bare task name from the positional arguments after
    it, and `--frozen` keeps it from re-solving or rewriting the lockfile.
    """
    return ["env", "-u", "PIXI_PROJECT_MANIFEST", pixi_binary(), "run",
            "--manifest-path", str(PIXI_MANIFEST), "--frozen", "--", *command]


def pixi_binary() -> str:
    found = os.environ.get("PI_AGENTS_PIXI") or shutil.which("pixi") or str(Path.home() / ".pixi/bin/pixi")
    return found


def validate_case(case: dict, index: int, tasks: tuple[str, ...]) -> dict:
    where = f"cases[{index}]"
    if not isinstance(case, dict):
        raise ManifestError(f"{where}: a case is a JSON object")
    for field in ("id", "kind", "command"):
        if field not in case:
            raise ManifestError(f"{where}: missing required field {field!r}")
    if not (isinstance(case["id"], str) and IDENTIFIER.match(case["id"])):
        raise ManifestError(f"{where}: id {case['id']!r} must match {IDENTIFIER.pattern}")
    if case["kind"] not in KINDS:
        raise ManifestError(f"{where}: kind {case['kind']!r} is not one of {KINDS}")
    if not (isinstance(case["command"], list) and case["command"]
            and all(isinstance(part, str) for part in case["command"])):
        raise ManifestError(f"{where}: command must be a non-empty list of strings")

    if case["kind"] == "test":
        if case.get("config") not in APPROVED_CONFIGS:
            raise ManifestError(f"{where}: config {case.get('config')!r} is not one of {APPROVED_CONFIGS}")
        repository_path(where, "config", case["config"])
        repository_path(where, "file", case["file"] if "file" in case else "")
        if "testName" in case and not isinstance(case["testName"], str):
            raise ManifestError(f"{where}: testName is a string")
        if "passWithNoTests" in case and not isinstance(case["passWithNoTests"], bool):
            raise ManifestError(f"{where}: passWithNoTests is a boolean")
    elif case["kind"] == "install":
        packages = case.get("packages")
        if not (isinstance(packages, list) and packages
                and all(isinstance(part, str) and PACKAGE_PIN.match(part) for part in packages)):
            raise ManifestError(f"{where}: packages must be a non-empty list of exact name@version pins, "
                               f"matching {PACKAGE_PIN.pattern}")
        # One installed tree cannot satisfy two versions of one package, so two pins of the same name are
        # a contradiction the verifier must never be asked to certify.
        names = [pin.rsplit("@", 1)[0] for pin in packages]
        repeated = sorted({name for name in names if names.count(name) > 1})
        if repeated:
            raise ManifestError(f"{where}: a package may be pinned once; repeated names: {repeated}")
    else:
        task = case.get("task")
        if task not in KIND_TASKS[case["kind"]]:
            raise ManifestError(f"{where}: kind {case['kind']!r} runs one of "
                                f"{KIND_TASKS[case['kind']]}, not {task!r}")
        if task not in tasks:
            raise ManifestError(f"{where}: {PIXI_MANIFEST} defines no task {task!r}")

    built = build_command(case)
    if case["command"] != built:
        raise ManifestError(f"{where}: declared command does not match the built command\n"
                            f"  declared: {case['command']}\n  built:    {built}")
    return case


def validate_manifest(manifest: dict) -> list[dict]:
    if manifest.get("manifestVersion") != 1:
        raise ManifestError("manifestVersion must be 1")
    if not isinstance(manifest.get("name"), str) or not IDENTIFIER.match(manifest["name"]):
        raise ManifestError(f"manifest name must match {IDENTIFIER.pattern}")
    cases = manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ManifestError("a manifest names at least one case")
    tasks = pixi_tasks()
    validated = [validate_case(case, index, tasks) for index, case in enumerate(cases)]
    identifiers = [case["id"] for case in validated]
    repeated = sorted({name for name in identifiers if identifiers.count(name) > 1})
    if repeated:
        raise ManifestError(f"case ids must be unique: {repeated}")
    return validated


# --- worker side: collection, protected paths, cleanup ------------------------
def collected_tests(stdout: str, stderr: str) -> int | None:
    """Vitest's own count, read from both streams because reporters split them.

    `None` means the summary was unreadable, which is not zero and not a pass; it fails the case
    because a run whose collection cannot be read has not shown that it ran anything.
    """
    combined = f"{stdout}\n{stderr}"
    if "No test files found" in combined:
        return 0
    match = re.search(r"^\s*Tests\s+.*?\((\d+)\)\s*$", combined, re.MULTILINE)
    return int(match.group(1)) if match else None


def collected_test_files(stdout: str, stderr: str) -> int | None:
    """How many files Vitest actually ran. A case declares one, so anything else is a failure.

    Vitest's positional argument is a filter, not a path: a stray copy of a probe anywhere under the
    repository — including a gitignored workspace — makes the same filter match two files, and the case
    then did not run what it declared. Measured on worker 3734175, where a snapshot copy of
    `test/slurm/collection-probe.experiment.mjs` turned a one-file case into a two-file run.
    """
    combined = f"{stdout}\n{stderr}"
    if "No test files found" in combined:
        return 0
    match = re.search(r"^\s*Test Files\s+.*?\((\d+)\)\s*$", combined, re.MULTILINE)
    return int(match.group(1)) if match else None


def json_array_in(text: str):
    """The first JSON array in output that npm prefixes with its own run-script banner.

    `npm run pack:check` writes two banner lines before the JSON, so parsing the whole stream fails
    (observed on worker 3733861_3). Decoding from the first `[` keeps the artifact assertion honest
    without accepting arbitrary trailing text as success.
    """
    start = text.find("[")
    if start < 0:
        raise json.JSONDecodeError("no JSON array in the captured output", text, 0)
    return json.JSONDecoder().raw_decode(text, start)[0]


def artifact_check(case: dict, stdout: str, case_directory: Path) -> dict:
    """The required artifact for a non-test kind, in place of a test count."""
    if case["kind"] == "package":
        try:
            packed = json_array_in(stdout)
        except json.JSONDecodeError as broken:
            return {"rule": "npm pack --json output parses and lists files", "satisfied": False,
                    "detail": f"artifact unreadable: {broken}"}
        if not (isinstance(packed, list) and packed and isinstance(packed[0], dict) and packed[0].get("files")):
            return {"rule": "npm pack --json output parses and lists files", "satisfied": False,
                    "detail": "artifact named no packed files"}
        return {"rule": "npm pack --json output parses and lists files", "satisfied": True,
                "detail": f"{len(packed[0]['files'])} files in {packed[0].get('filename')}"}
    if case["kind"] == "install":
        root = Path(case_directory) / "install-root"
        installed: dict[str, str | None] = {}
        missing = []
        mismatched = []
        # Judged pin by pin, not name by name: a per-name check would call a package verified because
        # *some* declared pin matched it.
        for pin in case["packages"]:
            name, version = pin.rsplit("@", 1)
            manifest = root / "node_modules" / name / "package.json"
            if not manifest.is_file():
                missing.append(pin)
                continue
            found = json.loads(manifest.read_text()).get("version")
            installed[name] = found
            if found != version:
                mismatched.append({"pin": pin, "installed": found})
        wrong = {entry["pin"].rsplit("@", 1)[0]: entry["installed"] for entry in mismatched}
        satisfied = not missing and not mismatched
        return {"rule": "every declared pin is installed under this attempt's own install root, at that "
                        "exact version",
                "satisfied": satisfied, "installed": installed, "missing": missing,
                "mismatchedPins": mismatched, "unexpectedVersions": wrong, "installRoot": str(root),
                "detail": (f"{len(case['packages'])} pinned packages verified under {root}" if satisfied else
                           f"missing {missing}, mismatched {mismatched}")}
    return {"rule": "exit status only", "satisfied": True,
            "detail": f"{case['kind']} declares no artifact beyond its exit status"}


def path_inventory(root: Path) -> dict:
    """Path, size and sha256 of a file, or of every file under a tree. Absent is recorded as absent."""
    root = Path(root)
    if root.is_file():
        return {".": {"bytes": root.stat().st_size, "sha256": hashlib.sha256(root.read_bytes()).hexdigest()}}
    if not root.is_dir():
        return {}
    inventory = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.is_symlink():
            inventory[str(path.relative_to(root))] = {
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
    return inventory


def npm_dependency_identity() -> dict:
    """Name and version of every installed top-level npm package.

    This establishes package **identity** only: an unchanged name and version does not establish
    unchanged file content. Hashing the whole tree would cost minutes per case, so content is checked
    only for the exact paths in `PROTECTED_PATHS`.
    """
    root = REPOSITORY / "node_modules"
    if not root.is_dir():
        return {}
    identity = {}
    for entry in sorted(root.iterdir()):
        if entry.name.startswith("."):
            continue
        packages = sorted(entry.iterdir()) if entry.name.startswith("@") and entry.is_dir() else [entry]
        for package in packages:
            manifest = package / "package.json"
            if not manifest.is_file():
                continue
            name = str(package.relative_to(root))
            try:
                identity[name] = json.loads(manifest.read_text()).get("version")
            except json.JSONDecodeError:
                identity[name] = "UNREADABLE"
    return identity


def pixi_environment_identity() -> dict:
    """Every conda package recorded in the frozen environment, by its own metadata file name."""
    meta = REPOSITORY / ".pixi/envs/default/conda-meta"
    if not meta.is_dir():
        return {}
    return {path.name: path.stat().st_size for path in sorted(meta.glob("*.json"))}


def protected_inventory() -> dict:
    inventory = {name: path_inventory(REPOSITORY / name) for name in PROTECTED_PATHS}
    inventory[NPM_DEPENDENCY_IDENTITY] = npm_dependency_identity()
    inventory[PIXI_ENVIRONMENT_IDENTITY] = pixi_environment_identity()
    return inventory


def inventory_difference(before: dict, after: dict) -> dict:
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    modified = sorted(name for name in set(before) & set(after) if before[name] != after[name])
    return {"added": added, "removed": removed, "modified": modified,
            "unchanged": not (added or removed or modified)}


def protected_difference(before: dict, after: dict) -> dict:
    per_path = {name: inventory_difference(before[name], after.get(name, {})) for name in before}
    changed = {name: difference for name, difference in per_path.items() if not difference["unchanged"]}
    return {"paths": per_path, "changed": changed, "unchanged": not changed}


def ledger_cleanup(ledger_directory: Path, stdout: str, stderr: str) -> dict:
    """What the repository's own process ledger recorded, without smoothing absence into success.

    `test/reap-test-processes.mjs` creates this directory in `globalSetup` and sweeps it in
    `teardown`, signalling only identities a harness recorded. A directory that does not exist means
    no run ever reached that setup, which is `UNKNOWN` and never a pass. A leftover ledger file or a
    reported unstoppable process is a survivor.
    """
    combined = f"{stdout}\n{stderr}"
    unstoppable = [line for line in combined.splitlines() if "could not stop a recorded process" in line]
    if not ledger_directory.is_dir():
        return {"status": "UNKNOWN", "survivors": None, "source": str(ledger_directory),
                "note": "the run never created a ledger directory, so nothing swept its processes"}
    leftover = sorted(str(path.name) for path in ledger_directory.glob("*.jsonl"))
    reaped = [line for line in combined.splitlines() if "reaped a leaked process" in line]
    if unstoppable or leftover:
        return {"status": "SURVIVORS", "survivors": unstoppable + leftover,
                "source": str(ledger_directory), "reaped": reaped}
    return {"status": "CLEAN", "survivors": [], "source": str(ledger_directory), "reaped": reaped}


def process_identity(pid: int) -> dict | None:
    """Pid, start time and state, so a recycled pid is never mistaken for the process that had it."""
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError, IndexError):
        return None
    return {"pid": pid, "state": fields[0], "startTime": fields[19]}


def identity_matches(expected: dict, actual: dict | None) -> bool:
    return actual is not None and actual["pid"] == expected["pid"] and actual["startTime"] == expected["startTime"]


def own_children() -> list[int]:
    children: list[int] = []
    try:
        threads = list(Path(f"/proc/{os.getpid()}/task").iterdir())
    except FileNotFoundError:
        return []
    for thread in threads:
        try:
            children += [int(part) for part in (thread / "children").read_text().split()]
        except (FileNotFoundError, ProcessLookupError):
            continue
    return sorted(set(children))


def reap_without_blocking(pid: int) -> str:
    try:
        reaped, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return "NOT_OUR_CHILD"
    return "REAPED" if reaped == pid else "STILL_RUNNING"


def wait_briefly_for(identity: dict, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if reap_without_blocking(identity["pid"]) != "STILL_RUNNING":
            return True
        if not identity_matches(identity, process_identity(identity["pid"])):
            return True
        time.sleep(CHILD_REAP_INTERVAL_SECONDS)
    return reap_without_blocking(identity["pid"]) != "STILL_RUNNING"


def terminate_own_children(identities: list[dict]) -> dict:
    """Reap first, then escalate SIGTERM and SIGKILL against this task's own children only.

    Identity is revalidated immediately before every signal, so a recycled pid is never signalled, and
    nothing is sent to a child that has already exited. Every wait is bounded, so a child that ignores
    SIGTERM reaches SIGKILL instead of holding the task until the Slurm timeout kills it with no result
    record. No name or user selector is ever used.
    """
    actions = []
    survivors = []
    for identity in identities:
        current = process_identity(identity["pid"])
        if not identity_matches(identity, current):
            actions.append({"identity": identity, "signal": None, "result": "ALREADY_GONE_OR_REUSED"})
            continue
        reaped = reap_without_blocking(identity["pid"])
        if reaped == "REAPED":
            actions.append({"identity": identity, "signal": None, "result": "REAPED_BEFORE_ANY_SIGNAL"})
            continue
        if reaped == "NOT_OUR_CHILD":
            actions.append({"identity": identity, "signal": None, "result": "NOT_OUR_CHILD"})
            continue
        if current["state"] == "Z":
            actions.append({"identity": identity, "signal": None, "result": "ALREADY_EXITED_UNREAPED"})
            continue
        for number, name, grace in ((signal.SIGTERM, "SIGTERM", CHILD_TERM_GRACE_SECONDS),
                                    (signal.SIGKILL, "SIGKILL", CHILD_KILL_GRACE_SECONDS)):
            if not identity_matches(identity, process_identity(identity["pid"])):
                actions.append({"identity": identity, "signal": name, "result": "ALREADY_GONE_OR_REUSED"})
                break
            try:
                os.kill(identity["pid"], number)
            except ProcessLookupError:
                actions.append({"identity": identity, "signal": name, "result": "ALREADY_GONE"})
                break
            gone = wait_briefly_for(identity, grace)
            actions.append({"identity": identity, "signal": name, "result": "SIGNALLED",
                            "goneWithin": round(grace, 1) if gone else None,
                            "stillRunningAfterGrace": not gone})
            if gone:
                break
        else:
            survivors.append(identity)
    return {"actions": actions, "survivors": survivors}


# --- worker side: one case ----------------------------------------------------
def allocate_case_directory(batch_directory: Path, case_id: str) -> tuple[Path, int]:
    """Claim one case directory exclusively; a replayed task claims `<id>.attempt-N` instead."""
    root = Path(batch_directory) / "cases"
    root.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, 51):
        candidate = root / (case_id if attempt == 1 else f"{case_id}.attempt-{attempt}")
        try:
            candidate.mkdir(parents=False, exist_ok=False)
        except FileExistsError:
            continue
        fsync_directory(root)
        return candidate, attempt
    raise RuntimeError(f"{case_id}: 50 attempt directories already exist")


def default_runner(argv: list[str], cwd: str, environment: dict) -> dict:
    completed = subprocess.run(argv, capture_output=True, text=True, cwd=cwd, env=environment,
                               timeout=TASK_TIMEOUT_SECONDS)
    return {"returncode": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}


def case_environment(case_directory: Path) -> tuple[dict, dict]:
    """The child's environment: every writable root pointed at this attempt, and the one shared read named.

    HOME, the XDG roots and TMPDIR are *configured* to directories inside this attempt's case directory,
    so nothing routes to `~/.local/state`, `~/.npm` or `~/.config` by default. This is configuration, not
    a filesystem sandbox: a command that hard-codes an absolute path can still reach it, which is why the
    protected-path fingerprint runs as well. `PIXI_CACHE_DIR` still names the operator's existing package
    cache, because pixi reads it to activate the frozen environment and an empty cache would invite a
    download; that one shared read is recorded in the result rather than left implicit. Measured on worker
    3734175: a case runs green under these roots.
    """
    environment = dict(os.environ)
    environment.pop("PIXI_PROJECT_MANIFEST", None)
    roots = {}
    for variable, name in DISPOSABLE_ROOTS:
        root = Path(case_directory) / name
        root.mkdir(parents=True, exist_ok=True)
        environment[variable] = str(root)
        roots[variable] = str(root)
    ledger = Path(case_directory) / "process-ledgers"
    environment[LEDGER_DIRECTORY_VARIABLE] = str(ledger)
    # Deliberately not created here. `test/reap-test-processes.mjs` creates it in `globalSetup`, so its
    # absence afterwards is evidence that no run ever reached that setup, and `ledger_cleanup` reports
    # UNKNOWN instead of an empty pass.
    roots[LEDGER_DIRECTORY_VARIABLE] = str(ledger)
    environment["PIXI_CACHE_DIR"] = str(SHARED_PIXI_CACHE)
    return environment, roots


def write_result_record(results_directory: Path, case_id: str, build_payload) -> Path:
    """Write a result that names its own file, write-once, without guessing that name in advance.

    The path has to be inside the record — `INTERFACE.md` documents `resultFile` — but the name is only
    known once a free one is claimed, so the payload is built per candidate rather than patched after
    serialization.
    """
    results_directory = Path(results_directory)
    for attempt in range(1, 51):
        candidate = results_directory / (f"{case_id}.json" if attempt == 1
                                        else f"{case_id}.attempt-{attempt}.json")
        try:
            return write_json_durable(candidate, build_payload(str(candidate)))
        except FileExistsError:
            continue
    raise RuntimeError(f"{case_id}: 50 attempt records already exist")


def run_manifest_case(case: dict, batch: dict, runner=None) -> dict:
    """Run one validated case on a worker and fail the task process when the case failed."""
    started = time.time()
    runner = default_runner if runner is None else runner
    case_directory, attempt = allocate_case_directory(Path(batch["batchDirectory"]), case["id"])
    command = resolve_command(build_command(case), {"caseDirectory": str(case_directory),
                                                    "batchId": batch["batchId"],
                                                    "batchDirectory": batch["batchDirectory"]})
    argv = wrap_for_project_environment(command)
    environment, environment_roots = case_environment(case_directory)
    working_directory = working_directory_for(case, case_directory)
    children_before = own_children()
    protected_before = protected_inventory()

    try:
        outcome = runner(argv, str(working_directory), environment)
    except subprocess.TimeoutExpired as expired:
        outcome = {"returncode": "TIMEOUT", "stdout": _text(expired.stdout),
                   "stderr": _text(expired.stderr) + f"\ncase exceeded {TASK_TIMEOUT_SECONDS}s"}

    stdout, stderr = outcome["stdout"], outcome["stderr"]
    protected_check = protected_difference(protected_before, protected_inventory())
    leftover = [identity for identity in (process_identity(pid) for pid in own_children()
                                          if pid not in children_before) if identity is not None]
    child_cleanup = terminate_own_children(leftover)

    if case["kind"] == "test":
        collected = collected_tests(stdout, stderr)
        collected_files = collected_test_files(stdout, stderr)
        collection_rule = "vitest collected tests, zero fails, exactly one declared file runs"
        cleanup = ledger_cleanup(Path(environment[LEDGER_DIRECTORY_VARIABLE]), stdout, stderr)
        artifact = {"rule": "the case's own Vitest result", "satisfied": True,
                    "detail": "a test case is judged by its exit status and its collection count"}
    else:
        collected, collected_files, collection_rule = None, None, "exit-status-only"
        cleanup = {"status": "NOT_APPLICABLE", "survivors": [], "source": None,
                   "note": f"a {case['kind']} case registers no process identity; its own children are "
                           "covered by childProcessCleanup"}
        artifact = artifact_check(case, stdout, case_directory)

    result = {
        "caseId": case["id"], "kind": case["kind"], "batchId": batch["batchId"], "attempt": attempt,
        "caseDirectory": str(case_directory), "argv": argv,
        "workingDirectory": str(working_directory),
        "returncode": outcome["returncode"], "stdout": stdout, "stderr": stderr,
        "collected": collected, "collectedTestFiles": collected_files,
        "collectionRule": collection_rule,
        "artifact": artifact, "cleanup": cleanup,
        "protectedCacheCheck": protected_check,
        "environmentRoots": environment_roots,
        "sharedReadOnlyPaths": [str(SHARED_PIXI_CACHE)],
        "childProcessCleanup": {"before": children_before, "leftover": leftover,
                                "actions": child_cleanup["actions"],
                                "survivors": child_cleanup["survivors"], "after": own_children()},
        "hostname": os.uname().nodename,
        "slurmJobId": os.environ.get("SLURM_JOB_ID"),
        "slurmArrayTaskId": os.environ.get("SLURM_ARRAY_TASK_ID"),
        "slurmRestartCount": os.environ.get("SLURM_RESTART_COUNT"),
        "startedAt": started, "finishedAt": time.time(),
    }
    result["failures"] = case_failures(case, result)
    result["result"] = "PASSED" if not result["failures"] else "FAILED"
    written = write_result_record(Path(batch["resultsDirectory"]), case["id"],
                                 lambda path: {**result, "resultFile": path})
    result["resultFile"] = str(written)
    if result["failures"]:
        # Printed and raised: a task that merely returned this dictionary would let `sacct` record
        # COMPLETED for a failed case, which makes every downstream scheduler assertion meaningless.
        print(stdout[-20000:])
        print(stderr[-20000:], file=sys.stderr)
        raise RuntimeError(f"case {case['id']} failed: {'; '.join(result['failures'])}")
    return result


def case_failures(case: dict, result: dict) -> list[str]:
    failures = []
    if result["returncode"] != 0:
        failures.append(f"command exited {result['returncode']}")
    if case["kind"] == "test":
        if result["collected"] is None:
            failures.append("the runner reported no collection count")
        elif result["collected"] == 0:
            failures.append("the case collected no tests")
        if result["collectedTestFiles"] is None:
            failures.append("the runner reported no test file count")
        elif result["collectedTestFiles"] != 1:
            failures.append(f"the case declared one file but {result['collectedTestFiles']} test files ran, "
                            "so the positional filter matched something else")
    elif not result["artifact"]["satisfied"]:
        failures.append(f"required artifact missing: {result['artifact']['detail']}")
    if result["cleanup"]["status"] == "SURVIVORS":
        failures.append(f"the harness cleanup record shows survivors: {result['cleanup']['survivors']}")
    if result["childProcessCleanup"]["survivors"]:
        failures.append(f"child processes survived cleanup: {result['childProcessCleanup']['survivors']}")
    if not result["protectedCacheCheck"]["unchanged"]:
        failures.append(f"the case wrote into read-only repository state: "
                        f"{result['protectedCacheCheck']['changed']}")
    return failures


def _text(value) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)


# --- submission ---------------------------------------------------------------
def claim_batch_directory(execution_root: Path, batch_id: str) -> Path:
    directory = Path(execution_root) / batch_id
    directory.parent.mkdir(parents=True, exist_ok=True)
    directory.mkdir(parents=False, exist_ok=False)
    (directory / "results").mkdir()
    (directory / "logs").mkdir()
    fsync_directory(directory)
    return directory


def record_submission_intent(batch_directory: Path, batch_id: str, manifest_path: Path,
                             cases: list[dict]) -> dict:
    """Fsync what this batch intends to run while no job id exists yet.

    An interruption between this record and the batch record is therefore visibly uncertain: the intent
    exists, the job ids do not, and `reconcile` rebuilds them from submitit's own submission artifacts
    and from `sacct` instead of resubmitting blindly. The validated cases are recorded here too, so a
    reconciliation can map array task indices back to case ids without the manifest.
    """
    intent = {"batchId": batch_id, "manifest": str(manifest_path),
              "manifestSha256": digest_of(manifest_path),
              "caseIds": [case["id"] for case in cases],
              "cases": cases,
              "jobName": job_name_for(batch_id),
              "batchDirectory": str(batch_directory),
              "resultsDirectory": str(batch_directory / "results"),
              "logsFolder": str(batch_directory / "logs"),
              "repository": str(REPOSITORY), "partition": SLURM_PARTITION, "qos": SLURM_QOS,
              "timeoutMinutes": SLURM_TIMEOUT_MINUTES, "intentRecordedAt": time.time(),
              "jobIds": None}
    write_json_durable(Path(batch_directory) / "submission-intent.json", intent)
    return intent


def job_name_for(batch_id: str) -> str:
    """The Slurm job name. It carries the batch id, which is what lets `sacct` find an unrecorded batch."""
    return f"pi-agents-{batch_id}"[:64]


# Reconciliation states that close a submission gap. `UNKNOWN_SUBMISSION_GAP` deliberately does not:
# writing that record says an operator decision is required, so the guard stays shut.
CLOSING_RECONCILIATION_STATES = ("RECORDED", "RECONCILED")


def reconciliation_records(batch_directory: Path) -> list[Path]:
    """Every reconciliation record, oldest attempt first.

    Ordered by attempt number rather than by name: `reconciled-batch-record.attempt-2.json` sorts
    *before* `reconciled-batch-record.json` lexically, so a lexical sort would report the first attempt
    as the latest one.
    """
    found = []
    for path in Path(batch_directory).glob("reconciled-batch-record*.json"):
        match = re.match(r"^reconciled-batch-record(?:\.attempt-(\d+))?\.json$", path.name)
        if match:
            found.append((int(match.group(1) or 1), path))
    return [path for _, path in sorted(found)]


def latest_reconciliation_state(batch_directory: Path) -> str | None:
    """The state of the most recent reconciliation, or `None` when none was ever written.

    An unreadable record is `UNREADABLE`, which closes nothing: a record nobody can parse is not a
    decision.
    """
    records = reconciliation_records(batch_directory)
    if not records:
        return None
    try:
        return json.loads(records[-1].read_text()).get("reconciliationState")
    except (json.JSONDecodeError, OSError):
        return "UNREADABLE"


def unreconciled_gaps(execution_root: Path) -> list[Path]:
    """Batches whose intent exists with no batch record and no *closing* reconciliation.

    The existence of a reconciliation record is not closure. `reconcile` writes one for an unknown
    submission window too, and that record's whole point is that an operator has to decide; treating it
    as closure would let the next `submit` start a second unaccounted batch.
    """
    root = Path(execution_root)
    if not root.is_dir():
        return []
    return [directory for directory in sorted(root.iterdir())
            if (directory / "submission-intent.json").is_file()
            and not (directory / "batch-record.json").is_file()
            and latest_reconciliation_state(directory) not in CLOSING_RECONCILIATION_STATES]


def assert_no_unreconciled_gap(execution_root: Path) -> None:
    """Refuse to submit into a root holding an unrecorded submission. Reconcile first, never resubmit."""
    gaps = unreconciled_gaps(execution_root)
    if gaps:
        described = [f"{path} (reconciliation state: {latest_reconciliation_state(path) or 'none'})"
                     for path in gaps]
        raise UnreconciledSubmissionGap(
            "these batches were submitted but never recorded, and no reconciliation has closed them; "
            "run `reconcile --batch-directory <dir>` and resolve any unknown submission window before "
            f"submitting again: {described}")


def read_sacct_by_name(job_name: str) -> dict:
    completed = subprocess.run(
        ["sacct", "--name", job_name, "-X", "-P",
         "--format=JobID,JobName%64,State,ExitCode,Start,End,Elapsed,NodeList%20"],
        capture_output=True, text=True)
    return {"returncode": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}


def job_ids_from_artifacts(logs_folder: Path) -> list[str]:
    """Job ids submitit already wrote to disk, read from the names it uses.

    An array writes `<array>_<task>_submitted.pkl` and a one-case batch is not an array at all, so it
    writes `<jobid>_submitted.pkl` with no task component. Job 3734496 is where that difference was
    observed: the array-only pattern found nothing and a real reconciliation reported an unknown gap.
    """
    found = []
    for path in sorted(Path(logs_folder).glob("*_submitted.pkl")):
        match = re.match(r"^(\d+)(?:_(\d+))?_submitted\.pkl$", path.name)
        if match:
            task = match.group(2)
            found.append((int(match.group(1)), -1 if task is None else int(task)))
    return [str(array) if task < 0 else f"{array}_{task}" for array, task in sorted(set(found))]


def job_ids_from_sacct(sacct: dict, job_name: str) -> list[str]:
    """The same ids from the scheduler's own accounting, array task or plain job alike."""
    if sacct["returncode"] != 0:
        return []
    found = []
    for line in sacct["stdout"].splitlines():
        fields = line.split("|")
        if len(fields) > 3 and fields[1] == job_name and re.match(r"^\d+(_\d+)?$", fields[0]):
            array, _, task = fields[0].partition("_")
            found.append((int(array), int(task) if task else -1))
    return [str(array) if task < 0 else f"{array}_{task}" for array, task in sorted(set(found))]


def reconcile(batch_directory: Path, sacct_by_name=read_sacct_by_name) -> dict:
    """Close the submission gap without resubmitting anything.

    Three outcomes, and only one of them claims to know the job ids. A batch whose record exists needs
    nothing. A batch with as many reconstructed ids as it has cases is `RECONCILED`, and the rebuilt
    record is durable and usable by `wait` and `collect`. Anything else — no ids, or fewer ids than
    cases — is `UNKNOWN_SUBMISSION_GAP`: an operator decision, never an automatic resubmission.

    The array task index is the case index because `map_array` submits in manifest order, and the
    intent recorded that order before any job existed.
    """
    batch_directory = Path(batch_directory)
    intent_path = batch_directory / "submission-intent.json"
    if not intent_path.is_file():
        raise FileNotFoundError(f"{intent_path}: no submission intent, so there is nothing to reconcile")
    intent = json.loads(intent_path.read_text())
    job_name = intent.get("jobName") or job_name_for(intent["batchId"])
    logs_folder = Path(intent["logsFolder"])
    record_path = batch_directory / "batch-record.json"

    artifact_ids = job_ids_from_artifacts(logs_folder) if logs_folder.is_dir() else []
    sacct = sacct_by_name(job_name)
    sacct_ids = job_ids_from_sacct(sacct, job_name)
    cases = intent.get("cases") or [{"id": case_id} for case_id in intent["caseIds"]]
    sources = {"submititArtifacts": artifact_ids, "sacctByJobName": sacct_ids, "sacct": sacct}

    if record_path.is_file():
        report = {"reconciliationState": "RECORDED", "batchId": intent["batchId"],
                  "batchDirectory": str(batch_directory),
                  "batchRecord": str(record_path), "jobIds": json.loads(record_path.read_text()).get("jobIds"),
                  "sources": sources,
                  "note": "the batch record exists, so no submission gap was open"}
        report["reconciliationRecord"] = str(write_json_durable_attempt(
            batch_directory / "reconciled-batch-record.json", report))
        print(json.dumps({key: report[key] for key in ("reconciliationState", "batchId", "jobIds",
                                                       "reconciliationRecord")}, indent=2))
        return report

    reconstructed = artifact_ids or sacct_ids
    complete = len(reconstructed) == len(cases) and bool(reconstructed)
    report = {
        "reconciliationState": "RECONCILED" if complete else "UNKNOWN_SUBMISSION_GAP",
        "batchId": intent["batchId"], "batchDirectory": str(batch_directory),
        "resultsDirectory": intent["resultsDirectory"], "logsFolder": str(logs_folder),
        "jobName": job_name, "cases": cases,
        "jobIds": reconstructed if complete else None,
        "jobs": ([{"caseId": case["id"], "kind": case.get("kind"), "jobId": job_id}
                  for case, job_id in zip(cases, reconstructed)] if complete else []),
        "mappingBasis": "map_array submits in manifest order, so array task index is the case index",
        "sources": sources, "reconciledAt": time.time(),
        "note": ("job ids rebuilt from the sources above; wait and collect may use this record" if complete
                 else f"{len(reconstructed)} job ids found for {len(cases)} cases: the submission window "
                      "is unknown and needs an operator decision. Nothing was resubmitted."),
    }
    report["reconciliationRecord"] = str(write_json_durable_attempt(
        batch_directory / "reconciled-batch-record.json", report))
    print(json.dumps({key: report[key] for key in ("reconciliationState", "batchId", "jobIds",
                                                   "reconciliationRecord", "note")}, indent=2))
    return report


def executor_for(batch_directory: Path, batch_id: str, case_count: int) -> submitit.AutoExecutor:
    executor = submitit.AutoExecutor(folder=str(Path(batch_directory) / "logs"))
    executor.update_parameters(
        name=job_name_for(batch_id),
        slurm_partition=SLURM_PARTITION,
        slurm_qos=SLURM_QOS,
        timeout_min=SLURM_TIMEOUT_MINUTES,
        cpus_per_task=SLURM_CPUS_PER_TASK,
        slurm_array_parallelism=min(case_count, SLURM_MAX_CONCURRENT_TASKS),
    )
    return executor


def submit(manifest_path: Path, execution_root: Path) -> dict:
    manifest_path = Path(manifest_path).resolve()
    cases = validate_manifest(load_manifest(manifest_path))
    # Never submit past an open submission gap: an unrecorded earlier batch has to be reconciled first,
    # or its jobs become orphans nothing accounts for.
    assert_no_unreconciled_gap(Path(execution_root).resolve())
    batch_id = f"{load_manifest(manifest_path)['name']}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
    batch_directory = claim_batch_directory(Path(execution_root).resolve(), batch_id)
    intent = record_submission_intent(batch_directory, batch_id, manifest_path, cases)

    batch = {key: intent[key] for key in ("batchId", "batchDirectory", "resultsDirectory")}
    if __name__ != "__main__":
        # Run as a script, cloudpickle already serializes this module by value; imported, it has to be
        # told, so a worker needs nothing from `test/slurm` on its import path.
        cloudpickle.register_pickle_by_value(sys.modules[__name__])
    executor = executor_for(batch_directory, batch_id, len(cases))
    jobs = executor.map_array(run_manifest_case, cases, [batch] * len(cases))
    record = {**intent, "submittedAt": time.time(),
              "jobs": [{"caseId": case["id"], "kind": case["kind"], "jobId": job.job_id}
                       for case, job in zip(cases, jobs)],
              "jobIds": [job.job_id for job in jobs], "cases": cases}
    # Fsynced with its parent directory before any consumer waits.
    write_json_durable(batch_directory / "batch-record.json", record)
    print(json.dumps({"batchId": batch_id, "batchRecord": str(batch_directory / "batch-record.json"),
                      "jobs": record["jobs"]}, indent=2))
    return record


# --- collection ---------------------------------------------------------------
def read_sacct(job_id: str) -> dict:
    completed = subprocess.run(
        ["sacct", "-j", job_id, "-P",
         "--format=JobID,JobName%30,State,ExitCode,Start,End,Elapsed,NodeList%20"],
        capture_output=True, text=True)
    return {"returncode": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}


def sacct_fields(sacct: dict, job_id: str) -> tuple[str, str]:
    """State and exit code, read from sacct alone. Anything else is UNKNOWN, never a guessed pass."""
    if sacct["returncode"] != 0:
        return "UNKNOWN", "UNKNOWN"
    for line in sacct["stdout"].splitlines():
        fields = line.split("|")
        if len(fields) > 3 and fields[0] == job_id:
            return fields[2].split()[0], fields[3]
    return "UNKNOWN", "UNKNOWN"


def verdict_for(state: str, exit_code: str, result: dict | None) -> tuple[str, list[str]]:
    """All four conditions or no pass: terminal state, 0:0, a result file, a clean cleanup record."""
    reasons = []
    if state not in TERMINAL_STATES:
        reasons.append(f"state {state} is not terminal")
    if exit_code != "0:0":
        reasons.append(f"exit code {exit_code}")
    if result is None:
        reasons.append("no result file")
        return "FAILED", reasons
    cleanup = result.get("cleanup") or {}
    survivors = cleanup.get("survivors")
    if cleanup.get("status") in (None, "unknown", "UNKNOWN"):
        reasons.append("cleanup record is unknown")
    elif survivors is None:
        reasons.append("cleanup reported unknown survivors")
    elif survivors:
        reasons.append(f"surviving registered identities: {survivors}")
    if result.get("result") != "PASSED":
        reasons.append(f"case result {result.get('result')}: {result.get('failures')}")
    return ("PASSED" if not reasons else "FAILED"), reasons


def attempt_records(results_directory: Path, case_id: str) -> list[dict]:
    """Every result record a case left, first attempt first, with attempt identity from the record.

    The file name is not the identity. Slurm can requeue a task after it claimed its case directory but
    before it wrote a result, and the restarted worker then finds the base `<id>.json` name free and
    takes it — so a name that says "attempt 1" can hold the second run. `recordedAttempt` is what the
    worker persisted, `fileAttempt` is what the name says, and `attempt` is the recorded one whenever it
    exists.
    """
    results_directory = Path(results_directory)
    found = []
    first = results_directory / f"{case_id}.json"
    if first.is_file():
        found.append((1, first))
    for path in results_directory.glob(f"{case_id}.attempt-*.json"):
        match = re.match(rf"^{re.escape(case_id)}\.attempt-(\d+)\.json$", path.name)
        if match:
            found.append((int(match.group(1)), path))
    records = []
    for file_attempt, path in sorted(found):
        record = json.loads(path.read_text())
        recorded = record.get("attempt")
        recorded = recorded if isinstance(recorded, int) else None
        records.append({"attempt": recorded if recorded is not None else file_attempt,
                        "fileAttempt": file_attempt, "recordedAttempt": recorded,
                        "path": str(path), "result": record.get("result"),
                        "failures": record.get("failures"), "returncode": record.get("returncode"),
                        "slurmJobId": record.get("slurmJobId"),
                        "slurmRestartCount": record.get("slurmRestartCount"),
                        "record": record})
    return sorted(records, key=lambda entry: (entry["attempt"], entry["fileAttempt"]))


def restart_evidence(attempt: dict) -> list[str]:
    """Reasons this single record cannot be read as an undisturbed first run.

    A nonzero `SLURM_RESTART_COUNT`, a persisted attempt past the first, or a record whose name and
    persisted attempt disagree all mean the task ran more than once, whether or not an earlier run left
    a record behind. An unparseable restart count counts too: it is not evidence of zero.
    """
    reasons = []
    raw = attempt.get("slurmRestartCount")
    if raw is not None:
        try:
            if int(raw) > 0:
                reasons.append(f"the record reports a nonzero restart count (SLURM_RESTART_COUNT {raw!r}), "
                               "so the task was requeued and an earlier run may have left no record")
        except (TypeError, ValueError):
            reasons.append(f"the record's restart count {raw!r} is unreadable, which is not evidence of "
                           "zero restarts")
    recorded, named = attempt.get("recordedAttempt"), attempt.get("fileAttempt")
    if isinstance(recorded, int) and recorded > 1:
        reasons.append(f"the record persists attempt {recorded}, so it is not this case's first run")
    if isinstance(recorded, int) and isinstance(named, int) and recorded != named:
        reasons.append(f"the record persists attempt {recorded} under a file name that says {named}")
    return reasons


def verdict_for_attempts(state: str, exit_code: str, attempts: list[dict]) -> tuple[str, list[str]]:
    """Judge a case from every attempt record it left, conservatively.

    More than one record means the task ran more than once, and this driver cannot tell which run the
    scheduler's single terminal state belongs to. That is never a pass: it is reported as needing
    reconciliation, with every attempt's own result named.

    One record is not automatically one run. A requeue between the case-directory claim and the result
    write leaves exactly one record, under the base name, from the second run — so a lone record that
    carries restart evidence is also never a pass. Only an undisturbed first run reaches the ordinary
    four-part verdict, so a normal batch is unaffected.
    """
    if not attempts:
        return verdict_for(state, exit_code, None)
    if len(attempts) > 1:
        summary = ", ".join(f"attempt {attempt['attempt']}: {attempt['result']}" for attempt in attempts)
        reasons = [f"{len(attempts)} attempt records need reconciliation before any verdict ({summary}); "
                   "the scheduler reports one terminal state and it cannot be attributed to one attempt"]
        _, single = verdict_for(state, exit_code, attempts[-1]["record"])
        return "FAILED", reasons + single
    replay = restart_evidence(attempts[0])
    if replay:
        reasons = ["one result record but the task did not run once, so it needs reconciliation before "
                   f"any verdict: {'; '.join(replay)}"]
        _, single = verdict_for(state, exit_code, attempts[0]["record"])
        return "FAILED", reasons + single
    return verdict_for(state, exit_code, attempts[0]["record"])


def collect(batch_record_path: Path, sacct_reader=read_sacct) -> dict:
    record = json.loads(Path(batch_record_path).read_text())
    results_directory = Path(record["resultsDirectory"])
    entries = []
    for job in record["jobs"]:
        sacct = sacct_reader(job["jobId"])
        state, exit_code = sacct_fields(sacct, job["jobId"])
        attempts = attempt_records(results_directory, job["caseId"])
        verdict, reasons = verdict_for_attempts(state, exit_code, attempts)
        judged = attempts[-1]["record"] if attempts else {}
        entries.append({"caseId": job["caseId"], "kind": job["kind"], "jobId": job["jobId"],
                        "sacct": sacct, "observedTerminalState": state, "observedExitCode": exit_code,
                        "resultFile": attempts[0]["path"] if attempts else None,
                        "attempts": [{key: attempt[key] for key in
                                      ("attempt", "fileAttempt", "recordedAttempt", "path", "result",
                                       "failures", "returncode", "slurmJobId", "slurmRestartCount")}
                                     for attempt in attempts],
                        "collected": judged.get("collected"),
                        "collectedTestFiles": judged.get("collectedTestFiles"),
                        "collectionRule": judged.get("collectionRule"),
                        "artifact": judged.get("artifact"),
                        "cleanup": judged.get("cleanup"),
                        "childProcessCleanup": judged.get("childProcessCleanup"),
                        "protectedCacheCheck": judged.get("protectedCacheCheck"),
                        "environmentRoots": judged.get("environmentRoots"),
                        "caseResult": judged.get("result"),
                        "caseFailures": judged.get("failures"),
                        "verdict": verdict, "verdictReasons": reasons})
    report = {"batchId": record["batchId"], "collectedAt": time.time(), "entries": entries,
              "passed": sum(entry["verdict"] == "PASSED" for entry in entries), "total": len(entries)}
    write_json_durable(Path(record["batchDirectory"]) /
                       f"collect-{int(time.time())}-{uuid.uuid4().hex[:6]}.json", report)
    print(json.dumps(report, indent=2, default=str))
    return report


def wait_for(batch_record_path: Path) -> None:
    """Block on the scheduler's own handles once, then stop. No status polling in a caller."""
    record = json.loads(Path(batch_record_path).read_text())
    for job_id in record["jobIds"]:
        job = submitit.SlurmJob(folder=record["logsFolder"], job_id=job_id)
        try:
            job.result()
        except Exception as error:  # a failing case is evidence, not a driver crash
            print(f"{job_id}: {type(error).__name__}: {str(error)[-500:]}", file=sys.stderr)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=("validate", "submit", "wait", "collect", "reconcile"))
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--execution-root", type=Path, help="where this batch claims its directory")
    parser.add_argument("--batch-record", type=Path, help="batch-record.json for wait/collect")
    parser.add_argument("--batch-directory", type=Path, help="a claimed batch directory for reconcile")
    parser.add_argument("--wait", action="store_true", help="submit, then block on the job handles")
    arguments = parser.parse_args(argv)

    if arguments.action == "reconcile":
        if not arguments.batch_directory:
            parser.error("reconcile needs --batch-directory")
        report = reconcile(arguments.batch_directory)
        # An unknown submission window is an operator decision, so it exits nonzero and nothing here
        # resubmits anything.
        return 0 if report["reconciliationState"] in ("RECORDED", "RECONCILED") else 4
    if arguments.action in ("validate", "submit"):
        try:
            cases = validate_manifest(load_manifest(arguments.manifest))
        except (ManifestError, json.JSONDecodeError, OSError) as problem:
            print(f"{arguments.manifest}: {type(problem).__name__}: {problem}", file=sys.stderr)
            return 2
        if arguments.action == "validate":
            print(json.dumps({"manifest": str(arguments.manifest),
                              "cases": [case["id"] for case in cases],
                              "sha256": digest_of(arguments.manifest)}, indent=2))
            return 0
        if not arguments.execution_root:
            parser.error("submit needs --execution-root")
        try:
            record = submit(arguments.manifest, arguments.execution_root)
        except UnreconciledSubmissionGap as gap:
            print(f"refusing to submit: {gap}", file=sys.stderr)
            return 4
        if arguments.wait:
            wait_for(Path(record["batchDirectory"]) / "batch-record.json")
        return 0
    if not arguments.batch_record:
        parser.error(f"{arguments.action} needs --batch-record")
    if arguments.action == "wait":
        wait_for(arguments.batch_record)
        return 0
    report = collect(arguments.batch_record)
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
