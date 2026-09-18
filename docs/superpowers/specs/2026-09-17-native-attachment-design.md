# Native attachment: one whole Pi per session, many writing terminals

## Status: isolated implementation authorized; native parity unproved

**Status: isolated implementation authorized; exact native parity remains unproved.** The target shape is one permanent pseudo-terminal per worker hosting a **pinned, project-maintained seam-enabled Pi build**, one owner-local management extension, and seven native integration seams Pi 0.84.3 does not expose. M0 measured stock-Pi gaps and partial terminal-state candidates. The user approved maintaining the required Pi patches inside this repository without waiting for upstream; that does not establish child-terminal parity, input provenance or the durable submit barrier on the future build. Patch size and implementation effort remain unknown.

**What is settled and not re-litigated here:** the product direction — Claude-Code-Linux-style multi-attach over one whole native Pi, every authenticated terminal typing into one shared draft, no controller role, no observer role, no takeover, no kick.

**What this document is not.** It is not approval to implement, to run anything, or to change an installed package. Every name under "Proposed interfaces" is a proposal. No size, cost or difficulty claim is made about any of them.

## Evidence classes

Each claim below is tagged. Mixing these produced the withdrawn conclusions of earlier rounds.

| Class | Meaning |
| --- | --- |
| **executed** | Ran against stock Pi 0.84.3 in the corrected feasibility spike, artifacts on disk |
| **source** | Read from installed `dist/` or from this repository at a named line range |
| **proposed** | A contract this document invents to specify an obligation |
| **unproved** | Believed, with no evidence of either kind |

### What the spike actually established

**executed**, stock runtime, disposable roots, from [the corrected report](/mnt/main0/home/gjohnson/.cache/pi-agents-native-attach-feasibility/REPORT.md):

- **Two clients** — not two *authenticated* clients — typed into one native draft in arrival order. The probe's `HELLO` name is not authentication and no authentication was exercised. Authentication is proposed host behavior with no evidence behind it yet.
- One shared `winsize`; `ioctl(TIOCSWINSZ)` from either client reflows both.
- The owner and its extension timer survived the last detach: 15 heartbeats with nothing attached, unchanged identity, retained draft.
- A resize after reattach revealed the retained draft — a SIGWINCH side effect, not a repaint API.
- `ctrl+g` launched the external editor on the owner's real terminal and text came back, **with one client attached**.
- Real installed extensions loaded and drew their own UI (`/monitors`, `/subagents-fleet`, **empty state only**).
- `ctrl+r` in owner one's `/resume` selector wrote a rename into a **different live owner's** canonical file, silently. This is the only integrity hazard proven so far.
- `pi.on("input")` is awaited before agent processing and before canonical persistence; `handled` suppressed the turn; a 2.5 s hold delayed dispatch.
- Left reached a second client's overlay natively; closing one socket detached only that client.

**Not established, and not to be cited as if it were:** authentication, late full repaint, geometry corruption (the old screen oracle mishandled deferred wrap across SGR and is withdrawn), active-fleet rendering, `ctrl+o`, any real fsync failure, the steer/follow-up barrier, cross-file resume, mixed-capability correctness, and multi-client external-editor behavior. The probe's `ptyhost.py:247-261` `finish()` can misattribute an already-exited unreaped child to host cleanup; that defect is corrected as the first milestone task, in the cache harness, before any exit-cause claim reuses it.

## Implemented today vs proposed here

| Capability | Implemented today | Proposed here |
| --- | --- | --- |
| Durable acceptance | `RECEIVED` fsync before any RPC write, five stages, `DELIVERY_UNKNOWN` never retried ([worker.mjs:190-254](../../../runtime/worker.mjs#L190)) | the same discipline moved **ahead of Pi's own queue mutation** (seam A), plus attachment blobs and effective payloads |
| Canonical identity | one row per canonical file, `canonicalSessionFile` immutable on update, duplicate-path create refused ([registry-store.mjs:372-444](../../../runtime/registry-store.mjs#L372)) | reservations on exact resolved names, binding generations, coverage of Pi's own in-process rebinds and the selector's direct writes (seam D) |
| Worker lifetime | worker listens, daemon connects, worker survives daemon absence indefinitely ([worker.mjs:280-336](../../../runtime/worker.mjs#L280)) | unchanged, extended to hold a PTY master instead of RPC pipes |
| Process identity | recorded pid + start identity + process group, revalidated at every signal ([worker-supervisor.mjs:479-492](../../../runtime/worker-supervisor.mjs#L479)) | extended with session id and a stored wait status, because the owner becomes a session leader |
| Attachment | one frontend viewer per session, composed from RPC frames ([app/viewer/](../../../app/viewer/)) | many authenticated terminal attachments with epochs into one native UI |
| Terminal capability | Pi negotiates once at startup against the owner's terminal; **executed**: the second client saw no query at all | a host-defined launch-fixed virtual profile, with reply classification that is an explicit open API decision (seam F) |
| Readiness | worker `ready` frame with a strict allowlist | separate `native-mounted` / `initialized` / `first-paint` receipts plus a bootstrap snapshot for late registrants |
| Repaint | none; the viewer rebuilds from normalized frames | `presentTerminal` with cold-terminal cache invalidation (seam E) |
| Automatic replacement | `replaceStaleWorker` / `scheduleUpgradeRespawn` fire on model idle ([daemon.mjs:739-873](../../../runtime/daemon.mjs#L739)) | **removed**; only an explicit operator stop replaces an owner |

## The seven native seams, and why no supported API reaches them

### Seam A — durable acceptance must precede any native enqueue

**source.** `ExtensionRunner.emitInput` awaits the handler inside `try`, catches, calls `emitError`, and continues, returning `continue` unless something returned `handled` or transformed ([runner.js:930-965](../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js#L930)). An extension that throws because `fsync` failed is **fail-open**. `handled` suppresses the turn but is reported as successful preflight, not as a refusal.

**source.** The hook is also too late for three paths. `queueCompactionMessage` pushes `{text, mode}` into `compactionQueuedMessages`, adds history and clears the editor **before** any `session.prompt` call ([interactive-mode.js:3604-3609](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js#L3604), reached from `2523-2533` and `3354-3363`). Built-in slash handlers act in `defaultEditor.onSubmit` before `AgentSession.prompt`. Direct `steer()`/`followUp()` expand templates and queue without emitting `input` at all ([agent-session.js:989-1139](../../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L989)).

### Seam B — input provenance is destroyed before any supported surface

**source.** `ProcessTerminal` reads one UTF-8 stdin stream through one `StdinBuffer`, answers keyboard-protocol replies, and hands the TUI plain sequence strings ([terminal.js:130-249](../../../node_modules/@earendil-works/pi-tui/dist/terminal.js#L130)). `TuiBase` consumes capability replies **before** input listeners, then dispatches synchronously to the focused component ([tui.js:553-624](../../../node_modules/@earendil-works/pi-tui/dist/tui.js#L553)). `ctx.ui.onTerminalInput` is exactly `(data: string) => { consume?: boolean; data?: string } | undefined`.

**executed.** Two socket chunks are not two labelled input events: a split CSI from A absorbed a byte from B (`split:B[D!`) and a bracketed paste from A swallowed B's byte.

### Seam C — return authorization has nowhere to stand

**source.** A custom editor's `handleInput(data): void` may consume Left with empty text and cannot declare whether it owns an action ([editor-component.d.ts:10-35](../../../node_modules/@earendil-works/pi-tui/dist/editor-component.d.ts#L10)). `TUI.hasOverlay()` is public; `getFocusedComponent()` is on `TuiBase` but not the public `TUI` type. Overlay-absent plus empty `getEditorText()` is insufficient.

### Seam D — canonical mutations bypass every existing hook

**source.** `showSessionSelector` calls `SessionManager.open(sessionFilePath).appendSessionInfo(next)` directly ([interactive-mode.js:4457-4463](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js#L4457)) — no `session_before_switch`, no `session_before_fork`. That is the **executed** cross-owner rename. `session_before_switch` can admit a *known* resume target, but new and fork targets are named after the event and fork can create the file before teardown ([agent-session-runtime.js:128-253](../../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js#L128)). Selector delete calls `deleteSessionFile` (trash, then unlink) checking only its own active session ([session-selector.js:539-571](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js#L539)). `/import` can copy over a destination before replacing. Delete and import are **source, unproved**.

### Seam E — a cold terminal cannot be brought current by repaint alone

**source.** `TUI.renderNow(force)` exists and forcing calls `resetRenderState()`. In fullscreen, `resetRenderState` clears the text screen and layout but **not** `uploadedKittyImages` ([tui-alt-screen.js:232-237](../../../node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js#L232)); `prepareKittyScreen` then suppresses transmission when that cache matches (`185-203`), so a cold terminal can receive a placement for an image it never got. Alt-screen entry, autowrap, mouse modes, bracketed paste, the Kitty keyboard stack, `modifyOtherKeys`, cursor shape, synchronized output, title and progress were all emitted at startup and a late client missed them.

**executed.** A reattached client got a blank screen holding only rows written after it attached, and the second client saw no capability query (`clientBQueriesSeen: []`).

A captured startup byte tail is **not** a state snapshot; replaying it can issue stale queries and unbalanced mode pushes. No raw tail is ever presented as history or state anywhere in this design.

## Where each gap is solved

| Gap | Owner | Basis |
| --- | --- | --- |
| PTY master, owner lifetime, detach survival | host | **executed**: stock Pi already ran under a physical PTY and survived the last detach |
| Authentication, attachment epochs, membership, backpressure | host | **proposed**; the spike exercised none of it |
| Shared geometry and resize ordering | host | **executed**: one `winsize`, `TIOCSWINSZ` is the only path |
| Client terminal mode save/restore at the frontend | host | the frontend owns its own terminal before and after relay |
| Cold-terminal mode and image presentation | host + seam E | the host can emit modes; only Pi can invalidate `uploadedKittyImages` without resetting search, selection, focus or components |
| Structured status, abort, shutdown request | extension | `ctx.abort()`, `ctx.shutdown()`, `session_start`, `setWidget` all exist |
| Bridge-ready signal | extension | `session_start` gives it somewhere to connect from |
| Mounted / initialized / first-paint receipts, and a bootstrap snapshot | seam E | `session_start` runs during init and the native UI starts before extensions ([interactive-mode.js:639-782](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js#L639)); an extension hello is not a frame, and an extension registered after mount never saw the mount event |
| Durable pre-enqueue submit barrier | seam A | the compaction, slash and direct-steer paths bypass the only awaited hook |
| Per-attachment input provenance | seam B | provenance is gone before any supported surface |
| Return authorization at the ordered input boundary | seam C | no return disposition exists on `EditorComponent` |
| Canonical-operation admission on exact resolved names | seam D | rename, delete and import touch files with no event at all |
| Terminal-response classification | **open API decision** (seam F) | see "Query replies" below; neither candidate is settled |
| Managed child-terminal phase with ordered input drain | **seam G, newly required** | see "Child terminal ownership" below; the foreground-process-group test is insufficient |
| Exact process-exit observation | host | the worker reaps its own child; an extension receipt is never a completed stop |

## Retained invariants

None of these may be traded to make a gate pass.

1. Acceptance is the **worker's** fsync of the operator's original text. Never a daemon journal, never `pty.write()` returning, never a byte count.
2. Nothing is replayed after an ambiguous outcome, at any layer. `DELIVERY_UNKNOWN` is terminal.
3. One canonical writer per session file; input writers are unlimited and are a different concept.
4. Worker lifetime is independent of the daemon and of the attachment set. An empty attachment set is not an orphan.
5. Model idle is not extension idle. No timeout, disconnect, stale lease or `isIdle` authorizes replacing an owner.
6. Native keybindings, the operator's `keybindings.json`, custom editors, overlays and extension renderers are Pi's and are never reimplemented, wrapped or disabled.
7. First list paint stays ahead of every Pi and extension import; no preload for an unlaunched session. The measured reason is at [standalone-list.mjs:184-195](../../../app/list/standalone-list.mjs#L184).
8. Return is authorized by the owner at the ordered input boundary and detaches only the originating attachment.
9. No raw byte tail is ever presented as history or state.
10. Rows come from structured facts Pi publishes. Unknown stays unknown.
11. Every authenticated attached terminal can type. **Currently unsatisfied during child ownership** — see gate 5.

## Proposed interfaces

None of these exist in Pi 0.84.3. Versions are **proposed pending freeze**.

### Identity

```ts
type OwnerRunIdentity = {
  initialRowId: string;        // the registry row this owner was launched against; never changes
  runId: string;               // one owner process lifetime
  ownerPid: number;
  ownerStartIdentity: string;  // /proc start identity, guards pid reuse
  hostId: string;              // machine identity
  bootId: string;              // /proc/sys/kernel/random/boot_id; a reboot invalidates pid claims
};

type CanonicalBinding = {
  currentRowId: string;        // the row of the file this owner writes NOW; may differ from initialRowId
  canonicalFile: string;
  device: string; inode: string;
  generation: number;          // monotonic per owner, advances on every rebind
};

type AttachmentEpoch = { attachmentId: string; epoch: number };  // epoch strictly increases, never reused
type GeometryRevision = number;
```

`initialRowId` and `currentRowId` are deliberately separate. A single `sessionId` could not express an owner that has moved to another file, which is the situation `switchSession` creates.

### Seam A — submission barrier

```ts
type SubmissionEnvelope = {
  submissionId: string;        // minted by Pi, stable across transform, queue, drain and reload
  ownerRunId: string;
  binding: { canonicalFile: string; generation: number };
  source: 'native-editor' | 'native-followup' | 'native-steer' | 'compaction-queue'
        | 'builtin-command' | 'extension-command' | 'startup-prompt' | 'extension-api';
  intent: 'prompt' | 'steer' | 'follow_up' | 'command';
  originalText: string;        // before trim, transform, template or skill expansion
  attachments?: { kind: 'image' | 'file'; mediaType: string; byteLength: number; sha256: string }[];
  behavior: 'idle' | 'streaming';
  draftRevision: number;
  attachmentOrigin?: AttachmentEpoch;  // the submit gesture, NOT authorship of a shared draft
  parentSubmissionId?: string;
};

type SubmissionFence = { submissionId: string; ownerRunId: string; bindingGeneration: number; nonce: string };

type Authorization =
  | { authorized: true; fence: SubmissionFence }
  | { authorized: false; code: 'PERSISTENCE_FAILED' | 'PERSISTENCE_UNCERTAIN' | 'STALE_BINDING'
                             | 'DUPLICATE_SUBMISSION' | 'REFUSED'; reason: string };

beforeNativeSubmit(e: SubmissionEnvelope): Promise<Authorization>;
recordEffectivePayload(p: { submissionId: string; effectiveText: string;
  expandedFrom: 'transform' | 'template' | 'skill' | 'queue-drain' }): Promise<
    { recorded: true } | { recorded: false; code: string; reason: string }>;
nativeSubmitOutcome(o:
  | { submissionId: string; appliedAs: 'applied' | 'queued' | 'handled' | 'discarded' }
  | { submissionId: string; appliedAs: 'refused'; code: 'STALE_BINDING' | 'DUPLICATE_SUBMISSION'; beforeMutation: true }
): void;   // payload records and application receipts are separate
```

Obligations:

- Called before the first managed semantic mutation on every `source`, including `queueCompactionMessage`.
- The worker persists `originalText` and every attachment blob, fsynced, before authorizing. A blob it cannot store is a refusal, not a dropped image.
- **Duplicate handling is a lookup, not a re-authorization.** Any `submissionId` already at `DISPATCH_STARTED` or beyond returns `DUPLICATE_SUBMISSION` carrying the recorded stage. Returning `{authorized:true}` twice for one id could enqueue one semantic action twice. Only a never-dispatched `RECEIVED` record has a defined **manual** recovery path, never automatic replay.
- **The binding fence is consumed atomically at native mutation.** Worker generation checks before and after persistence are necessary but insufficient: a rebind can occur after the reply. The worker returns a one-use `SubmissionFence`; Pi validates and consumes it in the same owner-local critical section as the first queue mutation or command dispatch, serialized against canonical binding commits. A stale or reused fence performs no mutation and emits an explicit `beforeMutation` refusal. The worker fsyncs that refusal as `REFUSED`; if the refusal receipt cannot be attributed or persisted, the durable dispatch-start remains ambiguous. Release this critical section before awaiting arbitrary extension handlers or child submissions; do not hold it across a model turn.
- `appliedAs: 'queued'` is a **terminal acceptance receipt for this submission**, not proof of model completion. Its normal later drain retains the same id and is not a second operator submission or authorization. Effective-payload records return a recording receipt, never another grant. A later drain failure is reported separately and does not rewrite the accepted queue receipt as a clean refusal, replay it, or imply rollback of extension side effects.
- `PERSISTENCE_UNCERTAIN` is distinct from `PERSISTENCE_FAILED`: failed means nothing landed, uncertain means the worker cannot tell. Both refuse. Uncertain additionally poisons further authorization until recovery.
- **Draft preservation is compatibility-first.** The `EditorComponent` prepare/commit hooks (`submitGate`,
  `draftRevision`, `commitSubmittedDraft`) stay optional, so an existing custom editor remains usable
  without adopting them. Full draft-state preservation on a refusal is required of the default editor and of
  custom editors that implement the hooks correctly. A custom editor that clears its own state before
  calling `onSubmit` gets best effort only: the submitted text may be restored while that editor is still
  empty, and newer typing is never overwritten. Extension-private paste bodies, undo history and
  cursor/scroll state are not reconstructed, and no editor is wrapped, replaced, disabled or required to
  change (invariant 6). This relaxes nothing in authorization — the one-use fence and the queue/command
  mutation checks above are unchanged — and it is not universal preservation, so the reduced capability must
  be stated rather than hidden. Pi states it: a managed session whose installed editor component declares
  neither hook writes one warning through the session's existing notification channel, at its first managed
  submission, naming the two hooks and the text-only recovery. That notice is read from the component's own
  optional public members at the `setEditorComponent` lifecycle point, never from its private state, and it
  adds no wrapper, indicator widget or capability framework.
- No new durability scope is introduced. The existing stage vocabulary is extended, not replaced, and legacy `RPC_*` records keep parsing unchanged.

### Seam B — labelled ingress, and where replies are classified

```ts
dispatchNativeInput(i: { attachmentEpoch: AttachmentEpoch; bytes: Uint8Array;
  binding: { generation: number } }): Promise<{ consumedThrough: number }>;

// Proposed authorization BEFORE any capability-state mutation, not an after-the-fact notification.
beforeApplyTerminalResponse(r: { kind: 'da' | 'kitty-keyboard' | 'cell-size' | 'other';
  requestEpoch: number; attachmentEpoch: AttachmentEpoch | null; raw: Uint8Array }
): Promise<{ apply: boolean }>; // missing, timed-out or failed authorization means do not apply
```

Obligations: provenance is retained per byte span, including a sequence assembled from two origins and a bracketed-paste body; when a child owns stdin, routing transfers to physical PTY bytes in one ordered transition after in-flight input is drained.

**Mixed-origin policy (proposed, G-A8).** A sequence whose bytes came from more than one attachment is attributed to the attachment that supplied its final byte and marked `mixedOrigin`. A `mixedOrigin` sequence can never authorize a return.

### Seam C — return authorization

```ts
authorizeReturn(r: { sequenceId: string; origin: AttachmentEpoch; mixedOrigin: boolean;
  binding: { generation: number } }): 'native' | { detachOrigin: AttachmentEpoch };

interface ReturnDisposition { declaresReturnKey(seq: string): 'owns' | 'free'; }  // optional; absent ⇒ 'owns'
```

Evaluated synchronously inside the native input turn, after focus and overlay resolution. Default for any unknown custom component is `'native'` — deliver the key, do not detach. A stale host eligibility snapshot is never acceptable.

### Seam D — canonical admission on exact names

```ts
type CanonicalOperation = {
  operationId: string;
  operation: 'startup' | 'new' | 'fork' | 'resume' | 'import' | 'rename' | 'delete';
  currentBinding: CanonicalBinding;
  resolvedTarget: { canonicalFile: string };   // the EXACT final path, resolved before admission
};

admitCanonicalOperation(op: CanonicalOperation): Promise<
  | { reservationId: string }
  | { forwardTo: { canonicalFile: string; writer: OwnerRunIdentity } }
  | { refused: true; code: 'TARGET_HAS_LIVE_WRITER' | 'TARGET_UNCERTAIN' | 'STALE_BINDING'
                         | 'DUPLICATE_OPERATION' | 'ADMISSION_UNAVAILABLE'; message: string }>;
commitBinding(c: { reservationId: string; nextGeneration: number }): Promise<void>;
abortReservation(a: { reservationId: string; reason: string }): Promise<void>;
```

**The name is resolved before the reservation, not after the write.** An earlier draft reserved a directory plus a pattern and reported the actual filename at commit; that leaves a window in which the file exists and no reservation names it. Pi therefore resolves the final `new`/`fork`/`import` filename first — including its uniqueness suffix — and admits that exact path. If the resolved name is taken when Pi tries to create it, the operation fails and the reservation is aborted; it does not silently pick another name.

### Seam E — presentation and readiness

```ts
presentTerminal(p: { attachmentEpoch: AttachmentEpoch; geometryRevision: GeometryRevision;
  coldTerminal: boolean }): Promise<{ presentationNonce: string; terminalOwner: 'pi' | 'child' }>;

type Readiness =
  | { phase: 'native-mounted' }                         // TUI started; startup input and output flow NOW
  | { phase: 'initialized' }                            // init() resolved: extensions loaded, startup dialogs settled
  | { phase: 'first-paint'; presentationNonce: string };// one complete frame has been handed to the terminal

onReadiness(cb: (r: Readiness) => void): void;
readinessSnapshot(): { reached: Readiness[] };          // bootstrap for a late registrant
```

### Seam F — terminal profile with Pi-owned parsing

```ts
type VirtualTerminalProfile = {
  profileId: string;            // launch-fixed; an attaching client can never change it
  term: string;
  capabilities: { kittyKeyboard: boolean; kittyGraphics: boolean; mouse: boolean;
                  bracketedPaste: boolean; synchronizedOutput: boolean; trueColor: boolean };
  cellSize: { width: number; height: number } | null;
};
```

The host decides the profile at launch and answers Pi's startup queries from it, because Pi negotiates once and a late client missed that exchange.

### Seam G — managed child terminal, newly required

```ts
onChildTerminalPhase(cb: (p:
  | { phase: 'entering'; reason: 'external-editor' | 'extension-child'; drainedThrough: number }
  | { phase: 'left'; reason: string }) => void): void;
```

Pi announces that it is handing the terminal to a child, after draining in-flight input, and announces when it has it back. See "Child terminal ownership".

## Readiness, presentation and the startup dialog

Three facts are separate and were previously conflated.

1. **`native-mounted`** — the TUI has started. Pi starts it **before** awaiting extension initialization, specifically so a startup dialog can receive input ([interactive-mode.js:639-782](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js#L639)).
2. **`initialized`** — `init()` resolved. Extensions are loaded and any blocking `session_start` dialog has been answered.
3. **`first-paint`** — one complete frame reached the terminal.

**Output and input flow from `native-mounted`.** The attachment endpoint opens there, and the relay shows whatever the owner writes from that moment. Holding visible output until `initialized` or `first-paint` would deadlock: the dialog needs an attached terminal to answer it, and no terminal could see it. `first-paint` marks completed initial presentation and is used for ordering and diagnostics; it never gates whether the operator can see or answer something.

**The registration-order problem, and what it requires.** A management extension registers during `session_start`, which is *after* the TUI mounted, so it can never observe the `native-mounted` event. Two things follow. First, seam E supplies `readinessSnapshot()` so a late registrant learns what has already been reached instead of waiting for an event that will not come again. Second, the worker must not depend on the extension for `native-mounted` at all: the **host** learns it from a supported core bootstrap — either a launch-time core handshake on the sideband before arbitrary extensions run, or the snapshot replayed to the first registrant. Which of those two Pi should provide is part of the seam-E ask. An arbitrary extension's `session_start` handler may await indefinitely, so nothing load-bearing may sit behind it.

## Child terminal ownership

**source, and this invalidates the previously proposed detection.** `editInExternalEditor` calls `spawn(editor, [...args, filePath], { stdio: "inherit", shell: process.platform === "win32" })` ([external-editor.js:12-20](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/external-editor.js#L12)) — no `detached`, no `setpgid`, no job-control setup. The child therefore **inherits Pi's process group**, so `tcgetpgrp(masterFd)` does not change and cannot detect this transition. Comparing foreground process groups is corroboration only, useful for a child that does establish its own group, and it is not a detection mechanism for Pi's own external editor.

What is required instead is **seam G**: Pi announces `entering` before handing over, after draining in-flight input, and `left` when it resumes. Without it the host cannot know when not to paint, and cannot know when labelled ingress must stop bypassing the child.

**Arbitrary extension children are a separate, explicitly unproved parity gate.** An extension can spawn anything with any stdio and never tell Pi. Seam G does not cover it. Foreground-group observation may corroborate some of those cases and will miss others.

**Direct `process.stdout` writes are PTY output.** Anything Pi or a child writes to the inherited terminal passes through the same master the host reads. So the earlier claim that no mechanism can ever reconstruct direct-stdout or non-redrawing-child state is **false and withdrawn**. The correct statement: **Pi repaint cannot reconstruct it**, and whether a host-maintained or tmux-maintained screen model can is **unproved**. Both candidate mechanisms observe exactly that byte stream.

## Query replies

**Replies are not self-contained chunks.** They can be split across reads, coalesced with ordinary keys, and byte sequences that look like replies can occur inside a bracketed paste body. Query epochs give correlation, not framing. This is the same fragmentation that motivated seam B.

Two candidates, and the choice is an explicit open API/scope decision, not a solved problem:

- **Preferred — classify and authorize before applying at the native parser (seam B `beforeApplyTerminalResponse`).** Pi parses fragmented input and paste context, then awaits the host's epoch decision before mutating any keyboard, color, cell-size or other capability state. The ordered parser path revalidates the request epoch at application; a rejected, expired or failed decision consumes only the classified response and changes no capability state. A post-application notification cannot enforce this rule. The authorization path must be registered by the core bootstrap before startup queries, independently of arbitrary extension initialization.
- **Alternative — a host-side incremental response parser.** This is only correct if it maintains bracketed-paste state and retains unmatched bytes across reads, which means the host holds a partial terminal-input state machine. That is a real scope increase and needs an explicit decision, not a regular expression over "byte runs".

**Forbidden either way:** a dashboard key parser, paste-completeness judgement for routing keys, synthesized native shortcuts, and any assumption that an untagged byte run is a reply. Getting this wrong drops operator input or forwards a late capability reply into Pi's global negotiation path, which `TuiBase` consumes before any listener.

## Backpressure

- The queue length is evaluated **after** the write, or as a projection that includes it, so the first oversized broadcast marks the attachment `resync-required`. Checking only before the write leaves a sink that jumped from zero to over the cap still marked `live`.
- The set keeps **no copy of any byte it handed to a sink**. Recovery is a repaint, not a replay.
- A lagging attachment keeps its membership and its input eligibility. No automatic kick; no silent byte dropping behind a screen that claims to be current; a transport failure is reported as a failure, never as a role change.
- `resync-required` clears only on a **presentation acknowledgement**: the client echoes the `presentationNonce` from seam E's `presentTerminal`, proving an ordered frame actually arrived. Calling a local `markPresented` proves nothing.
- Key bytes are volatile. Nothing is replayed on a lost connection, and a reconnect is a new epoch.

## Canonical reservations and the lock domain

- Reservations are stamped with `OwnerRunIdentity`, which includes `hostId` and `bootId` as well as pid and start identity, plus the writer runtime's own identity — not `runId` alone. A claim from a previous boot cannot be confused with a live one.
- The lock domain is **the Pi session directory, not a state root**. Two state roots can share one session directory, so the lock and journal live beside the sessions being protected and a per-root lock would not exclude anything.
- `reconcile()` returns `live` / `released` / `uncertain`. Released requires provable owner absence. **Uncertain never expires on a timer.**
- Uncertainty must not become a permanent unrecoverable lock. Recovery is an **explicit operator action requiring proof of owner absence on the recorded host**: authoritative evidence of that host's changed boot, or an absent/mismatched process start identity on that same boot, plus no live claimant. Comparing this machine's boot ID or PID table with a different host proves nothing; an unreachable recorded host stays uncertain. The recovery action is journalled. Never a timeout and never automatic.
- Network-filesystem lock semantics remain an explicit feasibility gate (G-A5).
- Trusted extensions can import `SessionManager` or write files directly. No contract here constrains that and none should claim to.

## Protocol: accepted versus emitted

One global constant cannot express a mixed population, and the current checks are exact. So the release train is two explicit stages with dual readers.

**Proposed pending freeze**, current values are `CLIENT_PROTOCOL = 6` ([contracts.mjs:46](../../../shared/contracts.mjs#L46)) and `WORKER_SOCKET_PROTOCOL = 2` ([worker-socket.mjs:14](../../../runtime/worker-socket.mjs#L14)):

| Release | Client protocols accepted | Client protocol emitted | Worker protocols accepted | Worker protocol emitted |
| --- | --- | --- | --- | --- |
| **Bridge** | 6 | 6 | 2, and 3 for adoption only | 2 |
| **Native** | 6 (management only), 7 | 7 | 2 (management only), 3 | 3 |

The bridge must **accept** worker 3 to adopt a native worker without replacing it, while still **emitting** 2 for the workers it launches. That requires an explicit accepted-set reader on each listener rather than an equality check against one constant. Version 7 and worker 3 are announced only once the schemas they name are implemented.

Population outcomes:

| Frontend | Daemon | Worker | Outcome |
| --- | --- | --- | --- |
| 6 | bridge | 2 (RPC) | full, as today |
| 6 | bridge | 3 (native) | management only; `NATIVE_ATTACHMENT_UNAVAILABLE`; worker keeps running |
| 7 | native | 2 (RPC) | management only; native attachment refused; worker never replaced |
| 7 | native | 3 (native) | full native attachment |
| 7 | pre-bridge | any | refused as an earlier release, as `UNSUPPORTED_CLIENT_PROTOCOL` does today |

Task 17 implements both profiles and ships the bridge profile. Task 19 is the ordered final writer of the release-profile selection and protocol emitters, activating the native profile only after qualification; Task 18 tests its frontend against that candidate profile in disposable roots without publishing it. A bridge-only rollback offers management, not native attachment, unless a separately verified compatible native route remains available.

**Rollback never reinstates automatic replacement, never reopens an RPC-composed viewer against a native owner, and never autoloads the old renderer for one.** The bridge is the floor because it is the first release without `scheduleUpgradeRespawn`. Rolling back past it is unsupported while any native owner is live. A running owner is never converted back to RPC and its canonical file is never rewritten.

## Approval gates

Each is a recommendation awaiting the user, placed immediately before the work that consumes it.

| Gate | Recommendation | Blocks |
| --- | --- | --- |
| **G-A1** row identity | canonical-file rows plus `OwnerRunIdentity`; a move marks the source row `superseded` and binds the target row; no row's canonical path is ever mutated | canonical implementation, worker integration |
| **G-A2** live-target resume | refuse visibly in Pi's UI and offer explicit attachment to the existing owner; never redirect, kill, implicitly fork or disable `/resume` | canonical implementation |
| **G-A3** cross-owner rename | forward to the target's current writer with a generation check; alternative is refusal with retry | canonical implementation |
| **G-A4** selector delete and `/import` | both route through admission; delete of a live-writer file is refused; dashboard `rm` stays forget-only | canonical implementation |
| **G-A5** admission without a daemon | worker-held reservations over a session-directory lock, daemon still sole registry writer; filesystem scope is itself a feasibility gate | canonical implementation |
| **G-A6** backpressure | bounded queue, `resync-required`, presentation-nonce recovery, no kick | attachment set; **also an M0 prerequisite where a probe measures it** |
| **G-A7** unsupported terminals and owners | refuse by named missing capability; an owner without seams stays running and is marked attachment-unavailable; never a substitute UI, never a second Pi | terminal profile |
| **G-A8** mixed-origin return | attribute to the final byte; `mixedOrigin` can never return | seam B/C delivery |
| **G-A9** child-terminal scope | see gate 5 below. A narrowing is a **new product spec with its own DoD**, not a way to complete this one | child-terminal work |
| **R1** failed-submission recovery | a native recoverable failed-submission item plus `draftRevision` compare-and-restore, restoring only if the draft is unchanged | failpoint work |

## Gate 5 is a must-pass

The carried-forward gate is unambiguous: "A declared restriction is **not** a pass — narrowing external editor behavior is a product change the user has not approved, so a limitation here is a failed gate and an escalation" ([2026-09-16 spec:188](2026-09-16-native-background-ui-design.md#L188)).

So, for **this** product:

- **Gate 5 must pass.** A pass means a late attachment receives the child's current terminal state and then shares its input like any other attachment.
- **An honest refusal is a failed-open research finding**, not a completion. It is what the implementation does while the gate is open, and it does not satisfy the definition of done.
- **A user narrowing does not complete this feature.** If the user chooses to narrow child-terminal behavior, that is a **different product** and needs its own spec and its own definition of done. This document's DoD is not amended by it.
- Candidate mechanisms: a host-maintained screen model, or tmux as the terminal-state engine. Both are unproved.

## Alternatives

| Option | Verdict | Basis |
| --- | --- | --- |
| Permanent PTY + unmodified Pi 0.84.3 + extension only | cannot meet the contract | seams A–D are unreachable from any supported surface; useful only as the M0 probe substrate |
| Permanent PTY + extension + seam-enabled Pi release | the proposed target | host keeps transport, lifetime and capability policy; Pi keeps parser, focus, semantic submission and canonical operations. Upstream acceptance and implementation size are both unknown |
| Own SDK launcher driving native `InteractiveMode` | fallback research | could await `init` and hold subscriptions, but duplicates CLI startup, config and resource policy and still cannot intercept submit, rename or private UI boundaries |
| tmux as terminal-state engine behind this same bridge | **open candidate, not rejected** | see below |
| Continue the RPC-composed viewer | no | `dist/modes/rpc/rpc-mode.js` makes widget factories, custom editors, raw input, autocomplete, theme and tool-expansion explicit no-ops; it structurally cannot carry native UI |
| Project-maintained Pi patch series | selected by the user after M0 | keep the upstream source pin, integrity checks, focused patches, build tooling and regression tests in this repository under `vendor/pi/`; `pi-agents` owns maintenance. Upstreaming is optional, not a prerequisite. Do not check in an unchanged upstream tree or patch installed dependencies. Compatibility testing and rebases remain our responsibility; no cost or patch-size estimate is claimed |

### tmux, evaluated as a component

The earlier wholesale rejection is withdrawn. What [docs/tmux-prototype-report.md](../../tmux-prototype-report.md) measured is directly relevant to the one gate with no other answer: "A new client attaches at the current bottom of the pane. It sees the current screen immediately, **including editor contents and extension UI**" ([:57-63](../../tmux-prototype-report.md#L57)), and shared geometry behaved as this design requires ([:50-56](../../tmux-prototype-report.md#L50)). Every objection in that report's "become harder" list ([:131-156](../../tmux-prototype-report.md#L131)) — no delivery proof from terminal bytes, no durable stages, stop by keystroke synthesis, row state undecidable from JSONL, Left breaking the editor, one-writer-plus-observers — is an objection to having *only* tmux. This design supplies a worker-owned ledger, a structured sideband stop, structured Pi status, seam C, and unrestricted multi-writer attachment.

**The failure boundary depends on the topology, and the two must not be conflated.** A **shared** tmux server means one server failure stops every hosted session ([:156](../../tmux-prototype-report.md#L156)). A **per-worker** server — one tmux server per owner, under that worker's lifetime and permissions — has the same blast radius as the custom host and must be evaluated on its own terms. The earlier text cited the shared-server hazard against a per-session proposal; that was incoherent and is corrected.

Open either way: whether per-attachment input provenance survives tmux's client-to-pane path to reach seam B, and how tmux's own terminal emulation translates capabilities between a client and the pane.

## Feasibility answer

**Conditional. Exact native parity is not established.**

The user has approved a pinned Pi patch series maintained by the `pi-agents` project inside this repository, without waiting for upstream. That settles the delivery route, not technical feasibility. Native parsing remains Pi-owned for seam F, with response authorization before side effects; mixed-origin input cannot authorize a return, while an unambiguous key retains final-byte attribution (G-A8). Required for the target to be reachable: the maintained build actually delivers seams A–G; the user answers G-A1…G-A9 and R1 at their lanes; a maintained Node 22 PTY mechanism is selected and validated; **and gate 5 passes by a demonstrated terminal-state mechanism**. If gate 5 cannot pass, the honest outcome is that the approved product is not deliverable as specified and the user decides whether to accept a different, narrower product.

**Hardest unresolved items, in order:** full child-terminal parity (screen-model and per-worker tmux candidates have only partial evidence); seam A's compaction pre-queue coverage; seam B's provenance through fragmentation and paste; seam F's response authorization before side effects; and seam D's admission before every canonical mutation. M0 exercised delete and import and recorded stock-Pi hazards; these are no longer untested paths, but corrected behavior remains unimplemented.

**Milestones.** M0's cache-only characterization and independent reviews are complete. The user selected a project-maintained Pi build. Task 8's runner and Task 7's packaging foundation have completed review; their artifacts add no native interfaces. M1 continues with focused source patches and behavioral tests. Root dependency activation and later runtime work remain subject to their gates.

**Size and effort are not estimated here.** Seam implementation size and maintenance cost remain unknown. Upstream review and release are not prerequisites for the selected route. Prior numeric ranges remain withdrawn as unsupported.

## Nine prior gates

| Gate | Probed by | Closed by | Status |
| --- | --- | --- | --- |
| 1 Non-destructive attach/detach | M0-A | host + seam E | open |
| 2 Capability negotiation and query replies | M0-A | seam F boundary decision + seam B classification | open, boundary unsettled |
| 3 Multi-client repaint and shared geometry | M0-A | host + seam E | geometry **executed**; repaint open |
| 4 Concurrent input into one draft | M0-B | seam B + G-A8 | behavior **executed**; policy open |
| 5 External editor and process-global streams | M0-E | seam G + a terminal-state mechanism | **must-pass, open** |
| 6 Native stop/start and process lifecycle | M0-A | host reap + extension stop request | survival **executed**; structured stop open |
| 7 Durable semantic submit barrier | M0-C | seam A + worker ledger | open; no real fsync failure has ever been exercised |
| 8 Return at the ordered input boundary | M0-B | seam C | native half **executed**; authorization open |
| 9 Canonical identity and admission | M0-D | seam D + reservations | cross-owner rename hazard **executed**; admission open |

## Definition of done

1. All nine gates pass. **Gate 5 included**; an escalated failure does not satisfy this DoD.
2. Two authenticated terminals type into one draft, resize each other, detach and reattach with a correct first frame validated by an established terminal emulator, with the operator's configured `Ctrl+O` firing exactly once through Pi.
3. The full failpoint matrix passes with deterministic injected persistence failures, plus a separate real-storage gate reported honestly as passed or not-run.
4. Cross-owner rename, resume, fork, import and delete each produce a defined honest outcome with `/resume` still enabled.
5. An old RPC worker is adopted and managed without replacement; the bridge rollback rehearsal succeeds.
6. Unit, typecheck, package and integration checks pass **on SLURM workers**, exercising the installed tarball rather than the checkout. No expected-red probe is collected by the default suite.
7. Documentation describes shipped behavior. The old viewer is deleted only after its last consumer is retired, and the shipped-behavior `README.md` update is a named final task performed after implementation approval — never during this planning phase, where `README.md` stays byte-identical.

## Sources

- [AGENTS.md](../../../AGENTS.md) · [README.md](../../../README.md) · [docs/architecture.md](../../architecture.md) · [docs/command-acceptance.md](../../command-acceptance.md) · [docs/tmux-prototype-report.md](../../tmux-prototype-report.md) · [docs/pi-server-investigation.md](../../pi-server-investigation.md)
- [docs/superpowers/specs/2026-09-16-native-background-ui-design.md](2026-09-16-native-background-ui-design.md) (superseded as a proposal; file unchanged)
- [Corrected feasibility report](/mnt/main0/home/gjohnson/.cache/pi-agents-native-attach-feasibility/REPORT.md), including "Isolation and cleanup" and "Final review limits"
- This repository: [runtime/worker.mjs:190](../../../runtime/worker.mjs#L190) · [runtime/worker-replay-contract.mjs:1](../../../runtime/worker-replay-contract.mjs#L1) · [runtime/append-store.mjs:52](../../../runtime/append-store.mjs#L52) · [runtime/registry-store.mjs:427](../../../runtime/registry-store.mjs#L427) · [runtime/lifecycle-lock.mjs](../../../runtime/lifecycle-lock.mjs) · [runtime/daemon.mjs:739](../../../runtime/daemon.mjs#L739) · [runtime/worker-socket.mjs:14](../../../runtime/worker-socket.mjs#L14) · [runtime/worker-supervisor.mjs:479](../../../runtime/worker-supervisor.mjs#L479) · [shared/contracts.mjs:46](../../../shared/contracts.mjs#L46) · [app/list/standalone-list.mjs:184](../../../app/list/standalone-list.mjs#L184) · [vitest.config.ts:5](../../../vitest.config.ts#L5)
- Installed Pi 0.84.3: [runner.js:930](../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js#L930) · [agent-session.js:989](../../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js#L989) · [agent-session-runtime.js:128](../../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js#L128) · [interactive-mode.js:639](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js#L639) · [interactive-mode.js:3604](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js#L3604) · [interactive-mode.js:4457](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js#L4457) · [session-selector.js:539](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js#L539) · [external-editor.js:12](../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/external-editor.js#L12) · [terminal.js:130](../../../node_modules/@earendil-works/pi-tui/dist/terminal.js#L130) · [tui.js:553](../../../node_modules/@earendil-works/pi-tui/dist/tui.js#L553) · [tui-alt-screen.js:232](../../../node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js#L232) · [editor-component.d.ts:10](../../../node_modules/@earendil-works/pi-tui/dist/editor-component.d.ts#L10)
