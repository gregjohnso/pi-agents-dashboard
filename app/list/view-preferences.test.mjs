import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { readViewPreferences, writeViewPreferences } from "./view-preferences.mjs";

const cleanup = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function home() {
  const directory = await mkdtemp(path.join(tmpdir(), "pia-view-"));
  cleanup.push(directory);
  return directory;
}

it("defaults to grouping by state when nothing was saved or the file is unreadable", async () => {
  const directory = await home();
  expect(await readViewPreferences(directory)).toEqual({ groupBy: "taskState" });
  await writeFile(path.join(directory, "dashboard-view.json"), "{not json");
  expect(await readViewPreferences(directory)).toEqual({ groupBy: "taskState" });
  await writeFile(path.join(directory, "dashboard-view.json"), JSON.stringify({ version: 1, groupBy: "model" }));
  expect(await readViewPreferences(directory)).toEqual({ groupBy: "taskState" });
});

it("keeps the grouping chosen last, including no grouping at all", async () => {
  const directory = await home();
  await writeViewPreferences(directory, { groupBy: "cwd" });
  expect(await readViewPreferences(directory)).toEqual({ groupBy: "cwd" });
  expect(JSON.parse(await readFile(path.join(directory, "dashboard-view.json"), "utf8"))).toEqual({ version: 1, groupBy: "cwd" });
  await writeViewPreferences(directory, { groupBy: undefined });
  expect(await readViewPreferences(directory)).toEqual({ groupBy: undefined });
});
