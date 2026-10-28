/**
 * What a fresh dashboard can see after the manager that wrote the record is gone.
 *
 * SCOPE NOTE: the user superseded the custom-durable-store design with "just use whatever pi's storage system is"
 * (see `durable-storage/NATIVE-STORAGE-SCOPE.md`). Pi owns session files, their naming and the directory they live
 * in. These cases therefore stand Pi's own file where Pi would put it — under a private Pi CONFIGURATION home, in
 * Pi's own `<agent dir>/agent/sessions` shape — and check that the dashboard records and rediscovers that path
 * rather than inventing one. Nothing here allocates a transcript namespace.
 *
 * The two ways this could lie are pinned: a saved row must not become `LIVE` merely to escape the default view
 * filter, and it must not claim an exit that was never observed.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNativeBackend } from "./native-backend.mjs";
import { createSavedOwnerRecord, writeSavedOwnerSnapshot } from "../../examples/native-session-demo/saved-owner-record.mjs";
import { displaySessionState } from "./session-state.mjs";
import { selectDashboardSessions } from "./dashboard-state.mjs";

/** @type {(() => unknown)[]} */
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const OWNER = { pid: 5150, startIdentity: "identity-5150", processGroupId: 5150 };

/**
 * A manager that ran, recorded what Pi reported, and then went away entirely.
 *
 * The session file is placed in Pi's own convention under a private Pi config home, which is where Pi puts it when
 * its configuration selects that home. The records home is a separate directory holding metadata only.
 */
async function savedSessionOnDisk({ exit = null, removeWholeRuntimeHome = false } = {}) {
  const recordsHome = await mkdtemp(path.join(tmpdir(), "pia-rec-"));
  const piConfigHome = await mkdtemp(path.join(tmpdir(), "pia-piconfig-"));
  const runtimeHome = await mkdtemp(path.join(tmpdir(), "pia-rt-"));
  cleanup.push(() => rm(recordsHome, { recursive: true, force: true }));
  cleanup.push(() => rm(piConfigHome, { recursive: true, force: true }));
  cleanup.push(() => rm(runtimeHome, { recursive: true, force: true }));
  const sessionId = "session-1700000000900";
  const runtimeRoot = path.join(runtimeHome, sessionId);
  await mkdir(runtimeRoot, { recursive: true });

  // Pi's own layout, observed from the pinned build rather than guessed: it keys sessions by project directory,
  // as <agent dir>/sessions/<project slug>/<timestamp>_<uuid>.jsonl. An earlier guess of `agent/sessions` is
  // retained in the failed launcher log under durable-storage/logs/.
  const piSessions = path.join(piConfigHome, ".pi", "sessions", "--fixture-project--");
  await mkdir(piSessions, { recursive: true });
  const sessionFile = path.join(piSessions, "2026-09-21T00-00-00-000Z_01a0-saved.jsonl");
  await writeFile(sessionFile, '{"type":"user","content":"a unique prompt"}\n{"type":"assistant","content":"a unique answer"}\n');

  const record = await createSavedOwnerRecord({ recordsHome, sessionId, runtimeRoot });
  const ownerId = record.ownerId;
  await writeSavedOwnerSnapshot(record, {
    sequence: 1,
    owner: OWNER,
    cwd: "/repo/project",
    facts: { sessionId: "01a0-saved", sessionFile, sessionName: "a saved session" },
    ...(exit === null ? {} : { exit, stopped: true }),
  });
  await record.close();

  if (removeWholeRuntimeHome) await rm(runtimeHome, { recursive: true, force: true });
  else await rm(runtimeRoot, { recursive: true, force: true });

  // Saved rows are addressed by durable OWNER identity, not by the runtime-root basename: that basename may belong
  // to a different live owner, so a saved row carries a `saved:` id that no action can mistake for a runtime root.
  return { recordsHome, runtimeHome, piConfigHome, sessionId, sessionFile, ownerId, savedRowId: `saved:${ownerId}` };
}

/** A brand-new backend, as a freshly started dashboard would build. */
function freshBackend({ sessionsHome, stateHome }) {
  const client = createNativeBackend({ sessionsHome, stateHome, listModels: async () => "provider  model" });
  cleanup.push(() => client.close());
  return client;
}

describe("a fresh dashboard rediscovers Pi's own session file without the runtime root", () => {
  it("lists the saved row pointing at Pi's real file when the runtime directory is gone", async () => {
    const saved = await savedSessionOnDisk();
    const client = freshBackend({ sessionsHome: saved.runtimeHome, stateHome: saved.recordsHome });

    const { sessions } = await client.getState();
    const row = sessions.find((candidate) => candidate.sessionId === saved.savedRowId);
    expect(row).toBeDefined();
    // Exactly what Pi reported, in Pi's own layout. Not a placeholder, not a descriptor alias.
    expect(row.canonicalSessionFile).toBe(saved.sessionFile);
    expect(row.canonicalSessionFile).toContain(`${path.sep}.pi${path.sep}sessions${path.sep}`);
    expect(path.basename(row.canonicalSessionFile)).not.toBe("session.jsonl");
    expect(row.canonicalSessionFile).not.toMatch(/\/proc\/(?:\d+|self)\/fd\//u);
    // And it is actually readable, which is the point.
    expect(await readFile(row.canonicalSessionFile, "utf8")).toContain("a unique answer");
    expect(row.name).toBe("a saved session");
    expect(row.cwd).toBe("/repo/project");
    expect(row.durable.savedOnly).toBe(true);
    // The record holds metadata only: it does not mirror Pi's history model.
    expect(row.durable.transcripts).toBeUndefined();
  });

  it("finds it even when the whole runtime sessions home no longer exists", async () => {
    const saved = await savedSessionOnDisk({ removeWholeRuntimeHome: true });
    const client = freshBackend({ sessionsHome: saved.runtimeHome, stateHome: saved.recordsHome });
    const row = (await client.getState()).sessions.find((c) => c.sessionId === saved.savedRowId);
    expect(row).toBeDefined();
    expect(await readFile(row.canonicalSessionFile, "utf8")).toContain("a unique prompt");
  });

  it("is STALE and not live when no exit was observed, and is reached through the existing all view", async () => {
    const saved = await savedSessionOnDisk();
    const client = freshBackend({ sessionsHome: saved.runtimeHome, stateHome: saved.recordsHome });
    const row = (await client.getState()).sessions.find((c) => c.sessionId === saved.savedRowId);

    // A saved record is not evidence that its writer is dead, and never evidence that it is alive.
    expect(row.processState).toBe("STALE");
    expect(row.processState).not.toBe("LIVE");
    expect(row.processState).not.toBe("EXITED");
    expect(row.taskState).not.toBe("FAILED");
    expect(row.taskState).not.toBe("STOPPED");
    expect(displaySessionState(row)).toBe("STALE");
    expect(row.activity.summary).toMatch(/could not be confirmed/u);
    // Documented consequence: STALE is outside the default live view and needs the existing view filter.
    expect(selectDashboardSessions([row], { view: "live" })).toHaveLength(0);
    expect(selectDashboardSessions([row], { view: "all" })).toHaveLength(1);
  });

  it("reports an observed stop exit, which survives a frontend restart", async () => {
    const saved = await savedSessionOnDisk({ exit: { status: 0, code: 0, signal: null, waitObserved: true, disposition: "graceful" } });
    const first = freshBackend({ sessionsHome: saved.runtimeHome, stateHome: saved.recordsHome });
    const firstRow = (await first.getState()).sessions.find((c) => c.sessionId === saved.savedRowId);
    const second = freshBackend({ sessionsHome: saved.runtimeHome, stateHome: saved.recordsHome });
    const secondRow = (await second.getState()).sessions.find((c) => c.sessionId === saved.savedRowId);

    for (const row of [firstRow, secondRow]) {
      expect(row.processState).toBe("EXITED");
      expect(displaySessionState(row)).toBe("STOPPED");
      expect(row.activity.summary).toMatch(/owner exited 0/u);
    }
    expect(secondRow.durable.sequence).toBe(firstRow.durable.sequence);
  });

  it("follows Pi to a new session file when the identity changes, leaving the earlier file untouched", async () => {
    const recordsHome = await mkdtemp(path.join(tmpdir(), "pia-rec-ids-"));
    const piConfigHome = await mkdtemp(path.join(tmpdir(), "pia-piconfig-ids-"));
    const runtimeHome = await mkdtemp(path.join(tmpdir(), "pia-rt-ids-"));
    cleanup.push(() => rm(recordsHome, { recursive: true, force: true }), () => rm(piConfigHome, { recursive: true, force: true }), () => rm(runtimeHome, { recursive: true, force: true }));
    const piSessions = path.join(piConfigHome, ".pi", "sessions", "--fixture-project--");
    await mkdir(piSessions, { recursive: true });
    const before = path.join(piSessions, "2026-09-21T00-00-00-000Z_id-before.jsonl");
    const after = path.join(piSessions, "2026-09-21T00-05-00-000Z_id-after.jsonl");
    await writeFile(before, '{"type":"user","content":"before /new"}\n');
    await writeFile(after, '{"type":"user","content":"after /new"}\n');

    const record = await createSavedOwnerRecord({ recordsHome, sessionId: "session-1700000000901", runtimeRoot: path.join(runtimeHome, "session-1700000000901") });
    const ownerId = record.ownerId;
    await writeSavedOwnerSnapshot(record, { sequence: 1, owner: OWNER, cwd: "/repo", facts: { sessionId: "id-before", sessionFile: before } });
    await writeSavedOwnerSnapshot(record, { sequence: 2, owner: OWNER, cwd: "/repo", facts: { sessionId: "id-after", sessionFile: after } });
    await record.close();

    const client = freshBackend({ sessionsHome: runtimeHome, stateHome: recordsHome });
    const row = (await client.getState()).sessions.find((c) => c.sessionId === `saved:${ownerId}`);
    // The row follows Pi's current identity, and Pi's earlier file is left exactly as Pi wrote it.
    expect(row.canonicalSessionFile).toBe(after);
    expect(await readFile(before, "utf8")).toContain("before /new");
    expect(await readFile(after, "utf8")).toContain("after /new");
    // One dashboard owner, several Pi identities: the dashboard id is not the Pi session id.
    expect(row.sessionId).not.toBe(row.durable.piSessionId);
    expect(row.durable.piSessionId).toBe("id-after");
  });

  it("surfaces an unreadable record as a named failure rather than an absent session", async () => {
    const saved = await savedSessionOnDisk();
    const ownersRoot = path.join(saved.recordsHome, "owners");
    const [ownerId] = await readdir(ownersRoot);
    await writeFile(path.join(ownersRoot, ownerId, "owner.json"), "{ not json\n");

    const client = freshBackend({ sessionsHome: saved.runtimeHome, stateHome: saved.recordsHome });
    const { sessions } = await client.getState();
    const broken = sessions.find((candidate) => candidate.durable?.corrupt === true);
    expect(broken).toBeDefined();
    expect(broken.activity.summary).toMatch(/durable record unreadable/u);
    expect(broken.processState).toBe("STALE");
    // The owner appears exactly ONCE, as the named failure. It is not also listed as a healthy saved session, and
    // because saved rows are keyed by owner identity that single row is the corrupt one rather than a second entry.
    const forThisOwner = sessions.filter((c) => c.sessionId === saved.savedRowId);
    expect(forThisOwner).toHaveLength(1);
    expect(forThisOwner[0].durable?.corrupt).toBe(true);
    expect(forThisOwner[0].canonicalSessionFile).not.toBe(saved.sessionFile);
  });

  it("reads and writes no records at all when no records home is configured", async () => {
    const saved = await savedSessionOnDisk();
    const client = freshBackend({ sessionsHome: saved.runtimeHome });
    const { sessions } = await client.getState();
    // Legacy behaviour: only runtime directories are listed, and the deleted one is simply absent.
    expect(sessions.find((candidate) => candidate.durable !== undefined)).toBeUndefined();
    expect(sessions.find((candidate) => candidate.sessionId === saved.savedRowId)).toBeUndefined();
  });
});
