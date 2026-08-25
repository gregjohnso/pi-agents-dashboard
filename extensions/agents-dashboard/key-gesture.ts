import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
  parseKey,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";

export interface LeftGestureState {
  readonly editedOrHistory: boolean;
  readonly armedAt?: number;
}

export type LeftGestureEvent =
  | { type: "editorChanged"; text: string }
  | { type: "historyNavigated" }
  | { type: "submitted" }
  | {
      type: "key";
      key: string;
      at: number;
      editorText: string;
      cursorAtStart: boolean;
      mainEditorFocused: boolean;
      modified: boolean;
      phase: "press" | "repeat" | "release";
    };

export interface LeftGestureResult {
  readonly state: LeftGestureState;
  readonly openDashboard: boolean;
  readonly passThrough: boolean;
}

const DOUBLE_LEFT_MS = 500;

/** Return the initial clean-editor gesture state. */
export function createLeftGestureState(): LeftGestureState {
  return { editedOrHistory: false };
}

function unchanged(state: LeftGestureState): LeftGestureResult {
  return { state, openDashboard: false, passThrough: false };
}

/** Reduce editor and key events without intercepting keys outside the activation boundary. */
export function reduceLeftGesture(
  state: LeftGestureState,
  event: LeftGestureEvent,
): LeftGestureResult {
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

  if (
    state.armedAt !== undefined
    && event.at >= state.armedAt
    && event.at - state.armedAt <= DOUBLE_LEFT_MS
  ) {
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
  private readonly base: CustomEditor;
  private readonly openDashboard: () => void;
  private readonly now: () => number;
  private readonly priorSubmit?: (text: string) => void;
  private readonly priorChange?: (text: string) => void;
  private readonly wrappedSubmit: (text: string) => void;
  private readonly wrappedChange: (text: string) => void;
  private gesture: LeftGestureState;
  private submitHandler?: (text: string) => void;
  private changeHandler?: (text: string) => void;

  constructor(base: CustomEditor, openDashboard: () => void, now: () => number = Date.now) {
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

  get onSubmit(): ((text: string) => void) | undefined { return this.submitHandler; }
  set onSubmit(handler: ((text: string) => void) | undefined) { this.submitHandler = handler; }
  get onChange(): ((text: string) => void) | undefined { return this.changeHandler; }
  set onChange(handler: ((text: string) => void) | undefined) { this.changeHandler = handler; }
  get borderColor() { return this.base.borderColor; }
  set borderColor(value) { this.base.borderColor = value; }
  get focused(): boolean { return this.base.focused; }
  set focused(value: boolean) { this.base.focused = value; }

  getText(): string { return this.base.getText(); }
  setText(text: string): void { this.base.setText(text); }
  render(width: number): string[] { return this.base.render(width); }
  invalidate(): void { this.base.invalidate(); }
  addToHistory(text: string): void { this.base.addToHistory(text); }
  insertTextAtCursor(text: string): void { this.base.insertTextAtCursor(text); }
  getExpandedText(): string { return this.base.getExpandedText(); }
  setAutocompleteProvider(provider: AutocompleteProvider): void { this.base.setAutocompleteProvider(provider); }
  setPaddingX(padding: number): void { this.base.setPaddingX(padding); }
  setAutocompleteMaxVisible(maxVisible: number): void { this.base.setAutocompleteMaxVisible(maxVisible); }

  handleInput(data: string): void {
    const parsed = parseKey(data) ?? "unknown";
    const cursor = this.base.getCursor();
    const result = reduceLeftGesture(this.gesture, {
      type: "key",
      key: matchesKey(data, Key.left) ? "left" : parsed,
      at: this.now(),
      editorText: this.base.getText(),
      cursorAtStart: cursor.line === 0 && cursor.col === 0,
      mainEditorFocused: true,
      modified: matchesKey(data, Key.left) && parsed !== "left",
      phase: isKeyRelease(data) ? "release" : isKeyRepeat(data) ? "repeat" : "press",
    });
    this.gesture = result.state;
    if (result.openDashboard) {
      this.openDashboard();
      return;
    }
    if (!result.passThrough) return;

    const before = this.base.getText();
    const historyCandidate = matchesKey(data, Key.up) || matchesKey(data, Key.down);
    this.base.handleInput(data);
    if (historyCandidate && this.base.getText() !== before) {
      this.gesture = reduceLeftGesture(this.gesture, { type: "historyNavigated" }).state;
    }
  }

  dispose(): void {
    if (this.base.onSubmit === this.wrappedSubmit) this.base.onSubmit = this.priorSubmit;
    if (this.base.onChange === this.wrappedChange) this.base.onChange = this.priorChange;
  }
}
