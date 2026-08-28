import { LIST_COMMANDS, matchingListCommands } from "./list-commands.mjs";

const DEFAULT_CHOICE_ROWS = 8;
const CHOICE_KEYS = "↑↓ choose · Enter apply · Esc cancel";

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
/**
 * Offer the commands a partly typed slash prompt still admits. The menu is derived from the
 * prompt on every render, so it holds no state beyond which row is highlighted.
 * @param {string} text @param {number} index
 */
export function createCommandMenuOverlay(text, index) {
    const commands = matchingListCommands(text);
    return { kind: "command_menu", commands, index: commands.length === 0 ? 0 : Math.max(0, Math.min(index, commands.length - 1)) };
}

/** Offer one bounded list of exact values for a launch field, starting on the current one. @param {string} field @param {string} title @param {string[]} values @param {string} current */
export function createChoiceOverlay(field, title, values, current) {
    return { kind: "choice", field, title, values: [...values], index: Math.max(0, values.indexOf(current)) };
}

/** Keep the highlighted row inside a panel that shows at most `maxRows` of them. @param {number} index @param {number} length @param {number} maxRows */
function windowStart(index, length, maxRows) {
    return Math.max(0, Math.min(index - Math.floor(maxRows / 2), length - maxRows));
}

/** Return the dashboard-only keyboard reference. */
export function createHelpOverlay() {
    return {
        kind: "help",
        bindings: [
            { keys: "type anything", action: "compose a prompt; Enter launches it" },
            { keys: "Enter / →", action: "open the selected session" },
            { keys: "↑ ↓ PgUp PgDn Home End", action: "move the selection" },
            { keys: "Tab / Shift+Tab", action: "edit cwd, isolation, model, thinking, name" },
            { keys: "Ctrl+X", action: "stop the session; press again within 500 ms to clear it" },
            { keys: "Ctrl+F", action: "search" },
            { keys: "Ctrl+V / Ctrl+T / Ctrl+P", action: "cycle view, task state, process state" },
            { keys: "Ctrl+O / Ctrl+A / Ctrl+J", action: "cycle outcome, activity, project filters" },
            { keys: "Ctrl+S / Ctrl+B / Ctrl+L", action: "cycle sort, grouping; clear filters" },
            { keys: "Ctrl+R / Ctrl+E", action: "refresh activity summaries; show session metadata" },
            { keys: "/model /thinking", action: "set the next session's model and thinking level" },
            { keys: "/cwd /isolation /name", action: "set its directory, isolation, and name" },
            { keys: "? / Ctrl+G", action: "this help" },
            { keys: "Ctrl+C", action: "quit" },
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
/** Bind confirmation to one canonical session revision and requested action. */
export function createSessionConfirmation(session) {
    return {
        kind: "session_confirmation",
        action: destructiveAction(session),
        sessionId: session.sessionId,
        revision: session.revision,
        processState: session.processState,
    };
}
/**
 * Describe one overlay as a title and plain content rows for the floating panel.
 * `emphasis` marks rows the panel renders as muted guidance rather than data.
 */
export function describeOverlay(overlay, options = {}) {
    if (overlay.kind === "command_menu") {
        if (overlay.commands.length === 0) return { title: "Commands", rows: [{ text: `Known: ${LIST_COMMANDS.join(" ")}`, emphasis: true }] };
        const signatures = overlay.commands.map((command) => `${command.name} ${command.argumentHint}`.trim());
        const signatureWidth = Math.max(...signatures.map((signature) => signature.length));
        return {
            title: "Commands",
            rows: overlay.commands.map((command, index) => ({ text: `${index === overlay.index ? "❯" : " "} ${signatures[index].padEnd(signatureWidth)}  ${command.summary}` })),
        };
    }
    if (overlay.kind === "choice") {
        const maxRows = Math.max(1, options.choiceRows ?? DEFAULT_CHOICE_ROWS);
        const start = windowStart(overlay.index, overlay.values.length, maxRows);
        return {
            title: `${overlay.title} ${overlay.index + 1}/${overlay.values.length}`,
            rows: [
                ...overlay.values.slice(start, start + maxRows).map((value, offset) => ({ text: `${start + offset === overlay.index ? "❯" : " "} ${value}` })),
                { text: CHOICE_KEYS, emphasis: true },
            ],
        };
    }
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
            title: overlay.clearingStopped === true ? "Clear stopped session" : `Confirm ${overlay.action.toUpperCase()}`,
            rows: [
                { text: overlay.sessionId },
                { text: "Press y/Enter to confirm; n/Escape to cancel.", emphasis: true },
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
