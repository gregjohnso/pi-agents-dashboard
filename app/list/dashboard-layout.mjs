import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { jobwatchTheme } from "./dashboard-theme.mjs";
const COLUMN_LABELS = {
    id: "ID",
    name: "NAME",
    state: "STATE",
    activity: "ACTIVITY",
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
function columnsForWidth(width) {
    if (width <= 0)
        return [];
    if (width >= 72) {
        return [
            { key: "id", width: 10 },
            { key: "name", width: width >= 100 ? 28 : 22 },
            { key: "state", width: 9 },
            { key: "activity", width: width - (width >= 100 ? 51 : 45) },
        ];
    }
    if (width >= 52) {
        return [
            { key: "id", width: 9 },
            { key: "name", width: 14 },
            { key: "state", width: 8 },
            { key: "activity", width: width - 34 },
        ];
    }
    if (width >= 28) {
        return [
            { key: "id", width: 9 },
            { key: "state", width: 8 },
            { key: "activity", width: width - 19 },
        ];
    }
    if (width >= 12) {
        return [
            { key: "id", width: 8 },
            { key: "activity", width: width - 9 },
        ];
    }
    return [{ key: "activity", width }];
}
/** Compute responsive dashboard columns and the bounded list viewport. */
export function createDashboardLayout(width, height) {
    const normalizedWidth = normalizedDimension(width);
    const normalizedHeight = normalizedDimension(height);
    const listTop = Math.min(5, normalizedHeight);
    return {
        width: normalizedWidth,
        height: normalizedHeight,
        density: densityForWidth(normalizedWidth),
        listTop,
        listHeight: Math.max(0, normalizedHeight - listTop - 4),
        columns: columnsForWidth(normalizedWidth),
    };
}
function joinCells(layout, values, paintCell, paintSeparator) {
    const cells = layout.columns.map((column) => paintCell(column.key, fit(values[column.key], column.width)));
    return truncateToWidth(cells.join(paintSeparator(" ")), layout.width, "");
}
/** Render one responsive, width-safe table header. */
export function renderColumnHeader(layout, theme = jobwatchTheme) {
    const values = COLUMN_LABELS;
    return joinCells(layout, values, (_key, text) => theme.header(text), (text) => theme.header(text));
}
function age(updatedAt, now) {
    const updated = Date.parse(updatedAt);
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
function liveness(session) {
    switch (session.processState) {
        case "LIVE":
            return "▶";
        case "SLEEPING":
            return "◌";
        case "STALE":
            return "×";
        case "EXITED":
            return " ";
    }
}
function sessionValues(session, now) {
    return {
        id: `${liveness(session)} ${truncateToWidth(plainText(session.sessionId), 8, "")}`,
        name: (session.name ?? "").trim() || "—",
        state: session.taskState,
        age: age(session.updatedAt, now),
        activity: (session.summary?.text ?? session.activity.summary).trim() || "—",
    };
}
/** Render one dense session row without allocating a component per session. */
export function renderSessionRow(session, layout, options) {
    const selected = options.selected ?? false;
    const theme = options.theme ?? jobwatchTheme;
    const values = sessionValues(session, options.now);
    return joinCells(layout, values, (key, text) => {
        if (key === "id")
            return theme.id(text, selected);
        if (key === "state")
            return theme.state(session, text, selected);
        if (key === "age")
            return theme.muted(text, selected);
        return theme.text(text, selected);
    }, (text) => theme.separator(text, selected));
}
/** Render an unselectable group row that occupies one virtual list position. */
export function renderGroupHeader(label, count, layout, theme = jobwatchTheme) {
    return theme.group(fit(`── ${plainText(label)} (${count}) `, layout.width));
}
