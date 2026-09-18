/**
 * A test-owned startup gate, so the lifecycle case can assert a *connected* sideband and a natural exit.
 *
 * `pi config --help` returns from `main()` instead of calling `process.exit`, so the process ends when its own
 * event loop drains. That is exactly the property under test — an unreferenced sideband socket must not hold
 * Pi open — but it also means the run can end before `net.connect` completes, in which case the case would
 * only prove that a *configured* channel does not hold Pi open, not that a connected one does not.
 *
 * This preload closes that gap without touching production code. `node --import` runs it before the bundle's
 * entry, and everything it uses is the installed public API: `nativeBootstrapStatus()`. It holds one
 * referenced timer — the only thing keeping the loop alive after `main()` returns — until that status reports
 * `open` with the hello already written, then releases every handle it owns: the timer is cleared and its
 * single report socket is destroyed as soon as the report is flushed, rather than waiting on a peer FIN.
 *
 * After that release the process holds nothing of the test's. What it proves, precisely: with the hello
 * delivered to a live listener and every test-owned handle gone, Pi still exits `0` on its own. It does not
 * keep the process alive by any other means, adds no keepalive to Pi, and never calls `process.exit`.
 */

import net from "node:net";

const installedEntry = process.env.PI_SEAM_E_GATE_ENTRY;
const reportSocketPath = process.env.PI_SEAM_E_GATE_SOCKET;
const deadlineMs = Number(process.env.PI_SEAM_E_GATE_DEADLINE_MS ?? 20_000);
const POLL_MS = 10;

const observation = {
  type: "gate-observation",
  pid: process.pid,
  entry: installedEntry,
  /** True only when the channel reached `open` with the hello written before the deadline. */
  released: false,
  expired: false,
  state: undefined,
  framesSent: 0,
  waitedMs: 0,
  error: undefined,
};

let reported = false;

/** One frame, on a socket this gate destroys itself: a peer FIN is not part of what it waits for. */
function report() {
  if (reported) return;
  reported = true;
  const connection = net.connect(reportSocketPath, () => {
    connection.end(`${JSON.stringify(observation)}\n`, () => connection.destroy());
  });
  connection.on("error", () => connection.destroy());
}

try {
  const installed = await import(installedEntry);
  const started = Date.now();
  // Referenced deliberately: this timer is the gate. Nothing else the test owns keeps this process alive.
  const gate = setInterval(() => {
    const status = installed.nativeBootstrapStatus();
    observation.state = status.state;
    observation.framesSent = status.framesSent;
    const connected = status.state === "open" && status.framesSent > 0;
    const expired = Date.now() - started >= deadlineMs;
    if (!connected && !expired) return;
    observation.waitedMs = Date.now() - started;
    observation.released = connected;
    observation.expired = expired && !connected;
    // Every handle this gate owns is released here: the timer now, the report socket as soon as it flushes.
    clearInterval(gate);
    report();
  }, POLL_MS);
} catch (error) {
  observation.error = String(error?.stack ?? error);
  report();
}
