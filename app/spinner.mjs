/** Pi's status spinner, shared by the viewer's status line and the session list's STATE cell. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 80;

/** Return the spinner frame for a monotonic millisecond reading. @param {number} now */
export function spinnerFrame(now) {
    return FRAMES[Math.floor(Math.max(0, now) / SPINNER_INTERVAL_MS) % FRAMES.length];
}

/**
 * The repaint clock behind that frame, shared by the list and the viewer.
 *
 * `spinnerFrame` is a pure function of the clock, so a surface advances it only when something asks
 * for a repaint. A session whose model is thinking publishes nothing to repaint on for seconds at a
 * time. The timer is unreferenced and draws nothing itself.
 * @param {{ requestRender: () => unknown }} options
 */
export function createSpinnerClock({ requestRender }) {
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let timer;
    const stop = () => {
        if (timer === undefined)
            return;
        clearInterval(timer);
        timer = undefined;
    };
    return {
        /** Run while `active`, stop otherwise. Safe to call on every frame. @param {boolean} active */
        sync(active) {
            if (!active) {
                stop();
                return;
            }
            if (timer !== undefined)
                return;
            timer = setInterval(() => requestRender(), SPINNER_INTERVAL_MS);
            timer.unref?.();
        },
        stop,
    };
}
