/** Exact two-press Left/Escape return gesture for edited or history-browsing editors. */
export class ReturnGesture {
  constructor({ now = Date.now, onReturn, windowMs = 500 }) {
    this.now = now;
    this.onReturn = onReturn;
    this.windowMs = windowMs;
    this.armed = undefined;
  }
  cancel() { this.armed = undefined; }
  cancelForInput(key) {
    if (this.armed !== undefined && this.armed.key !== key) this.cancel();
  }
  handle(key, { clean, overlayCaptured }) {
    const current = this.now();
    if (overlayCaptured) { this.cancel(); return "captured"; }
    if (clean) { this.cancel(); this.onReturn(); return "returned"; }
    if (this.armed?.key === key && current - this.armed.at <= this.windowMs) {
      this.cancel(); this.onReturn(); return "returned";
    }
    this.armed = { key, at: current };
    return "armed";
  }
}
