// One cold-launch sample: journal acceptance through the first usable viewer snapshot, plus the
// resident cost a prewarmed spare would pay. Runs real Pi inference against the installed CLI, so it
// is not a test, is never imported by vitest, and must run on a SLURM node, never on a login node.
//
// Usage: node perf/cold-launch.mjs --out <file> [--base <dir>] [--provider p] [--model id]
//                                  [--prompt text] [--idle-ms 60000] [--timeout-ms 180000]
//
// Every sample builds its own state root, its own Pi agent directory, and its own disposable Git
// repository under --base, and removes all three before it exits.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { runDaemonCommand } from "../cli/daemon-commands.mjs";
import { LAUNCH_TRACE_STAGES, sampleIntervals } from "./cold-launch-sample.mjs";

const args = process.argv.slice(2);
const option = (/** @type {string} */ name, /** @type {string} */ fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : String(args[index + 1]);
};
const OUT = option("out", "");
const BASE = option("base", process.env.TMPDIR ?? tmpdir());
const PROVIDER = option("provider", "anthropic");
const MODEL = option("model", "claude-haiku-4-5");
const PROMPT = option("prompt", "Reply with the single word: ok");
const IDLE_MS = Number(option("idle-ms", "60000"));
const TIMEOUT_MS = Number(option("timeout-ms", "180000"));
const READY_POLL_MS = 10;

// Copied into the disposable agent directory so Pi can authenticate and resolve models without
// writing sessions, worktrees, or locks into the operator's own ~/.pi/agent.
const AGENT_FILES = ["auth.json", "models.json", "models-store.json", "settings.json"];
// This measurement runs from inside a Pi session; those variables would follow the child Pi.
const INHERITED_SESSION_VARIABLES = /^(PI_SESSION_FILE|PI_SUBAGENT|PI_INTERCOM|PI_CODING_AGENT_DIR)/u;
const TRACE_STAGE_TIMESTAMP = { ready_persisted: "readyPersistedAt" };

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run one command to completion and return its trimmed stdout. @param {string} file @param {string[]} argv @param {any} [options] */
function capture(file, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { stdio: ["ignore", "pipe", "pipe"], shell: false, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${file} ${argv.join(" ")} exited ${code}: ${stderr.trim()}`)));
  });
}

/**
 * The epoch instant the kernel booted, and the clock ticks per second its process start times use.
 *
 * Reading uptime and the wall clock back to back pins the origin to about the 10 ms resolution of
 * `/proc/uptime` itself, which is what lets a session record's process start ticks become an epoch
 * instant. `/proc/stat`'s own `btime` is integer seconds and drifts on a long-lived host.
 */
async function bootClock() {
  const before = Date.now();
  const uptimeSeconds = Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]);
  const after = Date.now();
  const clockTicks = Number(await capture("getconf", ["CLK_TCK"]));
  if (!Number.isFinite(uptimeSeconds) || !Number.isFinite(clockTicks) || clockTicks <= 0) throw new Error("could not read the boot clock");
  return { bootEpochMs: Math.round((before + after) / 2 - uptimeSeconds * 1_000), clockTicks, readSpreadMs: after - before };
}

/** Turn a session record's process start ticks into an epoch instant. @param {{bootEpochMs:number,clockTicks:number}} clock @param {unknown} startIdentity */
function spawnedAt(clock, startIdentity) {
  const ticks = Number(startIdentity);
  if (!Number.isFinite(ticks) || ticks <= 0) return undefined;
  return Math.round(clock.bootEpochMs + (ticks / clock.clockTicks) * 1_000);
}

/** Resident set size in kibibytes, or null once the process is gone. @param {number} pid */
async function residentKib(pid) {
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
  const line = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
  return line === null ? null : Number(line[1]);
}

/** A repository the launch can branch a worktree from, with one commit and nothing else. @param {string} path */
async function disposableRepository(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const git = (/** @type {string[]} */ argv) => capture("git", ["-C", path, ...argv], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "cold-launch", GIT_AUTHOR_EMAIL: "cold-launch@invalid", GIT_COMMITTER_NAME: "cold-launch", GIT_COMMITTER_EMAIL: "cold-launch@invalid" },
  });
  await git(["init", "--quiet", "--initial-branch", "main"]);
  await writeFile(join(path, "README.md"), "Disposable cold-launch measurement repository.\n");
  await git(["add", "README.md"]);
  await git(["commit", "--quiet", "-m", "base"]);
  return path;
}

/** A Pi agent directory holding only the credentials and model catalog, so sessions land in the sample root. @param {string} path */
async function disposableAgentDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const source = join(process.env.HOME ?? "", ".pi", "agent");
  for (const name of AGENT_FILES) {
    // A symbolic link, not a copy: credentials are never duplicated onto the compute node's disk.
    await symlink(join(source, name), join(path, name)).catch(() => {});
  }
  await chmod(path, 0o700);
  return path;
}

async function main() {
  if (process.env.SLURM_JOB_ID === undefined && process.env.PI_AGENTS_ALLOW_LOGIN_NODE !== "1") {
    throw new Error("Cold-launch samples run real Pi inference; submit them through perf/cold_launch_launcher.py");
  }
  const root = await mkdtemp(join(BASE, "pi-agents-cold-launch-"));
  const tracePath = join(root, "launch-trace.ndjson");
  const agentDirectory = await disposableAgentDirectory(join(root, "pi-agent"));
  const repository = await disposableRepository(join(root, "repo"));

  const env = { ...process.env };
  for (const name of Object.keys(env)) if (INHERITED_SESSION_VARIABLES.test(name)) delete env[name];
  Object.assign(env, { PI_AGENTS_STATE_DIR: root, PI_CODING_AGENT_DIR: agentDirectory, PI_AGENTS_LAUNCH_TRACE: tracePath });

  const piBin = await capture("bash", ["-lc", "command -v pi"]).catch(() => "pi");
  const piVersion = await capture(piBin, ["--version"]).catch(() => "unknown");
  const clock = await bootClock();
  // The same derivation applied to this process, whose start the driver already knows: the residual
  // is this sample's own spawn-instant error, not an assumed one.
  const selfStat = await readFile("/proc/self/stat", "utf8");
  const selfTicks = selfStat.slice(selfStat.lastIndexOf(") ") + 2).trim().split(/\s+/u)[19];
  const spawnClockResidualMs = (spawnedAt(clock, selfTicks) ?? 0) - Math.round(Date.now() - process.uptime() * 1_000);
  const loadBefore = loadavg();

  /** @type {any} */
  let sample = { ok: false };
  /** @type {any} */
  let client;
  try {
    const started = await runDaemonCommand("start", { root, piBin, env, timeoutMs: TIMEOUT_MS });
    if (started.code !== 0) throw new Error(`daemon start failed: ${JSON.stringify(started.error)}`);
    const token = (await readFile(join(root, "daemon", "control.token"), "utf8")).trim();
    client = createDaemonClient({ socketPath: join(root, "daemon", "control.sock"), token, clientId: "cold-launch", reconnect: false, maxBytes: 4 * 1024 * 1024 });
    await client.connect();
    const requestId = randomUUID();
    /** @param {string} op @param {any} payload @param {string} [id] */
    const request = async (op, payload, id = randomUUID()) => {
      const reply = await client.request({ version: 1, clientId: "cold-launch", requestId: id, op, payload });
      if (!reply.ok) throw new Error(`${op} failed: ${JSON.stringify(reply.error)}`);
      return reply.result;
    };

    const launched = await request("launch", {
      prompt: PROMPT,
      cwd: repository,
      sourceSessionId: "cold-launch",
      model: { provider: PROVIDER, id: MODEL },
      isolation: { mode: "worktree" },
    }, requestId);
    const sessionId = launched.sessionId;

    // The first successful snapshot taken after the row already carries persisted readiness. Reading
    // the row first, then the snapshot, costs one extra round trip and biases the total upward.
    const deadline = Date.now() + TIMEOUT_MS;
    let firstUsableSnapshotAt = 0;
    /** @type {any} */
    let readyRow;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`session ${sessionId} never reported persisted readiness`);
      const state = await request("get_state", {});
      const row = state.sessions.find((/** @type {any} */ record) => record.sessionId === sessionId);
      if (row?.processState === "LIVE" && row.runtime !== undefined) {
        await request("subscribe_viewer", { sessionId });
        firstUsableSnapshotAt = Date.now();
        readyRow = row;
        break;
      }
      await sleep(READY_POLL_MS);
    }

    const journal = (await readFile(join(root, "queue", "commands.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const accepted = journal.find((record) => record.status?.requestId === requestId && record.status?.stage === "ACCEPTED");
    if (accepted === undefined) throw new Error("launch journal has no ACCEPTED record for this request");

    /** @type {Record<string, number>} */
    const timestamps = { journalAcceptedAt: Date.parse(accepted.status.acceptedAt), firstUsableSnapshotAt };
    const workerSpawnedAt = spawnedAt(clock, readyRow?.ownership?.process?.startIdentity);
    const piChildSpawnedAt = spawnedAt(clock, readyRow?.runtime?.piChild?.startIdentity);
    if (workerSpawnedAt !== undefined) timestamps.workerSpawnedAt = workerSpawnedAt;
    if (piChildSpawnedAt !== undefined) timestamps.piChildSpawnedAt = piChildSpawnedAt;
    const trace = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.sessionId === sessionId);
    for (const stage of LAUNCH_TRACE_STAGES) {
      const entry = trace.find((record) => record.stage === stage);
      if (entry !== undefined) timestamps[TRACE_STAGE_TIMESTAMP[stage]] = entry.at;
    }

    // Sixty idle seconds, then the resident cost one spare would hold while waiting for an operator.
    await sleep(IDLE_MS);
    const state = await request("get_state", {});
    const row = state.sessions.find((/** @type {any} */ record) => record.sessionId === sessionId);
    const workerPid = row?.runtime?.supervisor?.pid;
    const piChildPid = row?.runtime?.piChild?.pid;
    const workerResidentKib = typeof workerPid === "number" ? await residentKib(workerPid) : null;
    const piChildResidentKib = typeof piChildPid === "number" ? await residentKib(piChildPid) : null;

    sample = {
      ok: true,
      timestamps,
      intervals: sampleIntervals(timestamps),
      residency: {
        idleMs: IDLE_MS,
        workerResidentKib,
        piChildResidentKib,
        totalResidentKib: workerResidentKib === null || piChildResidentKib === null ? null : workerResidentKib + piChildResidentKib,
      },
      session: { sessionId, readyRevision: readyRow.revision, confirmedModel: row?.model ?? null, taskState: row?.taskState ?? null, processState: row?.processState ?? null },
      pi: { executable: piBin, version: piVersion, requestedProvider: PROVIDER, requestedModel: MODEL, reportedVersion: row?.runtime?.piVersion ?? null },
    };
  } catch (error) {
    sample = { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.close().catch(() => {});
    await runDaemonCommand("stop", { root, env, allowLiveWorkers: true, stopWorkers: true, yes: true, timeoutMs: TIMEOUT_MS }).catch(() => {});
    await sleep(500);
    // A daemon still unlinking its own files can lose a race with this cleanup.
    await rm(root, { recursive: true, force: true }).catch(async () => { await sleep(2_000); await rm(root, { recursive: true, force: true }).catch(() => {}); });
  }

  const record = {
    ...sample,
    machine: {
      host: hostname(),
      loadavgBefore: loadBefore,
      loadavgAfter: loadavg(),
      nodeVersion: process.version,
      readyPollMs: READY_POLL_MS,
      bootEpochMs: clock.bootEpochMs,
      clockTicks: clock.clockTicks,
      bootClockReadSpreadMs: clock.readSpreadMs,
      spawnClockResidualMs,
    },
    slurm: {
      jobId: process.env.SLURM_JOB_ID ?? null,
      arrayJobId: process.env.SLURM_ARRAY_JOB_ID ?? null,
      arrayTaskId: process.env.SLURM_ARRAY_TASK_ID ?? null,
      partition: process.env.SLURM_JOB_PARTITION ?? null,
      nodelist: process.env.SLURM_JOB_NODELIST ?? null,
    },
    recordedAt: new Date().toISOString(),
  };
  const text = `${JSON.stringify(record, undefined, 2)}\n`;
  if (OUT === "") process.stdout.write(text);
  else await writeFile(OUT, text);
  if (!record.ok) process.exitCode = 1;
}

await main();
