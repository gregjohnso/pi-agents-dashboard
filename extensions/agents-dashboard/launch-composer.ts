import type {
  DeliveryResolution,
  LaunchRequest,
} from "../../shared/contracts.js";

export type LaunchIsolationMode = "worktree" | "shared_directory";

export interface LaunchDraft {
  prompt: string;
  cwd: string;
  sourceSessionId: string;
  isolationMode: LaunchIsolationMode;
  model: { provider: string; id: string };
  thinkingLevel: string;
  name: string;
}

export interface LaunchDefaults {
  cwd: string;
  sourceSessionId?: string;
  model: { provider: string; id: string };
  thinkingLevel: string;
  name: string;
}

export interface LaunchPreflight {
  canonicalCwd: string;
  isolationMode: LaunchIsolationMode;
  ownerSessionIds: readonly string[];
}

export type PreparedLaunch =
  | { kind: "blank" }
  | { kind: "confirmation_required"; canonicalCwd: string; ownerSessionIds: readonly string[] }
  | { kind: "confirmation_mismatch"; canonicalCwd: string }
  | { kind: "ready"; request: LaunchRequest };

export interface DeliveryUnknownState {
  clientId: string;
  requestId: string;
  actions: readonly DeliveryResolution[];
}

export interface LaunchComposerState {
  focus: "list" | "composer";
  draft: LaunchDraft;
  launch?: LaunchRequest;
  deliveryUnknown?: DeliveryUnknownState;
}

export type LaunchComposerEvent =
  | { type: "focus" }
  | { type: "changed"; prompt: string }
  | { type: "cancel" }
  | { type: "submit"; preflight: LaunchPreflight; confirmation?: string }
  | { type: "deliveryUnknown"; clientId: string; requestId: string };

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

/** Create the complete launch form with worktree isolation as its default. */
export function createLaunchDraft(defaults: LaunchDefaults): LaunchDraft {
  return {
    prompt: "",
    cwd: required(defaults.cwd, "Launch cwd"),
    sourceSessionId: required(defaults.sourceSessionId ?? "source-session", "Source session ID"),
    isolationMode: "worktree",
    model: {
      provider: required(defaults.model.provider, "Model provider"),
      id: required(defaults.model.id, "Model ID"),
    },
    thinkingLevel: required(defaults.thinkingLevel, "Thinking level"),
    name: required(defaults.name, "Display name"),
  };
}

/** Build the exact daemon LaunchRequest after canonical preflight and confirmation. */
export function prepareLaunchRequest(
  draft: LaunchDraft,
  preflight: LaunchPreflight,
  confirmation?: string,
): PreparedLaunch {
  if (draft.prompt.trim().length === 0) return { kind: "blank" };
  required(draft.cwd, "Launch cwd");
  required(draft.sourceSessionId, "Source session ID");
  required(draft.model.provider, "Model provider");
  required(draft.model.id, "Model ID");
  required(draft.thinkingLevel, "Thinking level");
  required(draft.name, "Display name");
  required(preflight.canonicalCwd, "Canonical cwd");
  if (preflight.isolationMode !== draft.isolationMode) {
    throw new TypeError("Launch preflight isolation mode does not match the draft");
  }

  if (draft.isolationMode === "shared_directory") {
    if (confirmation === undefined) {
      return {
        kind: "confirmation_required",
        canonicalCwd: preflight.canonicalCwd,
        ownerSessionIds: preflight.ownerSessionIds,
      };
    }
    if (confirmation !== preflight.canonicalCwd) {
      return { kind: "confirmation_mismatch", canonicalCwd: preflight.canonicalCwd };
    }
  }

  const request: LaunchRequest = {
    prompt: draft.prompt,
    cwd: preflight.canonicalCwd,
    sourceSessionId: draft.sourceSessionId,
    isolation: draft.isolationMode === "worktree"
      ? { mode: "worktree" }
      : { mode: "shared_directory", confirmedCwd: preflight.canonicalCwd },
    model: { ...draft.model },
    thinkingLevel: draft.thinkingLevel,
    name: draft.name,
  };
  return { kind: "ready", request };
}

/** Reduce composer focus and delivery states without performing transport effects. */
export function reduceLaunchComposer(
  state: LaunchComposerState,
  event: LaunchComposerEvent,
): LaunchComposerState {
  switch (event.type) {
    case "focus":
      return { ...state, focus: "composer" };
    case "changed":
      return { ...state, draft: { ...state.draft, prompt: event.prompt }, launch: undefined };
    case "cancel":
      return { ...state, focus: "list", launch: undefined };
    case "submit": {
      const prepared = prepareLaunchRequest(state.draft, event.preflight, event.confirmation);
      return prepared.kind === "ready"
        ? { ...state, focus: "list", launch: prepared.request, deliveryUnknown: undefined }
        : { ...state, launch: undefined };
    }
    case "deliveryUnknown":
      return {
        ...state,
        focus: "list",
        launch: undefined,
        deliveryUnknown: {
          clientId: event.clientId,
          requestId: event.requestId,
          actions: ["retry_at_risk", "abandon"],
        },
      };
  }
}
