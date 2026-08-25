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
