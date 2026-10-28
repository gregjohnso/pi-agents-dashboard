import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });

async function start(fake) {
  vi.stubEnv("PI_DEMO_FAKE_PROVIDER", fake ? "1" : "0");
  vi.stubEnv("PI_AGENTS_OWNER_SIDEBAND_SOCKET", undefined);
  vi.stubEnv("PI_AGENTS_OWNER_SIDEBAND_TOKEN", undefined);
  vi.stubEnv("PI_DEMO_INITIAL_PROMPT_FILE", undefined);
  const root = await mkdtemp(path.join(tmpdir(), "owner-banner-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([new URL("./owner-extension.ts", import.meta.url).pathname], root, root);
  expect(loaded.errors).toEqual([]);
  const extension = loaded.extensions[0];
  const widgets = new Map();
  const listeners = [];
  const tui = { addInputListener(listener) { listeners.push(listener); return () => {}; } };
  let editorFactory;
  const ctx = { mode: "tui", ui: {
    setWidget(key, content) { widgets.set(key, typeof content === "function" ? content(tui) : content); },
    setEditorComponent(factory) { editorFactory = factory; },
  } };
  for (const handler of extension.handlers.get("session_start")) await handler({}, ctx);
  cleanup.push(async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx); });
  return { widgets, shortcuts: [...extension.shortcuts.keys()], listeners, editorFactory };
}

it("keeps native return controls and TUI capture without a real-mode banner", async () => {
  const f = await start(false);
  expect(f.widgets.get("native-session-demo").render(80)).toEqual([]);
  expect(f.editorFactory).toBeTypeOf("function");
  expect(f.shortcuts).toContain("f9");
  expect(f.listeners).toHaveLength(1);
});

it("retains the explicit fake-provider warning in demo mode", async () => {
  const f = await start(true);
  expect(f.widgets.get("native-session-demo").render(300).join("")).toContain("FAKE");
});
