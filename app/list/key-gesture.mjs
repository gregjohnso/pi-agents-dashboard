import { isKeyRelease, isKeyRepeat, Key, matchesKey, parseKey, } from "@earendil-works/pi-tui";
const DOUBLE_LEFT_MS = 500;
/** Return the initial clean-editor gesture state. */
export function createLeftGestureState() {
    return { editedOrHistory: false };
}
function unchanged(state) {
    return { state, openDashboard: false, passThrough: false };
}
/** Reduce editor and key events without intercepting keys outside the activation boundary. */
export function reduceLeftGesture(state, event) {
    if (event.type === "editorChanged") {
        return { ...unchanged({ editedOrHistory: true }), passThrough: false };
    }
    if (event.type === "historyNavigated") {
        return { ...unchanged({ editedOrHistory: true }), passThrough: false };
    }
    if (event.type === "submitted") {
        return unchanged(createLeftGestureState());
    }
    const ordinaryState = state.armedAt === undefined
        ? state
        : { editedOrHistory: state.editedOrHistory };
    const eligibleLeft = event.key === "left"
        && event.phase === "press"
        && !event.modified
        && event.mainEditorFocused
        && event.cursorAtStart;
    if (!eligibleLeft) {
        return { state: ordinaryState, openDashboard: false, passThrough: true };
    }
    const trulyClean = !state.editedOrHistory && event.editorText.length === 0;
    if (trulyClean) {
        return { state: createLeftGestureState(), openDashboard: true, passThrough: false };
    }
    if (state.armedAt !== undefined
        && event.at >= state.armedAt
        && event.at - state.armedAt <= DOUBLE_LEFT_MS) {
        return {
            state: { editedOrHistory: true },
            openDashboard: true,
            passThrough: false,
        };
    }
    return {
        state: { editedOrHistory: true, armedAt: event.at },
        openDashboard: false,
        passThrough: true,
    };
}
/** Compose the dashboard gesture with Pi's documented public CustomEditor API. */
export class DashboardGestureEditor {
    base;
    openDashboard;
    now;
    priorSubmit;
    priorChange;
    wrappedSubmit;
    wrappedChange;
    gesture;
    submitHandler;
    changeHandler;
    constructor(base, openDashboard, now = Date.now) {
        this.base = base;
        this.openDashboard = openDashboard;
        this.now = now;
        this.gesture = base.getText().length === 0
            ? createLeftGestureState()
            : reduceLeftGesture(createLeftGestureState(), { type: "editorChanged", text: base.getText() }).state;
        this.priorSubmit = base.onSubmit;
        this.priorChange = base.onChange;
        this.wrappedSubmit = (text) => {
            this.gesture = reduceLeftGesture(this.gesture, { type: "submitted" }).state;
            this.priorSubmit?.(text);
            this.submitHandler?.(text);
        };
        this.wrappedChange = (text) => {
            this.gesture = reduceLeftGesture(this.gesture, { type: "editorChanged", text }).state;
            this.priorChange?.(text);
            this.changeHandler?.(text);
        };
        base.onSubmit = this.wrappedSubmit;
        base.onChange = this.wrappedChange;
    }
    get onSubmit() { return this.submitHandler; }
    set onSubmit(handler) { this.submitHandler = handler; }
    get onChange() { return this.changeHandler; }
    set onChange(handler) { this.changeHandler = handler; }
    // Pi duck-types this map before wiring callbacks that follow its active interrupt/shortcut handlers.
    get actionHandlers() { return this.base.actionHandlers; }
    set actionHandlers(handlers) { this.base.actionHandlers = handlers; }
    onAction(action, handler) { this.base.onAction(action, handler); }
    get onEscape() { return this.base.onEscape; }
    set onEscape(handler) { this.base.onEscape = handler; }
    get onCtrlD() { return this.base.onCtrlD; }
    set onCtrlD(handler) { this.base.onCtrlD = handler; }
    get onPasteImage() { return this.base.onPasteImage; }
    set onPasteImage(handler) { this.base.onPasteImage = handler; }
    get onExtensionShortcut() { return this.base.onExtensionShortcut; }
    set onExtensionShortcut(handler) { this.base.onExtensionShortcut = handler; }
    get borderColor() { return this.base.borderColor; }
    set borderColor(value) { this.base.borderColor = value; }
    get focused() { return this.base.focused; }
    set focused(value) { this.base.focused = value; }
    getText() { return this.base.getText(); }
    setText(text) { this.base.setText(text); }
    render(width) { return this.base.render(width); }
    invalidate() { this.base.invalidate(); }
    addToHistory(text) { this.base.addToHistory(text); }
    insertTextAtCursor(text) { this.base.insertTextAtCursor(text); }
    getExpandedText() { return this.base.getExpandedText(); }
    setAutocompleteProvider(provider) { this.base.setAutocompleteProvider(provider); }
    setPaddingX(padding) { this.base.setPaddingX(padding); }
    setAutocompleteMaxVisible(maxVisible) { this.base.setAutocompleteMaxVisible(maxVisible); }
    handleInput(data) {
        const parsed = parseKey(data) ?? "unknown";
        const cursor = this.base.getCursor();
        const result = reduceLeftGesture(this.gesture, {
            type: "key",
            key: matchesKey(data, Key.left) ? "left" : parsed,
            at: this.now(),
            editorText: this.base.getText(),
            cursorAtStart: cursor.line === 0 && cursor.col === 0,
            mainEditorFocused: this.base.focused,
            modified: matchesKey(data, Key.left) && parsed !== "left",
            phase: isKeyRelease(data) ? "release" : isKeyRepeat(data) ? "repeat" : "press",
        });
        this.gesture = result.state;
        if (result.openDashboard) {
            this.openDashboard();
            return;
        }
        if (!result.passThrough)
            return;
        const before = this.base.getText();
        const historyCandidate = matchesKey(data, Key.up) || matchesKey(data, Key.down);
        this.base.handleInput(data);
        if (historyCandidate && this.base.getText() !== before) {
            this.gesture = reduceLeftGesture(this.gesture, { type: "historyNavigated" }).state;
        }
    }
    dispose() {
        if (this.base.onSubmit === this.wrappedSubmit)
            this.base.onSubmit = this.priorSubmit;
        if (this.base.onChange === this.wrappedChange)
            this.base.onChange = this.priorChange;
    }
}
