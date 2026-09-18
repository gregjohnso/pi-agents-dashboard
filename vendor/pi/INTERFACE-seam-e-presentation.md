# vendor/pi seam E interface: native cold presentation and readiness

This is the public contract of the one source patch this node owns,
`vendor/pi/patches/0003-native-presentation-readiness.patch`. In the composed series that patch is applied
third, after seam A and seam B/C/F, and the file in `patches/series` is the **serialized** diff taken at that
position: sha256 `cf7f5ccca6358612f17bb65583f17934fb795b9935c921efe0fbaba1737bdfb9`, prepared tree
`9c40d805754c6cbc5dd161ec4e1c6880b1bc1ef4`. This lane's own diff against the bare pin was sha256
`8a483bf73c9b6d6d44cea44eae2289386946e545f1b6fa2b8bd6a5fd88542868` with patched tree
`88e61de9062ba65ddde592d96b7afa24473b0b67`, and applying it alone to the pin still reproduces that tree.
Serialization kept every symbol in this contract: the only hunks git could not merge were import blocks in
`packages/tui/src/{terminal,tui}.ts`, and both lanes' imports are retained.
`test/native-presentation.test.mjs` is the acceptance suite that drives it through an installed artifact.

It is a section of `vendor/pi/INTERFACE.md` — the vendor pin, build and patch-rule contract — which another
node owns; the section numbers below are that document's, kept so review citations still resolve. That
file's section 9 records the composed order, the patch digests and the prepared-tree hashes. Read it for the
pin, what you run, what you get, the package cohort and the rules a patch must satisfy. Nothing here
restates them, and nothing here claims any seam other than E: seams A, B, C, D, F and G are other patches,
and this one does not claim to commute with them.

## 8. Seam E: cold presentation and readiness

All of it is opt-in. Until a host calls `presentTerminal` or subscribes to readiness, every changed path
behaves exactly as unmodified 0.84.3 does.

### 8.1 What a host imports

From `@earendil-works/pi-coding-agent`:

```ts
presentTerminal(request: {
  attachmentEpoch: { attachmentId: string; epoch: number };
  geometryRevision: number;
  coldTerminal: boolean;
}): Promise<PresentTerminalResult>;

onNativeReadiness(listener: (readiness: ReadinessRecord) => void): () => void;
nativeReadinessSnapshot(): { reached: ReadinessRecord[] };
nativePresentationCapability(): typeof NATIVE_PRESENTATION_CAPABILITY;
```

The same three are on `ExtensionAPI`, so an extension loaded by the bundled CLI reaches them as
`pi.presentTerminal`, `pi.onNativeReadiness` and `pi.nativeReadinessSnapshot`. That route is for an extension
that is already running; it is **not** the launch-time route, which is the core bootstrap sideband below.

The core bootstrap, also from `@earendil-works/pi-coding-agent`:

```ts
startNativeBootstrapChannel(): NativeBootstrapStatus;   // called by main() before any extension is loaded
nativeBootstrapStatus(): NativeBootstrapStatus;
stopNativeBootstrapChannel(): void;
NATIVE_BOOTSTRAP_SOCKET_ENV; // "PI_NATIVE_BOOTSTRAP_SOCKET"
NATIVE_BOOTSTRAP_PROTOCOL;   // 1
NATIVE_BOOTSTRAP_STATE_VERSION;    // 1
NATIVE_PRESENTATION_STATE_VERSION; // 1
```

**Module instance boundary.** The bundled CLI inlines its dependencies, so a supported in-process caller that
imports the installed public module while the agent runs from the bundle holds a *different copy* of these
modules. Seam E's readiness ledger, its presentation provider and its bootstrap channel therefore live on the
process, under two registered symbols this lane owns:
`Symbol.for("@earendil-works/pi-coding-agent/native-presentation-state")` and
`Symbol.for("@earendil-works/pi-coding-agent/native-bootstrap-state")`. Each record carries its own `version`;
an existing record is **reused, never reset**, so a later import cannot discard phases already reached or close
a channel already open; and a record whose version this build cannot speak to is **refused with both versions
named**, never shadowed by a second ledger. The renderer brand `NATIVE_PRESENTATION_TUI` is already a
`Symbol.for`, so renderer capability crosses the same boundary. These are seam E's own keys and say nothing
about any other lane's process state.

From `@earendil-works/pi-tui`: `isNativePresentationTui`, `NATIVE_PRESENTATION_TUI` and the
`PresentationFrameReceipt` / `ColdReassertion` / `ReassertedTerminalModes` types, for a host that drives a
renderer directly.

**Name mapping against the design document.** `presentTerminal` keeps its name and argument shape.
`onReadiness` and `readinessSnapshot` are spelled `onNativeReadiness` and `nativeReadinessSnapshot`, because
those two names are far too generic for this package's shared export namespace; the semantics are
unchanged, and `onNativeReadiness` additionally returns an unsubscribe. `Readiness` keeps the document's
three-variant union; `ReadinessRecord` is that union plus `sequence` and `atMs`.

### 8.1a The core bootstrap sideband

The host creates a unix-domain listener, puts its path in `PI_NATIVE_BOOTSTRAP_SOCKET`, and launches Pi. Pi
connects out from `main()` — before extension modules are loaded, before the TUI mounts and before any
`session_start` handler exists — and speaks newline-delimited JSON:

| Direction | Frame | When |
| --- | --- | --- |
| Pi → host | `{type:"native-bootstrap", protocol:1, pid, capability, reached:[…]}` | **first**, on connect; `reached` is the snapshot at that moment |
| Pi → host | `{type:"native-readiness", protocol:1, readiness}` | one per phase the hello did not already carry, as it is recorded |
| host → Pi | `{type:"present", protocol:1, requestId, attachmentEpoch, geometryRevision, coldTerminal}` | any time |
| Pi → host | `{type:"presentation-result", protocol:1, requestId, result}` | the `presentTerminal` result for that request |
| Pi → host | `{type:"error", protocol:1, requestId, error}` | one refused inbound frame, or a presentation that threw |

The socket is unreferenced, so it never holds Pi open, and every failure is reported through
`nativeBootstrapStatus()` rather than thrown: an unconfigured, absent or closed listener leaves Pi running
exactly as unmanaged Pi runs. The channel carries readiness and presentation only. It is not a session
manager, not an input transport and not a general RPC surface.

**The hello is the first write, and no record arrives twice.** A socket accepts writes while it is still
connecting, so a phase recorded between `startNativeBootstrapChannel()` and the connection would otherwise
reach the host ahead of the hello that opens the stream. Such a record waits for the hello instead: the
hello's `reached` snapshot is taken at connect time and written first, and only records the snapshot did not
carry follow, each one once, keyed by its `sequence`. The readiness subscription is installed *before* the
connection is attempted, so there is no window in which a phase is recorded and nobody is listening.

**The inbound side is bounded and fail-closed.** A command is one newline-terminated JSON object of at most
`NATIVE_BOOTSTRAP_MAX_COMMAND_BYTES` (8192) bytes. The bound is measured on the **raw** frame the peer sent —
its newline and any whitespace included — before anything is trimmed, normalized or parsed, so padding a large
command out with whitespace buys no bytes the bound already refused. It must be an object — not `null`, not an array — carrying
`protocol === 1`, `type === "present"`, a `requestId` of 1 to 200 characters, an `attachmentEpoch` object whose
`attachmentId` is 1 to 200 characters and whose `epoch` is a whole number, a whole `geometryRevision`, and a
boolean `coldTerminal`. Only those validated values are forwarded; nothing is cast, so a host cannot reach
`presentTerminal` with a value it did not declare.

| Inbound | Answer |
| --- | --- |
| unparseable JSON, a non-object, a wrong `protocol`, an unknown `type`, a missing or mistyped field | one `error` frame naming the reason, echoing `requestId` when the host supplied a usable one; the channel stays open and Pi presents nothing |
| a presentation provider or renderer that throws, or a rejected `presentTerminal` | one `error` frame naming the failure; the channel stays open |
| a frame larger than the bound, or input that passes the bound with no newline | one `error` frame naming the bound, then Pi closes the channel and stops reading rather than retaining the input; `nativeBootstrapStatus().lastError` names it |

A fatal breach closes admission **before** the refusal is flushed: reads are paused, the `data` listener is
removed, and the socket stops being the channel's, so a frame already buffered behind the breach and a frame
arriving on a later data event are both left unread. Nothing behind a refused frame reaches `presentTerminal`.

An inbound protocol mismatch is refused by version, not partially understood by field, so a host built
against a later channel is told which version this build speaks.

### 8.2 What the presentation nonce means

The nonce is the `frameId` of one complete frame that was **handed to the terminal**: the renderer built the
whole frame buffer and passed it to `Terminal.write`, which for `ProcessTerminal` is one
`process.stdout.write`. It is not a client display acknowledgement. `process.stdout.write` returning `false`
means the sink is above its high-water mark and has still accepted the bytes; nothing in this patch reads
that boolean, and nothing re-sends a frame because of it. Proving that a client *displayed* the frame is the
host's work: the client echoes the nonce back over the host's transport. `Terminal.write` still returns
`void`, unchanged, so no third-party `Terminal` implementation breaks.

The receipt also carries the `columns` and `rows` the frame was built at, and the `requestId` derived from
the attachment epoch and geometry revision. A host compares those with its own current geometry rather than
trusting that a nonce is still current.

### 8.3 What a cold presentation does, and does not do

Does: re-emit the renderer-owned set-modes a late terminal missed (alt-screen entry, autowrap off, mouse
tracking, cursor hidden), ask the `Terminal` to re-emit its own idempotent set-modes (bracketed paste,
`modifyOtherKeys`, title, progress), drop the Kitty transmission cache so the forced frame retransmits every
visible image in full, then render one complete frame from the live component tree.

The negotiated Kitty keyboard flags are part of "does": they are reasserted with the set-flags form,
`CSI = flags ; 1 u`, which rewrites the flags of the entry already on the terminal's keyboard stack. The push
form `CSI > flags u` is never re-emitted, because Pi pops that stack exactly once at shutdown and a second
push would leave every terminal that received the first one unbalanced. A terminal that received the startup
push therefore ends in the same state, and a terminal that missed it now has the negotiated flags.
`coldReassertion.kittyKeyboardFlagsReemitted` reports the flags Pi set, and the host owes nothing here.

Does **not**: reset the draft, focus, overlays, selection, transcript search, scroll position or any
component state; issue a capability query; replay a captured byte tail; or push the Kitty keyboard stack a
second time.

### 8.4 Readiness timing

| Phase | Recorded at | What is true |
| --- | --- | --- |
| `native-mounted` | `InteractiveMode.init`, immediately after `this.ui.start()` and **before** extensions load | the TUI is started and focused; a key reaches the editor and a frame reaches the terminal, so a blocking `session_start` dialog can be seen and answered |
| `first-paint` | the first complete frame handed to the terminal | initial presentation completed; carries that frame's nonce |
| `initialized` | the end of `init()` | extensions are loaded and any blocking startup dialog has been answered |

The three are separate records with their own `sequence`. Nothing in the patch assumes an order beyond
`native-mounted` being first, and no phase gates rendering, input or presentation. A phase is recorded once;
a registrant that arrives later reads `nativeReadinessSnapshot()` and receives no duplicate event.

**Three routes, and which one is load-bearing.** An SDK or embedding host registers before `init()` and
receives every phase as an event. An extension registers from `session_start`, which is after the mount, and
reads the mount from the snapshot. Neither is a launch-time route for a host that launched the bundled CLI:
extension `session_start` handlers run in series, so an arbitrary handler that awaits forever stops every
later extension from reporting anything at all. The load-bearing route is therefore the core bootstrap
sideband (8.1a), opened by `main()` before any extension exists. The acceptance suite drives exactly that
case through the installed bundled CLI under a real pseudo-terminal: a blocking `session_start` dialog holds
initialization, the host still learns `native-mounted`, presents to that terminal over the sideband, answers
the dialog with a keystroke, and then receives `first-paint` and `initialized` as separate records.

### 8.5 Terminal ownership

`presentTerminal` refuses, and writes nothing, while a recognised handoff holds the terminal: the external
editor (`terminalOwner: "child"`, `childAcknowledgement: "unavailable"`) and Ctrl+Z suspension
(`terminalOwner: "suspended"`). `terminalOwner` is deliberately wider than the design document's
`'pi' | 'child'`, which cannot express a suspension in which neither Pi nor a child owns the terminal.

Arbitrary extension children are **not** covered: an extension can spawn anything with any stdio and tell
Pi nothing. Reconstructing a child-owned screen is not attempted, and no repaint is faked. Announcing the
handoff with a drained input boundary is seam G, and it is not in this patch.

### 8.6 Not covered by this patch

- Both native renderers are supported. The fullscreen renderer's complete frame is one full redraw; the
  main-screen renderer's is its `fullRender` path, which a forced render always takes. Incremental frames —
  changed rows, changed lines — mint no receipt, because a presentation nonce may only name a complete frame.
  A main-screen presentation clears the screen and the scrollback, exactly as a stock `requestRender(true)`
  on that renderer already does; neither preserves scrollback a warm client had.
- A renderer that is not one of those two is refused by capability preflight, **before any byte is written**:
  `TuiBase` supplies the presentation methods but carries no capability brand, so a third-party subclass
  reports `no-complete-frame-support` without emitting mode bytes or half a render.
- Kitty protocol bytes in a test are protocol bytes. They are not proof of visual output on a real Kitty
  terminal.
- Everything listed in `NATIVE_PRESENTATION_CAPABILITY.notDelivered`.
