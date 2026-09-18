# vendor/pi seam D interface: canonical admission on exact names

This is the public contract of the one source patch this node owns,
`vendor/pi/patches/0004-native-canonical-admission.patch`, sha256
`66cdeaacf78c3e18e8f7512abf928d7a509691ea776f368d417a60ae0e446dc0`. In `patches/series` it is applied
fourth, after seam A, seam B/C/F and seam E; the prepared tree after the four-patch series is
`87062556dde3b44331f1638c51062a8c390548ce` (recorded by `prepare.mjs` on worker `3745834`, Node
`v22.23.2`). `test/native-canonical.test.mjs` is the acceptance suite that drives it through an installed
artifact, and `packages/coding-agent/test/native-canonical-admission.test.ts` is the patch's own upstream
regression test.

It is a section of `vendor/pi/INTERFACE.md` — the vendor pin, build and patch-rule contract — which another
node owns. Read that file for the pin, what you run, what you get, the package cohort and the rules a patch
must satisfy. Nothing here restates them, and nothing here claims any seam other than D.

## Seam D: canonical admission

All of it is opt-in twice over. Canonical behaviour is byte-for-byte unmodified 0.84.3 until a host is
registered **and** that host carries the canonical trio; a seam A host without the trio leaves every session
file operation exactly as it was.

### What a host implements

The trio goes on the `NativeSubmitHost` a host already registers with `setNativeSubmissionHost`:

```ts
type CanonicalOperationKind = "startup" | "new" | "fork" | "resume" | "import" | "rename" | "delete";

type CanonicalOperation = {
  operationId: string;
  operation: CanonicalOperationKind;
  currentBinding: NativeSubmitBinding;             // { canonicalFile: string | undefined; generation: number }
  resolvedTarget: { canonicalFile: string };       // the EXACT normalized absolute final path
};

type CanonicalAdmission =
  | { reservationId: string }
  | { refused: true;
      code: "TARGET_HAS_LIVE_WRITER" | "TARGET_UNCERTAIN" | "STALE_BINDING" | "DUPLICATE_OPERATION"
          | "ADMISSION_UNAVAILABLE";
      message: string };

// All three or none. A partial trio throws at registration.
admitCanonicalOperation?(operation: CanonicalOperation): Promise<CanonicalAdmission>;
commitBinding?(commit: { reservationId: string; nextGeneration: number }): Promise<void>;
abortReservation?(abort: { reservationId: string; reason: string }): Promise<void>;
```

`NativeSubmitBinding` is seam A's fixed shape. Row id, device, inode and `OwnerRunIdentity` are **host**
data: Pi neither sources nor reports them.

### What a host reads

```ts
nativeCanonicalCapability(): typeof NATIVE_CANONICAL_CAPABILITY;   // { seam: "D", version: 1, delivers, notDelivered }
class CanonicalOperationRefusedError extends Error { code; operation; resolvedTarget; beforeMutation: true }
```

The coordinator, its reservations, the barrier and the binding supplier are **not** exported. A caller cannot
mint a reservation, claim a mutation already happened, or move this owner's binding.

### The rules a host can rely on

1. **Exact names, resolved before the reservation.** `new` and `fork` resolve the final filename — Pi's own
   `<iso-timestamp>_<sessionId>.jsonl` rule, through `SessionManager.resolveNextSessionFile()` for a branch —
   and admit that path. `resume`, `import`, selector rename and selector delete admit the exact selected or
   destination path. An admitted create that finds the name taken fails the operation, aborts its reservation
   once, and never rerolls a name or overwrites: a managed branch create uses `wx`, and a managed import
   copies with `COPYFILE_EXCL`.
2. **Admission precedes the first side effect.** The ordered trace for every intercepted call site is
   admission, then the create, copy, open, append, trash or unlink. Opening a session file counts, because
   opening can rewrite an empty file or migrate a legacy one.
3. **One binding source, one synchronous section.** Seam D reads the same active-owner supplier seam A reads,
   and consumes its reservation inside the same non-reentrant synchronous critical section a submission fence
   is consumed in. Nothing — host, extension, session teardown, runtime creation or model work — is awaited
   while it is held. A temporary `SessionManager` opened to rename, import, inspect or list is never the
   supplier.
4. **Generations advance once per rebind.** The generation advances only when the owner's own canonical file
   becomes a *different file*: the initial undefined-to-file binding, and a successful `new`/`fork`/`resume`/
   `import` onto another file. A disposed session reports no file and does not advance it, so replacing a
   `SessionManager` or reloading onto the same file is not a rebind. Selector rename and selector delete act
   on another file and commit the **unchanged** generation.
5. **Refusals mutate nothing and disable nothing.** A refusal, a thrown or rejected handler, a malformed
   decision, an empty or colliding reservation id, a stale binding or a reused reservation performs no native
   mutation, changes no generation, and retries nothing automatically. Pi shows the host's message with retry
   and attachment guidance through its existing error channel; `/resume`, `/new`, `/fork` and `/import` stay
   enabled, and the refusal is never fatal.
6. **No `forwardTo` in v1.** A live-writer conflict is `TARGET_HAS_LIVE_WRITER` and a visible refusal — the
   alternative G-A3 permits. An unrecognised decision, including a `forwardTo` arm, is
   `ADMISSION_UNAVAILABLE`; nothing is routed and no IPC is attempted.
7. **Unresolved persistence fails closed.** After a successful mutation the coordinator is `COMMIT_PENDING`
   until exactly one `commitBinding` resolves. While pending, and permanently after a rejected or lost commit
   receipt or an ambiguously failed mutation, every later canonical mutation and every seam A authorization
   and dispatch is refused with `PERSISTENCE_UNCERTAIN`, the reservation is retained, and nothing is rolled
   back, replayed, committed twice or aborted on a guess. An `EEXIST` or a validated precondition failure
   before any side effect is a definite no-mutation outcome instead: exactly one `abortReservation`, and no
   uncertainty.
8. **Submission and canonical records stay disjoint.** A submission already accepted stays accepted when a
   later canonical operation fails or becomes uncertain, and a refused canonical operation never rewrites a
   submission receipt.

### What this patch does not deliver

- **No durable reservations.** The journal, the session-directory lock, fsync, alias/inode collapse and
  reconciliation are the host's Task 14 backend. Every test here uses a fake host.
- **No pre-spawn startup reservation.** An extension registers long after the initial `SessionManager` is
  constructed, so the `startup` operation here is the *adoption* of a binding Pi already had. The
  authoritative startup reservation belongs to the worker that spawns Pi (Task 16), and no fake-host
  `startup` case may be cited as proof of it.
- **No constraint on trusted extensions** that import `SessionManager` and write a session file directly.
- **No other seam and no Gate 5.** Seams A, B, C, E, F and G are other patches, and arbitrary-child terminal
  parity remains unproved.
