/**
 * Unit cases for the durable canonical reservation backend.
 *
 * Persistence here is real: every case writes a real journal in a real disposable directory, through
 * `openDurableAppendStore`, and every lock is a real `acquireLifecycleLock` directory. Nothing fakes a
 * write, a rename or an fsync. Two things are injected, both deterministic and both named in the module's
 * options: `failpoint(stage)` for a crash at an exact point in a journal write, and `hostProof` for the
 * verdict a trusted verifier returns about a *recorded* host and boot. The verifier is injected because
 * the recorded host of a foreign claim is not this machine, so no real probe here could answer for it;
 * `canonical-reservation.integration.test.mjs` uses the real local verifier against real processes.
 *
 * A "crash" is this process abandoning a backend mid-operation: the object is dropped without a release,
 * and the next owner run opens the same journal. That is the state a killed owner leaves behind.
 */

import { randomUUID } from "node:crypto";
import { appendFile, copyFile, link, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CANONICAL_JOURNAL_VERSION,
  canonicalReservationPaths,
  openCanonicalReservations,
  orderCanonicalLocks,
} from "./canonical-reservation.mjs";
import { acquireLifecycleLock } from "./lifecycle-lock.mjs";

const RECORDED_HOST = "host-recorded";
const RECORDED_BOOT = "boot-recorded";

/** @type {string[]} */
const roots = [];
/** @type {{close(): Promise<void>}[]} */
const opened = [];

afterEach(async () => {
  // Every backend is closed before its directory is removed, including the ones a case abandoned to
  // simulate a crash. An open descriptor makes a network filesystem keep a deleted file as a hidden entry,
  // and `rm` then fails with ENOTEMPTY on a directory the case is done with.
  for (const reservations of opened.splice(0)) await reservations.close().catch(() => {});
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** One disposable Pi session directory, plus the two state roots that share it. */
async function sessionDirectory() {
  const root = await mkdtemp(join(tmpdir(), "canonical-reservation-"));
  roots.push(root);
  const session = join(root, "pi", "sessions");
  await mkdir(session, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "state-a"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "state-b"), { recursive: true, mode: 0o700 });
  const paths = canonicalReservationPaths(session);
  await mkdir(dirname(paths.journalPath), { recursive: true, mode: 0o700 });
  return { root, session, ...paths };
}

/** @param {Partial<{initialRowId:string,runId:string,ownerPid:number,ownerStartIdentity:string,hostId:string,bootId:string}>} [overrides] */
function ownerRun(overrides = {}) {
  return {
    initialRowId: "row-1",
    runId: `run-${randomUUID()}`,
    ownerPid: 4242,
    ownerStartIdentity: "9001",
    hostId: RECORDED_HOST,
    bootId: RECORDED_BOOT,
    ...overrides,
  };
}

/**
 * A trusted verifier stand-in: one verdict per recorded host and boot, and `unknown` for anything else.
 * @param {Record<string, {proof:"live"|"absent"|"unknown", evidence:string}>} verdicts
 */
function hostProofOf(verdicts) {
  /** @type {{hostId:string,bootId:string,ownerPid:number}[]} */
  const asked = [];
  return {
    asked,
    /** @param {any} recorded */
    async proveOwnerAbsence(recorded) {
      asked.push({ hostId: recorded.hostId, bootId: recorded.bootId, ownerPid: recorded.ownerPid });
      return verdicts[`${recorded.hostId}/${recorded.bootId}`] ?? { proof: /** @type {const} */ ("unknown"), evidence: `no verifier for ${recorded.hostId}` };
    },
  };
}

const liveProof = () => hostProofOf({ [`${RECORDED_HOST}/${RECORDED_BOOT}`]: { proof: "live", evidence: "recorded pid is running" } });
const absentProof = () => hostProofOf({ [`${RECORDED_HOST}/${RECORDED_BOOT}`]: { proof: "absent", evidence: "recorded pid is gone on the recorded boot" } });
const unreachableProof = () => hostProofOf({});

/**
 * @param {{session:string,journalPath:string,lockPath:string}} domain
 * @param {{owner?:any, generation?:number, hostProof?:any, failpoint?:(stage:string)=>Promise<void>, fsOps?:any}} [options]
 */
async function openOwner(domain, { owner = ownerRun(), generation = 1, hostProof = liveProof(), failpoint, fsOps } = {}) {
  let current = generation;
  const reservations = await openCanonicalReservations({
    sessionDirectory: domain.session,
    journalPath: domain.journalPath,
    lockPath: domain.lockPath,
    owner,
    currentGeneration: () => current,
    hostProof,
    ...(failpoint === undefined ? {} : { failpoint }),
    ...(fsOps === undefined ? {} : { fsOps }),
  });
  opened.push(reservations);
  return {
    owner,
    reservations,
    hostProof,
    /** Move the owner's authoritative generation the way Pi's own binding supplier does. @param {number} next */
    setGeneration(next) {
      current = next;
    },
    generation: () => current,
  };
}

/** @param {{operationId?:string, operation?:string, generation:number, target:string}} fields */
function operationOn({ operationId = `operation-${randomUUID()}`, operation = "new", generation, target }) {
  return { operationId, operation, currentBinding: { canonicalFile: undefined, generation }, resolvedTarget: { canonicalFile: target } };
}

/** One admission decision, read through either of the seam's two arms. @param {any} host @param {any} fields */
async function admitting(host, fields) {
  return /** @type {any} */ (await host.reservations.admit(operationOn(fields)));
}

/** @param {string} journalPath */
async function journalRecords(journalPath) {
  const text = await readFile(journalPath, "utf8");
  return text.length === 0 ? [] : text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
}

/**
 * Bind one owner to one file the way a startup adoption does: admit, then commit at the same generation.
 * @param {any} host @param {string} target @param {number} generation
 */
async function bind(host, target, generation) {
  const admission = await admitting(host, { operation: "startup", generation, target });
  expect(admission).toMatchObject({ reservationId: expect.any(String) });
  await host.reservations.commitBinding({ reservationId: admission.reservationId, nextGeneration: generation });
  return admission.reservationId;
}

/**
 * Let two admissions reach their journal write before either of them finishes it.
 *
 * `before_prepared_append` is the one point where an admission has taken every lock it is going to take
 * and has written nothing yet, so a participant waiting here is holding its locks. A participant the
 * exclusion refuses never arrives, which is why the wait is bounded rather than a two-party rendezvous:
 * the bound is what proves the other side was refused instead of merely slow.
 * @param {number} participants
 */
function admissionBarrier(participants, holdMilliseconds = 500) {
  let arrived = 0;
  /** @type {() => void} */
  let releaseAll = () => {};
  const everyone = new Promise((resolve) => {
    releaseAll = () => resolve(undefined);
  });
  return async (/** @type {string} */ stage) => {
    if (stage !== "before_prepared_append") return;
    arrived += 1;
    if (arrived >= participants) {
      releaseAll();
      return;
    }
    await Promise.race([everyone, new Promise((resolve) => setTimeout(resolve, holdMilliseconds))]);
  };
}

describe("the canonical lock domain", () => {
  it("puts the journal and the locks in one subdirectory of the Pi session directory, shared by both state roots", async () => {
    const domain = await sessionDirectory();
    expect(dirname(domain.journalPath)).toBe(dirname(domain.lockPath));
    expect(dirname(domain.journalPath)).toBe(join(domain.session, "canonical-reservations"));
    expect(domain.journalPath.startsWith(join(domain.root, "state-"))).toBe(false);
    // Nothing this module writes sits beside Pi's own session files, where a `*.jsonl` journal would be
    // offered as a session to resume.
    expect(await readdir(domain.session)).toEqual(["canonical-reservations"]);
  });

  it("takes the Pi session directory as the domain's authority and derives both paths from it", async () => {
    const domain = await sessionDirectory();
    const reservations = await openCanonicalReservations({
      sessionDirectory: domain.session,
      owner: ownerRun(),
      currentGeneration: () => 1,
      hostProof: liveProof(),
    });
    opened.push(reservations);
    expect(reservations.domain).toMatchObject({ journalPath: domain.journalPath, lockPath: domain.lockPath });
    // Without that authority there is no domain to check a configured pair against, so there is no open.
    await expect(
      openCanonicalReservations(/** @type {any} */ ({ journalPath: domain.journalPath, lockPath: domain.lockPath, owner: ownerRun(), currentGeneration: () => 1, hostProof: liveProof() })),
    ).rejects.toThrow(/session directory/i);
  });

  it("refuses a journal and lock pair under a dashboard state root, even one that agrees with itself", async () => {
    const domain = await sessionDirectory();
    for (const root of ["state-a", "state-b"]) {
      const perRoot = canonicalReservationPaths(join(domain.root, root));
      // Each pair is internally consistent — one directory, one journal, one lock — and two of them
      // exclude nothing against each other, which is exactly why the session directory decides.
      expect(dirname(perRoot.journalPath)).toBe(dirname(perRoot.lockPath));
      await expect(
        openCanonicalReservations({
          sessionDirectory: domain.session,
          journalPath: perRoot.journalPath,
          lockPath: perRoot.lockPath,
          owner: ownerRun(),
          currentGeneration: () => 1,
          hostProof: liveProof(),
        }),
        root,
      ).rejects.toMatchObject({ name: "CanonicalReservationError", code: "DOMAIN_SPLIT" });
    }
  });

  it("refuses a journal and a lock that do not share one directory, because a per-root lock excludes nothing", async () => {
    const domain = await sessionDirectory();
    await expect(
      openCanonicalReservations({
        sessionDirectory: domain.session,
        journalPath: join(domain.root, "state-a", "canonical-reservations.jsonl"),
        lockPath: domain.lockPath,
        owner: ownerRun(),
        currentGeneration: () => 1,
        hostProof: liveProof(),
      }),
    ).rejects.toMatchObject({ name: "CanonicalReservationError", code: "DOMAIN_SPLIT" });
  });

  it("orders path locks before identity locks, lexicographically within each kind, and collapses an alias", async () => {
    const domain = await sessionDirectory();
    const first = join(domain.session, "a.jsonl");
    const second = join(domain.session, "b.jsonl");
    await writeFile(first, "", { mode: 0o600 });
    await writeFile(second, "", { mode: 0o600 });
    await symlink(first, join(domain.session, "alias.jsonl"));

    const ordered = await orderCanonicalLocks(domain.lockPath, [second, first]);
    expect(ordered.map((entry) => entry.kind)).toEqual(["path", "path", "identity", "identity"]);
    expect(ordered.filter((entry) => entry.kind === "path").map((entry) => entry.canonicalFile)).toEqual([first, second]);
    // An existing file carries a `{device, inode}` lock as well, and it is a different lock from its path's.
    const identities = ordered.filter((entry) => entry.kind === "identity");
    expect(identities.map((entry) => entry.subject)).toEqual([...identities.map((entry) => entry.subject)].sort());
    expect(new Set(ordered.map((entry) => entry.path)).size).toBe(4);

    const aliased = await orderCanonicalLocks(domain.lockPath, [join(domain.session, "alias.jsonl"), first]);
    expect(aliased.map((entry) => entry.kind)).toEqual(["path", "identity"]);
    expect(aliased[0].path).toBe(ordered[0].path);
  });

  it("locks the source and the target in that order for a rebind, whichever way the paths sort", async () => {
    for (const [sourceName, targetName] of [["a.jsonl", "z.jsonl"], ["z.jsonl", "a.jsonl"]]) {
      const domain = await sessionDirectory();
      const source = join(domain.session, sourceName);
      const target = join(domain.session, targetName);
      await writeFile(source, "", { mode: 0o600 });
      /** @type {string[]} */
      const staged = [];
      const fsOps = {
        ...(await import("node:fs/promises")),
        /** @param {any} path @param {any} options */
        async mkdir(path, options) {
          staged.push(String(path));
          return mkdir(path, options);
        },
      };
      const host = await openOwner(domain, { fsOps });
      await bind(host, source, 1);
      await writeFile(target, "", { mode: 0o600 });
      staged.length = 0;
      const admission = await admitting(host, { generation: 1, target });
      host.setGeneration(2);
      await host.reservations.commitBinding({ reservationId: admission.reservationId, nextGeneration: 2 });
      await host.reservations.close();

      const expected = (await orderCanonicalLocks(domain.lockPath, [source, target])).map((entry) => entry.path);
      const observed = staged
        .map((path) => expected.find((lock) => path.startsWith(`${lock}.`)))
        .filter((lock, index, all) => lock !== undefined && all.indexOf(lock) === index);
      expect(observed, `${sourceName} -> ${targetName}`).toEqual(expected);
    }
  });
});

describe("admission", () => {
  it("refuses a superseded generation with no journal entry at all", async () => {
    const domain = await sessionDirectory();
    const host = await openOwner(domain, { generation: 7 });
    const refusal = await admitting(host, { generation: 6, target: join(domain.session, "s.jsonl") });
    expect(refusal).toMatchObject({ refused: true, code: "STALE_BINDING" });
    expect(await journalRecords(domain.journalPath)).toEqual([]);
  });

  it("refuses a replayed operation id with a different target, and with the same target, for the owner's lifetime", async () => {
    const domain = await sessionDirectory();
    const host = await openOwner(domain);
    const operationId = "operation-replayed";
    const first = join(domain.session, "first.jsonl");
    const admitted = await admitting(host, { operationId, generation: 1, target: first });
    expect(admitted).toMatchObject({ reservationId: expect.any(String) });

    const elsewhere = await admitting(host, { operationId, generation: 1, target: join(domain.session, "second.jsonl") });
    expect(elsewhere).toMatchObject({ refused: true, code: "DUPLICATE_OPERATION" });
    await host.reservations.abortReservation({ reservationId: admitted.reservationId, reason: "test" });
    const again = await admitting(host, { operationId, generation: 1, target: first });
    expect(again).toMatchObject({ refused: true, code: "DUPLICATE_OPERATION" });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared", "aborted"]);
  });

  it("rejects a directory plus a pattern through the shared contract, and admits the exact final name", async () => {
    const domain = await sessionDirectory();
    const host = await openOwner(domain);
    for (const target of [`${domain.session}/`, join(domain.session, "*.jsonl"), `${domain.session}/{a,b}.jsonl`]) {
      await expect(host.reservations.admit(operationOn({ generation: 1, target })), target).rejects.toThrow(TypeError);
    }
    // A path that is an exact name by the contract and a directory on disk is refused, never admitted.
    expect(await admitting(host, { generation: 1, target: domain.session })).toMatchObject({
      refused: true,
      code: "ADMISSION_UNAVAILABLE",
    });
    expect(await journalRecords(domain.journalPath)).toEqual([]);
    const exact = await admitting(host, { generation: 1, target: join(domain.session, "2026-01-01T00-00-00-000Z_new.jsonl") });
    expect(exact).toMatchObject({ reservationId: expect.any(String) });
  });

  it("refuses a live writer's target with a retry hint and no forwarding arm", async () => {
    const domain = await sessionDirectory();
    const target = join(domain.session, "owned.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    const first = await openOwner(domain);
    await bind(first, target, 1);

    const second = await openOwner(domain, { owner: ownerRun(), hostProof: liveProof() });
    const refusal = await admitting(second, { operation: "resume", generation: 1, target });
    expect(refusal).toMatchObject({ refused: true, code: "TARGET_HAS_LIVE_WRITER" });
    expect(refusal.message).toMatch(/retry/i);
    expect(Object.keys(refusal).sort()).toEqual(["code", "message", "refused"]);
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared", "committed"]);
  });

  it("collapses two paths that resolve to one inode into one claim, by realpath and by hard link", async () => {
    const domain = await sessionDirectory();
    const real = join(domain.session, "real.jsonl");
    await writeFile(real, "", { mode: 0o600 });
    await mkdir(join(domain.session, "by-link"), { mode: 0o700 });
    await symlink(real, join(domain.session, "by-link", "symlinked.jsonl"));
    const hardLink = join(domain.session, "hard.jsonl");
    await link(real, hardLink);
    const [viaReal, viaLink] = [await stat(real, { bigint: true }), await stat(hardLink, { bigint: true })];
    expect(`${viaLink.dev}/${viaLink.ino}`).toBe(`${viaReal.dev}/${viaReal.ino}`);
    expect(await realpath(join(domain.session, "by-link", "symlinked.jsonl"))).toBe(await realpath(real));

    const first = await openOwner(domain);
    await bind(first, real, 1);
    const second = await openOwner(domain);
    for (const alias of [join(domain.session, "by-link", "symlinked.jsonl"), hardLink]) {
      const refusal = await admitting(second, { operation: "resume", generation: 1, target: alias });
      expect(refusal, alias).toMatchObject({ refused: true, code: "TARGET_HAS_LIVE_WRITER" });
    }
  });

  it("keeps a committed claim blocking until releaseCommitted, and never releases on close", async () => {
    const domain = await sessionDirectory();
    const target = join(domain.session, "held.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    const first = await openOwner(domain);
    const reservationId = await bind(first, target, 1);
    await first.reservations.close();

    const second = await openOwner(domain);
    expect(await admitting(second, { operation: "resume", generation: 1, target })).toMatchObject({ code: "TARGET_HAS_LIVE_WRITER" });
    const third = await openOwner(domain, { owner: first.owner, generation: 1 });
    await third.reservations.releaseCommitted({ reservationId, reason: "session disposed" });
    expect(await admitting(second, { operation: "resume", generation: 1, target })).toMatchObject({ reservationId: expect.any(String) });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared", "committed", "released", "prepared"]);
  });
});

describe("commit and transfer", () => {
  it("moves a claim and its generation in one record, leaving the source unclaimed and the target advanced", async () => {
    const domain = await sessionDirectory();
    const source = join(domain.session, "source.jsonl");
    const target = join(domain.session, "target.jsonl");
    await writeFile(source, "", { mode: 0o600 });
    const host = await openOwner(domain);
    await bind(host, source, 1);
    const admission = await admitting(host, { generation: 1, target });
    await writeFile(target, "", { mode: 0o600 });
    host.setGeneration(2);

    await host.reservations.commitBinding({ reservationId: admission.reservationId, nextGeneration: 2 });

    const records = await journalRecords(domain.journalPath);
    const transferred = records.at(-1);
    expect(records.map((record) => record.record)).toEqual(["prepared", "committed", "prepared", "transferred"]);
    expect(transferred).toMatchObject({ version: CANONICAL_JOURNAL_VERSION, generation: 2, released: { canonicalFile: await realpath(source) } });
    expect(await host.reservations.reconcile({ canonicalFile: source })).toMatchObject({ state: "released" });
    expect(await host.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "live" });
    const other = await openOwner(domain);
    expect(await admitting(other, { operation: "resume", generation: 1, target: source })).toMatchObject({ reservationId: expect.any(String) });
    expect(await admitting(other, { operation: "resume", generation: 1, target })).toMatchObject({ code: "TARGET_HAS_LIVE_WRITER" });
  });

  it("commits the unchanged generation for a selector operation on another owner's released file, and keeps the owner's own binding", async () => {
    const domain = await sessionDirectory();
    const own = join(domain.session, "own.jsonl");
    const other = join(domain.session, "other.jsonl");
    await writeFile(own, "", { mode: 0o600 });
    await writeFile(other, "", { mode: 0o600 });
    const host = await openOwner(domain, { generation: 3 });
    await bind(host, own, 3);
    const admission = await admitting(host, { operation: "delete", generation: 3, target: other });
    await unlink(other);

    await host.reservations.commitBinding({ reservationId: admission.reservationId, nextGeneration: 3 });

    expect((await journalRecords(domain.journalPath)).at(-1)).toMatchObject({ record: "committed", generation: 3, binds: false });
    expect(await host.reservations.reconcile({ canonicalFile: own })).toMatchObject({ state: "live" });
  });

  it("refuses a generation the owner's own binding does not report, journals nothing, and leaves the claim uncertain", async () => {
    const domain = await sessionDirectory();
    const source = join(domain.session, "source.jsonl");
    const target = join(domain.session, "target.jsonl");
    await writeFile(source, "", { mode: 0o600 });
    const host = await openOwner(domain);
    await bind(host, source, 1);
    const admission = await admitting(host, { generation: 1, target });
    await writeFile(target, "", { mode: 0o600 });

    // The requested target is not evidence: the owner's supplier still reports generation 1.
    await expect(host.reservations.commitBinding({ reservationId: admission.reservationId, nextGeneration: 2 })).rejects.toMatchObject({
      name: "CanonicalReservationError",
      code: "GENERATION_NOT_AUTHORITATIVE",
    });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared", "committed", "prepared"]);
    const witness = await openOwner(domain, { hostProof: absentProof() });
    expect(await witness.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "uncertain" });
  });

  it("refuses a commit whose generation the owner's binding does not report, on a first bind and on a selector operation", async () => {
    const domain = await sessionDirectory();
    const own = join(domain.session, "own.jsonl");
    await writeFile(own, "", { mode: 0o600 });
    const host = await openOwner(domain, { generation: 3 });

    // A first bind has no claim to move, so this is `commitBinding`'s own check, not a transfer's.
    const first = await admitting(host, { operation: "startup", generation: 3, target: own });
    await expect(host.reservations.commitBinding({ reservationId: first.reservationId, nextGeneration: 4 })).rejects.toMatchObject({
      code: "GENERATION_NOT_AUTHORITATIVE",
    });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared"]);
    await host.reservations.commitBinding({ reservationId: first.reservationId, nextGeneration: 3 });

    // A selector operation on another file commits the unchanged generation, so a lower one is not a
    // transfer either and is refused by the same check.
    const other = join(domain.session, "other.jsonl");
    await writeFile(other, "", { mode: 0o600 });
    const selector = await admitting(host, { operation: "rename", generation: 3, target: other });
    await expect(host.reservations.commitBinding({ reservationId: selector.reservationId, nextGeneration: 2 })).rejects.toMatchObject({
      code: "GENERATION_NOT_AUTHORITATIVE",
    });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared", "committed", "prepared"]);
  });

  it("spends a reservation id for the owner's lifetime, whether it committed or aborted", async () => {
    const domain = await sessionDirectory();
    const target = join(domain.session, "spent.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    const host = await openOwner(domain);
    const reservationId = await bind(host, target, 1);
    for (const attempt of [
      () => host.reservations.commitBinding({ reservationId, nextGeneration: 1 }),
      () => host.reservations.abortReservation({ reservationId, reason: "replay" }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ name: "CanonicalReservationError", code: "SPENT_RESERVATION" });
    }
    // A new owner run is the only thing that clears them, and re-opening the same run does not.
    const same = await openOwner(domain, { owner: host.owner });
    await expect(same.reservations.commitBinding({ reservationId, nextGeneration: 1 })).rejects.toMatchObject({ code: "SPENT_RESERVATION" });
  });

  it("refuses to abort a committed claim, so a release is never disguised as a no-mutation abort", async () => {
    const domain = await sessionDirectory();
    const target = join(domain.session, "committed.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    const host = await openOwner(domain);
    const admission = await admitting(host, { generation: 1, target });
    await host.reservations.commitBinding({ reservationId: admission.reservationId, nextGeneration: 1 });
    await expect(host.reservations.abortReservation({ reservationId: admission.reservationId, reason: "late" })).rejects.toMatchObject({
      code: "SPENT_RESERVATION",
    });
  });
});

describe("two simultaneous admissions", () => {
  it("admits exactly one of two owners reaching one file through two hard links at the same time", async () => {
    const domain = await sessionDirectory();
    const firstName = join(domain.session, "one.jsonl");
    const secondName = join(domain.session, "two.jsonl");
    await writeFile(firstName, "{}\n", { mode: 0o600 });
    await link(firstName, secondName);
    const [viaFirst, viaSecond] = [await stat(firstName, { bigint: true }), await stat(secondName, { bigint: true })];
    expect(`${viaSecond.dev}/${viaSecond.ino}`).toBe(`${viaFirst.dev}/${viaFirst.ino}`);
    // Two hard links are two canonicalized paths: `realpath` reports each link's own name, so a path lock
    // alone would let both owners take their own lock, read the same unclaimed journal and both win.
    expect(await realpath(secondName)).not.toBe(await realpath(firstName));

    const failpoint = admissionBarrier(2);
    const [first, second] = [await openOwner(domain, { failpoint }), await openOwner(domain, { failpoint })];
    const decisions = await Promise.all([
      admitting(first, { operation: "resume", generation: 1, target: firstName }),
      admitting(second, { operation: "resume", generation: 1, target: secondName }),
    ]);

    const admitted = decisions.filter((decision) => typeof decision.reservationId === "string");
    const refused = decisions.filter((decision) => decision.refused === true);
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ code: "ADMISSION_UNAVAILABLE", message: expect.stringMatching(/lock/i) });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared"]);
    // Retried, the loser is refused on the claim itself rather than on the lock.
    const loser = decisions.indexOf(refused[0]) === 0 ? { host: first, target: firstName } : { host: second, target: secondName };
    expect(await admitting(loser.host, { operation: "resume", generation: 1, target: loser.target })).toMatchObject({
      refused: true,
      code: "TARGET_HAS_LIVE_WRITER",
    });
  });
});

describe("a same-owner reservation on the file this owner is already bound to", () => {
  it("keeps the committed claim when the no-mutation reservation is aborted", async () => {
    const domain = await sessionDirectory();
    const target = join(domain.session, "bound.jsonl");
    await writeFile(target, "{}\n", { mode: 0o600 });
    const host = await openOwner(domain);
    const committed = await bind(host, target, 1);
    const again = await admitting(host, { operation: "rename", generation: 1, target });
    expect(again).toMatchObject({ reservationId: expect.any(String) });

    await host.reservations.abortReservation({ reservationId: again.reservationId, reason: "the rename was cancelled" });

    expect(await host.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "live" });
    const other = await openOwner(domain);
    expect(await admitting(other, { operation: "resume", generation: 1, target })).toMatchObject({ refused: true, code: "TARGET_HAS_LIVE_WRITER" });
    // The original claim leaves the way it always did: explicitly, and only then.
    await host.reservations.releaseCommitted({ reservationId: committed, reason: "session disposed" });
    expect(await admitting(other, { operation: "resume", generation: 1, target })).toMatchObject({ reservationId: expect.any(String) });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared", "committed", "prepared", "aborted", "released", "prepared"]);
  });

  it("keeps the committed claim when the owner crashes with the no-mutation reservation open", async () => {
    const domain = await sessionDirectory();
    const target = join(domain.session, "crashed.jsonl");
    await writeFile(target, "{}\n", { mode: 0o600 });
    const host = await openOwner(domain);
    await bind(host, target, 1);
    expect(await admitting(host, { operation: "rename", generation: 1, target })).toMatchObject({ reservationId: expect.any(String) });
    // The owner dies holding both: no commit, no abort, no release.
    await host.reservations.close();

    const next = await openOwner(domain, { hostProof: absentProof() });
    expect(await next.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "uncertain", absenceProven: true });
    expect(await admitting(next, { operation: "resume", generation: 1, target })).toMatchObject({ refused: true, code: "TARGET_UNCERTAIN" });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared", "committed", "prepared"]);
  });

  it("leaves exactly one claim once the reservation commits, which one explicit release frees", async () => {
    const domain = await sessionDirectory();
    const target = join(domain.session, "recommitted.jsonl");
    await writeFile(target, "{}\n", { mode: 0o600 });
    const host = await openOwner(domain);
    await bind(host, target, 1);
    const again = await admitting(host, { operation: "rename", generation: 1, target });

    await host.reservations.commitBinding({ reservationId: again.reservationId, nextGeneration: 1 });

    expect(await host.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "live" });
    await host.reservations.releaseCommitted({ reservationId: again.reservationId, reason: "session disposed" });
    // One release frees the file: the claim the commit superseded was not left behind under it.
    const other = await openOwner(domain);
    expect(await admitting(other, { operation: "resume", generation: 1, target })).toMatchObject({ reservationId: expect.any(String) });
  });
});

describe("durable record validation", () => {
  /** One owner bound to one real file, and the journal it wrote. @param {{session:string,journalPath:string,lockPath:string}} domain */
  async function committedJournal(domain) {
    const target = join(domain.session, "validated.jsonl");
    await writeFile(target, "{}\n", { mode: 0o600 });
    const host = await openOwner(domain);
    const reservationId = await bind(host, target, 1);
    await host.reservations.close();
    const records = await journalRecords(domain.journalPath);
    expect(records.map((record) => record.record)).toEqual(["prepared", "committed"]);
    return { target, owner: host.owner, reservationId, committed: records[1] };
  }

  /**
   * Every way a `released` record can fail to be one, keyed by what is wrong with it.
   *
   * A record that removes a claim is the one an incomplete schema is most dangerous for, so each of these
   * is appended to a journal holding a real committed claim and must leave that claim exactly where it was.
   * @type {Record<string, (complete: any, owner: any) => Record<string, unknown>>}
   */
  const malformedReleases = {
    "a reservation id and a run id only": (complete, owner) => ({ version: CANONICAL_JOURNAL_VERSION, record: "released", reservationId: complete.reservationId, owner: { runId: owner.runId } }),
    "no reason": (complete) => ({ version: complete.version, record: complete.record, at: complete.at, owner: complete.owner, reservationId: complete.reservationId, target: complete.target }),
    "a partial owner": (complete, owner) => ({ ...complete, owner: { runId: owner.runId } }),
    "an unparseable timestamp": (complete) => ({ ...complete, at: "yesterday" }),
    "an unknown field": (complete) => ({ ...complete, absent: true }),
    "an unbounded reason": (complete) => ({ ...complete, reason: "x".repeat(1025) }),
    "half a device and inode pair": (complete) => ({ ...complete, target: { ...complete.target, inode: null } }),
    "another file as its target": (complete) => ({ ...complete, target: { canonicalFile: `${complete.target.canonicalFile}.other`, device: null, inode: null } }),
    "another owner run's identity": (complete, owner) => ({ ...complete, owner: { ...owner, ownerPid: owner.ownerPid + 1 } }),
  };

  it("refuses every incomplete or mismatched released record, and none of them removes the claim", async () => {
    for (const [wrong, author] of Object.entries(malformedReleases)) {
      const domain = await sessionDirectory();
      const { target, owner, reservationId, committed } = await committedJournal(domain);
      const complete = { version: CANONICAL_JOURNAL_VERSION, record: "released", at: new Date().toISOString(), owner, reservationId, target: committed.target, reason: "explicit release" };
      await appendFile(domain.journalPath, `${JSON.stringify(author(complete, owner))}\n`);

      const next = await openOwner(domain, { hostProof: absentProof() });
      expect(await admitting(next, { operation: "resume", generation: 1, target }), wrong).toMatchObject({ refused: true, code: "ADMISSION_UNAVAILABLE" });
      await expect(next.reservations.reconcile({ canonicalFile: target }), wrong).rejects.toMatchObject({
        name: "CanonicalReservationError",
        code: expect.stringMatching(/^JOURNAL_(UNRECOGNIZED|INCONSISTENT)$/),
      });
      // The malformed line is evidence and stays; the claim it named is still the last word on the file.
      expect((await journalRecords(domain.journalPath)).slice(0, 2).map((record) => record.record), wrong).toEqual(["prepared", "committed"]);
    }
  });

  it("accepts the complete released record the module writes itself", async () => {
    const domain = await sessionDirectory();
    const { target, owner, reservationId, committed } = await committedJournal(domain);
    await appendFile(
      domain.journalPath,
      `${JSON.stringify({ version: CANONICAL_JOURNAL_VERSION, record: "released", at: new Date().toISOString(), owner, reservationId, target: committed.target, reason: "explicit release" })}\n`,
    );

    const next = await openOwner(domain);
    expect(await next.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "released" });
    expect(await admitting(next, { operation: "resume", generation: 1, target })).toMatchObject({ reservationId: expect.any(String) });
  });
});

/**
 * Replay of a history that is schema-valid in every field and still impossible.
 *
 * The live API already refuses each of these: `abortReservation` refuses a committed reservation,
 * `releaseCommitted` refuses an uncommitted one, a commit spends its reservation id, `transfer` only ever
 * releases the claim this owner is bound to, and a clear names the claim it found. None of that helps on
 * **replay**, where the records come from whatever wrote this journal. A second writer that disagrees about
 * this history — or a future version that got one of those preconditions wrong — must not be able to hand a
 * complete record to the fold and have a committed claim disappear.
 *
 * So each case here writes a real journal with the module itself, appends one synthesized record the module
 * would never have written, and requires the same two things: the journal refuses to be folded with
 * `JOURNAL_INCONSISTENT`, and admission on the protected file stays unavailable. A thrown untyped error
 * would not do — the code is what tells a caller this is a disagreeing writer rather than a missing file.
 */
describe("durable replay of an impossible history", () => {
  /** The identity the module records for one real file: its canonicalized path, device and inode. @param {string} file */
  async function claimIdentityOf(file) {
    const resolved = await realpath(file);
    const identity = await stat(resolved, { bigint: true });
    return { canonicalFile: resolved, device: String(identity.dev), inode: String(identity.ino) };
  }

  /** Append one complete record of this schema version, exactly as a writer sharing this journal would.
   * @param {{journalPath:string}} domain @param {Record<string, unknown>} fields */
  async function appendRecord(domain, fields) {
    await appendFile(domain.journalPath, `${JSON.stringify({ version: CANONICAL_JOURNAL_VERSION, at: new Date().toISOString(), ...fields })}\n`);
  }

  /** @param {string} file */
  async function realFile(file) {
    await writeFile(file, "{}\n", { mode: 0o600 });
    return file;
  }

  /**
   * One impossible history per case: it authors the real records, appends the impossible one, and names the
   * file whose claim must survive plus the real records that must still be the journal's prefix.
   * @type {Record<string, (domain: any) => Promise<{protected:string, real:string[]}>>}
   */
  const impossibleHistories = {
    async "an abort of a claim this journal already committed"(domain) {
      const target = await realFile(join(domain.session, "abort-after-commit.jsonl"));
      const host = await openOwner(domain);
      const reservationId = await bind(host, target, 1);
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      await appendRecord(domain, { record: "aborted", owner: host.owner, reservationId, target: records[1].target, reason: "this operation mutated nothing" });
      return { protected: target, real: ["prepared", "committed"] };
    },

    async "a release of a reservation that was never committed"(domain) {
      const target = await realFile(join(domain.session, "release-before-commit.jsonl"));
      const host = await openOwner(domain);
      const admission = await admitting(host, { generation: 1, target });
      expect(admission).toMatchObject({ reservationId: expect.any(String) });
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      await appendRecord(domain, { record: "released", owner: host.owner, reservationId: admission.reservationId, target: records[0].target, reason: "explicit release" });
      return { protected: target, real: ["prepared"] };
    },

    async "a second commit of one reservation, identical to the first"(domain) {
      const target = await realFile(join(domain.session, "commit-twice.jsonl"));
      const host = await openOwner(domain);
      const reservationId = await bind(host, target, 1);
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      await appendRecord(domain, { record: "committed", owner: host.owner, reservationId, generation: records[1].generation, binds: records[1].binds, target: records[1].target });
      return { protected: target, real: ["prepared", "committed"] };
    },

    async "a second transfer of one reservation, identical to the first"(domain) {
      const source = await realFile(join(domain.session, "transfer-twice-source.jsonl"));
      const moved = await realFile(join(domain.session, "transfer-twice-moved.jsonl"));
      const host = await openOwner(domain);
      await bind(host, source, 1);
      const move = await admitting(host, { generation: 1, target: moved });
      host.setGeneration(2);
      await host.reservations.commitBinding({ reservationId: move.reservationId, nextGeneration: 2 });
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      const transferred = records[3];
      expect(transferred.record).toBe("transferred");
      await appendRecord(domain, { record: "transferred", owner: host.owner, reservationId: move.reservationId, generation: transferred.generation, target: transferred.target, released: transferred.released });
      return { protected: moved, real: ["prepared", "committed", "prepared", "transferred"] };
    },

    async "an operator clear naming a reservation the claimed file does not hold"(domain) {
      const target = await realFile(join(domain.session, "clear-wrong-reservation.jsonl"));
      const abandoned = ownerRun({ runId: `run-abandoned-${randomUUID()}` });
      const host = await openOwner(domain, { owner: abandoned });
      const admission = await admitting(host, { generation: 1, target });
      expect(admission).toMatchObject({ reservationId: expect.any(String) });
      // The owner dies here, leaving one uncertain claim an operator could legitimately clear.
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      await appendRecord(domain, {
        record: "cleared",
        owner: ownerRun(),
        clearedOwner: abandoned,
        clearedReservationId: `${admission.reservationId}-not-this-one`,
        target: records[0].target,
        operator: "operator-1",
        reason: "stale claim",
        evidence: "recorded pid is gone on the recorded boot",
      });
      return { protected: target, real: ["prepared"] };
    },

    async "a transfer releasing a file this owner run never bound"(domain) {
      const source = await realFile(join(domain.session, "transfer-source.jsonl"));
      const moved = await realFile(join(domain.session, "transfer-moved.jsonl"));
      const unrelated = await realFile(join(domain.session, "transfer-unrelated.jsonl"));
      const host = await openOwner(domain);
      await bind(host, source, 1);
      const move = await admitting(host, { generation: 1, target: moved });
      expect(move).toMatchObject({ reservationId: expect.any(String) });
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      // Every field is complete and this owner run does hold a binding — just not on the file named here.
      await appendRecord(domain, { record: "transferred", owner: host.owner, reservationId: move.reservationId, generation: 2, target: records[2].target, released: await claimIdentityOf(unrelated) });
      return { protected: source, real: ["prepared", "committed", "prepared"] };
    },

    /**
     * The two non-advancing transfers.
     *
     * `transfer` refuses a `nextGeneration` that does not advance past the claim it is releasing, because a
     * binding that did not move is not a rebind. Without that condition on replay, a record naming the right
     * bound file at a generation the binding never reached still frees that file, which is the one thing a
     * transfer's release is allowed to do and only when it really moved.
     */
    async "a transfer at the same generation as the bound claim it releases"(domain) {
      const bound = await realFile(join(domain.session, "same-generation-bound.jsonl"));
      const moved = await realFile(join(domain.session, "same-generation-moved.jsonl"));
      const host = await openOwner(domain);
      await bind(host, bound, 1);
      const move = await admitting(host, { generation: 1, target: moved });
      expect(move).toMatchObject({ reservationId: expect.any(String) });
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      expect(records[1]).toMatchObject({ record: "committed", generation: 1, binds: true });
      // Right owner, right reservation, right target, and the released identity really is the bound claim.
      // Only the generation is impossible: it is the one the binding already had.
      await appendRecord(domain, { record: "transferred", owner: host.owner, reservationId: move.reservationId, generation: 1, target: records[2].target, released: records[1].target });
      return { protected: bound, real: ["prepared", "committed", "prepared"] };
    },

    async "a transfer at a lower generation than the bound claim it releases"(domain) {
      const bound = await realFile(join(domain.session, "regressing-bound.jsonl"));
      const moved = await realFile(join(domain.session, "regressing-moved.jsonl"));
      const host = await openOwner(domain, { generation: 3 });
      await bind(host, bound, 3);
      const move = await admitting(host, { generation: 3, target: moved });
      expect(move).toMatchObject({ reservationId: expect.any(String) });
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      expect(records[1]).toMatchObject({ record: "committed", generation: 3, binds: true });
      await appendRecord(domain, { record: "transferred", owner: host.owner, reservationId: move.reservationId, generation: 2, target: records[2].target, released: records[1].target });
      return { protected: bound, real: ["prepared", "committed", "prepared"] };
    },

    /**
     * A commit claiming the binding while this owner run is already bound to another file.
     *
     * `commitBinding` derives `binds` rather than being told it: `holdsBinding = bound === undefined ||
     * sameIdentity(bound.target, target)`. So with a binding on another file it writes `binds: false`, and a
     * `true` here is a record the writer could not have produced. Nothing is freed by folding it — the owner
     * ends up holding two `binds: true` claims and `boundClaimIn` then answers with the older one — which is
     * why this one is about the replayed state being coherent rather than about a file being let go.
     *
     * The generation is deliberately the bound claim's own, so this isolates the `binds` derivation: a higher
     * one would also have been routed to `transfer` by the writer, which is a different predicate.
     */
    async "a commit that claims the binding while this owner run is bound to another file"(domain) {
      const bound = await realFile(join(domain.session, "two-bindings-bound.jsonl"));
      const other = await realFile(join(domain.session, "two-bindings-other.jsonl"));
      const host = await openOwner(domain);
      await bind(host, bound, 1);
      const selector = await admitting(host, { operation: "rename", generation: 1, target: other });
      expect(selector).toMatchObject({ reservationId: expect.any(String) });
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      expect(records[1]).toMatchObject({ record: "committed", binds: true });
      await appendRecord(domain, { record: "committed", owner: host.owner, reservationId: selector.reservationId, generation: 1, binds: true, target: records[2].target });
      return { protected: bound, real: ["prepared", "committed", "prepared"] };
    },

    /**
     * An operation id admitted twice for one owner run, then an otherwise perfect transfer.
     *
     * `admit` refuses an operation id it already spent, and `openCanonicalReservations` re-seeds
     * `spentOperationIds` from the journal — but that protects the *next* call, it does not validate a
     * duplicate admission already recorded. Every later record here is exactly what the writer would have
     * written, including a properly advancing transfer, so the duplicate admission is the only impossible
     * thing in the history and it is what frees the bound file.
     */
    async "an operation id admitted a second time for one owner run"(domain) {
      const bound = await realFile(join(domain.session, "duplicate-operation-bound.jsonl"));
      const moved = await realFile(join(domain.session, "duplicate-operation-moved.jsonl"));
      const host = await openOwner(domain);
      await bind(host, bound, 1);
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      const reused = records[0].operationId;
      const reservationId = `reservation-${randomUUID()}`;
      await appendRecord(domain, {
        record: "prepared",
        owner: host.owner,
        operationId: reused,
        reservationId,
        operation: "resume",
        generation: 1,
        requestedTarget: moved,
        target: await claimIdentityOf(moved),
        source: records[1].target,
      });
      await appendRecord(domain, { record: "transferred", owner: host.owner, reservationId, generation: 2, target: await claimIdentityOf(moved), released: records[1].target });
      return { protected: bound, real: ["prepared", "committed", "prepared"] };
    },

    /**
     * A reservation id prepared again after a terminal record spent it.
     *
     * `liveReservation` treats a reservation id as one use for the owner run's lifetime, and a commit or an
     * abort spends it rather than returning it to the pool. The fold only asked whether a claim with that key
     * was *currently* held, so an id whose claim a terminal record removed could be prepared again — and the
     * transfer that followed then freed the bound file. The operation id here is fresh, so this is the
     * reservation-id lifetime and nothing else.
     */
    async "a reservation id prepared again after its abort spent it"(domain) {
      const bound = await realFile(join(domain.session, "reused-reservation-bound.jsonl"));
      const scratch = await realFile(join(domain.session, "reused-reservation-scratch.jsonl"));
      const moved = await realFile(join(domain.session, "reused-reservation-moved.jsonl"));
      const host = await openOwner(domain);
      await bind(host, bound, 1);
      const spent = await admitting(host, { operation: "rename", generation: 1, target: scratch });
      expect(spent).toMatchObject({ reservationId: expect.any(String) });
      await host.reservations.abortReservation({ reservationId: spent.reservationId, reason: "this rename mutated nothing" });
      await host.reservations.close();
      const records = await journalRecords(domain.journalPath);
      expect(records.map((record) => record.record)).toEqual(["prepared", "committed", "prepared", "aborted"]);
      await appendRecord(domain, {
        record: "prepared",
        owner: host.owner,
        operationId: `operation-${randomUUID()}`,
        reservationId: spent.reservationId,
        operation: "resume",
        generation: 1,
        requestedTarget: moved,
        target: await claimIdentityOf(moved),
        source: records[1].target,
      });
      await appendRecord(domain, { record: "transferred", owner: host.owner, reservationId: spent.reservationId, generation: 2, target: await claimIdentityOf(moved), released: records[1].target });
      return { protected: bound, real: ["prepared", "committed", "prepared", "aborted", "prepared"] };
    },
  };

  it("refuses every complete but impossible history, frees no claim, and admits nothing", async () => {
    /** @type {Record<string, {folded:string, admission:string, journal:string[]}>} */
    const observed = {};
    /** @type {Record<string, {folded:string, admission:string, journal:string[]}>} */
    const required = {};
    for (const [history, author] of Object.entries(impossibleHistories)) {
      const domain = await sessionDirectory();
      const { protected: guarded, real } = await author(domain);
      const appended = (await journalRecords(domain.journalPath)).map((record) => record.record);

      // Absence of the recorded owner is proven, so nothing here is merely an unreachable host.
      const next = await openOwner(domain, { hostProof: absentProof() });
      const folded = await next.reservations.reconcile({ canonicalFile: guarded }).then(
        (state) => `folded to ${state.state}`,
        (error) => (error?.name === "CanonicalReservationError" ? error.code : `${error?.name}: ${error?.message}`),
      );
      const decision = /** @type {any} */ (await admitting(next, { operation: "resume", generation: 1, target: guarded }));
      observed[history] = { folded, admission: decision.refused === true ? decision.code : "admitted", journal: appended };
      // The impossible line is evidence and stays, so the real records it followed are still the prefix.
      required[history] = { folded: "JOURNAL_INCONSISTENT", admission: "ADMISSION_UNAVAILABLE", journal: [...real, appended.at(-1) ?? ""] };
    }
    expect(observed).toEqual(required);
  });

  it("replays a real bind, transfer, abort and release exactly as they were written", async () => {
    const domain = await sessionDirectory();
    const source = await realFile(join(domain.session, "replay-source.jsonl"));
    const moved = await realFile(join(domain.session, "replay-moved.jsonl"));
    const scratch = await realFile(join(domain.session, "replay-scratch.jsonl"));
    const host = await openOwner(domain);
    await bind(host, source, 1);
    const move = await admitting(host, { generation: 1, target: moved });
    host.setGeneration(2);
    await host.reservations.commitBinding({ reservationId: move.reservationId, nextGeneration: 2 });
    const selector = await admitting(host, { operation: "rename", generation: 2, target: scratch });
    await host.reservations.abortReservation({ reservationId: selector.reservationId, reason: "this rename mutated nothing" });
    await host.reservations.releaseCommitted({ reservationId: move.reservationId, reason: "the owner is done with this file" });
    await host.reservations.close();

    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual([
      "prepared", "committed", "prepared", "transferred", "prepared", "aborted", "released",
    ]);

    // A fresh owner run folds the whole history: the transfer freed the source, the abort freed the
    // scratch reservation, the release freed the binding, and all three files admit again.
    const next = await openOwner(domain);
    for (const file of [source, moved, scratch]) {
      expect(await next.reservations.reconcile({ canonicalFile: file }), file).toMatchObject({ state: "released" });
      expect(await admitting(next, { operation: "resume", generation: 1, target: file }), file).toMatchObject({ reservationId: expect.any(String) });
    }
  });

  it("replays a transfer that advances the generation by more than one", async () => {
    const domain = await sessionDirectory();
    const bound = await realFile(join(domain.session, "jump-bound.jsonl"));
    const moved = await realFile(join(domain.session, "jump-moved.jsonl"));
    const host = await openOwner(domain);
    await bind(host, bound, 1);
    const move = await admitting(host, { generation: 1, target: moved });
    // Pi's binding supplier reports what it reports. A rebind advances the generation; it does not increment
    // it, so the rule replay enforces has to be "advances past the bound claim" and not "is one more than it".
    host.setGeneration(5);
    await host.reservations.commitBinding({ reservationId: move.reservationId, nextGeneration: 5 });
    await host.reservations.close();

    const records = await journalRecords(domain.journalPath);
    expect(records.map((record) => record.record)).toEqual(["prepared", "committed", "prepared", "transferred"]);
    expect(records[3]).toMatchObject({ record: "transferred", generation: 5, released: { canonicalFile: await realpath(bound) } });

    const next = await openOwner(domain);
    expect(await next.reservations.reconcile({ canonicalFile: bound })).toMatchObject({ state: "released" });
    expect(await next.reservations.reconcile({ canonicalFile: moved })).toMatchObject({ state: "live" });
    expect(await admitting(next, { operation: "resume", generation: 1, target: bound })).toMatchObject({ reservationId: expect.any(String) });
  });

  /**
   * An operation id and a reservation id are one use for **one owner run's** lifetime, not globally.
   *
   * `spentOperationIds` is seeded only from records of the same owner run and `claimKeyOf` keys a claim by
   * `runId:reservationId`, so a second owner run reusing either string is ordinary. The uniqueness this fold
   * enforces has to be scoped the same way, or two independent owners sharing a session directory would
   * block each other over a string collision.
   */
  it("replays one owner run's operation and reservation ids reused by an independent owner run", async () => {
    const domain = await sessionDirectory();
    const first = await realFile(join(domain.session, "shared-ids-first.jsonl"));
    const second = await realFile(join(domain.session, "shared-ids-second.jsonl"));
    const one = await openOwner(domain);
    const reservationId = await bind(one, first, 1);
    await one.reservations.releaseCommitted({ reservationId, reason: "the first owner is done" });
    await one.reservations.close();
    const records = await journalRecords(domain.journalPath);
    expect(records.map((record) => record.record)).toEqual(["prepared", "committed", "released"]);

    // A different owner run, the same two id strings, its own file.
    const other = ownerRun({ runId: `run-independent-${randomUUID()}` });
    const identity = await claimIdentityOf(second);
    await appendRecord(domain, {
      record: "prepared",
      owner: other,
      operationId: records[0].operationId,
      reservationId,
      operation: "startup",
      generation: 1,
      requestedTarget: second,
      target: identity,
      source: null,
    });
    await appendRecord(domain, { record: "committed", owner: other, reservationId, generation: 1, binds: true, target: identity });

    const next = await openOwner(domain);
    expect(await next.reservations.reconcile({ canonicalFile: first })).toMatchObject({ state: "released" });
    expect(await next.reservations.reconcile({ canonicalFile: second })).toMatchObject({ state: "live", owner: expect.objectContaining({ runId: other.runId }) });
    expect(await admitting(next, { operation: "resume", generation: 1, target: second })).toMatchObject({ refused: true, code: "TARGET_HAS_LIVE_WRITER" });
  });
});

describe("crash at each side effect", () => {
  /** @type {Record<string, (target: string) => Promise<void>>} */
  const sideEffects = {
    async prepared() {},
    async create(target) {
      await writeFile(target, "", { mode: 0o600 });
    },
    async copy(target) {
      const source = `${target}.origin`;
      await writeFile(source, "{}\n", { mode: 0o600 });
      await copyFile(source, target);
    },
    async open(target) {
      const handle = await open(target, "w+", 0o600);
      await handle.close();
    },
    async append(target) {
      await writeFile(target, "{}\n", { mode: 0o600 });
      await appendFile(target, "{}\n");
    },
    async unlink(target) {
      await writeFile(target, "{}\n", { mode: 0o600 });
      await unlink(target);
    },
  };

  it("leaves every abandoned side effect uncertain, never released, and never open to a second writer", async () => {
    for (const [stage, effect] of Object.entries(sideEffects)) {
      const domain = await sessionDirectory();
      const target = join(domain.session, `${stage}.jsonl`);
      const crashed = await openOwner(domain);
      const admission = await admitting(crashed, { generation: 1, target });
      expect(admission, stage).toMatchObject({ reservationId: expect.any(String) });
      await effect(target);
      // The owner dies here: no commit, no abort, no release.

      // Absence is proven on the recorded host, and proof of absence is still not a release.
      const next = await openOwner(domain, { hostProof: absentProof() });
      expect(await next.reservations.reconcile({ canonicalFile: target }), stage).toMatchObject({ state: "uncertain", absenceProven: true });
      expect(await admitting(next, { operation: "resume", generation: 1, target }), stage).toMatchObject({
        refused: true,
        code: "TARGET_UNCERTAIN",
      });
      const kinds = (await journalRecords(domain.journalPath)).map((record) => record.record);
      expect(kinds, stage).toEqual(["prepared"]);
    }
  });

  it("stays blocked when a journal write's durability is unknown, and opens no second writer", async () => {
    for (const stage of ["after_prepared_append", "after_prepared_sync"]) {
      const domain = await sessionDirectory();
      const target = join(domain.session, "unknown.jsonl");
      const host = await openOwner(domain, {
        failpoint: async (reached) => {
          if (reached === stage) throw new Error(`injected failure at ${reached}`);
        },
      });
      await expect(host.reservations.admit(operationOn({ generation: 1, target })), stage).resolves.toMatchObject({
        refused: true,
        code: "ADMISSION_UNAVAILABLE",
        message: expect.stringContaining("injected failure"),
      });
      // The record may or may not be on disk, so nothing else is decided from this journal.
      expect(await admitting(host, { generation: 1, target: join(domain.session, "other.jsonl") }), stage).toMatchObject({
        refused: true,
        code: "ADMISSION_UNAVAILABLE",
      });
      expect(await journalRecords(domain.journalPath), stage).toHaveLength(1);
    }
  });

  it("refuses admission on a torn journal tail rather than guessing what the truncated record claimed", async () => {
    const domain = await sessionDirectory();
    const host = await openOwner(domain);
    const admitted = await admitting(host, { generation: 1, target: join(domain.session, "torn.jsonl") });
    expect(admitted).toMatchObject({ reservationId: expect.any(String) });
    await host.reservations.close();
    const torn = `${await readFile(domain.journalPath, "utf8")}{"version":1,"record":"rele`;
    await writeFile(domain.journalPath, torn, { mode: 0o600 });

    const next = await openOwner(domain, { hostProof: absentProof() });
    expect(await admitting(next, { operation: "resume", generation: 1, target: join(domain.session, "torn.jsonl") })).toMatchObject({
      refused: true,
      code: "ADMISSION_UNAVAILABLE",
    });
    await expect(next.reservations.reconcile({ canonicalFile: join(domain.session, "torn.jsonl") })).rejects.toMatchObject({
      code: "JOURNAL_TAIL_INCOMPLETE",
    });
    // The torn record is evidence: it is never truncated away.
    expect(await readFile(domain.journalPath, "utf8")).toBe(torn);
  });

  it("refuses a journal record written to another schema version instead of claiming compatibility", async () => {
    const domain = await sessionDirectory();
    await writeFile(
      domain.journalPath,
      `${JSON.stringify({ version: CANONICAL_JOURNAL_VERSION + 1, record: "prepared", reservationId: "future" })}\n`,
      { mode: 0o600 },
    );
    const host = await openOwner(domain);
    expect(await admitting(host, { generation: 1, target: join(domain.session, "any.jsonl") })).toMatchObject({
      refused: true,
      code: "ADMISSION_UNAVAILABLE",
    });
  });
});

describe("reconciliation and operator recovery", () => {
  /**
   * Author one abandoned claim directly, at an arbitrary recorded time, in this schema version.
   * @param {{session:string,journalPath:string}} domain @param {{at:string, owner?:any}} recorded
   */
  async function abandonedClaim(domain, { at, owner = ownerRun() }) {
    const target = join(domain.session, "abandoned.jsonl");
    await writeFile(target, "{}\n", { mode: 0o600 });
    const resolved = await realpath(target);
    const identity = await stat(resolved, { bigint: true });
    await writeFile(
      domain.journalPath,
      `${JSON.stringify({
        version: CANONICAL_JOURNAL_VERSION,
        record: "prepared",
        at,
        operationId: "operation-abandoned",
        reservationId: "reservation-abandoned",
        operation: "resume",
        owner,
        generation: 1,
        requestedTarget: target,
        target: { canonicalFile: resolved, device: String(identity.dev), inode: String(identity.ino) },
        source: null,
      })}\n`,
      { mode: 0o600 },
    );
    return { target, owner };
  }

  it("keeps an uncertain claim uncertain after arbitrary elapsed time", async () => {
    const domain = await sessionDirectory();
    const { target } = await abandonedClaim(domain, { at: "1999-01-01T00:00:00.000Z" });
    const host = await openOwner(domain, { hostProof: absentProof() });
    expect(await host.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "uncertain" });
    expect(await admitting(host, { operation: "resume", generation: 1, target })).toMatchObject({ code: "TARGET_UNCERTAIN" });
  });

  it("clears an uncertain claim on an explicit operator action with proof from the recorded host, and journals it", async () => {
    const domain = await sessionDirectory();
    const { target } = await abandonedClaim(domain, { at: new Date().toISOString() });
    const host = await openOwner(domain, { hostProof: absentProof() });

    const cleared = await host.reservations.clearUncertainClaim({ canonicalFile: target, operator: "operator-1", reason: "host confirmed gone" });

    expect(cleared).toMatchObject({ cleared: true, evidence: expect.stringContaining("recorded") });
    const record = (await journalRecords(domain.journalPath)).at(-1);
    expect(record).toMatchObject({ record: "cleared", operator: "operator-1", reason: "host confirmed gone", clearedOwner: { hostId: RECORDED_HOST } });
    expect(await admitting(host, { operation: "resume", generation: 1, target })).toMatchObject({ reservationId: expect.any(String) });
  });

  it("takes no requester-asserted absence, and refuses to clear a live or unreachable claim", async () => {
    const domain = await sessionDirectory();
    const { target } = await abandonedClaim(domain, { at: new Date().toISOString() });
    const live = await openOwner(domain, { hostProof: liveProof() });
    await expect(live.reservations.clearUncertainClaim({ canonicalFile: target, operator: "operator-1", reason: "looks dead" })).rejects.toMatchObject({
      code: "CLAIM_NOT_UNCERTAIN",
    });
    const unreachable = await openOwner(domain, { hostProof: unreachableProof() });
    await expect(unreachable.reservations.clearUncertainClaim({ canonicalFile: target, operator: "operator-1", reason: "assume gone" })).rejects.toMatchObject({
      code: "NO_ABSENCE_PROOF",
    });
    // There is no parameter through which a requester could assert the absence itself: the cast is what it
    // takes to even write one, and the call is still refused.
    await expect(
      unreachable.reservations.clearUncertainClaim(/** @type {any} */ ({ canonicalFile: target, operator: "operator-1", reason: "assume gone", absent: true })),
    ).rejects.toThrow(TypeError);
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared"]);
  });

  it("accepts an authoritative boot change on the recorded host and refuses another machine's boot id", async () => {
    const domain = await sessionDirectory();
    const { target } = await abandonedClaim(domain, { at: new Date().toISOString() });
    const otherMachine = await openOwner(domain, {
      hostProof: hostProofOf({ "host-other/boot-other": { proof: "absent", evidence: "another machine rebooted" } }),
    });
    expect(await otherMachine.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "uncertain", absenceProven: false });
    await expect(otherMachine.reservations.clearUncertainClaim({ canonicalFile: target, operator: "operator-1", reason: "other host rebooted" })).rejects.toMatchObject({
      code: "NO_ABSENCE_PROOF",
    });

    const recordedHost = await openOwner(domain, {
      hostProof: hostProofOf({ [`${RECORDED_HOST}/${RECORDED_BOOT}`]: { proof: "absent", evidence: `recorded boot ${RECORDED_BOOT} was replaced` } }),
    });
    expect(await recordedHost.reservations.clearUncertainClaim({ canonicalFile: target, operator: "operator-1", reason: "recorded host rebooted" })).toMatchObject({ cleared: true });
    expect(recordedHost.hostProof.asked).toEqual([{ hostId: RECORDED_HOST, bootId: RECORDED_BOOT, ownerPid: 4242 }]);
  });

  it("keeps an unreachable recorded host's claim uncertain and blocking, with no expiry and no clearing", async () => {
    const domain = await sessionDirectory();
    const { target } = await abandonedClaim(domain, { at: "1999-01-01T00:00:00.000Z" });
    const host = await openOwner(domain, { hostProof: unreachableProof() });
    expect(await host.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "uncertain", absenceProven: false });
    expect(await admitting(host, { operation: "resume", generation: 1, target })).toMatchObject({ code: "TARGET_UNCERTAIN" });
    expect((await journalRecords(domain.journalPath)).map((record) => record.record)).toEqual(["prepared"]);
  });

  it("revalidates the claim under the canonical lock rather than trusting the fold it read first", async () => {
    const domain = await sessionDirectory();
    const target = join(domain.session, "raced.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    const winner = await openOwner(domain);
    // The winner claims the target inside the loser's own lock acquisition: the loser has already read an
    // unclaimed journal and has not published its lock directory yet. Only a fold taken under the lock sees
    // this claim, so an admission decided from the earlier read would admit a second writer.
    let raced = false;
    const loser = await openOwner(domain, {
      hostProof: liveProof(),
      fsOps: {
        ...(await import("node:fs/promises")),
        /** @param {any} path @param {any} options */
        async mkdir(path, options) {
          if (!raced) {
            raced = true;
            await bind(winner, target, 1);
          }
          return mkdir(path, options);
        },
      },
    });
    expect(await loser.reservations.reconcile({ canonicalFile: target })).toMatchObject({ state: "released" });

    expect(await admitting(loser, { operation: "resume", generation: 1, target })).toMatchObject({ code: "TARGET_HAS_LIVE_WRITER" });
    expect(raced).toBe(true);
  });
});

describe("the canonical lock's own recovery", () => {
  /**
   * Publish a lock directory for one canonical file, held by a recorded holder this process is not.
   * @param {{lockPath:string}} domain @param {string} canonicalFile @param {any} holder
   */
  async function publishForeignLock(domain, canonicalFile, holder) {
    const [{ path }] = await orderCanonicalLocks(domain.lockPath, [canonicalFile]);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lock = await acquireLifecycleLock(path, { canonicalFile, ownerRunId: "foreign" }, undefined, { holder });
    return { path, lock };
  }

  it("holds a foreign or identity-free lock record and refuses admission instead of reclaiming it", async () => {
    for (const holder of [
      { pid: 4242, processGroupId: 4242, startIdentity: "9001", hostId: "host-other", bootId: "boot-other" },
      { pid: 4242, processGroupId: 4242, startIdentity: "9001" },
      null,
    ]) {
      const domain = await sessionDirectory();
      const target = join(domain.session, "locked.jsonl");
      await writeFile(target, "", { mode: 0o600 });
      const { lock } = await publishForeignLock(domain, target, holder);
      const host = await openOwner(domain, { hostProof: absentProof() });

      expect(await admitting(host, { generation: 1, target }), JSON.stringify(holder)).toMatchObject({
        refused: true,
        code: "ADMISSION_UNAVAILABLE",
      });
      expect(await journalRecords(domain.journalPath)).toEqual([]);
      await lock.release();
    }
  });

  it("reclaims a lock only when the recorded host and boot prove its holder absent", async () => {
    const domain = await sessionDirectory();
    const target = join(domain.session, "reclaimable.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    const { lock, path } = await publishForeignLock(domain, target, {
      pid: 4242,
      processGroupId: 4242,
      startIdentity: "9001",
      hostId: RECORDED_HOST,
      bootId: RECORDED_BOOT,
    });
    const host = await openOwner(domain, { hostProof: absentProof() });

    expect(await admitting(host, { generation: 1, target })).toMatchObject({ reservationId: expect.any(String) });
    expect(host.hostProof.asked).toEqual([{ hostId: RECORDED_HOST, bootId: RECORDED_BOOT, ownerPid: 4242 }]);
    expect(await lock.release()).toBe(false);
    expect(basename(path).endsWith(".lock")).toBe(true);
  });
});
