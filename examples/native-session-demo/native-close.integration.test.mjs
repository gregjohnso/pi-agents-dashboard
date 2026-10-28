import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";

import { createRealProcessHarness } from "../../test/real-process-harness.mjs";
import { identifyDaemonChild } from "../../runtime/daemon-lifecycle.mjs";
import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";

if (!process.env.PI_CLOSE_APP_ROOT) {
  it.skip("native close/clear smoke requires an explicit private app root", () => {});
} else {
  const app = process.env.PI_CLOSE_APP_ROOT;
  if (!path.isAbsolute(app)) throw Error("PI_CLOSE_APP_ROOT must be absolute");
  const { createNativeBackend } = await import(path.join(app, "app/list/native-backend.mjs"));
  const { DashboardController } = await import(path.join(app, "app/list/dashboard.mjs"));

  it("closes and clears a real fake-provider Pi through list keys without errors, repeat-stop warnings, or transcript deletion", async () => {
    const harness = createRealProcessHarness("native-close-clear");
    const home = await harness.stateRoot("pcc-");
    const sessionsHome = path.join(home, "runtime");
    const stateHome = path.join(home, "state");
    const root = path.join(sessionsHome, "session-1");
    const project = path.join(home, "project");
    const prompt = path.join(home, "prompt.txt");
    await mkdir(project);
    await writeFile(path.join(project, "keep.txt"), "keep worktree contents\n");
    await writeFile(prompt, "Exercise a deterministic close and clear");
    let dashboard;
    let client;
    let owner;
    try {
      const config = { root, mode: "fake", manifestPath: path.join(app, "runtime/cohort-manifest.json"), stateHome,
        projectCwd: project, piConfigHome: path.join(home, "pi-config"), initialPromptFile: prompt };
      const script = path.join(home, "manager-fixture.mjs");
      await writeFile(script, `import {runManager} from ${JSON.stringify(pathToFileURL(path.join(app, "examples/native-session-demo/manager.mjs")).href)};\nawait runManager({...${JSON.stringify(config)}, log: () => {}, onReady: ready => process.send({type:"ready", owner:ready.owner})});\n`);
      const manager = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = "";
      manager.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      const ready = new Promise((resolve, reject) => {
        manager.on("message", (message) => { if (message.type === "ready") resolve(message); });
        manager.on("error", reject);
        manager.on("exit", (code) => reject(Error(`Fixture manager exited before ready (${code}): ${stderr}`)));
      });
      const recording = identifyDaemonChild(manager, inspectProcessIdentity).then(async (identified) => {
        if (identified.status !== "IDENTIFIED") throw Error("Could not identify the fixture manager");
        await harness.record("native manager", identified.identity);
      });
      const [, started] = await Promise.all([recording, ready]);
      owner = started.owner;
      await harness.record("fake native Pi", owner);
      client = createNativeBackend({ sessionsHome, stateHome, mode: "fake" });
      await expect.poll(async () => {
        const file = (await client.getState()).sessions[0]?.canonicalSessionFile;
        return file === undefined ? "" : readFile(file, "utf8").catch(() => "");
      }, { timeout: 30000 }).toContain("DEMO-FAKE-REPLY");
      await expect.poll(async () => {
        const row = (await client.getState()).sessions[0];
        return row?.stateReported === true && row.taskState === "READY";
      }, { timeout: 10000 }).toBe(true);
      const stopCalls = vi.spyOn(client, "stop");
      const clearCalls = vi.spyOn(client, "delete");
      let clock = 1000;
      dashboard = new DashboardController({ client, clientId: "close-smoke", openViewer: async () => {}, requestRender: () => {}, now: () => clock, launchDefaults: { cwd: project } });
      await dashboard.open();
      dashboard.handleInput("\x16");
      expect(dashboard.controlCategory).toBe("task");
      expect(dashboard.query).toEqual({ view: "live" });
      dashboard.handleInput("\x14");
      expect(dashboard.query.taskStates).toEqual(["WORKING"]);
      while (dashboard.controlCategory !== "clear filters") dashboard.handleInput("\x16");
      dashboard.handleInput("\x14");
      expect(dashboard.query.taskStates).toBeUndefined();
      dashboard.setView("all");
      const row = dashboard.sessions[0];
      expect(row.processState).toBe("LIVE");
      dashboard.handleInput("\x18");
      expect(stopCalls).not.toHaveBeenCalled();
      expect(await inspectProcessIdentity(owner.pid)).toEqual({ pid: owner.pid, startIdentity: owner.startIdentity, processGroupId: owner.processGroupId });
      clock += 100;
      dashboard.handleInput("\x18");
      await expect.poll(() => dashboard.sessions[0]?.taskState, { timeout: 15000 }).toBe("STOPPED");
      expect(stopCalls).toHaveBeenCalledTimes(1);
      expect(dashboard.stopClearArmed).toBe(false);
      expect(dashboard.status.kind).not.toBe("error");
      expect(await client.stop(row.sessionId, row.revision, "repeat-stop")).toMatchObject({ observedExit: true, alreadyStopped: true, exit: { code: 0 } });
      const transcript = await readFile(row.canonicalSessionFile, "utf8");
      const metadata = await readFile(path.join(root, "owner.json"), "utf8");
      clock += 501;
      dashboard.handleInput("\x18");
      expect(clearCalls).not.toHaveBeenCalled();
      dashboard.handleInput("\x18");
      await expect.poll(() => dashboard.sessions.length, { timeout: 10000 }).toBe(0);
      expect(dashboard.status.kind).not.toBe("error");
      const reopened = createNativeBackend({ sessionsHome, stateHome, mode: "fake" });
      try { expect((await reopened.getState()).sessions).toEqual([]); } finally { reopened.close(); }
      expect(await readFile(row.canonicalSessionFile, "utf8")).toBe(transcript);
      expect(await readFile(path.join(root, "owner.json"), "utf8")).toBe(metadata);
      expect(await readFile(path.join(project, "keep.txt"), "utf8")).toBe("keep worktree contents\n");
      console.log(JSON.stringify({ closeClearPassed: true, ownerPid: owner.pid, exitCode: 0, transcriptPreserved: true, noDuplicateRowsAfterReopen: true }));
    } finally {
      await dashboard?.close();
      if (client !== undefined) await client.stop("session-1", 1, "fixture-cleanup").catch(() => {});
      client?.close();
      await harness.cleanup();
    }
  }, 90000);
}
