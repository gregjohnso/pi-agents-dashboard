"""Bundled-CLI acceptance for the native input seams (B/C/F), with the full evidence a reviewer needs.

Two independent cases fan out as one SLURM array, each opens a real PTY, runs
`node --import <outside-bundle pre-TUI caller> <consumer>/…/dist/bundle/cli.js`, waits until the CLI's own
device-attributes query is *observed*, writes `ESC[?62;c` back, and requires the authorized case to enable
modifyOtherKeys (`ESC[>4;2m`) while the refused case must not. A third case is a negative control for the
cleanup evidence: it plants a survivor on purpose.

It drives the already-built cohort named by the artifacts manifest and never builds, installs or patches
anything. Inputs, all resolved from this file's own repository or from the environment, so nothing is
machine-local here:

  PI_NATIVE_ARTIFACTS_MANIFEST  the manifest written by `write-artifacts-manifest.mjs`; required, with no
                                default, so a leftover manifest can never drive an older build
  PI_NATIVE_NODE                the Node binary the cases run (defaults to `node` on PATH, and the measured
                                version is recorded in every case record)
  --attempt-root <directory>    where the evidence for this attempt is written; it must not already exist

What the evidence covers:

1. **The whole PTY stream is retained**, byte for byte, as `cases/<id>/pty-stream.bin` with its sha256 and
   length. The modifyOtherKeys verdict is recomputed **from the re-read file**, so the decision's observable
   consequence is a retained raw sequence rather than a derived boolean.
2. **Terminal `sacct` accounting** is collected by one merge job submitted with `--dependency=afterany:<array>`,
   so it runs only once every array task has reached a terminal state. No polling loop, no sleep.
3. **Exact identity-qualified descendant cleanup.** While the CLI is alive its whole descendant tree is
   recorded by identity (`pid` + `/proc` start time + `comm` + `ppid` + `pgid`). After it exits, every
   recorded identity is re-checked, and the child's own process group is scanned for anything the ledger
   never saw. Survivors are escalated SIGTERM→SIGKILL with the identity revalidated before every signal, so
   a recycled pid is never signalled. `processReaped` alone is no longer accepted as cleanup evidence.

Identity helpers come from the repository's own `test/slurm/submit_cases.py`, imported unchanged.
"""

import argparse
import fcntl
import hashlib
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

import cloudpickle
import submitit

REPOSITORY = Path(__file__).resolve().parents[3]
PRELOAD = REPOSITORY / "test/fixtures/native-ingress/bundled-cli-host-preload.mjs"
NODE = Path(os.environ.get("PI_NATIVE_NODE") or shutil.which("node") or "node")

sys.path.insert(0, str(REPOSITORY / "test/slurm"))
import submit_cases  # noqa: E402  the repository's own driver, imported unchanged for its identity helpers

KITTY_QUERY_TAIL = "\x1b[?u"
DEVICE_ATTRIBUTES_REPLY = b"\x1b[?62;c"
MODIFY_OTHER_KEYS_ENABLE = b"\x1b[>4;2m"
SESSION_DEADLINE_SECONDS = 120
TERMINAL_SACCT_STATES = submit_cases.TERMINAL_STATES

CASES = [
    {"id": "bundled-cli-authorized", "kind": "bundled-cli", "decision": "apply",
     "expectModifyOtherKeys": True},
    {"id": "bundled-cli-refused", "kind": "bundled-cli", "decision": "refuse",
     "expectModifyOtherKeys": False},
    # Negative control for obligation 3: an empty survivor set proves nothing on its own, because the
    # bundled CLI spawns no descendant. This case deliberately leaves one behind.
    {"id": "descendant-cleanup-control", "kind": "cleanup-control"},
]
SURVIVOR_LIFETIME_SECONDS = 600


def load_artifacts_manifest() -> tuple[Path, dict]:
    """The cohort this run drives, from `PI_NATIVE_ARTIFACTS_MANIFEST` alone. There is no default path.

    A manifest holds absolute paths into one machine's disposable build output, so a guessed one would drive
    whatever build was left behind. An unset variable, and an empty, unreadable or malformed selection, all
    fail here — before anything is submitted.
    """
    selected = os.environ.get("PI_NATIVE_ARTIFACTS_MANIFEST", "")
    if not selected.strip():
        raise SystemExit(
            "PI_NATIVE_ARTIFACTS_MANIFEST names the artifacts manifest this driver drives, and it is unset or "
            "empty. There is no default: build the cohort, write a manifest with "
            "test/fixtures/native-ingress/write-artifacts-manifest.mjs, and name it."
        )
    path = Path(selected).resolve()
    try:
        manifest = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"{path} is not a usable artifacts manifest: {error}") from error
    root = manifest.get("tuiPackageRoot")
    if not isinstance(root, str) or not root:
        raise SystemExit(f'{path} is missing a usable "tuiPackageRoot"')
    return path, manifest


def fsync_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True, default=str)
        handle.flush()
        os.fsync(handle.fileno())


def process_group_of(pid: int) -> int | None:
    try:
        return int(Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[2])
    except (FileNotFoundError, ProcessLookupError, IndexError, ValueError):
        return None


def command_name_of(pid: int) -> str | None:
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except (FileNotFoundError, ProcessLookupError):
        return None


def children_of(pid: int) -> list[int]:
    found: list[int] = []
    try:
        threads = list(Path(f"/proc/{pid}/task").iterdir())
    except (FileNotFoundError, ProcessLookupError):
        return []
    for thread in threads:
        try:
            found += [int(part) for part in (thread / "children").read_text().split()]
        except (FileNotFoundError, ProcessLookupError):
            continue
    return sorted(set(found))


def identity_of(pid: int) -> dict | None:
    """Pid plus `/proc` start time, so a recycled pid is never mistaken for the process that had it."""
    identity = submit_cases.process_identity(pid)
    if identity is None:
        return None
    return {**identity, "comm": command_name_of(pid), "pgid": process_group_of(pid)}


def descendant_ledger(root_pid: int) -> list[dict]:
    """Every process in the subtree rooted at `root_pid`, by identity, recorded while they are alive."""
    ledger: list[dict] = []
    seen: set[int] = set()
    frontier = [root_pid]
    while frontier:
        pid = frontier.pop()
        if pid in seen:
            continue
        seen.add(pid)
        identity = identity_of(pid)
        if identity is None:
            continue
        ledger.append({**identity, "isRoot": pid == root_pid})
        frontier += [child for child in children_of(pid) if child not in seen]
    return sorted(ledger, key=lambda entry: entry["pid"])


def process_group_members(pgid: int, exclude: set[int]) -> list[dict]:
    """Live members of one process group, by identity. A bounded `/proc` read, not a filesystem scan."""
    members = []
    for entry in sorted(Path("/proc").iterdir()):
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in exclude or process_group_of(pid) != pgid:
            continue
        identity = identity_of(pid)
        if identity is not None:
            members.append(identity)
    return members


def escalate_until_gone(identity: dict) -> dict:
    """SIGTERM then SIGKILL one surviving identity, revalidating the identity before every signal."""
    for number, name, grace in (
        (signal.SIGTERM, "SIGTERM", submit_cases.CHILD_TERM_GRACE_SECONDS),
        (signal.SIGKILL, "SIGKILL", submit_cases.CHILD_KILL_GRACE_SECONDS),
    ):
        if not submit_cases.identity_matches(identity, submit_cases.process_identity(identity["pid"])):
            return {"identity": identity, "signal": name, "result": "ALREADY_GONE_OR_REUSED"}
        try:
            os.kill(identity["pid"], number)
        except ProcessLookupError:
            return {"identity": identity, "signal": name, "result": "ALREADY_GONE"}
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            if not submit_cases.identity_matches(identity, submit_cases.process_identity(identity["pid"])):
                return {"identity": identity, "signal": name, "result": "GONE_AFTER_SIGNAL"}
            time.sleep(submit_cases.CHILD_REAP_INTERVAL_SECONDS)
    return {"identity": identity, "signal": "SIGKILL", "result": "SURVIVED_SIGKILL"}


def cleanup_descendants(ledger: list[dict], child_pid: int, child_pgid: int | None) -> dict:
    """Identity-qualified survivor check over the recorded subtree and the child's own process group."""
    survivors = [
        entry
        for entry in ledger
        if submit_cases.identity_matches(entry, submit_cases.process_identity(entry["pid"]))
    ]
    unledgered = (
        process_group_members(child_pgid, exclude={os.getpid()})
        if child_pgid is not None
        else []
    )
    known = {entry["pid"] for entry in survivors}
    survivors += [entry for entry in unledgered if entry["pid"] not in known]
    actions = [escalate_until_gone(entry) for entry in survivors]
    remaining = [
        entry
        for entry in survivors
        if submit_cases.identity_matches(entry, submit_cases.process_identity(entry["pid"]))
    ]
    return {
        "ledger": ledger,
        "ledgerSize": len(ledger),
        "childPid": child_pid,
        "childProcessGroup": child_pgid,
        "survivorsBeforeEscalation": survivors,
        "actions": actions,
        "survivorsAfterEscalation": remaining,
        "processGroupMembersAfterExit": unledgered,
        "processGroupMembersAfterEscalation": (
            process_group_members(child_pgid, exclude={os.getpid()}) if child_pgid is not None else []
        ),
        "rule": "every recorded descendant identity is gone, and the child's process group holds no member",
    }


def run_case(case: dict, attempt_root: str, consumer_root: str, tui_package_root: str) -> dict:
    """Runs on the worker: one PTY session against the installed bundled CLI, with full evidence retained."""
    attempt = Path(attempt_root)
    case_root = attempt / "cases" / case["id"]
    disposable = case_root / "env"
    for name in ("home", "agent", "project", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "tmp"):
        (disposable / name).mkdir(parents=True, exist_ok=True)
    host_log = case_root / "native-host.jsonl"
    host_log.write_text("")

    cli = Path(consumer_root) / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
    env = dict(os.environ)
    env.pop("PIXI_PROJECT_MANIFEST", None)
    # No credential reaches the CLI: it must not be able to call a model even if it wanted to.
    for name in list(env):
        if any(marker in name.upper() for marker in ("API_KEY", "TOKEN", "SECRET", "CREDENTIAL", "PASSWORD")):
            env.pop(name)
        elif name.startswith(("AWS_", "ANTHROPIC_", "OPENAI_", "GOOGLE_", "AZURE_", "GEMINI_", "XAI_")):
            env.pop(name)
    env.update(
        HOME=str(disposable / "home"),
        XDG_CONFIG_HOME=str(disposable / "xdg-config"),
        XDG_CACHE_HOME=str(disposable / "xdg-cache"),
        XDG_DATA_HOME=str(disposable / "xdg-data"),
        XDG_STATE_HOME=str(disposable / "xdg-state"),
        TMPDIR=str(disposable / "tmp"),
        TERM="xterm-256color",
        PI_STARTUP_BENCHMARK="1",
        PI_OFFLINE="1",
        PI_CODING_AGENT_DIR=str(disposable / "agent"),
        PI_NATIVE_HOST_LOG=str(host_log),
        PI_NATIVE_HOST_TUI_PACKAGE=str(tui_package_root),
        PI_NATIVE_HOST_DECISION=case["decision"],
    )

    node_version = subprocess.run([str(NODE), "--version"], capture_output=True, text=True, env=env)
    argv = [str(NODE), "--import", str(PRELOAD), str(cli)]

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    started = time.time()
    proc = subprocess.Popen(
        argv,
        cwd=str(disposable / "project"),
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)
    child_pgid = process_group_of(proc.pid)

    stream = bytearray()
    ledger: list[dict] = []
    query_observed_at = None
    reply_written_at = None
    read_error = None
    deadline = started + SESSION_DEADLINE_SECONDS
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            read_error = "session deadline reached"
            break
        readable, _, _ = select.select([master], [], [], remaining)
        if not readable:
            read_error = "select timed out"
            break
        try:
            chunk = os.read(master, 65536)
        except OSError as error:  # EIO: the child closed the PTY slave, i.e. it exited
            read_error = f"{type(error).__name__}: {error}"
            break
        if not chunk:
            break
        stream += chunk
        # Reply only to a query we actually observed on the CLI's own terminal.
        if query_observed_at is None and KITTY_QUERY_TAIL.encode("utf-8") in stream:
            query_observed_at = round(time.time() - started, 4)
            # The CLI is alive here, so this is the moment its descendants can be recorded by identity.
            ledger = descendant_ledger(proc.pid)
            os.write(master, DEVICE_ATTRIBUTES_REPLY)
            reply_written_at = round(time.time() - started, 4)

    try:
        returncode = proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        returncode = proc.wait(timeout=30)
    os.close(master)
    cleanup = cleanup_descendants(ledger, proc.pid, child_pgid)

    # The complete stream, byte for byte, and the verdict recomputed from the file as re-read from disk.
    stream_path = case_root / "pty-stream.bin"
    with stream_path.open("wb") as handle:
        handle.write(bytes(stream))
        handle.flush()
        os.fsync(handle.fileno())
    retained = stream_path.read_bytes()
    modify_other_keys = MODIFY_OTHER_KEYS_ENABLE in retained
    (case_root / "pty-stream.txt").write_text(retained.decode("utf-8", errors="replace"))

    host_events = [json.loads(line) for line in host_log.read_text().splitlines() if line.strip()]
    responses = [event for event in host_events if event["event"] == "beforeApplyTerminalResponse"]
    preload_events = [event for event in host_events if event["event"] == "preload"]
    registered = [event for event in host_events if event["event"] == "registered"]
    cli_node = preload_events[0]["node"] if preload_events else None
    cli_major = int(cli_node.lstrip("v").split(".")[0]) if cli_node else None
    cli_minor = int(cli_node.lstrip("v").split(".")[1]) if cli_node else None

    checks = {
        "cliExitedZero": returncode == 0,
        "startupQueryObserved": query_observed_at is not None,
        "replyWritten": reply_written_at is not None,
        "preTuiCallerRegistered": len(registered) == 1 and registered[0]["hostVisibleFromInstalledInstance"],
        "bundleConsultedOutsideBundleHost": len(responses) == 1,
        "responseKindIsDeviceAttributes": len(responses) == 1 and responses[0]["kind"] == "da",
        "rawIsCompleteResponse": (
            len(responses) == 1 and responses[0]["raw"] == DEVICE_ATTRIBUTES_REPLY.decode("utf-8")
        ),
        "modifyOtherKeysMatchesDecision": modify_other_keys == case["expectModifyOtherKeys"],
        "cliRuntimeIsNode22": cli_major == 22 and cli_minor is not None and cli_minor >= 19,
        "processReaped": returncode is not None,
        # The three round-3 evidence obligations.
        "fullPtyStreamRetained": len(retained) == len(stream),
        "descendantLedgerRecordedWhileAlive": any(entry["isRoot"] for entry in cleanup["ledger"]),
        "noSurvivingDescendantsOrGroupMembers": not cleanup["survivorsAfterEscalation"]
        and not cleanup["processGroupMembersAfterEscalation"],
    }
    record = {
        "caseId": case["id"],
        "decision": case["decision"],
        "slurmJobId": os.environ.get("SLURM_JOB_ID"),
        "slurmArrayJobId": os.environ.get("SLURM_ARRAY_JOB_ID"),
        "slurmArrayTaskId": os.environ.get("SLURM_ARRAY_TASK_ID"),
        "hostname": os.uname().nodename,
        "argv": argv,
        "cwd": str(disposable / "project"),
        "consumerRoot": consumer_root,
        "installedTuiPackageRoot": tui_package_root,
        "bundledCli": str(cli),
        "bundledCliSha256": subprocess.run(
            ["sha256sum", str(cli)], capture_output=True, text=True
        ).stdout.split()[0],
        "preloadSha256": hashlib.sha256(PRELOAD.read_bytes()).hexdigest(),
        "nodeVersionOnWorker": node_version.stdout.strip(),
        "nodeBinary": str(NODE),
        "cliProcessNodeVersion": cli_node,
        "credentialEnvNamesPassed": sorted(
            name
            for name in env
            if any(marker in name.upper() for marker in ("API_KEY", "TOKEN", "SECRET", "CREDENTIAL", "PASSWORD"))
        ),
        "workerPythonVersion": sys.version.split()[0],
        "returncode": returncode,
        "terminatedBySignal": -returncode if isinstance(returncode, int) and returncode < 0 else None,
        "durationSeconds": round(time.time() - started, 3),
        "queryObservedAtSeconds": query_observed_at,
        "replyWrittenAtSeconds": reply_written_at,
        "readError": read_error,
        "modifyOtherKeysEnabled": modify_other_keys,
        "modifyOtherKeysOffsetInRetainedStream": retained.find(MODIFY_OTHER_KEYS_ENABLE),
        "hostEvents": host_events,
        "hostEventLog": str(host_log),
        "ptyStreamFile": str(stream_path),
        "ptyStreamBytes": len(retained),
        "ptyStreamSha256": hashlib.sha256(retained).hexdigest(),
        "ptyStreamTail": retained[-2000:].decode("utf-8", errors="replace"),
        "descendantCleanup": cleanup,
        "checks": checks,
        "verdict": "PASSED" if all(checks.values()) else "FAILED",
    }
    fsync_json(case_root / "case-record.json", record)
    return record


def run_cleanup_control(case: dict, attempt_root: str) -> dict:
    """Leave one identified descendant behind on purpose, then require the cleanup to find and kill it.

    `sh` starts a long-lived grandchild in its own new session, reports its pid, and exits as soon as its
    stdin closes. The grandchild is reparented away from this task, so it is exactly the survivor a
    `returncode is not None` check cannot see. This is what makes the empty survivor sets in the bundled
    cases mean something.
    """
    case_root = Path(attempt_root) / "cases" / case["id"]
    case_root.mkdir(parents=True, exist_ok=True)
    started = time.time()
    proc = subprocess.Popen(
        ["/bin/sh", "-c", f"sleep {SURVIVOR_LIFETIME_SECONDS} & echo $!; read done; exit 0"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    child_pgid = process_group_of(proc.pid)
    survivor_pid = int(proc.stdout.readline().strip())
    ledger = descendant_ledger(proc.pid)
    planted = identity_of(survivor_pid)
    proc.stdin.close()
    returncode = proc.wait(timeout=30)
    cleanup = cleanup_descendants(ledger, proc.pid, child_pgid)

    ledgered = [entry for entry in cleanup["ledger"] if entry["pid"] == survivor_pid]
    found = [entry for entry in cleanup["survivorsBeforeEscalation"] if entry["pid"] == survivor_pid]
    killed = [
        action
        for action in cleanup["actions"]
        if action["identity"]["pid"] == survivor_pid and action["result"] == "GONE_AFTER_SIGNAL"
    ]
    checks = {
        # The parent exits cleanly, so the survivor is the shell's own doing rather than a killed parent.
        "parentExitedCleanlyAndWasReaped": returncode == 0,
        "survivorRecordedByIdentityWhileAlive": len(ledgered) == 1
        and planted is not None
        and ledgered[0]["startTime"] == planted["startTime"],
        "survivorDetectedAfterItsParentExited": len(found) == 1,
        "survivorKilledAfterIdentityRevalidation": len(killed) == 1,
        "survivorIdentityGone": planted is not None
        and not submit_cases.identity_matches(planted, submit_cases.process_identity(survivor_pid)),
        "noSurvivingDescendantsOrGroupMembers": not cleanup["survivorsAfterEscalation"]
        and not cleanup["processGroupMembersAfterEscalation"],
    }
    record = {
        "caseId": case["id"],
        "kind": case["kind"],
        "slurmJobId": os.environ.get("SLURM_JOB_ID"),
        "slurmArrayJobId": os.environ.get("SLURM_ARRAY_JOB_ID"),
        "slurmArrayTaskId": os.environ.get("SLURM_ARRAY_TASK_ID"),
        "hostname": os.uname().nodename,
        "workerPythonVersion": sys.version.split()[0],
        "parentPid": proc.pid,
        "parentReturncode": returncode,
        "plantedSurvivor": planted,
        "durationSeconds": round(time.time() - started, 3),
        "descendantCleanup": cleanup,
        "checks": checks,
        "verdict": "PASSED" if all(checks.values()) else "FAILED",
    }
    fsync_json(case_root / "case-record.json", record)
    return record


def run_array_case(case: dict, attempt_root: str, consumer_root: str, tui_package_root: str) -> dict:
    if case["kind"] == "cleanup-control":
        return run_cleanup_control(case, attempt_root)
    return run_case(case, attempt_root, consumer_root, tui_package_root)


def terminal_accounting(array_job_id: str) -> dict:
    """Runs after every array task is terminal, because this job depends on the array with `afterany`."""
    completed = subprocess.run(
        ["sacct", "-j", array_job_id, "-P",
         "--format=JobID,JobName%40,State,ExitCode,Start,End,Elapsed,NodeList%20"],
        capture_output=True,
        text=True,
    )
    return {
        "arrayJobId": array_job_id,
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "collectedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "collectedOn": os.uname().nodename,
        "collectorJobId": os.environ.get("SLURM_JOB_ID"),
    }


def states_in(accounting: dict) -> dict:
    states = {}
    for line in accounting["stdout"].splitlines():
        fields = line.split("|")
        if len(fields) > 3 and fields[0][0].isdigit():
            states[fields[0]] = {"state": fields[2].split()[0], "exitCode": fields[3]}
    return states


def main() -> int:
    parser = argparse.ArgumentParser(description="bundled-CLI acceptance for the native input seams")
    parser.add_argument("--attempt-root", required=True, help="evidence directory for this attempt; must not exist")
    parser.add_argument("--label", default="bundled-cli", help="name recorded in the SLURM job names")
    parsed = parser.parse_args()

    manifest_path, manifest = load_artifacts_manifest()
    tui_package_root = Path(manifest["tuiPackageRoot"])
    consumer_root = manifest.get("consumerRoot") or str(tui_package_root.parents[2])
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    attempt = Path(parsed.attempt_root)
    attempt.mkdir(parents=True, exist_ok=False)
    shutil.copy2(PRELOAD, attempt / PRELOAD.name)
    shutil.copy2(__file__, attempt / Path(__file__).name)
    cloudpickle.register_pickle_by_value(submit_cases)

    executor = submitit.AutoExecutor(folder=str(attempt / "submitit-logs"))
    executor.update_parameters(
        name=f"native-input-{parsed.label}-{stamp}",
        slurm_partition="l40-reserved",
        slurm_qos="dev",
        timeout_min=13,
        cpus_per_task=4,
        slurm_array_parallelism=len(CASES),
    )
    intent = {
        "purpose": "bundled CLI acceptance with full PTY retention, terminal accounting and descendant cleanup",
        "attemptRoot": str(attempt),
        "artifactsManifestFile": str(manifest_path),
        "artifactsManifest": manifest,
        "nodeBinary": str(NODE),
        "consumerRoot": consumer_root,
        "cases": CASES,
        "jobIds": None,
        "intentWrittenAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    fsync_json(attempt / "acceptance-intent.json", intent)

    jobs = executor.map_array(
        run_array_case,
        CASES,
        [str(attempt)] * len(CASES),
        [consumer_root] * len(CASES),
        [str(tui_package_root)] * len(CASES),
    )
    array_id = jobs[0].job_id.split("_")[0]
    fsync_json(attempt / "acceptance-jobs.json", {**intent, "jobIds": [job.job_id for job in jobs],
                                                  "arrayJobId": array_id})
    print(f"submitted bundled-CLI acceptance array {[job.job_id for job in jobs]} -> {attempt}", flush=True)

    # One merge job, gated on the array reaching a terminal state, so `sacct` is read once and is terminal.
    # `afterany` rather than `afterok`: a failed case must still get its accounting, and nothing is orphaned.
    accountant = submitit.AutoExecutor(folder=str(attempt / "sacct-logs"))
    accountant.update_parameters(
        name=f"native-input-{parsed.label}-sacct-{stamp}",
        slurm_partition="l40-reserved",
        slurm_qos="dev",
        timeout_min=5,
        cpus_per_task=1,
        slurm_additional_parameters={"dependency": f"afterany:{array_id}"},
    )
    accounting_job = accountant.submit(terminal_accounting, array_id)
    fsync_json(attempt / "accounting-job.json",
               {"arrayJobId": array_id, "accountingJobId": accounting_job.job_id,
                "dependency": f"afterany:{array_id}"})
    print(f"submitted terminal-accounting job {accounting_job.job_id} (afterany:{array_id})", flush=True)

    records = []
    failures = []
    for case, job in zip(CASES, jobs):
        try:
            records.append(job.result())
        except Exception as exc:
            failures.append({"caseId": case["id"], "jobId": job.job_id, "error": repr(exc)[:40000]})

    try:
        accounting = accounting_job.result()
    except Exception as exc:
        accounting = {"arrayJobId": array_id, "returncode": None, "stdout": "", "stderr": repr(exc)[:4000]}
    (attempt / "acceptance-sacct-terminal.txt").write_text(accounting["stdout"] + accounting["stderr"])
    states = states_in(accounting)
    non_terminal = {
        job_id: state for job_id, state in states.items() if state["state"] not in TERMINAL_SACCT_STATES
    }

    summary = {
        "attemptRoot": str(attempt),
        "jobIds": [job.job_id for job in jobs],
        "arrayJobId": array_id,
        "accountingJobId": accounting_job.job_id,
        "verdicts": {record["caseId"]: record["verdict"] for record in records},
        "failedTasks": failures,
        "checks": {record["caseId"]: record["checks"] for record in records},
        "ptyStreams": {
            record["caseId"]: {
                "file": record["ptyStreamFile"],
                "bytes": record["ptyStreamBytes"],
                "sha256": record["ptyStreamSha256"],
                "modifyOtherKeysOffset": record["modifyOtherKeysOffsetInRetainedStream"],
            }
            for record in records
            if "ptyStreamFile" in record
        },
        "descendantCleanup": {
            record["caseId"]: {
                "ledgerSize": record["descendantCleanup"]["ledgerSize"],
                "survivorsBeforeEscalation": record["descendantCleanup"]["survivorsBeforeEscalation"],
                "actions": record["descendantCleanup"]["actions"],
                "survivorsAfterEscalation": record["descendantCleanup"]["survivorsAfterEscalation"],
                "processGroupMembersAfterEscalation":
                    record["descendantCleanup"]["processGroupMembersAfterEscalation"],
            }
            for record in records
        },
        "terminalAccounting": accounting,
        "terminalAccountingStates": states,
        "nonTerminalStates": non_terminal,
    }
    fsync_json(attempt / "acceptance-record.json", {**summary, "records": records})
    print(json.dumps({key: summary[key] for key in
                      ("attemptRoot", "jobIds", "accountingJobId", "verdicts", "checks", "ptyStreams",
                       "descendantCleanup", "terminalAccountingStates", "nonTerminalStates")},
                     indent=2, default=str)[:12000])
    print(accounting["stdout"])
    passed = not failures and all(record["verdict"] == "PASSED" for record in records)
    return 0 if passed and not non_terminal and states else 1


if __name__ == "__main__":
    raise SystemExit(main())
