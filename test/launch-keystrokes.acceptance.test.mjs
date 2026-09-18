import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { DashboardController } from "../app/list/dashboard.mjs";

const execFileAsync = promisify(execFile);

/**
 * What the operator does: type a task, press Enter, read the screen.
 *
 * These drive `handleInput` and `render` with the real Git probe, so a launch that never reaches the
 * daemon and never draws a confirmation is a failure here rather than a silently emptied box.
 */

let directories;

class FakeDaemonClient {
  requests = [];
  sequence = 1;
  /** @param {{ publishesLaunchedSession?: boolean }} [behavior] */
  constructor(behavior = {}) {
    this.publishesLaunchedSession = behavior.publishesLaunchedSession ?? true;
    this.snapshot = { sessions: [], cursor: this.cursor() };
  }
  cursor() { this.sequence += 1; return { daemonEpoch: "epoch", sequence: String(this.sequence) }; }
  async getState() { return this.snapshot; }
  async subscribeListChanges(onChanged) { this.notifyListChanged = onChanged; return () => {}; }
  async preflightLaunch(draft) {
    return { canonicalCwd: draft.cwd, isolationMode: draft.isolationMode, ownerSessionIds: [] };
  }
  /** The daemon publishes the launching session to subscribers, then answers the caller. */
  async launch(request) {
    this.requests.push(request);
    if (this.publishesLaunchedSession) {
      this.snapshot = { sessions: [launchedSession(request)], cursor: this.cursor() };
      this.notifyListChanged?.();
    }
    return { kind: "launched", sessionId: "new" };
  }
  async getModels() { return []; }
  async refreshSummaries() { return []; }
}

function launchedSession(request) {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1, revision: 1, sessionId: "new",
    sessionFile: "/sessions/new.jsonl", canonicalSessionFile: "/sessions/new.jsonl",
    cwd: request.cwd, model: request.model, name: "Implement It",
    taskState: "WORKING", processState: "LIVE", outcome: "NONE",
    activity: { kind: "assistant_final", summary: "Starting", updatedAt: timestamp },
    createdAt: timestamp, updatedAt: timestamp,
  };
}

/** A dashboard wired the way `createStandaloneList` wires the installed one: no injected probe. */
function dashboard(client, cwd) {
  return new DashboardController({
    client,
    openViewer: vi.fn(async () => {}),
    clientId: "keystroke-client",
    sourceSessionId: "source",
    launchDefaults: { cwd, model: { provider: "anthropic", id: "claude" } },
    requestRender: () => {},
  });
}

function screen(controller) {
  return controller.render(100, 24).map(stripVTControlCharacters).join("\n");
}

async function type(controller, text) {
  for (const character of text) controller.handleInput(character);
  controller.handleInput("\r");
}

beforeAll(async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "launch-keystrokes-")));
  const repository = join(parent, "repo");
  const outsideGit = join(parent, "outside-git");
  await Promise.all([mkdir(repository), mkdir(outsideGit)]);
  const git = (cwd, ...args) => execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false });
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Keystroke Tests");
  await git(repository, "config", "user.email", "keystroke@example.test");
  await writeFile(join(repository, "tracked.txt"), "base\n");
  await git(repository, "add", "tracked.txt");
  await git(repository, "commit", "-m", "base");
  directories = { parent, repository, outsideGit };
});

afterAll(async () => { await rm(directories.parent, { recursive: true, force: true }); });

it("shows a row on screen when Enter launches from a repository with a commit", async () => {
  const client = new FakeDaemonClient();
  const controller = dashboard(client, directories.repository);
  await controller.open();

  await type(controller, "Implement it");

  await vi.waitFor(() => expect(client.requests).toHaveLength(1));
  expect(client.requests[0]).toMatchObject({ isolation: { mode: "worktree" }, prompt: "Implement it" });
  await vi.waitFor(() => expect(screen(controller)).toContain("Implement It"));
});

// The placeholder row is retired when the launch is answered, but the session row arrives on a
// separate subscription. A daemon that has not published yet must not leave the operator looking at
// an empty list and an empty box, which is indistinguishable from a prompt that was dropped.
it("keeps the launched session on screen until the daemon publishes its row", async () => {
  const client = new FakeDaemonClient({ publishesLaunchedSession: false });
  const controller = dashboard(client, directories.repository);
  await controller.open();

  await type(controller, "Implement it");

  await vi.waitFor(() => expect(client.requests).toHaveLength(1));
  expect(screen(controller)).toContain("STARTING");
});
