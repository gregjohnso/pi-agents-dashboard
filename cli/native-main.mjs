import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displaySessionState } from "../app/list/session-state.mjs";

const HELP = `Usage: pi-agents [options]

Open the native Pi session dashboard.

Options:
  --cwd <dir>        project directory (default: invoking directory)
  --state <dir>      dashboard metadata (default: <HOME>/.pi-agents)
  --sessions <dir>   short owner runtime root (default: /tmp/pi-save-default-<uid>)
  --real             use normal Pi configuration (default)
  --fake             use the deterministic fixture provider
  --pi-config <dir>  private Pi configuration for --fake only
  --help, -h         show this help
  --version          show the package version

       pi-agents new [--cwd <dir>] [--name <name>] [--model <provider/id>] [prompt...]

Start one session in the background, as the dashboard's prompt does, and print its id.
It runs in --cwd (default: invoking directory) and appears in the dashboard.

       pi-agents list [--json]
       pi-agents send [--interrupt] <session> <message...>

List live sessions, or add a message to one. <session> is the short ID from list, a full session id, or a
unique name. Run from inside a session, the message names that session as the sender, so the receiver can
reply with send. A message waits for the receiver's running turn to end; --interrupt steers it instead.
`;
const VERSION = "pi-agents 0.0.2";
const VALUE_FLAGS = new Set(["--cwd", "--state", "--sessions", "--pi-config"]);
const PACKAGED_COHORT_MANIFEST = fileURLToPath(new URL("../runtime/cohort-manifest.json", import.meta.url));

/** @param {string} message */
function syntax(message) {
  return Object.assign(new Error(message), { code: "INVALID_SYNTAX" });
}

/**
 * Resolve only the native dashboard grammar. Legacy administrative verbs are unsupported.
 * @param {{ argv: string[], cwd: string, homeDir: string, uid: number }} input
 */
export function resolveNativeOptions({ argv, cwd, homeDir, uid }) {
  const values = new Map();
  let selectedMode;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--real" || argument === "--fake") {
      const mode = argument.slice(2);
      if (selectedMode !== undefined) {
        throw syntax(selectedMode === mode ? `${argument} may be given only once` : "--real conflicts with --fake");
      }
      selectedMode = mode;
      continue;
    }
    if (!VALUE_FLAGS.has(argument)) throw syntax(`unsupported argument ${argument}`);
    if (values.has(argument)) throw syntax(`${argument} may be given only once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw syntax(`${argument} needs a directory`);
    values.set(argument, path.resolve(cwd, value));
    index += 1;
  }
  const mode = selectedMode ?? "real";
  if (values.has("--pi-config") && mode !== "fake") throw syntax("--pi-config is only accepted with --fake");
  return {
    mode,
    projectCwd: values.get("--cwd") ?? cwd,
    stateHome: values.get("--state") ?? path.join(homeDir, ".pi-agents"),
    sessionsHome: values.get("--sessions") ?? path.join("/tmp", `pi-save-default-${uid}`),
    piConfigHome: values.get("--pi-config"),
    manifestPath: PACKAGED_COHORT_MANIFEST,
  };
}

/** @param {any} options */
async function defaultOpenManager(options) {
  const { runNativeManager } = await import(new URL("../examples/native-session-demo/manager-demo.mjs", import.meta.url).href);
  return runNativeManager(options);
}

/**
 * `new`: the dashboard's own launch call, without the dashboard. Flags first, then the prompt words.
 * @param {{ argv: string[], cwd: string, homeDir: string, uid: number }} input
 */
export function resolveNewOptions({ argv, cwd, homeDir, uid }) {
  const values = new Map();
  let index = 0;
  for (; index < argv.length && ["--cwd", "--name", "--model"].includes(argv[index]); index += 2) {
    const value = argv[index + 1];
    if (value === undefined) throw syntax(`${argv[index]} needs a value`);
    if (values.has(argv[index])) throw syntax(`${argv[index]} may be given only once`);
    values.set(argv[index], value);
  }
  const model = values.get("--model");
  const separator = model?.indexOf("/") ?? -1;
  if (model !== undefined && (separator <= 0 || separator === model.length - 1)) throw syntax(`--model takes provider/id, not ${model}`);
  const projectCwd = path.resolve(cwd, values.get("--cwd") ?? ".");
  return {
    backend: { mode: "real", sessionsHome: path.join("/tmp", `pi-save-default-${uid}`), stateHome: path.join(homeDir, ".pi-agents"), manifestPath: PACKAGED_COHORT_MANIFEST },
    request: {
      prompt: argv.slice(index).join(" "),
      cwd: projectCwd,
      ...(values.has("--name") ? { name: values.get("--name") } : {}),
      ...(model === undefined ? {} : { model: { provider: model.slice(0, separator), id: model.slice(separator + 1) } }),
      isolation: { mode: "shared_directory", confirmedCwd: projectCwd },
    },
  };
}

/** The ID `list` shows and `send` takes: the end of Pi's session id, else the dashboard's. @param {any} row */
function shortId(row) {
  return (row.durable?.piSessionId || row.sessionId).slice(-6);
}

/**
 * The one live session `target` names: exactly by id, short id or name, else by a part of an id.
 * @param {any[]} rows @param {string} target
 */
function resolveTarget(rows, target) {
  const live = rows.filter((row) => row.processState === "LIVE");
  const lower = target.toLowerCase();
  const exactMatches = live.filter((row) => row.sessionId === target || shortId(row) === target || row.durable?.piSessionId === target || (row.name ?? "").toLowerCase() === lower);
  const matches = exactMatches.length > 0 || target.length < 4 ? exactMatches
    : live.filter((row) => row.sessionId.includes(target) || (row.durable?.piSessionId ?? "").includes(target));
  if (matches.length === 1) return matches[0];
  const reason = matches.length === 0
    ? `no live session matches ${target}; run pi-agents list`
    : `${target} matches ${matches.length} live sessions (${matches.map(shortId).join(", ")}); use its short ID`;
  throw Object.assign(new Error(reason), { code: matches.length === 0 ? "SESSION_NOT_FOUND" : "SESSION_AMBIGUOUS" });
}

/** @param {any} options */
async function defaultCreateBackend(options) {
  const { createNativeBackend } = await import(new URL("../app/list/native-backend.mjs", import.meta.url).href);
  return createNativeBackend(options);
}

/** @param {string[]} argv @param {any} deps */
export async function runNativeCli(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (argv[0] === "list" || argv[0] === "send") {
    const env = deps.env ?? process.env;
    try {
      const rest = argv.slice(1);
      const json = argv[0] === "list" && rest.includes("--json");
      const interrupt = argv[0] === "send" && rest[0] === "--interrupt";
      const words = interrupt ? rest.slice(1) : rest;
      if (argv[0] === "list" && rest.some((word) => word !== "--json")) throw syntax("list takes only --json");
      if (argv[0] === "send" && (words.length < 2 || words[1] === "")) throw syntax("send needs a session and a message: pi-agents send [--interrupt] <session> <message...>");
      const homeDir = deps.homeDir ?? homedir();
      const backend = await (deps.createBackend ?? defaultCreateBackend)({ mode: "real", sessionsHome: path.join("/tmp", `pi-save-default-${deps.uid ?? process.getuid?.() ?? 0}`), stateHome: path.join(homeDir, ".pi-agents") });
      try {
        const { sessions } = await backend.getState();
        if (argv[0] === "list") {
          const rows = sessions.filter((row) => row.processState === "LIVE").map((row) => ({ id: shortId(row), sessionId: row.sessionId, state: displaySessionState(row), name: row.name ?? "", cwd: row.cwd ?? "" }));
          if (json) stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
          else {
            const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
            const home = (/** @type {string} */ cwd) => cwd === homeDir || cwd.startsWith(`${homeDir}/`) ? `~${cwd.slice(homeDir.length)}` : cwd;
            const line = (/** @type {string[]} */ cells) => `${cells[0].padEnd(8)}${cells[1].padEnd(13)}${cells[2].padEnd(nameWidth + 2)}${cells[3]}`.trimEnd();
            stdout.write(`${[line(["ID", "STATE", "NAME", "CWD"]), ...rows.map((row) => line([row.id, row.state, row.name, home(row.cwd)]))].join("\n")}\n`);
          }
          return 0;
        }
        const target = resolveTarget(sessions, words[0]);
        const from = env.PI_AGENTS_SESSION_ID ?? "";
        const sender = sessions.find((row) => row.sessionId === from);
        await backend.sendMessage(target.sessionId, { text: words.slice(1).join(" "), from, fromName: sender?.name ?? "", interrupt });
        stdout.write(`sent to ${target.name ?? target.sessionId} (${shortId(target)})\n`);
        return 0;
      } finally {
        backend.close();
      }
    } catch (error) {
      const failure = /** @type {any} */ (error);
      stderr.write(`${failure?.code ?? "SEND_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
      return failure?.code === "INVALID_SYNTAX" ? 2 : 1;
    }
  }
  if (argv[0] === "new") {
    try {
      const { backend: options, request } = resolveNewOptions({ argv: argv.slice(1), cwd: deps.cwd ?? process.cwd(), homeDir: deps.homeDir ?? homedir(), uid: deps.uid ?? process.getuid?.() ?? 0 });
      const backend = await (deps.createBackend ?? defaultCreateBackend)(options);
      try {
        const { sessionId } = await backend.launch(request);
        stdout.write(`${sessionId}\n`);
      } finally {
        backend.close();
      }
      return 0;
    } catch (error) {
      const failure = /** @type {any} */ (error);
      stderr.write(`${failure?.code ?? "LAUNCH_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
      return failure?.code === "INVALID_SYNTAX" ? 2 : 1;
    }
  }
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(HELP);
    return 0;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  try {
    const options = resolveNativeOptions({
      argv,
      cwd: deps.cwd ?? process.cwd(),
      homeDir: deps.homeDir ?? homedir(),
      uid: deps.uid ?? process.getuid?.() ?? 0,
    });
    await (deps.openManager ?? defaultOpenManager)({
      ...options,
      stdin: deps.stdin ?? process.stdin,
      stdout,
      stderr,
    });
    return 0;
  } catch (error) {
    const failure = /** @type {any} */ (error);
    const code = failure?.code === "INVALID_SYNTAX" ? 2 : 1;
    stderr.write(`${failure?.code ?? "NATIVE_APP_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    return code;
  }
}
