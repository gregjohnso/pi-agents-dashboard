import { displaySessionState } from "./session-state.mjs";

export const JOBWATCH_ANSI = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    blackBackground: "\x1b[48;2;0;0;0m",
    surfaceBackground: "\x1b[48;2;17;17;17m",
    headerBackground: "\x1b[48;2;2;132;199m",
    selectionBackground: "\x1b[48;2;54;54;54m",
    text: "\x1b[38;2;255;255;255m",
    sky: "\x1b[38;2;125;211;252m",
    cyan: "\x1b[38;2;125;211;252m",
    green: "\x1b[38;2;110;231;183m",
    amber: "\x1b[38;2;252;211;77m",
    rose: "\x1b[38;2;253;164;175m",
    gray: "\x1b[38;2;136;136;136m",
};
function paint(text, foreground, selected, background = JOBWATCH_ANSI.blackBackground) {
    const rowBackground = selected ? JOBWATCH_ANSI.selectionBackground : background;
    return `${rowBackground}${foreground}${text}${JOBWATCH_ANSI.reset}`;
}
function stateColor(session) {
    switch (displaySessionState(session)) {
        case "FAILED":
        case "STALE":
            return JOBWATCH_ANSI.rose;
        case "WORKING":
            return JOBWATCH_ANSI.green;
        case "WAITING":
            return JOBWATCH_ANSI.amber;
        case "STARTING":
            return JOBWATCH_ANSI.cyan;
        case "EXITED":
        case "STOPPED":
        case "SLEEPING":
            return JOBWATCH_ANSI.gray;
        default:
            return JOBWATCH_ANSI.sky;
    }
}
/** Fixed Jobwatch-style colors used by the raw dashboard renderer. */
export const jobwatchTheme = {
    title(text) {
        return paint(text, `${JOBWATCH_ANSI.bold}${JOBWATCH_ANSI.text}`, false, JOBWATCH_ANSI.headerBackground);
    },
    surface(text) {
        return paint(text, JOBWATCH_ANSI.text, false, JOBWATCH_ANSI.surfaceBackground);
    },
    keyHints(text) {
        return paint(text, JOBWATCH_ANSI.gray, false, JOBWATCH_ANSI.surfaceBackground);
    },
    focusBorder(text) {
        return paint(text, JOBWATCH_ANSI.sky, false);
    },
    inactiveBorder(text) {
        return paint(text, JOBWATCH_ANSI.gray, false);
    },
    panel(text, focused) {
        return paint(text, JOBWATCH_ANSI.text, focused);
    },
    overlayBorder(text) {
        return paint(text, JOBWATCH_ANSI.sky, false, JOBWATCH_ANSI.surfaceBackground);
    },
    overlayTitle(text) {
        return paint(text, `${JOBWATCH_ANSI.bold}${JOBWATCH_ANSI.text}`, false, JOBWATCH_ANSI.surfaceBackground);
    },
    overlayText(text) {
        return paint(text, JOBWATCH_ANSI.text, false, JOBWATCH_ANSI.surfaceBackground);
    },
    overlayMuted(text) {
        return paint(text, JOBWATCH_ANSI.gray, false, JOBWATCH_ANSI.surfaceBackground);
    },
    error(text) {
        return paint(text, JOBWATCH_ANSI.rose, false);
    },
    header(text) {
        return paint(text, `${JOBWATCH_ANSI.bold}${JOBWATCH_ANSI.gray}`, false, JOBWATCH_ANSI.surfaceBackground);
    },
    group(text) {
        return paint(text, JOBWATCH_ANSI.sky, false, JOBWATCH_ANSI.surfaceBackground);
    },
    id(text, selected) {
        return paint(text, JOBWATCH_ANSI.cyan, selected);
    },
    state(session, text, selected) {
        return paint(text, stateColor(session), selected);
    },
    text(text, selected) {
        return paint(text, JOBWATCH_ANSI.text, selected);
    },
    name(text, selected, color) {
        return paint(text, color === undefined ? JOBWATCH_ANSI.text : JOBWATCH_ANSI[color], selected);
    },
    muted(text, selected) {
        return paint(text, JOBWATCH_ANSI.gray, selected);
    },
    separator(text, selected) {
        return paint(text, JOBWATCH_ANSI.text, selected);
    },
};
