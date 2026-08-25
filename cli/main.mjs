import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDaemonCommand } from "./daemon-commands.mjs";
import { runPackageCommand } from "./package-commands.mjs";
import { runSessionCommand } from "./session-commands.mjs";

async function defaultHostProbe() {
  const module = await import("../extensions/agents-dashboard/compatibility.ts");
  return module.checkHostCapabilities();
}

function writeResult(result, json, io) {
  const payload = result.code === 0
    ? { ok: true, code: "OK", ...result.result }
    : { ok: false, code: result.error?.code ?? "COMMAND_FAILED", message: result.error?.message ?? "Command failed", ...(result.result === undefined ? {} : { result: result.result }) };
  const target = json || result.code === 0 ? io.stdout : io.stderr;
  target.write(json ? `${JSON.stringify(payload)}\n` : `${payload.ok ? payload.kind ?? "ok" : `${payload.code}: ${payload.message}`}\n`);
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const io = deps.io ?? { stdout: process.stdout, stderr: process.stderr };
  const json = argv.includes("--json");
  const args = argv.filter((argument) => argument !== "--json");
  let result;
  try {
    if (args[0] === "daemon") {
      const stopWorkers = args[1] === "stop" && args.length === 4 && args.includes("--stop-workers") && args.includes("--yes");
      if (args.length !== 2 && !stopWorkers) result = { code: 2, error: { code: "INVALID_SYNTAX", message: "Usage: pi-agents-dashboard daemon start|status|restart|recover|stop [--stop-workers --yes]" } };
      else result = await (deps.runDaemonCommand ?? runDaemonCommand)(args[1], stopWorkers ? { ...deps.daemonOptions, stopWorkers: true, yes: true } : deps.daemonOptions);
    } else if (args[0] === "session") {
      result = await (deps.runSessionCommand ?? runSessionCommand)(args.slice(1), deps.sessionOptions);
    } else if ((args[0] === "install" || args[0] === "uninstall") && args.length === 1) {
      result = await (deps.runPackageCommand ?? runPackageCommand)(args[0], deps.packageOptions);
    } else if ((args[0] === "doctor" || args[0] === "run") && args.length === 1) {
      const report = await (deps.hostProbe ?? defaultHostProbe)();
      const unsupported = report.blockers?.length > 0 || report.daemonOwnedStartup === false || report.nativeAttach === false;
      if (unsupported) result = { code: 4, error: { code: "UNSUPPORTED_HOST", message: report.blockers?.join(" ") || "Pi host lacks daemon-owned startup or native attachment" }, result: { kind: "host_capabilities", report } };
      else if (args[0] === "run") result = { code: 1, error: { code: "RUN_UNAVAILABLE", message: "Daemon-backed product launch is not exposed by this CLI task" }, result: { kind: "host_capabilities", report } };
      else result = { code: 0, result: { kind: "host_capabilities", report } };
    } else {
      result = { code: 2, error: { code: "INVALID_SYNTAX", message: "Expected daemon, session, doctor, install, uninstall, or run" } };
    }
  } catch (error) {
    const conflictCodes = new Set(["OWNERSHIP_CONFLICT", "AMBIGUOUS_IDENTITY", "DAEMON_IDENTITY_CONFLICT", "PROCESS_IDENTITY_CONFLICT", "STALE_LEASE"]);
    result = { code: conflictCodes.has(error?.code) ? 5 : 1, error: { code: error?.code ?? "COMMAND_FAILED", message: error instanceof Error ? error.message : "Command failed" } };
  }
  writeResult(result, json, io);
  return result.code;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await runCli();
