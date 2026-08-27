import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth, } from "@earendil-works/pi-tui";
import { pastedText } from "./dashboard-input.mjs";
import { SPINNER_INTERVAL_MS } from "../spinner.mjs";
import { countDashboardSessions, selectDashboardSessions, } from "./dashboard-state.mjs";
import { createDashboardLayout, renderColumnHeader, } from "./dashboard-layout.mjs";
import { jobwatchTheme } from "./dashboard-theme.mjs";
import { displaySessionState } from "./session-state.mjs";
import { StopClearGesture } from "./stop-clear-gesture.mjs";
import { destructiveAction, createDeliveryUnknownOverlay, createHelpOverlay, createMetadataOverlay, createSessionConfirmation, createSessionIntent, createSharedDirectoryOverlay, describeOverlay, } from "./dashboard-overlays.mjs";
import { createLaunchDraft, prepareLaunchRequest, } from "./launch-composer.mjs";
import { VirtualSessionList } from "./virtual-session-list.mjs";
function cursorAfter(left, right) {
    if (left === undefined || left.daemonEpoch !== right.daemonEpoch)
        return true;
    return BigInt(right.sequence) > BigInt(left.sequence);
}
function daemonFailure(response) {
    return { code: response.error.code, message: response.error.message };
}
/** Adapt the Task 11 reconnecting client into snapshots with process-then-ack replay. */
export function createDaemonDashboardBackend({ client, clientId, preflight, requestId = randomUUID, }) {
    const sessions = new Map();
    const request = async (op, payload, exactRequestId = requestId()) => {
        return client.request({ version: 1, clientId, requestId: exactRequestId, op, payload });
    };
    const refreshState = async () => {
        const response = await request("get_state", {});
        if (!response.ok)
            throw Object.assign(new Error(response.error.message), response.error);
        if (response.result.kind !== "state")
            throw Object.assign(new Error("Daemon returned the wrong state result"), { code: "INVALID_RESPONSE" });
        sessions.clear();
        for (const session of response.result.sessions)
            sessions.set(session.sessionId, session);
        return { sessions: [...sessions.values()] };
    };
    const requestAsComposer = async (operation, sessionId, revision, exactRequestId) => {
        const transaction = client.createTransactionClient?.() ?? client;
        const ownsTransaction = transaction !== client;
        const transactionRequest = async (op, payload, transactionRequestId = requestId()) => transaction.request({ version: 1, clientId, requestId: transactionRequestId, op, payload });
        let attached = false;
        let response;
        try {
            if (ownsTransaction) await transaction.connect();
            const attachment = await transactionRequest("attach", { sessionId, role: "composer" });
            if (!attachment.ok || attachment.result.kind !== "attached" || attachment.result.role !== "composer") {
                if (!attachment.ok) throw Object.assign(new Error(attachment.error.message), attachment.error);
                throw Object.assign(new Error("Daemon refused the composer role"), { code: "ATTACHMENT_REQUIRED" });
            }
            attached = true;
            try { response = await transactionRequest(operation, { sessionId, revision }, exactRequestId); }
            catch (error) {
                if (["CONNECTION_CLOSED", "MALFORMED_FRAME", "INVALID_DAEMON_RESPONSE", "UNEXPECTED_DAEMON_RESPONSE"].includes(error?.code)) throw Object.assign(new Error(`${operation === "stop" ? "Stop" : "Delete"} delivery is ambiguous`), { code: "DELIVERY_UNKNOWN", clientId, requestId: exactRequestId });
                throw error;
            }
            return response;
        }
        finally {
            if (attached && response !== undefined) await transactionRequest("detach", { sessionId }).catch(() => {});
            if (ownsTransaction) await transaction.close();
        }
    };
    const requireCompletedDestructive = (operation, response) => {
        if (!response.ok)
            throw Object.assign(new Error(response.error.message), response.error);
        if (response.result.kind !== "command")
            throw Object.assign(new Error(`Daemon returned the wrong ${operation} result`), { code: "INVALID_RESPONSE" });
        if (response.result.status.stage === "DELIVERY_UNKNOWN") {
            throw Object.assign(new Error(`${operation === "stop" ? "Stop" : "Delete"} delivery is ambiguous`), { code: "DELIVERY_UNKNOWN", clientId: response.result.status.clientId, requestId: response.result.status.requestId });
        }
        if (response.result.status.stage === "FAILED") {
            const error = response.result.status.error ?? { code: "COMMAND_FAILED", message: `${operation} failed`, retryable: false };
            throw Object.assign(new Error(error.message), error);
        }
        if (response.result.status.stage !== "COMPLETED")
            throw Object.assign(new Error(`${operation} ended in ${response.result.status.stage}`), { code: response.result.status.stage });
    };
    return {
        async getSnapshot() {
            await client.connect();
            return refreshState();
        },
        subscribe(after, listener, onError) {
            let active = true;
            let acknowledged = after;
            const removeFatalListener = client.onFatalError?.((error) => {
                if (active)
                    onError({ code: error.code, message: error.message });
            });
            const iterator = client.subscribe(after)[Symbol.asyncIterator]();
            void (async () => {
                try {
                    while (active) {
                        const next = await iterator.next();
                        if (next.done || !active)
                            return;
                        const event = next.value;
                        if (!cursorAfter(acknowledged, event.cursor))
                            continue;
                        let snapshot = { sessions: [...sessions.values()] };
                        if (event.kind === "session_changed") {
                            sessions.set(event.payload.session.sessionId, event.payload.session);
                            snapshot = { sessions: [...sessions.values()] };
                        }
                        else if (event.kind === "command_changed" && event.payload.status.operation === "delete" && event.payload.status.stage === "COMPLETED") {
                            snapshot = await refreshState();
                        }
                        await listener({ snapshot, cursor: event.cursor, event });
                        const response = await request("ack", { cursor: event.cursor });
                        if (!response.ok)
                            throw Object.assign(new Error(response.error.message), response.error);
                        if (response.result.kind !== "acknowledged")
                            throw Object.assign(new Error("Daemon returned the wrong acknowledgement result"), { code: "INVALID_RESPONSE" });
                        acknowledged = response.result.cursor;
                    }
                }
                catch (error) {
                    if (!active)
                        return;
                    const typed = error;
                    onError({ code: typed.code ?? "MALFORMED_FRAME", message: typed.message ?? "Daemon event stream failed" });
                }
            })();
            return () => {
                active = false;
                removeFatalListener?.();
                void iterator.return?.();
            };
        },
        preflightLaunch: preflight,
        async launch(launchRequest, exactRequestId = requestId()) {
            const response = await request("launch", launchRequest, exactRequestId);
            if (!response.ok)
                return { kind: "rejected", error: daemonFailure(response) };
            if (response.result.kind === "launched")
                return { kind: "launched", sessionId: response.result.sessionId };
            if (response.result.kind === "command" && response.result.status.stage === "DELIVERY_UNKNOWN") {
                return { kind: "delivery_unknown", clientId: response.result.status.clientId, requestId: response.result.status.requestId };
            }
            if (response.result.kind === "command") {
                return {
                    kind: "rejected",
                    error: response.result.status.error ?? { code: response.result.status.stage, message: `Launch ended in ${response.result.status.stage}` },
                };
            }
            return { kind: "rejected", error: { code: "INVALID_RESPONSE", message: "Daemon returned the wrong launch result" } };
        },
        async refreshSummaries() {
            const response = await request("refresh_summaries", {});
            if (!response.ok)
                throw Object.assign(new Error(response.error.message), response.error);
            if (response.result.kind !== "summaries_refreshing")
                throw Object.assign(new Error("Daemon returned the wrong summary refresh result"), { code: "INVALID_RESPONSE" });
            return response.result.sessionIds;
        },
        async resolveDelivery(targetClientId, targetRequestId, resolution) {
            const response = await request("resolve_delivery", { targetClientId, targetRequestId, resolution });
            if (!response.ok)
                throw Object.assign(new Error(response.error.message), response.error);
        },
        async stop(sessionId, revision, exactRequestId) {
            requireCompletedDestructive("stop", await requestAsComposer("stop", sessionId, revision, exactRequestId));
        },
        async delete(sessionId, revision, exactRequestId) {
            requireCompletedDestructive("delete", await requestAsComposer("delete", sessionId, revision, exactRequestId));
        },
    };
}
function defaultQuery() {
    return { view: "live" };
}
function safeQuery(value) {
    if (value === undefined || !["live", "done", "all"].includes(value.view))
        return defaultQuery();
    return { ...value };
}
const TASK_STATES = ["WORKING", "WAITING", "READY", "FAILED", "STOPPED"];
const PROCESS_STATES = ["LIVE", "SLEEPING", "EXITED", "STALE"];
const OUTCOMES = ["NONE", "COMPLETED", "READY_FOR_REVIEW"];
const SORT_KEYS = ["age", "id", "state", "model", "project", "activity"];
const GROUPS = ["taskState", "cwd"];
const COMPOSER_FIELDS = ["prompt", "cwd", "isolationMode", "modelProvider", "modelId", "thinkingLevel", "name"];
function cycleValue(values, current) {
    if (current === undefined)
        return values[0];
    const index = values.indexOf(current);
    return index < 0 || index === values.length - 1 ? undefined : values[index + 1];
}
/**
 * The filter, sort, and group controls: one row each for the chord that runs it, the segment the
 * mouse hit-test measures, and what it does. Array order is the left-to-right order of the segments.
 * Ctrl+J is the same byte as Enter, which handleInput answers first, so only its click reaches here.
 */
const CONTROLS = [
    { key: Key.ctrl("f"), segment: (dashboard) => `/search:${dashboard.query.search ?? ""}`, activate: (dashboard) => { dashboard.focus = "search"; } },
    { key: Key.ctrl("v"), segment: (dashboard) => `v:${dashboard.query.view}`, activate: (dashboard) => dashboard.cycleView() },
    { key: Key.ctrl("t"), segment: (dashboard) => `t:${dashboard.query.taskStates?.join(",") ?? "all"}`, activate: (dashboard) => dashboard.setTaskStates(dashboard.singletonCycle(TASK_STATES, dashboard.query.taskStates)) },
    { key: Key.ctrl("p"), segment: (dashboard) => `p:${dashboard.query.processStates?.join(",") ?? "all"}`, activate: (dashboard) => dashboard.setProcessStates(dashboard.singletonCycle(PROCESS_STATES, dashboard.query.processStates)) },
    { key: Key.ctrl("o"), segment: (dashboard) => `o:${dashboard.query.outcomes?.join(",") ?? "all"}`, activate: (dashboard) => dashboard.setOutcomes(dashboard.singletonCycle(OUTCOMES, dashboard.query.outcomes)) },
    { key: Key.ctrl("a"), segment: (dashboard) => `a:${dashboard.query.activityKinds?.join(",") ?? "all"}`, activate: (dashboard) => dashboard.cycleActivityFilter() },
    { key: Key.ctrl("j"), segment: (dashboard) => `j:${dashboard.query.projectPaths?.join(",") ?? "all"}`, activate: (dashboard) => dashboard.setProjectPaths(dashboard.singletonCycle([...new Set(dashboard.sessions.map((session) => session.cwd))], dashboard.query.projectPaths)) },
    { key: Key.ctrl("s"), segment: (dashboard) => `s:${dashboard.query.sort === undefined ? "none" : `${dashboard.query.sort.key}/${dashboard.query.sort.direction}`}`, activate: (dashboard) => dashboard.cycleSort() },
    { key: Key.ctrl("b"), segment: (dashboard) => `g:${dashboard.query.groupBy ?? "none"}`, activate: (dashboard) => dashboard.setGrouping(cycleValue(GROUPS, dashboard.query.groupBy)) },
];
function fitLine(line, width) {
    const clipped = truncateToWidth(line.replace(/[\r\n\u2028\u2029]/gu, " "), Math.max(0, width), "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
function paintPlainLine(text, width, paint) {
    return paint(fitLine(stripVTControlCharacters(String(text)), width));
}
const COMPOSER_FIELD_LABELS = {
    prompt: "prompt",
    cwd: "cwd",
    isolationMode: "isolation",
    modelProvider: "model provider",
    modelId: "model id",
    thinkingLevel: "thinking",
    name: "name",
};
function sectionFooter(width, focused) {
    return paintPlainLine("─".repeat(Math.max(0, width)), width, focused ? jobwatchTheme.focusBorder : jobwatchTheme.text);
}
function sectionBorder(label, width, focused) {
    const prefix = label === "" ? "╭─" : `╭─ ${label} `;
    const line = prefix + "─".repeat(Math.max(0, width - visibleWidth(prefix)));
    return paintPlainLine(line, width, focused ? jobwatchTheme.focusBorder : jobwatchTheme.inactiveBorder);
}
function overlayRow(content, innerWidth, indent, paintContent) {
    const body = fitLine(stripVTControlCharacters(String(content)), innerWidth);
    return `${" ".repeat(indent)}${jobwatchTheme.overlayBorder("│")}${paintContent(` ${body} `)}${jobwatchTheme.overlayBorder("│")}`;
}
/** Render one centered Jobwatch-style floating panel bounded by the dashboard width and list height. */
function renderOverlayPanel(described, width, areaHeight) {
    const frameCost = 4;
    const contentWidth = Math.max(visibleWidth(described.title) + 3, ...described.rows.map((row) => visibleWidth(row.text)));
    const innerWidth = Math.max(1, Math.min(contentWidth, width - frameCost));
    const outerWidth = Math.min(width, innerWidth + frameCost);
    const indent = Math.max(0, Math.floor((width - outerWidth) / 2));
    const visibleRows = described.rows.slice(0, Math.max(1, areaHeight - 2));
    const titlePrefix = `╭─ ${truncateToWidth(stripVTControlCharacters(described.title), Math.max(0, outerWidth - 5), "")} `;
    const top = `${" ".repeat(indent)}${jobwatchTheme.overlayBorder(titlePrefix + "─".repeat(Math.max(0, outerWidth - visibleWidth(titlePrefix) - 1)) + "╮")}`;
    const bottom = `${" ".repeat(indent)}${jobwatchTheme.overlayBorder("╰" + "─".repeat(Math.max(0, outerWidth - 2)) + "╯")}`;
    return [
        top,
        ...visibleRows.map((row) => overlayRow(row.text, innerWidth, indent, row.emphasis === true ? jobwatchTheme.overlayMuted : jobwatchTheme.overlayText)),
        bottom,
    ];
}
/** Own dashboard subscription, focus, selection, launch, rendering, and disposal. */
export class DashboardController {
    backend;
    persistence;
    openViewer;
    clientId;
    sourceSessionId;
    requestId;
    onClose;
    onSessionIntent;
    requestRender;
    now;
    unsubscribe;
    sessions = [];
    list = new VirtualSessionList([]);
    width = 80;
    height = 24;
    viewportOffset = 0;
    cursor;
    pendingShared;
    closed = true;
    preferredSelectionId;
    openGeneration = 0;
    openController;
    confirmationText = "";
    closePromise;
    eventOperations = new Set();
    eventTail = Promise.resolve();
    saveTail = Promise.resolve();
    saveFailure;
    saveAdmissionGeneration = 0;
    renderRequestGeneration = 0;
    renderWaiters = new Map();
    stopClearGesture;
    animationTimer;
    query = defaultQuery();
    focus = "list";
    composerField = "prompt";
    composerDraft;
    overlay;
    status = { kind: "loading" };
    constructor(options) {
        this.backend = options.backend;
        this.persistence = options.persistence;
        if (typeof options.openViewer !== "function")
            throw new TypeError("openViewer is required");
        this.openViewer = options.openViewer;
        this.clientId = options.clientId;
        this.sourceSessionId = options.sourceSessionId;
        this.requestId = options.requestId ?? randomUUID;
        this.onClose = options.onClose;
        this.onSessionIntent = options.onSessionIntent;
        this.requestRender = options.requestRender;
        this.now = options.now ?? Date.now;
        this.stopClearGesture = new StopClearGesture({ now: options.now });
        this.composerDraft = createLaunchDraft({
            ...options.launchDefaults,
            sourceSessionId: options.sourceSessionId,
        });
    }
    get selectedSessionId() {
        return this.list.selectedSessionId;
    }
    async open() {
        if (!this.closed)
            return;
        this.closed = false;
        this.closePromise = undefined;
        this.saveFailure = undefined;
        this.eventTail = Promise.resolve();
        const generation = ++this.openGeneration;
        const controller = new AbortController();
        this.openController = controller;
        this.status = { kind: "loading" };
        try {
            const persisted = await this.persistence.load();
            if (!this.isCurrentOpen(generation))
                return;
            if (persisted?.clientId === this.clientId) {
                this.cursor = persisted.cursor;
                this.query = safeQuery(persisted.viewState?.query);
                this.preferredSelectionId = persisted.viewState?.selectedSessionId;
                if (persisted.launchDraft !== undefined) {
                    this.composerDraft = {
                        ...persisted.launchDraft,
                        sourceSessionId: this.sourceSessionId,
                        model: { ...persisted.launchDraft.model },
                    };
                }
            }
            const snapshot = await this.backend.getSnapshot(controller.signal);
            if (!this.isCurrentOpen(generation))
                return;
            this.applySnapshot(snapshot);
            const unsubscribe = await this.backend.subscribe(this.cursor, (update) => this.trackEvent(update, generation), (error) => { if (this.isCurrentOpen(generation))
                this.fail(error); });
            if (!this.isCurrentOpen(generation)) {
                unsubscribe();
                return;
            }
            this.unsubscribe = unsubscribe;
            this.status = { kind: "ready" };
            this.requestRender?.();
            this.refreshSummaries();
        }
        catch (error) {
            if (!this.isCurrentOpen(generation))
                return;
            this.fail(this.typedError(error, "DASHBOARD_OPEN_FAILED"));
        }
    }
    close() {
        return this.beginClose();
    }
    resize(width, height) {
        this.width = Math.max(0, Math.floor(width));
        this.height = Math.max(0, Math.floor(height));
        this.ensureSelectionVisible();
    }
    get stopClearArmed() {
        const selected = this.list.selectedSessionId;
        return selected !== undefined && this.stopClearGesture.armedFor(selected);
    }
    selectSession(sessionId) {
        if (sessionId !== this.list.selectedSessionId)
            this.stopClearGesture.cancel();
        this.preferredSelectionId = sessionId;
        const selected = this.list.selectSession(sessionId);
        this.ensureSelectionVisible();
        if (selected) {
            this.invalidateSessionConfirmation();
            this.scheduleUiSave();
        }
        return selected;
    }
    setSearch(search) {
        this.setQuery({ ...this.query, search: search?.trim() === "" ? undefined : search });
    }
    setTaskStates(taskStates) {
        this.setQuery({ ...this.query, taskStates });
    }
    setProcessStates(processStates) {
        this.setQuery({ ...this.query, processStates });
    }
    setOutcomes(outcomes) {
        this.setQuery({ ...this.query, outcomes });
    }
    setActivityKinds(activityKinds) {
        this.setQuery({ ...this.query, activityKinds });
    }
    setProjectPaths(projectPaths) {
        this.setQuery({ ...this.query, projectPaths });
    }
    setGrouping(groupBy) {
        this.setQuery({ ...this.query, groupBy });
    }
    setSort(key, direction) {
        this.setQuery({ ...this.query, sort: { key, direction } });
    }
    setView(view) {
        this.setQuery({ ...this.query, view });
    }
    clearFilters() {
        this.setQuery({ view: this.query.view, sort: this.query.sort, groupBy: this.query.groupBy });
    }
    toggleMetadata() {
        const selected = this.selectedSession();
        this.overlay = this.overlay?.kind === "metadata" || selected === undefined
            ? undefined
            : createMetadataOverlay(selected);
    }
    toggleHelp() {
        this.overlay = this.overlay?.kind === "help" ? undefined : createHelpOverlay();
    }
    /** Aim typed text at the prompt. The composer is not a focus stop, so this leaves focus on the list. */
    focusComposer() {
        this.focus = "list";
        this.composerField = "prompt";
    }
    setComposerPrompt(prompt) {
        this.composerDraft = { ...this.composerDraft, prompt };
        this.scheduleUiSave();
    }
    setIsolationMode(isolationMode) {
        this.composerDraft = { ...this.composerDraft, isolationMode };
        this.scheduleUiSave();
    }
    async submitComposer() {
        if (this.composerDraft.prompt.trim().length === 0)
            return;
        try {
            const preflight = await this.backend.preflightLaunch(this.composerDraft);
            const prepared = prepareLaunchRequest(this.composerDraft, preflight);
            if (prepared.kind === "confirmation_required") {
                this.pendingShared = { draft: { ...this.composerDraft, model: { ...this.composerDraft.model } }, preflight };
                this.confirmationText = "";
                this.focus = "confirmation";
                this.overlay = createSharedDirectoryOverlay(prepared.canonicalCwd, prepared.ownerSessionIds);
                return;
            }
            if (prepared.kind === "ready")
                await this.launch(prepared.request);
        }
        catch (error) {
            this.setError(error, "LAUNCH_PREFLIGHT_FAILED");
        }
    }
    async confirmSharedLaunch(exactPath) {
        const pending = this.pendingShared;
        if (pending === undefined)
            return;
        const prepared = prepareLaunchRequest(pending.draft, pending.preflight, exactPath);
        if (prepared.kind !== "ready") {
            this.status = { kind: "error", code: "CONFIRMATION_MISMATCH", message: `Type the exact canonical cwd: ${pending.preflight.canonicalCwd}` };
            return;
        }
        this.pendingShared = undefined;
        this.confirmationText = "";
        this.overlay = undefined;
        await this.launch(prepared.request);
    }
    async resolveUnknownDelivery(resolution) {
        if (this.overlay?.kind !== "delivery_unknown")
            return;
        const { clientId, requestId } = this.overlay;
        await this.backend.resolveDelivery(clientId, requestId, resolution);
        this.overlay = undefined;
    }
    async confirmSession(confirmation) {
        const selected = this.sessions.find((session) => session.sessionId === confirmation.sessionId);
        if (selected === undefined) {
            this.overlay = undefined;
            return;
        }
        // Background metadata (summaries, names, activity) bumps the revision while the prompt is open;
        // only a change in what makes the session destructible cancels the confirmation.
        if (confirmation.action !== destructiveAction(selected)) {
            this.overlay = undefined;
            this.setError(Object.assign(new Error("The session changed before the action ran"), { code: selected.processState === "LIVE" || selected.ownership !== undefined ? "SESSION_LIVE" : "SESSION_CHANGED" }), "SESSION_CHANGED");
            return;
        }
        const requestId = this.requestId();
        const { action, sessionId } = confirmation;
        const { revision } = selected;
        // The daemon's stop policy escalates SIGTERM to SIGKILL over seconds. Hand the request off and
        // give the list straight back; the outcome arrives as a status line and a session event.
        this.overlay = undefined;
        this.status = { kind: "pending", code: `${action.toUpperCase()}_SENT`, message: `${action} sent for ${sessionId}` };
        if (action === "stop") {
            this.setView("all");
            this.selectSession(sessionId);
        }
        this.requestRender();
        try {
            await this.backend[action](sessionId, revision, requestId);
            // Arm only after the stop landed, so a single press can never remove a running session.
            if (action === "stop")
                this.stopClearGesture.armAfterStop(sessionId);
            if (this.status.kind === "pending" && this.status.code === `${action.toUpperCase()}_SENT`)
                this.status = { kind: "ready" };
        }
        catch (error) {
            const typed = error;
            if (typed.code === "DELIVERY_UNKNOWN")
                this.overlay = createDeliveryUnknownOverlay(typed.clientId ?? this.clientId, typed.requestId ?? requestId);
            else
                this.setError(error, `${action.toUpperCase()}_FAILED`);
        }
        this.requestRender();
    }
    async activateSelection() {
        const selected = this.selectedSession();
        if (selected === undefined)
            return;
        await this.openViewer(selected.sessionId);
    }
    handleInput(data) {
        if (matchesKey(data, Key.ctrl("c"))) {
            void this.close();
            return;
        }
        if (this.overlay?.kind === "session_confirmation") {
            if (matchesKey(data, Key.escape) || data.toLowerCase() === "n") {
                this.overlay = undefined;
                return;
            }
            if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
                void this.confirmSession(this.overlay);
            }
            return;
        }
        if (this.focus === "confirmation") {
            if (matchesKey(data, Key.escape)) {
                this.focus = "list";
                this.pendingShared = undefined;
                this.confirmationText = "";
                this.overlay = undefined;
                return;
            }
            if (matchesKey(data, Key.enter)) {
                void this.confirmSharedLaunch(this.confirmationText);
                return;
            }
            if (matchesKey(data, Key.backspace)) {
                this.confirmationText = this.confirmationText.slice(0, -1);
                return;
            }
            const printable = this.printable(data);
            if (printable !== undefined)
                this.confirmationText += printable;
            return;
        }
        if (this.focus === "search") {
            if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
                this.focus = "list";
                return;
            }
            if (matchesKey(data, Key.backspace)) {
                this.setSearch((this.query.search ?? "").slice(0, -1));
                return;
            }
            const printable = this.printable(data);
            if (printable !== undefined)
                this.setSearch((this.query.search ?? "") + printable);
            return;
        }
        if (matchesKey(data, Key.tab)) {
            this.cycleComposerField(1);
            return;
        }
        if (matchesKey(data, "shift+tab")) {
            this.cycleComposerField(-1);
            return;
        }
        if (this.composerField === "isolationMode" && (matchesKey(data, Key.left) || matchesKey(data, Key.right) || data === " ")) {
            this.setIsolationMode(this.composerDraft.isolationMode === "worktree" ? "shared_directory" : "worktree");
            return;
        }
        if (matchesKey(data, Key.backspace)) {
            this.editComposerField((value) => value.slice(0, -1));
            return;
        }
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) return;
        if (matchesKey(data, Key.ctrl("x"))) {
            const selected = this.selectedSession();
            if (selected !== undefined) {
                const clearingStopped = this.stopClearGesture.pressWouldClear(selected.sessionId);
                this.overlay = { ...createSessionConfirmation(selected), clearingStopped };
                this.onSessionIntent?.(createSessionIntent(selected));
            }
            return;
        }
        if (matchesKey(data, Key.enter)) {
            if (this.composerDraft.prompt.trim() !== "")
                void this.submitComposer();
            else
                void this.activateSelection();
            return;
        }
        if (matchesKey(data, Key.right)) {
            void this.activateSelection();
            return;
        }
        const control = CONTROLS.find(({ key }) => matchesKey(data, key));
        if (control !== undefined) {
            control.activate(this);
            return;
        }
        if (matchesKey(data, Key.down))
            this.moveSelection(1);
        else if (matchesKey(data, Key.up))
            this.moveSelection(-1);
        else if (matchesKey(data, Key.pageDown))
            this.moveSelection(Math.max(1, this.listHeight()));
        else if (matchesKey(data, Key.pageUp))
            this.moveSelection(-Math.max(1, this.listHeight()));
        else if (matchesKey(data, Key.home))
            this.selectBoundary(false);
        else if (matchesKey(data, Key.end))
            this.selectBoundary(true);
        else if (matchesKey(data, Key.ctrl("e")))
            this.toggleMetadata();
        else if (matchesKey(data, Key.ctrl("g")))
            this.toggleHelp();
        else if (matchesKey(data, Key.ctrl("r")))
            this.refreshSummaries();
        else if (matchesKey(data, Key.ctrl("l")))
            this.clearFilters();
        else {
            // Typed and pasted text always composes a prompt, wherever the cursor sits in the list.
            const printable = this.printable(data);
            if (printable !== undefined) {
                this.composerField = "prompt";
                this.editComposerField((value) => value + printable);
            }
        }
    }
    /**
     * Only wheel events arrive in production: the terminal tap in app/mouse-input.mjs forwards
     * wheel notches and passes clicks through to pi-tui's own selection handling. The click
     * branches below stay covered by tests but are unreachable until pi-tui exposes a click seam.
     */
    handleMouse(event) {
        if (event.button === "wheel_up") {
            this.moveSelection(-1);
            return;
        }
        if (event.button === "wheel_down") {
            this.moveSelection(1);
            return;
        }
        const layout = createDashboardLayout(this.width, this.height);
        if (Math.floor(event.row) === 2) {
            const column = Math.max(0, Math.floor(event.column));
            let offset = 1;
            const clicked = CONTROLS.find(({ segment }) => {
                const width = segment(this).length;
                const inside = column >= offset && column < offset + width;
                offset += width + 1;
                return inside;
            });
            (clicked ?? CONTROLS[0]).activate(this);
            return;
        }
        if (Math.floor(event.row) === this.height - 3) {
            this.focusComposer();
            return;
        }
        if (Math.floor(event.row) === this.height - 2) {
            this.composerField = COMPOSER_FIELDS[1 + Math.min(COMPOSER_FIELDS.length - 2, Math.floor(Math.max(0, event.column) * (COMPOSER_FIELDS.length - 1) / Math.max(1, this.width)))];
            return;
        }
        const index = this.viewportOffset + Math.floor(event.row) - layout.listTop;
        const row = this.list.rows[index];
        if (row?.kind === "session")
            this.selectSession(row.session.sessionId);
    }
    render(width = this.width, height = this.height) {
        const renderedGeneration = this.renderRequestGeneration;
        try {
            this.resize(width, height);
            // Rows cache their rendered line; without a fresh reading the spinner frame and age never move.
            this.list.setNow(this.now());
            const layout = createDashboardLayout(this.width, this.height);
            // The dock takes the focus border only while it waits for the typed shared-directory path.
            const confirmingSharedLaunch = this.focus === "confirmation";
            const lines = Array.from({ length: this.height }, () => "");
            if (lines.length > 0)
                lines[0] = paintPlainLine(" pi-dashboard", this.width, jobwatchTheme.title);
            if (lines.length > 1)
                lines[1] = paintPlainLine(this.activeFilterSummary(), this.width, jobwatchTheme.keyHints);
            if (lines.length > 2)
                lines[2] = sectionBorder("Sessions", this.width, !confirmingSharedLaunch);
            if (lines.length > 3)
                lines[3] = renderColumnHeader(layout);
            const rendered = this.list.renderViewport({ offset: this.viewportOffset, height: layout.listHeight, width: this.width });
            for (let index = 0; index < rendered.length; index += 1) {
                const target = layout.listTop + index;
                if (target < lines.length)
                    lines[target] = rendered[index].line;
            }
            if (lines.length >= 4) {
                const dockTop = lines.length - layout.dockRows;
                const draftPrompt = this.composerDraft.prompt;
                lines[dockTop] = sectionBorder(this.composerField === "prompt" ? "" : COMPOSER_FIELD_LABELS[this.composerField], this.width, confirmingSharedLaunch);
                lines[dockTop + 1] = paintPlainLine(` ❯ ${draftPrompt || "describe a task for a new session"}`, this.width, draftPrompt ? (text) => jobwatchTheme.text(text, false) : (text) => jobwatchTheme.muted(text, false));
                const form = ` cwd:${this.composerDraft.cwd} isolation:${this.composerDraft.isolationMode} model:${this.composerDraft.model.provider}/${this.composerDraft.model.id} thinking:${this.composerDraft.thinkingLevel} name:${this.composerDraft.name}`;
                lines[dockTop + 2] = paintPlainLine(this.status.kind === "error" ? ` ${this.status.code}: ${this.status.message}  ${form}` : form, this.width, this.status.kind === "error" ? jobwatchTheme.error : jobwatchTheme.surface);
                if (layout.dockRows >= 5) lines[dockTop + 3] = sectionFooter(this.width, confirmingSharedLaunch);
                if (layout.dockRows >= 6) lines[dockTop + 4] = paintPlainLine(this.selectedCwdLine(), this.width, jobwatchTheme.keyHints);
                lines[lines.length - 1] = paintPlainLine(" Ctrl+C quit  ↑↓ navigate  Enter/→ open  ←/Esc back  type to compose  Tab fields  ^X action  ^G help", this.width, jobwatchTheme.keyHints);
            }
            this.renderOverlay(lines);
            this.syncAnimation();
            const result = lines.map((line) => fitLine(line, this.width));
            this.completeHostRender(renderedGeneration);
            return result;
        }
        catch (error) {
            const typed = this.typedError(error, "RENDER_FAILED");
            this.rejectHostRenders(Object.assign(new Error(typed.message), { code: typed.code }));
            this.fail(typed);
            throw Object.assign(new Error(typed.message), { code: typed.code });
        }
    }
    setQuery(query) {
        this.query = query;
        this.rebuildList();
        this.scheduleUiSave();
    }
    applySnapshot(snapshot) {
        this.sessions = snapshot.sessions;
        this.rebuildList();
        this.invalidateSessionConfirmation();
    }
    invalidateSessionConfirmation() {
        if (this.overlay?.kind !== "session_confirmation")
            return;
        // Summaries, names and activity churn the revision constantly; only a change in what the session
        // admits (stop versus delete, or the session disappearing) invalidates an open confirmation.
        const current = this.sessions.find((session) => session.sessionId === this.overlay.sessionId);
        if (current === undefined || destructiveAction(current) !== this.overlay.action) {
            const action = this.overlay.action;
            this.overlay = undefined;
            if (current !== undefined)
                this.setError(Object.assign(new Error(`Session became ${destructiveAction(current) === "stop" ? "live" : "inactive"} before ${action.toUpperCase()}`), { code: destructiveAction(current) === "stop" ? "SESSION_LIVE" : "SESSION_INACTIVE" }), "SESSION_CHANGED");
        }
    }
    rebuildList() {
        const selected = this.preferredSelectionId ?? this.list.selectedSessionId;
        const visible = selectDashboardSessions(this.sessions, this.query);
        this.list.setSessions(visible, { groupBy: this.query.groupBy });
        if (selected !== undefined && visible.some((session) => session.sessionId === selected)) {
            this.list.selectSession(selected);
            this.preferredSelectionId = selected;
        }
        this.ensureSelectionVisible();
    }
    selectedSession() {
        const selectedId = this.selectedSessionId;
        return selectedId === undefined ? undefined : this.sessions.find((session) => session.sessionId === selectedId);
    }
    moveSelection(delta) {
        this.stopClearGesture.cancel();
        this.list.moveSelection(delta);
        this.preferredSelectionId = this.list.selectedSessionId;
        this.ensureSelectionVisible();
        this.scheduleUiSave();
    }
    selectBoundary(last) {
        const rows = last ? [...this.list.rows].reverse() : this.list.rows;
        const row = rows.find((candidate) => candidate.kind === "session");
        if (row?.kind === "session")
            this.selectSession(row.session.sessionId);
    }
    listHeight() {
        return createDashboardLayout(this.width, this.height).listHeight;
    }
    ensureSelectionVisible() {
        const row = this.list.selectedRowIndex;
        const height = this.listHeight();
        const maximum = Math.max(0, this.list.rows.length - height);
        if (row < 0 || height <= 0)
            this.viewportOffset = Math.min(this.viewportOffset, maximum);
        else if (row < this.viewportOffset)
            this.viewportOffset = row;
        else if (row >= this.viewportOffset + height)
            this.viewportOffset = row - height + 1;
        this.viewportOffset = Math.max(0, Math.min(this.viewportOffset, maximum));
    }
    cycleView() {
        const next = this.query.view === "live" ? "done" : this.query.view === "done" ? "all" : "live";
        this.setView(next);
    }
    selectedCwdLine() {
        const selected = this.selectedSession();
        return selected === undefined ? "" : ` ${selected.cwd}`;
    }
    /** Show filter state only once something is filtered; the keys themselves live in the footer and in Help. */
    activeFilterSummary() {
        const active = [
            this.query.search === undefined || this.query.search === "" ? undefined : `search:${this.query.search}`,
            this.query.view === "live" ? undefined : `view:${this.query.view}`,
            this.query.taskStates === undefined ? undefined : `state:${this.query.taskStates.join(",")}`,
            this.query.processStates === undefined ? undefined : `process:${this.query.processStates.join(",")}`,
            this.query.outcomes === undefined ? undefined : `outcome:${this.query.outcomes.join(",")}`,
            this.query.activityKinds === undefined ? undefined : `activity:${this.query.activityKinds.join(",")}`,
            this.query.projectPaths === undefined ? undefined : `project:${this.query.projectPaths.join(",")}`,
            this.query.sort === undefined ? undefined : `sort:${this.query.sort.key}/${this.query.sort.direction}`,
            this.query.groupBy === undefined ? undefined : `group:${this.query.groupBy}`,
        ].filter((segment) => segment !== undefined);
        return active.length === 0 ? "" : ` ${active.join("  ")}`;
    }
    singletonCycle(values, current) {
        const next = cycleValue(values, current?.length === 1 ? current[0] : undefined);
        return next === undefined ? undefined : [next];
    }
    cycleActivityFilter() {
        const kinds = [...new Set(this.sessions.map((session) => session.activity.kind))].sort();
        this.setActivityKinds(this.singletonCycle(kinds, this.query.activityKinds));
    }
    cycleSort() {
        const current = this.query.sort;
        if (current === undefined) {
            this.setSort(SORT_KEYS[0], "asc");
            return;
        }
        if (current.direction === "asc") {
            this.setSort(current.key, "desc");
            return;
        }
        const next = cycleValue(SORT_KEYS, current.key);
        this.setQuery({ ...this.query, sort: next === undefined ? undefined : { key: next, direction: "asc" } });
    }
    cycleComposerField(delta) {
        const current = COMPOSER_FIELDS.indexOf(this.composerField);
        this.composerField = COMPOSER_FIELDS[(current + delta + COMPOSER_FIELDS.length) % COMPOSER_FIELDS.length];
    }
    editComposerField(edit) {
        switch (this.composerField) {
            case "prompt":
                this.composerDraft = { ...this.composerDraft, prompt: edit(this.composerDraft.prompt) };
                break;
            case "cwd":
                this.composerDraft = { ...this.composerDraft, cwd: edit(this.composerDraft.cwd) };
                break;
            case "modelProvider":
                this.composerDraft = { ...this.composerDraft, model: { ...this.composerDraft.model, provider: edit(this.composerDraft.model.provider) } };
                break;
            case "modelId":
                this.composerDraft = { ...this.composerDraft, model: { ...this.composerDraft.model, id: edit(this.composerDraft.model.id) } };
                break;
            case "thinkingLevel":
                this.composerDraft = { ...this.composerDraft, thinkingLevel: edit(this.composerDraft.thinkingLevel) };
                break;
            case "name":
                this.composerDraft = { ...this.composerDraft, name: edit(this.composerDraft.name) };
                break;
            case "isolationMode": return;
        }
        this.scheduleUiSave();
    }
    printable(data) {
        return decodeKittyPrintable(data) ?? pastedText(data);
    }
    /** Ask the daemon for opt-in Activity summaries; absence of a summary model is not an error. */
    refreshSummaries() {
        if (typeof this.backend.refreshSummaries !== "function")
            return;
        void Promise.resolve(this.backend.refreshSummaries()).catch(() => { });
    }
    async launch(request) {
        // Show the list before the daemon answers: startup takes seconds and the session row arrives by subscription.
        this.focus = "list";
        this.status = { kind: "ready" };
        this.requestRender?.();
        const outcome = await this.backend.launch(request, this.requestId());
        if (outcome.kind === "launched") {
            this.composerDraft = { ...this.composerDraft, prompt: "" };
            this.scheduleUiSave();
            this.requestRender?.();
            return;
        }
        if (outcome.kind === "delivery_unknown") {
            this.focus = "list";
            this.overlay = createDeliveryUnknownOverlay(outcome.clientId, outcome.requestId);
            return;
        }
        this.status = { kind: "error", code: outcome.error.code, message: outcome.error.message };
    }
    renderOverlay(lines) {
        const overlay = this.overlay;
        if (overlay === undefined || lines.length === 0)
            return;
        const described = describeOverlay(overlay, { confirmationText: this.confirmationText });
        const layout = createDashboardLayout(this.width, this.height);
        const areaTop = Math.min(layout.listTop, Math.max(0, lines.length - 1));
        // A short terminal leaves no list rows; the panel then borrows the space below it rather than covering the header.
        const areaHeight = Math.max(1, Math.min(Math.max(layout.listHeight, described.rows.length + 2), Math.max(1, lines.length - areaTop)));
        const panel = renderOverlayPanel(described, this.width, areaHeight);
        const start = areaTop + Math.max(0, Math.floor((areaHeight - panel.length) / 2));
        panel.forEach((line, index) => { if (start + index < lines.length)
            lines[start + index] = line; });
    }
    trackEvent(update, generation) {
        const operation = this.eventOperations.size === 0
            ? this.processEvent(update, generation)
            : this.eventTail.then(() => this.processEvent(update, generation));
        this.eventTail = operation;
        this.eventOperations.add(operation);
        void operation.finally(() => this.eventOperations.delete(operation)).catch(() => { });
        return operation;
    }
    async processEvent(update, generation) {
        if (!this.isCurrentOpen(generation))
            throw Object.assign(new Error("Dashboard is closed"), { code: "DASHBOARD_CLOSED" });
        try {
            this.applySnapshot(update.snapshot);
            await this.awaitHostRender();
            if (!this.isCurrentOpen(generation))
                throw Object.assign(new Error("Dashboard is closed"), { code: "DASHBOARD_CLOSED" });
            await this.enqueueSave(this.persistedState(update.cursor));
            if (!this.isCurrentOpen(generation))
                throw Object.assign(new Error("Dashboard is closed"), { code: "DASHBOARD_CLOSED" });
            this.cursor = update.cursor;
        }
        catch (error) {
            const typed = this.typedError(error, "EVENT_PROCESSING_FAILED");
            this.fail(typed);
            throw Object.assign(new Error(typed.message), { code: typed.code });
        }
    }
    /**
     * Keep one repaint timer alive exactly while a visible session is working. Without it the
     * spinner frame only advances when some other event happens to redraw the list.
     */
    syncAnimation() {
        const working = this.list.rows.some((row) => row.kind === "session" && displaySessionState(row.session) === "WORKING");
        if (!working || this.closed || this.requestRender === undefined) {
            this.stopAnimation();
            return;
        }
        if (this.animationTimer !== undefined)
            return;
        this.animationTimer = setInterval(() => this.requestRender?.(), SPINNER_INTERVAL_MS);
        this.animationTimer.unref?.();
    }
    stopAnimation() {
        if (this.animationTimer === undefined)
            return;
        clearInterval(this.animationTimer);
        this.animationTimer = undefined;
    }
    awaitHostRender() {
        if (this.requestRender === undefined)
            return Promise.reject(Object.assign(new Error("Dashboard host cannot request rendering"), { code: "UNSUPPORTED_HOST" }));
        const generation = ++this.renderRequestGeneration;
        const rendered = new Promise((resolve, reject) => {
            this.renderWaiters.set(generation, { resolve, reject });
        });
        try {
            this.requestRender();
        }
        catch (error) {
            const waiter = this.renderWaiters.get(generation);
            this.renderWaiters.delete(generation);
            const waiterError = Object.assign(new Error("Dashboard host render request failed"), { code: "RENDER_FAILED", cause: error });
            waiter?.reject(waiterError);
            return rendered;
        }
        return rendered;
    }
    completeHostRender(generation) {
        const waiter = this.renderWaiters.get(generation);
        if (waiter === undefined)
            return;
        this.renderWaiters.delete(generation);
        waiter.resolve();
    }
    rejectHostRenders(error) {
        for (const waiter of this.renderWaiters.values())
            waiter.reject(error);
        this.renderWaiters.clear();
    }
    persistedState(cursor = this.cursor) {
        const { sourceSessionId: _sourceSessionId, ...launchDraft } = this.composerDraft;
        return {
            schemaVersion: 1,
            clientId: this.clientId,
            cursor,
            viewState: {
                query: (({ historyPolicy: _historyPolicy, ...query }) => query)(this.query),
                selectedSessionId: this.preferredSelectionId ?? this.selectedSessionId,
            },
            launchDraft: { ...launchDraft, model: { ...launchDraft.model } },
        };
    }
    enqueueSave(state) {
        const operation = this.saveTail.then(() => this.persistence.save(state));
        this.saveTail = operation.then(() => { }, (error) => { this.saveFailure ??= error; });
        return operation;
    }
    scheduleUiSave() {
        if (this.closed)
            return;
        const admission = this.saveAdmissionGeneration;
        const state = this.persistedState();
        if (this.closed || admission !== this.saveAdmissionGeneration)
            return;
        const operation = this.enqueueSave(state);
        void operation.catch((error) => this.fail(this.typedError(error, "PERSIST_FAILED")));
    }
    beginClose(initialError) {
        if (this.closePromise !== undefined)
            return this.closePromise;
        this.stopAnimation();
        this.closed = true;
        this.openGeneration += 1;
        this.saveAdmissionGeneration += 1;
        this.openController?.abort();
        this.openController = undefined;
        const unsubscribe = this.unsubscribe;
        this.unsubscribe = undefined;
        unsubscribe?.();
        this.overlay = undefined;
        this.pendingShared = undefined;
        this.confirmationText = "";
        const closedError = initialError ?? { code: "DASHBOARD_CLOSED", message: "Dashboard closed before host render" };
        this.rejectHostRenders(Object.assign(new Error(closedError.message), { code: closedError.code }));
        this.closePromise = this.finishClose(initialError);
        return this.closePromise;
    }
    async finishClose(initialError) {
        let error = initialError;
        await Promise.allSettled([...this.eventOperations]);
        await this.saveTail;
        if (error === undefined && this.saveFailure !== undefined)
            error = this.typedError(this.saveFailure, "PERSIST_FAILED");
        try {
            await this.enqueueSave(this.persistedState());
        }
        catch (saveError) {
            error ??= this.typedError(saveError, "DASHBOARD_CLOSE_FAILED");
        }
        await this.saveTail;
        const result = error === undefined
            ? { kind: "closed" }
            : { kind: "error", code: error.code, message: error.message };
        if (error !== undefined)
            this.status = { kind: "error", code: error.code, message: error.message };
        this.onClose?.(result);
    }
    isCurrentOpen(generation) {
        return !this.closed && this.openGeneration === generation;
    }
    typedError(error, fallbackCode) {
        const typed = error;
        return { code: typed.code ?? fallbackCode, message: typed.message ?? fallbackCode };
    }
    fail(error) {
        this.status = { kind: "error", code: error.code, message: error.message };
        this.beginClose(error).catch(() => { });
    }
    setError(error, fallbackCode) {
        const typed = this.typedError(error, fallbackCode);
        this.status = { kind: "error", code: typed.code, message: typed.message };
    }
}
