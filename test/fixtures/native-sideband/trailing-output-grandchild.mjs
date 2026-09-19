// A grandchild that holds the observer's stdout and stderr open and writes AFTER the helper has exited.
//
// This exists to create the ordering the drain phase is for. The observer's main loop stops as soon as the parent
// and helper wait statuses are accounted for. This process inherited those same pipes, so their EOF cannot arrive
// until it closes them too, and it deliberately writes its marker only once its own parent - the helper - is gone.
// Trailing output therefore exists after the statuses are complete, which is precisely the window in which a
// verdict emitted at that moment would be published over output nobody had read.
//
// Its parent is the helper, so `disconnect` here means the helper's IPC channel closed, which happens when the
// helper exits. No sleep and no timing guess: the write is keyed to a process event.
import { writeSync } from "node:fs";

import { TRAILING_MARKER } from "./trailing-output-marker.mjs";

process.once("disconnect", () => {
  // stderr, the same pipe the binder's own diagnostics travel on, so this is relayed through the same path.
  writeSync(2, `${TRAILING_MARKER}\n`);
  process.exit(0);
});
