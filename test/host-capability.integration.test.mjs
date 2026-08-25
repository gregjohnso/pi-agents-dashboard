import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { checkHostCapabilities } from "../extensions/agents-dashboard/compatibility.js";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");
const piExecutable = join(projectRoot, "node_modules", ".bin", "pi");
const temporaryRoots = new Set();

/** @param {string} socketPath */
async function startFakeDaemon(socketPath) {
  const identity = Object.freeze({ workerId: "worker-1", writerLease: "writer-1" });
  const server = createServer((connection) => {
    connection.end(`${JSON.stringify(identity)}\n`);
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });

  return {
    identity,
    writerCount: 1,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose(undefined));
    }),
  };
}

/**
 * @param {import("../extensions/agents-dashboard/compatibility.js").HostCapabilityReport} report
 * @param {{ identity: { workerId: string, writerLease: string }, writerCount: number }} daemon
 */
function attemptNativeAttach(report, daemon) {
  if (!report.daemonOwnedStartup || !report.nativeAttach) {
    return {
      status: "unsupported",
      code: "UNSUPPORTED_HOST",
      blockers: report.blockers,
    };
  }

  throw new Error(
    `Host ${report.piVersion} reports support, but no approved public native adapter fixture is recorded. ` +
    `Worker ${daemon.identity.workerId} was not attached.`,
  );
}

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => {
    await rm(root, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }));
});

it("installs as a Pi package and returns typed unsupported before native frontend construction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agents-dashboard-host-"));
  temporaryRoots.add(root);
  const piConfig = join(root, "pi-config");
  await mkdir(piConfig, { recursive: true });

  await execFileAsync(piExecutable, ["install", projectRoot], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piConfig,
      PI_OFFLINE: "1",
    },
    timeout: 10_000,
  });

  const settings = JSON.parse(await readFile(join(piConfig, "settings.json"), "utf8"));
  expect(settings.packages).toHaveLength(1);
  expect(resolve(piConfig, settings.packages[0])).toBe(projectRoot);

  const fakeDaemon = await startFakeDaemon(join(root, "fake-daemon.sock"));
  const originalIdentity = fakeDaemon.identity;
  try {
    const report = await checkHostCapabilities();
    const result = attemptNativeAttach(report, fakeDaemon);

    expect(result).toEqual({
      status: "unsupported",
      code: "UNSUPPORTED_HOST",
      blockers: report.blockers,
    });
    expect(fakeDaemon.identity).toBe(originalIdentity);
    expect(fakeDaemon.writerCount).toBe(1);
  } finally {
    await fakeDaemon.close();
  }
}, 15_000);
