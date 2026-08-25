import { AsyncLocalStorage } from "node:async_hooks";

/** Serialize asynchronous operations by key without retaining idle queues. */
export class SessionCoordinator {
  #queues = new Map();
  #active = new AsyncLocalStorage();

  get size() {
    return this.#queues.size;
  }

  async idle() {
    while (this.#queues.size > 0) {
      await Promise.allSettled([...this.#queues.values()].map((entry) => entry.tail));
    }
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
    return this.#run(key, operation, false);
  }

  /** Run an explicitly nested operation within the caller's active key. @template Result @param {string} key @param {() => Promise<Result> | Result} operation @returns {Promise<Result>} */
  runNested(key, operation) {
    return this.#run(key, operation, true);
  }

  /** @template Result @param {string} key @param {() => Promise<Result> | Result} operation @param {boolean} nested @returns {Promise<Result>} */
  #run(key, operation, nested) {
    if (typeof key !== "string" || key.length === 0) {
      return Promise.reject(new TypeError("Coordination key must be a non-empty string"));
    }
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("Coordinated operation must be a function"));
    }

    const active = this.#active.getStore();
    if (nested && active?.coordinator === this && active.live && active.keys.has(key)) {
      return Promise.resolve().then(operation);
    }

    const previous = this.#queues.get(key)?.tail ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => {
      const state = { coordinator: this, live: true, keys: new Set([...(active?.coordinator === this && active.live ? active.keys : []), key]) };
      return this.#active.run(state, async () => {
        try {
          return await operation();
        } finally {
          state.live = false;
        }
      });
    });
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
