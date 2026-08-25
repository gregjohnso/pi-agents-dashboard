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
  PersistedEvent,
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
  createDeliveryUnknownOverlay,
  createHelpOverlay,
  createMetadataOverlay,
  createSessionIntent,
  createSharedDirectoryOverlay,
  type DashboardOverlay,
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
  ): () => void;
  preflightLaunch(draft: LaunchDraft, signal?: AbortSignal): Promise<LaunchPreflight>;
  launch(request: LaunchRequest, requestId?: string, signal?: AbortSignal): Promise<LaunchOutcome>;
  resolveDelivery(clientId: string, requestId: string, resolution: DeliveryResolution, signal?: AbortSignal): Promise<void>;
  stop(sessionId: string, requestId: string, signal?: AbortSignal): Promise<void>;
  delete(sessionId: string, requestId: string, signal?: AbortSignal): Promise<void>;
}

export interface PersistedDashboardState {
  clientId: string;
  cursor?: EventCursor;
  viewState?: {
    query: Omit<DashboardQuery, "historyPolicy">;
    selectedSessionId?: string;
  };
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

/** Task 14 implements this seam with Pi's native interface. */
export interface NativeAttachSeam {
  attach(request: { sessionId: string; selectedRevision: number }): Promise<NativeAttachResult>;
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

  return {
    async getSnapshot() {
      await client.connect();
      const response = await request("get_state", {});
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      if (response.result.kind !== "state") throw Object.assign(new Error("Daemon returned the wrong state result"), { code: "INVALID_RESPONSE" });
      sessions.clear();
      for (const session of response.result.sessions) sessions.set(session.sessionId, session);
      return { sessions: [...sessions.values()] };
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
            if (event.kind === "session_changed") {
              sessions.set(event.payload.session.sessionId, event.payload.session);
            }
            await listener({ snapshot: { sessions: [...sessions.values()] }, cursor: event.cursor, event });
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
    async stop(sessionId, exactRequestId) {
      const response = await request("stop", { sessionId }, exactRequestId);
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    },
    async delete(sessionId, exactRequestId) {
      const response = await request("delete", { sessionId }, exactRequestId);
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
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
  now?: () => number;
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
  private readonly requestId: () => string;
  private readonly now: () => number;
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

  query: DashboardQuery = defaultQuery();
  focus: "list" | "composer" = "list";
  composerDraft: LaunchDraft;
  overlay?: DashboardOverlay;
  status: DashboardStatus = { kind: "loading" };
  attachmentRole?: AttachmentRole;

  constructor(options: DashboardControllerOptions) {
    this.backend = options.backend;
    this.persistence = options.persistence;
    this.nativeAttach = options.nativeAttach;
    this.clientId = options.clientId;
    this.requestId = options.requestId ?? randomUUID;
    this.now = options.now ?? Date.now;
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
    this.status = { kind: "loading" };
    try {
      const persisted = await this.persistence.load();
      if (persisted?.clientId === this.clientId) {
        this.cursor = persisted.cursor;
        this.query = safeQuery(persisted.viewState?.query);
        this.preferredSelectionId = persisted.viewState?.selectedSessionId;
      }
      const snapshot = await this.backend.getSnapshot();
      this.applySnapshot(snapshot);
      this.unsubscribe = this.backend.subscribe(
        this.cursor,
        async (update) => {
          this.applySnapshot(update.snapshot);
          this.cursor = update.cursor;
          await this.persist();
          this.requestRender?.();
        },
        (error) => this.fail(error),
      );
      this.status = { kind: "ready" };
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      this.fail({ code: typed.code ?? "DASHBOARD_OPEN_FAILED", message: typed.message ?? "Dashboard could not open" });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    unsubscribe?.();
    this.attachmentRole = undefined;
    this.onClose?.({ kind: "closed" });
    await this.persist().catch(() => {});
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
    return selected;
  }

  setSearch(search?: string): void {
    this.setQuery({ ...this.query, search: search?.trim() === "" ? undefined : search });
  }

  setTaskStates(taskStates?: readonly TaskState[]): void {
    this.setQuery({ ...this.query, taskStates });
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
    this.focus = "composer";
  }

  setComposerPrompt(prompt: string): void {
    this.composerDraft = { ...this.composerDraft, prompt };
  }

  setIsolationMode(isolationMode: LaunchIsolationMode): void {
    this.composerDraft = { ...this.composerDraft, isolationMode };
  }

  async submitComposer(): Promise<void> {
    if (this.composerDraft.prompt.trim().length === 0) return;
    try {
      const preflight = await this.backend.preflightLaunch(this.composerDraft);
      const prepared = prepareLaunchRequest(this.composerDraft, preflight);
      if (prepared.kind === "confirmation_required") {
        this.pendingShared = { draft: { ...this.composerDraft }, preflight };
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
    this.overlay = undefined;
    await this.launch(prepared.request);
  }

  async resolveUnknownDelivery(resolution: DeliveryResolution): Promise<void> {
    if (this.overlay?.kind !== "delivery_unknown") return;
    const { clientId, requestId } = this.overlay;
    await this.backend.resolveDelivery(clientId, requestId, resolution);
    this.overlay = undefined;
  }

  async activateSelection(): Promise<void> {
    const selected = this.selectedSession();
    if (selected === undefined) return;
    const result = await this.nativeAttach.attach({ sessionId: selected.sessionId, selectedRevision: selected.revision });
    if (result.kind !== "attached") {
      this.status = { kind: "error", code: result.error.code, message: result.error.message };
      return;
    }
    this.attachmentRole = result.role;
    this.status = result.role === "observer"
      ? { kind: "observer", message: "Read-only observer: composing and pending-request responses require explicit composer takeover after release." }
      : { kind: "ready" };
  }

  handleInput(data: string): void {
    if (this.focus === "composer") {
      if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
        this.focus = "list";
        return;
      }
      if (matchesKey(data, Key.enter)) {
        void this.submitComposer();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.setComposerPrompt(this.composerDraft.prompt.slice(0, -1));
        return;
      }
      const printable = decodeKittyPrintable(data)
        ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
      if (printable !== undefined) this.setComposerPrompt(this.composerDraft.prompt + printable);
      return;
    }

    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      void this.close();
      return;
    }
    if (matchesKey(data, Key.ctrl("x"))) {
      const selected = this.selectedSession();
      if (selected !== undefined) this.onSessionIntent?.(createSessionIntent(selected));
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
    else if (matchesKey(data, Key.tab) || data === "n") this.focus = "composer";
    else if (data === "i") this.toggleMetadata();
    else if (data === "?") this.toggleHelp();
    else if (data === "v") this.cycleView();
    else if (data === "c") this.clearFilters();
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
    const index = this.viewportOffset + Math.floor(event.row) - layout.listTop;
    const row = this.list.rows[index];
    if (row?.kind === "session") this.selectSession(row.session.sessionId);
  }

  render(width = this.width, height = this.height): string[] {
    try {
      this.resize(width, height);
      const layout = createDashboardLayout(this.width, this.height);
      const counts = countDashboardSessions(this.sessions);
      const lines = Array.from({ length: this.height }, () => "");
      if (lines.length > 0) lines[0] = " pi agents";
      if (lines.length > 1) lines[1] = ` Working ${counts.working}  Ready ${counts.ready}  Failed ${counts.failed}  Sessions ${counts.sessions}  Processes ${counts.processes}`;
      if (lines.length > 2) lines[2] = ` [${this.query.view}] sort:${this.query.sort?.key ?? "none"} group:${this.query.groupBy ?? "none"}`;
      if (lines.length > 3) lines[3] = renderColumnHeader(layout);
      const rendered = this.list.renderViewport({ offset: this.viewportOffset, height: layout.listHeight, width: this.width });
      for (let index = 0; index < rendered.length; index += 1) {
        const target = layout.listTop + index;
        if (target < lines.length) lines[target] = rendered[index].line;
      }
      if (lines.length >= 3) {
        lines[lines.length - 3] = `❯ ${this.composerDraft.prompt || "describe a task for a new session"}`;
        lines[lines.length - 2] = this.status.kind === "error" ? `${this.status.code}: ${this.status.message}` : "";
        lines[lines.length - 1] = " ↑↓ nav  Enter/→ open  i info  n new  / search  v view  ^X intent  ? help";
      }
      this.renderOverlay(lines);
      return lines.map((line) => fitLine(line, this.width));
    } catch (error) {
      this.setError(error, "RENDER_FAILED");
      const message = this.status.kind === "error" ? `${this.status.code}: ${this.status.message}` : "RENDER_FAILED";
      return [fitLine(message, Math.max(0, width))];
    }
  }

  private setQuery(query: DashboardQuery): void {
    this.query = query;
    this.rebuildList();
  }

  private applySnapshot(snapshot: DashboardSnapshot): void {
    this.sessions = snapshot.sessions;
    this.rebuildList();
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

  private async launch(request: LaunchRequest): Promise<void> {
    const outcome = await this.backend.launch(request, this.requestId());
    if (outcome.kind === "launched") {
      this.focus = "list";
      this.composerDraft = { ...this.composerDraft, prompt: "" };
      this.status = { kind: "ready" };
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
    else if (overlay.kind === "shared_directory_confirmation") details = ["Shared directory warning", `Type exactly: ${overlay.canonicalCwd}`];
    else details = ["DELIVERY_UNKNOWN", "Choose retry_at_risk or abandon; no automatic retry."];
    const start = Math.max(0, Math.floor((lines.length - details.length) / 2));
    details.forEach((detail, index) => { if (start + index < lines.length) lines[start + index] = detail; });
  }

  private async persist(): Promise<void> {
    await this.persistence.save({
      clientId: this.clientId,
      cursor: this.cursor,
      viewState: {
        query: (({ historyPolicy: _historyPolicy, ...query }) => query)(this.query),
        selectedSessionId: this.preferredSelectionId ?? this.selectedSessionId,
      },
    });
  }

  private fail(error: DashboardTransportError): void {
    this.status = { kind: "error", code: error.code, message: error.message };
    if (!this.closed) {
      this.closed = true;
      const unsubscribe = this.unsubscribe;
      this.unsubscribe = undefined;
      unsubscribe?.();
      this.attachmentRole = undefined;
      this.onClose?.({ kind: "error", code: error.code, message: error.message });
    }
  }

  private setError(error: unknown, fallbackCode: string): void {
    const typed = error as { code?: string; message?: string };
    this.status = { kind: "error", code: typed.code ?? fallbackCode, message: typed.message ?? fallbackCode };
  }
}
