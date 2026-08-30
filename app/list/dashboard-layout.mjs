import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { jobwatchTheme } from "./dashboard-theme.mjs";
import { spinnerFrame } from "../spinner.mjs";
import { displaySessionState } from "./session-state.mjs";
const COLUMN_LABELS = {
    name: "NAME",
    spinner: "",
    state: "STATE",
    activity: "ACTIVITY",
    model: "MODEL",
    age: "AGE",
};
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
function plainText(value) {
    return stripVTControlCharacters(value).replace(CONTROL_CHARACTERS, " ");
}
function fit(value, width) {
    const safe = plainText(value);
    const clipped = truncateToWidth(safe, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
function normalizedDimension(value) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
function densityForWidth(width) {
    if (width >= 100)
        return "full";
    if (width >= 52)
        return "compact";
    return "minimal";
}
/** Wide enough for a model id such as claude-opus-5 or gpt-5.6-sol. */
const MODEL_WIDTH = 16;
function columnsForWidth(width) {
    if (width <= 0)
        return [];
    if (width >= 72) {
        return [
            { key: "spinner", width: 1 },
            { key: "name", width: width >= 100 ? 32 : 26 },
            { key: "state", width: 9 },
            { key: "activity", width: width - (width >= 100 ? 54 : 48) - MODEL_WIDTH - 1 },
            { key: "model", width: MODEL_WIDTH },
            { key: "age", width: 7 },
        ];
    }
    if (width >= 52) {
        return [
            { key: "spinner", width: 1 },
            { key: "name", width: 18 },
            { key: "state", width: 8 },
            { key: "activity", width: width - 37 },
            { key: "age", width: 6 },
        ];
    }
    if (width >= 28) {
        return [
            { key: "spinner", width: 1 },
            { key: "name", width: 10 },
            { key: "state", width: 8 },
            { key: "activity", width: width - 23 },
        ];
    }
    if (width >= 12) {
        return [
            { key: "name", width: 8 },
            { key: "activity", width: width - 9 },
        ];
    }
    return [{ key: "activity", width }];
}
/** Compute responsive dashboard columns and the bounded list viewport. */
export function createDashboardLayout(width, height) {
    const normalizedWidth = normalizedDimension(width);
    const normalizedHeight = normalizedDimension(height);
    // Title, working directory, section border, column header. The context line sits in the dock.
    const listTop = Math.min(normalizedHeight >= 12 ? 4 : 3, normalizedHeight);
    // Border, prompt, closing rule, status, context. A short terminal drops the rule for a list row.
    const dockRows = normalizedHeight >= 12 ? 5 : 4;
    return {
        width: normalizedWidth,
        height: normalizedHeight,
        density: densityForWidth(normalizedWidth),
        listTop,
        dockRows,
        listHeight: Math.max(0, normalizedHeight - listTop - dockRows),
        columns: columnsForWidth(normalizedWidth),
    };
}
function joinCells(layout, values, paintCell, paintSeparator) {
    const cells = layout.columns.map((column) => paintCell(column.key, fit(values[column.key], column.width)));
    return truncateToWidth(cells.join(paintSeparator(" ")), layout.width, "");
}
/** Render one responsive, width-safe table header. */
export function renderColumnHeader(layout) {
    return joinCells(layout, COLUMN_LABELS, (_key, text) => jobwatchTheme.header(text), (text) => jobwatchTheme.header(text));
}
/** How long the session has existed. Last-activity age reads as "0m" for a day-old session that just replied. */
function age(createdAt, now) {
    const updated = Date.parse(createdAt);
    if (!Number.isFinite(updated))
        return "—";
    const seconds = Math.max(0, Math.floor((now - updated) / 1_000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48)
        return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 14)
        return `${days}d`;
    return `${Math.floor(days / 7)}w`;
}
function sessionValues(session, now) {
    return {
        name: (session.name ?? "").trim() || truncateToWidth(plainText(session.sessionId), 8, ""),
        spinner: displaySessionState(session) === "WORKING" ? spinnerFrame(now) : "",
        state: displaySessionState(session),
        age: age(session.createdAt, now),
        activity: (session.summary?.text ?? session.activity.summary).trim() || "—",
        model: session.model?.id ?? "—",
    };
}
/** Render one dense session row without allocating a component per session. */
export function renderSessionRow(session, layout, options) {
    const selected = options.selected ?? false;
    const values = sessionValues(session, options.now);
    return joinCells(layout, values, (key, text) => {
        if (key === "state")
            return jobwatchTheme.state(session, text, selected);
        if (key === "age")
            return jobwatchTheme.muted(text, selected);
        if (key === "name") {
            // A colour marks the name, not the column: fill behind the text and leave the padding alone.
            const label = text.trimEnd();
            return jobwatchTheme.name(label, selected, session.color) + jobwatchTheme.text(text.slice(label.length), selected);
        }
        return jobwatchTheme.text(text, selected);
    }, (text) => jobwatchTheme.separator(text, selected));
}
/** Render an unselectable group row that occupies one virtual list position. */
export function renderGroupHeader(label, count, layout) {
    return jobwatchTheme.group(fit(`── ${plainText(label)} (${count}) `, layout.width));
}
