import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";

import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth, } from "@earendil-works/pi-tui";
import { ClearQuitGesture } from "../clear-quit-gesture.mjs";
import { pastedText } from "./dashboard-input.mjs";
import { sessionNameFromPrompt } from "../../runtime/session-name.mjs";
import { SPINNER_INTERVAL_MS } from "../spinner.mjs";
import { countDashboardSessions, selectDashboardSessions, } from "./dashboard-state.mjs";
import { createDashboardLayout, renderColumnHeader, wrapPromptDraft, } from "./dashboard-layout.mjs";
import { JOBWATCH_ANSI, jobwatchTheme } from "./dashboard-theme.mjs";
import { displaySessionState } from "./session-state.mjs";
import { StopClearGesture } from "./stop-clear-gesture.mjs";
import { destructiveAction, createChoiceOverlay, createCommandMenuOverlay, createHelpOverlay, createMetadataOverlay, createPathCompletionOverlay, createSessionConfirmation, createSessionIntent, createSharedDirectoryOverlay, describeOverlay, filterChoiceOverlay, } from "./dashboard-overlays.mjs";
import { draftChoices, parseListCommand } from "./list-commands.mjs";
import { applyCwdCompletion, cwdArgument, suggestDirectories, } from "./path-completion.mjs";
import { deleteBeforePromptCursor, movePromptCursor, normalizePromptCursor, } from "./prompt-cursor.mjs";
import { createLaunchDraft, prepareLaunchRequest, } from "./launch-composer.mjs";
import { probeWorktreeCapability } from "../../isolation/launch-preflight.mjs";
import { VirtualSessionList } from "./virtual-session-list.mjs";
/** A path the operator may launch into: it must exist now and be a directory. @param {string} path */
async function existingDirectory(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch {
        return false;
    }
}
/** Idle time before a typed path is listed. pi-tui lists it synchronously, so no keystroke may start one. */
const COMPLETION_DEBOUNCE_MS = 60;
function defaultQuery() {
    return { view: "live" };
}
const TASK_STATES = ["WORKING", "WAITING", "READY", "FAILED", "STOPPED"];
const PROCESS_STATES = ["LIVE", "SLEEPING", "EXITED", "STALE"];
const OUTCOMES = ["NONE", "COMPLETED", "READY_FOR_REVIEW"];
const SORT_KEYS = ["age", "id", "state", "model", "project", "activity"];
const GROUPS = ["taskState", "cwd"];
function cycleValue(values, current) {
    if (current === undefined)
        return values[0];
    const index = values.indexOf(current);
    return index < 0 || index === values.length - 1 ? undefined : values[index + 1];
}
/** Matches StopClearGesture's default window; the hint must vanish exactly when the gesture does. */
const STOP_CLEAR_WINDOW_MS = 500;
/**
 * The filter, sort, and group controls: the chord that runs one, and what it does.
 * Ctrl+J carries the line-feed byte, which no terminal distinguishes from Enter, so the project
 * filter answers to Ctrl+W instead.
 */
// Summaries are background work: entering or leaving a session must never queue behind one, so the
// refresh waits until the list has been drawn and the operator's first keys have had the socket.
const SUMMARY_REFRESH_DELAY_MS = 750;
const CONTROLS = [
    { key: Key.ctrl("f"), activate: (dashboard) => { dashboard.focus = "search"; } },
    { key: Key.ctrl("v"), activate: (dashboard) => dashboard.cycleView() },
    { key: Key.ctrl("t"), activate: (dashboard) => dashboard.setTaskStates(dashboard.singletonCycle(TASK_STATES, dashboard.query.taskStates)) },
    { key: Key.ctrl("p"), activate: (dashboard) => dashboard.setProcessStates(dashboard.singletonCycle(PROCESS_STATES, dashboard.query.processStates)) },
    { key: Key.ctrl("o"), activate: (dashboard) => dashboard.setOutcomes(dashboard.singletonCycle(OUTCOMES, dashboard.query.outcomes)) },
    { key: Key.ctrl("a"), activate: (dashboard) => dashboard.cycleActivityFilter() },
    { key: Key.ctrl("w"), activate: (dashboard) => dashboard.setProjectPaths(dashboard.singletonCycle([...new Set(dashboard.sessions.map((session) => session.cwd))], dashboard.query.projectPaths)) },
    { key: Key.ctrl("s"), activate: (dashboard) => dashboard.cycleSort() },
    { key: Key.ctrl("b"), activate: (dashboard) => dashboard.setGrouping(cycleValue(GROUPS, dashboard.query.groupBy)) },
];
function fitLine(line, width) {
    const clipped = truncateToWidth(line.replace(/[\r\n\u2028\u2029]/gu, " "), Math.max(0, width), "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
function paintPlainLine(text, width, paint) {
    return paint(fitLine(stripVTControlCharacters(String(text)), width));
}
/**
 * The empty prompt: placeholder text under a dimmed block cursor on its first character, so the
 * caret reads as resting where typing will land rather than as literal text to keep.
 * @param {number} width
 */
function promptPlaceholderLine(width) {
    const placeholder = "describe a task for a new session";
    const painted = `${jobwatchTheme.text(" ❯ ", false)}${jobwatchTheme.placeholderCursor(placeholder.slice(0, 1))}${jobwatchTheme.muted(placeholder.slice(1), false)}`;
    const padding = Math.max(0, width - (3 + placeholder.length));
    return `${painted}${jobwatchTheme.muted(" ".repeat(padding), false)}`;
}
function sectionFooter(width, focused) {
    return paintPlainLine("─".repeat(Math.max(0, width)), width, focused ? jobwatchTheme.focusBorder : jobwatchTheme.text);
}
/**
 * A launch the daemon has not answered yet, shaped like a session record so the list can draw it.
 * It disappears as soon as the daemon replies, replaced by the real record arriving over the subscription.
 * @param {{ sessionId: string, prompt: string, cwd: string, createdAt: string }} pending
 */
function pendingSessionRecord(pending) {
    return {
        schemaVersion: 1, revision: 0,
        sessionId: pending.sessionId, sessionFile: "", canonicalSessionFile: "", cwd: pending.cwd,
        name: sessionNameFromPrompt(pending.prompt),
        taskState: "READY", processState: "EXITED", outcome: "NONE",
        activity: { kind: "launching", summary: pending.prompt, updatedAt: pending.createdAt },
        createdAt: pending.createdAt, updatedAt: pending.createdAt,
    };
}
function sectionBorder(label, width, focused) {
    const prefix = label === "" ? "╭─" : `╭─ ${label} `;
    const line = prefix + "─".repeat(Math.max(0, width - visibleWidth(prefix)));
    return paintPlainLine(line, width, (text) => focused
        ? jobwatchTheme.focusBorder(text, JOBWATCH_ANSI.defaultBackground)
        : jobwatchTheme.inactiveBorder(text, JOBWATCH_ANSI.defaultBackground));
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
    client;
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
    /** How far the daemon's list had advanced when it read the snapshot now on screen. In memory
     * only: it states a snapshot's coverage and is never a position to replay from. */
    coverageCursor;
    pendingShared;
    closed = true;
    preferredSelectionId;
    openGeneration = 0;
    openController;
    confirmationText = "";
    closePromise;
    /** One dirty flag, never a queue: any number of invalidations between reads mean the same read. */
    listChangePending = false;
    /** The read loop draining that flag, while one is running. */
    listReads;
    stopClearGesture;
    clearQuitGesture;
    animationTimer;
    summaryRefreshTimer;
    /** Launches sent but not yet answered, shown as STARTING rows so a prompt never looks lost. */
    pendingLaunches = [];
    stopRetryLimit;
    clearHintTimer;
    query = defaultQuery();
    focus = "list";
    composerDraft;
    composerCursor = 0;
    launchDefaults;
    isDirectory;
    worktreeCapability;
    suggestDirectories;
    /** The `/cwd` path the newest line types, and the last listing that completed for one. */
    cwdCompletionArgument;
    cwdCompletion;
    cwdCompletionIndex = 0;
    cwdCompletionTimer;
    cwdCompletionAbort;
    /** Which command the slash menu highlights, and whether Escape has closed it for this text. */
    commandMenuIndex = 0;
    commandMenuClosed = false;
    /** Pi's own model list, read when a picker first needs it and kept for this dashboard's life. */
    modelCatalog;
    modelCatalogFailure;
    overlay;
    status = { kind: "loading" };
    constructor(options) {
        this.client = options.client;
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
        this.stopRetryLimit = options.stopRetryLimit ?? 8;
        this.stopClearGesture = new StopClearGesture({ now: options.now });
        this.clearQuitGesture = new ClearQuitGesture({ now: options.now });
        this.launchDefaults = options.launchDefaults ?? {};
        this.isDirectory = options.isDirectory ?? existingDirectory;
        this.worktreeCapability = options.worktreeCapability ?? probeWorktreeCapability;
        this.suggestDirectories = options.suggestDirectories ?? suggestDirectories;
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
        // A quit armed before this list was put away cannot travel into the list it comes back as.
        this.clearQuitGesture.cancel();
        this.closePromise = undefined;
        this.listReads = undefined;
        const generation = ++this.openGeneration;
        const controller = new AbortController();
        this.openController = controller;
        this.status = { kind: "loading" };
        try {
            // Subscribe before reading, never after: a change published while the read is in flight
            // then arrives as an invalidation and provokes one refetch, rather than being lost.
            this.listChangePending = true;
            const unsubscribe = await this.client.subscribeListChanges(() => this.noteListChanged(generation), (error) => { if (this.isCurrentOpen(generation))
                this.fail(error); });
            if (!this.isCurrentOpen(generation)) {
                unsubscribe();
                return;
            }
            this.unsubscribe = unsubscribe;
            await this.noteListChanged(generation);
            if (!this.isCurrentOpen(generation))
                return;
            this.status = { kind: "ready" };
            this.requestRender?.();
            this.scheduleSummaryRefresh(generation);
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
            // Selecting elsewhere abandons an armed clear, so Ctrl+X can never remove the wrong session.
            this.stopClearGesture.cancel();
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
    }
    setComposerPrompt(prompt, cursor = prompt.length) {
        this.composerDraft = { ...this.composerDraft, prompt };
        this.composerCursor = normalizePromptCursor(prompt, cursor);
        // Every edit reopens the slash menu: a closed menu belongs to the text the operator escaped from.
        this.commandMenuClosed = false;
        if (!prompt.trim().startsWith("/"))
            this.commandMenuIndex = 0;
        this.scheduleCwdCompletion();
    }
    moveComposerCursor(delta) {
        this.composerCursor = movePromptCursor(this.composerDraft.prompt, this.composerCursor, delta);
        this.requestRender?.();
    }
    insertComposerText(text) {
        const prompt = this.composerDraft.prompt;
        this.setComposerPrompt(`${prompt.slice(0, this.composerCursor)}${text}${prompt.slice(this.composerCursor)}`, this.composerCursor + text.length);
    }
    deleteBeforeComposerCursor() {
        const edited = deleteBeforePromptCursor(this.composerDraft.prompt, this.composerCursor);
        if (edited.text !== this.composerDraft.prompt)
            this.setComposerPrompt(edited.text, edited.cursor);
    }
    /**
     * Ask pi-tui for the directories a `/cwd` line admits. The listing is debounced and runs off the
     * keystroke, and a listing the operator has typed past is abandoned rather than shown.
     */
    scheduleCwdCompletion() {
        const argument = cwdArgument(this.composerDraft.prompt);
        if (argument === this.cwdCompletionArgument)
            return;
        this.cwdCompletionArgument = argument;
        this.cwdCompletion = undefined;
        this.cwdCompletionIndex = 0;
        clearTimeout(this.cwdCompletionTimer);
        this.cwdCompletionTimer = undefined;
        this.cwdCompletionAbort?.abort();
        this.cwdCompletionAbort = undefined;
        if (argument === undefined)
            return;
        // A relative path resolves the way a shell resolves one, against the directory the dashboard
        // was started in, which is exactly what `/cwd` itself will do with the completed line.
        const basePath = process.cwd();
        const abort = new AbortController();
        this.cwdCompletionAbort = abort;
        this.cwdCompletionTimer = setTimeout(() => {
            this.cwdCompletionTimer = undefined;
            void this.readCwdCompletion(argument, basePath, abort.signal);
        }, COMPLETION_DEBOUNCE_MS);
        this.cwdCompletionTimer.unref?.();
    }
    /** @param {string} argument @param {string} basePath @param {AbortSignal} signal */
    async readCwdCompletion(argument, basePath, signal) {
        let suggestions;
        try {
            suggestions = await this.suggestDirectories(argument, basePath, signal);
        }
        catch {
            // Permission denied, a path not created yet, a symbolic-link loop, a directory removed
            // mid-read: the operator has typed a path that cannot be listed, which is not an error row.
        }
        // A listing the operator has typed past names directories that do not exist under the typed path.
        if (argument !== this.cwdCompletionArgument || this.closed || suggestions === undefined)
            return;
        this.cwdCompletion = { argument, ...suggestions };
        this.requestRender?.();
    }
    /** The directories a `/cwd` line still admits, drawn from the last completed listing and never from a new one. */
    pathCompletionOverlay() {
        if (this.focus !== "list" || this.commandMenuClosed)
            return undefined;
        const completion = this.cwdCompletion;
        if (completion === undefined || completion.argument !== cwdArgument(this.composerDraft.prompt))
            return undefined;
        return createPathCompletionOverlay(completion.items, completion.prefix, this.cwdCompletionIndex);
    }
    movePathCompletion(delta) {
        const overlay = this.pathCompletionOverlay();
        if (overlay === undefined)
            return;
        this.cwdCompletionIndex = Math.max(0, Math.min(overlay.index + delta, overlay.items.length - 1));
        this.requestRender?.();
    }
    /**
     * Write the highlighted directory into the typed `/cwd` path. This is the one key that rewrites
     * the operator's text, and it applies only what the last completed listing offered.
     */
    completeCwdPath() {
        const overlay = this.pathCompletionOverlay();
        const item = overlay?.items[overlay.index];
        if (item === undefined)
            return;
        this.setComposerPrompt(applyCwdCompletion(this.composerDraft.prompt, item, overlay.prefix, process.cwd()));
        this.requestRender?.();
    }
    setIsolationMode(isolationMode) {
        this.composerDraft = { ...this.composerDraft, isolationMode };
    }
    /** The commands a slash prompt still admits, or undefined when the operator is not typing one. */
    commandMenuOverlay() {
        const prompt = this.composerDraft.prompt.trim();
        if (this.focus !== "list" || this.commandMenuClosed || !prompt.startsWith("/"))
            return undefined;
        return createCommandMenuOverlay(prompt, this.commandMenuIndex);
    }
    moveCommandMenu(delta) {
        const menu = this.commandMenuOverlay();
        if (menu === undefined || menu.commands.length === 0)
            return;
        this.commandMenuIndex = Math.max(0, Math.min(menu.index + delta, menu.commands.length - 1));
        this.requestRender?.();
    }
    /**
     * Every model the installed Pi will accept. Spawning `pi --list-models` costs a process, so the
     * answer is read once, on the first picker that needs it, and never at startup or per keystroke.
     */
    async catalogModels() {
        try {
            this.modelCatalog ??= Promise.resolve(this.client.getModels());
            const models = await this.modelCatalog;
            this.modelCatalogFailure = undefined;
            return models;
        }
        catch (error) {
            // A failed read is not cached: the next picker asks the daemon again.
            this.modelCatalog = undefined;
            this.modelCatalogFailure = this.typedError(error, "MODEL_CATALOG_UNAVAILABLE");
            return [];
        }
    }
    /** The models a picker can offer, given Pi's catalog if the caller read it. */
    draftChoices(catalog = []) {
        const choices = draftChoices(this.composerDraft, this.sessions, this.launchDefaults, catalog);
        return this.modelCatalogFailure === undefined ? choices : { ...choices, modelsUnavailable: this.modelCatalogFailure };
    }
    /**
     * Run one slash prompt as a dashboard command. It configures the next launch and never reaches
     * a session; a refusal keeps the text so the operator can correct it in place.
     */
    async runListCommand() {
        const menu = this.commandMenuOverlay();
        const highlighted = menu?.commands[menu.index];
        const typed = this.composerDraft.prompt.trim();
        // A bare name the menu has narrowed to one command runs that command, so /mo means /model.
        const text = highlighted !== undefined && !/\s/u.test(typed) ? highlighted.name : typed;
        // Only a bare /model opens a picker over Pi's whole catalog, so only it pays for the read.
        const choices = this.draftChoices(text === "/model" ? await this.catalogModels() : []);
        const parsed = parseListCommand(text, choices);
        if (parsed.kind === "rejected") {
            this.status = { kind: "error", code: parsed.code, message: parsed.message };
            this.requestRender?.();
            return;
        }
        if (parsed.kind === "set_cwd" && !(await this.isDirectory(parsed.path))) {
            this.status = { kind: "error", code: "CWD_NOT_A_DIRECTORY", message: `Not a directory: ${parsed.path}` };
            this.requestRender?.();
            return;
        }
        switch (parsed.kind) {
            case "set_model":
                this.composerDraft = { ...this.composerDraft, model: { ...parsed.model } };
                break;
            case "set_cwd":
                this.composerDraft = { ...this.composerDraft, cwd: parsed.path };
                break;
            case "set_isolation":
                this.composerDraft = { ...this.composerDraft, isolationMode: parsed.isolationMode };
                break;
            case "set_name":
                this.composerDraft = { ...this.composerDraft, name: parsed.name };
                break;
            case "pick_model":
                this.overlay = createChoiceOverlay("model", "Model", choices.models, `${this.composerDraft.model.provider}/${this.composerDraft.model.id}`);
                this.focus = "choice";
                break;
            case "pick_isolation":
                this.overlay = createChoiceOverlay("isolation", "Isolation", ["worktree", "shared_directory"], this.composerDraft.isolationMode);
                this.focus = "choice";
                break;
            case "help":
                this.overlay = createHelpOverlay();
                break;
            case "not_a_command":
                return;
        }
        this.setComposerPrompt("");
        if (this.status.kind === "error")
            this.status = { kind: "ready" };
        this.requestRender?.();
    }
    /** Apply the highlighted value of an open picker to the draft. */
    applyChoice() {
        const overlay = this.overlay;
        if (overlay?.kind !== "choice")
            return;
        const value = overlay.values[overlay.index];
        // A filter that matches nothing leaves the picker open, so the operator can correct it.
        if (value === undefined)
            return;
        if (overlay.field === "model") {
            const separator = value.indexOf("/");
            this.composerDraft = { ...this.composerDraft, model: { provider: value.slice(0, separator), id: value.slice(separator + 1) } };
        }
        else
            this.composerDraft = { ...this.composerDraft, isolationMode: value };
        this.closeChoice();
    }
    moveChoice(delta) {
        const overlay = this.overlay;
        if (overlay?.kind !== "choice")
            return;
        this.overlay = { ...overlay, index: Math.max(0, Math.min(overlay.index + delta, overlay.values.length - 1)) };
        this.requestRender?.();
    }
    /** Retype the open picker's filter. Pi's catalog is too long to reach any row with arrows alone. */
    filterChoice(edit) {
        const overlay = this.overlay;
        if (overlay?.kind !== "choice")
            return;
        this.overlay = filterChoiceOverlay(overlay, edit(overlay.filter ?? ""));
        this.requestRender?.();
    }
    closeChoice() {
        this.overlay = undefined;
        this.focus = "list";
        this.requestRender?.();
    }
    async submitComposer() {
        const submitted = { ...this.composerDraft, model: { ...this.composerDraft.model } };
        const prompt = submitted.prompt;
        if (prompt.trim().length === 0)
            return;
        // A slash prompt configures the next launch. It never starts a session, mistyped or not.
        if (prompt.trim().startsWith("/"))
            return this.runListCommand();
        // Clear the draft on the keystroke that sent it: a prompt still sitting in the box invites a
        // second Enter, which launches the same work twice while the daemon is still starting the first.
        this.composerDraft = { ...this.composerDraft, prompt: "" };
        this.composerCursor = 0;
        // The row goes up on this keystroke, before Git is spawned and before the daemon is asked:
        // those take long enough that an emptied box over an unchanged list reads as a lost prompt.
        const pending = this.addPendingLaunch(submitted.prompt, submitted.cwd);
        this.requestRender?.();
        try {
            // A directory that cannot host a worktree runs the session in itself. The operator chose it
            // and typed the task in it, and after the first session that directory has an owner, so
            // asking him to spell it out again would block every launch but the first.
            const requested = submitted.isolationMode === "worktree" && !(await this.worktreeCapability(submitted.cwd)).available
                ? { ...submitted, isolationMode: "shared_directory" }
                : submitted;
            const preflight = await this.client.preflightLaunch(requested);
            const prepared = prepareLaunchRequest(requested, preflight, requested !== submitted ? preflight.canonicalCwd : undefined);
            if (prepared.kind === "confirmation_required") {
                this.retirePendingLaunch(pending);
                this.pendingShared = { draft: requested, preflight };
                this.confirmationText = "";
                this.focus = "confirmation";
                this.overlay = createSharedDirectoryOverlay(prepared.canonicalCwd, prepared.ownerSessionIds);
                return;
            }
            if (prepared.kind === "ready")
                await this.launch(prepared.request, pending);
            else this.retirePendingLaunch(pending);
        }
        catch (error) {
            this.retirePendingLaunch(pending);
            this.restoreDraft(prompt);
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
    /**
     * Ctrl+X stops a running session. A second press within the gesture window clears it, and a session
     * that is already stopped needs the same two presses, so one keystroke can never remove anything.
     */
    pressStopClear() {
        const selected = this.selectedSession();
        if (selected === undefined)
            return;
        const action = destructiveAction(selected);
        if (action === "stop") {
            void this.confirmSession({ ...createSessionConfirmation(selected), clearingStopped: false });
            return;
        }
        if (this.stopClearGesture.pressWouldClear(selected.sessionId)) {
            void this.confirmSession({ ...createSessionConfirmation(selected), clearingStopped: true });
            return;
        }
        this.armClear(selected);
    }
    /** Arm the clear and repaint once the window lapses, so the hint disappears on its own. */
    armClear(session) {
        this.stopClearGesture.armAfterStop(session.sessionId);
        this.onSessionIntent?.(createSessionIntent(session));
        clearTimeout(this.clearHintTimer);
        this.clearHintTimer = setTimeout(() => this.requestRender?.(), STOP_CLEAR_WINDOW_MS + 1);
        this.clearHintTimer.unref?.();
        this.requestRender?.();
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
        let attemptRequestId = this.requestId();
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
            // A working session's record churns while the request travels, so a revision conflict means
            // "the record moved", not "do not do this". Re-aim at the newest revision and send again.
            let attemptRevision = revision;
            for (let attempt = 1; ; attempt += 1) {
                try {
                    await this.client[action](sessionId, attemptRevision, attemptRequestId);
                    break;
                }
                catch (error) {
                    if (error?.code !== "REVISION_CONFLICT" || attempt >= this.stopRetryLimit)
                        throw error;
                    // The cached list can be many revisions behind, so ask the daemon rather than
                    // retrying against a copy that will conflict forever.
                    const snapshot = await this.client.getState().catch(() => undefined);
                    if (snapshot !== undefined)
                        this.applySnapshot(snapshot);
                    const current = this.sessions.find((candidate) => candidate.sessionId === sessionId);
                    if (current === undefined || destructiveAction(current) !== action)
                        throw error;
                    attemptRevision = current.revision;
                    attemptRequestId = this.requestId();
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
            }
            // Arm only after the stop landed, so a single press can never remove a running session.
            if (action === "stop") {
                const stopped = this.sessions.find((candidate) => candidate.sessionId === sessionId);
                if (stopped !== undefined)
                    this.armClear(stopped);
            }
            if (this.status.kind === "pending" && this.status.code === `${action.toUpperCase()}_SENT`)
                this.status = { kind: "ready" };
        }
        catch (error) {
            // An ambiguous destructive command is one error line, not a question. Nothing durable
            // records it any more and nothing may retry it: the row's revision and process state are
            // where the operator reads what happened.
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
        // Any key other than a second Ctrl+X abandons an armed clear, so the red warning cannot linger
        // and a later keystroke cannot inherit it.
        if (this.stopClearArmed && !matchesKey(data, Key.ctrl("x"))) {
            this.stopClearGesture.cancel();
            this.requestRender?.();
        }
        // Pi's Ctrl+C: the first press empties the prompt and leaves the list standing, and only a
        // second press inside the window quits. Quitting is this frontend leaving: no session is
        // stopped, cleared, or asked for anything.
        if (matchesKey(data, Key.ctrl("c"))) {
            if (this.clearQuitGesture.press() === "quit") {
                void this.close();
                return;
            }
            this.setComposerPrompt("");
            this.requestRender?.();
            return;
        }
        if (this.focus === "confirmation") {
            if (matchesKey(data, Key.escape)) {
                const pending = this.pendingShared;
                this.focus = "list";
                this.pendingShared = undefined;
                this.confirmationText = "";
                this.overlay = undefined;
                if (pending !== undefined)
                    this.restoreDraft(pending.draft.prompt);
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
        if (this.focus === "choice") {
            if (matchesKey(data, Key.escape))
                this.closeChoice();
            else if (matchesKey(data, Key.enter))
                this.applyChoice();
            else if (matchesKey(data, Key.up))
                this.moveChoice(-1);
            else if (matchesKey(data, Key.down))
                this.moveChoice(1);
            else if (matchesKey(data, Key.pageDown))
                this.moveChoice(Math.max(1, this.listHeight() - 1));
            else if (matchesKey(data, Key.pageUp))
                this.moveChoice(-Math.max(1, this.listHeight() - 1));
            else if (matchesKey(data, Key.backspace))
                this.filterChoice((filter) => filter.slice(0, -1));
            else {
                const printable = this.printable(data);
                if (printable !== undefined)
                    this.filterChoice((filter) => filter + printable);
            }
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
        if (matchesKey(data, Key.backspace)) {
            this.deleteBeforeComposerCursor();
            return;
        }
        // Escape closes the slash menu without touching the text, so a mistyped command stays editable.
        if (matchesKey(data, Key.escape)) {
            if (this.commandMenuOverlay() !== undefined) {
                this.commandMenuClosed = true;
                this.requestRender?.();
            }
            return;
        }
        if (matchesKey(data, Key.left)) {
            if (this.composerDraft.prompt !== "")
                this.moveComposerCursor(-1);
            return;
        }
        // Tab used to move a launch-field cursor that typing ignored and Backspace obeyed. It now
        // completes a `/cwd` directory and types nothing anywhere else; a tab inside a paste still
        // arrives as text and becomes a space.
        if (matchesKey(data, Key.tab)) {
            this.completeCwdPath();
            return;
        }
        if (matchesKey(data, "shift+tab")) return;
        if ((matchesKey(data, Key.up) || matchesKey(data, Key.down)) && this.pathCompletionOverlay() !== undefined) {
            this.movePathCompletion(matchesKey(data, Key.up) ? -1 : 1);
            return;
        }
        if ((matchesKey(data, Key.up) || matchesKey(data, Key.down)) && this.commandMenuOverlay() !== undefined) {
            this.moveCommandMenu(matchesKey(data, Key.up) ? -1 : 1);
            return;
        }
        if (matchesKey(data, Key.ctrl("x"))) {
            this.pressStopClear();
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
            if (this.composerDraft.prompt !== "")
                this.moveComposerCursor(1);
            else
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
        else if (data === "?" && this.composerDraft.prompt === "")
            this.toggleHelp();
        else if (matchesKey(data, Key.ctrl("r")))
            this.refreshSummaries();
        else if (matchesKey(data, Key.ctrl("l")))
            this.clearFilters();
        else {
            // Typed and pasted text always composes a prompt, wherever the cursor sits in the list.
            const printable = this.printable(data);
            if (printable !== undefined)
                this.insertComposerText(printable);
        }
    }
    /**
     * Wheel notches and plain left clicks both arrive here: the terminal tap in app/mouse-input.mjs
     * reports them and passes every other mouse report through to pi-tui's own selection handling.
     * A click reaches whatever the layout drew under it, and nothing where the layout drew nothing.
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
        const layout = this.layout();
        const clicked = Math.floor(event.row);
        // The prompt is the block under the dock's opening rule; everything else above the list
        // (title, context, launch settings, border, column header) and below it is read-only.
        const dockTop = this.height - layout.dockRows;
        if (this.height >= 4 && clicked > dockTop && clicked <= dockTop + layout.promptRows) {
            this.focusComposer();
            return;
        }
        if (clicked < layout.listTop || clicked >= layout.listTop + layout.listHeight)
            return;
        const index = this.viewportOffset + clicked - layout.listTop;
        const row = this.list.rows[index];
        if (row?.kind !== "session")
            return;
        // First click selects, a second on the same row opens it, so the mouse alone can reach a session.
        if (this.list.selectedSessionId === row.session.sessionId)
            void this.activateSelection();
        else
            this.selectSession(row.session.sessionId);
    }
    render(width = this.width, height = this.height) {
        try {
            this.resize(width, height);
            // Rows cache their rendered line; without a fresh reading the spinner frame and age never move.
            this.list.setNow(this.now());
            const layout = this.layout();
            // The dock takes the focus border only while it waits for the typed shared-directory path.
            const confirmingSharedLaunch = this.focus === "confirmation";
            const lines = Array.from({ length: this.height }, () => "");
            if (lines.length > 0)
                lines[0] = paintPlainLine(" pi-agents", this.width, jobwatchTheme.title);
            // One launch setting per row, above the list, so each is readable without truncation.
            if (layout.listTop >= 4) {
                for (const [offset, [label, value]] of this.launchSettingRows().entries())
                    lines[1 + offset] = paintPlainLine(`   ${label}: ${value}`, this.width, jobwatchTheme.surface);
            }
            // The section border and column header always sit immediately above the first row.
            if (lines.length > layout.listTop - 2 && layout.listTop >= 2)
                lines[layout.listTop - 2] = sectionBorder("Sessions", this.width, !confirmingSharedLaunch);
            if (lines.length > layout.listTop - 1 && layout.listTop >= 1)
                lines[layout.listTop - 1] = renderColumnHeader(layout);
            const rendered = this.list.renderViewport({ offset: this.viewportOffset, height: layout.listHeight, width: this.width });
            for (let index = 0; index < rendered.length; index += 1) {
                const target = layout.listTop + index;
                if (target < lines.length)
                    lines[target] = rendered[index].line;
            }
            if (lines.length >= 4) {
                const dockTop = lines.length - layout.dockRows;
                const draftPrompt = this.composerDraft.prompt;
                // Flat rules above and below the prompt: a rounded top with a flat bottom read as a broken box.
                lines[dockTop] = sectionFooter(this.width, confirmingSharedLaunch);
                if (draftPrompt === "")
                    lines[dockTop + 1] = promptPlaceholderLine(this.width);
                else {
                    const wrapped = wrapPromptDraft(draftPrompt, this.width, this.composerCursor);
                    const cursorRow = wrapped.findIndex((row) => row.includes(JOBWATCH_ANSI.inverse));
                    const firstVisible = cursorRow < 0
                        ? Math.max(0, wrapped.length - layout.promptRows)
                        : Math.min(Math.max(0, cursorRow - layout.promptRows + 1), Math.max(0, wrapped.length - layout.promptRows));
                    wrapped.slice(firstVisible, firstVisible + layout.promptRows).forEach((row, index) => {
                        lines[dockTop + 1 + index] = jobwatchTheme.text(fitLine(row, this.width), false);
                    });
                }
                const promptBottom = dockTop + layout.promptRows;
                const form = layout.listTop >= 4 ? this.draftModelSummary() : ` cwd:${this.composerDraft.cwd} isolation:${this.composerDraft.isolationMode} model:${this.composerDraft.model.provider}/${this.composerDraft.model.id} name:${this.composerDraft.name}`;
                // The rule closes the prompt box; launch settings and the selected path are context below it.
                const formRow = layout.dockRows >= 4 ? promptBottom + 2 : promptBottom + 1;
                if (layout.dockRows >= 4) lines[promptBottom + 1] = sectionFooter(this.width, confirmingSharedLaunch);
                // An armed clear is the one thing on this row worth interrupting for, and it expires on its own.
                lines[formRow] = this.stopClearArmed
                    ? paintPlainLine(" ctrl+x to confirm", this.width, jobwatchTheme.error)
                    : paintPlainLine(this.status.kind === "error" ? ` ${this.status.code}: ${this.status.message}  ${form}` : form, this.width, this.status.kind === "error" ? jobwatchTheme.error : jobwatchTheme.surface);
                // Which session the list is pointing at, read last: it describes the selection, not the launch.
                if (formRow + 1 < lines.length)
                    lines[formRow + 1] = paintPlainLine(this.contextLine(), this.width, jobwatchTheme.keyHints);

            }
            this.renderOverlay(lines);
            this.syncAnimation();
            return lines.map((line) => fitLine(line, this.width));
        }
        catch (error) {
            const typed = this.typedError(error, "RENDER_FAILED");
            this.fail(typed);
            throw Object.assign(new Error(typed.message), { code: typed.code });
        }
    }
    setQuery(query) {
        this.query = query;
        this.rebuildList();
    }
    applySnapshot(snapshot) {
        this.sessions = snapshot.sessions;
        this.rebuildList();
        // An armed clear belongs to the session as it was: if it came back to life, the next press stops it.
        const armedSession = this.sessions.find((session) => this.stopClearGesture.armedFor(session.sessionId));
        if (armedSession !== undefined && destructiveAction(armedSession) === "stop")
            this.stopClearGesture.cancel();
    }
    /** Put a failed launch's text back so the operator does not retype it. */
    restoreDraft(prompt) {
        if (this.composerDraft.prompt.trim() === "")
            this.setComposerPrompt(prompt);
    }
    rebuildList() {
        const selected = this.preferredSelectionId ?? this.list.selectedSessionId;
        // The daemon publishes a launching session before it answers the launch call, so retire any
        // placeholder the real record has already replaced. Otherwise a row sits at STARTING forever
        // beside the session it stands for.
        // Match on creation time, not name: the summary pass renames a session minutes later.
        this.pendingLaunches = this.pendingLaunches.filter((entry) => !this.sessions.some((session) => session.createdAt >= entry.createdAt));
        const visible = [...selectDashboardSessions(this.sessions, this.query), ...this.pendingLaunches.map((entry) => pendingSessionRecord(entry))];
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
    }
    selectBoundary(last) {
        const rows = last ? [...this.list.rows].reverse() : this.list.rows;
        const row = rows.find((candidate) => candidate.kind === "session");
        if (row?.kind === "session")
            this.selectSession(row.session.sessionId);
    }
    /** The current layout, with the dock sized to the rows the draft wraps into. */
    layout() {
        return createDashboardLayout(this.width, this.height, { promptRows: wrapPromptDraft(this.composerDraft.prompt, this.width, this.composerDraft.prompt === "" ? undefined : this.composerCursor).length });
    }
    listHeight() {
        return this.layout().listHeight;
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
    /** The next session's settings, one per row: label and current value. */
    launchSettingRows() {
        // Only the working directory earns a row: the MODEL column reports each session's own model,
        // and the rest are set through the slash menu when they matter.
        return [["cwd", this.composerDraft.cwd]];
    }
    /**
     * The model the next launch will ask for, named only when the draft carries one. A draft
     * outlives the dashboard that wrote it, and a model Pi refuses fails the launch itself, so the
     * value that will be sent has to be readable without opening a picker to find it.
     */
    draftModelSummary() {
        const { provider, id } = this.composerDraft.model;
        return provider === "" && id === "" ? "" : ` model:${provider}/${id}`;
    }
    /** The selected session's working directory, plus any active filters. */
    contextLine() {
        const selected = this.selectedSession();
        const filters = this.activeFilterSummary().trim();
        // Name the selected agent, not its worktree: an isolated session's cwd is a bare UUID that
        // tells the operator nothing about which row the line describes.
        const subject = selected === undefined ? "" : (selected.name ?? "").trim() === "" ? selected.sessionId.slice(0, 8) : `${selected.name}`;
        if (subject === "" && filters === "")
            return "";
        return ` ${[subject, filters].filter((segment) => segment !== "").join("  ·  ")}`;
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
    printable(data) {
        return decodeKittyPrintable(data) ?? pastedText(data);
    }
    /** Ask for summaries once the list is interactive, so open never waits on background work. */
    scheduleSummaryRefresh(generation) {
        clearTimeout(this.summaryRefreshTimer);
        this.summaryRefreshTimer = setTimeout(() => {
            this.summaryRefreshTimer = undefined;
            if (this.isCurrentOpen(generation))
                this.refreshSummaries();
        }, SUMMARY_REFRESH_DELAY_MS);
        this.summaryRefreshTimer.unref?.();
    }
    /** Ask the daemon for opt-in Activity summaries; absence of a summary model is not an error. */
    refreshSummaries() {
        void Promise.resolve(this.client.refreshSummaries()).catch(() => { });
    }
    /** Put a STARTING row up for a launch that has not been sent yet. @param {string} prompt @param {string} cwd */
    addPendingLaunch(prompt, cwd) {
        const pending = { sessionId: `pending:${this.requestId()}`, prompt, cwd, createdAt: new Date(this.now()).toISOString() };
        this.pendingLaunches = [...this.pendingLaunches, pending];
        this.rebuildList();
        return pending;
    }
    /** @param {any} pending */
    retirePendingLaunch(pending) {
        this.pendingLaunches = this.pendingLaunches.filter((entry) => entry !== pending);
        this.rebuildList();
        this.requestRender?.();
    }
    /** @param {any} request @param {any} [placeholder] */
    async launch(request, placeholder) {
        // Show the list before the daemon answers: startup takes seconds and the session row arrives by subscription.
        this.focus = "list";
        this.status = { kind: "ready" };
        const pending = placeholder ?? this.addPendingLaunch(request.prompt, request.cwd);
        this.requestRender?.();
        let failure;
        try {
            await this.client.launch(request, this.requestId());
        }
        catch (error) {
            // A refusal and a transport failure cost the operator the same thing: his text and the
            // session it was for. One path hands the prompt back, because `confirmSharedLaunch` is
            // invoked from a keystroke with `void` and anything raised past here vanished with the draft.
            failure = this.typedError(error, "LAUNCH_FAILED");
        }
        if (failure === undefined) {
            // The answer says the daemon accepted the launch, not that its row has been published, and
            // those arrive on the subscription. Retiring the placeholder here left the operator with an
            // empty list and an empty box, which reads exactly like a prompt that was dropped.
            // `rebuildList` retires it against the record the daemon publishes.
            this.requestRender?.();
            return;
        }
        this.retirePendingLaunch(pending);
        this.restoreDraft(request.prompt);
        this.status = { kind: "error", code: failure.code, message: failure.message };
        this.requestRender?.();
    }
    renderOverlay(lines) {
        // A `/cwd` path being completed outranks the one command-menu row it would otherwise show.
        const overlay = this.overlay ?? this.pathCompletionOverlay() ?? this.commandMenuOverlay();
        if (overlay === undefined || lines.length === 0)
            return;
        const layout = this.layout();
        // Commands and their values read like Pi's own completion list: flush above the prompt, no frame.
        if (overlay.kind === "command_menu" || overlay.kind === "choice" || overlay.kind === "path_completion") {
            this.renderInlineMenu(lines, overlay, layout);
            return;
        }
        const described = describeOverlay(overlay, { confirmationText: this.confirmationText, choiceRows: Math.max(1, layout.listHeight - 2) });
        const areaTop = Math.min(layout.listTop, Math.max(0, lines.length - 1));
        // A short terminal leaves no list rows; the panel then borrows the space below it rather than covering the header.
        const areaHeight = Math.max(1, Math.min(Math.max(layout.listHeight, described.rows.length + 2), Math.max(1, lines.length - areaTop)));
        const panel = renderOverlayPanel(described, this.width, areaHeight);
        const start = areaTop + Math.max(0, Math.floor((areaHeight - panel.length) / 2));
        panel.forEach((line, index) => { if (start + index < lines.length)
            lines[start + index] = line; });
    }
    /** Draw a completion list in the rows directly above the prompt, newest entry nearest the prompt. */
    renderInlineMenu(lines, overlay, layout) {
        // Two rows short of the list area, leaving room for the count-and-filter header and the key hint.
        const described = describeOverlay(overlay, { confirmationText: this.confirmationText, choiceRows: Math.max(1, layout.listHeight - 2), completionRows: Math.max(1, layout.listHeight - 2) });
        // A picker over Pi's whole catalog needs its own header: the prompt that opened it is cleared,
        // so the count and the typed filter have nowhere else to appear.
        const describedRows = overlay.kind === "choice" ? [{ text: described.title, emphasis: true }, ...described.rows] : described.rows;
        const dockTop = lines.length - layout.dockRows;
        const rows = describedRows.slice(0, Math.max(0, Math.min(describedRows.length, dockTop - layout.listTop)));
        const start = Math.max(layout.listTop, dockTop - rows.length);
        rows.forEach((row, index) => {
            const text = typeof row === "string" ? row : String(row.text ?? "");
            const selected = text.trimStart().startsWith("❯");
            if (start + index < lines.length)
                lines[start + index] = paintPlainLine(` ${text}`, this.width, selected ? jobwatchTheme.focusBorder : jobwatchTheme.muted);
        });
    }
    /**
     * Record that the list changed and make sure exactly one read loop is draining that fact.
     * Returns the loop, so a caller that needs the list current can wait for it.
     * @param {number} generation
     */
    noteListChanged(generation) {
        this.listChangePending = true;
        if (this.listReads !== undefined)
            return this.listReads;
        // Start the loop one microtask later so `listReads` is installed before its first read runs.
        // Started inline, a notification raised during that read saw no loop and began a second one,
        // and the two interleaved reads applied each other's stale rows.
        const reads = Promise.resolve().then(() => this.readCurrentList(generation)).finally(() => { this.listReads = undefined; });
        this.listReads = reads;
        // The subscription's callback does not await this loop, so its failure is reported through
        // fail() rather than left as an unhandled rejection.
        void reads.catch(() => { });
        return reads;
    }
    /** Read current rows until no invalidation arrived during the last read. @param {number} generation */
    async readCurrentList(generation) {
        try {
            while (this.listChangePending) {
                if (!this.isCurrentOpen(generation))
                    throw Object.assign(new Error("Dashboard is closed"), { code: "DASHBOARD_CLOSED" });
                this.listChangePending = false;
                const snapshot = await this.client.getState();
                if (!this.isCurrentOpen(generation))
                    throw Object.assign(new Error("Dashboard is closed"), { code: "DASHBOARD_CLOSED" });
                this.applySnapshot(snapshot);
                this.coverageCursor = snapshot.cursor;
                this.requestRender?.();
            }
        }
        catch (error) {
            const typed = this.typedError(error, "LIST_READ_FAILED");
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
    beginClose(initialError) {
        if (this.closePromise !== undefined)
            return this.closePromise;
        this.stopAnimation();
        clearTimeout(this.summaryRefreshTimer);
        this.summaryRefreshTimer = undefined;
        clearTimeout(this.cwdCompletionTimer);
        this.cwdCompletionTimer = undefined;
        this.cwdCompletionAbort?.abort();
        this.cwdCompletionAbort = undefined;
        this.closed = true;
        this.openGeneration += 1;
        this.openController?.abort();
        this.openController = undefined;
        const unsubscribe = this.unsubscribe;
        this.unsubscribe = undefined;
        unsubscribe?.();
        this.overlay = undefined;
        this.pendingShared = undefined;
        this.confirmationText = "";
        this.closePromise = this.finishClose(initialError);
        return this.closePromise;
    }
    async finishClose(initialError) {
        let error = initialError;
        await Promise.allSettled([this.listReads]);
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
