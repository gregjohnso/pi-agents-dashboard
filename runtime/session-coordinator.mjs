/** Serialize asynchronous operations by key without retaining idle queues. */
export class SessionCoordinator {
  #queues = new Map();

  get size() {
    return this.#queues.size;
  }

  /**
   * Run one operation after earlier operations for the same key.
   *
   * @template Result
   * @param {string} key
   * @param {() => Promise<Result> | Result} operation
   * @returns {Promise<Result>}
   */
  run(key, operation) {
    if (typeof key !== "string" || key.length === 0) {
      return Promise.reject(new TypeError("Coordination key must be a non-empty string"));
    }
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("Coordinated operation must be a function"));
    }

    const previous = this.#queues.get(key)?.tail ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.catch(() => {});
    const entry = { tail };
    this.#queues.set(key, entry);
    void tail.finally(() => {
      if (this.#queues.get(key) === entry) {
        this.#queues.delete(key);
      }
    });
    return result;
  }
}
