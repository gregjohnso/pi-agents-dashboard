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
class FakeBackend {
    snapshot;
    listener;
    errorListener;
    unsubscribed = 0;
    requests = [];
    stop = vi.fn();
    delete = vi.fn();
    resolveDelivery = vi.fn(async () => { });
    constructor(sessions) {
        this.snapshot = { sessions };
    }
    async getSnapshot() { return this.snapshot; }
    subscribe(after, listener, onError) {
        this.subscribedAfter = after;
        this.listener = listener;
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
function persistence(initial = undefined) {
    const saved = [];
    return {
        saved,
        async load() { return initial; },
        async save(value) { saved.push(value); },
    };
}
const openViewer = vi.fn(async () => {});
function controller(backend, overrides = {}) {
    return new DashboardController({
        backend,
        persistence: persistence(),
        openViewer,
        clientId: "stable-client",
        sourceSessionId: "source",
        launchDefaults: { cwd: "/repo", model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high", name: "new task" },
        requestRender: vi.fn(),
        ...overrides,
    });
}
/**
 * A destructive backend call that keys its command the way runtime/command-journal.mjs does:
 * one request ID owns one exact payload, and the same ID with a changed revision is a conflict.
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
async function processRenderedEvent(dashboard, backend, update) {
    const processing = Promise.resolve(backend.listener?.(update));
    dashboard.render();
    await processing;
}
describe("dashboard controller", () => {
    it("keeps selection by canonical session ID through live reorder and resize", async () => {
        const backend = new FakeBackend([session("a"), session("b"), session("c")]);
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.handleInput("\x1b[B");
        expect(dashboard.selectedSessionId).toBe("b");
        await processRenderedEvent(dashboard, backend, { snapshot: { sessions: [session("c"), session("a"), session("b", { revision: 2 })] }, cursor: { daemonEpoch: "epoch", sequence: "1" } });
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
        backend.getSnapshot = vi.fn(async () => ({ sessions: [session("a", { processState: "LIVE", revision: 9 })] }));
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
        backend.getSnapshot = vi.fn(async () => ({ sessions: [session("a", { taskState: "FAILED", processState: "EXITED", revision: 25 })] }));
        dashboard.setView("all");
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        dashboard.handleInput("\x18");
        await vi.waitFor(() => expect(backend.delete).toHaveBeenCalledWith("a", 25, expect.any(String)));
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
        expect(new Set(journal.requestIds).size).toBe(journal.requestIds.length);
    });
    it("coalesces cursor saves across a burst of events and flushes on close", async () => {
        // Each save fsyncs the file and its directory, about 70ms on a network home, so one save per
        // event stalls the list while an agent streams.
        const backend = new FakeBackend([session("a")]);
        const saves = [];
        const dashboard = controller(backend, { persistence: { async load() { return undefined; }, async save(value) { saves.push(value.cursor?.sequence); } } });
        await dashboard.open();
        const before = saves.length;
        const burst = [1, 2, 3, 4, 5].map((sequence) => Promise.resolve(backend.listener?.({
            snapshot: { sessions: [session("a", { revision: sequence })] },
            cursor: { daemonEpoch: "epoch", sequence: String(sequence) },
        })));
        // Each queued event waits for a host render, so keep rendering while the burst drains.
        const ticker = setInterval(() => dashboard.render(), 5);
        try { await Promise.all(burst); } finally { clearInterval(ticker); }
        expect(saves.length - before).toBeLessThan(5);
        await dashboard.close();
        // Whatever was coalesced is durable once the dashboard has closed.
        expect(saves.at(-1)).toBe("5");
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
        const update = Promise.resolve(backend.listener?.({ snapshot: { sessions: [session("a", { revision: 2 })] }, cursor: { daemonEpoch: "epoch", sequence: "2" } }));
        // A queued event drains on a host render, so keep rendering until it lands.
        const ticker = setInterval(() => dashboard.render(100, 24), 5);
        try { await update; } finally { clearInterval(ticker); }
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
    it("surfaces DELIVERY_UNKNOWN actions and never automatically retries", async () => {
        const backend = new FakeBackend([]);
        backend.launch = vi.fn(async () => ({ kind: "delivery_unknown", clientId: "stable-client", requestId: "launch-unknown" }));
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.setComposerPrompt("Implement it");
        await dashboard.submitComposer();
        expect(backend.launch).toHaveBeenCalledTimes(1);
        expect(dashboard.overlay).toMatchObject({ kind: "delivery_unknown", actions: ["retry_at_risk", "abandon"] });
        await dashboard.resolveUnknownDelivery("abandon");
        expect(backend.resolveDelivery).toHaveBeenCalledWith("stable-client", "launch-unknown", "abandon");
        expect(backend.launch).toHaveBeenCalledTimes(1);
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
            ["delivery unknown", async (dashboard, backend) => {
                backend.launch = vi.fn(async () => ({ kind: "delivery_unknown", clientId: "stable-client", requestId: "launch-unknown" }));
                dashboard.setComposerPrompt("Implement it");
                await dashboard.submitComposer();
            }, "Delivery unknown", "retry_at_risk"],
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
    // made the daemon replay the whole log at once, and the list died before it drew a row.
    it("subscribes from the daemon's own position, not from a persisted cursor thousands of events behind", async () => {
        const backend = new FakeBackend([session("a"), session("b")]);
        backend.snapshot = { sessions: backend.snapshot.sessions, cursor: { daemonEpoch: "epoch", sequence: "6778" } };
        const saved = persistence({ schemaVersion: 1, clientId: "stable-client", cursor: { daemonEpoch: "epoch", sequence: "2" }, viewState: {}, launchDraft: {} });
        const dashboard = controller(backend, { persistence: saved });
        await dashboard.open();
        expect(dashboard.status).toEqual({ kind: "ready" });
        expect(backend.subscribedAfter).toEqual({ daemonEpoch: "epoch", sequence: "6778" });
        expect(dashboard.sessions.map((record) => record.sessionId)).toEqual(["a", "b"]);
        await dashboard.close();
        expect(saved.saved.at(-1)?.cursor).toEqual({ daemonEpoch: "epoch", sequence: "6778" });
    });
    it("keeps the persisted cursor against a daemon that does not report its position", async () => {
        const backend = new FakeBackend([session("a")]);
        const saved = persistence({ schemaVersion: 1, clientId: "stable-client", cursor: { daemonEpoch: "epoch", sequence: "2" }, viewState: {}, launchDraft: {} });
        const dashboard = controller(backend, { persistence: saved });
        await dashboard.open();
        expect(backend.subscribedAfter).toEqual({ daemonEpoch: "epoch", sequence: "2" });
        await dashboard.close();
    });
    // Operator-visible failure: every crash rewrote frontend-state.json with a cursor at the start of
    // the log, or with no cursor at all, so the next start replayed the same flood.
    it("never persists a cursor behind the position it reached, even when open fails", async () => {
        const backend = new FakeBackend([session("a")]);
        backend.snapshot = { sessions: backend.snapshot.sessions, cursor: { daemonEpoch: "epoch", sequence: "6778" } };
        backend.subscribeFailure = Object.assign(new Error("Client subscriber exceeded its bounded queue"), { code: "SUBSCRIBER_OVERFLOW" });
        const saved = persistence({ schemaVersion: 1, clientId: "stable-client", cursor: { daemonEpoch: "epoch", sequence: "2" }, viewState: {}, launchDraft: {} });
        const dashboard = controller(backend, { persistence: saved });
        await dashboard.open();
        await dashboard.close();
        expect(saved.saved.length).toBeGreaterThan(0);
        for (const state of saved.saved) expect(state.cursor).toEqual({ daemonEpoch: "epoch", sequence: "6778" });
    });
    it("restores safe view state and cursor but never stale composer ownership", async () => {
        const saved = persistence({
            schemaVersion: 1,
            clientId: "stable-client",
            cursor: { daemonEpoch: "epoch", sequence: "4" },
            viewState: { query: { view: "all", search: "b" }, selectedSessionId: "b" },
        });
        const dashboard = controller(new FakeBackend([session("a"), session("b")]), { persistence: saved });
        await dashboard.open();
        expect(dashboard.query).toMatchObject({ view: "all", search: "b" });
        expect(dashboard.selectedSessionId).toBe("b");
        expect(dashboard.attachmentRole).toBeUndefined();
        await dashboard.close();
        expect(saved.saved.length).toBeGreaterThan(0);
    });
    it("serializes concurrent events through distinct rendered states and acknowledgements", async () => {
        const backend = new FakeBackend([session("initial")]);
        const saved = persistence();
        const renders = [];
        const acknowledgements = [];
        let dashboard;
        dashboard = controller(backend, {
            persistence: {
                load: saved.load,
                async save(state) {
                    await saved.save(state);
                    if (state.cursor !== undefined)
                        acknowledgements.push(state.cursor.sequence);
                },
            },
            requestRender: () => { renders.push(dashboard.render(80, 12)); },
        });
        await dashboard.open();
        renders.length = 0;
        const first = Promise.resolve(backend.listener?.({ snapshot: { sessions: [session("state-1")] }, cursor: { daemonEpoch: "epoch", sequence: "1" } }));
        const second = Promise.resolve(backend.listener?.({ snapshot: { sessions: [session("state-2")] }, cursor: { daemonEpoch: "epoch", sequence: "2" } }));
        await first;
        expect(renders).toHaveLength(2);
        expect(renders[0]?.join("\n")).toContain("state-1");
        expect(renders[0]?.join("\n")).not.toContain("state-2");
        await second;
        expect(renders[1]?.join("\n")).toContain("state-2");
        // Cursors advance monotonically, so a burst persists once and the newest cursor covers the rest.
        expect(acknowledgements).toEqual(["2"]);
    });
    it.each(["render", "request", "persistence", "disposed"])("closes on %s failure so the backend sends no acknowledgement", async (failure) => {
        const backend = new FakeBackend([session("a")]);
        const onClose = vi.fn();
        const saved = persistence();
        let renderRequests = 0;
        if (failure === "persistence")
            saved.save = vi.fn(async () => { throw Object.assign(new Error("disk failed"), { code: "PERSIST_FAILED" }); });
        const dashboard = controller(backend, {
            persistence: saved,
            onClose,
            requestRender: () => {
                renderRequests += 1;
                if (failure === "request" && renderRequests > 1)
                    throw new Error("request render failed");
            },
        });
        await dashboard.open();
        if (failure === "render") {
            const internals = dashboard;
            internals.list.renderViewport = () => { throw new Error("render failed"); };
        }
        const processing = Promise.resolve(backend.listener?.({ snapshot: { sessions: [session("a", { revision: 2 })] }, cursor: { daemonEpoch: "epoch", sequence: "1" } }));
        if (failure === "disposed")
            await dashboard.close();
        else if (failure === "render")
            expect(() => dashboard.render()).toThrowError("render failed");
        else if (failure !== "request")
            dashboard.render();
        await expect(processing).rejects.toThrow();
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ kind: failure === "disposed" ? "closed" : "error" })));
        expect(backend.unsubscribed).toBe(1);
        expect(saved.saved.some((state) => state.cursor?.sequence === "1")).toBe(false);
    });
    it("disposes a subscription that resolves after close and installs nothing", async () => {
        let resolveSubscribe;
        const backend = new FakeBackend([session("a")]);
        const unsubscribe = vi.fn();
        backend.subscribe = vi.fn(() => new Promise((resolve) => { resolveSubscribe = resolve; }));
        const dashboard = controller(backend);
        const opening = dashboard.open();
        await vi.waitFor(() => expect(backend.subscribe).toHaveBeenCalled());
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
    it("shows a persisted launch model, so a draft the operator cannot fix cannot poison a launch unseen", async () => {
        // The menu hint reads /model [provider/id]; typing it literally persisted this draft, and
        // /model now refuses the value that is still sitting in it.
        const stored = {
            schemaVersion: 1,
            clientId: "stable-client",
            cursor: { daemonEpoch: "epoch", sequence: "1" },
            viewState: { query: { view: "live" } },
            launchDraft: { prompt: "", cwd: "/repo", isolationMode: "worktree", model: { provider: "provider", id: "id" }, name: "" },
        };
        const dashboard = controller(new FakeBackend([session("a")]), { persistence: persistence(stored) });
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
    it("never persists source ownership and derives it from each current Pi session", async () => {
        let current;
        const shared = {
            async load() { return current; },
            async save(state) { current = structuredClone(state); },
        };
        const firstBackend = new FakeBackend([]);
        const first = controller(firstBackend, { persistence: shared, sourceSessionId: "session-a" });
        await first.open();
        first.setComposerPrompt("from A");
        await first.close();
        expect(current?.launchDraft).not.toHaveProperty("sourceSessionId");
        const secondBackend = new FakeBackend([]);
        const second = controller(secondBackend, { persistence: shared, sourceSessionId: "session-b" });
        await second.open();
        await second.submitComposer();
        expect(secondBackend.requests[0]).toMatchObject({ sourceSessionId: "session-b", prompt: "from A" });
    });
});
describe("daemon dashboard backend", () => {
    it.each(["stop", "delete"])("claims composer on the same client for %s and detaches afterward", async (operation) => {
        const operations = [];
        const client = {
            async connect() {},
            async request(request) {
                operations.push(request.op);
                if (request.op === "attach") return { version: 1, requestId: request.requestId, ok: true, result: { kind: "attached", sessionId: "exact-session", role: "composer" } };
                if (request.op === "detach") return { version: 1, requestId: request.requestId, ok: true, result: { kind: "detached", sessionId: "exact-session" } };
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "command", status: { clientId: "stable-client", requestId: request.requestId, operation, stage: "COMPLETED", acceptedAt: timestamp, updatedAt: timestamp } } };
            },
            subscribe() { return { async *[Symbol.asyncIterator]() {} }; },
        };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await backend[operation]("exact-session", 3, `${operation}-request`);
        expect(operations).toEqual(["attach", operation, "detach"]);
    });
    // An ambiguous transport failure after submission is never replayed silently: it becomes
    // DELIVERY_UNKNOWN, carrying the identity the operator needs to resolve it explicitly.
    it.each([
        ["stop", "a disconnected composer socket", Object.assign(new Error("socket closed"), { code: "CONNECTION_CLOSED", submitted: true })],
        ["delete", "a malformed daemon frame", Object.assign(new Error("malformed daemon frame"), { code: "MALFORMED_FRAME" })],
        ["stop", "an unparseable response for this request", Object.assign(new Error("unparseable response"), { code: "MALFORMED_RESPONSE", submitted: true })],
    ])("classifies %s interrupted by %s as delivery unknown", async (operation, _label, failure) => {
        const requests = [];
        const transaction = {
            async connect() {},
            async request(request) {
                requests.push(request.op);
                if (request.op === "attach") return { version: 1, requestId: request.requestId, ok: true, result: { kind: "attached", sessionId: "exact-session", role: "composer" } };
                throw failure;
            },
            async close() {},
        };
        const backend = createDaemonDashboardBackend({ client: { createTransactionClient: () => transaction }, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await expect(backend[operation]("exact-session", 3, `${operation}-request`)).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "stable-client", requestId: `${operation}-request` });
        expect(requests).toEqual(["attach", operation]);
    });
    it.each(["stop", "delete"])("treats durable %s FAILED as a structured refusal", async (operation) => {
        const status = { clientId: "stable-client", requestId: `${operation}-request`, operation, stage: "FAILED", acceptedAt: timestamp, updatedAt: timestamp, error: { code: "SESSION_REFUSED", message: `${operation} refused`, retryable: false } };
        const client = {
            async connect() { },
            async request(request) {
                if (request.op === "attach") return { version: 1, requestId: request.requestId, ok: true, result: { kind: "attached", sessionId: "exact-session", role: "composer" } };
                if (request.op === "detach") return { version: 1, requestId: request.requestId, ok: true, result: { kind: "detached", sessionId: "exact-session" } };
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "command", status } };
            },
            subscribe() { return { async *[Symbol.asyncIterator]() { } }; },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client: client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await expect(backend[operation]("exact-session", 3, `${operation}-request`)).rejects.toMatchObject({ code: "SESSION_REFUSED", message: `${operation} refused` });
    });
    it("refreshes state after completed Delete command_changed and removes the absent row", async () => {
        const cursor = { daemonEpoch: "epoch", sequence: "1" };
        const deleted = session("deleted", { processState: "EXITED" });
        const event = { version: 1, cursor, occurredAt: timestamp, kind: "command_changed", payload: { status: { clientId: "stable-client", requestId: "delete-request", operation: "delete", stage: "COMPLETED", acceptedAt: timestamp, updatedAt: timestamp } } };
        let stateReads = 0;
        const client = {
            async connect() { },
            async request(request) {
                if (request.op === "get_state") {
                    stateReads += 1;
                    return { version: 1, requestId: request.requestId, ok: true, result: { kind: "state", sessions: stateReads === 1 ? [deleted] : [] } };
                }
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "acknowledged", cursor: request.payload.cursor } };
            },
            subscribe() { return { async *[Symbol.asyncIterator]() { yield event; } }; },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client: client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        expect((await backend.getSnapshot()).sessions).toHaveLength(1);
        const updates = [];
        const unsubscribe = await backend.subscribe(undefined, (update) => { updates.push(update); }, () => { });
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        expect(updates[0]?.snapshot.sessions).toEqual([]);
        expect(stateReads).toBe(2);
        unsubscribe();
    });
    // Operator-visible failure: a session that changed while the client was behind kept its old row
    // forever, because the dropped session_changed was never replaced by an authoritative read.
    it("resynchronizes from the snapshot on overflow and shows the session that changed during the gap", async () => {
        const resynchronize = { kind: "resynchronize", cursor: { daemonEpoch: "epoch", sequence: "9" } };
        // A late event from before the snapshot must not put the stale row back.
        const stale = { version: 1, cursor: { daemonEpoch: "epoch", sequence: "4" }, occurredAt: timestamp, kind: "session_changed", payload: { session: session("a", { revision: 2 }) } };
        const requests = [];
        let stateReads = 0;
        const client = {
            async connect() { },
            async request(request) {
                requests.push(request);
                if (request.op === "get_state") {
                    stateReads += 1;
                    return { version: 1, requestId: request.requestId, ok: true, result: { kind: "state", sessions: [session("a", { revision: stateReads === 1 ? 1 : 7, taskState: stateReads === 1 ? "READY" : "WORKING" })], cursor: { daemonEpoch: "epoch", sequence: stateReads === 1 ? "1" : "9" } } };
                }
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "acknowledged", cursor: request.payload.cursor } };
            },
            subscribe() { return { async *[Symbol.asyncIterator]() { yield resynchronize; yield stale; } }; },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        expect((await backend.getSnapshot()).cursor).toEqual({ daemonEpoch: "epoch", sequence: "1" });
        const updates = [];
        const unsubscribe = await backend.subscribe({ daemonEpoch: "epoch", sequence: "1" }, (update) => { updates.push(update); }, () => { });
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 0));
        unsubscribe();
        expect(updates[0].snapshot.sessions).toEqual([expect.objectContaining({ sessionId: "a", taskState: "WORKING", revision: 7 })]);
        expect(updates[0].cursor).toEqual({ daemonEpoch: "epoch", sequence: "9" });
        // The snapshot already contains the dropped events, so the client acknowledges where it now stands.
        expect(requests.filter((request) => request.op === "ack").map((request) => request.payload.cursor)).toEqual([{ daemonEpoch: "epoch", sequence: "9" }]);
        expect(stateReads).toBe(2);
    });
    it("resynchronizes against a daemon that does not report its position", async () => {
        const resynchronize = { kind: "resynchronize", cursor: { daemonEpoch: "epoch", sequence: "9" } };
        let stateReads = 0;
        const client = {
            async connect() { },
            async request(request) {
                if (request.op === "get_state") {
                    stateReads += 1;
                    return { version: 1, requestId: request.requestId, ok: true, result: { kind: "state", sessions: [session("a", { revision: 7, taskState: "WORKING" })] } };
                }
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "acknowledged", cursor: request.payload.cursor } };
            },
            subscribe() { return { async *[Symbol.asyncIterator]() { yield resynchronize; } }; },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        expect((await backend.getSnapshot()).cursor).toBeUndefined();
        const updates = [];
        const unsubscribe = await backend.subscribe(undefined, (update) => { updates.push(update); }, () => { });
        await vi.waitFor(() => expect(updates).toHaveLength(1));
        unsubscribe();
        // Without a daemon-reported position the newest cursor the client saw is the one it reached.
        expect(updates[0].cursor).toEqual({ daemonEpoch: "epoch", sequence: "9" });
        expect(updates[0].snapshot.sessions).toEqual([expect.objectContaining({ taskState: "WORKING" })]);
        // The snapshot is refetched, not reused: a row that changed during the gap is only correct
        // because the daemon was asked again.
        expect(stateReads).toBe(2);
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
    it("processes replay once, acknowledges only successful events, and resumes from the acknowledged cursor", async () => {
        const zero = { daemonEpoch: "epoch", sequence: "0" };
        const one = { daemonEpoch: "epoch", sequence: "1" };
        const requests = [];
        const event = { version: 1, cursor: one, occurredAt: timestamp, kind: "session_changed", payload: { session: session("a") } };
        const client = {
            async connect() { },
            async request(request) {
                requests.push(request);
                const typed = request;
                if (typed.op === "get_state")
                    return { version: 1, requestId: typed.requestId, ok: true, result: { kind: "state", sessions: [] } };
                return { version: 1, requestId: typed.requestId, ok: true, result: { kind: "acknowledged", cursor: typed.payload.cursor } };
            },
            subscribe(after) {
                expect(after).toEqual(zero);
                return {
                    async *[Symbol.asyncIterator]() { yield event; yield event; },
                };
            },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        const updates = [];
        const unsubscribe = await backend.subscribe(zero, (update) => { updates.push(update); }, () => { });
        await new Promise((resolve) => setTimeout(resolve, 0));
        unsubscribe();
        expect(updates).toHaveLength(1);
        expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ op: "ack", payload: { cursor: one } })]));
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
