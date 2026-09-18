# vendor/pi seam G interface: ordered input drain and recognized child-terminal handoff

This is the public contract of the one source patch this node owns,
`vendor/pi/patches/0005-native-child-handoff.patch`. In this branch's series it is applied fourth, directly
after `0003-native-presentation-readiness.patch`, and the file in `patches/series` is the diff taken at exactly
that position: sha256 `d787fda99d28a7c865116bc599cdfd8fe0840ef2fe2775c062e868f29fc36a16`, prepared tree
`b9a3f2bf656c68ee5ad686a1fa272827c5513528` (build job `3745133`, upstream commit
`bfb004d4418ff05c6f909eaaab856cbe75c1fde0`). It depends on seams B/C/F (0002) and E (0003) and does not
commute with them. The number leaves `0004` free for the independent canonical-admission sibling: this branch
does not carry that patch and nothing here depends on it.

`vendor/pi/INTERFACE.md`, `vendor/pi/README.md` and `vendor/pi/NOTICE.md` are owned by another node and still
describe a three-patch series. Recording the composed order, the digests and the prepared-tree hash for a
four-patch series is the integrator's, exactly as it was for seam E.

`test/native-child-handoff.test.mjs` is the acceptance suite that drives this patch through an installed
artifact cohort, named by `PI_NATIVE_ARTIFACTS_MANIFEST`. With no cohort selected it skips.

## What this delivers

Pi already recognizes one handoff: its external editor takes the terminal for the length of an edit, and
seam E marks that as a release so a cold presentation refuses instead of painting over the child. What a host
that feeds Pi labelled bytes could not get was a boundary — the point after which none of its clients' bytes
enter Pi's parser — and a paired announcement around it. This patch adds exactly that.

It does **not** add arbitrary-child parity. Nothing here discovers, classifies or reconstructs a child Pi was
not told about, and no gate 5 claim follows from it.

## What a host imports

From `@earendil-works/pi-tui`:

```ts
SUPPORTED_CHILD_TERMINAL_HANDOFF_VERSION; // 1
type ChildTerminalHandoffOptIn = { version: number };
type ChildTerminalPhase =
  | { phase: "entering"; childPhaseId: string; reason: "external-editor"; drainedThrough: number }
  | { phase: "left"; childPhaseId: string; reason: "external-editor"; outcome: "returned" | "failed" };
onChildTerminalPhase(listener: (phase: ChildTerminalPhase) => void): () => void;
isChildTerminalHandoffActive(): boolean;

// on the terminal a host owns
ProcessTerminal.dispatchNativeInput(input: NativeInputDispatch): Promise<NativeInputDispatchResult>;
ProcessTerminal.drainNativeInput(): Promise<NativeInputDrainLease>;
type NativeInputDispatchResult =
  | { admitted: true; consumedThrough: number }
  | { admitted: false; consumedThrough: number; reason: "stale-binding" | "superseded-attachment" | "handoff-closed" };
type NativeInputDrainLease = { readonly drainedThrough: number; reopen(): void };
class NativeInputDrainError extends Error { code: "NATIVE_INPUT_DRAIN_ACTIVE" | "NATIVE_INPUT_NOT_STARTED" }
```

`notifyChildTerminalPhase` and `nextChildTerminalPhaseId` are exported because Pi's own recognized handoff
site lives in the other package of the cohort. A host subscribes; it does not announce.

## The opt-in, and the additive/version rule

**An existing seam B/C/F registration is not a seam G opt-in.** A host built before this patch has no drain,
no reopen and no phase listener, so closing labelled admission for a handoff would strand its clients with
bytes Pi will not accept and no event telling them why. The opt-in is therefore one explicit, versioned,
optional field on the registration the host already makes:

```ts
registerNativeAttachmentHost({ profile, authorizeReturn, beforeApplyTerminalResponse,
  childTerminalHandoff: { version: 1 } });
```

| Registration | Result |
| --- | --- |
| no `childTerminalHandoff` | not opted in: Pi keeps its pinned external-editor path, never closes admission for a handoff, emits no phase |
| `{ version: 1 }` | opted in, for this build |
| `{ version: <anything else> }` | **refused at registration**, naming both versions; nothing is mutated and the previous host stays registered |
| no host at all | unchanged pinned behavior, exactly as today |

`release()` on the registration removes the opt-in with the host.

The registry container's `NATIVE_ATTACHMENT_STATE_VERSION` stays `1`. Seam G's phase listeners and phase
counter are **optional fields created on first use**, so a container created by a copy of this module that
predates seam G is reused rather than refused. That is the additive rule: a field an older copy never reads
costs no version bump, and only a change that would make an older copy read the container *wrongly* bumps it.

## Admission, the barrier and the counters

`drainNativeInput()` changes admission from open to draining **synchronously, before its first await**, and
snapshots the accepted-byte counter there. A dispatch whose synchronous admission completed first is wholly
before the barrier; one whose admission starts afterwards is wholly rejected with `handoff-closed`. No byte
span is split across the barrier.

- `consumedThrough` counts labelled bytes **admitted** into the ordered native path, monotonically, across
  attachments. Ordinary local stdin, rejected dispatches and every forced flush count nothing. Each admitted
  dispatch reports the boundary fixed at its own admission.
- `drainedThrough` is exactly the snapshot at the barrier. It means every byte accepted through it has been
  through all three forced holds and every terminal-response authorization those bytes started has settled.
- A rejected dispatch's bytes are neither copied into Pi's queues nor counted. They remain the sender's. A
  host that retains them and, after it has changed its own route, writes them once to the physical child in
  arrival order is performing first delivery, not replay. They must not be sent through both routes.

## The drain

The drain takes one turn on the existing dispatch serialization chain, so it waits for the dispatches admitted
before the barrier and for nothing else. Then, in this order:

1. the incomplete UTF-8 byte tail is decoded through the existing decoder, keeping provenance and Node's own
   U+FFFD outcome;
2. `StdinBuffer`'s incomplete-sequence hold is force-run through the path its 50 ms timer would have used;
3. the 150 ms keyboard-response fragment hold is force-run, classifying a complete response normally and
   forwarding an incomplete prefix as ordinary native input;
4. the pending terminal-response authorization set is awaited until empty, including work those flushes
   started.

The order is load-bearing: step 1 can populate the buffer step 2 releases, and step 2's released sequence can
classify as the split response prefix step 3 releases. Nothing is fabricated, discarded, host-parsed or
reclassified outside Pi. An unterminated bracketed paste is not one of these holds and stays buffered.

**Self-dispatch is safe and required to stay safe.** A key handler may start the child entry that calls
`drainNativeInput()`. TUI input delivery is synchronous and void: the handler reaches its first `await`,
unwinds, the dispatch settles its own authorization work and releases its turn, and only then does the drain
run. The drain never waits on the promise returned by the child-entry operation.

## The lease

One drain at a time. A second call rejects with `NATIVE_INPUT_DRAIN_ACTIVE` before changing any state; a
terminal that was never started rejects with `NATIVE_INPUT_NOT_STARTED`; any failure before the lease exists
reopens admission internally. After success only that lease can reopen the gate, `reopen()` is synchronous and
idempotent, and a stale or duplicated call is a no-op — including a stale lease's call after a later drain
closed the gate again.

The gate is routing state only. It never becomes a second terminal owner: seam E's existing `terminalRelease`
remains the one recognized ownership state, and `presentTerminal` still refuses through it.

## The recognized external-editor bracket

`bracketRecognizedChildTerminal` in `@earendil-works/pi-coding-agent` is the one site. `InteractiveMode` is a
thin adapter over it, supplying its own terminal, seam E release, renderer stop/restore and the editor call.

Opted-in order: drain to a boundary, set seam E's recognized release, mint one process-unique monotonic
`childPhaseId`, announce `entering`, stop the renderer, run the editor. Then, in an outermost finalizer chain:
attempt restoration, clear the release **only after** that attempt, announce exactly one matching `left`, and
reopen admission last. A listener, spawn, editor, stop, start or render failure therefore cannot strand
admission closed, and there is at most one `entering` and one `left` per phase id. A duplicate entry while the
recognized release is active is refused before another drain, event or spawn, and does not disturb the first
lifecycle. The child's own failure still propagates to the caller, exactly as it did before.

`outcome: "returned"` means the editor completed **and** Pi's restoration attempt did not throw. A failed
restoration reports `failed`: Pi does not advertise a return it could not restore itself from, and seam E's
readiness and refusal semantics are unchanged.

Not opted in, or a terminal with no `drainNativeInput`: the bracket runs Pi's pinned order — release, stop,
child, reclaim, restore — with no drain, no lease and no announcement.

## Limits this patch states rather than hides

- **`entering` is local.** It says Pi's own gate is closed and drained and that the recognized release is
  active. An out-of-process host changes its route asynchronously, after its own control notification; this
  patch makes no transport-delivery or route-acknowledgement guarantee, and a listener returning is not an
  acknowledgement. Listener return values and promises are ignored.
- **A listener that throws** is reported as a Node process warning — this package has no logger of its own —
  and the remaining listeners, the paired event, the native editor path and the reopen all still run.
- **Transition buffering on `left`** belongs to the later host transport work. It is not asserted by this
  synchronous callback API, and nothing here silently drops or replays bytes to simulate it.
- **Gate 5 remains mandatory and unproved.** Arbitrary and unannounced children, same-process-group children,
  late attachment to a child's current screen, shared input, both renderers and actual Kitty graphics in a
  compatible Kitty environment all need separate product evidence. Foreground process group is corroboration
  only, and the deterministic cases here prove a prerequisite, not that gate.
