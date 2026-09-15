/** Two-press Ctrl+X gesture: one press stops a session, a second soon after clears it. */
export class StopClearGesture {
  constructor({ now = Date.now, windowMs = 500 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.armed = undefined;
    /** The stop this gesture asked for and has not been answered about yet. @type {{ sessionId: string } | undefined} */
    this.pending = undefined;
  }
  /** Abandon whatever this gesture was holding: an armed clear, a stop it is still waiting on, or both. */
  cancel() { this.armed = undefined; this.pending = undefined; }
  /**
   * Record the stop one press asked for, and hand back the intent that must still be this gesture's
   * when the daemon answers.
   *
   * The answer can take seconds, and the operator is free to move on inside them. Anything that
   * cancels this gesture drops the intent, so a late answer arms nothing: it belongs to a press the
   * operator has already abandoned.
   * @param {string} sessionId
   */
  beginStop(sessionId) {
    this.pending = { sessionId };
    return this.pending;
  }
  /** Whether the answer now arriving belongs to the press this gesture is still holding. @param {any} intent */
  holds(intent) { return intent !== undefined && this.pending === intent; }
  /** The stop this gesture is waiting on, while it still is. */
  pendingSessionId() { return this.pending?.sessionId; }
  /** Arm the clear press only once a stop has actually landed for this session. */
  armAfterStop(sessionId) {
    this.pending = undefined;
    this.armed = { sessionId, at: this.now() };
  }
  armedFor(sessionId) {
    return this.armed !== undefined &&
      this.armed.sessionId === sessionId &&
      this.now() - this.armed.at <= this.windowMs;
  }
  /**
   * The session this gesture is holding, while it still is.
   *
   * A stopped row leaves a filtered list the moment the daemon publishes the stop, and the selection
   * lands on whatever is next. The identity armed here is what the second press means, so it cannot
   * become the neighbour's.
   */
  armedSessionId() {
    return this.armed !== undefined && this.armedFor(this.armed.sessionId) ? this.armed.sessionId : undefined;
  }
  /** Report whether the next press clears, consuming the gesture either way. */
  pressWouldClear(sessionId) {
    const clears = this.armedFor(sessionId);
    this.cancel();
    return clears;
  }
}
