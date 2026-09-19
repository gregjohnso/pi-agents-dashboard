# vendor/pi interface, for the seam implementer

Read this before you write a Pi source patch or consume a built artifact. `vendor/pi/README.md` is the
maintenance procedure; this file is the contract.

**Seams A, B, C, D, E and F are implemented and composed but NOT qualified; seam G is absent.** The
series carries four ordered patches, so today's artifacts are **patched** upstream Pi 0.84.3 that expose
the native submission barrier, labelled ingress with return authorization and the terminal profile,
cold presentation with readiness, and canonical admission on exact names — and nothing else. The build is also a **hybrid** - pinned source plus
one pinned release-generated data input - which section 6 describes in full.

Section 8 is the seam A contract: the public API, its managed activation, the envelope, the fence and the
receipts a consumer can rely on. Section 8.6 states the draft behaviour the default editor implements, and
section 8.6b states the selected **compatibility-first** custom-editor policy, the limitation that policy
accepts, and the one operator-visible notice that states the limitation instead of hiding it. Section 9 is
the composition: which document owns which seam, what the serialized series is, and what the composition
itself does not deliver. What is still missing is qualification work, not a policy: seam G's drain,
arbitrary-child terminal parity and whole-product qualification. Seam D's canonical admission arrived with
`0004` and is contracted in `INTERFACE-seam-d-canonical.md`; it is implemented and tested against a built
cohort, not frozen and not qualified. That is why these artifacts are not
cleared for dependency activation.

The seam contracts live in four documents, and none of them supersedes another:

| Seam | Contract document | Ordered patch |
| --- | --- | --- |
| A — native submission barrier | section 8 of this file | `0001-seam-a-native-submission-barrier.patch` |
| B, C, F — labelled ingress, return authorization, terminal profile | [`docs/native-input-interface.md`](../../docs/native-input-interface.md) | `0002-native-ingress-return-profile.patch` |
| E — cold presentation and readiness | [`INTERFACE-seam-e-presentation.md`](INTERFACE-seam-e-presentation.md) | `0003-native-presentation-readiness.patch` |
| D — canonical admission on exact names | [`INTERFACE-seam-d-canonical.md`](INTERFACE-seam-d-canonical.md) | `0004-native-canonical-admission.patch` |
| G | not written: unassigned and unimplemented | none |

## 1. The pin

| Field | Value |
| --- | --- |
| repository | `https://github.com/earendil-works/pi.git` |
| commit | `bfb004d4418ff05c6f909eaaab856cbe75c1fde0` (npm `gitHead` of the published 0.84.3) |
| tree | `562b495c89525fbefb00795d77f34586b69e7068` |
| tag `v0.84.3` | `4e58f324fae8ebfa98a3d45181fb248072a2afac`, **not the pin** |
| upstream `package-lock.json` | sha256 `abd9982ce837df8e2775196cde3b5c5584c30e66b232c26b7c55aafd58ab2e1b` |
| license | MIT, Copyright (c) 2025 Mario Zechner |

Never substitute the tag for the commit. `prepare.mjs` fetches the commit as an object and fails on any
other identity or tree.

## 2. What you run

```bash
OUT=<disposable root outside the repository>/attempt-<unique>
node vendor/pi/prepare.mjs --output "$OUT/prepared"                       # fetch, verify, apply series
node vendor/pi/build.mjs --prepared "$OUT/prepared" --artifacts "$OUT/artifacts"
node vendor/pi/build.mjs --prepared "$OUT/prepared" --dry-run             # the plan, runs nothing
```

Both refuse an existing directory. Neither touches the repository, `node_modules`, `.pixi`, or any
installed Pi. Everything that fetches, installs, builds or packs runs on a Slurm worker.

## 3. What you get

`$OUT/prepared/`

| File | Contents |
| --- | --- |
| `source/` | the pinned monorepo with the series applied; a git working tree at the pinned commit, with every patched path in its index |
| `prepare-intent.json` | written before the fetch: the lock digest, the series and its digest |
| `provenance.json` | written once, only on success: resolved commit/tree, verified digests, packages, applied patches with digests, `patchedTreeHash`, `workingDiffSha256`, `stagedStatus`, `baseline`, `artifactLabel` |
| `applied.diff` | the exact `git diff` the series produced, added files included; empty for a baseline |
| `prepare-failure.json` | written instead of `provenance.json` when preparation refuses |
| `build-claim.json` | written by `build.mjs`, once: this tree has been built and will not be built again |

`$OUT/artifacts/`

| File | Contents |
| --- | --- |
| `build-manifest.json` | the whole build record; see below |
| `earendil-works-pi-*-0.84.3.tgz` | seven packed packages, each carrying the verified `LICENSE` |
| `generated-input-pi-ai-model-data.json` | the pinned generated input, its registry identity and per-file digests |
| `build-failure.json` | written instead of the manifest when the build refuses |

`build-manifest.json` fields a consumer relies on:

- `artifactFiles[]`: `package`, `version`, `file`, `bytes`, `sha256`, `licenseSha256`, `exports`, `bin`
- `bundledCli`: `bin` (`dist/bundle/cli.js`), `sha256`, `bytes`, `bundleFileCount`, `bundleDigest`
- `license`: the notice added to every package root, its digest, its byte count, the repository copy it was
  checked against, and which package roots received it
- `preparedState`: the commit, `patchedTreeHash`, working diff digest and stray-file list observed at build
  start; `preparedClaim`: the one-shot claim this build took on the prepared tree
- `baseline`, `artifactLabel`, `capability`, `reproducibility`, `buildKind`
- `plan[]`: every step in execution order, each marked `kind: "command"` or `kind: "file"`
- `commands[]`: every command, in order, with exit status and duration
- `generatedInputs[]`: id, kind, spec, registry URL and SRI, the digests actually observed on the download,
  and the archive-member-to-source mapping
- `resolved`, `series`, `applied`, `upstream`, `lock`

## 4. The package cohort

Seven packages are built and packed, in this order:

`packages/tui` → `packages/telemetry` → `packages/ai` (`build:offline`) → `packages/agent` →
`packages/protocol` → `packages/client` → `packages/coding-agent`

Pack set: telemetry, ai, agent-core, protocol, client, tui, coding-agent — the full internal runtime
cohort of coding-agent's `npm-shrinkwrap.json`. Install **all seven** together. Installing only
coding-agent and tui leaves its unbundled public exports resolving registry copies of the other five.

`packages/sqlite-node` and `packages/server` are deliberately out of scope: no packed package depends on
them. If your patch touches one, add it to `build.steps`/`build.pack` from the actual imports.

Upstream names, versions, `exports` (`.`, `./client`, `./rpc-entry`), `bin` (`pi`) and `files` are
preserved. These are `@earendil-works/pi-*@0.84.3`, not a renamed fork. One file is added that upstream's own
tarballs do not carry: the pinned MIT `LICENSE`, in every package root, because the notice is required and
upstream packs none. Its digest is verified inside each tarball and recorded per artifact.

## 5. Rules a patch must satisfy

1. Source only. `git diff` against the pinned tree, no `dist`, no bundle output, no generated file, no
   binary, no `node_modules`, no postinstall. A patch may add a file: `git add -N` it before taking the diff,
   and preparation stages it with `git apply --index` so it is tracked and covered by `patchedTreeHash`.
   Nothing may be left outside the index, and the build refuses a prepared tree that holds anything untracked
   or ignored.
2. The bundled CLI is rebuilt by the pipeline. Editing `dist` or an installed tree is never acceptable:
   `packages/coding-agent`'s `build` runs `build:unbundled` and then
   `scripts/build-coding-agent-bundle.mjs`, and the bundle inlines the whole cohort.
3. Ordered and exact. `patches/series` is the order; `git apply` runs with no fuzz, no `-3` and no skip.
   An already-applied or out-of-order patch fails the preparation.
4. Native interfaces only. Ledger, ownership policy, attachment policy and session management stay in
   pi-agents.
5. Unmanaged Pi behaviour stays unchanged unless a narrowly justified bug regression requires otherwise,
   and then the justification and its regression test ship with the patch.
6. A dependency change must regenerate upstream's own install locks in the same patch, or
   `build.checks` (`generate-coding-agent-shrinkwrap.mjs --check`,
   `generate-coding-agent-install-lock.mjs --check`) fails the build.
7. Each patch brings its own regression test, and the artifact label stops saying baseline.

## 6. One upstream constraint you will meet

`packages/ai/src/providers/data/**` is gitignored upstream and generated by `npm run generate-models`,
which fetches the live models.dev catalog. The pinned commit therefore does not build from source alone,
and today's live catalog no longer type checks against it (TS2353 in
`packages/ai/src/providers/cloudflare-ai-gateway.ts`: the pinned generated shard types expect
`openai-completions` models that the current catalog no longer lists).

`upstream-lock.json` pins that generated input to the published `@earendil-works/pi-ai@0.84.3` artifact
(registry integrity plus an aggregate content digest over all 40 files, including upstream's own
`.manifest.json`), and the build uses upstream's `build:offline` script. Do not "fix" this by running
`generate-models`: that reintroduces a live network dependency into the build and a nondeterministic type
surface. If a patch needs newer model data, pin the new data explicitly in the lock.

## 7. Not done here

- No root `package.json` / `package-lock.json` change, no dependency activation, no installed-tree change.
  `README.md` lists what must pass first.
- No publication, no registry push, no upstream contact.
- Byte reproducibility is not claimed from a single build. Compare two independent builds' artifact
  digests if you need that claim.

## 8. Seam A: the native submission barrier

This is the whole delivered interface. A later seam implementer consumes exactly what is written here.

### 8.1 Activation

Two public entry points, both opt-in. Until one is called, every native submission path behaves exactly
as unmodified Pi does.

```ts
// embedding / SDK: before the session is created
import { setNativeSubmissionHost } from "@earendil-works/pi-coding-agent";
setNativeSubmissionHost(host);          // pass undefined to return to unmanaged behaviour

// from a Pi extension, which is how a process launched as the bundled CLI is managed
export default (pi) => { pi.setNativeSubmissionHost(host); };
```

**The barrier instance and its grant objects are deliberately not exported.** Forwarding state is opaque
and barrier-owned, so a caller cannot mint a grant, assert that a submission was already dispatched, or
redeem a grant for content it was not authorized for. A host implements `NativeSubmitHost` and activates
it; everything else belongs to Pi.

### 8.2 What the host implements

```ts
interface NativeSubmitHost {
  ownerRunId: string;
  beforeNativeSubmit(e: SubmissionEnvelope): Promise<NativeSubmitAuthorization>;
  recordEffectivePayload(p: EffectivePayloadRecord): Promise<EffectivePayloadReceipt>;
  nativeSubmitOutcome(o: NativeSubmitOutcome): void;
}
```

**Submission identity is owner-lifetime, not host-object-lifetime.** A management extension is
re-registered on every resource reload, and `AgentSession.reload` rebuilds extensions while submissions
accepted before the reload are still queued and still owe a drain. Re-registering a host with the **same**
`ownerRunId` therefore keeps every record and handoff and only swaps the callable host. A different
`ownerRunId`, or deactivation with `undefined`, drops the previous owner's records, so a stale handoff can
never be redeemed against a host that did not authorize it and missing managed authorization stays
fail-closed.

`SubmissionEnvelope` carries `submissionId`, `ownerRunId`, `binding {canonicalFile, generation}`,
`source`, `intent`, `originalText`, optional `attachments`, `behavior`, `draftRevision` and optional
`parentSubmissionId`. `attachmentOrigin` is deliberately absent: input provenance is seam B and optional
here, and inferring it from a last-input variable is forbidden.

**`originalText` is the operator's untouched text.** For the native editor that is the raw draft with
paste markers intact and nothing trimmed; the trimmed, paste-expanded text Pi will act on is reported
separately as an effective payload with `expandedFrom: "transform"`. Nothing downstream overwrites
`originalText`: a forwarded submission is redeemed against the exact text it was granted for.

**Attachments carry the bytes, not only a descriptor.** Pi's native attachment representation is
`ImageContent { type: "image"; data: base64; mimeType }`. Each envelope attachment is
`{ kind: "image", mediaType: mimeType, byteLength, sha256, bytes: Uint8Array }`, where `bytes` is the
decoded payload and `byteLength`/`sha256` describe those bytes rather than the base64 text. Pi keeps no
copy and stores nothing: blob persistence is the host's, and a blob the host cannot store is a refusal
(`PERSISTENCE_FAILED`), never a dropped image.

`NativeSubmitAuthorization` is `{ authorized: true; fence }` or `{ authorized: false; code; reason }` with
`code` in `PERSISTENCE_FAILED | PERSISTENCE_UNCERTAIN | STALE_BINDING | DUPLICATE_SUBMISSION | REFUSED`. A
refusal, a thrown handler, a rejected promise, a missing decision, or a fence whose `submissionId`,
`ownerRunId`, `bindingGeneration` or `nonce` does not match the envelope all dispatch nothing.

### 8.3 The fence, and why it is atomic

`SubmissionFence = { submissionId, ownerRunId, bindingGeneration, nonce }`, one use. Pi validates and
consumes it in the same **synchronous** region as the first native mutation or command dispatch:

- `dispatch(mutate)` is synchronous and `mutate` must be synchronous. Fence validation, consumption and
  the mutation therefore occur in one uninterrupted turn of the event loop.
- The canonical binding is **observed**, not committed: the barrier reads the owner's active session
  through an **internal** supplier registered by `AgentSession`, and the generation advances only when the
  owner's own canonical file changes. This supplier is seam-A fence coordination and nothing more: it is
  not exported, it is not a frozen binding-commit API, and it supplies no admission, reservation or commit
  contract. Seam D's admission, reservation and commit contract is a separate patch, `0004`, documented in
  `INTERFACE-seam-d-canonical.md`; it reads this same supplier and exports nothing new of it. A temporary `SessionManager` opened to rename, import or list some other session
  is not the owner's session and cannot move the binding. The observation is repeated inside the critical
  section, so a rebind between grant and mutation is refused with `STALE_BINDING` and mutates nothing.
- Because the section is synchronous, it is never held across an extension handler, a child submission or
  a model turn. A `dispatch` re-entered from inside a mutation throws rather than deadlocking.

A second `dispatch` of the same grant returns `DUPLICATE_SUBMISSION` and mutates nothing.

### 8.4 Receipts

`nativeSubmitOutcome` reports at most once per submission:

| `appliedAs` | Meaning |
| --- | --- |
| `applied` | the submission's messages were handed to the agent |
| `queued` | **terminal acceptance for this submission**, not model completion. Its later drain keeps the same id |
| `handled` | a command dispatched, or the advisory `input` hook suppressed the turn |
| `discarded` | the grant was abandoned before any mutation |
| `refused` + `code` + `beforeMutation: true` | a stale or reused fence. No mutation happened |
| `drain-failed` + `reason` + `afterAcceptance: true` | a drain or payload record failed **after** acceptance. Reported once, never as a clean pre-mutation refusal, and it never rewrites the queue receipt |

`recordEffectivePayload` is a **receipt, never a grant**, with `expandedFrom` in
`transform | template | skill | queue-drain`. **Every drain records exactly one `queue-drain` receipt**,
whether or not expansion changed the text: the receipt is what tells the host which text was actually sent
for an already-accepted submission, so an unchanged drain owes it just as much as an expanded one. Each label names what actually changed the text: a
template-only expansion is `template`, a skill expansion is `skill`, the native editor's trim and paste
expansion is `transform`, and a queue drain is `queue-drain`. A record taken before any mutation that the
host cannot accept refuses the submission; a record that fails after acceptance is `drain-failed`.

### 8.5 Covered entry points and forwarding

| `source` | Insertion point |
| --- | --- |
| `native-editor` | `Editor.submitGate` in `packages/tui`, before the editor destroys the draft; then `defaultEditor.onSubmit` |
| `builtin-command` | `defaultEditor.onSubmit`, fence consumed immediately before the built-in branch acts, including `!bash` |
| `extension-command` | `AgentSession._tryExecuteExtensionCommand`, the real command boundary: the grant travels there with the fence **unconsumed**, so the binding is rechecked where the command actually dispatches, and the retained draft is committed by that consumption |
| `compaction-queue` | `InteractiveMode.queueCompactionMessage`, with the push into `compactionQueuedMessages`. Classified by `isCompacting`, so a submission queued during compaction is never mislabelled a native-editor prompt |
| `native-steer` / `native-followup` | `AgentSession.steer` / `followUp`, before template and skill expansion |
| `startup-prompt` | the interactive startup prompt and print mode's initial messages |
| `extension-api` | any other `AgentSession.prompt` call, which is the default label |

When one native entry point hands a submission to another, it passes `PromptOptions.nativeSubmit`:

| Field | Meaning |
| --- | --- |
| `source` | label this call for the barrier, which authorizes here |
| `handoff` | the barrier's opaque token, **one-use**. The barrier resolves it to its own recorded stage: `GRANTED` means this call consumes the fence at its own mutation, `DISPATCH_STARTED` means the fence is already consumed and this call is the one continuation that submission owes, which may only record and report |
| `originalText` | the untouched text the grant was taken for, so a handoff cannot be redeemed for substituted content |
| `drain` | this call is the drain of an already-accepted queued submission: same id, a `queue-drain` receipt, no new grant and no new fence |

A `handoff` that is present but is not a live barrier-issued token refuses; it never falls back to a fresh
authorization. A `drain` without a handoff is an error.

**A handoff redeems exactly once.** Every native flow spends one redemption: the post-queue continuation of
an idle editor push, the drain of a compaction queue entry, or the forwarding call that consumes the fence
itself. The second redemption of the same token is refused `DUPLICATE_SUBMISSION` and reported as a
pre-mutation `refused` outcome, whether the first one consumed the fence or continued an accepted
submission. `PromptOptions.nativeSubmit` is public, so this does not depend on callers never replaying a
token: a replayed handoff runs neither an extension command handler nor an ordinary agent prompt. Because
the redemption is spent synchronously, before the redeeming call does any work, two overlapping redemptions
of one handoff resolve the same way — exactly one proceeds and the other is refused while the first is still
awaiting its own boundary.

### 8.6 Draft preservation: retain, then commit

The default editor never destroys a draft on authorization alone. `Editor.submitGate` runs before any
clearing, and authorization is only permission to *attempt* the submission: the native mutation can still
be refused by a stale or duplicate fence afterwards. So the order is **retain, submit, then commit**:

```ts
// on the editor (optional on EditorComponent, implemented by the default Editor)
submitGate?: (s: { text: string; originalText: string; draftRevision: number }) => boolean | Promise<boolean>;
commitSubmittedDraft?(revision: number): boolean;
```

1. The gate is asked, and is given the untouched draft plus the effective text.
2. On a grant the editor calls `onSubmit` and **keeps the whole draft** — text, paste markers and their
   bodies, cursor, scroll offset and undo history.
3. The host performs its native mutation under the fence. Only once that mutation has committed does it
   call `commitSubmittedDraft(revision)`, which clears that draft and only that draft.

For an **idle extension command** the mutation to commit at is `AgentSession`'s command dispatch, not the
editor's own queue push: the grant is queued with its fence unconsumed, and the retained draft is destroyed
by that consumption, in the same turn as it. A rebind or a duplicate between the push and the command
therefore refuses with the complete draft still on screen. The commit responsibility travels with the
grant, so exactly one boundary owns it per submission. It runs only after a **successful** mutation: a
fence spent by a mutation that then threw commits no draft, and the next dispatch of that submission is a
duplicate that leaves the draft intact. Pi hands each grant to exactly one holder, so the boundary that
consumes the fence is always the boundary the draft was queued for.

Consequences a host can rely on:

- A refusal at authorization **or at the fence** (`STALE_BINDING`, `DUPLICATE_SUBMISSION`) leaves the
  complete draft in place. Nothing is reconstructed from the submitted text, because nothing was lost.
- `commitSubmittedDraft` is revision-bound: if the operator typed while the submission was in flight the
  revision no longer matches, the call returns `false` and the newer draft is never overwritten. The
  authorized text is still submitted.
- An idle Alt+Enter commits against the revision **the gesture submitted**, captured before authorization
  was awaited, so an edit made while the host was still deciding is never destroyed.
- An unmanaged editor is unchanged: with no gate set, `submitValue` clears and submits synchronously
  exactly as before.
- A commit that **throws** cannot un-accept a dispatched submission, so the submission stays accepted and
  the failure is reported through the channel the registering entry point owns:
  `NativeSubmitAccepted.afterDispatch(commit, reportFailure)` takes that channel as a required argument, and
  the default editor's is the same error line every refused submission uses
  (`The submitted draft could not be cleared: …`). It is not discarded. The only remaining silence is a
  `reportFailure` that itself throws, which leaves no channel at all; that is caught so the accepted
  dispatch still stands, and nothing is retried.

### 8.6b Custom editors: compatibility-first draft preservation

`EditorComponent.submitGate`, `draftRevision` and `commitSubmittedDraft` are **optional**, and they stay
optional. An arbitrary custom editor from an extension may ignore all three, clear its own private state
before calling `onSubmit`, submit on a gesture other than Enter, or invoke an asynchronous callback. Pi
cannot infer those semantics from the outside.

The selected policy is **compatibility-first**: an existing custom editor remains usable in a managed
session without adopting the hooks, and Pi claims no universal draft preservation. What an editor gets on a
submission that is refused before any mutation:

| Editor | Draft after the refusal |
| --- | --- |
| the default editor | the complete draft — text, paste markers and their bodies, cursor, scroll offset, undo history — is still there, as section 8.6 describes |
| a custom editor that implements the hooks correctly | the same: `submitGate` retains, the fence decides, and `commitSubmittedDraft(revision)` clears only the revision that was submitted |
| a custom editor that clears itself before calling `onSubmit` | best effort only: the **submitted text** may be put back, and only while that editor is still empty |

That third row is the concession, and it is a real one. `reportRefusedSubmission` restores the submitted
text only when the editor's `getText()` is still empty, so a draft the operator typed after the component
cleared itself is never overwritten: newer typing always wins over an older restoration. Nothing else is
recovered. Paste objects and their bodies, undo history, cursor and scroll offset and any other
extension-private state belong to the component; Pi neither reads nor reconstructs them. Saving the
submitted string is not a third route to full preservation, and intercepting Enter is not one either,
because such an editor may submit through another gesture or an asynchronous callback.

A custom editor clearing its own UI is **not** a native submission mutation. The component's own state is
the extension's business; the queue push and the command dispatch are Pi's, and they stay behind the fence
whatever the editor did to its own screen first.

What compatibility-first does **not** relax:

- **Dispatch stays fail-closed.** No unauthorized submission reaches the agent, and every queue mutation
  and command dispatch is still fenced and one-use, refused on a stale or reused fence. Keeping an older
  editor usable is not permission to dispatch unauthorized work.
- **The default editor's retain-submit-commit order is unchanged**, and so is revision-bound commit.
- **No editor is wrapped, replaced, disabled or required to change**, and no extension is asked to adopt a
  mandatory prepare/commit protocol.

The limitation must be explicit rather than hidden behind a universal claim, so a managed host must treat a
custom editor that implements neither `submitGate` nor `commitSubmittedDraft` as
**draft-preservation-unavailable, and say so**. In the interactive mode Pi now says it itself: when a managed
session's installed editor component declares neither hook, `InteractiveMode` writes one warning through the
session's existing notification channel — the same `showWarning` line an extension's own warning notices use
— at that session's first managed submission:

> Draft preservation is unavailable in this managed session: the active editor implements neither submitGate
> nor commitSubmittedDraft, so a refused submission can only put the submitted text back, and only while
> that editor is still empty.

What that notice is, exactly:

- **Read from the component's own public optional members**, `submitGate` and `commitSubmittedDraft`, at the
  `setEditorComponent` lifecycle point and before Pi wires its own gate into a custom editor. No private
  component state is inspected, and nothing is inferred from rendered text.
- **Once per installed component**, at the first managed submission, not once per submission, and never in an
  unmanaged session. Installing another component re-evaluates it; restoring the default editor clears it.
- **A statement, not a mechanism.** No wrapper, no capability framework, no indicator widget, no
  default-editor warning, no hook made mandatory, and no editor wrapped, replaced or disabled. An editor that
  declares either hook is never called draft-preservation-unavailable, and an unknown or noncooperating
  component is never advertised as preserving drafts.

Verification against a real legacy component ships with the patch:
`packages/coding-agent/test/native-submission-barrier.test.ts` drives an `EditorComponent` that implements no
optional hook, clears itself before calling `onSubmit` and can deliver that call from its own timer, through
the real `setCustomEditorComponent` path — an allowed submission, a refusal, the text-only recovery, newer
typing winning over that recovery, and one notice across two submissions. The public binding/API freeze and
combined integration are the remaining seam A qualification work, which is why the top of this file still
says seam A is implemented but not qualified.

### 8.7 What seam A does not do

No durable ledger, no blob storage, no ownership or attachment policy, no canonical admission, no
reservation, no session management. It reconstructs no extension-private editor state, and it never
reimplements, wraps, replaces or disables a custom editor. The binding is observed here, never admitted: the
admission, reservation and commit contract is seam D's own patch, `0004`. The advisory `input` event keeps its existing catch-and-continue
contract and is unchanged.

## 9. The composed series

The three patches were written against the same pinned tree by three separate lanes, and they do **not**
commute: `packages/tui/src/{terminal,tui,index}.ts` are changed by both 0002 and 0003, and
`packages/coding-agent/src/{index.ts,core/extensions/{types,loader}.ts,modes/interactive/interactive-mode.ts}`
by both 0001 and 0003. `patches/series` is therefore the only order these files apply in, and 0002 and 0003
are the **serialized** forms regenerated in that order rather than the lanes' original diffs. Seam D's 0004
was written on top of the applied series and is a fourth non-commuting position: it changes seam A's own
`core/native-submission.ts` as well as `index.ts` and `interactive-mode.ts`. Its contract is
`INTERFACE-seam-d-canonical.md`.

| Position | Patch | sha256 | Prepared tree after it |
| --- | --- | --- | --- |
| 1 | `0001-seam-a-native-submission-barrier.patch` | `c2d0a7c73bae0359357f012d95954dd9bcb645af7ca13d805623192c7d9542a7` (unchanged from the seam A lane) | `4a175953509e7a38bfbaefd0aa55f01b6168a980` |
| 2 | `0002-native-ingress-return-profile.patch` | `9376635ebb4aa87d77354fe19c53cf70562aa37ba64f9e5513e0e2ed7ea7db1e` (serialized; the lane's own diff was `1db62cf6355d371d910a947d771a6c81efff5f4996a7a7d5b3796a5d251ae816`) | `8c21a5d8e326a44719ad53d5c6ba183db9925731` |
| 3 | `0003-native-presentation-readiness.patch` | `cf7f5ccca6358612f17bb65583f17934fb795b9935c921efe0fbaba1737bdfb9` (serialized; the lane's own diff was `8a483bf73c9b6d6d44cea44eae2289386946e545f1b6fa2b8bd6a5fd88542868`) | `9c40d805754c6cbc5dd161ec4e1c6880b1bc1ef4` |
| 4 | `0004-native-canonical-admission.patch` | `1f5e78f4ebdeafcc8a161d3b0c02613256902981a12adf540ff2509329bf89d5` (authored at this position; its first form was `66cdeaacf78c3e18e8f7512abf928d7a509691ea776f368d417a60ae0e446dc0`, and the form before the one-use reservation and string-message corrections was `425ac07a02a6d10261f01ad9b8048ee5719ab745f1af6e7ffb2a08e21fc6b9d1`) | `69762c6631d6395b989735cef63f6c97a9511bf9` |

Applying each lane's patch alone to the pin still reproduces that lane's own tree
(`4a175953509e7a38bfbaefd0aa55f01b6168a980` for A, `657974161957889b737195121078666ced55192d` for B/C/F,
`88e61de9062ba65ddde592d96b7afa24473b0b67` for E), which is what makes the serialized forms comparable to
the reviewed lanes rather than a rewrite. Serializing changed no lane's behaviour: every conflicting hunk
git could not merge was an import block, and both sides' imports are kept verbatim in
`packages/tui/src/{terminal,tui}.ts`. No identifier, frame field, environment variable or exported name was
renamed by the composition.

Regenerating a later patch is the maintenance procedure, not reordering the series: apply the series up to
position *n − 1* in a disposable tree, apply the lane's own diff on top, resolve, and re-take the diff from
position *n − 1*. `prepare.mjs` then applies the whole series with no fuzz, no `-3` and no skip, and the
prepared tree must equal the tree recorded above.

### 9.1 What the composition itself does not deliver

- **No seam G.** There is still no `drainedThrough` and no child-terminal phase announcement. Seam D's
  canonical admission arrived with 0004 and is contracted in `INTERFACE-seam-d-canonical.md`; nothing else
  here may be cited as a G interface freeze.
- **No owner bootstrap and no arbitrary-child terminal parity (Gate 5).** Managed behaviour stays inert
  until an owner process registers a host; with nothing registered every seam is the pinned baseline.
- **No dependency activation.** The root `package.json` still installs the released Pi; these artifacts are
  built, tested and left in a disposable directory.
