/** Describe one selected session without collapsing independent state fields. */
export function createMetadataOverlay(session) {
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
export function createHelpOverlay() {
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
export function createSharedDirectoryOverlay(canonicalCwd, ownerSessionIds) {
    return {
        kind: "shared_directory_confirmation",
        canonicalCwd,
        ownerSessionIds: [...ownerSessionIds],
        requiredInput: canonicalCwd,
    };
}
/** Which destructive action a session currently admits. @param {any} session */
export function destructiveAction(session) {
    return session.processState === "LIVE" || session.processState === "SLEEPING" ||
        (session.processState === "STALE" && session.ownership !== undefined)
        ? "stop"
        : "delete";
}
/** Return a typed Task 15 intent; this function performs no destructive action. */
export function createSessionIntent(session) {
    return {
        kind: "session_intent",
        action: destructiveAction(session),
        sessionId: session.sessionId,
        revision: session.revision,
    };
}
function ownershipFingerprint(session) {
    const ownership = session.ownership;
    return ownership === undefined
        ? "unowned"
        : JSON.stringify([ownership.runId, ownership.process.pid, ownership.process.startIdentity, ownership.process.processGroupId, ownership.acquiredAt, ownership.heartbeatAt]);
}
/** Bind confirmation to one canonical session revision and requested action. */
export function createSessionConfirmation(session) {
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
export function confirmationMatchesSession(confirmation, session) {
    return session !== undefined &&
        confirmation.sessionId === session.sessionId &&
        confirmation.revision === session.revision &&
        confirmation.processState === session.processState &&
        confirmation.ownershipFingerprint === ownershipFingerprint(session) &&
        confirmation.action === destructiveAction(session);
}
/**
 * Describe one overlay as a title and plain content rows for the floating panel.
 * `emphasis` marks rows the panel renders as muted guidance rather than data.
 */
export function describeOverlay(overlay, options = {}) {
    if (overlay.kind === "help") {
        const keyWidth = Math.max(...overlay.bindings.map((binding) => binding.keys.length));
        return {
            title: "Help",
            rows: overlay.bindings.map((binding) => ({ text: `${binding.keys.padEnd(keyWidth)}  ${binding.action}` })),
        };
    }
    if (overlay.kind === "metadata") {
        const fields = Object.entries(overlay.fields);
        const keyWidth = Math.max(...fields.map(([key]) => key.length));
        return {
            title: "Session",
            rows: [
                { text: overlay.sessionId, emphasis: true },
                ...fields.map(([key, value]) => ({ text: `${key.padEnd(keyWidth)}  ${value}` })),
            ],
        };
    }
    if (overlay.kind === "session_confirmation") {
        return {
            title: `Confirm ${overlay.action.toUpperCase()}`,
            rows: [
                { text: overlay.sessionId },
                { text: overlay.submitting ? "Submitting…" : "Press y/Enter to confirm; n/Escape to cancel.", emphasis: true },
            ],
        };
    }
    if (overlay.kind === "shared_directory_confirmation") {
        return {
            title: "Shared directory",
            rows: [
                { text: "This session shares a directory with other owners.", emphasis: true },
                { text: `Type exactly: ${overlay.canonicalCwd}` },
                { text: `> ${options.confirmationText ?? ""}` },
            ],
        };
    }
    return {
        title: "Delivery unknown",
        rows: [
            { text: "The daemon cannot prove this command was delivered.", emphasis: true },
            { text: `Choose ${overlay.actions.join(" or ")}; no automatic retry.` },
        ],
    };
}
/** Return explicit resolution choices for an ambiguous durable command. */
export function createDeliveryUnknownOverlay(clientId, requestId) {
    return {
        kind: "delivery_unknown",
        clientId,
        requestId,
        actions: ["retry_at_risk", "abandon"],
    };
}
