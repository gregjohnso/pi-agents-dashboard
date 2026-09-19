# native-session-demo

One persistent native Pi. Attach from as many terminals as you like, detach them all, come back, and the
session is still there — same process, same draft, same screen.

This is a **development-only integration demo**. It ships in no tarball, it is not a product entry point, it
registers a **labelled fake provider** that calls no model and needs no credential, and it makes no claim to
be qualified. Read [Honest limits](#honest-limits) before drawing a conclusion from it.

## What it actually is

Pi is the whole product here. It owns the editor, the draft, the transcript, the key classification and every
byte on the screen. The manager in [manager.mjs](manager.mjs) owns exactly three things Pi cannot own for
itself:

| The manager owns | Through |
| --- | --- |
| the pseudo-terminal the one real Pi runs on | [`runtime/pty-mechanism.mjs`](../../runtime/pty-mechanism.mjs) |
| which client a byte span came from | seam B: `ProcessTerminal.dispatchNativeInput`, under an attachment epoch |
| when a cold client is repainted | seam E: the core bootstrap sideband's `present` command |

There is no second editor, no second viewer, no key parser, no screen model, no captured byte tail and no
inference from rendered output. A reattachment is a **cold presentation**: Pi renders one complete frame from
its own live component tree. Nothing is replayed.

| File | What it is |
| --- | --- |
| [demo.mjs](demo.mjs) | the command line: `start`, `attach`, `detach`, `status`, `stop`, `serve` |
| [manager.mjs](manager.mjs) | the owner manager: one pseudo-terminal, one control socket, one sideband |
| [client.mjs](client.mjs) | one attachment: raw bytes out, Pi's bytes in, and its own terminal modes restored |
| [owner-preload.mjs](owner-preload.mjs) | the pre-TUI caller inside Pi: it registers the launch-fixed profile and dispatches labelled input |
| [owner-extension.ts](owner-extension.ts) | the Pi extension: the fake provider, and the public `TUI` handover |
| [fake-provider.mjs](fake-provider.mjs) | deterministic replies, computed from the prompt, with no network |
| [protocol.mjs](protocol.mjs) | one bounded frame format shared by all three peers |
| [smoke.mjs](smoke.mjs) | the acceptance smoke, driven entirely through the commands above |
| [native-session-demo.test.mjs](native-session-demo.test.mjs) | focused cases; the smoke runs only under `PI_NATIVE_DEMO_SMOKE=1` |

## Run it

Node must be 22.19 or newer and below 23; this repository's pixi environment supplies one. Everything below is
copy-pasteable from the repository root.

```bash
NODE=/mnt/main0/home/gjohnson/projects/pi-agents-native-owner-pty-20260918/.pixi/envs/default/bin/node
DEMO=/mnt/main0/home/gjohnson/projects/pi-agents-native-demo-20260919/examples/native-session-demo/demo.mjs
```

### 1. Start one owner

```bash
$NODE $DEMO start --root /tmp/pi-nsd-mine --cols 100 --rows 30
```

It prints the owner's real identity and the exact commands for the rest:

```
owner pid 1437362, startIdentity 1488117543, process group 1437362
manager pid 1437351, log /tmp/pi-nsd-mine/manager.log
root /tmp/pi-nsd-mine, control socket /tmp/pi-nsd-mine/s
geometry 100x30, provider native-session-demo-fake/deterministic-echo (FAKE: deterministic, no model is called)
cohort .../consumer/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
```

`start` returns when Pi has recorded **`native-mounted`** — the phase at which a key reaches the editor and a
frame reaches the terminal. It does not wait for first paint or for initialization, so a blocking startup
dialog cannot hold your attach command.

Which Pi runs is chosen by manifest, not by whatever npm happens to have installed:

```bash
$NODE $DEMO start --root /tmp/pi-nsd-mine \
  --manifest /mnt/main0/home/gjohnson/projects/pi-agents-tool-error-summary/.superpowers/sdd/2026-09-17-native-attachment/merge-tree-wave-6/partial-integration/selected-artifacts-manifest.json
```

### 2. Attach, from one terminal or several

```bash
$NODE $DEMO attach --root /tmp/pi-nsd-mine --id client-1     # in your first terminal
$NODE $DEMO attach --root /tmp/pi-nsd-mine --id client-2     # in a second terminal
```

Both terminals show the same Pi. Type in either one: it is one shared draft and one shared screen, because
there is only one editor and it is Pi's. Make your terminals 100x30, or start the owner with `--cols`/`--rows`
matching them — there is one shared geometry and no per-client resize.

### 3. Detach, and come back

There is deliberately **no detach key**. This demo adds no key parser, and the default Pi editor owns the
return key, so Pi never offers it to a host. Detach is explicit:

```bash
$NODE $DEMO detach --root /tmp/pi-nsd-mine                   # every attachment
$NODE $DEMO detach --root /tmp/pi-nsd-mine --id client-2     # just that one
```

or send the attach process a signal (`kill -TERM <its pid>`), which detaches it and restores that terminal.

The owner keeps running with zero clients attached — same PID, same start identity:

```bash
$NODE $DEMO status --root /tmp/pi-nsd-mine | grep -E 'ownerAliveWithZeroClients|"pid"|startIdentity'
```

Attach again with the same `--id` and it is a new epoch of that attachment. Pi repaints it cold, and the draft
you never sent is still on the screen, because it never left Pi.

### 4. Send something

Type a message and press Enter. The fake provider answers deterministically:

```
DEMO-FAKE-REPLY e86a3df10130 :: unsent draft from client one and an edit from client two
```

The digest is a hash of your own prompt. No model was called; no credential exists in that process.

### 5. Stop

```bash
$NODE $DEMO stop --root /tmp/pi-nsd-mine                     # add --keep-root to keep the logs
```

`stop` detaches every client, dispatches Pi's own end-of-input as the graceful gesture, and escalates only
through this repository's verified group stop, which re-reads PID, start identity and process group
immediately before every signal. It prints the owner's real `wait(2)` status and removes only what this demo
created.

### Watch the manager instead of backgrounding it

```bash
$NODE $DEMO serve --root /tmp/pi-nsd-mine                    # what `start` runs, in the foreground
```

## Isolation

Every launch is disposable, and the native spawn **replaces** the inherited environment rather than adding to
it — measured, not assumed. The owner's whole environment is the list in `manager.mjs`:

- `HOME`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` all point inside `--root`, created `0700`
- no `*_API_KEY`, no auth file, no operator `~/.pi`, and `--no-extensions` so nothing of yours is discovered
- `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1`
- tools are disabled (`-nt`): this demo shows attachment, not tool execution
- the connection token lives in `<root>/token` (`0600`), never in `argv` and never in a log
- the control socket and the sideband are unix-domain, `0600`, in a `0700` directory. There is no TCP listener
- frames are bounded (256 KiB), a client that falls 4 MiB behind is disconnected **by name** rather than
  silently dropped, and bytes sent before Pi's labelled ingress is ready are held in order and delivered once

## Prove it

```bash
# focused cases, no Pi, under a second
$NODE node_modules/vitest/vitest.mjs run examples/native-session-demo/native-session-demo.test.mjs --no-cache

# the real user flow: two clients, two real pseudo-terminals, one real bundled CLI
$NODE examples/native-session-demo/smoke.mjs --root /tmp/pi-nsd-smoke --evidence /tmp/nsd-evidence
```

The smoke drives only the commands above. It types an unsent draft from the first attachment, detaches
everything, checks the owner's identity is unchanged and unreaped, reattaches, asserts the retained draft came
back on Pi's own repaint, attaches a second client to the same draft, edits from there, submits, and reads the
deterministic reply on both screens. It writes each client's terminal transcript, the manager log, the
in-Pi caller's JSONL and measured timings into `--evidence`.

## Honest limits

- **Not qualified.** This is one integration demo against one patched, unreleased cohort. It is not seam
  qualification, not a Gate 5 pass, and not a substitute for the seam work it exercises.
- **Seam A is not activated.** No native submission host is registered, so the submission barrier, its
  one-use fences and its retain-submit-commit draft order are not exercised here. Submission behaves as
  unmanaged Pi's.
- **Seam C authorization is never consulted.** Pi asks a host about a return key only when the focused
  component declares it free, and the default editor declares nothing, so it owns the key. That is why detach
  is the manager's explicit command; this demo does not add a key parser to work around it.
- **Seam F response authorization is registered but unexercised by the smoke.** The pseudo-terminals the smoke
  drives answer no capability query. A real terminal emulator would reply, and the host refuses to apply it,
  because the profile is fixed by the owner at launch.
- **Seam G is opted into but not demonstrated.** No external editor is launched, so no drain boundary, phase
  announcement or `handoff-closed` refusal appears in the smoke.
- **No ledger, no canonical ownership, no recovery.** The manager holds one owner for as long as it runs. It
  is not a durable ledger, it is not a second canonical writer, and it recovers nothing: if the manager dies,
  the pseudo-terminal closes and the owner is hung up.
- **Output produced while detached is not retained.** It is read and discarded, which is why a reattachment is
  a repaint rather than a replay.
- **One geometry, fixed at launch.** A client whose terminal differs is told so and attaches anyway. There is
  no per-client viewport, and no controller or observer role.
- **Linux, x86-64, glibc.** That is what the owner pseudo-terminal artifact supports; it refuses other hosts
  by name.
