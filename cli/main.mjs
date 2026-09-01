import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDaemonCommand } from "./daemon-commands.mjs";
import { runAgentsCommand, runLogsCommand, runSessionCommand } from "./session-commands.mjs";

const HELP = `Usage: pi-agents [--pi-bin /absolute/path/to/pi]
       pi-agents agents [--json]
       pi-agents attach <full-session-id>
       pi-agents logs [<full-session-id>]
       pi-agents stop|rm <full-session-id> --revision <n> --yes
       pi-agents respawn <full-session-id> --revision <n> --yes
       pi-agents daemon start|status|restart|recover|stop [--stop-workers --yes]
       pi-agents session cleanup <full-session-id> --revision <n> --yes

With no arguments, pi-agents opens the machine-local session list.
`;
const SESSION_VERBS = new Set(["stop", "rm", "respawn"]);
/** Recovery operations Claude Code has no verb for, so they stay under the session namespace. */
const RECOVERY_VERBS = new Set(["cleanup"]);
const RECOVERY_USAGE = "Usage: pi-agents session cleanup <full-id> --revision <n> --yes";
const LOGS_USAGE = "Usage: pi-agents logs [<full-session-id>]";

async function defaultOpenApp(options) {
  const { runDashboardApp } = await import(new URL("../app/standalone.mjs", import.meta.url).href);
  return runDashboardApp(options);
}

async function defaultAttachSession(sessionId, options) {
  const { attachSession } = await import(new URL("./attach-command.mjs", import.meta.url).href);
  return attachSession(sessionId, options);
}

function writeResult(result, json, io) {
  const payload = result.code === 0
    ? { ok: true, code: "OK", ...result.result }
    : { ok: false, code: result.error?.code ?? "COMMAND_FAILED", message: result.error?.message ?? "Command failed", ...(result.result === undefined ? {} : { result: result.result }) };
  // A log tail is the answer itself, so plain output is the bytes read and nothing around them.
  if (!json && payload.ok && payload.kind === "logs") {
    io.stdout.write(payload.text);
    return;
  }
  const target = json || result.code === 0 ? io.stdout : io.stderr;
  target.write(json ? `${JSON.stringify(payload)}\n` : `${payload.ok ? payload.kind ?? "ok" : `${payload.code}: ${payload.message}`}\n`);
}

/** Run the standalone CLI and exact administrative commands. */
export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const io = deps.io ?? { stdout: process.stdout, stderr: process.stderr };
  const json = argv.includes("--json");
  const args = argv.filter((argument) => argument !== "--json");
  let result;
  try {
    const listOnly = args.length === 1 && args[0] === "agents";
    const standalone = args.length === 0 || listOnly || (args.length === 2 && args[0] === "--pi-bin" && isAbsolute(args[1]));
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      io.stdout.write(HELP);
      return 0;
    }
    if (standalone && !(listOnly && json)) {
      await (deps.openApp ?? defaultOpenApp)({
        cwd: deps.cwd ?? process.cwd(), piBin: args[0] === "--pi-bin" ? args[1] : undefined,
        env: deps.env ?? process.env, stdin: deps.stdin ?? process.stdin, stdout: deps.stdout ?? io.stdout, stderr: deps.stderr ?? io.stderr,
      });
      if (json) writeResult({ code: 0, result: { kind: "closed" } }, true, io);
      return 0;
    }
    if (listOnly) result = await (deps.runAgentsCommand ?? runAgentsCommand)(deps.sessionOptions);
    else if (args[0] === "daemon") {
      const stopWorkers = args[1] === "stop" && args.length === 4 && args.includes("--stop-workers") && args.includes("--yes");
      if (args.length !== 2 && !stopWorkers) result = { code: 2, error: { code: "INVALID_SYNTAX", message: "Usage: pi-agents daemon start|status|restart|recover|stop [--stop-workers --yes]" } };
      // The daemon commands wait on a process this one does not own, and only they can say so while
      // the wait is still running: writeResult below runs after the answer already exists.
      else result = await (deps.runDaemonCommand ?? runDaemonCommand)(args[1], { ...deps.daemonOptions, stderr: io.stderr, ...(stopWorkers ? { stopWorkers: true, yes: true } : {}) });
    } else if (args[0] === "attach") {
      result = args.length === 2
        ? await (deps.attachSession ?? defaultAttachSession)(args[1], deps.attachOptions)
        : { code: 2, error: { code: "INVALID_SYNTAX", message: "Usage: pi-agents attach <full-session-id>" } };
    } else if (args[0] === "logs") {
      result = args.length <= 2
        ? await (deps.runLogsCommand ?? runLogsCommand)(args[1], deps.sessionOptions)
        : { code: 2, error: { code: "INVALID_SYNTAX", message: LOGS_USAGE } };
    } else if (SESSION_VERBS.has(args[0])) result = await (deps.runSessionCommand ?? runSessionCommand)(args, deps.sessionOptions);
    else if (args[0] === "session") {
      result = RECOVERY_VERBS.has(args[1])
        ? await (deps.runSessionCommand ?? runSessionCommand)(args.slice(1), deps.sessionOptions)
        : { code: 2, error: { code: "INVALID_SYNTAX", message: RECOVERY_USAGE } };
    } else result = { code: 2, error: { code: "INVALID_SYNTAX", message: "Usage: pi-agents [--pi-bin /absolute/path] | agents | attach ... | logs ... | stop ... | rm ... | respawn ... | daemon ... | session ..." } };
  } catch (error) {
    const conflictCodes = new Set(["OWNERSHIP_CONFLICT", "AMBIGUOUS_IDENTITY", "DAEMON_IDENTITY_CONFLICT", "PROCESS_IDENTITY_CONFLICT", "STALE_LEASE"]);
    result = { code: conflictCodes.has(error?.code) ? 5 : 1, error: { code: error?.code ?? "COMMAND_FAILED", message: error instanceof Error ? error.message : "Command failed" } };
  }
  writeResult(result, json, io);
  return result.code;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await runCli();
