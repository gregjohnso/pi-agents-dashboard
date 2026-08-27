/** Two-press Ctrl+X gesture: one press stops a session, a second soon after clears it. */
export class StopClearGesture {
  constructor({ now = Date.now, windowMs = 500 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.armed = undefined;
  }
  cancel() { this.armed = undefined; }
  /** Arm the clear press only once a stop has actually landed for this session. */
  armAfterStop(sessionId) {
    this.armed = { sessionId, at: this.now() };
  }
  armedFor(sessionId) {
    return this.armed !== undefined &&
      this.armed.sessionId === sessionId &&
      this.now() - this.armed.at <= this.windowMs;
  }
  /** Report whether the next press clears, consuming the gesture either way. */
  pressWouldClear(sessionId) {
    const clears = this.armedFor(sessionId);
    this.cancel();
    return clears;
  }
}
