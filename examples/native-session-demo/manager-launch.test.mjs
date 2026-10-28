/**
 * Does Enter in the composer actually start the task, and in the directory the operator asked for?
 *
 * Two separate failures live here, and both were invisible to a test that only checked a row appeared:
 *
 *   1. the prompt was stored for display and never handed to the launch, so Enter opened a blank Pi;
 *   2. the isolation mode was echoed back by preflight and then ignored, so a worktree request would
 *      have run a real coding agent in the operator's own directory.
 *
 * These cases judge `launch` on what it asks for, using an injected `runDemo` so no Pi starts and no
 * provider is called. Delivery of the prompt to a real provider is proven separately, end to end, by
 * `manager-flow.mjs`'s delivery flow against the labelled fake provider's own digest.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNativeBackend } from "../../app/list/native-backend.mjs";
import { deterministicReply } from "./fake-provider.mjs";
import { OWNER_PRIVATE_ENV_KEYS, ownerLaunchPlan } from "./owner-launch.mjs";

/** One launch-plan input naming every path, so a case can assert on any of them. */
function planInput(overrides = {}) {
  return {
    mode: "fake",
    preload: "/demo/owner-preload.mjs",
    extension: "/demo/owner-extension.ts",
    bundledCli: "/cohort/cli.js",
    tuiPackageRoot: "/cohort/pi-tui",
    profile: { term: "xterm-256color" },
    cols: 100,
    rows: 30,
    owned: {
      home: "/root/home", agent: "/root/agent", sessions: "/root/sessions", project: "/root/project",
      bootstrapSocket: "/root/bootstrap.sock", controlSocket: "/root/control.sock",
      sidebandSocket: "/root/sideband.sock", ingressLog: "/root/ingress.jsonl",
    },
    token: "control-token",
    bridgeToken: "bridge-token",
    sidebandSocketEnv: "PI_AGENTS_OWNER_SIDEBAND_SOCKET",
    sidebandTokenEnv: "PI_AGENTS_OWNER_SIDEBAND_TOKEN",
    fakeProviderId: "native-session-demo-fake",
    fakeModelId: "deterministic-echo",
    ...overrides,
  };
}

/** A backend whose `runDemo` records the argv instead of starting a Pi. */
function recordingBackend(sessionsHome, overrides = {}) {
  const calls = [];
  const client = createNativeBackend({
    sessionsHome,
    runDemo: async (args) => {
      calls.push(args);
      const rootIndex = args.indexOf("--root");
      if (rootIndex !== -1) await mkdir(args[rootIndex + 1], { recursive: true });
      return { code: 0, output: "" };
    },
    ...overrides,
  });
  return { client, calls };
}

const SHARED = (cwd) => ({ mode: "shared_directory", confirmedCwd: cwd, ownerSessionIds: [] });

describe("the composer's prompt is actually launched, not just stored", () => {
  it("hands the prompt to the launch instead of only remembering it for the row", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-prompt-"));
    const { client, calls } = recordingBackend(sessionsHome);
    const prompt = "run the actual task from the composer";
    await client.launch({ prompt, cwd: sessionsHome, sourceSessionId: "dashboard-test", isolation: SHARED(sessionsHome) });
    expect(calls).toHaveLength(1);
    const [args] = calls;
    // A run that names no prompt opens a blank Pi, which is the defect this pins.
    const fileIndex = args.indexOf("--initial-prompt-file");
    expect(fileIndex, `launch argv carried no prompt: ${args.join(" ")}`).toBeGreaterThan(-1);
    expect(await readFile(args[fileIndex + 1], "utf8")).toBe(prompt);
    client.close();
  });

  it("preserves the exact text, including leading dashes, newlines and trailing spaces", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-prompt-"));
    const { client, calls } = recordingBackend(sessionsHome);
    // Text that argv would reinterpret and a trim would damage. A file is the transport for that reason.
    const prompt = "--not-a-flag\n  second line with trailing space  \n\nlast";
    await client.launch({ prompt, cwd: sessionsHome, sourceSessionId: "dashboard-test", isolation: SHARED(sessionsHome) });
    const args = calls[0];
    expect(await readFile(args[args.indexOf("--initial-prompt-file") + 1], "utf8")).toBe(prompt);
    client.close();
  });

  it("carries the prompt file through the owner launch plan in both modes, and never inherits a stale one", () => {
    const promptFile = "/root/initial-prompt.txt";
    for (const mode of ["fake", "real"]) {
      const plan = ownerLaunchPlan(planInput({
        mode,
        initialPromptFile: promptFile,
        inheritedEnv: { PATH: "/operator/bin", PI_DEMO_INITIAL_PROMPT_FILE: "/previous/stale-prompt.txt" },
      }));
      expect(plan.env.PI_DEMO_INITIAL_PROMPT_FILE, mode).toBe(promptFile);
    }
    // A previous owner's prompt must never be inherited, or a new session would run an old task.
    expect(OWNER_PRIVATE_ENV_KEYS).toContain("PI_DEMO_INITIAL_PROMPT_FILE");
    const stale = ownerLaunchPlan(planInput({
      mode: "real",
      inheritedEnv: { PI_DEMO_INITIAL_PROMPT_FILE: "/previous/stale-prompt.txt" },
    }));
    expect(stale.env.PI_DEMO_INITIAL_PROMPT_FILE).toBeUndefined();
  });

  it("digests the prompt exactly as the fake provider will, which is what the delivery flow asserts on", () => {
    const prompt = "--leading-dash task\nsecond line";
    const reply = deterministicReply({ messages: [{ role: "user", content: prompt }] });
    expect(reply).toMatch(/^DEMO-FAKE-REPLY [0-9a-f]{12} :: /u);
    // One trailing space is a different digest, so the digest is a byte-exactness claim, not a fuzzy one.
    expect(reply).not.toBe(deterministicReply({ messages: [{ role: "user", content: `${prompt} ` }] }));
  });

  it("pins every owner launch to the backend's packaged cohort manifest", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-cohort-"));
    const manifestPath = "/installed/release/app/runtime/cohort-manifest.json";
    const { client, calls } = recordingBackend(sessionsHome, { manifestPath });
    await client.launch({ prompt: "use packaged Pi", cwd: sessionsHome, sourceSessionId: "dashboard-test", isolation: SHARED(sessionsHome) });
    const args = calls[0];
    expect(args.slice(args.indexOf("--manifest"), args.indexOf("--manifest") + 2)).toEqual(["--manifest", manifestPath]);
    client.close();
  });
});

describe("isolation is honoured, not merely echoed", () => {
  /** A disposable Git repository, so worktree isolation is exercised against a real repo. */
  async function disposableRepo() {
    const root = await mkdtemp(path.join(tmpdir(), "native-repo-"));
    const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git(["init", "--quiet"]);
    git(["config", "user.email", "demo@example.invalid"]);
    git(["config", "user.name", "Demo"]);
    await writeFile(path.join(root, "README.md"), "disposable\n");
    git(["add", "README.md"]);
    git(["commit", "--quiet", "-m", "base"]);
    return realpath(root);
  }

  it("launches a worktree request in a prepared worktree, not in the operator's directory", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-iso-"));
    const repo = await disposableRepo();
    const { client, calls } = recordingBackend(sessionsHome, { piConfigRoot: `${sessionsHome}-config` });
    await client.launch({ prompt: "work in isolation", cwd: repo, sourceSessionId: "dashboard-test", isolation: { mode: "worktree" } });
    const args = calls[0];
    const cwdIndex = args.indexOf("--cwd");
    expect(cwdIndex, `launch argv named no cwd: ${args.join(" ")}`).toBeGreaterThan(-1);
    const ownerCwd = args[cwdIndex + 1];
    // The point of the mode: a real coding agent must not be started in the operator's own directory.
    expect(ownerCwd).not.toBe(repo);
    expect(ownerCwd).toContain("worktrees");
    // And it is a real checkout, not just a directory with a suggestive name.
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ownerCwd, encoding: "utf8" }).trim();
    expect(await realpath(topLevel)).toBe(await realpath(ownerCwd));
    client.close();
  });

  it("runs a confirmed shared-directory request in that directory", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-iso-"));
    const shared = await realpath(await mkdtemp(path.join(tmpdir(), "native-shared-")));
    const { client, calls } = recordingBackend(sessionsHome);
    await client.launch({ prompt: "work here", cwd: shared, sourceSessionId: "dashboard-test", isolation: SHARED(shared) });
    expect(calls[0][calls[0].indexOf("--cwd") + 1]).toBe(shared);
    client.close();
  });

  it("refuses a worktree request it cannot prepare instead of launching in the shared directory", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-iso-"));
    const notARepo = await realpath(await mkdtemp(path.join(tmpdir(), "native-plain-")));
    const { client, calls } = recordingBackend(sessionsHome, { piConfigRoot: `${sessionsHome}-config` });
    await expect(client.launch({
      prompt: "work in isolation", cwd: notARepo, sourceSessionId: "dashboard-test", isolation: { mode: "worktree" },
    })).rejects.toThrow();
    // Refused BEFORE launching: no owner was started, and none in the operator's directory.
    expect(calls).toEqual([]);
    expect((await client.getState()).sessions).toEqual([]);
    client.close();
  });

  it("refuses an isolation mode it does not implement rather than reporting success", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-iso-"));
    const { client, calls } = recordingBackend(sessionsHome);
    await expect(client.launch({
      prompt: "x", cwd: sessionsHome, sourceSessionId: "dashboard-test", isolation: { mode: "container" },
    })).rejects.toThrow(/isolation/iu);
    expect(calls).toEqual([]);
    client.close();
  });

  it("reports the mode the existing preflight resolved, rather than echoing the draft back", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-iso-"));
    const repo = await disposableRepo();
    const { client } = recordingBackend(sessionsHome, { piConfigRoot: `${sessionsHome}-config` });
    const preflight = await client.preflightLaunch({ cwd: repo, isolationMode: "worktree", sourceSessionId: "dashboard-test" });
    expect(preflight.isolationMode).toBe("worktree");
    expect(preflight.canonicalCwd).toBe(repo);
    // A cwd that cannot host a worktree is refused at preflight, which is where the composer can show it.
    const notARepo = await realpath(await mkdtemp(path.join(tmpdir(), "native-plain-")));
    await expect(client.preflightLaunch({ cwd: notARepo, isolationMode: "worktree", sourceSessionId: "dashboard-test" })).rejects.toThrow();
    client.close();
  });
});

describe("a row claims only what the manager actually reports", () => {
  it("does not call a live owner idle, because this backend is told nothing about its work", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-activity-"));
    await mkdir(path.join(sessionsHome, "session-live"), { recursive: true });
    const client = createNativeBackend({ sessionsHome });
    const { sessions } = await client.getState();
    expect(sessions).toHaveLength(1);
    for (const row of sessions) {
      expect(row.activity.kind).not.toBe("idle");
      expect(row.activity.summary).toMatch(/not reported|unreachable|exited/u);
    }
    client.close();
  });
});
