function required(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${field} must be a non-empty string`);
    }
    return value;
}
/** Create the complete launch form with worktree isolation as its default. */
export function createLaunchDraft(defaults) {
    return {
        prompt: "",
        cwd: required(defaults.cwd, "Launch cwd"),
        sourceSessionId: required(defaults.sourceSessionId ?? "source-session", "Source session ID"),
        isolationMode: "worktree",
        model: {
            provider: defaults.model?.provider ?? "",
            id: defaults.model?.id ?? "",
        },
        thinkingLevel: defaults.thinkingLevel ?? "",
        name: defaults.name ?? "",
    };
}
/** Build the exact daemon LaunchRequest after canonical preflight and confirmation. */
export function prepareLaunchRequest(draft, preflight, confirmation) {
    if (draft.prompt.trim().length === 0)
        return { kind: "blank" };
    required(draft.cwd, "Launch cwd");
    required(draft.sourceSessionId, "Source session ID");
    if ((draft.model.provider === "") !== (draft.model.id === ""))
        throw new TypeError("Model provider and ID must be selected together");
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
    const request = {
        prompt: draft.prompt,
        cwd: preflight.canonicalCwd,
        sourceSessionId: draft.sourceSessionId,
        isolation: draft.isolationMode === "worktree"
            ? { mode: "worktree" }
            : { mode: "shared_directory", confirmedCwd: preflight.canonicalCwd },
    };
    if (draft.model.provider !== "") request.model = { ...draft.model };
    if (draft.thinkingLevel !== "") request.thinkingLevel = draft.thinkingLevel;
    if (draft.name.trim() !== "") request.name = draft.name;
    return { kind: "ready", request };
}
/** Reduce composer focus and delivery states without performing transport effects. */
export function reduceLaunchComposer(state, event) {
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
