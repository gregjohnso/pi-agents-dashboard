/**
 * One permanent pseudo-terminal per Pi owner, held by this process for as long as the owner lives.
 *
 * The mechanism is the pinned, patched native artifact in [vendor/pty](../vendor/pty/README.md); read that
 * file for why it exists, what was rejected and what the patch changes. Three facts about it decide the shape
 * of everything here:
 *
 * **`masterFd` is a real pseudo-terminal master in this process.** Ownership was transferred to us, so the
 * host reads and writes it directly and `TIOCSWINSZ` and `tcgetpgrp` are meaningful on it. It is opened
 * `O_NONBLOCK`. A consumer that wraps it in a Node stream hands the descriptor's lifetime to that stream,
 * because Node closes a socket's descriptor when the socket is destroyed; `close()` below is for the case
 * where nothing else owns it.
 *
 * **The owner is reaped by the artifact, not by this process.** One thread per owner owns the single
 * `wait(2)`, stores the raw status the moment it returns, and only then notifies JavaScript. So
 * `reapIfExited()` is a synchronous read of that stored status: it never waits and never signals. It is a
 * published cache of a completed reap, not a `waitpid` — the status is stored just after `wait(2)` returned,
 * so `null` means "no status published yet", not "the owner is alive". Nothing here may treat it as proof of
 * life: identity is revalidated immediately before any signal, which is `stopVerifiedProcessGroup`'s job.
 *
 * **The owner's identity is bound at birth.** The artifact reads the child's `/proc/<pid>/stat` once, after
 * the spawn and before the waiting thread starts, and Linux cannot reuse a PID that nothing has reaped yet.
 * That snapshot is where this module takes the owner's PID, start identity, process group, session and
 * controlling terminal from, so a PID reused after the native thread reaps the owner cannot be mistaken for
 * it. Every later read by PID — `foregroundProcessGroup()` — compares the start identity in that snapshot and
 * refuses rather than returning another process's answer.
 *
 * **Platform: Linux, x86-64, glibc.** The artifact is a Node-API version 4 addon, so it is ABI-stable across
 * Node majors, but it links the build host's glibc. There is no musl, arm64 or non-Linux artifact, and
 * `loadNativeMechanism` refuses those hosts by name rather than loading a binary that cannot work.
 *
 * `foregroundProcessGroup()` is corroboration only. Pi's own external editor inherits Pi's process group, so
 * an unchanged foreground group proves nothing about whether a child owns the terminal; child detection is a
 * separate seam.
 */

import { closeSync, readFileSync, statSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { isatty } from "node:tty";

import { identityFromProcStat } from "./process-identity-linux.mjs";

const require = createRequire(import.meta.url);

/** The one artifact this mechanism loads. Built and committed by vendor/pty/build.mjs. */
const NATIVE_ARTIFACT = "../vendor/pty/pi-agents-owner-pty-linux-x64-gnu.node";
/** Linux hands UNIX98 pseudo-terminals a dynamic major in this range; anything else is not a `pts/` device. */
const DEVPTS_MAJORS = { first: 136, last: 143 };
/** Names for the numbers a raw wait status carries. Reversed, so the earliest name wins: SIGABRT, not SIGIOT. */
const SIGNAL_NAMES = new Map(
  Object.entries(constants.signals).reverse().map(([name, number]) => /** @type {[number, string]} */ ([number, name])),
);

/** A refused input, an unusable host, or an owner that is not what the mechanism requires. Never a warning. */
export class PtyMechanismError extends Error {
  /** @param {string} message @param {{ code?: string, cause?: unknown, bytesWritten?: number, totalBytes?: number }} [options] */
  constructor(message, { code = "PTY_MECHANISM", cause, bytesWritten, totalBytes } = {}) {
    super(message, { cause });
    this.name = "PtyMechanismError";
    this.code = code;
    /**
     * How many bytes of the refused write the terminal had already accepted, and how many were offered.
     *
     * Numbers, not prose: a caller that must queue the rest needs the exact suffix boundary, and parsing it
     * back out of a message is how bytes get duplicated or dropped. `null` on every failure that is not a
     * write.
     *
     * @type {number | null}
     */
    this.bytesWritten = bytesWritten ?? null;
    /** @type {number | null} */
    this.totalBytes = totalBytes ?? null;
  }
}

/**
 * Load the native mechanism, refusing a host it was not built for before `require` can fail obscurely.
 *
 * `glibcVersionRuntime` is absent on a musl host, which is the only cheap way to tell the two apart from
 * inside Node.
 */
export function loadNativeMechanism() {
  const report = /** @type {any} */ (process.report?.getReport() ?? {});
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new PtyMechanismError(
      `The owner pseudo-terminal artifact is built for linux-x64 only, not ${process.platform}-${process.arch}`,
      { code: "PTY_UNSUPPORTED_HOST" },
    );
  }
  if (typeof report.header?.glibcVersionRuntime !== "string") {
    throw new PtyMechanismError("The owner pseudo-terminal artifact links glibc, and this host reports none", {
      code: "PTY_UNSUPPORTED_LIBC",
    });
  }
  try {
    return require(NATIVE_ARTIFACT);
  } catch (cause) {
    throw new PtyMechanismError(`The owner pseudo-terminal artifact ${NATIVE_ARTIFACT} did not load`, {
      code: "PTY_ARTIFACT_UNAVAILABLE",
      cause,
    });
  }
}

/**
 * Decode one raw `wait(2)` status into the three separate facts it carries.
 *
 * A normal exit, a terminating signal and a core dump cannot be derived from each other, and an exit code of
 * `-1` stands in for all of them. This is `WIFEXITED`/`WEXITSTATUS`/`WTERMSIG`/`WCOREDUMP`, nothing more.
 *
 * @param {number} status
 */
export function decodeWaitStatus(status) {
  if (!Number.isSafeInteger(status) || status < 0 || status > 0xffff) {
    throw new PtyMechanismError(`A raw wait status must be a 16-bit unsigned integer, received ${status}`, {
      code: "PTY_INVALID_WAIT_STATUS",
    });
  }
  const terminatingSignal = status & 0x7f;
  if (terminatingSignal === 0) {
    return { status, code: (status >> 8) & 0xff, signal: null, coreDumped: false };
  }
  if (terminatingSignal === 0x7f) {
    throw new PtyMechanismError(`Wait status ${status} says stopped, and this mechanism never waits for stops`, {
      code: "PTY_INVALID_WAIT_STATUS",
    });
  }
  const signal = SIGNAL_NAMES.get(terminatingSignal);
  if (signal === undefined) {
    throw new PtyMechanismError(`Wait status ${status} names signal ${terminatingSignal}, which this host has no name for`, {
      code: "PTY_INVALID_WAIT_STATUS",
    });
  }
  return { status, code: null, signal, coreDumped: (status & 0x80) !== 0 };
}

/**
 * The two terminal fields the shared identity parser deliberately does not expose.
 *
 * Identity itself still comes from `identityFromProcStat`, so there is exactly one spelling of "which process
 * is this"; these are the session and the controlling terminal's foreground group, which that parser has no
 * caller for. It takes the record rather than a PID, because the record a caller may trust is the one taken
 * at a moment it can defend, not whatever `/proc/<pid>` holds now.
 *
 * @param {string} stat @param {number} pid
 */
function terminalFieldsFromProcStat(stat, pid) {
  const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/u);
  const [sessionId, terminalDevice, foregroundProcessGroup] = [Number(fields[3]), Number(fields[4]), Number(fields[5])];
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !Number.isSafeInteger(terminalDevice) || !Number.isSafeInteger(foregroundProcessGroup)) {
    throw new PtyMechanismError(`Linux proc stat for ${pid} carries no usable session or terminal fields`, {
      code: "PTY_AMBIGUOUS_TERMINAL",
    });
  }
  return { state: fields[0], sessionId, terminalMajor: (terminalDevice >> 8) & 0xfff, foregroundProcessGroup };
}

/** @param {string} name @param {number} value */
function requireTerminalDimension(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff) {
    throw new PtyMechanismError(`${name} must be a positive 16-bit integer, received ${value}`, { code: "PTY_INVALID_REQUEST" });
  }
}

/**
 * Open one owner pseudo-terminal and return the handle the host keeps for that owner's whole life.
 *
 * The owner is required to be a session leader on a `pts/` device before the handle is returned: a mechanism
 * that silently produced a child sharing this process's terminal would be discovered much later, by a
 * keystroke reaching the wrong process. Every one of those facts is read from the artifact's birth snapshot of
 * `/proc/<pid>/stat`, so the answer describes the child that was spawned even if the native thread has
 * already reaped it and Linux has already given that PID to something else.
 *
 * `readProcStat` and `writeToFd` are the two syscall seams, injected by tests that have to make a PID reuse,
 * a reaper ordering or a partial write happen at an exact moment instead of waiting for the kernel to produce
 * one.
 *
 * @param {{ command: string, args?: string[], env?: Record<string, string>, cwd?: string, cols?: number, rows?: number, native?: any, readProcStat?: (pid: number) => string, writeToFd?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number }} options
 */
export async function openOwnerPty({
  command,
  args = [],
  env = {},
  cwd,
  cols = 80,
  rows = 24,
  native = loadNativeMechanism(),
  readProcStat = (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
  writeToFd = writeSync,
}) {
  if (typeof command !== "string" || command === "") throw new PtyMechanismError("An owner command must be a non-empty string", { code: "PTY_INVALID_REQUEST" });
  requireTerminalDimension("cols", cols);
  requireTerminalDimension("rows", rows);

  /** @type {(status: number) => void} */
  let reaped;
  /** @type {(error: unknown) => void} */
  let reapFailed;
  const rawStatus = new Promise((resolve, reject) => {
    reaped = resolve;
    reapFailed = reject;
  });
  const exit = rawStatus.then((status) => decodeWaitStatus(/** @type {number} */ (status)));
  // One promise, created once: `wait()` returns it every time, so two callers cannot see two answers. The
  // no-op handler exists because a reap failure nobody ever asked about must not take the process down.
  exit.catch(() => {});

  const pty = new native.Pty({
    command,
    args,
    envs: env,
    dir: cwd,
    size: { cols, rows },
    onExit: (/** @type {Error | null} */ error, /** @type {number} */ status) => {
      if (error) reapFailed(new PtyMechanismError(`Waiting for the owner failed: ${error.message}`, { code: "PTY_REAP_FAILED", cause: error }));
      else reaped(status);
    },
  });
  const masterFd = pty.takeControllerFd();
  // The child holds its own descriptors for the slave. Keeping this process's copy would mean the master
  // never reports end of output, so a detached owner's exit would look like an idle terminal forever.
  pty.dropUserFd();

  let closed = false;
  const refuseWhenClosed = () => {
    if (closed) throw new PtyMechanismError("This owner pseudo-terminal is closed", { code: "PTY_CLOSED" });
  };

  /** @type {{ pid: number, startIdentity: string, processGroupId: number }} */
  let identity;
  /** @type {{ state: string, sessionId: number, terminalMajor: number, foregroundProcessGroup: number }} */
  let terminal;
  try {
    // One record, read by the artifact before anything could have reaped this child, so its PID was still
    // this child's: identity and terminal facts both come from it rather than from two later reads that a
    // reaped PID could have answered on another process's behalf.
    const birth = pty.birthProcStat();
    if (typeof birth !== "string" || birth === "") {
      throw new PtyMechanismError(`The artifact recorded no birth proc snapshot for owner ${pty.pid}`, { code: "PTY_OWNER_UNIDENTIFIED" });
    }
    identity = identityFromProcStat(birth);
    if (identity.pid !== pty.pid) {
      throw new PtyMechanismError(`The birth proc snapshot names ${identity.pid}, and the artifact spawned ${pty.pid}`, { code: "PTY_OWNER_UNIDENTIFIED" });
    }
    terminal = terminalFieldsFromProcStat(birth, identity.pid);
  } catch (cause) {
    closeSync(masterFd);
    closed = true;
    const status = pty.rawWaitStatus();
    throw new PtyMechanismError(
      status === null
        ? `The owner ${pty.pid} could not be identified`
        : `The owner ${pty.pid} exited before it could be identified, with raw wait status ${status}`,
      { code: "PTY_OWNER_UNIDENTIFIED", cause },
    );
  }
  // A zombie has already released its controlling terminal, so an owner that exited between the spawn and
  // the snapshot reports terminal 0 while its session and group are still its own. Requiring a pts of that
  // corpse would refuse a handle whose only remaining job is to report how the owner died.
  const exited = terminal.state === "Z" || pty.rawWaitStatus() !== null;
  const onPseudoTerminal = terminal.terminalMajor >= DEVPTS_MAJORS.first && terminal.terminalMajor <= DEVPTS_MAJORS.last;
  if (!isatty(masterFd) || identity.processGroupId !== identity.pid || terminal.sessionId !== identity.pid || !(onPseudoTerminal || exited)) {
    closeSync(masterFd);
    closed = true;
    throw new PtyMechanismError(
      `The owner ${identity.pid} is not a session leader on a pts device: session ${terminal.sessionId}, group ${identity.processGroupId}, terminal major ${terminal.terminalMajor}, state ${terminal.state}`,
      { code: "PTY_OWNER_NOT_SESSION_LEADER" },
    );
  }

  return {
    masterFd,
    owner: { pid: identity.pid, startIdentity: identity.startIdentity, sessionId: terminal.sessionId, processGroupId: identity.processGroupId },
    // An in-process addon, so there is no third process between the host and its owner to identify.
    helper: null,

    /**
     * The foreground process group of the owner's controlling terminal. Corroboration only.
     *
     * Refused rather than answered once this owner is gone: the PID alone is not the owner, and after the
     * native thread reaps it Linux may hand that number to any process, whose foreground group would
     * otherwise be reported as this owner's.
     */
    foregroundProcessGroup() {
      refuseWhenClosed();
      const status = pty.rawWaitStatus();
      if (status !== null) {
        throw new PtyMechanismError(`The owner ${identity.pid} exited with raw wait status ${status} and has no terminal`, { code: "PTY_OWNER_EXITED" });
      }
      let stat;
      try {
        stat = readProcStat(identity.pid);
      } catch (cause) {
        throw new PtyMechanismError(`The owner ${identity.pid} has no proc record left to read a foreground group from`, { code: "PTY_OWNER_EXITED", cause });
      }
      const current = identityFromProcStat(stat);
      if (current.pid !== identity.pid || current.startIdentity !== identity.startIdentity) {
        throw new PtyMechanismError(
          `PID ${identity.pid} now belongs to a process started at ${current.startIdentity}, not to the owner started at ${identity.startIdentity}`,
          { code: "PTY_OWNER_IDENTITY_CHANGED" },
        );
      }
      return terminalFieldsFromProcStat(stat, identity.pid).foregroundProcessGroup;
    },

    /**
     * Write bytes to the terminal exactly as given: no encoding, no translation, no host-side queue.
     *
     * Returns nothing on success, because success means every byte was accepted. The descriptor is
     * non-blocking, so a terminal whose input buffer is full refuses with `bytesWritten` and `totalBytes` on
     * the error: those two numbers are the suffix boundary the caller must queue, and they are data rather
     * than prose precisely so nobody reads them back out of a message. Queueing input is the ingress seam's
     * job, and a second buffer here would be a second writer.
     *
     * @param {Uint8Array} bytes
     */
    write(bytes) {
      refuseWhenClosed();
      if (!(bytes instanceof Uint8Array)) throw new PtyMechanismError("Terminal input must be a Uint8Array", { code: "PTY_INVALID_REQUEST" });
      let written = 0;
      while (written < bytes.byteLength) {
        let accepted;
        try {
          accepted = writeToFd(masterFd, bytes, written, bytes.byteLength - written);
        } catch (error) {
          const code = /** @type {NodeJS.ErrnoException} */ (error).code;
          if (code === "EINTR") continue;
          if (code === "EAGAIN") {
            throw new PtyMechanismError(`The terminal accepted ${written} of ${bytes.byteLength} bytes and its input buffer is full`, { code: "PTY_INPUT_BACKPRESSURE", cause: error, bytesWritten: written, totalBytes: bytes.byteLength });
          }
          throw new PtyMechanismError(`Writing ${bytes.byteLength} bytes to the terminal failed after ${written}`, { code: "PTY_WRITE_FAILED", cause: error, bytesWritten: written, totalBytes: bytes.byteLength });
        }
        // A write that accepts nothing and reports no error would spin here forever. It is the same fact
        // backpressure carries — this much was taken, the rest was not — so it is reported the same way.
        if (accepted <= 0) {
          throw new PtyMechanismError(`The terminal accepted ${written} of ${bytes.byteLength} bytes and then accepted none`, { code: "PTY_WRITE_NO_PROGRESS", bytesWritten: written, totalBytes: bytes.byteLength });
        }
        written += accepted;
      }
    },

    /** Resize the terminal. One `TIOCSWINSZ` on the master, so the owner and every child share one size.
     * @param {number} nextCols @param {number} nextRows */
    resize(nextCols, nextRows) {
      refuseWhenClosed();
      requireTerminalDimension("cols", nextCols);
      requireTerminalDimension("rows", nextRows);
      native.ptyResize(masterFd, { cols: nextCols, rows: nextRows });
    },

    /**
     * The owner's raw wait status if a reap has already been published for it, and `null` while none has.
     *
     * Non-blocking and signal-free. It is a cache the artifact's waiting thread fills just after `wait(2)`
     * returns, so `null` is not proof the owner is alive; only the published status is proof it is not. It
     * must be asked before any signal: once a signal is sent, an exit that had already happened for another
     * reason can no longer be distinguished from the one it caused. Identity is still revalidated before a
     * signal, because this answer cannot rule out a reap that has happened but not yet been published.
     */
    reapIfExited() {
      const status = pty.rawWaitStatus();
      return status === null ? null : { status };
    },

    /** The owner's decoded exit. The same answer every time it is asked, because it is one stored fact. */
    wait() {
      return exit;
    },

    /**
     * Release this process's descriptor for the terminal. It signals nothing.
     *
     * The kernel hangs up a session whose last master is closed, so closing before the owner exits does end
     * the owner — by hangup, not by a signal this mechanism chose to send.
     */
    async close() {
      if (closed) return;
      closed = true;
      closeSync(masterFd);
    },
  };
}

/** The committed artifact's path, for the package and permission checks that assert what ships. */
export function nativeArtifactPath() {
  const path = require.resolve(NATIVE_ARTIFACT);
  statSync(path);
  return path;
}
