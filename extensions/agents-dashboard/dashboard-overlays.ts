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
      { keys: "n/Tab", action: "focus launch composer" },
      { keys: "/ s p c v t Ctrl+S", action: "search, filter, view, sort, group" },
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

/** Return a typed Task 15 intent; this function performs no destructive action. */
export function createSessionIntent(session: SessionRecord): SessionIntent {
  return {
    kind: "session_intent",
    action: session.processState === "LIVE" ? "stop" : "delete",
    sessionId: session.sessionId,
    revision: session.revision,
  };
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
