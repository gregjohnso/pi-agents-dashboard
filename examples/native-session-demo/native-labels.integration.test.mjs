import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";
import { createFrameReader, encodeFrame } from "./protocol.mjs";
import { demoPaths, readToken } from "./demo-root.mjs";
import { runManager } from "./manager.mjs";
import { createNativeBackend } from "../../app/list/native-backend.mjs";
import { DashboardController } from "../../app/list/dashboard.mjs";
import { createRealProcessHarness } from "../../test/real-process-harness.mjs";

const plans = vi.hoisted(() => []);
vi.mock("./owner-launch.mjs", async (original) => {
  const actual = await original();
  return { ...actual, ownerLaunchPlan: (options) => {
    const plan = actual.ownerLaunchPlan(options);
    if (options.mode === "fake") {
      if (!process.env.TMPDIR || process.env.JITI_FS_CACHE !== "false") throw new Error("Native label fixture requires private TMPDIR and JITI_FS_CACHE=false");
      plan.env.TMPDIR = process.env.TMPDIR;
      plan.env.JITI_FS_CACHE = "false";
      plans.push({ HOME: plan.env.HOME, PI_CODING_AGENT_DIR: plan.env.PI_CODING_AGENT_DIR, TMPDIR: plan.env.TMPDIR, JITI_FS_CACHE: plan.env.JITI_FS_CACHE });
    }
    return plan;
  } };
});

const COHORT = "/mnt/main0/home/gjohnson/projects/pi-agents-pi14-work/cohort-4189339";
const MANIFEST = path.join(COHORT, "cohort-manifest.json");

async function evidence(entry) {
  if (process.env.PI_AGENTS_LABEL_EVIDENCE_FILE) await appendFile(process.env.PI_AGENTS_LABEL_EVIDENCE_FILE, `${JSON.stringify(entry)}\n`);
}
const harness = createRealProcessHarness("native-labels");
const cleanup = [];
afterEach(async () => {
  for (const end of cleanup.splice(0).reverse()) await end();
  await harness.cleanup();
});

async function launch(requestedName) {
  const base = await mkdtemp("/tmp/pia-label-live-");
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const home = await mkdtemp(path.join(tmpdir(), "native-label-home-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const project = path.join(home, "project");
  await mkdir(project);
  const stateHome = path.join(home, "metadata");
  const prompt = path.join(home, "initial-prompt");
  await writeFile(prompt, "Exercise durable session labels");
  const previousDelay = process.env.PI_DEMO_FAKE_DELAY_MS;
  process.env.PI_DEMO_FAKE_DELAY_MS = "1500";
  let recorded;
  let manager;
  const logs = [];
  try {
    manager = await runManager({ root: path.join(base, "session-1"), manifestPath: MANIFEST, mode: "fake", projectCwd: project,
      stateHome, piConfigHome: path.join(home, "pi-config"), initialPromptFile: prompt, requestedName, log: (line) => logs.push(line),
      onReady: (ready) => { recorded = harness.record("fake native Pi", ready.owner); },
    });
    await recorded;
  } finally {
    if (previousDelay === undefined) delete process.env.PI_DEMO_FAKE_DELAY_MS;
    else process.env.PI_DEMO_FAKE_DELAY_MS = previousDelay;
  }
  const owner = manager.statusRecord().owner;
  const managerIdentity = await inspectProcessIdentity(process.pid);
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const piPackage = JSON.parse(await readFile(path.join(COHORT, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
  await evidence({ phase: "ready", requestedName, managerIdentity, owner, nativeChildEnv: plans.at(-1), nodeVersion: process.versions.node, piVersion: piPackage.version,
    cohort: manager.statusRecord().cohort, manifest: { series: manifest.series, patchedTreeHash: manifest.patchedTreeHash, bundledCliSha256: manifest.bundledCliSha256 } });
  cleanup.push(async () => {
    const stopped = await manager.stop(true);
    const ownerAfter = await inspectProcessIdentity(owner.pid).then((identity) => ({ status: "IDENTIFIED", identity }),
      (error) => ({ status: error.code === "ENOENT" ? "ABSENT" : "UNKNOWN", code: error.code }));
    await evidence({ phase: "stopped", requestedName, managerIdentity, owner, stopped, ownerAfter, logs });
    await harness.cleanup();
    expect(stopped.exit.waitObserved).toBe(true);
    expect(ownerAfter.status).toBe("ABSENT");
  });
  expect(process.versions.node).toBe("22.23.2");
  expect(piPackage.version).toBe("1.4.0");
  expect(manifest.series).toHaveLength(4);
  expect(manifest.patchedTreeHash).toBe("b0c4f259cb287cecadbeecf1dc49aac56682462b");
  const backend = () => {
    const client = createNativeBackend({ sessionsHome: base, stateHome });
    cleanup.push(() => client.close());
    return client;
  };
  await expect.poll(() => manager.statusRecord().bridge.facts.agentPhase, { timeout: 15_000 }).toBe("settled");
  // One request summarizes the turn but does not title the session.
  expect(manager.statusRecord().bridge.facts.sessionName).toBe(requestedName);
  const socket = net.connect(demoPaths(manager.statusRecord().root).controlSocket);
  cleanup.push(() => socket.destroy());
  let welcome;
  const reader = createFrameReader(({ header }) => { if (header.type === "welcome") welcome = header; }, (error) => { throw error; });
  socket.on("data", (bytes) => reader.push(bytes));
  socket.write(encodeFrame({ type: "hello", role: "client", token: await readToken(manager.statusRecord().root), attachmentId: "second-request", cols: 100, rows: 30 }));
  await expect.poll(() => welcome, { timeout: 10_000 }).toMatchObject({ type: "welcome" });
  socket.write(encodeFrame({ type: "input", epoch: welcome.epoch }, Buffer.from("Make the session title informative\r")));
  await expect.poll(() => manager.statusRecord().bridge.facts.agentPhase, { timeout: 15_000 }).toBe("start");
  socket.destroy();
  return { manager, backend, facts: () => manager.statusRecord().bridge.facts };
}

it("native Pi confirms and persists a generated title while a detached dashboard keeps the short description", async () => {
  const f = await launch();
  const initial = f.backend();
  initial.close();
  await expect.poll(() => f.facts().sessionName, { timeout: 15_000 }).toBe("Demo fake task");
  await expect.poll(() => f.facts().labelStatus, { timeout: 15_000 }).toBe("ready");
  const row = (await f.backend().getState()).sessions.find((session) => session.sessionId === "session-1");
  expect(row.name).toBe("Demo fake task");
  expect(row.summary.text).toContain("deterministic fake provider");
  const entries = (await readFile(row.canonicalSessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(entries.filter((entry) => entry.type === "session_info").at(-1).name).toBe("Demo fake task");
  expect(entries.filter((entry) => entry.type === "message" && entry.message?.role === "user")).toHaveLength(2);
  expect(entries.some((entry) => JSON.stringify(entry).includes("Title: Demo fake task"))).toBe(false);
});

it("native Pi's built-in /name wins over automatic labelling", async () => {
  const f = await launch();
  const root = f.manager.statusRecord().root;
  const socket = net.connect(demoPaths(root).controlSocket);
  cleanup.push(() => socket.destroy());
  let welcome;
  let refused;
  const reader = createFrameReader(({ header }) => {
    if (header.type === "welcome") welcome = header;
    if (header.type === "refused") refused = header;
  }, (error) => { refused = { text: error.message }; });
  socket.on("data", (bytes) => reader.push(bytes));
  socket.write(encodeFrame({ type: "hello", role: "client", token: await readToken(root), attachmentId: "native-name", cols: 100, rows: 30 }));
  await expect.poll(() => welcome ?? refused, { timeout: 10_000 }).toMatchObject({ type: "welcome" });
  socket.write(encodeFrame({ type: "input", epoch: welcome.epoch }, Buffer.from("/name Native name wins")));
  socket.write(encodeFrame({ type: "input", epoch: welcome.epoch }, Buffer.from("\r")));
  await expect.poll(() => f.facts().sessionName, { timeout: 15_000 }).toBe("Native name wins");
  await expect.poll(() => f.facts().labelStatus, { timeout: 15_000 }).toBe("ready");
  expect((await f.backend().getState()).sessions[0].name).toBe("Native name wins");
});

it("an explicit launch name and the real dashboard /rename beat a pending native label completion", async () => {
  const f = await launch("Explicit launch name");
  expect(f.facts().sessionName).toBe("Explicit launch name");
  const client = f.backend();
  const controller = new DashboardController({ client, openViewer: async () => {}, clientId: "labels-fixture", sourceSessionId: "labels-fixture",
    launchDefaults: { cwd: "/unused-fixture" }, requestRender: () => {}, worktreeCapability: async () => ({ available: false }),
  });
  cleanup.push(() => controller.close());
  await controller.open();
  controller.selectSession("session-1");
  controller.setComposerPrompt("/rename User priority wins");
  await controller.runListCommand();
  expect(controller.status.kind).not.toBe("error");
  await controller.close();
  client.close();
  await expect.poll(() => f.facts().labelDescription ?? "", { timeout: 15_000 }).toContain("deterministic fake provider");
  expect(f.facts().sessionName).toBe("User priority wins");
  const row = (await f.backend().getState()).sessions.find((session) => session.sessionId === "session-1");
  expect(row.name).toBe("User priority wins");
  expect(row.summary.text).toContain("deterministic fake provider");
});
