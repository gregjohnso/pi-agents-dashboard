import { stripVTControlCharacters } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { DashboardController, createDaemonDashboardBackend, } from "./dashboard.mjs";
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
    it("shows the selected session's working directory and a filter chip only once a filter is set", async () => {
        const dashboard = controller(new FakeBackend([
            session("a", { cwd: "/repo/alpha" }),
            session("b", { cwd: "/repo/beta" }),
        ]));
        await dashboard.open();
        const unfiltered = dashboard.render(100, 16).map(stripVTControlCharacters);
        expect(unfiltered[1]).not.toContain("search:");
        expect(unfiltered[1]).not.toContain("v:live");
        expect(unfiltered.at(-4).trim()).toMatch(/^─+$/u);

        dashboard.selectSession("a");
        expect(stripVTControlCharacters(dashboard.render(100, 16).at(-2))).toContain("/repo/alpha");
        dashboard.selectSession("b");
        expect(stripVTControlCharacters(dashboard.render(100, 16).at(-2))).toContain("/repo/beta");

        dashboard.setSearch("beta");
        const filtered = dashboard.render(100, 16);
        expect(stripVTControlCharacters(filtered.at(-2))).toContain("/repo/beta");
        expect(stripVTControlCharacters(filtered[1])).toContain("search:beta");
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
        expect(dashboard.status).toMatchObject({ kind: "pending", code: "CLEAR_ARMED" });

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
        expect(dashboard.status).toMatchObject({ kind: "pending", code: "CLEAR_ARMED" });
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
            ["help", async (dashboard) => { dashboard.toggleHelp(); }, "Help", "metadata / help"],
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
            // A floating panel never swallows the composer dock at an ordinary size.
            expect(rendered.at(-1)).toContain("Ctrl+C quit");
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
