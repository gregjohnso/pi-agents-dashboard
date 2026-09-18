/**
 * A `Terminal` that records every byte the renderer hands it.
 *
 * Deliberately not an emulator: these cases assert what Pi hands to a terminal, and this fixture keeps
 * that boundary visible. Where a case asserts image protocol bytes it says so; protocol bytes are not
 * proof of visual output on a real terminal, and nothing here claims otherwise.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class RecordingTerminal {
  constructor(columns = 100, rows = 30) {
    this._columns = columns;
    this._rows = rows;
    this.writes = [];
    this.started = false;
    this.stopped = false;
    this.reassertCalls = 0;
    this.negotiatedKittyFlags = undefined;
    this.title = undefined;
    this.progressActive = false;
  }

  start(onInput, onResize) {
    this.started = true;
    this.stopped = false;
    this.onInput = onInput;
    this.onResize = onResize;
    // Bracketed paste, as ProcessTerminal does at startup.
    this.write("\x1b[?2004h");
  }

  stop() {
    this.started = false;
    this.stopped = true;
    this.onInput = undefined;
    this.onResize = undefined;
  }

  async drainInput() {}

  write(data) {
    this.writes.push(data);
  }

  since(index) {
    return this.writes.slice(index).join("");
  }

  all() {
    return this.writes.join("");
  }

  get columns() {
    return this._columns;
  }

  get rows() {
    return this._rows;
  }

  get kittyProtocolActive() {
    return this.negotiatedKittyFlags !== undefined;
  }

  moveBy() {}
  hideCursor() {
    this.write("\x1b[?25l");
  }
  showCursor() {
    this.write("\x1b[?25h");
  }
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}

  setTitle(title) {
    this.title = title;
    this.write(`\x1b]0;${title}\x07`);
  }

  setProgress(active) {
    this.progressActive = active;
  }

  /**
   * The optional seam-E hook, as `ProcessTerminal` implements it: idempotent modes are re-emitted, and the
   * negotiated Kitty keyboard flags are set with `CSI = flags ; 1 u`, never pushed a second time.
   */
  reassertNegotiatedModes() {
    this.reassertCalls += 1;
    this.write("\x1b[?2004h");
    const reemitted = ["bracketed-paste"];
    if (this.negotiatedKittyFlags !== undefined) {
      this.write(`\x1b[=${this.negotiatedKittyFlags};1u`);
      reemitted.push("kitty-keyboard-flags");
    }
    if (this.title !== undefined) {
      this.write(`\x1b]0;${this.title}\x07`);
      reemitted.push("title");
    }
    return {
      reemitted,
      kittyKeyboard:
        this.negotiatedKittyFlags === undefined
          ? undefined
          : { flags: this.negotiatedKittyFlags, reemitted: true, mechanism: "set-flags" },
      modifyOtherKeys: false,
      title: this.title,
      progress: this.progressActive,
    };
  }
}

/** Wait for the renderer's own throttled render path to flush, without polling for a condition. */
export function nextFrames(count = 3) {
  let chain = Promise.resolve();
  for (let index = 0; index < count; index += 1) {
    chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  return chain;
}

/** The smallest real theme the exported `Editor` needs. */
export const editorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};

/**
 * Resolve a package's ESM entry point from an install root.
 *
 * Node's resolver is not used: upstream's `exports` map declares `.` as import-only and does not declare
 * `./package.json`, so both `require.resolve(name)` and `require.resolve(name + "/package.json")` throw
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. The install layout is read directly instead, and the entry is taken from
 * the package's own manifest rather than guessed.
 */
export function resolveInstalledPackageDirectory(installRoot, packageName) {
  let directory = path.resolve(installRoot);
  for (;;) {
    const candidate = path.join(directory, "node_modules", packageName);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`${packageName} is not installed under ${installRoot}`);
    directory = parent;
  }
}

export function resolveInstalledEntry(installRoot, packageName) {
  let directory = path.resolve(installRoot);
  for (;;) {
    const candidate = path.join(directory, "node_modules", packageName);
    if (existsSync(path.join(candidate, "package.json"))) {
      const manifest = JSON.parse(readFileSync(path.join(candidate, "package.json"), "utf8"));
      const dot = manifest.exports?.["."];
      const relative =
        (typeof dot === "string" ? dot : (dot?.import ?? dot?.default)) ?? manifest.module ?? manifest.main;
      if (!relative) throw new Error(`${packageName} declares no ESM entry point in ${candidate}`);
      return pathToFileURL(path.join(candidate, relative)).href;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`${packageName} is not installed under ${installRoot}`);
    directory = parent;
  }
}
