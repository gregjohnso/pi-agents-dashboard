import { homedir } from "node:os";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { dashboardGroupIdentity, } from "./dashboard-state.mjs";
import { createDashboardLayout, renderGroupHeader, renderSessionRow, } from "./dashboard-layout.mjs";
import { displaySessionState } from "./session-state.mjs";
const HOME = homedir();
function sessionSignature(session) {
    return JSON.stringify(session);
}
function groupLabel(session, groupBy) {
    if (session.pinned === true)
        return "PINNED";
    if (groupBy === "taskState")
        return displaySessionState(session);
    const cwd = session.cwd || "—";
    // The whole path, because two projects can share a last directory name.
    return cwd === HOME || cwd.startsWith(`${HOME}/`) ? `~${cwd.slice(HOME.length)}` : cwd;
}
function buildRows(sessions, groupBy) {
    if (groupBy === undefined) {
        return sessions.map((session) => ({
            kind: "session",
            key: `session:${session.sessionId}`,
            session,
            selectable: true,
        }));
    }
    const rows = [];
    let index = 0;
    while (index < sessions.length) {
        const session = sessions[index];
        const identity = dashboardGroupIdentity(session, groupBy);
        let end = index + 1;
        while (end < sessions.length
            && dashboardGroupIdentity(sessions[end], groupBy) === identity) {
            end += 1;
        }
        // One blank line between sections.
        if (rows.length > 0)
            rows.push({ kind: "gap", key: `gap:${groupBy}:${identity}:${index}`, selectable: false });
        rows.push({
            kind: "group",
            key: `group:${groupBy}:${identity}:${index}`,
            label: groupLabel(session, groupBy),
            count: end - index,
            selectable: false,
        });
        for (let sessionIndex = index; sessionIndex < end; sessionIndex += 1) {
            const session = sessions[sessionIndex];
            rows.push({
                kind: "session",
                key: `session:${session.sessionId}`,
                session,
                selectable: true,
            });
        }
        index = end;
    }
    return rows;
}
function firstSessionId(rows) {
    return rows.find((row) => row.kind === "session")?.session.sessionId;
}
function normalizedInteger(value) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
/** Virtualized session rows with ID-stable selection and per-session render caching. */
export class VirtualSessionList {
    sessions;
    groupBy;
    virtualRows;
    selectedId;
    now;
    renderRowOverride;
    rowCache = new Map();
    constructor(sessions, options = {}) {
        this.sessions = sessions;
        this.groupBy = options.groupBy;
        this.virtualRows = buildRows(sessions, this.groupBy);
        this.selectedId = firstSessionId(this.virtualRows);
        this.now = options.now ?? Date.now();
        this.renderRowOverride = options.renderRow;
    }
    get rows() {
        return this.virtualRows;
    }
    get selectedSessionId() {
        return this.selectedId;
    }
    get selectedRowIndex() {
        if (this.selectedId === undefined)
            return -1;
        return this.virtualRows.findIndex((row) => (row.kind === "session" && row.session.sessionId === this.selectedId));
    }
    selectSession(sessionId) {
        const exists = this.sessions.some((session) => session.sessionId === sessionId);
        if (!exists)
            return false;
        this.selectedId = sessionId;
        return true;
    }
    moveSelection(delta) {
        if (this.virtualRows.length === 0 || delta === 0)
            return;
        const direction = delta > 0 ? 1 : -1;
        let remaining = Math.abs(Math.trunc(delta));
        let index = this.selectedRowIndex;
        if (index < 0) {
            this.selectedId = firstSessionId(this.virtualRows);
            index = this.selectedRowIndex;
            remaining -= 1;
        }
        while (remaining > 0) {
            let candidate = index + direction;
            while (candidate >= 0 && candidate < this.virtualRows.length) {
                const row = this.virtualRows[candidate];
                if (row.kind === "session")
                    break;
                candidate += direction;
            }
            if (candidate < 0 || candidate >= this.virtualRows.length)
                break;
            index = candidate;
            remaining -= 1;
        }
        const row = this.virtualRows[index];
        if (row?.kind === "session")
            this.selectedId = row.session.sessionId;
    }
    setSessions(sessions, options) {
        const previousById = new Map(this.sessions.map((session) => [session.sessionId, session]));
        const nextById = new Map(sessions.map((session) => [session.sessionId, session]));
        let invalidated = 0;
        for (const [sessionId, cached] of this.rowCache) {
            const previous = previousById.get(sessionId);
            const next = nextById.get(sessionId);
            if (previous === undefined
                || next === undefined
                || cached.signature !== sessionSignature(next)) {
                this.rowCache.delete(sessionId);
                invalidated += 1;
            }
        }
        const previous = this.sessions;
        this.sessions = sessions;
        if (options !== undefined)
            this.groupBy = options.groupBy;
        this.virtualRows = buildRows(sessions, this.groupBy);
        if (this.selectedId === undefined || !nextById.has(this.selectedId)) {
            // Keep the cursor where it was: the row below moves up into the gap, or the row above takes it at the end.
            const at = previous.findIndex((session) => session.sessionId === this.selectedId);
            const neighbour = at < 0 ? undefined
                : previous.slice(at + 1).find((session) => nextById.has(session.sessionId))
                    ?? previous.slice(0, at).reverse().find((session) => nextById.has(session.sessionId));
            this.selectedId = neighbour?.sessionId ?? firstSessionId(this.virtualRows);
        }
        return { invalidated };
    }
    setNow(now) {
        if (this.now === now)
            return 0;
        this.now = now;
        const invalidated = this.rowCache.size;
        this.rowCache.clear();
        return invalidated;
    }
    renderViewport(viewport) {
        const offset = Math.min(normalizedInteger(viewport.offset), this.virtualRows.length);
        const height = normalizedInteger(viewport.height);
        const width = normalizedInteger(viewport.width);
        const end = Math.min(this.virtualRows.length, offset + height);
        const rendered = [];
        for (let index = offset; index < end; index += 1) {
            const row = this.virtualRows[index];
            const selected = row.kind === "session" && row.session.sessionId === this.selectedId;
            const line = row.kind === "session"
                ? this.renderSession(row, width, selected)
                : this.renderUncached(row, width, false);
            rendered.push({ index, row, line });
        }
        return rendered;
    }
    renderSession(row, width, selected) {
        const signature = sessionSignature(row.session);
        const cached = this.rowCache.get(row.session.sessionId);
        if (cached !== undefined
            && cached.signature === signature
            && cached.width === width
            && cached.selected === selected) {
            return cached.line;
        }
        const line = this.renderUncached(row, width, selected);
        this.rowCache.set(row.session.sessionId, { signature, width, selected, line });
        return line;
    }
    renderUncached(row, width, selected) {
        const line = this.renderRowOverride === undefined
            ? this.renderDefault(row, width, selected)
            : this.renderRowOverride(row, width, selected);
        return truncateToWidth(line, width, "");
    }
    renderDefault(row, width, selected) {
        if (row.kind === "gap")
            return "";
        const layout = createDashboardLayout(width, 1);
        return row.kind === "group"
            ? renderGroupHeader(row.label, row.count, layout)
            : renderSessionRow(row.session, layout, { now: this.now, selected });
    }
}
