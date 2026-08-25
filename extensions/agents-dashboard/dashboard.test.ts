import { Key, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type { EventCursor, LaunchRequest, SessionRecord } from "../../shared/contracts.js";
import {
  DashboardController,
  createDaemonDashboardBackend,
  type DashboardBackend,
  type DashboardPersistence,
  type DashboardSnapshot,
  type LaunchOutcome,
  type DashboardUpdate,
  type NativeAttachSeam,
} from "./dashboard.js";

const timestamp = "2026-08-25T12:00:00.000Z";

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
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

class FakeBackend implements DashboardBackend {
  snapshot: DashboardSnapshot;
  listener?: (update: DashboardUpdate) => Promise<void> | void;
  errorListener?: (error: { code: string; message: string }) => void;
  unsubscribed = 0;
  requests: LaunchRequest[] = [];
  stop = vi.fn();
  delete = vi.fn();
  resolveDelivery = vi.fn(async () => {});

  constructor(sessions: readonly SessionRecord[]) {
    this.snapshot = { sessions };
  }

  async getSnapshot() { return this.snapshot; }
  subscribe(_after: EventCursor | undefined, listener: (update: DashboardUpdate) => Promise<void> | void, onError: (error: { code: string; message: string }) => void) {
    this.listener = listener;
    this.errorListener = onError;
    return () => { this.unsubscribed += 1; };
  }
  async preflightLaunch(draft: { cwd: string; isolationMode: "worktree" | "shared_directory" }) {
    return { canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: draft.isolationMode === "shared_directory" ? ["other"] : [] };
  }
  async launch(request: LaunchRequest): Promise<LaunchOutcome> {
    this.requests.push(request);
    return { kind: "launched" as const, sessionId: "launched" };
  }
}

function persistence(initial: Awaited<ReturnType<DashboardPersistence["load"]>> = undefined): DashboardPersistence & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    async load() { return initial; },
    async save(value) { saved.push(value); },
  };
}

const unsupportedAttach: NativeAttachSeam = {
  async attach() { return { kind: "unsupported", error: { code: "UNSUPPORTED_HOST", message: "Native attach is unavailable" } }; },
};

function controller(backend: FakeBackend, overrides: Partial<ConstructorParameters<typeof DashboardController>[0]> = {}) {
  return new DashboardController({
    backend,
    persistence: persistence(),
    nativeAttach: unsupportedAttach,
    clientId: "stable-client",
    sourceSessionId: "source",
    launchDefaults: { cwd: "/repo", model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high", name: "new task" },
    ...overrides,
  });
}

describe("dashboard controller", () => {
  it("keeps selection by canonical session ID through live reorder and resize", async () => {
    const backend = new FakeBackend([session("a"), session("b"), session("c")]);
    const dashboard = controller(backend);
    await dashboard.open();
    dashboard.handleInput("\x1b[B");
    expect(dashboard.selectedSessionId).toBe("b");

    await backend.listener?.({ snapshot: { sessions: [session("c"), session("a"), session("b", { revision: 2 })] }, cursor: { daemonEpoch: "epoch", sequence: "1" } });
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

  it("closes list on Ctrl+C/Escape without stop, delete, abort, or worker signal", async () => {
    const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
    const onClose = vi.fn();
    const dashboard = controller(backend, { onClose });
    await dashboard.open();
    dashboard.handleInput("\x03");
    expect(onClose).toHaveBeenCalledWith({ kind: "closed" });
    expect(backend.stop).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
    expect(backend.unsubscribed).toBe(1);

    const reopened = controller(backend, { onClose });
    await reopened.open();
    reopened.handleInput("\x1b");
    expect(backend.unsubscribed).toBe(2);
  });

  it("returns composer focus on Ctrl+C with draft intact and ignores blank Enter", async () => {
    const backend = new FakeBackend([]);
    const dashboard = controller(backend);
    await dashboard.open();
    dashboard.focusComposer();
    dashboard.setComposerPrompt("draft");
    dashboard.handleInput("\x03");
    expect(dashboard.focus).toBe("list");
    expect(dashboard.composerDraft.prompt).toBe("draft");
    dashboard.focusComposer();
    dashboard.setComposerPrompt("   ");
    await dashboard.submitComposer();
    expect(backend.requests).toEqual([]);
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
    await dashboard.confirmSharedLaunch("/repo");
    expect(backend.requests[1]).toMatchObject({ isolation: { mode: "shared_directory", confirmedCwd: "/repo" } });
  });

  it("surfaces DELIVERY_UNKNOWN actions and never automatically retries", async () => {
    const backend = new FakeBackend([]);
    backend.launch = vi.fn(async () => ({ kind: "delivery_unknown" as const, clientId: "stable-client", requestId: "launch-unknown" })) as DashboardBackend["launch"];
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

  it("delegates Enter/Right only to native attach and surfaces typed UNSUPPORTED_HOST", async () => {
    const attach = vi.fn(unsupportedAttach.attach);
    const dashboard = controller(new FakeBackend([session("a")]), { nativeAttach: { attach } });
    await dashboard.open();
    await dashboard.activateSelection();
    expect(attach).toHaveBeenCalledWith({ sessionId: "a", selectedRevision: 1 });
    expect(dashboard.status).toMatchObject({ kind: "error", code: "UNSUPPORTED_HOST" });
  });

  it("routes Ctrl+X to a typed non-destructive intent without backend mutation", async () => {
    const backend = new FakeBackend([session("a", { processState: "LIVE" })]);
    const onSessionIntent = vi.fn();
    const dashboard = controller(backend, { onSessionIntent });
    await dashboard.open();
    dashboard.handleInput("\x18");
    expect(onSessionIntent).toHaveBeenCalledWith({ kind: "session_intent", action: "stop", sessionId: "a", revision: 1 });
    expect(backend.stop).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
  });

  it("closes and surfaces a typed malformed-frame state without signaling workers", async () => {
    const backend = new FakeBackend([session("a")]);
    const onClose = vi.fn();
    const dashboard = controller(backend, { onClose });
    await dashboard.open();
    backend.errorListener?.({ code: "MALFORMED_FRAME", message: "invalid event" });
    expect(dashboard.status).toMatchObject({ kind: "error", code: "MALFORMED_FRAME" });
    expect(onClose).toHaveBeenCalledWith({ kind: "error", code: "MALFORMED_FRAME", message: "invalid event" });
    expect(backend.stop).not.toHaveBeenCalled();
  });

  it("restores safe view state and cursor but never stale composer ownership", async () => {
    const saved = persistence({
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
});

describe("daemon dashboard backend", () => {
  it("processes replay once, acknowledges only successful events, and resumes from the acknowledged cursor", async () => {
    const zero = { daemonEpoch: "epoch", sequence: "0" };
    const one = { daemonEpoch: "epoch", sequence: "1" };
    const requests: unknown[] = [];
    const event = { version: 1 as const, cursor: one, occurredAt: timestamp, kind: "session_changed" as const, payload: { session: session("a") } };
    const client = {
      async connect() {},
      async request(request: unknown) {
        requests.push(request);
        const typed = request as { requestId: string; op: string; payload: { cursor?: EventCursor } };
        if (typed.op === "get_state") return { version: 1 as const, requestId: typed.requestId, ok: true as const, result: { kind: "state" as const, sessions: [] } };
        return { version: 1 as const, requestId: typed.requestId, ok: true as const, result: { kind: "acknowledged" as const, cursor: typed.payload.cursor! } };
      },
      subscribe(after?: EventCursor) {
        expect(after).toEqual(zero);
        return {
          async *[Symbol.asyncIterator]() { yield event; yield event; },
        };
      },
      async close() {},
    };
    const backend = createDaemonDashboardBackend({ client, clientId: "stable-client", preflight: async (draft) => ({ canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] }) });
    const updates: DashboardUpdate[] = [];
    const unsubscribe = backend.subscribe(zero, (update) => { updates.push(update); }, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();
    expect(updates).toHaveLength(1);
    expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ op: "ack", payload: { cursor: one } })]));
  });
});
