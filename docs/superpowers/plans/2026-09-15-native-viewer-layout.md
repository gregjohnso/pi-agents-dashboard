# Native viewer layout implementation plan

> **For agentic workers:** Use the approved design below with test-driven development. Parent owns orchestration, review, commits, and deployment; do not launch children or commit independently.

**Goal:** Give Pi ownership of transcript scrolling, selection, copying, hyperlinks, and search, completing the native interaction repair.

**Architecture:** Render the complete normalized transcript as a Pi component inside one primary `ScrollView`, with header and editor/status/footer dock outside it in a `VStack`. The existing host selects the list or viewer layout and keeps input focus explicit. Pi owns viewport state and gestures; the list retains its dashboard-specific row navigation.

**Tech stack:** JavaScript/JSDoc, pinned pi-coding-agent and pi-tui 0.84.3, Vitest, SLURM verification.

**Spec:** User approved on 2026-09-15: replace the pre-clipped transcript/custom scrolling with Pi's scrolling component, fixed editor/footer, and native mouse/key handling. Session list, workers, canonical conversations, and delivery semantics stay unchanged.

## Constraints

- Work only in `/mnt/main0/home/gjohnson/projects/pi-agents-tool-error-summary`, branch `fix/native-interaction-parity`, based on `8fabab2` plus the existing keyboard repair. Preserve those uncommitted changes.
- No backend, protocol, dependency, worker-version, or live-state changes. No inference or provider requests.
- The existing keyboard repair uses Pi's actual keybinding manager, including user configuration and both nested/root pi-tui instances. Do not copy key tables or migrations.
- Keep native Enter/Alt+Enter delivery, acknowledged-only fallback, and ambiguous-delivery handling unchanged.
- Pi Ctrl+C clears, Ctrl+D exits an empty editor, Ctrl+T toggles thinking, Shift+Tab cycles supported levels, Ctrl+O toggles all tools. Exit only closes the frontend.
- Run tests through `srun -p l40-reserved --qos=dev --time=00:15:00 -N 1`, with explicit output/error files under `~/.cache/pi-agents-native-parity`, followed by `env -u PIXI_PROJECT_MANIFEST pixi run npm test -- <files>`. No test execution on the login node.
- Real RED assertions must precede production changes. Do not replace behavioral tests with source-string checks, skip failures, or suppress runner errors.

## Task 1: Native transcript layout and viewport

**Files:** `app/viewer/transcript.mjs`, `app/viewer/viewer-controller.mjs`, their tests, and a focused layout module beside them if needed for separation.

**Interfaces:** Keep normalized state/event handling and component rendering cache. `TranscriptModel.render(width)` becomes the full document, not a viewport slice. The viewer exposes its native layout root and primary scroll view to the host; its existing `render(width,height)` test seam must render that same layout, not retain a second viewport implementation.

- [ ] Add a real `TuiAltScreen` regression with more transcript lines than the viewport. Send Home, End, PageUp, wheel, and search events through the terminal; assert visible transcript text changes while editor/footer remain fixed. Assert the full document is searchable.
- [ ] Run RED against the current clipped-canvas host.
- [ ] Compose the layout using the actual public types (not guessed `flex` options):

```js
const viewport = new ScrollView(document, { follow: "end", primary: true });
const root = new VStack([
  { component: header, shrink: 0 },
  { component: viewport, basis: 0, grow: 1, minSize: 0 },
  { component: dock, shrink: 0 },
]);
tui.setLayoutRoot(root);
```

- [ ] Delete `linesFromEnd`, `following`, `newActivity`, custom anchor/clamp/tail slicing, and competing viewer scroll-key handlers. Delegate follow/scroll state to `ScrollView`. Preserve render caching by item/tool identity and width.
- [ ] Keep overlays above the native viewport using Pi's overlay mechanism so search/scroll commands do not steal modal input. Preserve editor cursor/focus and narrow-terminal usable transcript space.
- [ ] Replace obsolete custom-scrolling assertions with native viewport behavior tests before removing them. Verify paused follow during streaming, End resumes follow, resize, thinking/tool expansion, and prompt markers if supported by the existing native component API.
- [ ] Run focused GREEN and typecheck.

## Task 2: Host ownership, complete gestures, and shutdown

**Files:** `app/list/standalone-list.mjs`, `app/standalone.mjs`, `app/mouse-input.mjs` and their tests; add real terminal acceptance coverage under `test/`.

**Interfaces:** Hosted and direct viewers mount the same layout. `setLayoutRoot` does not set focus; host switching must do both explicitly. Only dashboard row navigation may intercept input ahead of Pi.

- [ ] Add RED tests for a complete mouse press/drag/release selecting known transcript text and calling an injected clipboard callback once, and an OSC 8 click calling the opener. Include direct attachment and dashboard-to-viewer-to-list switching.
- [ ] Pass all viewer mouse bytes unchanged to Pi. Restrict or relocate the existing tap to dashboard-only handling; delete viewer `handleMouse` scrolling and any now-unused parser code. Do not implement another drag recognizer.
- [ ] Supply native clipboard/open-browser helpers to `TuiAltScreen` in its fourth constructor argument. Public helpers are preferred. One documented pinned import of Pi's browser helper is approved if it is not exported; do not write a competing opener.

```js
const tui = new TuiAltScreen(terminal, false, undefined, {
  copySelection,
  openUrl,
});
```

- [ ] Restore list layout/focus on return and after failed opens; prevent viewer scroll regions or search state from capturing list controls. Preserve lazy Pi imports before first list paint.
- [ ] Use native fullscreen shutdown semantics, verified in `stopInteractiveTui`: `tui.stop({ preserveScreen: true })`. Test cleanup and no accidental screen spill; do not alter daemon/worker lifetime.
- [ ] Run focused GREEN, real terminal acceptance, and typecheck without snapshot-update flags on the verification run.

## Task 3: Complete and verify the interaction contract

**Files:** `AGENTS.md`, `README.md`, `docs/development.md`, current help/snapshots, plus the existing keyboard repair where a regression requires it.

- [ ] Bind `app.model.select` to the existing model picker (native Ctrl+L), with a real-editor RED/GREEN test. No new model-cycling implementation.
- [ ] Document Pi interaction ownership separately from Claude-style background-session management. Explain the pinned internal keybinding/browser imports and the shared manager across nested pi-tui copies.
- [ ] Document actual remaining unsupported Pi features, especially dequeue/queue clearing over RPC; do not claim complete Pi feature parity.
- [ ] Report focused commands, genuine RED/GREEN evidence, changed files, remaining risks, and any staged rename from the previous worker. No commits or deployment by the worker.
- [ ] Parent performs independent keyboard/behavior and viewport/host review, then runs the full suite, typecheck, and package checks using `~/.cache/pi-agents-native-parity/verify.py`.
- [ ] Parent integrates only after findings are resolved and the final tree passes. Frontend-only deployment does not restart daemon or workers.
