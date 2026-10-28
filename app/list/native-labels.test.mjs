import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createNativeBackend } from "./native-backend.mjs";
import { createDashboardLayout, renderSessionRow } from "./dashboard-layout.mjs";
import { createSavedOwnerRecord, readSavedOwnerRecords, writeSavedOwnerSnapshot } from "../../examples/native-session-demo/saved-owner-record.mjs";

const cleanup = [];
afterEach(async () => { for (const end of cleanup.splice(0).reverse()) await end(); });
const OWNER = { pid: 123, startIdentity: "fixture-identity", processGroupId: 123 };
const FACTS = { sessionId: "pi-1", sessionName: "Pi confirmed", sessionFile: "/fixture/pi/session.jsonl", labelVersion: 1, labelStatus: "ready", labelDescription: "Repairs native labels", labelModelProvider: "configured", labelModelId: "haiku" };

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "pia-label-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const sessionsHome = path.join(home, "runtime");
  const root = path.join(sessionsHome, "session-1");
  const stateHome = path.join(home, "metadata");
  await mkdir(root, { recursive: true });
  const saved = await createSavedOwnerRecord({ recordsHome: stateHome, sessionId: "session-1", runtimeRoot: root });
  cleanup.push(() => saved.close());
  let facts = FACTS;
  const backend = () => {
    const b = createNativeBackend({ sessionsHome, stateHome, askControl: async () => ({ reachable: true, answer: { status: { owner: OWNER, durable: { ownerId: saved.ownerId }, bridge: { facts }, attachments: [] } } }) });
    cleanup.push(() => b.close());
    return b;
  };
  return { home, stateHome, saved, backend, setFacts: (next) => { facts = next; }, write: (sequence, next = facts) => writeSavedOwnerSnapshot(saved, { sequence, owner: OWNER, facts: next }) };
}

it("durably shows the description after dashboard detach/relaunch and a same-session owner reload", async () => {
  const f = await fixture();
  await f.write(1);
  const stored = JSON.parse(await readFile(f.saved.paths.record, "utf8"));
  expect(stored.labels).toMatchObject({ version: 1, sessionId: "pi-1", description: "Repairs native labels" });
  f.backend().close();
  const fresh = f.backend();
  expect((await fresh.getState()).sessions[0].summary.text).toBe("Repairs native labels");
  f.setFacts({ sessionId: "pi-1", sessionName: "User renamed", sessionFile: FACTS.sessionFile });
  await f.write(2);
  expect((await f.backend().getState()).sessions[0]).toMatchObject({ name: "User renamed", summary: { text: "Repairs native labels" } });
  await f.write(1, { ...FACTS, labelDescription: "stale write" });
  expect((await readSavedOwnerRecords(f.stateHome))[0].labels.description).toBe("Repairs native labels");
});

it("does not associate an old description with a replacement Pi session or incompatible label version", async () => {
  const f = await fixture();
  await f.write(1);
  f.setFacts({ sessionId: "pi-2", sessionName: "replacement" });
  await f.write(2);
  expect((await f.backend().getState()).sessions[0].summary?.text).toBeUndefined();
  await f.write(3, { ...FACTS, labelVersion: 99, labelDescription: "untrusted schema" });
  expect((await readSavedOwnerRecords(f.stateHome))[0].labels).toBeUndefined();
});

it("keeps old saved records and owners usable without labels, and ignores unsupported additive labels", async () => {
  const f = await fixture();
  f.setFacts({ sessionId: "pi-1", sessionName: "old name" });
  await f.write(1);
  const old = (await readSavedOwnerRecords(f.stateHome))[0];
  expect(old.corrupt).toBe(false);
  expect((await f.backend().getState()).sessions[0].name).toBe("old name");
  const bytes = JSON.parse(await readFile(f.saved.paths.record, "utf8"));
  await writeFile(f.saved.paths.record, JSON.stringify({ ...bytes, labels: { version: 99, sessionId: "pi-1", description: "unsupported" } }));
  const incompatible = (await readSavedOwnerRecords(f.stateHome))[0];
  expect(incompatible.corrupt).toBe(false);
  expect(incompatible.labels).toBeUndefined();
});

it.each(["error", "timeout", "malformed", "unavailable-auth", "unavailable-model"])("renders a retained description alongside failed refresh status %s, including a fresh backend read", async (status) => {
  const f = await fixture();
  await f.write(1);
  const backend = f.backend();
  expect((await backend.getState()).sessions[0].summary.text).toBe(FACTS.labelDescription);
  f.setFacts({ ...FACTS, labelDescription: undefined, labelStatus: status });
  await f.write(2);
  const layout = createDashboardLayout(320, 40);
  const row = (await backend.getState()).sessions[0];
  const freshRow = (await f.backend().getState()).sessions[0];
  expect(stripVTControlCharacters(renderSessionRow(row, layout, {}))).toContain(`${FACTS.labelDescription}; labels ${status}`);
  expect(stripVTControlCharacters(renderSessionRow(freshRow, layout, {}))).toContain(`${FACTS.labelDescription}; labels ${status}`);
});

it.each(["ready", "pending"])("keeps %s description rows unchanged", async (status) => {
  const f = await fixture();
  f.setFacts({ ...FACTS, labelStatus: status });
  await f.write(1);
  expect((await f.backend().getState()).sessions[0].summary.text).toBe(FACTS.labelDescription);
});

it("carries an explicit launch name to Pi before the initial task can be labelled", async () => {
  const f = await fixture();
  const calls = [];
  const backend = createNativeBackend({ sessionsHome: path.join(f.home, "new-runtime"), runDemo: async (args) => { calls.push(args); return { code: 0, output: "" }; } });
  cleanup.push(() => backend.close());
  await backend.launch({ name: "Chosen task", prompt: "task", cwd: f.home, sourceSessionId: "labels-fixture", isolation: { mode: "shared_directory", confirmedCwd: f.home, ownerSessionIds: [] } });
  expect(calls[0].slice(calls[0].indexOf("--name"), calls[0].indexOf("--name") + 2)).toEqual(["--name", "Chosen task"]);
});
