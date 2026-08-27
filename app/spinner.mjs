/** Pi's status spinner, shared by the viewer's status line and the session list's STATE cell. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 80;

/** Return the spinner frame for a monotonic millisecond reading. @param {number} now */
export function spinnerFrame(now) {
    return FRAMES[Math.floor(Math.max(0, now) / SPINNER_INTERVAL_MS) % FRAMES.length];
}
