/**
 * The observer half of seam E's module-instance rule, loaded into the bundled CLI's own process.
 *
 * The bundled CLI inlines its dependencies, so the implementation the agent runs is `dist/bundle/cli.js` and
 * nothing in it resolves the installed `@earendil-works/pi-coding-agent` entry. A host that embeds Pi in the
 * same process therefore holds a **second implementation**, and the interface claims both of them reach one
 * readiness ledger and one presentation provider. This module is that second implementation's side of the
 * claim, preloaded with `node --import` — a supported Node route, with no production code injected and no
 * private field read.
 *
 * `--import` runs before the main entry, so the process record is created by *this* copy. If the bundle
 * started a ledger or a provider of its own, `phases` would stay empty and `presentation` would report
 * `no-native-renderer`; both are read across the boundary here and asserted by the acceptance case.
 *
 * One newline-delimited JSON frame is written to `PI_SEAM_E_PRELOAD_SOCKET`, so the case waits on an event
 * rather than polling a file. The socket is unreferenced: an observer must not hold Pi open either.
 */

import net from "node:net";

const reportSocketPath = process.env.PI_SEAM_E_PRELOAD_SOCKET;
const installedEntry = process.env.PI_SEAM_E_PRELOAD_ENTRY;

const observation = {
  type: "preload-observation",
  entry: installedEntry,
  imported: false,
  stateVersion: undefined,
  /** The ledger on the process is the one this copy constructed, because this copy loaded first. */
  ledgerIsThisCopys: undefined,
  /** Phases this copy was told about. Every one of them is recorded inside the bundle. */
  phases: [],
  snapshotPhases: [],
  /** The result of calling the bundle-registered provider through this copy's `presentTerminal`. */
  presentation: undefined,
  error: undefined,
};

let reported = false;

function report() {
  if (reported) return;
  reported = true;
  const connection = net.connect(reportSocketPath, () => {
    connection.end(`${JSON.stringify(observation)}\n`);
  });
  connection.unref();
  connection.on("error", () => {});
}

try {
  const installed = await import(installedEntry);
  observation.imported = true;
  observation.stateVersion = installed.NATIVE_PRESENTATION_STATE_VERSION;
  observation.ledgerIsThisCopys = installed.nativeReadiness() instanceof installed.NativeReadinessLedger;
  installed.onNativeReadiness((record) => {
    observation.phases.push(record.phase);
    if (record.phase !== "native-mounted" || observation.presentation !== undefined) return;
    // Off the recording turn, so an observer cannot re-enter Pi's own startup path.
    setImmediate(() => {
      installed
        .presentTerminal({
          attachmentEpoch: { attachmentId: "preload-observer", epoch: 1 },
          geometryRevision: 41,
          coldTerminal: true,
        })
        .then((result) => {
          observation.presentation = result;
          observation.snapshotPhases = installed.nativeReadinessSnapshot().reached.map((entry) => entry.phase);
          report();
        })
        .catch((error) => {
          observation.error = String(error?.stack ?? error);
          report();
        });
    });
  });
} catch (error) {
  observation.error = String(error?.stack ?? error);
  report();
}
