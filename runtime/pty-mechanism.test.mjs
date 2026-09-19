import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync, readlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadStream, isatty } from "node:tty";

import { afterEach, expect, it } from "vitest";

import { PtyMechanismError, decodeWaitStatus, loadNativeMechanism, nativeArtifactPath, openOwnerPty } from "./pty-mechanism.mjs";
import { parseProcStat } from "./process-identity-linux.mjs";
import { signalProcessGroup } from "./process-signaler.mjs";
import { openProcessLedger, reapProcessLedger, recordProcess, reportReapResults } from "../test/process-ledger.mjs";

const LEDGER_LABEL = "pty-mechanism";
const NEWLINE = new Uint8Array([0x0a]);
/** Nothing here runs Pi. A shell reading one line is enough to be a real session leader on a real pts. */
const OWNER_ENV = { PATH: "/usr/bin:/bin", TERM: "xterm-256color" };
/** The post-command fields of `/proc/<pid>/stat` these tests rewrite, by index. */
const PROC_FIELD = { state: 0, ttyNumber: 4, startTicks: 19 };
/** @type {string | undefined} */
let ledgerPath;

// The ledger, not a list in memory: every owner below is a real process, and a test that times out never
// reaches its own teardown. This is the same durable record the cross-cutting suites use; the harness that
// wraps it is not imported here, because it reaches the daemon CLI and this file is strictly typechecked.
afterEach(async () => {
  if (ledgerPath === undefined) return;
  reportReapResults(await reapProcessLedger(ledgerPath), console.error);
  await rm(ledgerPath, { force: true });
  ledgerPath = undefined;
});

/** @param {string} script @param {{ cols?: number, rows?: number, native?: any, readProcStat?: (pid: number) => string, writeToFd?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number }} [options] */
async function openOwner(script, options = {}) {
  const handle = await openOwnerPty({ command: "/bin/sh", args: ["-c", script], env: OWNER_ENV, cwd: tmpdir(), ...options });
  // Recorded before anything is asserted: a test that times out never reaches its own teardown.
  ledgerPath ??= await openProcessLedger({ label: LEDGER_LABEL });
  await recordProcess(ledgerPath, `${LEDGER_LABEL} owner shell`, handle.owner);
  return handle;
}

/**
 * The real artifact with one of its two birth/reap answers replaced.
 *
 * A native thread that has already reaped, and a PID Linux has already handed to another process, cannot be
 * scheduled by a test, and waiting for real PID reuse would make these cases both slow and flaky. The owner
 * stays a real process on a real pts; only the moment the artifact claims to have reaped it, or the record it
 * claims to have read at its birth, is the test's.
 *
 * @param {{ birthProcStat?: (real: any) => string | null, rawWaitStatus?: (real: any) => number | null }} answers
 */
function artifactAnswering(answers) {
  const real = loadNativeMechanism();
  return {
    ptyResize: real.ptyResize,
    Pty: class {
      /** @param {any} options */
      constructor(options) {
        this.inner = new real.Pty(options);
        this.pid = /** @type {number} */ (this.inner.pid);
      }
      takeControllerFd() {
        return this.inner.takeControllerFd();
      }
      dropUserFd() {
        return this.inner.dropUserFd();
      }
      birthProcStat() {
        return answers.birthProcStat ? answers.birthProcStat(this.inner) : this.inner.birthProcStat();
      }
      rawWaitStatus() {
        return answers.rawWaitStatus ? answers.rawWaitStatus(this.inner) : this.inner.rawWaitStatus();
      }
    },
  };
}

/** One proc stat record with some of its post-command fields replaced: the same PID, another process or state.
 * @param {string} stat @param {Record<number, string>} replacements */
function withProcFields(stat, replacements) {
  const command = stat.slice(0, stat.lastIndexOf(") ") + 2);
  const fields = stat.slice(command.length).trim().split(/\s+/u);
  for (const [index, value] of Object.entries(replacements)) fields[Number(index)] = value;
  return `${command}${fields.join(" ")}\n`;
}

/** A writer driven by one step per call: each step either accepts a byte count or throws one errno.
 * @param {(number | NodeJS.ErrnoException)[]} steps */
function scriptedWriter(steps) {
  /** @type {number[]} */
  const accepted = [];
  /** @type {(fd: number, bytes: Uint8Array, offset: number, length: number) => number} */
  const writeToFd = (fd, bytes, offset, length) => {
    const step = steps.shift();
    if (step === undefined) throw new Error("the terminal writer was called more times than the test scripted");
    if (typeof step !== "number") throw step;
    const taken = Math.min(step, length);
    accepted.push(...bytes.subarray(offset, offset + taken));
    return taken;
  };
  return { accepted, writeToFd };
}

/** @param {string} code */
function errnoFailure(code) {
  return Object.assign(new Error(code), { code });
}

/** The refusal one call answers with, so a test can assert its data instead of its prose.
 * @param {() => unknown} call */
function refusalOf(call) {
  try {
    call();
  } catch (error) {
    if (error instanceof PtyMechanismError) return error;
    throw error;
  }
  throw new Error("the call was expected to refuse and did not");
}

/**
 * Read the terminal the way a host does: one stream over the master descriptor.
 *
 * The stream owns the descriptor from here on, because Node closes a socket's descriptor when the socket is
 * destroyed, so a test that reads does not also call `close()`.
 *
 * @param {{ masterFd: number }} handle
 */
function readTerminal(handle) {
  const stream = new ReadStream(handle.masterFd);
  /** @type {Buffer[]} */
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const collected = () => Buffer.concat(chunks);
  const ended = new Promise((resolve, reject) => {
    stream.once("end", () => resolve(undefined));
    // A master whose slave has no open descriptor left reports EIO. That is this platform's end of output,
    // and seeing it at all is what proves the mechanism dropped its own copy of the slave.
    stream.once("error", (error) => (/** @type {NodeJS.ErrnoException} */ (error).code === "EIO" ? resolve(undefined) : reject(error)));
  });
  return {
    ended,
    collected,
    /** @param {string} text */
    waitFor(text) {
      const target = Buffer.from(text, "latin1");
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!collected().includes(target)) return;
          stream.off("data", check);
          resolve(undefined);
        };
        stream.on("data", check);
        ended.then(check).then(() => reject(new Error(`the terminal ended before ${JSON.stringify(text)} arrived`)), reject);
        check();
      });
    },
  };
}

it("gives the owner a pts terminal it leads by itself, with no helper process between them", async () => {
  const handle = await openOwner("read line; exit 0");

  expect(isatty(handle.masterFd)).toBe(true);
  expect(handle.owner.sessionId).toBe(handle.owner.pid);
  expect(handle.owner.processGroupId).toBe(handle.owner.pid);
  expect(handle.owner.startIdentity).toMatch(/^\d+$/u);
  expect(handle.helper).toBe(null);
  expect(readlinkSync(`/proc/${handle.owner.pid}/fd/0`)).toMatch(/^\/dev\/pts\/\d+$/u);
  expect(handle.foregroundProcessGroup()).toBe(handle.owner.pid);

  handle.write(NEWLINE);
  expect(await handle.wait()).toEqual({ status: 0, code: 0, signal: null, coreDumped: false });
  await handle.close();
});

it("resizes to one size the owner and a child of the owner both read", async () => {
  const handle = await openOwner("read line; stty size; sh -c 'stty size'", { cols: 80, rows: 24 });
  const terminal = readTerminal(handle);

  handle.resize(100, 40);
  handle.write(NEWLINE);
  await handle.wait();
  await terminal.ended;

  expect(terminal.collected().toString("latin1").match(/40 100/gu)).toEqual(["40 100", "40 100"]);
});

it("writes bytes to the terminal exactly as given", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agents-pty-bytes-"));
  try {
    const received = join(directory, "received");
    // Raw mode, so the terminal translates nothing: this measures the mechanism, not termios defaults.
    const handle = await openOwner(`stty raw -echo; printf R; head -c 6 > ${received}`);
    const terminal = readTerminal(handle);
    await terminal.waitFor("R");

    const sent = new Uint8Array([0x03, 0x0d, 0x0a, 0x1b, 0xff, 0x00]);
    handle.write(sent);
    await handle.wait();

    expect(new Uint8Array(await readFile(received))).toEqual(sent);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("carries the owner's bytes and nothing else, including the sequence the upstream mechanism injected", async () => {
  // The upstream artifact wrote this exact OSC into the terminal when a child exited. A child is allowed to
  // emit it, the host must see it once, and nothing may be appended after it.
  const handle = await openOwner("stty -echo; printf R; read line; printf '\\033]7878\\033\\\\'");
  const terminal = readTerminal(handle);
  await terminal.waitFor("R");

  handle.write(NEWLINE);
  await handle.wait();
  await terminal.ended;

  expect(terminal.collected()).toEqual(Buffer.from("R\u001b]7878\u001b\\", "latin1"));
});

it("observes an exited owner without signalling it, and answers with the same status every time", async () => {
  const handle = await openOwner("read line; exit 7");

  expect(handle.reapIfExited()).toBe(null);
  handle.write(NEWLINE);
  const first = await handle.wait();

  expect(first).toEqual({ status: 1792, code: 7, signal: null, coreDumped: false });
  expect(handle.reapIfExited()).toEqual({ status: 1792 });
  expect(await handle.wait()).toBe(first);

  await handle.close();
  await handle.close();
  expect(() => handle.write(NEWLINE)).toThrowError(PtyMechanismError);
});

it("reports the signal that terminated an owner, rather than an exit code that erases it", async () => {
  const handle = await openOwner("read line");

  signalProcessGroup(handle.owner.processGroupId, "SIGTERM");

  expect(await handle.wait()).toEqual({ status: 15, code: null, signal: "SIGTERM", coreDumped: false });
  await handle.close();
});

it("decodes a raw wait status into the three separate facts it carries", () => {
  expect(decodeWaitStatus(0)).toEqual({ status: 0, code: 0, signal: null, coreDumped: false });
  expect(decodeWaitStatus(1792)).toEqual({ status: 1792, code: 7, signal: null, coreDumped: false });
  expect(decodeWaitStatus(9)).toEqual({ status: 9, code: null, signal: "SIGKILL", coreDumped: false });
  expect(decodeWaitStatus(0x80 | 6)).toEqual({ status: 134, code: null, signal: "SIGABRT", coreDumped: true });
  expect(() => decodeWaitStatus(0x7f)).toThrowError(PtyMechanismError);
  expect(() => decodeWaitStatus(-1)).toThrowError(PtyMechanismError);
});

it("loads one committed artifact that matches its build manifest and that no one else may write", () => {
  const artifact = nativeArtifactPath();
  const manifest = JSON.parse(readFileSync(new URL("../vendor/pty/build-manifest.json", import.meta.url), "utf8"));
  const statistics = statSync(artifact);

  expect(createHash("sha256").update(readFileSync(artifact)).digest("hex")).toBe(manifest.sha256);
  expect(statistics.size).toBe(manifest.byteLength);
  // Git records only the executable bit, so the group bit is whatever the checkout's umask left; a
  // world-writable native artifact is the one mode that would let anyone replace what this host loads.
  expect(statistics.mode & 0o002).toBe(0);
});

it("takes the owner's identity from the record the artifact read at its birth, not from a later read of that PID", async () => {
  // The artifact reads /proc once, after the spawn and before its waiting thread starts, so nothing can have
  // reaped the child and handed its PID on. A distinguishable start time in that record is how this test sees
  // which read the handle answered from.
  const bornAt = "424242";
  const handle = await openOwner("read line", {
    native: artifactAnswering({
      birthProcStat: (real) => withProcFields(readFileSync(`/proc/${real.pid}/stat`, "utf8"), { [PROC_FIELD.startTicks]: bornAt }),
    }),
  });

  expect(handle.owner.startIdentity).toBe(bornAt);
  expect(parseProcStat(readFileSync(`/proc/${handle.owner.pid}/stat`, "utf8")).startTimeTicks).not.toBe(bornAt);
  expect(handle.owner.sessionId).toBe(handle.owner.pid);
  expect(handle.owner.processGroupId).toBe(handle.owner.pid);

  handle.write(NEWLINE);
  await handle.wait();
  await handle.close();
});

it("keeps a handle for an owner the waiting thread already reaped, and refuses to read a terminal by that PID", async () => {
  // The reaped owner's /proc entry is gone, which is exactly when a fresh read by PID could answer about
  // whatever holds that number next. Both the reap and the vanished record are injected, because real PID
  // reuse cannot be scheduled.
  const handle = await openOwner("read line", {
    native: artifactAnswering({
      birthProcStat: (real) => withProcFields(readFileSync(`/proc/${real.pid}/stat`, "utf8"), { [PROC_FIELD.state]: "Z", [PROC_FIELD.ttyNumber]: "0" }),
      rawWaitStatus: () => 1792,
    }),
    readProcStat: () => {
      throw errnoFailure("ENOENT");
    },
  });

  expect(handle.owner.sessionId).toBe(handle.owner.pid);
  expect(handle.owner.startIdentity).toMatch(/^\d+$/u);
  expect(handle.reapIfExited()).toEqual({ status: 1792 });
  expect(refusalOf(() => handle.foregroundProcessGroup()).code).toBe("PTY_OWNER_EXITED");

  handle.write(NEWLINE);
  await handle.wait();
  await handle.close();
});

it("refuses a foreground-group read once its PID names a process that started at another time", async () => {
  const handle = await openOwner("read line", {
    readProcStat: (pid) => withProcFields(readFileSync(`/proc/${pid}/stat`, "utf8"), { [PROC_FIELD.startTicks]: "1" }),
  });

  const refusal = refusalOf(() => handle.foregroundProcessGroup());
  expect(refusal.code).toBe("PTY_OWNER_IDENTITY_CHANGED");
  expect(refusal.message).toContain(String(handle.owner.pid));

  handle.write(NEWLINE);
  await handle.wait();
  await handle.close();
});

it("refuses a write with the byte boundary it reached, and then accepts the suffix alone", async () => {
  const steps = /** @type {(number | NodeJS.ErrnoException)[]} */ ([3, errnoFailure("EAGAIN")]);
  const writer = scriptedWriter(steps);
  const handle = await openOwner("read line", { writeToFd: writer.writeToFd });
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);

  const refusal = refusalOf(() => handle.write(bytes));
  expect(refusal.code).toBe("PTY_INPUT_BACKPRESSURE");
  expect(refusal.bytesWritten).toBe(3);
  expect(refusal.totalBytes).toBe(6);
  expect(writer.accepted).toEqual([1, 2, 3]);

  // The numbers, not the message: a caller queues exactly the suffix the terminal did not take, and the
  // accepted prefix is never offered twice.
  steps.push(3);
  handle.write(bytes.subarray(refusal.bytesWritten ?? 0));
  expect(writer.accepted).toEqual([1, 2, 3, 4, 5, 6]);

  await handle.close();
  await handle.wait();
});

it("retries an interrupted write at the same offset, without repeating or dropping a byte", async () => {
  const writer = scriptedWriter([errnoFailure("EINTR"), 2, errnoFailure("EINTR"), 4]);
  const handle = await openOwner("read line", { writeToFd: writer.writeToFd });

  handle.write(new Uint8Array([1, 2, 3, 4, 5, 6]));

  expect(writer.accepted).toEqual([1, 2, 3, 4, 5, 6]);

  await handle.close();
  await handle.wait();
});

it("refuses a write that stops making progress instead of spinning on a terminal that accepts nothing", async () => {
  const writer = scriptedWriter([2, 0]);
  const handle = await openOwner("read line", { writeToFd: writer.writeToFd });

  const refusal = refusalOf(() => handle.write(new Uint8Array([1, 2, 3, 4, 5, 6])));

  expect(refusal.code).toBe("PTY_WRITE_NO_PROGRESS");
  expect(refusal.bytesWritten).toBe(2);
  expect(refusal.totalBytes).toBe(6);
  expect(writer.accepted).toEqual([1, 2]);

  await handle.close();
  await handle.wait();
});
