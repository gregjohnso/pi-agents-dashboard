# vendor/pi consumer-capability interface: the published input target, ordered presentation framing, and bootstrap protocol 2

This is the public contract of one source patch, `vendor/pi/patches/0006-native-consumer-capabilities.patch`.
It is applied **sixth and last** in this branch's series, after `0005-native-child-handoff.patch`, and it is
generated against the tree the first five patches leave behind: every file it touches is a file an earlier
patch already rewrote, so it applies at that position and nowhere else. `INTERFACE.md` section 9 records the
per-position digests.

`vendor/pi/INTERFACE.md`, `vendor/pi/README.md` and `vendor/pi/NOTICE.md` record the composed order.

`test/native-consumer-capabilities.test.mjs` is the acceptance suite. Its in-process cases drive the installed
cohort named by `PI_NATIVE_ARTIFACTS_MANIFEST`; its pseudo-terminal cases drive the installed bundled CLI named
by `PI_NATIVE_COHORT`. With neither selected they skip rather than pretend a cohort is present.

## Why this patch exists

Two gaps in the five-patch cohort, both established by reading its own source:

1. **There was no early public route to labelled ingress.** Seam B's `ProcessTerminal.dispatchNativeInput` was
   public, but reaching the terminal object meant reaching Pi's renderer, and the only published route to it
   ran through an extension's `session_start` handler. An arbitrary extension can block that handler forever,
   and a management extension queued behind it then never registers, so a host had no route at all.
2. **There was no physical presentation boundary.** Seam E's receipt names the complete frame the renderer
   handed to `Terminal.write`. It does not say where that frame began and ended in the bytes a host reads off
   the PTY master, so a host could not separate the frame's own bytes from everything else Pi wrote.

This patch adds one narrow answer to each, and nothing else. It does not add a host, a client, a transport, a
recovery coordinator or a display acknowledgement.

## 1. The native input target

From `@earendil-works/pi-tui`:

```ts
NATIVE_INPUT_TARGET_API_VERSION; // 1 — this build exports the API
NATIVE_INPUT_TARGET_PRODUCER_VERSION; // 1 — this build's ProcessTerminal publishes

type NativeInputTargetPublication = { publicationId: string; sequence: number; producerVersion: number };
type NativeInputTargetRevoked = { admitted: false; reason: "target-revoked" };
type NativeInputTarget = {
  readonly publication: NativeInputTargetPublication;
  dispatchNativeInput(input: NativeInputDispatch): Promise<NativeInputDispatchResult | NativeInputTargetRevoked>;
};
type NativeInputTargetUnavailableReason = "producer-absent" | "revoked" | "host-released" | "host-replaced";
type NativeInputTargetSnapshot = {
  apiVersion: 1;
  producerVersion: number | null;
  publication: NativeInputTargetPublication | null;
  target: NativeInputTarget | null;
  reason: NativeInputTargetUnavailableReason | null;
};

nativeInputTargetSnapshot(): NativeInputTargetSnapshot;
subscribeNativeInputTarget(
  listener: (snapshot: NativeInputTargetSnapshot) => void,
): { snapshot: NativeInputTargetSnapshot; unsubscribe(): void };
```

**API availability is not producer availability.** `NATIVE_INPUT_TARGET_API_VERSION` says the functions exist.
`producerVersion` is `null` until a `ProcessTerminal` of *this* build publishes, so a new installed copy paired
with an older bundled Pi reports API version 1 and `producerVersion: null`, and a host must not infer support
from the exported version. Once a producer has published, `producerVersion` stays set, so "no new producer in
this process" and "a producer published and its target is currently unavailable" are different answers.

**Lifecycle.** Publication happens at the last point of `ProcessTerminal.start()`, after the stdin buffer, the
stdin handler, the negotiation state and the startup capability query exist. `TuiBase.start()` calls
`terminal.start(...)` synchronously and returns, and `InteractiveMode` records `native-mounted` only after that
return, so the publication is observable before `native-mounted` and before any extension callback. Revocation
is synchronous, at the first point of `ProcessTerminal.stop()`, before any buffer or handler is destroyed.
Every restart mints a new publication with a higher `sequence`.

**Staleness is checked against two identities, on every call.** A publication captures both the publication
record and the exact `state.host` object registered at that moment. `dispatchNativeInput` on the handle
re-reads the shared process container synchronously and requires both to still match; otherwise it answers
`{ admitted: false, reason: "target-revoked" }` and carries no `consumedThrough`, because nothing was
dispatched. This is what makes a stale handle safe in a mixed process: an **older** copy of
`native-attachment.ts` changes or clears the shared `state.host` and can neither rotate a publication nor
notify anybody, so safety cannot depend on a callback. Host identity is the guard that works anyway.

**Registration rotates; release revokes.** `registerNativeAttachmentHost` on a process with a mounted producer
mints a new publication for the new host, and its `release()` revokes that publication. The producer mount
survives a release, so a later registration republishes with no renderer restart. Registering the same host
object again changes nothing.

**Notification.** `subscribeNativeInputTarget` registers the listener and then reads the snapshot, so a caller
cannot lose a transition between reading and subscribing; it may observe one transition twice. A listener that
throws is reported as a process warning and the remaining listeners still run.

**Seam G is unchanged.** The drain closes the terminal's admission, not the publication: a call through the
current handle during a drain gets seam G's own `handoff-closed`, with the bytes still the sender's.
`ui.stop()` then revokes, `ui.start()` publishes a new handle while the lease is still closed, and only the
lease's `reopen()` admits. Recognized-child behavior implies nothing about arbitrary children; gate 5 is open.

**Registry versioning.** The four optional fields are additive, so `NATIVE_ATTACHMENT_STATE_VERSION` stays 1:
an older copy never reads them. A present-but-uninterpretable publication record, or a producer version this
copy does not speak, is **refused** with a throw and left untouched — never reset, and never downgraded to
"no target".

## 2. `dcs-pi-native-present-v1`

From `@earendil-works/pi-tui`:

```ts
NATIVE_PRESENT_MARKER_CODEC; // "dcs-pi-native-present-v1"
NATIVE_PRESENT_ORDERING_VERSION; // 1
NATIVE_PRESENT_TOKEN_BYTES; // 32
NATIVE_PRESENT_TOKEN_LENGTH; // 43
NATIVE_PRESENT_MARKER_MAX_BYTES; // 128
NATIVE_PRESENT_FRESH_CHUNK_MAX; // 16384

type NativePresentOrdering = { version: number; token: string };
mintNativePresentToken(): string;
isNativePresentToken(candidate: unknown): candidate is string;
isNativePresentFrameId(candidate: unknown): candidate is string;
encodeNativePresentBegin(token: string): string;
encodeNativePresentEnd(token: string, frameId: string): string;
encodeNativePresentAbort(token: string): string;

type NativePresentMarkerRefusal =
  | "duplicate-begin" | "unexpected-end" | "unexpected-abort" | "malformed-marker" | "overlong-candidate";
type NativePresentMarkerEvent =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "begin"; token: string }
  | { kind: "end"; token: string; frameId: string }
  | { kind: "abort"; token: string }
  | { kind: "refused"; reason: NativePresentMarkerRefusal; bytes: Uint8Array };

class NativePresentMarkerDecoder {
  static readonly MAX_RETAINED_BYTES; // 128
  get armedToken(): string | undefined;
  get phase(): "idle" | "open";
  arm(token: string): void;
  disarm(): void;
  retainedBytes(): number;
  decode(chunk: Uint8Array): NativePresentMarkerEvent[];
  flush(): NativePresentMarkerEvent[];
}
```

The wire form, where `ESC \` is the two bytes `0x1b 0x5c`:

| Marker | Bytes |
| --- | --- |
| BEGIN | `ESC P =pi-native-present;1;B;<token> ESC \` |
| END | `ESC P =pi-native-present;1;E;<token>;<frameId> ESC \` |
| ABORT | `ESC P =pi-native-present;1;A;<token> ESC \` |

`token` is 32 cryptographic random bytes as exactly 43 canonical unpadded base64url characters, minted per
attempt by the host. `frameId` is the renderer's own 36-character lowercase UUID from the frame receipt. Every
marker is at most 128 bytes: BEGIN and ABORT are 70, END is 107, and the failed-attempt cleanup write below is
72.

**Where they are written, and what happens when a write fails.** `TuiBase.presentNow` writes BEGIN as the first
byte of the interval — before the cold reassertion — and END carrying the receipt's `frameId` as the last, on the
terminal's own `write` path.

`Terminal.write` is a synchronous **local admission** call. A normal return means the bytes were admitted, not
that the OS delivered or the terminal displayed them; a `false` from an underlying `Writable` still admitted
them; and a throw reports **no accepted-byte count**, so it may have admitted nothing, an arbitrary prefix, or
all of it. Nothing here assumes `write` is atomic on throw.

Every write of an ordered attempt is therefore inside one failure-handling region — BEGIN, the cold reassertion,
the render, the completeness check and END:

- **No exception from any of them produces `presented: true`.** The original exception, with its identity, is
  what the caller receives.
- **A failing BEGIN does not go on** to reassert modes or render: there is no interval to fill.
- **Nothing admitted is ever rewritten.** No marker, frame byte or accepted prefix is retried, ever.
- **A failed attempt makes at most ONE cleanup write:** the two-byte DCS string terminator `ESC \` immediately
  followed by that token's exact ABORT marker. The leading terminator is there because a failed marker write may
  have left an unterminated candidate in the stream; it ends that candidate before ABORT is read. This is
  bounded framing cleanup — not a frame replay, not a rollback and not a VT parser.
- **Pending presentation state is cleared on every exit**, including the paths that never reached the render.
- A `no-complete-frame-support` refusal is a failed ordered attempt too: it gets the same one cleanup write, and
  it stays a refusal even if that write fails.

**ABORT means the attempt failed. It does not mean no frame bytes were written, and it undoes nothing.** The
whole frame, or even END, may already have been admitted before a throw. The cleanup's own leading terminator
can itself complete an otherwise-finished partial BEGIN or END, so a reader that sees an END must not conclude
the presentation succeeded — see the success rule below.

**If the cleanup write itself throws**, what it admitted and whether the framing closed are both unknown. It is
never retried: retrying could write an accepted prefix twice. The uncertainty is reported as a fixed process
warning that formats no error object and carries no token or marker bytes — a thrown error's message is
arbitrary text that may itself contain the attempt's token — and it claims neither that the framing stayed open
nor that it closed.

Without an `ordering` on the request, **not one marker or cleanup byte is written**, so Pi's default output is
unchanged. An unknown ordering version, an unknown codec or a non-canonical token is refused by the preflight,
before any byte, as `{ presented: false, reason: "unsupported-ordering" }`, and writes no cleanup either.

### A usable successful ordered presentation needs two things

A consumer may treat an ordered presentation as usable — and issue or accept its recovery acknowledgement — only
with **both**:

1. the request's own successful presentation result, with matching receipt/frame identity; **and**
2. the matching BEGIN/END observed on the fresh byte route.

A native local frame-handoff event alone is not success. A throwing, negative or missing control result, an
ABORT, refused framing or transport loss leaves the attempt failed or uncertain **even if a complete END was
observed** — which is exactly what a fully admitted END followed by a throwing write, or a partial END completed
by the cleanup terminator, looks like on the byte route. Retire that token and nonce, stop treating later bytes
as its fresh frame, and do not replay. A later independent cold presentation with a **new** token may recover;
it does not retroactively validate the old attempt.

**What the decoder is.** A framing decoder, and deliberately not a VT, key or screen parser. It recognizes
exactly the markers of the token it is armed with and **reproduces every other byte verbatim**, which is what
keeps untrusted marker-like terminal text byte-identical: an unarmed decoder, a wrong or stale token, and a
body this codec never wrote are all plain bytes. Only the armed token in the wrong shape or the wrong phase is
refused, and a refusal still carries the candidate's bytes, so nothing is ever lost. Concatenating the bytes of
every `bytes` and `refused` event, with each recognized marker re-encoded at its own position, reproduces the
decoded input exactly.

**Bounds.** At most 128 bytes are retained between calls — an unterminated candidate's prefix — plus the chunk
being decoded. A candidate that reaches the bound without terminating is refused as `overlong-candidate` and
never grown. Where a read boundary fell is not part of the framing: the same bytes decode the same way split at
every byte boundary and coalesced into one read.

**How that is qualified, and how it is not.** The real-stream evidence feeds the decoder the exact raw `Buffer`
reads as they arrive from the pseudo-terminal relay while the producer is still running, stamps every decoded
event with the arriving read it came from, and samples `retainedBytes()` after every read. Two producers are
used for two different reasons: Pi's own renderer, which proves a real ordered presentation is bracketed; and a
fixture producer that splits each marker across a reader-confirmed gap and has a child process write inside the
interval, because `presentNow` runs the whole interval in one synchronous call and therefore cannot be asked
for a split or an interleave. A recorded transcript is secondary evidence only and is never the input a decoder
is fed. In-process re-slicing of one buffer at a chosen stride remains in the suite as a supplementary check;
it is synthetic, and an earlier receipt that called it "kernel-sized reads" was wrong.

**How the write-failure cases are qualified.** A test double admits a chosen prefix of a chosen write and then
throws, which is the only shape a channel with no accepted-byte count can present. Every case reconstructs the
physical stream from what the double really took and requires exactly that prefix, so a title cannot stand in
for a fact. BEGIN and END are swept at every byte prefix on both renderers; the cleanup write is covered at zero,
partial and full admission, and the fully admitted case still reports uncertainty because a write that threw
says nothing about what it admitted. An earlier version of this suite reported those three cleanup cases green
while all three admitted zero bytes: the fault callback threw before returning an accepted length, so the
double's prefix-recording path was never reached. That was a test defect, not a production one, and the
correction is test-only — see `cleanup-test-correction/receipts.md` in the orchestration workspace for the
per-block proof that every production hunk is byte-identical across it.

**What a marker is not.** It is a boundary in a byte stream. It is not proof that a client decoded, flushed,
parsed or displayed anything. A client acknowledgement is the host's work (Task 12/17) and is not in this
patch.

## 3. Bootstrap protocol 2

From `@earendil-works/pi-coding-agent`:

```ts
NATIVE_BOOTSTRAP_PROTOCOL; // 1
NATIVE_BOOTSTRAP_ORDERED_PROTOCOL; // 2
NATIVE_BOOTSTRAP_PROTOCOL_ENV; // "PI_NATIVE_BOOTSTRAP_PROTOCOL"
NATIVE_BOOTSTRAP_ORDERED_PRESENTATION; // { version, markerCodec, tokenBytes, maxMarkerBytes, freshChunkMax }
type NativeBootstrapProtocol = 1 | 2;
```

Protocol 1 is **not** extended. Its reviewed parser requires `protocol === 1` and the single `present`
command, and extra hello fields are not an approved extension point for it.

| `PI_NATIVE_BOOTSTRAP_PROTOCOL` | Behavior |
| --- | --- |
| absent or `1` | the protocol-1 channel, unchanged: same hello fields, same single command, same refusals |
| `2` | a protocol-2 hello carrying `orderedPresentation`, and `present-ordered` accepted |
| anything else | fails closed: no socket is opened, `nativeBootstrapStatus()` is `failed` and names the value |

`PI_NATIVE_BOOTSTRAP_SOCKET` is unchanged: the transport and the schema are two separate decisions.
`nativeBootstrapStatus()` gained one field, `protocol`, so a host or a test can tell 1 from 2 without a frame.

The protocol-2 hello adds one field to the protocol-1 shape:

```json
{"orderedPresentation":{"version":1,"markerCodec":"dcs-pi-native-present-v1","tokenBytes":32,"maxMarkerBytes":128,"freshChunkMax":16384}}
```

The protocol-2 command is `present-ordered`, which is the protocol-1 `present` fields plus
`ordering: { version: 1, token, markerCodec? }`. Its `presentation-result` echoes `ordering: { version, token }`
so a host binds the result to the markers it armed, and `result.ordering` carries the same pair plus the codec
name. An unknown ordering version, an unknown codec or a non-canonical token is refused before presentation and
is **never** downgraded to an unordered presentation.

`present` is retained under protocol 2, and its meaning is named: it is exactly the protocol-1 presentation —
a **local** handoff of the frame to `Terminal.write`, no marker written, and no physical-delivery claim. A host
that needs the frame's own boundary uses `present-ordered`.

**Compatibility across versions.** A new host must set protocol 2 and validate the first hello before it sends
anything: an old Pi ignores the selector, sends its protocol-1 hello, and the new host refuses activation
locally and sends no command. No old Pi is expected to emit a new named refusal. A protocol-1 frame on a
protocol-2 channel, and the reverse, are refused by version with both versions named.

## What this patch does not deliver

- **A marker is a boundary in a byte stream.** No OS flush, terminal parse, display, pixel or client
  acknowledgement claim follows from one, and an observed END is not on its own a successful presentation.
- No host, client, transport, fresh-route streaming, queue accounting or acknowledgement. Those are Task 12/17
  and are not touched here. `NATIVE_PRESENT_FRESH_CHUNK_MAX` is declared because a peer needs the bound; this
  patch neither reads nor writes a client transport.
- No change to Task 11. There is no `recovering` state, no ordinary live output to a resync-required member
  before its acknowledgement, and no AttachmentSet change of any kind. The known liveness cost stands:
  continuous post-END output or a slow acknowledgement can leave a client resync-required until an output gap.
- No retained frame, no saved tail and no replay anywhere. The decoder's memory is the 128-byte bound plus the
  chunk in hand.
- No display, flush or pixel claim from a marker, and no client acknowledgement semantics.
- No `VirtualTerminalProfile` or seam F change. The OSC11 exclusion recorded for this lane is evidence only.
- No arbitrary-child terminal parity. Gate 5 is open, exactly as `0005` left it.
- No product rollout. The demo's `awaitTui()` ingress dependency is still in the demo; consuming this target
  there is the integration lane's work, not this patch's.
