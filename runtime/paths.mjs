import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Derive legacy and standalone roots from the same per-user XDG parents. @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function resolveDashboardRoots(env = process.env) {
  const home = env.HOME ?? homedir();
  const stateParent = env.XDG_STATE_HOME ?? join(home, ".local", "state");
  const legacyStateRoot = resolve(stateParent, "pi-agents-dashboard");
  const destinationStateRoot = resolve(env.PI_AGENTS_STATE_DIR ?? join(stateParent, "pi-agents"));
  return {
    legacyStateRoot,
    destinationStateRoot,
    legacyRuntimeRoot: legacyStateRoot,
    destinationRuntimeRoot: destinationStateRoot,
  };
}
