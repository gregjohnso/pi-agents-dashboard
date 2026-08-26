import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth, } from "@earendil-works/pi-tui";
import { countDashboardSessions, selectDashboardSessions, } from "./dashboard-state.mjs";
import { createDashboardLayout, renderColumnHeader, } from "./dashboard-layout.mjs";
import { jobwatchTheme } from "./dashboard-theme.mjs";
import { confirmationMatchesSession, createDeliveryUnknownOverlay, createHelpOverlay, createMetadataOverlay, createSessionConfirmation, createSessionIntent, createSharedDirectoryOverlay, } from "./dashboard-overlays.mjs";
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
function fitLine(line, width) {
    const clipped = truncateToWidth(line.replace(/[\r\n\u2028\u2029]/gu, " "), Math.max(0, width), "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
function paintPlainLine(text, width, paint) {
    return paint(fitLine(stripVTControlCharacters(String(text)), width));
}
function sectionBorder(label, width, focused) {
    const prefix = `╭─ ${label} `;
    const line = prefix + "─".repeat(Math.max(0, width - visibleWidth(prefix)));
    return paintPlainLine(line, width, focused ? jobwatchTheme.focusBorder : jobwatchTheme.inactiveBorder);
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
    selectSession(sessionId) {
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
    focusComposer() {
        this.focus = "composer";
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
        if (confirmation.submitting)
            return;
        const selected = this.selectedSession();
        if (!confirmationMatchesSession(confirmation, selected)) {
            this.overlay = undefined;
            return;
        }
        const requestId = this.requestId();
        this.overlay = { ...confirmation, submitting: true };
        try {
            await this.backend[confirmation.action](confirmation.sessionId, confirmation.revision, requestId);
            if (confirmation.action === "stop") {
                this.setView("all");
                this.selectSession(confirmation.sessionId);
            }
            if (this.overlay?.kind === "session_confirmation" && this.overlay.sessionId === confirmation.sessionId) {
                this.overlay = undefined;
            }
            this.status = { kind: "ready" };
        }
        catch (error) {
            const typed = error;
            if (typed.code === "DELIVERY_UNKNOWN") {
                this.overlay = createDeliveryUnknownOverlay(typed.clientId ?? this.clientId, typed.requestId ?? requestId);
            }
            else {
                this.overlay = { ...confirmation, submitting: false };
                this.setError(error, `${confirmation.action.toUpperCase()}_FAILED`);
            }
        }
    }
    async activateSelection() {
        const selected = this.selectedSession();
        if (selected === undefined)
            return;
        await this.openViewer(selected.sessionId);
    }
    handleInput(data) {
        if (matchesKey(data, Key.ctrl("c")) && !(this.overlay?.kind === "session_confirmation" && this.overlay.submitting)) {
            void this.close();
            return;
        }
        if (this.overlay?.kind === "session_confirmation") {
            if (this.overlay.submitting)
                return;
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
                this.focus = "composer";
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
        if (this.focus === "composer") {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.up)) {
                this.focus = "list";
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
            if (matchesKey(data, Key.enter)) {
                void this.submitComposer();
                return;
            }
            if (this.composerField === "isolationMode") {
                if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || data === " ") {
                    this.setIsolationMode(this.composerDraft.isolationMode === "worktree" ? "shared_directory" : "worktree");
                }
                return;
            }
            if (matchesKey(data, Key.backspace)) {
                this.editComposerField((value) => value.slice(0, -1));
                return;
            }
            const printable = this.printable(data);
            if (printable !== undefined)
                this.editComposerField((value) => value + printable);
            return;
        }
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) return;
        if (matchesKey(data, Key.ctrl("x"))) {
            const selected = this.selectedSession();
            if (selected !== undefined) {
                this.overlay = createSessionConfirmation(selected);
                this.onSessionIntent?.(createSessionIntent(selected));
            }
            return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
            void this.activateSelection();
            return;
        }
        if (matchesKey(data, Key.down)) {
            const lastSessionRow = this.list.rows.findLastIndex((row) => row.kind === "session");
            if (lastSessionRow < 0 || this.list.selectedRowIndex === lastSessionRow)
                this.focusComposer();
            else
                this.moveSelection(1);
        }
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
        else if (data === "/")
            this.focus = "search";
        else if (matchesKey(data, Key.tab) || data === "n")
            this.focusComposer();
        else if (data === "i")
            this.toggleMetadata();
        else if (data === "?")
            this.toggleHelp();
        else if (data === "v")
            this.cycleView();
        else if (data === "c")
            this.clearFilters();
        else if (data === "t")
            this.setTaskStates(this.singletonCycle(TASK_STATES, this.query.taskStates));
        else if (data === "p")
            this.setProcessStates(this.singletonCycle(PROCESS_STATES, this.query.processStates));
        else if (data === "o")
            this.setOutcomes(this.singletonCycle(OUTCOMES, this.query.outcomes));
        else if (data === "a")
            this.cycleActivityFilter();
        else if (data === "j")
            this.setProjectPaths(this.singletonCycle([...new Set(this.sessions.map((session) => session.cwd))], this.query.projectPaths));
        else if (data === "s")
            this.cycleSort();
        else if (data === "g")
            this.setGrouping(cycleValue(GROUPS, this.query.groupBy));
    }
    handleMouse(event) {
        if (event.button === "wheel_up") {
            this.moveSelection(-3);
            return;
        }
        if (event.button === "wheel_down") {
            this.moveSelection(3);
            return;
        }
        const layout = createDashboardLayout(this.width, this.height);
        if (Math.floor(event.row) === 2) {
            const column = Math.max(0, Math.floor(event.column));
            const segments = this.controlSegments();
            let offset = 1;
            const index = segments.findIndex((segment) => {
                const inside = column >= offset && column < offset + segment.length;
                offset += segment.length + 1;
                return inside;
            });
            this.activateControl(index < 0 ? 0 : index);
            return;
        }
        if (Math.floor(event.row) === this.height - 3) {
            this.focusComposer();
            return;
        }
        if (Math.floor(event.row) === this.height - 2) {
            this.focus = "composer";
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
            const layout = createDashboardLayout(this.width, this.height);
            const counts = countDashboardSessions(this.sessions);
            const lines = Array.from({ length: this.height }, () => "");
            if (lines.length > 0)
                lines[0] = paintPlainLine(" pi-dashboard", this.width, jobwatchTheme.title);
            if (lines.length > 1)
                lines[1] = paintPlainLine(` Working ${counts.working}  Ready ${counts.ready}  Failed ${counts.failed}  Sessions ${counts.sessions}  Processes ${counts.processes}`, this.width, jobwatchTheme.surface);
            if (lines.length > 2)
                lines[2] = paintPlainLine(` ${this.controlSegments().join(" ")}`, this.width, jobwatchTheme.keyHints);
            if (lines.length > 3)
                lines[3] = sectionBorder("Sessions", this.width, this.focus === "list" || this.focus === "search");
            if (lines.length > 4)
                lines[4] = renderColumnHeader(layout);
            const rendered = this.list.renderViewport({ offset: this.viewportOffset, height: layout.listHeight, width: this.width });
            for (let index = 0; index < rendered.length; index += 1) {
                const target = layout.listTop + index;
                if (target < lines.length)
                    lines[target] = rendered[index].line;
            }
            if (lines.length >= 4) {
                const composerFocused = this.focus === "composer" || this.focus === "confirmation";
                const composerMarker = composerFocused ? `[${this.composerField}]` : "";
                lines[lines.length - 4] = sectionBorder("New Session", this.width, composerFocused);
                lines[lines.length - 3] = paintPlainLine(` ❯${composerMarker} ${this.composerDraft.prompt || "describe a task for a new session"}`, this.width, (text) => jobwatchTheme.panel(text, composerFocused));
                const form = ` cwd:${this.composerDraft.cwd} isolation:${this.composerDraft.isolationMode} model:${this.composerDraft.model.provider}/${this.composerDraft.model.id} thinking:${this.composerDraft.thinkingLevel} name:${this.composerDraft.name}`;
                lines[lines.length - 2] = paintPlainLine(this.status.kind === "error" ? ` ${this.status.code}: ${this.status.message}  ${form}` : form, this.width, this.status.kind === "error" ? jobwatchTheme.error : jobwatchTheme.surface);
                lines[lines.length - 1] = paintPlainLine(" Ctrl+C quit  ↑↓ navigate  Enter/→ open  ←/Esc back  / search  n form  Tab fields  ^X action  ? help", this.width, jobwatchTheme.keyHints);
            }
            this.renderOverlay(lines);
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
        if (this.overlay?.kind === "session_confirmation" && !confirmationMatchesSession(this.overlay, this.selectedSession())) {
            this.overlay = undefined;
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
    controlSegments() {
        return [
            `/search:${this.query.search ?? ""}`,
            `v:${this.query.view}`,
            `t:${this.query.taskStates?.join(",") ?? "all"}`,
            `p:${this.query.processStates?.join(",") ?? "all"}`,
            `o:${this.query.outcomes?.join(",") ?? "all"}`,
            `a:${this.query.activityKinds?.join(",") ?? "all"}`,
            `j:${this.query.projectPaths?.join(",") ?? "all"}`,
            `s:${this.query.sort === undefined ? "none" : `${this.query.sort.key}/${this.query.sort.direction}`}`,
            `g:${this.query.groupBy ?? "none"}`,
        ];
    }
    activateControl(index) {
        switch (index) {
            case 0:
                this.focus = "search";
                break;
            case 1:
                this.cycleView();
                break;
            case 2:
                this.setTaskStates(this.singletonCycle(TASK_STATES, this.query.taskStates));
                break;
            case 3:
                this.setProcessStates(this.singletonCycle(PROCESS_STATES, this.query.processStates));
                break;
            case 4:
                this.setOutcomes(this.singletonCycle(OUTCOMES, this.query.outcomes));
                break;
            case 5:
                this.cycleActivityFilter();
                break;
            case 6:
                this.setProjectPaths(this.singletonCycle([...new Set(this.sessions.map((session) => session.cwd))], this.query.projectPaths));
                break;
            case 7:
                this.cycleSort();
                break;
            case 8:
                this.setGrouping(cycleValue(GROUPS, this.query.groupBy));
                break;
        }
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
        return decodeKittyPrintable(data)
            ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
    }
    async launch(request) {
        this.focus = "list";
        const outcome = await this.backend.launch(request, this.requestId());
        if (outcome.kind === "launched") {
            this.focus = "list";
            this.composerDraft = { ...this.composerDraft, prompt: "" };
            this.status = { kind: "ready" };
            this.scheduleUiSave();
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
        let details;
        if (overlay.kind === "metadata")
            details = Object.entries(overlay.fields).map(([key, value]) => `${key}: ${value}`);
        else if (overlay.kind === "help")
            details = overlay.bindings.map((binding) => `${binding.keys}  ${binding.action}`);
        else if (overlay.kind === "shared_directory_confirmation")
            details = ["Shared directory warning", `Type exactly: ${overlay.canonicalCwd}`, `> ${this.confirmationText}`];
        else if (overlay.kind === "session_confirmation")
            details = [`Confirm ${overlay.action.toUpperCase()} for ${overlay.sessionId}?`, overlay.submitting ? "Submitting…" : "Press y/Enter to confirm; n/Escape to cancel."];
        else
            details = ["DELIVERY_UNKNOWN", "Choose retry_at_risk or abandon; no automatic retry."];
        const start = Math.max(0, Math.floor((lines.length - details.length) / 2));
        details.forEach((detail, index) => { if (start + index < lines.length)
            lines[start + index] = detail; });
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
