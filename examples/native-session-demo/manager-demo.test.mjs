/**
 * The existing manager, backed by native Pi.
 *
 * Three things are checked here, all of them the parts that can be decided without a terminal:
 *
 *   1. the native backend really answers the contract `DashboardController` asks of a client, with rows
 *      built from owner facts rather than from anything rendered;
 *   2. `createStandaloneList`'s two new injections default to today's behaviour, so the installed path
 *      is unchanged when nothing is passed;
 *   3. the Left gesture the owner installs is the dashboard's own helper, and it claims Left only at the
 *      approved boundary — which is the property that keeps cursor movement, dialogs and overlays working.
 *
 * The flow itself is driven through the actual dashboard entry point on a real terminal by
 * `manager-flow.mjs`; these cases exist so a failure there has a smaller explanation.
 */

import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNativeBackend } from "../../app/list/native-backend.mjs";
import { selectDashboardSessions } from "../../app/list/dashboard-state.mjs";
import { displaySessionState } from "../../app/list/session-state.mjs";
import { DashboardGestureEditor, createLeftGestureState, reduceLeftGesture } from "../../app/list/key-gesture.mjs";

/** The contract's own unions, so a near-miss state value is caught here rather than on a screen. */
const TASK_STATES = ["WORKING", "WAITING", "READY", "FAILED", "STOPPED"];
const PROCESS_STATES = ["LIVE", "SLEEPING", "EXITED", "STALE"];
const OUTCOMES = ["NONE", "COMPLETED", "READY_FOR_REVIEW"];

/** The six methods `DashboardController` calls, plus the two `runViewerTransition` calls. */
const CLIENT_CONTRACT = ["getState", "subscribeListChanges", "refreshSummaries", "preflightLaunch", "launch", "getModels", "attach", "detach"];

/** A minimal editor that records what reached it, standing in for Pi's real one in gesture cases. */
function fakeBaseEditor(text = "", cursor = { line: 0, col: 0 }) {
  const seen = [];
  return {
    seen,
    focused: true,
    onSubmit: undefined,
    onChange: undefined,
    getText: () => text,
    setText: (value) => { text = value; },
    getCursor: () => cursor,
    moveCursorTo: (next) => { cursor = next; },
    handleInput: (data) => seen.push(data),
    render: () => [],
    invalidate: () => {},
  };
}

describe("the native backend answers the dashboard's client contract", () => {
  it("implements every method the controller and the viewer transition call", () => {
    const client = createNativeBackend({ sessionsHome: "/tmp/does-not-need-to-exist-yet" });
    for (const method of CLIENT_CONTRACT) {
      expect(typeof client[method], `client.${method}`).toBe("function");
    }
    client.close();
  });

  it("reports an empty sessions home as no sessions, not as a failure", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-backend-"));
    const client = createNativeBackend({ sessionsHome });
    const snapshot = await client.getState();
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.cursor).toBeDefined();
    client.close();
  });

  it("lists a session directory whose owner is unreachable rather than hiding it", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-backend-"));
    await mkdir(path.join(sessionsHome, "session-gone"), { recursive: true });
    const client = createNativeBackend({ sessionsHome });
    const { sessions } = await client.getState();
    expect(sessions).toHaveLength(1);
    const [row] = sessions;
    expect(row.sessionId).toBe("session-gone");
    // Structured state, never inference - and a failed connection is NOT evidence of exit, so an unreachable
    // owner is STALE, the repository's existing unconfirmed-worker state, rather than a death nobody observed.
    expect(row.processState).toBe("STALE");
    expect(row.taskState).not.toBe("STOPPED");
    expect(row.taskState).not.toBe("FAILED");
    expect(row.activity.summary).toMatch(/could not be reached/u);
    client.close();
  });

  /**
   * The defect this replaces: a live owner was reported with `processState: "RUNNING"`, which is not a
   * value the contract has. The dashboard's default `live` view keeps only `LIVE`, so the launched
   * session was filtered out of the list and the pending STARTING row sat beside nothing forever.
   */
  it("uses only the contract's own state values, so the default live view keeps a live session", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-backend-"));
    await mkdir(path.join(sessionsHome, "session-live"), { recursive: true });
    const client = createNativeBackend({ sessionsHome });
    const { sessions } = await client.getState();
    for (const row of sessions) {
      expect(PROCESS_STATES).toContain(row.processState);
      expect(TASK_STATES).toContain(row.taskState);
      expect(OUTCOMES).toContain(row.outcome);
      expect(displaySessionState(row)).not.toBe(undefined);
    }
    // And the row a live owner produces survives the dashboard's own default filter.
    const live = { ...sessions[0], processState: "LIVE", taskState: "READY" };
    expect(selectDashboardSessions([live], { view: "live" })).toHaveLength(1);
    // The near-miss this pins would be dropped, which is why the value matters.
    expect(selectDashboardSessions([{ ...live, processState: "RUNNING" }], { view: "live" })).toHaveLength(0);
    client.close();
  });

  /**
   * This used to assert the defect: preflight echoed the draft's cwd and mode back without resolving either,
   * so `/somewhere` "passed". It now runs the repository's own preflight, so a real directory is canonicalised
   * and an impossible one is refused. Worktree resolution and its refusals are covered in
   * `manager-launch.test.mjs`.
   */
  it("resolves a shared-directory preflight against the real directory, and refuses one that does not exist", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-backend-"));
    const shared = await realpath(await mkdtemp(path.join(tmpdir(), "native-shared-")));
    const client = createNativeBackend({ sessionsHome });
    const preflight = await client.preflightLaunch({ cwd: shared, isolationMode: "shared_directory", sourceSessionId: "dashboard-test" });
    expect(preflight).toEqual({ canonicalCwd: shared, isolationMode: "shared_directory", ownerSessionIds: [] });
    await expect(client.preflightLaunch({ cwd: "/definitely/not/here", isolationMode: "shared_directory", sourceSessionId: "dashboard-test" })).rejects.toThrow();
    client.close();
  });

  it("delivers a payload-free invalidation and stops delivering after unsubscribe", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-backend-"));
    const client = createNativeBackend({ sessionsHome });
    let changes = 0;
    const unsubscribe = await client.subscribeListChanges(() => { changes += 1; });
    await mkdir(path.join(sessionsHome, "session-new"), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterCreate = changes;
    expect(afterCreate).toBeGreaterThan(0);
    unsubscribe();
    await mkdir(path.join(sessionsHome, "session-second"), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(changes).toBe(afterCreate);
    client.close();
  });

  /**
   * The defect this replaces: the watcher treated any change under the sessions home as an
   * invalidation, so a running owner writing its own log - including in answer to the status request
   * each read makes - made every read provoke the next one, and the dashboard spun in
   * `readCurrentList` instead of drawing the row it already had.
   */
  it("raises no invalidation for churn inside an existing session, so a read cannot provoke the next", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-backend-"));
    const root = path.join(sessionsHome, "session-live");
    await mkdir(root, { recursive: true });
    const client = createNativeBackend({ sessionsHome });
    let changes = 0;
    const unsubscribe = await client.subscribeListChanges(() => { changes += 1; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const baseline = changes;
    // Exactly what a live owner does while the list reads it: append to its own log, repeatedly.
    for (let write = 0; write < 25; write += 1) {
      await writeFile(path.join(root, "manager.log"), `line ${write}\n`, { flag: "a" });
      await client.getState();
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(changes).toBe(baseline);
    unsubscribe();
    client.close();
  });

  it("still invalidates when a session directory is removed, not only when one is added", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-backend-"));
    await mkdir(path.join(sessionsHome, "session-going"), { recursive: true });
    const client = createNativeBackend({ sessionsHome });
    let changes = 0;
    const unsubscribe = await client.subscribeListChanges(() => { changes += 1; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const baseline = changes;
    await rm(path.join(sessionsHome, "session-going"), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(changes).toBeGreaterThan(baseline);
    unsubscribe();
    client.close();
  });

  it("writes no trace inside the sessions home, because that would be an invalidation of its own", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-backend-"));
    const traceFile = path.join(await mkdtemp(path.join(tmpdir(), "native-trace-")), "backend.log");
    const client = createNativeBackend({ sessionsHome, traceFile });
    await client.getState();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readdir(sessionsHome)).toEqual([]);
    expect(await readFile(traceFile, "utf8")).toMatch(/getState/u);
    client.close();
  });

  it("refuses to report a failed launch as a started session", async () => {
    const sessionsHome = await mkdtemp(path.join(tmpdir(), "native-backend-"));
    // `node` that cannot run the demo: the launch must raise rather than add a row. The isolation is named
    // and satisfiable so the failure under test is the launch itself, not the isolation refusal.
    const client = createNativeBackend({ sessionsHome, node: "/bin/false" });
    await expect(client.launch({
      prompt: "hello", cwd: sessionsHome, sourceSessionId: "dashboard-test",
      isolation: { mode: "shared_directory", confirmedCwd: sessionsHome, ownerSessionIds: [] },
    })).rejects.toThrow(/native launch failed/u);
    expect((await client.getState()).sessions).toEqual([]);
    client.close();
  });
});

describe("the existing entry point keeps its installed behaviour", () => {
  it("still constructs its own daemon client and RPC viewer when nothing is injected", async () => {
    const source = await readFile(new URL("../../app/list/standalone-list.mjs", import.meta.url), "utf8");
    // The daemon client is still constructed inside the function, behind the absence of an injection.
    expect(source).toContain("injectedClient ?? await");
    expect(source).toContain("createDaemonClient({ socketPath:");
    // And the reconstructed viewer is still the default opener.
    expect(source).toContain("injectedOpenViewer === undefined");
    expect(source).toContain("? openRealViewer");
  });

  it("hands an injected opener the pieces it needs to reuse the existing transition", async () => {
    const source = await readFile(new URL("../../app/list/standalone-list.mjs", import.meta.url), "utf8");
    for (const piece of ["tui,", "client,", "controller,", "runViewerTransition,", "activateList(", "shouldRestore(", "onRestoreClosed("]) {
      expect(source).toContain(piece);
    }
  });
});

describe("Left returns only at the approved boundary", () => {
  const press = (overrides) => ({
    type: "key",
    key: "left",
    at: 1_000,
    editorText: "",
    cursorAtStart: true,
    mainEditorFocused: true,
    modified: false,
    phase: "press",
    ...overrides,
  });

  it("returns immediately from a clean empty prompt", () => {
    const result = reduceLeftGesture(createLeftGestureState(), press({}));
    expect(result.openDashboard).toBe(true);
    expect(result.passThrough).toBe(false);
  });

  it("leaves Left to Pi when a dialog or overlay holds focus", () => {
    const result = reduceLeftGesture(createLeftGestureState(), press({ mainEditorFocused: false }));
    expect(result.openDashboard).toBe(false);
    expect(result.passThrough).toBe(true);
  });

  it("leaves Left to Pi for editing when the cursor is not at the start", () => {
    const result = reduceLeftGesture(createLeftGestureState(), press({ cursorAtStart: false, editorText: "draft" }));
    expect(result.openDashboard).toBe(false);
    expect(result.passThrough).toBe(true);
  });

  it("moves the cursor on the first Left with text, and returns only on a second", () => {
    const dirty = reduceLeftGesture(createLeftGestureState(), { type: "editorChanged", text: "draft" }).state;
    const first = reduceLeftGesture(dirty, press({ editorText: "draft" }));
    expect(first.openDashboard).toBe(false);
    expect(first.passThrough).toBe(true);
    const second = reduceLeftGesture(first.state, press({ editorText: "draft", at: 1_200 }));
    expect(second.openDashboard).toBe(true);
  });

  it("does not treat a modified or released Left as the gesture", () => {
    expect(reduceLeftGesture(createLeftGestureState(), press({ modified: true })).passThrough).toBe(true);
    expect(reduceLeftGesture(createLeftGestureState(), press({ phase: "release" })).passThrough).toBe(true);
  });
});

describe("the wrapper installed in native Pi keeps Pi's editor behaviour", () => {
  it("passes every non-gesture key through to Pi's own editor", () => {
    const base = fakeBaseEditor();
    const editor = new DashboardGestureEditor(base, () => {});
    editor.handleInput("x");
    editor.handleInput("\u001b[C");
    expect(base.seen).toEqual(["x", "\u001b[C"]);
  });

  it("calls back exactly once when Left is the gesture, and does not forward it", () => {
    const base = fakeBaseEditor();
    let returns = 0;
    const editor = new DashboardGestureEditor(base, () => { returns += 1; });
    editor.handleInput("\u001b[D");
    expect(returns).toBe(1);
    expect(base.seen).toEqual([]);
  });

  it("forwards Left as an editing key when the cursor is not at the start", () => {
    const base = fakeBaseEditor("draft", { line: 0, col: 3 });
    let returns = 0;
    const editor = new DashboardGestureEditor(base, () => { returns += 1; });
    editor.handleInput("\u001b[D");
    expect(returns).toBe(0);
    expect(base.seen).toEqual(["\u001b[D"]);
  });

  it("restores the base editor's own handlers when disposed", () => {
    const base = fakeBaseEditor();
    const original = () => {};
    base.onSubmit = original;
    const editor = new DashboardGestureEditor(base, () => {});
    expect(base.onSubmit).not.toBe(original);
    editor.dispose();
    expect(base.onSubmit).toBe(original);
  });
});
