import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { JOBWATCH_ANSI, jobwatchTheme } from "./dashboard-theme.mjs";
import { markPromptCursor, normalizePromptCursor } from "./prompt-cursor.mjs";
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
/** The prompt marker, and the column its continuation rows line up under. */
const PROMPT_MARKER = " \u276f ";

function markWrappedPromptCursor(text, rows, cursorIndex, width) {
    const cursor = normalizePromptCursor(text, cursorIndex);
    const marked = [...rows];
    let sourceOffset = 0;
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const rowStart = text.indexOf(row, sourceOffset);
        if (rowStart < 0)
            break;
        const rowEnd = rowStart + row.length;
        if (cursor < rowStart) {
            const previous = index - 1;
            if (previous >= 0 && visibleWidth(marked[previous]) < width) {
                marked[previous] += jobwatchTheme.promptCursor(" ");
                return marked;
            }
            marked[index] = `${jobwatchTheme.promptCursor(" ")}${row}`;
            return marked;
        }
        if (cursor < rowEnd) {
            marked[index] = markPromptCursor(row, cursor - rowStart, (value) => jobwatchTheme.promptCursor(value));
            return marked;
        }
        sourceOffset = rowEnd;
    }
    const last = marked.length - 1;
    if (last >= 0 && visibleWidth(marked[last]) < width)
        marked[last] += jobwatchTheme.promptCursor(" ");
    else
        marked.push(jobwatchTheme.promptCursor(" "));
    return marked;
}
/**
 * How tall the prompt box may grow, copied from pi-tui's Editor: it shows max(5, 30% of the
 * terminal) and scrolls past that, so the dashboard's prompt reaches the same bound Pi's does.
 */
const PROMPT_MIN_ROWS = 5;
const PROMPT_HEIGHT_FRACTION = 0.3;
/**
 * Wrap one draft into the rows the prompt box would paint, marker included.
 *
 * Wrapping is pi-tui's own `wrapTextWithAnsi`: word boundaries first, graphemes when a single word
 * is wider than the box, so a wide character is never split across a cell.
 * @param {string} draft @param {number} width @param {number} [cursorIndex]
 * @returns {string[]} One string per row, each already indented under the marker.
 */
export function wrapPromptDraft(draft, width, cursorIndex) {
    const indent = visibleWidth(PROMPT_MARKER);
    const usable = Math.max(1, normalizedDimension(width) - indent);
    const safe = plainText(String(draft));
    const wrapped = wrapTextWithAnsi(safe, usable);
    const marked = cursorIndex === undefined ? wrapped : markWrappedPromptCursor(safe, wrapped, cursorIndex, usable);
    return marked.map((text, index) => `${index === 0 ? PROMPT_MARKER : " ".repeat(indent)}${text}`);
}
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
/**
 * Compute responsive dashboard columns and the bounded list viewport.
 * @param {number} width @param {number} height
 * @param {{ promptRows?: number }} [options] Rows the current draft needs; the dock grows into the list to hold them.
 */
export function createDashboardLayout(width, height, options = {}) {
    const normalizedWidth = normalizedDimension(width);
    const normalizedHeight = normalizedDimension(height);
    // Title, working directory, section border, column header. The context line sits in the dock.
    const listTop = Math.min(normalizedHeight >= 12 ? 4 : 3, normalizedHeight);
    // Border, prompt, closing rule, status, context. A short terminal drops the rule for a list row.
    const baseDockRows = normalizedHeight >= 12 ? 5 : 4;
    const baseListHeight = Math.max(0, normalizedHeight - listTop - baseDockRows);
    // The box stops at Pi's own cap, and never at the cost of the list's last row.
    const cap = Math.max(PROMPT_MIN_ROWS, Math.floor(normalizedHeight * PROMPT_HEIGHT_FRACTION));
    const promptRows = Math.min(Math.max(1, normalizedDimension(options.promptRows ?? 1)), cap, Math.max(1, baseListHeight));
    const dockRows = baseDockRows + promptRows - 1;
    return {
        width: normalizedWidth,
        height: normalizedHeight,
        density: densityForWidth(normalizedWidth),
        listTop,
        promptRows,
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
    const background = JOBWATCH_ANSI.defaultBackground;
    return joinCells(layout, values, (key, text) => {
        if (key === "state")
            return jobwatchTheme.state(session, text, selected, background);
        if (key === "age")
            return jobwatchTheme.muted(text, selected, background);
        if (key === "name") {
            // A colour marks the name, not the column: fill behind the text and leave the padding alone.
            const label = text.trimEnd();
            return jobwatchTheme.name(label, selected, session.color, background) + jobwatchTheme.text(text.slice(label.length), selected, background);
        }
        return jobwatchTheme.text(text, selected, background);
    }, (text) => jobwatchTheme.separator(text, selected, background));
}
/** The end of `text` that fits `width` cells: for a path, the part that tells two directories apart. */
function keepEnd(text, width) {
    let kept = "";
    for (const character of [...text].reverse()) {
        if (visibleWidth(character + kept) > width) break;
        kept = character + kept;
    }
    return kept;
}
/** Render an unselectable group row: a full-width divider naming the group and how many rows it holds. */
export function renderGroupHeader(label, count, layout) {
    const suffix = ` (${count}) `;
    const room = Math.max(1, layout.width - visibleWidth("── ") - visibleWidth(suffix) - 1);
    const text = plainText(label);
    const shown = visibleWidth(text) > room ? `…${keepEnd(text, room - 1)}` : text;
    const head = `── ${shown}${suffix}`;
    return jobwatchTheme.group(fit(head + "─".repeat(Math.max(0, layout.width - visibleWidth(head))), layout.width));
}
