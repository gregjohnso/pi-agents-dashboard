import { displaySessionState } from "./session-state.mjs";

export const JOBWATCH_ANSI = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    inverse: "\x1b[7m",
    inverseOff: "\x1b[27m",
    defaultBackground: "\x1b[49m",
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
    black: "\x1b[38;2;0;0;0m",
};
/** session-color's names, as the xterm-256 hues it paints the editor border with. */
const SESSION_TINTS = {
    red: "255;95;95", blue: "95;175;255", green: "95;215;135", yellow: "215;175;95",
    purple: "175;135;255", orange: "215;135;95", pink: "255;135;215", cyan: "95;215;215",
};
/** Turn a palette foreground, or a session-color name, into the matching background fill. */
function backgroundFor(color) {
    if (Object.hasOwn(SESSION_TINTS, color))
        return `\x1b[48;2;${SESSION_TINTS[color]}m`;
    return JOBWATCH_ANSI[color].replace("[38;2;", "[48;2;");
}
function paint(text, foreground, selected, background = JOBWATCH_ANSI.blackBackground) {
    const rowBackground = selected ? JOBWATCH_ANSI.selectionBackground : background;
    // Selection adds weight only, so the row keeps the colors that carry its meaning.
    return `${rowBackground}${foreground}${selected ? JOBWATCH_ANSI.bold : ""}${text}${JOBWATCH_ANSI.reset}`;
}
function stateColor(session) {
    switch (displaySessionState(session)) {
        case "FAILED":
        case "STALE":
            return JOBWATCH_ANSI.rose;
        case "WORKING":
            return JOBWATCH_ANSI.green;
        case "WAITING":
        case "NEEDS INPUT":
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
    focusBorder(text, background = JOBWATCH_ANSI.blackBackground) {
        return paint(text, JOBWATCH_ANSI.sky, false, background);
    },
    inactiveBorder(text, background = JOBWATCH_ANSI.blackBackground) {
        return paint(text, JOBWATCH_ANSI.gray, false, background);
    },
    overlayBorder(text) {
        return paint(text, JOBWATCH_ANSI.sky, false, JOBWATCH_ANSI.surfaceBackground);
    },
    overlayText(text) {
        return paint(text, JOBWATCH_ANSI.text, false, JOBWATCH_ANSI.surfaceBackground);
    },
    /** A dimmed block over one character: the cursor at rest, not a selection. */
    placeholderCursor(text) {
        return `${JOBWATCH_ANSI.selectionBackground}${JOBWATCH_ANSI.gray}${text}${JOBWATCH_ANSI.reset}`;
    },
    promptCursor(text) {
        return `${JOBWATCH_ANSI.inverse}${text}${JOBWATCH_ANSI.inverseOff}`;
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
    state(session, text, selected, background = JOBWATCH_ANSI.blackBackground) {
        return paint(text, stateColor(session), selected, background);
    },
    text(text, selected, background = JOBWATCH_ANSI.blackBackground) {
        return paint(text, JOBWATCH_ANSI.text, selected, background);
    },
    name(text, selected, color, background = JOBWATCH_ANSI.blackBackground) {
        if (color === undefined)
            return paint(text, JOBWATCH_ANSI.text, selected, background);
        // A colour is a label the operator chose, so selection must not repaint it. The row keeps the
        // colour behind black text either way; selection adds weight only.
        const bold = selected ? JOBWATCH_ANSI.bold : "";
        return `${backgroundFor(color)}${JOBWATCH_ANSI.black}${bold}${text}${JOBWATCH_ANSI.reset}`;
    },
    muted(text, selected, background = JOBWATCH_ANSI.blackBackground) {
        return paint(text, JOBWATCH_ANSI.gray, selected, background);
    },
    separator(text, selected, background = JOBWATCH_ANSI.blackBackground) {
        return paint(text, JOBWATCH_ANSI.text, selected, background);
    },
};
