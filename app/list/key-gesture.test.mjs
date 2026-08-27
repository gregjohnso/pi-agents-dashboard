import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
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
    it.each([
        [499, true],
        [500, true],
        [501, false],
    ])("uses the exact 500 ms boundary: %d ms", (elapsed, opens) => {
        const dirty = reduceLeftGesture(createLeftGestureState(), { type: "editorChanged", text: "" }).state;
        const armed = reduceLeftGesture(dirty, left(10)).state;
        expect(reduceLeftGesture(armed, left(10 + elapsed))).toMatchObject({ openDashboard: opens });
    });
    it("treats whitespace, history, and type-then-erase as non-clean", () => {
        const cases = [
            reduceLeftGesture(createLeftGestureState(), { type: "editorChanged", text: " " }).state,
            reduceLeftGesture(createLeftGestureState(), { type: "historyNavigated" }).state,
            reduceLeftGesture(reduceLeftGesture(createLeftGestureState(), { type: "editorChanged", text: "x" }).state, { type: "editorChanged", text: "" }).state,
        ];
        for (const state of cases)
            expect(reduceLeftGesture(state, left(1))).toMatchObject({ openDashboard: false, passThrough: true });
    });
    it.each([
        ["cursor away", { cursorAtStart: false }],
        ["modified Left", { modified: true }],
        ["non-main focus", { mainEditorFocused: false }],
        ["repeat", { phase: "repeat" }],
        ["release", { phase: "release" }],
    ])("preserves normal Left for %s", (_name, override) => {
        expect(reduceLeftGesture(createLeftGestureState(), left(0, override))).toMatchObject({ openDashboard: false, passThrough: true });
    });
    it("cancels an armed gesture on another key and resets after successful submit", () => {
        const dirty = reduceLeftGesture(createLeftGestureState(), { type: "historyNavigated" }).state;
        const armed = reduceLeftGesture(dirty, left(100)).state;
        const other = reduceLeftGesture(armed, { ...left(200), key: "down" });
        // Every key the gesture does not claim reaches the editor untouched.
        expect(other).toMatchObject({ openDashboard: false, passThrough: true });
        const cancelled = other.state;
        expect(reduceLeftGesture(cancelled, left(300))).toMatchObject({ openDashboard: false, passThrough: true });
        const submitted = reduceLeftGesture(cancelled, { type: "submitted" }).state;
        expect(reduceLeftGesture(submitted, left(400))).toMatchObject({ openDashboard: true, passThrough: false });
    });
    it("delegates an empty unfocused Left and opens only after public focus is restored", () => {
        const tui = { requestRender: vi.fn() };
        const theme = {
            borderColor: (text) => text,
            selectList: { selectedPrefix: () => "", selectedText: (text) => text, description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text },
        };
        const base = new CustomEditor(tui, theme, getKeybindings());
        const delegated = vi.spyOn(base, "handleInput");
        const open = vi.fn();
        const editor = new DashboardGestureEditor(base, open);
        base.focused = false;
        editor.handleInput("\x1b[D");
        expect(delegated).toHaveBeenCalledOnce();
        expect(open).not.toHaveBeenCalled();
        base.focused = true;
        editor.handleInput("\x1b[D");
        expect(open).toHaveBeenCalledOnce();
        editor.dispose();
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
