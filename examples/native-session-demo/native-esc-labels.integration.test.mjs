import { constants } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRealProcessHarness } from "../../test/real-process-harness.mjs";

if (!Object.keys(process.env).some((name) => name.startsWith("PI_ASSEMBLY_"))) {
  it.skip("combined native assembly fixture requires explicit PI_ASSEMBLY_* configuration", () => {});
} else {
  for (const name of ["PI_ASSEMBLY_APP_ROOT", "PI_ASSEMBLY_MANIFEST", "PI_ASSEMBLY_OBSERVER", "PI_ASSEMBLY_EVIDENCE", "PI_ASSEMBLY_OBSERVATIONS"]) {
    if (!process.env[name] || !path.isAbsolute(process.env[name])) throw new Error(`Assembly fixture requires an absolute ${name}`);
  }
  if (!(await stat(process.env.PI_ASSEMBLY_APP_ROOT)).isDirectory()) throw new Error("Assembly fixture requires an app directory");
  for (const name of ["PI_ASSEMBLY_MANIFEST", "PI_ASSEMBLY_OBSERVER"]) {
    if (!(await stat(process.env[name])).isFile()) throw new Error(`Assembly fixture requires a file at ${name}`);
  }
  for (const name of ["PI_ASSEMBLY_EVIDENCE", "PI_ASSEMBLY_OBSERVATIONS"]) {
    await access(path.dirname(process.env[name]), constants.W_OK);
  }
  const app = process.env.PI_ASSEMBLY_APP_ROOT;
  const manifest = process.env.PI_ASSEMBLY_MANIFEST;
  const plans = [];
  vi.doMock(path.join(app, "examples/native-session-demo/owner-launch.mjs"), async (original) => {
    const actual = await original();
    return { ...actual, ownerLaunchPlan: (options) => {
      const plan = actual.ownerLaunchPlan(options);
      if (options.mode !== "fake") throw new Error("Combined fixture requires fake mode");
      if (!process.env.TMPDIR || process.env.JITI_FS_CACHE !== "false") throw new Error("Private cache/temp required");
      plan.env.TMPDIR = process.env.TMPDIR;
      plan.env.JITI_FS_CACHE = "false";
      plan.env.PI_ASSEMBLY_OBSERVATIONS = process.env.PI_ASSEMBLY_OBSERVATIONS;
      plan.args = plan.args.filter((arg) => arg !== "-nt");
      plan.args.push("--no-approve", "-e", process.env.PI_ASSEMBLY_OBSERVER);
      plans.push(plan);
      return plan;
    } };
  });
  const { runManager } = await import(path.join(app, "examples/native-session-demo/manager.mjs"));
  const { createNativeBackend } = await import(path.join(app, "app/list/native-backend.mjs"));
  const { demoPaths, readToken } = await import(path.join(app, "examples/native-session-demo/demo-root.mjs"));
  const { createFrameReader, encodeFrame } = await import(path.join(app, "examples/native-session-demo/protocol.mjs"));
  const { inspectProcessIdentity } = await import(path.join(app, "runtime/process-identity-linux.mjs"));
  const { readSavedOwnerRecords } = await import(path.join(app, "examples/native-session-demo/saved-owner-record.mjs"));
  const harness = createRealProcessHarness("native-esc-labels-combined");
  const cleanup = [];
  const evidence = (entry) => appendFile(process.env.PI_ASSEMBLY_EVIDENCE, `${JSON.stringify(entry)}\n`);
  afterEach(async () => {
    for (const end of cleanup.splice(0).reverse()) await end();
    await harness.cleanup();
  });

  async function exited(identity) {
    try {
      const current = await inspectProcessIdentity(identity.pid);
      if (current.startIdentity !== identity.startIdentity) return true;
      const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z ");
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error.code)) return true;
      throw error;
    }
  }

  it("one native owner labels, honors /name, aborts Bash with Esc, retains draft/reply and detached labels", async () => {
    const base = await mkdtemp("/tmp/pia-combined-");
    const home = await mkdtemp(path.join(tmpdir(), "combined-home-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }), () => rm(home, { recursive: true, force: true }));
    const project = path.join(home, "project");
    const stateHome = path.join(home, "metadata");
    const prompt = path.join(home, "initial-prompt");
    await mkdir(project);
    await writeFile(prompt, "Exercise native Esc and durable labels together");
    const managerIdentity = await inspectProcessIdentity(process.pid);
    await evidence({ phase: "fixture-worker", managerIdentity, app });
    let recorded;
    const manager = await runManager({ root: path.join(base, "session-1"), manifestPath: manifest, mode: "fake", projectCwd: project,
      stateHome, piConfigHome: path.join(home, "pi-config"), initialPromptFile: prompt, log: () => {},
      onReady: (ready) => { recorded = harness.record("fake native Pi", ready.owner); },
    });
    await recorded;
    const owner = manager.statusRecord().owner;
    const ownerIdentity = { pid: owner.pid, startIdentity: owner.startIdentity, processGroupId: owner.processGroupId };
    await evidence({ phase: "ready", app, manifest, managerIdentity, owner, nativeChildEnv: plans.at(-1).env, host: process.env.SLURMD_NODENAME });
    cleanup.push(async () => {
      const stopped = await manager.stop(true);
      const ownerAfter = await inspectProcessIdentity(owner.pid).then((identity) => ({ status: "IDENTIFIED", identity }),
        (error) => ({ status: error.code === "ENOENT" ? "ABSENT" : "UNKNOWN", code: error.code }));
      await evidence({ phase: "stopped", owner, managerIdentity, stopped, ownerAfter });
      expect(stopped.exit.waitObserved).toBe(true);
      expect(ownerAfter.status).toBe("ABSENT");
    });
    const facts = () => manager.statusRecord().bridge.facts;
    const backend = () => {
      const client = createNativeBackend({ sessionsHome: base, stateHome });
      cleanup.push(() => client.close());
      return client;
    };
    await expect.poll(() => facts().labelStatus, { timeout: 20_000 }).toBe("ready");
    expect(facts().sessionName).toBe("Demo fake task");
    const row = (await backend().getState()).sessions[0];
    expect(row.name).toBe("Demo fake task");
    expect(row.summary.text).toContain("deterministic fake provider");
    expect(row.canonicalSessionFile).toContain(path.join(home, "pi-config", ".pi", "sessions"));

    async function attach(id) {
      const socket = net.connect(demoPaths(manager.statusRecord().root).controlSocket);
      cleanup.push(() => socket.destroy());
      let welcome;
      const reader = createFrameReader(({ header }) => { if (header.type === "welcome") welcome = header; }, (error) => { throw error; });
      socket.on("data", (bytes) => reader.push(bytes));
      socket.write(encodeFrame({ type: "hello", role: "client", token: await readToken(manager.statusRecord().root), attachmentId: id, cols: 100, rows: 30 }));
      await expect.poll(() => welcome, { timeout: 10_000 }).toMatchObject({ type: "welcome" });
      return { socket, input: (text) => socket.write(encodeFrame({ type: "input", epoch: welcome.epoch }, Buffer.from(text))) };
    }
    const events = async () => (await readFile(process.env.PI_ASSEMBLY_OBSERVATIONS, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let client = await attach("combined-first");
    client.input("/name Combined explicit name\r");
    await expect.poll(() => facts().sessionName, { timeout: 10_000 }).toBe("Combined explicit name");
    const shellFile = path.join(home, "shell.pid");
    const childFile = path.join(home, "child.pid");
    client.input(`!echo $$ > '${shellFile}'; sleep 90 & echo $! > '${childFile}'; wait\r`);
    await expect.poll(() => readFile(childFile, "utf8").catch(() => ""), { timeout: 10_000 }).not.toBe("");
    const shell = await inspectProcessIdentity(Number(await readFile(shellFile, "utf8")));
    const child = await inspectProcessIdentity(Number(await readFile(childFile, "utf8")));
    await harness.record("fixture Bash", shell);
    await evidence({ phase: "bash-started", shell, child });
    const draft = "unsent combined draft";
    client.input(draft);
    await expect.poll(async () => (await events()).some((event) => event.text === draft), { timeout: 10_000 }).toBe(true);
    client.input("\x1b");
    await expect.poll(() => exited(shell), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => exited(child), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await events()).findLast((event) => event.data === "\x1b"), { timeout: 10_000 }).toMatchObject({ text: draft, pid: owner.pid, jiti: "false", tmp: process.env.TMPDIR });
    expect(await inspectProcessIdentity(owner.pid)).toEqual(ownerIdentity);
    client.input("\x15next combined fake reply\r");
    await expect.poll(async () => (await readFile(row.canonicalSessionFile, "utf8")).includes("next combined fake reply"), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await readFile(row.canonicalSessionFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((entry) => entry.message?.role === "assistant").length, { timeout: 20_000 }).toBe(2);
    const entries = (await readFile(row.canonicalSessionFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(entries.some((entry) => entry.message?.role === "bashExecution" && entry.message.cancelled === true)).toBe(true);
    expect(JSON.stringify(entries)).toContain("DEMO-FAKE-REPLY");
    await expect.poll(() => facts().labelStatus, { timeout: 20_000 }).toBe("ready");
    expect(facts().sessionName).toBe("Combined explicit name");
    client.input(draft);
    await expect.poll(async () => (await events()).at(-1)?.text, { timeout: 10_000 }).toBe(draft);
    client.socket.destroy();
    await new Promise((resolve) => client.socket.once("close", resolve));
    const detached = backend();
    const detachedRow = (await detached.getState()).sessions[0];
    expect(detachedRow.name).toBe("Combined explicit name");
    expect(detachedRow.summary.text).toContain("deterministic fake provider");
    await expect.poll(async () => (await readSavedOwnerRecords(stateHome))[0], { timeout: 10_000 }).toMatchObject({
      sessionName: "Combined explicit name", sessionFile: row.canonicalSessionFile, labels: { version: 1, status: "ready", description: expect.stringContaining("deterministic fake provider") },
    });
    const durable = (await readSavedOwnerRecords(stateHome))[0];
    detached.close();
    client = await attach("combined-reopened");
    client.input("\x1b[C");
    await expect.poll(async () => (await events()).findLast((event) => event.data === "\x1b[C"), { timeout: 10_000 }).toMatchObject({ text: draft, pid: owner.pid });
    expect(await inspectProcessIdentity(owner.pid)).toEqual(ownerIdentity);
    const reopened = (await backend().getState()).sessions[0];
    expect(reopened.name).toBe("Combined explicit name");
    expect(reopened.summary.text).toContain("deterministic fake provider");
    await evidence({ phase: "combined-pass", owner, shell, child, shellExited: await exited(shell), childExited: await exited(child), draft,
      generatedTitle: row.name, explicitName: reopened.name, description: reopened.summary.text, canonicalSessionFile: row.canonicalSessionFile,
      nextFakeReply: true, detachedReopened: true, durable });
  }, 120_000);
}
