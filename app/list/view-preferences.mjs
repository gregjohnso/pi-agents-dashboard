import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteJson } from "../../runtime/atomic-file.mjs";

/** The dashboard's remembered view, beside its other metadata. Written only when the operator changes it. */
const FILE = "dashboard-view.json";
/** @typedef {{ groupBy: "taskState" | "cwd" | undefined }} ViewPreferences */
/** @type {readonly ("taskState" | "cwd")[]} */
const GROUPINGS = ["taskState", "cwd"];
/** Claude Code's agent view opens grouped by state. @type {ViewPreferences} */
const DEFAULT = { groupBy: "taskState" };

/** @param {string} stateHome @returns {Promise<ViewPreferences>} */
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

/** Claude Code keeps pins in its own file; so does this, keyed by durable owner id. */
const PINS_FILE = "pins.json";

/** @param {string} stateHome @returns {Promise<string[]>} */
export async function readPins(stateHome) {
  try {
    const saved = JSON.parse(await readFile(path.join(stateHome, PINS_FILE), "utf8"));
    return saved?.version === 1 && Array.isArray(saved.pins) ? saved.pins.filter((/** @type {unknown} */ key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/** @param {string} stateHome @param {string[]} pins */
export async function writePins(stateHome, pins) {
  await atomicWriteJson(path.join(stateHome, PINS_FILE), { version: 1, pins });
}

/** @param {string} stateHome @param {{ groupBy: string | undefined }} preferences */
export async function writeViewPreferences(stateHome, { groupBy }) {
  await atomicWriteJson(path.join(stateHome, FILE), { version: 1, groupBy: groupBy ?? null });
}
