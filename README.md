# Pi Agents Dashboard

A machine-local dashboard for concurrent [Pi](https://github.com/badlogic/pi-mono) agent sessions.

## Status

This package is under development. It fails closed unless the Pi host supports daemon-owned startup and native session attachment; it does not fall back to a reduced transcript interface.

## Installation

The package is designed for installation through Pi from npm or a local checkout:

```bash
pi install npm:pi-agents-dashboard
pi install /absolute/path/to/pi-agents-dashboard
```

A global npm installation is optional and exposes the `pi-agents-dashboard` command. The extension and executable discover runtime modules relative to this package, not from a global command on `PATH`.

## Development

Use Pixi for installation and verification:

```bash
pixi run install
pixi run typecheck
pixi run test
pixi run pack-check
```

All runtime state and processes are local to the current machine.

## Destructive command compatibility

Version 1 Stop and Delete requests require the exact full session ID and current registry revision. A legacy `{sessionId}` Stop/Delete request receives `REVISION_REQUIRED` without execution. A revised client talking to an older strict daemon receives that daemon's invalid-request refusal; it does not remove `revision` or retry with the legacy payload.

The CLI persists a private client ID and pending destructive request IDs under its runtime state directory. Re-running the same action/session/revision reuses the pending identity. Resolve ambiguous delivery only with full IDs:

```bash
pi-agents-dashboard session resolve-delivery <full-client-id> <full-request-id> retry_at_risk|abandon --yes
```

Session Delete and managed-worktree cleanup are separate. Delete uses only an approved Pi trash capability and fails closed when none is available. Cleanup requires its own exact ID, revision, and confirmation.
