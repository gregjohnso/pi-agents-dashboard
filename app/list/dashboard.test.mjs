import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { DashboardController, createDaemonDashboardBackend, } from "./dashboard.mjs";
import { JOBWATCH_ANSI } from "./dashboard-theme.mjs";
import { createSessionConfirmation, describeOverlay } from "./dashboard-overlays.mjs";
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
    subscribe(_after, listener, onError) {
        this.listener = listener;
        this.errorListener = onError;
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
        expect(dashboard.render(40, 8).every((line) => visibleWidth(line) <= 40)).toBe(true);
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
        expect(dashboard.selectedSessionId).toBeDefined();
        expect(dashboard.render(80, 14).length).toBeLessThanOrEqual(14);
    });
    it("renders Jobwatch-style surfaces, focus borders, selection, and key hints", async () => {
        const dashboard = controller(new FakeBackend([session("a")]));
        await dashboard.open();
        const listFocused = dashboard.render(100, 16);
        expect(listFocused[0]).toContain(JOBWATCH_ANSI.headerBackground);
        expect(listFocused[1]).toContain(JOBWATCH_ANSI.surfaceBackground);
        expect(listFocused[2]).toContain(JOBWATCH_ANSI.sky);
        expect(stripVTControlCharacters(listFocused[2])).toContain("Sessions");
        expect(listFocused.at(-6)).toContain(JOBWATCH_ANSI.gray);
        expect(stripVTControlCharacters(listFocused.at(-6)).trim()).toMatch(/^\u256d\u2500+$/u);
        expect(listFocused.at(-1)).toContain(JOBWATCH_ANSI.surfaceBackground);
        expect(stripVTControlCharacters(listFocused.at(-1))).toContain("Ctrl+C quit");

        // The list keeps focus: the composer is a destination for text, never a focus stop.
        dashboard.handleInput("\x1b[B");
        expect(dashboard.render(100, 16)[2]).toContain(JOBWATCH_ANSI.sky);
        dashboard.handleInput("\t");
        expect(stripVTControlCharacters(dashboard.render(100, 16).at(-6))).toContain("cwd");
    });
    it("applies search, task/project filters, grouping, and sort independently without changing selected ID", async () => {
        const waiting = session("waiting", { taskState: "WAITING", processState: "LIVE", outcome: "NONE", cwd: "/repo/a", activity: { kind: "ui", summary: "Need approval", updatedAt: timestamp } });
        const ready = session("ready", { cwd: "/repo/b" });
        const dashboard = controller(new FakeBackend([ready, waiting]));
        await dashboard.open();
        dashboard.selectSession("waiting");
        dashboard.setSearch("approval");
        dashboard.setTaskStates(["WAITING"]);
        dashboard.setProjectPaths(["/repo/a"]);
        dashboard.setGrouping("cwd");
        dashboard.setSort("activity", "asc");
        dashboard.toggleMetadata();
        dashboard.toggleHelp();
        expect(dashboard.selectedSessionId).toBe("waiting");
        expect(dashboard.query).toMatchObject({ search: "approval", taskStates: ["WAITING"], projectPaths: ["/repo/a"], groupBy: "cwd", sort: { key: "activity", direction: "asc" } });
    });
    it("asks the daemon to refresh Activity summaries on open and on demand", async () => {
        const backend = new FakeBackend([session("a")]);
        backend.refreshSummaries = vi.fn(async () => ["a"]);
        const dashboard = controller(backend);
        await dashboard.open();
        await vi.waitFor(() => expect(backend.refreshSummaries).toHaveBeenCalledTimes(1));
        dashboard.handleInput("\x12");
        await vi.waitFor(() => expect(backend.refreshSummaries).toHaveBeenCalledTimes(2));
    });
    it("opens without summaries when the daemon has none configured", async () => {
        const backend = new FakeBackend([session("a")]);
        backend.refreshSummaries = vi.fn(async () => { throw Object.assign(new Error("nope"), { code: "SUMMARIES_UNAVAILABLE" }); });
        const dashboard = controller(backend);
        await dashboard.open();
        await vi.waitFor(() => expect(backend.refreshSummaries).toHaveBeenCalled());
        expect(dashboard.status).toEqual({ kind: "ready" });
    });
    it("greys the composer placeholder and leaves the prompt line unchanged when focused", async () => {
        const dashboard = controller(new FakeBackend([]));
        await dashboard.open();
        const promptLine = (rendered) => rendered[rendered.length - 5];
        const unfocused = promptLine(dashboard.render(80, 24));
        expect(stripVTControlCharacters(unfocused)).toContain("describe a task for a new session");
        expect(unfocused).toContain(JOBWATCH_ANSI.gray);

        dashboard.focusComposer();
        expect(promptLine(dashboard.render(80, 24))).toBe(unfocused);

        dashboard.setComposerPrompt("ship it");
        const typed = promptLine(dashboard.render(80, 24));
        expect(stripVTControlCharacters(typed)).toContain("ship it");
        expect(stripVTControlCharacters(typed)).not.toContain("describe a task");
        expect(typed).not.toContain(JOBWATCH_ANSI.gray);
        expect(stripVTControlCharacters(typed)).not.toContain("[prompt]");
    });
    it("closes the composer panel and shows filter state only when filters are set", async () => {
        const dashboard = controller(new FakeBackend([session("a")]));
        await dashboard.open();
        const plain = dashboard.render(100, 16).map(stripVTControlCharacters);
        expect(plain[1]).not.toContain("/search");
        expect(plain[1]).not.toContain("v:live");
        expect(plain.at(-3).trim()).toMatch(/^─+$/u);

        dashboard.setSearch("needle");
        const filtered = dashboard.render(100, 16).map(stripVTControlCharacters);
        expect(filtered[1]).toContain("needle");
    });
    it("shows the selected session's working directory", async () => {
        const dashboard = controller(new FakeBackend([
            session("a", { cwd: "/repo/alpha" }),
            session("b", { cwd: "/repo/beta" }),
        ]));
        await dashboard.open();
        dashboard.selectSession("a");
        expect(stripVTControlCharacters(dashboard.render(100, 16).at(-2))).toContain("/repo/alpha");
        dashboard.selectSession("b");
        expect(stripVTControlCharacters(dashboard.render(100, 16).at(-2))).toContain("/repo/beta");

        dashboard.setSearch("beta");
        const rendered = dashboard.render(100, 16);
        expect(stripVTControlCharacters(rendered.at(-2))).toContain("/repo/beta");
        expect(stripVTControlCharacters(rendered[1])).toContain("search:beta");
    });
    it("confirms a destructive action against the revision current at confirm time", async () => {
        const backend = new FakeBackend([session("a", { revision: 4 })]);
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        expect(dashboard.overlay).toMatchObject({ kind: "session_confirmation", revision: 4 });

        dashboard.applySnapshot({ sessions: [session("a", { revision: 9, summary: { text: "summarized", generatedAt: timestamp, model: { provider: "p", id: "m" }, sourceCursor: "3" } })] });
        dashboard.selectSession("a");
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledWith("a", 9, expect.any(String)));
    });
    it("cancels a destructive confirmation when the session comes back to life", async () => {
        const backend = new FakeBackend([session("a", { revision: 2, processState: "EXITED" })]);
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.setView("all");
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        expect(dashboard.overlay).toMatchObject({ kind: "session_confirmation", action: "delete" });
        dashboard.applySnapshot({ sessions: [session("a", { revision: 3, processState: "LIVE", ownership: { kind: "managed", runId: "r", process: { pid: 5, startIdentity: "5", processGroupId: 5 }, acquiredAt: timestamp, heartbeatAt: timestamp } })] });
        dashboard.selectSession("a");
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "SESSION_LIVE" }));
        expect(backend.stop).not.toHaveBeenCalled();
    });
    it("titles the clear-after-stop confirmation distinctly", () => {
        const stopped = session("a", { processState: "EXITED", taskState: "STOPPED" });
        const described = describeOverlay({ ...createSessionConfirmation(stopped), clearingStopped: true });
        expect(described.title).toBe("Clear stopped session");
        expect(describeOverlay(createSessionConfirmation(stopped)).title).toBe("Confirm DELETE");
    });
    it("stops a live session on the first Ctrl+X and never deletes it", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
        let now = 0;
        const dashboard = controller(backend, { now: () => now });
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        expect(dashboard.overlay).toMatchObject({ kind: "session_confirmation", action: "stop" });
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledWith("a", 1, expect.any(String)));
        expect(backend.delete).not.toHaveBeenCalled();
    });
    it("clears with a second Ctrl+X inside the window, still asking to confirm", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
        let now = 0;
        const dashboard = controller(backend, { now: () => now });
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledOnce());
        dashboard.applySnapshot({ sessions: [session("a", { revision: 2, processState: "EXITED", taskState: "STOPPED" })] });
        dashboard.selectSession("a");

        now = 400;
        expect(dashboard.stopClearArmed).toBe(true);
        dashboard.handleInput("\x18");
        expect(dashboard.overlay).toMatchObject({ kind: "session_confirmation", action: "delete", clearingStopped: true });
        expect(backend.delete).not.toHaveBeenCalled();
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(backend.delete).toHaveBeenCalledWith("a", 2, expect.any(String)));
    });
    it("reopens the ordinary confirmation once the clear window lapses", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
        let now = 0;
        const dashboard = controller(backend, { now: () => now });
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledOnce());
        dashboard.applySnapshot({ sessions: [session("a", { revision: 2, processState: "EXITED", taskState: "STOPPED" })] });
        dashboard.selectSession("a");

        now = 900;
        dashboard.handleInput("\x18");
        expect(dashboard.overlay).toMatchObject({ kind: "session_confirmation", action: "delete" });
        expect(dashboard.stopClearArmed).toBe(false);
    });
    it("forgets the stop gesture when the operator moves the selection", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE" }), session("b", { processState: "LIVE" })]);
        let now = 0;
        const dashboard = controller(backend, { now: () => now });
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledOnce());
        expect(dashboard.stopClearArmed).toBe(true);
        dashboard.selectSession("b");
        expect(dashboard.stopClearArmed).toBe(false);
    });
    it("dismisses the confirmation as soon as a destructive request is sent", async () => {
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
        release();
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
    });
    it("reports a background destructive failure without blocking the list", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
        backend.stop = vi.fn(async () => { throw Object.assign(new Error("worker is gone"), { code: "WORKER_UNAVAILABLE" }); });
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        expect(dashboard.overlay).toBeUndefined();
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "WORKER_UNAVAILABLE" }));
    });
    it("repaints on a timer while a session works and stops when none do", async () => {
        vi.useFakeTimers();
        try {
            const backend = new FakeBackend([session("a", { taskState: "WORKING", processState: "LIVE" })]);
            const requestRender = vi.fn();
            const dashboard = controller(backend, { requestRender });
            await dashboard.open();
            dashboard.render(100, 24);
            const before = requestRender.mock.calls.length;
            await vi.advanceTimersByTimeAsync(400);
            // The throbber only moves if something asks for a frame.
            expect(requestRender.mock.calls.length).toBeGreaterThan(before);

            dashboard.applySnapshot({ sessions: [session("a", { taskState: "READY", processState: "LIVE" })] });
            dashboard.render(100, 24);
            const settled = requestRender.mock.calls.length;
            await vi.advanceTimersByTimeAsync(400);
            expect(requestRender.mock.calls.length).toBe(settled);
            await dashboard.close();
        }
        finally {
            vi.useRealTimers();
        }
    });
    it("shows only the sessions the current view selects", async () => {
        const dashboard = controller(new FakeBackend([
            session("live", { processState: "LIVE" }),
            session("done", { processState: "EXITED", outcome: "COMPLETED" }),
            session("stopped", { processState: "EXITED", taskState: "STOPPED" }),
        ]));
        await dashboard.open();
        const rows = () => dashboard.render(80, 24).map(stripVTControlCharacters).filter((line) => /^[\u25b6\u25cc\u00d7 ] \S/u.test(line));
        expect(rows()).toHaveLength(1);
        dashboard.setQuery({ view: "all" });
        expect(rows()).toHaveLength(3);
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
        backend.stop = vi.fn(async (_sessionId, revision) => {
            // A working session's record churns constantly, so the revision moves under the request.
            if (revision === 4) throw Object.assign(new Error("Session revision changed before Stop"), { code: "REVISION_CONFLICT" });
            return { accepted: true };
        });
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.selectSession("a");
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        dashboard.applySnapshot({ sessions: [session("a", { processState: "LIVE", revision: 9 })] });
        await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledWith("a", 9, expect.any(String)));
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
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

        // The prompt is gone and the pending session is visible before the daemon replies.
        expect(dashboard.composerDraft.prompt).toBe("");
        const rendered = dashboard.render(100, 24).map(stripVTControlCharacters);
        expect(rendered.some((line) => line.includes("STARTING") && line.includes("ship it"))).toBe(true);

        // A second Enter cannot launch the same prompt twice.
        dashboard.handleInput("\r");
        expect(backend.launch).toHaveBeenCalledTimes(1);
        release();
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
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
    it("launches with Enter when the prompt has text and opens the session when it is empty", async () => {
        const backend = new FakeBackend([session("a")]);
        const opened = [];
        const dashboard = controller(backend, { onOpenSession: (sessionId) => opened.push(sessionId) });
        await dashboard.open();
        dashboard.handleInput("\r");
        expect(backend.requests).toEqual([]);
        dashboard.handleInput("g");
        dashboard.handleInput("o");
        dashboard.handleInput("\r");
        await vi.waitFor(() => expect(backend.requests).toHaveLength(1));
        expect(backend.requests[0]).toMatchObject({ prompt: "go" });
    });
    it("keeps a draft through Escape and ignores a blank submit", async () => {
        const backend = new FakeBackend([]);
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.focusComposer();
        dashboard.setComposerPrompt("draft");
        dashboard.handleInput("\x1b");
        expect(dashboard.focus).toBe("list");
        expect(dashboard.composerDraft.prompt).toBe("draft");
        dashboard.focusComposer();
        dashboard.setComposerPrompt("   ");
        await dashboard.submitComposer();
        expect(backend.requests).toEqual([]);
    });
    it("closes the list from New Session on Ctrl+C with its draft intact", async () => {
        const backend = new FakeBackend([]);
        const onClose = vi.fn();
        const dashboard = controller(backend, { onClose });
        await dashboard.open();
        dashboard.focusComposer();
        dashboard.setComposerPrompt("draft");
        dashboard.handleInput("\x03");
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith({ kind: "closed" }));
        expect(dashboard.composerDraft.prompt).toBe("draft");
    });
    it("shows the sessions list immediately while launch startup is pending", async () => {
        const backend = new FakeBackend([]);
        let completeLaunch;
        backend.launch = vi.fn(() => new Promise((resolve) => { completeLaunch = resolve; }));
        const renders = [];
        const dashboard = controller(backend, { requestRender: () => renders.push(dashboard.focus) });
        await dashboard.open();
        dashboard.focusComposer();
        dashboard.setComposerPrompt("Start now");
        renders.length = 0;

        const submitting = dashboard.submitComposer();
        await vi.waitFor(() => expect(backend.launch).toHaveBeenCalledTimes(1));
        expect(dashboard.focus).toBe("list");
        expect(renders).toContain("list");
        completeLaunch({ kind: "launched", sessionId: "started" });
        await submitting;
        expect(dashboard.composerDraft.prompt).toBe("");
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
    it("delegates Enter/Right to the injected viewer boundary", async () => {
        const openSelectedViewer = vi.fn(async () => {});
        const dashboard = controller(new FakeBackend([session("a")]), { openViewer: openSelectedViewer });
        await dashboard.open();
        await dashboard.activateSelection();
        expect(openSelectedViewer).toHaveBeenCalledWith("a");
    });
    it("confirms Ctrl+X against the exact selected revision and invalidates on change", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE" }), session("b", { processState: "EXITED" })]);
        const onSessionIntent = vi.fn();
        const dashboard = controller(backend, { onSessionIntent, requestId: () => "destructive-request" });
        await dashboard.open();
        dashboard.handleInput("\x18");
        expect(dashboard.overlay).toMatchObject({ kind: "session_confirmation", action: "stop", sessionId: "a", revision: 1, processState: "LIVE" });
        expect(backend.stop).not.toHaveBeenCalled();
        dashboard.handleInput("n");
        expect(dashboard.overlay).toBeUndefined();
        expect(backend.stop).not.toHaveBeenCalled();
        dashboard.handleInput("\x18");
        await processRenderedEvent(dashboard, backend, { snapshot: { sessions: [session("a", { revision: 2, processState: "LIVE" }), session("b", { processState: "EXITED" })] }, cursor: { daemonEpoch: "epoch", sequence: "1" } });
        expect(dashboard.overlay).toMatchObject({ kind: "session_confirmation", action: "stop", sessionId: "a" });
        await processRenderedEvent(dashboard, backend, { snapshot: { sessions: [session("a", { revision: 3, processState: "EXITED" }), session("b", { processState: "EXITED" })] }, cursor: { daemonEpoch: "epoch", sequence: "2" } });
        expect(dashboard.overlay).toBeUndefined();
        dashboard.setView("all");
        dashboard.selectSession("b");
        dashboard.handleInput("\x18");
        expect(dashboard.overlay).toMatchObject({ action: "delete", sessionId: "b", revision: 1 });
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(backend.delete).toHaveBeenCalledWith("b", 1, "destructive-request"));
        expect(dashboard.selectedSessionId).toBe("b");
        expect(onSessionIntent).toHaveBeenCalledWith({ kind: "session_intent", action: "delete", sessionId: "b", revision: 1 });
    });
    it("preserves failed destructive confirmation with its structured refusal and permits an explicit retry", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
        backend.stop
            .mockRejectedValueOnce(Object.assign(new Error("ownership changed"), { code: "OWNERSHIP_CONFLICT" }))
            .mockResolvedValueOnce(undefined);
        const dashboard = controller(backend, { requestId: () => "stop-request" });
        await dashboard.open();
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "error", code: "OWNERSHIP_CONFLICT", message: "ownership changed" }));
        // A refusal reports itself and leaves the list usable; Ctrl+X retries.
        expect(dashboard.overlay).toBeUndefined();
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(dashboard.status).toMatchObject({ kind: "ready" }));
    });
    it("keeps a successfully stopped row selected and requires a later Delete confirmation", async () => {
        const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
        const dashboard = controller(backend, { requestId: () => "stop-request" });
        await dashboard.open();
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledWith("a", 1, "stop-request"));
        await processRenderedEvent(dashboard, backend, { snapshot: { sessions: [session("a", { revision: 2, processState: "EXITED" })] }, cursor: { daemonEpoch: "epoch", sequence: "2" } });
        expect(dashboard.selectedSessionId).toBe("a");
        dashboard.handleInput("\x18");
        expect(dashboard.overlay).toMatchObject({ action: "delete", sessionId: "a", revision: 2 });
    });
    it("ignores repeated Ctrl+X while a stop is in flight", async () => {
        let release;
        const backend = new FakeBackend([session("a")]);
        backend.stop = vi.fn(() => new Promise((resolve) => { release = resolve; }));
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        dashboard.handleInput("\x18");
        expect(backend.stop).toHaveBeenCalledTimes(1);
        release?.();
    });
    it("never leaves input wedged behind an in-flight destructive request", async () => {
        let release;
        const backend = new FakeBackend([session("a")]);
        backend.stop = vi.fn(() => new Promise((resolve) => { release = resolve; }));
        const dashboard = controller(backend);
        await dashboard.open();
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        // Nothing waits on the daemon, so navigation works while the stop is still travelling.
        expect(dashboard.overlay).toBeUndefined();
        dashboard.handleInput("\x1b[B");
        expect(dashboard.focus).toBe("list");
        expect(backend.stop).toHaveBeenCalledTimes(1);
        release?.();
    });
    it("closes the dashboard with Ctrl+C while a stop is in flight", async () => {
        let release;
        const backend = new FakeBackend([session("a")]);
        backend.stop = vi.fn(() => new Promise((resolve) => { release = resolve; }));
        const onClose = vi.fn();
        const dashboard = controller(backend, { onClose });
        await dashboard.open();
        dashboard.handleInput("\x18");
        dashboard.handleInput("y");
        dashboard.handleInput("\x03");
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith({ kind: "closed" }));
        release?.();
    });
    describe("floating overlay panels", () => {
        // The composer dock owns the last five rows, including its own closing border.
        const panelRows = (rendered) => rendered
            .map((line, index) => ({ line: stripVTControlCharacters(line), index }))
            .filter(({ line }) => /\u256d\u2500.*\u256e\s*$|^\s*\u2502.*\u2502\s*$|\u2570\u2500+\u256f\s*$/u.test(line));
        const panelLines = (rendered) => panelRows(rendered).map(({ line }) => line);
        it.each([[40, 10], [55, 16], [80, 24], [120, 32], [160, 40]])("frames the help panel inside %ix%i", async (width, height) => {
            const dashboard = controller(new FakeBackend([session("a")]));
            await dashboard.open();
            dashboard.toggleHelp();
            const rendered = dashboard.render(width, height);
            for (const line of rendered)
                expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            const framed = panelLines(rendered);
            expect(framed.length).toBeGreaterThan(2);
            expect(framed[0]).toContain("Help");
            expect(framed[0]).toMatch(/\u256d\u2500/u);
            expect(framed.at(-1)).toMatch(/\u2570\u2500+\u256f/u);
        });
        it("centers the panel within the list area and paints a focus border", async () => {
            const dashboard = controller(new FakeBackend([session("a")]));
            await dashboard.open();
            dashboard.toggleHelp();
            const rendered = dashboard.render(80, 24);
            const framedRows = panelRows(rendered);
            expect(framedRows[0].index).toBeGreaterThan(4);
            expect(framedRows.at(-1).index).toBeLessThan(20);
            const indent = framedRows[0].line.search(/\S/u);
            for (const { line } of framedRows)
                expect(line.search(/\S/u)).toBe(indent);
            expect(rendered[framedRows[0].index]).toContain(JOBWATCH_ANSI.sky);
        });
        it.each([
            ["help", (dashboard) => dashboard.toggleHelp(), "Help", "metadata / help"],
            ["metadata", (dashboard) => dashboard.toggleMetadata(), "Session", "taskState"],
            ["session confirmation", (dashboard) => dashboard.handleInput("\x18"), "Confirm STOP", "y/Enter"],
        ])("titles the %s panel and keeps its content", async (_label, open, title, content) => {
            const dashboard = controller(new FakeBackend([session("a", { processState: "LIVE" })]));
            await dashboard.open();
            open(dashboard);
            const rendered = dashboard.render(120, 32).map(stripVTControlCharacters);
            expect(rendered.some((line) => line.includes(title))).toBe(true);
            expect(rendered.some((line) => line.includes(content))).toBe(true);
        });
        it("frames the delivery-unknown choices without overflowing a narrow terminal", async () => {
            const backend = new FakeBackend([]);
            backend.launch = vi.fn(async () => ({ kind: "delivery_unknown", clientId: "stable-client", requestId: "launch-unknown" }));
            const dashboard = controller(backend);
            await dashboard.open();
            dashboard.setComposerPrompt("Implement it");
            await dashboard.submitComposer();
            const rendered = dashboard.render(40, 10);
            for (const line of rendered)
                expect(visibleWidth(line)).toBeLessThanOrEqual(40);
            const plain = rendered.map(stripVTControlCharacters);
            expect(plain.some((line) => line.includes("Delivery unknown"))).toBe(true);
            expect(plain.some((line) => line.includes("retry_at_risk"))).toBe(true);
        });
        it("centers a narrow panel horizontally inside a wide terminal", async () => {
            const dashboard = controller(new FakeBackend([session("a", { processState: "LIVE" })]));
            await dashboard.open();
            dashboard.handleInput("\x18");
            const rendered = dashboard.render(160, 40);
            const framed = panelRows(rendered);
            const indent = framed[0].line.search(/\S/u);
            expect(indent).toBeGreaterThan(0);
            for (const { line } of framed) {
                expect(line.search(/\S/u)).toBe(indent);
                expect(visibleWidth(line.trimEnd())).toBeLessThanOrEqual(160);
            }
        });
        it("frames the shared-directory confirmation with its typed echo", async () => {
            const dashboard = controller(new FakeBackend([]));
            await dashboard.open();
            dashboard.setComposerPrompt("Shared change");
            dashboard.setIsolationMode("shared_directory");
            await dashboard.submitComposer();
            dashboard.handleInput("/");
            dashboard.handleInput("r");
            const rendered = dashboard.render(80, 24).map(stripVTControlCharacters);
            expect(rendered.some((line) => line.includes("Shared directory"))).toBe(true);
            expect(rendered.some((line) => line.includes("> /r"))).toBe(true);
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
    it("awaits the actual host component render before persisting an event", async () => {
        const order = [];
        const backend = new FakeBackend([session("a")]);
        const saved = persistence();
        saved.save = vi.fn(async () => { order.push("persist"); });
        const dashboard = controller(backend, { persistence: saved, requestRender: () => order.push("request-render") });
        await dashboard.open();
        order.length = 0;
        const processing = Promise.resolve(backend.listener?.({ snapshot: { sessions: [session("a", { revision: 2 })] }, cursor: { daemonEpoch: "epoch", sequence: "1" } }));
        expect(order).toEqual(["request-render"]);
        await Promise.resolve();
        expect(order).toEqual(["request-render"]);
        order.push("host-render");
        dashboard.render();
        await processing;
        expect(order).toEqual(["request-render", "host-render", "persist"]);
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
        expect(acknowledgements).toEqual(["1"]);
        await second;
        expect(renders[1]?.join("\n")).toContain("state-2");
        expect(acknowledgements).toEqual(["1", "2"]);
    });
    it("leaves concurrent events unacknowledged when the first host render fails", async () => {
        const backend = new FakeBackend([session("initial")]);
        const saved = persistence();
        let renderRequests = 0;
        const dashboard = controller(backend, {
            persistence: saved,
            requestRender: () => {
                renderRequests += 1;
                if (renderRequests === 1)
                    return;
                const internals = dashboard;
                internals.list.renderViewport = () => { throw new Error("render failed"); };
                dashboard.render();
            },
        });
        await dashboard.open();
        const first = Promise.resolve(backend.listener?.({ snapshot: { sessions: [session("state-1")] }, cursor: { daemonEpoch: "epoch", sequence: "1" } }));
        const second = Promise.resolve(backend.listener?.({ snapshot: { sessions: [session("state-2")] }, cursor: { daemonEpoch: "epoch", sequence: "2" } }));
        await expect(first).rejects.toThrow("render failed");
        await expect(second).rejects.toThrow();
        expect(saved.saved.some((state) => state.cursor?.sequence === "1" || state.cursor?.sequence === "2")).toBe(false);
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
    it("provides keyboard and mouse access to filters, sorting, grouping, search, and every launch field", async () => {
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
        dashboard.handleMouse({ row: 2, column: 2, button: "left" });
        expect(dashboard.focus).toBe("search");
        dashboard.focusComposer();
        const fields = ["prompt", "cwd", "isolationMode", "modelProvider", "modelId", "thinkingLevel", "name"];
        expect(dashboard.composerField).toBe(fields[0]);
        for (const field of fields.slice(1)) {
            dashboard.handleInput("\t");
            expect(dashboard.composerField).toBe(field);
        }
        const rendered = dashboard.render(100, 16).join("\n");
        expect(rendered).toContain("isolation:");
        expect(rendered).toContain("model:");
        expect(rendered).toContain("thinking:");
        expect(rendered).toContain("name:");
    });
    it("serializes delayed UI and final close saves and admits no writes after close resolves", async () => {
        let releaseFirst;
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        const starts = [];
        let active = 0;
        let maximumActive = 0;
        const saved = persistence();
        saved.save = vi.fn(async (state) => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            starts.push(state.viewState?.query.search ?? "final");
            if (starts.length === 1)
                await firstGate;
            active -= 1;
        });
        const dashboard = controller(new FakeBackend([session("a")]), { persistence: saved });
        await dashboard.open();
        dashboard.setSearch("queued");
        await vi.waitFor(() => expect(starts).toEqual(["queued"]));
        let closed = false;
        const closing = dashboard.close().then(() => { closed = true; });
        await Promise.resolve();
        expect(closed).toBe(false);
        releaseFirst?.();
        await closing;
        expect(maximumActive).toBe(1);
        expect(starts).toEqual(["queued", "queued"]);
        dashboard.setSearch("late");
        await Promise.resolve();
        expect(starts).toEqual(["queued", "queued"]);
    });
    it("signals list close exactly once without invoking the viewer boundary", async () => {
        const onClose = vi.fn();
        const openSelectedViewer = vi.fn(async () => {});
        const dashboard = controller(new FakeBackend([session("a")]), { openViewer: openSelectedViewer, onClose });
        await dashboard.open();
        await Promise.all([dashboard.close(), dashboard.close()]);
        expect(openSelectedViewer).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledWith({ kind: "closed" });
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
    it("keeps list composer and destructive controls independent of viewer role", async () => {
        const onSessionIntent = vi.fn();
        const dashboard = controller(new FakeBackend([session("a")]), { onSessionIntent });
        await dashboard.open();
        dashboard.focusComposer();
        expect(dashboard.focus).toBe("list");
        dashboard.handleInput("\x1b");
        dashboard.handleInput("\x18");
        expect(onSessionIntent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "a" }));
        await dashboard.close();
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
    it("does not replay Stop after its composer socket disconnects", async () => {
        const requests = [];
        const transaction = {
            async connect() {},
            async request(request) {
                requests.push(request.op);
                if (request.op === "attach") return { version: 1, requestId: request.requestId, ok: true, result: { kind: "attached", sessionId: "exact-session", role: "composer" } };
                throw Object.assign(new Error("socket closed"), { code: "CONNECTION_CLOSED", submitted: true });
            },
            async close() {},
        };
        const client = { createTransactionClient: () => transaction };
        const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await expect(backend.stop("exact-session", 3, "stop-request")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "stable-client", requestId: "stop-request" });
        expect(requests).toEqual(["attach", "stop"]);
    });
    it("classifies a malformed response after Delete submission as delivery unknown", async () => {
        const transaction = {
            async connect() {},
            async request(request) {
                if (request.op === "attach") return { version: 1, requestId: request.requestId, ok: true, result: { kind: "attached", sessionId: "exact-session", role: "composer" } };
                throw Object.assign(new Error("malformed daemon frame"), { code: "MALFORMED_FRAME" });
            },
            async close() {},
        };
        const backend = createDaemonDashboardBackend({ client: { createTransactionClient: () => transaction }, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        await expect(backend.delete("exact-session", 3, "delete-request")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", clientId: "stable-client", requestId: "delete-request" });
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
    it("sends no acknowledgement when reducer, render, or persistence processing rejects", async () => {
        const one = { daemonEpoch: "epoch", sequence: "1" };
        const requests = [];
        const event = { version: 1, cursor: one, occurredAt: timestamp, kind: "session_changed", payload: { session: session("a") } };
        const client = {
            async connect() { },
            async request(request) {
                requests.push(request);
                return { version: 1, requestId: request.requestId, ok: true, result: { kind: "acknowledged", cursor: one } };
            },
            subscribe() { return { async *[Symbol.asyncIterator]() { yield event; } }; },
            async close() { },
        };
        const backend = createDaemonDashboardBackend({ client: client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
        const onError = vi.fn();
        await backend.subscribe(undefined, async () => { throw Object.assign(new Error("render failed"), { code: "RENDER_FAILED" }); }, onError);
        await vi.waitFor(() => expect(onError).toHaveBeenCalledWith({ code: "RENDER_FAILED", message: "render failed" }));
        expect(requests.some((request) => request.op === "ack")).toBe(false);
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
