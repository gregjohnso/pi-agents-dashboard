import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import { PI_KEYBINDINGS_MODULE, PI_TUI_MODULE, createPiKeybindings, installPiKeybindings } from "./pi-keybindings.mjs";

/**
 * The viewer's keys are Pi's keys, including the operator's own `keybindings.json`.
 *
 * Operator-visible failure each test names: a documented shortcut this viewer resolves to a
 * different key than Pi does, a remap Pi honours and this viewer ignores, and a remap the editor
 * and the selection lists ignore because they read pi-tui's global manager rather than ours.
 */

/** @type {string[]} */
const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** One throwaway Pi agent directory, so no test reads the operator's own configuration. */
async function agentDir(bindings = undefined) {
  const dir = await mkdtemp(join(tmpdir(), "pi-agents-keybindings-"));
  dirs.push(dir);
  if (bindings !== undefined) await writeFile(join(dir, "keybindings.json"), JSON.stringify(bindings));
  return dir;
}

describe("Pi keybindings in the viewer", () => {
  it("resolves every action this viewer owns to Pi's own documented default key", async () => {
    const keybindings = createPiKeybindings(await agentDir());
    expect(Object.fromEntries(["app.interrupt", "app.clear", "app.exit", "app.thinking.toggle", "app.thinking.cycle", "app.tools.expand", "app.message.followUp", "tui.select.cancel", "tui.input.submit"]
      .map((action) => [action, keybindings.getKeys(action)]))).toEqual({
      "app.interrupt": ["escape"],
      "app.clear": ["ctrl+c"],
      "app.exit": ["ctrl+d"],
      "app.thinking.toggle": ["ctrl+t"],
      "app.thinking.cycle": ["shift+tab"],
      "app.tools.expand": ["ctrl+o"],
      "app.message.followUp": ["alt+enter"],
      "tui.select.cancel": ["escape", "ctrl+c"],
      "tui.input.submit": ["enter"],
    });
  });

  it("honours a remapped action and Pi's own legacy binding names from the operator's config", async () => {
    const remapped = createPiKeybindings(await agentDir({ "app.tools.expand": "ctrl+e" }));
    expect(remapped.getKeys("app.tools.expand")).toEqual(["ctrl+e"]);
    expect(remapped.matches("\x05", "app.tools.expand")).toBe(true);
    expect(remapped.matches("\x0f", "app.tools.expand")).toBe(false);

    // Pi migrates its pre-namespace names in memory; a config written for an older Pi still applies.
    const legacy = createPiKeybindings(await agentDir({ toggleThinking: "ctrl+y", cursorUp: "alt+up" }));
    expect(legacy.getKeys("app.thinking.toggle")).toEqual(["ctrl+y"]);
    expect(legacy.getKeys("tui.editor.cursorUp")).toEqual(["alt+up"]);
  });

  it("installs one manager in both pi-tui copies, because Pi ships its own", async () => {
    const keybindings = createPiKeybindings(await agentDir({ "tui.select.cancel": "ctrl+q" }));
    expect(installPiKeybindings(keybindings)).toBe(keybindings);
    // This package's own Input, SelectList and ScrollView resolve their keys from this singleton.
    expect(getKeybindings()).toBe(keybindings);
    expect(getKeybindings().matches("\x11", "tui.select.cancel")).toBe(true);
    // Pi's editor and its own components resolve theirs from the copy under Pi's package.
    const piTui = await import(PI_TUI_MODULE);
    expect(piTui.getKeybindings()).toBe(keybindings);
    expect(piTui).not.toBe(await import("@earendil-works/pi-tui"));
  });

  // Canary: Pi 0.84.3 exports only ".", "./rpc-entry" and "./client", so its keybinding table, user
  // config loader and legacy-name migrations are reachable only next to the package's own entry
  // point. When this fails Pi moved or renamed that module: follow it, or ask for an export. Never
  // restate the table here, because a copy drifts silently from the keys Pi documents.
  it("still finds Pi's own table, loader and migrations beside the package entry point", async () => {
    const module = await import(PI_KEYBINDINGS_MODULE);
    expect(PI_KEYBINDINGS_MODULE).toMatch(/core\/keybindings\.js$/u);
    expect(typeof module.KEYBINDINGS).toBe("object");
    expect(module.KEYBINDINGS["app.thinking.toggle"]).toMatchObject({ defaultKeys: "ctrl+t" });
    expect(typeof module.KeybindingsManager.create).toBe("function");
    expect(typeof module.migrateKeybindingsConfig).toBe("function");
    expect(PI_TUI_MODULE).toMatch(/pi-coding-agent\/node_modules\/@earendil-works\/pi-tui\//u);
    expect(typeof (await import(PI_TUI_MODULE)).setKeybindings).toBe("function");
  });
});
