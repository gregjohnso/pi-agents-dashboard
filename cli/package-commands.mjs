import { spawn as nodeSpawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function packageRoot() {
  return realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}

function spawnCommand(file, argv, options) {
  return new Promise((resolveChild, rejectChild) => {
    const child = nodeSpawn(file, argv, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectChild);
    child.once("close", (code) => resolveChild({ code: code ?? 1, stdout, stderr }));
  });
}

export async function runPackageCommand(command, { spawn = spawnCommand } = {}) {
  const operation = command === "install" ? "install" : command === "uninstall" ? "remove" : undefined;
  if (operation === undefined) return { code: 2, error: { code: "INVALID_COMMAND", message: "Package command must be install or uninstall" } };
  const root = await packageRoot();
  const result = await spawn("pi", [operation, root], { shell: false });
  return result.code === 0
    ? { code: 0, result: { kind: command === "install" ? "installed" : "uninstalled", packageRoot: root }, stdout: result.stdout, stderr: result.stderr }
    : { code: 1, error: { code: "PI_REGISTRATION_FAILED", message: result.stderr || `pi ${operation} failed` }, stdout: result.stdout, stderr: result.stderr };
}
