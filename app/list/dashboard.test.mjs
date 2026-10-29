import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DashboardController } from "./dashboard.mjs";
import { JOBWATCH_ANSI } from "./dashboard-theme.mjs";
import { createDashboardLayout } from "./dashboard-layout.mjs";
const timestamp = "2026-08-25T12:00:00.000Z";
function session(id, overrides = {}) {
    return {
        schemaVersion: 1,
        revision: 1,
        sessionId: id,
        sessionFile: `/sessions/${id}.jsonl`,
        canonicalSessionFile: `/sessions/${id}.jsonl`,
        cwd: `/projects/${id}`,
        model: { provider: "anthropic", id: "claude" },
        thinkingLevel: "high",
        name: id,
        taskState: "READY",
        processState: "LIVE",
        outcome: "NONE",
        activity: { kind: "assistant_final", summary: id, updatedAt: timestamp },
        createdAt: timestamp,
        updatedAt: timestamp,
        ...overrides,
    };
}
let coverageSequence = 0;
/** The daemon's in-memory snapshot coverage cursor, which every successful get_state must carry. */
function nextCoverage() {
    coverageSequence += 1;
    return { daemonEpoch: "epoch", sequence: String(coverageSequence) };
}
class FakeDaemonClient {
    snapshot;
    /** The dashboard's invalidation callback; calling it returns the read it drives. */
    notifyListChanged;
    errorListener;
    unsubscribed = 0;
    reads = 0;
    subscriptions = 0;
    requests = [];
    stop = vi.fn();
    delete = vi.fn();
    constructor(sessions) {
        this.snapshot = { sessions, cursor: nextCoverage() };
    }
    /** @param {readonly any[]} sessions */
    setSessions(sessions) { this.snapshot = { sessions, cursor: nextCoverage() }; }
    async getState() {
        this.reads += 1;
        // The daemon reads its coverage cursor and rows before it answers, so a change published
        // while the response is in flight is not in this snapshot.
        const snapshot = this.snapshot;
        await this.duringRead?.(this.reads);
        return snapshot;
    }
    async subscribeListChanges(onChanged, onError) {
        this.subscriptions += 1;
        this.notifyListChanged = onChanged;
        this.errorListener = onError;
        if (this.subscribeFailure !== undefined) throw this.subscribeFailure;
        return () => { this.unsubscribed += 1; };
    }
    /** Live sessions the daemon reports already working in the requested shared directory. */
    sharedOwners = ["other"];
    async preflightLaunch(draft) {
        return { canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: draft.isolationMode === "shared_directory" ? this.sharedOwners : [] };
    }
    async launch(request) {
        this.requests.push(request);
        return { kind: "launched", sessionId: "launched" };
    }
    async getModels() { return []; }
    async refreshSummaries() { return []; }
}
const openViewer = vi.fn(async () => {});
function controller(client, overrides = {}) {
    return new DashboardController({
        client,
        openViewer,
        clientId: "stable-client",
        sourceSessionId: "source",
        launchDefaults: { cwd: "/repo", model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high", name: "new task" },
        requestRender: vi.fn(),
        // These cases launch from synthetic directories. The real Git probe runs against real
        // repositories in "worktree capability" below.
        worktreeCapability: async () => ({ available: true }),
        ...overrides,
    });
}
/**
 * A destructive client call that refuses to see the same request ID carry two different payloads,
 * so a re-aimed revision that reuses its ID is a conflict rather than a silent second command.
 */
function journalledDestructive(refuse) {
    const revisionsById = new Map();
    const requestIds = [];
    return {
        requestIds,
        async call(_sessionId, revision, requestId) {
            requestIds.push(requestId);
            const recorded = revisionsById.get(requestId);
            if (recorded !== undefined && recorded !== revision)
                throw Object.assign(new Error("Request IDs were already used with a different command"), { code: "IDEMPOTENCY_CONFLICT" });
            revisionsById.set(requestId, revision);
            refuse(revision);
            return { accepted: true };
        },
    };
}
/** Publish one list change the way the daemon does: mutate state, then invalidate. */
async function applyListChange(dashboard, client, sessions) {
    if (sessions !== undefined) client.setSessions(sessions);
    await client.notifyListChanged();
    dashboard.render();
}
describe("dashboard controller", () => {
    it("keeps selection by canonical session ID through live reorder and resize", async () => {
        const client = new FakeDaemonClient([session("a"), session("b"), session("c")]);
        const dashboard = controller(client);
        await dashboard.open();
        dashboard.handleInput("\x1b[B");
        expect(dashboard.selectedSessionId).toBe("b");
        await applyListChange(dashboard, client, [session("c"), session("a"), session("b", { revision: 2 })]);
        dashboard.resize(40, 8);
        expect(dashboard.selectedSessionId).toBe("b");
    });
    it("keeps virtualized navigation index-safe with groups, pages, ends, resize, and mouse clicks", async () => {
        const sessions = Array.from({ length: 10_000 }, (_, index) => session(`s-${String(index).padStart(5, "0")}`, { taskState: index % 2 ? "READY" : "WORKING" }));
        const dashboard = controller(new FakeDaemonClient(sessions));
        await dashboard.open();
        dashboard.setGrouping("taskState");
        dashboard.resize(80, 14);
        dashboard.handleInput("\x1b[6~");
        dashboard.handleInput("\x1b[F");
        expect(dashboard.selectedSessionId).toBe("s-09999");
        dashboard.handleMouse({ row: 6, column: 2, button: "left" });
        expect(dashboard.selectedSessionId).not.toBe("s-09999");
        expect(dashboard.render(80, 14).length).toBeLessThanOrEqual(14);
    });
    it("asks the daemon to refresh Activity summaries after open, not on the path that returns to the list", async () => {
        const client = new FakeDaemonClient([session("a")]);
        client.refreshSummaries = vi.fn(async () => ["a"]);
        const dashboard = controller(client);
        await dashboard.open();
        expect(dashboard.status).toEqual({ kind: "ready" });
        expect(client.refreshSummaries).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(client.refreshSummaries).toHaveBeenCalledTimes(1), { timeout: 5_000 });
        dashboard.refreshSummaries();
        await vi.waitFor(() => expect(client.refreshSummaries).toHaveBeenCalledTimes(2));
    });
    // A confirmed double-tap hands the stop off without blocking input.
    it("hands a destructive request off in the background and never wedges input behind it", async () => {
        let release = () => {};
        const client = new FakeDaemonClient([session("a", { processState: "LIVE" })]);
        client.stop = vi.fn(() => new Promise((resolve) => { release = () => resolve({ accepted: true }); }));
        const dashboard = controller(client);
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        expect(client.stop).not.toHaveBeenCalled();
        dashboard.handleInput("\x18");
        // The stop travels in the background: the operator gets the list back without waiting for the daemon.
        expect(dashboard.overlay).toBeUndefined();
        expect(client.stop).toHaveBeenCalledWith("a", 1, expect.any(String));
        expect(dashboard.status).toMatchObject({ kind: "pending" });
        dashboard.handleInput("\x1b[B");
        expect(dashboard.focus).toBe("list");
        release();
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
    });
    it("clears the prompt on Ctrl+C and closes the list only on a second press inside 500 ms", async () => {
        let clock = 1_000;
        const client = new FakeDaemonClient([session("a", { processState: "LIVE" })]);
        const onClose = vi.fn();
        const dashboard = controller(client, { onClose, now: () => clock });
        await dashboard.open();
        dashboard.handleInput("\x1b[D");
        dashboard.handleInput("\x1b");
        for (const input of "draft")
            dashboard.handleInput(input);
        dashboard.handleInput("\x03");
        expect(dashboard.composerDraft.prompt).toBe("");
        expect(onClose).not.toHaveBeenCalled();
        expect(client.unsubscribed).toBe(0);
        // The window has passed, so this press clears again rather than quitting.
        clock += 500;
        dashboard.handleInput("\x03");
        expect(onClose).not.toHaveBeenCalled();
        clock += 499;
        dashboard.handleInput("\x03");
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith({ kind: "closed" }));
        expect(client.stop).not.toHaveBeenCalled();
        expect(client.delete).not.toHaveBeenCalled();
        expect(client.unsubscribed).toBe(1);
    });
    // Operator regression: the dashboard's own clearQuitGesture.cancel() on close is the only thing
    // that stops the first Ctrl+C after a reopen from quitting; the gesture unit cannot see that call.
    it("forgets an armed quit when the same controller is reopened", async () => {
        const client = new FakeDaemonClient([session("a", { processState: "LIVE" })]);
        const onClose = vi.fn();
        const dashboard = controller(client, { onClose, now: () => 1_000 });
        await dashboard.open();
        dashboard.handleInput("\x03");
        await dashboard.close();
        await dashboard.open();
        dashboard.handleInput("\x03");
        expect(dashboard.closed).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
    it("keeps retrying a stop against the newest revision instead of failing on churn", async () => {
        const client = new FakeDaemonClient([session("a", { processState: "LIVE", revision: 4 })]);
        const journal = journalledDestructive((revision) => {
            // A working session's record churns constantly, so the revision moves under the request.
            if (revision === 4) throw Object.assign(new Error("Session revision changed before Stop"), { code: "REVISION_CONFLICT" });
        });
        client.stop = vi.fn(journal.call);
        const dashboard = controller(client);
        await dashboard.open();
        dashboard.selectSession("a");
        // The retry re-reads from the daemon, so the newest revision comes from there.
        client.getState = vi.fn(async () => ({ sessions: [session("a", { processState: "LIVE", revision: 9 })], cursor: nextCoverage() }));
        dashboard.handleInput("\x18");
        expect(client.stop).not.toHaveBeenCalled();
        dashboard.handleInput("\x18");
        await vi.waitFor(() => expect(client.stop).toHaveBeenCalledWith("a", 9, expect.any(String)));
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
        // The journal keys a command by request ID and refuses the same ID with a changed payload,
        // so a retry that reuses it can only fail; each attempt carries its own.
        expect(new Set(journal.requestIds).size).toBe(journal.requestIds.length);
    });
    it("gives up a stop that keeps conflicting and says so", async () => {
        const client = new FakeDaemonClient([session("a", { processState: "LIVE", revision: 4 })]);
        client.stop = vi.fn(async () => { throw Object.assign(new Error("Session revision changed before Stop"), { code: "REVISION_CONFLICT" }); });
        const dashboard = controller(client, { stopRetryLimit: 3 });
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        expect(client.stop).not.toHaveBeenCalled();
        dashboard.handleInput("\x18");
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "REVISION_CONFLICT" }));
        expect(client.stop).toHaveBeenCalledTimes(3);
    });
    it("clears the prompt and shows a STARTING row before the daemon answers", async () => {
        let release = () => {};
        const client = new FakeDaemonClient([]);
        client.launch = vi.fn(() => new Promise((resolve) => { release = () => resolve({ kind: "launched", sessionId: "new-session" }); }));
        const dashboard = controller(client);
        await dashboard.open();
        for (const character of "ship it") dashboard.handleInput(character);
        expect(dashboard.composerDraft.prompt).toBe("ship it");
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(client.launch).toHaveBeenCalledTimes(1));

        // The prompt is gone, focus stays on the list, and the pending session is visible
        // before the daemon replies.
        expect(dashboard.composerDraft.prompt).toBe("");
        expect(dashboard.focus).toBe("list");
        const rendered = dashboard.render(100, 24).map(stripVTControlCharacters);
        expect(rendered.some((line) => line.includes("STARTING") && line.includes("ship it"))).toBe(true);

        // A second Enter cannot launch the same prompt twice.
        dashboard.handleInput("\r");
        expect(client.launch).toHaveBeenCalledTimes(1);
        release();
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
    });
    // Operator-visible failure: each save fsynced the file and its directory, about 70 ms on a
    // network home, so a burst that saved per change stalled the list while an agent streamed. The
    // dashboard keeps its view state in memory now and writes nothing at all.
    it("writes nothing durable while list invalidations arrive, or when it closes", async () => {
        const client = new FakeDaemonClient([session("a")]);
        const dashboard = controller(client);
        await dashboard.open();
        for (const revision of [1, 2, 3, 4, 5]) await applyListChange(dashboard, client, [session("a", { revision })]);
        expect(dashboard.sessions[0].revision).toBe(5);
        // The coverage cursor is the daemon's, held in memory for one read; nothing persists it.
        expect(dashboard.coverageCursor).toEqual(client.snapshot.cursor);
        expect(/** @type {any} */ (dashboard).persistence).toBeUndefined();
        await dashboard.close();
    });
    it("retires the pending row as soon as the real session appears", async () => {
        let release = () => {};
        const client = new FakeDaemonClient([]);
        client.launch = vi.fn(() => new Promise((resolve) => { release = () => resolve({ kind: "launched", sessionId: "real" }); }));
        const dashboard = controller(client);
        await dashboard.open();
        for (const character of "ship it") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(client.launch).toHaveBeenCalled());
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("STARTING"))).toBe(true);

        // The daemon publishes the session before it answers the launch, so the placeholder must yield
        // to the real record instead of sitting at STARTING beside it.
        dashboard.applySnapshot({ sessions: [session("real", { name: "Ship It", processState: "LIVE", taskState: "READY", createdAt: new Date().toISOString() })] });
        const rendered = dashboard.render(100, 24).map(stripVTControlCharacters);
        // The context line names the selected session too, so count list rows rather than every line.
        const header = rendered.findIndex((line) => line.includes("NAME"));
        const dockTop = rendered.findIndex((line, index) => index > header && line.trim().startsWith("─"));
        const rows = rendered.slice(header + 1, dockTop);
        expect(rows.filter((line) => line.includes("Ship It"))).toHaveLength(1);
        expect(rows.some((line) => line.includes("STARTING"))).toBe(false);
        release();
    });
    it("keeps the STARTING row while only rows hidden from the view are newer", async () => {
        const client = new FakeDaemonClient([]);
        client.launch = vi.fn(() => new Promise(() => {}));
        const dashboard = controller(client);
        await dashboard.open();
        for (const character of "ship it") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(client.launch).toHaveBeenCalled());
        // A native session that has not answered yet, and an unreachable older one, are STALE: hidden from the
        // default view and stamped with the read time, so neither is the launch the operator is waiting for.
        const now = new Date(Date.now() + 1000).toISOString();
        dashboard.applySnapshot({ sessions: [session("starting", { processState: "STALE", createdAt: now }), session("unreachable", { processState: "STALE", createdAt: now })] });
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("STARTING") && line.includes("ship it"))).toBe(true);
    });
    it("retires the STARTING row once the launched session reports, even while the view hides it", async () => {
        const client = new FakeDaemonClient([]);
        client.launch = vi.fn(async () => ({ kind: "launched", sessionId: "native-1" }));
        const dashboard = controller(client);
        await dashboard.open();
        for (const character of "ship it") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        // The list is usable before the backend answers, so wait for the launch itself to name its session.
        await vi.waitFor(() => expect(dashboard.pendingLaunches[0]?.launchedSessionId).toBe("native-1"));
        dashboard.applySnapshot({ sessions: [session("native-1", { processState: "STALE", createdAt: timestamp })] });
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("STARTING"))).toBe(true);
        dashboard.applySnapshot({ sessions: [session("native-1", { processState: "EXITED", taskState: "FAILED", createdAt: timestamp })] });
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("STARTING"))).toBe(false);
    });
    it("toggles grouping between state and working directory with Ctrl+S, and reports each choice", async () => {
        const saved = [];
        const client = new FakeDaemonClient([session("a", { cwd: "/repo/x" }), session("b", { cwd: "/repo/y", taskState: "WORKING" })]);
        const dashboard = controller(client, { initialGroupBy: "taskState", onGroupingChanged: (groupBy) => saved.push(groupBy) });
        await dashboard.open();
        expect(dashboard.query.groupBy).toBe("taskState");
        const headers = () => dashboard.render(100, 24).map(stripVTControlCharacters).filter((line) => line.startsWith("── "));
        expect(headers().map((line) => line.split(" (")[0])).toEqual(["── WORKING", "── READY"]);
        dashboard.handleInput("\x13");
        expect(dashboard.query.groupBy).toBe("cwd");
        expect(headers().map((line) => line.split(" (")[0])).toEqual(["── /repo/x", "── /repo/y"]);
        dashboard.handleInput("\x13");
        expect(dashboard.query.groupBy).toBe("taskState");
        expect(saved).toEqual(["cwd", "taskState"]);
    });
    it("keeps a STARTING row inside its own group rather than under the last one", async () => {
        const client = new FakeDaemonClient([session("a", { taskState: "WORKING" }), session("b")]);
        client.launch = vi.fn(() => new Promise(() => {}));
        const dashboard = controller(client, { initialGroupBy: "taskState" });
        await dashboard.open();
        for (const character of "ship it") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(client.launch).toHaveBeenCalled());
        const rows = dashboard.render(100, 24).map(stripVTControlCharacters);
        const starting = rows.findIndex((line) => line.startsWith("── STARTING"));
        const ready = rows.findIndex((line) => line.startsWith("── READY"));
        expect(starting).toBeGreaterThan(-1);
        expect(rows[starting + 1]).toContain("ship it");
        expect(starting).toBeLessThan(ready);
    });
    it("restores the draft and drops the pending row when a launch fails", async () => {
        const client = new FakeDaemonClient([]);
        client.launch = vi.fn(async () => { throw Object.assign(new Error("no worker slots"), { code: "LAUNCH_UNAVAILABLE" }); });
        const dashboard = controller(client);
        await dashboard.open();
        for (const character of "retry me") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "LAUNCH_UNAVAILABLE" }));
        // The operator keeps their text and the phantom row is gone.
        expect(dashboard.composerDraft.prompt).toBe("retry me");
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("STARTING"))).toBe(false);
    });
    it("launches worktrees and requires exact canonical shared-directory confirmation", async () => {
        const client = new FakeDaemonClient([]);
        const dashboard = controller(client);
        await dashboard.open();
        dashboard.focusComposer();
        dashboard.setComposerPrompt("Implement it");
        await dashboard.submitComposer();
        expect(client.requests[0]).toMatchObject({ isolation: { mode: "worktree" }, sourceSessionId: "source" });
        dashboard.setComposerPrompt("Shared change");
        dashboard.setIsolationMode("shared_directory");
        await dashboard.submitComposer();
        expect(client.requests).toHaveLength(1);
        await dashboard.confirmSharedLaunch("/wrong");
        expect(client.requests).toHaveLength(1);
        expect(dashboard.focus).toBe("confirmation");
        dashboard.handleInput("/");
        dashboard.handleInput("r");
        dashboard.handleInput("e");
        dashboard.handleInput("p");
        dashboard.handleInput("o");
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(client.requests).toHaveLength(2));
        expect(client.requests[1]).toMatchObject({ isolation: { mode: "shared_directory", confirmedCwd: "/repo" } });
    });
// Nothing durable records an ambiguous launch and nothing may retry it, so the operator gets his
// prompt back and one error line naming the code.
    it("hands back the prompt and never retries a launch whose delivery is ambiguous", async () => {
        const client = new FakeDaemonClient([]);
        client.launch = vi.fn(async () => { throw Object.assign(new Error("Launch delivery is ambiguous"), { code: "DELIVERY_UNKNOWN" }); });
        const dashboard = controller(client);
        await dashboard.open();
        dashboard.setComposerPrompt("Implement it");
        await dashboard.submitComposer();
        expect(client.launch).toHaveBeenCalledTimes(1);
        expect(dashboard.overlay).toBeUndefined();
        expect(dashboard.status).toMatchObject({ kind: "error", code: "DELIVERY_UNKNOWN" });
        expect(dashboard.composerDraft.prompt).toBe("Implement it");
    });
    it("opens the selection through the injected viewer boundary on an empty Enter or Right, and launches once the prompt has text", async () => {
        const openSelectedViewer = vi.fn(async () => {});
        const client = new FakeDaemonClient([session("a")]);
        const dashboard = controller(client, { openViewer: openSelectedViewer });
        await dashboard.open();
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(openSelectedViewer).toHaveBeenCalledWith("a"));
        dashboard.handleInput("\x1b[C");
        await vi.waitFor(() => expect(openSelectedViewer).toHaveBeenCalledTimes(2));
        expect(client.requests).toEqual([]);

        dashboard.handleInput("g");
        dashboard.handleInput("o");
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(client.requests).toHaveLength(1));
        expect(client.requests[0]).toMatchObject({ prompt: "go" });
        expect(openSelectedViewer).toHaveBeenCalledTimes(2);
    });
    it("closes and surfaces a typed malformed-frame state without signaling workers", async () => {
        const client = new FakeDaemonClient([session("a")]);
        const onClose = vi.fn();
        const dashboard = controller(client, { onClose });
        await dashboard.open();
        client.errorListener?.({ code: "MALFORMED_FRAME", message: "invalid event" });
        expect(dashboard.status).toMatchObject({ kind: "error", code: "MALFORMED_FRAME" });
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith({ kind: "error", code: "MALFORMED_FRAME", message: "invalid event" }));
        expect(client.stop).not.toHaveBeenCalled();
    });
    // Operator-visible failure: a dashboard whose persisted cursor was thousands of events behind
    // made the daemon replay the whole log at once, and the list died before it drew a row. Nothing
    // is replayed now: the list subscribes to payload-free invalidations and reads current rows.
    it("subscribes before it reads, so a change published during the read is not lost", async () => {
        const client = new FakeDaemonClient([session("a")]);
        /** @type {string[]} */
        const order = [];
        client.duringRead = async (read) => {
            order.push(`read-${read}`);
            // The daemon published this between the subscription and the response, the window that
            // used to lose a change entirely.
            if (read === 1) {
                client.setSessions([session("a"), session("b", { taskState: "WORKING" })]);
                void client.notifyListChanged();
            }
        };
        const subscribeListChanges = client.subscribeListChanges.bind(client);
        client.subscribeListChanges = async (...args) => { order.push("subscribe"); return subscribeListChanges(...args); };
        const dashboard = controller(client);
        await dashboard.open();
        expect(order).toEqual(["subscribe", "read-1", "read-2"]);
        expect(dashboard.status).toEqual({ kind: "ready" });
        expect(dashboard.sessions.map((record) => record.sessionId)).toEqual(["a", "b"]);
        expect(dashboard.coverageCursor).toEqual(client.snapshot.cursor);
        await dashboard.close();
    });
    // A change published while the socket was down leaves no trace, so the client reports the
    // reconnection itself as a change and the list reads current rows again.
    it("reads again when the subscription reports a reconnect", async () => {
        const client = new FakeDaemonClient([session("a")]);
        const dashboard = controller(client);
        await dashboard.open();
        const reads = client.reads;
        await applyListChange(dashboard, client, [session("a"), session("b")]);
        expect(client.reads).toBe(reads + 1);
        expect(dashboard.sessions.map((record) => record.sessionId)).toEqual(["a", "b"]);
        await dashboard.close();
    });
    // Operator-visible failure: an unrestarted dashboard against this daemon used to read rows once
    // and then freeze on them with a ready status line, which the operator cannot tell from a list
    // that simply has nothing new. The refusal has to reach the row he actually looks at.
    it("shows a refused client protocol on the status line and stops", async () => {
        const client = new FakeDaemonClient([session("a")]);
        client.subscribeFailure = Object.assign(new Error("This daemon speaks client protocol 2; restart every dashboard on the same release"), { code: "UNSUPPORTED_CLIENT_PROTOCOL" });
        const onClose = vi.fn();
        const dashboard = controller(client, { onClose });
        await dashboard.open();
        expect(dashboard.status).toMatchObject({ kind: "error", code: "UNSUPPORTED_CLIENT_PROTOCOL" });
        const rendered = dashboard.render(120, 24).map(stripVTControlCharacters).join("\n");
        expect(rendered).toContain("UNSUPPORTED_CLIENT_PROTOCOL");
        expect(rendered).toContain("restart every dashboard on the same release");
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", code: "UNSUPPORTED_CLIENT_PROTOCOL" })));
        // It never reads rows it cannot keep current.
        expect(client.reads).toBe(0);
        expect(dashboard.sessions).toEqual([]);
    });
    it("keeps its own view state across a viewer transition, and starts a new process at the default", async () => {
        const client = new FakeDaemonClient([session("a"), session("b")]);
        const dashboard = controller(client);
        await dashboard.open();
        dashboard.setView("all");
        dashboard.setSearch("b");
        dashboard.selectSession("b");
        // Opening a viewer closes the list and reopens it; that must not move the operator's place.
        await dashboard.close();
        await dashboard.open();
        expect(dashboard.query).toMatchObject({ view: "all", search: "b" });
        expect(dashboard.selectedSessionId).toBe("b");

        const fresh = controller(new FakeDaemonClient([session("a"), session("b")]));
        await fresh.open();
        expect(fresh.query).toMatchObject({ view: "live" });
        await fresh.close();
    });
    it("closes when the host cannot repaint the list it just read", async () => {
        const client = new FakeDaemonClient([session("a")]);
        const onClose = vi.fn();
        let renderRequests = 0;
        const dashboard = controller(client, {
            onClose,
            requestRender: () => {
                renderRequests += 1;
                if (renderRequests > 1) throw new Error("request render failed");
            },
        });
        await dashboard.open();
        await expect(applyListChange(dashboard, client, [session("a", { revision: 2 })])).rejects.toThrow();
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" })));
        expect(client.unsubscribed).toBe(1);
    });
    it("abandons a read in flight when the dashboard closes and never applies it", async () => {
        const client = new FakeDaemonClient([session("a")]);
        const onClose = vi.fn();
        const dashboard = controller(client, { onClose });
        await dashboard.open();
        let releaseRead = () => {};
        client.duringRead = () => new Promise((resolve) => { releaseRead = () => resolve(undefined); });
        client.setSessions([session("a"), session("b")]);
        const reading = client.notifyListChanged();
        const closing = dashboard.close();
        releaseRead();
        await expect(reading).rejects.toMatchObject({ code: "DASHBOARD_CLOSED" });
        await closing;
        expect(onClose).toHaveBeenCalledWith({ kind: "closed" });
        expect(dashboard.sessions.map((record) => record.sessionId)).toEqual(["a"]);
        expect(client.unsubscribed).toBe(1);
    });
    it("cycles filters, sort, and grouping through the category/value pair", async () => {
        const dashboard = controller(new FakeDaemonClient([
            session("a", { taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "approval", summary: "waiting", updatedAt: timestamp } }),
            session("b"),
        ]));
        await dashboard.open();
        dashboard.handleInput("\x06");
        dashboard.handleInput("w");
        dashboard.handleInput("\r");
        for (const category of ["task", "process", "outcome", "activity", "sort", "group"]) {
            while (dashboard.controlCategory !== category) dashboard.handleInput("\x16");
            dashboard.handleInput("\x14");
        }
        expect(dashboard.query).toMatchObject({ search: "w", taskStates: ["WORKING"], processStates: ["LIVE"], outcomes: ["NONE"], activityKinds: ["approval"], sort: { key: "age", direction: "asc" }, groupBy: "taskState" });
        expect(dashboard.selectedSessionId).toBe("a");
        expect(dashboard.render(80, 14).join("\n")).toContain("a");
        // Only the working directory has a header row now; the rest are set through the slash menu.
        expect(dashboard.render(100, 16).join("\n")).toContain("cwd:");
    });
    describe("slash commands", () => {
        function typed(dashboard, text) {
            for (const character of text) dashboard.handleInput(character);
        }
        it("offers the command menu while the prompt is a slash and runs the highlighted command", async () => {
            const dashboard = controller(new FakeDaemonClient([session("a")]));
            await dashboard.open();
            dashboard.handleInput("/");
            const menu = dashboard.render(80, 24).map(stripVTControlCharacters);
            expect(menu.some((line) => line.includes("/model"))).toBe(true);
            for (const command of ["/model", "/cwd", "/isolation", "/name", "/help"]) {
                expect(menu.some((line) => line.includes(command))).toBe(true);
            }
            expect(menu.some((line) => line.includes("/thinking"))).toBe(false);
            // Down drives the menu, not the session list, while a slash prompt is open.
            dashboard.handleInput("\x1b[B");
            dashboard.handleInput("\x1b[B");
            expect(dashboard.selectedSessionId).toBe("a");
            expect(dashboard.render(80, 24).some((line) => stripVTControlCharacters(line).includes("❯ /isolation"))).toBe(true);
            dashboard.handleInput("\r");
            expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "isolation" });
            expect(dashboard.composerDraft.prompt).toBe("");
        });
        it("picks a model from the values the list already knows and applies it to the draft", async () => {
            const client = new FakeDaemonClient([session("a", { model: { provider: "google", id: "gemini" } }), session("b")]);
            const dashboard = controller(client);
            await dashboard.open();
            typed(dashboard, "/model");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "model", values: ["anthropic/claude", "google/gemini"] }));
            dashboard.handleInput("\x1b[B");
            dashboard.handleInput("\r");
            expect(dashboard.composerDraft.model).toEqual({ provider: "google", id: "gemini" });
            expect(dashboard.overlay).toBeUndefined();
            expect(dashboard.focus).toBe("list");
            expect(client.requests).toEqual([]);
        });
        it("takes an existing directory and refuses anything else by name", async () => {
            const root = await mkdtemp(join(tmpdir(), "pi-agents-cwd-"));
            const file = join(root, "notes.txt");
            await writeFile(file, "", { mode: 0o600 });
            try {
                const client = new FakeDaemonClient([session("a")]);
                const dashboard = controller(client);
                await dashboard.open();
                typed(dashboard, `/cwd ${root}`);
                dashboard.handleInput("\r");
                await vi.waitFor(() => expect(dashboard.composerDraft.cwd).toBe(root));
                expect(dashboard.composerDraft.prompt).toBe("");
                for (const rejectedPath of [join(root, "missing"), file]) {
                    typed(dashboard, `/cwd ${rejectedPath}`);
                    dashboard.handleInput("\r");
                    await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "CWD_NOT_A_DIRECTORY", message: expect.stringContaining(rejectedPath) }));
                    expect(dashboard.composerDraft.cwd).toBe(root);
                    // A refusal keeps the text so the operator can correct it in place.
                    expect(dashboard.composerDraft.prompt).toBe(`/cwd ${rejectedPath}`);
                    typed(dashboard, "\x7f".repeat(`/cwd ${rejectedPath}`.length));
                }
                expect(client.requests).toEqual([]);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
        function completionLines(dashboard) {
            return dashboard.render(100, 24).map(stripVTControlCharacters).join("\n");
        }
        /** A directory tree to complete against, removed when the test ends. */
        async function completionRoot() {
            const root = await mkdtemp(join(tmpdir(), "pi-agents-complete-"));
            await mkdir(join(root, "alpha"));
            await mkdir(join(root, "alpha", "nested"));
            await mkdir(join(root, "alpine"));
            await writeFile(join(root, "alpha.txt"), "", { mode: 0o600 });
            return root;
        }
        it("refuses an unknown command by name and launches nothing", async () => {
            const openSelectedViewer = vi.fn(async () => {});
            const client = new FakeDaemonClient([session("a")]);
            const dashboard = controller(client, { openViewer: openSelectedViewer });
            await dashboard.open();
            typed(dashboard, "/logni now");
            dashboard.handleInput("\r");
            expect(dashboard.status).toMatchObject({ kind: "error", code: "UNKNOWN_LIST_COMMAND", message: expect.stringContaining("/logni") });
            expect(dashboard.status.message).toContain("/model");
            expect(dashboard.composerDraft.prompt).toBe("/logni now");
            expect(client.requests).toEqual([]);
            expect(openSelectedViewer).not.toHaveBeenCalled();
        });
        it.each([80])("keeps the menu and the picker inside %i columns", async (width) => {
            const dashboard = controller(new FakeDaemonClient([
                session("a", { model: { provider: "a-very-long-provider-name", id: "an-even-longer-model-identifier-2026" } }),
                session("b", { thinkingLevel: "an-unusually-long-thinking-level" }),
            ]));
            await dashboard.open();
            dashboard.handleInput("/");
            expect(dashboard.render(width, 24).every((line) => visibleWidth(line) <= width)).toBe(true);
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "model" }));
            expect(dashboard.render(width, 24).every((line) => visibleWidth(line) <= width)).toBe(true);
            expect(dashboard.render(width, 10).every((line) => visibleWidth(line) <= width)).toBe(true);
        });
    });
    // Operator-visible failure: three dashboards shared one frontend-state.json, so whichever one
    // saved last handed its draft and selection to whichever one next reopened its list after a
    // viewer transition. Each dashboard now keeps that state in its own process and writes nothing.
    it("keeps three dashboards' drafts and selections apart, whatever order they close in", async () => {
        const sharedFrontendStore = {
            loads: 0,
            saves: [],
            async load() { this.loads += 1; const last = this.saves.at(-1); return last === undefined ? undefined : structuredClone(last); },
            async save(state) { this.saves.push(state); },
        };
        const dashboards = ["alpha", "beta", "gamma"].map((name) => controller(new FakeDaemonClient([session("a"), session("b"), session("c")]), { persistence: sharedFrontendStore, sourceSessionId: `source-${name}` }));
        for (const dashboard of dashboards) await dashboard.open();
        const drafts = ["alpha draft", "beta draft", "gamma draft"];
        const selections = ["a", "b", "c"];
        dashboards.forEach((dashboard, index) => {
            dashboard.setComposerPrompt(drafts[index]);
            dashboard.selectSession(selections[index]);
        });
        // Closing order is the operator's, not ours: one dashboard leaving must not move another's state.
        for (const index of [1, 2, 0]) await dashboards[index].close();
        for (const index of [2, 0, 1]) await dashboards[index].open();
        expect(dashboards.map((dashboard) => dashboard.composerDraft.prompt)).toEqual(drafts);
        expect(dashboards.map((dashboard) => dashboard.selectedSessionId)).toEqual(selections);
        expect([sharedFrontendStore.loads, sharedFrontendStore.saves.length]).toEqual([0, 0]);
        for (const dashboard of dashboards) await dashboard.close();
    });
    it("derives source ownership from each dashboard's own Pi session, never from another's draft", async () => {
        const firstClient = new FakeDaemonClient([]);
        const first = controller(firstClient, { sourceSessionId: "session-a" });
        await first.open();
        first.setComposerPrompt("from A");
        await first.close();
        const secondClient = new FakeDaemonClient([]);
        const second = controller(secondClient, { sourceSessionId: "session-b" });
        await second.open();
        second.setComposerPrompt("from B");
        await second.submitComposer();
        expect(secondClient.requests[0]).toMatchObject({ sourceSessionId: "session-b", prompt: "from B" });
        expect(first.composerDraft.prompt).toBe("from A");
    });
});
describe("worktree capability", () => {
    const execFileAsync = promisify(execFile);
    /** @type {{ parent: string, repository: string, unborn: string, outsideGit: string }} */
    let directories;
    /** A dashboard wired to the real Git probe, launching from `cwd`. */
    function gitDashboard(client, cwd) {
        return new DashboardController({
            client,
            openViewer,
            clientId: "stable-client",
            sourceSessionId: "source",
            launchDefaults: { cwd, model: { provider: "anthropic", id: "claude" }, name: "new task" },
            requestRender: vi.fn(),
        });
    }
    beforeAll(async () => {
        const parent = await realpath(await mkdtemp(join(tmpdir(), "dashboard-capability-")));
        const repository = join(parent, "repo");
        const unborn = join(parent, "unborn");
        const outsideGit = join(parent, "outside-git");
        await Promise.all([mkdir(repository), mkdir(unborn), mkdir(outsideGit)]);
        const git = (cwd, ...args) => execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false });
        await Promise.all([git(repository, "init", "-b", "main"), git(unborn, "init", "-b", "main")]);
        await git(repository, "config", "user.name", "Dashboard Tests");
        await git(repository, "config", "user.email", "dashboard@example.test");
        await writeFile(join(repository, "tracked.txt"), "base\n");
        await git(repository, "add", "tracked.txt");
        await git(repository, "commit", "-m", "base");
        directories = { parent, repository, unborn, outsideGit };
    });
    afterAll(async () => { await rm(directories.parent, { recursive: true, force: true }); });
    it.each([
        ["a directory outside Git", () => directories.outsideGit],
    ])("launches in %s rather than asking for a directory the operator already chose", async (_label, select) => {
        const cwd = select();
        const client = new FakeDaemonClient([]);
        client.sharedOwners = [];
        const dashboard = gitDashboard(client, cwd);
        await dashboard.open();
        dashboard.focusComposer();
        dashboard.setComposerPrompt("Implement it");
        await dashboard.submitComposer();

        expect(dashboard.overlay).toBeUndefined();
        expect(dashboard.focus).toBe("list");
        expect(client.requests).toEqual([{
            prompt: "Implement it",
            cwd,
            sourceSessionId: "source",
            isolation: { mode: "shared_directory", confirmedCwd: cwd, ownerSessionIds: [] },
            model: { provider: "anthropic", id: "claude" },
            name: "new task",
        }]);
    });
    // A second session in a directory that cannot host a worktree is the normal case, not a mistake:
    // the first launch made the directory owned, and asking for its path again blocks every launch
    // after the first. The daemon still re-checks owners, and the row still names the directory.
    it("launches into a directory another live session already works in", async () => {
        const client = new FakeDaemonClient([]);
        const dashboard = gitDashboard(client, directories.outsideGit);
        await dashboard.open();
        dashboard.focusComposer();
        dashboard.setComposerPrompt("Implement it");
        await dashboard.submitComposer();

        expect(dashboard.overlay).toBeUndefined();
        expect(client.requests).toEqual([{
            prompt: "Implement it",
            cwd: directories.outsideGit,
            sourceSessionId: "source",
            isolation: { mode: "shared_directory", confirmedCwd: directories.outsideGit, ownerSessionIds: ["other"] },
            model: { provider: "anthropic", id: "claude" },
            name: "new task",
        }]);
    });
    // Choosing `/isolation shared` by hand still spells the directory out: that one is a decision about
    // where to work, not a directory the operator is already standing in.
    it("still confirms a shared directory the operator selected himself", async () => {
        const client = new FakeDaemonClient([]);
        const dashboard = gitDashboard(client, directories.repository);
        await dashboard.open();
        dashboard.focusComposer();
        dashboard.setIsolationMode("shared_directory");
        dashboard.setComposerPrompt("Implement it");
        await dashboard.submitComposer();

        expect(client.requests).toEqual([]);
        expect(dashboard.focus).toBe("confirmation");
        expect(dashboard.overlay).toMatchObject({ kind: "shared_directory_confirmation" });

        dashboard.handleInput("\x1b");
        expect(dashboard.composerDraft.prompt).toBe("Implement it");
    });
    it("launches a worktree from a repository with a commit", async () => {
        const client = new FakeDaemonClient([]);
        const dashboard = gitDashboard(client, directories.repository);
        await dashboard.open();
        dashboard.focusComposer();
        dashboard.setComposerPrompt("Implement it");
        await dashboard.submitComposer();

        expect(dashboard.overlay).toBeUndefined();
        expect(client.requests).toEqual([{
            prompt: "Implement it",
            cwd: directories.repository,
            sourceSessionId: "source",
            isolation: { mode: "worktree" },
            model: { provider: "anthropic", id: "claude" },
            name: "new task",
        }]);
    });
});
describe("mouse clicks", () => {
    it("selects the clicked session and opens it when it is already selected", async () => {
        const client = new FakeDaemonClient([session("a"), session("b"), session("c")]);
        const opened = [];
        const dashboard = controller(client, { openViewer: async (id) => { opened.push(id); } });
        await dashboard.open();
        dashboard.render(100, 24);
        const layout = createDashboardLayout(100, 24);

        dashboard.handleMouse({ button: "left", column: 4, row: layout.listTop + 1 });
        expect(dashboard.selectedSessionId).toBe("b");
        expect(opened).toEqual([]);

        // Clicking the row you are already on opens it, so a session is one or two clicks away.
        dashboard.handleMouse({ button: "left", column: 4, row: layout.listTop + 1 });
        await vi.waitFor(() => expect(opened).toEqual(["b"]));
    });

});
describe("wheel scrolling", () => {
    it("moves the selection up and down from wheel events", async () => {
        const dashboard = controller(new FakeDaemonClient([session("a"), session("b"), session("c"), session("d"), session("e")]));
        await dashboard.open();
        dashboard.render(80, 24);
        dashboard.selectSession("a");
        dashboard.handleMouse({ button: "wheel_down", column: 5, row: 7 });
        expect(dashboard.selectedSessionId).toBe("b");
        dashboard.handleMouse({ button: "wheel_down", column: 5, row: 7 });
        dashboard.handleMouse({ button: "wheel_up", column: 5, row: 7 });
        expect(dashboard.selectedSessionId).toBe("b");
    });
});

/** The dock's prompt block: the rows between the rule that opens the prompt box and the one that closes it. */
function promptRows(lines) {
  const plain = lines.map(stripVTControlCharacters);
  const rules = plain.flatMap((line, index) => /^─+$/u.test(line.trim()) ? [index] : []);
  const [open, close] = rules.slice(-2);
  return plain.slice(open + 1, close);
}

function listRowCount(lines) {
  return lines.filter((line) => stripVTControlCharacters(line).includes("READY")).length;
}

const CAPPED_DRAFT = Array.from({ length: 200 }, (_, index) => `word${index}`).join(" ");

describe("prompt wrapping", () => {
  // Operator-visible failure: a prompt longer than the terminal was clipped at the right edge, so the
  // operator's own sentence disappeared as he typed it and he could not read what he was about to send.
  it("keeps every character of an over-wide draft visible and takes the rows from the list", async () => {
    const draft = "Add the Notion and Slack MCP servers to this session so the agent can read the release checklist and post a summary";
    const dashboard = controller(new FakeDaemonClient(Array.from({ length: 40 }, (_, index) => session(`s-${index}`))));
    await dashboard.open();

    const empty = dashboard.render(60, 24);
    expect(promptRows(empty)).toHaveLength(1);

    dashboard.setComposerPrompt(draft);
    const wrapped = dashboard.render(60, 24);
    const rows = promptRows(wrapped);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join("").replace(/\s+/gu, "")).toBe(`❯${draft}`.replace(/\s+/gu, ""));
    expect(wrapped.every((line) => visibleWidth(line) <= 60)).toBe(true);
    // No word is broken across rows while a whole word still fits.
    for (const row of rows.slice(0, -1)) expect(row.trimEnd()).toMatch(/[\s❯]\S+$/u);
    expect(listRowCount(empty) - listRowCount(wrapped)).toBe(rows.length - 1);
  });

});
