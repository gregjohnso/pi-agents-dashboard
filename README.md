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
