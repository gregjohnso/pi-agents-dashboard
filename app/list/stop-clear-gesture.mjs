/** Stop and clear each require two taps for the same session and action. */
export class StopClearGesture {
  constructor({ now = Date.now, windowMs = 500 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.armed = undefined;
    this.pending = undefined;
  }
  cancel() { this.armed = undefined; this.pending = undefined; }
  beginStop(sessionId) {
    this.armed = undefined;
    this.pending = { sessionId };
    return this.pending;
  }
  holds(intent) { return intent !== undefined && this.pending === intent; }
  pendingSessionId() { return this.pending?.sessionId; }
  arm(sessionId, action) {
    this.pending = undefined;
    this.armed = { sessionId, action, at: this.now() };
  }
  armedFor(sessionId) {
    return this.armed !== undefined &&
      this.armed.sessionId === sessionId &&
      this.now() - this.armed.at <= this.windowMs;
  }
  armedSessionId() {
    return this.armed !== undefined && this.armedFor(this.armed.sessionId) ? this.armed.sessionId : undefined;
  }
  armedAction() {
    return this.armedSessionId() === undefined ? undefined : this.armed.action;
  }
  pressWouldAct(sessionId, action) {
    const acts = this.armedFor(sessionId) && this.armed.action === action;
    this.cancel();
    return acts;
  }
}
