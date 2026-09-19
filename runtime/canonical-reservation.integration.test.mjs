/**
 * Integration cases for the canonical reservation backend: real files, real processes, real refusals.
 *
 * Nothing is injected here. The verifier is `createLocalHostProof` over this machine's own
 * `/etc/machine-id` and `/proc/sys/kernel/random/boot_id` and the real `/proc` process table, so "live"
 * means a process that is running on this box and "absent" means one this kernel no longer has. The
 * claimant is a real disposable child process, recorded in the test process ledger the instant its
 * identity can be read, and the storage failures are real kernel errors — an `O_NOFOLLOW` symlink and a
 * directory this user cannot write — rather than a fake store that throws.
 *
 * The last block drives the **installed** Pi cohort through seam D's real hook, with this module as the
 * host's canonical trio. Point `PI_SEAM_D_CONSUMER` at a consumer whose `node_modules` holds the patched
 * cohort; without it that block skips and the rest still runs, because these cases are authored green.
 *
 * Two things are deliberately not claimed. `fsync` itself is not observable from a test, so durability is
 * shown here as visibility to a second process reading the journal; the fsync and partial-record contract
 * belongs to `runtime/append-store.test.mjs`. And `ENOSPC` is not exercised: filling a filesystem needs
 * privileges this suite does not have, so the storage failures here are `ELOOP` and `EACCES`.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { canonicalReservationPaths, createLocalHostProof, openCanonicalReservations, readLocalHostIdentity } from "./canonical-reservation.mjs";
import { inspectProcessIdentity } from "./process-identity-linux.mjs";

const CHILD_EXIT_TIMEOUT_MS = 10_000;
const CONSUMER = process.env.PI_SEAM_D_CONSUMER;

/**
 * The two shared harnesses this file uses, loaded by URL rather than by a literal specifier.
 *
 * `tsconfig.json` checks `runtime/` in strict mode and does not cover `test/`. A literal import here would
 * pull the installed-cohort fixture and the process harness — and every daemon module the harness itself
 * imports — into that strict program, which would report errors in five files this lane does not own.
 * @param {string} name
 */
const loadTestHelper = (name) => import(new URL(`../test/${name}`, import.meta.url).href);

/** The two fields an `OwnerRunIdentity` carries about a host; the source this machine read them from is not one. */
const recordedHost = () => ({ hostId: hostIdentity.hostId, bootId: hostIdentity.bootId });

/** @type {any} */
let harness;
/** @type {any} */
let fixture;
/** @type {{close(): Promise<void>}[]} */
const opened = [];
/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
/** @type {{ dispose(): void }[]} */
const runtimes = [];
/** @type {{hostId:string,bootId:string,hostIdSource:string}} */
let hostIdentity;
/** @type {any} */
let pi;

beforeAll(async () => {
  harness = (await loadTestHelper("real-process-harness.mjs")).createRealProcessHarness("canonical reservations");
  fixture = await loadTestHelper("fixtures/native-canonical/installed-runtime.mjs");
  hostIdentity = await readLocalHostIdentity();
  expect(hostIdentity.hostId.length).toBeGreaterThan(0);
  console.log(`canonical reservations ran as ${hostIdentity.hostId} on boot ${hostIdentity.bootId}, host id from ${hostIdentity.hostIdSource}`);
  if (CONSUMER) {
    console.log(`canonical reservations resolved the installed cohort from ${fixture.resolveInstalled(fixture.COHORT_ROOT, "@earendil-works/pi-coding-agent")}`);
    pi = await fixture.importInstalled("@earendil-works/pi-coding-agent");
  }
});

afterEach(async () => {
  if (pi?.setNativeSubmissionHost) pi.setNativeSubmissionHost(undefined);
  while (runtimes.length > 0) runtimes.pop()?.dispose();
  // Each child is killed *and* waited for. An unreaped child is a zombie whose `/proc` record the ledger's
  // own identity check cannot read, which it reports as a process it could not stop.
  for (const child of children.splice(0)) await stopChild(child);
  // Closed before the harness removes the directories: a descriptor still open on a deleted journal makes a
  // network filesystem keep a hidden entry, and the directory removal then fails with ENOTEMPTY.
  for (const reservations of opened.splice(0)) await reservations.close().catch(() => {});
  await harness.cleanup();
});

/** Kill one child and wait for the kernel to reap it, bounded. @param {import("node:child_process").ChildProcess} child */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit", { signal: AbortSignal.timeout(CHILD_EXIT_TIMEOUT_MS) }).catch(() => {});
}

/** One real Pi session directory, and the two independent state roots that share it. */
async function realSessionDirectory() {
  const root = await harness.stateRoot("canonical-reservations-", ["pi/sessions", "state-a", "state-b"]);
  const session = join(root, "pi", "sessions");
  const paths = canonicalReservationPaths(session);
  await mkdir(paths.lockPath, { recursive: true, mode: 0o700 });
  return { root, session, ...paths };
}

/**
 * A real, disposable process to stand in for a canonical owner, recorded before it can be leaked.
 *
 * It is its own process group so the ledger can reap it by verified identity, and it does nothing but
 * hold a timer open: the point is a PID and a start identity this machine's `/proc` really reports.
 */
async function realOwnerProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { detached: true, stdio: "ignore" });
  children.push(child);
  const identity = await inspectProcessIdentity(/** @type {number} */ (child.pid));
  await harness.record("canonical owner stand-in", identity);
  return {
    child,
    identity,
    /** @param {string} initialRowId */
    ownerRun(initialRowId) {
      return { initialRowId, runId: `run-${identity.pid}`, ownerPid: identity.pid, ownerStartIdentity: identity.startIdentity, ...recordedHost() };
    },
    /** Kill it and wait for the kernel to reap it, so the next read is a real absence. */
    stop: () => stopChild(child),
  };
}

/** @param {{journalPath:string,lockPath:string}} domain @param {any} owner @param {number} generation */
async function openFor(domain, owner, generation) {
  let current = generation;
  const reservations = await openCanonicalReservations({
    journalPath: domain.journalPath,
    lockPath: domain.lockPath,
    owner,
    currentGeneration: () => current,
    hostProof: createLocalHostProof({ hostIdentity }),
  });
  opened.push(reservations);
  return {
    reservations,
    /** @param {number} next */
    setGeneration(next) {
      current = next;
    },
  };
}

/** @param {{operationId?:string, operation?:string, generation:number, target:string}} fields */
function operationOn({ operationId = `operation-${Math.random().toString(36).slice(2)}`, operation = "resume", generation, target }) {
  return { operationId, operation, currentBinding: { canonicalFile: undefined, generation }, resolvedTarget: { canonicalFile: target } };
}

/** @param {any} host @param {any} fields */
async function admitting(host, fields) {
  return /** @type {any} */ (await host.reservations.admit(operationOn(fields)));
}

/** @param {string} journalPath */
async function journalRecords(journalPath) {
  const text = await readFile(journalPath, "utf8");
  return text.length === 0 ? [] : text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
}

/** @param {string} path @param {string} name */
async function writeSessionFile(path, name) {
  await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: dirname(path) })}\n`, { mode: 0o600 });
  return path;
}

describe("two state roots, one real session directory", () => {
  it("excludes a second owner from a live process's file and admits it once the claim is released", async () => {
    const domain = await realSessionDirectory();
    const target = await writeSessionFile(join(domain.session, "2026-01-01T00-00-00-000Z_owned.jsonl"), "owned");
    const claimant = await realOwnerProcess();
    // Owner one is driven from the state root `state-a`; owner two from `state-b`. Neither root appears in
    // the domain, which is why one lock excludes both.
    const first = await openFor(domain, claimant.ownerRun("state-a-row"), 1);
    const held = await admitting(first, { operation: "startup", generation: 1, target });
    await first.reservations.commitBinding({ reservationId: held.reservationId, nextGeneration: 1 });

    const second = await openFor(domain, { initialRowId: "state-b-row", runId: "run-second", ownerPid: process.pid, ownerStartIdentity: (await inspectProcessIdentity(process.pid)).startIdentity, ...recordedHost() }, 1);
    const refused = await admitting(second, { generation: 1, target });
    expect(refused).toMatchObject({ refused: true, code: "TARGET_HAS_LIVE_WRITER" });
    expect(refused.message).toMatch(/retry/i);
    expect(await second.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "live" });

    await first.reservations.releaseCommitted({ reservationId: held.reservationId, reason: "owner disposed the session" });
    expect(await admitting(second, { generation: 1, target })).toMatchObject({ reservationId: expect.any(String) });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared", "committed", "released", "prepared"]);
  });

  it("turns a killed owner's claim into a blocking uncertainty, and clears it only on an operator action", async () => {
    const domain = await realSessionDirectory();
    const target = await writeSessionFile(join(domain.session, "2026-01-01T00-00-00-000Z_killed.jsonl"), "killed");
    const claimant = await realOwnerProcess();
    const owner = await openFor(domain, claimant.ownerRun("state-a-row"), 1);
    const held = await admitting(owner, { operation: "startup", generation: 1, target });
    await owner.reservations.commitBinding({ reservationId: held.reservationId, nextGeneration: 1 });

    await claimant.stop();

    const next = await openFor(domain, { initialRowId: "state-b-row", runId: "run-next", ownerPid: process.pid, ownerStartIdentity: (await inspectProcessIdentity(process.pid)).startIdentity, ...recordedHost() }, 1);
    const state = await next.reservations.reconcile({ canonicalFile: target });
    expect(state).toMatchObject({ state: "uncertain", absenceProven: true });
    expect(state.reason).toContain(`pid ${claimant.identity.pid}`);
    expect(await admitting(next, { generation: 1, target })).toMatchObject({ refused: true, code: "TARGET_UNCERTAIN" });

    const cleared = await next.reservations.clearUncertainClaim({ canonicalFile: target, operator: "integration-operator", reason: "the recorded owner process is gone" });
    expect(cleared.cleared).toBe(true);
    expect(await admitting(next, { generation: 1, target })).toMatchObject({ reservationId: expect.any(String) });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared", "committed", "cleared", "prepared"]);
  });

  it("leaves a claim recorded on another machine uncertain, unclearable and blocking", async () => {
    const domain = await realSessionDirectory();
    const target = await writeSessionFile(join(domain.session, "2026-01-01T00-00-00-000Z_elsewhere.jsonl"), "elsewhere");
    const elsewhere = { initialRowId: "row", runId: "run-elsewhere", ownerPid: process.pid, ownerStartIdentity: (await inspectProcessIdentity(process.pid)).startIdentity, hostId: `${hostIdentity.hostId}-other-machine`, bootId: hostIdentity.bootId };
    const foreign = await openFor(domain, elsewhere, 1);
    const held = await admitting(foreign, { operation: "startup", generation: 1, target });
    await foreign.reservations.commitBinding({ reservationId: held.reservationId, nextGeneration: 1 });

    const here = await openFor(domain, { initialRowId: "row", runId: "run-here", ownerPid: process.pid, ownerStartIdentity: (await inspectProcessIdentity(process.pid)).startIdentity, ...recordedHost() }, 1);
    // This PID is alive on *this* machine, and that is deliberately not evidence about the recorded one.
    expect(await here.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "uncertain", absenceProven: false });
    expect(await admitting(here, { generation: 1, target })).toMatchObject({ refused: true, code: "TARGET_UNCERTAIN" });
    await expect(here.reservations.clearUncertainClaim({ canonicalFile: target, operator: "integration-operator", reason: "assume the other machine is gone" })).rejects.toMatchObject({
      code: "NO_ABSENCE_PROOF",
    });
  });

  it("refuses both halves of a swap without deadlocking, and refuses a replay onto a different target", async () => {
    const domain = await realSessionDirectory();
    const left = await writeSessionFile(join(domain.session, "2026-01-01T00-00-00-000Z_left.jsonl"), "left");
    const right = await writeSessionFile(join(domain.session, "2026-01-01T00-00-00-000Z_right.jsonl"), "right");
    const [leftOwner, rightOwner] = [await realOwnerProcess(), await realOwnerProcess()];
    const first = await openFor(domain, leftOwner.ownerRun("state-a-row"), 1);
    const second = await openFor(domain, rightOwner.ownerRun("state-b-row"), 1);
    for (const [host, file] of /** @type {[any, string][]} */ ([[first, left], [second, right]])) {
      const held = await admitting(host, { operation: "startup", generation: 1, target: file });
      await host.reservations.commitBinding({ reservationId: held.reservationId, nextGeneration: 1 });
    }

    // Each owner reaches for the other's live file at the same time. Both take the same two locks in the
    // same order, so both answer promptly instead of waiting on each other, and neither is admitted: the
    // one that finds a lock held is refused as unavailable with a retry, because nothing waits on a lock.
    const swap = await Promise.all([admitting(first, { generation: 1, target: right }), admitting(second, { generation: 1, target: left })]);
    expect(swap.every((decision) => decision.refused === true)).toBe(true);
    expect(swap.map((decision) => decision.code).sort()).toEqual(["ADMISSION_UNAVAILABLE", "TARGET_HAS_LIVE_WRITER"]);
    expect(swap.map((decision) => decision.message).join(" ")).toMatch(/retry/i);
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared", "committed", "prepared", "committed"]);
    // Retried one at a time, each refusal is the live writer it actually is.
    expect(await admitting(first, { generation: 1, target: right })).toMatchObject({ code: "TARGET_HAS_LIVE_WRITER" });
    expect(await admitting(second, { generation: 1, target: left })).toMatchObject({ code: "TARGET_HAS_LIVE_WRITER" });

    const free = join(domain.session, "2026-01-01T00-00-00-000Z_free.jsonl");
    const replayed = "operation-replayed-once";
    expect(await admitting(first, { operationId: replayed, generation: 1, target: free })).toMatchObject({ reservationId: expect.any(String) });
    expect(await admitting(first, { operationId: replayed, generation: 1, target: `${free}.other` })).toMatchObject({ refused: true, code: "DUPLICATE_OPERATION" });
  });
});

describe("real storage failures", () => {
  it("refuses to open a journal that is a symlink, and writes nothing through it", async () => {
    const domain = await realSessionDirectory();
    const elsewhere = join(domain.root, "state-a", "smuggled.jsonl");
    await writeFile(elsewhere, "", { mode: 0o600 });
    await symlink(elsewhere, domain.journalPath);
    const claimant = await realOwnerProcess();

    await expect(openFor(domain, claimant.ownerRun("row"), 1)).rejects.toMatchObject({ code: "ELOOP" });
    expect(await readFile(elsewhere, "utf8")).toBe("");
  });

  it("refuses admission when the lock domain cannot be written, and admits again once it can", async () => {
    const domain = await realSessionDirectory();
    const target = await writeSessionFile(join(domain.session, "2026-01-01T00-00-00-000Z_blocked.jsonl"), "blocked");
    const claimant = await realOwnerProcess();
    const owner = await openFor(domain, claimant.ownerRun("row"), 1);
    await chmod(domain.lockPath, 0o500);

    try {
      const refused = await admitting(owner, { generation: 1, target });
      expect(refused).toMatchObject({ refused: true, code: "ADMISSION_UNAVAILABLE" });
      expect(refused.message).toMatch(/EACCES|permission denied/i);
      expect(await journalRecords(domain.journalPath)).toEqual([]);
    } finally {
      await chmod(domain.lockPath, 0o700);
    }
    expect(await admitting(owner, { generation: 1, target })).toMatchObject({ reservationId: expect.any(String) });
  });

  it("makes a committed claim visible to a second process reading the same journal", async () => {
    const domain = await realSessionDirectory();
    const target = await writeSessionFile(join(domain.session, "2026-01-01T00-00-00-000Z_durable.jsonl"), "durable");
    const claimant = await realOwnerProcess();
    const owner = await openFor(domain, claimant.ownerRun("row"), 1);
    const held = await admitting(owner, { operation: "startup", generation: 1, target });
    await owner.reservations.commitBinding({ reservationId: held.reservationId, nextGeneration: 1 });

    const reader = spawn(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", domain.journalPath], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    for await (const chunk of reader.stdout) chunks.push(chunk);
    const [exit] = await once(reader, "exit", { signal: AbortSignal.timeout(CHILD_EXIT_TIMEOUT_MS) });
    expect(exit).toBe(0);
    const records = Buffer.concat(chunks).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.record)).toEqual(["prepared", "committed"]);
    expect(records.at(-1)).toMatchObject({ generation: 1, target: { canonicalFile: await realpath(target), inode: String((await stat(target, { bigint: true })).ino) } });
  });
});

describe.skipIf(!CONSUMER)("the installed seam D hook, backed by this journal", () => {
  /**
   * The host Pi actually registers: seam A's submission handlers, plus the canonical trio wired straight
   * to this module.
   *
   * The generation this host reports is adopted from the `startup` operation — seam D's adoption of the
   * binding Pi already had — and afterwards is only ever what this host itself committed. That is what
   * makes a later operation carrying a superseded generation refusable: nothing here recomputes it.
   */
  /** @param {{journalPath:string,lockPath:string}} domain @param {any} ownerRun */
  async function hostFor(domain, ownerRun) {
    /** @type {number|undefined} */
    let generation;
    const reservations = await openCanonicalReservations({
      journalPath: domain.journalPath,
      lockPath: domain.lockPath,
      owner: ownerRun,
      currentGeneration: () => generation ?? 0,
      hostProof: createLocalHostProof({ hostIdentity }),
    });
    opened.push(reservations);
    /** @type {{operation:string,target:string,decision:any}[]} */
    const decisions = [];
    return {
      reservations,
      decisions,
      host: {
        ownerRunId: ownerRun.runId,
        /** @param {any} envelope */
        async beforeNativeSubmit(envelope) {
          return { authorized: true, fence: { submissionId: envelope.submissionId, ownerRunId: ownerRun.runId, bindingGeneration: envelope.binding.generation, nonce: "nonce" } };
        },
        async recordEffectivePayload() {
          return { recorded: true };
        },
        nativeSubmitOutcome() {},
        /** @param {any} operation */
        async admitCanonicalOperation(operation) {
          generation ??= operation.currentBinding.generation;
          const decision = await reservations.admit(operation);
          decisions.push({ operation: operation.operation, target: operation.resolvedTarget.canonicalFile, decision });
          return decision;
        },
        /** @param {any} commit */
        async commitBinding(commit) {
          generation = commit.nextGeneration;
          return await reservations.commitBinding(commit);
        },
        /** @param {any} abort */
        async abortReservation(abort) {
          return await reservations.abortReservation(abort);
        },
      },
    };
  }

  /** @param {{session:string}} domain */
  async function installedRuntime(domain) {
    const harnessRuntime = await fixture.createInstalledRuntime({ workspace: dirname(domain.session) });
    runtimes.push(harnessRuntime);
    return harnessRuntime;
  }

  it("journals a real new-session rebind as one prepared record and one transfer", async () => {
    const domain = await realSessionDirectory();
    const claimant = await realOwnerProcess();
    const owner = await hostFor(domain, claimant.ownerRun("installed-row"));
    pi.setNativeSubmissionHost(owner.host);
    const runtime = await installedRuntime(domain);
    const startupFile = runtime.persist(runtime.runtime.session.sessionManager);

    const created = await runtime.runtime.newSession();

    expect(created.cancelled).toBe(false);
    const target = runtime.runtime.session.sessionManager.getSessionFile();
    expect(target).not.toBe(startupFile);
    expect(owner.decisions.map((entry) => entry.operation)).toEqual(["startup", "new"]);
    const records = await journalRecords(domain.journalPath);
    expect(records.map((record) => record.record)).toEqual(["prepared", "committed", "prepared", "transferred"]);
    // A new session's file is named and reserved before Pi writes it, so the claim carries the canonicalized
    // path and no inode yet. The file Pi moved off is on disk and carries both.
    expect(records.at(-1)).toMatchObject({
      target: { canonicalFile: join(await realpath(dirname(target)), basename(target)), device: null, inode: null },
      released: { canonicalFile: await realpath(startupFile), inode: String((await stat(startupFile, { bigint: true })).ino) },
    });
    expect(records.at(-1).generation).toBeGreaterThan(records[1].generation);
    // The file Pi moved off is free for another owner; the file it moved onto is not.
    expect(await owner.reservations.reconcile({ canonicalFile: startupFile })).toMatchObject({ state: "released" });
    expect(await owner.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "live" });
  });

  it("refuses a resume onto a live owner's file with a retry hint, writes nothing, and leaves resume working", async () => {
    const domain = await realSessionDirectory();
    const claimant = await realOwnerProcess();
    const contender = await realOwnerProcess();
    const owner = await hostFor(domain, claimant.ownerRun("installed-row"));
    pi.setNativeSubmissionHost(owner.host);
    const runtime = await installedRuntime(domain);
    const ownFile = runtime.persist(runtime.runtime.session.sessionManager);
    const other = runtime.writeSession("claimed-elsewhere");
    const bytesBefore = await readFile(other, "utf8");

    // A second live owner holds the file Pi is about to be asked to resume.
    const rival = await openFor(domain, contender.ownerRun("rival-row"), 1);
    const rivalClaim = await admitting(rival, { operation: "startup", generation: 1, target: other });
    await rival.reservations.commitBinding({ reservationId: rivalClaim.reservationId, nextGeneration: 1 });

    await expect(runtime.runtime.switchSession(other)).rejects.toMatchObject({
      name: "CanonicalOperationRefusedError",
      code: "TARGET_HAS_LIVE_WRITER",
      beforeMutation: true,
    });
    expect(await readFile(other, "utf8")).toBe(bytesBefore);
    expect(runtime.runtime.session.sessionManager.getSessionFile()).toBe(ownFile);

    // Nothing was disabled: the same `/resume` succeeds once the rival's claim is released explicitly.
    await rival.reservations.releaseCommitted({ reservationId: rivalClaim.reservationId, reason: "rival disposed the session" });
    const resumed = await runtime.runtime.switchSession(other);
    expect(resumed.cancelled).toBe(false);
    expect(runtime.runtime.session.sessionManager.getSessionFile()).toBe(other);
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual([
      "prepared",
      "committed",
      "prepared",
      "committed",
      "released",
      "prepared",
      "transferred",
    ]);
  });

  it("keeps a killed owner's real file out of another owner's resume until an operator clears it", async () => {
    const domain = await realSessionDirectory();
    const claimant = await realOwnerProcess();
    const dead = await realOwnerProcess();
    const owner = await hostFor(domain, claimant.ownerRun("installed-row"));
    pi.setNativeSubmissionHost(owner.host);
    const runtime = await installedRuntime(domain);
    runtime.persist(runtime.runtime.session.sessionManager);
    const abandoned = runtime.writeSession("abandoned");
    const deadOwner = await openFor(domain, dead.ownerRun("dead-row"), 1);
    const deadClaim = await admitting(deadOwner, { operation: "startup", generation: 1, target: abandoned });
    await deadOwner.reservations.commitBinding({ reservationId: deadClaim.reservationId, nextGeneration: 1 });
    await dead.stop();

    await expect(runtime.runtime.switchSession(abandoned)).rejects.toMatchObject({ name: "CanonicalOperationRefusedError", code: "TARGET_UNCERTAIN" });

    await owner.reservations.clearUncertainClaim({ canonicalFile: abandoned, operator: "integration-operator", reason: "the recorded owner process is gone" });
    const resumed = await runtime.runtime.switchSession(abandoned);
    expect(resumed.cancelled).toBe(false);
    expect(runtime.runtime.session.sessionManager.getSessionFile()).toBe(abandoned);
  });
});
