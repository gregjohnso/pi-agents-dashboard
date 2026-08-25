# Pi Host Capability Seam

**Inspected host:** `@earendil-works/pi-coding-agent` 0.84.3
**Release status:** Blocked

## Gate

A host is supported only when `checkHostCapabilities()` reports both `daemonOwnedStartup: true` and `nativeAttach: true`. Standard package startup, the optional CLI, `doctor`, Task 14, and release acceptance must fail closed when either value is false. A reduced transcript renderer or a foreground session owned by the terminal is not an acceptable fallback.

## Public evidence

The probe uses only the documented package entry points `@earendil-works/pi-coding-agent`, `@earendil-works/pi-coding-agent/client`, and `@earendil-works/pi-coding-agent/rpc-entry`. It does not import `dist/modes/interactive/*` or mutate Pi objects.

Stock Pi 0.84.3 exposes:

- `DefaultPackageManager` and `createExtensionRuntime`, which support installed global Pi packages;
- `RpcClient` and the exported `rpc-entry` subpath, which support detached RPC workers;
- `CustomEditor` and documented editor get/set composition, which can compose the guarded Left gesture;
- `InteractiveMode` and documented extension custom UI, which support fullscreen custom UI;
- the public `client` entry with `RemoteSession`, which is a protocol client and not a native interactive frontend adapter.

Stock Pi 0.84.3 does not expose:

1. A documented public extension startup hook that selects a daemon-owned backend before the model loop starts.
2. A documented public adapter that binds `InteractiveMode` and its transcript, editor, commands, tool rendering, images, keybindings, and extension UI to a daemon-owned remote session.

The resulting blockers are:

- `Pi 0.84.3 has no documented public extension startup hook for selecting a daemon-owned backend before the model loop starts.`
- `Pi 0.84.3 has no documented public native attachment adapter that binds InteractiveMode to a daemon-owned remote session.`

## Installed-package fixture

`test/host-capability.integration.test.mjs` installs this repository through the documented `pi install <local-path>` command into a disposable `PI_CODING_AGENT_DIR`. It starts a bounded fake daemon before any frontend construction and records one worker/writer identity. On Pi 0.84.3, native attachment returns the typed `UNSUPPORTED_HOST` result before frontend construction. The fixture verifies that the worker identity is unchanged and no second session writer is created.

The supported-host branch intentionally fails closed. No approved public startup or native adapter symbols are currently specified, so the package does not guess future export names. After Pi documents an upstream contract, this document and the installed-host probe must record the exact public symbols and semantics before the supported-host fixture can assert detach and reattach with unchanged worker identity and native transcript/editor/tool surfaces.

## Documentation reviewed

The finding follows the installed Pi 0.84.3 package, extension, RPC, SDK, TUI, keybinding, session, and related documentation. In particular, the SDK documents `InteractiveMode` as accepting a local `AgentSessionRuntime`, while RPC mode documents that TUI-specific extension methods such as `custom()` and `setEditorComponent()` are unavailable or degraded. Neither path supplies native remote attachment.
