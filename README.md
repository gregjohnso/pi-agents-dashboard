# pi-dashboard

A machine-local standalone terminal dashboard for concurrent [Pi](https://github.com/badlogic/pi-mono) sessions.

## Installation

```bash
npm install -g pi-dashboard
pi-dashboard
```

Also supported:

```bash
npx pi-dashboard
pi-dashboard --pi-bin /absolute/path/to/pi
npm install /absolute/path/to/pi-dashboard
```

The package has no npm lifecycle scripts and no Pi extension entry point. Running `pi-dashboard` from any working directory starts the list with that directory as the launch default. Closing the frontend does not stop the daemon or signal a Pi process.

## Development

Use Pixi for installation and verification:

```bash
pixi run install
pixi run typecheck
pixi run test
pixi run pack-check
```

All runtime state and processes are local to the current user and machine. Private state uses mode-`0700` directories and mode-`0600` files.

## Destructive command compatibility

Stop and Delete require the exact full session ID and current registry revision. Ambiguous delivery remains `DELIVERY_UNKNOWN` until explicitly resolved with the original full client and request IDs:

```bash
pi-dashboard session resolve-delivery <full-client-id> <full-request-id> retry_at_risk|abandon --yes
```

Session Delete and managed-worktree cleanup remain separate. Delete uses only an approved Pi trash capability and fails closed when none is available. Cleanup requires its own exact ID, revision, and confirmation.
