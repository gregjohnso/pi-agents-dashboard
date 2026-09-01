import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { DashboardController, createDaemonDashboardBackend, } from "./dashboard.mjs";
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
class FakeBackend {
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
    async getSnapshot() {
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
    async preflightLaunch(draft) {
        return { canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: draft.isolationMode === "shared_directory" ? ["other"] : [] };
    }
    async launch(request) {
        this.requests.push(request);
        return { kind: "launched", sessionId: "launched" };
    }
}
const openViewer = vi.fn(async () => {});
function controller(backend, overrides = {}) {
    return new DashboardController({
        backend,
        openViewer,
        clientId: "stable-client",
        sourceSessionId: "source",
        launchDefaults: { cwd: "/repo", model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high", name: "new task" },
        requestRender: vi.fn(),
        ...overrides,
    });
}
/**
 * A destructive backend call that refuses to see the same request ID carry two different payloads,
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
async function applyListChange(dashboard, backend, sessions) {
    if (sessions !== undefined) backend.setSessions(sessions);
    await backend.notifyListChanged();
    dashboard.render();
}
describe("dashboard controller", () => {
    it("keeps selection by canonical session ID through live reorder and resize", async () => {
        const backend = new FakeBackend([session("a"), session("b"), session("c")]);
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.handleInput("\x1b[B");
        expect(dashboard.selectedSessionId).toBe("b");
        await applyListChange(dashboard, backend, [session("c"), session("a"), session("b", { revision: 2 })]);
        dashboard.resize(40, 8);
        expect(dashboard.selectedSessionId).toBe("b");
    });
    it("keeps virtualized navigation index-safe with groups, pages, ends, resize, and mouse clicks", async () => {
        const sessions = Array.from({ length: 10_000 }, (_, index) => session(`s-${String(index).padStart(5, "0")}`, { taskState: index % 2 ? "READY" : "WORKING" }));
        const dashboard = controller(new FakeBackend(sessions));
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
        const backend = new FakeBackend([session("a")]);
        backend.refreshSummaries = vi.fn(async () => ["a"]);
        const dashboard = controller(backend);
        await dashboard.open();
        expect(dashboard.status).toEqual({ kind: "ready" });
        expect(backend.refreshSummaries).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(backend.refreshSummaries).toHaveBeenCalledTimes(1), { timeout: 5_000 });
        dashboard.handleInput("\x12");
        await vi.waitFor(() => expect(backend.refreshSummaries).toHaveBeenCalledTimes(2));
    });
    it("drops a scheduled summary refresh when the list closes first", async () => {
        const backend = new FakeBackend([session("a")]);
        backend.refreshSummaries = vi.fn(async () => ["a"]);
        const dashboard = controller(backend);
        await dashboard.open();
        await dashboard.close();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(backend.refreshSummaries).not.toHaveBeenCalled();
    });
    it("opens without summaries when the daemon has none configured", async () => {
        const backend = new FakeBackend([session("a")]);
        backend.refreshSummaries = vi.fn(async () => { throw Object.assign(new Error("nope"), { code: "SUMMARIES_UNAVAILABLE" }); });
        const dashboard = controller(backend);
        await dashboard.open();
        await vi.waitFor(() => expect(backend.refreshSummaries).toHaveBeenCalled());
        expect(dashboard.status).toEqual({ kind: "ready" });
    });
    it("names the selected session and adds a filter chip only once a filter is set", async () => {
        const dashboard = controller(new FakeBackend([
            session("a", { cwd: "/repo/alpha" }),
            session("b", { cwd: "/repo/beta" }),
        ]));
        await dashboard.open();
        const unfiltered = dashboard.render(100, 16).map(stripVTControlCharacters);
        // Inverted 2026-08-30: the line named the session cwd, a bare worktree UUID, and sat above the
        // list; it now names the session and reads last, under the prompt.
        expect(unfiltered.at(-1)).toContain("a");
        expect(unfiltered.at(-1)).not.toContain("/repo/alpha");
        expect(unfiltered.at(-1)).not.toContain("search:");
        expect(unfiltered.at(-1)).not.toContain("v:live");

        // The selected session's name sits at the top, above the list, and follows the selection.
        dashboard.selectSession("a");
        expect(stripVTControlCharacters(dashboard.render(100, 16).at(-1)).trim()).toMatch(/^a\b/u);
        dashboard.selectSession("b");
        expect(stripVTControlCharacters(dashboard.render(100, 16).at(-1)).trim()).toMatch(/^b\b/u);

        dashboard.setSearch("beta");
        const filtered = dashboard.render(100, 16);
        // Name and active filters share the one context line.
        expect(stripVTControlCharacters(filtered.at(-1))).toContain("b");
        expect(stripVTControlCharacters(filtered.at(-1))).toContain("search:beta");
    });
    // Ctrl+X on a live session is a Stop; only a second press inside the window clears it, and
    // both presses confirm. app/list/stop-clear-gesture.test.mjs owns the window's exact edges.
    it("hands a destructive request off in the background and never wedges input behind it", async () => {
        let release = () => {};
        const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
        backend.stop = vi.fn(() => new Promise((resolve) => { release = () => resolve({ accepted: true }); }));
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        // The stop travels in the background: the operator gets the list back without waiting for the daemon.
        expect(dashboard.overlay).toBeUndefined();
        expect(backend.stop).toHaveBeenCalledWith("a", 1, expect.any(String));
        expect(dashboard.status).toMatchObject({ kind: "pending" });
        dashboard.handleInput("\x1b[B");
        expect(dashboard.focus).toBe("list");
        release();
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
    });
    it("closes the list only on Ctrl+C; Left and Escape are inert", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
        const onClose = vi.fn();
        const dashboard = controller(backend, { onClose });
        await dashboard.open();
        dashboard.handleInput("\x1b[D");
        dashboard.handleInput("\x1b");
        expect(onClose).not.toHaveBeenCalled();
        expect(backend.unsubscribed).toBe(0);
        dashboard.handleInput("\x03");
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith({ kind: "closed" }));
        expect(backend.stop).not.toHaveBeenCalled();
        expect(backend.delete).not.toHaveBeenCalled();
        expect(backend.unsubscribed).toBe(1);
    });
    it.each([
        ["an empty list", []],
        ["the last row", [session("a")]],
    ])("keeps arrows inside the list from %s, because the composer is not a focus target", async (_label, sessions) => {
        const dashboard = controller(new FakeBackend(sessions));
        await dashboard.open();
        dashboard.handleInput("\x1b[B");
        expect(dashboard.focus).toBe("list");
        dashboard.handleInput("\x1b[A");
        expect(dashboard.focus).toBe("list");
        // Typing still reaches the prompt without any focus move.
        dashboard.handleInput("h");
        expect(dashboard.composerDraft.prompt).toBe("h");
    });
    it("keeps retrying a stop against the newest revision instead of failing on churn", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE", revision: 4 })]);
        const journal = journalledDestructive((revision) => {
            // A working session's record churns constantly, so the revision moves under the request.
            if (revision === 4) throw Object.assign(new Error("Session revision changed before Stop"), { code: "REVISION_CONFLICT" });
        });
        backend.stop = vi.fn(journal.call);
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.selectSession("a");
        // The retry re-reads from the daemon, so the newest revision comes from there.
        backend.getSnapshot = vi.fn(async () => ({ sessions: [session("a", { processState: "LIVE", revision: 9 })], cursor: nextCoverage() }));
        dashboard.handleInput("\x18");
        await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledWith("a", 9, expect.any(String)));
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
        // The journal keys a command by request ID and refuses the same ID with a changed payload,
        // so a retry that reuses it can only fail; each attempt carries its own.
        expect(new Set(journal.requestIds).size).toBe(journal.requestIds.length);
    });
    it("gives up a stop that keeps conflicting and says so", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE", revision: 4 })]);
        backend.stop = vi.fn(async () => { throw Object.assign(new Error("Session revision changed before Stop"), { code: "REVISION_CONFLICT" }); });
        const dashboard = controller(backend, { stopRetryLimit: 3 });
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "REVISION_CONFLICT" }));
        expect(backend.stop).toHaveBeenCalledTimes(3);
    });
    it("clears the prompt and shows a STARTING row before the daemon answers", async () => {
        let release = () => {};
        const backend = new FakeBackend([]);
        backend.launch = vi.fn(() => new Promise((resolve) => { release = () => resolve({ kind: "launched", sessionId: "new-session" }); }));
        const dashboard = controller(backend);
        await dashboard.open();
        for (const character of "ship it") dashboard.handleInput(character);
        expect(dashboard.composerDraft.prompt).toBe("ship it");
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(backend.launch).toHaveBeenCalledTimes(1));

        // The prompt is gone, focus stays on the list, and the pending session is visible
        // before the daemon replies.
        expect(dashboard.composerDraft.prompt).toBe("");
        expect(dashboard.focus).toBe("list");
        const rendered = dashboard.render(100, 24).map(stripVTControlCharacters);
        expect(rendered.some((line) => line.includes("STARTING") && line.includes("ship it"))).toBe(true);

        // A second Enter cannot launch the same prompt twice.
        dashboard.handleInput("\r");
        expect(backend.launch).toHaveBeenCalledTimes(1);
        release();
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
    });
    it("stops on the first Ctrl+X and clears only on a second press inside the window", async () => {
        let clock = 0;
        const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
        const dashboard = controller(backend, { now: () => clock });
        await dashboard.open();
        dashboard.selectSession("a");

        // One press stops, with no prompt to confirm.
        dashboard.handleInput("\x18");
        await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledWith("a", 1, expect.any(String)));
        expect(dashboard.overlay).toBeUndefined();
        expect(backend.delete).not.toHaveBeenCalled();

        // The clear arms only once the stop has landed.
        await vi.waitFor(() => expect(dashboard.stopClearArmed).toBe(true));
        dashboard.applySnapshot({ sessions: [session("a", { taskState: "STOPPED", processState: "EXITED", revision: 2 })] });
        clock = 400;
        dashboard.handleInput("\x18");
        await vi.waitFor(() => expect(backend.delete).toHaveBeenCalledWith("a", 2, expect.any(String)));
    });
    it("shows a red confirm hint while the clear is armed and drops it when the window passes", async () => {
        let clock = 0;
        const backend = new FakeBackend([session("a", { taskState: "STOPPED", processState: "EXITED" })]);
        const dashboard = controller(backend, { now: () => clock });
        await dashboard.open();
        dashboard.setView("all");
        dashboard.selectSession("a");

        dashboard.handleInput("\x18");
        const armed = dashboard.render(100, 24);
        expect(armed.map(stripVTControlCharacters).some((line) => line.includes("ctrl+x to confirm"))).toBe(true);
        expect(armed.find((line) => stripVTControlCharacters(line).includes("ctrl+x to confirm"))).toContain(JOBWATCH_ANSI.rose);

        clock = 600;
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("ctrl+x to confirm"))).toBe(false);
    });
    it("abandons an armed clear on any other key", async () => {
        const backend = new FakeBackend([session("a", { taskState: "STOPPED", processState: "EXITED" })]);
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.setView("all");
        dashboard.selectSession("a");
        for (const key of ["\x1b", "\x7f", "x"]) {
            dashboard.handleInput("\x18");
            expect(dashboard.stopClearArmed).toBe(true);
            dashboard.handleInput(key);
            expect(dashboard.stopClearArmed).toBe(false);
        }
        expect(backend.delete).not.toHaveBeenCalled();
    });
    it("requires two presses to clear a session that was already stopped", async () => {
        let clock = 0;
        const backend = new FakeBackend([session("a", { taskState: "STOPPED", processState: "EXITED" })]);
        const dashboard = controller(backend, { now: () => clock });
        await dashboard.open();
        dashboard.setView("all");
        dashboard.selectSession("a");

        // A dead session cannot be stopped, so the first press only arms the clear.
        dashboard.handleInput("\x18");
        expect(backend.delete).not.toHaveBeenCalled();
        expect(dashboard.stopClearArmed).toBe(true);

        clock = 300;
        dashboard.handleInput("\x18");
        await vi.waitFor(() => expect(backend.delete).toHaveBeenCalledWith("a", 1, expect.any(String)));
    });
    it("forgets an armed clear once the window passes", async () => {
        let clock = 0;
        const backend = new FakeBackend([session("a", { taskState: "STOPPED", processState: "EXITED" })]);
        const dashboard = controller(backend, { now: () => clock });
        await dashboard.open();
        dashboard.setView("all");
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        clock = 900;
        dashboard.handleInput("\x18");
        expect(backend.delete).not.toHaveBeenCalled();
        expect(dashboard.stopClearArmed).toBe(true);
    });
    it("re-reads the authoritative revision when a destructive request conflicts", async () => {
        // The record churns from background writes, and the frontend's cached copy can be many
        // revisions behind, so retrying against the cache conflicts forever.
        const backend = new FakeBackend([session("a", { taskState: "FAILED", processState: "EXITED", revision: 4 })]);
        const journal = journalledDestructive((revision) => {
            if (revision !== 25) throw Object.assign(new Error("Session revision changed before Delete"), { code: "REVISION_CONFLICT" });
        });
        backend.delete = vi.fn(journal.call);
        const dashboard = controller(backend);
        await dashboard.open();
        // The daemon has moved on; the frontend still holds revision 4 because no event carried the change.
        backend.getSnapshot = vi.fn(async () => ({ sessions: [session("a", { taskState: "FAILED", processState: "EXITED", revision: 25 })], cursor: nextCoverage() }));
        dashboard.setView("all");
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        dashboard.handleInput("\x18");
        await vi.waitFor(() => expect(backend.delete).toHaveBeenCalledWith("a", 25, expect.any(String)));
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
        expect(new Set(journal.requestIds).size).toBe(journal.requestIds.length);
    });
    // Operator-visible failure: each save fsynced the file and its directory, about 70 ms on a
    // network home, so a burst that saved per change stalled the list while an agent streamed. The
    // dashboard keeps its view state in memory now and writes nothing at all.
    it("writes nothing durable while list invalidations arrive, or when it closes", async () => {
        const backend = new FakeBackend([session("a")]);
        const dashboard = controller(backend);
        await dashboard.open();
        for (const revision of [1, 2, 3, 4, 5]) await applyListChange(dashboard, backend, [session("a", { revision })]);
        expect(dashboard.sessions[0].revision).toBe(5);
        // The coverage cursor is the daemon's, held in memory for one read; nothing persists it.
        expect(dashboard.coverageCursor).toEqual(backend.snapshot.cursor);
        expect(/** @type {any} */ (dashboard).persistence).toBeUndefined();
        await dashboard.close();
    });
    it("retires the pending row as soon as the real session appears", async () => {
        let release = () => {};
        const backend = new FakeBackend([]);
        backend.launch = vi.fn(() => new Promise((resolve) => { release = () => resolve({ kind: "launched", sessionId: "real" }); }));
        const dashboard = controller(backend);
        await dashboard.open();
        for (const character of "ship it") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(backend.launch).toHaveBeenCalled());
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
    it("drops the pending row when the launch request throws", async () => {
        const backend = new FakeBackend([]);
        backend.launch = vi.fn(async () => { throw Object.assign(new Error("socket closed"), { code: "DAEMON_UNAVAILABLE" }); });
        const dashboard = controller(backend);
        await dashboard.open();
        for (const character of "ship it") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error" }));
        // A thrown launch must not leave a STARTING row that never resolves.
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("STARTING"))).toBe(false);
        expect(dashboard.composerDraft.prompt).toBe("ship it");
    });
    it("restores the draft and drops the pending row when a launch fails", async () => {
        const backend = new FakeBackend([]);
        backend.launch = vi.fn(async () => ({ kind: "error", error: { code: "LAUNCH_UNAVAILABLE", message: "no worker slots" } }));
        const dashboard = controller(backend);
        await dashboard.open();
        for (const character of "retry me") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "LAUNCH_UNAVAILABLE" }));
        // The operator keeps their text and the phantom row is gone.
        expect(dashboard.composerDraft.prompt).toBe("retry me");
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("STARTING"))).toBe(false);
    });
    it("keeps the typed prompt when the daemon refuses the launch outright", async () => {
        // The backend answers a FAILED command with `rejected`; matching only `error` ate the draft,
        // so a MODEL_UNKNOWN refusal lost what the operator typed while the fixture test still passed.
        const backend = new FakeBackend([]);
        backend.launch = vi.fn(async () => ({ kind: "rejected", error: { code: "MODEL_UNKNOWN", message: "openai-codex/nope is not installed" } }));
        const dashboard = controller(backend);
        await dashboard.open();
        for (const character of "keep this") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "MODEL_UNKNOWN" }));
        expect(dashboard.composerDraft.prompt).toBe("keep this");
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("STARTING"))).toBe(false);
    });
    it("keeps a refused launch on the status line through timer-driven changes until the next command", async () => {
        const backend = new FakeBackend([session("a")]);
        backend.refreshSummaries = vi.fn(async () => ["a"]);
        // The daemon's shape for a refused launch: a terminal FAILED command status, not a transport error.
        backend.launch = vi.fn(async () => ({ kind: "rejected", error: { code: "MODEL_UNKNOWN", message: "Pi does not offer openai/id" } }));
        const dashboard = controller(backend);
        await dashboard.open();
        for (const character of "ship it") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "MODEL_UNKNOWN" }));

        // Every later change the operator did not make: the summary-refresh timer, a subscription
        // update, and repeated renders. None of them may take the refusal off the screen.
        await vi.waitFor(() => expect(backend.refreshSummaries).toHaveBeenCalled(), { timeout: 5_000 });
        await applyListChange(dashboard, backend, [session("a", { revision: 2 })]);
        expect(dashboard.status).toMatchObject({ kind: "error", code: "MODEL_UNKNOWN" });
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("MODEL_UNKNOWN"))).toBe(true);

        // The refusal handed the prompt back, so clear it before typing the next command.
        expect(dashboard.composerDraft.prompt).toBe("ship it");
        dashboard.setComposerPrompt("");
        for (const character of "/help") dashboard.handleInput(character);
        dashboard.handleInput("\r");
        expect(dashboard.status).toEqual({ kind: "ready" });
    });
    it("launches worktrees and requires exact canonical shared-directory confirmation", async () => {
        const backend = new FakeBackend([]);
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.focusComposer();
        dashboard.setComposerPrompt("Implement it");
        await dashboard.submitComposer();
        expect(backend.requests[0]).toMatchObject({ isolation: { mode: "worktree" }, sourceSessionId: "source" });
        dashboard.setComposerPrompt("Shared change");
        dashboard.setIsolationMode("shared_directory");
        await dashboard.submitComposer();
        expect(backend.requests).toHaveLength(1);
        await dashboard.confirmSharedLaunch("/wrong");
        expect(backend.requests).toHaveLength(1);
        expect(dashboard.focus).toBe("confirmation");
        dashboard.handleInput("/");
        dashboard.handleInput("r");
        dashboard.handleInput("e");
        dashboard.handleInput("p");
        dashboard.handleInput("o");
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(backend.requests).toHaveLength(2));
        expect(backend.requests[1]).toMatchObject({ isolation: { mode: "shared_directory", confirmedCwd: "/repo" } });
    });
    // A launch has two failure channels today: a refusal on the response envelope, and a thrown
    // transport failure the client cannot attribute to an answer. The confirmation path let the
    // second one escape, and the operator's text went with it: the composer was already cleared.
    it("hands the prompt back when a confirmed shared-directory launch fails on the transport", async () => {
        const backend = new FakeBackend([]);
        backend.launch = vi.fn(async () => { throw Object.assign(new Error("Daemon response could not be parsed"), { code: "MALFORMED_RESPONSE" }); });
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.setComposerPrompt("Shared change");
        dashboard.setIsolationMode("shared_directory");
        await dashboard.submitComposer();
        expect(dashboard.focus).toBe("confirmation");
        await dashboard.confirmSharedLaunch("/repo");
        expect(backend.launch).toHaveBeenCalledTimes(1);
        expect(dashboard.composerDraft.prompt).toBe("Shared change");
        expect(dashboard.status).toMatchObject({ kind: "error", code: "MALFORMED_RESPONSE" });
    });
// Nothing durable records an ambiguous launch and nothing may retry it, so the operator gets his
// prompt back and one error line naming the code.
    it("hands back the prompt and never retries a launch whose delivery is ambiguous", async () => {
        const backend = new FakeBackend([]);
        backend.launch = vi.fn(async () => ({ kind: "rejected", error: { code: "DELIVERY_UNKNOWN", message: "Launch delivery is ambiguous" } }));
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.setComposerPrompt("Implement it");
        await dashboard.submitComposer();
        expect(backend.launch).toHaveBeenCalledTimes(1);
        expect(dashboard.overlay).toBeUndefined();
        expect(dashboard.status).toMatchObject({ kind: "error", code: "DELIVERY_UNKNOWN" });
        expect(dashboard.composerDraft.prompt).toBe("Implement it");
    });
    it("opens the selection through the injected viewer boundary on an empty Enter or Right, and launches once the prompt has text", async () => {
        const openSelectedViewer = vi.fn(async () => {});
        const backend = new FakeBackend([session("a")]);
        const dashboard = controller(backend, { openViewer: openSelectedViewer });
        await dashboard.open();
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(openSelectedViewer).toHaveBeenCalledWith("a"));
        dashboard.handleInput("\x1b[C");
        await vi.waitFor(() => expect(openSelectedViewer).toHaveBeenCalledTimes(2));
        expect(backend.requests).toEqual([]);

        dashboard.handleInput("g");
        dashboard.handleInput("o");
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(backend.requests).toHaveLength(1));
        expect(backend.requests[0]).toMatchObject({ prompt: "go" });
        expect(openSelectedViewer).toHaveBeenCalledTimes(2);
    });
    describe("floating overlay panels", () => {
        it.each([
            ["help", async (dashboard) => { dashboard.toggleHelp(); }, "Help", "this help"],
            ["metadata", async (dashboard) => { dashboard.toggleMetadata(); }, "Session", "taskState"],
            ["shared directory", async (dashboard) => {
                dashboard.setComposerPrompt("Shared change");
                dashboard.setIsolationMode("shared_directory");
                await dashboard.submitComposer();
                dashboard.handleInput("/");
                dashboard.handleInput("r");
            }, "Shared directory", "> /r"],
        ])("titles the %s panel and keeps its content", async (_label, open, title, content) => {
            const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
            const dashboard = controller(backend);
            await dashboard.open();
            await open(dashboard, backend);
            const rendered = dashboard.render(120, 32).map(stripVTControlCharacters);
            expect(rendered.some((line) => line.includes(title))).toBe(true);
            expect(rendered.some((line) => line.includes(content))).toBe(true);
            // A floating panel never swallows the prompt at an ordinary size.
            expect(rendered.some((line) => line.includes("describe a task") || line.includes("❯"))).toBe(true);
        });
    });
    it("closes and surfaces a typed malformed-frame state without signaling workers", async () => {
        const backend = new FakeBackend([session("a")]);
        const onClose = vi.fn();
        const dashboard = controller(backend, { onClose });
        await dashboard.open();
        backend.errorListener?.({ code: "MALFORMED_FRAME", message: "invalid event" });
        expect(dashboard.status).toMatchObject({ kind: "error", code: "MALFORMED_FRAME" });
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith({ kind: "error", code: "MALFORMED_FRAME", message: "invalid event" }));
        expect(backend.stop).not.toHaveBeenCalled();
    });
    // Operator-visible failure: a dashboard whose persisted cursor was thousands of events behind
    // made the daemon replay the whole log at once, and the list died before it drew a row. Nothing
    // is replayed now: the list subscribes to payload-free invalidations and reads current rows.
    it("subscribes before it reads, so a change published during the read is not lost", async () => {
        const backend = new FakeBackend([session("a")]);
        /** @type {string[]} */
        const order = [];
        backend.duringRead = async (read) => {
            order.push(`read-${read}`);
            // The daemon published this between the subscription and the response, the window that
            // used to lose a change entirely.
            if (read === 1) {
                backend.setSessions([session("a"), session("b", { taskState: "WORKING" })]);
                void backend.notifyListChanged();
            }
        };
        const subscribeListChanges = backend.subscribeListChanges.bind(backend);
        backend.subscribeListChanges = async (...args) => { order.push("subscribe"); return subscribeListChanges(...args); };
        const dashboard = controller(backend);
        await dashboard.open();
        expect(order).toEqual(["subscribe", "read-1", "read-2"]);
        expect(dashboard.status).toEqual({ kind: "ready" });
        expect(dashboard.sessions.map((record) => record.sessionId)).toEqual(["a", "b"]);
        expect(dashboard.coverageCursor).toEqual(backend.snapshot.cursor);
        await dashboard.close();
    });
    // Operator-visible failure: replaying a persisted list history crashed the dashboard on every
    // start, and the queue that held the replay grew with the burst.
    it("collapses ten thousand invalidations into one dirty flag and at most three reads", async () => {
        const backend = new FakeBackend([session("a")]);
        backend.duringRead = async (read) => {
            if (read === 1) for (let index = 0; index < 10_000; index += 1) void backend.notifyListChanged();
            // One further change lands during the refetch the burst provoked.
            if (read === 2) { backend.setSessions([session("a", { revision: 3 })]); void backend.notifyListChanged(); }
        };
        const dashboard = controller(backend);
        await dashboard.open();
        expect(backend.reads).toBe(3);
        expect(dashboard.listChangePending).toBe(false);
        expect(dashboard.sessions[0].revision).toBe(3);
        await dashboard.close();
        expect(backend.reads).toBe(3);
    });
    // A change published while the socket was down leaves no trace, so the client reports the
    // reconnection itself as a change and the list reads current rows again.
    it("reads again when the subscription reports a reconnect", async () => {
        const backend = new FakeBackend([session("a")]);
        const dashboard = controller(backend);
        await dashboard.open();
        const reads = backend.reads;
        await applyListChange(dashboard, backend, [session("a"), session("b")]);
        expect(backend.reads).toBe(reads + 1);
        expect(dashboard.sessions.map((record) => record.sessionId)).toEqual(["a", "b"]);
        await dashboard.close();
    });
    // Operator-visible failure: a snapshot whose coverage was unknown could not be told from one
    // taken before a change, which is what made the subscribe-then-read window unsafe.
    it("refuses a snapshot that does not carry its coverage cursor", async () => {
        const backend = new FakeBackend([session("a")]);
        backend.getSnapshot = async () => ({ sessions: [session("a")] });
        const dashboard = controller(backend);
        await dashboard.open();
        expect(dashboard.status).toMatchObject({ kind: "error", code: "INVALID_RESPONSE" });
        await dashboard.close();
    });
    // Operator-visible failure: an unrestarted dashboard against this daemon used to read rows once
    // and then freeze on them with a ready status line, which the operator cannot tell from a list
    // that simply has nothing new. The refusal has to reach the row he actually looks at.
    it("shows a refused client protocol on the status line and stops", async () => {
        const backend = new FakeBackend([session("a")]);
        backend.subscribeFailure = Object.assign(new Error("This daemon speaks client protocol 2; restart every dashboard on the same release"), { code: "UNSUPPORTED_CLIENT_PROTOCOL" });
        const onClose = vi.fn();
        const dashboard = controller(backend, { onClose });
        await dashboard.open();
        expect(dashboard.status).toMatchObject({ kind: "error", code: "UNSUPPORTED_CLIENT_PROTOCOL" });
        const rendered = dashboard.render(120, 24).map(stripVTControlCharacters).join("\n");
        expect(rendered).toContain("UNSUPPORTED_CLIENT_PROTOCOL");
        expect(rendered).toContain("restart every dashboard on the same release");
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", code: "UNSUPPORTED_CLIENT_PROTOCOL" })));
        // It never reads rows it cannot keep current.
        expect(backend.reads).toBe(0);
        expect(dashboard.sessions).toEqual([]);
    });
    it("keeps its own view state across a viewer transition, and starts a new process at the default", async () => {
        const backend = new FakeBackend([session("a"), session("b")]);
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.setView("all");
        dashboard.setSearch("b");
        dashboard.selectSession("b");
        // Opening a viewer closes the list and reopens it; that must not move the operator's place.
        await dashboard.close();
        await dashboard.open();
        expect(dashboard.query).toMatchObject({ view: "all", search: "b" });
        expect(dashboard.selectedSessionId).toBe("b");

        const fresh = controller(new FakeBackend([session("a"), session("b")]));
        await fresh.open();
        expect(fresh.query).toMatchObject({ view: "live" });
        await fresh.close();
    });
    it("draws every snapshot it reads, newest last", async () => {
        const backend = new FakeBackend([session("initial")]);
        const renders = [];
        let dashboard;
        dashboard = controller(backend, { requestRender: () => { renders.push(dashboard.render(80, 12)); } });
        await dashboard.open();
        renders.length = 0;
        backend.setSessions([session("state-1")]);
        backend.duringRead = async () => {
            backend.duringRead = undefined;
            backend.setSessions([session("state-2")]);
            void backend.notifyListChanged();
        };
        await backend.notifyListChanged();
        expect(renders.map((lines) => lines.join("\n")).filter((text) => text.includes("state-1"))).toHaveLength(1);
        expect(renders.at(-1)?.join("\n")).toContain("state-2");
        await dashboard.close();
    });
    it("closes when the host cannot repaint the list it just read", async () => {
        const backend = new FakeBackend([session("a")]);
        const onClose = vi.fn();
        let renderRequests = 0;
        const dashboard = controller(backend, {
            onClose,
            requestRender: () => {
                renderRequests += 1;
                if (renderRequests > 1) throw new Error("request render failed");
            },
        });
        await dashboard.open();
        await expect(applyListChange(dashboard, backend, [session("a", { revision: 2 })])).rejects.toThrow();
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" })));
        expect(backend.unsubscribed).toBe(1);
    });
    it("closes when rendering the list throws", async () => {
        const backend = new FakeBackend([session("a")]);
        const onClose = vi.fn();
        const dashboard = controller(backend, { onClose });
        await dashboard.open();
        /** @type {any} */ (dashboard).list.renderViewport = () => { throw new Error("render failed"); };
        expect(() => dashboard.render()).toThrowError("render failed");
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" })));
        expect(backend.unsubscribed).toBe(1);
    });
    it("abandons a read in flight when the dashboard closes and never applies it", async () => {
        const backend = new FakeBackend([session("a")]);
        const onClose = vi.fn();
        const dashboard = controller(backend, { onClose });
        await dashboard.open();
        let releaseRead = () => {};
        backend.duringRead = () => new Promise((resolve) => { releaseRead = () => resolve(undefined); });
        backend.setSessions([session("a"), session("b")]);
        const reading = backend.notifyListChanged();
        const closing = dashboard.close();
        releaseRead();
        await expect(reading).rejects.toMatchObject({ code: "DASHBOARD_CLOSED" });
        await closing;
        expect(onClose).toHaveBeenCalledWith({ kind: "closed" });
        expect(dashboard.sessions.map((record) => record.sessionId)).toEqual(["a"]);
        expect(backend.unsubscribed).toBe(1);
    });
    it("disposes a subscription that resolves after close and installs nothing", async () => {
        let resolveSubscribe;
        const backend = new FakeBackend([session("a")]);
        const unsubscribe = vi.fn();
        backend.subscribeListChanges = vi.fn(() => new Promise((resolve) => { resolveSubscribe = resolve; }));
        const dashboard = controller(backend);
        const opening = dashboard.open();
        await vi.waitFor(() => expect(backend.subscribeListChanges).toHaveBeenCalled());
        await dashboard.close();
        resolveSubscribe?.(unsubscribe);
        await opening;
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
    it("cycles every filter, sort, and grouping from its own chord", async () => {
        const dashboard = controller(new FakeBackend([
            session("a", { taskState: "WORKING", processState: "LIVE", outcome: "NONE", activity: { kind: "approval", summary: "waiting", updatedAt: timestamp } }),
            session("b"),
        ]));
        await dashboard.open();
        dashboard.handleInput("\x06");
        dashboard.handleInput("w");
        dashboard.handleInput("\r");
        dashboard.handleInput("\x14");
        dashboard.handleInput("\x10");
        dashboard.handleInput("\x0f");
        dashboard.handleInput("\x01");
        dashboard.handleInput("\x13");
        dashboard.handleInput("\x02");
        expect(dashboard.query).toMatchObject({ search: "w", taskStates: ["WORKING"], processStates: ["LIVE"], outcomes: ["NONE"], activityKinds: ["approval"], sort: { key: "age", direction: "asc" }, groupBy: "taskState" });
        expect(dashboard.selectedSessionId).toBe("a");
        expect(dashboard.render(80, 14).join("\n")).toContain("a");
        // Only the working directory has a header row now; the rest are set through the slash menu.
        expect(dashboard.render(100, 16).join("\n")).toContain("cwd:");
    });
    it("cycles the project filter from Ctrl+W, because Ctrl+J is the Enter byte", async () => {
        const openSelectedViewer = vi.fn(async () => {});
        const dashboard = controller(new FakeBackend([session("a", { cwd: "/repo/alpha" })]), { openViewer: openSelectedViewer });
        await dashboard.open();
        // Ctrl+J is a line feed, so a terminal cannot tell it from Enter; it opens the selection.
        dashboard.handleInput("\n");
        await vi.waitFor(() => expect(openSelectedViewer).toHaveBeenCalledWith("a"));
        expect(dashboard.query.projectPaths).toBeUndefined();

        dashboard.handleInput("\x17");
        expect(dashboard.query.projectPaths).toEqual(["/repo/alpha"]);
    });
    it("leaves the launch fields to the slash commands: Tab moves nothing and Backspace only trims the prompt", async () => {
        const dashboard = controller(new FakeBackend([session("a")]));
        await dashboard.open();
        for (const character of "go") dashboard.handleInput(character);
        // Tab used to move an invisible cursor that typing ignored and Backspace obeyed, so a
        // Backspace after it silently ate the launch cwd.
        dashboard.handleInput("\t");
        dashboard.handleInput("\x7f");
        expect(dashboard.composerDraft.prompt).toBe("g");
        expect(dashboard.composerField).toBeUndefined();
        dashboard.handleInput("\x1b[Z");
        dashboard.handleInput("x");
        expect(dashboard.composerDraft.prompt).toBe("gx");
        expect(dashboard.composerDraft.cwd).toBe("/repo");
        expect(dashboard.composerDraft.model).toEqual({ provider: "anthropic", id: "claude" });
        expect(dashboard.composerDraft.name).toBe("new task");
        expect(dashboard.composerDraft.isolationMode).toBe("worktree");
    });
    it("shows the draft launch model, so a draft the operator cannot fix cannot poison a launch unseen", async () => {
        // The menu hint reads /model [provider/id]; typing it literally left this in the draft, and
        // /model now refuses the value that is still sitting in it.
        const dashboard = controller(new FakeBackend([session("a")]), { launchDefaults: { cwd: "/repo", model: { provider: "provider", id: "id" } } });
        await dashboard.open();
        expect(dashboard.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("model:provider/id"))).toBe(true);

        // A draft that carries no model of its own says nothing: Pi's default is not a setting.
        const plain = controller(new FakeBackend([session("a")]), { launchDefaults: { cwd: "/repo" } });
        await plain.open();
        expect(plain.render(100, 24).map(stripVTControlCharacters).some((line) => line.includes("model:"))).toBe(false);
    });
    describe("slash commands", () => {
        function typed(dashboard, text) {
            for (const character of text) dashboard.handleInput(character);
        }
        it("offers the command menu while the prompt is a slash and runs the highlighted command", async () => {
            const dashboard = controller(new FakeBackend([session("a")]));
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
        it("selects no thinking level for the next launch, in the draft or through a command", async () => {
            const dashboard = controller(new FakeBackend([session("a")]), { launchDefaults: { cwd: "/repo", thinkingLevel: "high" } });
            await dashboard.open();
            expect(Object.hasOwn(dashboard.composerDraft, "thinkingLevel")).toBe(false);
            typed(dashboard, "/thinking high");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "UNKNOWN_LIST_COMMAND" }));
            expect(dashboard.overlay).toBeUndefined();
            expect(Object.hasOwn(dashboard.composerDraft, "thinkingLevel")).toBe(false);
        });
        it("closes the menu on Escape and keeps the typed text editable", async () => {
            const showsMenu = (dashboard) => dashboard.render(80, 24).some((line) => stripVTControlCharacters(line).includes("/model"));
            const dashboard = controller(new FakeBackend([session("a")]));
            await dashboard.open();
            typed(dashboard, "/mo");
            expect(showsMenu(dashboard)).toBe(true);
            dashboard.handleInput("\x1b");
            expect(dashboard.composerDraft.prompt).toBe("/mo");
            expect(showsMenu(dashboard)).toBe(false);
            // Editing the mistyped name brings the menu back.
            dashboard.handleInput("\x7f");
            expect(dashboard.composerDraft.prompt).toBe("/m");
            expect(showsMenu(dashboard)).toBe(true);
        });
        it("picks a model from the values the list already knows and applies it to the draft", async () => {
            const backend = new FakeBackend([session("a", { model: { provider: "google", id: "gemini" } }), session("b")]);
            const dashboard = controller(backend);
            await dashboard.open();
            typed(dashboard, "/model");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "model", values: ["anthropic/claude", "google/gemini"] }));
            dashboard.handleInput("\x1b[B");
            dashboard.handleInput("\r");
            expect(dashboard.composerDraft.model).toEqual({ provider: "google", id: "gemini" });
            expect(dashboard.overlay).toBeUndefined();
            expect(dashboard.focus).toBe("list");
            expect(backend.requests).toEqual([]);
        });
        it("cancels a picker without changing the draft", async () => {
            const dashboard = controller(new FakeBackend([session("a")]));
            await dashboard.open();
            typed(dashboard, "/isolation");
            dashboard.handleInput("\r");
            expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "isolation", values: ["worktree", "shared_directory"] });
            dashboard.handleInput("\x1b");
            expect(dashboard.overlay).toBeUndefined();
            expect(dashboard.composerDraft.isolationMode).toBe("worktree");
            dashboard.handleInput("\x1b[B");
            expect(dashboard.selectedSessionId).toBe("a");
        });
        it("offers Pi's whole catalog on a cold dashboard, asking for it only when a picker needs it", async () => {
            const backend = new FakeBackend([]);
            backend.getModels = vi.fn(async () => [{ provider: "openai", id: "gpt-6", thinking: true }, { provider: "anthropic", id: "claude-opus-4", thinking: true }]);
            const dashboard = controller(backend, { launchDefaults: { cwd: "/repo" } });
            await dashboard.open();
            typed(dashboard, "/model");
            // Neither startup nor a keystroke spends a catalog read.
            expect(backend.getModels).not.toHaveBeenCalled();
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "model", values: ["anthropic/claude-opus-4", "openai/gpt-6"] }));
            dashboard.handleInput("\x1b");
            typed(dashboard, "/model");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "model" }));
            // The catalog is cached for the dashboard's life.
            expect(backend.getModels).toHaveBeenCalledTimes(1);
            // A picker for another field never reaches the daemon at all.
            dashboard.handleInput("\x1b");
            typed(dashboard, "/isolation");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "isolation" }));
            expect(backend.getModels).toHaveBeenCalledTimes(1);
        });
        it("names the daemon's own reason when it cannot list models, and asks again next time", async () => {
            const backend = new FakeBackend([session("a", { model: undefined, thinkingLevel: undefined })]);
            backend.getModels = vi.fn(async () => { throw Object.assign(new Error("Listing Pi models timed out"), { code: "MODEL_CATALOG_TIMEOUT" }); });
            const dashboard = controller(backend, { launchDefaults: { cwd: "/repo" } });
            await dashboard.open();
            typed(dashboard, "/model");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "MODEL_CATALOG_TIMEOUT", message: expect.stringContaining("Listing Pi models timed out") }));
            expect(dashboard.overlay).toBeUndefined();
            // A refusal keeps the text editable, and a failed read is never cached.
            expect(dashboard.composerDraft.prompt).toBe("/model");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(backend.getModels).toHaveBeenCalledTimes(2));
        });
        it("says so when it knows no model to offer, and still takes one typed in full", async () => {
            const backend = new FakeBackend([session("a", { model: undefined, thinkingLevel: undefined })]);
            const dashboard = controller(backend, { launchDefaults: { cwd: "/repo" } });
            await dashboard.open();
            typed(dashboard, "/model");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "MODEL_CHOICES_UNKNOWN" }));
            expect(dashboard.overlay).toBeUndefined();
            typed(dashboard, "\x7f".repeat(6));
            typed(dashboard, "/model openai/gpt-6");
            dashboard.handleInput("\r");
            expect(dashboard.composerDraft.model).toEqual({ provider: "openai", id: "gpt-6" });
            // An unknown model is carried to the daemon unchanged, so Pi refuses it at launch.
            typed(dashboard, "ship it");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(backend.requests).toHaveLength(1));
            expect(backend.requests[0]).toMatchObject({ prompt: "ship it", model: { provider: "openai", id: "gpt-6" } });
        });
        it("takes an existing directory and refuses anything else by name", async () => {
            const root = await mkdtemp(join(tmpdir(), "pi-agents-cwd-"));
            const file = join(root, "notes.txt");
            await writeFile(file, "", { mode: 0o600 });
            try {
                const backend = new FakeBackend([session("a")]);
                const dashboard = controller(backend);
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
                expect(backend.requests).toEqual([]);
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
        it("offers the typed directory's subdirectories, never its files, and descends into the one chosen", async () => {
            const root = await completionRoot();
            try {
                const dashboard = controller(new FakeBackend([session("a")]));
                await dashboard.open();
                typed(dashboard, `/cwd ${root}/alp`);
                await vi.waitFor(() => expect(completionLines(dashboard)).toContain("alpine/"));
                expect(completionLines(dashboard)).toContain("alpha/");
                // A file is a choice /cwd would refuse, so it is never offered.
                expect(completionLines(dashboard)).not.toContain("alpha.txt");
                // Down moves the completion list, not the session selection underneath it.
                dashboard.handleInput("\x1b[B");
                expect(dashboard.selectedSessionId).toBe("a");
                dashboard.handleInput("\x1b[A");
                dashboard.handleInput("\t");
                // The trailing separator is what makes the next Tab list that directory's own children.
                expect(dashboard.composerDraft.prompt).toBe(`/cwd ${root}/alpha/`);
                await vi.waitFor(() => expect(completionLines(dashboard)).toContain("nested/"));
                expect(dashboard.status).toEqual({ kind: "ready" });
                dashboard.handleInput("\r");
                await vi.waitFor(() => expect(dashboard.composerDraft.cwd).toBe(`${root}/alpha/`));
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
        it("lists the directory the dashboard was started in when no path is typed yet", async () => {
            // Typing the path blind is the failure: with no argument yet the list still has to say what
            // is there, and a relative path means what it would mean in the shell that started this.
            const dashboard = controller(new FakeBackend([session("a")]), { launchDefaults: { cwd: "/nowhere" } });
            await dashboard.open();
            typed(dashboard, "/cwd ");
            await vi.waitFor(() => expect(completionLines(dashboard)).toContain("app/"));
            expect(completionLines(dashboard)).not.toContain("README.md");
            typed(dashboard, "ap");
            // Typing narrows the list only once its own listing lands; Tab before that rewrites nothing.
            await vi.waitFor(() => expect(dashboard.pathCompletionOverlay()?.prefix).toBe("ap"));
            dashboard.handleInput("\t");
            expect(dashboard.composerDraft.prompt).toBe("/cwd app/");
        });
        it("lists a tilde path's real directory instead of matching a literal ~", async () => {
            const root = await completionRoot();
            const realHome = process.env.HOME;
            process.env.HOME = root;
            try {
                const dashboard = controller(new FakeBackend([session("a")]), { launchDefaults: { cwd: "/nowhere" } });
                await dashboard.open();
                typed(dashboard, "/cwd ~/alp");
                await vi.waitFor(() => expect(completionLines(dashboard)).toContain("alpha/"));
                dashboard.handleInput("\t");
                // The tilde survives completion, and /cwd expands it when the operator submits the line.
                expect(dashboard.composerDraft.prompt).toBe("/cwd ~/alpha/");
                dashboard.handleInput("\r");
                await vi.waitFor(() => expect(dashboard.composerDraft.cwd).toBe(`${root}/alpha/`));
            } finally {
                process.env.HOME = realHome;
                await rm(root, { recursive: true, force: true });
            }
        });
        it("discards a directory listing that lands after the operator has typed further", async () => {
            let releaseSlowListing = () => {};
            const listed = [];
            const suggestDirectories = async (argument) => {
                listed.push(argument);
                const item = (label) => ({ items: [{ value: `${argument}${label}/`, label: `${label}/` }], prefix: argument });
                if (argument === "slow/") return new Promise((resolve) => { releaseSlowListing = () => resolve(item("stale-entry")); });
                return item("fresh-entry");
            };
            const dashboard = controller(new FakeBackend([session("a")]), { suggestDirectories });
            await dashboard.open();
            typed(dashboard, "/cwd slow/");
            await vi.waitFor(() => expect(listed).toEqual(["slow/"]));
            typed(dashboard, "deep/");
            await vi.waitFor(() => expect(completionLines(dashboard)).toContain("fresh-entry/"));
            releaseSlowListing();
            await new Promise((resolve) => setTimeout(resolve, 5));
            // A list that lags behind the cursor names directories that do not exist under the typed path.
            expect(completionLines(dashboard)).not.toContain("stale-entry");
            expect(completionLines(dashboard)).toContain("fresh-entry/");
        });
        it("shows no list and no error when the typed directory cannot be listed", async () => {
            const suggestDirectories = vi.fn(async (argument) => { throw Object.assign(new Error(`EACCES: permission denied, scandir '${argument}'`), { code: "EACCES" }); });
            const dashboard = controller(new FakeBackend([session("a")]), { suggestDirectories });
            await dashboard.open();
            typed(dashboard, "/cwd secret/");
            await vi.waitFor(() => expect(suggestDirectories).toHaveBeenCalledWith("secret/", process.cwd(), expect.anything()));
            expect(dashboard.status).toEqual({ kind: "ready" });
            expect(completionLines(dashboard)).not.toContain("EACCES");
            // Tab has nothing listed to apply, so it leaves the typed text exactly as it is.
            dashboard.handleInput("\t");
            expect(dashboard.composerDraft.prompt).toBe("/cwd secret/");
        });
        it("drops the completion list when the line stops being a /cwd path", async () => {
            const suggestDirectories = async (argument) => ({ items: [{ value: "alpha/", label: "alpha/" }], prefix: argument });
            const dashboard = controller(new FakeBackend([session("a")]), { suggestDirectories });
            await dashboard.open();
            typed(dashboard, "/cwd al");
            await vi.waitFor(() => expect(completionLines(dashboard)).toContain("alpha/"));
            typed(dashboard, "\x7f\x7f\x7f");
            expect(dashboard.composerDraft.prompt).toBe("/cwd");
            expect(completionLines(dashboard)).not.toContain("alpha/");
        });
        it("clears the draft name so the agent names the session itself", async () => {
            const dashboard = controller(new FakeBackend([]));
            await dashboard.open();
            typed(dashboard, "/name Coverage loader");
            dashboard.handleInput("\r");
            expect(dashboard.composerDraft.name).toBe("Coverage loader");
            typed(dashboard, "/name");
            dashboard.handleInput("\r");
            expect(dashboard.composerDraft.name).toBe("");
        });
        it("opens the help overlay from /help, leading space and all", async () => {
            const backend = new FakeBackend([]);
            const dashboard = controller(backend);
            await dashboard.open();
            typed(dashboard, " /help");
            expect(dashboard.render(80, 24).some((line) => stripVTControlCharacters(line).includes("/help"))).toBe(true);
            dashboard.handleInput("\r");
            expect(dashboard.overlay).toMatchObject({ kind: "help" });
            expect(dashboard.composerDraft.prompt).toBe("");
            expect(backend.requests).toEqual([]);
        });
        it("refuses an unknown command by name and launches nothing", async () => {
            const openSelectedViewer = vi.fn(async () => {});
            const backend = new FakeBackend([session("a")]);
            const dashboard = controller(backend, { openViewer: openSelectedViewer });
            await dashboard.open();
            typed(dashboard, "/logni now");
            dashboard.handleInput("\r");
            expect(dashboard.status).toMatchObject({ kind: "error", code: "UNKNOWN_LIST_COMMAND", message: expect.stringContaining("/logni") });
            expect(dashboard.status.message).toContain("/model");
            expect(dashboard.composerDraft.prompt).toBe("/logni now");
            expect(backend.requests).toEqual([]);
            expect(openSelectedViewer).not.toHaveBeenCalled();
        });
        it("narrows a catalog-sized picker as the operator types and stays inside every width", async () => {
            const models = Array.from({ length: 300 }, (_, index) => ({ provider: index % 2 ? "anthropic" : "openai", id: `model-${String(index).padStart(3, "0")}-with-a-deliberately-long-identifier`, thinking: true }));
            const backend = new FakeBackend([]);
            backend.getModels = vi.fn(async () => models);
            const dashboard = controller(backend, { launchDefaults: { cwd: "/repo" } });
            await dashboard.open();
            typed(dashboard, "/model");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "model" }));
            expect(dashboard.overlay.values).toHaveLength(300);
            for (const width of [40, 55, 80, 120, 160]) {
                for (const height of [24, 10]) {
                    const lines = dashboard.render(width, height);
                    expect(lines, `${width}x${height}`).toHaveLength(height);
                    expect(lines.every((line) => visibleWidth(line) <= width), `${width}x${height}`).toBe(true);
                }
            }
            // 300 rows never reach the screen: the picker draws one windowful between header and dock.
            const windowRows = createDashboardLayout(80, 24);
            expect(dashboard.render(80, 24).filter((line) => stripVTControlCharacters(line).includes("-with-a-deliberately-long-identifier")).length)
                .toBeLessThanOrEqual(24 - windowRows.listTop - windowRows.dockRows);
            typed(dashboard, "model-137");
            expect(dashboard.overlay.values).toEqual(["anthropic/model-137-with-a-deliberately-long-identifier"]);
            dashboard.handleInput("\r");
            expect(dashboard.composerDraft.model).toEqual({ provider: "anthropic", id: "model-137-with-a-deliberately-long-identifier" });
            expect(dashboard.overlay).toBeUndefined();
        });
        it("keeps a picker open when the typed filter matches nothing, and pages through a long one", async () => {
            const models = Array.from({ length: 300 }, (_, index) => ({ provider: "openai", id: `model-${String(index).padStart(3, "0")}`, thinking: false }));
            const backend = new FakeBackend([]);
            backend.getModels = vi.fn(async () => models);
            const dashboard = controller(backend, { launchDefaults: { cwd: "/repo" } });
            await dashboard.open();
            dashboard.resize(80, 24);
            typed(dashboard, "/model");
            dashboard.handleInput("\r");
            await vi.waitFor(() => expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "model" }));
            // What was typed and how much it left must be on screen; the prompt was cleared to open the picker.
            typed(dashboard, "model-13");
            expect(dashboard.render(80, 24).map(stripVTControlCharacters).some((line) => line.includes("Model 1/10 · model-13"))).toBe(true);
            typed(dashboard, "\x7f".repeat(8));
            typed(dashboard, "zzz");
            expect(dashboard.overlay.values).toEqual([]);
            expect(dashboard.render(80, 24).map(stripVTControlCharacters).some((line) => line.includes("Nothing matches zzz"))).toBe(true);
            // Enter with nothing to apply leaves the picker open so the filter can be corrected.
            dashboard.handleInput("\r");
            expect(dashboard.overlay).toMatchObject({ kind: "choice", field: "model", filter: "zzz" });
            typed(dashboard, "\x7f\x7f\x7f");
            expect(dashboard.overlay.values).toHaveLength(300);
            expect(dashboard.overlay.index).toBe(0);
            dashboard.handleInput("\x1b[6~");
            expect(dashboard.overlay.index).toBeGreaterThan(1);
            dashboard.handleInput("\x1b[5~");
            expect(dashboard.overlay.index).toBe(0);
        });
        it.each([40, 55, 80, 120, 160])("keeps the menu and the picker inside %i columns", async (width) => {
            const dashboard = controller(new FakeBackend([
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
        const dashboards = ["alpha", "beta", "gamma"].map((name) => controller(new FakeBackend([session("a"), session("b"), session("c")]), { persistence: sharedFrontendStore, sourceSessionId: `source-${name}` }));
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
        const firstBackend = new FakeBackend([]);
        const first = controller(firstBackend, { sourceSessionId: "session-a" });
        await first.open();
        first.setComposerPrompt("from A");
        await first.close();
        const secondBackend = new FakeBackend([]);
        const second = controller(secondBackend, { sourceSessionId: "session-b" });
        await second.open();
        second.setComposerPrompt("from B");
        await second.submitComposer();
        expect(secondBackend.requests[0]).toMatchObject({ sourceSessionId: "session-b", prompt: "from B" });
        expect(first.composerDraft.prompt).toBe("from A");
    });
});
describe("daemon dashboard backend", () => {
    // A destructive command claims nothing: it carries the installation clientId, its own request ID,
    // and an exact revision, and that is the whole authorization the daemon needs.
    it.each(["stop", "delete"])("sends %s alone, with no attachment around it", async (operation) => {
        const requests = [];
        const client = {
            async connect() {},
            async request(request) {
                requests.push(request);
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "command", sessionId: "exact-session" } };
            },
            subscribe() { return { async *[Symbol.asyncIterator]() {} }; },
        };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await backend[operation]("exact-session", 3, `${operation}-request`);
        expect(requests).toEqual([{ version: 1, clientId: "stable-client", requestId: `${operation}-request`, op: operation, payload: { sessionId: "exact-session", revision: 3 } }]);
    });
    // An ambiguous transport failure after submission is never replayed silently: it becomes
    // DELIVERY_UNKNOWN, carrying the identity the operator needs to resolve it explicitly.
    it.each([
        ["stop", "a disconnected socket", Object.assign(new Error("socket closed"), { code: "CONNECTION_CLOSED", submitted: true })],
        ["delete", "a malformed daemon frame", Object.assign(new Error("malformed daemon frame"), { code: "MALFORMED_FRAME" })],
        ["stop", "an unparseable response for this request", Object.assign(new Error("unparseable response"), { code: "MALFORMED_RESPONSE", submitted: true })],
    ])("classifies %s interrupted by %s as delivery unknown", async (operation, _label, failure) => {
        const requests = [];
        const transaction = {
            async connect() {},
            async request(request) {
                requests.push(request.op);
                throw failure;
            },
            async close() {},
        };
        const backend = createDaemonDashboardBackend({ client: { createTransactionClient: () => transaction }, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await expect(backend[operation]("exact-session", 3, `${operation}-request`)).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "stable-client", requestId: `${operation}-request` });
        expect(requests).toEqual([operation]);
    });
    it.each(["stop", "delete"])("treats a refused %s as a structured refusal", async (operation) => {
        const client = {
            async connect() { },
            async request(request) {
                return { version: 1, requestId: request.requestId, ok: false, error: { code: "SESSION_REFUSED", message: `${operation} refused`, retryable: false } };
            },
            subscribe() { return { async *[Symbol.asyncIterator]() { } }; },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client: client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await expect(backend[operation]("exact-session", 3, `${operation}-request`)).rejects.toMatchObject({ code: "SESSION_REFUSED", message: `${operation} refused` });
    });
    it("reads current rows for every invalidation, so a completed Delete removes the absent row", async () => {
        const deleted = session("deleted", { processState: "EXITED" });
        let stateReads = 0;
        /** @type {(() => void) | undefined} */
        let invalidate;
        const client = {
            async connect() { },
            async request(request) {
                stateReads += 1;
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "state", sessions: stateReads === 1 ? [deleted] : [], cursor: nextCoverage() } };
            },
            async subscribeListChanges(onChanged) { invalidate = onChanged; return () => { invalidate = undefined; }; },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        const invalidations = [];
        const unsubscribe = await backend.subscribeListChanges(() => { invalidations.push(1); }, () => { });
        expect((await backend.getSnapshot()).sessions).toHaveLength(1);
        invalidate?.();
        expect(invalidations).toHaveLength(1);
        expect((await backend.getSnapshot()).sessions).toEqual([]);
        expect(stateReads).toBe(2);
        unsubscribe();
    });
    // Operator-visible failure: a snapshot with no stated coverage cannot be told from one taken
    // before the change that provoked the read, so the list could sit on a row that never updated.
    it("refuses a get_state result that carries no coverage cursor", async () => {
        const client = {
            async connect() { },
            async request(request) {
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "state", sessions: [] } };
            },
            async subscribeListChanges() { return () => { }; },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await expect(backend.getSnapshot()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    });
    it("reports a refused list subscription instead of returning a list that never refreshes", async () => {
        const client = {
            async connect() { },
            async request(request) { return { version: 1, requestId: request.requestId, ok: true, result: { kind: "state", sessions: [], cursor: nextCoverage() } }; },
            async subscribeListChanges() { throw Object.assign(new Error("Invalid client request"), { code: "INVALID_REQUEST" }); },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await expect(backend.subscribeListChanges(() => { }, () => { })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    });
    it("reads the model catalog through get_models and names a daemon that cannot list one", async () => {
        const models = [{ provider: "anthropic", id: "claude-opus-4", thinking: true }];
        const operations = [];
        let refusals = 0;
        const client = {
            async connect() { },
            async request(request) {
                operations.push(request.op);
                if (refusals++ > 0) return { version: 1, requestId: request.requestId, ok: false, error: { code: "MODEL_CATALOG_TIMEOUT", message: "Listing Pi models timed out", retryable: true } };
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "models", models } };
            },
            subscribe() { return { async *[Symbol.asyncIterator]() { } }; },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await expect(backend.getModels()).resolves.toEqual(models);
        await expect(backend.getModels()).rejects.toMatchObject({ code: "MODEL_CATALOG_TIMEOUT", message: "Listing Pi models timed out" });
        expect(operations).toEqual(["get_models", "get_models"]);
    });
    it("sends nothing on the wire for an invalidation and stops notifying once unsubscribed", async () => {
        const requests = [];
        /** @type {(() => void) | undefined} */
        let invalidate;
        const client = {
            async connect() { },
            async request(request) {
                requests.push(request.op);
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "state", sessions: [], cursor: nextCoverage() } };
            },
            async subscribeListChanges(onChanged) { invalidate = onChanged; return () => { invalidate = undefined; }; },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        const invalidations = [];
        const unsubscribe = await backend.subscribeListChanges(() => { invalidations.push(1); }, () => { });
        invalidate?.();
        invalidate?.();
        expect(invalidations).toHaveLength(2);
        // An invalidation costs no request: no acknowledgement, no cursor, no replay.
        expect(requests).toEqual([]);
        unsubscribe();
        expect(invalidate).toBeUndefined();
    });
});

describe("mouse clicks", () => {
    it("selects the clicked session and opens it when it is already selected", async () => {
        const backend = new FakeBackend([session("a"), session("b"), session("c")]);
        const opened = [];
        const dashboard = controller(backend, { openViewer: async (id) => { opened.push(id); } });
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

    it("ignores a click below the last session", async () => {
        const backend = new FakeBackend([session("a")]);
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.render(100, 24);
        const layout = createDashboardLayout(100, 24);
        dashboard.handleMouse({ button: "left", column: 4, row: layout.listTop + 6 });
        expect(dashboard.selectedSessionId).toBe("a");
    });

    it("does nothing at all where the layout draws no target", async () => {
        const backend = new FakeBackend([session("a", { cwd: "/repo/alpha" }), session("b", { cwd: "/repo/beta" })]);
        const opened = [];
        const dashboard = controller(backend, { openViewer: async (id) => { opened.push(id); } });
        await dashboard.open();
        dashboard.render(100, 24);
        const layout = createDashboardLayout(100, 24);
        const dockTop = 24 - layout.dockRows;
        const before = { ...dashboard.query };
        // The title, the selected session's path, the cwd row, the section border, the column
        // header, both prompt rules, and the status line are all read-only.
        for (const row of [0, 1, 2, layout.listTop - 2, layout.listTop - 1, dockTop, dockTop + 2, dockTop + 3]) {
            for (const column of [0, 2, 40, 99]) {
                dashboard.handleMouse({ button: "left", column, row });
                expect(dashboard.query, `row ${row} column ${column}`).toEqual(before);
                expect(dashboard.focus, `row ${row} column ${column}`).toBe("list");
                expect(dashboard.selectedSessionId, `row ${row} column ${column}`).toBe("a");
            }
        }
        expect(opened).toEqual([]);
        expect(dashboard.composerDraft.cwd).toBe("/repo");
    });

    it("puts the search box away when the prompt row is clicked, wherever the dock sits", async () => {
        for (const height of [24, 11]) {
            const dashboard = controller(new FakeBackend([session("a")]));
            await dashboard.open();
            dashboard.render(100, height);
            const layout = createDashboardLayout(100, height);
            dashboard.handleInput("\x06");
            expect(dashboard.focus).toBe("search");
            // The cwd row is not a click target, so the search box keeps the keystrokes.
            dashboard.handleMouse({ button: "left", column: 4, row: 2 });
            expect(dashboard.focus, `height ${height}`).toBe("search");
            dashboard.handleMouse({ button: "left", column: 4, row: height - layout.dockRows + 1 });
            expect(dashboard.focus, `height ${height}`).toBe("list");
        }
    });
});
describe("wheel scrolling", () => {
    it("moves the selection up and down from wheel events", async () => {
        const dashboard = controller(new FakeBackend([session("a"), session("b"), session("c"), session("d"), session("e")]));
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

it("rests a dimmed cursor on the placeholder's first character until the operator types", async () => {
  // An empty prompt must read as a caret waiting, not as text the operator has to delete.
  const dashboard = controller(new FakeBackend([]));
  await dashboard.open();

  const rows = dashboard.render(80, 20).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  expect(rows.join("\n")).toContain("describe a task for a new session");
  const cursorRow = dashboard.render(80, 20).find((line) => line.includes("escribe a task"));
  expect(cursorRow).toContain(`${JOBWATCH_ANSI.selectionBackground}${JOBWATCH_ANSI.gray}d`);

  dashboard.setComposerPrompt("hello");
  const typed = dashboard.render(80, 20).join("\n");
  expect(typed).not.toContain("describe a task for a new session");
  expect(typed).toContain("hello");
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
    const dashboard = controller(new FakeBackend(Array.from({ length: 40 }, (_, index) => session(`s-${index}`))));
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

  it("caps the prompt box at Pi's editor height and keeps the tail of a longer draft visible", async () => {
    const dashboard = controller(new FakeBackend([session("a")]));
    await dashboard.open();
    dashboard.setComposerPrompt(CAPPED_DRAFT);
    const lines = dashboard.render(60, 24);
    const rows = promptRows(lines);

    // pi-tui's Editor shows max(5, 30% of the terminal): 7 rows at height 24.
    expect(rows).toHaveLength(7);
    expect(rows.at(-1)).toContain("word199");
    expect(rows.join(" ")).not.toMatch(/word0\b/u);
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it("never takes the last list row, however long the draft and however short the terminal", async () => {
    const dashboard = controller(new FakeBackend([session("a")]));
    await dashboard.open();
    dashboard.setComposerPrompt(CAPPED_DRAFT);
    for (const height of [24, 12, 11, 9]) {
      const lines = dashboard.render(60, height);
      expect(lines, `height ${height}`).toHaveLength(height);
      expect(listRowCount(lines), `height ${height}`).toBeGreaterThanOrEqual(1);
      expect(lines.every((line) => visibleWidth(line) <= 60), `height ${height}`).toBe(true);
    }
  });

  it("wraps a wide-character draft without splitting a cell", async () => {
    const draft = "検証中🚀のセッションをNotionとSlackのMCPサーバーに接続して結果を要約してください";
    const dashboard = controller(new FakeBackend([session("a")]));
    await dashboard.open();
    dashboard.setComposerPrompt(draft);
    const lines = dashboard.render(40, 24);
    const rows = promptRows(lines);

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join("").replace(/\s+/gu, "")).toBe(`❯${draft}`.replace(/\s+/gu, ""));
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
  });

  it("keeps the /cwd completion list flush above a prompt several rows tall", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agents-tall-prompt-"));
    await mkdir(join(root, "a-directory-name-long-enough-to-wrap-the-prompt", "nested"), { recursive: true });
    try {
      const dashboard = controller(new FakeBackend([session("a")]));
      await dashboard.open();
      for (const character of `/cwd ${root}/a-directory-name-long-enough-to-wrap-the-prompt/`) dashboard.handleInput(character);
      await vi.waitFor(() => expect(dashboard.pathCompletionOverlay()).toBeDefined());

      const lines = dashboard.render(60, 24);
      const plain = lines.map(stripVTControlCharacters);
      expect(promptRows(lines).length).toBeGreaterThan(2);
      const openRule = plain.flatMap((line, index) => /^─+$/u.test(line.trim()) ? [index] : []).at(-2);
      // The completion list ends on the row directly above the rule, wherever the taller prompt put it.
      expect(plain[openRule - 1].trim()).not.toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
