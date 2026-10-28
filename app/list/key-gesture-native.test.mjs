import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ReadStream } from "node:tty";
import { afterEach, expect, it } from "vitest";
import { openOwnerPty } from "../../runtime/pty-mechanism.mjs";
import { inspectProcessIdentity } from "../../runtime/process-identity-linux.mjs";
import { createRealProcessHarness } from "../../test/real-process-harness.mjs";
import { stripSequences } from "../../examples/native-session-demo/smoke.mjs";
import { FAKE_MODEL_ID, FAKE_PROVIDER_ID } from "../../examples/native-session-demo/fake-provider.mjs";
import { PI_ENTRY } from "../viewer/pi-modules.mjs";

const harness = createRealProcessHarness("key-gesture-native");
let handle;
let stream;
afterEach(async () => {
    await harness.cleanup();
    stream?.destroy();
    handle = undefined;
    stream = undefined;
});

async function exited(identity) {
    try {
        const current = await inspectProcessIdentity(identity.pid);
        if (current.startIdentity !== identity.startIdentity) return true;
        const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z ");
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "ESRCH") return true;
        throw error;
    }
}

it("native Escape cancels a running Bash tree and leaves the same Pi owner and draft accepting input", async () => {
    const root = await harness.stateRoot("esc-native-");
    const home = path.join(root, "home");
    const config = path.join(root, "pi-config");
    const project = path.join(root, "project");
    const tmpDir = path.join(root, "tmp");
    await Promise.all([mkdir(home), mkdir(config), mkdir(project), mkdir(tmpDir)]);
    const readyFile = path.join(root, "ready.json");
    const eventsFile = path.join(root, "events.jsonl");
    const shellFile = path.join(root, "shell.pid");
    const childFile = path.join(root, "child.pid");
    const cli = new URL("./cli.js", PI_ENTRY);
    const fixture = new URL("./key-gesture-fixture.ts", import.meta.url);
    handle = await openOwnerPty({
        command: process.execPath, cwd: project, cols: 100, rows: 30,
        args: [cli.pathname, "--no-extensions", "-e", fixture.pathname, "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--provider", FAKE_PROVIDER_ID, "--model", FAKE_MODEL_ID, "--session", path.join(root, "session.jsonl")],
        env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: tmpDir, PI_CODING_AGENT_DIR: config, TERM: "xterm-256color", LANG: "C.UTF-8", XDG_CACHE_HOME: path.join(root, "cache"), JITI_FS_CACHE: "false", PI_ESC_FIXTURE_READY: readyFile, PI_ESC_FIXTURE_EVENTS: eventsFile },
    });
    const { pid, startIdentity, processGroupId } = handle.owner;
    const ownerIdentity = { pid, startIdentity, processGroupId };
    await harness.record("Pi owner", ownerIdentity);
    let raw = "";
    stream = new ReadStream(handle.masterFd);
    stream.on("error", () => {});
    stream.on("data", (chunk) => { raw += chunk.toString(); });
    const input = (text) => handle.write(Buffer.from(text));
    await expect.poll(() => readFile(readyFile, "utf8").catch(() => ""), { timeout: 60_000 }).not.toBe("");
    await expect.poll(() => stripSequences(raw).includes("ESC-FIXTURE-READY"), { timeout: 60_000 }).toBe(true);
    const ready = JSON.parse(await readFile(readyFile, "utf8"));
    expect(ready).toMatchObject({ pid: handle.owner.pid, home, tmpDir, fsCache: "false" });
    input(`!echo $$ > '${shellFile}'; sleep 90 & echo $! > '${childFile}'; wait\r`);
    await expect.poll(() => readFile(childFile, "utf8").catch(() => ""), { timeout: 10_000 }).not.toBe("");
    const shell = await inspectProcessIdentity(Number(await readFile(shellFile, "utf8")));
    const child = await inspectProcessIdentity(Number(await readFile(childFile, "utf8")));
    await harness.record("fixture Bash", shell);
    const draft = "unsent draft after command";
    input(draft);
    const events = async () => (await readFile(eventsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    await expect.poll(async () => (await events()).some((event) => event.text === draft), { timeout: 10_000 }).toBe(true);
    input("\x1b");
    await expect.poll(() => exited(shell), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => exited(child), { timeout: 10_000 }).toBe(true);
    const afterEscape = (await events()).findLast((event) => event.type === "input" && event.data === "\x1b");
    expect(afterEscape).toMatchObject({ text: draft, pid: handle.owner.pid });
    expect(await inspectProcessIdentity(handle.owner.pid)).toEqual(ownerIdentity);
    expect((await events()).some((event) => event.type === "return")).toBe(false);
    input("\x15next input after native abort\r");
    // Pi persists a new session lazily on the first model turn, not on a standalone user Bash command.
    await expect.poll(async () => (await readFile(ready.sessionFile, "utf8").catch(() => "")).includes("DEMO-FAKE-REPLY"), { timeout: 20_000 }).toBe(true);
    const entries = (await readFile(ready.sessionFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(entries.some((entry) => entry.message?.role === "bashExecution" && entry.message.cancelled === true)).toBe(true);
    expect(await inspectProcessIdentity(handle.owner.pid)).toEqual(ownerIdentity);
    input("/quit\r");
    await expect.poll(() => handle.reapIfExited(), { timeout: 10_000 }).not.toBe(null);
    const ownerExit = await handle.wait();
    expect(ownerExit.code).toBe(0);
    console.log(JSON.stringify({ nativeEscape: true, bash: shell, child, childExited: await exited(child), ownerSurvived: handle.owner, draftPreserved: afterEscape.text, nextFakeReply: true, cleanup: ownerExit }));
}, 120_000);
