import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { afterEach, expect, it, vi } from "vitest";

import { createDaemonClient } from "../app/daemon-client.mjs";
import { createStandaloneList } from "../app/list/standalone-list.mjs";
import { RegistryStore } from "../runtime/registry-store.mjs";
import { ScreenTerminal, mouseReport } from "./alt-screen-harness.mjs";
import { createRealProcessHarness } from "./real-process-harness.mjs";

/**
 * The frontend the operator actually launches: `createStandaloneList`, over a real daemon, opening a
 * real viewer on a real alternate screen.
 *
 * Operator-visible failure this pins: the hosted frontend built its alternate screen with no
 * clipboard and no hyperlink opener, so a drag across a hosted viewer's transcript copied nothing.
 * Only `pi-agents attach` had them. The second failure it pins is the list's own wheel tap staying
 * on top of a viewer, where it swallows the press that starts a selection before Pi sees it.
 */

const fakePiSource = await readFile(fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url)), "utf8");
const harness = createRealProcessHarness("list-native-mouse-acceptance");
/** @type {any[]} */
const closers = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
  await harness.cleanup();
});

/** One state root running a real daemon over the bounded fake Pi, holding one launched session. */
async function liveSession() {
  const root = await harness.stateRoot("pi-agents-list-mouse-", ["canonical", "daemon", "sessions", "runs", "index"]);
  const executable = join(root, "pi");
  await writeFile(executable, fakePiSource, { mode: 0o700 });
  await chmod(executable, 0o700);
  const started = await harness.daemon("start", { root, piBin: executable, env: { ...process.env, FAKE_PI_LOG: join(root, "fake-pi.jsonl") }, timeoutMs: 20_000 });
  expect(started).toMatchObject({ code: 0 });
  const client = createDaemonClient({
    socketPath: join(root, "daemon", "control.sock"),
    token: (await readFile(join(root, "daemon", "control.token"), "utf8")).trim(),
    clientId: "list-native-mouse-launcher", attachId: "list-native-mouse-launcher-process", reconnect: false, maxBytes: 256 * 1024,
  });
  await client.connect();
  const launched = await client.request({
    version: 1, clientId: "list-native-mouse-launcher", requestId: "launch-list-mouse", op: "launch",
    payload: { prompt: "select this transcript line", cwd: root, sourceSessionId: "dashboard-list-mouse", isolation: { mode: "shared_directory", confirmedCwd: root, ownerSessionIds: [] } },
  });
  if (!launched.ok) throw new Error(`Launch failed: ${JSON.stringify(launched)}`);
  const records = await new RegistryStore(join(root, "sessions")).list();
  if (records[0]?.ownership?.process !== undefined) await harness.record("launched worker", records[0].ownership.process);
  await client.close();
  return { piBin: executable, root, sessionId: launched.result.sessionId };
}

it("copies a dragged viewer selection through the hosted frontend's own alternate screen", async () => {
  // Pi reads the operator's own keybindings.json from this directory; a remap of his must not decide
  // what this test presses.
  vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "pi-agents-default-keybindings"));
  const { piBin, root, sessionId } = await liveSession();
  const terminal = new ScreenTerminal({ columns: 100, rows: 30 });
  const copySelection = vi.fn(async () => true);
  const openUrl = vi.fn();
  const list = await createStandaloneList({
    cwd: root, terminal, copySelection, openUrl,
    frontend: { root, piBin, clientId: "list-native-mouse", attachId: "list-native-mouse-process", async close() {} },
  });
  closers.push(() => list.close());

  // Open the selected session from the list, the way Right does. The viewer's own header names the
  // session, which the list never prints: that is what says the screen is the viewer's now.
  await vi.waitFor(() => expect(terminal.text()).toContain("select this transcript line"), { timeout: 30_000, interval: 20 });
  terminal.type("\x1b[C");
  await vi.waitFor(() => expect(terminal.text()).toContain(`· ${sessionId} ·`), { timeout: 60_000, interval: 20 });
  await vi.waitFor(() => {
    expect(terminal.screen().findIndex((line) => line.includes("select this transcript line"))).toBeGreaterThanOrEqual(0);
  }, { timeout: 30_000, interval: 20 });

  const row = terminal.screen().findIndex((line) => line.includes("select this transcript line"));
  const column = terminal.screen()[row].indexOf("select this");
  terminal.type(mouseReport({ button: 0, column, row }));
  terminal.type(mouseReport({ button: 32, column: column + 11, row }));
  terminal.type(mouseReport({ button: 0, column: column + 11, row, release: true }));

  await vi.waitFor(() => expect(copySelection).toHaveBeenCalledTimes(1), { timeout: 30_000, interval: 20 });
  expect(copySelection.mock.calls[0][0]).toContain("select this");
}, 120_000);
