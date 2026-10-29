import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * What a new session launches with when the composer chose nothing, from the metadata home's settings.json:
 * `{ "version": 1, "defaultModel": "provider/id" }`. Anything absent or unusable leaves the choice to Pi.
 * @param {string} stateHome @returns {Promise<{ model: { provider: string, id: string } | undefined }>}
 */
export async function readLaunchSettings(stateHome) {
  try {
    const settings = JSON.parse(await readFile(path.join(stateHome, "settings.json"), "utf8"));
    if (settings?.version !== 1 || typeof settings.defaultModel !== "string") return { model: undefined };
    const slash = settings.defaultModel.indexOf("/");
    const provider = settings.defaultModel.slice(0, slash);
    const id = settings.defaultModel.slice(slash + 1);
    return slash > 0 && id !== "" ? { model: { provider, id } } : { model: undefined };
  } catch {
    return { model: undefined };
  }
}
