import type {
  DeliveryResolution,
  SessionRecord,
} from "../../shared/contracts.js";

export interface MetadataOverlay {
  kind: "metadata";
  sessionId: string;
  fields: {
    taskState: SessionRecord["taskState"];
    processState: SessionRecord["processState"];
    outcome: SessionRecord["outcome"];
    activity: string;
    cwd: string;
    model: string;
    thinkingLevel: string;
  };
}

export interface HelpOverlay {
  kind: "help";
  bindings: readonly { keys: string; action: string }[];
}

export interface SharedDirectoryOverlay {
  kind: "shared_directory_confirmation";
  canonicalCwd: string;
  ownerSessionIds: readonly string[];
  requiredInput: string;
}

export interface SessionIntent {
  kind: "session_intent";
  action: "stop" | "delete";
  sessionId: string;
  revision: number;
}

export interface SessionConfirmation {
  kind: "session_confirmation";
  action: SessionIntent["action"];
  sessionId: string;
  revision: number;
  processState: SessionRecord["processState"];
  ownershipFingerprint: string;
  submitting: boolean;
}

export interface DeliveryUnknownOverlay {
  kind: "delivery_unknown";
  clientId: string;
  requestId: string;
  actions: readonly DeliveryResolution[];
}

export type DashboardOverlay =
  | MetadataOverlay
  | HelpOverlay
  | SharedDirectoryOverlay
  | SessionConfirmation
  | DeliveryUnknownOverlay;

/** Describe one selected session without collapsing independent state fields. */
export function createMetadataOverlay(session: SessionRecord): MetadataOverlay {
  return {
    kind: "metadata",
    sessionId: session.sessionId,
    fields: {
      taskState: session.taskState,
      processState: session.processState,
      outcome: session.outcome,
      activity: session.activity.summary,
      cwd: session.cwd,
      model: session.model === undefined ? "—" : `${session.model.provider}/${session.model.id}`,
      thinkingLevel: session.thinkingLevel ?? "—",
    },
  };
}

/** Return the dashboard-only keyboard reference. */
export function createHelpOverlay(): HelpOverlay {
  return {
    kind: "help",
    bindings: [
      { keys: "↑/↓ PgUp/PgDn Home/End", action: "navigate" },
      { keys: "Enter/→", action: "open native Pi session" },
      { keys: "n, then Tab/Shift+Tab", action: "edit prompt, cwd, isolation, provider/model, thinking, and name" },
      { keys: "/ t p o a j", action: "edit search; cycle task, process, outcome, activity, and project filters" },
      { keys: "v s g c", action: "cycle view, sort, group; clear filters" },
      { keys: "mouse controls/form", action: "focus or cycle the clicked search, filter, sort, group, or launch field" },
      { keys: "i / ?", action: "metadata / help" },
      { keys: "Ctrl+C / Escape", action: "close dashboard" },
      { keys: "Ctrl+X", action: "request Task 15 confirmation" },
    ],
  };
}

/** Require the canonical path itself as shared-directory confirmation input. */
export function createSharedDirectoryOverlay(
  canonicalCwd: string,
  ownerSessionIds: readonly string[],
): SharedDirectoryOverlay {
  return {
    kind: "shared_directory_confirmation",
    canonicalCwd,
    ownerSessionIds: [...ownerSessionIds],
    requiredInput: canonicalCwd,
  };
}

function destructiveAction(session: SessionRecord): SessionIntent["action"] {
  return session.processState === "LIVE" || session.processState === "SLEEPING" ||
    (session.processState === "STALE" && session.ownership !== undefined)
    ? "stop"
    : "delete";
}

/** Return a typed Task 15 intent; this function performs no destructive action. */
export function createSessionIntent(session: SessionRecord): SessionIntent {
  return {
    kind: "session_intent",
    action: destructiveAction(session),
    sessionId: session.sessionId,
    revision: session.revision,
  };
}

function ownershipFingerprint(session: SessionRecord): string {
  const ownership = session.ownership;
  return ownership === undefined
    ? "unowned"
    : JSON.stringify([ownership.runId, ownership.process.pid, ownership.process.startIdentity, ownership.process.processGroupId, ownership.acquiredAt, ownership.heartbeatAt]);
}

/** Bind confirmation to one canonical session revision and requested action. */
export function createSessionConfirmation(session: SessionRecord): SessionConfirmation {
  return {
    kind: "session_confirmation",
    action: destructiveAction(session),
    sessionId: session.sessionId,
    revision: session.revision,
    processState: session.processState,
    ownershipFingerprint: ownershipFingerprint(session),
    submitting: false,
  };
}

/** Check that a confirmation still names the selected record and same action. */
export function confirmationMatchesSession(
  confirmation: SessionConfirmation,
  session: SessionRecord | undefined,
): boolean {
  return session !== undefined &&
    confirmation.sessionId === session.sessionId &&
    confirmation.revision === session.revision &&
    confirmation.processState === session.processState &&
    confirmation.ownershipFingerprint === ownershipFingerprint(session) &&
    confirmation.action === destructiveAction(session);
}

/** Return explicit resolution choices for an ambiguous durable command. */
export function createDeliveryUnknownOverlay(
  clientId: string,
  requestId: string,
): DeliveryUnknownOverlay {
  return {
    kind: "delivery_unknown",
    clientId,
    requestId,
    actions: ["retry_at_risk", "abandon"],
  };
}
