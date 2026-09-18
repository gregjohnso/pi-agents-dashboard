# Native input interface: labelled ingress, return authorization, terminal profile

The public contract of the input lane of native attachment, seams **B**, **C** and **F**. It is delivered as
one ordered source patch on the pinned Pi tree, `vendor/pi/patches/0002-native-ingress-return-profile.patch`,
and its cases are `test/native-ingress.test.mjs` and `test/native-return.test.mjs`. Those cases drive the
**built** package named by the artifacts manifest in `PI_NATIVE_ARTIFACTS_MANIFEST`, which
`test/fixtures/native-ingress/write-artifacts-manifest.mjs` produces from a build's own
`build-manifest.json` and the consumer that build installed — never a checkout, and never a committed
pointer at some earlier machine's build.

This document records the contract an integrator may rely on. Seams A, D, E and G are other lanes: an
artifact built from this patch advertises B/C/F and nothing else, and Gate 5 (child terminal parity) is
untouched and unproved.

## Where it lives

Everything is inside `@earendil-works/pi-tui`, exported from the package entry point. New module
`packages/tui/src/native-attachment.ts`; modified `stdin-buffer.ts`, `terminal.ts`, `tui.ts`,
`editor-component.ts`, `index.ts`. No `pi-agents` runtime, app, shared or root package file is touched and no
dependency is activated.

## Public surface

```ts
type AttachmentEpoch = { attachmentId: string; epoch: number };   // epoch strictly increases, never reused

type NativeInputProvenance = {
  sequenceId: string;
  origin: AttachmentEpoch | null;   // null for ordinary local stdin
  mixedOrigin: boolean;
  bindingGeneration: number;        // the generation this sequence's final byte arrived under; 0 local
  mixedBindingGeneration: boolean;  // native framing assembled it across a generation change
};

type NativeInputDispatch = { attachmentEpoch: AttachmentEpoch; bytes: Uint8Array; binding: { generation: number } };
type NativeReturnRequest = { sequenceId: string; origin: AttachmentEpoch; mixedOrigin: boolean; binding: { generation: number } };
type ReturnAuthorization = "native" | { detachOrigin: AttachmentEpoch };

interface NativeAttachmentHost {
  profile: VirtualTerminalProfile;                                              // launch-fixed
  authorizeReturn(request: NativeReturnRequest): ReturnAuthorization;           // synchronous
  beforeApplyTerminalResponse(response: TerminalResponseApplication): Promise<{ apply: boolean }>;
}

registerNativeAttachmentHost(host): { release(): void };
getNativeAttachmentHost(); getVirtualTerminalProfile(); declaresReturnKey(component, sequence);
authorizeTerminalResponse(host, response, stillCurrent, apply); settleTerminalResponseAuthorizations();
// on ProcessTerminal, optional on the Terminal interface:
dispatchNativeInput(input: NativeInputDispatch): Promise<{ consumedThrough: number }>;
```

The epoch high-water mark is not public: `dispatchNativeInput` records a reconnect itself during admission,
so there is no exported state mutator and no out-of-band reconnect notification.

Registration state is one versioned container on `globalThis` under
`Symbol.for("@earendil-works/pi-tui:native-attachment")`, `version === 1` today. This is load-bearing: a
bundled Pi inlines pi-tui into `dist/bundle/chunks/*.js`, so an owner bootstrap that imports the installed
package is a second module instance in the same process. One container makes those instances one registry.
A copy of pi-tui speaking another version throws a named error rather than replacing, resetting or falling
back to unmanaged behavior. Scope is the process, not a security boundary; `release()` clears only its own
host and never the launch-fixed profile.

## Ordered ingress

One `dispatchNativeInput` call, in order:

1. **Admission, synchronously, before the dispatch waits for its turn.** Refuse and return early for a
   generation below the highest seen or a superseded attachment epoch; otherwise record this generation and
   epoch as current and fix this dispatch's own `consumedThrough` boundary. Admission is deliberately
   outside the serialization chain, so a reconnect is visible to a response authorization that is already
   awaiting a host decision.
2. Wait for the previous dispatch's turn, so byte order is submission order.
3. Flush queued incomplete bytes first if they came from a different attachment, epoch or binding
   generation. A codepoint never spans any of those boundaries; the truncated tail renders as `U+FFFD`
   rather than being dropped or completed by an unrelated keystroke.
4. Append to the single ordered byte queue with origins and generation, decode every complete codepoint,
   and feed the characters into `StdinBuffer` with a per-character origin ledger.
5. For each emitted sequence, in order: a keyboard-protocol response is **consumed** and authorized with its
   complete reassembled `raw`; anything else is forwarded with a `NativeInputProvenance` record.
6. The dispatch promise resolves once every in-flight response authorization has settled, and reports the
   boundary fixed at admission.

Ingress is one ordered stream, not one per client: a client holding an incomplete codepoint cannot be
overtaken by a later client's complete key. A sequence's `bindingGeneration` is its own bytes' generation,
not the generation the terminal has since reached; parser framing is never flushed mid-key, the attribution
carries the fact instead. Origin identity is `{attachmentId, epoch}` by value, never object identity. A
bracketed-paste body stays one gesture, attributed by final byte and marked `mixedOrigin` when another
attachment typed into it.

## Response and return rules

Every response kind — `da`, `kitty-keyboard`, `cell-size` — goes through `authorizeTerminalResponse`:
bounded at 1000 ms, one pending set, revalidated after the await. A response applies only on
`{apply: true}` with an unchanged request epoch and a non-superseded attachment epoch. A refusal, throw,
rejection or expiry means the response is consumed and no capability state moves; missing authorization is
never a fallback to applying. Reply-shaped bytes inside a paste body are text. With no host registered,
negotiation is unmanaged Pi's own immediate application. OSC 11 background-colour replies are **not**
covered: they still resolve a query promise through the existing pending-query counter.

`authorizeReturn` is consulted only when a host is registered, the sequence matches Pi's own
`matchesKey(data, "return")`, `origin` is non-null, `mixedOrigin` and `mixedBindingGeneration` are both
false, and the focused component's `declaresReturnKey` returned `"free"`. Absent `declaresReturnKey` means
`"owns"`, so an unknown custom component keeps its key by default and the host is never asked. The key is
withheld only for an exact claim: a throw, a malformed result, or a `detachOrigin` that differs from
`provenance.origin` all deliver the key. Pi detaches nobody; acting on the decision is the host's.

## Drain boundary for seam G

`consumedThrough` counts bytes accepted into the ordered native input path across all attachments,
monotonically, and each dispatch reports the boundary fixed when **it** was admitted. A resolved dispatch
means: parsed, dispatched, and no pending capability decision.

Three holds an integrator must carry into seam G:

1. Bytes held as an incomplete UTF-8 codepoint count as accepted. They cannot be overtaken and are flushed
   at any attachment, epoch or generation transition, but until then they are not parsed.
2. A split keyboard-protocol response is held for up to 150 ms by upstream's fragment window, and that wait
   is not awaited by `dispatchNativeInput`.
3. `StdinBuffer` holds an incomplete sequence for up to 50 ms, and that wait is not awaited either.

Seam G's `drainedThrough` is the **counter snapshot at the close barrier**, not an arithmetic increment for
flushing, and it *means* that every byte accepted through that snapshot has been through all three forced
holds and that every response authorization those bytes started has settled. A drain that flushed only the
two timer windows would leave an unparsed codepoint behind, and one that flushed only the codepoint hold
would leave a held sequence behind, so the order is load-bearing: the codepoint hold feeds `StdinBuffer`,
whose released sequence can classify as a split response fragment. `vendor/pi/patches/0005-native-child-handoff.patch`
implements exactly that drain and brackets Pi's own recognized external editor with it; see
`vendor/pi/INTERFACE-seam-g-child-handoff.md`. It implements no arbitrary-child spawning, discovery or
parity, and this lane's own patch still implements none of the three flushes.

## What this lane does not deliver

- `binding.generation` is accepted and compared here, never minted or committed: that is seam A's.
- Submission and draft preservation are untouched. `authorizeReturn` fires only for a single-origin return on
  a component that declared the key `"free"`, cannot observe or restore editor text, and is not a submission
  barrier. Any custom-editor submission claim needs seam A's own verification.
- The owner-side bootstrap is not written here. Managed attachment stays inert until an owner process calls
  `registerNativeAttachmentHost` once, before the interactive mode constructs its `Tui`. With nothing
  registered, `origin` is `null`, the return gate returns early, negotiation applies immediately, and
  behavior is the pinned baseline's.
- `tui.ts` and `terminal.ts` also change in lanes A and E, and these patches do not commute: this one
  changes the `handleTerminalInput` signature, the `terminal.start` callback type,
  `consumeCellSizeResponse`, `StdinBuffer.process` and the `StdinBuffer` event tuple. Rebase in series
  order and re-run both case files; do not apply with fuzz.

## Serialized form in the composed series

`vendor/pi/patches/series` now applies this lane second, after seam A and before seam E, and the patch file
in that series is the **serialized** diff taken at that position: sha256
`9376635ebb4aa87d77354fe19c53cf70562aa37ba64f9e5513e0e2ed7ea7db1e`, where this lane's own diff against the
bare pin was `1db62cf6355d371d910a947d771a6c81efff5f4996a7a7d5b3796a5d251ae816`. Nothing in the public
surface above changed: serializing resolved one import-block overlap in `packages/tui/src/terminal.ts`, and
both lanes' imports are kept. `vendor/pi/INTERFACE.md` section 9 records the order, the digests and the
prepared-tree hashes.
