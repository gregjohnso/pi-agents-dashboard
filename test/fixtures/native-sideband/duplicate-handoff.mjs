// A helper that hands over one listener and then hands over a second, then exits cleanly.
//
// The exit is 0 on every ordinary path, so nothing about this sender can be refused for an unrelated reason:
// the first handoff is valid, the process ends normally, and the only thing wrong is the second handoff. A
// parent that keeps its channel open until the helper's own exit must therefore observe the duplicate and
// refuse it as a protocol violation, disposing both listeners it was handed.
import net from "node:net";

import { FIXTURE_PROTOCOL, SOCKET_PATH, bindPrivately, proofFor, send } from "./binder-fixture.mjs";

const { server, proof } = await bindPrivately(SOCKET_PATH);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH, proof }, server);

const second = net.createServer();
await new Promise((resolve) => second.listen(`${SOCKET_PATH}-second`, () => resolve(undefined)));
await send(
  { protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH, proof: proofFor(`${SOCKET_PATH}-second`) },
  second,
);
process.exit(0);
