import { CustomEditor, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, TuiMainScreen, getKeybindings } from "@earendil-works/pi-tui";
import { importPiModule } from "../viewer/pi-modules.mjs";

const { KeybindingsManager } = await importPiModule("keybindings");
const editorTheme = {
    borderColor: (text) => text,
    selectList: { selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text },
};

// Call Pi's real duck-typed installation path without starting a session or provider.
function installedEditor(bindings = {}) {
    initTheme("dark");
    const keybindings = new KeybindingsManager(bindings);
    const ui = new TuiMainScreen({ columns: 100, rows: 30, write: vi.fn(), hideCursor: vi.fn() });
    vi.spyOn(ui, "requestRender").mockImplementation(() => {});
    vi.spyOn(ui, "requestImmediateRender").mockImplementation(() => {});
    const defaultEditor = new CustomEditor(ui, editorTheme, keybindings);
    const mode = {
        ui, keybindings, defaultEditor, editor: defaultEditor,
        editorContainer: new Container(), disposeActiveSelector: vi.fn(),
    };
    const interrupt = vi.fn();
    const open = vi.fn();
    defaultEditor.onEscape = interrupt;
    defaultEditor.onAction("app.clear", vi.fn());
    let base;
    InteractiveMode.prototype.setCustomEditorComponent.call(mode, (tui, theme, keys) => {
        base = new CustomEditor(tui, theme, keys);
        return new DashboardGestureEditor(base, open);
    });
    return { mode, ui, base, editor: mode.editor, defaultEditor, interrupt, open };
}
import { describe, expect, it, vi } from "vitest";
import { DashboardGestureEditor, createLeftGestureState, reduceLeftGesture, } from "./key-gesture.mjs";
function left(at, overrides = {}) {
    return {
        type: "key",
        key: "left",
        at,
        editorText: "",
        cursorAtStart: true,
        mainEditorFocused: true,
        modified: false,
        phase: "press",
        ...overrides,
    };
}
describe("Pi native actions through the dashboard editor", () => {
    it("lets Pi wire native interrupt without changing the owner editor or unsent draft", () => {
        const { ui, base, editor, defaultEditor, interrupt, open } = installedEditor();
        editor.setText("unsent draft");
        const cursor = base.getCursor();
        ui.handleTerminalInput("\x1b");
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(editor.actionHandlers).toBe(base.actionHandlers);
        expect(base.actionHandlers.get("app.clear")).toBe(defaultEditor.actionHandlers.get("app.clear"));
        expect(editor.getText()).toBe("unsent draft");
        expect(base.getCursor()).toEqual(cursor);
        expect(open).not.toHaveBeenCalled();
        editor.dispose();
    });
    it("honors a rebound interrupt and follows Pi's changing retry, compaction, exit, paste and shortcut callbacks", () => {
        const { ui, editor, base, defaultEditor, interrupt, open } = installedEditor({ "app.interrupt": "ctrl+e" });
        editor.setText("draft");
        ui.handleTerminalInput("\x1b");
        expect(interrupt).not.toHaveBeenCalled();
        ui.handleTerminalInput("\x05");
        expect(interrupt).toHaveBeenCalledTimes(1);
        const retryAbort = vi.fn();
        defaultEditor.onEscape = retryAbort;
        ui.handleTerminalInput("\x05");
        expect(retryAbort).toHaveBeenCalledTimes(1);
        const compactAbort = vi.fn();
        defaultEditor.onEscape = compactAbort;
        ui.handleTerminalInput("\x05");
        expect(compactAbort).toHaveBeenCalledTimes(1);
        const paste = vi.fn();
        defaultEditor.onPasteImage = paste;
        ui.handleTerminalInput("\x16");
        expect(paste).toHaveBeenCalledTimes(1);
        const shortcut = vi.fn((data) => data === "x");
        defaultEditor.onExtensionShortcut = shortcut;
        ui.handleTerminalInput("x");
        expect(shortcut).toHaveBeenCalledWith("x");
        expect(editor.getText()).toBe("draft");
        defaultEditor.onExtensionShortcut = undefined;
        const exit = vi.fn();
        defaultEditor.onCtrlD = exit;
        editor.setText("");
        ui.handleTerminalInput("\x04");
        expect(exit).toHaveBeenCalledTimes(1);
        const action = vi.fn();
        editor.onAction("app.tools.expand", action);
        ui.handleTerminalInput("\x0f");
        expect(action).toHaveBeenCalledTimes(1);
        expect(base.actionHandlers.get("app.tools.expand")).toBe(action);
        expect(open).not.toHaveBeenCalled();
        editor.dispose();
    });
    it("lets Escape close autocomplete before interrupting, with the same draft and cursor", async () => {
        const { ui, editor, base, interrupt, open } = installedEditor();
        editor.setAutocompleteProvider({
            getSuggestions: () => ({ prefix: "/", items: [{ value: "/one", label: "/one" }, { value: "/two", label: "/two" }] }),
            applyCompletion: vi.fn(),
        });
        ui.handleTerminalInput("/");
        await expect.poll(() => base.isShowingAutocomplete()).toBe(true);
        const cursor = base.getCursor();
        ui.handleTerminalInput("\x1b");
        expect(base.isShowingAutocomplete()).toBe(false);
        expect(interrupt).not.toHaveBeenCalled();
        expect(editor.getText()).toBe("/");
        expect(base.getCursor()).toEqual(cursor);
        ui.handleTerminalInput("\x1b");
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(open).not.toHaveBeenCalled();
        editor.dispose();
    });
    it("keeps Escape and Left with a focused Pi dialog, then restores editor navigation", () => {
        const { ui, editor, base, interrupt, open } = installedEditor();
        editor.setText("draft");
        const cursor = base.getCursor();
        const menu = new SelectList([{ value: "one", label: "one" }], 5, editorTheme.selectList);
        const cancel = vi.fn();
        const overlay = ui.showOverlay(menu);
        menu.onCancel = () => { cancel(); overlay.hide(); };
        ui.handleTerminalInput("\x1b[D");
        expect(open).not.toHaveBeenCalled();
        ui.handleTerminalInput("\x1b");
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(interrupt).not.toHaveBeenCalled();
        expect(editor.getText()).toBe("draft");
        expect(base.getCursor()).toEqual(cursor);
        expect(editor.focused).toBe(true);
        ui.handleTerminalInput("\x01");
        ui.handleTerminalInput("\x1b[D");
        expect(open).not.toHaveBeenCalled();
        ui.handleTerminalInput("\x1b[D");
        expect(open).toHaveBeenCalledTimes(1);
        expect(editor.getText()).toBe("draft");
        editor.dispose();
    });
});

describe("Left dashboard gesture", () => {
    it("opens on one clean Left and requires two Left presses after editing", () => {
        const clean = createLeftGestureState();
        expect(reduceLeftGesture(clean, left(0))).toMatchObject({ openDashboard: true, passThrough: false });
        const dirty = reduceLeftGesture(clean, { type: "editorChanged", text: "x" }).state;
        const erased = reduceLeftGesture(dirty, { type: "editorChanged", text: "" }).state;
        const armed = reduceLeftGesture(erased, left(100));
        expect(armed).toMatchObject({ openDashboard: false, passThrough: true });
        expect(reduceLeftGesture(armed.state, left(599))).toMatchObject({ openDashboard: true, passThrough: false });
    });
    it("uses the real public CustomEditor cursor, history, and keybindings", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const tui = { requestRender: vi.fn() };
        const theme = {
            borderColor: (text) => text,
            selectList: { selectedPrefix: () => "", selectedText: (text) => text, description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text },
        };
        const base = new CustomEditor(tui, theme, getKeybindings());
        base.focused = true;
        const open = vi.fn();
        const editor = new DashboardGestureEditor(base, open, Date.now);
        editor.handleInput("\x1b[D");
        expect(open).toHaveBeenCalledTimes(1);
        editor.handleInput("x");
        editor.handleInput("\x01");
        editor.handleInput("\x1b[D");
        expect(open).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(500);
        editor.handleInput("\x1b[D");
        expect(open).toHaveBeenCalledTimes(2);
        base.setText("");
        base.addToHistory("history prompt");
        editor.handleInput("\x1b[A");
        expect(editor.getText()).toBe("history prompt");
        editor.handleInput("\x01");
        editor.handleInput("\x1b[D");
        vi.advanceTimersByTime(501);
        editor.handleInput("\x1b[D");
        expect(open).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(1);
        editor.handleInput("\x1b[D");
        expect(open).toHaveBeenCalledTimes(3);
        editor.dispose();
        vi.useRealTimers();
    });
});
