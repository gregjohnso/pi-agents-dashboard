import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync, readlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadStream, isatty } from "node:tty";

import { afterEach, expect, it } from "vitest";

import { PtyMechanismError, decodeWaitStatus, nativeArtifactPath, openOwnerPty } from "./pty-mechanism.mjs";
import { signalProcessGroup } from "./process-signaler.mjs";
import { openProcessLedger, reapProcessLedger, recordProcess, reportReapResults } from "../test/process-ledger.mjs";

const LEDGER_LABEL = "pty-mechanism";
const NEWLINE = new Uint8Array([0x0a]);
/** Nothing here runs Pi. A shell reading one line is enough to be a real session leader on a real pts. */
const OWNER_ENV = { PATH: "/usr/bin:/bin", TERM: "xterm-256color" };
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

/** @param {string} script @param {{ cols?: number, rows?: number }} [size] */
async function openOwner(script, size = {}) {
  const handle = await openOwnerPty({ command: "/bin/sh", args: ["-c", script], env: OWNER_ENV, cwd: tmpdir(), ...size });
  // Recorded before anything is asserted: a test that times out never reaches its own teardown.
  ledgerPath ??= await openProcessLedger({ label: LEDGER_LABEL });
  await recordProcess(ledgerPath, `${LEDGER_LABEL} owner shell`, handle.owner);
  return handle;
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
