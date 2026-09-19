# vendor/pi seam D interface: canonical admission on exact names

This is the public contract of the one source patch this node owns,
`vendor/pi/patches/0004-native-canonical-admission.patch`, sha256
`425ac07a02a6d10261f01ad9b8048ee5719ab745f1af6e7ffb2a08e21fc6b9d1`. In `patches/series` it is applied
fourth, after seam A, seam B/C/F and seam E; the prepared tree after the four-patch series is
`e50de46baff8aefe82610a8db04d47c6d8575a8d` (recorded by `prepare.mjs` on worker `3749510`, Node
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
   copies with `COPYFILE_EXCL`. **A fork with no canonical host resolves and reserves nothing**, so the stock
   branch create — its own naming and its own overwrite behaviour — is what runs.
2. **Admission precedes the first side effect.** The ordered trace for every intercepted call site is
   admission, then the create, copy, open, append, trash or unlink. Opening a session file counts, because
   opening can rewrite an empty file or migrate a legacy one; `SessionManager.fileRewrittenOnLoad()` reports
   whether that happened, and a precondition failure after such a rewrite is mutation uncertainty rather than
   a definite no-mutation abort.
3. **One binding source, one synchronous section.** Seam D reads the same active-owner supplier seam A reads,
   and consumes its reservation inside the same non-reentrant synchronous critical section a submission fence
   is consumed in. Nothing — host, extension, session teardown, runtime creation or model work — is awaited
   while it is held. The coordinator rechecks its own state *inside* that section, so an operation admitted at
   the same generation as another cannot mutate once that other operation reached its commit. A temporary
   `SessionManager` opened to rename, import, inspect or list is never the supplier.
4. **Generations advance once per rebind, and a rebind is committed only after it happened.** The generation
   advances only when the owner's own canonical file becomes a *different file*: the initial undefined-to-file
   binding, and a successful `new`/`fork`/`resume`/`import` onto another file. A disposed session reports no
   file and does not advance it, so replacing a `SessionManager` or reloading onto the same file is not a
   rebind. `commitBinding` for a rebind is sent only after the session teardown and runtime creation finished
   and the same supplier reports the admitted target, and it carries the generation that supplier reports —
   never one computed from the requested target. A replacement that fails, or that leaves this owner on
   another file or unbound, commits nothing and leaves the owner `PERSISTENCE_UNCERTAIN`. Selector rename and
   selector delete act on another file and commit the **unchanged** generation.
5. **Refusals mutate nothing and disable nothing.** A refusal, a thrown or rejected handler, a malformed
   decision, an empty or colliding reservation id, a stale binding or a reused reservation performs no native
   mutation, changes no generation, and retries nothing automatically. A refusal arm is validated strictly:
   `refused` must be exactly `true`, the code must be one of the five names above and the message must be a
   non-empty string, or the decision is malformed and becomes `ADMISSION_UNAVAILABLE`. Pi shows the host's
   message with retry and attachment guidance through its existing error channel; `/resume`, `/new`, `/fork`
   and `/import` stay enabled, and the refusal is never fatal.
6. **No `forwardTo` in v1.** A live-writer conflict is `TARGET_HAS_LIVE_WRITER` and a visible refusal — the
   alternative G-A3 permits. An unrecognised decision, including a `forwardTo` arm, is
   `ADMISSION_UNAVAILABLE`; nothing is routed and no IPC is attempted.
7. **Unresolved persistence fails closed.** After a successful mutation the coordinator is `COMMIT_PENDING`
   until exactly one `commitBinding` resolves, which includes the whole awaited session replacement of a
   rebind. While pending, and permanently after a rejected or lost commit receipt, an ambiguously failed
   mutation or a failed replacement, every later canonical mutation and every seam A authorization and
   dispatch is refused with `PERSISTENCE_UNCERTAIN`, the reservation is retained, and nothing is rolled back,
   replayed, committed twice or aborted on a guess. Only two outcomes are definite no-mutation outcomes
   instead — a validated precondition that failed before any write, and an `EEXIST` from a call site whose
   first write is the exclusive create of that exact target — and each gets exactly one `abortReservation`
   with no uncertainty. A failed selector deletion is never committed: the file's own unchanged revision is
   the proof that aborts it, and anything else stays uncertain while the selector shows its usual error.
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
