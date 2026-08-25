import { randomUUID } from "node:crypto";

import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type {
  AttachmentRole,
  CommandStatus,
  DeliveryResolution,
  EventCursor,
  LaunchRequest,
  Outcome,
  PersistedEvent,
  ProcessState,
  SessionRecord,
  TaskState,
} from "../../shared/contracts.js";
import {
  countDashboardSessions,
  selectDashboardSessions,
  type DashboardGroup,
  type DashboardQuery,
  type DashboardSortKey,
  type SortDirection,
} from "./dashboard-state.js";
import {
  createDashboardLayout,
  renderColumnHeader,
} from "./dashboard-layout.js";
import type { DaemonClient } from "./daemon-client.js";
import {
  confirmationMatchesSession,
  createDeliveryUnknownOverlay,
  createHelpOverlay,
  createMetadataOverlay,
  createSessionConfirmation,
  createSessionIntent,
  createSharedDirectoryOverlay,
  type DashboardOverlay,
  type SessionConfirmation,
  type SessionIntent,
} from "./dashboard-overlays.js";
import {
  createLaunchDraft,
  prepareLaunchRequest,
  type LaunchDefaults,
  type LaunchDraft,
  type LaunchIsolationMode,
  type LaunchPreflight,
} from "./launch-composer.js";
import { VirtualSessionList } from "./virtual-session-list.js";

export interface DashboardSnapshot {
  sessions: readonly SessionRecord[];
}

export interface DashboardUpdate {
  snapshot: DashboardSnapshot;
  cursor: EventCursor;
  event?: PersistedEvent;
}

export interface DashboardTransportError {
  code: string;
  message: string;
}

export type LaunchOutcome =
  | { kind: "launched"; sessionId: string }
  | { kind: "delivery_unknown"; clientId: string; requestId: string }
  | { kind: "rejected"; error: DashboardTransportError };

export interface DashboardBackend {
  getSnapshot(signal?: AbortSignal): Promise<DashboardSnapshot>;
  subscribe(
    after: EventCursor | undefined,
    listener: (update: DashboardUpdate) => Promise<void> | void,
    onError: (error: DashboardTransportError) => void,
  ): (() => void) | Promise<() => void>;
  preflightLaunch(draft: LaunchDraft, signal?: AbortSignal): Promise<LaunchPreflight>;
  launch(request: LaunchRequest, requestId?: string, signal?: AbortSignal): Promise<LaunchOutcome>;
  resolveDelivery(clientId: string, requestId: string, resolution: DeliveryResolution, signal?: AbortSignal): Promise<void>;
  stop(sessionId: string, revision: number, requestId: string, signal?: AbortSignal): Promise<void>;
  delete(sessionId: string, revision: number, requestId: string, signal?: AbortSignal): Promise<void>;
}

export interface PersistedDashboardState {
  schemaVersion: 1;
  clientId: string;
  cursor?: EventCursor;
  viewState?: {
    query: Omit<DashboardQuery, "historyPolicy">;
    selectedSessionId?: string;
  };
  launchDraft?: Omit<LaunchDraft, "sourceSessionId">;
}

export interface DashboardPersistence {
  load(): Promise<PersistedDashboardState | undefined>;
  save(state: PersistedDashboardState): Promise<void>;
}

export type NativeAttachResult =
  | {
      kind: "attached";
      role: AttachmentRole;
      controls: {
        left: "detach_to_dashboard";
        escape: "detach_to_dashboard";
        ctrlC: "native_pi";
      };
    }
  | { kind: "unsupported"; error: DashboardTransportError }
  | { kind: "failed"; error: DashboardTransportError };

export type NativeDetachResult =
  | { kind: "detached" }
  | { kind: "unsupported"; error: DashboardTransportError }
  | { kind: "failed"; error: DashboardTransportError };

/** Task 14 implements this seam with Pi's native interface. */
export interface NativeAttachSeam {
  attach(request: { sessionId: string; selectedRevision: number }): Promise<NativeAttachResult>;
  detach(request: { sessionId: string }): Promise<NativeDetachResult>;
}

export type DashboardStatus =
  | { kind: "ready" }
  | { kind: "loading" }
  | { kind: "error"; code: string; message: string }
  | { kind: "observer"; message: string };

export type DashboardCloseResult =
  | { kind: "closed" }
  | { kind: "error"; code: string; message: string };

interface DaemonBackendOptions {
  client: DaemonClient;
  clientId: string;
  preflight(draft: LaunchDraft, signal?: AbortSignal): Promise<LaunchPreflight>;
  requestId?: () => string;
}

function cursorAfter(left: EventCursor | undefined, right: EventCursor): boolean {
  if (left === undefined || left.daemonEpoch !== right.daemonEpoch) return true;
  return BigInt(right.sequence) > BigInt(left.sequence);
}

function daemonFailure(response: Extract<Awaited<ReturnType<DaemonClient["request"]>>, { ok: false }>): DashboardTransportError {
  return { code: response.error.code, message: response.error.message };
}

/** Adapt the Task 11 reconnecting client into snapshots with process-then-ack replay. */
export function createDaemonDashboardBackend({
  client,
  clientId,
  preflight,
  requestId = randomUUID,
}: DaemonBackendOptions): DashboardBackend {
  const sessions = new Map<string, SessionRecord>();

  const request = async (op: Parameters<DaemonClient["request"]>[0]["op"], payload: object, exactRequestId = requestId()) => {
    return client.request({ version: 1, clientId, requestId: exactRequestId, op, payload } as Parameters<DaemonClient["request"]>[0]);
  };

  const refreshState = async () => {
    const response = await request("get_state", {});
    if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    if (response.result.kind !== "state") throw Object.assign(new Error("Daemon returned the wrong state result"), { code: "INVALID_RESPONSE" });
    sessions.clear();
    for (const session of response.result.sessions) sessions.set(session.sessionId, session);
    return { sessions: [...sessions.values()] };
  };

  const requireCompletedDestructive = (operation: "stop" | "delete", response: Awaited<ReturnType<typeof request>>) => {
    if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    if (response.result.kind !== "command") throw Object.assign(new Error(`Daemon returned the wrong ${operation} result`), { code: "INVALID_RESPONSE" });
    if (response.result.status.stage === "DELIVERY_UNKNOWN") {
      throw Object.assign(new Error(`${operation === "stop" ? "Stop" : "Delete"} delivery is ambiguous`), { code: "DELIVERY_UNKNOWN", clientId: response.result.status.clientId, requestId: response.result.status.requestId });
    }
    if (response.result.status.stage === "FAILED") {
      const error = response.result.status.error ?? { code: "COMMAND_FAILED", message: `${operation} failed`, retryable: false };
      throw Object.assign(new Error(error.message), error);
    }
    if (response.result.status.stage !== "COMPLETED") throw Object.assign(new Error(`${operation} ended in ${response.result.status.stage}`), { code: response.result.status.stage });
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
        if (active) onError({ code: error.code, message: error.message });
      });
      const iterator = client.subscribe(after)[Symbol.asyncIterator]();
      void (async () => {
        try {
          while (active) {
            const next = await iterator.next();
            if (next.done || !active) return;
            const event = next.value;
            if (!cursorAfter(acknowledged, event.cursor)) continue;
            let snapshot = { sessions: [...sessions.values()] };
            if (event.kind === "session_changed") {
              sessions.set(event.payload.session.sessionId, event.payload.session);
              snapshot = { sessions: [...sessions.values()] };
            } else if (event.kind === "command_changed" && event.payload.status.operation === "delete" && event.payload.status.stage === "COMPLETED") {
              snapshot = await refreshState();
            }
            await listener({ snapshot, cursor: event.cursor, event });
            const response = await request("ack", { cursor: event.cursor });
            if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
            if (response.result.kind !== "acknowledged") throw Object.assign(new Error("Daemon returned the wrong acknowledgement result"), { code: "INVALID_RESPONSE" });
            acknowledged = response.result.cursor;
          }
        } catch (error) {
          if (!active) return;
          const typed = error as { code?: string; message?: string };
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
      if (!response.ok) return { kind: "rejected", error: daemonFailure(response) };
      if (response.result.kind === "launched") return { kind: "launched", sessionId: response.result.sessionId };
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
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    },
    async stop(sessionId, revision, exactRequestId) {
      requireCompletedDestructive("stop", await request("stop", { sessionId, revision }, exactRequestId));
    },
    async delete(sessionId, revision, exactRequestId) {
      requireCompletedDestructive("delete", await request("delete", { sessionId, revision }, exactRequestId));
    },
  };
}

export interface DashboardControllerOptions {
  backend: DashboardBackend;
  persistence: DashboardPersistence;
  nativeAttach: NativeAttachSeam;
  clientId: string;
  sourceSessionId: string;
  launchDefaults: Omit<LaunchDefaults, "sourceSessionId">;
  requestId?: () => string;
  onClose?: (result: DashboardCloseResult) => void;
  onSessionIntent?: (intent: SessionIntent) => void;
  requestRender?: () => void;
}

function defaultQuery(): DashboardQuery {
  return { view: "live" };
}

function safeQuery(value: Omit<DashboardQuery, "historyPolicy"> | undefined): DashboardQuery {
  if (value === undefined || !["live", "done", "all"].includes(value.view)) return defaultQuery();
  return { ...value };
}

const TASK_STATES: readonly TaskState[] = ["WORKING", "WAITING", "READY", "FAILED", "STOPPED"];
const PROCESS_STATES: readonly ProcessState[] = ["LIVE", "SLEEPING", "EXITED", "STALE"];
const OUTCOMES: readonly Outcome[] = ["NONE", "COMPLETED", "READY_FOR_REVIEW"];
const SORT_KEYS: readonly DashboardSortKey[] = ["age", "id", "state", "model", "project", "activity"];
const GROUPS: readonly DashboardGroup[] = ["taskState", "cwd"];
export type ComposerField = "prompt" | "cwd" | "isolationMode" | "modelProvider" | "modelId" | "thinkingLevel" | "name";
const COMPOSER_FIELDS: readonly ComposerField[] = ["prompt", "cwd", "isolationMode", "modelProvider", "modelId", "thinkingLevel", "name"];

function cycleValue<T>(values: readonly T[], current: T | undefined): T | undefined {
  if (current === undefined) return values[0];
  const index = values.indexOf(current);
  return index < 0 || index === values.length - 1 ? undefined : values[index + 1];
}

function fitLine(line: string, width: number): string {
  const clipped = truncateToWidth(line.replace(/[\r\n\u2028\u2029]/gu, " "), Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Own dashboard subscription, focus, selection, launch, rendering, and disposal. */
export class DashboardController {
  private readonly backend: DashboardBackend;
  private readonly persistence: DashboardPersistence;
  private readonly nativeAttach: NativeAttachSeam;
  private readonly clientId: string;
  private readonly sourceSessionId: string;
  private readonly requestId: () => string;
  private readonly onClose?: (result: DashboardCloseResult) => void;
  private readonly onSessionIntent?: (intent: SessionIntent) => void;
  private readonly requestRender?: () => void;
  private unsubscribe?: () => void;
  private sessions: readonly SessionRecord[] = [];
  private list = new VirtualSessionList([]);
  private width = 80;
  private height = 24;
  private viewportOffset = 0;
  private cursor?: EventCursor;
  private pendingShared?: { draft: LaunchDraft; preflight: LaunchPreflight };
  private closed = true;
  private preferredSelectionId?: string;
  private openGeneration = 0;
  private openController?: AbortController;
  private attachedSessionId?: string;
  private confirmationText = "";
  private closePromise?: Promise<void>;
  private readonly eventOperations = new Set<Promise<void>>();
  private eventTail: Promise<void> = Promise.resolve();
  private saveTail: Promise<void> = Promise.resolve();
  private saveFailure?: unknown;
  private saveAdmissionGeneration = 0;
  private renderRequestGeneration = 0;
  private readonly renderWaiters = new Map<number, { resolve(): void; reject(error: unknown): void }>();

  query: DashboardQuery = defaultQuery();
  focus: "list" | "search" | "composer" | "confirmation" = "list";
  composerField: ComposerField = "prompt";
  composerDraft: LaunchDraft;
  overlay?: DashboardOverlay;
  status: DashboardStatus = { kind: "loading" };
  attachmentRole?: AttachmentRole;

  constructor(options: DashboardControllerOptions) {
    this.backend = options.backend;
    this.persistence = options.persistence;
    this.nativeAttach = options.nativeAttach;
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

  get selectedSessionId(): string | undefined {
    return this.list.selectedSessionId;
  }

  async open(): Promise<void> {
    if (!this.closed) return;
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
      if (!this.isCurrentOpen(generation)) return;
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
      if (!this.isCurrentOpen(generation)) return;
      this.applySnapshot(snapshot);
      const unsubscribe = await this.backend.subscribe(
        this.cursor,
        (update) => this.trackEvent(update, generation),
        (error) => { if (this.isCurrentOpen(generation)) this.fail(error); },
      );
      if (!this.isCurrentOpen(generation)) {
        unsubscribe();
        return;
      }
      this.unsubscribe = unsubscribe;
      this.status = { kind: "ready" };
      this.requestRender?.();
    } catch (error) {
      if (!this.isCurrentOpen(generation)) return;
      this.fail(this.typedError(error, "DASHBOARD_OPEN_FAILED"));
    }
  }

  close(): Promise<void> {
    return this.beginClose();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    this.ensureSelectionVisible();
  }

  selectSession(sessionId: string): boolean {
    this.preferredSelectionId = sessionId;
    const selected = this.list.selectSession(sessionId);
    this.ensureSelectionVisible();
    if (selected) {
      this.invalidateSessionConfirmation();
      this.scheduleUiSave();
    }
    return selected;
  }

  setSearch(search?: string): void {
    this.setQuery({ ...this.query, search: search?.trim() === "" ? undefined : search });
  }

  setTaskStates(taskStates?: readonly TaskState[]): void {
    this.setQuery({ ...this.query, taskStates });
  }

  setProcessStates(processStates?: readonly ProcessState[]): void {
    this.setQuery({ ...this.query, processStates });
  }

  setOutcomes(outcomes?: readonly Outcome[]): void {
    this.setQuery({ ...this.query, outcomes });
  }

  setActivityKinds(activityKinds?: readonly string[]): void {
    this.setQuery({ ...this.query, activityKinds });
  }

  setProjectPaths(projectPaths?: readonly string[]): void {
    this.setQuery({ ...this.query, projectPaths });
  }

  setGrouping(groupBy?: DashboardGroup): void {
    this.setQuery({ ...this.query, groupBy });
  }

  setSort(key: DashboardSortKey, direction: SortDirection): void {
    this.setQuery({ ...this.query, sort: { key, direction } });
  }

  setView(view: DashboardQuery["view"]): void {
    this.setQuery({ ...this.query, view });
  }

  clearFilters(): void {
    this.setQuery({ view: this.query.view, sort: this.query.sort, groupBy: this.query.groupBy });
  }

  toggleMetadata(): void {
    const selected = this.selectedSession();
    this.overlay = this.overlay?.kind === "metadata" || selected === undefined
      ? undefined
      : createMetadataOverlay(selected);
  }

  toggleHelp(): void {
    this.overlay = this.overlay?.kind === "help" ? undefined : createHelpOverlay();
  }

  focusComposer(): void {
    if (this.attachmentRole === "observer") return;
    this.focus = "composer";
    this.composerField = "prompt";
  }

  setComposerPrompt(prompt: string): void {
    this.composerDraft = { ...this.composerDraft, prompt };
    this.scheduleUiSave();
  }

  setIsolationMode(isolationMode: LaunchIsolationMode): void {
    this.composerDraft = { ...this.composerDraft, isolationMode };
    this.scheduleUiSave();
  }

  async submitComposer(): Promise<void> {
    if (this.attachmentRole === "observer" || this.composerDraft.prompt.trim().length === 0) return;
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
      if (prepared.kind === "ready") await this.launch(prepared.request);
    } catch (error) {
      this.setError(error, "LAUNCH_PREFLIGHT_FAILED");
    }
  }

  async confirmSharedLaunch(exactPath: string): Promise<void> {
    const pending = this.pendingShared;
    if (pending === undefined) return;
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

  async resolveUnknownDelivery(resolution: DeliveryResolution): Promise<void> {
    if (this.overlay?.kind !== "delivery_unknown") return;
    const { clientId, requestId } = this.overlay;
    await this.backend.resolveDelivery(clientId, requestId, resolution);
    this.overlay = undefined;
  }

  private async confirmSession(confirmation: SessionConfirmation): Promise<void> {
    if (confirmation.submitting || this.attachmentRole === "observer") return;
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
    } catch (error) {
      const typed = error as { code?: string; message?: string; clientId?: string; requestId?: string };
      if (typed.code === "DELIVERY_UNKNOWN") {
        this.overlay = createDeliveryUnknownOverlay(typed.clientId ?? this.clientId, typed.requestId ?? requestId);
      } else {
        this.overlay = { ...confirmation, submitting: false };
        this.setError(error, `${confirmation.action.toUpperCase()}_FAILED`);
      }
    }
  }

  async activateSelection(): Promise<void> {
    const selected = this.selectedSession();
    if (selected === undefined) return;
    const result = await this.nativeAttach.attach({ sessionId: selected.sessionId, selectedRevision: selected.revision });
    if (result.kind !== "attached") {
      this.status = { kind: "error", code: result.error.code, message: result.error.message };
      return;
    }
    this.attachedSessionId = selected.sessionId;
    this.attachmentRole = result.role;
    this.status = result.role === "observer"
      ? { kind: "observer", message: "Read-only observer: composing and pending-request responses require explicit composer takeover after release." }
      : { kind: "ready" };
  }

  handleInput(data: string): void {
    if (this.overlay?.kind === "session_confirmation") {
      if (this.overlay.submitting) return;
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
        this.overlay = undefined;
        return;
      }
      if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
        void this.confirmSession(this.overlay);
      }
      return;
    }
    if (this.focus === "confirmation") {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
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
      if (printable !== undefined) this.confirmationText += printable;
      return;
    }

    if (this.focus === "search") {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.focus = "list";
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.setSearch((this.query.search ?? "").slice(0, -1));
        return;
      }
      const printable = this.printable(data);
      if (printable !== undefined) this.setSearch((this.query.search ?? "") + printable);
      return;
    }

    if (this.focus === "composer") {
      if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
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
      if (printable !== undefined) this.editComposerField((value) => value + printable);
      return;
    }

    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      void this.close();
      return;
    }
    if (matchesKey(data, Key.ctrl("x"))) {
      if (this.attachmentRole === "observer") return;
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
    if (matchesKey(data, Key.down)) this.moveSelection(1);
    else if (matchesKey(data, Key.up)) this.moveSelection(-1);
    else if (matchesKey(data, Key.pageDown)) this.moveSelection(Math.max(1, this.listHeight()));
    else if (matchesKey(data, Key.pageUp)) this.moveSelection(-Math.max(1, this.listHeight()));
    else if (matchesKey(data, Key.home)) this.selectBoundary(false);
    else if (matchesKey(data, Key.end)) this.selectBoundary(true);
    else if (data === "/") this.focus = "search";
    else if ((matchesKey(data, Key.tab) || data === "n") && this.attachmentRole !== "observer") this.focusComposer();
    else if (data === "i") this.toggleMetadata();
    else if (data === "?") this.toggleHelp();
    else if (data === "v") this.cycleView();
    else if (data === "c") this.clearFilters();
    else if (data === "t") this.setTaskStates(this.singletonCycle(TASK_STATES, this.query.taskStates));
    else if (data === "p") this.setProcessStates(this.singletonCycle(PROCESS_STATES, this.query.processStates));
    else if (data === "o") this.setOutcomes(this.singletonCycle(OUTCOMES, this.query.outcomes));
    else if (data === "a") this.cycleActivityFilter();
    else if (data === "j") this.setProjectPaths(this.singletonCycle([...new Set(this.sessions.map((session) => session.cwd))], this.query.projectPaths));
    else if (data === "s") this.cycleSort();
    else if (data === "g") this.setGrouping(cycleValue(GROUPS, this.query.groupBy));
  }

  handleMouse(event: { row: number; column: number; button: "left" | "wheel_up" | "wheel_down" }): void {
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
    if (Math.floor(event.row) === this.height - 3 && this.attachmentRole !== "observer") {
      this.focusComposer();
      return;
    }
    if (Math.floor(event.row) === this.height - 2 && this.attachmentRole !== "observer") {
      this.focus = "composer";
      this.composerField = COMPOSER_FIELDS[1 + Math.min(COMPOSER_FIELDS.length - 2, Math.floor(Math.max(0, event.column) * (COMPOSER_FIELDS.length - 1) / Math.max(1, this.width)))];
      return;
    }
    const index = this.viewportOffset + Math.floor(event.row) - layout.listTop;
    const row = this.list.rows[index];
    if (row?.kind === "session") this.selectSession(row.session.sessionId);
  }

  render(width = this.width, height = this.height): string[] {
    const renderedGeneration = this.renderRequestGeneration;
    try {
      this.resize(width, height);
      const layout = createDashboardLayout(this.width, this.height);
      const counts = countDashboardSessions(this.sessions);
      const lines = Array.from({ length: this.height }, () => "");
      if (lines.length > 0) lines[0] = " pi agents";
      if (lines.length > 1) lines[1] = ` Working ${counts.working}  Ready ${counts.ready}  Failed ${counts.failed}  Sessions ${counts.sessions}  Processes ${counts.processes}`;
      if (lines.length > 2) lines[2] = ` ${this.controlSegments().join(" ")}`;
      if (lines.length > 3) lines[3] = renderColumnHeader(layout);
      const rendered = this.list.renderViewport({ offset: this.viewportOffset, height: layout.listHeight, width: this.width });
      for (let index = 0; index < rendered.length; index += 1) {
        const target = layout.listTop + index;
        if (target < lines.length) lines[target] = rendered[index].line;
      }
      if (lines.length >= 3) {
        const composerMarker = this.focus === "composer" ? `[${this.composerField}]` : "";
        lines[lines.length - 3] = `❯${composerMarker} ${this.composerDraft.prompt || "describe a task for a new session"}`;
        const form = `cwd:${this.composerDraft.cwd} isolation:${this.composerDraft.isolationMode} model:${this.composerDraft.model.provider}/${this.composerDraft.model.id} thinking:${this.composerDraft.thinkingLevel} name:${this.composerDraft.name}`;
        lines[lines.length - 2] = this.status.kind === "error" ? `${this.status.code}: ${this.status.message}  ${form}` : form;
        lines[lines.length - 1] = " ↑↓ nav Enter/→ open / search t/p/o/a/j filters s sort g group n form Tab fields ^X intent ? help";
      }
      this.renderOverlay(lines);
      const result = lines.map((line) => fitLine(line, this.width));
      this.completeHostRender(renderedGeneration);
      return result;
    } catch (error) {
      const typed = this.typedError(error, "RENDER_FAILED");
      this.rejectHostRenders(Object.assign(new Error(typed.message), { code: typed.code }));
      this.fail(typed);
      throw Object.assign(new Error(typed.message), { code: typed.code });
    }
  }

  private setQuery(query: DashboardQuery): void {
    this.query = query;
    this.rebuildList();
    this.scheduleUiSave();
  }

  private applySnapshot(snapshot: DashboardSnapshot): void {
    this.sessions = snapshot.sessions;
    this.rebuildList();
    this.invalidateSessionConfirmation();
  }

  private invalidateSessionConfirmation(): void {
    if (this.overlay?.kind === "session_confirmation" && !confirmationMatchesSession(this.overlay, this.selectedSession())) {
      this.overlay = undefined;
    }
  }

  private rebuildList(): void {
    const selected = this.preferredSelectionId ?? this.list.selectedSessionId;
    const visible = selectDashboardSessions(this.sessions, this.query);
    this.list.setSessions(visible, { groupBy: this.query.groupBy });
    if (selected !== undefined && visible.some((session) => session.sessionId === selected)) {
      this.list.selectSession(selected);
      this.preferredSelectionId = selected;
    }
    this.ensureSelectionVisible();
  }

  private selectedSession(): SessionRecord | undefined {
    const selectedId = this.selectedSessionId;
    return selectedId === undefined ? undefined : this.sessions.find((session) => session.sessionId === selectedId);
  }

  private moveSelection(delta: number): void {
    this.list.moveSelection(delta);
    this.preferredSelectionId = this.list.selectedSessionId;
    this.ensureSelectionVisible();
    this.scheduleUiSave();
  }

  private selectBoundary(last: boolean): void {
    const rows = last ? [...this.list.rows].reverse() : this.list.rows;
    const row = rows.find((candidate) => candidate.kind === "session");
    if (row?.kind === "session") this.selectSession(row.session.sessionId);
  }

  private listHeight(): number {
    return createDashboardLayout(this.width, this.height).listHeight;
  }

  private ensureSelectionVisible(): void {
    const row = this.list.selectedRowIndex;
    const height = this.listHeight();
    const maximum = Math.max(0, this.list.rows.length - height);
    if (row < 0 || height <= 0) this.viewportOffset = Math.min(this.viewportOffset, maximum);
    else if (row < this.viewportOffset) this.viewportOffset = row;
    else if (row >= this.viewportOffset + height) this.viewportOffset = row - height + 1;
    this.viewportOffset = Math.max(0, Math.min(this.viewportOffset, maximum));
  }

  private cycleView(): void {
    const next = this.query.view === "live" ? "done" : this.query.view === "done" ? "all" : "live";
    this.setView(next);
  }

  private controlSegments(): string[] {
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

  private activateControl(index: number): void {
    switch (index) {
      case 0: this.focus = "search"; break;
      case 1: this.cycleView(); break;
      case 2: this.setTaskStates(this.singletonCycle(TASK_STATES, this.query.taskStates)); break;
      case 3: this.setProcessStates(this.singletonCycle(PROCESS_STATES, this.query.processStates)); break;
      case 4: this.setOutcomes(this.singletonCycle(OUTCOMES, this.query.outcomes)); break;
      case 5: this.cycleActivityFilter(); break;
      case 6: this.setProjectPaths(this.singletonCycle([...new Set(this.sessions.map((session) => session.cwd))], this.query.projectPaths)); break;
      case 7: this.cycleSort(); break;
      case 8: this.setGrouping(cycleValue(GROUPS, this.query.groupBy)); break;
    }
  }

  private singletonCycle<T>(values: readonly T[], current: readonly T[] | undefined): readonly T[] | undefined {
    const next = cycleValue(values, current?.length === 1 ? current[0] : undefined);
    return next === undefined ? undefined : [next];
  }

  private cycleActivityFilter(): void {
    const kinds = [...new Set(this.sessions.map((session) => session.activity.kind))].sort();
    this.setActivityKinds(this.singletonCycle(kinds, this.query.activityKinds));
  }

  private cycleSort(): void {
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

  private cycleComposerField(delta: number): void {
    const current = COMPOSER_FIELDS.indexOf(this.composerField);
    this.composerField = COMPOSER_FIELDS[(current + delta + COMPOSER_FIELDS.length) % COMPOSER_FIELDS.length];
  }

  private editComposerField(edit: (value: string) => string): void {
    switch (this.composerField) {
      case "prompt": this.composerDraft = { ...this.composerDraft, prompt: edit(this.composerDraft.prompt) }; break;
      case "cwd": this.composerDraft = { ...this.composerDraft, cwd: edit(this.composerDraft.cwd) }; break;
      case "modelProvider": this.composerDraft = { ...this.composerDraft, model: { ...this.composerDraft.model, provider: edit(this.composerDraft.model.provider) } }; break;
      case "modelId": this.composerDraft = { ...this.composerDraft, model: { ...this.composerDraft.model, id: edit(this.composerDraft.model.id) } }; break;
      case "thinkingLevel": this.composerDraft = { ...this.composerDraft, thinkingLevel: edit(this.composerDraft.thinkingLevel) }; break;
      case "name": this.composerDraft = { ...this.composerDraft, name: edit(this.composerDraft.name) }; break;
      case "isolationMode": return;
    }
    this.scheduleUiSave();
  }

  private printable(data: string): string | undefined {
    return decodeKittyPrintable(data)
      ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
  }

  private async launch(request: LaunchRequest): Promise<void> {
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

  private renderOverlay(lines: string[]): void {
    const overlay = this.overlay;
    if (overlay === undefined || lines.length === 0) return;
    let details: string[];
    if (overlay.kind === "metadata") details = Object.entries(overlay.fields).map(([key, value]) => `${key}: ${value}`);
    else if (overlay.kind === "help") details = overlay.bindings.map((binding) => `${binding.keys}  ${binding.action}`);
    else if (overlay.kind === "shared_directory_confirmation") details = ["Shared directory warning", `Type exactly: ${overlay.canonicalCwd}`, `> ${this.confirmationText}`];
    else if (overlay.kind === "session_confirmation") details = [`Confirm ${overlay.action.toUpperCase()} for ${overlay.sessionId}?`, overlay.submitting ? "Submitting…" : "Press y/Enter to confirm; n/Escape to cancel."];
    else details = ["DELIVERY_UNKNOWN", "Choose retry_at_risk or abandon; no automatic retry."];
    const start = Math.max(0, Math.floor((lines.length - details.length) / 2));
    details.forEach((detail, index) => { if (start + index < lines.length) lines[start + index] = detail; });
  }

  private trackEvent(update: DashboardUpdate, generation: number): Promise<void> {
    const operation = this.eventOperations.size === 0
      ? this.processEvent(update, generation)
      : this.eventTail.then(() => this.processEvent(update, generation));
    this.eventTail = operation;
    this.eventOperations.add(operation);
    void operation.finally(() => this.eventOperations.delete(operation)).catch(() => {});
    return operation;
  }

  private async processEvent(update: DashboardUpdate, generation: number): Promise<void> {
    if (!this.isCurrentOpen(generation)) throw Object.assign(new Error("Dashboard is closed"), { code: "DASHBOARD_CLOSED" });
    try {
      this.applySnapshot(update.snapshot);
      await this.awaitHostRender();
      if (!this.isCurrentOpen(generation)) throw Object.assign(new Error("Dashboard is closed"), { code: "DASHBOARD_CLOSED" });
      await this.enqueueSave(this.persistedState(update.cursor));
      if (!this.isCurrentOpen(generation)) throw Object.assign(new Error("Dashboard is closed"), { code: "DASHBOARD_CLOSED" });
      this.cursor = update.cursor;
    } catch (error) {
      const typed = this.typedError(error, "EVENT_PROCESSING_FAILED");
      this.fail(typed);
      throw Object.assign(new Error(typed.message), { code: typed.code });
    }
  }

  private awaitHostRender(): Promise<void> {
    if (this.requestRender === undefined) return Promise.reject(Object.assign(new Error("Dashboard host cannot request rendering"), { code: "UNSUPPORTED_HOST" }));
    const generation = ++this.renderRequestGeneration;
    const rendered = new Promise<void>((resolve, reject) => {
      this.renderWaiters.set(generation, { resolve, reject });
    });
    try {
      this.requestRender();
    } catch (error) {
      const waiter = this.renderWaiters.get(generation);
      this.renderWaiters.delete(generation);
      const waiterError = Object.assign(new Error("Dashboard host render request failed"), { code: "RENDER_FAILED", cause: error });
      waiter?.reject(waiterError);
      return rendered;
    }
    return rendered;
  }

  private completeHostRender(generation: number): void {
    const waiter = this.renderWaiters.get(generation);
    if (waiter === undefined) return;
    this.renderWaiters.delete(generation);
    waiter.resolve();
  }

  private rejectHostRenders(error: unknown): void {
    for (const waiter of this.renderWaiters.values()) waiter.reject(error);
    this.renderWaiters.clear();
  }

  private persistedState(cursor = this.cursor): PersistedDashboardState {
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

  private enqueueSave(state: PersistedDashboardState): Promise<void> {
    const operation = this.saveTail.then(() => this.persistence.save(state));
    this.saveTail = operation.then(
      () => {},
      (error) => { this.saveFailure ??= error; },
    );
    return operation;
  }

  private scheduleUiSave(): void {
    if (this.closed) return;
    const admission = this.saveAdmissionGeneration;
    const state = this.persistedState();
    if (this.closed || admission !== this.saveAdmissionGeneration) return;
    const operation = this.enqueueSave(state);
    void operation.catch((error) => this.fail(this.typedError(error, "PERSIST_FAILED")));
  }

  private beginClose(initialError?: DashboardTransportError): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
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

  private async finishClose(initialError?: DashboardTransportError): Promise<void> {
    let error = initialError;
    await Promise.allSettled([...this.eventOperations]);
    await this.saveTail;
    if (error === undefined && this.saveFailure !== undefined) error = this.typedError(this.saveFailure, "PERSIST_FAILED");
    try {
      await this.detachNative();
    } catch (detachError) {
      error ??= this.typedError(detachError, "DASHBOARD_CLOSE_FAILED");
    }
    try {
      await this.enqueueSave(this.persistedState());
    } catch (saveError) {
      error ??= this.typedError(saveError, "DASHBOARD_CLOSE_FAILED");
    }
    await this.saveTail;
    const result: DashboardCloseResult = error === undefined
      ? { kind: "closed" }
      : { kind: "error", code: error.code, message: error.message };
    if (error !== undefined) this.status = { kind: "error", code: error.code, message: error.message };
    this.onClose?.(result);
  }

  private isCurrentOpen(generation: number): boolean {
    return !this.closed && this.openGeneration === generation;
  }

  private typedError(error: unknown, fallbackCode: string): DashboardTransportError {
    const typed = error as { code?: string; message?: string };
    return { code: typed.code ?? fallbackCode, message: typed.message ?? fallbackCode };
  }

  private async detachNative(): Promise<void> {
    const sessionId = this.attachedSessionId;
    if (sessionId === undefined) return;
    const result = await this.nativeAttach.detach({ sessionId });
    if (result.kind !== "detached") throw Object.assign(new Error(result.error.message), result.error);
    this.attachedSessionId = undefined;
    this.attachmentRole = undefined;
  }

  private fail(error: DashboardTransportError): void {
    this.status = { kind: "error", code: error.code, message: error.message };
    this.beginClose(error).catch(() => {});
  }

  private setError(error: unknown, fallbackCode: string): void {
    const typed = this.typedError(error, fallbackCode);
    this.status = { kind: "error", code: typed.code, message: typed.message };
  }
}
