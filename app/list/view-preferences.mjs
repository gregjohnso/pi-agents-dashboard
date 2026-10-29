import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteJson } from "../../runtime/atomic-file.mjs";

/** The dashboard's remembered view, beside its other metadata. Written only when the operator changes it. */
const FILE = "dashboard-view.json";
const GROUPINGS = ["taskState", "cwd"];
/** Claude Code's agent view opens grouped by state. */
const DEFAULT = { groupBy: "taskState" };

/** @param {string} stateHome @returns {Promise<{ groupBy: "taskState" | "cwd" | undefined }>} */
export async function readViewPreferences(stateHome) {
  try {
    const saved = JSON.parse(await readFile(path.join(stateHome, FILE), "utf8"));
    if (saved?.version !== 1) return { ...DEFAULT };
    if (saved.groupBy === null) return { groupBy: undefined };
    return GROUPINGS.includes(saved.groupBy) ? { groupBy: saved.groupBy } : { ...DEFAULT };
  } catch {
    return { ...DEFAULT };
  }
}

/** @param {string} stateHome @param {{ groupBy: string | undefined }} preferences */
export async function writeViewPreferences(stateHome, { groupBy }) {
  await atomicWriteJson(path.join(stateHome, FILE), { version: 1, groupBy: groupBy ?? null });
}
