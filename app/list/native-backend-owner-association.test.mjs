/**
 * Which owner a saved record belongs to.
 *
 * SCOPE: `durable-storage/NATIVE-STORAGE-SCOPE.md`, supervisor option A. Pi owns storage; this is only about which
 * row a saved *metadata* record may be attached to.
 *
 * The reviewed defect: records were collapsed by `dashboardSessionId`, which is nothing but the runtime-root
 * basename, and the highest sequence won across different owners. Two owners under different runtime homes — or a
 * legitimately recreated root — therefore collided, and an older owner at sequence 20 could attach its transcript
 * to a brand-new live owner at sequence 2.
 *
 * A sequence orders ONE owner's own snapshots and means nothing between owners, so these cases pin association on
 * durable owner identity instead, and pin that saved rows can never route a control operation to a live owner.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNativeBackend } from "./native-backend.mjs";
import { createSavedOwnerRecord, writeSavedOwnerSnapshot } from "../../examples/native-session-demo/saved-owner-record.mjs";

/** @type {(() => unknown)[]} */
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function disposable(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** One committed saved record for a given runtime root and owner identity. */
async function savedRecordFor({ recordsHome, sessionId, runtimeRoot, owner, sequence, sessionFile, sessionName }) {
  const record = await createSavedOwnerRecord({ recordsHome, sessionId, runtimeRoot });
  for (let n = 1; n <= sequence; n += 1) {
    await writeSavedOwnerSnapshot(record, {
      sequence: n,
      owner,
      cwd: "/repo",
      facts: { sessionId: `pi-${owner.startIdentity}`, sessionFile, sessionName },
    });
  }
  const ownerId = record.ownerId;
  await record.close();
  return { ownerId };
}

/** A live runtime root whose status this backend will be given. */
async function liveRoot(runtimeHome, name) {
  const root = path.join(runtimeHome, name);
  await mkdir(root, { recursive: true });
  return root;
}

function statusFor({ root, pid, startIdentity, durableOwnerId, sessionFile, sessionId }) {
  return {
    root,
    owner: { pid, startIdentity, processGroupId: pid },
    geometry: { cols: 100, rows: 30 },
    geometryRevision: 1,
    attachments: [],
    exit: null,
    reaped: null,
    projectCwd: "/repo",
    readiness: [{ phase: "native-mounted" }],
    presentations: [],
    durable: durableOwnerId === undefined ? null : { ownerId: durableOwnerId, recordsHome: "x", ownerRoot: "x", record: "x", committedSequence: 1, failure: null },
    bridge: { connected: true, facts: { agentPhase: "settled", idle: true, pendingMessages: false, ...(sessionFile === undefined ? {} : { sessionFile }), ...(sessionId === undefined ? {} : { sessionId }) } },
  };
}

/** A backend whose control answers are supplied per root, so no owner is spawned. */
function backendWith({ sessionsHome, stateHome, statusByRoot }) {
  const client = createNativeBackend({
    sessionsHome,
    stateHome,
    listModels: async () => "provider  model",
    askControl: async (root) => {
      const status = statusByRoot[root];
      return status === undefined ? { reachable: false, reason: "no control socket" } : { reachable: true, answer: { status } };
    },
  });
  cleanup.push(() => client.close());
  return client;
}

describe("a saved record is joined only to the owner it actually belongs to", () => {
  it("keeps two owners apart when their runtime roots share a basename", async () => {
    const recordsHome = await disposable("pia-assoc-rec-");
    const homeA = await disposable("pia-assoc-a-");
    const homeB = await disposable("pia-assoc-b-");
    const name = "session-1700000000001";
    const rootA = await liveRoot(homeA, name);
    const rootB = path.join(homeB, name);
    const a = await savedRecordFor({ recordsHome, sessionId: name, runtimeRoot: rootA, owner: { pid: 11, startIdentity: "id-a" }, sequence: 2, sessionFile: "/pi/a.jsonl", sessionName: "owner A" });
    const b = await savedRecordFor({ recordsHome, sessionId: name, runtimeRoot: rootB, owner: { pid: 22, startIdentity: "id-b" }, sequence: 20, sessionFile: "/pi/b.jsonl", sessionName: "owner B" });

    // Only home A is listed, and its live owner is A.
    const client = backendWith({
      sessionsHome: homeA,
      stateHome: recordsHome,
      statusByRoot: { [rootA]: statusFor({ root: rootA, pid: 11, startIdentity: "id-a", durableOwnerId: a.ownerId, sessionFile: "/pi/a.jsonl", sessionId: "pi-id-a" }) },
    });
    const { sessions } = await client.getState();

    const live = sessions.find((row) => row.sessionId === name);
    expect(live).toBeDefined();
    // Owner B's higher sequence must NOT capture owner A's live row.
    expect(live.canonicalSessionFile).toBe("/pi/a.jsonl");
    expect(live.name).not.toBe("owner B");
    // And B survives as its own distinct saved row rather than being collapsed away.
    const savedB = sessions.filter((row) => row.durable?.savedOnly === true && row.durable?.ownerId === b.ownerId);
    expect(savedB).toHaveLength(1);
    expect(savedB[0].sessionId).not.toBe(name);
  });

  it("does not let an old owner at sequence 20 attach to a new owner on a recreated root", async () => {
    const recordsHome = await disposable("pia-assoc-rec2-");
    const runtimeHome = await disposable("pia-assoc-rt2-");
    const name = "session-1700000000002";
    const root = await liveRoot(runtimeHome, name);
    const old = await savedRecordFor({ recordsHome, sessionId: name, runtimeRoot: root, owner: { pid: 101, startIdentity: "id-old" }, sequence: 20, sessionFile: "/pi/old.jsonl", sessionName: "the old owner" });
    const fresh = await savedRecordFor({ recordsHome, sessionId: name, runtimeRoot: root, owner: { pid: 202, startIdentity: "id-new" }, sequence: 2, sessionFile: "/pi/new.jsonl", sessionName: "the new owner" });

    const client = backendWith({
      sessionsHome: runtimeHome,
      stateHome: recordsHome,
      statusByRoot: { [root]: statusFor({ root, pid: 202, startIdentity: "id-new", durableOwnerId: fresh.ownerId, sessionFile: "/pi/new.jsonl", sessionId: "pi-id-new" }) },
    });
    const { sessions } = await client.getState();
    const live = sessions.find((row) => row.sessionId === name);

    // The live row belongs to the NEW owner, whatever sequence the old record reached.
    expect(live.canonicalSessionFile).toBe("/pi/new.jsonl");
    expect(live.durable?.ownerId).toBe(fresh.ownerId);
    expect(live.name).not.toBe("the old owner");
    // The old owner is still discoverable, as its own row.
    expect(sessions.some((row) => row.durable?.ownerId === old.ownerId && row.durable?.savedOnly === true)).toBe(true);
  });

  it("refuses to join a record whose owner identity disagrees with the live owner", async () => {
    const recordsHome = await disposable("pia-assoc-rec3-");
    const runtimeHome = await disposable("pia-assoc-rt3-");
    const name = "session-1700000000003";
    const root = await liveRoot(runtimeHome, name);
    const stranger = await savedRecordFor({ recordsHome, sessionId: name, runtimeRoot: root, owner: { pid: 999, startIdentity: "id-stranger" }, sequence: 9, sessionFile: "/pi/stranger.jsonl", sessionName: "a stranger" });

    // The live owner reports a DIFFERENT durable owner id than the saved record.
    const client = backendWith({
      sessionsHome: runtimeHome,
      stateHome: recordsHome,
      statusByRoot: { [root]: statusFor({ root, pid: 303, startIdentity: "id-live", durableOwnerId: "00000000-0000-4000-8000-000000000000", sessionFile: "/pi/live.jsonl", sessionId: "pi-id-live" }) },
    });
    const { sessions } = await client.getState();
    const live = sessions.find((row) => row.sessionId === name);

    expect(live.canonicalSessionFile).toBe("/pi/live.jsonl");
    expect(live.name).not.toBe("a stranger");
    expect(sessions.some((row) => row.durable?.ownerId === stranger.ownerId && row.durable?.savedOnly === true)).toBe(true);
  });

  it("prefers the current live Pi session over a saved previous-session pointer", async () => {
    const recordsHome = await disposable("pia-assoc-rec4-");
    const runtimeHome = await disposable("pia-assoc-rt4-");
    const name = "session-1700000000004";
    const root = await liveRoot(runtimeHome, name);
    const mine = await savedRecordFor({ recordsHome, sessionId: name, runtimeRoot: root, owner: { pid: 404, startIdentity: "id-mine" }, sequence: 3, sessionFile: "/pi/previous-session.jsonl", sessionName: "before /new" });

    // Same owner, but Pi has since switched session: its live facts name a different file.
    const client = backendWith({
      sessionsHome: runtimeHome,
      stateHome: recordsHome,
      statusByRoot: { [root]: statusFor({ root, pid: 404, startIdentity: "id-mine", durableOwnerId: mine.ownerId, sessionFile: "/pi/current-session.jsonl", sessionId: "pi-current" }) },
    });
    const live = (await client.getState()).sessions.find((row) => row.sessionId === name);

    // The current Pi identity wins; an old pointer is never attached to a newly switched session.
    expect(live.canonicalSessionFile).toBe("/pi/current-session.jsonl");
    expect(live.sessionFile).toBe("/pi/current-session.jsonl");
  });
});

describe("a saved row can never route an operation to a live owner", () => {
  async function savedOnlyRow() {
    const recordsHome = await disposable("pia-assoc-rec5-");
    const runtimeHome = await disposable("pia-assoc-rt5-");
    const name = "session-1700000000005";
    // A live owner exists under that very basename, so a mistaken route would hit a real session.
    const root = await liveRoot(runtimeHome, name);
    const gone = await savedRecordFor({ recordsHome, sessionId: name, runtimeRoot: path.join("/tmp/removed-runtime", name), owner: { pid: 505, startIdentity: "id-gone" }, sequence: 4, sessionFile: "/pi/gone.jsonl", sessionName: "a saved owner" });
    /** @type {string[]} */
    const controlCalls = [];
    const client = createNativeBackend({
      sessionsHome: runtimeHome,
      stateHome: recordsHome,
      listModels: async () => "provider  model",
      askControl: async (target, frame) => {
        controlCalls.push(`${frame.type}:${target}`);
        return target === root
          ? { reachable: true, answer: { status: statusFor({ root, pid: 606, startIdentity: "id-live", durableOwnerId: "11111111-1111-4111-8111-111111111111", sessionFile: "/pi/live.jsonl", sessionId: "pi-live" }) } }
          : { reachable: false, reason: "no control socket" };
      },
    });
    cleanup.push(() => client.close());
    const { sessions } = await client.getState();
    const savedRow = sessions.find((row) => row.durable?.ownerId === gone.ownerId && row.durable?.savedOnly === true);
    controlCalls.length = 0;
    return { client, savedRow, liveRootPath: root, controlCalls };
  }

  it("gives the saved row an id that is not a runtime-root basename", async () => {
    const { savedRow } = await savedOnlyRow();
    expect(savedRow).toBeDefined();
    expect(savedRow.sessionId).not.toBe("session-1700000000005");
    expect(/^session-\d{10,}$/u.test(savedRow.sessionId)).toBe(false);
  });

  it("refuses rootFor on a saved row instead of resolving a live root", async () => {
    const { client, savedRow, liveRootPath } = await savedOnlyRow();
    let resolved;
    try {
      resolved = client.rootFor(savedRow.sessionId);
    } catch (error) {
      expect(error.code).toBe("SAVED_ROW_HAS_NO_RUNTIME_ROOT");
      return;
    }
    // If it does not throw it must at least never name the live owner's root.
    expect(resolved).not.toBe(liveRootPath);
    throw new Error(`rootFor resolved a saved row to ${resolved} instead of refusing`);
  });

  it("refuses stop and rename on a saved row, with no control call to the live owner", async () => {
    const { client, savedRow, controlCalls } = await savedOnlyRow();
    await expect(client.stop(savedRow.sessionId, savedRow.revision, "r1")).rejects.toMatchObject({ code: "SAVED_ROW_NOT_ACTIONABLE" });
    await expect(client.rename(savedRow.sessionId, savedRow.revision, "r2", "a new name")).rejects.toMatchObject({ code: "SAVED_ROW_NOT_ACTIONABLE" });
    // The decisive part: nothing was asked of any owner.
    expect(controlCalls).toEqual([]);
  });
});
