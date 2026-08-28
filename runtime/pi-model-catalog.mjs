/** Read Pi's own model catalog, so pickers offer what Pi will actually accept. */

const MAX_MODELS = 2_000;

/**
 * Parse `pi --list-models` output. The table is `provider model context max-out thinking images`,
 * with a header row; anything that does not start with two non-space columns is ignored.
 * @param {string} output
 * @returns {{ provider: string, id: string, thinking: boolean }[]}
 */
export function parseModelCatalog(output) {
  const models = [];
  for (const line of String(output).split("\n")) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 3 || columns[0] === "provider" || line.startsWith(" ")) continue;
    const [provider, id, , , thinking] = columns;
    if (provider === undefined || id === undefined || id === "model") continue;
    models.push({ provider, id, thinking: thinking === "yes" });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/**
 * Ask the installed Pi for its catalog once and cache it. Listing models runs no inference and
 * spends nothing, but it does spawn a process, so a dashboard opening a picker must not pay for it
 * twice.
 * @param {{ executable: string, spawn: Function, env?: Record<string, string | undefined>, timeoutMs?: number }} options
 */
export function createModelCatalog({ executable, spawn, env, timeoutMs = 10_000 }) {
  let cached;
  return {
    async models() {
      cached ??= (async () => {
        const output = await new Promise((resolve, reject) => {
          const child = spawn(executable, ["--list-models"], { stdio: ["ignore", "pipe", "pipe"], env, shell: false });
          let stdout = "";
          const timer = setTimeout(() => { child.kill?.("SIGKILL"); reject(Object.assign(new Error("Listing Pi models timed out"), { code: "MODEL_CATALOG_TIMEOUT" })); }, timeoutMs);
          timer.unref?.();
          child.stdout?.on("data", (/** @type {any} */ chunk) => { stdout += String(chunk); });
          child.once("error", (/** @type {any} */ error) => { clearTimeout(timer); reject(error); });
          child.once("exit", (/** @type {any} */ code) => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout);
            else reject(Object.assign(new Error(`Listing Pi models exited ${code}`), { code: "MODEL_CATALOG_FAILED" }));
          });
        });
        return parseModelCatalog(output);
      })().catch((error) => { cached = undefined; throw error; });
      return cached;
    },
  };
}
