#!/usr/bin/env python3
"""Reap the orphaned sideband helper and report its ACTUAL terminal status.

Why this exists. The abrupt-parent-death scenario kills the helper's parent outright. A dead parent cannot
forward its child's exit status, so the surrounding test could previously establish only that the helper emitted
its parent-gone diagnostic and then disappeared. Neither of those is a terminal status: the same diagnostic and
the same disappearance are produced by a process that exits 0, and `kill(pid, 0)` returning ESRCH says a pid is
unused, not how its occupant died. `runBinder` calling `process.exit(4)` is source intent, not an observation.

How it gets the status. Linux reparents an orphan to the nearest ancestor marked `PR_SET_CHILD_SUBREAPER`
rather than always to pid 1. This process sets that flag **before** starting anything, so when the disposable
parent is killed the helper is reparented here and `waitpid` yields its real wait status. Nothing about the
helper or the production binder changes; the only new thing is somebody left alive who is entitled to reap it.

Scope. This is a test harness. It is not a supervisor, it is not a daemon, it exits with the scenario, and it
only ever reaps processes descended from the one child it started itself. There is no global process discovery
and no ownership inferred from a process name.

Bounded by design. `signal.alarm` arms a real timer and `signal.set_wakeup_fd` turns both SIGCHLD and SIGALRM
into a readable byte, so the main loop blocks in `selectors.select` and is woken by an event - a readable pipe or
a delivered signal. There is no sleep and no poll loop, and a scenario that never terminates ends with a recorded
failure rather than a hang.

Usage:
  subreaper-observer.py --node <nodeExecPath> --parent-script <disposableParent.mjs>
                        --child-script <heldBinderOrImposter.mjs> --socket <absolutePath>
                        [--timeout <seconds>]

Protocol on stdin (one line):
  kill   - SIGKILL the disposable parent this process started, then reap whatever reparents here.

Every byte the disposable parent and the helper write is relayed verbatim to this process's stdout, so a caller's
existing marker waits keep working. Records are single-line JSON, prefixed for grepping:
  observer-pid / observed-parent-pid / observed-helper-pid / observer-sent-sigkill
  OBSERVER-REAPED  {...}   one per reaped process, with the raw wait status and both decodings
  OBSERVER-DONE    {...}   the summary, including which expected pids were reaped
  OBSERVER-TIMEOUT {...}   the bound was reached; nothing is claimed about anything left unreaped
"""

import argparse
import ctypes
import ctypes.util
import json
import os
import selectors
import signal
import sys

PR_SET_CHILD_SUBREAPER = 36
EXIT_OK = 0
EXIT_TIMEOUT = 3
EXIT_SETUP = 4
HELPER_PID_MARKER = "binder-pid "
CLEANUP_DEADLINE_SECONDS = 10

alarm_fired = False


def on_alarm(_signum, _frame) -> None:
    global alarm_fired
    alarm_fired = True


def become_subreaper() -> None:
    """Ask the kernel to reparent this process's orphaned descendants here instead of to pid 1."""
    libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_CHILD_SUBREAPER) failed")


def decode(status: int) -> dict:
    """Both decodings of one raw wait status, so nothing downstream has to guess which one applied."""
    exited = os.WIFEXITED(status)
    signalled = os.WIFSIGNALED(status)
    return {
        "rawWaitStatus": status,
        "exitedNormally": exited,
        "exitCode": os.WEXITSTATUS(status) if exited else None,
        "terminatedBySignal": signalled,
        "termSignalNumber": os.WTERMSIG(status) if signalled else None,
        "termSignalName": signal.Signals(os.WTERMSIG(status)).name if signalled else None,
        "coreDumped": os.WCOREDUMP(status) if signalled else False,
    }


def emit(line: str) -> None:
    sys.stdout.write(line if line.endswith("\n") else f"{line}\n")
    sys.stdout.flush()


def start_disposable_parent(arguments, out_write: int, err_write: int, closable: tuple[int, ...]) -> int:
    """Fork and exec the disposable parent, whose stdout and stderr the helper will inherit."""
    pid = os.fork()
    if pid != 0:
        return pid
    # Its own process group, whose id is this pid. That is what makes the subtree owned by construction: cleanup
    # can reach a descendant whose identity was never reported, without discovering pids and without a scan.
    os.setpgid(0, 0)
    os.dup2(out_write, 1)
    os.dup2(err_write, 2)
    for descriptor in closable:
        try:
            os.close(descriptor)
        except OSError:
            pass
    try:
        os.execv(arguments.node, [
            arguments.node, arguments.parent_script, "hold", arguments.child_script, arguments.socket,
        ])
    finally:
        os._exit(EXIT_SETUP)


def kill_and_reap_owned(group_pid: int, reaped: dict, reap_ready, wake_read: int) -> dict:
    """Kill the owned subtree and stay alive to collect it, bounded, then report what really happened.

    Signalling and leaving is what this replaces: a subreaper that exits with descendants unreaped hands them to
    something else and no status is ever collected. The signal goes to the process GROUP the forked parent leads,
    so a descendant whose pid was never reported is reached anyway - no pid discovery, no scan of anything this
    process does not own.

    The wait is the same mechanism the main loop uses: SIGCHLD and SIGALRM arrive as a readable byte on the wakeup
    pipe, so this blocks in `select` and is woken by events. No sleep and no retry loop. The end condition is
    `waitpid` reporting no remaining children, which is the kernel's own answer rather than an empty list.
    """
    global alarm_fired
    before = set(reaped)
    account = {
        "killedOwnedProcessGroup": False,
        "killSignal": "SIGKILL",
        "processGroup": group_pid,
        "killError": None,
        "reapedDuringCleanup": [],
        "noChildrenRemaining": False,
        "cleanupTimedOut": False,
        "stillUnreaped": [],
        "uncertainty": [],
    }
    try:
        os.killpg(group_pid, signal.SIGKILL)
        account["killedOwnedProcessGroup"] = True
    except OSError as error:
        # ESRCH here means the group is already gone, which is a fine outcome rather than a failure to report.
        account["killError"] = f"{type(error).__name__}: {error}"

    alarm_fired = False
    signal.alarm(CLEANUP_DEADLINE_SECONDS)
    selector = selectors.DefaultSelector()
    selector.register(wake_read, selectors.EVENT_READ, "signal")
    try:
        if reap_ready():
            account["noChildrenRemaining"] = True
        while not account["noChildrenRemaining"] and not alarm_fired:
            try:
                for _key, _mask in selector.select():
                    try:
                        os.read(wake_read, 4096)
                    except (BlockingIOError, OSError):
                        pass
            except InterruptedError:
                pass
            if reap_ready():
                account["noChildrenRemaining"] = True
    finally:
        signal.alarm(0)
        selector.close()

    account["cleanupTimedOut"] = alarm_fired and not account["noChildrenRemaining"]
    account["reapedDuringCleanup"] = [reaped[pid] for pid in sorted(set(reaped) - before)]
    if not account["noChildrenRemaining"]:
        # Named uncertainty, because an unreaped child is exactly what must not be claimed away.
        account["stillUnreaped"] = ["at-least-one-waitable-child-remained"]
        account["uncertainty"] = [
            "the cleanup deadline passed with at least one waitable child still unreaped; its terminal status is "
            "unknown and this process is relinquishing it",
        ]
    return account


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", required=True)
    parser.add_argument("--parent-script", required=True)
    parser.add_argument("--child-script", required=True)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--timeout", type=int, default=45)
    arguments = parser.parse_args()
    if not arguments.socket.startswith("/"):
        emit(f"OBSERVER-SETUP-FAILED {json.dumps({'reason': 'socket path must be absolute'})}")
        return EXIT_SETUP

    try:
        become_subreaper()
    except OSError as error:
        emit(f"OBSERVER-SETUP-FAILED {json.dumps({'reason': str(error)})}")
        return EXIT_SETUP

    wake_read, wake_write = os.pipe()
    os.set_blocking(wake_read, False)
    os.set_blocking(wake_write, False)
    signal.signal(signal.SIGCHLD, lambda *_: None)
    signal.signal(signal.SIGALRM, on_alarm)
    signal.set_wakeup_fd(wake_write)
    signal.alarm(arguments.timeout)

    out_read, out_write = os.pipe()
    err_read, err_write = os.pipe()
    parent_pid = start_disposable_parent(
        arguments, out_write, err_write, (out_read, out_write, err_read, err_write, wake_read, wake_write),
    )
    os.close(out_write)
    os.close(err_write)
    emit(f"observer-pid {os.getpid()}")
    emit(f"observed-parent-pid {parent_pid}")

    selector = selectors.DefaultSelector()
    streams = {out_read: "stdout", err_read: "stderr"}
    for descriptor, name in ((out_read, "stdout"), (err_read, "stderr"), (wake_read, "signal"), (0, "stdin")):
        os.set_blocking(descriptor, False)
        selector.register(descriptor, selectors.EVENT_READ, name)

    relayed = ""
    reaped: dict[int, dict] = {}
    helper_pid = None
    killed = False
    cleanup_requested = False
    open_streams = {"stdout", "stderr"}

    def accounted_for() -> bool:
        # Done when the parent this process started and the helper it forked have both been reaped here.
        return parent_pid in reaped and helper_pid is not None and helper_pid in reaped

    def reap_ready() -> bool:
        """Collect everything reapable now. Returns True once no waitable child remains at all."""
        while True:
            try:
                dead_pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                # Authoritative: this process has no children left, reaped or otherwise.
                return True
            if dead_pid == 0:
                return False
            record = decode(status)
            record["pid"] = dead_pid
            record["role"] = (
                "disposable-parent" if dead_pid == parent_pid
                else "helper" if dead_pid == helper_pid
                else "unexpected-descendant"
            )
            reaped[dead_pid] = record
            emit(f"OBSERVER-REAPED {json.dumps(record)}")

    while not accounted_for() and not alarm_fired and not cleanup_requested:
        try:
            events = selector.select()
        except InterruptedError:
            continue
        for key, _ in events:
            descriptor = key.fd
            name = key.data
            if name == "signal":
                try:
                    os.read(descriptor, 4096)
                except (BlockingIOError, OSError):
                    pass
                # SIGCHLD and SIGALRM both arrive here. Reaping is driven by the signal, never by asking again.
                reap_ready()
                continue
            if name == "stdin":
                try:
                    data = os.read(descriptor, 4096)
                except BlockingIOError:
                    continue
                if not data:
                    selector.unregister(descriptor)
                    continue
                if b"cleanup" in data:
                    # The harness asking the owner to tidy up, rather than signalling numbers it parsed from a log.
                    emit("observer-asked-to-clean-up")
                    cleanup_requested = True
                    break
                if b"kill" in data and not killed:
                    killed = True
                    os.kill(parent_pid, signal.SIGKILL)
                    emit(f"observer-sent-sigkill {parent_pid}")
                continue
            try:
                data = os.read(descriptor, 65536)
            except BlockingIOError:
                continue
            if not data:
                selector.unregister(descriptor)
                open_streams.discard(streams[descriptor])
                continue
            text = data.decode("utf-8", "replace")
            relayed += text
            sys.stdout.write(text)
            sys.stdout.flush()
            if helper_pid is None and HELPER_PID_MARKER in relayed:
                tail = relayed.split(HELPER_PID_MARKER, 1)[1].split()
                if tail and tail[0].isdigit():
                    helper_pid = int(tail[0])
                    emit(f"observed-helper-pid {helper_pid}")
                    # The helper may already have been reaped as an unexpected descendant before its pid was
                    # known, so relabel that record rather than leaving it misfiled.
                    if helper_pid in reaped:
                        reaped[helper_pid]["role"] = "helper"

    signal.alarm(0)
    summary = {
        "endedBecause": (
            "accounted-for" if accounted_for()
            else "cleanup-requested" if cleanup_requested
            else "deadline"
        ),
        "observerPid": os.getpid(),
        "disposableParentPid": parent_pid,
        "helperPid": helper_pid,
        "sentSigkillToParent": killed,
        "reapedPids": sorted(reaped),
        "reaped": {str(pid): record for pid, record in reaped.items()},
        # As observed when the main loop ended, before any cleanup phase below.
        "streamsStillOpenAtMainLoopEnd": sorted(open_streams),
        "timedOut": not accounted_for(),
    }
    if not accounted_for():
        summary["cleanup"] = kill_and_reap_owned(parent_pid, reaped, reap_ready, wake_read)
        summary["reapedPids"] = sorted(reaped)
        summary["reaped"] = {str(pid): record for pid, record in reaped.items()}
        emit(f"OBSERVER-TIMEOUT {json.dumps(summary)}")
        return EXIT_TIMEOUT
    emit(f"OBSERVER-DONE {json.dumps(summary)}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
