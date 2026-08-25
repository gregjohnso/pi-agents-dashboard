export const JOBWATCH_ANSI = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    blackBackground: "\x1b[48;2;0;0;0m",
    surfaceBackground: "\x1b[48;2;9;9;11m",
    selectionBackground: "\x1b[48;2;39;39;42m",
    text: "\x1b[38;2;228;228;231m",
    sky: "\x1b[38;2;56;189;248m",
    cyan: "\x1b[38;2;34;211;238m",
    green: "\x1b[38;2;74;222;128m",
    amber: "\x1b[38;2;251;191;36m",
    rose: "\x1b[38;2;251;113;133m",
    gray: "\x1b[38;2;113;113;122m",
};
function paint(text, foreground, selected, background = JOBWATCH_ANSI.blackBackground) {
    const rowBackground = selected ? JOBWATCH_ANSI.selectionBackground : background;
    return `${rowBackground}${foreground}${text}${JOBWATCH_ANSI.reset}`;
}
function stateColor(session) {
    if (session.taskState === "FAILED" || session.processState === "STALE")
        return JOBWATCH_ANSI.rose;
    if (session.taskState === "WORKING")
        return JOBWATCH_ANSI.green;
    if (session.taskState === "WAITING")
        return JOBWATCH_ANSI.amber;
    if (session.taskState === "STOPPED"
        || session.outcome !== "NONE"
        || session.processState === "EXITED") {
        return JOBWATCH_ANSI.gray;
    }
    return JOBWATCH_ANSI.sky;
}
/** Fixed Jobwatch-style colors used by the raw dashboard renderer. */
export const jobwatchTheme = {
    header(text) {
        return paint(text, `${JOBWATCH_ANSI.bold}${JOBWATCH_ANSI.sky}`, false, JOBWATCH_ANSI.surfaceBackground);
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
    muted(text, selected) {
        return paint(text, JOBWATCH_ANSI.gray, selected);
    },
    separator(text, selected) {
        return paint(text, JOBWATCH_ANSI.text, selected);
    },
};
