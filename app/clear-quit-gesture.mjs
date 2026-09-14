/**
 * Pi's two-press Ctrl+C: one press clears the editor, a second inside the window quits the frontend.
 *
 * The window is strict, as Pi's own `handleCtrlC` is, and an unarmed gesture holds no instant at
 * all: a clock a test pins to zero must still read the first press as a clear rather than a quit.
 */
export class ClearQuitGesture {
    constructor({ now = Date.now, windowMs = 500 } = {}) {
        this.now = now;
        this.windowMs = windowMs;
        /** @type {number | undefined} */
        this.armedAt = undefined;
    }
    cancel() { this.armedAt = undefined; }
    /** Report what this press does, arming the quit when it only clears. @returns {"clear" | "quit"} */
    press() {
        const at = this.now();
        if (this.armedAt !== undefined && at - this.armedAt < this.windowMs) {
            this.armedAt = undefined;
            return "quit";
        }
        this.armedAt = at;
        return "clear";
    }
}
