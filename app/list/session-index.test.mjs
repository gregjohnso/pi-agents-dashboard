import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeSessionIndex } from "./session-index.mjs";
function saved(id, path = `/sessions/${id}.jsonl`, overrides = {}) {
    return {
        id,
        path,
        cwd: `/projects/${id}`,
        created: new Date("2026-08-25T10:00:00.000Z"),
        modified: new Date("2026-08-25T11:00:00.000Z"),
        messageCount: 2,
        firstMessage: `First message ${id}`,
        allMessagesText: `First message ${id}\nReply`,
        ...overrides,
    };
}
const lexicalSessionFileIdentity = (sessionFile) => resolve(sessionFile);
function live(sessionId, overrides = {}) {
    return {
        schemaVersion: 1,
        revision: 3,
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        canonicalSessionFile: `/sessions/${sessionId}.jsonl`,
        cwd: `/projects/${sessionId}`,
        taskState: "WORKING",
        processState: "LIVE",
        outcome: "NONE",
        activity: { kind: "tool", summary: "bash: test", updatedAt: "2026-08-25T12:00:00.000Z" },
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T12:00:00.000Z",
        ...overrides,
    };
}
describe("mergeSessionIndex", () => {
    it("projects saved Pi sessions without inferring an outcome from message count", () => {
        expect(mergeSessionIndex([saved("saved", "/sessions/a/../saved.jsonl", { name: "Saved name", messageCount: 9 })], [], lexicalSessionFileIdentity)).toEqual([
            expect.objectContaining({
                schemaVersion: 1,
                revision: 0,
                sessionId: "saved",
                sessionFile: "/sessions/a/../saved.jsonl",
                canonicalSessionFile: "/sessions/saved.jsonl",
                cwd: "/projects/saved",
                name: "Saved name",
                taskState: "READY",
                processState: "EXITED",
                outcome: "NONE",
                activity: {
                    kind: "saved_session",
                    summary: "First message saved",
                    updatedAt: "2026-08-25T11:00:00.000Z",
                },
                createdAt: "2026-08-25T10:00:00.000Z",
                updatedAt: "2026-08-25T11:00:00.000Z",
            }),
        ]);
    });
    // One worker per canonical session file: a saved alias and a live record naming the same
    // canonical file must collapse to the single live record, whatever spells the identity.
    it.each([
        ["lexical path normalization", "/real/sessions/../sessions/one.jsonl", "/alias/sessions/one.jsonl", "/real/sessions/one.jsonl", lexicalSessionFileIdentity],
        ["an injected canonical identity", "/aliases/saved-session.jsonl", "/display/live-session.jsonl", "/real/sessions/session.jsonl", undefined],
    ])("merges a saved alias into the authoritative live record by %s", (_label, savedPath, livePath, canonicalPath, identity) => {
        const identities = new Map([[savedPath, canonicalPath], [livePath, canonicalPath], [canonicalPath, canonicalPath]]);
        const sessionFileIdentity = identity ?? ((sessionFile) => identities.get(sessionFile) ?? sessionFile);
        const liveRecord = live("live-id", { sessionFile: livePath, canonicalSessionFile: canonicalPath, name: undefined });
        expect(mergeSessionIndex([saved("saved-id", savedPath, { name: "Name from Pi" })], [liveRecord], sessionFileIdentity)).toEqual([
            expect.objectContaining({
                sessionId: "live-id",
                sessionFile: livePath,
                canonicalSessionFile: canonicalPath,
                name: "Name from Pi",
                processState: "LIVE",
            }),
        ]);
    });
    it("uses one live record for duplicate session IDs", () => {
        const liveRecord = live("duplicate", { sessionFile: "/managed/live.jsonl", canonicalSessionFile: "/managed/live.jsonl" });
        expect(mergeSessionIndex([
            saved("duplicate", "/saved/older.jsonl", { modified: new Date("2026-08-25T09:00:00.000Z") }),
            saved("duplicate", "/saved/newer.jsonl", { modified: new Date("2026-08-25T11:00:00.000Z") }),
        ], [liveRecord], lexicalSessionFileIdentity)).toEqual([liveRecord]);
    });
    it("chooses the newest deterministic saved duplicate when no live record exists", () => {
        const records = mergeSessionIndex([
            saved("duplicate", "/saved/older.jsonl", { modified: new Date("2026-08-25T09:00:00.000Z") }),
            saved("duplicate", "/saved/newer.jsonl", { modified: new Date("2026-08-25T11:00:00.000Z") }),
        ], [], lexicalSessionFileIdentity);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ sessionId: "duplicate", sessionFile: "/saved/newer.jsonl" });
    });
    it("skips malformed saved metadata without rejecting valid sessions", () => {
        const malformed = {
            ...saved("malformed"),
            modified: new Date("invalid"),
        };
        expect(mergeSessionIndex([malformed, saved("valid")], [], lexicalSessionFileIdentity)).toEqual([
            expect.objectContaining({ sessionId: "valid" }),
        ]);
    });
    it("hides child and nested sessions from the top-level index", () => {
        expect(mergeSessionIndex([
            saved("child", "/sessions/child.jsonl", { parentSessionPath: "/sessions/parent.jsonl" }),
            saved("top-level"),
        ], [], lexicalSessionFileIdentity)).toEqual([
            expect.objectContaining({ sessionId: "top-level" }),
        ]);
    });
    it("orders the merged snapshot by updated time then session ID", () => {
        const sameTime = new Date("2026-08-25T11:00:00.000Z");
        const records = mergeSessionIndex([
            saved("b", "/sessions/b.jsonl", { modified: sameTime }),
            saved("a", "/sessions/a.jsonl", { modified: sameTime }),
            saved("old", "/sessions/old.jsonl", { modified: new Date("2026-08-25T09:00:00.000Z") }),
        ], [], lexicalSessionFileIdentity);
        expect(records.map(({ sessionId }) => sessionId)).toEqual(["a", "b", "old"]);
    });
    it("does not mutate saved or live input arrays", () => {
        const savedRecords = Object.freeze([saved("saved")]);
        const liveRecords = Object.freeze([live("live")]);
        mergeSessionIndex(savedRecords, liveRecords, lexicalSessionFileIdentity);
        expect(savedRecords).toHaveLength(1);
        expect(liveRecords).toHaveLength(1);
    });
});
