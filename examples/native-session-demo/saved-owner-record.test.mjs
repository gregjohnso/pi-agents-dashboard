/**
 * The saved owner record, and the one storage decision this demo still makes.
 *
 * SCOPE NOTE: the user superseded the custom-durable-store design with "just use whatever pi's storage system is"
 * (`durable-storage/NATIVE-STORAGE-SCOPE.md`). Pi owns session files and their directory. What remains here is
 * discovery metadata plus one narrow guard: a demo launched from inside a demo session must not inherit the
 * previous owner's TRANSIENT session directory, while an operator's own configured session directory must be
 * honored untouched.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SavedOwnerRecordError,
  createSavedOwnerRecord,
  readSavedOwnerRecords,
  savedOwnerLayout,
  writeSavedOwnerSnapshot,
} from "./saved-owner-record.mjs";
import { sessionDirectoryDecision } from "./owner-launch.mjs";

/** @type {(() => unknown)[]} */
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function recordsHome() {
  const home = await mkdtemp(path.join(tmpdir(), "pia-savedrec-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

const OWNER = { pid: 4242, startIdentity: "identity-4242", processGroupId: 4242 };

describe("Pi's session directory is Pi's decision, with one inherited-plumbing guard", () => {
  it("contributes nothing when nothing is set", () => {
    expect(sessionDirectoryDecision({})).toEqual({ env: {}, decision: "absent" });
  });

  it("preserves an operator's own configured session directory", () => {
    const outcome = sessionDirectoryDecision({ PI_CODING_AGENT_SESSION_DIR: "/home/operator/elsewhere/sessions" });
    expect(outcome.decision).toBe("preserved-operator-setting");
    expect(outcome.env).toEqual({ PI_CODING_AGENT_SESSION_DIR: "/home/operator/elsewhere/sessions" });
  });

  it("drops an old-demo transient directory, whose descriptor anchor is about to disappear", () => {
    const outcome = sessionDirectoryDecision({
      // Exactly the shape the superseded demo produced: the manager's held-descriptor anchor.
      PI_CODING_AGENT_SESSION_DIR: "/proc/999/fd/7/sessions",
      PI_DEMO_CONTROL_SOCKET: "/tmp/pi-nsd-1/s",
    });
    expect(outcome.decision).toBe("dropped-old-demo-transient");
    expect(outcome.env).toEqual({});
  });

  it("treats an ordinary path the same whether or not a demo marker is present", () => {
    // Corrected contract. This previously discriminated on `PI_DEMO_CONTROL_SOCKET`, which the CURRENT
    // native-storage demo also exports - so an operator who set their own session directory and then launched from
    // inside a demo session had it silently discarded. The marker cannot condemn a setting; only the known old
    // plumbing shape can.
    const shared = "/some/where/sessions";
    expect(sessionDirectoryDecision({ PI_CODING_AGENT_SESSION_DIR: shared }).decision).toBe("preserved-operator-setting");
    expect(sessionDirectoryDecision({ PI_CODING_AGENT_SESSION_DIR: shared, PI_DEMO_CONTROL_SOCKET: "/tmp/x/s" }).decision).toBe("preserved-operator-setting");
  });

  it("drops an old-demo transient directory even with no marker in the environment", () => {
    expect(sessionDirectoryDecision({ PI_CODING_AGENT_SESSION_DIR: "/proc/self/fd/12/sessions" }).decision).toBe("dropped-old-demo-transient");
  });
});

describe("a saved owner record is allocated exclusively and never adopted", () => {
  it("creates its own directory and holds it open", async () => {
    const home = await recordsHome();
    const record = await createSavedOwnerRecord({ recordsHome: home, sessionId: "session-1700000000001" });
    cleanup.push(() => record.close());
    expect(record.paths.record).toBe(savedOwnerLayout(home, record.ownerId).record);
    // Metadata only: there is no transcript directory here, because Pi owns that.
    expect(record.paths).not.toHaveProperty("sessions");
  });

  it("refuses to adopt an existing record directory, and writes nothing into it", async () => {
    const home = await recordsHome();
    const first = await createSavedOwnerRecord({ recordsHome: home, sessionId: "session-1700000000002" });
    cleanup.push(() => first.close());
    const witness = path.join(first.paths.ownerRoot, "witness.txt");
    await writeFile(witness, "untouched\n");
    await expect(createSavedOwnerRecord({ recordsHome: home, sessionId: "session-1700000000002", ownerId: first.ownerId }))
      .rejects.toMatchObject({ code: "OWNER_RECORD_EXISTS" });
    expect(await readFile(witness, "utf8")).toBe("untouched\n");
  });

  it("gives two concurrent launches separate records", async () => {
    const home = await recordsHome();
    const [a, b] = await Promise.all([
      createSavedOwnerRecord({ recordsHome: home, sessionId: "session-1700000000003" }),
      createSavedOwnerRecord({ recordsHome: home, sessionId: "session-1700000000004" }),
    ]);
    cleanup.push(() => a.close(), () => b.close());
    expect(a.ownerId).not.toBe(b.ownerId);
    expect(a.paths.record).not.toBe(b.paths.record);
  });

  it("refuses a records home that is a symlink, without following or deleting it", async () => {
    const home = await recordsHome();
    const real = path.join(home, "real");
    const link = path.join(home, "link");
    await mkdir(real, { recursive: true });
    await symlink(real, link);
    await expect(createSavedOwnerRecord({ recordsHome: link, sessionId: "session-x" }))
      .rejects.toMatchObject({ code: "RECORDS_HOME_NOT_A_DIRECTORY" });
  });

  it("refuses a relative or empty records home rather than guessing one", async () => {
    for (const bad of ["", "relative/path", "  "]) {
      await expect(createSavedOwnerRecord({ recordsHome: bad, sessionId: "session-x" })).rejects.toBeInstanceOf(SavedOwnerRecordError);
    }
  });

  it("accepts a long records home, because it is never a socket path", async () => {
    const home = await recordsHome();
    const deep = path.join(home, "a".repeat(90), "b".repeat(90));
    await mkdir(deep, { recursive: true });
    const record = await createSavedOwnerRecord({ recordsHome: deep, sessionId: "session-long" });
    cleanup.push(() => record.close());
    expect(record.paths.record.length).toBeGreaterThan(200);
  });
});

describe("snapshots record what Pi reported, in order, honestly", () => {
  async function record(home, sessionId = "session-1700000000010") {
    const created = await createSavedOwnerRecord({ recordsHome: home, sessionId });
    cleanup.push(() => created.close());
    return created;
  }

  it("acknowledges only after the record is readable, and stores Pi's own path verbatim", async () => {
    const home = await recordsHome();
    const r = await record(home);
    // A path in Pi's own convention, chosen by Pi, not by this module.
    const sessionFile = "/home/fixture/.pi/sessions/--repo--/2026-09-21T00-00-00-000Z_01a0-real.jsonl";

    const ack = await writeSavedOwnerSnapshot(r, {
      sequence: 1,
      owner: OWNER,
      cwd: "/repo",
      facts: { sessionId: "01a0-real", sessionFile, sessionName: "a named session" },
    });
    expect(ack).toMatchObject({ written: true, sequence: 1 });

    const [saved] = await readSavedOwnerRecords(home);
    expect(saved.sessionFile).toBe(sessionFile);
    expect(saved.sessionId).toBe("01a0-real");
    expect(saved.sessionName).toBe("a named session");
    expect(saved.owner).toMatchObject({ pid: 4242, startIdentity: "identity-4242" });
    expect(saved.exit).toBeNull();
    // The dashboard id and Pi's session id are different things.
    expect(saved.dashboardSessionId).not.toBe(saved.sessionId);
  });

  it("never lets an older snapshot replace a newer one", async () => {
    const home = await recordsHome();
    const r = await record(home);
    await writeSavedOwnerSnapshot(r, { sequence: 5, owner: OWNER, cwd: "/repo", facts: { sessionId: "newer", sessionFile: "/x/.pi/sessions/--repo--/newer.jsonl" } });
    const stale = await writeSavedOwnerSnapshot(r, { sequence: 2, owner: OWNER, cwd: "/elsewhere", facts: { sessionId: "older", sessionFile: "/x/.pi/sessions/--repo--/older.jsonl" } });
    expect(stale.written).toBe(false);
    expect(stale.reason).toMatch(/not newer|sequence/iu);
    const [saved] = await readSavedOwnerRecords(home);
    expect(saved.sessionId).toBe("newer");
    expect(saved.cwd).toBe("/repo");
  });

  it("follows Pi to a new session file when the identity changes", async () => {
    const home = await recordsHome();
    const r = await record(home);
    await writeSavedOwnerSnapshot(r, { sequence: 1, owner: OWNER, cwd: "/repo", facts: { sessionId: "id-one", sessionFile: "/x/.pi/sessions/--repo--/one.jsonl" } });
    await writeSavedOwnerSnapshot(r, { sequence: 2, owner: OWNER, cwd: "/repo", facts: { sessionId: "id-two", sessionFile: "/x/.pi/sessions/--repo--/two.jsonl" } });
    const [saved] = await readSavedOwnerRecords(home);
    expect(saved.sessionId).toBe("id-two");
    expect(saved.sessionFile).toBe("/x/.pi/sessions/--repo--/two.jsonl");
  });

  it("stores an observed exit only when there is real wait evidence", async () => {
    const home = await recordsHome();
    const r = await record(home);
    await writeSavedOwnerSnapshot(r, { sequence: 1, owner: OWNER, cwd: "/repo", facts: { sessionId: "id", sessionFile: "/x/.pi/sessions/--repo--/id.jsonl" } });
    expect((await readSavedOwnerRecords(home))[0].exit).toBeNull();
    await writeSavedOwnerSnapshot(r, {
      sequence: 2, owner: OWNER, cwd: "/repo",
      facts: { sessionId: "id", sessionFile: "/x/.pi/sessions/--repo--/id.jsonl" },
      exit: { status: 0, code: 0, signal: null, waitObserved: true, disposition: "graceful" },
    });
    expect((await readSavedOwnerRecords(home))[0].exit).toMatchObject({ code: 0, waitObserved: true });
  });

  it("refuses a descriptor-alias session file rather than recording an unresolvable reference", async () => {
    const home = await recordsHome();
    const r = await record(home);
    await expect(writeSavedOwnerSnapshot(r, {
      sequence: 1, owner: OWNER, cwd: "/repo",
      facts: { sessionId: "id", sessionFile: "/proc/12345/fd/20/sessions/id.jsonl" },
    })).rejects.toMatchObject({ code: "OWNER_RECORD_SESSION_FILE_IS_FD_ALIAS" });
    expect(await readSavedOwnerRecords(home)).toEqual([]);
  });

  it("writes through its held directory, so a replaced path never receives the record", async () => {
    const home = await recordsHome();
    const r = await record(home);
    await writeSavedOwnerSnapshot(r, { sequence: 1, owner: OWNER, cwd: "/repo", facts: { sessionId: "id", sessionFile: "/x/.pi/sessions/--repo--/id.jsonl" } });
    const aside = `${r.paths.ownerRoot}.moved`;
    await (await import("node:fs/promises")).rename(r.paths.ownerRoot, aside);
    await mkdir(r.paths.ownerRoot, { recursive: true, mode: 0o700 });
    const imposter = path.join(r.paths.ownerRoot, "imposter.txt");
    await writeFile(imposter, "not mine\n");

    await writeSavedOwnerSnapshot(r, { sequence: 2, owner: OWNER, cwd: "/repo", facts: { sessionId: "id", sessionFile: "/x/.pi/sessions/--repo--/id.jsonl" } }).catch(() => {});
    // The replacement is untouched, and the committed record is still readable where the directory went.
    expect(await readFile(imposter, "utf8")).toBe("not mine\n");
    expect(await readFile(path.join(aside, "owner.json"), "utf8")).toMatch(/"sequence"/u);
  });

  it("reports a corrupt record as a named failure instead of dropping it", async () => {
    const home = await recordsHome();
    const r = await record(home, "session-1700000000021");
    await writeFile(r.paths.record, "{ this is not json\n");
    const [saved] = await readSavedOwnerRecords(home);
    expect(saved.corrupt).toBe(true);
    expect(saved.failure).toMatch(/corrupt|could not be read/iu);
    expect(saved.sessionId).toBeUndefined();
  });

  it("returns nothing for a records home that does not exist, without creating it", async () => {
    const absent = path.join(await recordsHome(), "never-created");
    expect(await readSavedOwnerRecords(absent)).toEqual([]);
    await expect((await import("node:fs/promises")).stat(absent)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
